package provider

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/aitest"
)

func openAIOpts(url, flavor string) Options {
	return Options{Kind: KindOpenAI, Flavor: flavor, BaseURL: url + "/v1", APIKey: "sk-test-secret"}
}

func TestOpenAIPlainTextUsageAfterFinish(t *testing.T) {
	f := newFakeServer(t, sse(
		chunk(`{"role":"assistant","content":"Hel"}`, ""),
		chunk(`{"content":"lo"}`, ""),
		chunk(`{}`, "stop"),
		usageChunk(15, 36),
		"[DONE]",
	))
	p := newTestProvider(t, openAIOpts(f.srv.URL, FlavorCustom))
	resp, log, err := stream(t, p, &Request{Model: "m1", Messages: []ai.Message{userMsg("hi")}})
	if err != nil {
		t.Fatal(err)
	}
	if got := textOf(resp.Message, ai.BlockText); got != "Hello" {
		t.Fatalf("text %q", got)
	}
	if log.text(EvTextDelta) != "Hello" {
		t.Fatalf("deltas %q", log.text(EvTextDelta))
	}
	if resp.StopReason != ai.StopEndTurn || !resp.Complete {
		t.Fatalf("stop %s complete %v", resp.StopReason, resp.Complete)
	}
	if resp.Usage.InputTokens != 15 || resp.Usage.OutputTokens != 36 || resp.Usage.CacheReadTokens != 3 || resp.Usage.ReasoningTokens != 2 {
		t.Fatalf("usage %+v", resp.Usage)
	}
	if log.count(EvUsage) != 1 {
		t.Fatal("usage event missing")
	}
	if got := f.requests("/v1/chat/completions")[0].Header.Get("Authorization"); got != "Bearer sk-test-secret" {
		t.Fatalf("auth header %q", got)
	}
}

func TestOpenAIRecordedOllamaText(t *testing.T) {
	f := newFakeServer(t, fileBody(t, "text/event-stream", "testdata/openai_ollama_text.sse"))
	p := newTestProvider(t, openAIOpts(f.srv.URL, FlavorCustom))
	resp, log, err := stream(t, p, &Request{Model: "qwen3-vl:8b", Messages: []ai.Message{userMsg("hi")}})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Usage.InputTokens != 15 || resp.Usage.OutputTokens != 36 {
		t.Fatalf("usage %+v", resp.Usage)
	}
	if resp.Model != "qwen3-vl:8b" || resp.StopReason != ai.StopEndTurn {
		t.Fatalf("model %q stop %s", resp.Model, resp.StopReason)
	}
	if strings.TrimSpace(textOf(resp.Message, ai.BlockText)) == "" || log.count(EvThinkingDelta) == 0 {
		t.Fatalf("text %q thinking deltas %d", textOf(resp.Message, ai.BlockText), log.count(EvThinkingDelta))
	}
}

func TestOpenAIFragmentedToolCallSplitUTF8(t *testing.T) {
	// The arguments {"filter":"(cn=Müller😀)"} arrive in 5 fragments; one
	// splits the UTF-8 bytes of "ü", another the surrogate pair of the emoji.
	frags := []string{`{\"filter\":`, `\"(cn=M` + "\xc3", "\xbc" + `ller\ud83d`, `\ude00`, `)\"}`}
	payloads := []string{chunk(`{"role":"assistant","tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"search_ldap","arguments":""}}]}`, "")}
	for _, fr := range frags {
		payloads = append(payloads, chunk(`{"tool_calls":[{"index":0,"function":{"arguments":"`+fr+`"}}]}`, ""))
	}
	payloads = append(payloads, chunk(`{}`, "tool_calls"), "[DONE]")
	f := newFakeServer(t, sse(payloads...))
	p := newTestProvider(t, openAIOpts(f.srv.URL, FlavorCustom))
	resp, log, err := stream(t, p, &Request{Model: "m1", Tools: testTools, Messages: []ai.Message{userMsg("x")}})
	if err != nil {
		t.Fatal(err)
	}
	calls := toolUses(resp.Message)
	if len(calls) != 1 {
		t.Fatalf("calls %d", len(calls))
	}
	var in map[string]string
	if err := json.Unmarshal(calls[0].Input, &in); err != nil || in["filter"] != "(cn=Müller😀)" {
		t.Fatalf("input %s (%v)", calls[0].Input, err)
	}
	if calls[0].ProviderCallID != "call_abc" || calls[0].Name != "search_ldap" || calls[0].Producer != "openai/custom:m1" {
		t.Fatalf("block %+v", calls[0])
	}
	if resp.StopReason != ai.StopToolUse || log.count(EvToolUseStart) != 1 {
		t.Fatalf("stop %s starts %d", resp.StopReason, log.count(EvToolUseStart))
	}
}

func TestOpenAIRecordedParallelWholeCalls(t *testing.T) {
	f := newFakeServer(t, fileBody(t, "text/event-stream", "testdata/openai_ollama_parallel_tools.sse"))
	p := newTestProvider(t, openAIOpts(f.srv.URL, FlavorCustom))
	resp, _, err := stream(t, p, &Request{Model: "qwen3-vl:8b", Tools: testTools, Messages: []ai.Message{userMsg("x")}})
	if err != nil {
		t.Fatal(err)
	}
	calls := toolUses(resp.Message)
	if len(calls) != 2 || calls[0].ProviderCallID != "call_nnf1gxmg" || calls[1].ProviderCallID != "call_hee070kd" {
		t.Fatalf("calls %+v", calls)
	}
	if string(calls[1].Input) != `{"filter":"(cn=bob)","attributes":["mail"]}` {
		t.Fatalf("input %s", calls[1].Input)
	}
	if resp.StopReason != ai.StopToolUse {
		t.Fatal(resp.StopReason)
	}
	if !strings.HasPrefix(textOf(resp.Message, ai.BlockThinking), "Okay,") {
		t.Fatalf("thinking %q", textOf(resp.Message, ai.BlockThinking))
	}
}

func TestOpenAIParallelInterleavedFragments(t *testing.T) {
	f := newFakeServer(t, sse(
		chunk(`{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"search_ldap","arguments":"{\"fil"}}]}`, ""),
		chunk(`{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"get_entry","arguments":"{\"dn\""}}]}`, ""),
		chunk(`{"tool_calls":[{"index":0,"function":{"arguments":"ter\":\"(a=1)\"}"}}]}`, ""),
		chunk(`{"tool_calls":[{"index":1,"function":{"arguments":":\"cn=x\"}"}}]}`, ""),
		chunk(`{}`, "tool_calls"), "[DONE]"))
	p := newTestProvider(t, openAIOpts(f.srv.URL, FlavorCustom))
	resp, _, err := stream(t, p, &Request{Model: "m1", Tools: testTools, Messages: []ai.Message{userMsg("x")}})
	if err != nil {
		t.Fatal(err)
	}
	calls := toolUses(resp.Message)
	if len(calls) != 2 || string(calls[0].Input) != `{"filter":"(a=1)"}` || string(calls[1].Input) != `{"dn":"cn=x"}` || calls[1].Name != "get_entry" {
		t.Fatalf("calls %+v", calls)
	}
}

func TestOpenAIReasoningAndThinkTags(t *testing.T) {
	f := newFakeServer(t,
		sse(chunk(`{"reasoning":"<think>\nweigh"}`, ""), chunk(`{"reasoning":"ing</think>"}`, ""), chunk(`{"content":"Answer"}`, ""), chunk(`{}`, "stop"), "[DONE]"),
		sse(chunk(`{"reasoning_content":"r1"}`, ""), chunk(`{"content":"A<thi"}`, ""), chunk(`{"content":"nk>inner</th"}`, ""), chunk(`{"content":"ink>\nB"}`, ""), chunk(`{}`, "stop"), "[DONE]"),
		sse(chunk(`{"content":"lone reasoning"}`, ""), chunk(`{"content":"</think>\n\nVisible"}`, ""), chunk(`{}`, "stop"), "[DONE]"),
	)
	p := newTestProvider(t, openAIOpts(f.srv.URL, FlavorCustom))

	resp, log, err := stream(t, p, &Request{Model: "m1", Messages: []ai.Message{userMsg("x")}})
	if err != nil {
		t.Fatal(err)
	}
	if got := textOf(resp.Message, ai.BlockThinking); got != "weighing" {
		t.Fatalf("thinking %q", got)
	}
	if log.text(EvThinkingDelta) != "weighing" || textOf(resp.Message, ai.BlockText) != "Answer" {
		t.Fatalf("deltas %q text %q", log.text(EvThinkingDelta), textOf(resp.Message, ai.BlockText))
	}

	resp, log, err = stream(t, p, &Request{Model: "m1", Messages: []ai.Message{userMsg("x")}})
	if err != nil {
		t.Fatal(err)
	}
	if got := textOf(resp.Message, ai.BlockThinking); got != "r1inner" {
		t.Fatalf("thinking %q", got)
	}
	if got := textOf(resp.Message, ai.BlockText); got != "AB" || strings.Contains(log.text(EvTextDelta), "think") {
		t.Fatalf("text %q deltas %q", got, log.text(EvTextDelta))
	}

	// A known thinker: a lone </think> in the first 2 KB of content.
	p.(*openAI).caps["m1"] = Caps{Thinking: ai.CapYes}
	resp, log, err = stream(t, p, &Request{Model: "m1", Messages: []ai.Message{userMsg("x")}})
	if err != nil {
		t.Fatal(err)
	}
	if textOf(resp.Message, ai.BlockThinking) != "lone reasoning" || textOf(resp.Message, ai.BlockText) != "Visible" {
		t.Fatalf("thinking %q text %q", textOf(resp.Message, ai.BlockThinking), textOf(resp.Message, ai.BlockText))
	}
	if strings.Contains(log.text(EvTextDelta), "lone") {
		t.Fatal("reasoning leaked into text deltas")
	}
}

func TestOpenAIFinishMapping(t *testing.T) {
	f := newFakeServer(t,
		sse(chunk(`{"tool_calls":[{"index":0,"id":"c","type":"function","function":{"name":"get_entry","arguments":"{}"}}]}`, ""), chunk(`{}`, "stop"), "[DONE]"),
		sse(chunk(`{"content":""}`, ""), chunk(`{}`, "length"), "[DONE]"),
		sse(chunk(`{"refusal":"I can't help with that."}`, ""), chunk(`{}`, "stop"), "[DONE]"),
		sse(chunk(`{"content":"x"}`, ""), chunk(`{}`, "content_filter"), "[DONE]"),
	)
	p := newTestProvider(t, openAIOpts(f.srv.URL, FlavorCustom))
	req := &Request{Model: "m1", Tools: testTools, Messages: []ai.Message{userMsg("x")}}
	want := []ai.StopReason{ai.StopToolUse, ai.StopMaxTokens, ai.StopRefusal, ai.StopRefusal}
	for i, w := range want {
		resp, _, err := stream(t, p, req)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StopReason != w {
			t.Fatalf("case %d: stop %s want %s", i, resp.StopReason, w)
		}
		if i == 2 && textOf(resp.Message, ai.BlockText) != "I can't help with that." {
			t.Fatalf("refusal text %q", textOf(resp.Message, ai.BlockText))
		}
	}
}

func TestOpenAIErrorShapes(t *testing.T) {
	cases := []struct {
		h        http.HandlerFunc
		code     string
		msg      string
		retry    bool
		ctxToken int
	}{
		{rawBody(404, "application/json", `{"error":{"message":"model 'no-such-model:1b' not found","type":"not_found_error","param":null,"code":null}}`), ai.CodeModelNotFound, "model 'no-such-model:1b' not found", false, 0},
		{rawBody(400, "application/json", `{"error":"json: cannot unmarshal object"}`), ai.CodeBadRequest, "json: cannot unmarshal object", false, 0},
		{rawBody(400, "text/plain", `bad things happened`), ai.CodeBadRequest, "bad things happened", false, 0},
		{rawBody(400, "application/json", `{"error":"request (14538 tokens) exceeds the available context size (4096 tokens), try increasing it"}`), ai.CodeContextExceeded, "exceeds the available", false, 14538},
		{rawBody(401, "application/json", `{"error":{"message":"invalid key sk-test-secret"}}`), ai.CodeAuthFailed, "invalid key ***", false, 0},
		{rawBody(503, "application/json", `{"error":"busy"}`), ai.CodeOverloaded, "busy", true, 0},
		{rawBody(404, "text/plain", `404 page not found`), ai.CodeBadRequest, "Check the URL", false, 0},
	}
	for i, c := range cases {
		f := newFakeServer(t, c.h)
		p := newTestProvider(t, openAIOpts(f.srv.URL, FlavorCustom))
		_, _, err := stream(t, p, &Request{Model: "m1", Messages: []ai.Message{userMsg("x")}})
		var pe *Error
		if !errors.As(err, &pe) {
			t.Fatalf("case %d: %v", i, err)
		}
		if pe.Code != c.code || !strings.Contains(pe.Message, c.msg) || pe.Retryable != c.retry || pe.ContextTokens != c.ctxToken {
			t.Fatalf("case %d: %+v", i, pe)
		}
		if strings.Contains(pe.Error(), "sk-test-secret") {
			t.Fatalf("case %d: secret in error", i)
		}
		if c.code == ai.CodeContextExceeded && !errors.Is(err, ErrContextExceeded) {
			t.Fatalf("case %d: not ErrContextExceeded", i)
		}
	}
}

func TestRetryPolicy(t *testing.T) {
	clock := aitest.NewFakeClock()
	ok := sse(chunk(`{"content":"ok"}`, "stop"), "[DONE]")
	f := newFakeServer(t,
		rawBody(429, "application/json", `{"error":"slow down"}`, "Retry-After", "2"),
		rawBody(429, "application/json", `{"error":"slow down"}`, "Retry-After", clock.Now().Add(5*time.Second).Format(http.TimeFormat)),
		rawBody(503, "application/json", `{"error":"busy"}`),
		ok,
	)
	inner := newTestProvider(t, Options{Kind: KindOpenAI, Flavor: FlavorCustom, BaseURL: f.srv.URL + "/v1", Clock: clock})
	p := WithRetry(inner, clock).(*retrying)
	p.jitter = func() float64 { return 0.5 } // no jitter
	log := &eventLog{}
	done := make(chan error, 1)
	var resp *Response
	go func() {
		var err error
		resp, err = p.Stream(context.Background(), &Request{Model: "m1", Messages: []ai.Message{userMsg("x")}}, log.sink)
		done <- err
	}()
	// The HTTP date is 5 s after the start; 2 s have passed when it is read.
	waits := []time.Duration{2 * time.Second, 3 * time.Second, 4 * time.Second}
	for i, w := range waits {
		clock.WaitForTimers(t, 1)
		st := log.statuses(ai.StatusRetrying)
		if len(st) != i+1 || st[i].DelayMs != w.Milliseconds() || st[i].Attempt != i+1 {
			t.Fatalf("retry %d: statuses %+v", i, st)
		}
		clock.Advance(w)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if textOf(resp.Message, ai.BlockText) != "ok" || len(f.requests("/v1/chat/completions")) != 4 {
		t.Fatalf("requests %d", len(f.requests("/v1/chat/completions")))
	}
}

func TestRetryNotForAuthAndLongRetryAfter(t *testing.T) {
	clock := aitest.NewFakeClock()
	f := newFakeServer(t, rawBody(401, "application/json", `{"error":"nope"}`))
	p := WithRetry(newTestProvider(t, Options{Kind: KindOpenAI, BaseURL: f.srv.URL + "/v1", Clock: clock}), clock)
	_, _, err := stream(t, p, &Request{Model: "m1", Messages: []ai.Message{userMsg("x")}})
	var pe *Error
	if !errors.As(err, &pe) || pe.Code != ai.CodeAuthFailed || len(f.requests("")) != 1 {
		t.Fatalf("err %v requests %d", err, len(f.requests("")))
	}

	f2 := newFakeServer(t, rawBody(429, "application/json", `{"error":"later"}`, "Retry-After", "120"))
	p2 := WithRetry(newTestProvider(t, Options{Kind: KindOpenAI, BaseURL: f2.srv.URL + "/v1", Clock: clock}), clock)
	start := time.Now()
	_, _, err = stream(t, p2, &Request{Model: "m1", Messages: []ai.Message{userMsg("x")}})
	if !errors.As(err, &pe) || pe.Code != ai.CodeRateLimited || !strings.Contains(pe.Message, "120 s") || len(f2.requests("")) != 1 || time.Since(start) > time.Second {
		t.Fatalf("err %v requests %d", err, len(f2.requests("")))
	}
}

func TestRetryBackoffJitterBounds(t *testing.T) {
	r := &retrying{jitter: func() float64 { return 0 }}
	if d := r.backoff(1); d != 800*time.Millisecond {
		t.Fatal(d)
	}
	r.jitter = func() float64 { return 0.999999 }
	if d := r.backoff(3); d < 4790*time.Millisecond || d > 4800*time.Millisecond {
		t.Fatal(d)
	}
	r.jitter = func() float64 { return 0.5 }
	if d := r.backoff(10); d != 30*time.Second {
		t.Fatal(d)
	}
}

func TestOpenAICancellationMidStream(t *testing.T) {
	aitest.CheckGoroutines(t)
	release := make(chan struct{})
	f := newFakeServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fl := w.(http.Flusher)
		for i := 0; i < 3; i++ {
			w.Write([]byte("data: " + chunk(`{"content":"x"}`, "") + "\n\n"))
			fl.Flush()
		}
		select {
		case <-r.Context().Done():
		case <-release:
		}
	})
	defer close(release)
	p := newTestProvider(t, openAIOpts(f.srv.URL, FlavorCustom))
	ctx, cancel := context.WithCancel(context.Background())
	got := make(chan struct{})
	var n int
	sink := func(e Event) {
		if e.Kind == EvTextDelta {
			n++
			if n == 3 {
				close(got)
			}
		}
	}
	errc := make(chan error, 1)
	go func() {
		_, err := p.Stream(ctx, &Request{Model: "m1", Messages: []ai.Message{userMsg("x")}}, sink)
		errc <- err
	}()
	<-got
	start := time.Now()
	cancel()
	select {
	case err := <-errc:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err %v", err)
		}
		if time.Since(start) > 100*time.Millisecond {
			t.Fatalf("took %v", time.Since(start))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Stream did not return after cancel")
	}
}

func TestOpenAITermination(t *testing.T) {
	f := newFakeServer(t,
		sse(chunk(`{"content":"done"}`, ""), chunk(`{}`, "stop")), // finish then EOF, no [DONE]
		sse(chunk(`{"content":"partial"}`, "")),                   // EOF without finish
		rawBody(200, "text/event-stream", ""),                     // nothing at all
		sse(chunk(`{"content":"ok"}`, "stop"), "[DONE]"),
	)
	p := newTestProvider(t, openAIOpts(f.srv.URL, FlavorCustom))
	req := &Request{Model: "m1", Messages: []ai.Message{userMsg("x")}}
	resp, _, err := stream(t, p, req)
	if err != nil || !resp.Complete || !containsSub(resp.Warnings, "without [DONE]") {
		t.Fatalf("resp %+v err %v", resp, err)
	}
	_, _, err = stream(t, p, req)
	var pe *Error
	if !errors.As(err, &pe) || pe.Code != ai.CodeStreamInterrupted {
		t.Fatalf("err %v", err)
	}

	// With the retry wrapper: interrupted after output → no retry;
	// interrupted before any output → retried.
	clock := aitest.NewFakeClock()
	f2 := newFakeServer(t, sse(chunk(`{"content":"partial"}`, "")), sse(chunk(`{"content":"ok"}`, "stop"), "[DONE]"))
	rp := WithRetry(newTestProvider(t, Options{Kind: KindOpenAI, BaseURL: f2.srv.URL + "/v1", Clock: clock}), clock)
	_, _, err = stream(t, rp, req)
	if !errors.As(err, &pe) || pe.Code != ai.CodeStreamInterrupted || len(f2.requests("")) != 1 {
		t.Fatalf("err %v requests %d", err, len(f2.requests("")))
	}
	f3 := newFakeServer(t, rawBody(200, "text/event-stream", ""), sse(chunk(`{"content":"ok"}`, "stop"), "[DONE]"))
	rp3 := WithRetry(newTestProvider(t, Options{Kind: KindOpenAI, BaseURL: f3.srv.URL + "/v1", Clock: clock}), clock)
	errc := make(chan error, 1)
	go func() { _, _, err := stream(t, rp3, req); errc <- err }()
	if err := advanceUntilDone(t, clock, errc); err != nil || len(f3.requests("")) != 2 {
		t.Fatalf("err %v requests %d", err, len(f3.requests("")))
	}
}

// advanceUntilDone advances the fake clock in small steps until the
// goroutine reports on errc.
func advanceUntilDone(t *testing.T, clock *aitest.FakeClock, errc chan error) error {
	t.Helper()
	for i := 0; i < 2000; i++ {
		select {
		case err := <-errc:
			return err
		case <-time.After(2 * time.Millisecond):
			clock.Advance(100 * time.Millisecond)
		}
	}
	t.Fatal("did not finish")
	return nil
}

func containsSub(list []string, sub string) bool {
	for _, s := range list {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

func TestOpenAIIdleWatchdog(t *testing.T) {
	aitest.CheckGoroutines(t)
	clock := aitest.NewFakeClock()
	f := newFakeServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("data: " + chunk(`{"content":"x"}`, "") + "\n\n"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	p := newTestProvider(t, Options{Kind: KindOpenAI, BaseURL: f.srv.URL + "/v1", Clock: clock})
	errc := make(chan error, 1)
	log := &eventLog{}
	go func() {
		_, err := p.Stream(context.Background(), &Request{Model: "m1", Messages: []ai.Message{userMsg("x")}}, log.sink)
		errc <- err
	}()
	clock.WaitForTimers(t, 2) // idle + hard cap
	time.Sleep(20 * time.Millisecond)
	clock.Advance(streamIdleTimeout + time.Second)
	select {
	case err := <-errc:
		var pe *Error
		if !errors.As(err, &pe) || pe.Code != ai.CodeTimeout {
			t.Fatalf("err %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("watchdog did not fire")
	}
}

func TestLoopbackHeaderTimeout(t *testing.T) {
	c := NewHTTPClient(HTTPOptions{BaseURL: "http://127.0.0.1:11434"})
	if c.Transport.(*http.Transport).ResponseHeaderTimeout != 10*time.Minute || c.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("loopback client")
	}
	c = NewHTTPClient(HTTPOptions{BaseURL: "https://api.openai.com/v1", RequestTimeout: 90 * time.Second})
	if c.Transport.(*http.Transport).ResponseHeaderTimeout != 90*time.Second || c.Transport.(*http.Transport).Proxy == nil || c.Timeout != 0 {
		t.Fatal("remote client")
	}
}

func TestOllamaV1FirstByteStatus(t *testing.T) {
	aitest.CheckGoroutines(t)
	clock := aitest.NewFakeClock()
	release := make(chan struct{})
	f := newFakeServer(t, func(w http.ResponseWriter, r *http.Request) {
		<-release
		sse(chunk(`{"content":"ok"}`, "stop"), "[DONE]")(w, r)
	})
	psCalls := 0
	f.route("/api/ps", func(w http.ResponseWriter, r *http.Request) {
		psCalls++
		if psCalls <= 2 {
			io := `{"models":[]}`
			w.Write([]byte(io))
			return
		}
		w.Write([]byte(`{"models":[{"name":"qwen3-vl:8b","model":"qwen3-vl:8b","context_length":16384}]}`))
	})
	// Port 11434 is not available in tests; use flavor ollama.
	p := newTestProvider(t, Options{Kind: KindOpenAI, Flavor: FlavorOllama, BaseURL: f.srv.URL + "/v1", Clock: clock})
	log := &eventLog{}
	errc := make(chan error, 1)
	go func() {
		_, err := p.Stream(context.Background(), &Request{Model: "qwen3-vl:8b", Messages: []ai.Message{userMsg("x")}}, log.sink)
		errc <- err
	}()
	clock.WaitForTimers(t, 1)
	if len(log.statuses(ai.StatusModelLoading)) != 1 {
		t.Fatalf("preflight status %+v", log.statuses(""))
	}
	clock.Advance(3 * time.Second)
	waitFor(t, func() bool { return len(log.statuses(ai.StatusModelLoading)) == 2 })
	clock.WaitForTimers(t, 1)
	clock.Advance(15 * time.Second)
	waitFor(t, func() bool { return len(log.statuses(ai.StatusProcessingPrompt)) == 1 })
	close(release)
	if err := <-errc; err != nil {
		t.Fatal(err)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestOpenAIRequestBody(t *testing.T) {
	f := newFakeServer(t, sse(chunk(`{"content":"ok"}`, "stop"), "[DONE]"))
	history := []ai.Message{
		userMsg("find bob"),
		{ID: "a1", Role: ai.RoleAssistant, Blocks: []ai.Block{
			{Type: ai.BlockThinking, Thinking: "secret reasoning", Producer: "openai/openai:gpt-5"},
			{Type: ai.BlockText, Text: "Searching."},
			{Type: ai.BlockToolUse, ID: "11111111-1111-4111-8111-111111111111", ProviderCallID: "call_x", Producer: "openai/openai:gpt-5", Name: "search_ldap", Input: json.RawMessage(`{"filter":"(cn=bob)"}`)},
			{Type: ai.BlockToolUse, ID: "22222222-2222-4222-8222-222222222222", ProviderCallID: "call_x", Producer: "openai/openai:gpt-5", Name: "get_entry", Input: json.RawMessage(`{"dn":"cn=bob"}`)},
		}},
		{ID: "u2", Role: ai.RoleUser, Blocks: []ai.Block{
			{Type: ai.BlockToolResult, ToolUseID: "11111111-1111-4111-8111-111111111111", Content: `{"ok":true}`},
			{Type: ai.BlockToolResult, ToolUseID: "22222222-2222-4222-8222-222222222222", Content: `{"ok":false}`, IsError: true},
			{Type: ai.BlockText, Text: "and now?"},
		}},
	}
	for _, flavor := range []string{FlavorOpenAI, FlavorLiteLLM} {
		p := newTestProvider(t, openAIOpts(f.srv.URL, flavor))
		if _, _, err := stream(t, p, &Request{Model: "gpt-5", System: "SYS", Tools: testTools, Messages: history, MaxOutputTokens: 4096, Thinking: "low"}); err != nil {
			t.Fatal(err)
		}
		body := f.lastBody(t, "/v1/chat/completions")
		if _, ok := body["tool_choice"]; ok {
			t.Fatal("tool_choice sent")
		}
		if flavor == FlavorOpenAI {
			if body["max_completion_tokens"] != float64(4096) || body["max_tokens"] != nil {
				t.Fatalf("max tokens %v %v", body["max_completion_tokens"], body["max_tokens"])
			}
		} else if body["max_tokens"] != float64(4096) || body["max_completion_tokens"] != nil {
			t.Fatalf("litellm max tokens %v", body["max_tokens"])
		}
		if body["reasoning_effort"] != "low" {
			t.Fatalf("reasoning_effort %v", body["reasoning_effort"])
		}
		so, _ := body["stream_options"].(map[string]any)
		if so["include_usage"] != true || body["stream"] != true {
			t.Fatalf("stream options %v", body["stream_options"])
		}
		msgs := body["messages"].([]any)
		roles := []string{}
		for _, m := range msgs {
			roles = append(roles, m.(map[string]any)["role"].(string))
		}
		if strings.Join(roles, ",") != "system,user,assistant,tool,tool,user" {
			t.Fatalf("roles %v", roles)
		}
		asst := msgs[2].(map[string]any)
		calls := asst["tool_calls"].([]any)
		id0 := calls[0].(map[string]any)["id"].(string)
		id1 := calls[1].(map[string]any)["id"].(string)
		if id0 == id1 {
			t.Fatal("duplicate wire IDs")
		}
		if msgs[3].(map[string]any)["tool_call_id"] != id0 || msgs[4].(map[string]any)["tool_call_id"] != id1 {
			t.Fatal("tool results not paired")
		}
		if strings.Contains(string(f.requests("")[len(f.requests(""))-1].Body), "secret reasoning") {
			t.Fatal("reasoning sent back")
		}
		if flavor == FlavorOpenAI && id0 != "call_x" {
			t.Fatalf("same-provider ID not reused: %s", id0)
		}
		if flavor == FlavorLiteLLM && id0 == "call_x" {
			t.Fatal("other-provider ID reused")
		}
	}
	// Deterministic: the same history gives byte-identical requests.
	p := newTestProvider(t, openAIOpts(f.srv.URL, FlavorCustom))
	stream(t, p, &Request{Model: "m", Tools: testTools, Messages: history})
	stream(t, p, &Request{Model: "m", Tools: testTools, Messages: history})
	rs := f.requests("/v1/chat/completions")
	if string(rs[len(rs)-1].Body) != string(rs[len(rs)-2].Body) {
		t.Fatal("requests differ")
	}
}

func TestOpenAIThinkingOffMapping(t *testing.T) {
	f := newFakeServer(t, sse(chunk(`{"content":"ok"}`, "stop"), "[DONE]"))
	for flavor, check := range map[string]func(map[string]any) bool{
		FlavorOllama: func(b map[string]any) bool { return b["reasoning_effort"] == "none" },
		FlavorVLLM: func(b map[string]any) bool {
			k, _ := b["chat_template_kwargs"].(map[string]any)
			return k["enable_thinking"] == false && b["reasoning_effort"] == nil
		},
		FlavorCustom: func(b map[string]any) bool { return b["reasoning_effort"] == nil && b["chat_template_kwargs"] == nil },
	} {
		p := newTestProvider(t, openAIOpts(f.srv.URL, flavor))
		if _, _, err := stream(t, p, &Request{Model: "m", Messages: []ai.Message{userMsg("x")}, Thinking: "off"}); err != nil {
			t.Fatal(err)
		}
		if !check(f.lastBody(t, "/v1/chat/completions")) {
			t.Fatalf("%s: %v", flavor, f.lastBody(t, "/v1/chat/completions"))
		}
	}
}

func TestOpenAIToolLessRequest(t *testing.T) {
	f := newFakeServer(t, sse(chunk(`{"content":"Title"}`, "stop"), "[DONE]"))
	p := newTestProvider(t, openAIOpts(f.srv.URL, FlavorCustom))
	history := []ai.Message{
		userMsg("find bob"),
		{Role: ai.RoleAssistant, Blocks: []ai.Block{{Type: ai.BlockToolUse, ID: "t1", Name: "search_ldap", Input: json.RawMessage(`{"filter":"(cn=bob)"}`)}}},
		{Role: ai.RoleUser, Blocks: []ai.Block{{Type: ai.BlockToolResult, ToolUseID: "t1", Content: `{"dn":"CN=Bob,DC=x"}`, Meta: &ai.BlockMeta{Summary: "1 entry"}}}},
		{Role: ai.RoleAssistant, Blocks: []ai.Block{{Type: ai.BlockText, Text: "Bob is CN=Bob,DC=x"}}},
	}
	if _, _, err := stream(t, p, &Request{Model: "m", ToolLess: true, Tools: testTools, Messages: history}); err != nil {
		t.Fatal(err)
	}
	body := f.lastBody(t, "/v1/chat/completions")
	if body["tools"] != nil {
		t.Fatal("tools sent")
	}
	msgs := body["messages"].([]any)
	if len(msgs) != 1 || msgs[0].(map[string]any)["role"] != "user" {
		t.Fatalf("messages %v", msgs)
	}
	content := msgs[0].(map[string]any)["content"].(string)
	if !strings.Contains(content, "<transcript>") || !strings.Contains(content, "[tool search_ldap(") || !strings.Contains(content, "1 entry") || !strings.Contains(content, "result excerpt") {
		t.Fatalf("transcript %s", content)
	}
}

func TestOpenAILiteLLMThinkingBlocks(t *testing.T) {
	stream1 := sse(
		chunk(`{"reasoning_content":"Let me ","thinking_blocks":[{"index":0,"type":"thinking","thinking":"Let me "}]}`, ""),
		chunk(`{"reasoning_content":"think.","thinking_blocks":[{"index":0,"type":"thinking","thinking":"think.","signature":"sig-part1"}]}`, ""),
		chunk(`{"thinking_blocks":[{"index":0,"type":"thinking","thinking":"","signature":"sig-part2"}]}`, ""),
		chunk(`{"tool_calls":[{"index":0,"id":"toolu_1","type":"function","function":{"name":"get_entry","arguments":"{\"dn\":\"cn=a\"}"}}]}`, ""),
		chunk(`{}`, "tool_calls"), "[DONE]")
	nonStream := rawBody(200, "application/json", `{"id":"x","model":"claude-opus-5-5","choices":[{"index":0,"message":{"role":"assistant","content":"Hi","reasoning_content":"r","thinking_blocks":[{"type":"thinking","thinking":"r","signature":"S2"}]},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}`)
	f := newFakeServer(t, stream1, nonStream, sse(chunk(`{"content":"ok"}`, "stop"), "[DONE]"))
	p := newTestProvider(t, openAIOpts(f.srv.URL, FlavorLiteLLM))
	resp, _, err := stream(t, p, &Request{Model: "claude", Tools: testTools, Messages: []ai.Message{userMsg("x")}})
	if err != nil {
		t.Fatal(err)
	}
	var th ai.Block
	for _, b := range resp.Message.Blocks {
		if b.Type == ai.BlockThinking {
			th = b
		}
	}
	if th.Thinking != "Let me think." || th.Signature != "sig-part1sig-part2" || th.Producer != "openai/litellm:m1" {
		t.Fatalf("thinking block %+v", th)
	}
	resp2, _, err := stream(t, p, &Request{Model: "claude", Messages: []ai.Message{userMsg("x")}})
	if err != nil {
		t.Fatal(err)
	}
	if resp2.Message.Blocks[0].Signature != "S2" || textOf(resp2.Message, ai.BlockText) != "Hi" {
		t.Fatalf("non-stream %+v", resp2.Message.Blocks)
	}

	// Same turn: echoed byte-identically; earlier turn: not echoed.
	resp.Message.Blocks[len(resp.Message.Blocks)-1].ID = "33333333-3333-4333-8333-333333333333"
	tr := ai.Message{Role: ai.RoleUser, Blocks: []ai.Block{{Type: ai.BlockToolResult, ToolUseID: "33333333-3333-4333-8333-333333333333", Content: "{}"}}}
	hist := []ai.Message{userMsg("x"), resp.Message, tr}
	p.(*openAI).respModel["claude"] = "m1"
	stream(t, p, &Request{Model: "claude", Tools: testTools, Messages: hist, TurnStartIndex: 0})
	body := f.lastBody(t, "/v1/chat/completions")
	asst := body["messages"].([]any)[1].(map[string]any)
	tb, _ := asst["thinking_blocks"].([]any)
	if len(tb) != 1 || tb[0].(map[string]any)["signature"] != "sig-part1sig-part2" || tb[0].(map[string]any)["thinking"] != "Let me think." {
		t.Fatalf("thinking_blocks %v", asst["thinking_blocks"])
	}
	stream(t, p, &Request{Model: "claude", Tools: testTools, Messages: append(hist, userMsg("next")), TurnStartIndex: 3})
	body = f.lastBody(t, "/v1/chat/completions")
	if _, ok := body["messages"].([]any)[1].(map[string]any)["thinking_blocks"]; ok {
		t.Fatal("thinking from an earlier turn echoed")
	}
	// Other flavors never send reasoning back.
	p2 := newTestProvider(t, openAIOpts(f.srv.URL, FlavorCustom))
	stream(t, p2, &Request{Model: "claude", Tools: testTools, Messages: hist})
	if strings.Contains(string(f.requests("")[len(f.requests(""))-1].Body), "thinking_blocks") {
		t.Fatal("custom flavor echoed thinking")
	}
}

func TestOpenAIUnsupportedParams(t *testing.T) {
	facts := NewMemoryParamFacts()
	f := newFakeServer(t,
		rawBody(400, "application/json", `{"error":{"message":"Unrecognized request argument supplied: reasoning_effort","type":"invalid_request_error"}}`),
		sse(chunk(`{"content":"ok"}`, "stop"), "[DONE]"),
		sse(chunk(`{"content":"ok"}`, "stop"), "[DONE]"),
	)
	p := newTestProvider(t, Options{Kind: KindOpenAI, Flavor: FlavorLiteLLM, BaseURL: f.srv.URL + "/v1", Params: facts})
	req := &Request{Model: "m", Messages: []ai.Message{userMsg("x")}, Thinking: "high"}
	_, log, err := stream(t, p, req)
	if err != nil {
		t.Fatal(err)
	}
	rs := f.requests("/v1/chat/completions")
	if len(rs) != 2 || strings.Contains(string(rs[1].Body), "reasoning_effort") {
		t.Fatalf("requests %d", len(rs))
	}
	if st := log.statuses(ai.StatusWarning); len(st) != 1 || st[0].Param != "reasoning_effort" {
		t.Fatalf("warning %+v", st)
	}
	// Cached: the next request skips it without a 400.
	stream(t, p, req)
	if rs = f.requests("/v1/chat/completions"); len(rs) != 3 || strings.Contains(string(rs[2].Body), "reasoning_effort") {
		t.Fatal("param not cached")
	}

	// max_completion_tokens → max_tokens
	f2 := newFakeServer(t, rawBody(400, "application/json", `{"error":{"message":"Unsupported parameter: 'max_completion_tokens'"}}`), sse(chunk(`{"content":"ok"}`, "stop"), "[DONE]"))
	p2 := newTestProvider(t, Options{Kind: KindOpenAI, Flavor: FlavorOpenAI, BaseURL: f2.srv.URL + "/v1"})
	if _, _, err := stream(t, p2, &Request{Model: "m", Messages: []ai.Message{userMsg("x")}, MaxOutputTokens: 1000}); err != nil {
		t.Fatal(err)
	}
	b := f2.lastBody(t, "/v1/chat/completions")
	if b["max_tokens"] != float64(1000) || b["max_completion_tokens"] != nil {
		t.Fatalf("body %v", b)
	}

	// LiteLLM UnsupportedParamsError naming stream_options.
	f3 := newFakeServer(t, rawBody(400, "application/json", `{"error":{"message":"litellm.UnsupportedParamsError: stream_options is not supported","type":"None","code":"400"}}`), sse(chunk(`{"content":"ok"}`, "stop"), "[DONE]"))
	p3 := newTestProvider(t, Options{Kind: KindOpenAI, Flavor: FlavorLiteLLM, BaseURL: f3.srv.URL + "/v1"})
	resp, _, err := stream(t, p3, &Request{Model: "m", Messages: []ai.Message{userMsg("x")}})
	if err != nil || f3.lastBody(t, "/v1/chat/completions")["stream_options"] != nil || !containsSub(resp.Warnings, "usage") {
		t.Fatalf("err %v body %v", err, f3.lastBody(t, "/v1/chat/completions"))
	}

	// No fallback after visible output.
	f4 := newFakeServer(t, sse(chunk(`{"content":"vis"}`, ""), `{"error":{"message":"reasoning_effort unsupported","code":"400"}}`))
	p4 := newTestProvider(t, Options{Kind: KindOpenAI, Flavor: FlavorLiteLLM, BaseURL: f4.srv.URL + "/v1"})
	if _, _, err := stream(t, p4, &Request{Model: "m", Messages: []ai.Message{userMsg("x")}, Thinking: "low"}); err == nil || len(f4.requests("")) != 1 {
		t.Fatalf("err %v requests %d", err, len(f4.requests("")))
	}
}

func TestEndpointLimiterQueues(t *testing.T) {
	aitest.CheckGoroutines(t)
	release := make(chan struct{})
	started := make(chan struct{}, 2)
	f := newFakeServer(t, func(w http.ResponseWriter, r *http.Request) {
		started <- struct{}{}
		<-release
		sse(chunk(`{"content":"ok"}`, "stop"), "[DONE]")(w, r)
	})
	lim := NewLimiters()
	o := Options{Kind: KindOpenAI, BaseURL: f.srv.URL + "/v1", Limiters: lim, Concurrency: 1}
	p1 := newTestProvider(t, o)
	p2 := newTestProvider(t, o)
	errc := make(chan error, 2)
	go func() {
		_, _, err := stream(t, p1, &Request{Model: "m", Messages: []ai.Message{userMsg("x")}})
		errc <- err
	}()
	<-started
	log := &eventLog{}
	go func() {
		_, err := p2.Stream(context.Background(), &Request{Model: "m", Messages: []ai.Message{userMsg("x")}}, log.sink)
		errc <- err
	}()
	waitFor(t, func() bool { return len(log.statuses(ai.StatusQueued)) == 1 })
	if len(f.requests("")) != 1 {
		t.Fatal("second request sent while queued")
	}
	close(release)
	for i := 0; i < 2; i++ {
		if err := <-errc; err != nil {
			t.Fatal(err)
		}
	}
}

func TestOpenAIDiscovery(t *testing.T) {
	f := newFakeServer(t)
	f.route("/v1/models", rawBody(200, "application/json", `{"data":[{"id":"gpt-4o","owned_by":"openai"},{"id":"text-embedding-3-small"},{"id":"whisper-1"},{"id":"llama","max_model_len":32768},{"id":"emb","type":"embeddings"}]}`))
	f.route("/model/info", rawBody(200, "application/json", `{"data":[{"model_name":"gpt-4o","model_info":{"max_input_tokens":128000,"max_output_tokens":16384,"supports_function_calling":true,"supports_vision":true}}]}`))
	p := newTestProvider(t, openAIOpts(f.srv.URL, FlavorLiteLLM))
	models, err := p.ListModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0].ID != "gpt-4o" || models[1].ID != "llama" {
		t.Fatalf("models %+v", models)
	}
	if models[0].ContextWindow != 128000 || models[0].Tools != ai.CapYes || !models[0].ToolsVerified || models[1].ContextWindow != 32768 || models[1].Tools != ai.CapUnknown {
		t.Fatalf("caps %+v", models)
	}
	caps, _ := p.ModelCaps(context.Background(), "llama")
	if caps.ContextWindow != 32768 || caps.Source != "models" {
		t.Fatalf("caps %+v", caps)
	}
	caps, _ = p.ModelCaps(context.Background(), "unknown")
	if caps.ContextWindow != 8192 || caps.Source != "default" {
		t.Fatalf("default caps %+v", caps)
	}

	// OpenAI flavor uses the static table.
	po := newTestProvider(t, openAIOpts(f.srv.URL, FlavorOpenAI))
	models, _ = po.ListModels(context.Background())
	if models[0].ContextWindow != 128000 || models[0].ContextSource != "table" {
		t.Fatalf("openai table %+v", models[0])
	}
}

// §4.3/§6.8: an Ollama cloud model is remote also when only the /v1
// listing is available (the native /api/tags failed), and a cloud name is
// recognized without any listing.
func TestOllamaV1ListingMarksCloudModelsRemote(t *testing.T) {
	f := newFakeServer(t)
	f.route("/api/tags", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "boom", http.StatusInternalServerError) })
	f.route("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":[{"id":"gpt-oss:120b-cloud"},{"id":"qwen3-vl:8b"}]}`))
	})
	p := newTestProvider(t, Options{Kind: KindOpenAI, Flavor: FlavorOllama, BaseURL: f.srv.URL + "/v1", ContextWindow: 16384})
	models, err := p.ListModels(context.Background())
	if err != nil || len(models) != 2 {
		t.Fatalf("%v %+v", err, models)
	}
	for _, m := range models {
		if m.Remote != (m.ID == "gpt-oss:120b-cloud") {
			t.Fatalf("%s remote=%v", m.ID, m.Remote)
		}
	}
	caps, _ := p.ModelCaps(context.Background(), "gpt-oss:120b-cloud")
	if !caps.Remote || !caps.Listed {
		t.Fatalf("caps %+v", caps)
	}
	if !IsCloudModel("deepseek-v3.1:671b-cloud") || !IsCloudModel("x:cloud") || IsCloudModel("qwen3-vl:8b") {
		t.Fatal("IsCloudModel")
	}
}
