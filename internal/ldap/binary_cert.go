package ldap

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// binOIDSubjectAltName is the X.509 subjectAltName extension.
var binOIDSubjectAltName = asn1.ObjectIdentifier{2, 5, 29, 17}

// binOIDMicrosoftUPN is the otherName type of a Microsoft user principal name.
var binOIDMicrosoftUPN = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 311, 20, 2, 3}

// ParseCertificateValue parses a certificate given as DER or as PEM text
// (the first CERTIFICATE block is used) and returns it together with its DER
// encoding.
func ParseCertificateValue(data []byte) (*x509.Certificate, []byte, error) {
	if cert, err := x509.ParseCertificate(data); err == nil {
		return cert, data, nil
	} else if !bytes.Contains(data, []byte("-----BEGIN")) {
		return nil, nil, fmt.Errorf("not an X.509 certificate: %w", err)
	}
	rest := data
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			return nil, nil, errors.New("not an X.509 certificate: the PEM data holds no CERTIFICATE block")
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, nil, fmt.Errorf("not an X.509 certificate: %w", err)
		}
		return cert, block.Bytes, nil
	}
}

// DescribeCertificate summarizes a certificate given as DER or PEM.
func DescribeCertificate(data []byte) (*models.CertificateSummary, error) {
	cert, der, err := ParseCertificateValue(data)
	if err != nil {
		return nil, err
	}
	sha1Sum := sha1.Sum(der)
	sha256Sum := sha256.Sum256(der)
	info := &models.CertificateSummary{
		Subject:            certDistinguishedName(cert.RawSubject, cert.Subject),
		Issuer:             certDistinguishedName(cert.RawIssuer, cert.Issuer),
		SerialNumber:       certColonHex(cert.SerialNumber.Bytes()),
		NotBefore:          cert.NotBefore.UTC().Format(time.RFC3339),
		NotAfter:           cert.NotAfter.UTC().Format(time.RFC3339),
		Version:            cert.Version,
		SignatureAlgorithm: cert.SignatureAlgorithm.String(),
		PublicKeyAlgorithm: cert.PublicKeyAlgorithm.String(),
		PublicKeyBits:      certPublicKeyBits(cert.PublicKey),
		IsCA:               cert.BasicConstraintsValid && cert.IsCA,
		SelfSigned:         certIsSelfSigned(cert),
		DNSNames:           certNonNil(cert.DNSNames),
		EmailAddresses:     certNonNil(cert.EmailAddresses),
		IPAddresses:        []string{},
		URIs:               []string{},
		UPNs:               certSubjectAltNameUPNs(cert),
		KeyUsage:           certKeyUsageNames(cert.KeyUsage),
		ExtKeyUsage:        certExtKeyUsageNames(cert),
		SubjectKeyID:       certColonHex(cert.SubjectKeyId),
		AuthorityKeyID:     certColonHex(cert.AuthorityKeyId),
		SHA1Fingerprint:    certColonHex(sha1Sum[:]),
		SHA256Fingerprint:  certColonHex(sha256Sum[:]),
		Size:               len(der),
		DER:                base64.StdEncoding.EncodeToString(der),
	}
	if len(cert.SerialNumber.Bytes()) == 0 {
		info.SerialNumber = "00"
	}
	for _, ip := range cert.IPAddresses {
		info.IPAddresses = append(info.IPAddresses, ip.String())
	}
	for _, u := range cert.URIs {
		info.URIs = append(info.URIs, u.String())
	}
	certDescribeExtensions(cert, info)
	return info, nil
}

// Extensions read for the certificate card (DEF-12).
var (
	binOIDKeyUsage          = asn1.ObjectIdentifier{2, 5, 29, 15}
	binOIDExtKeyUsage       = asn1.ObjectIdentifier{2, 5, 29, 37}
	binOIDTemplateName      = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 311, 20, 2}    // szOID_ENROLL_CERTTYPE_EXTENSION (BMPString)
	binOIDTemplateInfo      = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 311, 21, 7}    // szOID_CERTIFICATE_TEMPLATE
	binOIDNTDSCASecurityExt = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 311, 25, 2}    // szOID_NTDS_CA_SECURITY_EXT
	binOIDNTDSObjectSID     = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 311, 25, 2, 1} // szOID_NTDS_OBJECTSID
)

// certDescribeExtensions fills the extension details of a summary: SANs in
// certificate order, EKU OIDs and criticality, path length, AD CS template
// and SID, CRL / OCSP / CA issuer URLs and policies.
func certDescribeExtensions(cert *x509.Certificate, info *models.CertificateSummary) {
	info.AltNames = certAltNames(cert)
	info.ExtKeyUsageOIDs = []string{}
	info.MaxPathLen = -1
	if cert.BasicConstraintsValid && cert.IsCA && (cert.MaxPathLen > 0 || (cert.MaxPathLen == 0 && cert.MaxPathLenZero)) {
		info.MaxPathLen = cert.MaxPathLen
	}
	for _, ext := range cert.Extensions {
		switch {
		case ext.Id.Equal(binOIDKeyUsage):
			info.KeyUsageCritical = ext.Critical
		case ext.Id.Equal(binOIDExtKeyUsage):
			info.ExtKeyUsageCritical = ext.Critical
			var oids []asn1.ObjectIdentifier
			if rest, err := asn1.Unmarshal(ext.Value, &oids); err == nil && len(rest) == 0 {
				for _, oid := range oids {
					info.ExtKeyUsageOIDs = append(info.ExtKeyUsageOIDs, oid.String())
				}
			}
		case ext.Id.Equal(binOIDTemplateName):
			if name := certBMPString(ext.Value); name != "" {
				info.Template = name
			}
		case ext.Id.Equal(binOIDTemplateInfo):
			var tmpl struct {
				ID    asn1.ObjectIdentifier
				Major int `asn1:"optional"`
				Minor int `asn1:"optional"`
			}
			if _, err := asn1.Unmarshal(ext.Value, &tmpl); err == nil && info.Template == "" {
				info.Template = fmt.Sprintf("%s v%d.%d", tmpl.ID, tmpl.Major, tmpl.Minor)
			}
		case ext.Id.Equal(binOIDNTDSCASecurityExt):
			info.SID = certNTDSObjectSID(ext.Value)
		}
	}
	if len(info.ExtKeyUsageOIDs) > 0 {
		// Names in certificate order (crypto/x509 lists known usages before unknown ones).
		names := make([]string, 0, len(info.ExtKeyUsageOIDs))
		for _, oid := range info.ExtKeyUsageOIDs {
			names = append(names, certExtKeyUsageName(oid))
		}
		info.ExtKeyUsage = names
	}
	info.CRLDistributionPoints = certNonNil(cert.CRLDistributionPoints)
	info.OCSPServers = certNonNil(cert.OCSPServer)
	info.IssuingCertificateURLs = certNonNil(cert.IssuingCertificateURL)
	info.PolicyOIDs = []string{}
	for _, p := range cert.Policies {
		info.PolicyOIDs = append(info.PolicyOIDs, p.String())
	}
	if len(info.PolicyOIDs) == 0 {
		for _, p := range cert.PolicyIdentifiers {
			info.PolicyOIDs = append(info.PolicyOIDs, p.String())
		}
	}
}

// certExtKeyUsageNamesByOID names extended key usages by OID (RFC 5280,
// Microsoft, Kerberos PKINIT, SSH).
var certExtKeyUsageNamesByOID = map[string]string{
	"2.5.29.37.0":              "Any",
	"1.3.6.1.5.5.7.3.1":        "Server Authentication",
	"1.3.6.1.5.5.7.3.2":        "Client Authentication",
	"1.3.6.1.5.5.7.3.3":        "Code Signing",
	"1.3.6.1.5.5.7.3.4":        "Email Protection",
	"1.3.6.1.5.5.7.3.5":        "IPsec End System",
	"1.3.6.1.5.5.7.3.6":        "IPsec Tunnel",
	"1.3.6.1.5.5.7.3.7":        "IPsec User",
	"1.3.6.1.5.5.7.3.8":        "Time Stamping",
	"1.3.6.1.5.5.7.3.9":        "OCSP Signing",
	"1.3.6.1.5.5.7.3.17":       "IKE Intermediate",
	"1.3.6.1.5.5.7.3.21":       "SSH Client",
	"1.3.6.1.5.5.7.3.22":       "SSH Server",
	"1.3.6.1.4.1.311.10.3.3":   "Microsoft Server Gated Crypto",
	"2.16.840.1.113730.4.1":    "Netscape Server Gated Crypto",
	"1.3.6.1.4.1.311.2.1.21":   "Microsoft Individual Code Signing",
	"1.3.6.1.4.1.311.2.1.22":   "Microsoft Commercial Code Signing",
	"1.3.6.1.4.1.311.61.1.1":   "Microsoft Kernel Code Signing",
	"1.3.6.1.4.1.311.10.3.1":   "Microsoft Trust List Signing",
	"1.3.6.1.4.1.311.10.3.12":  "Document Signing",
	"1.3.6.1.4.1.311.10.3.13":  "Lifetime Signing",
	"1.3.6.1.4.1.311.80.1":     "Document Encryption",
	"1.3.6.1.4.1.311.20.2.1":   "Certificate Request Agent",
	"1.3.6.1.4.1.311.20.2.2":   "Smart Card Logon",
	"1.3.6.1.4.1.311.10.3.4":   "Encrypting File System",
	"1.3.6.1.4.1.311.10.3.4.1": "File Recovery",
	"1.3.6.1.4.1.311.21.5":     "Private Key Archival",
	"1.3.6.1.4.1.311.21.6":     "Key Recovery Agent",
	"1.3.6.1.4.1.311.21.19":    "Directory Service Email Replication",
	"1.3.6.1.4.1.311.54.1.2":   "Remote Desktop Authentication",
	"1.3.6.1.5.2.3.4":          "Kerberos Client Authentication",
	"1.3.6.1.5.2.3.5":          "Kerberos KDC",
}

// certExtKeyUsageName is the name of an extended key usage OID, or the OID.
func certExtKeyUsageName(oid string) string {
	if n, ok := certExtKeyUsageNamesByOID[oid]; ok {
		return n
	}
	return oid
}

// certAltNames decodes the subjectAltName extension in certificate order.
func certAltNames(cert *x509.Certificate) []models.CertificateAltName {
	out := []models.CertificateAltName{}
	for _, ext := range cert.Extensions {
		if !ext.Id.Equal(binOIDSubjectAltName) {
			continue
		}
		var seq asn1.RawValue
		if rest, err := asn1.Unmarshal(ext.Value, &seq); err != nil || len(rest) > 0 || !seq.IsCompound {
			return out
		}
		rest := seq.Bytes
		for len(rest) > 0 {
			var name asn1.RawValue
			var err error
			if rest, err = asn1.Unmarshal(rest, &name); err != nil {
				return out
			}
			if name.Class != asn1.ClassContextSpecific {
				continue
			}
			if an, ok := certAltName(name); ok {
				out = append(out, an)
			}
		}
	}
	return out
}

// certAltName decodes one GeneralName (RFC 5280 4.2.1.6).
func certAltName(name asn1.RawValue) (models.CertificateAltName, bool) {
	switch name.Tag {
	case 0: // otherName [0] IMPLICIT SEQUENCE { type-id OID, value [0] EXPLICIT ANY }
		var typeID asn1.ObjectIdentifier
		valueBytes, err := asn1.Unmarshal(name.Bytes, &typeID)
		if err != nil {
			return models.CertificateAltName{}, false
		}
		var explicit asn1.RawValue
		if _, err := asn1.Unmarshal(valueBytes, &explicit); err != nil {
			return models.CertificateAltName{}, false
		}
		value := certASN1Text(explicit.Bytes)
		if typeID.Equal(binOIDMicrosoftUPN) {
			return models.CertificateAltName{Type: "UPN", Value: value}, true
		}
		return models.CertificateAltName{Type: "otherName " + typeID.String(), Value: value}, true
	case 1:
		return models.CertificateAltName{Type: "Email", Value: string(name.Bytes)}, true
	case 2:
		return models.CertificateAltName{Type: "DNS", Value: string(name.Bytes)}, true
	case 3:
		return models.CertificateAltName{Type: "X400", Value: certColonHex(name.Bytes)}, true
	case 4: // directoryName [4] EXPLICIT Name
		return models.CertificateAltName{Type: "DirName", Value: certDistinguishedName(name.Bytes, pkix.Name{})}, true
	case 5:
		return models.CertificateAltName{Type: "EDIParty", Value: certColonHex(name.Bytes)}, true
	case 6:
		return models.CertificateAltName{Type: "URI", Value: string(name.Bytes)}, true
	case 7:
		if len(name.Bytes) == 4 || len(name.Bytes) == 16 {
			return models.CertificateAltName{Type: "IP", Value: net.IP(name.Bytes).String()}, true
		}
		return models.CertificateAltName{Type: "IP", Value: certColonHex(name.Bytes)}, true
	case 8: // registeredID [8] IMPLICIT OBJECT IDENTIFIER
		var oid asn1.ObjectIdentifier
		full, err := asn1.Marshal(asn1.RawValue{Class: asn1.ClassUniversal, Tag: asn1.TagOID, Bytes: name.Bytes})
		if err == nil {
			if _, err = asn1.Unmarshal(full, &oid); err == nil {
				return models.CertificateAltName{Type: "RegisteredID", Value: oid.String()}, true
			}
		}
		return models.CertificateAltName{Type: "RegisteredID", Value: certColonHex(name.Bytes)}, true
	}
	return models.CertificateAltName{}, false
}

// certASN1Text renders a DER value as text when it is a string type
// (UTF8String, PrintableString, IA5String, BMPString, OCTET STRING with
// printable text), else as hex.
func certASN1Text(der []byte) string {
	var raw asn1.RawValue
	if _, err := asn1.Unmarshal(der, &raw); err != nil {
		return certColonHex(der)
	}
	if raw.Class == asn1.ClassUniversal {
		switch raw.Tag {
		case asn1.TagUTF8String, asn1.TagPrintableString, asn1.TagIA5String, asn1.TagT61String, 26 /* VisibleString */ :
			return string(raw.Bytes)
		case asn1.TagBMPString:
			return certDecodeBMP(raw.Bytes)
		case asn1.TagOctetString:
			if certPrintable(raw.Bytes) {
				return string(raw.Bytes)
			}
		}
	}
	return certColonHex(raw.Bytes)
}

func certPrintable(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	for _, c := range b {
		if c < 0x20 || c > 0x7e {
			return false
		}
	}
	return true
}

// certBMPString decodes a DER BMPString (UTF-16BE), "" when it is none.
func certBMPString(der []byte) string {
	var raw asn1.RawValue
	if _, err := asn1.Unmarshal(der, &raw); err != nil || raw.Class != asn1.ClassUniversal || raw.Tag != asn1.TagBMPString {
		return ""
	}
	return certDecodeBMP(raw.Bytes)
}

func certDecodeBMP(b []byte) string {
	if len(b)%2 != 0 {
		return ""
	}
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = uint16(b[2*i])<<8 | uint16(b[2*i+1])
	}
	return string(utf16.Decode(u))
}

// certNTDSObjectSID reads the SID of the AD CS security extension: a
// SEQUENCE of otherName [0] { 1.3.6.1.4.1.311.25.2.1, [0] OCTET STRING "S-1-5-…" }.
func certNTDSObjectSID(value []byte) string {
	var seq asn1.RawValue
	if _, err := asn1.Unmarshal(value, &seq); err != nil || !seq.IsCompound {
		return ""
	}
	rest := seq.Bytes
	for len(rest) > 0 {
		var name asn1.RawValue
		var err error
		if rest, err = asn1.Unmarshal(rest, &name); err != nil {
			return ""
		}
		if name.Class != asn1.ClassContextSpecific || name.Tag != 0 {
			continue
		}
		var typeID asn1.ObjectIdentifier
		valueBytes, err := asn1.Unmarshal(name.Bytes, &typeID)
		if err != nil || !typeID.Equal(binOIDNTDSObjectSID) {
			continue
		}
		var explicit asn1.RawValue
		if _, err := asn1.Unmarshal(valueBytes, &explicit); err != nil {
			continue
		}
		if sid := certASN1Text(explicit.Bytes); strings.HasPrefix(sid, "S-1-") {
			return sid
		}
	}
	return ""
}

// certDistinguishedName renders a certificate name in RFC 4514 form from its DER
// encoding, keeping the order and every attribute of the certificate (e.g.
// "CN=jdoe,CN=Users,DC=example,DC=com" of an AD-issued certificate, which
// pkix.Name.String() would reorder and shorten to one CN). parsed is the
// fallback if the raw name cannot be decoded.
func certDistinguishedName(raw []byte, parsed pkix.Name) string {
	var seq pkix.RDNSequence
	if rest, err := asn1.Unmarshal(raw, &seq); err != nil || len(rest) > 0 {
		return parsed.String()
	}
	rdns := make([]string, 0, len(seq))
	for i := len(seq) - 1; i >= 0; i-- { // RFC 4514: last RDN first
		atvs := make([]string, 0, len(seq[i]))
		for _, atv := range seq[i] {
			atvs = append(atvs, certFormatAttributeTypeAndValue(atv))
		}
		rdns = append(rdns, strings.Join(atvs, "+"))
	}
	return strings.Join(rdns, ",")
}

// certNameAttributeTypes are the short names of attribute types in certificate
// subjects and issuers (as printed by openssl -nameopt RFC2253).
var certNameAttributeTypes = map[string]string{
	"2.5.4.3":                    "CN",
	"2.5.4.4":                    "SN",
	"2.5.4.5":                    "SERIALNUMBER",
	"2.5.4.6":                    "C",
	"2.5.4.7":                    "L",
	"2.5.4.8":                    "ST",
	"2.5.4.9":                    "STREET",
	"2.5.4.10":                   "O",
	"2.5.4.11":                   "OU",
	"2.5.4.12":                   "title",
	"2.5.4.17":                   "POSTALCODE",
	"2.5.4.42":                   "GN",
	"0.9.2342.19200300.100.1.1":  "UID",
	"0.9.2342.19200300.100.1.25": "DC",
	"1.2.840.113549.1.9.1":       "emailAddress",
}

// certFormatAttributeTypeAndValue renders one "type=value" of a certificate name
// with RFC 4514 escaping; values that are not strings become "#<hex DER>".
func certFormatAttributeTypeAndValue(atv pkix.AttributeTypeAndValue) string {
	typ := atv.Type.String()
	if name, ok := certNameAttributeTypes[typ]; ok {
		typ = name
	}
	str, ok := atv.Value.(string)
	if !ok {
		if der, err := asn1.Marshal(atv.Value); err == nil {
			return typ + "=#" + hex.EncodeToString(der)
		}
		return typ + "=" + certEscapeDNValue(fmt.Sprint(atv.Value))
	}
	return typ + "=" + certEscapeDNValue(str)
}

// certEscapeDNValue escapes an attribute value for a string DN (RFC 4514 2.4).
func certEscapeDNValue(v string) string {
	var b strings.Builder
	for i, r := range v {
		switch {
		case r == 0:
			b.WriteString(`\00`)
			continue
		case strings.ContainsRune(`"+,;<>\`, r),
			i == 0 && (r == ' ' || r == '#'),
			i == len(v)-1 && r == ' ':
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// certColonHex formats bytes as upper-case hex pairs separated by colons.
func certColonHex(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	h := strings.ToUpper(hex.EncodeToString(b))
	parts := make([]string, 0, len(b))
	for i := 0; i < len(h); i += 2 {
		parts = append(parts, h[i:i+2])
	}
	return strings.Join(parts, ":")
}

func certNonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// certIsSelfSigned reports whether issuer and subject are equal and the
// certificate's signature verifies with its own key.
func certIsSelfSigned(cert *x509.Certificate) bool {
	if !bytes.Equal(cert.RawIssuer, cert.RawSubject) {
		return false
	}
	return cert.CheckSignature(cert.SignatureAlgorithm, cert.RawTBSCertificate, cert.Signature) == nil
}

func certPublicKeyBits(key any) int {
	switch k := key.(type) {
	case *rsa.PublicKey:
		return k.N.BitLen()
	case *ecdsa.PublicKey:
		if k.Curve != nil {
			return k.Curve.Params().BitSize
		}
	case ed25519.PublicKey:
		return 256
	}
	return 0
}

var certKeyUsageBits = []struct {
	bit  x509.KeyUsage
	name string
}{
	{x509.KeyUsageDigitalSignature, "Digital Signature"},
	{x509.KeyUsageContentCommitment, "Non-Repudiation"},
	{x509.KeyUsageKeyEncipherment, "Key Encipherment"},
	{x509.KeyUsageDataEncipherment, "Data Encipherment"},
	{x509.KeyUsageKeyAgreement, "Key Agreement"},
	{x509.KeyUsageCertSign, "Certificate Sign"},
	{x509.KeyUsageCRLSign, "CRL Sign"},
	{x509.KeyUsageEncipherOnly, "Encipher Only"},
	{x509.KeyUsageDecipherOnly, "Decipher Only"},
}

func certKeyUsageNames(ku x509.KeyUsage) []string {
	names := []string{}
	for _, b := range certKeyUsageBits {
		if ku&b.bit != 0 {
			names = append(names, b.name)
		}
	}
	return names
}

var certExtKeyUsageNameMap = map[x509.ExtKeyUsage]string{
	x509.ExtKeyUsageAny:                            "Any",
	x509.ExtKeyUsageServerAuth:                     "Server Authentication",
	x509.ExtKeyUsageClientAuth:                     "Client Authentication",
	x509.ExtKeyUsageCodeSigning:                    "Code Signing",
	x509.ExtKeyUsageEmailProtection:                "Email Protection",
	x509.ExtKeyUsageIPSECEndSystem:                 "IPsec End System",
	x509.ExtKeyUsageIPSECTunnel:                    "IPsec Tunnel",
	x509.ExtKeyUsageIPSECUser:                      "IPsec User",
	x509.ExtKeyUsageTimeStamping:                   "Time Stamping",
	x509.ExtKeyUsageOCSPSigning:                    "OCSP Signing",
	x509.ExtKeyUsageMicrosoftServerGatedCrypto:     "Microsoft Server Gated Crypto",
	x509.ExtKeyUsageNetscapeServerGatedCrypto:      "Netscape Server Gated Crypto",
	x509.ExtKeyUsageMicrosoftCommercialCodeSigning: "Microsoft Commercial Code Signing",
	x509.ExtKeyUsageMicrosoftKernelCodeSigning:     "Microsoft Kernel Code Signing",
}

// certUnknownExtKeyUsageNames names extended key usages Go does not know.
var certUnknownExtKeyUsageNames = map[string]string{
	"1.3.6.1.4.1.311.20.2.2":  "Smart Card Logon",
	"1.3.6.1.4.1.311.10.3.4":  "Encrypting File System",
	"1.3.6.1.4.1.311.10.3.12": "Document Signing",
	"1.3.6.1.5.2.3.4":         "Kerberos Client Authentication",
	"1.3.6.1.5.2.3.5":         "Kerberos KDC",
	"1.3.6.1.5.5.7.3.17":      "IKE Intermediate",
}

func certExtKeyUsageNames(cert *x509.Certificate) []string {
	names := []string{}
	for _, eku := range cert.ExtKeyUsage {
		if n, ok := certExtKeyUsageNameMap[eku]; ok {
			names = append(names, n)
		} else {
			names = append(names, fmt.Sprintf("EKU %d", eku))
		}
	}
	for _, oid := range cert.UnknownExtKeyUsage {
		if n, ok := certUnknownExtKeyUsageNames[oid.String()]; ok {
			names = append(names, n)
		} else {
			names = append(names, oid.String())
		}
	}
	return names
}

// certSubjectAltNameUPNs returns the Microsoft UPN otherName entries of the
// subjectAltName extension, which crypto/x509 does not expose.
func certSubjectAltNameUPNs(cert *x509.Certificate) []string {
	upns := []string{}
	for _, ext := range cert.Extensions {
		if !ext.Id.Equal(binOIDSubjectAltName) {
			continue
		}
		var seq asn1.RawValue
		if rest, err := asn1.Unmarshal(ext.Value, &seq); err != nil || len(rest) > 0 || !seq.IsCompound {
			return upns
		}
		rest := seq.Bytes
		for len(rest) > 0 {
			var name asn1.RawValue
			var err error
			if rest, err = asn1.Unmarshal(rest, &name); err != nil {
				return upns
			}
			// otherName [0] IMPLICIT SEQUENCE { type-id OID, value [0] EXPLICIT ANY }
			if name.Class != asn1.ClassContextSpecific || name.Tag != 0 {
				continue
			}
			var typeID asn1.ObjectIdentifier
			valueBytes, err := asn1.Unmarshal(name.Bytes, &typeID)
			if err != nil || !typeID.Equal(binOIDMicrosoftUPN) {
				continue
			}
			var explicit asn1.RawValue
			if _, err := asn1.Unmarshal(valueBytes, &explicit); err != nil {
				continue
			}
			var upn string
			if _, err := asn1.Unmarshal(explicit.Bytes, &upn); err == nil {
				upns = append(upns, upn)
			}
		}
	}
	return upns
}
