package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"sort"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
)

// openAI is the OpenAI-compatible Chat Completions adapter (flavors
// openai, litellm, ollama, vllm, lmstudio, custom).
type openAI struct {
	common
	ollamaRT *ollamaRuntime // flavor ollama (or port 11434 on loopback)
}

func newOpenAI(o Options) *openAI {
	p := &openAI{common: newCommon(o)}
	if o.Flavor == FlavorOllama || (p.http.loop && isOllamaPort(o.BaseURL)) {
		p.ollamaRT = newOllamaRuntime(strings.TrimSuffix(o.BaseURL, "/v1"), &p.http)
	}
	return p
}

func (p *openAI) Kind() string { return KindOpenAI }

// --- request ---

type oaRequest struct {
	Model               string           `json:"model"`
	Messages            []oaMessage      `json:"messages"`
	Tools               []oaTool         `json:"tools,omitempty"`
	Stream              bool             `json:"stream"`
	StreamOptions       *oaStreamOptions `json:"stream_options,omitempty"`
	MaxTokens           int              `json:"max_tokens,omitempty"`
	MaxCompletionTokens int              `json:"max_completion_tokens,omitempty"`
	ReasoningEffort     string           `json:"reasoning_effort,omitempty"`
	ChatTemplateKwargs  map[string]any   `json:"chat_template_kwargs,omitempty"`
}

type oaStreamOptions struct {
	IncludeUsage bool `json:"include_usage"`
}

type oaMessage struct {
	Role           string             `json:"role"`
	Content        string             `json:"content"`
	ToolCalls      []oaToolCall       `json:"tool_calls,omitempty"`
	ToolCallID     string             `json:"tool_call_id,omitempty"`
	ThinkingBlocks []oaThinkingOutput `json:"thinking_blocks,omitempty"`
}

type oaToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type oaTool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description,omitempty"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function"`
}

type oaThinkingOutput struct {
	Type      string `json:"type"`
	Thinking  string `json:"thinking,omitempty"`
	Signature string `json:"signature,omitempty"`
	Data      string `json:"data,omitempty"`
}

func specsToOpenAI(specs []tools.Spec) []oaTool {
	out := make([]oaTool, 0, len(specs))
	for _, s := range specs {
		var t oaTool
		t.Type = "function"
		t.Function.Name = s.Name
		t.Function.Description = s.Description
		t.Function.Parameters = s.Parameters
		if len(t.Function.Parameters) == 0 {
			t.Function.Parameters = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		out = append(out, t)
	}
	return out
}

// buildBody renders the request and returns the optional parameters sent.
func (p *openAI) buildBody(req *Request, dropped map[string]bool) ([]byte, []string, error) {
	flavor := p.opts.Flavor
	body := oaRequest{Model: req.Model, Stream: true}
	var sent []string

	msgs := req.Messages
	if req.ToolLess {
		msgs = flattenedMessages(msgs)
	}
	style := idStyleFor(KindOpenAI, req.Model, p.opts.ToolCallIDStyle)
	ids := buildWireIDs(msgs, style, p.key)
	if req.System != "" {
		body.Messages = append(body.Messages, oaMessage{Role: "system", Content: req.System})
	}
	producer := p.currentProducer(req.Model)
	for mi, m := range msgs {
		switch m.Role {
		case ai.RoleAssistant:
			om := oaMessage{Role: "assistant", Content: joinText(m)}
			for bi, b := range m.Blocks {
				if b.Type == ai.BlockToolUse && !req.ToolLess {
					var tc oaToolCall
					tc.ID = ids.forUse(b, mi, bi)
					tc.Type = "function"
					tc.Function.Name = b.Name
					tc.Function.Arguments = compactJSON(b.Input)
					om.ToolCalls = append(om.ToolCalls, tc)
				}
			}
			if flavor == FlavorLiteLLM && mi >= req.TurnStartIndex && !req.ToolLess {
				for _, b := range m.Blocks {
					switch {
					case b.Type == ai.BlockThinking && b.Signature != "" && b.Producer == producer:
						om.ThinkingBlocks = append(om.ThinkingBlocks, oaThinkingOutput{Type: "thinking", Thinking: b.Thinking, Signature: b.Signature})
					case b.Type == ai.BlockRedactedThinking && b.Data != "" && b.Producer == producer:
						om.ThinkingBlocks = append(om.ThinkingBlocks, oaThinkingOutput{Type: "redacted_thinking", Data: b.Data})
					}
				}
			}
			if om.Content == "" && len(om.ToolCalls) == 0 && len(om.ThinkingBlocks) == 0 {
				continue
			}
			body.Messages = append(body.Messages, om)
		default:
			for _, b := range m.Blocks {
				if b.Type == ai.BlockToolResult && !req.ToolLess {
					body.Messages = append(body.Messages, oaMessage{Role: "tool", ToolCallID: ids.forResult(b.ToolUseID), Content: b.Content})
				}
			}
			if t := joinText(m); t != "" {
				body.Messages = append(body.Messages, oaMessage{Role: "user", Content: t})
			}
		}
	}
	if !req.ToolLess && len(req.Tools) > 0 {
		body.Tools = specsToOpenAI(req.Tools)
	}
	if !dropped[ParamStreamOptions] {
		body.StreamOptions = &oaStreamOptions{IncludeUsage: true}
		sent = append(sent, ParamStreamOptions)
	}
	if req.MaxOutputTokens > 0 {
		if flavor == FlavorOpenAI && !dropped[ParamMaxCompletionTokens] {
			body.MaxCompletionTokens = req.MaxOutputTokens
			sent = append(sent, ParamMaxCompletionTokens)
		} else {
			body.MaxTokens = req.MaxOutputTokens
		}
	}
	switch req.Thinking {
	case "low", "medium", "high":
		if (flavor == FlavorOpenAI || flavor == FlavorLiteLLM || flavor == FlavorOllama) && !dropped[ParamReasoningEffort] {
			body.ReasoningEffort = req.Thinking
			sent = append(sent, ParamReasoningEffort)
		}
	case "off":
		switch flavor {
		case FlavorOllama:
			if !dropped[ParamReasoningEffort] {
				body.ReasoningEffort = "none"
				sent = append(sent, ParamReasoningEffort)
			}
		case FlavorVLLM:
			if !dropped[ParamChatTemplateKwargs] {
				body.ChatTemplateKwargs = map[string]any{"enable_thinking": false}
				sent = append(sent, ParamChatTemplateKwargs)
			}
		}
	}
	data, err := json.Marshal(body)
	return data, sent, err
}

func compactJSON(raw json.RawMessage) string {
	if len(bytes.TrimSpace(raw)) == 0 {
		return "{}"
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return "{}"
	}
	return buf.String()
}

// --- streaming ---

func (p *openAI) Stream(ctx context.Context, req *Request, sink func(Event)) (*Response, error) {
	if req.Model == "" {
		return nil, &Error{Code: ai.CodeConfigMissing, Message: "No model is selected."}
	}
	return paramFallbackStream(req, p.opts.Params, p.cacheKey, sink, func(dropped map[string]bool, sink func(Event)) (*Response, []string, error) {
		body, sent, err := p.buildBody(req, dropped)
		if err != nil {
			return nil, sent, err
		}
		resp, err := p.streamOnce(ctx, req, body, dropped, sink)
		return resp, sent, err
	})
}

func (p *openAI) streamOnce(ctx context.Context, req *Request, body []byte, dropped map[string]bool, sink func(Event)) (*Response, error) {
	release, err := p.acquire(ctx, sink)
	if err != nil {
		return nil, err
	}
	defer release()

	var before func() func()
	if p.ollamaRT != nil && p.http.loop {
		p.ollamaRT.preflightStatus(ctx, req.Model, sink)
		before = func() func() { return p.ollamaRT.firstByteStatus(ctx, req.Model, sink) }
	}
	c, err := p.http.do(ctx, func(cctx context.Context) (*http.Request, error) {
		r, err := http.NewRequestWithContext(cctx, http.MethodPost, p.opts.BaseURL+"/chat/completions", bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Accept", "text/event-stream")
		if p.opts.APIKey != "" {
			r.Header.Set("Authorization", "Bearer "+p.opts.APIKey)
		}
		return r, nil
	}, before)
	if err != nil {
		return nil, err
	}
	defer c.close()

	st := &oaState{
		p:      p,
		req:    req,
		b:      newStepBuilder(sink, p.key, offeredTools(req), p.knownThinker(req.Model), true),
		sink:   sink,
		byIdx:  map[int]*oaCall{},
		model:  req.Model,
		thinkB: map[int]*oaThinkingOutput{},
	}
	st.reqID = requestID(c.resp.Header)
	if dropped[ParamStreamOptions] {
		st.warnings = append(st.warnings, "usage not reported by the server (stream_options unsupported); estimated")
	}

	ct, _, _ := mime.ParseMediaType(c.resp.Header.Get("Content-Type"))
	if ct == "application/json" {
		data, rerr := io.ReadAll(io.LimitReader(c.body, maxJSONBody))
		if rerr != nil {
			return nil, c.streamErr(ctx, rerr, p.http.scrub)
		}
		if err := st.nonStream(data); err != nil {
			return nil, err
		}
		return st.finish(true)
	}

	sse := newSSEReader(c.body)
	for {
		data, rerr := sse.next()
		if rerr != nil {
			if errors.Is(rerr, io.EOF) {
				break
			}
			return st.partial(), c.streamErr(ctx, rerr, p.http.scrub)
		}
		if string(data) == "[DONE]" {
			st.done = true
			break
		}
		if err := st.chunk(data); err != nil {
			return st.partial(), err
		}
	}
	if ctx.Err() != nil {
		return st.partial(), ctx.Err()
	}
	if !st.done && !st.sawFinish {
		return st.partial(), interruptedError(nil, p.http.scrub)
	}
	return st.finish(false)
}

func offeredTools(req *Request) []tools.Spec {
	if req.ToolLess {
		return nil
	}
	return req.Tools
}

type oaChunk struct {
	ID      string          `json:"id"`
	Model   string          `json:"model"`
	Choices []oaChoice      `json:"choices"`
	Usage   *oaUsage        `json:"usage"`
	Error   json.RawMessage `json:"error"`
}

type oaChoice struct {
	Index        int      `json:"index"`
	Delta        *oaDelta `json:"delta"`
	Message      *oaDelta `json:"message"`
	FinishReason *string  `json:"finish_reason"`
}

type oaDelta struct {
	Role             string             `json:"role"`
	Content          *string            `json:"content"`
	Reasoning        *string            `json:"reasoning"`
	ReasoningContent *string            `json:"reasoning_content"`
	Refusal          *string            `json:"refusal"`
	ToolCalls        []oaToolCallDelta  `json:"tool_calls"`
	ThinkingBlocks   []oaThinkingDeltaB `json:"thinking_blocks"`
}

type oaThinkingDeltaB struct {
	Index     *int   `json:"index"`
	Type      string `json:"type"`
	Thinking  string `json:"thinking"`
	Signature string `json:"signature"`
	Data      string `json:"data"`
}

type oaToolCallDelta struct {
	Index    *int   `json:"index"`
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"function"`
}

type oaUsage struct {
	PromptTokens        int `json:"prompt_tokens"`
	CompletionTokens    int `json:"completion_tokens"`
	PromptTokensDetails *struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	CompletionTokensDetails *struct {
		ReasoningTokens int `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
}

type oaCall struct {
	id, name string
	args     strings.Builder // per-fragment decoded (fallback)
	argsRaw  []byte          // escaped JSON string body, concatenated
	argsObj  json.RawMessage
	started  bool
}

// argString decodes the concatenated escaped argument fragments.
func (c *oaCall) argString() string {
	if len(c.argsRaw) > 0 {
		var s string
		quoted := make([]byte, 0, len(c.argsRaw)+2)
		quoted = append(append(append(quoted, '"'), c.argsRaw...), '"')
		if json.Unmarshal(quoted, &s) == nil {
			return s
		}
	}
	return c.args.String()
}

type oaState struct {
	p         *openAI
	req       *Request
	b         *stepBuilder
	sink      func(Event)
	calls     []*oaCall
	byIdx     map[int]*oaCall
	finishStr string
	sawFinish bool
	done      bool
	refusal   bool
	usage     *ai.Usage
	model     string
	reqID     string
	thinkB    map[int]*oaThinkingOutput
	thinkOrd  []int
	warnings  []string
	badChunks int
}

func (st *oaState) chunk(data []byte) error {
	var ch oaChunk
	if err := json.Unmarshal(data, &ch); err != nil {
		st.badChunks++
		if st.badChunks == 1 {
			st.warnings = append(st.warnings, "ignored a malformed stream chunk")
		}
		return nil
	}
	if len(ch.Error) > 0 && string(ch.Error) != "null" {
		return streamError(data, st.p.http.scrub, st.reqID)
	}
	if ch.Model != "" {
		st.model = ch.Model
	}
	if ch.Usage != nil {
		st.usage = usageFromOpenAI(ch.Usage)
	}
	for _, c := range ch.Choices {
		if c.Index != 0 {
			continue
		}
		d := c.Delta
		if d == nil {
			d = c.Message
		}
		if d != nil {
			st.delta(d)
		}
		if c.FinishReason != nil && *c.FinishReason != "" {
			st.finishStr = *c.FinishReason
			st.sawFinish = true
		}
	}
	return nil
}

func (st *oaState) nonStream(data []byte) error {
	var ch oaChunk
	if err := json.Unmarshal(data, &ch); err != nil {
		return &Error{Code: ai.CodeBadRequest, Message: "The server returned an unreadable response."}
	}
	if len(ch.Error) > 0 && string(ch.Error) != "null" {
		return streamError(data, st.p.http.scrub, st.reqID)
	}
	if err := st.chunk(data); err != nil {
		return err
	}
	st.done = true
	return nil
}

func (st *oaState) delta(d *oaDelta) {
	switch {
	case d.Reasoning != nil && *d.Reasoning != "":
		st.b.reasoningText(*d.Reasoning)
	case d.ReasoningContent != nil && *d.ReasoningContent != "":
		st.b.reasoningText(*d.ReasoningContent)
	}
	for i, tb := range d.ThinkingBlocks {
		idx := i
		if tb.Index != nil {
			idx = *tb.Index
		}
		cur := st.thinkB[idx]
		if cur == nil {
			cur = &oaThinkingOutput{Type: "thinking"}
			st.thinkB[idx] = cur
			st.thinkOrd = append(st.thinkOrd, idx)
		}
		if tb.Type != "" {
			cur.Type = tb.Type
		}
		cur.Thinking += tb.Thinking
		if tb.Signature != "" {
			cur.Signature += tb.Signature
		}
		if tb.Data != "" {
			cur.Data = tb.Data
		}
	}
	if d.Content != nil && *d.Content != "" {
		st.b.content(*d.Content)
	}
	if d.Refusal != nil && *d.Refusal != "" {
		st.refusal = true
		st.b.appendText(*d.Refusal)
	}
	for _, tc := range d.ToolCalls {
		var c *oaCall
		switch {
		case tc.Index != nil:
			c = st.byIdx[*tc.Index]
			if c == nil {
				c = &oaCall{}
				st.byIdx[*tc.Index] = c
				st.calls = append(st.calls, c)
			}
		case tc.ID != "":
			for _, x := range st.calls {
				if x.id == tc.ID {
					c = x
				}
			}
			if c == nil {
				c = &oaCall{}
				st.calls = append(st.calls, c)
			}
		case len(st.calls) > 0:
			c = st.calls[len(st.calls)-1]
		default:
			c = &oaCall{}
			st.calls = append(st.calls, c)
		}
		if tc.ID != "" && c.id == "" {
			c.id = tc.ID
		}
		if tc.Function.Name != "" && c.name == "" {
			c.name = tc.Function.Name
		}
		if a := bytes.TrimSpace(tc.Function.Arguments); len(a) > 0 && string(a) != "null" {
			switch a[0] {
			case '"':
				// Keep the escaped string body: a fragment may end inside a
				// UTF-8 sequence or between surrogate halves, so the whole
				// string is decoded once at the end.
				if len(a) >= 2 && a[len(a)-1] == '"' {
					c.argsRaw = append(c.argsRaw, a[1:len(a)-1]...)
				}
				var s string
				if json.Unmarshal(a, &s) == nil {
					c.args.WriteString(s)
				}
			case '{':
				c.argsObj = append(json.RawMessage(nil), a...)
			}
		}
		if !c.started && c.name != "" {
			c.started = true
			name, _ := tools.Resolve(c.name, offeredTools(st.req))
			st.sink(Event{Kind: EvToolUseStart, ToolName: name})
		}
	}
}

func usageFromOpenAI(u *oaUsage) *ai.Usage {
	out := &ai.Usage{InputTokens: u.PromptTokens, OutputTokens: u.CompletionTokens}
	if u.PromptTokensDetails != nil {
		out.CacheReadTokens = u.PromptTokensDetails.CachedTokens
	}
	if u.CompletionTokensDetails != nil {
		out.ReasoningTokens = u.CompletionTokensDetails.ReasoningTokens
	}
	return out
}

// partial returns what arrived so far (for cancel/error persistence).
func (st *oaState) partial() *Response {
	st.b.think.flush()
	st.b.reasoning.flush()
	_, held := st.b.hold.finish()
	st.b.appendText(held)
	st.b.hold = newHoldBack(false, st.b.appendText)
	return &Response{Message: ai.Message{Role: ai.RoleAssistant, Blocks: st.b.message(), Model: st.model, Partial: true}, Model: st.model, RequestID: st.reqID, StopReason: ai.StopError}
}

func (st *oaState) finish(nonStream bool) (*Response, error) {
	p := st.p
	p.noteResponseModel(st.req.Model, st.model)
	native := false
	for _, c := range st.calls {
		if c.name != "" || c.args.Len() > 0 || len(c.argsRaw) > 0 || len(c.argsObj) > 0 {
			native = true
		}
	}
	st.b.finish(st.model, native)
	for _, c := range st.calls {
		if c.name == "" && c.args.Len() == 0 && len(c.argsRaw) == 0 && len(c.argsObj) == 0 {
			continue
		}
		var args normalizedArgs
		if len(c.argsObj) > 0 {
			args = normalizeArgValue(c.argsObj)
		} else {
			args = normalizeArgString(c.argString())
		}
		st.b.addToolUse(toolUseBlock(p.key, st.model, c.id, c.name, args, offeredTools(st.req)))
	}
	blocks := st.b.message()
	if len(st.thinkOrd) > 0 {
		// LiteLLM thinking_blocks carry signatures: they replace the
		// reasoning_content text used for the live display.
		sort.Ints(st.thinkOrd)
		var signed []ai.Block
		for _, i := range st.thinkOrd {
			t := st.thinkB[i]
			if t.Type == "redacted_thinking" {
				signed = append(signed, ai.Block{Type: ai.BlockRedactedThinking, Data: t.Data, Producer: Producer(p.key, st.model)})
			} else {
				signed = append(signed, ai.Block{Type: ai.BlockThinking, Thinking: t.Thinking, Signature: t.Signature, Producer: Producer(p.key, st.model)})
			}
		}
		var rest []ai.Block
		for _, b := range blocks {
			if b.Type != ai.BlockThinking {
				rest = append(rest, b)
			}
		}
		blocks = append(signed, rest...)
	}
	hasCalls := false
	for _, b := range blocks {
		if b.Type == ai.BlockToolUse {
			hasCalls = true
		}
	}
	resp := &Response{
		Message:   ai.Message{Role: ai.RoleAssistant, Blocks: blocks, Model: st.model, Provider: KindOpenAI},
		Model:     st.model,
		RequestID: st.reqID,
		Complete:  true,
		Warnings:  append(st.warnings, st.b.warnings...),
	}
	switch strings.ToLower(st.finishStr) {
	case "tool_calls", "function_call":
		resp.StopReason = ai.StopToolUse
	case "stop", "eos", "end_turn":
		resp.StopReason = ai.StopEndTurn
		if hasCalls {
			resp.StopReason = ai.StopToolUse
		}
	case "length", "max_tokens":
		resp.StopReason = ai.StopMaxTokens
	case "content_filter":
		resp.StopReason = ai.StopRefusal
	case "":
		if hasCalls {
			resp.StopReason = ai.StopToolUse
		} else {
			resp.StopReason = ai.StopEndTurn
		}
		if !nonStream {
			resp.Warnings = append(resp.Warnings, "stream ended without a finish reason")
		}
	default:
		resp.StopReason = ai.StopUnknown
		resp.Warnings = append(resp.Warnings, "unknown finish reason "+st.finishStr)
	}
	if st.refusal {
		resp.StopReason = ai.StopRefusal
	}
	if !st.done && !nonStream {
		resp.Warnings = append(resp.Warnings, "stream ended without [DONE]; usage may be missing")
	}
	if st.usage != nil {
		resp.Usage = *st.usage
		u := *st.usage
		st.sink(Event{Kind: EvUsage, Usage: &u})
	}
	resp.Message.StopReason = resp.StopReason
	u := resp.Usage
	resp.Message.Usage = &u
	return resp, nil
}

// --- discovery ---

var nonChatModelRe = regexp.MustCompile(`(?i)^(text-embedding|embedding|tts-|whisper|dall-e|gpt-image|omni-moderation|text-moderation|davinci-002|babbage-002)`)

type oaModelList struct {
	Data []struct {
		ID          string `json:"id"`
		OwnedBy     string `json:"owned_by"`
		MaxModelLen int    `json:"max_model_len"` // vLLM
		Type        string `json:"type"`          // LM Studio
	} `json:"data"`
}

func (p *openAI) authHeaders() map[string]string {
	if p.opts.APIKey == "" {
		return nil
	}
	return map[string]string{"Authorization": "Bearer " + p.opts.APIKey}
}

func (p *openAI) ListModels(ctx context.Context) ([]ai.ModelInfo, error) {
	if p.opts.Flavor == FlavorOllama && p.ollamaRT != nil {
		// Ollama /v1: the native API knows capabilities and context sizes.
		if models, err := p.ollamaRT.listModels(ctx); err == nil {
			p.storeModels(models, func(m ai.ModelInfo) Caps { return capsFromInfo(m, "api/show", p.opts.ContextWindow) })
			return models, nil
		}
	}
	var list oaModelList
	if err := p.http.getJSON(ctx, http.MethodGet, p.opts.BaseURL+"/models", nil, p.authHeaders(), &list); err != nil {
		return nil, err
	}
	var models []ai.ModelInfo
	for _, d := range list.Data {
		if d.ID == "" || nonChatModelRe.MatchString(d.ID) || strings.EqualFold(d.Type, "embeddings") {
			continue
		}
		m := ai.ModelInfo{ID: d.ID, DisplayName: d.ID, Tools: ai.CapUnknown, Vision: ai.CapUnknown, Thinking: ai.CapUnknown, Note: d.OwnedBy}
		if p.opts.Flavor == FlavorOllama && isCloudModel(d.ID) {
			m.Remote = true // Ollama cloud model listed through /v1 only
		}
		if d.MaxModelLen > 0 {
			m.ContextWindow, m.ContextSource = d.MaxModelLen, "models"
		}
		if p.opts.Flavor == FlavorOpenAI {
			if t, ok := openAIModelTable(d.ID); ok {
				m.ContextWindow, m.MaxOutput, m.ContextSource = t.ctx, t.out, "table"
				m.Tools, m.Vision, m.Thinking = t.tools, t.vision, t.thinking
			}
		}
		models = append(models, m)
	}
	switch p.opts.Flavor {
	case FlavorLiteLLM:
		p.enrichLiteLLM(ctx, models)
	case FlavorLMStudio:
		p.enrichLMStudio(ctx, models)
	}
	sort.SliceStable(models, func(i, j int) bool { return models[i].ID < models[j].ID })
	p.storeModels(models, func(m ai.ModelInfo) Caps { return capsFromInfo(m, nzSource(m.ContextSource), p.opts.ContextWindow) })
	return models, nil
}

func nzSource(s string) string {
	if s == "" {
		return "default"
	}
	return s
}

// enrichLiteLLM reads GET {root}/model/info (max_input_tokens,
// supports_function_calling, …). Failures are ignored.
func (p *openAI) enrichLiteLLM(ctx context.Context, models []ai.ModelInfo) {
	var info struct {
		Data []struct {
			ModelName string `json:"model_name"`
			ModelInfo struct {
				MaxInputTokens          int   `json:"max_input_tokens"`
				MaxOutputTokens         int   `json:"max_output_tokens"`
				SupportsFunctionCalling *bool `json:"supports_function_calling"`
				SupportsVision          *bool `json:"supports_vision"`
				SupportsReasoning       *bool `json:"supports_reasoning"`
			} `json:"model_info"`
		} `json:"data"`
	}
	root := strings.TrimSuffix(p.opts.BaseURL, "/v1")
	if err := p.http.getJSON(ctx, http.MethodGet, root+"/model/info", nil, p.authHeaders(), &info); err != nil {
		if err2 := p.http.getJSON(ctx, http.MethodGet, p.opts.BaseURL+"/model/info", nil, p.authHeaders(), &info); err2 != nil {
			return
		}
	}
	byName := map[string]int{}
	for i, m := range models {
		byName[m.ID] = i
	}
	for _, d := range info.Data {
		i, ok := byName[d.ModelName]
		if !ok {
			continue
		}
		m := &models[i]
		if d.ModelInfo.MaxInputTokens > 0 {
			m.ContextWindow, m.ContextSource = d.ModelInfo.MaxInputTokens, "model/info"
		}
		if d.ModelInfo.MaxOutputTokens > 0 {
			m.MaxOutput = d.ModelInfo.MaxOutputTokens
		}
		if b := d.ModelInfo.SupportsFunctionCalling; b != nil {
			m.Tools, m.ToolsVerified = yesNo(*b), true
		}
		if b := d.ModelInfo.SupportsVision; b != nil {
			m.Vision = yesNo(*b)
		}
		if b := d.ModelInfo.SupportsReasoning; b != nil {
			m.Thinking = yesNo(*b)
		}
	}
}

// enrichLMStudio reads GET {host}/api/v0/models (loaded_context_length,
// max_context_length, type). The endpoint is documented by LM Studio but
// unverified here; failures are ignored.
func (p *openAI) enrichLMStudio(ctx context.Context, models []ai.ModelInfo) {
	var list struct {
		Data []struct {
			ID                  string   `json:"id"`
			Type                string   `json:"type"`
			MaxContextLength    int      `json:"max_context_length"`
			LoadedContextLength int      `json:"loaded_context_length"`
			Capabilities        []string `json:"capabilities"`
		} `json:"data"`
	}
	root := strings.TrimSuffix(p.opts.BaseURL, "/v1")
	if err := p.http.getJSON(ctx, http.MethodGet, root+"/api/v0/models", nil, p.authHeaders(), &list); err != nil {
		return
	}
	byName := map[string]int{}
	for i, m := range models {
		byName[m.ID] = i
	}
	for _, d := range list.Data {
		i, ok := byName[d.ID]
		if !ok {
			continue
		}
		m := &models[i]
		switch {
		case d.LoadedContextLength > 0:
			m.ContextWindow, m.ContextSource, m.LoadedContext = d.LoadedContextLength, "lmstudio", d.LoadedContextLength
		case d.MaxContextLength > 0:
			m.ContextWindow, m.ContextSource = d.MaxContextLength, "lmstudio"
		}
		if d.Type == "vlm" {
			m.Vision = ai.CapYes
		}
		for _, c := range d.Capabilities {
			if c == "tool_use" {
				m.Tools, m.ToolsVerified = ai.CapYes, true
			}
		}
	}
}

func yesNo(b bool) string {
	if b {
		return ai.CapYes
	}
	return ai.CapNo
}

func (p *openAI) ModelCaps(ctx context.Context, model string) (Caps, error) {
	if caps, ok := p.cachedCaps(model); ok {
		return caps, nil
	}
	if p.opts.Flavor == FlavorOpenAI {
		if t, ok := openAIModelTable(model); ok {
			return Caps{ContextWindow: overrideOr(p.opts.ContextWindow, t.ctx), MaxContext: t.ctx, MaxOutput: t.out, Tools: t.tools, Vision: t.vision, Thinking: t.thinking, Source: sourceOr(p.opts.ContextWindow, "table")}, nil
		}
	}
	if _, err := p.ListModels(ctx); err == nil {
		if caps, ok := p.cachedCaps(model); ok {
			return caps, nil
		}
	} else if IsReachabilityError(err) {
		// The endpoint is down or rejects us: say so instead of running
		// with guessed caps (a default 8k window then read as "context
		// window too small", UX A-19).
		return defaultCaps(p.opts.ContextWindow), err
	}
	return defaultCaps(p.opts.ContextWindow), nil
}

func overrideOr(override, v int) int {
	if override > 0 {
		return override
	}
	return v
}

func sourceOr(override int, s string) string {
	if override > 0 {
		return "config"
	}
	return s
}
