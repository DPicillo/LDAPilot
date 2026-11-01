// Package mcpserver is LDAPilot's internal MCP server for the Claude Code
// engine (§11, CLAUDE-CODE-MODE.md "headless only"): Streamable HTTP on
// 127.0.0.1, a random port and a random bearer token per run, alive only
// while LDAPilot runs a `claude -p` child. It exposes the tools offered to
// the run; every call is answered by the run's handler, which goes through
// the same executor, permission manager, redaction and audit as the
// built-in engine. It is never exposed to other clients.
package mcpserver

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/dpicillo/LDAPilot/internal/ai/tools"
)

// Path is the HTTP path of the MCP endpoint.
const Path = "/mcp"

// Tool is one tool the server lists.
type Tool struct {
	Spec     tools.Spec
	Title    string // display name
	ReadOnly bool   // read tool (annotation readOnlyHint)
}

// Call is one tools/call request.
type Call struct {
	Name string          // tool name as registered (no mcp__ prefix)
	Args json.RawMessage // arguments as sent ("{}" when absent)
}

// Result is the answer to a call: the model-facing text and whether it is
// an error result.
type Result struct {
	Text    string
	IsError bool
}

// Handler answers calls. ctx ends when the client cancels the call, the
// server is closed or the run ends.
type Handler func(ctx context.Context, c Call) Result

// Options configure Start.
type Options struct {
	// Name and Version are reported in the MCP initialize result.
	Name, Version string
	// Instructions are the server instructions shown to the model.
	Instructions string
	// Token is the bearer token ("" = a random 256-bit token).
	Token string
	// ProgressEvery is the interval of keep-alive progress notifications
	// while a call runs (0 = 30 s); they keep the client's idle timeout
	// from aborting a call that waits for the user's approval.
	ProgressEvery time.Duration
	// ProgressMessage is the text of those notifications.
	ProgressMessage string
	// Logf receives diagnostics (nil = discard).
	Logf func(format string, args ...any)
}

// Server is a running MCP server.
type Server struct {
	url   string
	token string
	srv   *http.Server
	ln    net.Listener
	base  context.Context
	stop  context.CancelFunc
	wg    sync.WaitGroup
	calls sync.WaitGroup

	mu       sync.Mutex
	closed   bool
	requests int
	rejected int
}

// Start listens on a random port of 127.0.0.1 and serves the tools.
func Start(list []Tool, h Handler, o Options) (*Server, error) {
	if h == nil {
		return nil, errors.New("mcpserver: nil handler")
	}
	token := o.Token
	if token == "" {
		var b [32]byte
		if _, err := rand.Read(b[:]); err != nil {
			return nil, err
		}
		token = hex.EncodeToString(b[:])
	}
	if o.Name == "" {
		o.Name = "ldapilot"
	}
	if o.Version == "" {
		o.Version = "1"
	}
	if o.ProgressEvery <= 0 {
		o.ProgressEvery = 30 * time.Second
	}
	if o.ProgressMessage == "" {
		o.ProgressMessage = "LDAPilot is still working on this call (it may be waiting for the user's approval)."
	}
	logf := o.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("mcpserver: cannot listen on 127.0.0.1: %w", err)
	}
	base, stop := context.WithCancel(context.Background())
	s := &Server{url: "http://" + ln.Addr().String() + Path, token: token, ln: ln, base: base, stop: stop}

	ms := mcp.NewServer(&mcp.Implementation{Name: o.Name, Version: o.Version}, &mcp.ServerOptions{
		Instructions: o.Instructions,
		Logger:       slog.New(slog.DiscardHandler),
	})
	for _, t := range list {
		t := t
		schema := json.RawMessage(t.Spec.Parameters)
		if len(schema) == 0 {
			schema = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		ann := &mcp.ToolAnnotations{Title: t.Title, ReadOnlyHint: t.ReadOnly, IdempotentHint: t.ReadOnly}
		openWorld := false
		ann.OpenWorldHint = &openWorld
		if !t.ReadOnly {
			destructive := true
			ann.DestructiveHint = &destructive
		}
		ms.AddTool(&mcp.Tool{Name: t.Spec.Name, Title: t.Title, Description: t.Spec.Description, InputSchema: schema, Annotations: ann,
			Meta: mcp.Meta{"anthropic/alwaysLoad": true}},
			func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				return s.serveCall(ctx, req, h, o, logf), nil
			})
	}
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return ms }, &mcp.StreamableHTTPOptions{
		SessionTimeout: 5 * time.Minute,
		Logger:         slog.New(slog.DiscardHandler),
	})
	verifier := func(_ context.Context, got string, _ *http.Request) (*auth.TokenInfo, error) {
		if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			return nil, auth.ErrInvalidToken
		}
		return &auth.TokenInfo{Expiration: time.Now().Add(24 * time.Hour)}, nil
	}
	protected := auth.RequireBearerToken(verifier, nil)(handler)
	cross := http.NewCrossOriginProtection()
	mux := http.NewServeMux()
	mux.Handle(Path, cross.Handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.requests++
		s.mu.Unlock()
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || bearer(r) != token {
			s.mu.Lock()
			s.rejected++
			s.mu.Unlock()
		}
		protected.ServeHTTP(w, r)
	})))
	s.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second,
		BaseContext: func(net.Listener) context.Context { return base }}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		if err := s.srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logf("mcpserver: %v", err)
		}
	}()
	return s, nil
}

func bearer(r *http.Request) string {
	f := strings.Fields(r.Header.Get("Authorization"))
	if len(f) == 2 && strings.EqualFold(f[0], "bearer") {
		return f[1]
	}
	return ""
}

func (s *Server) serveCall(ctx context.Context, req *mcp.CallToolRequest, h Handler, o Options, logf func(string, ...any)) *mcp.CallToolResult {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return errorResult("LDAPilot ended this run; the call was not executed.")
	}
	s.calls.Add(1)
	s.mu.Unlock()
	defer s.calls.Done()
	// The call also ends with the server (run end, stop).
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stopAfter := context.AfterFunc(s.base, cancel)
	defer stopAfter()

	args := json.RawMessage(nil)
	name := ""
	var progress any
	if req != nil && req.Params != nil {
		name = req.Params.Name
		args = req.Params.Arguments
		progress = req.Params.GetProgressToken()
	}
	if len(strings.TrimSpace(string(args))) == 0 || string(args) == "null" {
		args = json.RawMessage(`{}`)
	}
	if progress != nil && req.Session != nil {
		done := make(chan struct{})
		defer close(done)
		go func() {
			t := time.NewTicker(o.ProgressEvery)
			defer t.Stop()
			n := 0
			for {
				select {
				case <-done:
					return
				case <-ctx.Done():
					return
				case <-t.C:
					n++
					if err := req.Session.NotifyProgress(ctx, &mcp.ProgressNotificationParams{ProgressToken: progress, Progress: float64(n), Message: o.ProgressMessage}); err != nil {
						logf("mcpserver: progress: %v", err)
					}
				}
			}
		}()
	}
	res := h(ctx, Call{Name: name, Args: args})
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: res.Text}}, IsError: res.IsError}
}

func errorResult(msg string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: msg}}, IsError: true}
}

// URL is the endpoint URL (http://127.0.0.1:<port>/mcp).
func (s *Server) URL() string { return s.url }

// Token is the bearer token.
func (s *Server) Token() string { return s.token }

// Stats returns the number of HTTP requests and of requests without the
// right token.
func (s *Server) Stats() (requests, rejected int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.requests, s.rejected
}

// Close stops accepting calls, cancels the calls in flight and waits up to
// wait for their handlers to return, then closes the listener and all
// connections.
func (s *Server) Close(wait time.Duration) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.mu.Unlock()
	s.stop()
	done := make(chan struct{})
	go func() {
		s.calls.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(wait):
	}
	_ = s.srv.Close()
	s.wg.Wait()
}
