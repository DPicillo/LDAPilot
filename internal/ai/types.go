// Package ai holds LDAPilot's canonical AI types: the provider-neutral
// message model (shaped like Anthropic content blocks, the strictest
// format; adapters translate at the edge), chat/model views shared with the
// frontend, and small injectable interfaces (Clock, IDGen). It depends on
// the standard library only.
package ai

import "encoding/json"

// Role of a message. Only "user" and "assistant" are stored; the system
// prompt is rendered per request.
type Role string

const (
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
)

// BlockType is the type of a content block.
type BlockType string

const (
	BlockText             BlockType = "text"
	BlockThinking         BlockType = "thinking"
	BlockRedactedThinking BlockType = "redacted_thinking"
	BlockToolUse          BlockType = "tool_use"
	BlockToolResult       BlockType = "tool_result"
)

// Block is one content block of a message.
type Block struct {
	Type           BlockType       `json:"type"`
	Text           string          `json:"text,omitempty"`
	Thinking       string          `json:"thinking,omitempty"`       // display text (may be "" when the provider omits it)
	Signature      string          `json:"signature,omitempty"`      // thinking signature; opaque, never edited
	Data           string          `json:"data,omitempty"`           // redacted_thinking payload
	Producer       string          `json:"producer,omitempty"`       // "<provider key>:<model as named in the response>"
	ID             string          `json:"id,omitempty"`             // tool_use: harness toolCallId (lower-case UUIDv4)
	ProviderCallID string          `json:"providerCallId,omitempty"` // tool_use: the ID the provider sent ("" if none)
	Name           string          `json:"name,omitempty"`           // tool_use: normalized tool name
	Input          json.RawMessage `json:"input,omitempty"`          // tool_use: always a JSON object
	ToolUseID      string          `json:"toolUseId,omitempty"`      // tool_result → harness toolCallId
	Content        string          `json:"content,omitempty"`        // tool_result: the string first delivered to the model; never mutated
	IsError        bool            `json:"isError,omitempty"`
	Meta           *BlockMeta      `json:"meta,omitempty"` // harness/UI only; never sent to a provider as such
}

// BlockMeta carries harness and UI data for a block.
type BlockMeta struct {
	Kind            string          `json:"kind,omitempty"` // "context" | "summary" | "continue" | "read" | "write" | "access"
	ConnectionID    string          `json:"connectionId,omitempty"`
	ConnectionLabel string          `json:"connectionLabel,omitempty"`
	DurationMs      int64           `json:"durationMs,omitempty"`
	Summary         string          `json:"summary,omitempty"`
	ErrorCode       string          `json:"errorCode,omitempty"`
	Warnings        []string        `json:"warnings,omitempty"`
	Approval        *ApprovalRecord `json:"approval,omitempty"`
	Synthetic       bool            `json:"synthetic,omitempty"`
	DNs             []string        `json:"dns,omitempty"`
	RawArgs         string          `json:"rawArgs,omitempty"`
	Executing       bool            `json:"executing,omitempty"`
	ExecutingSince  int64           `json:"executingSince,omitempty"`
	ClearedAt       int64           `json:"clearedAt,omitempty"`
	Shrunk          string          `json:"shrunk,omitempty"`
	// ConsentHost is the provider host an @entry mention allowed this read
	// for (ask-level connections without chat consent).
	ConsentHost string `json:"consentHost,omitempty"`
}

// ApprovalRecord stores how a write or access request was decided.
type ApprovalRecord struct {
	Decision    string `json:"decision"`
	By          string `json:"by"`
	At          int64  `json:"at"`
	PreviewHash string `json:"previewHash,omitempty"`
	GrantID     string `json:"grantId,omitempty"`
}

// StopReason of an assistant message.
type StopReason string

const (
	StopEndTurn         StopReason = "end_turn"
	StopToolUse         StopReason = "tool_use"
	StopMaxTokens       StopReason = "max_tokens"
	StopRefusal         StopReason = "refusal"
	StopContextExceeded StopReason = "context_exceeded"
	StopSequence        StopReason = "stop_sequence"
	StopCancelled       StopReason = "cancelled"
	StopError           StopReason = "error"
	StopUnknown         StopReason = "unknown"
)

// Message is one stored chat message.
type Message struct {
	ID         string     `json:"id"`
	Role       Role       `json:"role"`
	Blocks     []Block    `json:"blocks"`
	CreatedAt  int64      `json:"createdAt"` // unix ms
	RunID      string     `json:"runId,omitempty"`
	Provider   string     `json:"provider,omitempty"` // assistant: provider kind actually used
	Model      string     `json:"model,omitempty"`    // assistant: model reported by the response
	StopReason StopReason `json:"stopReason,omitempty"`
	Usage      *Usage     `json:"usage,omitempty"`
	Partial    bool       `json:"partial,omitempty"`
	Truncated  bool       `json:"truncated,omitempty"`
	Error      *RunError  `json:"error,omitempty"`
	UIContext  *UIContext `json:"uiContext,omitempty"`
}

// Usage is token usage of a step or a total.
type Usage struct {
	InputTokens      int     `json:"inputTokens"`
	OutputTokens     int     `json:"outputTokens"`
	CacheReadTokens  int     `json:"cacheReadTokens"`
	CacheWriteTokens int     `json:"cacheWriteTokens"`
	ReasoningTokens  int     `json:"reasoningTokens"`
	CostUSD          float64 `json:"costUsd,omitempty"` // only when the provider reports it (Claude Code)
}

// Add accumulates u2 into u.
func (u *Usage) Add(u2 Usage) {
	u.InputTokens += u2.InputTokens
	u.OutputTokens += u2.OutputTokens
	u.CacheReadTokens += u2.CacheReadTokens
	u.CacheWriteTokens += u2.CacheWriteTokens
	u.ReasoningTokens += u2.ReasoningTokens
	u.CostUSD += u2.CostUSD
}

// UIContext is the frontend state sent with a user message.
type UIContext struct {
	ActiveProfileID   string    `json:"activeProfileId"`
	SelectedDN        string    `json:"selectedDn"`
	SelectedProfileID string    `json:"selectedProfileId"`
	Mentions          []Mention `json:"mentions"`
	Locale            string    `json:"locale"`
	TimeZone          string    `json:"timeZone"`
}

// Mention is an @entry reference from the composer.
type Mention struct {
	ProfileID string `json:"profileId"`
	DN        string `json:"dn"`
}

// RunError describes why a run or step failed.
type RunError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
	Status    int    `json:"status,omitempty"`
	RequestID string `json:"requestId,omitempty"`
}

func (e *RunError) Error() string { return e.Message }

// Error codes used in RunError.Code and ai:error events.
const (
	CodeConfigMissing       = "config_missing"
	CodeProviderUnreachable = "provider_unreachable"
	CodeAuthFailed          = "auth_failed"
	CodeModelNotFound       = "model_not_found"
	CodeRateLimited         = "rate_limited"
	CodeOverloaded          = "overloaded"
	CodeContextExceeded     = "context_exceeded"
	CodeContextTooSmall     = "context_too_small"
	CodeContextTruncated    = "context_truncated"
	CodeBadRequest          = "bad_request"
	CodeTimeout             = "timeout"
	CodeStreamInterrupted   = "stream_interrupted"
	CodeRunActive           = "run_active"
	CodeBusy                = "busy"
	CodeInvalidChatID       = "invalid_chat_id"
	CodeMessageTooLarge     = "message_too_large"
	CodeStoreUnavailable    = "store_unavailable"
	CodeStoreReadOnly       = "store_read_only"
	CodeInternal            = "internal"
	// CodeBudgetExceeded: the Claude Code engine reached the per-message
	// budget (--max-budget-usd).
	CodeBudgetExceeded = "budget_exceeded"
	// CodeCancelled: AIService.CheckProvider was stopped (CancelProviderCheck).
	CodeCancelled = "cancelled"
)

// ChatSummary is one row of the chat list.
type ChatSummary struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	CreatedAt    int64  `json:"createdAt"`
	UpdatedAt    int64  `json:"updatedAt"`
	MessageCount int    `json:"messageCount"`
	Model        string `json:"model"`
	Usage        Usage  `json:"usage"`
	Running      bool   `json:"running"`
	Corrupt      bool   `json:"corrupt"`
	PendingWrite bool   `json:"pendingWrite"`
	Note         string `json:"note,omitempty"` // e.g. why a chat is corrupt
}

// ChatView is a full chat for the UI.
type ChatView struct {
	ChatSummary
	ModelOverride string             `json:"modelOverride"`
	Messages      []Message          `json:"messages"`
	Compactions   []CompactionMarker `json:"compactions"`
	Egress        []EgressRecord     `json:"egress"`
	ReadOnly      bool               `json:"readOnly"` // second app instance
}

// CompactionMarker records one compaction of a chat's history.
type CompactionMarker struct {
	ID               string `json:"id"`
	At               int64  `json:"at"`
	SummaryMessageID string `json:"summaryMessageId"`
	UpToMessageID    string `json:"upToMessageId"` // last message folded into the summary
	TokensBefore     int    `json:"tokensBefore"`
	TokensAfter      int    `json:"tokensAfter"`
	Summary          string `json:"summary"` // neutralized summary text (sent to the model, framed)
	Model            string `json:"model,omitempty"`
	Chunks           int    `json:"chunks,omitempty"`
	// Connections are the profiles whose data the summary may contain
	// (results folded into it, labels it names); it is withheld from a
	// destination that may not see one of them (§6.1).
	Connections []string `json:"connections,omitempty"`
}

// EgressRecord aggregates what a chat sent to a provider host per profile.
type EgressRecord struct {
	ProfileID    string `json:"profileId"`
	ProviderHost string `json:"providerHost"`
	Remote       bool   `json:"remote"`
	ToolResults  int    `json:"toolResults"`
	Bytes        int64  `json:"bytes"`
	FirstAt      int64  `json:"firstAt"`
	LastAt       int64  `json:"lastAt"`
}

// Calibration is the per-chat estimator correction factor (§7.1).
type Calibration struct {
	Provider string  `json:"provider"`
	Model    string  `json:"model"`
	K        float64 `json:"k"`
}
