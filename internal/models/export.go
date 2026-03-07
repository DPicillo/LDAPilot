package models

// ExportOptions holds configuration for LDIF export operations.
type ExportOptions struct {
	DNs       []string `json:"dns"`
	Subtree   bool     `json:"subtree"`
	FoldWidth int      `json:"foldWidth"`
}
