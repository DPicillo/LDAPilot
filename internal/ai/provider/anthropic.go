package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"

	anthropic "github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/option"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
)

// Anthropic Messages API adapter on the official Go SDK. The client is built
// only from explicit options: no environment defaults (ANTHROPIC_API_KEY,
// ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS, profiles, federation), an
// explicit choice of exactly one credential header, and SDK retries off
// (WithRetry is the only retry layer).

const (
	defaultAnthropicModel     = "claude-opus-5-5"
	defaultAnthropicMaxTokens = 16000
)

type anthropicP struct {
	common
	client anthropic.Client
}

func newAnthropic(o Options) (*anthropicP, error) {
	o.BaseURL = strings.TrimRight(strings.TrimSuffix(o.BaseURL, "/v1"), "/")
	p := &anthropicP{common: newCommon(o)}
	opts := []option.RequestOption{
		option.WithoutEnvironmentDefaults(),
		option.WithBaseURL(o.BaseURL + "/"),
		option.WithHTTPClient(p.http.client),
		option.WithMaxRetries(0),
	}
	switch o.AnthropicAuth {
	case "", "x-api-key":
		opts = append(opts, option.WithHeader("X-Api-Key", o.APIKey), option.WithHeaderDel("Authorization"))
	case "bearer":
		opts = append(opts, option.WithAuthToken(o.APIKey), option.WithHeaderDel("X-Api-Key"))
	default:
		return nil, &Error{Code: ai.CodeConfigMissing, Message: fmt.Sprintf("Unknown Anthropic auth mode %q.", o.AnthropicAuth)}
	}
	p.client = anthropic.NewClient(opts...)
	return p, nil
}

func (p *anthropicP) Kind() string { return KindAnthropic }

// --- thinking and effort per model ---

// anthropicStatic is the fallback capability table (used when /v1/models
// did not report capabilities).
type anthropicStatic struct {
	prefix        string
	ctx, out      int
	modes         []string // thinking types supported
	efforts       []string
	defaultEffort string // "" = API default
}

var allEfforts = []string{"low", "medium", "high", "xhigh", "max"}

var anthropicModels = []anthropicStatic{
	{"claude-opus-5-5", 1000000, 128000, []string{"adaptive"}, allEfforts, "medium"},
	{"claude-sonnet-5-5", 1000000, 128000, []string{"adaptive", "between_tools"}, allEfforts, ""},
	{"claude-fable-5", 1000000, 128000, []string{"adaptive"}, allEfforts, ""},
	{"claude-mythos-5", 1000000, 128000, []string{"adaptive"}, allEfforts, ""},
	{"claude-opus-5", 1000000, 128000, []string{"adaptive", "disabled"}, allEfforts, ""},
	{"claude-sonnet-5", 1000000, 128000, []string{"adaptive", "disabled"}, allEfforts, ""},
	{"claude-opus-4-8", 1000000, 128000, []string{"adaptive", "disabled"}, allEfforts, ""},
	{"claude-opus-4-7", 1000000, 128000, []string{"adaptive", "disabled"}, allEfforts, ""},
	{"claude-opus-4-6", 1000000, 128000, []string{"adaptive", "enabled", "disabled"}, []string{"low", "medium", "high", "max"}, ""},
	{"claude-sonnet-4-6", 1000000, 64000, []string{"adaptive", "enabled", "disabled"}, []string{"low", "medium", "high", "max"}, ""},
	{"claude-haiku-4-5", 200000, 64000, []string{"enabled", "disabled"}, nil, ""},
}

func anthropicTable(model string) (anthropicStatic, bool) {
	best := -1
	for i, m := range anthropicModels {
		if strings.HasPrefix(model, m.prefix) && (best < 0 || len(m.prefix) > len(anthropicModels[best].prefix)) {
			best = i
		}
	}
	if best < 0 {
		return anthropicStatic{}, false
	}
	return anthropicModels[best], true
}

func has(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// thinkingPlan is the thinking/effort configuration of one request.
type thinkingPlan struct {
	thinking anthropic.ThinkingConfigParamUnion
	effort   string
	warnings []string
}

// planThinking maps the harness thinking setting and effort to the API for
// one model, using discovered caps (modes/efforts) or the static table. An
// invalid combination falls back to the nearest valid value with a warning.
func planThinking(model string, caps Caps, thinking, effort string, show bool, maxTokens int, toolLess bool) thinkingPlan {
	modes, efforts := caps.ThinkingModes, caps.EffortLevels
	defEffort := ""
	if t, ok := anthropicTable(model); ok {
		if len(modes) == 0 {
			modes = t.modes
		}
		if len(efforts) == 0 && caps.Source != "models" {
			efforts = t.efforts
		}
		defEffort = t.defaultEffort
	}
	var plan thinkingPlan
	adaptive := func() {
		a := anthropic.ThinkingConfigAdaptiveParam{}
		if show {
			a.Display = anthropic.ThinkingConfigAdaptiveDisplaySummarized
		}
		plan.thinking = anthropic.ThinkingConfigParamUnion{OfAdaptive: &a}
	}
	if toolLess {
		// Compaction and titles: no thinking replay, effort low where supported.
		if len(efforts) > 0 {
			plan.effort = "low"
		}
		return plan
	}
	switch thinking {
	case "off":
		switch {
		case has(modes, "between_tools"):
			plan.thinking = anthropic.ThinkingConfigParamUnion{OfBetweenTools: &anthropic.ThinkingConfigBetweenToolsParam{}}
			if effort == "xhigh" || effort == "max" {
				plan.warnings = append(plan.warnings, "Thinking off on this model needs effort high or lower; using high.")
				effort = "high"
			}
		case has(modes, "disabled"):
			plan.thinking = anthropic.ThinkingConfigParamUnion{OfDisabled: &anthropic.ThinkingConfigDisabledParam{}}
		case has(modes, "adaptive"):
			// Cannot be disabled: omit thinking and use low effort.
			if effort == "" {
				effort = "low"
			}
		}
	case "low", "medium", "high":
		switch {
		case has(modes, "adaptive"):
			adaptive()
		case has(modes, "enabled"):
			budget := map[string]int{"low": 2048, "medium": 4096, "high": 8192}[thinking]
			if budget >= maxTokens {
				budget = maxTokens - 1024
			}
			if budget >= 1024 {
				plan.thinking = anthropic.ThinkingConfigParamOfEnabled(int64(budget))
			} else {
				plan.warnings = append(plan.warnings, "The output budget is too small for thinking on this model; thinking is off.")
			}
		}
	default: // auto
		if has(modes, "adaptive") {
			adaptive()
		}
	}
	if len(efforts) == 0 {
		if effort != "" {
			plan.warnings = append(plan.warnings, "This model does not support the effort setting; it is ignored.")
		}
		return plan
	}
	if effort == "" {
		effort = defEffort
	}
	if effort != "" && !has(efforts, effort) {
		nearest := nearestEffort(effort, efforts)
		plan.warnings = append(plan.warnings, fmt.Sprintf("Effort %q is not supported by this model; using %q.", effort, nearest))
		effort = nearest
	}
	plan.effort = effort
	return plan
}

func nearestEffort(want string, supported []string) string {
	idx := func(s string) int {
		for i, e := range allEfforts {
			if e == s {
				return i
			}
		}
		return 2
	}
	w := idx(want)
	best, bestD := supported[0], 99
	for _, s := range supported {
		d := idx(s) - w
		if d < 0 {
			d = -d
		}
		if d < bestD {
			best, bestD = s, d
		}
	}
	return best
}

// --- request ---

func toAnthropicTools(specs []tools.Spec) []anthropic.ToolUnionParam {
	out := make([]anthropic.ToolUnionParam, 0, len(specs))
	for _, s := range specs {
		schema := anthropic.ToolInputSchemaParam{}
		var m map[string]any
		if len(s.Parameters) > 0 && json.Unmarshal(s.Parameters, &m) == nil {
			if props, ok := m["properties"]; ok {
				schema.Properties = props
			}
			if req, ok := m["required"].([]any); ok {
				for _, r := range req {
					if rs, ok := r.(string); ok {
						schema.Required = append(schema.Required, rs)
					}
				}
			}
			extra := map[string]any{}
			for k, v := range m {
				if k != "type" && k != "properties" && k != "required" {
					extra[k] = v
				}
			}
			if len(extra) > 0 {
				schema.ExtraFields = extra
			}
		}
		if schema.Properties == nil {
			schema.Properties = map[string]any{}
		}
		t := anthropic.ToolParam{Name: s.Name, InputSchema: schema}
		if s.Description != "" {
			t.Description = anthropic.String(s.Description)
		}
		out = append(out, anthropic.ToolUnionParam{OfTool: &t})
	}
	return out
}

func (p *anthropicP) buildParams(req *Request, caps Caps) (anthropic.MessageNewParams, []string) {
	msgs := req.Messages
	if req.ToolLess {
		msgs = flattenedMessages(msgs)
	}
	ids := buildWireIDs(msgs, idStyleAnthropic, p.key)
	producer := p.currentProducer(req.Model)

	maxTokens := req.MaxOutputTokens
	if maxTokens <= 0 {
		maxTokens = defaultAnthropicMaxTokens
	}
	if caps.MaxOutput > 0 && maxTokens > caps.MaxOutput {
		maxTokens = caps.MaxOutput
	}
	params := anthropic.MessageNewParams{
		Model:        anthropic.Model(req.Model),
		MaxTokens:    int64(maxTokens),
		CacheControl: anthropic.NewCacheControlEphemeralParam(),
	}
	if req.System != "" {
		params.System = []anthropic.TextBlockParam{{Text: req.System, CacheControl: anthropic.NewCacheControlEphemeralParam()}}
	}
	if !req.ToolLess && len(req.Tools) > 0 {
		params.Tools = toAnthropicTools(req.Tools)
	}

	type pending struct {
		role   ai.Role
		blocks []anthropic.ContentBlockParamUnion
	}
	var out []pending
	for mi, m := range msgs {
		var blocks []anthropic.ContentBlockParamUnion
		if m.Role == ai.RoleAssistant {
			replay := !req.ToolLess && mi >= req.TurnStartIndex
			for bi, b := range m.Blocks {
				switch b.Type {
				case ai.BlockThinking:
					if replay && b.Signature != "" && b.Producer == producer {
						blocks = append(blocks, anthropic.ContentBlockParamUnion{OfThinking: &anthropic.ThinkingBlockParam{Thinking: b.Thinking, Signature: b.Signature}})
					}
				case ai.BlockRedactedThinking:
					if replay && b.Data != "" && b.Producer == producer {
						blocks = append(blocks, anthropic.ContentBlockParamUnion{OfRedactedThinking: &anthropic.RedactedThinkingBlockParam{Data: b.Data}})
					}
				case ai.BlockText:
					if strings.TrimSpace(b.Text) != "" {
						blocks = append(blocks, anthropic.NewTextBlock(b.Text))
					}
				case ai.BlockToolUse:
					if req.ToolLess {
						continue
					}
					input := b.Input
					if len(input) == 0 {
						input = emptyObject
					}
					blocks = append(blocks, anthropic.ContentBlockParamUnion{OfToolUse: &anthropic.ToolUseBlockParam{ID: ids.forUse(b, mi, bi), Name: b.Name, Input: json.RawMessage(input)}})
				}
			}
		} else {
			var results, texts []anthropic.ContentBlockParamUnion
			for _, b := range m.Blocks {
				switch b.Type {
				case ai.BlockToolResult:
					if req.ToolLess {
						continue
					}
					content := b.Content
					if content == "" {
						content = "(empty)"
					}
					tr := anthropic.ToolResultBlockParam{ToolUseID: ids.forResult(b.ToolUseID), Content: []anthropic.ToolResultBlockParamContentUnion{{OfText: &anthropic.TextBlockParam{Text: content}}}}
					if b.IsError {
						tr.IsError = anthropic.Bool(true)
					}
					results = append(results, anthropic.ContentBlockParamUnion{OfToolResult: &tr})
				case ai.BlockText:
					if strings.TrimSpace(b.Text) != "" {
						texts = append(texts, anthropic.NewTextBlock(b.Text))
					}
				}
			}
			blocks = append(results, texts...) // tool_result blocks first
		}
		if len(blocks) == 0 {
			continue
		}
		if n := len(out); n > 0 && out[n-1].role == m.Role {
			// Merge same-role neighbours; keep tool results first.
			merged := append(out[n-1].blocks, blocks...)
			if m.Role == ai.RoleUser {
				var r, t []anthropic.ContentBlockParamUnion
				for _, b := range merged {
					if b.OfToolResult != nil {
						r = append(r, b)
					} else {
						t = append(t, b)
					}
				}
				merged = append(r, t...)
			}
			out[n-1].blocks = merged
			continue
		}
		out = append(out, pending{role: m.Role, blocks: blocks})
	}
	for _, m := range out {
		if m.role == ai.RoleAssistant {
			params.Messages = append(params.Messages, anthropic.NewAssistantMessage(m.blocks...))
		} else {
			params.Messages = append(params.Messages, anthropic.NewUserMessage(m.blocks...))
		}
	}

	plan := planThinking(req.Model, caps, req.Thinking, req.Effort, req.ShowThinking, maxTokens, req.ToolLess)
	params.Thinking = plan.thinking
	if plan.effort != "" {
		params.OutputConfig = anthropic.OutputConfigParam{Effort: anthropic.OutputConfigEffort(plan.effort)}
	}
	return params, plan.warnings
}

// --- streaming ---

func (p *anthropicP) Stream(ctx context.Context, req *Request, sink func(Event)) (*Response, error) {
	if req.Model == "" {
		return nil, &Error{Code: ai.CodeConfigMissing, Message: "No model is selected."}
	}
	caps, _ := p.cachedCaps(req.Model)
	if caps.Source == "" {
		caps = anthropicStaticCaps(req.Model)
	}
	params, warnings := p.buildParams(req, caps)
	for _, w := range warnings {
		sink(Event{Kind: EvStatus, Status: &Status{Kind: ai.StatusWarning, Message: w}})
	}

	release, err := p.acquire(ctx, sink)
	if err != nil {
		return nil, err
	}
	defer release()

	// Idle watchdog and hard call cap (§3.7): the SDK sets no timeout on
	// streaming requests. The watchdog starts once the headers arrived and
	// is touched on every body read; it cancels the request with a cause
	// that mapErr turns into a retryable timeout.
	cctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	var wdMu sync.Mutex
	var wd *watchdog
	defer func() {
		wdMu.Lock()
		w := wd
		wdMu.Unlock()
		if w != nil {
			w.stop()
		}
	}()
	hard := remoteCallCap
	if p.http.loop {
		hard = loopbackCallCap
	}
	watch := option.WithMiddleware(func(r *http.Request, next option.MiddlewareNext) (*http.Response, error) {
		resp, err := next(r)
		if err != nil || resp == nil || resp.Body == nil {
			return resp, err
		}
		w := startWatchdog(cctx, cancel, p.http.clock, streamIdleTimeout, hard)
		wdMu.Lock()
		wd = w
		wdMu.Unlock()
		resp.Body = &activityReadCloser{rc: resp.Body, w: w}
		return resp, nil
	})

	var raw *http.Response
	stream := p.client.Messages.NewStreaming(cctx, params, option.WithResponseInto(&raw), watch)
	defer stream.Close()

	offered := offeredTools(req)
	var msg anthropic.Message
	stopped := false
	for stream.Next() {
		ev := stream.Current()
		if err := msg.Accumulate(ev); err != nil {
			return p.partial(&msg, req), &Error{Code: ai.CodeStreamInterrupted, Message: "Malformed stream: " + err.Error(), Retryable: true, err: err}
		}
		switch ev.Type {
		case "content_block_start":
			if ev.ContentBlock.Type == "tool_use" {
				name, _ := tools.Resolve(ev.ContentBlock.Name, offered)
				sink(Event{Kind: EvToolUseStart, ToolName: name, BlockIndex: int(ev.Index)})
			}
		case "content_block_delta":
			switch ev.Delta.Type {
			case "text_delta":
				if ev.Delta.Text != "" {
					sink(Event{Kind: EvTextDelta, BlockIndex: int(ev.Index), Text: ev.Delta.Text})
				}
			case "thinking_delta":
				if ev.Delta.Thinking != "" {
					sink(Event{Kind: EvThinkingDelta, BlockIndex: int(ev.Index), Text: ev.Delta.Thinking})
				}
			}
		case "message_stop":
			stopped = true
		}
	}
	reqID := ""
	if raw != nil {
		reqID = requestID(raw.Header)
	}
	if err := stream.Err(); err != nil {
		if ctx.Err() != nil {
			return p.partial(&msg, req), ctx.Err()
		}
		if cause := context.Cause(cctx); cause != nil && (errors.Is(cause, errIdleTimeout) || errors.Is(cause, errCallTimeout)) {
			return p.partial(&msg, req), &Error{Code: ai.CodeTimeout, Message: cause.Error() + ".", Retryable: true, err: cause}
		}
		return p.partial(&msg, req), p.mapErr(ctx, err, reqID)
	}
	if ctx.Err() != nil {
		return p.partial(&msg, req), ctx.Err()
	}
	if cause := context.Cause(cctx); cause != nil && (errors.Is(cause, errIdleTimeout) || errors.Is(cause, errCallTimeout)) {
		return p.partial(&msg, req), &Error{Code: ai.CodeTimeout, Message: cause.Error() + ".", Retryable: true, err: cause}
	}
	if !stopped {
		return p.partial(&msg, req), interruptedError(nil, p.http.scrub)
	}
	return p.finalize(&msg, req, reqID, sink), nil
}

func (p *anthropicP) mapErr(ctx context.Context, err error, reqID string) error {
	var ae *anthropic.Error
	if errors.As(err, &ae) {
		raw := ae.RawJSON()
		f, _ := parseErrorFields([]byte(raw))
		msg := f.Message
		if msg == "" {
			msg = raw
		}
		e := &Error{Status: ae.StatusCode, Type: string(ae.Type()), Message: truncateRunes(p.http.scrub.Scrub(msg), maxErrorShown), RequestID: ae.RequestID, Body: truncateRunes(p.http.scrub.Scrub(raw), maxErrorBodyRead), err: err}
		if e.RequestID == "" {
			e.RequestID = reqID
		}
		if ae.Response != nil {
			e.RetryAfter = parseRetryAfter(ae.Response.Header, p.opts.Clock)
		}
		if f.Type == "" {
			f.Type = e.Type
		}
		if e.Status == http.StatusOK {
			// Mid-stream error event: classify by type only.
			e.Status = 0
		}
		classify(e, f)
		return e
	}
	return transportError(ctx, err, p.opts.BaseURL, p.http.scrub)
}

func (p *anthropicP) convertBlocks(msg *anthropic.Message, req *Request) []ai.Block {
	model := string(msg.Model)
	if model == "" {
		model = req.Model
	}
	offered := offeredTools(req)
	var out []ai.Block
	for _, c := range msg.Content {
		switch c.Type {
		case "text":
			if c.Text != "" {
				out = append(out, ai.Block{Type: ai.BlockText, Text: c.Text})
			}
		case "thinking":
			out = append(out, ai.Block{Type: ai.BlockThinking, Thinking: c.Thinking, Signature: c.Signature, Producer: Producer(p.key, model)})
		case "redacted_thinking":
			out = append(out, ai.Block{Type: ai.BlockRedactedThinking, Data: c.Data, Producer: Producer(p.key, model)})
		case "tool_use":
			out = append(out, toolUseBlock(p.key, model, c.ID, c.Name, normalizeArgValue(c.Input), offered))
		}
	}
	return out
}

func (p *anthropicP) partial(msg *anthropic.Message, req *Request) *Response {
	blocks := p.convertBlocks(msg, req)
	// Tool calls of a partial message are never complete.
	var keep []ai.Block
	for _, b := range blocks {
		if b.Type != ai.BlockToolUse {
			keep = append(keep, b)
		}
	}
	return &Response{Message: ai.Message{Role: ai.RoleAssistant, Blocks: keep, Model: string(msg.Model), Partial: true}, Model: string(msg.Model), StopReason: ai.StopError}
}

func (p *anthropicP) finalize(msg *anthropic.Message, req *Request, reqID string, sink func(Event)) *Response {
	model := string(msg.Model)
	if model == "" {
		model = req.Model
	}
	p.noteResponseModel(req.Model, model)
	resp := &Response{
		Message:   ai.Message{Role: ai.RoleAssistant, Blocks: p.convertBlocks(msg, req), Model: model, Provider: KindAnthropic},
		Model:     model,
		RequestID: reqID,
		Complete:  true,
		Usage: ai.Usage{
			InputTokens:      int(msg.Usage.InputTokens),
			OutputTokens:     int(msg.Usage.OutputTokens),
			CacheReadTokens:  int(msg.Usage.CacheReadInputTokens),
			CacheWriteTokens: int(msg.Usage.CacheCreationInputTokens),
			ReasoningTokens:  int(msg.Usage.OutputTokensDetails.ThinkingTokens),
		},
	}
	switch msg.StopReason {
	case "end_turn":
		resp.StopReason = ai.StopEndTurn
	case "tool_use":
		resp.StopReason = ai.StopToolUse
	case "max_tokens":
		resp.StopReason = ai.StopMaxTokens
	case "stop_sequence":
		resp.StopReason = ai.StopSequence
	case "refusal":
		resp.StopReason = ai.StopRefusal
		resp.Refusal = strings.TrimSpace(string(msg.StopDetails.Category) + " " + msg.StopDetails.Explanation)
	case "model_context_window_exceeded":
		resp.StopReason = ai.StopContextExceeded
	default:
		resp.StopReason = ai.StopUnknown
		resp.Warnings = append(resp.Warnings, "unknown stop reason "+string(msg.StopReason))
	}
	resp.Message.StopReason = resp.StopReason
	u := resp.Usage
	resp.Message.Usage = &u
	sink(Event{Kind: EvUsage, Usage: &u})
	return resp
}

// --- discovery ---

func anthropicStaticCaps(model string) Caps {
	t, ok := anthropicTable(model)
	if !ok {
		return Caps{ContextWindow: 200000, MaxContext: 200000, Tools: ai.CapYes, Vision: ai.CapUnknown, Thinking: ai.CapUnknown, Source: "default"}
	}
	thinking := ai.CapNo
	if len(t.modes) > 0 && !(len(t.modes) == 1 && t.modes[0] == "disabled") {
		thinking = ai.CapYes
	}
	return Caps{ContextWindow: t.ctx, MaxContext: t.ctx, MaxOutput: t.out, Tools: ai.CapYes, Vision: ai.CapYes, Thinking: thinking, ThinkingModes: t.modes, EffortLevels: t.efforts, Source: "table"}
}

func (p *anthropicP) ListModels(ctx context.Context) ([]ai.ModelInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, discoveryTimeout)
	defer cancel()
	pager := p.client.Models.ListAutoPaging(ctx, anthropic.ModelListParams{Limit: anthropic.Int(100)})
	var models []ai.ModelInfo
	for pager.Next() {
		m := pager.Current()
		info := ai.ModelInfo{ID: m.ID, DisplayName: m.DisplayName, Tools: ai.CapYes, ToolsVerified: false, Vision: ai.CapUnknown, Thinking: ai.CapUnknown}
		if info.DisplayName == "" {
			info.DisplayName = m.ID
		}
		if m.MaxInputTokens > 0 {
			info.ContextWindow, info.ContextSource = int(m.MaxInputTokens), "models"
		}
		info.MaxOutput = int(m.MaxTokens)
		if m.JSON.Capabilities.Valid() {
			c := m.Capabilities
			info.Vision = yesNo(c.ImageInput.Supported)
			info.Thinking = yesNo(c.Thinking.Supported)
			t := c.Thinking.Types
			for _, x := range []struct {
				ok   bool
				name string
			}{{t.Adaptive.Supported, "adaptive"}, {t.BetweenTools.Supported, "between_tools"}, {t.Enabled.Supported, "enabled"}, {t.Disabled.Supported, "disabled"}} {
				if x.ok {
					info.ThinkingModes = append(info.ThinkingModes, x.name)
				}
			}
			if c.Effort.Supported {
				info.SupportsEffort = true
				for _, x := range []struct {
					ok   bool
					name string
				}{{c.Effort.Low.Supported, "low"}, {c.Effort.Medium.Supported, "medium"}, {c.Effort.High.Supported, "high"}, {c.Effort.Xhigh.Supported, "xhigh"}, {c.Effort.Max.Supported, "max"}} {
					if x.ok {
						info.EffortLevels = append(info.EffortLevels, x.name)
					}
				}
			}
		} else if st, ok := anthropicTable(m.ID); ok {
			info.ThinkingModes, info.EffortLevels = st.modes, st.efforts
			if info.ContextWindow == 0 {
				info.ContextWindow, info.ContextSource = st.ctx, "table"
			}
			if info.MaxOutput == 0 {
				info.MaxOutput = st.out
			}
			info.Thinking = ai.CapYes
			info.Vision = ai.CapYes
		}
		info.Default = m.ID == defaultAnthropicModel
		models = append(models, info)
	}
	if err := pager.Err(); err != nil {
		return nil, p.mapErr(ctx, err, "")
	}
	p.storeModels(models, func(m ai.ModelInfo) Caps {
		c := capsFromInfo(m, nzSource(m.ContextSource), p.opts.ContextWindow)
		return c
	})
	return models, nil
}

func (p *anthropicP) ModelCaps(ctx context.Context, model string) (Caps, error) {
	if caps, ok := p.cachedCaps(model); ok {
		return caps, nil
	}
	caps := anthropicStaticCaps(model)
	if p.opts.ContextWindow > 0 {
		caps.ContextWindow, caps.Source = p.opts.ContextWindow, "config"
	}
	return caps, nil
}

// activityReadCloser touches the watchdog on every successful read.
type activityReadCloser struct {
	rc io.ReadCloser
	w  *watchdog
}

func (a *activityReadCloser) Read(p []byte) (int, error) {
	n, err := a.rc.Read(p)
	if n > 0 {
		a.w.touch()
	}
	return n, err
}

func (a *activityReadCloser) Close() error { return a.rc.Close() }
