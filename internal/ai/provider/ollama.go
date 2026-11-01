package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

// Ollama native adapter (POST /api/chat, NDJSON), the default for the
// Ollama preset: it sets num_ctx per request, refuses silent truncation
// (truncate:false) and reports exact prompt sizes.

const (
	defaultKeepAlive    = "30m"
	defaultOllamaWindow = 16384
	psCacheTTL          = 5 * time.Second
	firstByteDelay      = 3 * time.Second
	firstByteRepeat     = 15 * time.Second
)

type ollama struct {
	common
	rt *ollamaRuntime
}

func newOllama(o Options) *ollama {
	p := &ollama{common: newCommon(o)}
	p.rt = newOllamaRuntime(o.BaseURL, &p.http)
	return p
}

func (p *ollama) Kind() string { return KindOllama }

// --- runtime helpers (shared with the OpenAI adapter for Ollama /v1) ---

type ollamaRuntime struct {
	root string
	h    *httpBase

	mu   sync.Mutex
	psAt time.Time
	ps   []ollamaPS
}

type ollamaPS struct {
	Name          string `json:"name"`
	Model         string `json:"model"`
	ContextLength int    `json:"context_length"`
}

func newOllamaRuntime(root string, h *httpBase) *ollamaRuntime {
	return &ollamaRuntime{root: strings.TrimRight(root, "/"), h: h}
}

// ps returns the loaded models (GET /api/ps, cached 5 s).
func (r *ollamaRuntime) loadedModels(ctx context.Context, fresh bool) ([]ollamaPS, error) {
	r.mu.Lock()
	if !fresh && !r.psAt.IsZero() && r.h.clock.Now().Sub(r.psAt) < psCacheTTL {
		out := r.ps
		r.mu.Unlock()
		return out, nil
	}
	r.mu.Unlock()
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var resp struct {
		Models []ollamaPS `json:"models"`
	}
	if err := r.h.getJSON(cctx, http.MethodGet, r.root+"/api/ps", nil, nil, &resp); err != nil {
		return nil, err
	}
	r.mu.Lock()
	r.ps, r.psAt = resp.Models, r.h.clock.Now()
	r.mu.Unlock()
	return resp.Models, nil
}

func (r *ollamaRuntime) loaded(ctx context.Context, model string, fresh bool) (bool, int) {
	ps, err := r.loadedModels(ctx, fresh)
	if err != nil {
		return true, 0 // unknown: do not claim loading
	}
	for _, m := range ps {
		if m.Name == model || m.Model == model {
			return true, m.ContextLength
		}
	}
	return false, 0
}

// preflightStatus emits model_loading at once when the model is not loaded.
func (r *ollamaRuntime) preflightStatus(ctx context.Context, model string, sink func(Event)) {
	if ok, _ := r.loaded(ctx, model, false); !ok {
		sink(Event{Kind: EvStatus, Status: &Status{Kind: ai.StatusModelLoading, Message: fmt.Sprintf("Loading %s…", model)}})
	}
}

// firstByteStatus starts a ticker that reports model_loading or
// processing_prompt while no response header has arrived (after 3 s, then
// every 15 s). The returned stop function waits for the ticker to exit.
func (r *ollamaRuntime) firstByteStatus(ctx context.Context, model string, sink func(Event)) func() {
	stop := make(chan struct{})
	done := make(chan struct{})
	clock := r.h.clock
	start := clock.Now()
	go func() {
		defer close(done)
		t := clock.NewTimer(firstByteDelay)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ctx.Done():
				return
			case <-t.C():
				elapsed := clock.Now().Sub(start).Round(time.Second)
				ok, _ := r.loaded(ctx, model, true)
				select {
				case <-stop:
					return
				default:
				}
				if !ok {
					sink(Event{Kind: EvStatus, Status: &Status{Kind: ai.StatusModelLoading, Message: fmt.Sprintf("Loading %s… (%s)", model, elapsed)}})
				} else {
					sink(Event{Kind: EvStatus, Status: &Status{Kind: ai.StatusProcessingPrompt, Message: fmt.Sprintf("The model is reading the conversation… (%s)", elapsed)}})
				}
				t.Reset(firstByteRepeat)
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() { close(stop) })
		<-done
	}
}

type ollamaShow struct {
	Capabilities []string                   `json:"capabilities"`
	Parameters   string                     `json:"parameters"`
	ModelInfo    map[string]json.RawMessage `json:"model_info"`
	Details      struct {
		Family            string `json:"family"`
		ParameterSize     string `json:"parameter_size"`
		QuantizationLevel string `json:"quantization_level"`
	} `json:"details"`
	Thinking *struct {
		Values  []json.RawMessage `json:"values"`
		Default json.RawMessage   `json:"default"`
	} `json:"thinking"`
	RemoteHost  string `json:"remote_host"`
	RemoteModel string `json:"remote_model"`
}

func (r *ollamaRuntime) show(ctx context.Context, model string) (*ollamaShow, error) {
	body, _ := json.Marshal(map[string]string{"model": model})
	var s ollamaShow
	if err := r.h.getJSON(ctx, http.MethodPost, r.root+"/api/show", body, nil, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// trainedContext returns model_info["<arch>.context_length"].
func (s *ollamaShow) trainedContext() int {
	arch := ""
	if raw, ok := s.ModelInfo["general.architecture"]; ok {
		_ = json.Unmarshal(raw, &arch)
	}
	if arch != "" {
		if raw, ok := s.ModelInfo[arch+".context_length"]; ok {
			var n int
			if json.Unmarshal(raw, &n) == nil {
				return n
			}
		}
	}
	for k, raw := range s.ModelInfo {
		if strings.HasSuffix(k, ".context_length") {
			var n int
			if json.Unmarshal(raw, &n) == nil {
				return n
			}
		}
	}
	return 0
}

// configuredContext returns num_ctx from the Modelfile parameters.
func (s *ollamaShow) configuredContext() int {
	for _, line := range strings.Split(s.Parameters, "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[0] == "num_ctx" {
			n, _ := strconv.Atoi(f[1])
			return n
		}
	}
	return 0
}

// load loads a model without a prompt (POST /api/generate).
func (r *ollamaRuntime) load(ctx context.Context, model, keepAlive string) error {
	if keepAlive == "" {
		keepAlive = defaultKeepAlive
	}
	body, _ := json.Marshal(map[string]any{"model": model, "keep_alive": keepAlive})
	var out map[string]any
	cctx, cancel := context.WithTimeout(ctx, loopbackHeaderTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodPost, r.root+"/api/generate", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.h.client.Do(req)
	if err != nil {
		return transportError(ctx, err, r.root, r.h.scrub)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return newHTTPError(resp, readErrorBody(resp.Body), r.h.scrub, r.h.clock)
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out)
	r.mu.Lock()
	r.psAt = time.Time{}
	r.mu.Unlock()
	return nil
}

// IsCloudModel reports an Ollama cloud model by its name (-cloud or :cloud
// suffix): it runs on ollama.com although the endpoint is local (§4.3).
func IsCloudModel(name string) bool { return isCloudModel(name) }

func isCloudModel(name string) bool {
	n := strings.ToLower(name)
	return strings.HasSuffix(n, "-cloud") || strings.HasSuffix(n, ":cloud")
}

// listModels discovers models via /api/tags, /api/show and /api/ps.
func (r *ollamaRuntime) listModels(ctx context.Context) ([]ai.ModelInfo, error) {
	var tags struct {
		Models []struct {
			Name    string `json:"name"`
			Model   string `json:"model"`
			Details struct {
				Family            string `json:"family"`
				ParameterSize     string `json:"parameter_size"`
				QuantizationLevel string `json:"quantization_level"`
				ContextLength     int    `json:"context_length"`
			} `json:"details"`
			Capabilities []string `json:"capabilities"`
			RemoteHost   string   `json:"remote_host"`
			RemoteModel  string   `json:"remote_model"`
		} `json:"models"`
	}
	if err := r.h.getJSON(ctx, http.MethodGet, r.root+"/api/tags", nil, nil, &tags); err != nil {
		return nil, err
	}
	ps, _ := r.loadedModels(ctx, true)
	loadedCtx := map[string]int{}
	for _, m := range ps {
		loadedCtx[m.Name] = m.ContextLength
		loadedCtx[m.Model] = m.ContextLength
	}

	models := make([]ai.ModelInfo, len(tags.Models))
	keep := make([]bool, len(tags.Models))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i, t := range tags.Models {
		name := t.Name
		if name == "" {
			name = t.Model
		}
		m := ai.ModelInfo{
			ID: name, DisplayName: name, Family: t.Details.Family, ParamSize: t.Details.ParameterSize,
			Tools: ai.CapUnknown, Vision: ai.CapUnknown, Thinking: ai.CapUnknown,
			Remote: isCloudModel(name) || t.RemoteHost != "" || t.RemoteModel != "",
			Note:   t.Details.QuantizationLevel, LoadedContext: loadedCtx[name],
		}
		if t.Details.ContextLength > 0 {
			m.ContextWindow, m.ContextSource = t.Details.ContextLength, "api/tags"
		}
		caps := t.Capabilities
		models[i], keep[i] = m, true
		wg.Add(1)
		go func(i int, caps []string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			mm := &models[i]
			if s, err := r.show(ctx, mm.ID); err == nil {
				if len(caps) == 0 {
					caps = s.Capabilities
				}
				if n := s.trainedContext(); n > 0 {
					mm.ContextWindow, mm.ContextSource = n, "api/show"
				}
				mm.ConfiguredCtx = s.configuredContext()
				if s.Details.Family != "" && mm.Family == "" {
					mm.Family = s.Details.Family
				}
				if s.RemoteHost != "" || s.RemoteModel != "" {
					mm.Remote = true
				}
				if s.Thinking != nil {
					for _, v := range s.Thinking.Values {
						mm.ThinkingModes = append(mm.ThinkingModes, strings.Trim(string(v), `"`))
					}
				}
			}
			if len(caps) > 0 {
				mm.Tools, mm.Vision, mm.Thinking = ai.CapNo, ai.CapNo, ai.CapNo
				mm.ToolsVerified = true
				completion := false
				for _, c := range caps {
					switch c {
					case "tools":
						mm.Tools = ai.CapYes
					case "vision":
						mm.Vision = ai.CapYes
					case "thinking":
						mm.Thinking = ai.CapYes
					case "completion":
						completion = true
					}
				}
				if !completion {
					keep[i] = false // embedding-only model
				}
			}
		}(i, caps)
	}
	wg.Wait()
	var out []ai.ModelInfo
	for i, m := range models {
		if keep[i] {
			out = append(out, m)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// ollamaCaps derives harness caps: the window is the config override, else
// min(16384, trained context).
func ollamaCaps(m ai.ModelInfo, override int) Caps {
	c := capsFromInfo(m, nzSource(m.ContextSource), 0)
	c.MaxContext = m.ContextWindow
	switch {
	case override > 0:
		c.ContextWindow, c.Source = override, "config"
	case m.ContextWindow > 0:
		c.ContextWindow = min(defaultOllamaWindow, m.ContextWindow)
	default:
		c.ContextWindow, c.Source = 8192, "default"
	}
	return c
}

// --- OllamaRuntime (pre-flight helpers for the agent loop) ---

// OllamaRuntime exposes Ollama's runtime endpoints for pre-flight checks.
type OllamaRuntime interface {
	// LoadedContext returns the context length of the loaded instance of
	// model (GET /api/ps); loaded is false when it is not loaded.
	LoadedContext(ctx context.Context, model string) (n int, loaded bool, err error)
	// LoadModel loads model without a prompt (POST /api/generate).
	LoadModel(ctx context.Context, model, keepAlive string) error
	// ModelContext returns the trained context and the Modelfile num_ctx
	// (POST /api/show).
	ModelContext(ctx context.Context, model string) (trained, configured int, err error)
}

type ollamaRuntimeAPI struct{ r *ollamaRuntime }

func (a ollamaRuntimeAPI) LoadedContext(ctx context.Context, model string) (int, bool, error) {
	ps, err := a.r.loadedModels(ctx, true)
	if err != nil {
		return 0, false, err
	}
	for _, m := range ps {
		if m.Name == model || m.Model == model {
			return m.ContextLength, true, nil
		}
	}
	return 0, false, nil
}

func (a ollamaRuntimeAPI) LoadModel(ctx context.Context, model, keepAlive string) error {
	return a.r.load(ctx, model, keepAlive)
}

func (a ollamaRuntimeAPI) ModelContext(ctx context.Context, model string) (int, int, error) {
	s, err := a.r.show(ctx, model)
	if err != nil {
		return 0, 0, err
	}
	return s.trainedContext(), s.configuredContext(), nil
}

// AsOllamaRuntime returns the Ollama runtime helpers of p (native Ollama or
// the OpenAI adapter with flavor ollama).
func AsOllamaRuntime(p Provider) (OllamaRuntime, bool) {
	if r, ok := p.(*retrying); ok {
		p = r.Provider
	}
	switch x := p.(type) {
	case *ollama:
		return ollamaRuntimeAPI{x.rt}, true
	case *openAI:
		if x.ollamaRT != nil {
			return ollamaRuntimeAPI{x.ollamaRT}, true
		}
	}
	return nil, false
}

// DetectV1Truncation reports Ollama /v1 silent truncation: the calibrated
// estimate is above 3000 tokens and the reported prompt_tokens is below
// 0.6 × the estimate.
func DetectV1Truncation(estimatedPromptTokens, reportedPromptTokens int) bool {
	return estimatedPromptTokens > 3000 && float64(reportedPromptTokens) < 0.6*float64(estimatedPromptTokens)
}

// --- request ---

type olRequest struct {
	Model     string         `json:"model"`
	Messages  []olMessage    `json:"messages"`
	Tools     []oaTool       `json:"tools,omitempty"`
	Stream    bool           `json:"stream"`
	Options   map[string]any `json:"options,omitempty"`
	Truncate  *bool          `json:"truncate,omitempty"`
	KeepAlive string         `json:"keep_alive,omitempty"`
	Think     any            `json:"think,omitempty"`
}

type olMessage struct {
	Role       string       `json:"role"`
	Content    string       `json:"content"`
	ToolCalls  []olToolCall `json:"tool_calls,omitempty"`
	ToolName   string       `json:"tool_name,omitempty"`
	ToolCallID string       `json:"tool_call_id,omitempty"`
}

type olToolCall struct {
	Function struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"function"`
}

func (p *ollama) numCtx(req *Request) int {
	if req.ContextWindow > 0 {
		return req.ContextWindow
	}
	if p.opts.ContextWindow > 0 {
		return p.opts.ContextWindow
	}
	if caps, ok := p.cachedCaps(req.Model); ok && caps.ContextWindow > 0 {
		return caps.ContextWindow
	}
	return 0
}

func (p *ollama) buildBody(req *Request, dropped map[string]bool) ([]byte, []string, error) {
	body := olRequest{Model: req.Model, Stream: true}
	var sent []string
	msgs := req.Messages
	if req.ToolLess {
		msgs = flattenedMessages(msgs)
	}
	ids := buildWireIDs(msgs, idStyleFor(KindOllama, req.Model, p.opts.ToolCallIDStyle), p.key)
	if req.System != "" {
		body.Messages = append(body.Messages, olMessage{Role: "system", Content: req.System})
	}
	names := map[string]string{}
	for mi, m := range msgs {
		if m.Role == ai.RoleAssistant {
			om := olMessage{Role: "assistant", Content: joinText(m)}
			for bi, b := range m.Blocks {
				if b.Type != ai.BlockToolUse {
					continue
				}
				names[b.ID] = b.Name
				_ = ids.forUse(b, mi, bi)
				if req.ToolLess {
					continue
				}
				var tc olToolCall
				tc.Function.Name = b.Name
				tc.Function.Arguments = json.RawMessage(compactJSON(b.Input))
				om.ToolCalls = append(om.ToolCalls, tc)
			}
			if om.Content == "" && len(om.ToolCalls) == 0 {
				continue
			}
			body.Messages = append(body.Messages, om)
			continue
		}
		for _, b := range m.Blocks {
			if b.Type == ai.BlockToolResult && !req.ToolLess {
				body.Messages = append(body.Messages, olMessage{Role: "tool", ToolName: names[b.ToolUseID], ToolCallID: ids.forResult(b.ToolUseID), Content: b.Content})
			}
		}
		if t := joinText(m); t != "" {
			body.Messages = append(body.Messages, olMessage{Role: "user", Content: t})
		}
	}
	if !req.ToolLess && len(req.Tools) > 0 {
		body.Tools = specsToOpenAI(req.Tools)
	}
	opts := map[string]any{}
	if n := p.numCtx(req); n > 0 {
		opts["num_ctx"] = n
	}
	if req.MaxOutputTokens > 0 {
		opts["num_predict"] = req.MaxOutputTokens
	}
	if len(opts) > 0 {
		body.Options = opts
	}
	if !dropped[ParamTruncate] {
		f := false
		body.Truncate = &f
		sent = append(sent, ParamTruncate)
	}
	if !dropped[ParamKeepAlive] {
		body.KeepAlive = p.opts.KeepAlive
		if body.KeepAlive == "" {
			body.KeepAlive = defaultKeepAlive
		}
		sent = append(sent, ParamKeepAlive)
	}
	if !dropped[ParamThink] {
		switch req.Thinking {
		case "off":
			body.Think = false
			sent = append(sent, ParamThink)
		case "low", "medium", "high":
			if dropped[ParamThinkLevel] {
				body.Think = true
				sent = append(sent, ParamThink)
			} else {
				body.Think = req.Thinking
				sent = append(sent, ParamThinkLevel)
			}
		}
	}
	data, err := json.Marshal(body)
	return data, sent, err
}

// --- streaming ---

func (p *ollama) Stream(ctx context.Context, req *Request, sink func(Event)) (*Response, error) {
	if req.Model == "" {
		return nil, &Error{Code: ai.CodeConfigMissing, Message: "No model is selected."}
	}
	return paramFallbackStream(req, p.opts.Params, p.cacheKey, sink, func(dropped map[string]bool, sink func(Event)) (*Response, []string, error) {
		body, sent, err := p.buildBody(req, dropped)
		if err != nil {
			return nil, sent, err
		}
		resp, err := p.streamOnce(ctx, req, body, sink)
		return resp, sent, err
	})
}

type olChunk struct {
	Model   string `json:"model"`
	Message *struct {
		Content   string `json:"content"`
		Thinking  string `json:"thinking"`
		ToolCalls []struct {
			ID       string `json:"id"`
			Function struct {
				Index     *int            `json:"index"`
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			} `json:"function"`
		} `json:"tool_calls"`
	} `json:"message"`
	Done                  bool            `json:"done"`
	DoneReason            string          `json:"done_reason"`
	PromptEvalCount       int             `json:"prompt_eval_count"`
	PromptEvalCachedCount int             `json:"prompt_eval_cached_count"`
	EvalCount             int             `json:"eval_count"`
	LoadDuration          int64           `json:"load_duration"`
	Error                 json.RawMessage `json:"error"`
}

func (p *ollama) streamOnce(ctx context.Context, req *Request, body []byte, sink func(Event)) (*Response, error) {
	release, err := p.acquire(ctx, sink)
	if err != nil {
		return nil, err
	}
	defer release()
	var before func() func()
	if p.http.loop {
		p.rt.preflightStatus(ctx, req.Model, sink)
		before = func() func() { return p.rt.firstByteStatus(ctx, req.Model, sink) }
	}
	c, err := p.http.do(ctx, func(cctx context.Context) (*http.Request, error) {
		r, err := http.NewRequestWithContext(cctx, http.MethodPost, p.opts.BaseURL+"/api/chat", bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		r.Header.Set("Content-Type", "application/json")
		if p.opts.APIKey != "" {
			r.Header.Set("Authorization", "Bearer "+p.opts.APIKey)
		}
		return r, nil
	}, before)
	if err != nil {
		return nil, err
	}
	defer c.close()

	offered := offeredTools(req)
	b := newStepBuilder(sink, p.key, offered, p.knownThinker(req.Model), true)
	model := req.Model
	reqID := requestID(c.resp.Header)
	var calls []ai.Block
	var final *olChunk
	lr := newLineReader(c.body)
	for {
		line, rerr := lr.next()
		if rerr != nil {
			if errors.Is(rerr, io.EOF) {
				break
			}
			return ollamaPartial(b, model, reqID), c.streamErr(ctx, rerr, p.http.scrub)
		}
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var ch olChunk
		if err := json.Unmarshal(line, &ch); err != nil {
			continue
		}
		if len(ch.Error) > 0 && string(ch.Error) != "null" {
			return ollamaPartial(b, model, reqID), streamError(line, p.http.scrub, reqID)
		}
		if ch.Model != "" {
			model = ch.Model
		}
		if ch.Message != nil {
			if ch.Message.Thinking != "" {
				b.reasoningText(ch.Message.Thinking)
			}
			if ch.Message.Content != "" {
				b.content(ch.Message.Content)
			}
			for _, tc := range ch.Message.ToolCalls {
				args := normalizeArgValue(tc.Function.Arguments)
				blk := toolUseBlock(p.key, model, tc.ID, tc.Function.Name, args, offered)
				calls = append(calls, blk)
				sink(Event{Kind: EvToolUseStart, ToolName: blk.Name})
			}
		}
		if ch.Done {
			cp := ch
			final = &cp
			break
		}
	}
	if ctx.Err() != nil {
		return ollamaPartial(b, model, reqID), ctx.Err()
	}
	if final == nil {
		return ollamaPartial(b, model, reqID), interruptedError(nil, p.http.scrub)
	}
	p.noteResponseModel(req.Model, model)
	b.finish(model, len(calls) > 0)
	for _, blk := range calls {
		blk.Producer = Producer(p.key, model)
		b.addToolUse(blk)
	}
	resp := &Response{
		Message:   ai.Message{Role: ai.RoleAssistant, Blocks: b.message(), Model: model, Provider: KindOllama},
		Model:     model,
		RequestID: reqID,
		Complete:  true,
		Warnings:  b.warnings,
		Usage:     ai.Usage{InputTokens: final.PromptEvalCount, OutputTokens: final.EvalCount, CacheReadTokens: final.PromptEvalCachedCount},
	}
	switch {
	case b.hasToolUse():
		resp.StopReason = ai.StopToolUse
	case final.DoneReason == "length":
		resp.StopReason = ai.StopMaxTokens
	default:
		resp.StopReason = ai.StopEndTurn
	}
	if final.DoneReason == "length" {
		resp.StopReason = ai.StopMaxTokens
	}
	resp.Message.StopReason = resp.StopReason
	u := resp.Usage
	resp.Message.Usage = &u
	sink(Event{Kind: EvUsage, Usage: &u})
	return resp, nil
}

func ollamaPartial(b *stepBuilder, model, reqID string) *Response {
	b.think.flush()
	b.reasoning.flush()
	_, held := b.hold.finish()
	b.appendText(held)
	return &Response{Message: ai.Message{Role: ai.RoleAssistant, Blocks: b.message(), Model: model, Partial: true}, Model: model, RequestID: reqID, StopReason: ai.StopError}
}

// --- discovery ---

func (p *ollama) ListModels(ctx context.Context) ([]ai.ModelInfo, error) {
	models, err := p.rt.listModels(ctx)
	if err != nil {
		return nil, err
	}
	p.storeModels(models, func(m ai.ModelInfo) Caps { return ollamaCaps(m, p.opts.ContextWindow) })
	return models, nil
}

func (p *ollama) ModelCaps(ctx context.Context, model string) (Caps, error) {
	if caps, ok := p.cachedCaps(model); ok {
		return caps, nil
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
