package ldap

import (
	"slices"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// AD capability OID announced by Active Directory and Samba AD domain controllers.
const adCapabilityOID = "1.2.840.113556.1.4.800"

// rootDSECapabilityAttrs are the RootDSE attributes read for ServerInfo.
// "*" and "+" make servers that only return operational attributes on
// request (OpenLDAP, 389DS) include everything.
var rootDSECapabilityAttrs = []string{
	"*", "+",
	"objectClass", "structuralObjectClass",
	"vendorName", "vendorVersion",
	"supportedControl", "supportedExtension", "supportedCapabilities", "supportedSASLMechanisms",
	"namingContexts", "defaultNamingContext", "rootDomainNamingContext",
	"configurationNamingContext", "schemaNamingContext", "subschemaSubentry",
	"dnsHostName",
}

// ServerInfo returns the capabilities the server announces in its RootDSE.
// The result is cached per connection: it is read once and read again after
// a reconnect. The returned value is a copy the caller may modify.
func (c *Client) ServerInfo() (*models.ServerInfo, error) {
	c.mu.Lock()
	cached := c.serverInfo
	c.mu.Unlock()
	if cached != nil {
		return copyServerInfo(cached), nil
	}

	start := time.Now()
	searchReq := goldap.NewSearchRequest(
		"",
		goldap.ScopeBaseObject,
		goldap.NeverDerefAliases,
		0, 0, false,
		"(objectClass=*)",
		rootDSECapabilityAttrs,
		nil,
	)

	var entry *goldap.Entry
	var conn *goldap.Conn
	err := c.read(func(cn *goldap.Conn) error {
		entry, conn = nil, cn
		result, err := cn.Search(searchReq)
		if err != nil {
			return err
		}
		if len(result.Entries) > 0 {
			entry = result.Entries[0]
		}
		return nil
	})
	if err != nil {
		c.logger.Log("ROOTDSE", "Read server capabilities", time.Since(start), err)
		return nil, searchError(err)
	}
	if entry == nil {
		entry = &goldap.Entry{}
	}

	info := serverInfoFromRootDSE(entry)
	c.mu.Lock()
	if c.conn == conn {
		// Only cache what belongs to the current connection.
		c.serverInfo = info
	}
	c.mu.Unlock()
	return copyServerInfo(info), nil
}

// serverInfoFromRootDSE extracts the capabilities from a RootDSE entry.
func serverInfoFromRootDSE(e *goldap.Entry) *models.ServerInfo {
	// values returns the distinct values of an attribute (Samba lists some
	// controls several times).
	values := func(name string) []string {
		out := []string{}
		for _, v := range e.GetEqualFoldAttributeValues(name) {
			if !slices.Contains(out, v) {
				out = append(out, v)
			}
		}
		return out
	}
	info := &models.ServerInfo{
		VendorName:                 e.GetEqualFoldAttributeValue("vendorName"),
		VendorVersion:              e.GetEqualFoldAttributeValue("vendorVersion"),
		SupportedControls:          values("supportedControl"),
		SupportedExtensions:        values("supportedExtension"),
		SupportedCapabilities:      values("supportedCapabilities"),
		SupportedSASLMechanisms:    values("supportedSASLMechanisms"),
		NamingContexts:             values("namingContexts"),
		DefaultNamingContext:       e.GetEqualFoldAttributeValue("defaultNamingContext"),
		RootDomainNamingContext:    e.GetEqualFoldAttributeValue("rootDomainNamingContext"),
		ConfigurationNamingContext: e.GetEqualFoldAttributeValue("configurationNamingContext"),
		SchemaNamingContext:        e.GetEqualFoldAttributeValue("schemaNamingContext"),
		SubschemaSubentry:          e.GetEqualFoldAttributeValue("subschemaSubentry"),
		DNSHostName:                e.GetEqualFoldAttributeValue("dnsHostName"),
	}
	objectClasses := append(values("objectClass"), values("structuralObjectClass")...)
	info.ServerType = detectServerType(info, objectClasses)
	return info
}

// detectServerType classifies a server: AD (and Samba AD) by the AD
// capability OID, 389DS by its vendor name, OpenLDAP by its RootDSE object
// class.
func detectServerType(info *models.ServerInfo, objectClasses []string) string {
	for _, capability := range info.SupportedCapabilities {
		if capability == adCapabilityOID {
			return models.ServerTypeAD
		}
	}
	vendor := strings.ToLower(info.VendorName)
	if strings.Contains(vendor, "389") || strings.Contains(vendor, "red hat") {
		return models.ServerType389DS
	}
	for _, oc := range objectClasses {
		if strings.EqualFold(oc, "OpenLDAProotDSE") {
			return models.ServerTypeOpenLDAP
		}
	}
	return models.ServerTypeOther
}

// copyServerInfo returns a deep copy of info.
func copyServerInfo(info *models.ServerInfo) *models.ServerInfo {
	cp := *info
	cp.SupportedControls = append([]string{}, info.SupportedControls...)
	cp.SupportedExtensions = append([]string{}, info.SupportedExtensions...)
	cp.SupportedCapabilities = append([]string{}, info.SupportedCapabilities...)
	cp.SupportedSASLMechanisms = append([]string{}, info.SupportedSASLMechanisms...)
	cp.NamingContexts = append([]string{}, info.NamingContexts...)
	return &cp
}
