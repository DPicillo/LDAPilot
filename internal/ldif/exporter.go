package ldif

import (
	"encoding/base64"
	"fmt"
	"io"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/models"
)

const defaultFoldWidth = 76

// Export converts a slice of LDAPEntry values into an LDIF-formatted string.
func Export(entries []models.LDAPEntry) (string, error) {
	var sb strings.Builder
	if err := ExportToWriter(&sb, entries); err != nil {
		return "", err
	}
	return sb.String(), nil
}

// ExportToWriter writes LDIF-formatted entries to the given writer.
func ExportToWriter(w io.Writer, entries []models.LDAPEntry) error {
	if _, err := fmt.Fprintf(w, "version: 1\n"); err != nil {
		return err
	}

	for _, entry := range entries {
		// Blank line separator between records (and after version header)
		if _, err := fmt.Fprintln(w); err != nil {
			return err
		}

		// Write DN - base64 encode if needed
		if needsBase64(entry.DN) {
			encoded := base64.StdEncoding.EncodeToString([]byte(entry.DN))
			if err := writeFolded(w, fmt.Sprintf("dn:: %s", encoded)); err != nil {
				return err
			}
		} else {
			if err := writeFolded(w, fmt.Sprintf("dn: %s", entry.DN)); err != nil {
				return err
			}
		}

		// Write attributes
		for _, attr := range entry.Attributes {
			for _, val := range attr.Values {
				if attr.Binary || needsBase64(val) {
					encoded := base64.StdEncoding.EncodeToString([]byte(val))
					if err := writeFolded(w, fmt.Sprintf("%s:: %s", attr.Name, encoded)); err != nil {
						return err
					}
				} else {
					if err := writeFolded(w, fmt.Sprintf("%s: %s", attr.Name, val)); err != nil {
						return err
					}
				}
			}
		}
	}

	return nil
}

// needsBase64 returns true if a string value should be base64-encoded per RFC 2849.
func needsBase64(s string) bool {
	if len(s) == 0 {
		return false
	}

	// Must base64 encode if starts with space, colon, or less-than
	first := s[0]
	if first == ' ' || first == ':' || first == '<' {
		return true
	}

	// Must base64 encode if contains non-ASCII or control characters
	for _, r := range s {
		if r < 0x20 || r > 0x7E {
			return true
		}
	}

	return false
}

// writeFolded writes a line to the writer, folding at defaultFoldWidth characters per RFC 2849.
// Uses rune-aware slicing to avoid breaking multi-byte UTF-8 characters.
func writeFolded(w io.Writer, line string) error {
	runes := []rune(line)
	if len(runes) <= defaultFoldWidth {
		_, err := fmt.Fprintf(w, "%s\n", line)
		return err
	}

	// Write first chunk
	if _, err := fmt.Fprintf(w, "%s\n", string(runes[:defaultFoldWidth])); err != nil {
		return err
	}

	remaining := runes[defaultFoldWidth:]
	for len(remaining) > 0 {
		// Continuation lines start with a space, so we can fit foldWidth-1 chars
		chunkSize := defaultFoldWidth - 1
		if chunkSize > len(remaining) {
			chunkSize = len(remaining)
		}
		if _, err := fmt.Fprintf(w, " %s\n", string(remaining[:chunkSize])); err != nil {
			return err
		}
		remaining = remaining[chunkSize:]
	}

	return nil
}
