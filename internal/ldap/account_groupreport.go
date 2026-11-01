package ldap

import (
	"encoding/binary"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// Group reports of the Reports panel that need more than one search:
// empty groups (minus the groups that are some account's primary group) and
// the members of the AD built-in privileged groups. They return entries plus
// computed columns (AccountReportResult.Extra) and no account statuses.

// acctReportExtraGroups and friends are the computed column titles.
const (
	acctReportExtraGroups = "Privileged groups"
	acctReportExtraVia    = "Nested via"
)

// emptyGroupsSpec is the search of the empty groups report on a server type.
type emptyGroupsSpec struct {
	filter  string
	attrs   []string
	columns []string
}

// emptyGroupsSpecFor returns the empty groups search for serverType. AD
// groups keep their members in member; LDAP groups in member
// (groupOfNames), uniqueMember (groupOfUniqueNames) or memberUid
// (posixGroup, RFC 2307; RFC 2307bis posixGroups may use member too).
func emptyGroupsSpecFor(serverType string) emptyGroupsSpec {
	if serverType == models.ServerTypeAD {
		return emptyGroupsSpec{
			filter:  "(&(objectClass=group)(!(member=*)))",
			attrs:   []string{"objectClass", "cn", "sAMAccountName", "description", "groupType", "objectSid"},
			columns: []string{"cn", "sAMAccountName", "description"},
		}
	}
	return emptyGroupsSpec{
		filter: "(|(&(objectClass=groupOfNames)(!(member=*)))" +
			"(&(objectClass=groupOfUniqueNames)(!(uniqueMember=*)))" +
			"(&(objectClass=posixGroup)(!(memberUid=*))(!(member=*))(!(uniqueMember=*))))",
		attrs:   []string{"objectClass", "cn", "description", "gidNumber"},
		columns: []string{"cn", "gidNumber", "description"},
	}
}

// emptyGroupsReport lists groups without members. Groups whose members are
// attached through the primary group (AD primaryGroupID = the group's RID,
// e.g. Domain Users; POSIX gidNumber of a posixAccount) are left out and
// named in a note.
func (c *Client) emptyGroupsReport(params models.AccountReportParams) (*models.AccountReportResult, error) {
	info, err := c.ServerInfo()
	if err != nil {
		return nil, err
	}
	base, err := c.accountReportBase(params, info)
	if err != nil {
		return nil, err
	}
	limit := params.SizeLimit
	if limit <= 0 {
		limit = defaultAccountReportLimit
	}
	spec := emptyGroupsSpecFor(info.ServerType)
	req := goldap.NewSearchRequest(base, goldap.ScopeWholeSubtree, goldap.NeverDerefAliases,
		0, 0, false, spec.filter, spec.attrs, nil)
	entries, err := c.SearchWithControls(req, uint32(c.pageSize()))
	truncated := false
	var notes []string
	if err != nil {
		if !goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
			return nil, err
		}
		truncated = true
		notes = append(notes, "The server's size limit was reached; only part of the directory was checked.")
	}

	// The primary group key of every candidate ("" when it has none).
	keys := make([]string, len(entries))
	var values []string
	attr, prefix := "primaryGroupID", ""
	if info.ServerType != models.ServerTypeAD {
		attr, prefix = "gidNumber", "(objectClass=posixAccount)"
	}
	for i, e := range entries {
		keys[i] = primaryGroupKey(e, info.ServerType)
		if keys[i] != "" {
			values = append(values, keys[i])
		}
	}
	inUse, err := c.reportValuesInUse(base, attr, prefix, values)
	if err != nil {
		return nil, fmt.Errorf("checking primary group members: %w", err)
	}

	result := &models.AccountReportResult{
		Entries:    []models.LDAPEntry{},
		Candidates: len(entries),
		Columns:    spec.columns,
		Statuses:   []models.AccountStatus{},
		Extra:      []map[string]string{},
	}
	var skipped []string
	for i, e := range entries {
		if keys[i] != "" && inUse[keys[i]] {
			skipped = append(skipped, rdnValue(e.DN))
			continue
		}
		if len(result.Entries) >= limit {
			truncated = true
			break
		}
		result.Entries = append(result.Entries, *convertEntry(e))
	}
	if len(skipped) > 0 {
		sort.Strings(skipped)
		how := "accounts have it as their primary group (primaryGroupID)"
		if info.ServerType != models.ServerTypeAD {
			how = "POSIX accounts have its gidNumber as their primary group"
		}
		notes = append(notes, fmt.Sprintf("%d group(s) without member values are not empty because %s: %s.", len(skipped), how, strings.Join(skipped, ", ")))
	}
	result.Notes = notes
	if result.Notes == nil {
		result.Notes = []string{}
	}
	result.TotalCount = len(result.Entries)
	result.Truncated = truncated
	return result, nil
}

// primaryGroupKey returns the value accounts use to name group e as their
// primary group: the RID of an AD domain group (not of a builtin group,
// which can never be a primary group), the gidNumber of a posixGroup.
func primaryGroupKey(e *goldap.Entry, serverType string) string {
	if serverType == models.ServerTypeAD {
		sid := attrBytes(e, "objectSid")
		rid, ok := sidRID(sid)
		// S-1-5-32-x (BUILTIN) has one sub-authority below 32.
		if !ok || len(sid) < 12 || binary.LittleEndian.Uint32(sid[8:12]) == 32 {
			return ""
		}
		return strconv.FormatUint(uint64(rid), 10)
	}
	hasPosix := false
	for _, oc := range e.GetAttributeValues("objectClass") {
		hasPosix = hasPosix || strings.EqualFold(oc, "posixGroup")
	}
	if !hasPosix {
		return ""
	}
	return strings.TrimSpace(e.GetEqualFoldAttributeValue("gidNumber"))
}

// reportValuesInUse returns which of values some entry below base has in
// attr (and matches the filter prefix, e.g. "(objectClass=posixAccount)").
// One OR search with size limit 1 per round: every round finds at least one
// more used value, so a domain with 30 empty groups of which 4 are primary
// groups needs 5 small searches instead of reading every account (servers
// that ignore the size limit, like Samba, answer all values in one round).
func (c *Client) reportValuesInUse(base, attr, prefix string, values []string) (map[string]bool, error) {
	used := map[string]bool{}
	remaining := map[string]bool{}
	for _, v := range values {
		remaining[v] = true
	}
	for round := 0; len(remaining) > 0 && round <= len(values); round++ {
		filter := reportValuesFilter(attr, prefix, remaining)
		req := goldap.NewSearchRequest(base, goldap.ScopeWholeSubtree, goldap.NeverDerefAliases,
			1, 0, false, filter, []string{attr}, nil)
		entries, err := c.accountReader().search(req)
		if err != nil && !goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
			return nil, err
		}
		found := false
		for _, e := range entries {
			for _, v := range e.GetEqualFoldAttributeValues(attr) {
				v = strings.TrimSpace(v)
				if remaining[v] {
					delete(remaining, v)
					used[v] = true
					found = true
				}
			}
		}
		if !found {
			break
		}
	}
	return used, nil
}

// reportValuesFilter builds (&prefix(|(attr=v1)(attr=v2)…)) for the values
// in sorted order.
func reportValuesFilter(attr, prefix string, values map[string]bool) string {
	sorted := make([]string, 0, len(values))
	for v := range values {
		sorted = append(sorted, v)
	}
	sort.Strings(sorted)
	var b strings.Builder
	b.WriteString("(&" + prefix + "(|")
	for _, v := range sorted {
		b.WriteString("(" + attr + "=" + goldap.EscapeFilter(v) + ")")
	}
	b.WriteString("))")
	return b.String()
}

// privilegedGroup is a well-known AD group of the privileged members
// report: a RID of the domain or a builtin (S-1-5-32-x) RID.
type privilegedGroup struct {
	name    string
	rid     uint32
	builtin bool
}

// privilegedGroups are the AD groups whose members can take over the domain
// or its domain controllers (Microsoft's "protected accounts and groups").
var privilegedGroups = []privilegedGroup{
	{name: "Domain Admins", rid: 512},
	{name: "Schema Admins", rid: 518},
	{name: "Enterprise Admins", rid: 519},
	{name: "Administrators", rid: 544, builtin: true},
	{name: "Account Operators", rid: 548, builtin: true},
	{name: "Server Operators", rid: 549, builtin: true},
	{name: "Print Operators", rid: 550, builtin: true},
	{name: "Backup Operators", rid: 551, builtin: true},
}

// builtinSID returns the binary SID S-1-5-32-rid.
func builtinSID(rid uint32) []byte {
	sid := []byte{1, 2, 0, 0, 0, 0, 0, 5}
	sid = binary.LittleEndian.AppendUint32(sid, 32)
	return binary.LittleEndian.AppendUint32(sid, rid)
}

// privilegedAccountAttrs are the attributes of the privileged members
// report's rows (the status attributes make the results' Status column work).
var privilegedAccountAttrs = []string{"objectClass", "cn", "displayName", "sAMAccountName", "description", "memberOf",
	"primaryGroupID", "userAccountControl", "msDS-User-Account-Control-Computed", "lockoutTime", "accountExpires",
	"pwdLastSet", "lastLogonTimestamp", "whenCreated"}

// groupReportRereadAttrs are the attributes a re-read of group report rows
// asks for: the attributes of the report's own search.
func groupReportRereadAttrs(report, serverType string) []string {
	if report == models.AccountReportPrivilegedMembers {
		return privilegedAccountAttrs
	}
	return emptyGroupsSpecFor(serverType).attrs
}

// rereadGroupReportRows reads params.DNs again (base scope) with the
// attributes of a group report (emptyGroups, privilegedMembers), e.g. a
// privileged member after an account action. Membership is not computed
// again: the entries come back with Matches true and without computed
// columns (the caller keeps the row's "Privileged groups" / "Nested via");
// entries that no longer exist are left out.
func (c *Client) rereadGroupReportRows(params models.AccountReportParams) (*models.AccountReportResult, error) {
	info, err := c.ServerInfo()
	if err != nil {
		return nil, err
	}
	attrs := groupReportRereadAttrs(params.Report, info.ServerType)
	result := &models.AccountReportResult{
		Entries:  []models.LDAPEntry{},
		Columns:  []string{},
		Notes:    []string{},
		Statuses: []models.AccountStatus{},
		Extra:    []map[string]string{},
		Matches:  []bool{},
	}
	for _, dn := range params.DNs {
		req := goldap.NewSearchRequest(dn, goldap.ScopeBaseObject, goldap.NeverDerefAliases,
			0, 0, false, "(objectClass=*)", attrs, nil)
		entries, err := c.SearchWithControls(req, 0)
		if err != nil {
			if goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject) {
				continue
			}
			return nil, err
		}
		for _, e := range entries {
			result.Entries = append(result.Entries, *convertEntry(e))
			result.Matches = append(result.Matches, true)
		}
	}
	result.Candidates = len(result.Entries)
	result.TotalCount = len(result.Entries)
	return result, nil
}

// privilegedMember collects what the report knows about one account.
type privilegedMember struct {
	entry  *goldap.Entry
	groups []string
	// via maps a group name to how the account is a member ("" = direct).
	via map[string]string
}

// privilegedMembersReport lists the accounts (users, computers, managed
// service accounts) that are direct or nested members of the AD privileged
// groups, found by their well-known SIDs (names differ by language). Nested
// members come from the in-chain matching rule (1.2.840.113556.1.4.1941);
// "Nested via" names the groups below the privileged group the account is
// a direct member of. Accounts whose primaryGroupID is Domain Admins,
// Schema Admins or Enterprise Admins are included as well.
func (c *Client) privilegedMembersReport(params models.AccountReportParams) (*models.AccountReportResult, error) {
	info, err := c.ServerInfo()
	if err != nil {
		return nil, err
	}
	if info.ServerType != models.ServerTypeAD {
		return nil, &ReportUnavailableError{Reason: "Privileged group members: Active Directory only."}
	}
	base, err := c.accountReportBase(params, info)
	if err != nil {
		return nil, err
	}
	limit := params.SizeLimit
	if limit <= 0 {
		limit = defaultAccountReportLimit
	}
	domainDN := adDomainDN(base)
	if domainDN == "" {
		domainDN = info.DefaultNamingContext
	}
	rd := c.accountReader()
	domainEntries, err := rd.search(goldap.NewSearchRequest(domainDN, goldap.ScopeBaseObject, goldap.NeverDerefAliases,
		0, 0, false, "(objectClass=*)", []string{"objectSid"}, nil))
	if err != nil {
		return nil, fmt.Errorf("reading the domain SID of %s: %w", domainDN, err)
	}
	var domainSID []byte
	if len(domainEntries) > 0 {
		domainSID = attrBytes(domainEntries[0], "objectSid")
	}
	if len(domainSID) < 8 {
		return nil, fmt.Errorf("the domain SID of %s is not readable with this connection", domainDN)
	}

	// Find the groups by SID.
	var or strings.Builder
	or.WriteString("(&(objectClass=group)(|")
	for _, g := range privilegedGroups {
		sid := builtinSID(g.rid)
		if !g.builtin {
			sid = sidAppendRID(domainSID, g.rid)
		}
		or.WriteString("(objectSid=" + escapeBinaryFilter(sid) + ")")
	}
	or.WriteString("))")
	groupEntries, err := rd.search(goldap.NewSearchRequest(domainDN, goldap.ScopeWholeSubtree, goldap.NeverDerefAliases,
		0, 0, false, or.String(), []string{"cn", "objectSid"}, nil))
	if err != nil {
		return nil, fmt.Errorf("finding the privileged groups: %w", err)
	}
	type foundGroup struct {
		privilegedGroup
		dn string
	}
	var found []foundGroup
	for _, g := range privilegedGroups {
		for _, e := range groupEntries {
			sid := attrBytes(e, "objectSid")
			rid, ok := sidRID(sid)
			if !ok || rid != g.rid {
				continue
			}
			isBuiltin := len(sid) >= 12 && binary.LittleEndian.Uint32(sid[8:12]) == 32
			if isBuiltin != g.builtin {
				continue
			}
			found = append(found, foundGroup{privilegedGroup: g, dn: e.DN})
		}
	}
	var notes []string
	var missing []string
	for _, g := range privilegedGroups {
		ok := false
		for _, f := range found {
			ok = ok || f.name == g.name
		}
		if !ok {
			missing = append(missing, g.name)
		}
	}
	names := make([]string, 0, len(found))
	for _, f := range found {
		names = append(names, f.name)
	}
	notes = append(notes, "Groups checked (found by their well-known SIDs): "+strings.Join(names, ", ")+".")
	if len(missing) > 0 {
		notes = append(notes, "Not found in "+domainDN+": "+strings.Join(missing, ", ")+
			" (Schema Admins and Enterprise Admins exist only in the forest root domain).")
	}

	accountAttrs := privilegedAccountAttrs
	members := map[string]*privilegedMember{}
	var order []string
	add := func(e *goldap.Entry, group, via string) {
		k := acctReportDNKey(e.DN)
		m, ok := members[k]
		if !ok {
			m = &privilegedMember{entry: e, via: map[string]string{}}
			members[k] = m
			order = append(order, k)
		}
		if _, seen := m.via[group]; !seen {
			m.groups = append(m.groups, group)
			m.via[group] = via
		} else if via == "" {
			m.via[group] = ""
		}
	}
	truncated := false
	for _, g := range found {
		chain := "(memberOf:1.2.840.113556.1.4.1941:=" + goldap.EscapeFilter(g.dn) + ")"
		accounts, err := c.SearchWithControls(goldap.NewSearchRequest(domainDN, goldap.ScopeWholeSubtree, goldap.NeverDerefAliases,
			0, 0, false, "(&(objectClass=user)"+chain+")", accountAttrs, nil), uint32(c.pageSize()))
		if err != nil {
			if !goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
				return nil, fmt.Errorf("members of %s: %w", g.name, err)
			}
			truncated = true
		}
		nested, err := c.SearchWithControls(goldap.NewSearchRequest(domainDN, goldap.ScopeWholeSubtree, goldap.NeverDerefAliases,
			0, 0, false, "(&(objectClass=group)"+chain+")", []string{"cn"}, nil), uint32(c.pageSize()))
		if err != nil && !goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
			return nil, fmt.Errorf("groups nested in %s: %w", g.name, err)
		}
		nestedNames := map[string]string{}
		for _, n := range nested {
			nestedNames[acctReportDNKey(n.DN)] = rdnValue(n.DN)
		}
		groupKey := acctReportDNKey(g.dn)
		for _, a := range accounts {
			add(a, g.name, privilegedVia(a.GetAttributeValues("memberOf"), groupKey, nestedNames))
		}
	}
	// Primary group members of the domain groups (not listed in member).
	var pgFilter strings.Builder
	pgFilter.WriteString("(&(objectClass=user)(|")
	pgNames := map[string]string{}
	for _, g := range found {
		if !g.builtin {
			v := strconv.FormatUint(uint64(g.rid), 10)
			pgFilter.WriteString("(primaryGroupID=" + v + ")")
			pgNames[v] = g.name
		}
	}
	pgFilter.WriteString("))")
	if len(pgNames) > 0 {
		primary, err := c.SearchWithControls(goldap.NewSearchRequest(domainDN, goldap.ScopeWholeSubtree, goldap.NeverDerefAliases,
			0, 0, false, pgFilter.String(), accountAttrs, nil), uint32(c.pageSize()))
		if err != nil && !goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
			return nil, fmt.Errorf("primary group members: %w", err)
		}
		for _, a := range primary {
			if name, ok := pgNames[strings.TrimSpace(a.GetEqualFoldAttributeValue("primaryGroupID"))]; ok {
				add(a, name, "primary group")
			}
		}
	}

	sort.SliceStable(order, func(i, j int) bool {
		return strings.ToLower(rdnValue(members[order[i]].entry.DN)) < strings.ToLower(rdnValue(members[order[j]].entry.DN))
	})
	result := &models.AccountReportResult{
		Entries:    []models.LDAPEntry{},
		Candidates: len(order),
		Columns:    []string{"sAMAccountName", "displayName", acctReportExtraGroups, acctReportExtraVia},
		Notes:      notes,
		Statuses:   []models.AccountStatus{},
		Extra:      []map[string]string{},
	}
	for _, k := range order {
		if len(result.Entries) >= limit {
			truncated = true
			break
		}
		m := members[k]
		result.Entries = append(result.Entries, *convertEntry(m.entry))
		result.Extra = append(result.Extra, privilegedColumns(m))
	}
	result.TotalCount = len(result.Entries)
	result.Truncated = truncated
	return result, nil
}

// privilegedVia says how an account with the direct groups memberOf is a
// member of the privileged group groupKey: "" when directly, else the names
// of its direct groups that are nested in it (nested: key → name).
func privilegedVia(memberOf []string, groupKey string, nested map[string]string) string {
	var via []string
	for _, g := range memberOf {
		k := acctReportDNKey(g)
		if k == groupKey {
			return ""
		}
		if name, ok := nested[k]; ok {
			via = append(via, name)
		}
	}
	if len(via) == 0 {
		return "nested"
	}
	sort.Strings(via)
	return strings.Join(via, ", ")
}

// privilegedColumns renders the computed columns of a member: the groups,
// and for nested memberships "Group ← via".
func privilegedColumns(m *privilegedMember) map[string]string {
	var nested []string
	for _, g := range m.groups {
		if v := m.via[g]; v != "" {
			nested = append(nested, g+" ← "+v)
		}
	}
	return map[string]string{
		acctReportExtraGroups: strings.Join(m.groups, ", "),
		acctReportExtraVia:    strings.Join(nested, "; "),
	}
}

// acctReportDNKey is a case-insensitive comparison key of a DN.
func acctReportDNKey(dn string) string {
	if d, err := goldap.ParseDN(dn); err == nil {
		parts := make([]string, 0, len(d.RDNs))
		for _, r := range d.RDNs {
			attrs := make([]string, 0, len(r.Attributes))
			for _, a := range r.Attributes {
				attrs = append(attrs, strings.ToLower(a.Type)+"="+strings.ToLower(a.Value))
			}
			parts = append(parts, strings.Join(attrs, "+"))
		}
		return strings.Join(parts, ",")
	}
	return strings.ToLower(strings.TrimSpace(dn))
}
