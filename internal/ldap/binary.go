package ldap

import (
	"encoding/base64"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// Binary values cross the Go/JSON boundary as standard base64 (RFC 4648
// StdEncoding, padded): models.LDAPAttribute.Binary and
// models.AttributeChange.Binary mean that every value is the base64 encoding
// of the raw bytes. convertEntry produces this form, rawValues reverses it
// for every write.

// knownBinaryAttributes lists lowercase attribute names whose values are
// always passed on as binary, even if they happen to look like text.
// Attributes with a formatter in knownBinaryFormatters (objectGUID,
// objectSid, ...) are rendered as text instead whenever the formatter applies.
var knownBinaryAttributes = map[string]bool{
	// Photos and media
	"jpegphoto":      true,
	"thumbnailphoto": true,
	"thumbnaillogo":  true,
	"photo":          true,
	"audio":          true,
	// Certificates and keys
	"usercertificate":           true,
	"cacertificate":             true,
	"usersmimecertificate":      true,
	"crosscertificatepair":      true,
	"certificaterevocationlist": true,
	"authorityrevocationlist":   true,
	"deltarevocationlist":       true,
	"userpkcs12":                true,
	"supportedalgorithms":       true,
	// AD security descriptors, SIDs and GUIDs
	"ntsecuritydescriptor":                     true,
	"msexchmailboxsecuritydescriptor":          true,
	"msds-allowedtoactonbehalfofotheridentity": true,
	"msds-groupmsamembership":                  true,
	"objectsid":                                true,
	"objectguid":                               true,
	"sidhistory":                               true,
	"securityidentifier":                       true,
	"tokengroups":                              true,
	"tokengroupsglobalanduniversal":            true,
	"tokengroupsnogcacceptable":                true,
	"msexchmasteraccountsid":                   true,
	"msexchmailboxguid":                        true,
	"ms-ds-consistencyguid":                    true,
	"msds-generationid":                        true,
	"schemaidguid":                             true,
	"attributesecurityguid":                    true,
	"invocationid":                             true,
	// AD account data
	"logonhours":           true,
	"msds-managedpassword": true,
	"terminalserver":       true,
	// AD replication metadata
	"replpropertymetadata": true,
	"repluptodatevector":   true,
	"repsfrom":             true,
	"repsto":               true,
	"dsasignature":         true,
	"partialattributeset":  true,
}

// attrBaseName returns the attribute type without options,
// e.g. "userCertificate" for "userCertificate;binary".
func attrBaseName(name string) string {
	if i := strings.IndexByte(name, ';'); i >= 0 {
		return name[:i]
	}
	return name
}

// hasBinaryOption reports whether the attribute description carries the
// ";binary" transfer option.
func hasBinaryOption(name string) bool {
	opts := strings.Split(name, ";")
	for _, o := range opts[1:] {
		if strings.EqualFold(o, "binary") {
			return true
		}
	}
	return false
}

// isUnicodePwd reports whether name is AD's unicodePwd attribute, by name
// or by its OID (options ignored).
func isUnicodePwd(name string) bool {
	base := attrBaseName(name)
	return strings.EqualFold(base, "unicodePwd") || base == OIDUnicodePwd
}

// IsKnownBinaryAttribute reports whether values of the attribute are always
// treated as binary: its name (case-insensitive, options ignored) is in the
// known-binary list or it carries the ;binary option.
func IsKnownBinaryAttribute(name string) bool {
	return knownBinaryAttributes[strings.ToLower(attrBaseName(name))] || hasBinaryOption(name)
}

// IsBinaryValue reports whether v cannot be passed on as text: it is not
// valid UTF-8 or contains control characters other than tab, CR and LF.
func IsBinaryValue(v []byte) bool {
	if !utf8.Valid(v) {
		return true
	}
	for _, r := range string(v) {
		if r == '\t' || r == '\r' || r == '\n' {
			continue
		}
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

// isBinaryAttribute decides whether an attribute read from the server is
// passed on as binary (base64).
func isBinaryAttribute(name string, values [][]byte) bool {
	if IsKnownBinaryAttribute(name) {
		return true
	}
	for _, v := range values {
		if IsBinaryValue(v) {
			return true
		}
	}
	return false
}

// encodeBinaryValues returns the base64 form of raw values.
func encodeBinaryValues(values [][]byte) []string {
	encoded := make([]string, len(values))
	for i, v := range values {
		encoded[i] = base64.StdEncoding.EncodeToString(v)
	}
	return encoded
}

// rawValues returns the values to send to the server for an attribute coming
// from the frontend or the model layer: binary values are base64-decoded,
// plain-text unicodePwd values are encoded the way AD expects. A binary
// unicodePwd value is taken as already encoded.
func rawValues(attr string, values []string, binary bool) ([]string, error) {
	out := make([]string, len(values))
	for i, v := range values {
		switch {
		case binary:
			raw, err := base64.StdEncoding.DecodeString(v)
			if err != nil {
				return nil, fmt.Errorf("attribute %q: value %d is not valid base64: %v", attr, i+1, err)
			}
			out[i] = string(raw)
		case isUnicodePwd(attr):
			out[i] = string(encodeUnicodePwd(v))
		default:
			out[i] = v
		}
	}
	return out, nil
}

// convertAttribute converts a go-ldap attribute to the model, applying the
// binary contract: known formatters (objectGUID, objectSid, ...) produce text,
// binary attributes are base64 encoded, everything else is passed as text.
func convertAttribute(name string, byteValues [][]byte, values []string) models.LDAPAttribute {
	if formatted := formatBinaryAttr(name, byteValues); formatted != nil {
		return models.LDAPAttribute{Name: name, Values: formatted}
	}
	if isBinaryAttribute(name, byteValues) {
		return models.LDAPAttribute{Name: name, Values: encodeBinaryValues(byteValues), Binary: true}
	}
	if values == nil {
		values = []string{}
	}
	return models.LDAPAttribute{Name: name, Values: values}
}
