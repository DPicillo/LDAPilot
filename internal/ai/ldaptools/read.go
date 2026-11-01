package ldaptools

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"unicode"

	goldap "github.com/go-ldap/ldap/v3"

	"github.com/dpicillo/LDAPilot/internal/ai/tools"
	"github.com/dpicillo/LDAPilot/internal/models"
)

type readTool struct {
	def *tools.Def
	run func(ctx context.Context, s *Session, c *Call) *tools.Result
}

func (t *readTool) Def() *tools.Def { return t.def }
func (t *readTool) Run(ctx context.Context, s *Session, c *Call) *tools.Result {
	return t.run(ctx, s, c)
}

func checkDN(tool, dn string) *tools.Result {
	if dn == "" {
		return errf(tool, tools.ErrInvalidArguments, "Give a full DN such as CN=Anna Schmidt,OU=Users,DC=example,DC=com.", "dn: is required")
	}
	if _, err := goldap.ParseDN(dn); err != nil {
		return errf(tool, tools.ErrInvalidArguments, "Give a full DN such as CN=Anna Schmidt,OU=Users,DC=example,DC=com.", "dn: not a valid DN (%v)", err)
	}
	return nil
}

func init() {
	register(&readTool{def: &tools.Def{
		Name: "list_connections", DisplayName: "List connections", Kind: tools.KindRead, Timeout: TimeoutLocal,
		Description: "List the LDAP directories you can use in this LDAPilot session: connection name, server type (ad, openldap, 389ds, other), base DN and naming contexts, and your access level (read, write, ask). Call it when you are unsure which directory or base DN to use. Directories the user has not connected or has hidden from you are not listed. Returns no directory entries.",
		Params:      tools.Obj(),
	}, run: runListConnections})

	register(&readTool{def: &tools.Def{
		Name: "get_server_info", DisplayName: "Server info", Kind: tools.KindRead, Timeout: TimeoutRead, Directory: true,
		Description: "Show what a directory server is and what it supports: vendor and version, server type, naming contexts (default, configuration, schema), important controls and features (paged results, server-side sorting, the AD in-chain matching rule, deleted-object controls, password policy, assertions), and for Active Directory the domain, forest and domain-controller functional levels and the DNS host name. Use it before relying on server-specific features or when the user asks about the server. Reads only the RootDSE.",
		Params:      tools.Obj(connectionProp()),
	}, run: runServerInfo})

	register(&readTool{def: &tools.Def{
		Name: "search_ldap", DisplayName: "Search", Kind: tools.KindRead, Timeout: TimeoutCount, Directory: true,
		Description: "Search a directory with an LDAP filter and return matching entries with the attributes you request. Use it for any lookup the specialised tools do not cover. Request only the attributes you need. For 'how many' questions set count_only=true instead of listing entries. Results are paged: if has_more is true, call again with offset=next_offset or narrow the filter. If total_is_lower_bound is true, the server limited the results and the real number may be higher. Secret attributes (passwords, LAPS, BitLocker keys) are never returned and cannot be used in filters. Well-known AD time and flag values are followed by a readable form in brackets.",
		Params: tools.Obj(
			connectionProp(),
			tools.R("filter", tools.Str(`RFC 4515 filter, e.g. (&(objectClass=user)(sAMAccountName=jdoe)). Escape literal * ( ) \ in values as \2a \28 \29 \5c.`).WithMaxLength(4096)),
			tools.P("base_dn", tools.Str("Entry to search below. Default: the connection's base DN.")),
			tools.P("scope", tools.Enum("base = only base_dn, one = direct children, sub = whole subtree.", "sub", "base", "one", "sub")),
			tools.P("attributes", tools.Arr(`Attributes to return, e.g. ["cn","mail"]; a numeric OID exactly as the user gave it (LDAPilot resolves it, never guess its name). Default: cn, objectClass and the login name. Use ["*"] only for a few entries.`, tools.Str(""), 30)),
			tools.P("limit", tools.Int("Maximum entries to return in this call.", 1, 200, 25)),
			tools.P("offset", tools.Int("Matching entries to skip (paging).", 0, 5000, 0)),
			tools.P("count_only", tools.Bool("Only count matches (up to 100000); returns no entries.", false)),
			tools.P("include_total", tools.Bool("Also count all matches (slower on large result sets).", false)),
		),
	}, run: runSearch})

	register(&readTool{def: &tools.Def{
		Name: "get_entry", DisplayName: "Read entry", Kind: tools.KindRead, Timeout: TimeoutRead, Directory: true,
		Description: "Read one entry by its full DN and return its attributes. Without an attribute list it returns all user attributes except noisy replication and system attributes (their names are listed in omitted_attributes); very long multi-valued attributes are shortened (use get_membership for group members). Use it to inspect or explain a single object; for many objects use search_ldap with specific attributes. Secret attributes are redacted.",
		Params: tools.Obj(
			connectionProp(),
			tools.R("dn", tools.Str("Full distinguished name, e.g. CN=Anna Schmidt,OU=Users,DC=example,DC=com.")),
			tools.P("attributes", tools.Arr("Only these attributes. May include operational or constructed ones such as createTimestamp or msDS-User-Account-Control-Computed, or a numeric OID exactly as the user gave it (LDAPilot resolves it, never guess its name).", tools.Str(""), 50)),
			tools.P("include_operational", tools.Bool("Also return operational attributes (createTimestamp, modifyTimestamp, entryUUID, …).", false)),
		),
	}, run: runGetEntry})

	register(&readTool{def: &tools.Def{
		Name: "get_children", DisplayName: "List children", Kind: tools.KindRead, Timeout: TimeoutRead, Directory: true,
		Description: "List the direct children of a container or OU (one level) with each child's DN, RDN and object type. Use it to explore the tree. Results are paged with limit/offset; has_more tells you whether more children exist. To find specific objects below a container, use search_ldap.",
		Params: tools.Obj(
			connectionProp(),
			tools.R("dn", tools.Str("DN of the parent container.")),
			tools.P("type", tools.Enum("Only children of this type.", "any", "any", "user", "group", "computer", "contact", "ou", "container")),
			tools.P("limit", tools.Int("Maximum children to return.", 1, 200, 50)),
			tools.P("offset", tools.Int("Children to skip (paging).", 0, 5000, 0)),
		),
	}, run: runGetChildren})

	register(&readTool{def: &tools.Def{
		Name: "get_schema_definition", DisplayName: "Schema definition", Kind: tools.KindRead, Timeout: TimeoutRead, Directory: true,
		Description: "Look up the schema definition of an attribute type or object class: OID, description, syntax, single- or multi-valued, and for object classes the superior class, kind (structural, auxiliary, abstract) and all required (MUST) and optional (MAY) attributes including inherited ones. Use it before creating entries or when unsure whether an attribute exists or how it is spelled. Unknown names return the closest matches.",
		Params: tools.Obj(
			connectionProp(),
			tools.R("name", tools.Str("Attribute or object class name, or a numeric OID.")),
			tools.P("kind", tools.Enum("What to look up.", "auto", "auto", "attribute", "object_class")),
		),
	}, run: runSchemaDefinition})

	register(&readTool{def: &tools.Def{
		Name: "validate_filter", DisplayName: "Validate filter", Kind: tools.KindRead, Timeout: TimeoutLocal, Directory: true, ConnectionOptional: true,
		Description: "Check an LDAP filter for syntax errors without querying the directory. Returns whether it is valid, where the first problem is when that can be located, and a hint for common mistakes (unbalanced parentheses, unescaped special characters, != instead of (!(attr=value))). With a connection it also reports attribute names that do not exist in that directory's schema. Use it when a search fails with a filter error or before running a complex filter.",
		Params: tools.Obj(
			tools.R("filter", tools.Str("The LDAP filter to check.").WithMaxLength(4096)),
			tools.P(tools.ConnectionParam, tools.Str("Optional: directory whose schema is used to check attribute names.")),
		),
	}, run: runValidateFilter})

	register(&readTool{def: &tools.Def{
		Name: "decode_value", DisplayName: "Decode value", Kind: tools.KindRead, Timeout: TimeoutLocal,
		Description: "Convert directory values into readable form, and dates into directory formats for filters. Kinds: filetime (AD 100-ns timestamps such as pwdLastSet, lastLogonTimestamp, accountExpires, lockoutTime), generalized_time (e.g. 20261029120000Z), duration (negative AD intervals such as maxPwdAge or lockoutDuration), user_account_control, ms_ds_uac_computed, group_type, sam_account_type, supported_encryption_types, sid and guid (base64 binary), plus to_filetime and to_generalized_time, which turn a date ('2026-07-31', 'now', 'now-90d') into the value to use in a filter such as (lastLogonTimestamp<=…). Runs locally without directory access.",
		Params: tools.Obj(
			tools.R("kind", tools.Enum("What the value is.", "", "filetime", "generalized_time", "duration", "user_account_control", "ms_ds_uac_computed", "group_type", "sam_account_type", "supported_encryption_types", "sid", "guid", "to_filetime", "to_generalized_time")),
			tools.R("value", tools.Str("The value to convert.").WithMaxLength(4096)),
		),
	}, run: runDecodeValue})
}

// --- list_connections ---

func runListConnections(ctx context.Context, s *Session, c *Call) *tools.Result {
	r := &tools.Result{OK: true, Tool: c.Tool, DataOrigin: "ldaptool"}
	r.Notes = append(r.Notes, c.Notes...)
	var list []tools.Fields
	for _, conn := range s.Conns {
		level, needsConsent := s.Access.Level(conn.Info.ProfileID)
		if level == "none" {
			continue
		}
		st := conn.Info.ServerType
		if needsConsent {
			if st == "" {
				st = "unknown"
			}
			list = append(list, tools.Fs("name", conn.Label, "server_type", st, "access", "ask", "consent", "required"))
			continue
		}
		f := tools.Fs("name", conn.Label)
		var vendor, defNC string
		var ncs []string
		if dc, err := s.Dir.Client(conn.Info.ProfileID); err == nil {
			if si, err := dc.ServerInfo(ctx); err == nil {
				if si.ServerType != "" {
					st = si.ServerType
				}
				vendor = strings.TrimSpace(si.VendorName + " " + si.VendorVersion)
				defNC = si.DefaultNamingContext
				ncs = si.NamingContexts
			}
		}
		if st == "" {
			st = "other"
		}
		f.Add("server_type", st)
		if vendor != "" {
			f.Add("vendor", vendor)
		}
		f.Add("base_dn", conn.Info.BaseDN)
		if defNC != "" {
			f.Add("default_naming_context", defNC)
		}
		if len(ncs) > 0 {
			f.Add("naming_contexts", ncs)
		}
		f.Add("access", level)
		f.Add("read_only_profile", conn.Info.ReadOnly)
		f.Add("active", conn.Info.ProfileID == s.ActiveProfileID)
		f.Add("tls", conn.Info.TLS())
		list = append(list, f)
	}
	if list == nil {
		list = []tools.Fields{}
	}
	r.Fields.Add("connections", list)
	if len(list) == 0 {
		r.Note("No directory is available to you. Ask the user to connect a directory or to allow access in the AI settings.")
	}
	r.Summary = Plural(len(list), "connection", "connections")
	return r
}

// --- get_server_info ---

var controlNames = map[string]string{
	"1.2.840.113556.1.4.319":    "paged_results",
	"1.2.840.113556.1.4.473":    "server_side_sort",
	"1.2.840.113556.1.4.417":    "show_deleted",
	"1.2.840.113556.1.4.2064":   "show_recycled",
	"1.2.840.113556.1.4.2065":   "show_deactivated_link",
	"1.2.840.113556.1.4.805":    "tree_delete",
	"1.2.840.113556.1.4.801":    "sd_flags",
	"1.2.840.113556.1.4.528":    "notification",
	"1.2.840.113556.1.4.1339":   "domain_scope",
	"1.2.840.113556.1.4.1340":   "search_options",
	"1.2.840.113556.1.4.1413":   "permissive_modify",
	"1.2.840.113556.1.4.1504":   "attribute_scoped_query",
	"1.2.840.113556.1.4.841":    "dirsync",
	"2.16.840.1.113730.3.4.9":   "vlv",
	"2.16.840.1.113730.3.4.2":   "manage_dsa_it",
	"1.3.6.1.1.12":              "assertion",
	"1.3.6.1.1.13.1":            "pre_read",
	"1.3.6.1.1.13.2":            "post_read",
	"1.3.6.1.4.1.42.2.27.8.5.1": "password_policy",
	"1.3.6.1.4.1.4203.1.10.1":   "subentries",
	"1.3.6.1.4.1.4203.1.9.1.1":  "sync_request",
	"2.16.840.1.113730.3.4.18":  "proxied_authorization",
	"1.3.6.1.1.22":              "dont_use_copy",
	"1.3.6.1.4.1.4203.666.5.12": "relax_rules",
	"2.16.840.1.113730.3.4.4":   "password_expired",
	"2.16.840.1.113730.3.4.5":   "password_expiring",
	"1.3.6.1.4.1.42.2.27.9.5.8": "account_usability",
}

var extensionNames = map[string]string{
	"1.3.6.1.4.1.4203.1.11.1":  "password_modify",
	"1.3.6.1.4.1.4203.1.11.3":  "who_am_i",
	"1.3.6.1.4.1.1466.20037":   "start_tls",
	"1.3.6.1.1.8":              "cancel",
	"1.3.6.1.4.1.1466.20036":   "notice_of_disconnection",
	"2.16.840.1.113730.3.5.12": "ds_replication",
}

var functionalLevels = map[string]string{
	"0": "Windows 2000", "1": "Windows Server 2003 interim", "2": "Windows Server 2003", "3": "Windows Server 2008",
	"4": "Windows Server 2008 R2", "5": "Windows Server 2012", "6": "Windows Server 2012 R2", "7": "Windows Server 2016",
	"10": "Windows Server 2025",
}

func namedOIDs(oids []string, names map[string]string) ([]string, int) {
	var out []string
	unknown := 0
	seen := map[string]bool{}
	for _, o := range oids {
		if n, ok := names[o]; ok {
			if !seen[n] {
				seen[n] = true
				out = append(out, n)
			}
		} else {
			unknown++
		}
	}
	sort.Strings(out)
	if out == nil {
		out = []string{}
	}
	return out, unknown
}

// HasControl reports whether the server advertises a control or extension.
func HasControl(si *models.ServerInfo, oid string) bool {
	if si == nil {
		return false
	}
	for _, o := range si.SupportedControls {
		if o == oid {
			return true
		}
	}
	for _, o := range si.SupportedExtensions {
		if o == oid {
			return true
		}
	}
	return false
}

const (
	oidAssertion      = "1.3.6.1.1.12"
	oidPasswordModify = "1.3.6.1.4.1.4203.1.11.1"
	oidPPolicy        = "1.3.6.1.4.1.42.2.27.8.5.1"
	oidInChain        = "1.2.840.113556.1.4.1941"
)

func runServerInfo(ctx context.Context, s *Session, c *Call) *tools.Result {
	si, err := c.Client.ServerInfo(ctx)
	if err != nil {
		return ErrorResult(c.Tool, err, "")
	}
	z := NewSanitizer(false)
	r := newResult(c)
	r.Fields.Add("server_type", si.ServerType)
	if si.VendorName != "" {
		r.Fields.Add("vendor", z.Text(si.VendorName, "vendorName", ""))
	}
	if si.VendorVersion != "" {
		r.Fields.Add("version", z.Text(si.VendorVersion, "vendorVersion", ""))
	}
	r.Fields.Add("naming_contexts", si.NamingContexts)
	if si.DefaultNamingContext != "" {
		r.Fields.Add("default_naming_context", si.DefaultNamingContext)
	}
	if si.ConfigurationNamingContext != "" {
		r.Fields.Add("configuration_naming_context", si.ConfigurationNamingContext)
	}
	if si.SchemaNamingContext != "" {
		r.Fields.Add("schema_naming_context", si.SchemaNamingContext)
	}
	ctrls, unknownC := namedOIDs(si.SupportedControls, controlNames)
	exts, unknownE := namedOIDs(si.SupportedExtensions, extensionNames)
	r.Fields.Add("controls", ctrls)
	if unknownC > 0 {
		r.Fields.Add("other_controls_count", unknownC)
	}
	r.Fields.Add("extensions", exts)
	if unknownE > 0 {
		r.Fields.Add("other_extensions_count", unknownE)
	}
	features := tools.Fs("paged_results", HasControl(si, "1.2.840.113556.1.4.319"), "server_side_sort", HasControl(si, "1.2.840.113556.1.4.473"), "assertion_control", HasControl(si, oidAssertion), "password_policy_control", HasControl(si, oidPPolicy), "password_modify_extended_op", HasControl(si, oidPasswordModify), "deleted_objects", HasControl(si, "1.2.840.113556.1.4.417"))
	if si.ServerType == models.ServerTypeAD {
		features.Add("in_chain_matching_rule", true)
	}
	r.Fields.Add("features", features)
	if si.ServerType == models.ServerTypeAD {
		if e, err := c.Client.RootDSE(ctx, []string{"domainFunctionality", "forestFunctionality", "domainControllerFunctionality", "dnsHostName", "serverName"}); err == nil {
			for _, k := range []string{"domainFunctionality", "forestFunctionality", "domainControllerFunctionality"} {
				if v := attrValue(e, k); v != "" {
					name := functionalLevels[v]
					if name == "" {
						name = "level " + v
					}
					r.Fields.Add(strings.ToLower(k[:1])+k[1:], v+" ["+name+"]")
				}
			}
			if v := attrValue(e, "dnsHostName"); v != "" {
				r.Fields.Add("dns_host_name", z.Text(v, "dnsHostName", ""))
			}
			if v := attrValue(e, "serverName"); v != "" {
				r.Fields.Add("server_name", z.Text(v, "serverName", ""))
			}
		}
		if dom := dnToDomain(si.DefaultNamingContext); dom != "" {
			r.Fields.Add("domain", dom)
		}
		if f := dnToDomain(si.RootDomainNamingContext); f != "" {
			r.Fields.Add("forest", f)
		}
	}
	// Feature tracks: the connection's password storage policy (issue #1)
	// and the AD Recycle Bin (recycle track).
	if pp, ok := c.Client.(PasswordPolicyReader); ok {
		if eff, err := pp.PasswordPolicy(ctx); err == nil && eff != nil {
			pf := tools.Fs("policy", eff.Policy, "summary", eff.Summary)
			if eff.SchemeLabel != "" {
				pf.Add("scheme", eff.SchemeLabel)
			}
			if eff.ServerHashing != "" {
				pf.Add("server_hashing", eff.ServerHashing)
			}
			r.Fields.Add("password_storage", pf)
		}
	}
	if si.ServerType == models.ServerTypeAD {
		if info, err := c.Client.Recycle().Info(ctx); err == nil && info != nil && info.RecycleBinKnown {
			r.Fields.Add("recycle_bin_enabled", info.RecycleBinEnabled)
		}
	}
	r.Warnings = append(r.Warnings, z.Warnings()...)
	r.Summary = fmt.Sprintf("%s server", si.ServerType)
	return r
}

// PasswordPolicyReader is implemented by directory clients that know the
// connection's password storage policy (services/ai_backend.go).
type PasswordPolicyReader interface {
	PasswordPolicy(ctx context.Context) (*models.EffectivePasswordPolicy, error)
}

func dnToDomain(dn string) string {
	var parts []string
	for _, rdn := range splitDN(dn) {
		k, v, ok := strings.Cut(rdn, "=")
		if ok && strings.EqualFold(strings.TrimSpace(k), "dc") {
			parts = append(parts, strings.TrimSpace(v))
		}
	}
	return strings.Join(parts, ".")
}

// --- search_ldap ---

// pageCache keeps the ordered, de-duplicated entries seen so far for one
// (connection, base, scope, filter, attributes) so that offset paging is
// stable although servers do not guarantee an order.
type pageCache struct {
	entries     []models.LDAPEntry
	seen        map[string]bool
	complete    bool
	serverLimit int // > 0 when the server limited the result
}

func (p *pageCache) add(es []models.LDAPEntry) {
	for _, e := range es {
		k := strings.ToLower(e.DN)
		if !p.seen[k] {
			p.seen[k] = true
			p.entries = append(p.entries, e)
		}
	}
}

func scopeOf(s string) models.SearchScope {
	switch s {
	case "base":
		return models.ScopeBase
	case "one":
		return models.ScopeOne
	}
	return models.ScopeSub
}

func filterError(tool, filter string, err error) *tools.Result {
	r := errf(tool, tools.ErrInvalidFilter, "Check parentheses and escaping, or call validate_filter.", "Invalid filter: %v", err)
	if pos, hint, ok := FilterProblem(filter); ok {
		r.Err.Hint = hint
		r.WithExtra("position", pos)
	}
	return r
}

// pagedFetch returns the cached sequence for key, extending it to need
// entries with a search when required.
func pagedFetch(ctx context.Context, s *Session, c *Call, key string, p models.SearchParams, need int) (*pageCache, error) {
	cache := s.Shared.Chat(s.ChatID)
	var pc *pageCache
	if v, ok := cache.Get(key); ok {
		pc = v.(*pageCache)
	}
	if pc != nil && (pc.complete || pc.serverLimit > 0 || len(pc.entries) >= need) {
		return pc, nil
	}
	p.SizeLimit = need
	res, err := searchRetry(ctx, c.Client, p)
	if err != nil {
		return nil, err
	}
	if pc == nil {
		pc = &pageCache{seen: map[string]bool{}}
	}
	pc.add(res.Entries)
	switch {
	case !res.Truncated:
		pc.complete = true
	case len(res.Entries) < need:
		pc.serverLimit = len(res.Entries)
	}
	cache.Put(c.Conn.Info.ProfileID, key, pc)
	return pc, nil
}

// searchRetry retries once after a cancellation by LDAPilot itself (user
// cancel or reconnect) while the run is still live (§3.6).
func searchRetry(ctx context.Context, dc DirClient, p models.SearchParams) (*models.SearchResult, error) {
	res, err := dc.Search(ctx, p)
	if err != nil && ctx.Err() == nil && isSearchCancelled(err) {
		res, err = dc.Search(ctx, p)
	}
	return res, err
}

// searchBaseError maps a search error; a missing base DN gets a hint that
// it is not an empty result, plus the DNs of entries with the same name
// (defect D1: small models guess "OU=Bulk,DC=…" for an OU that lives
// elsewhere and then report 0).
func searchBaseError(ctx context.Context, c *Call, tool string, err error, base string) *tools.Result {
	r := ErrorResult(tool, err, base)
	if r.Code() == tools.ErrNoSuchObject && r.Err != nil && !c.MentionOnly {
		name := unescapeRDNValue(rdnValue(base))
		cands, _ := containerCandidates(ctx, c.Client, name, 5)
		switch {
		case len(cands) > 0:
			r.WithExtra("candidates", outputDNs(r, cands))
			r.Err.Hint = fmt.Sprintf("The base DN does not exist, so this is not an empty result: do not report 0. Entries named %q exist at the DNs in candidates; call again with the right one as base_dn (count_entries also takes just the name). ", name) + r.Err.Hint
		default:
			find := ""
			if rdn := rdnOf(base); strings.Contains(rdn, "=") {
				find = " (e.g. search_ldap with filter (" + rdn + ") from the default base)"
			}
			r.Err.Hint = "The base DN does not exist, so this is not an empty result: do not report 0. Find the container first" + find + " and use its DN. " + r.Err.Hint
		}
	}
	return r
}

// entryDNError maps the error of a tool that takes one entry DN (get_entry,
// get_membership, get_account_status). A missing DN lists the DNs of
// entries with the same name: small models guess "CN=G,OU=Groups,DC=…" for
// a group that lives elsewhere and then report that it does not exist
// (test-2 S2).
func entryDNError(ctx context.Context, c *Call, err error, dn string) *tools.Result {
	var r *tools.Result
	if err != nil {
		r = ErrorResult(c.Tool, err, dn)
	} else {
		r = errf(c.Tool, tools.ErrNoSuchObject, "Use search_ldap to find the correct DN.", "No entry with DN %s.", dnOrDash(dn))
	}
	if r.Code() != tools.ErrNoSuchObject || r.Err == nil {
		return r
	}
	name := unescapeRDNValue(rdnValue(dn))
	if c.MentionOnly {
		// Allowed only by an @entry mention on an "ask" directory: the
		// mention is consent for exactly that DN (§6.1), not for a
		// subtree search that would hand other entries' DNs to the model.
		r.Err.Hint = "The mentioned entry may have been renamed, moved or deleted; ask the user, or find it with search_ldap (which needs the user's consent for this directory). " + r.Err.Hint
		return r
	}
	cands, _ := entryCandidates(ctx, c.Client, name, 5)
	if len(cands) > 0 {
		r.WithExtra("candidates", outputDNs(r, cands))
		r.Err.Hint = fmt.Sprintf("The entry does not exist at this DN. Entries named %q exist at the DNs in candidates; call again with the right one as dn. ", name) + r.Err.Hint
	} else if rdn := rdnOf(dn); strings.Contains(rdn, "=") {
		r.Err.Hint = "Do not conclude that the entry does not exist: find it first, e.g. search_ldap with filter (" + rdn + ") from the default base, and use its DN. " + r.Err.Hint
	}
	return r
}

// outputDNs sanitizes directory DNs for a tool result (they come from the
// directory, not from the model): invisible characters are escaped and
// template tokens neutralized like every other DN in a result, and the
// warnings go into r so the suspicious flag can suspend grants (§6.6).
func outputDNs(r *tools.Result, dns []string) []string {
	z := NewSanitizer(false)
	out := make([]string, len(dns))
	for i, dn := range dns {
		out[i] = z.DN(dn)
	}
	for _, w := range z.Warnings() {
		r.Warn(w)
	}
	return out
}

// outputDN is outputDNs for one DN.
func outputDN(r *tools.Result, dn string) string { return outputDNs(r, []string{dn})[0] }

// entryCandidates returns the DNs of entries named name (cn, ou, uid; on AD
// also name and sAMAccountName) below the base DN, at most limit.
func entryCandidates(ctx context.Context, dc DirClient, name string, limit int) ([]string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, nil
	}
	v := goldap.EscapeFilter(name)
	f := "(|(cn=" + v + ")(ou=" + v + ")(uid=" + v + "))"
	if serverType(ctx, dc) == models.ServerTypeAD {
		f = "(|(cn=" + v + ")(ou=" + v + ")(name=" + v + ")(sAMAccountName=" + v + "))"
	}
	res, err := searchRetry(ctx, dc, models.SearchParams{BaseDN: baseDN(ctx, dc), Filter: f, Scope: models.ScopeSub, Attributes: []string{"1.1"}, SizeLimit: limit, TimeLimit: int(TimeoutRead.Seconds())})
	if err != nil {
		if isNoSuchObject(err) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]string, 0, len(res.Entries))
	for _, e := range res.Entries {
		out = append(out, e.DN)
	}
	return out, nil
}

func matchAll(filter string) bool {
	f := strings.ToLower(strings.ReplaceAll(filter, " ", ""))
	return f == "(objectclass=*)"
}

// scopeKinds counts the entries of the search scope by their most specific
// object class (structuralObjectClass, else the last objectClass value).
func scopeKinds(ctx context.Context, c *Call, p models.SearchParams) (tools.Fields, int, bool) {
	const limit = 2000
	p.Filter = "(objectClass=*)"
	p.Attributes = []string{"objectClass", "structuralObjectClass"}
	p.SizeLimit = limit + 1
	res, err := searchRetry(ctx, c.Client, p)
	if err != nil || res == nil {
		return nil, 0, false
	}
	counts := map[string]int{}
	n := 0
	for i := range res.Entries {
		if n >= limit {
			break
		}
		e := &res.Entries[i]
		n++
		// The most specific class is the last value that is not "top":
		// AD and Samba list the hierarchy top first (Samba also returns
		// structuralObjectClass multi-valued that way); OpenLDAP's
		// structuralObjectClass has one value.
		k := ""
		for _, attr := range []string{"structuralObjectClass", "objectClass"} {
			vs := attrValues(e, attr)
			for j := len(vs) - 1; j >= 0 && k == ""; j-- {
				if !strings.EqualFold(vs[j], "top") {
					k = vs[j]
				}
			}
			if k != "" {
				break
			}
		}
		if k == "" {
			k = "unknown"
		}
		counts[k]++
	}
	names := make([]string, 0, len(counts))
	for k := range counts {
		names = append(names, k)
	}
	sort.Slice(names, func(i, j int) bool {
		if counts[names[i]] != counts[names[j]] {
			return counts[names[i]] > counts[names[j]]
		}
		return names[i] < names[j]
	})
	var out tools.Fields
	for i, k := range names {
		if i == 8 {
			break
		}
		out.Add(k, counts[k])
	}
	return out, n, len(res.Entries) > limit || res.Truncated
}

// repairFilter returns filter, or a repaired form when it does not compile
// but the repair does: spaces between components are removed ("(& (a=b)
// (c=d))", typical for small models), and side-by-side components without
// an operator ("(a=b)(c=d)", defect D6) are combined with (&…). The
// original compile error is returned when no repair helps.
func repairFilter(filter string) (string, bool, error) {
	_, err := goldap.CompileFilter(filter)
	if err == nil {
		return filter, false, nil
	}
	sq := SqueezeFilterSpaces(filter)
	if sq != filter {
		if _, e := goldap.CompileFilter(sq); e == nil {
			return sq, true, nil
		}
	}
	if adjacentComponents(sq) {
		and := "(&" + sq + ")"
		if _, e := goldap.CompileFilter(and); e == nil {
			return and, true, nil
		}
	}
	return filter, false, err
}

// adjacentComponents reports whether f is two or more complete,
// parenthesized components side by side, e.g. "(a=b)(c=d)".
func adjacentComponents(f string) bool {
	depth, parts := 0, 0
	esc := false
	for _, ch := range f {
		switch {
		case esc:
			esc = false
		case ch == '\\':
			esc = true
		case ch == '(':
			depth++
		case ch == ')':
			depth--
			if depth == 0 {
				parts++
			}
			if depth < 0 {
				return false
			}
		default:
			if depth == 0 {
				return false
			}
		}
	}
	return depth == 0 && parts >= 2
}

// SqueezeFilterSpaces removes whitespace between filter components (after
// "(" and the operators &, |, !, around parentheses, and before a
// comparison operator). Whitespace inside values is kept.
func SqueezeFilterSpaces(f string) string {
	r := []rune(f)
	var out []rune
	for i := 0; i < len(r); i++ {
		if !unicode.IsSpace(r[i]) {
			out = append(out, r[i])
			continue
		}
		j := i
		for j < len(r) && unicode.IsSpace(r[j]) {
			j++
		}
		var prev, next rune
		if len(out) > 0 {
			prev = out[len(out)-1]
		}
		if j < len(r) {
			next = r[j]
		}
		structural := prev == 0 || prev == '(' || prev == ')' || prev == '&' || prev == '|' || prev == '!' ||
			next == 0 || next == '(' && (prev == ')' || prev == '&' || prev == '|' || prev == '!') ||
			next == '=' || (next == '~' || next == '>' || next == '<') && j+1 < len(r) && r[j+1] == '=' ||
			next == ')' && (prev == ')')
		if structural {
			i = j - 1
			continue
		}
		out = append(out, r[i:j]...)
		i = j - 1
	}
	return string(out)
}

func countMatches(ctx context.Context, c *Call, p models.SearchParams) (total int, lowerBound bool, limitedBy string, err error) {
	p.Attributes = []string{"1.1"}
	p.SizeLimit = 100001
	res, err := searchRetry(ctx, c.Client, p)
	if err != nil {
		return 0, false, "", err
	}
	n := len(res.Entries)
	switch {
	case n >= 100001:
		return 100000, true, "harness", nil
	case res.Truncated:
		return n, true, "server", nil
	}
	return n, false, "", nil
}

func defaultAttrs(st string) []string {
	if st == models.ServerTypeAD {
		return []string{"cn", "objectClass", "sAMAccountName"}
	}
	return []string{"cn", "objectClass", "uid"}
}

func runSearch(ctx context.Context, s *Session, c *Call) *tools.Result {
	filter := strings.TrimSpace(c.Args.Str("filter"))
	if filter == "" {
		filter = "(objectClass=*)"
	}
	if !strings.HasPrefix(filter, "(") {
		filter = "(" + filter + ")"
	}
	filter, squeezed, err := repairFilter(filter)
	if err != nil {
		return filterError(c.Tool, filter, err)
	}
	red := s.redactor(ctx, c.Client)
	if secret, _ := red.CheckFilter(filter); secret != "" {
		return errf(c.Tool, tools.ErrRedactedAttribute, "Secret attributes cannot be used in filters.", "The filter uses the secret attribute %s.", red.RedactedName(secret))
	}
	st := serverType(ctx, c.Client)
	base := cleanDN(c.Args.Str("base_dn"))
	if base == "" {
		base = baseDN(ctx, c.Client)
	} else if r := checkDN(c.Tool, base); r != nil {
		return r
	}
	scopeName := c.Args.Str("scope")
	if scopeName == "" {
		scopeName = "sub"
	}
	limit := c.Args.Int("limit", 25)
	offset := c.Args.Int("offset", 0)
	r := newResult(c)
	r.Fields.Add("base_dn", base)
	r.Fields.Add("scope", scopeName)
	r.Fields.Add("filter", filter)
	if squeezed {
		r.Note("The filter was repaired: spaces between the components were removed and/or side-by-side components were combined with (&…). LDAP filters have no spaces outside values.")
	}
	p := models.SearchParams{BaseDN: base, Filter: filter, Scope: scopeOf(scopeName), TimeLimit: int(TimeoutCount.Seconds())}

	if c.Args.Bool("count_only", false) {
		total, lb, by, err := countMatches(ctx, c, p)
		if err != nil {
			return searchBaseError(ctx, c, c.Tool, err, base)
		}
		r.Fields.Add("count_only", true)
		r.Fields.Add("total", total)
		if lb {
			r.Fields.Add("total_is_lower_bound", true)
			r.Fields.Add("limited_by", by)
			if by == "server" {
				r.Fields.Add("server_limit", total)
				r.Note("SIZE_LIMIT: The server returns at most %d entries for this account; narrow the filter or base DN.", total)
			}
		}
		if total == 0 && !matchAll(filter) {
			// "How many users in OU=X" → 0 is easy to misreport when the
			// scope holds other kinds (e.g. 1500 contacts): say what is there.
			if kinds, n, more := scopeKinds(ctx, c, p); n > 0 {
				r.Fields.Add("entries_in_scope", n)
				if more {
					r.Fields.Add("entries_in_scope_is_lower_bound", true)
				}
				r.Fields.Add("object_classes_in_scope", kinds)
				r.Note("No entry matches the filter, but the scope holds other entries (see object_classes_in_scope). Mention them if they answer the question, e.g. contacts instead of users.")
			}
		}
		r.Summary = fmt.Sprintf("count %d%s", total, map[bool]string{true: "+", false: ""}[lb])
		return r
	}

	requested := c.Args.Strings("attributes")
	for _, a := range requested {
		if strings.TrimSpace(a) == "+" {
			return errf(c.Tool, tools.ErrInvalidArguments, "Name the operational attributes you need, e.g. createTimestamp, modifyTimestamp.", `attributes: "+" is not supported`)
		}
	}
	if len(requested) == 0 {
		requested = defaultAttrs(st)
	}
	kept, redacted, bad := red.RequestAttrs(requested)
	if bad != "" {
		return errf(c.Tool, tools.ErrRedactedAttribute, "Use the attribute name.", "%s", bad)
	}
	wildcard := false
	for _, a := range kept {
		if a == "*" {
			wildcard = true
		}
	}
	if wildcard {
		// Learn the attribute names first (typesOnly), then request them
		// explicitly without secrets, so secret values are never fetched.
		tp := p
		tp.SizeLimit = offset + limit + 1
		types, err := c.Client.SearchTypesOnly(ctx, tp)
		if err != nil && len(types) == 0 {
			return searchBaseError(ctx, c, c.Tool, err, base)
		}
		names := map[string]string{}
		for _, attrs := range types {
			for _, a := range attrs {
				names[strings.ToLower(a)] = a
			}
		}
		var expanded []string
		for _, a := range kept {
			if a != "*" {
				names[strings.ToLower(a)] = a
			}
		}
		for _, a := range names {
			if red.IsSecret(a) {
				redacted = appendUniqueFold(redacted, red.RedactedLabel(a))
				continue
			}
			expanded = append(expanded, a)
		}
		sort.Strings(expanded)
		kept = expanded
		if len(kept) == 0 {
			kept = []string{"objectClass"}
		}
	}
	if len(kept) == 0 {
		kept = []string{"objectClass"}
	}
	p.Attributes = kept
	p.TimeLimit = int(TimeoutRead.Seconds())
	key := fmt.Sprintf("search|%s|%s|%d|%s|%s", c.Conn.Info.ProfileID, strings.ToLower(base), p.Scope, filter, strings.ToLower(strings.Join(kept, ",")))
	pc, err := pagedFetch(ctx, s, c, key, p, offset+limit+1)
	if err != nil {
		return searchBaseError(ctx, c, c.Tool, err, base)
	}
	if pc.serverLimit > 0 && offset >= pc.serverLimit {
		return errf(c.Tool, tools.ErrSizeLimit, "Narrow the filter or base DN.", "The server returns at most %d entries for this account; offset %d is beyond that.", pc.serverLimit, offset)
	}
	if len(redacted) > 0 {
		r.Fields.Add("redacted_attributes", redacted)
		r.Notes = append(r.Notes, red.OIDNotes(requested)...)
	}
	if c.Args.Bool("include_total", false) {
		if pc.complete {
			r.Fields.Add("total", len(pc.entries))
		} else if total, lb, by, err := countMatches(ctx, c, p); err == nil {
			r.Fields.Add("total", total)
			if lb {
				r.Fields.Add("total_is_lower_bound", true)
				r.Fields.Add("limited_by", by)
			}
		}
	}
	if pc.serverLimit > 0 {
		r.Fields.Add("total_is_lower_bound", true)
		r.Fields.Add("limited_by", "server")
		r.Fields.Add("server_limit", pc.serverLimit)
		r.Note("SIZE_LIMIT: The server returns at most %d entries for this account; narrow the filter or base DN.", pc.serverLimit)
	}
	z := NewSanitizer(red.MaskPasswords())
	end := min(offset+limit, len(pc.entries))
	var items []any
	for i := offset; i < end; i++ {
		e := pc.entries[i]
		attrs, _, _ := renderAttrs(e, red, z, 25, nil, &r.Notes)
		dn := z.DN(e.DN)
		r.DNs = append(r.DNs, e.DN)
		items = append(items, tools.Fs("dn", dn, "attrs", attrs))
	}
	if items == nil {
		items = []any{}
	}
	more := len(pc.entries) > end || pc.serverLimit > 0
	r.List = &tools.List{Key: "entries", Items: items, Offset: offset, More: more, Total: -1}
	if pc.complete {
		r.List.Total = len(pc.entries)
	}
	r.Warnings = append(r.Warnings, z.Warnings()...)
	r.Summary = Plural(len(items), "entry", "entries")
	if r.List.More || len(pc.entries) > end {
		r.Summary += " (has more)"
	}
	return r
}

func appendUniqueFold(list []string, v string) []string {
	for _, x := range list {
		if strings.EqualFold(x, v) {
			return list
		}
	}
	return append(list, v)
}

// --- get_entry ---

func runGetEntry(ctx context.Context, s *Session, c *Call) *tools.Result {
	dn := cleanDN(c.Args.Str("dn"))
	if r := checkDN(c.Tool, dn); r != nil {
		return r
	}
	red := s.redactor(ctx, c.Client)
	requested := c.Args.Strings("attributes")
	includeOp := c.Args.Bool("include_operational", false)
	var omit map[string]bool
	var redacted []string
	var attrs []string
	if len(requested) == 0 || len(requested) == 1 && requested[0] == "*" {
		types, err := c.Client.SearchTypesOnly(ctx, models.SearchParams{BaseDN: dn, Filter: "(objectClass=*)", Scope: models.ScopeBase, SizeLimit: 1, TimeLimit: int(TimeoutRead.Seconds())})
		if err != nil {
			return entryDNError(ctx, c, err, dn)
		}
		if len(types) == 0 {
			return entryDNError(ctx, c, nil, dn)
		}
		omit = noiseAttrs
		for _, names := range types {
			for _, a := range names {
				if red.IsSecret(a) {
					redacted = appendUniqueFold(redacted, red.RedactedLabel(a))
					continue
				}
				attrs = append(attrs, a)
			}
		}
	} else {
		kept, red2, bad := red.RequestAttrs(requested)
		if bad != "" {
			return errf(c.Tool, tools.ErrRedactedAttribute, "Use the attribute name.", "%s", bad)
		}
		for _, a := range kept {
			if a == "+" {
				includeOp = true
				continue
			}
			if a != "*" {
				attrs = append(attrs, a)
			}
		}
		redacted = red2
	}
	if includeOp {
		attrs = append(attrs, "+")
	}
	if len(attrs) == 0 {
		attrs = []string{"objectClass"}
	}
	res, err := searchRetry(ctx, c.Client, models.SearchParams{BaseDN: dn, Filter: "(objectClass=*)", Scope: models.ScopeBase, Attributes: attrs, SizeLimit: 1, TimeLimit: int(TimeoutRead.Seconds())})
	if err != nil {
		return entryDNError(ctx, c, err, dn)
	}
	if len(res.Entries) == 0 {
		return entryDNError(ctx, c, nil, dn)
	}
	e := res.Entries[0]
	r := newResult(c)
	z := NewSanitizer(red.MaskPasswords())
	fields, omitted, red3 := renderAttrs(e, red, z, 50, omit, &r.Notes)
	for _, x := range red3 {
		redacted = appendUniqueFold(redacted, red.RedactedLabel(x))
	}
	r.Fields.Add("dn", z.DN(e.DN))
	ocs := objectClasses(e)
	r.Fields.Add("object_classes", ocs)
	r.Fields.Add("attrs", fields)
	if len(omitted) > 0 {
		sort.Strings(omitted)
		r.Fields.Add("omitted_attributes", omitted)
	}
	if len(redacted) > 0 {
		r.Fields.Add("redacted_attributes", redacted)
		r.Notes = append(r.Notes, red.OIDNotes(requested)...)
	}
	r.Warnings = append(r.Warnings, z.Warnings()...)
	r.DNs = []string{e.DN}
	r.Summary = fmt.Sprintf("1 entry, %d attributes", len(fields))
	return r
}

// --- get_children ---

func childFilter(kind, st string) string {
	switch kind {
	case "user":
		if st == models.ServerTypeAD {
			return "(&(objectCategory=person)(objectClass=user))"
		}
		return "(|(objectClass=inetOrgPerson)(objectClass=posixAccount)(objectClass=person))"
	case "group":
		return "(|(objectClass=group)(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))"
	case "computer":
		return "(objectClass=computer)"
	case "contact":
		return "(objectClass=contact)"
	case "ou":
		return "(objectClass=organizationalUnit)"
	case "container":
		return "(|(objectClass=container)(objectClass=builtinDomain)(objectClass=organization)(objectClass=domain))"
	}
	return "(objectClass=*)"
}

func runGetChildren(ctx context.Context, s *Session, c *Call) *tools.Result {
	dn := cleanDN(c.Args.Str("dn"))
	if r := checkDN(c.Tool, dn); r != nil {
		return r
	}
	kind := c.Args.Str("type")
	if kind == "" {
		kind = "any"
	}
	limit, offset := c.Args.Int("limit", 50), c.Args.Int("offset", 0)
	st := serverType(ctx, c.Client)
	filter := childFilter(kind, st)
	p := models.SearchParams{BaseDN: dn, Filter: filter, Scope: models.ScopeOne, Attributes: []string{"objectClass", "cn", "ou", "name"}, TimeLimit: int(TimeoutRead.Seconds())}
	key := fmt.Sprintf("children|%s|%s|%s", c.Conn.Info.ProfileID, strings.ToLower(dn), kind)
	pc, err := pagedFetch(ctx, s, c, key, p, offset+limit+1)
	if err != nil {
		return searchBaseError(ctx, c, c.Tool, err, dn)
	}
	if pc.serverLimit > 0 && offset >= pc.serverLimit {
		return errf(c.Tool, tools.ErrSizeLimit, "Use search_ldap with a narrower filter.", "The server returns at most %d entries for this account; offset %d is beyond that.", pc.serverLimit, offset)
	}
	r := newResult(c)
	r.Fields.Add("dn", dn)
	r.Fields.Add("type", kind)
	z := NewSanitizer(false)
	end := min(offset+limit, len(pc.entries))
	items := []any{}
	for i := offset; i < end; i++ {
		e := pc.entries[i]
		r.DNs = append(r.DNs, e.DN)
		items = append(items, tools.Fs("dn", z.DN(e.DN), "rdn", z.Text(rdnOf(e.DN), "rdn", e.DN), "type", objectType(objectClasses(e))))
	}
	r.List = &tools.List{Key: "children", Items: items, Offset: offset, More: len(pc.entries) > end || pc.serverLimit > 0, Total: -1}
	if pc.complete {
		r.List.Total = len(pc.entries)
		r.Fields.Add("total", len(pc.entries))
	}
	if pc.serverLimit > 0 {
		r.Fields.Add("total_is_lower_bound", true)
		r.Fields.Add("limited_by", "server")
		r.Fields.Add("server_limit", pc.serverLimit)
	}
	r.Warnings = append(r.Warnings, z.Warnings()...)
	r.Summary = Plural(len(items), "child", "children")
	if r.List.More {
		r.Summary += " (has more)"
	}
	return r
}

// --- get_schema_definition ---

func runSchemaDefinition(ctx context.Context, s *Session, c *Call) *tools.Result {
	name := strings.TrimSpace(c.Args.Str("name"))
	kind := c.Args.Str("kind")
	sch := s.Shared.Schema(ctx, c.Client)
	if sch == nil {
		return errf(c.Tool, tools.ErrLDAP, "", "The schema of this directory could not be read.")
	}
	red := NewRedactor(s.redactPolicy(), sch)
	r := newResult(c)
	if kind != "object_class" {
		if a := sch.Attr(name); a != nil {
			r.Fields.Add("kind", "attribute")
			r.Fields.Add("name", a.Name())
			if len(a.Names) > 1 {
				r.Fields.Add("aliases", a.Names[1:])
			}
			r.Fields.Add("oid", a.OID)
			if a.Desc != "" {
				r.Fields.Add("description", a.Desc)
			}
			r.Fields.Add("syntax", a.Syntax)
			if n := syntaxNames[a.Syntax]; n != "" {
				r.Fields.Add("syntax_name", n)
			}
			r.Fields.Add("single_valued", a.SingleValue)
			if a.Sup != "" {
				r.Fields.Add("superior", a.Sup)
			}
			r.Fields.Add("usage", a.Usage)
			if a.NoUserMod {
				r.Fields.Add("no_user_modification", true)
			}
			if red.IsSecret(a.Name()) {
				r.Fields.Add("secret", true)
			}
			r.Summary = "attribute " + a.Name()
			return r
		}
	}
	if kind != "attribute" {
		if oc := sch.Class(name); oc != nil {
			must, may, chain := sch.Inherited(oc)
			r.Fields.Add("kind", "object_class")
			r.Fields.Add("name", oc.Name())
			r.Fields.Add("oid", oc.OID)
			if oc.Desc != "" {
				r.Fields.Add("description", oc.Desc)
			}
			r.Fields.Add("class_kind", oc.Kind)
			r.Fields.Add("superior", oc.Sup)
			r.Fields.Add("inheritance", chain)
			if must == nil {
				must = []string{}
			}
			if may == nil {
				may = []string{}
			}
			r.Fields.Add("must", must)
			r.Fields.Add("may", may)
			r.Summary = "object class " + oc.Name()
			return r
		}
	}
	r.Fields.Add("found", false)
	r.Fields.Add("name", name)
	sugg := sch.Suggest(name, kind == "object_class")
	if kind == "auto" || kind == "" {
		sugg = append(sugg, sch.Suggest(name, true)...)
		if len(sugg) > 5 {
			sugg = sugg[:5]
		}
	}
	r.Fields.Add("closest_matches", sugg)
	r.Summary = "not found"
	return r
}

func (s *Session) redactPolicy() RedactPolicy {
	if s.Redact == nil {
		return RedactPolicy{}
	}
	return s.Redact()
}

// --- validate_filter ---

func runValidateFilter(ctx context.Context, s *Session, c *Call) *tools.Result {
	filter := strings.TrimSpace(c.Args.Str("filter"))
	r := &tools.Result{OK: true, Tool: c.Tool, DataOrigin: "ldaptool"}
	if c.Conn != nil {
		r = newResult(c)
	}
	r.Notes = append(r.Notes, c.Notes...)
	_, err := goldap.CompileFilter(filter)
	if err != nil {
		r.Fields.Add("valid", false)
		r.Fields.Add("error", err.Error())
		if pos, hint, ok := FilterProblem(filter); ok {
			r.Fields.Add("position", pos)
			r.Fields.Add("hint", hint)
		}
		r.Summary = "invalid filter"
		return r
	}
	r.Fields.Add("valid", true)
	attrs, _ := FilterAttributes(filter)
	uniq := []string{}
	for _, a := range attrs {
		uniq = appendUniqueFold(uniq, a)
	}
	r.Fields.Add("attributes", uniq)
	var sch *Schema
	if c.Client != nil {
		sch = s.Shared.Schema(ctx, c.Client)
	}
	red := NewRedactor(s.redactPolicy(), sch)
	unknown, redacted := []string{}, []string{}
	for _, a := range uniq {
		if red.IsSecret(a) {
			redacted = append(redacted, red.RedactedName(a))
		}
		if sch != nil && sch.Attr(a) == nil {
			unknown = append(unknown, a)
		}
	}
	if sch != nil {
		r.Fields.Add("unknown_attributes", unknown)
	}
	if len(redacted) > 0 {
		r.Fields.Add("redacted_attributes", redacted)
		r.Note("Secret attributes cannot be used in filters; search_ldap would reject this filter.")
	}
	r.Summary = "valid filter"
	return r
}

// --- decode_value ---

func runDecodeValue(ctx context.Context, s *Session, c *Call) *tools.Result {
	out, err := DecodeValue(c.Args.Str("kind"), c.Args.Str("value"), s.now())
	if err != nil {
		return errf(c.Tool, tools.ErrInvalidArguments, "", "value: %v", err)
	}
	r := &tools.Result{OK: true, Tool: c.Tool, DataOrigin: "local"}
	r.Notes = append(r.Notes, c.Notes...)
	r.Fields.Add("kind", c.Args.Str("kind"))
	keys := make([]string, 0, len(out))
	for k := range out {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		r.Fields.Add(k, out[k])
	}
	r.Summary = "decoded"
	return r
}
