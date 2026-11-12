package mcprelay

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/dpicillo/LDAPilot/internal/ai/mcpserver"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
)

var relayTools = []mcpserver.Tool{
	{Spec: tools.Spec{Name: "get_entry", Description: "Read one entry.", Parameters: json.RawMessage(`{"type":"object","properties":{"dn":{"type":"string"}},"required":["dn"]}`)}, Title: "Get entry", ReadOnly: true},
	{Spec: tools.Spec{Name: "modify_entry", Description: "Change an entry.", Parameters: json.RawMessage(`{"type":"object","properties":{"dn":{"type":"string"}}}`)}, Title: "Modify entry"},
}

// pipeRelay runs the relay between an in-process MCP client (stdio side,
// as Claude Code in WSL) and srv; it returns the client session and a
// channel closed when the relay returned.
func pipeRelay(t *testing.T, cfg Config, opts *mcp.ClientOptions) (*mcp.ClientSession, chan error) {
	t.Helper()
	toRelayR, toRelayW := io.Pipe()
	fromRelayR, fromRelayW := io.Pipe()
	done := make(chan error, 1)
	go func() {
		err := Run(context.Background(), cfg, toRelayR, fromRelayW, nil)
		fromRelayW.Close()
		done <- err
	}()
	c := mcp.NewClient(&mcp.Implementation{Name: "claude-code", Version: "test"}, opts)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	sess, err := c.Connect(ctx, &mcp.IOTransport{Reader: fromRelayR, Writer: toRelayW}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return sess, done
}

func TestRelayListCallProgressAndEnd(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	srv, err := mcpserver.Start(relayTools, func(ctx context.Context, c mcpserver.Call) mcpserver.Result {
		calls.Add(1)
		if c.Name == "modify_entry" {
			// An approval wait: progress keeps the call alive meanwhile.
			select {
			case <-release:
			case <-ctx.Done():
				return mcpserver.Result{Text: "cancelled", IsError: true}
			}
			return mcpserver.Result{Text: `{"ok":false,"error":{"code":"DECLINED_BY_USER"}}`, IsError: true}
		}
		return mcpserver.Result{Text: `{"ok":true,"args":` + string(c.Args) + `}`}
	}, mcpserver.Options{Instructions: "LDAP tools", ProgressEvery: 30 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close(time.Second)

	var progress atomic.Int32
	sess, done := pipeRelay(t, Config{URL: srv.URL(), Token: srv.Token()}, &mcp.ClientOptions{
		ProgressNotificationHandler: func(context.Context, *mcp.ProgressNotificationClientRequest) { progress.Add(1) },
	})
	if got := sess.InitializeResult().Instructions; got != "LDAP tools" {
		t.Fatalf("instructions %q", got)
	}
	ctx := context.Background()
	list, err := sess.ListTools(ctx, nil)
	if err != nil || len(list.Tools) != 2 || list.Tools[0].Name != "get_entry" {
		t.Fatalf("tools %+v %v", list, err)
	}

	// A long call and a quick one at the same time: the quick one is not
	// held up by the first.
	var wg sync.WaitGroup
	wg.Add(1)
	var longRes *mcp.CallToolResult
	var longErr error
	go func() {
		defer wg.Done()
		p := &mcp.CallToolParams{Name: "modify_entry", Arguments: map[string]any{"dn": "CN=x"}}
		p.SetProgressToken("p1")
		longRes, longErr = sess.CallTool(ctx, p)
	}()
	time.Sleep(50 * time.Millisecond)
	res, err := sess.CallTool(ctx, &mcp.CallToolParams{Name: "get_entry", Arguments: map[string]any{"dn": "CN=Schmidt\\, Anna,OU=x"}})
	if err != nil || res.IsError || !strings.Contains(res.Content[0].(*mcp.TextContent).Text, `"dn":"CN=Schmidt\\, Anna,OU=x"`) {
		t.Fatalf("quick call %+v %v", res, err)
	}
	time.Sleep(120 * time.Millisecond) // a few progress ticks
	close(release)
	wg.Wait()
	if longErr != nil || !longRes.IsError || !strings.Contains(longRes.Content[0].(*mcp.TextContent).Text, "DECLINED_BY_USER") {
		t.Fatalf("long call %+v %v", longRes, longErr)
	}
	if progress.Load() == 0 {
		t.Fatal("no progress notification reached the client")
	}
	if calls.Load() != 2 {
		t.Fatalf("server saw %d calls", calls.Load())
	}

	// Claude Code exits: the relay ends with stdin.
	sess.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("relay did not end with its stdin")
	}
}

// A cancelled call reaches the server (notifications/cancelled), so an
// approval wait ends.
func TestRelayCancel(t *testing.T) {
	ended := make(chan struct{})
	srv, err := mcpserver.Start(relayTools, func(ctx context.Context, c mcpserver.Call) mcpserver.Result {
		<-ctx.Done()
		close(ended)
		return mcpserver.Result{Text: "cancelled", IsError: true}
	}, mcpserver.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close(time.Second)
	sess, _ := pipeRelay(t, Config{URL: srv.URL(), Token: srv.Token()}, nil)
	defer sess.Close()
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	if _, err := sess.CallTool(ctx, &mcp.CallToolParams{Name: "modify_entry", Arguments: map[string]any{}}); err == nil {
		t.Fatal("cancelled call returned no error")
	}
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("the server call did not end after the cancel")
	}
}

// With a wrong token the server refuses; the relay answers the request
// with a JSON-RPC error instead of leaving Claude Code waiting.
func TestRelayWrongTokenAndClosedServer(t *testing.T) {
	srv, err := mcpserver.Start(relayTools, func(context.Context, mcpserver.Call) mcpserver.Result { return mcpserver.Result{Text: "x"} }, mcpserver.Options{})
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{URL: srv.URL(), Token: "wrong"}
	for _, closed := range []bool{false, true} {
		if closed {
			cfg.Token = srv.Token()
			srv.Close(time.Second)
		}
		in := strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}` + "\n")
		var out strings.Builder
		if err := Run(context.Background(), cfg, in, &out, nil); err != nil {
			t.Fatal(err)
		}
		var resp struct {
			ID    int `json:"id"`
			Error struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(out.String()), &resp); err != nil || resp.ID != 7 || resp.Error.Code == 0 {
			t.Fatalf("closed=%v: %q %v", closed, out.String(), err)
		}
		if closed && !strings.Contains(resp.Error.Message, "not reachable") {
			t.Fatalf("closed server: %q", resp.Error.Message)
		}
	}
}

func TestConfigCheck(t *testing.T) {
	good := Config{URL: "http://127.0.0.1:41234/mcp", Token: "abc123"}
	if err := good.Check(); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []Config{
		{URL: "http://localhost:41234/mcp", Token: "t"},
		{URL: "http://172.20.0.1:41234/mcp", Token: "t"},
		{URL: "https://127.0.0.1:41234/mcp", Token: "t"},
		{URL: "http://127.0.0.1/mcp", Token: "t"},
		{URL: "http://127.0.0.1:41234/other", Token: "t"},
		{URL: "http://user:pw@127.0.0.1:41234/mcp", Token: "t"},
		{URL: "http://127.0.0.1:41234/mcp?x=1", Token: "t"},
		{URL: "http://127.0.0.1:41234/mcp", Token: ""},
		{URL: "http://127.0.0.1:41234/mcp", Token: "a b"},
	} {
		if bad.Check() == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "relay.json")
	b, _ := json.Marshal(good)
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	if cfg, err := ReadConfig(p); err != nil || cfg != good {
		t.Fatalf("%+v %v", cfg, err)
	}
	if Main([]string{filepath.Join(dir, "missing.json")}) == 0 || Main(nil) == 0 {
		t.Fatal("Main accepted a missing relay file")
	}
}

// Server messages that arrive as SSE events and as a JSON batch are passed
// on one per line; the negotiated version is learned from the initialize
// result only.
func TestForwardAndEvents(t *testing.T) {
	var out strings.Builder
	r := &relay{out: &out, initID: "1"}
	r.readEvents(strings.NewReader("event: message\nid: 1\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\ndata: \"result\":{\"protocolVersion\":\"2025-06-18\"}}\n\n: comment\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{\"progress\":1}}\n\n"))
	if !r.forwardJSON([]byte(`[{"jsonrpc":"2.0","id":2,"result":{}},{"jsonrpc":"2.0","id":3,"result":{"protocolVersion":"2099-01-01"}}]`)) {
		t.Fatal("batch not forwarded")
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 4 || !strings.Contains(lines[0], `"protocolVersion":"2025-06-18"`) || !strings.Contains(lines[1], "notifications/progress") {
		t.Fatalf("lines %q", lines)
	}
	if r.version != "2025-06-18" {
		t.Fatalf("version %q", r.version)
	}
	if r.forwardJSON([]byte(`not json`)) || r.forwardJSON([]byte(`{"id":1}`)) {
		t.Fatal("forwarded a non-JSON-RPC body")
	}
}

func TestMessageHeaders(t *testing.T) {
	m, err := parseMessage([]byte(`{"jsonrpc":"2.0","id":"a","method":"tools/call","params":{"name":"get_entry","_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`))
	if err != nil || !m.isRequest() || m.name() != "get_entry" || m.version() != "2026-07-28" {
		t.Fatalf("%+v %v", m, err)
	}
	n, _ := parseMessage([]byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	if n.isRequest() || n.hasID() {
		t.Fatal("notification taken for a request")
	}
	resp, _ := parseMessage([]byte(`{"jsonrpc":"2.0","id":5,"result":{}}`))
	if resp.isRequest() || !resp.hasID() {
		t.Fatal("response taken for a request")
	}
	if _, err := parseMessage([]byte(`{`)); err == nil {
		t.Fatal("invalid JSON accepted")
	}
}
