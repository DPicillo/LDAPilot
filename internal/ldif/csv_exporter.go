package ldif

import (
	"encoding/csv"
	"io"
	"sort"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// ExportCSV converts entries to CSV format with specified columns.
// If columns is empty, all unique attribute names are used.
func ExportCSV(entries []models.LDAPEntry, columns []string) (string, error) {
	var sb strings.Builder
	if err := ExportCSVToWriter(&sb, entries, columns); err != nil {
		return "", err
	}
	return sb.String(), nil
}

// ExportCSVToWriter writes entries as CSV to the given writer.
func ExportCSVToWriter(w io.Writer, entries []models.LDAPEntry, columns []string) error {
	if len(columns) == 0 {
		columns = collectAllAttributes(entries)
	}

	// Prepend DN column
	allCols := append([]string{"dn"}, columns...)

	writer := csv.NewWriter(w)
	defer writer.Flush()

	// Write header
	if err := writer.Write(allCols); err != nil {
		return err
	}

	// Write rows
	for _, entry := range entries {
		row := make([]string, len(allCols))
		row[0] = entry.DN

		for i, col := range columns {
			for _, attr := range entry.Attributes {
				if strings.EqualFold(attr.Name, col) {
					row[i+1] = strings.Join(attr.Values, "; ")
					break
				}
			}
		}

		if err := writer.Write(row); err != nil {
			return err
		}
	}

	return nil
}

// collectAllAttributes returns a sorted list of unique attribute names across all entries.
func collectAllAttributes(entries []models.LDAPEntry) []string {
	attrSet := make(map[string]bool)
	for _, entry := range entries {
		for _, attr := range entry.Attributes {
			attrSet[attr.Name] = true
		}
	}

	attrs := make([]string, 0, len(attrSet))
	for name := range attrSet {
		attrs = append(attrs, name)
	}
	sort.Strings(attrs)
	return attrs
}
