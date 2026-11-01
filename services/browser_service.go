package services

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// BrowserService provides directory tree browsing capabilities.
type BrowserService struct {
	ctx  context.Context
	pool *ldap.Pool

	// layouts remembers the naming contexts injected below tree nodes (see treesearch_roots.go).
	layouts treeLayouts
}

// NewBrowserService creates a new BrowserService.
func NewBrowserService(pool *ldap.Pool) *BrowserService {
	return &BrowserService{
		pool: pool,
	}
}

// SetContext sets the Wails application context.
func (s *BrowserService) SetContext(ctx context.Context) {
	s.ctx = ctx
}

// GetRootEntries returns the top-level entries for a connected profile.
// For Active Directory, it reads the RootDSE and CN=Partitions and returns
// every naming context (forest domains, DNS zones, Configuration, Schema) as
// a root node; child domains are injected below their parent domain (see
// buildADRoots). Other servers follow planNonADRoots: several naming contexts
// go through buildForestTree, otherwise the base DN, the only naming context
// or defaultNamingContext is the single root. The RootDSE itself is never
// returned as a node.
func (s *BrowserService) GetRootEntries(profileID string) ([]models.TreeNode, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}

	// Try to read RootDSE for AD forest discovery
	rootDSE, rootDSEErr := client.GetRootDSE()
	if rootDSEErr == nil && isADRootDSE(rootDSE) {
		return s.buildADRoots(profileID, client, rootDSE)
	}
	s.layouts.set(profileID, treeLayout{})

	var namingContexts []string
	var defaultNC string
	if rootDSEErr == nil && rootDSE != nil {
		namingContexts = getAttrValues(rootDSE, "namingContexts")
		defaultNC = getAttrValue(rootDSE, "defaultNamingContext")
	}
	plan := planNonADRoots(client.Profile().BaseDN, namingContexts, defaultNC)
	switch plan.Mode {
	case nonADForest:
		return s.buildForestTree(client, rootDSE, plan.NamingContexts)
	case nonADSingle:
		return s.buildSingleRoot(client, plan.RootDN)
	}
	if rootDSEErr != nil {
		return nil, fmt.Errorf("no base DN is set and the RootDSE could not be read (%v): enter a base DN in the connection settings", rootDSEErr)
	}
	return nil, errors.New("no base DN is set and the server lists no naming contexts: enter a base DN in the connection settings")
}

// nonADRootMode says how GetRootEntries builds the roots of a non-AD server.
type nonADRootMode int

const (
	nonADNone   nonADRootMode = iota // nothing to show: no base DN and no naming context
	nonADSingle                      // RootDN is the only root
	nonADForest                      // several naming contexts: buildForestTree
)

// nonADRootPlan is the result of planNonADRoots.
type nonADRootPlan struct {
	Mode           nonADRootMode
	RootDN         string   // nonADSingle
	NamingContexts []string // nonADForest: the cleaned namingContexts
}

// planNonADRoots decides the tree roots of a server that is not Active
// Directory (pure, unit-tested). Several naming contexts keep the forest
// path (the base DN, when set, is its primary root); otherwise the explicit
// base DN, the only naming context or defaultNamingContext is the single
// root. An empty DN is never planned as a root: reading "" returns the
// RootDSE, which used to show up as a nameless node that could not expand.
func planNonADRoots(baseDN string, namingContexts []string, defaultNC string) nonADRootPlan {
	var ncs []string
	seen := make(map[string]bool)
	for _, nc := range namingContexts {
		nc = strings.TrimSpace(nc)
		if nc == "" || seen[dnKey(nc)] {
			continue
		}
		seen[dnKey(nc)] = true
		ncs = append(ncs, nc)
	}
	switch base := strings.TrimSpace(baseDN); {
	case len(ncs) > 1:
		return nonADRootPlan{Mode: nonADForest, NamingContexts: ncs}
	case base != "":
		return nonADRootPlan{Mode: nonADSingle, RootDN: base}
	case len(ncs) == 1:
		return nonADRootPlan{Mode: nonADSingle, RootDN: ncs[0]}
	case strings.TrimSpace(defaultNC) != "":
		return nonADRootPlan{Mode: nonADSingle, RootDN: strings.TrimSpace(defaultNC)}
	}
	return nonADRootPlan{Mode: nonADNone}
}

// buildForestTree builds the root nodes for a non-AD server with several
// naming contexts. Active Directory (recognised by its
// configurationNamingContext) goes through buildADRoots instead; this
// function keeps the previous behaviour for all other servers: the base DN
// root plus the naming contexts below it. Its AD-specific branches (crossRefs,
// DNS zones, Configuration) no longer trigger for them.
//
// Former AD behaviour, for reference. Discovery:
//   - Reads namingContexts from RootDSE (partitions hosted on the connected DC)
//   - Queries CN=Partitions,CN=Configuration,... for crossRef objects to discover
//     ALL forest domains, including child domains hosted on other DCs
//   - Merges both sources and deduplicates
//
// Only the primary domain (the one the user connected to) has its children pre-loaded.
// All other partitions (child domains, Configuration, DNS zones) are shown as collapsed
// nodes — their children are loaded on-demand when the user expands them.
//
// Display order:
//  1. Connected domain (BaseDN or defaultNamingContext) — expanded with children
//  2. Other domain partitions (child domains, forest peers) — collapsed
//  3. Application partitions (DomainDnsZones, ForestDnsZones) — collapsed
//  4. Configuration partition — collapsed
func (s *BrowserService) buildForestTree(client *ldap.Client, rootDSE *models.LDAPEntry, namingContexts []string) ([]models.TreeNode, error) {
	defaultNC := getAttrValue(rootDSE, "defaultNamingContext")
	configNC := getAttrValue(rootDSE, "configurationNamingContext")
	baseDN := client.Profile().BaseDN

	// Discover all forest partitions from CN=Partitions,CN=Configuration,...
	// This finds child domains hosted on other DCs that aren't in namingContexts
	allNCs := mergeNamingContexts(namingContexts, nil)
	if configNC != "" {
		forestPartitions, err := client.GetForestPartitions(configNC)
		if err == nil && len(forestPartitions) > 0 {
			allNCs = mergeNamingContexts(namingContexts, forestPartitions)
		}
	}

	// Filter out NCs that are children of other NCs (e.g. Schema is under Configuration)
	topLevel := filterTopLevelNCs(allNCs)

	// Determine the primary domain
	primaryDN := baseDN
	if primaryDN == "" {
		primaryDN = defaultNC
	}
	primaryLower := strings.ToLower(primaryDN)

	// Classify naming contexts into categories.
	var domainNCs []string // all domain partitions (DC=...)
	var appNCs []string    // application partitions (ForestDnsZones, DomainDnsZones of primary only)
	var configNCs []string // configuration partition

	for _, nc := range topLevel {
		ncLower := strings.ToLower(nc)
		switch {
		case strings.EqualFold(nc, configNC):
			configNCs = append(configNCs, nc)
		case strings.Contains(ncLower, "domaindnszones") || strings.Contains(ncLower, "forestdnszones"):
			// Only show DNS zones that belong directly to the primary domain
			if strings.EqualFold(nc, "DC=DomainDnsZones,"+primaryDN) ||
				strings.EqualFold(nc, "DC=ForestDnsZones,"+primaryDN) {
				appNCs = append(appNCs, nc)
			}
		default:
			domainNCs = append(domainNCs, nc)
		}
	}

	// Build a parent->children map for domain NCs.
	childDomainsOf := make(map[string][]string) // lowercase parent DN -> child DNs
	for _, nc := range domainNCs {
		parentDN := getParentDomainDN(nc, domainNCs)
		if parentDN != "" {
			parentLower := strings.ToLower(parentDN)
			childDomainsOf[parentLower] = append(childDomainsOf[parentLower], nc)
		}
	}

	var nodes []models.TreeNode
	added := make(map[string]bool)

	// Build a domain node with its child domains injected as children
	var buildDomainNode func(dn string) models.TreeNode
	buildDomainNode = func(dn string) models.TreeNode {
		dnLower := strings.ToLower(dn)
		added[dnLower] = true

		if dnLower == primaryLower {
			// Primary domain: full load with LDAP children
			node, err := s.buildRootNode(client, dn, "globe")
			if err != nil {
				node = models.TreeNode{
					DN: dn, RDN: dn, HasChildren: true,
					ObjectClass: []string{"domain"}, Icon: "globe",
				}
			}
			// Inject child domain nodes into children
			for _, childNC := range childDomainsOf[dnLower] {
				node.Children = append(node.Children, buildDomainNode(childNC))
			}
			return node
		}

		// Non-primary domain: collapsed placeholder with child domains injected
		node := models.TreeNode{
			DN: dn, RDN: dn, HasChildren: true,
			ObjectClass: []string{"domain"}, Icon: "globe",
		}
		for _, childNC := range childDomainsOf[dnLower] {
			node.Children = append(node.Children, buildDomainNode(childNC))
		}
		return node
	}

	// 1. Primary domain first (with LDAP children + child domains injected)
	if primaryDN != "" {
		nodes = append(nodes, buildDomainNode(primaryDN))
	}

	for _, nc := range domainNCs {
		ncLower := strings.ToLower(nc)
		if added[ncLower] {
			continue
		}
		// Only add if this NC is a sub-domain of the primary (suffix match)
		if primaryLower != "" && !strings.HasSuffix(ncLower, ","+primaryLower) {
			continue
		}
		nodes = append(nodes, buildDomainNode(nc))
	}

	// 3. Application partitions (DNS zones) — collapsed
	for _, nc := range appNCs {
		if added[strings.ToLower(nc)] {
			continue
		}
		added[strings.ToLower(nc)] = true
		nodes = append(nodes, models.TreeNode{
			DN: nc, RDN: nc, HasChildren: true,
			ObjectClass: []string{}, Icon: "database",
		})
	}

	// 4. Configuration partition — collapsed
	for _, nc := range configNCs {
		if added[strings.ToLower(nc)] {
			continue
		}
		added[strings.ToLower(nc)] = true
		nodes = append(nodes, models.TreeNode{
			DN: nc, RDN: nc, HasChildren: true,
			ObjectClass: []string{}, Icon: "settings",
		})
	}

	if len(nodes) == 0 {
		// Never the RootDSE: the base DN, else the first naming context.
		root := strings.TrimSpace(baseDN)
		if root == "" && len(namingContexts) > 0 {
			root = namingContexts[0]
		}
		return s.buildSingleRoot(client, root)
	}

	return nodes, nil
}

// getParentDomainDN finds the nearest parent domain DN for a given domain NC.
// Returns "" if no parent is found (it's a forest root).
func getParentDomainDN(dn string, allDomainNCs []string) string {
	dnLower := strings.ToLower(dn)

	// Walk up the DN suffix, stripping one component at a time,
	// looking for the nearest matching domain NC.
	// e.g. for "DC=sub,DC=example,DC=com" we check:
	//   "dc=example,dc=com", then "dc=com"
	remainder := dnLower
	for {
		parts := strings.SplitN(remainder, ",", 2)
		if len(parts) < 2 {
			return ""
		}
		remainder = parts[1]

		for _, candidate := range allDomainNCs {
			candidateLower := strings.ToLower(candidate)
			if candidateLower == dnLower {
				continue // skip self
			}
			if candidateLower == remainder {
				return candidate
			}
		}
	}
}

// mergeNamingContexts merges two lists of naming contexts, deduplicating by case-insensitive DN.
func mergeNamingContexts(a, b []string) []string {
	seen := make(map[string]bool)
	var result []string
	for _, nc := range a {
		lower := strings.ToLower(nc)
		if !seen[lower] {
			seen[lower] = true
			result = append(result, nc)
		}
	}
	for _, nc := range b {
		lower := strings.ToLower(nc)
		if !seen[lower] {
			seen[lower] = true
			result = append(result, nc)
		}
	}
	return result
}

// filterTopLevelNCs removes naming contexts that are direct sub-partitions of
// another NC (like CN=Schema,CN=Configuration,DC=example,DC=com under
// CN=Configuration,DC=example,DC=com).
//
// It does NOT filter out child domain partitions (DC=child,DC=parent,DC=com)
// because those are independent domain partitions that should be shown as
// separate root nodes in the tree.
func filterTopLevelNCs(ncs []string) []string {
	var result []string
	for _, nc := range ncs {
		isSubPartition := false
		ncLower := strings.ToLower(nc)

		for _, other := range ncs {
			otherLower := strings.ToLower(other)
			if ncLower == otherLower {
				continue
			}
			// Only filter if nc is a CN-based child of other (e.g. CN=Schema,CN=Configuration,...)
			// Domain partitions (DC=child,DC=parent,...) are independent and should NOT be filtered.
			if strings.HasSuffix(ncLower, ","+otherLower) && strings.HasPrefix(ncLower, "cn=") {
				isSubPartition = true
				break
			}
		}
		if !isSubPartition {
			result = append(result, nc)
		}
	}
	return result
}

// buildRootNode creates a single root TreeNode for a given DN, with children pre-loaded.
// If the entry can't be read (e.g. it's on a remote DC), a placeholder node is created
// so the user can still see the partition exists in the forest.
func (s *BrowserService) buildRootNode(client *ldap.Client, dn string, iconFallback string) (models.TreeNode, error) {
	entry, err := client.GetEntry(dn)
	if err != nil {
		// Create a placeholder node for remote/unreachable partitions
		// (e.g. child domains hosted on other DCs)
		return models.TreeNode{
			DN:          dn,
			RDN:         dn,
			HasChildren: true,
			ObjectClass: []string{},
			Icon:        iconFallback,
		}, nil
	}

	objectClasses := getObjectClasses(entry)
	icon := iconFallback
	if len(objectClasses) > 0 && iconFallback == "" {
		icon = "globe"
	}

	node := models.TreeNode{
		DN:          entry.DN,
		RDN:         entry.DN,
		HasChildren: true,
		ObjectClass: objectClasses,
		Icon:        icon,
	}

	children, err := client.GetChildren(entry.DN)
	if err == nil {
		node.Children = children
	}

	return node, nil
}

// buildSingleRoot builds the single root node rootDN (non-AD servers and the
// AD fallback). An empty DN is refused: it would read the RootDSE.
func (s *BrowserService) buildSingleRoot(client *ldap.Client, rootDN string) ([]models.TreeNode, error) {
	if strings.TrimSpace(rootDN) == "" {
		return nil, errors.New("no base DN is set: enter a base DN in the connection settings")
	}
	entry, err := client.GetEntry(rootDN)
	if err != nil {
		return nil, err
	}

	objectClasses := getObjectClasses(entry)
	rootNode := models.TreeNode{
		DN:          entry.DN,
		RDN:         entry.DN,
		HasChildren: true,
		ObjectClass: objectClasses,
		Icon:        "globe",
	}

	children, err := client.GetChildren(entry.DN)
	if err != nil {
		return []models.TreeNode{rootNode}, nil
	}

	rootNode.Children = children
	return []models.TreeNode{rootNode}, nil
}

// GetRootDSE returns the RootDSE entry for a connected profile.
func (s *BrowserService) GetRootDSE(profileID string) (*models.LDAPEntry, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.GetRootDSE()
}

// GetServerInfo returns the capabilities announced in the server's RootDSE
// (server type, vendor, supported controls/extensions/capabilities, naming
// contexts). The result is cached per connection.
func (s *BrowserService) GetServerInfo(profileID string) (*models.ServerInfo, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.ServerInfo()
}

// GetChildren returns the child entries under the given parent DN, plus the
// naming contexts shown below it (AD child domains, see buildADRoots).
func (s *BrowserService) GetChildren(profileID string, parentDN string) ([]models.TreeNode, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	children, err := client.GetChildren(parentDN)
	return s.withInjectedChildren(profileID, parentDN, children, err)
}

// GetEntry retrieves a single LDAP entry with all its attributes.
func (s *BrowserService) GetEntry(profileID string, dn string) (*models.LDAPEntry, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.GetEntry(dn)
}

// AttributesPresent returns which of the attributes the entry has (names
// only, no values; not written to the operation log). The menus use it to
// offer Download Photo / Certificate only for entries that have one.
func (s *BrowserService) AttributesPresent(profileID string, dn string, attributes []string) ([]string, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.AttributesPresent(dn, attributes)
}

// ObjectStats holds statistics about objects under a base DN.
type ObjectStats struct {
	BaseDN     string         `json:"baseDN"`
	TotalCount int            `json:"totalCount"`
	ByType     map[string]int `json:"byType"`
	// Filters holds, per category of ByType, the LDAP filter that finds
	// exactly the entries counted in it (subtree below BaseDN), so the
	// statistics dialog can list them.
	Filters map[string]string `json:"filters"`
	// Order lists the categories in display order (the classifier's order).
	Order []string `json:"order"`
	// Truncated is set when the count stopped at statsSizeLimit entries
	// (the counts are a lower bound).
	Truncated bool `json:"truncated,omitempty"`
}

// statsSizeLimit caps the entries GetStatistics reads.
const statsSizeLimit = 50000

// statisticsCalls tracks the running GetStatisticsRun calls (DEF-23): the
// statistics dialog stops its count with CancelStatistics (Stop, or closing
// the dialog). Package level like membershipCalls (one BrowserService).
var statisticsCalls = newCallRegistry()

// statsRule is one category of GetStatistics: an entry belongs to the first
// rule that lists one of its object classes (case-insensitive).
type statsRule struct {
	Category string
	Classes  []string
}

// statsOtherCategory counts the entries that match no rule.
const statsOtherCategory = "Other"

// statsRules is the classifier of GetStatistics, most specific first:
// service accounts before computers (their class chain contains computer),
// computers before contacts / users (AD computers are users too), contacts
// before users (AD contacts are persons), domains before OUs (an OpenLDAP
// suffix is dcObject + organization).
var statsRules = []statsRule{
	{"Service accounts", []string{"msDS-GroupManagedServiceAccount", "msDS-ManagedServiceAccount", "msDS-DelegatedManagedServiceAccount"}},
	{"Computers", []string{"computer", "device", "ipHost"}},
	{"Contacts", []string{"contact"}},
	{"Groups", []string{"group", "groupOfNames", "groupOfUniqueNames", "posixGroup", "groupOfMembers"}},
	{"Users", []string{"user", "inetOrgPerson", "posixAccount", "person", "organizationalPerson"}},
	{"Domains", []string{"domain", "domainDNS", "dcObject"}},
	{"OUs", []string{"organizationalUnit", "organization"}},
	{"Containers", []string{"container", "builtinDomain", "lostAndFound", "nsContainer"}},
}

// classifyStatsEntry returns the statistics category of an entry.
func classifyStatsEntry(objectClasses []string) string {
	have := make(map[string]bool, len(objectClasses))
	for _, oc := range objectClasses {
		have[strings.ToLower(strings.TrimSpace(oc))] = true
	}
	for _, r := range statsRules {
		for _, c := range r.Classes {
			if have[strings.ToLower(c)] {
				return r.Category
			}
		}
	}
	return statsOtherCategory
}

// statsAnyClass is "(|(objectClass=a)(objectClass=b)...)" for the classes of
// the rules that occur in seen (lowercase class -> spelling seen on an
// entry; nil = every class); "" when none occurs.
func statsAnyClass(rules []statsRule, seen map[string]string) string {
	var parts []string
	for _, r := range rules {
		for _, c := range r.Classes {
			name := c
			if seen != nil {
				spelled, ok := seen[strings.ToLower(c)]
				if !ok {
					continue
				}
				name = spelled
			}
			parts = append(parts, "(objectClass="+name+")")
		}
	}
	switch len(parts) {
	case 0:
		return ""
	case 1:
		return parts[0]
	}
	return "(|" + strings.Join(parts, "") + ")"
}

// statsCategoryFilter returns the LDAP filter matching exactly the entries
// classifyStatsEntry puts into category: one of its classes and none of an
// earlier rule ("Other": none of any rule). "" for an unknown category or one
// without entries.
//
// seen limits the filter to the object classes that occur on the counted
// entries (nil: all classes of the rules). OpenLDAP evaluates an equality
// filter on an object class its schema does not define as Undefined, and
// (!Undefined) stays Undefined, so a NOT over an unknown class (e.g.
// msDS-GroupManagedServiceAccount) would make every filter match nothing.
// Classes no counted entry has cannot change the result below the base.
func statsCategoryFilter(category string, seen map[string]string) string {
	if category == statsOtherCategory {
		anyRule := statsAnyClass(statsRules, seen)
		if anyRule == "" {
			return "(objectClass=*)"
		}
		return "(!" + anyRule + ")"
	}
	for i, r := range statsRules {
		if r.Category != category {
			continue
		}
		own := statsAnyClass([]statsRule{r}, seen)
		if own == "" {
			return ""
		}
		earlier := statsAnyClass(statsRules[:i], seen)
		if earlier == "" {
			return own
		}
		return "(&" + own + "(!" + earlier + "))"
	}
	return ""
}

// GetStatistics counts objects by type under the given base DN (not
// cancellable; the statistics dialog uses GetStatisticsRun).
func (s *BrowserService) GetStatistics(profileID string, baseDN string) (*ObjectStats, error) {
	return s.GetStatisticsRun(profileID, baseDN, "")
}

// GetStatisticsRun is GetStatistics that CancelStatistics(profileID,
// requestID) stops (DEF-23): the subtree search is abandoned and the call
// fails with ldap.ErrSearchCancelled ("search cancelled"); no partial counts
// are returned. A cancel that arrives before the call started is honoured.
func (s *BrowserService) GetStatisticsRun(profileID string, baseDN string, requestID string) (*ObjectStats, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	ctx, done := statisticsCalls.track(profileID, requestID)
	defer done()
	if ctx.Err() != nil {
		return nil, ldap.ErrSearchCancelled
	}

	result, err := client.SearchContext(ctx, models.SearchParams{
		BaseDN:     baseDN,
		Filter:     "(objectClass=*)",
		Scope:      models.ScopeSub,
		Attributes: []string{"objectClass"},
		SizeLimit:  statsSizeLimit,
		TimeLimit:  30,
	})
	if err != nil {
		return nil, err
	}
	return statisticsOf(baseDN, result), nil
}

// CancelStatistics stops the GetStatisticsRun call of profileID with
// requestID (all of the profile's statistics counts for ""); returns the
// number of calls stopped.
func (s *BrowserService) CancelStatistics(profileID string, requestID string) int {
	return statisticsCalls.cancel(profileID, requestID)
}

// statisticsOf classifies the entries of the statistics search (pure).
func statisticsOf(baseDN string, result *models.SearchResult) *ObjectStats {

	byType := make(map[string]int)
	seen := make(map[string]string) // object classes of the counted entries (filters)
	for _, entry := range result.Entries {
		classes := getObjectClasses(&entry)
		byType[classifyStatsEntry(classes)]++
		for _, c := range classes {
			if key := strings.ToLower(strings.TrimSpace(c)); key != "" {
				if _, ok := seen[key]; !ok {
					seen[key] = strings.TrimSpace(c)
				}
			}
		}
	}

	stats := &ObjectStats{
		BaseDN:     baseDN,
		TotalCount: result.TotalCount,
		ByType:     byType,
		Filters:    make(map[string]string),
		Truncated:  result.Truncated,
	}
	for _, r := range statsRules {
		stats.Order = append(stats.Order, r.Category)
	}
	stats.Order = append(stats.Order, statsOtherCategory)
	for _, category := range stats.Order {
		if f := statsCategoryFilter(category, seen); f != "" && byType[category] > 0 {
			stats.Filters[category] = f
		}
	}
	return stats
}

// getObjectClasses extracts objectClass values from an LDAPEntry.
func getObjectClasses(entry *models.LDAPEntry) []string {
	return getAttrValues(entry, "objectClass")
}

// getAttrValues returns all values for a named attribute.
func getAttrValues(entry *models.LDAPEntry, name string) []string {
	for _, attr := range entry.Attributes {
		if strings.EqualFold(attr.Name, name) {
			return attr.Values
		}
	}
	return nil
}

// getAttrValue returns the first value for a named attribute, or "".
func getAttrValue(entry *models.LDAPEntry, name string) string {
	vals := getAttrValues(entry, name)
	if len(vals) > 0 {
		return vals[0]
	}
	return ""
}

// LoginAttributesOf returns, per DN, the login attribute names the entry has
// (uid, userPassword, … — names only, types-only reads, not logged): an LDAP
// person without them is a contact (M-06). Used by the search results and
// the member pickers; DNs that cannot be read are left out.
func (s *BrowserService) LoginAttributesOf(profileID string, dns []string) (map[string][]string, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.LoginAttributesOf(dns)
}
