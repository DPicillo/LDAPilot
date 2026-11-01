package models

// CertificateSummary is a display summary of one X.509 certificate, e.g. a
// value of userCertificate or cACertificate. Times are RFC 3339 in UTC;
// serial number, key IDs and fingerprints are upper-case hex bytes separated
// by colons.
type CertificateSummary struct {
	Subject            string   `json:"subject"`
	Issuer             string   `json:"issuer"`
	SerialNumber       string   `json:"serialNumber"`
	NotBefore          string   `json:"notBefore"`
	NotAfter           string   `json:"notAfter"`
	Version            int      `json:"version"`
	SignatureAlgorithm string   `json:"signatureAlgorithm"`
	PublicKeyAlgorithm string   `json:"publicKeyAlgorithm"`
	PublicKeyBits      int      `json:"publicKeyBits"`
	IsCA               bool     `json:"isCA"`
	SelfSigned         bool     `json:"selfSigned"`
	DNSNames           []string `json:"dnsNames"`
	EmailAddresses     []string `json:"emailAddresses"`
	IPAddresses        []string `json:"ipAddresses"`
	URIs               []string `json:"uris"`
	// UPNs are Microsoft user principal names from otherName SAN entries
	// (smart card logon certificates).
	UPNs              []string `json:"upns"`
	KeyUsage          []string `json:"keyUsage"`
	ExtKeyUsage       []string `json:"extKeyUsage"`
	SubjectKeyID      string   `json:"subjectKeyId"`
	AuthorityKeyID    string   `json:"authorityKeyId"`
	SHA1Fingerprint   string   `json:"sha1Fingerprint"`
	SHA256Fingerprint string   `json:"sha256Fingerprint"`
	// Size is the length of the DER encoding in bytes.
	Size int `json:"size"`
	// DER is the standard base64 of the DER encoding (e.g. for "Copy as PEM"
	// of a certificate embedded in PKCS #7 data).
	DER string `json:"der"`

	// AltNames lists every subjectAltName entry in certificate order with its
	// type: "DNS", "Email", "IP", "URI", "UPN", "DirName", "RegisteredID",
	// "otherName <OID>" (value as text, else hex), "X400", "EDIParty" (hex).
	AltNames []CertificateAltName `json:"altNames"`
	// KeyUsageCritical / ExtKeyUsageCritical: the extension is marked critical.
	KeyUsageCritical    bool `json:"keyUsageCritical"`
	ExtKeyUsageCritical bool `json:"extKeyUsageCritical"`
	// ExtKeyUsageOIDs are the dotted OIDs of ExtKeyUsage, in the same order
	// (certificate order).
	ExtKeyUsageOIDs []string `json:"extKeyUsageOids"`
	// MaxPathLen is the path length constraint of a CA certificate; -1 when
	// there is none or the certificate is no CA.
	MaxPathLen int `json:"maxPathLen"`
	// Template is the AD CS certificate template: the name of a v1 template
	// ("User", "Machine") or the OID of a v2 template with its version
	// ("1.3.6.1.4.1.311.21.8.… v100.4"); "" when the certificate has none.
	Template string `json:"template"`
	// SID is the account SID of the AD CS strong certificate mapping
	// extension (1.3.6.1.4.1.311.25.2, KB5014754); "" when absent.
	SID                    string   `json:"sid"`
	CRLDistributionPoints  []string `json:"crlDistributionPoints"`
	OCSPServers            []string `json:"ocspServers"`
	IssuingCertificateURLs []string `json:"issuingCertificateUrls"`
	// PolicyOIDs are the certificate policy OIDs (dotted).
	PolicyOIDs []string `json:"policyOids"`
}

// CertificateAltName is one subjectAltName entry of a certificate.
type CertificateAltName struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

// PKCS7Summary is a display summary of PKCS #7 (CMS) SignedData, the format
// of userSMIMECertificate values published by Outlook/Exchange.
type PKCS7Summary struct {
	// ContentType is "signedData".
	ContentType string `json:"contentType"`
	// Version is the SignedData version (1 for PKCS #7, 1-5 for CMS).
	Version int `json:"version"`
	// EncapsulatedContentType is the dotted OID of the signed content
	// (1.2.840.113549.1.7.1 for data).
	EncapsulatedContentType string `json:"encapsulatedContentType"`
	// Detached is true if the signed content is not included.
	Detached bool `json:"detached"`
	// Certificates are the embedded X.509 certificates in stored order.
	Certificates []CertificateSummary `json:"certificates"`
	// OtherCertificates counts embedded certificates that are not readable
	// X.509 certificates (e.g. attribute certificates).
	OtherCertificates int `json:"otherCertificates"`
	CRLCount          int `json:"crlCount"`
	SignerCount       int `json:"signerCount"`
	// Size is the length of the encoding in bytes.
	Size int `json:"size"`
}

// BinaryFile is a local file prepared for upload into a binary attribute.
// Data follows the binary contract (standard base64 of the bytes to store).
type BinaryFile struct {
	// Name is the file's base name.
	Name string `json:"name"`
	// Size is the number of bytes in Data (after a PEM to DER conversion).
	Size int    `json:"size"`
	Data string `json:"data"`
	// Format is the detected content: "jpeg", "png", "gif", "x509" or ""
	// for anything else.
	Format string `json:"format"`
	// Width and Height are the image dimensions in pixels (0 if no image).
	Width  int `json:"width"`
	Height int `json:"height"`
	// Note describes a conversion that was applied, e.g. "converted from PEM".
	Note string `json:"note"`
}
