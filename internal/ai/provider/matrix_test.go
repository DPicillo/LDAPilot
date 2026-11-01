package provider

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/aitest"
)

// The same behaviours checked once per adapter: 429 with Retry-After is
// retried after exactly the announced delay (fake clock), and a cancelled
// context ends a stream that is mid-way within 100 ms without leaking
// goroutines.

type adapterCase struct {
	name string
	opts func(url string) Options
	path string
	// ok streams the text "ok" and ends the turn.
	ok http.HandlerFunc
	// first3 writes three text deltas ("x") and returns.
	first3 func(w http.ResponseWriter)
	// rateLimited is a 429 body in the provider's error shape.
	rateLimited string
}

func adapterCases() []adapterCase {
	return []adapterCase{
		{
			name: "openai",
			opts: func(url string) Options { return openAIOpts(url, FlavorCustom) },
			path: "/v1/chat/completions",
			ok:   sse(chunk(`{"content":"ok"}`, "stop"), "[DONE]"),
			first3: func(w http.ResponseWriter) {
				w.Header().Set("Content-Type", "text/event-stream")
				for i := 0; i < 3; i++ {
					fmt.Fprintf(w, "data: %s\n\n", chunk(`{"content":"x"}`, ""))
				}
			},
			rateLimited: `{"error":{"message":"slow down","type":"rate_limit_error"}}`,
		},
		{
			name: "ollama",
			opts: ollamaOpts,
			path: "/api/chat",
			ok: ndjson(
				`{"model":"m","message":{"role":"assistant","content":"ok"},"done":false}`,
				`{"model":"m","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":3,"eval_count":1}`,
			),
			first3: func(w http.ResponseWriter) {
				w.Header().Set("Content-Type", "application/x-ndjson")
				for i := 0; i < 3; i++ {
					fmt.Fprintln(w, `{"model":"m","message":{"role":"assistant","content":"x"},"done":false}`)
				}
			},
			rateLimited: `{"error":"slow down"}`,
		},
		{
			name: "anthropic",
			opts: anthropicOpts,
			path: "/v1/messages",
			ok: anthropicSSE(msgStart("m"), blockStart(0, `{"type":"text","text":""}`),
				blockDelta(0, `{"type":"text_delta","text":"ok"}`), blockStop(0), msgDelta("end_turn", 1), msgStop),
			first3: func(w http.ResponseWriter) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprintf(w, "event: message_start\ndata: %s\n\n", msgStart("m"))
				fmt.Fprintf(w, "event: content_block_start\ndata: %s\n\n", blockStart(0, `{"type":"text","text":""}`))
				for i := 0; i < 3; i++ {
					fmt.Fprintf(w, "event: content_block_delta\ndata: %s\n\n", blockDelta(0, `{"type":"text_delta","text":"x"}`))
				}
			},
			rateLimited: `{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`,
		},
	}
}

func TestAdapterMatrixRetryAfter429(t *testing.T) {
	for _, ac := range adapterCases() {
		t.Run(ac.name, func(t *testing.T) {
			clock := aitest.NewFakeClock()
			var mu sync.Mutex
			var at []time.Time
			stamp := func(h http.HandlerFunc) http.HandlerFunc {
				return func(w http.ResponseWriter, r *http.Request) {
					mu.Lock()
					at = append(at, clock.Now())
					mu.Unlock()
					h(w, r)
				}
			}
			f := newFakeServer(t,
				stamp(rawBody(429, "application/json", ac.rateLimited, "Retry-After", "2")),
				stamp(ac.ok),
			)
			o := ac.opts(f.srv.URL)
			o.Clock = clock
			p := WithRetry(newTestProvider(t, o), clock)
			log := &eventLog{}
			errc := make(chan error, 1)
			var resp *Response
			go func() {
				var err error
				resp, err = p.Stream(context.Background(), &Request{Model: "m", Messages: []ai.Message{userMsg("x")}}, log.sink)
				errc <- err
			}()
			if err := advanceUntilDone(t, clock, errc); err != nil {
				t.Fatal(err)
			}
			if textOf(resp.Message, ai.BlockText) != "ok" || len(f.requests(ac.path)) != 2 {
				t.Fatalf("text %q requests %d", textOf(resp.Message, ai.BlockText), len(f.requests(ac.path)))
			}
			st := log.statuses(ai.StatusRetrying)
			if len(st) != 1 || st[0].DelayMs != 2000 || st[0].Attempt != 1 {
				t.Fatalf("retry statuses %+v", st)
			}
			mu.Lock()
			gap := at[1].Sub(at[0])
			mu.Unlock()
			// The clock advances in 100 ms steps while the retry sleeps.
			if gap < 2*time.Second || gap > 2200*time.Millisecond {
				t.Fatalf("second attempt after %v, want 2 s", gap)
			}
		})
	}
}

func TestAdapterMatrixCancellationMidStream(t *testing.T) {
	for _, ac := range adapterCases() {
		t.Run(ac.name, func(t *testing.T) {
			aitest.CheckGoroutines(t)
			release := make(chan struct{})
			f := newFakeServer(t, func(w http.ResponseWriter, r *http.Request) {
				ac.first3(w)
				w.(http.Flusher).Flush()
				select {
				case <-r.Context().Done():
				case <-release:
				}
			})
			defer close(release)
			p := WithRetry(newTestProvider(t, ac.opts(f.srv.URL)), nil)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			got := make(chan struct{})
			var once sync.Once
			n := 0
			sink := func(e Event) {
				if e.Kind == EvTextDelta {
					n += len(e.Text)
					if n >= 3 {
						once.Do(func() { close(got) })
					}
				}
			}
			errc := make(chan error, 1)
			go func() {
				_, err := p.Stream(ctx, &Request{Model: "m", Messages: []ai.Message{userMsg("x")}}, sink)
				errc <- err
			}()
			select {
			case <-got:
			case <-time.After(3 * time.Second):
				t.Fatal("no deltas")
			}
			start := time.Now()
			cancel()
			select {
			case err := <-errc:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("err %v", err)
				}
				if d := time.Since(start); d > 100*time.Millisecond {
					t.Fatalf("Stream returned %v after cancel", d)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("Stream did not return after cancel")
			}
			if len(f.requests(ac.path)) != 1 {
				t.Fatalf("cancelled stream was retried: %d requests", len(f.requests(ac.path)))
			}
		})
	}
}

func TestOllamaParallelCallsAcrossLines(t *testing.T) {
	f := newFakeServer(t, ndjson(
		`{"model":"qwen3-vl:8b","message":{"role":"assistant","content":"","thinking":"two lookups"},"done":false}`,
		`{"model":"qwen3-vl:8b","message":{"role":"assistant","content":"","tool_calls":[{"id":"call_a","function":{"index":0,"name":"get_entry","arguments":{"dn":"cn=a"}}}]},"done":false}`,
		`{"model":"qwen3-vl:8b","message":{"role":"assistant","content":"","tool_calls":[{"id":"call_b","function":{"index":1,"name":"Search-LDAP","arguments":{"filter":"(cn=b)"}}},{"function":{"index":2,"name":"get_entry","arguments":"{\"dn\":\"cn=c\"}"}}]},"done":false}`,
		`{"model":"qwen3-vl:8b","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":10,"eval_count":5}`,
	))
	p := newTestProvider(t, ollamaOpts(f.srv.URL))
	resp, log, err := stream(t, p, &Request{Model: "qwen3-vl:8b", Tools: testTools, Messages: []ai.Message{userMsg("x")}})
	if err != nil {
		t.Fatal(err)
	}
	calls := toolUses(resp.Message)
	if len(calls) != 3 || resp.StopReason != ai.StopToolUse || log.count(EvToolUseStart) != 3 {
		t.Fatalf("calls %+v stop %s starts %d", calls, resp.StopReason, log.count(EvToolUseStart))
	}
	if calls[0].ProviderCallID != "call_a" || calls[1].Name != "search_ldap" || string(calls[1].Input) != `{"filter":"(cn=b)"}` ||
		calls[2].ProviderCallID != "" || string(calls[2].Input) != `{"dn":"cn=c"}` {
		t.Fatalf("calls %+v", calls)
	}
	if textOf(resp.Message, ai.BlockThinking) != "two lookups" {
		t.Fatalf("thinking %q", textOf(resp.Message, ai.BlockThinking))
	}
}
