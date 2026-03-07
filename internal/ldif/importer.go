package ldif

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"io"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// ImportResult contains the results of an LDIF import operation.
type ImportResult struct {
	Entries   []models.LDAPEntry `json:"entries"`
	Total     int                `json:"total"`
	Succeeded int                `json:"succeeded"`
	Failed    int                `json:"failed"`
	Errors    []string           `json:"errors"`
}

// Parse reads an LDIF string and returns parsed entries.
func Parse(ldifContent string) ([]models.LDAPEntry, error) {
	return ParseReader(strings.NewReader(ldifContent))
}

// ParseReader reads LDIF data from a reader and returns parsed entries.
func ParseReader(r io.Reader) ([]models.LDAPEntry, error) {
	scanner := bufio.NewScanner(r)
	var entries []models.LDAPEntry
	var currentLines []string

	flushEntry := func() error {
		if len(currentLines) == 0 {
			return nil
		}

		entry, err := parseEntry(currentLines)
		if err != nil {
			return err
		}
		if entry != nil {
			entries = append(entries, *entry)
		}
		currentLines = nil
		return nil
	}

	for scanner.Scan() {
		line := scanner.Text()

		// Skip comments
		if strings.HasPrefix(line, "#") {
			continue
		}

		// Skip version line
		if strings.HasPrefix(line, "version:") {
			continue
		}

		// Empty line = end of entry
		if line == "" {
			if err := flushEntry(); err != nil {
				return nil, err
			}
			continue
		}

		// Continuation line (starts with space)
		if strings.HasPrefix(line, " ") && len(currentLines) > 0 {
			currentLines[len(currentLines)-1] += line[1:]
			continue
		}

		currentLines = append(currentLines, line)
	}

	// Flush last entry
	if err := flushEntry(); err != nil {
		return nil, err
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("error reading LDIF: %w", err)
	}

	return entries, nil
}

// parseEntry parses unfolded lines into an LDAPEntry.
func parseEntry(lines []string) (*models.LDAPEntry, error) {
	if len(lines) == 0 {
		return nil, nil
	}

	entry := &models.LDAPEntry{}
	attrMap := make(map[string]*models.LDAPAttribute)
	var attrOrder []string

	for _, line := range lines {
		name, value, isBinary, err := parseLine(line)
		if err != nil {
			return nil, err
		}

		if strings.EqualFold(name, "dn") {
			entry.DN = value
			continue
		}

		if existing, ok := attrMap[name]; ok {
			existing.Values = append(existing.Values, value)
			if isBinary {
				existing.Binary = true
			}
		} else {
			attr := &models.LDAPAttribute{
				Name:   name,
				Values: []string{value},
				Binary: isBinary,
			}
			attrMap[name] = attr
			attrOrder = append(attrOrder, name)
		}
	}

	if entry.DN == "" {
		return nil, fmt.Errorf("entry missing DN")
	}

	for _, name := range attrOrder {
		entry.Attributes = append(entry.Attributes, *attrMap[name])
	}

	return entry, nil
}

// parseLine parses a single LDIF line into name, value, and whether it was base64.
func parseLine(line string) (name, value string, isBinary bool, err error) {
	// Check for base64 encoded value (attr:: value)
	if idx := strings.Index(line, ":: "); idx >= 0 {
		name = line[:idx]
		encoded := line[idx+3:]
		decoded, decErr := base64.StdEncoding.DecodeString(encoded)
		if decErr != nil {
			return "", "", false, fmt.Errorf("invalid base64 in attribute %q: %w", name, decErr)
		}
		return name, string(decoded), true, nil
	}

	// Normal value (attr: value)
	if idx := strings.Index(line, ": "); idx >= 0 {
		return line[:idx], line[idx+2:], false, nil
	}

	// Attribute with empty value (attr:)
	if idx := strings.Index(line, ":"); idx >= 0 {
		return line[:idx], "", false, nil
	}

	return "", "", false, fmt.Errorf("invalid LDIF line: %q", line)
}
