package ai

// Event names (§3.5). Payloads of run events carry the envelope fields
// chatId, runId, seq and ts. Events without a run (chat_updated,
// models_updated, config_updated, grants_updated) bypass the reducer's
// run/seq checks.
const (
	EventRunStarted       = "ai:run_started"
	EventMessageStarted   = "ai:message_started"
	EventTextDelta        = "ai:text_delta"
	EventThinkingDelta    = "ai:thinking_delta"
	EventTextReplaced     = "ai:text_replaced"
	EventStepDiscarded    = "ai:step_discarded"
	EventToolStart        = "ai:tool_start"
	EventToolUpdate       = "ai:tool_update"
	EventToolEnd          = "ai:tool_end"
	EventApprovalRequest  = "ai:approval_request"
	EventApprovalResolved = "ai:approval_resolved"
	EventSecretAvailable  = "ai:secret_available"
	EventUsage            = "ai:usage"
	EventStatus           = "ai:status"
	EventError            = "ai:error"
	EventDone             = "ai:done"
	EventChatUpdated      = "ai:chat_updated"
	EventModelsUpdated    = "ai:models_updated"
	EventConfigUpdated    = "ai:config_updated"
	EventGrantsUpdated    = "ai:grants_updated"
)

// Status kinds of ai:status.
const (
	StatusRetrying         = "retrying"
	StatusQueued           = "queued"
	StatusModelLoading     = "model_loading"
	StatusProcessingPrompt = "processing_prompt"
	StatusCompacting       = "compacting"
	StatusCompacted        = "compacted"
	StatusFinishingWrite   = "finishing_write"
	StatusTruncatedOutput  = "truncated_output"
	StatusWarning          = "warning"
)

// Emitter delivers events to the UI. The facade wraps Wails'
// runtime.EventsEmit; tests use a recorder.
type Emitter interface {
	Emit(name string, payload any)
}

// ModelsUpdatedEvent is the payload of ai:models_updated.
type ModelsUpdatedEvent struct {
	ProviderKey string         `json:"providerKey"`
	Models      []ModelInfo    `json:"models"`
	Discovery   ModelDiscovery `json:"discovery"`
}

// ConfigUpdatedEvent is the payload of ai:config_updated.
type ConfigUpdatedEvent struct {
	Revision int64 `json:"revision"`
}

// Envelope is carried by every run event (§3.5).
type Envelope struct {
	ChatID string `json:"chatId"`
	RunID  string `json:"runId"`
	Seq    int64  `json:"seq"`
	TS     int64  `json:"ts"`
}

// SetEnvelope sets the envelope of a run event payload.
func (e *Envelope) SetEnvelope(env Envelope) { *e = env }

// Enveloped is implemented by every run event payload (pointer).
type Enveloped interface{ SetEnvelope(Envelope) }

// RunStartedEvent is the payload of ai:run_started.
type RunStartedEvent struct {
	Envelope
	UserMessageID string `json:"userMessageId"`
	Kind          string `json:"kind"`
	Engine        string `json:"engine"`
	Provider      string `json:"provider"`
	Model         string `json:"model"`
	StartedAt     int64  `json:"startedAt"`
}

// MessageStartedEvent is the payload of ai:message_started.
type MessageStartedEvent struct {
	Envelope
	MessageID string `json:"messageId"`
	Step      int    `json:"step"`
	// Model is the model that answers this step when the engine reports it
	// per step (Claude Code: the model of the API message).
	Model string `json:"model,omitempty"`
}

// DeltaEvent is the payload of ai:text_delta, ai:thinking_delta and
// ai:text_replaced (Text is then the complete new text of the block).
type DeltaEvent struct {
	Envelope
	MessageID  string `json:"messageId"`
	BlockIndex int    `json:"blockIndex"`
	Text       string `json:"text"`
}

// StepDiscardedEvent is the payload of ai:step_discarded.
type StepDiscardedEvent struct {
	Envelope
	MessageID string `json:"messageId"`
	Reason    string `json:"reason"` // max_tokens_retry | empty_retry | context_retry | param_retry
}

// Tool call statuses (ai:tool_start, ai:tool_update, ai:tool_end).
const (
	ToolQueued           = "queued"
	ToolRunning          = "running"
	ToolAwaitingApproval = "awaiting_approval"
	ToolFinishingWrite   = "finishing_write"
	ToolOK               = "ok"
	ToolError            = "error"
	ToolDenied           = "denied"
	ToolCancelled        = "cancelled"
	ToolNotExecuted      = "not_executed"
	ToolOutcomeUnknown   = "outcome_unknown"
)

// ToolStartEvent is the payload of ai:tool_start.
type ToolStartEvent struct {
	Envelope
	MessageID       string   `json:"messageId"`
	ToolCallID      string   `json:"toolCallId"`
	Name            string   `json:"name"`
	DisplayName     string   `json:"displayName"`
	Kind            string   `json:"kind"` // read | write
	Args            string   `json:"args"` // validated JSON, invisible characters escaped
	ConnectionID    string   `json:"connectionId"`
	ConnectionLabel string   `json:"connectionLabel"`
	Status          string   `json:"status"`
	Warnings        []string `json:"warnings"`
}

// ToolUpdateEvent is the payload of ai:tool_update.
type ToolUpdateEvent struct {
	Envelope
	ToolCallID string `json:"toolCallId"`
	Status     string `json:"status"`
}

// WriteInfo describes an executed write for UI refreshes.
type WriteInfo struct {
	Op        string `json:"op"`
	DN        string `json:"dn"`
	NewDN     string `json:"newDn,omitempty"`
	ParentDN  string `json:"parentDn,omitempty"`
	ProfileID string `json:"profileId"`
}

// ToolEndEvent is the payload of ai:tool_end.
type ToolEndEvent struct {
	Envelope
	ToolCallID string     `json:"toolCallId"`
	Status     string     `json:"status"`
	DurationMs int64      `json:"durationMs"`
	Summary    string     `json:"summary"`
	Result     string     `json:"result"` // the exact model-facing JSON
	IsError    bool       `json:"isError"`
	ErrorCode  string     `json:"errorCode,omitempty"`
	Warnings   []string   `json:"warnings"`
	DNs        []string   `json:"dns"`
	Write      *WriteInfo `json:"write,omitempty"`
}

// ApprovalResolvedEvent is the payload of ai:approval_resolved.
type ApprovalResolvedEvent struct {
	Envelope
	ApprovalID string `json:"approvalId"`
	ToolCallID string `json:"toolCallId"`
	Decision   string `json:"decision"`
	By         string `json:"by"`
}

// SecretAvailableEvent is the payload of ai:secret_available. It never
// carries the secret.
type SecretAvailableEvent struct {
	Envelope
	ToolCallID string `json:"toolCallId"`
	Kind       string `json:"kind"`
	DN         string `json:"dn"`
	ExpiresAt  int64  `json:"expiresAt"`
}

// UsageEvent is the payload of ai:usage.
type UsageEvent struct {
	Envelope
	Step           int     `json:"step"`
	Usage          Usage   `json:"usage"`
	ContextTokens  int     `json:"contextTokens"`
	ContextWindow  int     `json:"contextWindow"`
	ContextPercent float64 `json:"contextPercent"`
	Totals         Usage   `json:"totals"`
	CostUSD        float64 `json:"costUsd,omitempty"`
	// Turns is the number of model turns of the run (Claude Code result).
	Turns int `json:"turns,omitempty"`
}

// StatusEvent is the payload of ai:status.
type StatusEvent struct {
	Envelope
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Attempt int    `json:"attempt,omitempty"`
	DelayMs int64  `json:"delayMs,omitempty"`
	Param   string `json:"param,omitempty"`
}

// ErrorEvent is the payload of ai:error.
type ErrorEvent struct {
	Envelope
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
	Status    int    `json:"status,omitempty"`
	RequestID string `json:"requestId,omitempty"`
}

// DoneEvent is the payload of ai:done (always the last event of a run).
type DoneEvent struct {
	Envelope
	Status         string `json:"status"`
	FinalMessageID string `json:"finalMessageId,omitempty"`
	DurationMs     int64  `json:"durationMs"`
	Totals         Usage  `json:"totals"`
	CanContinue    bool   `json:"canContinue"`
	ContextEdited  bool   `json:"contextEdited"`
}

// ChatUpdatedEvent is the payload of ai:chat_updated (no run).
type ChatUpdatedEvent struct {
	ChatID       string `json:"chatId"`
	Title        string `json:"title,omitempty"`
	UpdatedAt    int64  `json:"updatedAt"`
	PendingWrite bool   `json:"pendingWrite,omitempty"`
}

// GrantsUpdatedEvent is the payload of ai:grants_updated (no run).
type GrantsUpdatedEvent struct {
	ChatID string  `json:"chatId"`
	Grants []Grant `json:"grants"`
}
