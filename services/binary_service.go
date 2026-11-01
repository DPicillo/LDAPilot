package services

import (
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// Binary attribute support: certificate summaries, saving values to files and
// reading files for upload. Writing an uploaded value goes through
// EditorService.ModifyEntry (Binary: true), so read-only enforcement and the
// audit log apply as for every other change.

// DescribeCertificate summarizes an X.509 certificate value. value is the
// base64 form of a binary attribute value (DER); PEM text is accepted too.
func (s *EditorService) DescribeCertificate(value string) (*models.CertificateSummary, error) {
	return describeBinaryCertificateValue(value)
}

func describeBinaryCertificateValue(value string) (*models.CertificateSummary, error) {
	data, err := decodeBinaryDescribeInput(value, "certificate")
	if err != nil {
		return nil, err
	}
	return ldap.DescribeCertificate(data)
}

// DescribePKCS7 summarizes PKCS #7 (CMS) SignedData such as a
// userSMIMECertificate value: embedded certificates, signers. value is the
// base64 form of the binary value (BER/DER); PEM text is accepted too.
func (s *EditorService) DescribePKCS7(value string) (*models.PKCS7Summary, error) {
	return describeBinaryPKCS7Value(value)
}

func describeBinaryPKCS7Value(value string) (*models.PKCS7Summary, error) {
	data, err := decodeBinaryDescribeInput(value, "PKCS #7")
	if err != nil {
		return nil, err
	}
	return ldap.DescribePKCS7(data)
}

// decodeBinaryDescribeInput returns the bytes of a base64 binary value, or
// the text itself if it is PEM.
func decodeBinaryDescribeInput(value, what string) ([]byte, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, fmt.Errorf("no %s value", what)
	}
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		if !strings.Contains(value, "-----BEGIN") {
			return nil, fmt.Errorf("%s value is neither base64 nor PEM: %v", what, err)
		}
		data = []byte(value)
	}
	return data, nil
}

// SaveBinaryValue asks for a file name and writes one binary attribute value
// (base64, see models.LDAPAttribute) to it as raw bytes. The proposed name is
// derived from the entry's RDN, the attribute and the content, e.g.
// "jdoe-jpegPhoto.jpg". It returns the path written, or "" when the user
// cancelled the dialog.
func (s *ExportService) SaveBinaryValue(dn string, attribute string, value string) (string, error) {
	data, err := decodeBinaryAttributeValue(attribute, value)
	if err != nil {
		return "", err
	}
	name := ldap.BinaryFileName(dn, attribute, data)
	ext := filepath.Ext(name)
	filePath, err := runtime.SaveFileDialog(s.ctx, runtime.SaveDialogOptions{
		Title:                "Save " + attribute + " value",
		DefaultFilename:      name,
		CanCreateDirectories: true,
		Filters: []runtime.FileFilter{
			{DisplayName: fmt.Sprintf("%s (*%s)", binaryFileTypeName(ext), ext), Pattern: "*" + ext},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return "", fmt.Errorf("save dialog failed: %w", err)
	}
	if filePath == "" {
		return "", nil
	}
	if err := os.WriteFile(filePath, data, 0600); err != nil {
		return "", fmt.Errorf("failed to write file: %w", err)
	}
	return filePath, nil
}

// decodeBinaryAttributeValue returns the raw bytes of a binary attribute value.
func decodeBinaryAttributeValue(attribute, value string) ([]byte, error) {
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return nil, fmt.Errorf("value of %s is not valid base64: %v", attribute, err)
	}
	return data, nil
}

// OpenBinaryFile asks for a file to upload into the binary attribute and
// returns its content prepared for ModifyEntry (Binary: true): jpegPhoto
// needs a JPEG, thumbnailPhoto/photo a JPEG, PNG or GIF (thumbnailPhoto at
// most 100 KiB), certificate attributes an X.509 certificate (PEM is
// converted to DER), userSMIMECertificate PKCS #7 SignedData or an X.509
// certificate; files above 10 MiB are refused. It is refused on
// read-only connections before the dialog opens and returns nil when the
// user cancelled.
func (s *ExportService) OpenBinaryFile(profileID string, attribute string) (*models.BinaryFile, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	if err := client.CheckWritable(); err != nil {
		return nil, err
	}
	filePath, err := runtime.OpenFileDialog(s.ctx, runtime.OpenDialogOptions{
		Title:   "Upload " + attribute + " value",
		Filters: binaryUploadFileFilters(ldap.BinaryUploadPurpose(attribute)),
	})
	if err != nil {
		return nil, fmt.Errorf("open dialog failed: %w", err)
	}
	if filePath == "" {
		return nil, nil
	}
	return readBinaryUploadFile(filePath, attribute)
}

// readBinaryUploadFile reads a file of at most ldap.MaxBinaryUploadSize bytes
// and validates it for the attribute.
func readBinaryUploadFile(filePath, attribute string) (*models.BinaryFile, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to open file: %w", err)
	}
	defer f.Close()
	name := filepath.Base(filePath)
	if info, err := f.Stat(); err == nil && !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", name)
	}
	data, err := io.ReadAll(io.LimitReader(f, ldap.MaxBinaryUploadSize+1))
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}
	if len(data) > ldap.MaxBinaryUploadSize {
		return nil, fmt.Errorf("%s is larger than %d MiB", name, ldap.MaxBinaryUploadSize>>20)
	}
	return ldap.PrepareBinaryUpload(attribute, name, data)
}

// binaryUploadFileFilters returns the file dialog filters for an upload purpose.
func binaryUploadFileFilters(purpose string) []runtime.FileFilter {
	all := runtime.FileFilter{DisplayName: "All Files (*.*)", Pattern: "*.*"}
	switch purpose {
	case ldap.UploadPurposeJPEG:
		return []runtime.FileFilter{{DisplayName: "JPEG Images (*.jpg, *.jpeg)", Pattern: "*.jpg;*.jpeg;*.JPG;*.JPEG"}, all}
	case ldap.UploadPurposeImage:
		return []runtime.FileFilter{{DisplayName: "Images (*.jpg, *.png, *.gif)", Pattern: "*.jpg;*.jpeg;*.png;*.gif;*.JPG;*.JPEG;*.PNG;*.GIF"}, all}
	case ldap.UploadPurposeCertificate:
		return []runtime.FileFilter{{DisplayName: "Certificates (*.cer, *.crt, *.der, *.pem)", Pattern: "*.cer;*.crt;*.der;*.pem;*.CER;*.CRT;*.DER;*.PEM"}, all}
	case ldap.UploadPurposeSMIME:
		return []runtime.FileFilter{{
			DisplayName: "S/MIME data and certificates (*.p7b, *.p7c, *.p7s, *.cer, *.crt, *.der, *.pem)",
			Pattern:     "*.p7b;*.p7c;*.p7s;*.cer;*.crt;*.der;*.pem;*.P7B;*.P7C;*.P7S;*.CER;*.CRT;*.DER;*.PEM",
		}, all}
	}
	return []runtime.FileFilter{all}
}

// binaryFileTypeName names the file type of an extension for the save dialog.
func binaryFileTypeName(ext string) string {
	switch strings.ToLower(ext) {
	case ".jpg":
		return "JPEG Image"
	case ".png":
		return "PNG Image"
	case ".gif":
		return "GIF Image"
	case ".cer":
		return "DER Certificate"
	case ".p7b":
		return "PKCS #7 Data"
	}
	return "Binary File"
}
