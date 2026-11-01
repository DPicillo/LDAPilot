package ldap

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// rootDSEAllAttrs is what GetRootDSEAll asks for: every user attribute ("*"),
// every operational attribute ("+", RFC 3673; OpenLDAP and 389DS return the
// capabilities only on request) and the capability attributes by name for
// servers that support neither (Active Directory ignores "+" but returns the
// named ones).
var rootDSEAllAttrs = []string{
	"*", "+",
	"supportedControl", "supportedExtension", "supportedFeatures", "supportedCapabilities",
	"supportedSASLMechanisms", "supportedLDAPVersion", "supportedLDAPPolicies",
	"vendorName", "vendorVersion", "currentTime", "subschemaSubentry",
	"namingContexts", "defaultNamingContext", "rootDomainNamingContext",
	"configurationNamingContext", "schemaNamingContext", "dnsHostName", "serverName",
	"dsServiceName", "ldapServiceName", "isSynchronized", "isGlobalCatalogReady",
	"highestCommittedUSN", "forestFunctionality", "domainFunctionality",
	"domainControllerFunctionality", "altServer", "objectClass", "structuralObjectClass",
	"entryDN", "netscapemdsuffix", "dataversion", "lastusn",
}

// GetRootDSEAll reads the complete RootDSE for display (Server Info): every
// attribute the server returns, with distinct values (Samba lists some
// controls several times). Unlike GetRootDSE (naming contexts for the tree)
// and ServerInfo (cached capabilities), it is read fresh on every call.
func (c *Client) GetRootDSEAll() (*models.LDAPEntry, error) {
	start := time.Now()
	req := goldap.NewSearchRequest(
		"",
		goldap.ScopeBaseObject,
		goldap.NeverDerefAliases,
		0, 0, false,
		"(objectClass=*)",
		rootDSEAllAttrs,
		nil,
	)
	var result *goldap.SearchResult
	err := c.read(func(conn *goldap.Conn) (err error) {
		result, err = conn.Search(req)
		return err
	})
	if err != nil {
		c.logger.Log("ROOTDSE", "Read the RootDSE (all attributes)", time.Since(start), err)
		return nil, searchError(err)
	}
	if len(result.Entries) == 0 {
		return nil, fmt.Errorf("%w: RootDSE", ErrNotFound)
	}
	entry := result.Entries[0]
	rootDSEDedupe(entry)
	return convertEntry(entry), nil
}

// rootDSEDedupe drops repeated values and repeated attributes (servers that
// answer "*", "+" and an explicit name may list an attribute twice).
func rootDSEDedupe(e *goldap.Entry) {
	byName := map[string]*goldap.EntryAttribute{}
	var attrs []*goldap.EntryAttribute
	for _, a := range e.Attributes {
		key := strings.ToLower(a.Name)
		target := byName[key]
		if target == nil {
			target = &goldap.EntryAttribute{Name: a.Name}
			byName[key] = target
			attrs = append(attrs, target)
		}
		for i, v := range a.Values {
			if !slices.Contains(target.Values, v) {
				target.Values = append(target.Values, v)
				if i < len(a.ByteValues) {
					target.ByteValues = append(target.ByteValues, a.ByteValues[i])
				}
			}
		}
	}
	e.Attributes = attrs
}
