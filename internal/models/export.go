package models

// ExportOptions holds configuration for LDIF export operations.
type ExportOptions struct {
	DNs       []string `json:"dns"`
	Subtree   bool     `json:"subtree"`
	FoldWidth int      `json:"foldWidth"`
}

// ExportRequest describes an export of the Export dialog
// (ExportService.Export): explicit entries (DNs) or a search below BaseDN.
type ExportRequest struct {
	// Format is "ldif" or "csv".
	Format string `json:"format"`
	// DNs are exported as they are (multi-selection export); BaseDN, Scope
	// and Filter are then ignored.
	DNs []string `json:"dns,omitempty"`
	// BaseDN, Scope (base, one level, subtree) and Filter select the entries
	// otherwise; an empty filter is (objectClass=*).
	BaseDN string      `json:"baseDN"`
	Scope  SearchScope `json:"scope"`
	Filter string      `json:"filter,omitempty"`
	// Attributes: LDIF: only these attributes (objectClass is added for
	// importable files); CSV: the columns. Empty: all attributes.
	Attributes []string `json:"attributes,omitempty"`
	// Importable (LDIF) leaves out server-maintained attributes
	// (operational, NO-USER-MODIFICATION, AD system attributes and
	// back-links), so the file can be imported again.
	Importable bool `json:"importable,omitempty"`
}

// ExportResult is the text of an export and the number of entries in it.
type ExportResult struct {
	Content string `json:"content"`
	Count   int    `json:"count"`
	// Truncated: the search hit a size limit, the export is incomplete.
	Truncated bool `json:"truncated,omitempty"`
}
