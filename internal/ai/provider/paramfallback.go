package provider

import (
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

// Optional request parameters that the unsupported-parameter fallback may
// drop (§3.7). Required parameters (model, messages, tools) never are.
const (
	ParamReasoningEffort     = "reasoning_effort"
	ParamStreamOptions       = "stream_options"
	ParamMaxCompletionTokens = "max_completion_tokens" // dropped → max_tokens
	ParamChatTemplateKwargs  = "chat_template_kwargs"
	ParamThinkLevel          = "think_level" // Ollama: string level → true
	ParamThink               = "think"       // Ollama: omitted
	ParamKeepAlive           = "keep_alive"
	ParamTruncate            = "truncate"
)

// ParamFacts remembers which optional parameters a (provider, model)
// rejected, so later requests skip them.
type ParamFacts interface {
	DroppedParams(cacheKey, model string) map[string]bool
	RecordDroppedParam(cacheKey, model, param string)
}

// memoryParamFacts is an in-memory ParamFacts.
type memoryParamFacts struct {
	mu sync.Mutex
	m  map[string]map[string]bool
}

// NewMemoryParamFacts returns an in-memory ParamFacts.
func NewMemoryParamFacts() ParamFacts { return &memoryParamFacts{m: map[string]map[string]bool{}} }

func (f *memoryParamFacts) DroppedParams(key, model string) map[string]bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]bool{}
	for k, v := range f.m[key+"|"+model] {
		out[k] = v
	}
	return out
}

func (f *memoryParamFacts) RecordDroppedParam(key, model, param string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := key + "|" + model
	if f.m[k] == nil {
		f.m[k] = map[string]bool{}
	}
	f.m[k][param] = true
}

// wireName maps a fallback key to the JSON field name searched for in the
// error text.
func wireName(param string) string {
	switch param {
	case ParamThinkLevel:
		return "think"
	}
	return param
}

// detectUnsupportedParam returns which of the sent optional parameters a
// 400 (or LiteLLM UnsupportedParamsError) names, or "".
func detectUnsupportedParam(err error, sent []string) string {
	var pe *Error
	if !errors.As(err, &pe) || pe.Code == ai.CodeContextExceeded {
		return ""
	}
	unsupported := strings.Contains(pe.Body, "UnsupportedParamsError") || strings.Contains(pe.Message, "UnsupportedParamsError")
	if pe.Status != 400 && pe.Status != 422 && !unsupported {
		return ""
	}
	text := strings.ToLower(pe.Message + " " + pe.Param + " " + pe.Body)
	for _, p := range sent {
		if strings.Contains(text, strings.ToLower(wireName(p))) {
			return p
		}
	}
	return ""
}

// paramFallbackStream runs attempt with the unsupported-parameter fallback:
// a 400 naming an optional parameter that was sent is retried once per
// parameter without it (or with its substitute). It never applies after
// visible output. The fallback does not count as a retry of WithRetry.
func paramFallbackStream(req *Request, facts ParamFacts, cacheKey string, sink func(Event),
	attempt func(dropped map[string]bool, sink func(Event)) (*Response, []string, error)) (*Response, error) {

	dropped := map[string]bool{}
	if facts != nil {
		for k, v := range facts.DroppedParams(cacheKey, req.Model) {
			dropped[k] = v
		}
	}
	for k, v := range req.Dropped {
		if v {
			dropped[k] = true
		}
	}
	for tries := 0; ; tries++ {
		shown, visible := false, false
		wrapped := func(ev Event) {
			switch ev.Kind {
			case EvTextDelta, EvTextReplaced, EvToolUseStart:
				shown, visible = true, true
			case EvThinkingDelta:
				shown = true
			}
			sink(ev)
		}
		resp, sent, err := attempt(dropped, wrapped)
		if err == nil || visible || tries >= 4 {
			return resp, err
		}
		param := detectUnsupportedParam(err, sent)
		if param == "" || dropped[param] {
			return resp, err
		}
		dropped[param] = true
		if facts != nil {
			facts.RecordDroppedParam(cacheKey, req.Model, param)
		}
		if shown {
			sink(Event{Kind: EvDiscarded, Reason: "param_retry"})
		}
		msg := fmt.Sprintf("The server does not support %s; continuing without it.", wireName(param))
		switch param {
		case ParamMaxCompletionTokens:
			msg = "The server does not support max_completion_tokens; using max_tokens instead."
		case ParamThinkLevel:
			msg = "The model does not accept a thinking level; using thinking on/off instead."
		case ParamStreamOptions:
			msg += " Token usage will be estimated."
		case ParamTruncate:
			msg += " LDAPilot's own context budget is the only guard against truncation."
		}
		sink(Event{Kind: EvStatus, Status: &Status{Kind: ai.StatusWarning, Param: wireName(param), Message: msg}})
	}
}
