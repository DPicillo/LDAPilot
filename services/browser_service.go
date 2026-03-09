package services

import (
	"context"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// BrowserService provides directory tree browsing capabilities.
type BrowserService struct {
	ctx  context.Context
	pool *ldap.Pool
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
// For Active Directory, it reads the RootDSE to discover all naming contexts
// (forest domains, Configuration, Schema) and returns them as root nodes.
// For non-AD servers, it falls back to a single root node based on BaseDN.
func (s *BrowserService) GetRootEntries(profileID string) ([]models.TreeNode, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}

	// Try to read RootDSE for AD forest discovery
	rootDSE, rootDSEErr := client.GetRootDSE()
	if rootDSEErr == nil && rootDSE != nil {
		namingContexts := getAttrValues(rootDSE, "namingContexts")
		if len(namingContexts) > 1 {
			// This looks like AD (or a server with multiple naming contexts)
			return s.buildForestTree(client, rootDSE, namingContexts)
		}
	}

	// Fallback: single root node from BaseDN
	return s.buildSingleRoot(client)
}

// buildForestTree builds root nodes for an AD forest, similar to LDAPAdmin.
//
// Discovery:
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
		return s.buildSingleRoot(client)
	}

	return nodes, nil
}

// getParentDomainDN finds the nearest parent domain DN for a given domain NC.
// Returns "" if no parent is found (it's a forest root).
func getParentDomainDN(dn string, allDomainNCs []string) string {
	dnLower := strings.ToLower(dn)
	// Walk up the DN components looking for a matching domain NC
	parts := strings.SplitN(dnLower, ",", 2)
	if len(parts) < 2 {
		return ""
	}
	remainder := parts[1] // everything after first DC= component

	for _, candidate := range allDomainNCs {
		candidateLower := strings.ToLower(candidate)
		if candidateLower == dnLower {
			continue // skip self
		}
		if candidateLower == remainder {
			return candidate
		}
	}
	// Try further up (for deeper nesting like DC=a,DC=b,DC=c,DC=net)
	if strings.Contains(remainder, ",") {
		return getParentDomainDN("DC=dummy,"+remainder, allDomainNCs)
	}
	return ""
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

// buildSingleRoot builds a single root node from the profile's BaseDN (non-AD fallback).
func (s *BrowserService) buildSingleRoot(client *ldap.Client) ([]models.TreeNode, error) {
	entry, err := client.GetEntry(client.Profile().BaseDN)
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

// GetChildren returns the child entries under the given parent DN.
func (s *BrowserService) GetChildren(profileID string, parentDN string) ([]models.TreeNode, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.GetChildren(parentDN)
}

// GetEntry retrieves a single LDAP entry with all its attributes.
func (s *BrowserService) GetEntry(profileID string, dn string) (*models.LDAPEntry, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.GetEntry(dn)
}

// ObjectStats holds statistics about objects under a base DN.
type ObjectStats struct {
	BaseDN     string            `json:"baseDN"`
	TotalCount int               `json:"totalCount"`
	ByType     map[string]int    `json:"byType"`
}

// GetStatistics counts objects by type under the given base DN.
func (s *BrowserService) GetStatistics(profileID string, baseDN string) (*ObjectStats, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}

	result, err := client.Search(models.SearchParams{
		BaseDN:     baseDN,
		Filter:     "(objectClass=*)",
		Scope:      models.ScopeSub,
		Attributes: []string{"objectClass"},
		SizeLimit:  50000,
		TimeLimit:  30,
	})
	if err != nil {
		return nil, err
	}

	byType := make(map[string]int)
	for _, entry := range result.Entries {
		category := ""
		for _, attr := range entry.Attributes {
			if strings.EqualFold(attr.Name, "objectClass") {
				// Classify by most specific objectClass (priority order).
				// An entry like [top, person, organizationalPerson, user]
				// should count as "Users" exactly once.
				bestPriority := 999
				for _, oc := range attr.Values {
					lower := strings.ToLower(oc)
					pri := -1
					cat := ""
					switch lower {
					case "computer":
						pri, cat = 0, "Computers" // most specific first
					case "user":
						pri, cat = 1, "Users"
					case "inetorgperson":
						pri, cat = 2, "Users"
					case "posixaccount":
						pri, cat = 3, "Users"
					case "group", "groupofnames", "groupofuniquenames", "posixgroup":
						pri, cat = 1, "Groups"
					case "organizationalunit":
						pri, cat = 0, "OUs"
					case "container", "builtindomain":
						pri, cat = 0, "Containers"
					case "domain", "domaindns":
						pri, cat = 0, "Domains"
					case "person", "organizationalperson":
						pri, cat = 10, "Users" // low priority — only if nothing more specific matches
					}
					if pri >= 0 && pri < bestPriority {
						bestPriority = pri
						category = cat
					}
				}
				break
			}
		}
		if category == "" {
			byType["Other"]++
		} else {
			byType[category]++
		}
	}

	return &ObjectStats{
		BaseDN:     baseDN,
		TotalCount: result.TotalCount,
		ByType:     byType,
	}, nil
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
