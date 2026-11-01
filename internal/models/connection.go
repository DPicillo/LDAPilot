package models

// AuthMethod represents the authentication method for LDAP connections.
type AuthMethod string

const (
	// AuthNone represents anonymous authentication.
	AuthNone AuthMethod = "none"
	// AuthSimple represents simple bind authentication.
	AuthSimple AuthMethod = "simple"
	// AuthNTLM represents an NTLM bind (Active Directory, Samba). The user
	// name is BindDN in the form DOMAIN\user, user@domain or user with
	// NTLMDomain; the password is Password.
	AuthNTLM AuthMethod = "ntlm"
	// AuthKerberos represents a SASL GSSAPI (Kerberos v5) bind, see the Krb*
	// fields. It authenticates only: no SASL signing or sealing layer is
	// negotiated, so servers requiring LDAP signing need LDAPS or StartTLS.
	AuthKerberos AuthMethod = "kerberos"
	// AuthExternal represents a SASL EXTERNAL bind: the server derives the
	// identity from the TLS client certificate (TLSClientCertFile).
	AuthExternal AuthMethod = "external"
)

// Kerberos credential sources (ConnectionProfile.KrbCredSource).
const (
	// KrbCredPassword obtains a ticket with BindDN (principal) and Password.
	KrbCredPassword = "password"
	// KrbCredSystem uses the credentials of the logged-on user: SSPI on
	// Windows, the Kerberos credential cache (kinit) elsewhere.
	KrbCredSystem = "system"
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
	ID               string     `json:"id"`
	Name             string     `json:"name"`
	Host             string     `json:"host"`
	Port             int        `json:"port"`
	BaseDN           string     `json:"baseDN"`
	AuthMethod       AuthMethod `json:"authMethod"`
	BindDN           string     `json:"bindDN"`
	Password         string     `json:"password"`
	HasPassword      bool       `json:"hasPassword"`
	TLSMode          TLSMode    `json:"tlsMode"`
	TLSSkipVerify    bool       `json:"tlsSkipVerify"`
	PageSize         int        `json:"pageSize"`
	Timeout          int        `json:"timeout"`
	ReadOnly         bool       `json:"readOnly"`
	DisableReferrals bool       `json:"disableReferrals"`

	// AskPassword makes the profile ask for the password on every Connect
	// and Reconnect (simple bind with a DN, NTLM, Kerberos with user and
	// password): no password is stored, and a typed one is neither saved
	// nor kept for the next Connect. The open connection keeps it in memory
	// for its transparent re-dials until it is disconnected.
	AskPassword bool `json:"askPassword,omitempty"`

	// NTLMDomain is the NetBIOS domain for AuthNTLM when BindDN holds a bare
	// user name.
	NTLMDomain string `json:"ntlmDomain,omitempty"`

	// KrbCredSource is KrbCredPassword (default) or KrbCredSystem.
	KrbCredSource string `json:"krbCredSource,omitempty"`
	// KrbRealm is the Kerberos realm; when empty it is taken from a
	// user@REALM principal or derived from the DC= components of BaseDN.
	KrbRealm string `json:"krbRealm,omitempty"`
	// KrbKDC optionally overrides the KDC (host or host:port, default port
	// 88). When set, the Kerberos configuration is built programmatically
	// (TCP only) instead of reading krb5.conf / DNS.
	KrbKDC string `json:"krbKDC,omitempty"`
	// KrbSPN overrides the service principal (default ldap/<host>), needed
	// when connecting via an IP address or an alias.
	KrbSPN string `json:"krbSPN,omitempty"`
	// KrbCCache optionally names the credential cache file for
	// KrbCredSystem on Linux/macOS (default: KRB5CCNAME or /tmp/krb5cc_<uid>).
	KrbCCache string `json:"krbCCache,omitempty"`

	// TLSCACertFile and TLSCACertPEM add trusted CA certificates (PEM file
	// path, or PEM text stored in the profile) to the system roots.
	TLSCACertFile string `json:"tlsCACertFile,omitempty"`
	TLSCACertPEM  string `json:"tlsCACertPEM,omitempty"`
	// TLSClientCertFile and TLSClientKeyFile are PEM files of a client
	// certificate for mutual TLS (and SASL EXTERNAL). Only the paths are
	// stored; the key file must not be encrypted.
	TLSClientCertFile string `json:"tlsClientCertFile,omitempty"`
	TLSClientKeyFile  string `json:"tlsClientKeyFile,omitempty"`
	// TLSPinnedCerts holds SHA-256 fingerprints of server (leaf)
	// certificates that are trusted even if their chain, host name or
	// validity period cannot be verified. Canonical form: uppercase hex
	// pairs separated by colons.
	TLSPinnedCerts []string `json:"tlsPinnedCerts,omitempty"`
	// TLSPinnedAt records when each pin was added (fingerprint → RFC 3339
	// UTC), so a changed certificate can say since when the old one was
	// trusted. Pins without an entry predate the field.
	TLSPinnedAt map[string]string `json:"tlsPinnedAt,omitempty"`
	// TLSPinnedInfo describes the pinned certificates (fingerprint →
	// subject, issuer, validity), recorded when a pin is added from a
	// presented certificate or refreshed by a test connection. Manual pins
	// and pins of older versions have no entry.
	TLSPinnedInfo map[string]PinnedCertificateInfo `json:"tlsPinnedInfo,omitempty"`

	// PasswordPolicy is how cleartext userPassword values are stored:
	// PasswordPolicyClient, PasswordPolicyServer, PasswordPolicyAsk, or ""
	// (auto: the default of the detected server type). PasswordScheme is
	// the client-side scheme ID for "client" ("" = default of the server
	// type). See ldap.ResolvePasswordPolicy.
	PasswordPolicy string `json:"passwordPolicy,omitempty"`
	PasswordScheme string `json:"passwordScheme,omitempty"`
}

// ConnectionExportResult reports ConnectionService.ExportConnections: the
// file written and the number of profiles in it. An empty Path means the
// user cancelled the save dialog.
type ConnectionExportResult struct {
	Path  string `json:"path"`
	Count int    `json:"count"`
}

// ConnectionImportSkip is a profile of an import file that was not imported.
type ConnectionImportSkip struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// ConnectionImportReport reports ConnectionService.ImportConnections.
type ConnectionImportReport struct {
	// Cancelled is true when the user closed the open dialog.
	Cancelled bool   `json:"cancelled"`
	Path      string `json:"path"`
	// Total is the number of profiles in the file.
	Total int `json:"total"`
	// Imported lists the names of the profiles added.
	Imported []string `json:"imported"`
	// Duplicates lists profiles that were skipped because a saved profile
	// (or an earlier one of the same file) has the same host, port, bind DN
	// and base DN.
	Duplicates []string `json:"duplicates"`
	// Skipped lists profiles that could not be imported, with the reason.
	Skipped []ConnectionImportSkip `json:"skipped"`
	// NeedPassword lists imported profiles that need a password on their
	// first connect (exports never contain passwords).
	NeedPassword []string `json:"needPassword"`
	// AskPassword lists imported profiles that ask for the password on
	// every connect (ConnectionProfile.AskPassword); they are not in
	// NeedPassword.
	AskPassword []string `json:"askPassword"`
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
