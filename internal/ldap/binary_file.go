package ldap

import (
	"bytes"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"image"
	_ "image/gif"  // register the GIF decoder for image.DecodeConfig
	_ "image/jpeg" // register the JPEG decoder for image.DecodeConfig
	_ "image/png"  // register the PNG decoder for image.DecodeConfig
	"strings"
	"unicode"

	goldap "github.com/go-ldap/ldap/v3"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// Binary content formats reported by DetectBinaryFormat.
const (
	BinaryFormatJPEG = "jpeg"
	BinaryFormatPNG  = "png"
	BinaryFormatGIF  = "gif"
	BinaryFormatX509 = "x509"
	// BinaryFormatPKCS7 is PKCS #7 (CMS) SignedData, e.g. S/MIME data.
	BinaryFormatPKCS7 = "pkcs7"
)

// Upload purposes of binary attributes, see BinaryUploadPurpose.
const (
	UploadPurposeJPEG        = "jpeg"        // JPEG image only (jpegPhoto)
	UploadPurposeImage       = "image"       // JPEG, PNG or GIF (thumbnailPhoto, photo)
	UploadPurposeCertificate = "certificate" // X.509 certificate, stored as DER
	UploadPurposeSMIME       = "smime"       // PKCS #7 SignedData or X.509 certificate (userSMIMECertificate)
	UploadPurposeAny         = "any"         // any bytes
)

const (
	// MaxBinaryUploadSize caps files read for upload into an attribute.
	MaxBinaryUploadSize = 10 << 20
	// binaryMaxThumbnailPhotoSize is AD's rangeUpper of thumbnailPhoto.
	binaryMaxThumbnailPhotoSize = 102400
)

// DetectBinaryFormat sniffs the content of a binary value: "jpeg", "png",
// "gif", "x509" (DER certificate), "pkcs7" (SignedData) or "" when unknown.
func DetectBinaryFormat(data []byte) string {
	switch {
	case bytes.HasPrefix(data, []byte{0xFF, 0xD8, 0xFF}):
		return BinaryFormatJPEG
	case bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")):
		return BinaryFormatPNG
	case bytes.HasPrefix(data, []byte("GIF87a")), bytes.HasPrefix(data, []byte("GIF89a")):
		return BinaryFormatGIF
	}
	// A DER certificate and PKCS #7 start with a SEQUENCE (0x30); parse only those.
	if len(data) > 0 && data[0] == 0x30 {
		if _, err := x509.ParseCertificate(data); err == nil {
			return BinaryFormatX509
		}
		if IsPKCS7SignedData(data) {
			return BinaryFormatPKCS7
		}
	}
	return ""
}

// binaryFormatLabel describes a detected format for error messages.
func binaryFormatLabel(format string) string {
	switch format {
	case BinaryFormatJPEG:
		return "a JPEG image"
	case BinaryFormatPNG:
		return "a PNG image"
	case BinaryFormatGIF:
		return "a GIF image"
	case BinaryFormatX509:
		return "an X.509 certificate"
	case BinaryFormatPKCS7:
		return "PKCS #7 SignedData"
	}
	return "of an unknown format"
}

// isBinaryCertificateAttribute reports whether the attribute holds X.509
// certificates (options such as ;binary are ignored). userSMIMECertificate
// is not one of them: it holds PKCS #7 SignedData, see isBinarySMIMEAttribute.
func isBinaryCertificateAttribute(name string) bool {
	switch strings.ToLower(attrBaseName(name)) {
	case "usercertificate", "cacertificate":
		return true
	}
	return false
}

// isBinarySMIMEAttribute reports whether the attribute is userSMIMECertificate,
// which RFC 2798 defines as PKCS #7 SignedData.
func isBinarySMIMEAttribute(name string) bool {
	return strings.EqualFold(attrBaseName(name), "userSMIMECertificate")
}

// BinaryUploadPurpose returns what a file uploaded into the attribute must
// contain: UploadPurposeJPEG for jpegPhoto, UploadPurposeImage for other
// photo attributes, UploadPurposeCertificate for certificate attributes,
// UploadPurposeSMIME for userSMIMECertificate and UploadPurposeAny otherwise.
func BinaryUploadPurpose(attribute string) string {
	switch strings.ToLower(attrBaseName(attribute)) {
	case "jpegphoto":
		return UploadPurposeJPEG
	case "thumbnailphoto", "thumbnaillogo", "photo":
		return UploadPurposeImage
	}
	if isBinaryCertificateAttribute(attribute) {
		return UploadPurposeCertificate
	}
	if isBinarySMIMEAttribute(attribute) {
		return UploadPurposeSMIME
	}
	return UploadPurposeAny
}

// BinaryUploadLimit returns the maximum size in bytes of a value uploaded
// into the attribute.
func BinaryUploadLimit(attribute string) int {
	if strings.EqualFold(attrBaseName(attribute), "thumbnailPhoto") {
		return binaryMaxThumbnailPhotoSize
	}
	return MaxBinaryUploadSize
}

// PrepareBinaryUpload validates file content for the attribute and returns
// the value to store: images must have a format the attribute accepts,
// certificates are accepted as DER or PEM and stored as DER, and
// userSMIMECertificate takes PKCS #7 SignedData (BER/DER or PEM, stored
// binary) or an X.509 certificate.
func PrepareBinaryUpload(attribute, fileName string, data []byte) (*models.BinaryFile, error) {
	if len(data) == 0 {
		return nil, fmt.Errorf("%s is empty", fileName)
	}
	value := data
	format := DetectBinaryFormat(data)
	note := ""

	switch BinaryUploadPurpose(attribute) {
	case UploadPurposeJPEG:
		if format != BinaryFormatJPEG {
			return nil, fmt.Errorf("%s needs a JPEG image, but %s is %s", attribute, fileName, binaryFormatLabel(format))
		}
	case UploadPurposeImage:
		if format != BinaryFormatJPEG && format != BinaryFormatPNG && format != BinaryFormatGIF {
			return nil, fmt.Errorf("%s needs a JPEG, PNG or GIF image, but %s is %s", attribute, fileName, binaryFormatLabel(format))
		}
	case UploadPurposeCertificate:
		if format != BinaryFormatX509 {
			_, der, err := ParseCertificateValue(data)
			if err != nil {
				return nil, fmt.Errorf("%s needs an X.509 certificate (DER or PEM): %s is %s", attribute, fileName, binaryFormatLabel(format))
			}
			value, format, note = der, BinaryFormatX509, "converted from PEM to DER"
		}
	case UploadPurposeSMIME:
		if format != BinaryFormatPKCS7 && format != BinaryFormatX509 {
			if ber, err := ParsePKCS7Value(data); err == nil {
				value, format, note = ber, BinaryFormatPKCS7, "converted from PEM"
			} else if _, der, err := ParseCertificateValue(data); err == nil {
				value, format, note = der, BinaryFormatX509, "converted from PEM to DER"
			} else {
				return nil, fmt.Errorf("%s needs PKCS #7 S/MIME data or an X.509 certificate (DER or PEM): %s is %s", attribute, fileName, binaryFormatLabel(format))
			}
		}
	}

	if limit := BinaryUploadLimit(attribute); len(value) > limit {
		return nil, fmt.Errorf("%s is %s, %s allows at most %s", fileName, binaryFormatSize(len(value)), attribute, binaryFormatSize(limit))
	}

	file := &models.BinaryFile{
		Name:   fileName,
		Size:   len(value),
		Data:   base64.StdEncoding.EncodeToString(value),
		Format: format,
		Note:   note,
	}
	switch format {
	case BinaryFormatJPEG, BinaryFormatPNG, BinaryFormatGIF:
		cfg, _, err := image.DecodeConfig(bytes.NewReader(value))
		if err != nil {
			return nil, fmt.Errorf("%s is not a valid image: %v", fileName, err)
		}
		file.Width, file.Height = cfg.Width, cfg.Height
	}
	return file, nil
}

// binaryFormatSize renders a byte count for messages ("812 bytes", "97.7 KiB").
func binaryFormatSize(n int) string {
	switch {
	case n < 1024:
		return fmt.Sprintf("%d bytes", n)
	case n < 1<<20:
		return fmt.Sprintf("%.1f KiB", float64(n)/1024)
	default:
		return fmt.Sprintf("%.1f MiB", float64(n)/(1<<20))
	}
}

// BinaryFileExtension returns the file extension (without dot) for a value
// of the attribute with the given content.
func BinaryFileExtension(attribute string, data []byte) string {
	switch DetectBinaryFormat(data) {
	case BinaryFormatJPEG:
		return "jpg"
	case BinaryFormatPNG:
		return "png"
	case BinaryFormatGIF:
		return "gif"
	case BinaryFormatX509:
		return "cer"
	case BinaryFormatPKCS7:
		return "p7b"
	}
	if isBinarySMIMEAttribute(attribute) {
		return "p7b"
	}
	if isBinaryCertificateAttribute(attribute) {
		return "cer"
	}
	return "bin"
}

// BinaryFileName proposes a file name for saving a value of attribute of
// the entry dn: "<RDN value>-<attribute>.<ext>", e.g. "jdoe-jpegPhoto.jpg".
// Characters that are not allowed in file names are replaced by "_".
func BinaryFileName(dn, attribute string, data []byte) string {
	base := binaryRDNValue(dn)
	attr := attrBaseName(attribute)
	name := attr
	if base != "" {
		name = base + "-" + attr
	}
	name = binarySanitizeFileName(name)
	if name == "" {
		name = "value"
	}
	return name + "." + BinaryFileExtension(attribute, data)
}

// binaryRDNValue returns the (unescaped) value of the first RDN of dn, or "".
func binaryRDNValue(dn string) string {
	if parsed, err := goldap.ParseDN(dn); err == nil && len(parsed.RDNs) > 0 && len(parsed.RDNs[0].Attributes) > 0 {
		return parsed.RDNs[0].Attributes[0].Value
	}
	first := strings.SplitN(dn, ",", 2)[0]
	if i := strings.IndexByte(first, '='); i >= 0 {
		return first[i+1:]
	}
	return first
}

// binarySanitizeFileName replaces characters that are invalid in Windows, macOS
// or Linux file names and limits the length to 80 runes.
func binarySanitizeFileName(s string) string {
	var b strings.Builder
	n := 0
	for _, r := range s {
		if n == 80 {
			break
		}
		switch {
		case unicode.IsLetter(r), unicode.IsDigit(r), r == '-', r == '_', r == '.', r == ' ':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
		n++
	}
	return strings.Trim(b.String(), " .")
}
