package ldap

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"
)

// knownBinaryFormatters maps lowercase attribute names to their binary formatters.
var knownBinaryFormatters = map[string]func([]byte) string{
	"objectguid":  formatGUID,
	"objectsid":   formatSID,
	"msexchmailboxguid":  formatGUID,
	"msexchmailboxsecuritydescriptor": formatHexDump,
	"ntsecuritydescriptor":            formatHexDump,
	"msds-generationid":               formatGUID,
}

// formatBinaryAttr checks if the attribute has a known binary formatter and returns
// the formatted string values. Returns nil if no formatter applies.
func formatBinaryAttr(name string, byteValues [][]byte) []string {
	lower := strings.ToLower(name)
	formatter, ok := knownBinaryFormatters[lower]
	if !ok {
		return nil
	}

	formatted := make([]string, 0, len(byteValues))
	for _, bv := range byteValues {
		formatted = append(formatted, formatter(bv))
	}
	return formatted
}

// formatGUID converts a 16-byte AD objectGUID to the standard
// xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx format using AD's little-endian byte order.
func formatGUID(data []byte) string {
	if len(data) != 16 {
		return formatHexDump(data)
	}

	// AD stores the first three components in little-endian order
	d1 := binary.LittleEndian.Uint32(data[0:4])
	d2 := binary.LittleEndian.Uint16(data[4:6])
	d3 := binary.LittleEndian.Uint16(data[6:8])

	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		d1, d2, d3,
		data[8:10],
		data[10:16],
	)
}

// formatSID converts a binary SID to the S-1-... string format.
func formatSID(data []byte) string {
	if len(data) < 8 {
		return formatHexDump(data)
	}

	revision := data[0]
	subAuthorityCount := int(data[1])

	// 6-byte big-endian identifier authority
	var authority uint64
	for i := 2; i < 8; i++ {
		authority = (authority << 8) | uint64(data[i])
	}

	expectedLen := 8 + 4*subAuthorityCount
	if len(data) < expectedLen {
		return formatHexDump(data)
	}

	parts := []string{fmt.Sprintf("S-%d-%d", revision, authority)}
	for i := 0; i < subAuthorityCount; i++ {
		offset := 8 + 4*i
		sub := binary.LittleEndian.Uint32(data[offset : offset+4])
		parts = append(parts, fmt.Sprintf("%d", sub))
	}

	return strings.Join(parts, "-")
}

// formatHexDump returns a truncated hex representation for large binary values.
func formatHexDump(data []byte) string {
	const maxDisplay = 64
	if len(data) <= maxDisplay {
		return hex.EncodeToString(data)
	}
	return fmt.Sprintf("%s... (%d bytes)", hex.EncodeToString(data[:maxDisplay]), len(data))
}
