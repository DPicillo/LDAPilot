package provider

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

func ollamaOpts(url string) Options {
	return Options{Kind: KindOllama, BaseURL: url + "/v1", KeepAlive: "45m"}
}

func ndjson(lines ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		for _, l := range lines {
			w.Write([]byte(l + "\n"))
			w.(http.Flusher).Flush()
		}
	}
}

func TestOllamaNativeRecordedToolCall(t *testing.T) {
	f := newFakeServer(t, fileBody(t, "application/x-ndjson", "testdata/ollama_native_tool.ndjson"))
	f.route("/api/ps", rawBody(200, "application/json", `{"models":[{"name":"qwen3-vl:8b","model":"qwen3-vl:8b","context_length":16384}]}`))
	p := newTestProvider(t, ollamaOpts(f.srv.URL))
	resp, log, err := stream(t, p, &Request{Model: "qwen3-vl:8b", Tools: testTools, Messages: []ai.Message{userMsg("x")}, ContextWindow: 16384, MaxOutputTokens: 4096})
	if err != nil {
		t.Fatal(err)
	}
	calls := toolUses(resp.Message)
	if len(calls) != 1 || calls[0].ProviderCallID != "call_leztio3i" || string(calls[0].Input) != `{"filter":"(sAMAccountName=jdoe)","attributes":["mail"]}` || calls[0].Producer != "ollama:qwen3-vl:8b" {
		t.Fatalf("calls %+v", calls)
	}
	// done_reason "stop" with tool calls → tool_use
	if resp.StopReason != ai.StopToolUse || resp.Usage.InputTokens != 220 || resp.Usage.OutputTokens != 413 || resp.Usage.CacheReadTokens != 219 {
		t.Fatalf("stop %s usage %+v", resp.StopReason, resp.Usage)
	}
	if !strings.HasPrefix(textOf(resp.Message, ai.BlockThinking), "Okay, the") || log.count(EvThinkingDelta) == 0 {
		t.Fatalf("thinking %q", textOf(resp.Message, ai.BlockThinking))
	}
	if len(log.statuses(ai.StatusModelLoading)) != 0 {
		t.Fatal("loaded model reported as loading")
	}
	body := f.lastBody(t, "/api/chat")
	opts := body["options"].(map[string]any)
	if opts["num_ctx"] != float64(16384) || opts["num_predict"] != float64(4096) || body["truncate"] != false || body["keep_alive"] != "45m" || body["stream"] != true {
		t.Fatalf("body %v", body)
	}
}

func TestOllamaDoneLineCarriesContentAndCalls(t *testing.T) {
	f := newFakeServer(t, ndjson(
		`{"model":"m","message":{"role":"assistant","content":"Hel"},"done":false}`,
		`{"model":"m","message":{"role":"assistant","content":"lo","tool_calls":[{"function":{"index":0,"name":"get_entry","arguments":{"dn":"cn=a"}}}]},"done":true,"done_reason":"stop","prompt_eval_count":10,"eval_count":5}`,
	))
	p := newTestProvider(t, ollamaOpts(f.srv.URL))
	resp, _, err := stream(t, p, &Request{Model: "m", Tools: testTools, Messages: []ai.Message{userMsg("x")}})
	if err != nil {
		t.Fatal(err)
	}
	if textOf(resp.Message, ai.BlockText) != "Hello" || len(toolUses(resp.Message)) != 1 || resp.StopReason != ai.StopToolUse {
		t.Fatalf("%+v", resp.Message.Blocks)
	}
}

func TestOllamaLengthAndInterrupted(t *testing.T) {
	f := newFakeServer(t,
		ndjson(`{"model":"m","message":{"content":"","thinking":"long"},"done":true,"done_reason":"length","eval_count":200}`),
		ndjson(`{"model":"m","message":{"content":"par"},"done":false}`),
		ndjson(`{"error":"something broke"}`),
	)
	p := newTestProvider(t, ollamaOpts(f.srv.URL))
	req := &Request{Model: "m", Messages: []ai.Message{userMsg("x")}}
	resp, _, err := stream(t, p, req)
	if err != nil || resp.StopReason != ai.StopMaxTokens {
		t.Fatalf("resp %+v err %v", resp, err)
	}
	_, _, err = stream(t, p, req)
	var pe *Error
	if !errors.As(err, &pe) || pe.Code != ai.CodeStreamInterrupted {
		t.Fatalf("err %v", err)
	}
	_, _, err = stream(t, p, req)
	if !errors.As(err, &pe) || pe.Message != "something broke" {
		t.Fatalf("err %v", err)
	}
}

func TestOllamaContextExceeded(t *testing.T) {
	f := newFakeServer(t, rawBody(400, "application/json", `{"error":"request (14538 tokens) exceeds the available context size (4096 tokens), try increasing it"}`))
	p := newTestProvider(t, ollamaOpts(f.srv.URL))
	_, _, err := stream(t, p, &Request{Model: "m", Messages: []ai.Message{userMsg("x")}})
	var pe *Error
	if !errors.Is(err, ErrContextExceeded) || !errors.As(err, &pe) || pe.ContextTokens != 14538 {
		t.Fatalf("err %v", err)
	}
}

func TestOllamaRequestMapping(t *testing.T) {
	f := newFakeServer(t, ndjson(`{"model":"m","message":{"content":"ok"},"done":true,"done_reason":"stop"}`))
	p := newTestProvider(t, ollamaOpts(f.srv.URL))
	hist := []ai.Message{
		userMsg("q"),
		{Role: ai.RoleAssistant, Blocks: []ai.Block{{Type: ai.BlockThinking, Thinking: "secret"}, {Type: ai.BlockToolUse, ID: "h1", Name: "get_entry", Input: json.RawMessage(`{"dn":"cn=a"}`)}}},
		{Role: ai.RoleUser, Blocks: []ai.Block{{Type: ai.BlockToolResult, ToolUseID: "h1", Content: `{"ok":true}`}}},
	}
	if _, _, err := stream(t, p, &Request{Model: "m", System: "S", Tools: testTools, Messages: hist}); err != nil {
		t.Fatal(err)
	}
	body := f.lastBody(t, "/api/chat")
	msgs := body["messages"].([]any)
	if len(msgs) != 4 || msgs[0].(map[string]any)["role"] != "system" {
		t.Fatalf("messages %v", msgs)
	}
	asst := msgs[2].(map[string]any)
	tc := asst["tool_calls"].([]any)[0].(map[string]any)["function"].(map[string]any)
	if tc["name"] != "get_entry" || tc["arguments"].(map[string]any)["dn"] != "cn=a" {
		t.Fatalf("tool call %v", tc)
	}
	tool := msgs[3].(map[string]any)
	if tool["role"] != "tool" || tool["tool_name"] != "get_entry" || tool["tool_call_id"] == "" || tool["content"] != `{"ok":true}` {
		t.Fatalf("tool msg %v", tool)
	}
	if strings.Contains(string(f.requests("/api/chat")[0].Body), "secret") {
		t.Fatal("thinking sent to Ollama")
	}
	// Tool-less request: no tools, a single flattened user message.
	stream(t, p, &Request{Model: "m", ToolLess: true, Tools: testTools, Messages: hist})
	body = f.lastBody(t, "/api/chat")
	if body["tools"] != nil || len(body["messages"].([]any)) != 1 || strings.Contains(string(f.requests("/api/chat")[1].Body), "tool_calls") {
		t.Fatalf("tool-less body %v", body)
	}
}

func TestOllamaThinkFallbackChain(t *testing.T) {
	facts := NewMemoryParamFacts()
	f := newFakeServer(t,
		rawBody(400, "application/json", `{"error":"invalid think value: \"high\""}`),
		rawBody(400, "application/json", `{"error":"\"m\" does not support thinking"}`),
		ndjson(`{"model":"m","message":{"content":"ok"},"done":true,"done_reason":"stop"}`),
	)
	p := newTestProvider(t, Options{Kind: KindOllama, BaseURL: f.srv.URL, Params: facts})
	resp, log, err := stream(t, p, &Request{Model: "m", Messages: []ai.Message{userMsg("x")}, Thinking: "high"})
	if err != nil || textOf(resp.Message, ai.BlockText) != "ok" {
		t.Fatalf("err %v", err)
	}
	rs := f.requests("/api/chat")
	var b0, b1, b2 map[string]any
	json.Unmarshal(rs[0].Body, &b0)
	json.Unmarshal(rs[1].Body, &b1)
	json.Unmarshal(rs[2].Body, &b2)
	if b0["think"] != "high" || b1["think"] != true {
		t.Fatalf("think chain %v %v", b0["think"], b1["think"])
	}
	if _, ok := b2["think"]; ok {
		t.Fatalf("think not omitted: %v", b2["think"])
	}
	if len(log.statuses(ai.StatusWarning)) != 2 {
		t.Fatalf("warnings %+v", log.statuses(""))
	}
	if d := facts.DroppedParams(p.(*ollama).cacheKey, "m"); !d[ParamThinkLevel] || !d[ParamThink] {
		t.Fatalf("not cached: %v", d)
	}
}

func TestOllamaDiscoveryAndCloud(t *testing.T) {
	f := newFakeServer(t)
	f.route("/api/tags", rawBody(200, "application/json", `{"models":[
		{"name":"qwen3-vl:8b","model":"qwen3-vl:8b","details":{"family":"qwen3vl","parameter_size":"8.8B","quantization_level":"Q4_K_M"},"capabilities":["completion","vision","tools","thinking"]},
		{"name":"nomic-embed-text:latest","details":{"family":"nomic-bert"},"capabilities":["embedding"]},
		{"name":"gpt-oss:120b-cloud","details":{"family":"gptoss"},"capabilities":["completion","tools","thinking"],"remote_host":"https://ollama.com:443","remote_model":"gpt-oss:120b"},
		{"name":"llama3:8b","details":{"family":"llama"}}]}`))
	f.route("/api/show", func(w http.ResponseWriter, r *http.Request) {
		var req map[string]string
		json.NewDecoder(r.Body).Decode(&req)
		switch req["model"] {
		case "qwen3-vl:8b":
			w.Write([]byte(`{"parameters":"temperature 1\nnum_ctx 8192","model_info":{"general.architecture":"qwen3vl","qwen3vl.context_length":262144},"capabilities":["completion","vision","tools","thinking"],"thinking":{"values":[false,true],"default":true},"details":{"family":"qwen3vl"}}`))
		case "llama3:8b":
			w.Write([]byte(`{"model_info":{"general.architecture":"llama","llama.context_length":8192},"capabilities":["completion"]}`))
		default:
			w.Write([]byte(`{"model_info":{},"capabilities":["completion","tools"]}`))
		}
	})
	f.route("/api/ps", rawBody(200, "application/json", `{"models":[{"name":"qwen3-vl:8b","model":"qwen3-vl:8b","context_length":16384}]}`))
	p := newTestProvider(t, Options{Kind: KindOllama, BaseURL: f.srv.URL})
	models, err := p.ListModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 3 {
		t.Fatalf("models %+v", models)
	}
	byID := map[string]ai.ModelInfo{}
	for _, m := range models {
		byID[m.ID] = m
	}
	q := byID["qwen3-vl:8b"]
	if q.Tools != ai.CapYes || q.Vision != ai.CapYes || q.Thinking != ai.CapYes || q.ContextWindow != 262144 || q.ConfiguredCtx != 8192 || q.LoadedContext != 16384 || q.ParamSize != "8.8B" || strings.Join(q.ThinkingModes, ",") != "false,true" || q.Remote {
		t.Fatalf("qwen %+v", q)
	}
	if !byID["gpt-oss:120b-cloud"].Remote || byID["llama3:8b"].Tools != ai.CapNo {
		t.Fatalf("cloud/llama %+v %+v", byID["gpt-oss:120b-cloud"], byID["llama3:8b"])
	}
	caps, _ := p.ModelCaps(context.Background(), "qwen3-vl:8b")
	if caps.ContextWindow != 16384 || caps.MaxContext != 262144 || caps.Thinking != ai.CapYes {
		t.Fatalf("caps %+v", caps)
	}
	caps, _ = p.ModelCaps(context.Background(), "llama3:8b")
	if caps.ContextWindow != 8192 {
		t.Fatalf("llama caps %+v", caps)
	}
	eff, missing, _ := ResolveModel(KindOllama, "gone:1b", models)
	if eff != "qwen3-vl:8b" || !missing {
		t.Fatalf("fallback %s %v", eff, missing)
	}
	rt, ok := AsOllamaRuntime(WithRetry(p, nil))
	if !ok {
		t.Fatal("runtime")
	}
	if n, loaded, err := rt.LoadedContext(context.Background(), "qwen3-vl:8b"); err != nil || !loaded || n != 16384 {
		t.Fatalf("ps %d %v %v", n, loaded, err)
	}
	if tr, cf, err := rt.ModelContext(context.Background(), "qwen3-vl:8b"); err != nil || tr != 262144 || cf != 8192 {
		t.Fatalf("show %d %d %v", tr, cf, err)
	}
}

func TestDetectV1Truncation(t *testing.T) {
	if !DetectV1Truncation(14538, 2050) || DetectV1Truncation(2000, 100) || DetectV1Truncation(10000, 9000) {
		t.Fatal("detector")
	}
}
