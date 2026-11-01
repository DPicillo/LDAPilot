package models

// Bulk operations: batch modify with value templates and LDIF change files.
// Both have a dry run (preview) that reads the directory without writing and
// an apply step that reports per entry / per record results.

// BulkOptions control a bulk preview or apply run.
type BulkOptions struct {
	// RunID identifies the run for progress events ("bulk:progress") and for
	// stopping it with BatchService.StopBulkRun. Optional.
	RunID string `json:"runId"`
	// ContinueOnError keeps processing after a failed entry / record. When
	// false the run stops at the first failure.
	ContinueOnError bool `json:"continueOnError"`
	// SkipEmptyPlaceholders skips entries where a template placeholder is
	// empty (attribute missing or empty) instead of failing them.
	SkipEmptyPlaceholders bool `json:"skipEmptyPlaceholders"`
	// IgnoreNoOps drops value adds of values that are already present and
	// value deletes of values that are not present instead of failing the
	// entry (batch modify only).
	IgnoreNoOps bool `json:"ignoreNoOps"`
	// Passwords are the password storage decisions for the userPassword
	// values of the run (LDIF opt-out AsIs, "ask" decision, confirmation
	// for unencrypted connections), see PasswordWriteOptions.
	Passwords PasswordWriteOptions `json:"passwords"`
}

// Batch modify preview entry statuses.
const (
	BulkStatusChange    = "change"    // the entry would be modified
	BulkStatusUnchanged = "unchanged" // all changes are no-ops for this entry
	BulkStatusSkipped   = "skipped"   // a placeholder is empty and skipping was requested
	BulkStatusError     = "error"     // the changes cannot be applied (template error, predicted failure)
)

// Apply result item statuses (batch modify and LDIF).
const (
	BulkResultSuccess      = "success"
	BulkResultFailed       = "failed"
	BulkResultSkipped      = "skipped"
	BulkResultUnchanged    = "unchanged"
	BulkResultNotProcessed = "notProcessed" // run stopped before the item
)

// BulkAttrDiff is the predicted effect of the changes on one attribute of an
// entry. Before/After hold at most BulkDiffMaxValues values; Added/Removed
// list the exact value differences. Values of password attributes are masked
// ("***"), binary values are shown as "<binary N bytes>".
type BulkAttrDiff struct {
	Attribute   string   `json:"attribute"`
	Operations  []string `json:"operations"` // e.g. ["delete", "add"]
	Before      []string `json:"before"`
	After       []string `json:"after"`
	BeforeCount int      `json:"beforeCount"`
	AfterCount  int      `json:"afterCount"`
	Added       []string `json:"added"`
	Removed     []string `json:"removed"`
	Changed     bool     `json:"changed"`
	Masked      bool     `json:"masked"`
	Binary      bool     `json:"binary"`
}

// BulkDiffMaxValues limits Before/After of a BulkAttrDiff.
const BulkDiffMaxValues = 25

// BulkPreviewEntry is the dry run result of one entry of a batch modify.
type BulkPreviewEntry struct {
	DN       string            `json:"dn"`
	Status   string            `json:"status"` // BulkStatus*
	Errors   []string          `json:"errors"`
	Warnings []string          `json:"warnings"`
	Notes    []string          `json:"notes"` // dropped no-op changes etc.
	Diffs    []BulkAttrDiff    `json:"diffs"`
	Changes  []AttributeChange `json:"changes"` // resolved changes that would be sent
}

// BulkPreview is the dry run result of a batch modify.
type BulkPreview struct {
	Entries   []BulkPreviewEntry `json:"entries"`
	Total     int                `json:"total"`
	Changed   int                `json:"changed"`
	Unchanged int                `json:"unchanged"`
	Skipped   int                `json:"skipped"`
	Errors    int                `json:"errors"`
	Stopped   bool               `json:"stopped"` // preview was stopped; Entries is incomplete
}

// BulkResultItem is the outcome of one entry (batch) or record (LDIF).
type BulkResultItem struct {
	Line      int    `json:"line,omitempty"` // LDIF: line of the dn: line
	DN        string `json:"dn"`
	Operation string `json:"operation"` // modify, add, delete, modrdn
	Status    string `json:"status"`    // BulkResult*
	Message   string `json:"message,omitempty"`
	Details   string `json:"details,omitempty"` // summary of the sent changes (passwords masked)
	NewDN     string `json:"newDn,omitempty"`   // modrdn: resulting DN
	// PasswordWarning flags a written userPassword that needs attention
	// (PasswordWarning* constants; "" when none): the read-back after the
	// write found it stored in cleartext, the new password will not work,
	// or the scheme may not be verifiable. The item is still a success.
	PasswordWarning string `json:"passwordWarning,omitempty"`
	DurationMs      int64  `json:"durationMs"`
}

// BulkResultItem.PasswordWarning values, most severe first.
const (
	PasswordWarningIneffective = "ineffective" // the new password will not work
	PasswordWarningCleartext   = "cleartext"   // stored in cleartext
	PasswordWarningUnconfirmed = "unconfirmed" // the server may not verify the scheme
	PasswordWarningOther       = "warning"     // other password storage warnings
)

// BulkApplyResult is the outcome of a batch modify or LDIF apply run.
type BulkApplyResult struct {
	RunID        string `json:"runId"`
	Total        int    `json:"total"`
	Succeeded    int    `json:"succeeded"`
	Failed       int    `json:"failed"`
	Skipped      int    `json:"skipped"`
	Unchanged    int    `json:"unchanged"`
	NotProcessed int    `json:"notProcessed"`
	Stopped      bool   `json:"stopped"` // stopped by the user or by the first failure
	StopReason   string `json:"stopReason,omitempty"`
	// Items with a PasswordWarning, by kind: ineffective, cleartext, and
	// unconfirmed or other warnings.
	PasswordIneffective int              `json:"passwordIneffective"`
	PasswordCleartext   int              `json:"passwordCleartext"`
	PasswordWarnings    int              `json:"passwordWarnings"`
	Items               []BulkResultItem `json:"items"`
}

// BulkProgress is the payload of the "bulk:progress" event.
type BulkProgress struct {
	RunID     string `json:"runId"`
	Phase     string `json:"phase"` // "preview" or "apply"
	Current   int    `json:"current"`
	Total     int    `json:"total"`
	DN        string `json:"dn"`
	Succeeded int    `json:"succeeded"`
	Failed    int    `json:"failed"`
	Skipped   int    `json:"skipped"`
}

// LDIF change types as reported in previews and results ("moddn" records
// are reported as "modrdn").
const (
	LDIFChangeAdd    = "add"
	LDIFChangeModify = "modify"
	LDIFChangeDelete = "delete"
	LDIFChangeModRDN = "modrdn"
)

// LDIF preview record statuses.
const (
	LDIFRecordOK      = "ok"
	LDIFRecordWarning = "warning"
	LDIFRecordError   = "error"   // valid syntax, predicted to fail
	LDIFRecordInvalid = "invalid" // syntax error
)

// LDIFRecordPreview is the dry run result of one LDIF record.
type LDIFRecordPreview struct {
	Index        int               `json:"index"`
	Line         int               `json:"line"`
	DN           string            `json:"dn"`
	ChangeType   string            `json:"changeType"` // LDIFChange*; empty for unparsable records
	Status       string            `json:"status"`     // LDIFRecord*
	Errors       []string          `json:"errors"`
	Warnings     []string          `json:"warnings"`
	Notes        []string          `json:"notes,omitempty"`      // e.g. how password values are stored
	Summary      string            `json:"summary"`              // human readable summary of the record
	Attributes   []LDAPAttribute   `json:"attributes,omitempty"` // add (password values masked)
	Changes      []AttributeChange `json:"changes,omitempty"`    // modify (password values masked)
	Diffs        []BulkAttrDiff    `json:"diffs,omitempty"`      // modify: predicted effect
	NewRDN       string            `json:"newRdn,omitempty"`
	DeleteOldRDN bool              `json:"deleteOldRdn,omitempty"`
	NewSuperior  string            `json:"newSuperior,omitempty"`
	NewDN        string            `json:"newDn,omitempty"`
}

// LDIFSyntaxError is a syntax error with the 1-based line number.
type LDIFSyntaxError struct {
	Line    int    `json:"line"`
	Message string `json:"message"`
}

// LDIFPreview is the dry run result of an LDIF file.
type LDIFPreview struct {
	Version      int                 `json:"version"`
	Records      []LDIFRecordPreview `json:"records"`
	SyntaxErrors []LDIFSyntaxError   `json:"syntaxErrors"`
	// Counts per change type (add, modify, delete, modrdn) and per status
	// (ok, warning, error, invalid).
	ByChangeType map[string]int `json:"byChangeType"`
	ByStatus     map[string]int `json:"byStatus"`
	Total        int            `json:"total"`
	// Applicable is true when the file has no syntax errors (records predicted
	// to fail can still be applied with continue-on-error).
	Applicable bool `json:"applicable"`
	Stopped    bool `json:"stopped"`
}

// LDIFFile is an LDIF file read through the open dialog.
type LDIFFile struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	Content string `json:"content"`
}
