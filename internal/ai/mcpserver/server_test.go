package mcpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/dpicillo/LDAPilot/internal/ai/tools"
)

type bearerRT struct {
	token string
	base  http.RoundTripper
}

func (b bearerRT) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	if b.token != "" {
		r.Header.Set("Authorization", "Bearer "+b.token)
	}
	return b.base.RoundTrip(r)
}

func connect(t *testing.T, url, token string, opts *mcp.ClientOptions) (*mcp.ClientSession, error) {
	t.Helper()
	c := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "1"}, opts)
	tr := &mcp.StreamableClientTransport{Endpoint: url, HTTPClient: &http.Client{Transport: bearerRT{token, http.DefaultTransport}}, MaxRetries: -1}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return c.Connect(ctx, tr, nil)
}

var testTools = []Tool{
	{Spec: tools.Spec{Name: "get_entry", Description: "Read one entry.", Parameters: json.RawMessage(`{"type":"object","properties":{"dn":{"type":"string"}},"required":["dn"]}`)}, Title: "Get entry", ReadOnly: true},
	{Spec: tools.Spec{Name: "modify_entry", Description: "Change an entry.", Parameters: json.RawMessage(`{"type":"object","properties":{"dn":{"type":"string"}}}`)}, Title: "Modify entry"},
}

func TestListCallAndAuth(t *testing.T) {
	var got []Call
	var mu sync.Mutex
	srv, err := Start(testTools, func(ctx context.Context, c Call) Result {
		mu.Lock()
		got = append(got, c)
		mu.Unlock()
		if c.Name == "modify_entry" {
			return Result{Text: `{"ok":false,"error":{"code":"DECLINED_BY_USER"}}`, IsError: true}
		}
		return Result{Text: `{"ok":true,"dn":"CN=x"}`}
	}, Options{Instructions: "LDAP tools"})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close(time.Second)
	if !strings.HasPrefix(srv.URL(), "http://127.0.0.1:") || !strings.HasSuffix(srv.URL(), "/mcp") || len(srv.Token()) != 64 {
		t.Fatalf("url %s token %d", srv.URL(), len(srv.Token()))
	}

	// Without and with a wrong token: rejected before any MCP handling.
	for _, tok := range []string{"", "wrong-token"} {
		req, _ := http.NewRequest("POST", srv.URL(), strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("token %q: status %d", tok, resp.StatusCode)
		}
	}
	if _, err := connect(t, srv.URL(), "wrong-token", nil); err == nil {
		t.Fatal("client with a wrong token connected")
	}
	// DNS rebinding: a foreign Host header is refused even with the token.
	req, _ := http.NewRequest("POST", srv.URL(), strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`))
	req.Host = "evil.example:80"
	req.Header.Set("Authorization", "Bearer "+srv.Token())
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign host: %v %v", resp.StatusCode, err)
	}
	// A browser page on another origin is refused.
	req, _ = http.NewRequest("POST", srv.URL(), strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer "+srv.Token())
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross origin: %v %v", resp.StatusCode, err)
	}

	cs, err := connect(t, srv.URL(), srv.Token(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	if cs.InitializeResult().Instructions != "LDAP tools" || cs.InitializeResult().ServerInfo.Name != "ldapilot" {
		t.Fatalf("initialize %+v", cs.InitializeResult())
	}
	ctx := context.Background()
	lt, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(lt.Tools) != 2 {
		t.Fatalf("tools %+v", lt.Tools)
	}
	ge := lt.Tools[0]
	if ge.Name != "get_entry" || ge.Description != "Read one entry." || !ge.Annotations.ReadOnlyHint || ge.Meta["anthropic/alwaysLoad"] != true {
		t.Fatalf("get_entry %+v %+v", ge, ge.Annotations)
	}
	schema, _ := json.Marshal(ge.InputSchema)
	if !strings.Contains(string(schema), `"required":["dn"]`) {
		t.Fatalf("schema %s", schema)
	}
	me := lt.Tools[1]
	if me.Annotations.ReadOnlyHint || me.Annotations.DestructiveHint == nil || !*me.Annotations.DestructiveHint {
		t.Fatalf("modify_entry annotations %+v", me.Annotations)
	}

	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "get_entry", Arguments: map[string]any{"dn": "CN=x"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.IsError || res.Content[0].(*mcp.TextContent).Text != `{"ok":true,"dn":"CN=x"}` {
		t.Fatalf("result %+v", res)
	}
	res, err = cs.CallTool(ctx, &mcp.CallToolParams{Name: "modify_entry", Arguments: map[string]any{"dn": "CN=x"}})
	if err != nil || !res.IsError {
		t.Fatalf("modify %+v %v", res, err)
	}
	// Absent arguments arrive as {}.
	if _, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "get_entry"}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 3 || string(got[0].Args) != `{"dn":"CN=x"}` || got[1].Name != "modify_entry" || string(got[2].Args) != `{}` {
		t.Fatalf("calls %+v", got)
	}
	if req, rej := srv.Stats(); req == 0 || rej < 3 {
		t.Fatalf("stats %d %d", req, rej)
	}
}

// A call that waits (an approval) gets keep-alive progress notifications
// and ends when the client cancels it.
func TestProgressAndClientCancel(t *testing.T) {
	started := make(chan struct{})
	ended := make(chan error, 1)
	srv, err := Start(testTools, func(ctx context.Context, c Call) Result {
		close(started)
		<-ctx.Done()
		ended <- ctx.Err()
		return Result{Text: "cancelled", IsError: true}
	}, Options{ProgressEvery: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close(time.Second)
	var progress atomic.Int32
	cs, err := connect(t, srv.URL(), srv.Token(), &mcp.ClientOptions{ProgressNotificationHandler: func(_ context.Context, r *mcp.ProgressNotificationClientRequest) {
		if r.Params.ProgressToken == "p1" && strings.Contains(r.Params.Message, "approval") {
			progress.Add(1)
		}
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	ctx, cancel := context.WithCancel(context.Background())
	params := &mcp.CallToolParams{Name: "get_entry", Arguments: map[string]any{"dn": "x"}}
	params.SetProgressToken("p1")
	errc := make(chan error, 1)
	go func() {
		_, err := cs.CallTool(ctx, params)
		errc <- err
	}()
	<-started
	deadline := time.Now().Add(5 * time.Second)
	for progress.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if progress.Load() < 2 {
		t.Fatalf("progress notifications: %d", progress.Load())
	}
	cancel()
	select {
	case err := <-ended:
		if err == nil {
			t.Fatal("no ctx error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("handler not cancelled by notifications/cancelled")
	}
	if err := <-errc; err == nil {
		t.Fatal("client call did not fail after cancel")
	}
}

// Close cancels calls in flight and waits for their handlers; later calls
// are refused.
func TestCloseCancelsCalls(t *testing.T) {
	started := make(chan struct{})
	var handlerDone atomic.Bool
	srv, err := Start(testTools, func(ctx context.Context, c Call) Result {
		close(started)
		<-ctx.Done()
		time.Sleep(20 * time.Millisecond)
		handlerDone.Store(true)
		return Result{Text: "x"}
	}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	cs, err := connect(t, srv.URL(), srv.Token(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	go func() {
		_, _ = cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "get_entry", Arguments: map[string]any{}})
	}()
	<-started
	srv.Close(2 * time.Second)
	if !handlerDone.Load() {
		t.Fatal("Close returned before the handler finished")
	}
	if _, err := connect(t, srv.URL(), srv.Token(), nil); err == nil {
		t.Fatal("connected after Close")
	}
}
