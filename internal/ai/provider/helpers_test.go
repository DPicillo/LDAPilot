package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/aitest"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
)

// recordedRequest is one request a fake server received.
type recordedRequest struct {
	Method, Path string
	Header       http.Header
	Body         []byte
}

// fakeServer serves scripted responses in order (the last one repeats).
type fakeServer struct {
	t        *testing.T
	srv      *httptest.Server
	mu       sync.Mutex
	reqs     []recordedRequest
	handlers []http.HandlerFunc
	routes   map[string]http.HandlerFunc // exact path → handler (takes precedence)
}

func newFakeServer(t *testing.T, handlers ...http.HandlerFunc) *fakeServer {
	f := &fakeServer{t: t, handlers: handlers, routes: map[string]http.HandlerFunc{
		// Ollama pre-flight checks hit /api/ps; unless a test routes it,
		// answer 404 (= unknown, no status) without consuming a handler.
		"/api/ps": http.NotFound,
	}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeServer) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(body))
	f.mu.Lock()
	f.reqs = append(f.reqs, recordedRequest{Method: r.Method, Path: r.URL.Path, Header: r.Header.Clone(), Body: body})
	h, ok := f.routes[r.URL.Path]
	if !ok {
		n := 0
		for _, rq := range f.reqs {
			if _, routed := f.routes[rq.Path]; !routed {
				n++
			}
		}
		if len(f.handlers) == 0 {
			f.mu.Unlock()
			http.NotFound(w, r)
			return
		}
		if n > len(f.handlers) {
			n = len(f.handlers)
		}
		h = f.handlers[n-1]
	}
	f.mu.Unlock()
	h(w, r)
}

func (f *fakeServer) route(path string, h http.HandlerFunc) {
	f.mu.Lock()
	f.routes[path] = h
	f.mu.Unlock()
}

func (f *fakeServer) requests(path string) []recordedRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []recordedRequest
	for _, r := range f.reqs {
		if path == "" || r.Path == path {
			out = append(out, r)
		}
	}
	return out
}

func (f *fakeServer) lastBody(t *testing.T, path string) map[string]any {
	t.Helper()
	rs := f.requests(path)
	if len(rs) == 0 {
		t.Fatalf("no request to %s", path)
	}
	var m map[string]any
	if err := json.Unmarshal(rs[len(rs)-1].Body, &m); err != nil {
		t.Fatalf("request body: %v", err)
	}
	return m
}

// sse writes SSE lines; each payload becomes "data: <payload>\n\n".
func sse(payloads ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fl, _ := w.(http.Flusher)
		for _, p := range payloads {
			fmt.Fprintf(w, "data: %s\n\n", p)
			if fl != nil {
				fl.Flush()
			}
		}
	}
}

// rawBody writes a fixed body with a content type and status.
func rawBody(status int, contentType, body string, headers ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", contentType)
		for i := 0; i+1 < len(headers); i += 2 {
			w.Header().Set(headers[i], headers[i+1])
		}
		w.WriteHeader(status)
		io.WriteString(w, body)
	}
}

func fileBody(t *testing.T, contentType, path string) http.HandlerFunc {
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return rawBody(200, contentType, string(data))
}

// chunk builds an OpenAI chat.completion.chunk JSON with one choice delta.
func chunk(delta string, finish string) string {
	fr := "null"
	if finish != "" {
		fr = `"` + finish + `"`
	}
	return fmt.Sprintf(`{"id":"c1","object":"chat.completion.chunk","model":"m1","choices":[{"index":0,"delta":%s,"finish_reason":%s}]}`, delta, fr)
}

func usageChunk(prompt, completion int) string {
	return fmt.Sprintf(`{"id":"c1","object":"chat.completion.chunk","model":"m1","choices":[],"usage":{"prompt_tokens":%d,"completion_tokens":%d,"prompt_tokens_details":{"cached_tokens":3},"completion_tokens_details":{"reasoning_tokens":2}}}`, prompt, completion)
}

// eventLog collects sink events.
type eventLog struct {
	mu     sync.Mutex
	events []Event
}

func (l *eventLog) sink(e Event) {
	l.mu.Lock()
	l.events = append(l.events, e)
	l.mu.Unlock()
}

func (l *eventLog) text(kind EventKind) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var b strings.Builder
	for _, e := range l.events {
		if e.Kind == kind {
			b.WriteString(e.Text)
		}
	}
	return b.String()
}

func (l *eventLog) statuses(kind string) []Status {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []Status
	for _, e := range l.events {
		if e.Kind == EvStatus && e.Status != nil && (kind == "" || e.Status.Kind == kind) {
			out = append(out, *e.Status)
		}
	}
	return out
}

func (l *eventLog) count(kind EventKind) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, e := range l.events {
		if e.Kind == kind {
			n++
		}
	}
	return n
}

var testTools = []tools.Spec{
	{Name: "search_ldap", Description: "Search", Parameters: json.RawMessage(`{"type":"object","properties":{"filter":{"type":"string"}},"required":["filter"]}`)},
	{Name: "get_entry", Description: "Get", Parameters: json.RawMessage(`{"type":"object","properties":{"dn":{"type":"string"}},"required":["dn"]}`)},
}

func userMsg(text string) ai.Message {
	return ai.Message{ID: "u-" + text, Role: ai.RoleUser, Blocks: []ai.Block{{Type: ai.BlockText, Text: text}}}
}

func newTestProvider(t *testing.T, o Options) Provider {
	t.Helper()
	if o.Clock == nil {
		o.Clock = aitest.NewFakeClock()
	}
	if o.Limiters == nil {
		o.Limiters = NewLimiters()
	}
	p, err := NewUnwrapped(o)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func stream(t *testing.T, p Provider, req *Request) (*Response, *eventLog, error) {
	t.Helper()
	log := &eventLog{}
	resp, err := p.Stream(context.Background(), req, log.sink)
	return resp, log, err
}

func toolUses(m ai.Message) []ai.Block {
	var out []ai.Block
	for _, b := range m.Blocks {
		if b.Type == ai.BlockToolUse {
			out = append(out, b)
		}
	}
	return out
}

func textOf(m ai.Message, typ ai.BlockType) string {
	var b strings.Builder
	for _, blk := range m.Blocks {
		if blk.Type == typ {
			if typ == ai.BlockThinking {
				b.WriteString(blk.Thinking)
			} else {
				b.WriteString(blk.Text)
			}
		}
	}
	return b.String()
}
