package ldap

// Object lifecycle helpers (create / copy / move / restore targets) of the
// "life" work: existence checks for target containers, login name conflicts
// for new accounts and copies, the next free POSIX IDs and the UPN suffixes
// of an AD forest. All of them are background reads of a dialog, not user
// operations, so they do not write to the operation log (like EntryExists).

import (
	"context"
	"sort"
	"strconv"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// lifecycleCheckLimit caps the DNs of one EntriesExist call.
const lifecycleCheckLimit = 200

// EntriesExist checks every DN with a base search without attributes (see
// EntryExists). A DN the server refers elsewhere, or that cannot be checked,
// is reported with Error set and Exists false. At most 200 DNs are checked.
func (c *Client) EntriesExist(dns []string) []models.EntryCheck {
	out := make([]models.EntryCheck, 0, len(dns))
	for i, dn := range dns {
		check := models.EntryCheck{DN: dn}
		switch {
		case i >= lifecycleCheckLimit:
			check.Error = "not checked (too many DNs)"
		case strings.TrimSpace(dn) == "":
			check.Error = "empty DN"
		default:
			exists, err := c.EntryExists(strings.TrimSpace(dn))
			if err != nil {
				if goldap.IsErrorWithCode(err, goldap.LDAPResultInvalidDNSyntax) {
					check.Error = "invalid DN syntax"
				} else {
					check.Error = err.Error()
				}
			}
			check.Exists = exists
		}
		out = append(out, check)
	}
	return out
}

// lifecycleLoginAttrs are the attributes LoginNameHolders may search.
var lifecycleLoginAttrs = map[string]string{
	"uid":               "uid",
	"samaccountname":    "sAMAccountName",
	"userprincipalname": "userPrincipalName",
	"mail":              "mail",
	"cn":                "cn",
	"uidnumber":         "uidNumber",
	"gidnumber":         "gidNumber",
}

// LoginNameHolders returns the DNs (at most limit, default 5) of entries
// below the search bases whose attr equals value, for duplicate checks of
// new accounts and copies. bases are searched in order until limit DNs are
// found; a base that does not exist is skipped. attr must be one of uid,
// sAMAccountName, userPrincipalName, mail, cn, uidNumber or gidNumber.
func (c *Client) LoginNameHolders(bases []string, attr, value string, limit int) ([]string, error) {
	name, ok := lifecycleLoginAttrs[strings.ToLower(strings.TrimSpace(attr))]
	if !ok {
		return nil, &unsupportedAttrError{attr}
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return []string{}, nil
	}
	if limit <= 0 {
		limit = 5
	}
	filter := "(" + name + "=" + goldap.EscapeFilter(value) + ")"
	out := []string{}
	seen := map[string]bool{}
	for _, base := range bases {
		if len(out) >= limit {
			break
		}
		req := goldap.NewSearchRequest(base, goldap.ScopeWholeSubtree, goldap.NeverDerefAliases,
			limit, 10, false, filter, []string{"1.1"}, nil)
		var entries []*goldap.Entry
		err := c.read(func(conn *goldap.Conn) error {
			res, err := conn.Search(req)
			if res != nil {
				entries = res.Entries
			}
			if err != nil && goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
				return nil
			}
			return err
		})
		if err != nil {
			if goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject) {
				continue
			}
			return out, searchError(err)
		}
		for _, e := range entries {
			if k := normDN(e.DN); e.DN != "" && !seen[k] && len(out) < limit {
				seen[k] = true
				out = append(out, e.DN)
			}
		}
	}
	return out, nil
}

type unsupportedAttrError struct{ attr string }

func (e *unsupportedAttrError) Error() string {
	return "duplicate check not supported for attribute " + strconv.Quote(e.attr)
}

// Range of POSIX IDs NextPosixIDs considers: system accounts below 1000 and
// the reserved/nobody range (60000 and above, 65534) never decide the next
// ID; the first ID of an empty directory is posixFirstID.
const (
	posixMinID   = 1000
	posixMaxID   = 60000
	posixFirstID = 10000
)

// NextPosixIDs returns the next free uidNumber (highest uidNumber of
// posixAccount entries + 1), the next free gidNumber (highest gidNumber of
// posixGroup entries and of the accounts' primary groups + 1, so a new group
// never takes the primary group ID of existing accounts) and the gidNumber
// most accounts use as primary group (0 when there are no accounts), the
// default for a new account. Only IDs from 1000 to 59999 decide the next
// ID; 10000 when there is none. One paged search per base, without
// operation log entries.
func (c *Client) NextPosixIDs(bases []string) (uidNumber, gidNumber, commonGID int, err error) {
	var uids, gids []int
	primary := map[int]int{}
	for _, base := range bases {
		req := goldap.NewSearchRequest(base, goldap.ScopeWholeSubtree, goldap.NeverDerefAliases, 0, 30, false,
			"(|(&(objectClass=posixAccount)(uidNumber=*))(&(objectClass=posixGroup)(gidNumber=*)))",
			[]string{"objectClass", "uidNumber", "gidNumber"}, nil)
		var entries []*goldap.Entry
		ctx, done := c.trackSearch(context.Background())
		err := c.run(ctx, false, func(conn *goldap.Conn) error {
			var err error
			entries, err = c.pagedSearch(ctx, conn, req, c.pageSize())
			return err
		})
		done()
		if err != nil {
			if goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject) {
				continue
			}
			return 0, 0, 0, searchError(err)
		}
		for _, e := range entries {
			classes := strings.ToLower(strings.Join(attrValues(e, "objectClass"), " "))
			gid, gidErr := strconv.Atoi(strings.TrimSpace(attrValue(e, "gidNumber")))
			if strings.Contains(classes, "posixaccount") {
				if n, err := strconv.Atoi(strings.TrimSpace(attrValue(e, "uidNumber"))); err == nil {
					uids = append(uids, n)
				}
				if gidErr == nil {
					primary[gid]++
				}
			}
			if gidErr == nil {
				gids = append(gids, gid)
			}
		}
	}
	best := 0
	for gid, n := range primary {
		if n > primary[best] || (n == primary[best] && gid < best) {
			best = gid
		}
	}
	return nextPosixID(uids), nextPosixID(gids), best, nil
}

// nextPosixID returns the highest ID in [posixMinID, posixMaxID) + 1, or
// posixFirstID when there is none (or the next one would leave the range).
func nextPosixID(ids []int) int {
	max := 0
	for _, id := range ids {
		if id >= posixMinID && id < posixMaxID && id > max {
			max = id
		}
	}
	if max == 0 || max+1 >= posixMaxID {
		return posixFirstID
	}
	return max + 1
}

// UPNSuffixes returns the user principal name suffixes of an AD forest: the
// DNS name of the default naming context first, then the other domains of
// the forest (crossRef dnsRoot of domain partitions) and the alternative
// suffixes in uPNSuffixes of CN=Partitions. Unreadable parts are skipped;
// non-AD servers get none.
func (c *Client) UPNSuffixes() ([]string, error) {
	info, err := c.ServerInfo()
	if err != nil {
		return nil, err
	}
	if info.ServerType != models.ServerTypeAD {
		return []string{}, nil
	}
	var out []string
	seen := map[string]bool{}
	add := func(s string) {
		s = strings.TrimSpace(s)
		if k := strings.ToLower(s); s != "" && !seen[k] {
			seen[k] = true
			out = append(out, s)
		}
	}
	add(DNToDNSName(info.DefaultNamingContext))
	add(DNToDNSName(info.RootDomainNamingContext))
	if info.ConfigurationNamingContext != "" {
		var domains []string
		if refs, err := c.GetCrossRefs(info.ConfigurationNamingContext); err == nil {
			for _, r := range refs {
				// Domain partitions: FLAG_CR_NTDS_DOMAIN (2).
				if r.HasFlags && r.SystemFlags&2 != 0 && r.DNSRoot != "" {
					domains = append(domains, r.DNSRoot)
				}
			}
		}
		sort.Strings(domains)
		for _, d := range domains {
			add(d)
		}
		req := goldap.NewSearchRequest("CN=Partitions,"+info.ConfigurationNamingContext, goldap.ScopeBaseObject,
			goldap.NeverDerefAliases, 0, 10, false, "(objectClass=*)", []string{"uPNSuffixes"}, nil)
		var extra []string
		_ = c.read(func(conn *goldap.Conn) error {
			res, err := conn.Search(req)
			if err == nil && len(res.Entries) > 0 {
				extra = res.Entries[0].GetAttributeValues("uPNSuffixes")
			}
			return nil
		})
		sort.Strings(extra)
		for _, s := range extra {
			add(s)
		}
	}
	if out == nil {
		out = []string{}
	}
	return out, nil
}

// DNToDNSName turns the DC= components of a DN into a DNS name
// ("DC=ad,DC=example,DC=com" → "ad.example.com"); "" when the DN has none.
func DNToDNSName(dn string) string {
	parsed, err := goldap.ParseDN(strings.TrimSpace(dn))
	if err != nil {
		return ""
	}
	var labels []string
	for _, rdn := range parsed.RDNs {
		for _, a := range rdn.Attributes {
			if strings.EqualFold(a.Type, "dc") && a.Value != "" {
				labels = append(labels, a.Value)
			}
		}
	}
	return strings.Join(labels, ".")
}
