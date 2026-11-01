package models

// TLS verification modes reported in ConnectionTestResult.TLSVerification.
const (
	// TLSVerifySystem means the chain was verified against the system roots.
	TLSVerifySystem = "system"
	// TLSVerifyCustomCA means the chain was verified against a CA
	// certificate configured in the profile.
	TLSVerifyCustomCA = "custom-ca"
	// TLSVerifyPinned means the server certificate matched a pinned
	// fingerprint (TLSPinnedCerts).
	TLSVerifyPinned = "pinned"
	// TLSVerifySkipped means verification is disabled (TLSSkipVerify).
	TLSVerifySkipped = "skipped"
)

// Certificate problem kinds (CertificateProblem.Kind).
const (
	CertProblemUnknownAuthority = "unknown-authority"
	CertProblemHostname         = "hostname-mismatch"
	CertProblemExpired          = "expired"
	CertProblemNotYetValid      = "not-yet-valid"
	CertProblemInvalid          = "invalid"
)

// CertificateInfo describes one X.509 certificate presented by a server.
type CertificateInfo struct {
	Subject      string `json:"subject"`
	Issuer       string `json:"issuer"`
	SerialNumber string `json:"serialNumber"`
	// DNSNames and IPAddresses are the subject alternative names.
	DNSNames    []string `json:"dnsNames"`
	IPAddresses []string `json:"ipAddresses"`
	// NotBefore and NotAfter are RFC 3339 timestamps (UTC).
	NotBefore          string `json:"notBefore"`
	NotAfter           string `json:"notAfter"`
	IsCA               bool   `json:"isCA"`
	SelfSigned         bool   `json:"selfSigned"`
	KeyAlgorithm       string `json:"keyAlgorithm"`
	SignatureAlgorithm string `json:"signatureAlgorithm"`
	// SHA256 is the SHA-256 fingerprint of the DER encoding, uppercase hex
	// pairs separated by colons (the form stored in TLSPinnedCerts).
	SHA256 string `json:"sha256"`
	// PEM is the PEM encoding of the certificate.
	PEM string `json:"pem"`
}

// CertificateProblem describes why a server certificate was not trusted.
type CertificateProblem struct {
	// Host is the server name the certificate was checked against.
	Host string `json:"host"`
	// Kind is the primary problem, one of the CertProblem* constants.
	Kind string `json:"kind"`
	// Reason is the verification error text.
	Reason string `json:"reason"`
	// Issues lists every problem found (authority, host name, validity).
	Issues []string `json:"issues"`
	// Chain is the certificate chain as sent by the server, leaf first.
	Chain []CertificateInfo `json:"chain"`
	// PinnedChanged is true when the profile trusts pinned certificates and
	// the server now presents a different one (a new certificate, or someone
	// in between): not a first contact. PreviousPins are the pins the
	// profile trusted until now.
	PinnedChanged bool                `json:"pinnedChanged,omitempty"`
	PreviousPins  []PinnedCertificate `json:"previousPins,omitempty"`
}

// PinnedCertificate is a pinned server certificate of a profile.
type PinnedCertificate struct {
	// Fingerprint is the SHA-256 fingerprint (uppercase hex pairs with colons).
	Fingerprint string `json:"fingerprint"`
	// PinnedAt is when the pin was added (RFC 3339, UTC); empty for pins
	// stored before the date was recorded.
	PinnedAt string `json:"pinnedAt,omitempty"`
	// Subject, Issuer and NotAfter describe the pinned certificate when the
	// profile recorded them (ConnectionProfile.TLSPinnedInfo).
	Subject  string `json:"subject,omitempty"`
	Issuer   string `json:"issuer,omitempty"`
	NotAfter string `json:"notAfter,omitempty"`
}

// PinnedCertificateInfo describes a pinned server certificate (stored in
// ConnectionProfile.TLSPinnedInfo, keyed by its fingerprint).
type PinnedCertificateInfo struct {
	Subject string `json:"subject"`
	Issuer  string `json:"issuer,omitempty"`
	// NotBefore and NotAfter are RFC 3339 timestamps (UTC).
	NotBefore string `json:"notBefore,omitempty"`
	NotAfter  string `json:"notAfter,omitempty"`
}

// ConnectionTestResult reports the outcome of ConnectionService.TestConnectionDetailed.
type ConnectionTestResult struct {
	Success bool `json:"success"`
	// Error is the failure message (empty on success).
	Error string `json:"error,omitempty"`
	// Stage is where a failure happened: "config", "connect", "tls" or "bind".
	Stage string `json:"stage,omitempty"`

	AuthMethod AuthMethod `json:"authMethod"`
	// AuthSummary describes the bind, e.g. "Kerberos (GSSAPI) as
	// alice@EXAMPLE.COM, SPN ldap/dc1.example.com". Never contains secrets.
	AuthSummary string `json:"authSummary,omitempty"`
	// BoundAs is the authorization identity reported by the server
	// (Who am I? extended operation), if supported.
	BoundAs string `json:"boundAs,omitempty"`

	TLSMode TLSMode `json:"tlsMode"`
	// TLSVersion and TLSCipherSuite describe the negotiated TLS session.
	TLSVersion     string `json:"tlsVersion,omitempty"`
	TLSCipherSuite string `json:"tlsCipherSuite,omitempty"`
	// TLSVerification is one of the TLSVerify* constants for TLS sessions.
	TLSVerification string `json:"tlsVerification,omitempty"`
	// ServerCertificates is the chain the server presented, leaf first.
	ServerCertificates []CertificateInfo `json:"serverCertificates,omitempty"`
	// CertProblem is set when the connection failed because the server
	// certificate was not trusted; the UI can offer to pin it.
	CertProblem *CertificateProblem `json:"certProblem,omitempty"`

	// Warnings are security notes about a working connection.
	Warnings   []string `json:"warnings,omitempty"`
	DurationMs int64    `json:"durationMs"`

	// What the server announces in its RootDSE after a successful bind:
	// the detected server type (ServerType* constants), its naming contexts
	// and default naming context, offered as base DN by the dialog.
	ServerType           string   `json:"serverType,omitempty"`
	VendorName           string   `json:"vendorName,omitempty"`
	VendorVersion        string   `json:"vendorVersion,omitempty"`
	NamingContexts       []string `json:"namingContexts,omitempty"`
	DefaultNamingContext string   `json:"defaultNamingContext,omitempty"`
	// DNSHostName is the server's own DNS name from its RootDSE (AD and
	// Samba DCs): after a successful bind, or read anonymously when a
	// Kerberos bind failed, so the dialog can suggest the SPN
	// ldap/<dnsHostName> for a host given as an IP address or alias.
	DNSHostName string `json:"dnsHostName,omitempty"`
}

// AuthEnvironment describes the local authentication environment, so the
// connection dialog can explain what the "system" Kerberos credentials are.
type AuthEnvironment struct {
	// OS is the Go runtime GOOS ("windows", "linux", "darwin").
	OS string `json:"os"`
	// SSPIAvailable is true on Windows, where KrbCredSystem uses the
	// logged-on user via SSPI.
	SSPIAvailable bool `json:"sspiAvailable"`
	// Krb5Config is the krb5.conf used when no KDC override is set, and
	// Krb5ConfigFound whether it exists.
	Krb5Config      string `json:"krb5Config"`
	Krb5ConfigFound bool   `json:"krb5ConfigFound"`
	// DefaultCCache is the credential cache used by KrbCredSystem on
	// Linux/macOS when the profile names none (KRB5CCNAME, default_ccache_name
	// of krb5.conf, else the platform default); DefaultCCacheSource says which
	// ("from KRB5CCNAME", "from /etc/krb5.conf", "system default", ...).
	// CCacheSupported is false when it is of a type that cannot be read
	// (KEYRING:, KCM:, API:, DIR:); DefaultCCache is then the cache name.
	DefaultCCache       string `json:"defaultCCache"`
	DefaultCCacheSource string `json:"defaultCCacheSource"`
	CCacheSupported     bool   `json:"ccacheSupported"`
}
