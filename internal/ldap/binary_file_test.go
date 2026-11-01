package ldap

import (
	"bytes"
	"encoding/base64"
	"encoding/pem"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"
)

func binaryTestImage(t *testing.T, format string, w, h int) []byte {
	t.Helper()
	img := image.NewPaletted(image.Rect(0, 0, w, h), color.Palette{color.Black, color.White})
	var buf bytes.Buffer
	var err error
	switch format {
	case "jpeg":
		err = jpeg.Encode(&buf, img, nil)
	case "png":
		err = png.Encode(&buf, img)
	case "gif":
		err = gif.Encode(&buf, img, nil)
	}
	if err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestBinaryDetectBinaryFormat(t *testing.T) {
	cases := map[string][]byte{
		BinaryFormatJPEG: binaryTestImage(t, "jpeg", 2, 2),
		BinaryFormatPNG:  binaryTestImage(t, "png", 2, 2),
		BinaryFormatGIF:  binaryTestImage(t, "gif", 2, 2),
		BinaryFormatX509: binaryTestCertificate(t),
		"":               {0x01, 0x05, 0x00, 0x00, 0x30},
	}
	for want, data := range cases {
		if got := DetectBinaryFormat(data); got != want {
			t.Errorf("DetectBinaryFormat(%x...) = %q, want %q", data[:4], got, want)
		}
	}
	if got := DetectBinaryFormat([]byte{0x30, 0x03, 0x02, 0x01, 0x01}); got != "" {
		t.Errorf("non-certificate SEQUENCE detected as %q", got)
	}
	if got := DetectBinaryFormat(nil); got != "" {
		t.Errorf("empty = %q", got)
	}
}

func TestBinaryUploadPurposeAndLimit(t *testing.T) {
	cases := map[string]string{
		"jpegPhoto":              UploadPurposeJPEG,
		"thumbnailPhoto":         UploadPurposeImage,
		"photo":                  UploadPurposeImage,
		"userCertificate;binary": UploadPurposeCertificate,
		"cACertificate":          UploadPurposeCertificate,
		"userSMIMECertificate":   UploadPurposeSMIME,
		"nTSecurityDescriptor":   UploadPurposeAny,
		"audio":                  UploadPurposeAny,
	}
	for attr, want := range cases {
		if got := BinaryUploadPurpose(attr); got != want {
			t.Errorf("BinaryUploadPurpose(%q) = %q, want %q", attr, got, want)
		}
	}
	if BinaryUploadLimit("thumbnailphoto") != 102400 || BinaryUploadLimit("jpegPhoto") != MaxBinaryUploadSize {
		t.Error("unexpected upload limits")
	}
}

func TestBinaryPrepareBinaryUpload(t *testing.T) {
	jpg := binaryTestImage(t, "jpeg", 3, 2)
	pngData := binaryTestImage(t, "png", 4, 5)
	der := binaryTestCertificate(t)

	f, err := PrepareBinaryUpload("jpegPhoto", "me.jpg", jpg)
	if err != nil {
		t.Fatal(err)
	}
	if f.Format != BinaryFormatJPEG || f.Width != 3 || f.Height != 2 || f.Size != len(jpg) || f.Name != "me.jpg" {
		t.Errorf("jpeg upload = %+v", f)
	}
	if raw, _ := base64.StdEncoding.DecodeString(f.Data); !bytes.Equal(raw, jpg) {
		t.Error("jpeg data changed")
	}

	if _, err := PrepareBinaryUpload("jpegPhoto", "me.png", pngData); err == nil || !strings.Contains(err.Error(), "needs a JPEG image, but me.png is a PNG image") {
		t.Errorf("png as jpegPhoto: %v", err)
	}
	if f, err := PrepareBinaryUpload("thumbnailPhoto", "me.png", pngData); err != nil || f.Width != 4 || f.Height != 5 {
		t.Errorf("png as thumbnailPhoto: %+v %v", f, err)
	}
	if _, err := PrepareBinaryUpload("thumbnailPhoto", "doc.txt", []byte("hello")); err == nil || !strings.Contains(err.Error(), "unknown format") {
		t.Errorf("text as thumbnailPhoto: %v", err)
	}
	// Truncated JPEG: the magic matches, the header does not decode.
	if _, err := PrepareBinaryUpload("jpegPhoto", "broken.jpg", jpg[:4]); err == nil || !strings.Contains(err.Error(), "not a valid image") {
		t.Errorf("truncated jpeg: %v", err)
	}
	big := append([]byte{}, jpg...)
	big = append(big, make([]byte, 102400)...)
	if _, err := PrepareBinaryUpload("thumbnailPhoto", "big.jpg", big); err == nil || !strings.Contains(err.Error(), "allows at most 100.0 KiB") {
		t.Errorf("oversized thumbnailPhoto: %v", err)
	}
	if _, err := PrepareBinaryUpload("jpegPhoto", "empty.jpg", nil); err == nil {
		t.Error("empty file accepted")
	}

	// Certificates: DER as is, PEM converted to DER.
	if f, err := PrepareBinaryUpload("userCertificate", "c.cer", der); err != nil || f.Format != BinaryFormatX509 || f.Note != "" || f.Size != len(der) {
		t.Errorf("der: %+v %v", f, err)
	}
	pemData := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	f, err = PrepareBinaryUpload("userCertificate;binary", "c.pem", pemData)
	if err != nil {
		t.Fatal(err)
	}
	if raw, _ := base64.StdEncoding.DecodeString(f.Data); !bytes.Equal(raw, der) || f.Note == "" || f.Size != len(der) {
		t.Errorf("pem not converted to DER: %+v", f)
	}
	if _, err := PrepareBinaryUpload("userCertificate", "me.jpg", jpg); err == nil || !strings.Contains(err.Error(), "needs an X.509 certificate") {
		t.Errorf("jpeg as certificate: %v", err)
	}

	// Anything goes for other attributes.
	if f, err := PrepareBinaryUpload("audio", "a.bin", []byte{0, 1, 2}); err != nil || f.Format != "" || f.Data != "AAEC" {
		t.Errorf("any: %+v %v", f, err)
	}
}

func TestBinaryFileName(t *testing.T) {
	jpg := []byte{0xFF, 0xD8, 0xFF, 0xE0}
	cases := []struct {
		dn, attr string
		data     []byte
		want     string
	}{
		{"uid=jdoe,ou=People,dc=example,dc=org", "jpegPhoto", jpg, "jdoe-jpegPhoto.jpg"},
		{`CN=Schmidt\, Anna,OU=Users,DC=ad`, "thumbnailPhoto", jpg, "Schmidt_ Anna-thumbnailPhoto.jpg"},
		{"CN=Jürgen Weiß,OU=Users", "userCertificate;binary", []byte{1, 2}, "Jürgen Weiß-userCertificate.cer"},
		{`CN=Semi;Colon <Angle>,DC=x`, "nTSecurityDescriptor", []byte{1}, "Semi_Colon _Angle_-nTSecurityDescriptor.bin"},
		{"", "audio", []byte{1}, "audio.bin"},
		{"cn=../../etc/passwd,dc=x", "photo", []byte("GIF89a"), "_.._etc_passwd-photo.gif"},
	}
	for _, c := range cases {
		if got := BinaryFileName(c.dn, c.attr, c.data); got != c.want {
			t.Errorf("BinaryFileName(%q, %q) = %q, want %q", c.dn, c.attr, got, c.want)
		}
	}
}
