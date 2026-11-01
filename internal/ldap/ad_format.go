package ldap

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// knownBinaryFormatters maps lowercase attribute names to formatters that
// render binary values as readable text. A formatter returns ok=false for a
// value it cannot render losslessly; the attribute is then passed on as
// binary (base64) instead.
var knownBinaryFormatters = map[string]func([]byte) (string, bool){
	"objectguid":        formatGUID,
	"objectsid":         formatSID,
	"msexchmailboxguid": formatGUID,
	"msds-generationid": formatGUID,
}

// formatBinaryAttr checks if the attribute has a known binary formatter and returns
// the formatted string values. Returns nil if no formatter applies to every value.
func formatBinaryAttr(name string, byteValues [][]byte) []string {
	formatter, ok := knownBinaryFormatters[strings.ToLower(attrBaseName(name))]
	if !ok || len(byteValues) == 0 {
		return nil
	}

	formatted := make([]string, 0, len(byteValues))
	for _, bv := range byteValues {
		s, ok := formatter(bv)
		if !ok {
			return nil
		}
		formatted = append(formatted, s)
	}
	return formatted
}

// formatGUID converts a 16-byte AD objectGUID to the standard
// xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx format using AD's little-endian byte order.
func formatGUID(data []byte) (string, bool) {
	if len(data) != 16 {
		return "", false
	}

	// AD stores the first three components in little-endian order
	d1 := binary.LittleEndian.Uint32(data[0:4])
	d2 := binary.LittleEndian.Uint16(data[4:6])
	d3 := binary.LittleEndian.Uint16(data[6:8])

	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		d1, d2, d3,
		data[8:10],
		data[10:16],
	), true
}

// formatSID converts a binary SID to the S-1-... string format.
func formatSID(data []byte) (string, bool) {
	if len(data) < 8 {
		return "", false
	}

	revision := data[0]
	subAuthorityCount := int(data[1])

	// 6-byte big-endian identifier authority
	var authority uint64
	for i := 2; i < 8; i++ {
		authority = (authority << 8) | uint64(data[i])
	}

	if len(data) != 8+4*subAuthorityCount {
		return "", false
	}

	parts := []string{fmt.Sprintf("S-%d-%d", revision, authority)}
	for i := 0; i < subAuthorityCount; i++ {
		offset := 8 + 4*i
		sub := binary.LittleEndian.Uint32(data[offset : offset+4])
		parts = append(parts, fmt.Sprintf("%d", sub))
	}

	return strings.Join(parts, "-"), true
}

// knownBinaryParsers invert knownBinaryFormatters: they turn the text a
// formatter produced back into the raw value.
var knownBinaryParsers = map[string]func(string) ([]byte, bool){
	"objectguid":        parseGUIDText,
	"objectsid":         parseSIDText,
	"msexchmailboxguid": parseGUIDText,
	"msds-generationid": parseGUIDText,
}

// RawADValues returns attr with values that convertEntry rendered as text
// (objectGUID, objectSid, msExchMailboxGuid, msDS-GenerationId) turned back
// into the raw bytes: base64 values with Binary set, the form an LDIF export
// must write ("objectGUID:: …") so that it can be imported again. Other
// attributes, binary attributes and attributes with a value that does not
// parse are returned unchanged.
func RawADValues(attr models.LDAPAttribute) models.LDAPAttribute {
	parse, ok := knownBinaryParsers[strings.ToLower(attrBaseName(attr.Name))]
	if !ok || attr.Binary || len(attr.Values) == 0 {
		return attr
	}
	values := make([]string, 0, len(attr.Values))
	for _, v := range attr.Values {
		raw, ok := parse(v)
		if !ok {
			return attr
		}
		values = append(values, base64.StdEncoding.EncodeToString(raw))
	}
	return models.LDAPAttribute{Name: attr.Name, Values: values, Binary: true}
}

// parseGUIDText is the inverse of formatGUID.
func parseGUIDText(s string) ([]byte, bool) {
	s = strings.TrimSpace(s)
	if len(s) != 36 || s[8] != '-' || s[13] != '-' || s[18] != '-' || s[23] != '-' {
		return nil, false
	}
	b, err := hex.DecodeString(strings.ReplaceAll(s, "-", ""))
	if err != nil || len(b) != 16 {
		return nil, false
	}
	out := make([]byte, 16)
	binary.LittleEndian.PutUint32(out[0:4], binary.BigEndian.Uint32(b[0:4]))
	binary.LittleEndian.PutUint16(out[4:6], binary.BigEndian.Uint16(b[4:6]))
	binary.LittleEndian.PutUint16(out[6:8], binary.BigEndian.Uint16(b[6:8]))
	copy(out[8:], b[8:])
	return out, true
}

// parseSIDText is the inverse of formatSID ("S-1-5-21-…").
func parseSIDText(s string) ([]byte, bool) {
	parts := strings.Split(strings.TrimSpace(s), "-")
	if len(parts) < 3 || !strings.EqualFold(parts[0], "S") || len(parts)-3 > 15 {
		return nil, false
	}
	rev, err := strconv.ParseUint(parts[1], 10, 8)
	if err != nil {
		return nil, false
	}
	auth, err := strconv.ParseUint(parts[2], 10, 48)
	if err != nil {
		return nil, false
	}
	subs := parts[3:]
	out := make([]byte, 8+4*len(subs))
	out[0] = byte(rev)
	out[1] = byte(len(subs))
	for i := 0; i < 6; i++ {
		out[7-i] = byte(auth >> (8 * i))
	}
	for i, p := range subs {
		v, err := strconv.ParseUint(p, 10, 32)
		if err != nil {
			return nil, false
		}
		binary.LittleEndian.PutUint32(out[8+4*i:], uint32(v))
	}
	return out, true
}
