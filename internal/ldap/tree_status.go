package ldap

import (
	"context"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// Account states a tree listing can show as an overlay on the object icon
// (SPEC UX-1). Only states that the attributes of a one-level search tell
// reliably (a wrong status is worse than none). "locked" (RW1-P-02):
//   - AD: never, the constructed msDS-User-Account-Control-Computed comes
//     only with base-scope reads and a lockoutTime may have expired;
//   - 389DS: accountUnlockTime 19700101000000Z (until an administrator
//     unlocks) or in the future;
//   - OpenLDAP: a timed pwdAccountLockedTime only through olLocked, which
//     evaluates it against the entry's effective ppolicy (lockout duration),
//     the same rule as the account status.
//
// The account status of the editor (Client.AccountStatus) stays
// authoritative; the frontend prefers it once it was read.
const (
	TreeStatusDisabled = "disabled"
	TreeStatusExpired  = "expired"
	TreeStatusLocked   = "locked"
)

// treeStatusAttrs are requested next to the tree attributes. Servers ignore
// attribute names they do not know (pwdAccountLockedTime, accountUnlockTime
// and pwdPolicySubentry are operational and must be named explicitly).
var treeStatusAttrs = []string{"userAccountControl", "accountExpires", "nsAccountLock", "pwdAccountLockedTime", "accountUnlockTime", "pwdPolicySubentry"}

// treeChildAttrs returns the attributes of a one-level tree read.
func treeChildAttrs() []string {
	return append([]string{"dn", "objectClass", "hasSubordinates", "msDS-Approx-Immed-Subordinates"}, treeStatusAttrs...)
}

// treeNodeStatus derives the overlay states of a tree node: AD users,
// computers and service accounts (ACCOUNTDISABLE, accountExpires in the
// past), 389DS (nsAccountLock: TRUE; a lockout by accountUnlockTime) and
// OpenLDAP ppolicy (the permanent lock 000001010000Z, which the account
// track treats as "disabled"; a timed lock when olLocked confirms it).
// olLocked may be nil (no OpenLDAP lock evaluation).
func treeNodeStatus(objectClasses []string, a accountAttrs, now time.Time, olLocked ...func(accountAttrs) bool) []string {
	var out []string
	if _, ok := adAccountKind(objectClasses); ok && a.has("userAccountControl") {
		if uac, ok := a.int64("userAccountControl"); ok && uac&uacAccountDisable != 0 {
			out = append(out, TreeStatusDisabled)
		}
		if exp, ok := a.fileTime("accountExpires"); ok && !exp.After(now) {
			out = append(out, TreeStatusExpired)
		}
		return out
	}
	if !isGenericAccount(objectClasses) {
		return nil
	}
	disabled, _ := boolAttr(a, "nsAccountLock")
	pwdLocked := strings.TrimSpace(a.first("pwdAccountLockedTime"))
	if disabled || pwdLocked == ppolicyPermanentLock {
		out = append(out, TreeStatusDisabled)
	}
	switch {
	case pwdLocked != "" && pwdLocked != ppolicyPermanentLock:
		if len(olLocked) > 0 && olLocked[0] != nil && olLocked[0](a) {
			out = append(out, TreeStatusLocked)
		}
	case dsLockedOut(a.first("accountUnlockTime"), now):
		out = append(out, TreeStatusLocked)
	}
	return out
}

// dsLockedOut: a 389DS accountUnlockTime that still locks the account (the
// epoch = until an administrator unlocks it, else a time in the future).
func dsLockedOut(v string, now time.Time) bool {
	v = strings.TrimSpace(v)
	if v == "" {
		return false
	}
	t, err := parseGeneralizedTime(v)
	if err != nil {
		return false
	}
	return t.Unix() == 0 || t.After(now)
}

// treeOpenLDAPLock returns the OpenLDAP lock evaluation of one tree listing:
// the effective ppolicy of each locked entry decides whether a timed
// pwdAccountLockedTime still locks it, exactly as Client.AccountStatus does.
// The policies come from the client's shared policy cache
// (account_policycache.go), so account status reads and listings read a
// policy once per policyCacheTTL. The evaluation is called sequentially by
// one listing. nil for other server types.
func (c *Client) treeOpenLDAPLock() func(dn string, a accountAttrs) bool {
	info, err := c.ServerInfo()
	if err != nil || info == nil || info.ServerType != models.ServerTypeOpenLDAP {
		return nil
	}
	r := c.accountReader()
	now := time.Now().UTC()
	pr := c.beginPolicyRead(now, policyCacheTTL)
	return func(dn string, a accountAttrs) bool {
		pol, _ := r.ppolicyPolicy(dn, a.first("pwdPolicySubentry"), info, pr.cache)
		pr.finish()
		st := newAccountStatus(dn, models.ServerTypeOpenLDAP, now)
		computePPolicyStatus(st, a, pol, now)
		return st.Locked
	}
}

// Contact detection in tree listings (M-06 / CMD-08): an LDAP person
// (person / organizationalPerson / inetOrgPerson) without an account class
// is a contact when it has none of these attributes; the frontend's
// resolveObjectKind applies the rule to TreeNode.LoginAttributes.
var treeLoginAttrs = []string{"uid", "userPassword", "authPassword", "krbPrincipalName", "sambaNTPassword"}

var treeAccountClasses = map[string]bool{
	"user": true, "posixaccount": true, "shadowaccount": true, "account": true,
	"sambasamaccount": true, "krbprincipalaux": true, "uidobject": true,
	"contact": true, "computer": true, "device": true,
}

// treeKindNeedsAttributes mirrors objectKind.ts kindNeedsAttributes: a
// person-like entry whose kind (user or contact) depends on its attributes.
func treeKindNeedsAttributes(objectClasses []string) bool {
	person := false
	for _, oc := range objectClasses {
		l := strings.ToLower(oc)
		if treeAccountClasses[l] {
			return false
		}
		if l == "person" || l == "organizationalperson" || l == "inetorgperson" {
			person = true
		}
	}
	return person
}

// fillLoginAttributes sets LoginAttributes of the person-like children of
// parentDN with one types-only one-level read (attribute names, never
// password values; not logged: a background read for the icons). Entries the
// read does not return keep nil (unknown, shown as users).
func (c *Client) fillLoginAttributes(parentDN string, nodes []models.TreeNode) {
	idx := map[string]int{}
	for i := range nodes {
		if treeKindNeedsAttributes(nodes[i].ObjectClass) {
			idx[normalizeTreeDN(nodes[i].DN)] = i
		}
	}
	if len(idx) == 0 {
		return
	}
	req := goldap.NewSearchRequest(parentDN, goldap.ScopeSingleLevel, goldap.NeverDerefAliases,
		0, 15, true, "(objectClass=person)", treeLoginAttrs, nil)
	var found map[int][]string
	err := c.read(func(conn *goldap.Conn) error {
		found = map[int][]string{}
		entries, err := c.pagedSearch(context.Background(), conn, req, c.pageSize())
		if err != nil && !goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
			return err
		}
		for _, e := range entries {
			i, ok := idx[normalizeTreeDN(e.DN)]
			if !ok {
				continue
			}
			names := make([]string, 0, len(e.Attributes))
			for _, a := range e.Attributes {
				names = append(names, a.Name)
			}
			found[i] = names
		}
		return nil
	})
	if err != nil {
		return
	}
	for i, names := range found {
		nodes[i].LoginAttributes = names
	}
}

// maxLoginChecks caps LoginAttributesOf.
const maxLoginChecks = 500

// LoginAttributesOf returns, per DN as given, the login attribute names
// (treeLoginAttrs) the entry has; an empty list means none, so an LDAP person
// without an account class is a contact (M-06: search results and member
// pickers). One types-only base read per DN (no values are transferred; not
// logged: a background read for icons and types); DNs whose read fails are
// left out (unknown). At most maxLoginChecks DNs.
func (c *Client) LoginAttributesOf(dns []string) (map[string][]string, error) {
	out := map[string][]string{}
	if len(dns) > maxLoginChecks {
		dns = dns[:maxLoginChecks]
	}
	if len(dns) == 0 {
		return out, nil
	}
	err := c.read(func(conn *goldap.Conn) error {
		for _, dn := range dns {
			req := goldap.NewSearchRequest(dn, goldap.ScopeBaseObject, goldap.NeverDerefAliases, 1, 10, true, "(objectClass=*)", treeLoginAttrs, nil)
			res, err := conn.Search(req)
			if err != nil {
				if isConnDead(conn, err) {
					return err
				}
				continue // no such object, no access, referral: unknown
			}
			names := []string{}
			for _, e := range res.Entries {
				for _, a := range e.Attributes {
					names = append(names, a.Name)
				}
			}
			out[dn] = names
		}
		return nil
	})
	return out, err
}

// normalizeTreeDN compares DNs of one listing (case and blanks after commas).
func normalizeTreeDN(dn string) string {
	parts := strings.Split(dn, ",")
	for i, p := range parts {
		parts[i] = strings.TrimSpace(p)
	}
	return strings.ToLower(strings.Join(parts, ","))
}
