package ldaptools

import (
	"context"
	"fmt"
	"sort"
	"strings"

	goldap "github.com/go-ldap/ldap/v3"

	"github.com/dpicillo/LDAPilot/internal/ai/tools"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// find_by_name (UX A-23): small local models searched cn=test.photo only
// and reported "not found"; this tool tries every attribute a person's or
// object's name lives in (login, display name, first + last name, e-mail;
// AD ambiguous name resolution) and ranks exact login matches first.

func init() {
	register(&readTool{def: &tools.Def{
		Name: "find_by_name", DisplayName: "Find by name", Kind: tools.KindRead, Timeout: TimeoutRead, Directory: true,
		Description: "Find entries by a name as a person would write it: a login (uid, sAMAccountName, userPrincipalName), a full or display name ('Anna Schmidt', 'Schmidt, Anna'), an e-mail address, or the name of a group, computer or OU. Tries all these attributes at once (on Active Directory also ambiguous name resolution), exact matches first, then names starting with the text, then names containing it. Returns each match's DN, type, name, login and mail, best match first. Use it whenever the user names an object without giving its DN, before get_entry, get_account_status, get_membership or a write tool.",
		Params: tools.Obj(
			connectionProp(),
			tools.R("name", tools.Str("The name, login or e-mail address as the user wrote it.").WithMaxLength(256)),
			tools.P("type", tools.Enum("Only objects of this type.", "any", "any", "user", "group", "computer", "contact", "ou")),
			tools.P("base_dn", tools.Str("Entry to search below. Default: the connection's base DN.")),
			tools.P("limit", tools.Int("Maximum matches to return.", 1, 50, 10)),
		),
	}, run: runFindByName})
}

// nameAttrs are read for every match (and used for ranking).
var nameAttrs = []string{"objectClass", "cn", "name", "displayName", "givenName", "sn", "uid", "sAMAccountName", "userPrincipalName", "mail", "ou"}

// anrAttrs are the attributes AD's ambiguous name resolution searches
// (the default ANR set plus the RDN); (anr=…) is left out when one of them
// is redacted, since it would match on that attribute's value.
var anrAttrs = []string{"displayName", "givenName", "sn", "sAMAccountName", "mail", "proxyAddresses", "name", "cn",
	"legacyExchangeDN", "physicalDeliveryOfficeName", "mailNickname", "msExchMailNickname"}

// NameLookupFilters returns the filters find_by_name runs in order (exact,
// prefix, substring) for a name on a server type; the later ones run only
// when the earlier ones found nothing. kindFilter is ANDed to each.
func NameLookupFilters(name, st, kindFilter string) []string {
	return NameLookupFiltersFor(name, st, kindFilter, nil)
}

// NameLookupFiltersFor is NameLookupFilters without the attributes for
// which secret returns true (the user's redaction list: a redacted
// attribute must not be usable as a search oracle, AI-SPEC §6.5).
func NameLookupFiltersFor(name, st, kindFilter string, secret func(string) bool) []string {
	name = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(name), "@"))
	if name == "" {
		return nil
	}
	ok := func(a string) bool { return secret == nil || !secret(a) }
	keep := func(attrs []string) []string {
		var out []string
		for _, a := range attrs {
			if ok(a) {
				out = append(out, a)
			}
		}
		return out
	}
	v := goldap.EscapeFilter(name)
	ad := st == models.ServerTypeAD
	var exact []string
	attrs := []string{"cn", "displayName", "mail", "uid", "ou", "givenName", "sn"}
	if ad {
		attrs = []string{"cn", "name", "displayName", "mail", "sAMAccountName", "userPrincipalName", "ou", "givenName", "sn"}
	}
	for _, a := range keep(attrs) {
		exact = append(exact, "("+a+"="+v+")")
	}
	// "Anna Schmidt" / "Schmidt, Anna": first and last name in either order.
	if first, last, split := splitPersonName(name); split && ok("givenName") && ok("sn") {
		f, l := goldap.EscapeFilter(first), goldap.EscapeFilter(last)
		exact = append(exact, "(&(givenName="+f+")(sn="+l+"))", "(&(givenName="+l+")(sn="+f+"))")
	}
	if ad && len(keep(anrAttrs)) == len(anrAttrs) && !strings.ContainsAny(name, "*()\\") {
		// AD ambiguous name resolution: displayName, givenName, sn,
		// sAMAccountName, mail/proxyAddresses, name, "first last" (prefix
		// matches, so it belongs to the prefix pass in effect, but is cheap
		// and indexed).
		exact = append(exact, "(anr="+v+")")
	}
	and := func(f string) string {
		if kindFilter == "" || kindFilter == "(objectClass=*)" {
			return f
		}
		return "(&" + kindFilter + f + ")"
	}
	if len(exact) == 0 {
		return nil
	}
	out := []string{and("(|" + strings.Join(exact, "") + ")")}
	pre := []string{"cn", "displayName", "mail", "uid", "sn", "givenName"}
	if ad {
		pre = []string{"cn", "displayName", "mail", "sAMAccountName", "userPrincipalName", "sn", "givenName"}
	}
	if pre = keep(pre); len([]rune(name)) >= 2 && len(pre) > 0 {
		var ps []string
		for _, a := range pre {
			ps = append(ps, "("+a+"="+v+"*)")
		}
		out = append(out, and("(|"+strings.Join(ps, "")+")"))
	}
	sub := []string{"cn", "displayName", "mail", "uid"}
	if ad {
		sub = []string{"cn", "displayName", "mail", "sAMAccountName"}
	}
	if sub = keep(sub); len([]rune(name)) >= 3 && len(sub) > 0 {
		var ss []string
		for _, a := range sub {
			ss = append(ss, "("+a+"=*"+v+"*)")
		}
		out = append(out, and("(|"+strings.Join(ss, "")+")"))
	}
	return out
}

// splitPersonName splits "Anna Schmidt" or "Schmidt, Anna" into first and
// last name; "Schmidt, Anna" returns ("Anna", "Schmidt").
func splitPersonName(name string) (first, last string, ok bool) {
	if a, b, found := strings.Cut(name, ","); found {
		a, b = strings.TrimSpace(a), strings.TrimSpace(b)
		if a != "" && b != "" && !strings.ContainsAny(a+b, ",=") {
			return b, a, true
		}
		return "", "", false
	}
	parts := strings.Fields(name)
	if len(parts) != 2 || strings.ContainsAny(name, "=@") {
		return "", "", false
	}
	return parts[0], parts[1], true
}

// nameRank orders matches: an exact login or e-mail first, then an exact
// name, then first + last name, then prefix and substring matches.
func nameRank(e *models.LDAPEntry, name string) (int, string) {
	n := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(name), "@")))
	eq := func(attrs ...string) bool {
		for _, a := range attrs {
			for _, v := range attrValues(e, a) {
				if strings.ToLower(v) == n {
					return true
				}
			}
		}
		return false
	}
	has := func(pred func(string) bool, attrs ...string) bool {
		for _, a := range attrs {
			for _, v := range attrValues(e, a) {
				if pred(strings.ToLower(v)) {
					return true
				}
			}
		}
		return false
	}
	switch {
	case eq("uid", "sAMAccountName", "userPrincipalName", "mail"):
		return 0, "exact login or e-mail"
	case eq("cn", "name", "displayName", "ou"):
		return 1, "exact name"
	}
	if first, last, ok := splitPersonName(name); ok {
		gn, sn := strings.ToLower(attrValue(e, "givenName")), strings.ToLower(attrValue(e, "sn"))
		f, l := strings.ToLower(first), strings.ToLower(last)
		if gn == f && sn == l || gn == l && sn == f {
			return 2, "first and last name"
		}
	}
	if has(func(v string) bool { return strings.HasPrefix(v, n) }, "cn", "displayName", "uid", "sAMAccountName", "userPrincipalName", "mail", "givenName", "sn") {
		return 3, "starts with"
	}
	if has(func(v string) bool { return strings.Contains(v, n) }, "cn", "displayName", "uid", "sAMAccountName", "mail") {
		return 4, "contains"
	}
	return 5, "similar name"
}

func runFindByName(ctx context.Context, s *Session, c *Call) *tools.Result {
	name := strings.TrimSpace(c.Args.Str("name"))
	if name == "" {
		return errf(c.Tool, tools.ErrInvalidArguments, "Give the name as the user wrote it.", "name: is required")
	}
	kind := c.Args.Str("type")
	if kind == "" {
		kind = "any"
	}
	limit := c.Args.Int("limit", 10)
	st := serverType(ctx, c.Client)
	base := cleanDN(c.Args.Str("base_dn"))
	if base != "" {
		if r := checkDN(c.Tool, base); r != nil {
			return r
		}
	} else {
		base = baseDN(ctx, c.Client)
	}
	// The user's redaction list (and the built-in secrets) apply here as in
	// get_entry and search_ldap: a redacted name attribute is neither read,
	// searched (no exact/prefix/substring probe on it) nor returned.
	red := s.redactor(ctx, c.Client)
	var attrs, redacted []string
	for _, a := range nameAttrs {
		if red.IsSecret(a) {
			redacted = append(redacted, a)
		} else {
			attrs = append(attrs, a)
		}
	}
	filters := NameLookupFiltersFor(name, st, childFilter(kind, st), red.IsSecret)
	if len(filters) == 0 {
		return errf(c.Tool, tools.ErrInvalidArguments, "Use search_ldap with an attribute that is not redacted.",
			"All name attributes are redacted in the AI settings (%s).", strings.Join(redacted, ", "))
	}
	var entries []models.LDAPEntry
	used := ""
	truncated := false
	for _, f := range filters {
		res, err := searchRetry(ctx, c.Client, models.SearchParams{BaseDN: base, Filter: f, Scope: models.ScopeSub, Attributes: attrs,
			SizeLimit: 200, TimeLimit: int(TimeoutRead.Seconds())})
		if err != nil {
			if goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) && res != nil && len(res.Entries) > 0 {
				truncated = true
			} else {
				return searchBaseError(ctx, c, c.Tool, err, base)
			}
		}
		if res != nil && len(res.Entries) > 0 {
			entries, used = res.Entries, f
			truncated = truncated || res.Truncated
			break
		}
	}
	// ranking and output see only the attributes that may be sent
	for i := range entries {
		kept := entries[i].Attributes[:0:0]
		for _, a := range entries[i].Attributes {
			if !red.IsSecret(a.Name) {
				kept = append(kept, a)
			}
		}
		entries[i].Attributes = kept
	}
	type ranked struct {
		e     *models.LDAPEntry
		rank  int
		match string
	}
	rs := make([]ranked, 0, len(entries))
	for i := range entries {
		rk, why := nameRank(&entries[i], name)
		rs = append(rs, ranked{&entries[i], rk, why})
	}
	sort.SliceStable(rs, func(i, j int) bool {
		if rs[i].rank != rs[j].rank {
			return rs[i].rank < rs[j].rank
		}
		return strings.ToLower(rs[i].e.DN) < strings.ToLower(rs[j].e.DN)
	})
	z := NewSanitizer(red.MaskPasswords())
	r := newResult(c)
	r.Fields.Add("name", name)
	if kind != "any" {
		r.Fields.Add("type", kind)
	}
	r.Fields.Add("total", len(rs))
	if truncated {
		r.Fields.Add("total_is_lower_bound", true)
	}
	if used != "" {
		r.Fields.Add("filter", used)
	}
	items := []any{}
	for i := 0; i < len(rs) && i < limit; i++ {
		e := rs[i].e
		r.DNs = append(r.DNs, e.DN)
		f := tools.Fs("dn", z.DN(e.DN), "type", objectType(objectClasses(*e)), "name", z.Text(firstNonEmptyAttr(e, "displayName", "cn", "name", "ou"), "name", e.DN))
		if login := firstNonEmptyAttr(e, "sAMAccountName", "uid"); login != "" {
			f.Add("login", z.Text(login, "login", e.DN))
		}
		if m := attrValue(e, "mail"); m != "" {
			f.Add("mail", z.Text(m, "mail", e.DN))
		}
		f.Add("match", rs[i].match)
		items = append(items, f)
	}
	r.List = &tools.List{Key: "matches", Items: items, Offset: 0, More: len(rs) > limit, Total: len(rs)}
	if len(redacted) > 0 {
		r.Fields.Add("redacted_attributes", redacted)
	}
	r.Warnings = append(r.Warnings, z.Warnings()...)
	switch {
	case len(rs) == 0:
		r.Note("No entry named %q was found (login, name, first and last name, e-mail%s). Ask the user for another spelling or the container; do not guess a DN.", name, map[bool]string{true: ", ANR", false: ""}[st == models.ServerTypeAD])
		if len(redacted) > 0 {
			r.Note("Not searched (redacted in the AI settings): %s.", strings.Join(redacted, ", "))
		}
		r.Summary = "no match"
	case len(rs) > 1 && rs[0].rank == rs[1].rank && rs[0].rank <= 2:
		r.Note("Several entries match %q equally well; ask the user which one is meant unless the context decides it.", name)
	}
	if r.Summary == "" {
		r.Summary = Plural(len(rs), "match", "matches")
	}
	return r
}

func firstNonEmptyAttr(e *models.LDAPEntry, names ...string) string {
	for _, n := range names {
		if v := attrValue(e, n); v != "" {
			return v
		}
	}
	return ""
}

// Plural renders "1 entry" / "3 entries".
func Plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", one)
	}
	return fmt.Sprintf("%d %s", n, many)
}
