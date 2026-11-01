package services

import (
	"strings"
	"sync"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// Active Directory tree roots
//
// AD never returns a naming context (NC) head as a one-level child of the NC
// above it: a one-level search below DC=example,DC=com does not list
// CN=Configuration, and one below CN=Configuration does not list CN=Schema
// (Samba answers with a continuation reference, which is ignored). Every NC
// therefore needs its own root node, except child domains, which are shown
// ("injected") as children of their parent domain node.
//
// Root order: the profile's base DN (or defaultNamingContext), other domains
// (forest root first), DomainDnsZones, ForestDnsZones, other application
// partitions, Configuration, Schema.
//
// An explicit base DN that is not a domain NC head (an OU, a container, the
// Configuration or Schema NC, an application partition) scopes the tree, as
// on every other server: it is the only root, and the NC heads below it (e.g.
// CN=Schema below CN=Configuration) are injected as its descendants.

// ncKind classifies a naming context.
type ncKind string

const (
	ncKindNone          ncKind = "" // not an NC head, e.g. an OU used as base DN
	ncKindDomain        ncKind = "domain"
	ncKindDomainDNS     ncKind = "domainDns"
	ncKindForestDNS     ncKind = "forestDns"
	ncKindApplication   ncKind = "application"
	ncKindConfiguration ncKind = "configuration"
	ncKindSchema        ncKind = "schema"
)

// adRootInput is what planADRoots needs from the RootDSE, the profile and
// CN=Partitions.
type adRootInput struct {
	BaseDN         string // profile base DN, may be empty
	DefaultNC      string
	RootDomainNC   string
	ConfigNC       string
	SchemaNC       string
	NamingContexts []string        // RootDSE namingContexts (NCs held by the connected DC)
	CrossRefs      []ldap.CrossRef // CN=Partitions crossRefs (all NCs of the forest), may be nil
}

// ncNode is a planned tree node for a naming context (or for the base DN).
type ncNode struct {
	DN       string
	Kind     ncKind
	Primary  bool     // the base DN root; its LDAP children are pre-loaded
	Children []ncNode // NC heads shown as its children (child domains, their DomainDnsZones)
}

// adRootPlan is the result of planADRoots.
type adRootPlan struct {
	Roots []ncNode
	// SearchBases are the DNs a subtree search must start from to cover the
	// directory data shown in the tree: the base DN root and every visible
	// domain NC (a subtree search does not cross into another NC). Without
	// any of them the application partitions are used (AD LDS).
	SearchBases []string
}

// classifyNC determines the kind of a naming context. flags are the crossRef
// systemFlags when hasFlags is true.
func classifyNC(dn string, flags int, hasFlags bool, configNC, schemaNC string) ncKind {
	switch {
	case configNC != "" && strings.EqualFold(dn, configNC):
		return ncKindConfiguration
	case schemaNC != "" && strings.EqualFold(dn, schemaNC):
		return ncKindSchema
	}
	first := strings.ToLower(strings.TrimSpace(strings.SplitN(dn, ",", 2)[0]))
	switch strings.ReplaceAll(first, " ", "") {
	case "dc=domaindnszones":
		return ncKindDomainDNS
	case "dc=forestdnszones":
		return ncKindForestDNS
	}
	if hasFlags {
		if flags&ldap.CrossRefFlagNTDSDomain != 0 {
			return ncKindDomain
		}
		return ncKindApplication
	}
	if strings.HasPrefix(first, "dc=") {
		return ncKindDomain
	}
	return ncKindApplication
}

// dnKey normalises a DN for comparisons: lowercase, without blanks around the
// RDN separators ("DC=a, DC=b" and "dc=a,dc=b" give the same key).
func dnKey(dn string) string {
	var parts []string
	start := 0
	for i := 0; i < len(dn); i++ {
		switch dn[i] {
		case '\\':
			i++
		case ',':
			parts = append(parts, strings.TrimSpace(dn[start:i]))
			start = i + 1
		}
	}
	parts = append(parts, strings.TrimSpace(dn[start:]))
	return strings.ToLower(strings.Join(parts, ","))
}

// isUnderDN reports whether dn is a strict descendant of ancestor (both dnKey keys).
func isUnderDN(dn, ancestor string) bool {
	if ancestor == "" || len(dn) <= len(ancestor)+1 || !strings.HasSuffix(dn, ","+ancestor) {
		return false
	}
	// The comma must separate RDNs, not be an escaped part of a value.
	cut := len(dn) - len(ancestor) - 1
	return cut == 0 || dn[cut-1] != '\\'
}

// parentDNOf returns dn without its first RDN ("" for a single-RDN DN).
// Commas escaped with a backslash are respected.
func parentDNOf(dn string) string {
	for i := 0; i < len(dn); i++ {
		switch dn[i] {
		case '\\':
			i++
		case ',':
			return strings.TrimSpace(dn[i+1:])
		}
	}
	return ""
}

// planADRoots decides which naming contexts become root nodes and which are
// injected as children of a domain node. It does no I/O.
func planADRoots(in adRootInput) adRootPlan {
	type ncInfo struct {
		dn   string
		kind ncKind
	}
	var ncs []ncInfo
	index := make(map[string]int) // lowercase DN -> position in ncs

	add := func(dn string, flags int, hasFlags bool) {
		dn = strings.TrimSpace(dn)
		if dn == "" {
			return
		}
		key := dnKey(dn)
		kind := classifyNC(dn, flags, hasFlags, in.ConfigNC, in.SchemaNC)
		if i, ok := index[key]; ok {
			if hasFlags { // crossRef flags beat the DN heuristics
				ncs[i].kind = kind
			}
			return
		}
		index[key] = len(ncs)
		ncs = append(ncs, ncInfo{dn: dn, kind: kind})
	}
	for _, nc := range in.NamingContexts {
		add(nc, 0, false)
	}
	add(in.ConfigNC, 0, false)
	add(in.SchemaNC, 0, false)
	for _, ref := range in.CrossRefs {
		if !ref.Enabled || (ref.HasFlags && ref.SystemFlags&ldap.CrossRefFlagNTDSNC == 0) {
			continue // pre-created partition or external directory
		}
		add(ref.NCName, ref.SystemFlags, ref.HasFlags)
	}
	kindOf := func(key string) ncKind {
		if i, ok := index[key]; ok {
			return ncs[i].kind
		}
		return ncKindNone
	}

	// The primary root: the profile base DN, else the default domain.
	primary := strings.TrimSpace(in.BaseDN)
	if primary == "" {
		primary = strings.TrimSpace(in.DefaultNC)
	}
	primaryKey := dnKey(primary)
	primaryKind := kindOf(primaryKey)

	var build func(key string) ncNode
	children := make(map[string][]string) // parent key -> injected NC keys
	build = func(key string) ncNode {
		node := ncNode{DN: ncs[index[key]].dn, Kind: ncs[index[key]].kind}
		for _, child := range children[key] {
			node.Children = append(node.Children, build(child))
		}
		return node
	}
	primaryRoot := func() ncNode {
		root := ncNode{DN: primary, Kind: primaryKind, Primary: true}
		if i, ok := index[primaryKey]; ok {
			root.DN = ncs[i].dn
		}
		for _, child := range children[primaryKey] {
			root.Children = append(root.Children, build(child))
		}
		return root
	}

	// An explicit base DN that is not a domain NC head scopes the tree: it is
	// the only root; NC heads below it hang below the nearest of them.
	if strings.TrimSpace(in.BaseDN) != "" && primaryKind != ncKindDomain {
		var below []string
		for _, nc := range ncs {
			if key := dnKey(nc.dn); isUnderDN(key, primaryKey) {
				below = append(below, key)
			}
		}
		for _, key := range below {
			parent := primaryKey
			for _, b := range below {
				if isUnderDN(key, b) && len(b) > len(parent) {
					parent = b
				}
			}
			children[parent] = append(children[parent], key)
		}
		sortInjected(children, kindOf)
		plan := adRootPlan{Roots: []ncNode{primaryRoot()}}
		plan.SearchBases = searchBasesOf(plan.Roots)
		return plan
	}

	// Without a base DN, a default NC unknown to the NC list (inside an NC)
	// replaces that NC: the NC is hidden.
	hidden := make(map[string]bool)
	owningNC := ""
	if primary != "" && primaryKind == ncKindNone {
		for _, nc := range ncs {
			key := dnKey(nc.dn)
			if isUnderDN(primaryKey, key) && len(key) > len(owningNC) {
				owningNC = key
			}
		}
		if owningNC != "" {
			hidden[owningNC] = true
		}
	}

	// The domain whose DomainDnsZones is listed first among the roots.
	primaryDomain := dnKey(in.DefaultNC)
	if primaryKind == ncKindDomain {
		primaryDomain = primaryKey
	} else if owningNC != "" && kindOf(owningNC) == ncKindDomain {
		primaryDomain = owningNC
	}

	var domainKeys []string
	for _, nc := range ncs {
		if nc.kind == ncKindDomain {
			domainKeys = append(domainKeys, dnKey(nc.dn))
		}
	}
	// parentDomain returns the nearest domain NC above key, "" if none.
	parentDomain := func(key string) string {
		best := ""
		for _, d := range domainKeys {
			if isUnderDN(key, d) && len(d) > len(best) {
				best = d
			}
		}
		return best
	}

	var rootDomains, dnsRoots, forestDNSRoots, appRoots, configRoots, schemaRoots []string
	for _, nc := range ncs {
		key := dnKey(nc.dn)
		if key == primaryKey || hidden[key] {
			continue
		}
		switch nc.kind {
		case ncKindDomain:
			if p := parentDomain(key); p != "" && !hidden[p] {
				children[p] = append(children[p], key)
			} else if key == dnKey(in.RootDomainNC) {
				rootDomains = append([]string{key}, rootDomains...)
			} else {
				rootDomains = append(rootDomains, key)
			}
		case ncKindDomainDNS:
			p := dnKey(parentDNOf(nc.dn))
			switch {
			case p == primaryDomain:
				dnsRoots = append([]string{key}, dnsRoots...)
			case kindOf(p) == ncKindDomain && !hidden[p]:
				children[p] = append(children[p], key)
			default:
				dnsRoots = append(dnsRoots, key)
			}
		case ncKindForestDNS:
			forestDNSRoots = append(forestDNSRoots, key)
		case ncKindConfiguration:
			configRoots = append(configRoots, key)
		case ncKindSchema:
			schemaRoots = append(schemaRoots, key)
		default:
			appRoots = append(appRoots, key)
		}
	}
	sortInjected(children, kindOf)

	var plan adRootPlan
	if primary != "" {
		plan.Roots = append(plan.Roots, primaryRoot())
	}
	for _, group := range [][]string{rootDomains, dnsRoots, forestDNSRoots, appRoots, configRoots, schemaRoots} {
		for _, key := range group {
			plan.Roots = append(plan.Roots, build(key))
		}
	}

	plan.SearchBases = searchBasesOf(plan.Roots)
	if len(plan.SearchBases) == 0 {
		for _, key := range appRoots {
			plan.SearchBases = append(plan.SearchBases, ncs[index[key]].dn)
		}
	}
	return plan
}

// sortInjected puts child domains before the other injected NC heads (DNS
// partitions) of every parent, keeping their relative order.
func sortInjected(children map[string][]string, kindOf func(string) ncKind) {
	for p, keys := range children {
		var doms, others []string
		for _, k := range keys {
			if kindOf(k) == ncKindDomain {
				doms = append(doms, k)
			} else {
				others = append(others, k)
			}
		}
		children[p] = append(doms, others...)
	}
}

// searchBasesOf returns the primary root and every visible domain, in tree
// order: the subtree search bases covering the directory data of the tree.
func searchBasesOf(roots []ncNode) []string {
	var bases []string
	seen := make(map[string]bool)
	var collect func(nodes []ncNode)
	collect = func(nodes []ncNode) {
		for _, n := range nodes {
			key := dnKey(n.DN)
			if (n.Primary || n.Kind == ncKindDomain) && !seen[key] {
				seen[key] = true
				bases = append(bases, n.DN)
			}
			collect(n.Children)
		}
	}
	collect(roots)
	return bases
}

// ncIcon returns the tree icon hint for a naming context of the given kind.
func ncIcon(kind ncKind) string {
	switch kind {
	case ncKindDomain:
		return "globe"
	case ncKindConfiguration:
		return "settings"
	case ncKindSchema:
		return "schema"
	case ncKindNone:
		return "globe"
	default: // DNS and other application partitions
		return "database"
	}
}

// ncPlaceholder returns a collapsed tree node for a naming context head; its
// children are loaded when it is expanded.
func ncPlaceholder(n ncNode) models.TreeNode {
	objectClass := []string{}
	if n.Kind == ncKindDomain {
		objectClass = []string{"domain"} // domain colouring, as before
	}
	return models.TreeNode{
		DN:          n.DN,
		RDN:         n.DN,
		HasChildren: true,
		ObjectClass: objectClass,
		Icon:        ncIcon(n.Kind),
	}
}

// treeLayout remembers, per profile, the NC heads injected below a node so
// that GetChildren returns them again when that node is expanded or refreshed.
type treeLayout struct {
	injected map[string][]models.TreeNode // lowercase parent DN -> NC head nodes
}

// treeLayouts is a per-profile treeLayout store; the zero value is ready to use.
type treeLayouts struct {
	mu        sync.Mutex
	byProfile map[string]treeLayout
}

func (t *treeLayouts) set(profileID string, layout treeLayout) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.byProfile == nil {
		t.byProfile = make(map[string]treeLayout)
	}
	t.byProfile[profileID] = layout
}

// injectedChildren returns a copy of the NC heads to show below parentDN.
func (t *treeLayouts) injectedChildren(profileID, parentDN string) []models.TreeNode {
	t.mu.Lock()
	defer t.mu.Unlock()
	nodes := t.byProfile[profileID].injected[dnKey(parentDN)]
	return append([]models.TreeNode(nil), nodes...)
}

// layoutFromPlan collects the injected NC heads of a plan.
func layoutFromPlan(plan adRootPlan) treeLayout {
	layout := treeLayout{injected: make(map[string][]models.TreeNode)}
	var walk func(nodes []ncNode)
	walk = func(nodes []ncNode) {
		for _, n := range nodes {
			key := dnKey(n.DN)
			for _, child := range n.Children {
				layout.injected[key] = append(layout.injected[key], ncPlaceholder(child))
			}
			walk(n.Children)
		}
	}
	walk(plan.Roots)
	return layout
}

// mergeChildren appends the extra nodes that are not in children yet (DNs
// compared case-insensitively).
func mergeChildren(children, extra []models.TreeNode) []models.TreeNode {
	if len(extra) == 0 {
		return children
	}
	have := make(map[string]bool, len(children))
	for _, c := range children {
		have[dnKey(c.DN)] = true
	}
	for _, e := range extra {
		if !have[dnKey(e.DN)] {
			children = append(children, e)
		}
	}
	return children
}

// withInjectedChildren adds the NC heads injected below parentDN (child
// domains) to the LDAP children read from the server. A failed LDAP read is
// returned as an error, also for nodes with injected NCs: a partial list of
// only the NC heads would make the node look empty without telling why.
func (s *BrowserService) withInjectedChildren(profileID, parentDN string, children []models.TreeNode, err error) ([]models.TreeNode, error) {
	if err != nil {
		return nil, err
	}
	return mergeChildren(children, s.layouts.injectedChildren(profileID, parentDN)), nil
}

// isADRootDSE reports whether the RootDSE describes Active Directory (AD DS,
// AD LDS or Samba): only they publish configurationNamingContext.
func isADRootDSE(rootDSE *models.LDAPEntry) bool {
	return rootDSE != nil && getAttrValue(rootDSE, "configurationNamingContext") != ""
}

// planAD gathers the RootDSE, profile and CN=Partitions data and plans the
// AD tree roots. A failing CN=Partitions read only loses the NCs that the
// connected DC does not hold.
func planAD(client *ldap.Client, rootDSE *models.LDAPEntry) adRootPlan {
	in := adRootInput{
		BaseDN:         client.Profile().BaseDN,
		DefaultNC:      getAttrValue(rootDSE, "defaultNamingContext"),
		RootDomainNC:   getAttrValue(rootDSE, "rootDomainNamingContext"),
		ConfigNC:       getAttrValue(rootDSE, "configurationNamingContext"),
		SchemaNC:       getAttrValue(rootDSE, "schemaNamingContext"),
		NamingContexts: getAttrValues(rootDSE, "namingContexts"),
	}
	if in.ConfigNC != "" {
		if refs, err := client.GetCrossRefs(in.ConfigNC); err == nil {
			in.CrossRefs = refs
		}
	}
	return planADRoots(in)
}

// buildADRoots builds the root nodes of an Active Directory connection (see
// the comment at the top of this file). Only the primary root has its
// children pre-loaded; every other NC is a collapsed node.
func (s *BrowserService) buildADRoots(profileID string, client *ldap.Client, rootDSE *models.LDAPEntry) ([]models.TreeNode, error) {
	plan := planAD(client, rootDSE)
	layout := layoutFromPlan(plan)
	s.layouts.set(profileID, layout)

	nodes := make([]models.TreeNode, 0, len(plan.Roots))
	for _, r := range plan.Roots {
		if !r.Primary {
			nodes = append(nodes, ncPlaceholder(r))
			continue
		}
		node := ncPlaceholder(r)
		if entry, err := client.GetEntry(r.DN); err == nil {
			node.DN, node.RDN = entry.DN, entry.DN
			node.ObjectClass = getObjectClasses(entry)
			if r.Kind == ncKindNone {
				node.Icon = ldap.IconForObjectClasses(node.ObjectClass)
			}
			if children, err := client.GetChildren(entry.DN); err == nil {
				node.Children = mergeChildren(children, layout.injected[dnKey(r.DN)])
				node.HasChildren = len(node.Children) > 0
			}
		}
		nodes = append(nodes, node)
	}
	if len(nodes) == 0 {
		s.layouts.set(profileID, treeLayout{})
		plan := planNonADRoots(client.Profile().BaseDN, nil, getAttrValue(rootDSE, "defaultNamingContext"))
		return s.buildSingleRoot(client, plan.RootDN)
	}
	return nodes, nil
}

// GetTreeSearchBases returns the base DNs the tree's quick search must search
// (subtree) to cover the directory data shown in the tree. For Active
// Directory these are the base DN root and every domain shown in the tree
// (a subtree search does not cross into another naming context; an OU or
// container base DN gives just that DN); for other servers it is the profile
// base DN, or all naming contexts without one.
func (s *BrowserService) GetTreeSearchBases(profileID string) ([]string, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	rootDSE, err := client.GetRootDSE()
	if err == nil && isADRootDSE(rootDSE) {
		if bases := planAD(client, rootDSE).SearchBases; len(bases) > 0 {
			return bases, nil
		}
	}
	if baseDN := strings.TrimSpace(client.Profile().BaseDN); baseDN != "" {
		return []string{baseDN}, nil
	}
	if err == nil && rootDSE != nil {
		if ncs := getAttrValues(rootDSE, "namingContexts"); len(ncs) > 0 {
			return append([]string(nil), ncs...), nil
		}
	}
	return []string{}, nil
}
