// Package provider talks to model endpoints: OpenAI-compatible servers
// (OpenAI, LiteLLM, vLLM, LM Studio, Ollama /v1), Ollama's native API and
// the Anthropic Messages API. Each adapter streams one model response,
// translating the canonical ai.Message history to the wire format and the
// wire events back to canonical blocks and sink events. Retries, endpoint
// limits, unsupported-parameter fallback and model discovery live here too.
package provider

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
)

// Provider kinds.
const (
	KindOpenAI    = "openai"
	KindOllama    = "ollama"
	KindAnthropic = "anthropic"
)

// OpenAI-compatible flavors.
const (
	FlavorOpenAI   = "openai"
	FlavorLiteLLM  = "litellm"
	FlavorOllama   = "ollama"
	FlavorVLLM     = "vllm"
	FlavorLMStudio = "lmstudio"
	FlavorCustom   = "custom"
)

// Provider streams model responses and lists models.
type Provider interface {
	// Kind returns "openai", "ollama" or "anthropic".
	Kind() string
	// Key returns the provider key used in Block.Producer and caches:
	// "openai/<flavor>", "ollama" or "anthropic".
	Key() string
	// Stream sends one request and streams the response. sink is called
	// from the calling goroutine only (never concurrently).
	Stream(ctx context.Context, req *Request, sink func(Event)) (*Response, error)
	// ListModels discovers the models of the endpoint.
	ListModels(ctx context.Context) ([]ai.ModelInfo, error)
	// ModelCaps returns the capabilities of a model (cached discovery plus
	// static tables).
	ModelCaps(ctx context.Context, model string) (Caps, error)
}

// Request is one provider call.
type Request struct {
	Model           string
	System          string       // frozen per prompt version
	Messages        []ai.Message // normalized and rendered; adapters never read Meta
	Tools           []tools.Spec // deterministic order; nil for tool-less requests
	ToolLess        bool         // compaction/titles: Messages is flattened into one user message
	MaxOutputTokens int
	Thinking        string // "" auto | off | low | medium | high
	ShowThinking    bool
	Effort          string          // anthropic
	ContextWindow   int             // ollama num_ctx
	TurnStartIndex  int             // index of the first message of the current user turn
	Dropped         map[string]bool // optional parameters to omit (unsupported-parameter cache)
}

// EventKind is the kind of a streaming event.
type EventKind int

const (
	EvTextDelta EventKind = iota + 1
	EvThinkingDelta
	EvTextReplaced // Text holds the complete new text of BlockIndex
	EvToolUseStart
	EvUsage
	EvWarning
	EvStatus
	EvDiscarded // everything streamed so far in this step is void (Reason says why)
)

// Event is emitted while a response streams.
type Event struct {
	Kind       EventKind
	BlockIndex int
	Text       string
	ToolName   string
	Usage      *ai.Usage
	Warning    string
	Status     *Status
	Reason     string
}

// Status is an informational status for ai:status.
type Status struct {
	Kind    string
	Message string
	Attempt int
	DelayMs int64
	Param   string
}

// Response is a complete (or partial, on error) model response.
type Response struct {
	Message    ai.Message // assistant; tool_use blocks carry ProviderCallID, normalized Name and Input
	StopReason ai.StopReason
	Usage      ai.Usage
	Model      string // as reported by the server
	RequestID  string
	Complete   bool     // a terminal marker was seen
	Warnings   []string // e.g. "stream ended without [DONE]", "salvaged_text_tool_call"
	Refusal    string   // refusal category/explanation, when StopReason is refusal
}

// Caps are the capabilities of a model.
type Caps struct {
	ContextWindow int // effective window the harness should budget for (0 = unknown)
	MaxContext    int // the model's maximum (trained) context
	MaxOutput     int
	Tools         string // ai.CapYes | CapNo | CapUnknown
	Vision        string
	Thinking      string
	ThinkingModes []string
	EffortLevels  []string
	Source        string // where ContextWindow came from: "config", "api/ps", "api/show", "models", "table", "default", …
	Remote        bool
	// Listed is set when the caps come from the provider's model listing
	// (the model exists); false for defaults, overrides of unknown models
	// and static tables.
	Listed bool
}

// Error is a provider error. Code is one of the ai.Code* values.
type Error struct {
	Status        int
	Code          string
	Type          string
	Message       string
	RequestID     string
	Param         string
	Retryable     bool
	RetryAfter    time.Duration
	ContextTokens int
	// Body holds the (truncated, scrubbed) raw error body, for parameter
	// detection and diagnostics. Never shown to the user.
	Body string
	err  error
}

// ErrContextExceeded is wrapped by *Error when the prompt does not fit.
var ErrContextExceeded = errors.New("context exceeded")

func (e *Error) Error() string {
	msg := e.Message
	if msg == "" {
		msg = e.Code
	}
	if e.Status > 0 {
		return fmt.Sprintf("%s (HTTP %d)", msg, e.Status)
	}
	return msg
}

func (e *Error) Unwrap() error {
	if e.err != nil {
		return e.err
	}
	if e.Code == ai.CodeContextExceeded {
		return ErrContextExceeded
	}
	return nil
}

// RunError converts the error into the event/UI shape.
func (e *Error) RunError() *ai.RunError {
	return &ai.RunError{Code: e.Code, Message: e.Message, Retryable: e.Retryable, Status: e.Status, RequestID: e.RequestID}
}

// AsRunError maps any error from a provider call to a RunError.
func AsRunError(err error) *ai.RunError {
	if err == nil {
		return nil
	}
	var pe *Error
	if errors.As(err, &pe) {
		return pe.RunError()
	}
	if errors.Is(err, context.Canceled) {
		return &ai.RunError{Code: ai.CodeInternal, Message: "cancelled"}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &ai.RunError{Code: ai.CodeTimeout, Message: "The request timed out.", Retryable: true}
	}
	return &ai.RunError{Code: ai.CodeInternal, Message: err.Error()}
}

// ProducerKey returns the provider-key part of a Block.Producer value.
func ProducerKey(producer string) string {
	for i := 0; i < len(producer); i++ {
		if producer[i] == ':' {
			return producer[:i]
		}
	}
	return producer
}

// Producer builds a Block.Producer value.
func Producer(providerKey, model string) string { return providerKey + ":" + model }
