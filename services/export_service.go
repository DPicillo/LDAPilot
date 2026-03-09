package services

import (
	"context"
	"fmt"
	"os"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/ldif"
	"github.com/dpicillo/LDAPilot/internal/models"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// ExportService provides LDIF export capabilities.
type ExportService struct {
	ctx  context.Context
	pool *ldap.Pool
}

// NewExportService creates a new ExportService.
func NewExportService(pool *ldap.Pool) *ExportService {
	return &ExportService{
		pool: pool,
	}
}

// SetContext sets the Wails application context.
func (s *ExportService) SetContext(ctx context.Context) {
	s.ctx = ctx
}

// ExportEntries fetches the specified entries by DN and returns them as an LDIF string.
func (s *ExportService) ExportEntries(profileID string, dns []string) (string, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return "", err
	}

	entries := make([]models.LDAPEntry, 0, len(dns))
	for _, dn := range dns {
		entry, err := client.GetEntry(dn)
		if err != nil {
			return "", fmt.Errorf("failed to fetch entry %q: %w", dn, err)
		}
		entries = append(entries, *entry)
	}

	return ldif.Export(entries)
}

// ExportSubtree fetches all entries under the given base DN and returns them as an LDIF string.
func (s *ExportService) ExportSubtree(profileID string, baseDN string) (string, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return "", err
	}

	params := models.SearchParams{
		BaseDN: baseDN,
		Filter: "(objectClass=*)",
		Scope:  models.ScopeSub,
	}

	result, err := client.Search(params)
	if err != nil {
		return "", fmt.Errorf("failed to search subtree %q: %w", baseDN, err)
	}

	return ldif.Export(result.Entries)
}

// ImportLDIF parses an LDIF string and adds each entry to the server.
func (s *ExportService) ImportLDIF(profileID string, ldifContent string) (*ldif.ImportResult, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}

	entries, err := ldif.Parse(ldifContent)
	if err != nil {
		return nil, fmt.Errorf("failed to parse LDIF: %w", err)
	}

	result := &ldif.ImportResult{
		Entries: entries,
		Total:   len(entries),
	}

	for _, entry := range entries {
		if addErr := client.AddEntry(entry.DN, entry.Attributes); addErr != nil {
			result.Failed++
			result.Errors = append(result.Errors, fmt.Sprintf("%s: %v", entry.DN, addErr))
		} else {
			result.Succeeded++
		}
	}

	return result, nil
}

// ImportLDIFFromFile opens a file dialog, reads the LDIF file, and imports entries.
func (s *ExportService) ImportLDIFFromFile(profileID string) (*ldif.ImportResult, error) {
	filePath, err := runtime.OpenFileDialog(s.ctx, runtime.OpenDialogOptions{
		Title: "Import LDIF",
		Filters: []runtime.FileFilter{
			{
				DisplayName: "LDIF Files (*.ldif)",
				Pattern:     "*.ldif",
			},
			{
				DisplayName: "All Files (*.*)",
				Pattern:     "*.*",
			},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("open dialog failed: %w", err)
	}

	if filePath == "" {
		return nil, nil // User cancelled
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}

	return s.ImportLDIF(profileID, string(data))
}

// PreviewLDIF parses an LDIF string and returns the parsed entries without importing them.
func (s *ExportService) PreviewLDIF(ldifContent string) ([]models.LDAPEntry, error) {
	entries, err := ldif.Parse(ldifContent)
	if err != nil {
		return nil, fmt.Errorf("failed to parse LDIF: %w", err)
	}
	return entries, nil
}

// ExportCSV fetches entries and returns them as CSV.
func (s *ExportService) ExportCSV(profileID string, baseDN string, columns []string) (string, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return "", err
	}

	params := models.SearchParams{
		BaseDN: baseDN,
		Filter: "(objectClass=*)",
		Scope:  models.ScopeSub,
	}

	result, err := client.Search(params)
	if err != nil {
		return "", fmt.Errorf("failed to search: %w", err)
	}

	return ldif.ExportCSV(result.Entries, columns)
}

// ExportCSVToFile prompts the user to save CSV export.
func (s *ExportService) ExportCSVToFile(profileID string, baseDN string, columns []string) error {
	csvContent, err := s.ExportCSV(profileID, baseDN, columns)
	if err != nil {
		return err
	}

	filePath, err := runtime.SaveFileDialog(s.ctx, runtime.SaveDialogOptions{
		Title:                "Export CSV",
		DefaultFilename:      "export.csv",
		CanCreateDirectories: true,
		Filters: []runtime.FileFilter{
			{DisplayName: "CSV Files (*.csv)", Pattern: "*.csv"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return fmt.Errorf("save dialog failed: %w", err)
	}
	if filePath == "" {
		return nil
	}

	return os.WriteFile(filePath, []byte(csvContent), 0600)
}

// ExportToFile prompts the user to choose a file location and writes the LDIF export there.
func (s *ExportService) ExportToFile(profileID string, dns []string) error {
	ldifContent, err := s.ExportEntries(profileID, dns)
	if err != nil {
		return err
	}

	filePath, err := runtime.SaveFileDialog(s.ctx, runtime.SaveDialogOptions{
		Title:                "Export LDIF",
		DefaultFilename:      "export.ldif",
		CanCreateDirectories: true,
		Filters: []runtime.FileFilter{
			{
				DisplayName: "LDIF Files (*.ldif)",
				Pattern:     "*.ldif",
			},
			{
				DisplayName: "All Files (*.*)",
				Pattern:     "*.*",
			},
		},
	})
	if err != nil {
		return fmt.Errorf("save dialog failed: %w", err)
	}

	if filePath == "" {
		// User cancelled
		return nil
	}

	if err := os.WriteFile(filePath, []byte(ldifContent), 0600); err != nil {
		return fmt.Errorf("failed to write file: %w", err)
	}

	return nil
}
