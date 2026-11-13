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
	// Import are the choices of an LDIF import for the whole file (LDIF
	// preview and apply only).
	Import LDIFImportOptions `json:"import"`
	// PreviewRunID (LDIF apply with empty content): apply the file of this
	// large dry run (LDIFPreview.Partial), which the backend kept, instead
	// of sending it again.
	PreviewRunID string `json:"previewRunId,omitempty"`
}

// LDIFImportOptions decide, once for the whole file, what an LDIF import
// adapts instead of letting the server refuse a record. Empty values are
// the defaults (the first constant of each group).
type LDIFImportOptions struct {
	// ServerAttributes: attributes the server maintains (IDs, timestamps,
	// back-links, …) in add records. "omit" leaves them out; "send" sends
	// the ones this server lets an import set (OpenLDAP: with the Relax
	// Rules control) and leaves out the ones it refuses or assigns itself.
	ServerAttributes string `json:"serverAttributes,omitempty"`
	// UnknownSchema: attribute types and object classes of add records that
	// the server's schema does not define. "omit" leaves them out; "send"
	// sends them (the server refuses the record).
	UnknownSchema string `json:"unknownSchema,omitempty"`
	// MissingReferences (Active Directory, which refuses a DN value of an
	// entry that does not exist): "omit" leaves out such values of add
	// records; "send" sends them.
	MissingReferences string `json:"missingReferences,omitempty"`
	// Existing: an add record whose entry already exists. "skip" leaves the
	// entry alone; "update" sets the record's attributes on it (the file's
	// values replace the entry's, missing object classes are added, other
	// attributes stay); "fail" reports it as an error.
	Existing string `json:"existing,omitempty"`
}

// LDIFImportOptions values.
const (
	LDIFImportOmit     = "omit"
	LDIFImportSend     = "send"
	LDIFExistingSkip   = "skip"
	LDIFExistingUpdate = "update"
	LDIFExistingFail   = "fail"
)

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
	// Adjusted summarizes what an LDIF import changed in the record before
	// sending it (attributes left out, existing entry updated or skipped).
	Adjusted string `json:"adjusted,omitempty"`
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
	LDIFRecordSkip    = "skip"    // an add record of an existing entry that is skipped (or already up to date)
)

// LDIFAdjustment kinds: what an LDIF import changes in a record before
// sending it.
const (
	LDIFAdjustServerOmitted  = "serverOmitted"  // server-maintained attribute left out
	LDIFAdjustServerSent     = "serverSent"     // server-maintained attribute sent (option "send")
	LDIFAdjustUnknownOmitted = "unknownOmitted" // attribute type unknown to the server or not allowed by the entry's classes, left out
	LDIFAdjustClassOmitted   = "classOmitted"   // object class unknown to the server, left out (Values: the classes)
	LDIFAdjustRefOmitted     = "refOmitted"     // DN value of an entry that does not exist, left out (AD)
	LDIFAdjustRefDeferred    = "refDeferred"    // DN value of an entry a later record creates, set at the end of the run (AD)
	LDIFAdjustExisting       = "existing"       // add record of an existing entry: skipped or turned into an update
)

// LDIFAdjustment is one change an LDIF import makes to a record before
// sending it, e.g. "entryUUID, entryCSN left out: maintained by the server".
type LDIFAdjustment struct {
	Kind string `json:"kind"` // LDIFAdjust*
	// Attributes are the attribute names concerned (for object classes
	// "objectClass"); Values the object classes or DN values left out.
	Attributes []string `json:"attributes"`
	Values     []string `json:"values,omitempty"`
	Reason     string   `json:"reason"`
	// Text is the whole adjustment as one sentence (previews, reports).
	Text string `json:"text"`
}

// LDIFAdjustmentTotal counts the records with an adjustment of one kind,
// attribute and reason over the whole file.
type LDIFAdjustmentTotal struct {
	Kind      string `json:"kind"`
	Attribute string `json:"attribute"`
	Reason    string `json:"reason"`
	Records   int    `json:"records"`
}

// LDIFRecordPreview is the dry run result of one LDIF record.
type LDIFRecordPreview struct {
	Index      int      `json:"index"`
	Line       int      `json:"line"`
	DN         string   `json:"dn"`
	ChangeType string   `json:"changeType"` // LDIFChange*; empty for unparsable records
	Status     string   `json:"status"`     // LDIFRecord*
	Errors     []string `json:"errors"`
	Warnings   []string `json:"warnings"`
	Notes      []string `json:"notes,omitempty"` // e.g. how password values are stored
	// Adjustments are what the import changes in the record before sending
	// it (see LDIFImportOptions).
	Adjustments  []LDIFAdjustment  `json:"adjustments,omitempty"`
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
	// Adjustments count the records per adjustment (kind, attribute,
	// reason) in the order they first appear.
	Adjustments []LDIFAdjustmentTotal `json:"adjustments"`
	// Notes concern the whole file on this server (e.g. accounts imported
	// into Active Directory without passwords).
	Notes []string `json:"notes"`
	// Passwords is the password plan of every record together (nil without
	// password values): what applying the file asks (a decision for "ask",
	// a confirmation on an unencrypted connection).
	Passwords *PasswordWritePlan `json:"passwords,omitempty"`
	// Partial is true when Records holds only the first records of each
	// status (a large file): the others are read with
	// ExportService.GetLDIFPreviewRecords(RunID, …).
	Partial bool   `json:"partial,omitempty"`
	RunID   string `json:"runId,omitempty"`
	// ServerType is the type of the server the dry run checked against
	// (models.ServerType*), so the dialog can explain what cannot be adapted.
	ServerType string `json:"serverType,omitempty"`
	Stopped    bool   `json:"stopped"`
}

// LDIFRecordPage is a page of the records of a dry run (one status or all).
type LDIFRecordPage struct {
	Records []LDIFRecordPreview `json:"records"`
	// Total is the number of records with the status (all: of the file).
	Total int `json:"total"`
}

// LDIFFile is an LDIF file read through the open dialog.
type LDIFFile struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	Content string `json:"content"`
}
