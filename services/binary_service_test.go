package services

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ldap"
)

func binarySelfSignedDER(t *testing.T) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(42),
		Subject:      pkix.Name{CommonName: "svc test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func TestBinaryDescribeCertificateValue(t *testing.T) {
	der := binarySelfSignedDER(t)
	info, err := describeBinaryCertificateValue(base64.StdEncoding.EncodeToString(der))
	if err != nil || info.Subject != "CN=svc test" || info.SerialNumber != "2A" {
		t.Fatalf("base64 DER: %+v %v", info, err)
	}
	pemText := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	if info, err := describeBinaryCertificateValue(pemText); err != nil || info.Size != len(der) {
		t.Fatalf("PEM text: %+v %v", info, err)
	}
	if _, err := describeBinaryCertificateValue(""); err == nil {
		t.Error("empty value accepted")
	}
	if _, err := describeBinaryCertificateValue("%%%"); err == nil || !strings.Contains(err.Error(), "neither base64 nor PEM") {
		t.Errorf("garbage: %v", err)
	}
	if _, err := describeBinaryCertificateValue(base64.StdEncoding.EncodeToString([]byte("hello"))); err == nil {
		t.Error("non-certificate accepted")
	}
}

func TestBinaryReadBinaryUpload(t *testing.T) {
	dir := t.TempDir()
	der := binarySelfSignedDER(t)
	pemPath := filepath.Join(dir, "user.pem")
	if err := os.WriteFile(pemPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	f, err := readBinaryUploadFile(pemPath, "userCertificate")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := base64.StdEncoding.DecodeString(f.Data)
	if f.Name != "user.pem" || !bytes.Equal(raw, der) || f.Format != ldap.BinaryFormatX509 {
		t.Errorf("upload = %+v", f)
	}

	bigPath := filepath.Join(dir, "big.bin")
	if err := os.WriteFile(bigPath, make([]byte, ldap.MaxBinaryUploadSize+1), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readBinaryUploadFile(bigPath, "audio"); err == nil || !strings.Contains(err.Error(), "larger than 10 MiB") {
		t.Errorf("oversized file: %v", err)
	}
	if _, err := readBinaryUploadFile(dir, "audio"); err == nil {
		t.Error("directory accepted")
	}
	if _, err := readBinaryUploadFile(filepath.Join(dir, "missing"), "audio"); err == nil {
		t.Error("missing file accepted")
	}
}

func TestBinaryDescribePKCS7Value(t *testing.T) {
	der := binarySelfSignedDER(t)
	// Degenerate certs-only SignedData (openssl crl2pkcs7): version 1, no
	// digest algorithms, data content type, one certificate, no signers.
	oidSD := []byte{0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x02}
	oidData := []byte{0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x01}
	tlv := func(tag byte, content ...[]byte) []byte {
		body := bytes.Join(content, nil)
		n := len(body)
		var hdr []byte
		switch {
		case n < 0x80:
			hdr = []byte{tag, byte(n)}
		case n < 0x100:
			hdr = []byte{tag, 0x81, byte(n)}
		default:
			hdr = []byte{tag, 0x82, byte(n >> 8), byte(n)}
		}
		return append(hdr, body...)
	}
	signedData := tlv(0x30, []byte{0x02, 0x01, 0x01}, tlv(0x31), tlv(0x30, oidData), tlv(0xA0, der), tlv(0x31))
	p7 := tlv(0x30, oidSD, tlv(0xA0, signedData))

	s, err := describeBinaryPKCS7Value(base64.StdEncoding.EncodeToString(p7))
	if err != nil || len(s.Certificates) != 1 || s.Certificates[0].Subject != "CN=svc test" || s.Size != len(p7) {
		t.Fatalf("base64 PKCS #7: %+v %v", s, err)
	}
	pemText := string(pem.EncodeToMemory(&pem.Block{Type: "PKCS7", Bytes: p7}))
	if s, err := describeBinaryPKCS7Value(pemText); err != nil || len(s.Certificates) != 1 {
		t.Fatalf("PEM PKCS #7: %+v %v", s, err)
	}
	if _, err := describeBinaryPKCS7Value(base64.StdEncoding.EncodeToString(der)); err == nil {
		t.Error("certificate accepted as PKCS #7")
	}
	if _, err := describeBinaryPKCS7Value(" "); err == nil {
		t.Error("empty value accepted")
	}
	if f := binaryUploadFileFilters(ldap.UploadPurposeSMIME); len(f) != 2 || !strings.Contains(f[0].Pattern, "*.p7b") {
		t.Errorf("S/MIME filters = %+v", f)
	}
	if got := binaryFileTypeName(".p7b"); got != "PKCS #7 Data" {
		t.Errorf("binaryFileTypeName(.p7b) = %q", got)
	}
}
