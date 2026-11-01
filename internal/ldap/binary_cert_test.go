package ldap

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/pem"
	"math/big"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// binaryTestCertificate returns a self-signed DER certificate with SANs (incl. a
// Microsoft UPN otherName), key usages and a fixed validity.
func binaryTestCertificate(t *testing.T) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	upnValue, err := asn1.MarshalWithParams("jdoe@ad.example.org", "utf8")
	if err != nil {
		t.Fatal(err)
	}
	typeID, err := asn1.Marshal(binOIDMicrosoftUPN)
	if err != nil {
		t.Fatal(err)
	}
	explicitValue, _ := asn1.Marshal(asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 0, IsCompound: true, Bytes: upnValue})
	// otherName [0] IMPLICIT SEQUENCE { type-id, value [0] EXPLICIT }
	otherName, _ := asn1.Marshal(asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 0, IsCompound: true, Bytes: append(typeID, explicitValue...)})
	dnsName, _ := asn1.Marshal(asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 2, Bytes: []byte("host.example.org")})
	email, _ := asn1.Marshal(asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 1, Bytes: []byte("jdoe@example.org")})
	ip, _ := asn1.Marshal(asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 7, Bytes: net.ParseIP("192.0.2.1").To4()})
	uri, _ := asn1.Marshal(asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 6, Bytes: []byte("https://example.org/x")})
	var names []byte
	for _, n := range [][]byte{otherName, dnsName, email, ip, uri} {
		names = append(names, n...)
	}
	// The extension overrides the SAN crypto/x509 would build from the
	// template, so it lists all names itself.
	san, err := asn1.Marshal(asn1.RawValue{Class: asn1.ClassUniversal, Tag: asn1.TagSequence, IsCompound: true, Bytes: names})
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(0x1234ab),
		Subject:               pkix.Name{CommonName: "John Doe", Organization: []string{"Example"}},
		NotBefore:             time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC),
		NotAfter:              time.Date(2034, 1, 2, 3, 4, 5, 0, time.UTC),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageEmailProtection},
		UnknownExtKeyUsage:    []asn1.ObjectIdentifier{{1, 3, 6, 1, 4, 1, 311, 20, 2, 2}},
		BasicConstraintsValid: true,
		ExtraExtensions:       []pkix.Extension{{Id: binOIDSubjectAltName, Value: san}},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func TestBinaryDescribeCertificate(t *testing.T) {
	der := binaryTestCertificate(t)
	info, err := DescribeCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	if info.Subject != "CN=John Doe,O=Example" || info.Issuer != info.Subject {
		t.Errorf("subject/issuer = %q / %q", info.Subject, info.Issuer)
	}
	if info.SerialNumber != "12:34:AB" {
		t.Errorf("serial = %q", info.SerialNumber)
	}
	if info.NotBefore != "2024-01-02T03:04:05Z" || info.NotAfter != "2034-01-02T03:04:05Z" {
		t.Errorf("validity = %s - %s", info.NotBefore, info.NotAfter)
	}
	if !info.SelfSigned || info.IsCA {
		t.Errorf("selfSigned=%v isCA=%v", info.SelfSigned, info.IsCA)
	}
	if info.PublicKeyAlgorithm != "ECDSA" || info.PublicKeyBits != 256 || info.Version != 3 {
		t.Errorf("key = %s %d, version %d", info.PublicKeyAlgorithm, info.PublicKeyBits, info.Version)
	}
	if strings.Join(info.DNSNames, ",") != "host.example.org" || strings.Join(info.EmailAddresses, ",") != "jdoe@example.org" {
		t.Errorf("dns=%v email=%v", info.DNSNames, info.EmailAddresses)
	}
	if strings.Join(info.IPAddresses, ",") != "192.0.2.1" || strings.Join(info.URIs, ",") != "https://example.org/x" {
		t.Errorf("ip=%v uri=%v", info.IPAddresses, info.URIs)
	}
	if strings.Join(info.UPNs, ",") != "jdoe@ad.example.org" {
		t.Errorf("upns = %v", info.UPNs)
	}
	if strings.Join(info.KeyUsage, ",") != "Digital Signature,Key Encipherment" {
		t.Errorf("key usage = %v", info.KeyUsage)
	}
	if strings.Join(info.ExtKeyUsage, ",") != "Client Authentication,Email Protection,Smart Card Logon" {
		t.Errorf("ext key usage = %v", info.ExtKeyUsage)
	}
	sum := sha256.Sum256(der)
	if info.SHA256Fingerprint != certColonHex(sum[:]) || len(info.SHA256Fingerprint) != 32*3-1 || len(info.SHA1Fingerprint) != 20*3-1 {
		t.Errorf("fingerprints %q %q", info.SHA1Fingerprint, info.SHA256Fingerprint)
	}
	if info.Size != len(der) {
		t.Errorf("size = %d, want %d", info.Size, len(der))
	}
}

func TestBinaryDescribeCertificatePEMAndErrors(t *testing.T) {
	der := binaryTestCertificate(t)
	pemData := append([]byte("junk before\n"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte{1}})...)
	pemData = append(pemData, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})...)
	info, err := DescribeCertificate(pemData)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size != len(der) {
		t.Errorf("PEM size = %d, want DER size %d", info.Size, len(der))
	}
	if _, err := DescribeCertificate([]byte("\xff\xd8\xff\xe0 not a cert")); err == nil || !strings.Contains(err.Error(), "not an X.509 certificate") {
		t.Errorf("err = %v", err)
	}
	if _, err := DescribeCertificate(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: []byte{1}})); err == nil {
		t.Error("PEM without certificate accepted")
	}
}

func TestBinaryDescribeCertificateRSAAndCA(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Lab CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	info, err := DescribeCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	if !info.IsCA || info.PublicKeyBits != 2048 || info.PublicKeyAlgorithm != "RSA" || info.SerialNumber != "01" {
		t.Errorf("isCA=%v bits=%d alg=%s serial=%s", info.IsCA, info.PublicKeyBits, info.PublicKeyAlgorithm, info.SerialNumber)
	}
	if len(info.UPNs) != 0 || info.DNSNames == nil || info.ExtKeyUsage == nil {
		t.Errorf("empty lists must be non-nil and empty: %#v", info)
	}
}

// Subject and issuer keep the certificate's RDN order and all attributes:
// an AD-issued "DC=com/DC=example/CN=Users/CN=jdoe" certificate must not
// lose CN=Users (pkix.Name.String() keeps only one CN).
func TestBinaryDescribeCertificateNameOrder(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	oidDC := asn1.ObjectIdentifier{0, 9, 2342, 19200300, 100, 1, 25}
	oidCN := asn1.ObjectIdentifier{2, 5, 4, 3}
	subject := pkix.Name{ExtraNames: []pkix.AttributeTypeAndValue{
		{Type: oidDC, Value: "com"},
		{Type: oidDC, Value: "example"},
		{Type: oidCN, Value: "Users"},
		{Type: oidCN, Value: "Doe, John"},
	}}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(7),
		Subject:      subject,
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	info, err := DescribeCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	want := `CN=Doe\, John,CN=Users,DC=example,DC=com`
	if info.Subject != want || info.Issuer != want {
		t.Errorf("subject = %q, issuer = %q, want %q", info.Subject, info.Issuer, want)
	}
	if got := certDistinguishedName([]byte{1, 2}, pkix.Name{CommonName: "fallback"}); got != "CN=fallback" {
		t.Errorf("fallback = %q", got)
	}
	// The auth track's trust prompt / chain view (CertificateInfoOf) shows the
	// same names as the viewer, not pkix.Name.String()'s OID hex for DC.
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	if ci := CertificateInfoOf(cert); ci.Subject != want || ci.Issuer != want {
		t.Errorf("CertificateInfoOf subject = %q, issuer = %q, want %q", ci.Subject, ci.Issuer, want)
	}
}

func TestBinaryEscapeDNValue(t *testing.T) {
	for in, want := range map[string]string{
		"plain":       "plain",
		"Doe, John":   `Doe\, John`,
		"#hash":       `\#hash`,
		" lead":       `\ lead`,
		"trail ":      `trail\ `,
		`a+b;c<d>"e\`: `a\+b\;c\<d\>\"e\\`,
		"nul\x00":     `nul\00`,
		"Jürgen":      "Jürgen",
	} {
		if got := certEscapeDNValue(in); got != want {
			t.Errorf("certEscapeDNValue(%q) = %q, want %q", in, got, want)
		}
	}
	email := pkix.AttributeTypeAndValue{Type: asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 9, 1}, Value: "a@b.c"}
	if got := certFormatAttributeTypeAndValue(email); got != "emailAddress=a@b.c" {
		t.Errorf("email = %q", got)
	}
	other := pkix.AttributeTypeAndValue{Type: asn1.ObjectIdentifier{1, 2, 3}, Value: 5}
	if got := certFormatAttributeTypeAndValue(other); got != "1.2.3=#020105" {
		t.Errorf("non-string = %q", got)
	}
}

// binaryTestExtensionsCertificate returns a CA certificate with the
// extensions of the DEF-12 card: EKUs in a mixed order (critical), SANs of
// several types, an AD CS v1 template name and v2 template info, the AD CS
// SID extension, CRL / OCSP / CA issuer URLs and policies.
func binaryTestExtensionsCertificate(t *testing.T) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	mustMarshal := func(v any, params ...string) []byte {
		var b []byte
		var err error
		if len(params) > 0 {
			b, err = asn1.MarshalWithParams(v, params[0])
		} else {
			b, err = asn1.Marshal(v)
		}
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	ctx := func(tag int, compound bool, content []byte) []byte {
		return mustMarshal(asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: tag, IsCompound: compound, Bytes: content})
	}
	otherName := func(oid asn1.ObjectIdentifier, value []byte) []byte {
		return ctx(0, true, append(mustMarshal(oid), ctx(0, true, value)...))
	}
	seq := func(parts ...[]byte) []byte {
		var b []byte
		for _, p := range parts {
			b = append(b, p...)
		}
		return mustMarshal(asn1.RawValue{Class: asn1.ClassUniversal, Tag: asn1.TagSequence, IsCompound: true, Bytes: b})
	}
	dirName, err := asn1.Marshal(pkix.Name{CommonName: "Dir Entry", Organization: []string{"Lab"}}.ToRDNSequence())
	if err != nil {
		t.Fatal(err)
	}
	oidBytes := mustMarshal(asn1.ObjectIdentifier{1, 2, 3, 4})[2:] // content octets of the OID
	san := seq(
		ctx(2, false, []byte("dc1.ad.example.org")),
		otherName(asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 311, 25, 1}, mustMarshal([]byte("guid-bytes"))), // a non-UPN otherName (OCTET STRING)
		ctx(4, true, dirName),
		ctx(8, false, oidBytes),
		otherName(binOIDMicrosoftUPN, mustMarshal("dc1$@ad.example.org", "utf8")),
	)
	eku := seq(
		mustMarshal(asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 311, 20, 2, 2}), // Smart Card Logon first
		mustMarshal(asn1.ObjectIdentifier{1, 3, 6, 1, 5, 5, 7, 3, 2}),
		mustMarshal(asn1.ObjectIdentifier{1, 3, 6, 1, 5, 5, 7, 3, 1}),
		mustMarshal(asn1.ObjectIdentifier{1, 2, 3, 99}),
	)
	// "DomainController" as BMPString
	bmp := []byte{}
	for _, r := range "DomainController" {
		bmp = append(bmp, 0, byte(r))
	}
	templateName := mustMarshal(asn1.RawValue{Class: asn1.ClassUniversal, Tag: asn1.TagBMPString, Bytes: bmp})
	templateInfo := mustMarshal(struct {
		ID           asn1.ObjectIdentifier
		Major, Minor int
	}{asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 311, 21, 8, 1, 2}, 100, 4})
	sidExt := seq(otherName(binOIDNTDSObjectSID, mustMarshal([]byte("S-1-5-21-1-2-3-1105"))))
	policy, err := x509.ParseOID("1.3.6.1.4.1.99999.1")
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(7),
		Subject:               pkix.Name{CommonName: "Lab Issuing CA"},
		NotBefore:             time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:              time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            1,
		CRLDistributionPoints: []string{"http://pki.example.org/ca.crl"},
		OCSPServer:            []string{"http://ocsp.example.org"},
		IssuingCertificateURL: []string{"http://pki.example.org/ca.crt"},
		Policies:              []x509.OID{policy},
		ExtraExtensions: []pkix.Extension{
			{Id: binOIDSubjectAltName, Value: san},
			{Id: binOIDExtKeyUsage, Critical: true, Value: eku},
			{Id: binOIDTemplateName, Value: templateName},
			{Id: binOIDTemplateInfo, Value: templateInfo},
			{Id: binOIDNTDSCASecurityExt, Value: sidExt},
		},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func TestBinaryDescribeCertificateExtensions(t *testing.T) {
	info, err := DescribeCertificate(binaryTestExtensionsCertificate(t))
	if err != nil {
		t.Fatal(err)
	}
	var sans []string
	for _, n := range info.AltNames {
		sans = append(sans, n.Type+"="+n.Value)
	}
	want := []string{
		"DNS=dc1.ad.example.org",
		"otherName 1.3.6.1.4.1.311.25.1=guid-bytes",
		"DirName=CN=Dir Entry,O=Lab",
		"RegisteredID=1.2.3.4",
		"UPN=dc1$@ad.example.org",
	}
	if strings.Join(sans, "|") != strings.Join(want, "|") {
		t.Errorf("alt names = %q\nwant        %q", sans, want)
	}
	if got := strings.Join(info.ExtKeyUsage, ","); got != "Smart Card Logon,Client Authentication,Server Authentication,1.2.3.99" {
		t.Errorf("ext key usage (certificate order) = %s", got)
	}
	if got := strings.Join(info.ExtKeyUsageOIDs, ","); got != "1.3.6.1.4.1.311.20.2.2,1.3.6.1.5.5.7.3.2,1.3.6.1.5.5.7.3.1,1.2.3.99" {
		t.Errorf("ext key usage OIDs = %s", got)
	}
	if !info.ExtKeyUsageCritical || !info.KeyUsageCritical {
		t.Errorf("critical: eku=%v ku=%v (crypto/x509 marks key usage critical)", info.ExtKeyUsageCritical, info.KeyUsageCritical)
	}
	if info.MaxPathLen != 1 || !info.IsCA {
		t.Errorf("isCA=%v maxPathLen=%d", info.IsCA, info.MaxPathLen)
	}
	if info.Template != "DomainController" {
		t.Errorf("template = %q (the v1 name wins over the v2 OID)", info.Template)
	}
	if info.SID != "S-1-5-21-1-2-3-1105" {
		t.Errorf("sid = %q", info.SID)
	}
	if strings.Join(info.CRLDistributionPoints, ",") != "http://pki.example.org/ca.crl" ||
		strings.Join(info.OCSPServers, ",") != "http://ocsp.example.org" ||
		strings.Join(info.IssuingCertificateURLs, ",") != "http://pki.example.org/ca.crt" {
		t.Errorf("urls: crl=%v ocsp=%v aia=%v", info.CRLDistributionPoints, info.OCSPServers, info.IssuingCertificateURLs)
	}
	if strings.Join(info.PolicyOIDs, ",") != "1.3.6.1.4.1.99999.1" {
		t.Errorf("policies = %v", info.PolicyOIDs)
	}
	// The UPN is still in the flat list of the earlier summary fields.
	if strings.Join(info.UPNs, ",") != "dc1$@ad.example.org" || strings.Join(info.DNSNames, ",") != "dc1.ad.example.org" {
		t.Errorf("upns=%v dns=%v", info.UPNs, info.DNSNames)
	}
}

func TestBinaryDescribeCertificateDefaults(t *testing.T) {
	// The first test certificate: no CA, no template, empty lists (never null for the frontend).
	info, err := DescribeCertificate(binaryTestCertificate(t))
	if err != nil {
		t.Fatal(err)
	}
	if info.MaxPathLen != -1 || info.Template != "" || info.SID != "" {
		t.Errorf("maxPathLen=%d template=%q sid=%q", info.MaxPathLen, info.Template, info.SID)
	}
	if info.CRLDistributionPoints == nil || info.OCSPServers == nil || info.IssuingCertificateURLs == nil || info.PolicyOIDs == nil || info.AltNames == nil {
		t.Error("lists must be empty, not nil")
	}
	var types []string
	for _, n := range info.AltNames {
		types = append(types, n.Type)
	}
	if strings.Join(types, ",") != "UPN,DNS,Email,IP,URI" {
		t.Errorf("alt name order = %v", types)
	}
	// v2 template info only: the OID with its version.
	info2 := &models.CertificateSummary{}
	cert, _ := x509.ParseCertificate(binaryTestCertificate(t))
	cert.Extensions = append(cert.Extensions, pkix.Extension{Id: binOIDTemplateInfo, Value: func() []byte {
		b, _ := asn1.Marshal(struct {
			ID    asn1.ObjectIdentifier
			Major int
		}{asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 311, 21, 8, 9}, 100})
		return b
	}()})
	certDescribeExtensions(cert, info2)
	if info2.Template != "1.3.6.1.4.1.311.21.8.9 v100.0" {
		t.Errorf("v2 template = %q", info2.Template)
	}
}
