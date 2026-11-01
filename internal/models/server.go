package models

// Server types reported by ServerInfo.ServerType.
const (
	ServerTypeAD       = "ad"
	ServerTypeOpenLDAP = "openldap"
	ServerType389DS    = "389ds"
	ServerTypeOther    = "other"
)

// ServerInfo describes the capabilities a server announces in its RootDSE.
type ServerInfo struct {
	// ServerType is "ad" (Active Directory and Samba AD), "openldap",
	// "389ds" (389 Directory Server / Red Hat DS) or "other".
	ServerType                 string   `json:"serverType"`
	VendorName                 string   `json:"vendorName"`
	VendorVersion              string   `json:"vendorVersion"`
	SupportedControls          []string `json:"supportedControls"`
	SupportedExtensions        []string `json:"supportedExtensions"`
	SupportedCapabilities      []string `json:"supportedCapabilities"`
	SupportedSASLMechanisms    []string `json:"supportedSASLMechanisms"`
	NamingContexts             []string `json:"namingContexts"`
	DefaultNamingContext       string   `json:"defaultNamingContext"`
	RootDomainNamingContext    string   `json:"rootDomainNamingContext"`
	ConfigurationNamingContext string   `json:"configurationNamingContext"`
	SchemaNamingContext        string   `json:"schemaNamingContext"`
	SubschemaSubentry          string   `json:"subschemaSubentry"`
	DNSHostName                string   `json:"dnsHostName"`
}
