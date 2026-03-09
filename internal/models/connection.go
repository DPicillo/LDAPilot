package models

// AuthMethod represents the authentication method for LDAP connections.
type AuthMethod string

const (
	// AuthNone represents anonymous authentication.
	AuthNone AuthMethod = "none"
	// AuthSimple represents simple bind authentication.
	AuthSimple AuthMethod = "simple"
)

// TLSMode represents the TLS mode for LDAP connections.
type TLSMode string

const (
	// TLSNone represents no TLS.
	TLSNone TLSMode = "none"
	// TLSSSL represents LDAPS (SSL/TLS from the start).
	TLSSSL TLSMode = "ssl"
	// TLSStartTLS represents upgrading a plain connection with StartTLS.
	TLSStartTLS TLSMode = "starttls"
)

// ConnectionProfile holds all settings needed to connect to an LDAP server.
type ConnectionProfile struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Host          string     `json:"host"`
	Port          int        `json:"port"`
	BaseDN        string     `json:"baseDN"`
	AuthMethod    AuthMethod `json:"authMethod"`
	BindDN        string     `json:"bindDN"`
	Password      string     `json:"password"`
	HasPassword   bool       `json:"hasPassword"`
	TLSMode       TLSMode    `json:"tlsMode"`
	TLSSkipVerify bool       `json:"tlsSkipVerify"`
	PageSize      int        `json:"pageSize"`
	Timeout       int        `json:"timeout"`
	ReadOnly          bool       `json:"readOnly"`
	DisableReferrals  bool       `json:"disableReferrals"`
}

// Schema validation types

// ObjectClassInfo provides detailed information about an LDAP objectClass,
// including its inheritance chain and required/optional attributes.
type ObjectClassInfo struct {
	Name        string   `json:"name"`
	OID         string   `json:"oid"`
	Description string   `json:"description"`
	Superior    []string `json:"superior"`
	Must        []string `json:"must"`
	May         []string `json:"may"`
	Type        string   `json:"type"`
}

// ValidationError represents a single schema validation failure.
type ValidationError struct {
	Attribute string `json:"attribute"`
	Message   string `json:"message"`
	Type      string `json:"type"`
}
