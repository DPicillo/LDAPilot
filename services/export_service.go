package services

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/config"
	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/ldif"
	"github.com/dpicillo/LDAPilot/internal/models"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// ExportService provides LDIF export capabilities.
type ExportService struct {
	ctx        context.Context
	pool       *ldap.Pool
	auditStore *config.AuditStore
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

// SetAuditStore sets the audit store for logging entries created by LDIF import.
func (s *ExportService) SetAuditStore(store *config.AuditStore) {
	s.auditStore = store
}

// ExportEntries fetches the specified entries by DN and returns them as an LDIF string.
func (s *ExportService) ExportEntries(profileID string, dns []string) (string, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return "", err
	}

	entries, err := exportReadEntries(client, dns)
	if err != nil {
		return "", err
	}
	return ldif.Export(entries)
}

// exportReadEntries reads the entries of a multi-entry export, parents
// first (an LDIF import needs every parent before its children).
func exportReadEntries(client *ldap.Client, dns []string) ([]models.LDAPEntry, error) {
	entries := make([]models.LDAPEntry, 0, len(dns))
	for _, dn := range dns {
		entry, err := client.GetEntry(dn)
		if err != nil {
			return nil, fmt.Errorf("failed to fetch entry %q: %w", dn, err)
		}
		entries = append(entries, *entry)
	}
	ldif.SortParentFirst(entries)
	return entries, nil
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

	ldif.SortParentFirst(result.Entries)
	return ldif.Export(result.Entries)
}

// exportSearchAttributes are the attributes requested for an export search:
// all user attributes plus the operational ones a full LDIF shows.
var exportSearchAttributes = []string{"*", "+"}

// Export runs an export of the Export dialog (see models.ExportRequest) and
// returns its text: LDIF (parents first, AD values as raw bytes, optionally
// importable and restricted to attributes) or CSV (formula-safe). Nothing is
// written; SaveExport writes an export to a file without sending it to the
// frontend, req.Limit makes a preview of the first entries.
func (s *ExportService) Export(profileID string, req models.ExportRequest) (*models.ExportResult, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	entries, truncated, limited, err := exportEntries(client, req)
	if err != nil {
		return nil, err
	}
	var sb strings.Builder
	if err := writeExport(&sb, client, req, entries); err != nil {
		return nil, err
	}
	return &models.ExportResult{Content: sb.String(), Count: len(entries), Truncated: truncated, Limited: limited}, nil
}

// SaveExport runs an export like Export and writes it straight to a file
// chosen in the "Export LDIF" / "Export CSV" save dialog (shown first, in
// directory, named after defaultName): a large export never crosses the
// Wails bridge. Returns Path "" when the dialog was cancelled.
func (s *ExportService) SaveExport(profileID string, req models.ExportRequest, defaultName, directory string) (*models.ExportFileResult, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	path, err := s.exportSaveDialog(defaultName, req.Format, directory)
	if err != nil || path == "" {
		return &models.ExportFileResult{}, err
	}
	return exportToPath(client, req, path)
}

// exportToPath writes the export of req to path (buffered, 0600).
func exportToPath(client *ldap.Client, req models.ExportRequest, path string) (*models.ExportFileResult, error) {
	req.Limit = 0
	entries, truncated, _, err := exportEntries(client, req)
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return nil, fmt.Errorf("failed to write %s: %w", path, err)
	}
	w := bufio.NewWriterSize(f, 1<<20)
	cw := &countingWriter{w: w}
	err = writeExport(cw, client, req, entries)
	if err == nil {
		err = w.Flush()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, fmt.Errorf("failed to write %s: %w", path, err)
	}
	return &models.ExportFileResult{Path: path, Count: len(entries), Bytes: cw.n, Truncated: truncated}, nil
}

// countingWriter counts the bytes written through it.
type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

// exportEntries reads the entries of an export request: the DNs (parents
// first) or the search below the base DN. limited is true when req.Limit
// stopped the reading.
func exportEntries(client *ldap.Client, req models.ExportRequest) (entries []models.LDAPEntry, truncated, limited bool, err error) {
	if len(req.DNs) > 0 {
		dns := req.DNs
		if req.Limit > 0 && len(dns) > req.Limit {
			dns, limited = dns[:req.Limit], true
		}
		entries, err = exportReadEntries(client, dns)
		return entries, false, limited, err
	}
	if strings.TrimSpace(req.BaseDN) == "" {
		return nil, false, false, fmt.Errorf("no base DN")
	}
	filter := strings.TrimSpace(req.Filter)
	if filter == "" {
		filter = "(objectClass=*)"
	}
	if err := ldap.ValidateFilter(filter); err != nil {
		return nil, false, false, err
	}
	attrs := exportSearchAttributes
	switch {
	case req.Format == "csv" && len(req.Attributes) > 0:
		attrs = req.Attributes
	case req.Format != "csv" && req.Importable:
		// An importable file leaves out every operational attribute: they
		// are not even read (half the data of an OpenLDAP entry).
		attrs = []string{"*"}
	}
	params := models.SearchParams{BaseDN: req.BaseDN, Scope: req.Scope, Filter: filter, Attributes: attrs}
	if req.Limit > 0 {
		params.SizeLimit = req.Limit
	}
	res, err := client.Search(params)
	if err != nil {
		return nil, false, false, fmt.Errorf("export search below %q failed: %w", req.BaseDN, err)
	}
	entries, truncated = res.Entries, res.Truncated
	if req.Limit > 0 && truncated {
		truncated, limited = false, true
	}
	ldif.SortParentFirst(entries)
	return entries, truncated, limited, nil
}

// writeExport formats entries as the request's LDIF or CSV.
func writeExport(w io.Writer, client *ldap.Client, req models.ExportRequest, entries []models.LDAPEntry) error {
	if req.Format == "csv" {
		content, err := ldif.ExportCSV(entries, req.Attributes)
		if err != nil {
			return err
		}
		_, err = io.WriteString(w, content)
		return err
	}
	if req.Importable {
		entries = ldif.StripNonImportable(entries, schemaNonImportable(client))
	}
	entries = ldif.KeepAttributes(entries, req.Attributes, req.Importable)
	return ldif.ExportToWriter(w, entries)
}

// schemaNonImportable lists (lower case) the attribute types of the server's
// schema that an add record must not contain: NO-USER-MODIFICATION and
// operational usage. Without a readable schema the static list of
// internal/ldif applies alone.
func schemaNonImportable(client *ldap.Client) map[string]bool {
	out := map[string]bool{}
	schema, err := client.GetSchema()
	if err != nil || schema == nil {
		return out
	}
	for _, a := range schema.Attributes {
		if a.NoUserMod || (a.Usage != "" && !strings.EqualFold(a.Usage, "userApplications")) {
			out[strings.ToLower(a.Name)] = true
		}
	}
	return out
}

// SaveExportFile shows a save dialog titled "Export LDIF" / "Export CSV"
// (format "ldif" or "csv") in directory (the last export folder; empty =
// the dialog's default) with defaultName and writes content there. Returns
// the path, or "" when the dialog was cancelled.
func (s *ExportService) SaveExportFile(defaultName, format, content, directory string) (string, error) {
	path, err := s.exportSaveDialog(defaultName, format, directory)
	if err != nil || path == "" {
		return "", err
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		return "", fmt.Errorf("failed to write %s: %w", path, err)
	}
	return path, nil
}

// exportSaveDialog shows the "Export LDIF" / "Export CSV" save dialog in
// directory (the last export folder) with defaultName; "" when cancelled.
func (s *ExportService) exportSaveDialog(defaultName, format, directory string) (string, error) {
	format = strings.ToLower(format)
	title, filters := "Export LDIF", []runtime.FileFilter{{DisplayName: "LDIF Files (*.ldif)", Pattern: "*.ldif"}}
	if format == "csv" {
		title, filters = "Export CSV", []runtime.FileFilter{{DisplayName: "CSV Files (*.csv)", Pattern: "*.csv"}}
	}
	filters = append(filters, runtime.FileFilter{DisplayName: "All Files (*.*)", Pattern: "*.*"})
	opts := runtime.SaveDialogOptions{
		Title:                title,
		DefaultFilename:      exportFileName(defaultName, format),
		CanCreateDirectories: true,
		Filters:              filters,
	}
	opts.DefaultDirectory = exportStartDirectory(directory)
	path, err := runtime.SaveFileDialog(s.ctx, opts)
	if err != nil {
		return "", fmt.Errorf("save dialog failed: %w", err)
	}
	return path, nil
}

// exportFileName turns a suggested name (usually an RDN value) into a safe
// file name with the format's extension.
func exportFileName(name, format string) string {
	ext := "." + format
	if format != "csv" {
		ext = ".ldif"
	}
	name = strings.TrimSpace(name)
	name = strings.TrimSuffix(name, ext)
	var b strings.Builder
	for _, r := range name {
		switch {
		case r < 0x20 || strings.ContainsRune(`/\:*?"<>|`, r):
			b.WriteRune('_')
		default:
			b.WriteRune(r)
		}
	}
	safe := strings.Trim(b.String(), " .")
	if safe == "" {
		safe = "export"
	}
	if r := []rune(safe); len(r) > 120 {
		safe = string(r[:120])
	}
	return safe + ext
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

// ExportCSVToFile prompts the user to save CSV export. It returns the path
// written, or "" when the user cancelled the save dialog.
func (s *ExportService) ExportCSVToFile(profileID string, baseDN string, columns []string) (string, error) {
	csvContent, err := s.ExportCSV(profileID, baseDN, columns)
	if err != nil {
		return "", err
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
		return "", fmt.Errorf("save dialog failed: %w", err)
	}
	if filePath == "" {
		return "", nil
	}

	if err := os.WriteFile(filePath, []byte(csvContent), 0600); err != nil {
		return "", fmt.Errorf("failed to write file: %w", err)
	}
	return filePath, nil
}

// ExportToFile prompts the user to choose a file location and writes the
// LDIF export there. It returns the path written, or "" when the user
// cancelled the save dialog (callers report success only for a path).
func (s *ExportService) ExportToFile(profileID string, dns []string) (string, error) {
	ldifContent, err := s.ExportEntries(profileID, dns)
	if err != nil {
		return "", err
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
		return "", fmt.Errorf("save dialog failed: %w", err)
	}

	if filePath == "" {
		// User cancelled
		return "", nil
	}

	if err := os.WriteFile(filePath, []byte(ldifContent), 0600); err != nil {
		return "", fmt.Errorf("failed to write file: %w", err)
	}

	return filePath, nil
}

// exportStartDirectory is where the save dialog opens: the last export
// folder when it still exists, else the user's Documents folder, else the
// home directory — never the process working directory (the install
// directory or "/" for a desktop launch, RW2-S-10). "" lets the dialog decide.
func exportStartDirectory(last string) string {
	isDir := func(p string) bool {
		info, err := os.Stat(p)
		return err == nil && info.IsDir()
	}
	if last != "" && isDir(last) {
		return last
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	// Linux desktops name it per language (XDG user dirs: "Dokumente", …).
	if docs := xdgDocumentsDir(home); docs != "" && isDir(docs) {
		return docs
	}
	if docs := filepath.Join(home, "Documents"); isDir(docs) {
		return docs
	}
	if isDir(home) {
		return home
	}
	return ""
}

// xdgDocumentsDir reads XDG_DOCUMENTS_DIR from user-dirs.dirs ("" when unset).
func xdgDocumentsDir(home string) string {
	cfg := os.Getenv("XDG_CONFIG_HOME")
	if cfg == "" {
		cfg = filepath.Join(home, ".config")
	}
	data, err := os.ReadFile(filepath.Join(cfg, "user-dirs.dirs"))
	if err != nil {
		return ""
	}
	return parseXDGDocumentsDir(string(data), home)
}

// parseXDGDocumentsDir extracts XDG_DOCUMENTS_DIR="$HOME/…" from a user-dirs.dirs file.
func parseXDGDocumentsDir(content, home string) string {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		v, ok := strings.CutPrefix(line, "XDG_DOCUMENTS_DIR=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"`)
		v = strings.Replace(v, "$HOME", home, 1)
		if !filepath.IsAbs(v) || filepath.Clean(v) == filepath.Clean(home) {
			return "" // unset docs dir points at $HOME itself
		}
		return v
	}
	return ""
}
