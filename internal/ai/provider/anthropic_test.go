package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/aitest"
)

// anthropicSSE writes Anthropic SSE events ("event: <type>" + data).
func anthropicSSE(events ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("request-id", "req_123")
		for _, e := range events {
			var probe struct {
				Type string `json:"type"`
			}
			json.Unmarshal([]byte(e), &probe)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", probe.Type, e)
			w.(http.Flusher).Flush()
		}
	}
}

func msgStart(model string) string {
	return `{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"` + model + `","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":20,"output_tokens":1,"cache_read_input_tokens":5,"cache_creation_input_tokens":3}}}`
}

func blockStart(i int, block string) string {
	return fmt.Sprintf(`{"type":"content_block_start","index":%d,"content_block":%s}`, i, block)
}

func blockDelta(i int, delta string) string {
	return fmt.Sprintf(`{"type":"content_block_delta","index":%d,"delta":%s}`, i, delta)
}

func blockStop(i int) string { return fmt.Sprintf(`{"type":"content_block_stop","index":%d}`, i) }

func msgDelta(stop string, out int) string {
	return fmt.Sprintf(`{"type":"message_delta","delta":{"stop_reason":"%s","stop_sequence":null},"usage":{"output_tokens":%d}}`, stop, out)
}

const msgStop = `{"type":"message_stop"}`

func anthropicOpts(url string) Options {
	return Options{Kind: KindAnthropic, BaseURL: url, APIKey: "sk-ant-test-key"}
}

func TestAnthropicStream(t *testing.T) {
	f := newFakeServer(t, anthropicSSE(
		msgStart("claude-opus-5-5"),
		blockStart(0, `{"type":"thinking","thinking":"","signature":""}`),
		blockDelta(0, `{"type":"thinking_delta","thinking":"Let me "}`),
		blockDelta(0, `{"type":"thinking_delta","thinking":"check."}`),
		blockDelta(0, `{"type":"signature_delta","signature":"SIG=="}`),
		blockStop(0),
		`{"type":"ping"}`,
		blockStart(1, `{"type":"text","text":""}`),
		blockDelta(1, `{"type":"text_delta","text":"Looking "}`),
		blockDelta(1, `{"type":"text_delta","text":"it up."}`),
		blockStop(1),
		blockStart(2, `{"type":"tool_use","id":"toolu_01","name":"get_entry","input":{}}`),
		blockDelta(2, `{"type":"input_json_delta","partial_json":""}`),
		blockDelta(2, `{"type":"input_json_delta","partial_json":"{\"dn\":"}`),
		blockDelta(2, `{"type":"input_json_delta","partial_json":"\"cn=a\"}"}`),
		blockStop(2),
		blockStart(3, `{"type":"tool_use","id":"toolu_02","name":"search_ldap","input":{}}`),
		blockDelta(3, `{"type":"input_json_delta","partial_json":"{\"filter\":\"(x=1)\"}"}`),
		blockStop(3),
		`{"type":"some_future_event","foo":1}`,
		msgDelta("tool_use", 40),
		msgDelta("tool_use", 57),
		msgStop,
	))
	p := newTestProvider(t, anthropicOpts(f.srv.URL))
	resp, log, err := stream(t, p, &Request{Model: "claude-opus-5-5", Tools: testTools, Messages: []ai.Message{userMsg("x")}})
	if err != nil {
		t.Fatal(err)
	}
	if log.text(EvThinkingDelta) != "Let me check." || log.text(EvTextDelta) != "Looking it up." || log.count(EvToolUseStart) != 2 {
		t.Fatalf("events thinking %q text %q", log.text(EvThinkingDelta), log.text(EvTextDelta))
	}
	b := resp.Message.Blocks
	if len(b) != 4 || b[0].Type != ai.BlockThinking || b[0].Signature != "SIG==" || b[0].Producer != "anthropic:claude-opus-5-5" {
		t.Fatalf("blocks %+v", b)
	}
	if string(b[2].Input) != `{"dn":"cn=a"}` || b[2].ProviderCallID != "toolu_01" || b[3].Name != "search_ldap" {
		t.Fatalf("tool blocks %+v %+v", b[2], b[3])
	}
	if resp.StopReason != ai.StopToolUse || resp.Usage.OutputTokens != 57 || resp.Usage.InputTokens != 20 || resp.Usage.CacheReadTokens != 5 || resp.Usage.CacheWriteTokens != 3 || resp.RequestID != "req_123" {
		t.Fatalf("stop %s usage %+v req %s", resp.StopReason, resp.Usage, resp.RequestID)
	}
	if got := f.requests("/v1/messages")[0].Header; got.Get("X-Api-Key") != "sk-ant-test-key" || got.Get("Authorization") != "" || got.Get("Anthropic-Version") == "" {
		t.Fatalf("headers %v", got)
	}
}

func TestAnthropicRefusal(t *testing.T) {
	f := newFakeServer(t, anthropicSSE(
		msgStart("claude-opus-5-5"),
		blockStart(0, `{"type":"tool_use","id":"toolu_x","name":"get_entry","input":{}}`),
		blockDelta(0, `{"type":"input_json_delta","partial_json":"{}"}`),
		blockStop(0),
		`{"type":"message_delta","delta":{"stop_reason":"refusal","stop_sequence":null,"stop_details":{"type":"refusal","category":"cyber","explanation":"no"}},"usage":{"output_tokens":3}}`,
		msgStop))
	p := newTestProvider(t, anthropicOpts(f.srv.URL))
	resp, _, err := stream(t, p, &Request{Model: "claude-opus-5-5", Tools: testTools, Messages: []ai.Message{userMsg("x")}})
	if err != nil || resp.StopReason != ai.StopRefusal || !strings.Contains(resp.Refusal, "cyber") {
		t.Fatalf("resp %+v err %v", resp, err)
	}
}

func TestAnthropicMidStreamErrorsAndRetry(t *testing.T) {
	clock := aitest.NewFakeClock()
	overloaded := `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`
	ok := anthropicSSE(msgStart("claude-opus-5-5"), blockStart(0, `{"type":"text","text":""}`), blockDelta(0, `{"type":"text_delta","text":"hi"}`), blockStop(0), msgDelta("end_turn", 2), msgStop)
	f := newFakeServer(t, anthropicSSE(msgStart("claude-opus-5-5"), overloaded), ok)
	p := WithRetry(newTestProvider(t, Options{Kind: KindAnthropic, BaseURL: f.srv.URL, APIKey: "k", Clock: clock}), clock)
	errc := make(chan error, 1)
	var resp *Response
	go func() {
		var err error
		resp, _, err = stream(t, p, &Request{Model: "claude-opus-5-5", Messages: []ai.Message{userMsg("x")}})
		errc <- err
	}()
	if err := advanceUntilDone(t, clock, errc); err != nil || textOf(resp.Message, ai.BlockText) != "hi" || len(f.requests("/v1/messages")) != 2 {
		t.Fatalf("err %v requests %d", err, len(f.requests("/v1/messages")))
	}

	// After visible output: no retry.
	f2 := newFakeServer(t, anthropicSSE(msgStart("m"), blockStart(0, `{"type":"text","text":""}`), blockDelta(0, `{"type":"text_delta","text":"par"}`), overloaded))
	p2 := WithRetry(newTestProvider(t, Options{Kind: KindAnthropic, BaseURL: f2.srv.URL, APIKey: "k", Clock: clock}), clock)
	_, _, err := stream(t, p2, &Request{Model: "m", Messages: []ai.Message{userMsg("x")}})
	var pe *Error
	if !errors.As(err, &pe) || pe.Code != ai.CodeOverloaded || len(f2.requests("")) != 1 {
		t.Fatalf("err %v requests %d", err, len(f2.requests("")))
	}

	// 529 → retried; 429 spend limit → not retried.
	f3 := newFakeServer(t, rawBody(529, "application/json", `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`), ok)
	p3 := WithRetry(newTestProvider(t, Options{Kind: KindAnthropic, BaseURL: f3.srv.URL, APIKey: "k", Clock: clock}), clock)
	go func() {
		_, _, err := stream(t, p3, &Request{Model: "m", Messages: []ai.Message{userMsg("x")}})
		errc <- err
	}()
	if err := advanceUntilDone(t, clock, errc); err != nil || len(f3.requests("")) != 2 {
		t.Fatalf("529: err %v requests %d", err, len(f3.requests("")))
	}
	f4 := newFakeServer(t, rawBody(429, "application/json", `{"type":"error","error":{"type":"rate_limit_error","message":"spend limit","details":{"error_code":"enforced_spend_limit_reached"}}}`))
	p4 := WithRetry(newTestProvider(t, Options{Kind: KindAnthropic, BaseURL: f4.srv.URL, APIKey: "k", Clock: clock}), clock)
	_, _, err = stream(t, p4, &Request{Model: "m", Messages: []ai.Message{userMsg("x")}})
	if !errors.As(err, &pe) || pe.Code != ai.CodeRateLimited || pe.Retryable || len(f4.requests("")) != 1 {
		t.Fatalf("spend limit: err %v requests %d", err, len(f4.requests("")))
	}

	// 500: SDK retries are off → exactly one HTTP request per WithRetry attempt.
	f5 := newFakeServer(t, rawBody(500, "application/json", `{"type":"error","error":{"type":"api_error","message":"boom"}}`))
	p5 := WithRetry(newTestProvider(t, Options{Kind: KindAnthropic, BaseURL: f5.srv.URL, APIKey: "k", Clock: clock}), clock)
	go func() {
		_, _, err := stream(t, p5, &Request{Model: "m", Messages: []ai.Message{userMsg("x")}})
		errc <- err
	}()
	if err := advanceUntilDone(t, clock, errc); err == nil || len(f5.requests("")) != 4 {
		t.Fatalf("500: err %v requests %d", err, len(f5.requests("")))
	}
}

func TestAnthropicClientIgnoresEnvironment(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "env-key")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "env-token")
	t.Setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:1")
	t.Setenv("ANTHROPIC_CUSTOM_HEADERS", "X-Evil: 1")
	t.Setenv("ANTHROPIC_PROFILE", "nope")
	ok := anthropicSSE(msgStart("m"), msgDelta("end_turn", 1), msgStop)
	f := newFakeServer(t, ok)
	for _, mode := range []string{"", "bearer"} {
		o := anthropicOpts(f.srv.URL)
		o.AnthropicAuth = mode
		p := newTestProvider(t, o)
		if _, _, err := stream(t, p, &Request{Model: "m", Messages: []ai.Message{userMsg("x")}}); err != nil {
			t.Fatalf("%s: %v", mode, err)
		}
		rs := f.requests("/v1/messages")
		h := rs[len(rs)-1].Header
		if h.Get("X-Evil") != "" {
			t.Fatal("custom headers from the environment applied")
		}
		if mode == "" && (h.Get("X-Api-Key") != "sk-ant-test-key" || h.Get("Authorization") != "") {
			t.Fatalf("x-api-key mode headers %v", h)
		}
		if mode == "bearer" && (h.Get("Authorization") != "Bearer sk-ant-test-key" || h.Get("X-Api-Key") != "") {
			t.Fatalf("bearer mode headers %v", h)
		}
		if strings.Contains(fmt.Sprint(h), "env-key") || strings.Contains(fmt.Sprint(h), "env-token") {
			t.Fatal("env credential leaked")
		}
	}
}

func TestAnthropicRequestBody(t *testing.T) {
	ok := anthropicSSE(msgStart("claude-opus-5-5"), msgDelta("end_turn", 1), msgStop)
	f := newFakeServer(t, ok)
	p := newTestProvider(t, anthropicOpts(f.srv.URL))
	p.(*anthropicP).respModel["claude-opus-5-5"] = "claude-opus-5-5"
	hist := []ai.Message{
		userMsg("first"),
		{Role: ai.RoleAssistant, Blocks: []ai.Block{
			{Type: ai.BlockThinking, Thinking: "old turn", Signature: "S0", Producer: "anthropic:claude-opus-5-5"},
			{Type: ai.BlockText, Text: "earlier answer"},
		}},
		userMsg("second"),
		{Role: ai.RoleAssistant, Blocks: []ai.Block{
			{Type: ai.BlockThinking, Thinking: "current", Signature: "S1", Producer: "anthropic:claude-opus-5-5"},
			{Type: ai.BlockThinking, Thinking: "other model", Signature: "S2", Producer: "anthropic:claude-sonnet-5-5"},
			{Type: ai.BlockToolUse, ID: "h1", ProviderCallID: "toolu_A", Producer: "anthropic:claude-opus-5-5", Name: "get_entry", Input: json.RawMessage(`{"dn":"cn=a"}`)},
		}},
		{Role: ai.RoleUser, Blocks: []ai.Block{
			{Type: ai.BlockText, Text: "hidden context"},
			{Type: ai.BlockToolResult, ToolUseID: "h1", Content: `{"ok":true}`},
		}},
	}
	if _, _, err := stream(t, p, &Request{Model: "claude-opus-5-5", System: "SYS", Tools: testTools, Messages: hist, TurnStartIndex: 2, MaxOutputTokens: 8000, ShowThinking: true}); err != nil {
		t.Fatal(err)
	}
	raw := string(f.requests("/v1/messages")[0].Body)
	for _, bad := range []string{`"temperature"`, `"top_p"`, `"top_k"`, `"eager_input_streaming"`, `"tool_choice"`, `"fallbacks"`, "old turn", "other model"} {
		if strings.Contains(raw, bad) {
			t.Fatalf("body contains %s: %s", bad, raw)
		}
	}
	body := f.lastBody(t, "/v1/messages")
	if body["cache_control"] == nil || body["system"].([]any)[0].(map[string]any)["cache_control"] == nil {
		t.Fatal("cache_control missing")
	}
	if oc, _ := body["output_config"].(map[string]any); oc["effort"] != "medium" {
		t.Fatalf("effort %v", body["output_config"])
	}
	if th, _ := body["thinking"].(map[string]any); th["type"] != "adaptive" || th["display"] != "summarized" {
		t.Fatalf("thinking %v", body["thinking"])
	}
	msgs := body["messages"].([]any)
	cur := msgs[3].(map[string]any)["content"].([]any)
	if cur[0].(map[string]any)["type"] != "thinking" || cur[0].(map[string]any)["signature"] != "S1" || len(cur) != 2 || cur[1].(map[string]any)["id"] != "toolu_A" {
		t.Fatalf("current turn %v", cur)
	}
	last := msgs[4].(map[string]any)["content"].([]any)
	if last[0].(map[string]any)["type"] != "tool_result" || last[0].(map[string]any)["tool_use_id"] != "toolu_A" {
		t.Fatalf("tool_result not first: %v", last)
	}

	// Haiku 4.5: no effort, budget_tokens thinking.
	stream(t, p, &Request{Model: "claude-haiku-4-5-20251001", Messages: []ai.Message{userMsg("x")}, Thinking: "medium", Effort: "high", MaxOutputTokens: 8000})
	body = f.lastBody(t, "/v1/messages")
	if body["output_config"] != nil {
		t.Fatalf("effort sent to haiku: %v", body["output_config"])
	}
	if th := body["thinking"].(map[string]any); th["type"] != "enabled" || th["budget_tokens"] != float64(4096) {
		t.Fatalf("haiku thinking %v", th)
	}
	// Sonnet 5.5 "off" → between_tools (effort xhigh lowered to high).
	stream(t, p, &Request{Model: "claude-sonnet-5-5", Messages: []ai.Message{userMsg("x")}, Thinking: "off", Effort: "xhigh"})
	body = f.lastBody(t, "/v1/messages")
	if th := body["thinking"].(map[string]any); th["type"] != "between_tools" || len(th) != 1 {
		t.Fatalf("sonnet thinking %v", th)
	}
	if body["output_config"].(map[string]any)["effort"] != "high" {
		t.Fatalf("sonnet effort %v", body["output_config"])
	}
	// Opus 5.5 "off": thinking omitted, effort low.
	stream(t, p, &Request{Model: "claude-opus-5-5", Messages: []ai.Message{userMsg("x")}, Thinking: "off"})
	body = f.lastBody(t, "/v1/messages")
	if body["thinking"] != nil || body["output_config"].(map[string]any)["effort"] != "low" {
		t.Fatalf("opus off %v %v", body["thinking"], body["output_config"])
	}
	// Tool-less: no tool_use/tool_result, no tools.
	stream(t, p, &Request{Model: "claude-opus-5-5", ToolLess: true, Tools: testTools, Messages: hist})
	raw = string(f.requests("/v1/messages")[len(f.requests("/v1/messages"))-1].Body)
	if strings.Contains(raw, "tool_use") || strings.Contains(raw, "tool_result") || strings.Contains(raw, `"tools"`) {
		t.Fatalf("tool-less body %s", raw)
	}
}

func TestAnthropicDiscovery(t *testing.T) {
	f := newFakeServer(t)
	pages := 0
	f.route("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		pages++
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("after_id") == "" {
			w.Write([]byte(`{"data":[{"id":"claude-opus-5-5","type":"model","display_name":"Claude Opus 5.5","created_at":"2026-09-01T00:00:00Z","max_input_tokens":1000000,"max_tokens":128000,
			"capabilities":{"image_input":{"supported":true},"thinking":{"supported":true,"types":{"adaptive":{"supported":true},"between_tools":{"supported":false},"disabled":{"supported":false},"enabled":{"supported":false}}},"effort":{"supported":true,"low":{"supported":true},"medium":{"supported":true},"high":{"supported":true},"xhigh":{"supported":true},"max":{"supported":true}}}}],
			"has_more":true,"first_id":"claude-opus-5-5","last_id":"claude-opus-5-5"}`))
			return
		}
		w.Write([]byte(`{"data":[{"id":"claude-haiku-4-5-20251001","type":"model","display_name":"Claude Haiku 4.5","created_at":"2025-10-01T00:00:00Z"}],"has_more":false,"first_id":"claude-haiku-4-5-20251001","last_id":"claude-haiku-4-5-20251001"}`))
	})
	p := newTestProvider(t, anthropicOpts(f.srv.URL))
	models, err := p.ListModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || pages != 2 {
		t.Fatalf("models %d pages %d", len(models), pages)
	}
	o := models[0]
	if o.ContextWindow != 1000000 || o.MaxOutput != 128000 || strings.Join(o.ThinkingModes, ",") != "adaptive" || len(o.EffortLevels) != 5 || !o.Default || o.Vision != ai.CapYes {
		t.Fatalf("opus %+v", o)
	}
	h := models[1]
	if h.ContextWindow != 200000 || len(h.EffortLevels) != 0 || !strings.Contains(strings.Join(h.ThinkingModes, ","), "enabled") {
		t.Fatalf("haiku (static fallback) %+v", h)
	}
	eff, missing, _ := ResolveModel(KindAnthropic, "claude-gone", models)
	if eff != "claude-opus-5-5" || !missing {
		t.Fatal(eff)
	}
	if got := f.requests("/v1/models")[0].Header.Get("X-Api-Key"); got != "sk-ant-test-key" {
		t.Fatalf("models auth %q", got)
	}
}

func TestPlanThinkingValidation(t *testing.T) {
	plan := planThinking("claude-opus-5-5", Caps{}, "", "turbo", false, 8000, false)
	if plan.effort != "medium" && len(plan.warnings) == 0 {
		t.Fatalf("invalid effort accepted %+v", plan)
	}
	plan = planThinking("claude-haiku-4-5", Caps{}, "high", "", false, 4000, false)
	if plan.thinking.OfEnabled == nil || plan.thinking.OfEnabled.BudgetTokens >= 4000 || plan.thinking.OfEnabled.BudgetTokens < 1024 {
		t.Fatalf("budget %+v", plan.thinking.OfEnabled)
	}
}

// §3.7: an Anthropic stream that stalls after its headers is aborted by the
// idle watchdog with a retryable timeout (the SDK sets no stream timeout).
func TestAnthropicIdleWatchdog(t *testing.T) {
	aitest.CheckGoroutines(t)
	clock := aitest.NewFakeClock()
	f := newFakeServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, e := range []string{msgStart("claude-opus-5-5"), blockStart(0, `{"type":"text","text":""}`), blockDelta(0, `{"type":"text_delta","text":"Hi"}`)} {
			var probe struct {
				Type string `json:"type"`
			}
			json.Unmarshal([]byte(e), &probe)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", probe.Type, e)
		}
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	o := anthropicOpts(f.srv.URL)
	o.Clock = clock
	p := newTestProvider(t, o)
	errc := make(chan error, 1)
	log := &eventLog{}
	go func() {
		_, err := p.Stream(context.Background(), &Request{Model: "claude-opus-5-5", Messages: []ai.Message{userMsg("x")}}, log.sink)
		errc <- err
	}()
	clock.WaitForTimers(t, 2) // idle + hard cap
	time.Sleep(20 * time.Millisecond)
	clock.Advance(streamIdleTimeout + time.Second)
	select {
	case err := <-errc:
		var pe *Error
		if !errors.As(err, &pe) || pe.Code != ai.CodeTimeout || !pe.Retryable {
			t.Fatalf("err %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("watchdog did not fire")
	}
}
