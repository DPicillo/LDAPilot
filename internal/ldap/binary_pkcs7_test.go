package ldap

import (
	"bytes"
	"encoding/asn1"
	"encoding/base64"
	"encoding/pem"
	"strings"
	"testing"
)

var (
	binaryTestOIDSignedData = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 2}
	binaryTestOIDData       = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 1}
)

// binaryTestPKCS7 builds a DER "certs-only" PKCS #7 SignedData (the shape of
// openssl crl2pkcs7 output) holding the given certificates and no signers.
func binaryTestPKCS7(t *testing.T, certs ...[]byte) []byte {
	t.Helper()
	mustMarshal := func(v any) []byte {
		b, err := asn1.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	version := mustMarshal(1)
	digestAlgs := mustMarshal(asn1.RawValue{Class: asn1.ClassUniversal, Tag: asn1.TagSet, IsCompound: true})
	encap := mustMarshal(asn1.RawValue{Class: asn1.ClassUniversal, Tag: asn1.TagSequence, IsCompound: true, Bytes: mustMarshal(binaryTestOIDData)})
	certSet := mustMarshal(asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 0, IsCompound: true, Bytes: bytes.Join(certs, nil)})
	signers := mustMarshal(asn1.RawValue{Class: asn1.ClassUniversal, Tag: asn1.TagSet, IsCompound: true})
	signedData := mustMarshal(asn1.RawValue{Class: asn1.ClassUniversal, Tag: asn1.TagSequence, IsCompound: true,
		Bytes: bytes.Join([][]byte{version, digestAlgs, encap, certSet, signers}, nil)})
	content := mustMarshal(asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 0, IsCompound: true, Bytes: signedData})
	return mustMarshal(asn1.RawValue{Class: asn1.ClassUniversal, Tag: asn1.TagSequence, IsCompound: true,
		Bytes: append(mustMarshal(binaryTestOIDSignedData), content...)})
}

// binaryTestPKCS7Indefinite builds the same structure with indefinite
// lengths on every constructed layer around the certificates (BER, as
// streaming CMS encoders write it) and one signer.
func binaryTestPKCS7Indefinite(t *testing.T, cert []byte) []byte {
	t.Helper()
	oidSD, _ := asn1.Marshal(binaryTestOIDSignedData)
	oidData, _ := asn1.Marshal(binaryTestOIDData)
	var b bytes.Buffer
	b.Write([]byte{0x30, 0x80}) // ContentInfo
	b.Write(oidSD)
	b.Write([]byte{0xA0, 0x80})                   // [0] EXPLICIT
	b.Write([]byte{0x30, 0x80})                   // SignedData
	b.Write([]byte{0x02, 0x01, 0x01})             // version 1
	b.Write([]byte{0x31, 0x00})                   // digestAlgorithms
	b.Write([]byte{0x30, 0x80})                   // encapContentInfo
	b.Write(oidData)                              //
	b.Write([]byte{0xA0, 0x80, 0x24, 0x80})       // [0] EXPLICIT OCTET STRING (constructed)
	b.Write([]byte{0x04, 0x02, 'h', 'i', 0, 0})   // one chunk, end of OCTET STRING
	b.Write([]byte{0, 0, 0, 0})                   // end of [0], end of encapContentInfo
	b.Write([]byte{0xA0, 0x80})                   // certificates [0] IMPLICIT
	b.Write(cert)                                 //
	b.Write([]byte{0, 0})                         //
	b.Write([]byte{0x31, 0x80, 0x30, 0x00, 0, 0}) // signerInfos with one (empty) SignerInfo
	b.Write([]byte{0, 0, 0, 0, 0, 0})             // end of SignedData, [0], ContentInfo
	return b.Bytes()
}

func TestBinaryPKCS7Detection(t *testing.T) {
	cert := binaryTestCertificate(t)
	der := binaryTestPKCS7(t, cert)
	ber := binaryTestPKCS7Indefinite(t, cert)
	if !IsPKCS7SignedData(der) || !IsPKCS7SignedData(ber) {
		t.Fatal("PKCS #7 not detected")
	}
	if IsPKCS7SignedData(cert) || IsPKCS7SignedData([]byte{0x30, 0x03, 0x02, 0x01, 0x01}) || IsPKCS7SignedData(nil) {
		t.Error("non-PKCS #7 data detected as PKCS #7")
	}
	if got := DetectBinaryFormat(der); got != BinaryFormatPKCS7 {
		t.Errorf("DetectBinaryFormat(pkcs7) = %q", got)
	}
	if got := DetectBinaryFormat(ber); got != BinaryFormatPKCS7 {
		t.Errorf("DetectBinaryFormat(BER pkcs7) = %q", got)
	}
	if got := DetectBinaryFormat(cert); got != BinaryFormatX509 {
		t.Errorf("DetectBinaryFormat(cert) = %q", got)
	}
	// Every truncation is rejected without a panic.
	for _, data := range [][]byte{der, ber} {
		for i := 0; i < len(data); i++ {
			if IsPKCS7SignedData(data[:i]) {
				t.Fatalf("truncated PKCS #7 (%d of %d bytes) accepted", i, len(data))
			}
			_, _ = DescribePKCS7(data[:i])
		}
	}
}

func TestBinaryDescribePKCS7(t *testing.T) {
	cert := binaryTestCertificate(t)
	other := binaryTestCertificate(t)
	s, err := DescribePKCS7(binaryTestPKCS7(t, cert, other))
	if err != nil {
		t.Fatal(err)
	}
	if s.ContentType != "signedData" || s.Version != 1 || len(s.Certificates) != 2 || s.SignerCount != 0 ||
		s.EncapsulatedContentType != "1.2.840.113549.1.7.1" || !s.Detached || s.OtherCertificates != 0 {
		t.Errorf("summary = %+v", s)
	}
	if s.Certificates[0].Subject != "CN=John Doe,O=Example" || s.Certificates[0].DER != base64.StdEncoding.EncodeToString(cert) {
		t.Errorf("first certificate = %+v", s.Certificates[0])
	}

	ber := binaryTestPKCS7Indefinite(t, cert)
	s, err = DescribePKCS7(ber)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Certificates) != 1 || s.SignerCount != 1 || s.Detached || s.Size != len(ber) {
		t.Errorf("BER summary = %+v", s)
	}

	// PEM as written by openssl crl2pkcs7.
	pemData := pem.EncodeToMemory(&pem.Block{Type: "PKCS7", Bytes: binaryTestPKCS7(t, cert)})
	if s, err := DescribePKCS7(pemData); err != nil || len(s.Certificates) != 1 {
		t.Errorf("PEM: %+v %v", s, err)
	}
	if _, err := DescribePKCS7(cert); err == nil {
		t.Error("certificate described as PKCS #7")
	}
}

func TestBinarySMIMEUpload(t *testing.T) {
	cert := binaryTestCertificate(t)
	p7 := binaryTestPKCS7(t, cert)

	f, err := PrepareBinaryUpload("userSMIMECertificate", "c.p7b", p7)
	if err != nil {
		t.Fatal(err)
	}
	if f.Format != BinaryFormatPKCS7 || f.Note != "" || f.Data != base64.StdEncoding.EncodeToString(p7) {
		t.Errorf("DER PKCS #7 upload = %+v", f)
	}
	ber := binaryTestPKCS7Indefinite(t, cert)
	if f, err := PrepareBinaryUpload("userSMIMECertificate", "c.p7s", ber); err != nil || f.Size != len(ber) {
		t.Errorf("BER PKCS #7 upload = %+v %v", f, err)
	}
	pemData := pem.EncodeToMemory(&pem.Block{Type: "PKCS7", Bytes: p7})
	if f, err := PrepareBinaryUpload("userSMIMECertificate", "c.pem", pemData); err != nil || f.Format != BinaryFormatPKCS7 || f.Size != len(p7) || f.Note == "" {
		t.Errorf("PEM PKCS #7 upload = %+v %v", f, err)
	}
	// A plain certificate is accepted too (DER, or PEM converted to DER).
	if f, err := PrepareBinaryUpload("userSMIMECertificate", "c.cer", cert); err != nil || f.Format != BinaryFormatX509 {
		t.Errorf("certificate upload = %+v %v", f, err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert})
	if f, err := PrepareBinaryUpload("userSMIMECertificate", "c.crt", certPEM); err != nil || f.Format != BinaryFormatX509 || f.Size != len(cert) {
		t.Errorf("PEM certificate upload = %+v %v", f, err)
	}
	if _, err := PrepareBinaryUpload("userSMIMECertificate", "x.txt", []byte("hello")); err == nil || !strings.Contains(err.Error(), "needs PKCS #7 S/MIME data or an X.509 certificate") {
		t.Errorf("text as S/MIME data: %v", err)
	}
	// userCertificate still takes certificates only.
	if _, err := PrepareBinaryUpload("userCertificate", "c.p7b", p7); err == nil {
		t.Error("PKCS #7 accepted for userCertificate")
	}

	if got := BinaryFileExtension("userSMIMECertificate", p7); got != "p7b" {
		t.Errorf("extension of PKCS #7 = %q", got)
	}
	if got := BinaryFileExtension("userSMIMECertificate", []byte{1, 2}); got != "p7b" {
		t.Errorf("extension of unknown S/MIME data = %q", got)
	}
	if got := BinaryFileExtension("userSMIMECertificate", cert); got != "cer" {
		t.Errorf("extension of S/MIME certificate = %q", got)
	}
	if got := BinaryFileExtension("userCertificate", []byte{1, 2}); got != "cer" {
		t.Errorf("extension of unknown certificate data = %q", got)
	}
}

func TestBinaryOIDString(t *testing.T) {
	for want, oid := range map[string]asn1.ObjectIdentifier{
		"1.2.840.113549.1.7.1":    binaryTestOIDData,
		"2.5.29.17":               {2, 5, 29, 17},
		"1.3.6.1.4.1.311.20.2.3":  {1, 3, 6, 1, 4, 1, 311, 20, 2, 3},
		"2.999.1":                 {2, 999, 1},
		"0.9.2342.19200300.100.1": {0, 9, 2342, 19200300, 100, 1},
	} {
		der, _ := asn1.Marshal(oid)
		if got := binaryOIDString(der[2:]); got != want {
			t.Errorf("binaryOIDString(%v) = %q", oid, got)
		}
	}
	if got := binaryOIDString([]byte{0x2A, 0x86}); got != "" {
		t.Errorf("truncated OID = %q", got)
	}
}
