package ldap

import (
	"encoding/binary"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// This file holds the network-free parts of the membership resolution: the
// membership graph, its layout (depth, path, cycles) and the helpers for DNs,
// SIDs, filters and object types. See membership.go for the LDAP side.

// oidMatchingRuleInChain is AD's LDAP_MATCHING_RULE_IN_CHAIN, which makes a
// DN-valued filter assertion follow nested group links transitively.
const oidMatchingRuleInChain = "1.2.840.113556.1.4.1941"

// memGraph is the membership graph of one resolution. Nodes are keyed by
// normalized DN. Edges point away from the resolved entry: in the memberOf
// direction from a member to the groups containing it, in the members
// direction from a group to its members.
type memGraph struct {
	nodes map[string]*memNode
	order []string // node keys in insertion order (deterministic output)
	limit int      // maximum number of nodes besides the root; 0 = unlimited
	full  bool     // a node was refused because of limit
}

type memNode struct {
	key        string
	dn         string // empty for an unresolved memberUid
	name       string
	objectType string // "" until known
	isGroup    bool
	unresolved bool
	external   bool // held by another server, see models.MembershipItem.External
	// reported is set for nodes the server reported as (transitive) members
	// or groups, e.g. by an AD in-chain search, even if no edge leads to them.
	reported bool
	sid      []byte // objectSid (AD), used for primary group lookups
	gid      string // gidNumber of a posix group
	// personLike: an LDAP person without an account class, whose kind (user
	// or contact) depends on its login attributes (M-06); hasLogin: a uid was
	// read, so it is a user.
	personLike bool
	hasLogin   bool
	edges      []memEdge
	edgeIdx    map[string]int
}

type memEdge struct {
	to      string
	primary string // models.PrimaryGroupAD / PrimaryGroupPOSIX or ""
	// plain is set when the membership is (also) stored in a member
	// attribute (member, uniqueMember, memberUid, memberOf), not only given
	// by a primary group relation.
	plain bool
}

func newMemGraph(limit int) *memGraph {
	return &memGraph{nodes: map[string]*memNode{}, limit: limit}
}

// lookup returns the node of dn, or nil.
func (g *memGraph) lookup(dn string) *memNode {
	return g.nodes[normDN(dn)]
}

// node returns the node of dn, creating it if needed. It returns nil when the
// graph is full.
func (g *memGraph) node(dn string) *memNode {
	return g.nodeKey(normDN(dn), dn, rdnValue(dn))
}

// uidNode returns the node standing for a memberUid value without a
// matching account.
func (g *memGraph) uidNode(uid string) *memNode {
	n := g.nodeKey("\x00uid:"+strings.ToLower(uid), "", uid)
	if n != nil {
		n.unresolved = true
		n.objectType = models.MemberTypeUnknown
	}
	return n
}

func (g *memGraph) nodeKey(key, dn, name string) *memNode {
	if n, ok := g.nodes[key]; ok {
		return n
	}
	if g.limit > 0 && len(g.nodes) > g.limit { // +1 for the root
		g.full = true
		return nil
	}
	n := &memNode{key: key, dn: dn, name: name}
	g.nodes[key] = n
	g.order = append(g.order, key)
	return n
}

// addEdge adds an edge from → to; nil nodes (refused by a full graph) are
// ignored. Adding an existing edge again merges the kinds: a primary edge
// marks a plain edge as primary, a plain edge marks a primary edge as also
// stored in a member attribute.
func (g *memGraph) addEdge(from *memNode, to *memNode, primary string) {
	if from == nil || to == nil {
		return
	}
	if from.edgeIdx == nil {
		from.edgeIdx = map[string]int{}
	}
	if i, ok := from.edgeIdx[to.key]; ok {
		e := &from.edges[i]
		if primary == "" {
			e.plain = true
		} else if e.primary == "" {
			e.primary = primary
		}
		return
	}
	from.edgeIdx[to.key] = len(from.edges)
	from.edges = append(from.edges, memEdge{to: to.key, primary: primary, plain: primary == ""})
}

// applyEntry records the type information of entry on n.
func (n *memNode) applyEntry(e *goldap.Entry) {
	classes := attrValues(e, "objectClass")
	if len(classes) > 0 {
		n.objectType = memberObjectType(classes)
		n.isGroup = isGroupClass(classes)
		n.personLike = treeKindNeedsAttributes(classes)
	}
	if attrValue(e, "uid") != "" {
		n.hasLogin = true
	}
	if n.dn == "" || !strings.EqualFold(n.dn, e.DN) {
		n.dn = e.DN
		n.name = rdnValue(e.DN)
	}
	if sid := attrBytes(e, "objectSid"); len(sid) > 0 {
		n.sid = sid
	}
	if gid := attrValue(e, "gidNumber"); gid != "" {
		n.gid = gid
	}
}

// layoutResult is the outcome of layoutMembership.
type layoutResult struct {
	items        []models.MembershipItem
	cycles       []models.MembershipCycle
	depthLimited bool
}

// layoutMembership walks g breadth-first from root and returns the reached
// nodes as items with depth and shortest path, plus all circular nestings.
// Items deeper than maxDepth are left out (depthLimited). With
// includeReported, nodes the server reported but no edge reaches are
// appended with Depth 0 and no path ("path unknown").
func layoutMembership(g *memGraph, root *memNode, maxDepth int, includeReported bool) layoutResult {
	type visit struct {
		depth       int
		parent      string
		primary     string
		primaryOnly bool
	}
	var res layoutResult
	visited := map[string]*visit{root.key: {}}
	queue := []string{root.key}
	var reached []string
	for len(queue) > 0 {
		k := queue[0]
		queue = queue[1:]
		v := visited[k]
		for _, e := range g.nodes[k].edges {
			if e.to == root.key {
				continue
			}
			if _, ok := visited[e.to]; ok {
				continue
			}
			if maxDepth > 0 && v.depth+1 > maxDepth {
				res.depthLimited = true
				continue
			}
			visited[e.to] = &visit{
				depth:       v.depth + 1,
				parent:      k,
				primary:     e.primary,
				primaryOnly: k == root.key && e.primary != "" && !e.plain,
			}
			reached = append(reached, e.to)
			queue = append(queue, e.to)
		}
	}

	inCycle := map[string]bool{}
	res.cycles = findCycles(g, inCycle)

	for _, k := range reached {
		n := g.nodes[k]
		v := visited[k]
		var path []string
		for p := v.parent; p != root.key; p = visited[p].parent {
			path = append(path, g.nodes[p].dn)
		}
		// Collected from the item back to the root; nearest to the root first.
		for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
			path[i], path[j] = path[j], path[i]
		}
		it := nodeItem(n, v.depth, path, v.primary, inCycle[k])
		it.PrimaryOnly = v.primaryOnly
		res.items = append(res.items, it)
	}
	// A group stored as a member of itself: the self-loop is a cycle (see
	// findCycles), and the root is listed as a direct item so it can be seen
	// and removed (the BFS above never revisits the root).
	if i, ok := root.edgeIdx[root.key]; ok && maxDepth != 0 {
		it := nodeItem(root, 1, nil, root.edges[i].primary, true)
		it.Self = true
		it.PrimaryOnly = root.edges[i].primary != "" && !root.edges[i].plain
		res.items = append(res.items, it)
	}
	if includeReported {
		for _, k := range g.order {
			n := g.nodes[k]
			if _, ok := visited[k]; ok || !n.reported {
				continue
			}
			res.items = append(res.items, nodeItem(n, 0, nil, "", inCycle[k]))
		}
	}

	sort.SliceStable(res.items, func(i, j int) bool {
		a, b := res.items[i], res.items[j]
		da, db := a.Depth, b.Depth
		if da == 0 {
			da = 1 << 30
		}
		if db == 0 {
			db = 1 << 30
		}
		if da != db {
			return da < db
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	return res
}

func nodeItem(n *memNode, depth int, path []string, primary string, inCycle bool) models.MembershipItem {
	objectType := n.objectType
	if objectType == "" {
		objectType = models.MemberTypeUnknown
	}
	if path == nil {
		path = []string{}
	}
	return models.MembershipItem{
		DN:         n.dn,
		Name:       n.name,
		ObjectType: objectType,
		Direct:     depth == 1,
		Depth:      depth,
		Path:       path,
		Primary:    primary,
		InCycle:    inCycle,
		Unresolved: n.unresolved,
		External:   n.external,
	}
}

// maxReportedCycles limits the cycles listed in a result.
const maxReportedCycles = 20

// findCycles returns one cycle per strongly connected component of g that
// has more than one node or a self-loop, and marks the nodes of these
// components in inCycle.
func findCycles(g *memGraph, inCycle map[string]bool) []models.MembershipCycle {
	index := map[string]int{}
	low := map[string]int{}
	onStack := map[string]bool{}
	var stack []string
	var sccs [][]string
	next := 0

	var strongConnect func(k string)
	strongConnect = func(k string) {
		index[k] = next
		low[k] = next
		next++
		stack = append(stack, k)
		onStack[k] = true
		for _, e := range g.nodes[k].edges {
			if _, seen := index[e.to]; !seen {
				strongConnect(e.to)
				low[k] = min(low[k], low[e.to])
			} else if onStack[e.to] {
				low[k] = min(low[k], index[e.to])
			}
		}
		if low[k] == index[k] {
			var scc []string
			for {
				top := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				onStack[top] = false
				scc = append(scc, top)
				if top == k {
					break
				}
			}
			sccs = append(sccs, scc)
		}
	}
	for _, k := range g.order {
		if _, seen := index[k]; !seen {
			strongConnect(k)
		}
	}

	pos := map[string]int{}
	for i, k := range g.order {
		pos[k] = i
	}
	var cycles []models.MembershipCycle
	for _, scc := range sccs {
		if len(scc) == 1 {
			n := g.nodes[scc[0]]
			if _, self := n.edgeIdx[n.key]; !self {
				continue
			}
		}
		member := map[string]bool{}
		start := scc[0]
		for _, k := range scc {
			member[k] = true
			inCycle[k] = true
			if pos[k] < pos[start] {
				start = k
			}
		}
		if len(cycles) < maxReportedCycles {
			cycles = append(cycles, models.MembershipCycle{Path: cyclePath(g, start, member)})
		}
	}
	sort.SliceStable(cycles, func(i, j int) bool {
		return pos[normDN(cycles[i].Path[0])] < pos[normDN(cycles[j].Path[0])]
	})
	return cycles
}

// cyclePath returns the DNs of the shortest cycle through start that stays
// within the component member, starting and ending with start.
func cyclePath(g *memGraph, start string, member map[string]bool) []string {
	parent := map[string]string{}
	queue := []string{start}
	seen := map[string]bool{}
	last := ""
	for len(queue) > 0 && last == "" {
		k := queue[0]
		queue = queue[1:]
		for _, e := range g.nodes[k].edges {
			if !member[e.to] {
				continue
			}
			if e.to == start {
				last = k
				break
			}
			if !seen[e.to] {
				seen[e.to] = true
				parent[e.to] = k
				queue = append(queue, e.to)
			}
		}
	}
	path := []string{g.nodes[start].dn}
	var back []string
	for k := last; k != "" && k != start; k = parent[k] {
		back = append(back, g.nodes[k].dn)
	}
	for i := len(back) - 1; i >= 0; i-- {
		path = append(path, back[i])
	}
	return append(path, g.nodes[start].dn)
}

// summarizeItems fills the counters of r from r.Items.
func summarizeItems(r *models.MembershipResult) {
	r.TypeCounts = map[string]int{}
	r.DirectCount, r.MaxDepth = 0, 0
	for _, it := range r.Items {
		r.TypeCounts[it.ObjectType]++
		if it.Direct {
			r.DirectCount++
		}
		r.MaxDepth = max(r.MaxDepth, it.Depth)
	}
}

// normDN returns a comparison key for dn: attribute types and values are
// lowercased, RDN components sorted, and insignificant spaces and escaping
// differences removed. Unparsable DNs are lowercased.
func normDN(dn string) string {
	dn = strings.TrimSpace(dn)
	parsed, err := goldap.ParseDN(dn)
	if err != nil || len(parsed.RDNs) == 0 {
		return strings.ToLower(dn)
	}
	rdns := make([]string, len(parsed.RDNs))
	for i, rdn := range parsed.RDNs {
		parts := make([]string, len(rdn.Attributes))
		for j, a := range rdn.Attributes {
			parts[j] = strings.ToLower(a.Type) + "=" + goldap.EscapeDN(strings.ToLower(a.Value))
		}
		sort.Strings(parts)
		rdns[i] = strings.Join(parts, "+")
	}
	return strings.Join(rdns, ",")
}

// dnUnder reports whether dn equals base or lies below it.
func dnUnder(dn, base string) bool {
	d, b := normDN(dn), normDN(base)
	if b == "" {
		return true
	}
	return d == b || strings.HasSuffix(d, ","+b)
}

// rdnValue returns the value of the first RDN of dn ("CN=Doe\, John,OU=x" →
// "Doe, John"), or dn itself if it cannot be parsed.
func rdnValue(dn string) string {
	parsed, err := goldap.ParseDN(dn)
	if err != nil || len(parsed.RDNs) == 0 || len(parsed.RDNs[0].Attributes) == 0 {
		return dn
	}
	return parsed.RDNs[0].Attributes[0].Value
}

// rdnFilter returns a filter matching the RDN of dn, e.g. "(uid=jdoe)" or
// "(&(cn=a)(sn=b))" for a multi-valued RDN; ok is false if dn cannot be parsed.
func rdnFilter(dn string) (string, bool) {
	parsed, err := goldap.ParseDN(dn)
	if err != nil || len(parsed.RDNs) == 0 || len(parsed.RDNs[0].Attributes) == 0 {
		return "", false
	}
	attrs := parsed.RDNs[0].Attributes
	parts := make([]string, 0, len(attrs))
	for _, a := range attrs {
		if a.Type == "" {
			return "", false
		}
		parts = append(parts, "("+a.Type+"="+goldap.EscapeFilter(a.Value)+")")
	}
	if len(parts) == 1 {
		return parts[0], true
	}
	return "(&" + strings.Join(parts, "") + ")", true
}

// uniqueMemberUID matches the optional "#'0101'B" UID suffix of a
// uniqueMember value (NameAndOptionalUID syntax).
var uniqueMemberUID = regexp.MustCompile(`#'[01]*'B$`)

// stripOptionalUID removes the optional UID suffix of a uniqueMember value.
func stripOptionalUID(v string) string {
	return uniqueMemberUID.ReplaceAllString(v, "")
}

// orFilter combines filter components into one OR filter.
func orFilter(parts []string) string {
	if len(parts) == 1 {
		return parts[0]
	}
	return "(|" + strings.Join(parts, "") + ")"
}

// chainFilter returns an AD in-chain filter "(attr:1.2.840.113556.1.4.1941:=dn)".
func chainFilter(attr, dn string) string {
	return "(" + attr + ":" + oidMatchingRuleInChain + ":=" + goldap.EscapeFilter(dn) + ")"
}

// chunks splits items into slices of at most n elements.
func chunks[T any](items []T, n int) [][]T {
	var out [][]T
	for len(items) > n {
		out = append(out, items[:n])
		items = items[n:]
	}
	if len(items) > 0 {
		out = append(out, items)
	}
	return out
}

// groupClasses are the (lowercase) object classes of group objects.
var groupClasses = map[string]bool{
	"group":              true, // AD
	"groupofnames":       true,
	"groupofuniquenames": true,
	"posixgroup":         true,
	"groupofurls":        true,
	"groupofentries":     true,
	"groupofmembers":     true,
}

// isGroupClass reports whether objectClasses describe a group.
func isGroupClass(objectClasses []string) bool {
	for _, oc := range objectClasses {
		if groupClasses[strings.ToLower(oc)] {
			return true
		}
	}
	return false
}

// memberObjectType classifies an object for the membership views.
func memberObjectType(objectClasses []string) string {
	has := map[string]bool{}
	for _, oc := range objectClasses {
		has[strings.ToLower(oc)] = true
	}
	switch {
	case isGroupClass(objectClasses):
		return models.MemberTypeGroup
	case has["computer"], has["device"], has["iphost"]:
		// LDAP devices / hosts are computers, as in the tree and the menus (M-05).
		return models.MemberTypeComputer
	case has["foreignsecurityprincipal"]:
		return models.MemberTypeFSP
	case has["contact"]:
		return models.MemberTypeContact
	case has["user"], has["person"], has["inetorgperson"], has["organizationalperson"],
		has["posixaccount"], has["account"], has["simplesecurityobject"]:
		return models.MemberTypeUser
	}
	return models.MemberTypeOther
}

// groupMemberAttribute returns the attribute holding the members of a group
// with the given object classes: "member" (AD group, groupOfNames),
// "uniqueMember" (groupOfUniqueNames) or "memberUid" (plain posixGroup).
func groupMemberAttribute(objectClasses []string) string {
	has := map[string]bool{}
	for _, oc := range objectClasses {
		has[strings.ToLower(oc)] = true
	}
	switch {
	case has["group"], has["groupofnames"], has["groupofmembers"]:
		return "member"
	case has["groupofuniquenames"]:
		return "uniqueMember"
	case has["posixgroup"]:
		return "memberUid"
	}
	return "member"
}

// attrValues returns the values of attribute name of e, ignoring attribute
// options such as ";range=0-*" or ";binary".
func attrValues(e *goldap.Entry, name string) []string {
	var out []string
	for _, a := range e.Attributes {
		if strings.EqualFold(attrBaseName(a.Name), name) {
			out = append(out, a.Values...)
		}
	}
	return out
}

// attrValue returns the first value of attribute name of e, or "".
func attrValue(e *goldap.Entry, name string) string {
	if v := attrValues(e, name); len(v) > 0 {
		return v[0]
	}
	return ""
}

// attrBytes returns the first raw value of attribute name of e.
func attrBytes(e *goldap.Entry, name string) []byte {
	for _, a := range e.Attributes {
		if strings.EqualFold(attrBaseName(a.Name), name) && len(a.ByteValues) > 0 {
			return a.ByteValues[0]
		}
	}
	return nil
}

// sidRID returns the last sub-authority (RID) of a binary SID.
func sidRID(sid []byte) (uint32, bool) {
	if len(sid) < 12 || len(sid) != 8+4*int(sid[1]) {
		return 0, false
	}
	return binary.LittleEndian.Uint32(sid[len(sid)-4:]), true
}

// sidDomain returns the binary SID of the domain of an account SID (the SID
// without its RID).
func sidDomain(sid []byte) ([]byte, bool) {
	if _, ok := sidRID(sid); !ok {
		return nil, false
	}
	d := append([]byte{}, sid[:len(sid)-4]...)
	d[1]--
	return d, true
}

// sidWithRID returns the SID of the account rid in the domain of sid (an
// account SID of that domain).
func sidWithRID(sid []byte, rid uint32) ([]byte, bool) {
	if _, ok := sidRID(sid); !ok {
		return nil, false
	}
	out := append([]byte{}, sid...)
	binary.LittleEndian.PutUint32(out[len(out)-4:], rid)
	return out, true
}

// sidAppendRID returns the account SID rid of the domain SID domain.
func sidAppendRID(domain []byte, rid uint32) []byte {
	if len(domain) < 8 {
		return nil
	}
	out := binary.LittleEndian.AppendUint32(append([]byte{}, domain...), rid)
	out[1]++
	return out
}

// sameDomain reports whether account SIDs a and b belong to the same domain.
func sameDomain(a, b []byte) bool {
	da, ok1 := sidDomain(a)
	db, ok2 := sidDomain(b)
	return ok1 && ok2 && string(da) == string(db)
}

// escapeBinaryFilter escapes every byte of v for a filter assertion value.
func escapeBinaryFilter(v []byte) string {
	const hexDigits = "0123456789abcdef"
	var b strings.Builder
	b.Grow(len(v) * 3)
	for _, c := range v {
		b.WriteByte('\\')
		b.WriteByte(hexDigits[c>>4])
		b.WriteByte(hexDigits[c&0xf])
	}
	return b.String()
}

// parseRID parses a primaryGroupID value.
func parseRID(v string) (uint32, bool) {
	n, err := strconv.ParseUint(strings.TrimSpace(v), 10, 32)
	return uint32(n), err == nil
}
