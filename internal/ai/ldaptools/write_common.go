package ldaptools

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	goldap "github.com/go-ldap/ldap/v3"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// Write-tool helpers: protected areas, risk, LDIF previews, before-state
// hashes and assertion filters.

const maxWritePayload = 256 * 1024

func explanationProp() tools.Prop {
	return tools.R("explanation", tools.Str("One short sentence for the user explaining why this change is made.").WithMaxLength(300))
}

// dnUnder reports whether dn equals base or lies below it (case-insensitive,
// whitespace around RDN separators ignored).
func dnUnder(dn, base string) bool {
	if base == "" {
		return false
	}
	d, err1 := goldap.ParseDN(dn)
	b, err2 := goldap.ParseDN(base)
	if err1 != nil || err2 != nil {
		nd, nb := normDN(dn), normDN(base)
		return nd == nb || strings.HasSuffix(nd, ","+nb)
	}
	return b.AncestorOfFold(d) || b.EqualFold(d)
}

// DNKey is a comparison key for a DN: RDNs split escape-aware, attribute
// types and values lower-cased, blanks around the separators removed
// (word joiners stripped).
func DNKey(dn string) string { return normDN(cleanDN(dn)) }

func normDN(dn string) string {
	parts := splitDN(dn)
	for i, p := range parts {
		k, v, _ := strings.Cut(p, "=")
		parts[i] = strings.ToLower(strings.TrimSpace(k)) + "=" + strings.ToLower(strings.TrimSpace(v))
	}
	return strings.Join(parts, ",")
}

// protectedArea returns a reason when dn lies in a configuration or schema
// area that the assistant must not change (§5.3).
func protectedArea(ctx context.Context, dc DirClient, dn string) string {
	for _, b := range []string{"cn=config", "cn=schema", "cn=monitor", "cn=subschema"} {
		if dnUnder(dn, b) {
			return b
		}
	}
	if si, err := dc.ServerInfo(ctx); err == nil {
		for _, b := range []string{si.SchemaNamingContext, si.ConfigurationNamingContext, si.SubschemaSubentry} {
			if b != "" && dnUnder(dn, b) {
				return b
			}
		}
	}
	return ""
}

func protectedResult(tool, area string) *tools.Result {
	return errf(tool, tools.ErrProtectedArea, "Do not retry; explain to the user how to make this change in LDAPilot's editor.",
		"Configuration and schema changes are not available through the assistant; use LDAPilot's editor (%s).", area)
}

// --- risk (§6.3) ---

var protectedRIDs = map[uint32]string{498: "Enterprise Read-only Domain Controllers", 512: "Domain Admins", 516: "Domain Controllers",
	517: "Cert Publishers", 518: "Schema Admins", 519: "Enterprise Admins", 520: "Group Policy Creator Owners",
	521: "Read-only Domain Controllers", 526: "Key Admins", 527: "Enterprise Key Admins"}

var protectedBuiltinSIDs = map[string]string{"S-1-5-32-544": "Administrators", "S-1-5-32-548": "Account Operators",
	"S-1-5-32-549": "Server Operators", "S-1-5-32-550": "Print Operators", "S-1-5-32-551": "Backup Operators",
	"S-1-5-32-552": "Replicator"}

var highRiskAttrs = toSet("servicePrincipalName", "msDS-AllowedToDelegateTo", "msDS-AllowedToActOnBehalfOfOtherIdentity",
	"msDS-KeyCredentialLink", "sIDHistory", "primaryGroupID", "gPLink", "gPCFileSysPath", "scriptPath",
	"altSecurityIdentities", "userPrincipalName", "dNSHostName", "msDS-GroupMSAMembership", "msDS-SupportedEncryptionTypes",
	"pwdLastSet", "accountExpires", "objectClass", "adminCount")

var riskReadAttrs = []string{"objectClass", "objectSid", "adminCount", "sAMAccountName", "userAccountControl", "primaryGroupID"}

// protectionReason decides by SID (never by display name) whether an
// object is protected; read errors make it protected ("could not be
// determined").
func protectionReason(e *models.LDAPEntry, ad bool) string {
	if e == nil {
		return "protection status could not be determined"
	}
	if attrValue(e, "adminCount") == "1" {
		return "protected object (adminCount=1)"
	}
	if !ad {
		return ""
	}
	sid := attrValue(e, "objectSid")
	if n, ok := protectedBuiltinSIDs[sid]; ok {
		return "protected builtin group " + n + " (" + sid + ")"
	}
	if strings.HasPrefix(sid, "S-1-5-21-") {
		if rid, ok := SIDRID(sid); ok {
			if n, ok := protectedRIDs[rid]; ok {
				return fmt.Sprintf("protected group %s (RID %d)", n, rid)
			}
		}
	}
	if strings.EqualFold(attrValue(e, "sAMAccountName"), "DnsAdmins") {
		return "protected group DnsAdmins"
	}
	if uac, err := strconv.ParseInt(attrValue(e, "userAccountControl"), 10, 64); err == nil && uac&uacServerTrust != 0 {
		return "domain controller account"
	}
	if pg := attrValue(e, "primaryGroupID"); pg == "516" || pg == "521" {
		return "domain controller account"
	}
	return ""
}

func readForRisk(ctx context.Context, dc DirClient, dn string) *models.LDAPEntry {
	res, err := dc.Search(ctx, models.SearchParams{BaseDN: dn, Filter: "(objectClass=*)", Scope: models.ScopeBase, Attributes: riskReadAttrs, SizeLimit: 1})
	if err != nil || len(res.Entries) == 0 {
		return nil
	}
	return &res.Entries[0]
}

type riskAcc struct {
	high    bool
	reasons []string
}

func (r *riskAcc) add(reason string) {
	if reason == "" {
		return
	}
	r.high = true
	for _, x := range r.reasons {
		if x == reason {
			return
		}
	}
	r.reasons = append(r.reasons, reason)
}

func (r *riskAcc) level(base string) string {
	if r.high || base == "high" {
		return "high"
	}
	return "medium"
}

func (r *riskAcc) attrs(names []string, uacBefore, uacAfter string) {
	for _, n := range names {
		l := strings.ToLower(BaseAttr(n))
		if highRiskAttrs[l] {
			r.add("changes " + BaseAttr(n))
		}
		if l == "useraccountcontrol" {
			b, _ := strconv.ParseInt(uacBefore, 10, 64)
			a, err := strconv.ParseInt(uacAfter, 10, 64)
			if err != nil || (a^b)&^int64(uacDisabled) != 0 {
				r.add("changes userAccountControl bits other than ACCOUNTDISABLE")
			}
		}
	}
}

func (r *riskAcc) configArea(dn string) {
	if strings.Contains(strings.ToLower(dn), "cn=configuration,") {
		r.add("target lies below CN=Configuration")
	}
}

// --- LDIF previews (RFC 2849) ---

func ldifSafe(v string) bool {
	if v == "" {
		return true
	}
	if !utf8.ValidString(v) {
		return false
	}
	if v[0] == ' ' || v[0] == ':' || v[0] == '<' || v[len(v)-1] == ' ' {
		return false
	}
	for _, r := range v {
		if r < 0x20 || r > 0x7E {
			return false
		}
	}
	return true
}

func ldifLine(b *strings.Builder, attr, v string) {
	if ldifSafe(v) {
		fmt.Fprintf(b, "%s: %s\n", attr, v)
	} else {
		fmt.Fprintf(b, "%s:: %s\n", attr, base64.StdEncoding.EncodeToString([]byte(v)))
	}
}

func ldifDN(b *strings.Builder, dn string) { ldifLine(b, "dn", dn) }

// LDIFModify renders a modify change record; secret values are replaced.
func LDIFModify(dn string, changes []models.AttributeChange, red *Redactor) string {
	var b strings.Builder
	ldifDN(&b, dn)
	b.WriteString("changetype: modify\n")
	for _, c := range changes {
		fmt.Fprintf(&b, "%s: %s\n", c.Operation, c.Attribute)
		for _, v := range c.Values {
			if red != nil && red.IsSecret(c.Attribute) {
				fmt.Fprintf(&b, "%s: ***\n", c.Attribute)
				continue
			}
			ldifLine(&b, c.Attribute, v)
		}
		b.WriteString("-\n")
	}
	return b.String()
}

// LDIFAdd renders an add change record.
func LDIFAdd(dn string, attrs []models.LDAPAttribute) string {
	var b strings.Builder
	ldifDN(&b, dn)
	b.WriteString("changetype: add\n")
	for _, a := range attrs {
		for _, v := range a.Values {
			ldifLine(&b, a.Name, v)
		}
	}
	return b.String()
}

// --- before-state ---

// beforeHash hashes the touched attributes of an entry (names lower-cased,
// values sorted).
func beforeHash(e *models.LDAPEntry, attrs []string) string {
	h := sha256.New()
	names := append([]string(nil), attrs...)
	sort.Slice(names, func(i, j int) bool { return strings.ToLower(names[i]) < strings.ToLower(names[j]) })
	for _, n := range names {
		vals := append([]string(nil), attrValues(e, n)...)
		sort.Strings(vals)
		fmt.Fprintf(h, "%s\x00%d\x00", strings.ToLower(n), len(vals))
		for _, v := range vals {
			fmt.Fprintf(h, "%s\x00", v)
		}
	}
	if e == nil {
		h.Write([]byte("missing"))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// assertionFilter builds an RFC 4528 assertion from the before-state of the
// touched attributes: each value must still be present, absent attributes
// must still be absent. Attributes without an equality rule are skipped
// (ok=false means nothing could be asserted).
func assertionFilter(e *models.LDAPEntry, attrs []string, sch *Schema) (string, bool) {
	var parts []string
	for _, n := range attrs {
		if sch != nil {
			if at := sch.Attr(n); at != nil && at.Equality == "" {
				continue
			}
		}
		vals := attrValues(e, n)
		if len(vals) == 0 {
			parts = append(parts, "(!("+n+"=*))")
			continue
		}
		if len(vals) > 50 {
			parts = append(parts, "("+n+"=*)")
			continue
		}
		for _, v := range vals {
			parts = append(parts, "("+n+"="+goldap.EscapeFilter(v)+")")
		}
	}
	if len(parts) == 0 {
		return "", false
	}
	f := "(&" + strings.Join(parts, "") + ")"
	if _, err := goldap.CompileFilter(f); err != nil {
		return "", false
	}
	return f, true
}

// --- audit ---

// describeChanges summarizes changes for the audit log, masking secret
// values (the Redactor is a superset of the audit masking).
func describeChanges(changes []models.AttributeChange, red *Redactor) string {
	parts := make([]string, 0, len(changes))
	for _, c := range changes {
		part := c.Operation + " " + c.Attribute
		if len(c.Values) > 0 {
			shown := []string{}
			for i, v := range c.Values {
				if i == 3 {
					shown = append(shown, fmt.Sprintf("+%d more", len(c.Values)-3))
					break
				}
				switch {
				case red != nil && red.IsSecret(c.Attribute):
					v = "***"
				case c.Binary:
					v = "<binary>"
				case utf8.RuneCountInString(v) > 80:
					v = string([]rune(v)[:80]) + "..."
				}
				shown = append(shown, v)
			}
			part += "=[" + strings.Join(shown, "; ") + "]"
		}
		parts = append(parts, part)
	}
	return strings.Join(parts, "; ")
}

// invisibleWarning returns the preview warning when any of the strings
// contains invisible characters.
func invisibleWarning(ss ...string) []string {
	for _, s := range ss {
		for _, r := range s {
			if ai.IsInvisibleRune(r) {
				return []string{"contains invisible characters"}
			}
		}
	}
	return nil
}

// grantScopeFor builds the "approve for this chat" scope.
func grantScopeFor(tool, profileID, label, subtree, groupDN, action string, attrs []string) *ai.GrantScope {
	gs := &ai.GrantScope{Tool: tool, ProfileID: profileID, Subtree: subtree, GroupDN: groupDN, Action: action, Attributes: attrs, MaxUses: 10, DurationMin: 30}
	where := "entries below " + subtree
	if groupDN != "" {
		where = "the group " + groupDN
	}
	what := ""
	if len(attrs) > 0 && action == "" {
		what = ", attributes " + strings.Join(attrs, ", ")
	}
	if action != "" {
		what = ", action " + action
	}
	gs.Description = fmt.Sprintf("Auto-approve %s on %s for %s%s, for 30 min / 10 changes", tool, label, where, what)
	return gs
}

// reread reads the touched attributes again (BeforeHash check).
func reread(ctx context.Context, dc DirClient, dn string, attrs []string) (*models.LDAPEntry, error) {
	res, err := dc.Search(ctx, models.SearchParams{BaseDN: dn, Filter: "(objectClass=*)", Scope: models.ScopeBase, Attributes: append([]string{"objectClass"}, attrs...), SizeLimit: 1})
	if err != nil {
		if isNoSuchObject(err) {
			return nil, nil
		}
		return nil, err
	}
	if len(res.Entries) == 0 {
		return nil, nil
	}
	return &res.Entries[0], nil
}

func entryChanged(tool string) *tools.Result {
	return errf(tool, tools.ErrEntryChanged, "Read the entry again before proposing a change.", "The entry was changed after the preview was shown; nothing was changed.")
}

func lowerAll(ss []string) []string {
	out := make([]string, 0, len(ss))
	seen := map[string]bool{}
	for _, s := range ss {
		l := strings.ToLower(BaseAttr(s))
		if !seen[l] {
			seen[l] = true
			out = append(out, l)
		}
	}
	sort.Strings(out)
	return out
}

func okWrite(c *Call, changed bool, msg string) *tools.Result {
	r := newResult(c)
	r.DataOrigin = ""
	r.Fields.Add("changed", changed)
	if msg != "" {
		r.Fields.Add("message", msg)
	}
	r.Changed = changed
	return r
}
