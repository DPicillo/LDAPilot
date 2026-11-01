package ldaptools

import (
	"context"
	"strings"

	goldap "github.com/go-ldap/ldap/v3"

	"github.com/dpicillo/LDAPilot/internal/ai/tools"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// count_entries answers "how many … in OU=X" in one call (defect D1 / S3 of
// AI test round 2): small models guessed the container's DN, used filters
// that cannot match or listed a truncated OU list. The tool resolves a
// container given by name or by a guessed DN, counts exactly (paged, DNs
// only) and always reports what the container holds per object type, so
// "0 users" next to "1500 contacts" is visible in the same result.

// countKinds are the object types count_entries reports, in output order.
var countKinds = []string{"user", "computer", "group", "contact", "ou", "container"}

// countKindFilter returns the filter of an object type on a server type.
func countKindFilter(kind, st string) string {
	ad := st == models.ServerTypeAD
	switch kind {
	case "user":
		if ad {
			return "(&(objectCategory=person)(objectClass=user))"
		}
		return "(|(objectClass=inetOrgPerson)(objectClass=posixAccount)(objectClass=account)(&(objectClass=person)(!(objectClass=organizationalRole))))"
	case "computer":
		if ad {
			return "(objectClass=computer)"
		}
		return "(objectClass=device)"
	case "group":
		if ad {
			return "(objectClass=group)"
		}
		return "(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup)(objectClass=groupOfURLs))"
	case "contact":
		if ad {
			return "(objectClass=contact)"
		}
		return ""
	case "ou":
		return "(objectClass=organizationalUnit)"
	case "container":
		if ad {
			return "(&(objectClass=container)(!(objectClass=computer)))"
		}
		return "(|(objectClass=container)(objectClass=nsContainer))"
	}
	return "(objectClass=*)"
}

// containerClassFilter matches entries that can hold other entries.
const containerClassFilter = "(|(objectClass=organizationalUnit)(objectClass=container)(objectClass=builtinDomain)(objectClass=domainDNS)(objectClass=domain)(objectClass=organization)(objectClass=nsContainer))"

func init() {
	register(&readTool{def: &tools.Def{
		Name: "count_entries", DisplayName: "Count entries", Kind: tools.KindRead, Timeout: TimeoutCount, Directory: true,
		Description: "Count the entries in a container or OU exactly, e.g. 'how many users are in OU=Accounting?'. Give the container by name (\"Accounting\", \"OU=Accounting\") or DN: LDAPilot finds the container if the DN is not exact. Returns the exact total for object_type and a breakdown of everything in the container by type (users, computers, groups, contacts, OUs, containers), so you can say e.g. '0 users, but 1,500 contacts'. Use this for every 'how many' question about a container; use find_accounts for account states.",
		Params: tools.Obj(
			connectionProp(),
			tools.P("container", tools.Str("Container or OU: a DN, or just its name such as Bulk or OU=Bulk. Default: the whole directory (the connection's base DN).")),
			tools.P("object_type", tools.Enum("What to count.", "any", "any", "user", "computer", "group", "contact", "ou", "container")),
			tools.P("filter", tools.Str("Optional extra RFC 4515 filter that counted entries must also match, e.g. (l=Berlin).").WithMaxLength(2048)),
			tools.P("scope", tools.Enum("sub = everything below the container (default), one = direct children only.", "sub", "sub", "one")),
		),
	}, run: runCountEntries})
}

func runCountEntries(ctx context.Context, s *Session, c *Call) *tools.Result {
	st := serverType(ctx, c.Client)
	kind := c.Args.Str("object_type")
	if kind == "" {
		kind = "any"
	}
	scopeName := c.Args.Str("scope")
	if scopeName == "" {
		scopeName = "sub"
	}
	extra := strings.TrimSpace(c.Args.Str("filter"))
	r := newResult(c)
	if extra != "" {
		if !strings.HasPrefix(extra, "(") {
			extra = "(" + extra + ")"
		}
		fixed, squeezed, err := repairFilter(extra)
		if err != nil {
			return filterError(c.Tool, extra, err)
		}
		if squeezed {
			r.Note("The filter was repaired (spaces or missing (&…) removed/added); LDAP filters have no spaces outside values.")
		}
		extra = fixed
		red := s.redactor(ctx, c.Client)
		if secret, _ := red.CheckFilter(extra); secret != "" {
			return errf(c.Tool, tools.ErrRedactedAttribute, "Secret attributes cannot be used in filters.", "The filter uses the secret attribute %s.", red.RedactedName(secret))
		}
	}
	base, res := resolveContainer(ctx, c, strings.TrimSpace(c.Args.Str("container")), r)
	if res != nil {
		return res
	}
	r.Fields.Add("container_dn", outputDN(r, base))
	r.Fields.Add("scope", scopeName)
	r.Fields.Add("object_type", kind)
	p := models.SearchParams{BaseDN: base, Scope: scopeOf(scopeName), TimeLimit: int(TimeoutCount.Seconds())}
	and := func(fs ...string) string {
		var parts []string
		for _, f := range fs {
			if f != "" {
				parts = append(parts, f)
			}
		}
		switch len(parts) {
		case 0:
			return "(objectClass=*)"
		case 1:
			return parts[0]
		}
		return "(&" + strings.Join(parts, "") + ")"
	}
	notBase := "" // a subtree search includes the container itself
	if p.Scope == models.ScopeSub {
		if rdn := rdnOf(base); strings.Contains(rdn, "=") {
			if k, v, ok := strings.Cut(rdn, "="); ok {
				notBase = "(!(" + strings.TrimSpace(k) + "=" + goldap.EscapeFilter(unescapeRDNValue(strings.TrimSpace(v))) + "))"
			}
		}
	}
	count := func(f string) (int, bool, error) {
		q := p
		q.Filter = f
		n, lb, _, err := countMatches(ctx, c, q)
		return n, lb, err
	}
	kf := countKindFilter(kind, st)
	if kf == "" {
		return errf(c.Tool, tools.ErrUnsupportedOnServer, "Contacts exist on Active Directory only; count users or use search_ldap.", "object_type %s does not exist on this %s server.", kind, st)
	}
	if kind == "any" {
		kf = ""
	}
	total, lb, err := count(and(kf, extra, notBase))
	if err != nil {
		return searchBaseError(ctx, c, c.Tool, err, base)
	}
	r.Fields.Add("total", total)
	if lb {
		r.Fields.Add("total_is_lower_bound", true)
	}
	// Breakdown of the whole scope (without the extra filter): what is there.
	all, allLB, err := count(and(notBase))
	var by tools.Fields
	if err == nil {
		r.Fields.Add("entries_in_container", all)
		if allLB {
			r.Fields.Add("entries_in_container_is_lower_bound", true)
		}
		sum := 0
		for _, k := range countKinds {
			f := countKindFilter(k, st)
			if f == "" {
				continue
			}
			n, _, err := count(and(f, notBase))
			if err != nil {
				continue
			}
			sum += n
			by.Add(k, n)
		}
		if other := all - sum; other > 0 && !allLB {
			by.Add("other", other)
		}
		r.Fields.Add("by_type", by)
	}
	label := kind
	if kind == "any" {
		label = "entries"
	}
	if total == 0 && all > 0 && kind != "any" {
		r.Note("No %s matches, but the container holds %d other entries (see by_type). Say so in the answer, e.g. \"0 %ss, but N contacts\".", label, all, kind)
	}
	r.Note("These counts are exact%s; report them as given.", map[bool]string{true: " lower bounds (the server limited the result)", false: ""}[lb || allLB])
	one, many := kind, pluralKind(kind)
	if kind == "any" {
		one, many = "entry", "entries"
	}
	r.Summary = Plural(total, one, many)
	if lb {
		r.Summary = strings.Replace(r.Summary, " ", "+ ", 1)
	}
	if total == 0 && all > 0 && kind != "any" {
		// "0 users · 1500 other entries": the card says what is there (A-23)
		r.Summary += " · " + Plural(all, "other entry", "other entries")
	}
	return r
}

// unescapeRDNValue removes RDN escapes ("\," → ",") for an equality filter.
func unescapeRDNValue(v string) string {
	if !strings.Contains(v, `\`) {
		return v
	}
	if dn, err := goldap.ParseDN("x=" + v); err == nil && len(dn.RDNs) == 1 && len(dn.RDNs[0].Attributes) == 1 {
		return dn.RDNs[0].Attributes[0].Value
	}
	return v
}

// resolveContainer turns the model's container argument into an existing
// DN: an existing DN is used as is; a name ("Bulk", "OU=Bulk") or a DN
// that does not exist is looked up by its first RDN value below the
// connection's base DN. One match is used (with a note); several are
// returned as candidates; none is an error that says it is not an empty
// result.
func resolveContainer(ctx context.Context, c *Call, in string, r *tools.Result) (string, *tools.Result) {
	if in == "" {
		b := baseDN(ctx, c.Client)
		if b == "" {
			return "", errf(c.Tool, tools.ErrInvalidArguments, "Give the container's DN.", "container: the connection has no base DN.")
		}
		return b, nil
	}
	in = cleanDN(in)
	name := in
	if strings.Contains(in, "=") {
		if _, err := goldap.ParseDN(in); err != nil {
			return "", errf(c.Tool, tools.ErrInvalidArguments, "Give a DN such as OU=Accounting,DC=example,DC=com or just the name Accounting.", "container: not a valid DN (%v)", err)
		}
		if strings.Contains(in, ",") {
			e, err := reread(ctx, c.Client, in, nil)
			if err != nil {
				return "", ErrorResult(c.Tool, err, in)
			}
			if e != nil {
				return in, nil
			}
		}
		name = unescapeRDNValue(rdnValue(in))
	}
	cands, err := containerCandidates(ctx, c.Client, name, 6)
	if err != nil {
		return "", ErrorResult(c.Tool, err, in)
	}
	switch len(cands) {
	case 1:
		// The note names the directory's DN: sanitized like every DN in a
		// result (container_dn is sanitized by the caller).
		shown := outputDN(r, cands[0])
		if strings.Contains(in, ",") {
			r.Note("%s does not exist; counted in %s, the only container named %q.", in, shown, name)
		} else {
			r.Note("Container %q is %s.", name, shown)
		}
		r.Fields.Add("container_resolved_from", in)
		return cands[0], nil
	case 0:
		res := errf(c.Tool, tools.ErrNoSuchObject, "This is not an empty result: do not report 0. Check the name with the user, or browse with get_children.", "No container named %q was found below %s.", name, baseDN(ctx, c.Client))
		return "", res
	}
	res := errf(c.Tool, tools.ErrInvalidArguments, "Ask the user which one is meant, or call count_entries again with one of the candidate DNs.", "Several containers are named %q.", name)
	res.WithExtra("candidates", outputDNs(res, cands))
	return "", res
}

// containerCandidates finds entries named name (ou, cn or name equal to
// it) below the connection's base DN, containers first; at most limit.
func containerCandidates(ctx context.Context, dc DirClient, name string, limit int) ([]string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, nil
	}
	base := baseDN(ctx, dc)
	v := goldap.EscapeFilter(name)
	named := "(|(ou=" + v + ")(cn=" + v + "))"
	if serverType(ctx, dc) == models.ServerTypeAD {
		named = "(|(ou=" + v + ")(cn=" + v + ")(name=" + v + "))"
	}
	var out []string
	for _, f := range []string{"(&" + containerClassFilter + named + ")", named} {
		res, err := searchRetry(ctx, dc, models.SearchParams{BaseDN: base, Filter: f, Scope: models.ScopeSub, Attributes: []string{"1.1"}, SizeLimit: limit, TimeLimit: int(TimeoutRead.Seconds())})
		if err != nil {
			if isNoSuchObject(err) {
				return nil, nil
			}
			return nil, err
		}
		for _, e := range res.Entries {
			out = append(out, e.DN)
		}
		if len(out) > 0 {
			return out, nil
		}
	}
	return out, nil
}

// pluralKind: "user" → "users", "entry" → "entries", "group" → "groups".
func pluralKind(k string) string {
	switch {
	case strings.HasSuffix(k, "y") && !strings.HasSuffix(k, "ey"):
		return strings.TrimSuffix(k, "y") + "ies"
	case strings.HasSuffix(k, "s"):
		return k
	}
	return k + "s"
}
