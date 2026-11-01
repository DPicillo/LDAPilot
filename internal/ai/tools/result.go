package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

// Tool error codes (§5.1).
const (
	ErrInvalidArguments     = "INVALID_ARGUMENTS"
	ErrUnknownTool          = "UNKNOWN_TOOL"
	ErrUnknownConnection    = "UNKNOWN_CONNECTION"
	ErrNotConnected         = "NOT_CONNECTED"
	ErrAccessDenied         = "ACCESS_DENIED_BY_POLICY"
	ErrWritesDisabled       = "WRITES_DISABLED"
	ErrReadOnlyProfile      = "READ_ONLY_PROFILE"
	ErrProtectedArea        = "PROTECTED_AREA"
	ErrDeclined             = "DECLINED_BY_USER"
	ErrApprovalTimeout      = "APPROVAL_TIMEOUT"
	ErrCancelled            = "CANCELLED"
	ErrSearchCancelled      = "SEARCH_CANCELLED"
	ErrStepLimit            = "STEP_LIMIT"
	ErrContextTruncated     = "CONTEXT_TRUNCATED"
	ErrOutcomeUnknown       = "OUTCOME_UNKNOWN"
	ErrInvalidFilter        = "INVALID_FILTER"
	ErrRedactedAttribute    = "REDACTED_ATTRIBUTE"
	ErrNoSuchObject         = "NO_SUCH_OBJECT"
	ErrInsufficientAccess   = "INSUFFICIENT_ACCESS"
	ErrConstraintViolation  = "CONSTRAINT_VIOLATION"
	ErrObjectClassViolation = "OBJECT_CLASS_VIOLATION"
	ErrAlreadyExists        = "ALREADY_EXISTS"
	ErrNotAllowedOnNonLeaf  = "NOT_ALLOWED_ON_NON_LEAF"
	ErrUnwillingToPerform   = "UNWILLING_TO_PERFORM"
	ErrEntryChanged         = "ENTRY_CHANGED"
	ErrUnsupportedOnServer  = "UNSUPPORTED_ON_SERVER"
	// ErrPasswordDecision: the connection's password storage policy is
	// "ask" (GitHub issue #1); a separate code so the model does not mix it
	// up with the AI access level "ask" (test-1 D8).
	ErrPasswordDecision = "PASSWORD_STORAGE_DECISION_REQUIRED"
	ErrSizeLimit        = "SIZE_LIMIT"
	ErrTimeout          = "TIMEOUT"
	ErrResultTooLarge   = "RESULT_TOO_LARGE"
	ErrLDAP             = "LDAP_ERROR"
)

// Field is one key/value of an ordered JSON object.
type Field struct {
	K string
	V any
}

// Fields is an ordered JSON object.
type Fields []Field

// Add appends a field.
func (f *Fields) Add(k string, v any) { *f = append(*f, Field{k, v}) }

// Get returns a field value.
func (f Fields) Get(k string) (any, bool) {
	for _, x := range f {
		if x.K == k {
			return x.V, true
		}
	}
	return nil, false
}

// MarshalJSON renders the fields in order.
func (f Fields) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, x := range f {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, _ := json.Marshal(x.K)
		b.Write(kb)
		b.WriteByte(':')
		vb, err := marshalCompact(x.V)
		if err != nil {
			return nil, err
		}
		b.Write(vb)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// marshalCompact marshals without HTML escaping (so "<" stays readable and
// the U+2060 neutralization is not undone by < escapes).
func marshalCompact(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// List is the pageable part of a result (entries, children, members …).
type List struct {
	Key    string
	Items  []any
	Offset int  // position of Items[0] in the full sequence
	More   bool // more items exist beyond Items
	Total  int  // total if known, else -1
}

// ErrorInfo is the error object of a failed tool call.
type ErrorInfo struct {
	Code    string
	Message string
	Hint    string
	Extra   Fields
}

// Result is a tool result: the envelope rendered for the model plus
// harness-only metadata.
type Result struct {
	OK         bool
	Tool       string
	Connection string
	DataOrigin string
	Fields     Fields
	List       *List
	Truncated  bool
	Notes      []string
	Warnings   []string
	Err        *ErrorInfo

	// Harness-only (never rendered).
	Summary      string
	DNs          []string
	ConnectionID string
	Write        *ai.WriteInfo
	Changed      bool // writes: the directory was changed

	shown    int  // list items in the last Render (-1 = no list or error)
	tooLarge bool // the last Render had to fall back to RESULT_TOO_LARGE
}

// RenderedTooLarge reports whether the last Render did not fit at all and
// rendered a RESULT_TOO_LARGE error instead; the caller must then treat
// the call as failed (TooLargeError), since that is what the model sees.
func (r *Result) RenderedTooLarge() bool { return r.tooLarge }

// TooLargeError is the RESULT_TOO_LARGE error result Render falls back to.
func (r *Result) TooLargeError() *Result {
	return &Result{Tool: r.Tool, Connection: r.Connection, Summary: ErrResultTooLarge, ConnectionID: r.ConnectionID,
		Err: &ErrorInfo{Code: ErrResultTooLarge,
			Message: "The result does not fit into the remaining context budget.",
			Hint:    "The context is nearly full; narrow the request (fewer attributes, a smaller limit or a narrower filter)."}}
}

// Shown returns how many list items the last Render included and how many
// the result holds; ok is false for results without a list.
func (r *Result) Shown() (shown, total int, ok bool) {
	if r.List == nil || r.Err != nil {
		return 0, 0, false
	}
	return r.shown, len(r.List.Items), true
}

// Errorf builds an error result.
func Errorf(tool, code, hint, format string, args ...any) *Result {
	return &Result{Tool: tool, Err: &ErrorInfo{Code: code, Message: fmt.Sprintf(format, args...), Hint: hint}, Summary: code}
}

// WithExtra adds an extra field to the error object.
func (r *Result) WithExtra(k string, v any) *Result {
	if r.Err != nil {
		r.Err.Extra.Add(k, v)
	}
	return r
}

// IsError reports whether the result is an error.
func (r *Result) IsError() bool { return r.Err != nil }

// Code returns the error code ("" when ok).
func (r *Result) Code() string {
	if r.Err == nil {
		return ""
	}
	return r.Err.Code
}

// Note appends a note.
func (r *Result) Note(format string, args ...any) {
	r.Notes = append(r.Notes, fmt.Sprintf(format, args...))
}

// Warn appends a warning once.
func (r *Result) Warn(w string) {
	for _, x := range r.Warnings {
		if x == w {
			return
		}
	}
	r.Warnings = append(r.Warnings, w)
}

// Render returns the compact model-facing JSON, shortened to capChars when
// capChars > 0: list items are dropped from the end (with paging hints)
// and, as a last resort, long strings are shortened; the output always
// stays valid JSON. If even that does not fit, a RESULT_TOO_LARGE error is
// rendered.
func (r *Result) Render(capChars int) string {
	r.tooLarge = false
	if r.Err != nil {
		return r.renderError()
	}
	n := 0
	if r.List != nil {
		n = len(r.List.Items)
	}
	r.shown = n
	full := r.compose(n, 0)
	if capChars <= 0 || len(full) <= capChars {
		return full
	}
	if r.List != nil && n > 0 {
		lo, hi := 0, n-1 // largest k in [0, n-1] that fits
		best := -1
		for lo <= hi {
			mid := (lo + hi) / 2
			if len(r.compose(mid, 0)) <= capChars {
				best = mid
				lo = mid + 1
			} else {
				hi = mid - 1
			}
		}
		if best > 0 {
			r.shown = best
			return r.compose(best, 0)
		}
	}
	for _, maxRunes := range []int{160, 64} {
		k := n
		if r.List != nil {
			// Retry with shortened values, again finding the largest k.
			for k > 0 && len(r.compose(k, maxRunes)) > capChars {
				k = k * 3 / 4
			}
		}
		if s := r.compose(k, maxRunes); len(s) <= capChars && (r.List == nil || k > 0 || n == 0) {
			r.shown = k
			return s
		}
	}
	r.shown = 0
	r.tooLarge = true
	return r.TooLargeError().renderError()
}

func (r *Result) head() Fields {
	f := Fs("ok", r.Err == nil, "tool", r.Tool)
	if r.Connection != "" {
		f.Add("connection", r.Connection)
	}
	return f
}

func (r *Result) renderError() string {
	f := r.head()
	e := Fs("code", r.Err.Code, "message", r.Err.Message)
	if r.Err.Hint != "" {
		e.Add("hint", r.Err.Hint)
	}
	e = append(e, r.Err.Extra...)
	f.Add("error", e)
	if len(r.Notes) > 0 {
		f.Add("notes", r.Notes)
	}
	if len(r.Warnings) > 0 {
		f.Add("warnings", r.Warnings)
	}
	b, _ := f.MarshalJSON()
	return string(b)
}

func (r *Result) compose(n, maxRunes int) string {
	f := r.head()
	if r.DataOrigin != "" {
		f.Add("data_origin", r.DataOrigin)
	}
	for _, x := range r.Fields {
		v := x.V
		if maxRunes > 0 {
			v = shortenValue(v, maxRunes)
		}
		f.Add(x.K, v)
	}
	truncated := r.Truncated
	notes := append([]string(nil), r.Notes...)
	if r.List != nil {
		items := r.List.Items[:n]
		if maxRunes > 0 {
			sh := make([]any, len(items))
			for i, it := range items {
				sh[i] = shortenValue(it, maxRunes)
			}
			items = sh
		}
		hasMore := n < len(r.List.Items) || r.List.More
		f.Add("returned", n)
		f.Add("has_more", hasMore)
		if hasMore {
			f.Add("next_offset", r.List.Offset+n)
		}
		f.Add(r.List.Key, items)
		if n < len(r.List.Items) {
			truncated = true
			total := fmt.Sprintf("%d", r.List.Offset+len(r.List.Items))
			if r.List.Total >= 0 {
				total = fmt.Sprintf("%d", r.List.Total)
			} else if r.List.More {
				total += "+"
			}
			notes = append(notes, fmt.Sprintf("Result shortened to fit the context budget (%d of %s shown). Use offset=%d, fewer attributes, or a narrower filter.", n, total, r.List.Offset+n))
		}
	}
	if maxRunes > 0 {
		truncated = true
		notes = append(notes, fmt.Sprintf("Long values were shortened to %d characters to fit the context budget.", maxRunes))
	}
	f.Add("truncated", truncated)
	if notes == nil {
		notes = []string{}
	}
	f.Add("notes", notes)
	w := r.Warnings
	if w == nil {
		w = []string{}
	}
	f.Add("warnings", w)
	b, err := f.MarshalJSON()
	if err != nil {
		return fmt.Sprintf(`{"ok":false,"tool":%q,"error":{"code":"%s","message":"result could not be rendered"}}`, r.Tool, ErrResultTooLarge)
	}
	return string(b)
}

// shortenValue returns a copy of v with every string longer than maxRunes
// runes cut (rune-safe) and marked.
func shortenValue(v any, maxRunes int) any {
	switch x := v.(type) {
	case string:
		return TruncateRunes(x, maxRunes)
	case []string:
		out := make([]string, len(x))
		for i, s := range x {
			out[i] = TruncateRunes(s, maxRunes)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = shortenValue(e, maxRunes)
		}
		return out
	case Fields:
		out := make(Fields, len(x))
		for i, e := range x {
			out[i] = Field{e.K, shortenValue(e.V, maxRunes)}
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = shortenValue(e, maxRunes)
		}
		return out
	case nil, bool, int, int64, float64:
		return x
	default:
		// Structs and other values: round-trip through JSON.
		b, err := json.Marshal(x)
		if err != nil {
			return x
		}
		var g any
		if json.Unmarshal(b, &g) != nil {
			return x
		}
		return shortenValue(g, maxRunes)
	}
}

// TruncateRunes cuts s to n runes plus "…(+N chars)" (rune-safe).
func TruncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + fmt.Sprintf("…(+%d chars)", len(r)-n)
}

// --- per-step result budget (§5.1, §7.3) ---

type budgetKey struct{}

// WithResultBudget attaches the per-call result cap (tokens) to ctx.
func WithResultBudget(ctx context.Context, capTokens int) context.Context {
	return context.WithValue(ctx, budgetKey{}, capTokens)
}

// ResultBudget returns the per-call result cap in tokens (0 = none).
func ResultBudget(ctx context.Context) int {
	v, _ := ctx.Value(budgetKey{}).(int)
	return v
}

// CharsPerToken converts token caps to characters for directory JSON
// (about 2 chars per token, AUDIT §5f).
const CharsPerToken = 2.0

// CapChars returns the result cap in characters (0 = none).
func CapChars(ctx context.Context) int {
	return int(float64(ResultBudget(ctx)) * CharsPerToken)
}

// SummaryLine joins parts into a one-line summary.
func SummaryLine(parts ...string) string {
	var out []string
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, ", ")
}

// Fs builds Fields from alternating keys and values.
func Fs(kv ...any) Fields {
	f := make(Fields, 0, len(kv)/2)
	for i := 0; i+1 < len(kv); i += 2 {
		k, _ := kv[i].(string)
		f = append(f, Field{K: k, V: kv[i+1]})
	}
	return f
}
