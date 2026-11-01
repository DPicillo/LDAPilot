package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/aitest/fake"
	"github.com/dpicillo/LDAPilot/internal/ai/claudecode"
	"github.com/dpicillo/LDAPilot/internal/ai/permission"
	"github.com/dpicillo/LDAPilot/internal/config"
)

// fakeCLI plays `claude -p` in-process: it writes stream-json lines and
// calls the run's MCP server like the real CLI would.
type fakeCLI struct {
	t      *testing.T
	script func(f *fakeRun)

	mu   sync.Mutex
	invs []*claudecode.Invocation
	runs []*fakeRun
}

type fakeRun struct {
	t           *testing.T
	inv         *claudecode.Invocation
	pw          *io.PipeWriter
	pr          *io.PipeReader
	ctx         context.Context
	cancel      context.CancelFunc
	done        chan struct{}
	interrupted chan struct{}
	intOnce     sync.Once
	stderr      string
	session     *mcp.ClientSession
}

func (c *fakeCLI) Launch(ctx context.Context, inv *claudecode.Invocation) (claudecode.Process, error) {
	pr, pw := io.Pipe()
	rctx, cancel := context.WithCancel(context.Background())
	r := &fakeRun{t: c.t, inv: inv, pw: pw, pr: pr, ctx: rctx, cancel: cancel, done: make(chan struct{}), interrupted: make(chan struct{})}
	c.mu.Lock()
	c.invs = append(c.invs, inv)
	c.runs = append(c.runs, r)
	c.mu.Unlock()
	go func() {
		defer close(r.done)
		defer pw.Close()
		defer func() {
			if r.session != nil {
				r.session.Close()
			}
		}()
		c.script(r)
	}()
	return r, nil
}

func (c *fakeCLI) last() (*claudecode.Invocation, *fakeRun) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.invs[len(c.invs)-1], c.runs[len(c.runs)-1]
}

func (r *fakeRun) Stdout() io.Reader { return r.pr }
func (r *fakeRun) Interrupt() error {
	r.intOnce.Do(func() { close(r.interrupted) })
	r.cancel()
	return nil
}
func (r *fakeRun) Kill() error    { r.cancel(); return nil }
func (r *fakeRun) Wait() error    { <-r.done; return nil }
func (r *fakeRun) Stderr() string { return r.stderr }

func (r *fakeRun) line(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	_, _ = r.pw.Write(append(b, '\n'))
}

type obj = map[string]any

func (r *fakeRun) event(e obj) {
	r.line(obj{"type": "stream_event", "event": e, "session_id": "sess-1", "parent_tool_use_id": nil})
}

func (r *fakeRun) init(model string) {
	r.line(obj{"type": "system", "subtype": "init", "session_id": "sess-1", "model": model, "tools": []string{"mcp__ldapilot__get_entry"},
		"mcp_servers": []obj{{"name": "ldapilot", "status": "connected"}}, "claude_code_version": "2.1.308"})
}

func (r *fakeRun) startMsg(id, model string) {
	r.event(obj{"type": "message_start", "message": obj{"id": id, "model": model, "usage": obj{"input_tokens": 10, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 100}}})
}

func (r *fakeRun) text(idx int, parts ...string) {
	r.event(obj{"type": "content_block_start", "index": idx, "content_block": obj{"type": "text", "text": ""}})
	for _, p := range parts {
		r.event(obj{"type": "content_block_delta", "index": idx, "delta": obj{"type": "text_delta", "text": p}})
	}
	r.event(obj{"type": "content_block_stop", "index": idx})
}

func (r *fakeRun) toolUse(idx int, id, name, args string) {
	r.event(obj{"type": "content_block_start", "index": idx, "content_block": obj{"type": "tool_use", "id": id, "name": claudecode.ToolPrefix + name, "input": obj{}}})
	half := len(args) / 2
	r.event(obj{"type": "content_block_delta", "index": idx, "delta": obj{"type": "input_json_delta", "partial_json": args[:half]}})
	r.event(obj{"type": "content_block_delta", "index": idx, "delta": obj{"type": "input_json_delta", "partial_json": args[half:]}})
	r.event(obj{"type": "content_block_stop", "index": idx})
}

func (r *fakeRun) endMsg(stop string, out int) {
	r.event(obj{"type": "message_delta", "delta": obj{"stop_reason": stop}, "usage": obj{"output_tokens": out}})
	r.event(obj{"type": "message_stop"})
}

func (r *fakeRun) result(cost float64, extra obj) {
	l := obj{"type": "result", "subtype": "success", "is_error": false, "num_turns": 2, "total_cost_usd": cost, "session_id": "sess-1",
		"usage":      obj{"input_tokens": 20, "output_tokens": 50, "cache_read_input_tokens": 2000, "cache_creation_input_tokens": 200},
		"modelUsage": obj{"claude-haiku-5-5": obj{"contextWindow": 200000, "costUSD": cost}}}
	for k, v := range extra {
		l[k] = v
	}
	r.line(l)
}

type bearerTransport struct{ token string }

func (b bearerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(req)
}

// call invokes a tool through the run's MCP server (connecting first).
func (r *fakeRun) call(name, args string) (string, bool, error) {
	return r.callCtx(r.ctx, name, args)
}

func (r *fakeRun) callCtx(ctx context.Context, name, args string) (string, bool, error) {
	if r.session == nil {
		cfg, err := os.ReadFile(r.inv.MCPConfig)
		if err != nil {
			return "", false, err
		}
		var doc struct {
			MCPServers map[string]struct {
				URL     string            `json:"url"`
				Headers map[string]string `json:"headers"`
			} `json:"mcpServers"`
		}
		_ = json.Unmarshal(cfg, &doc)
		srv := doc.MCPServers[claudecode.MCPServerName]
		token := strings.TrimPrefix(srv.Headers["Authorization"], "Bearer ")
		c := mcp.NewClient(&mcp.Implementation{Name: "fake-claude", Version: "1"}, nil)
		tr := &mcp.StreamableClientTransport{Endpoint: srv.URL, HTTPClient: &http.Client{Transport: bearerTransport{token}}, MaxRetries: -1, DisableStandaloneSSE: true}
		s, err := c.Connect(r.ctx, tr, nil)
		if err != nil {
			return "", false, err
		}
		r.session = s
	}
	var a map[string]any
	_ = json.Unmarshal([]byte(args), &a)
	res, err := r.session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: a})
	if err != nil {
		return "", false, err
	}
	return res.Content[0].(*mcp.TextContent).Text, res.IsError, nil
}

func (r *fakeRun) toolResult(id, text string, isErr bool) {
	r.line(obj{"type": "user", "message": obj{"role": "user", "content": []obj{{"type": "tool_result", "tool_use_id": id, "content": []obj{{"type": "text", "text": text}}, "is_error": isErr}}},
		"session_id": "sess-1", "parent_tool_use_id": nil})
}

// ccHarness is the agent harness with the Claude Code engine selected.
func ccHarness(t *testing.T, level string, writes bool, script func(f *fakeRun)) (*harness, *fakeCLI, string) {
	h := newHarness(t, level, writes)
	cli := &fakeCLI{t: t, script: script}
	base := t.TempDir()
	h.m.d.ClaudeCode = &ClaudeCodeEnv{Launcher: cli, FindCLI: func(string) (string, error) { return "/opt/claude/bin/claude", nil },
		WorkDir: filepath.Join(base, "work"), FilesDir: filepath.Join(base, "runs"), Environ: func() []string { return []string{"PATH=/usr/bin", "CLAUDECODE=1"} },
		StopGrace: 100 * time.Millisecond}
	h.cfg.update(func(c *config.AIConfig) {
		c.Engine = EngineClaudeCode
		c.ClaudeCode = config.ClaudeCodeConfig{Model: "haiku", MaxBudgetUSD: 0.25}
		// Claude Code is a remote destination: read/write levels count
		// only for the hosts they were granted for (§6.1).
		c.ConnectionAccess[adID] = config.AccessEntry{Level: level, Hosts: []string{permission.Classify(*c, false).Host}}
	})
	return h, cli, filepath.Join(base, "runs")
}

func eventsOf[T any](h *harness, name string) []T {
	var out []T
	for _, v := range h.rec.find(name) {
		out = append(out, v.(T))
	}
	return out
}

func TestClaudeCodeReadRun(t *testing.T) {
	args := `{"dn":"` + anna + `","attributes":["description","userPassword","sAMAccountName"]}`
	var mcpText string
	var mcpErr error
	h, cli, runs := ccHarness(t, "read", false, func(f *fakeRun) {
		f.init("claude-haiku-5-5")
		f.startMsg("msg_1", "claude-haiku-5-5")
		f.text(0, "Let me ", "look.")
		f.toolUse(1, "toolu_01", "get_entry", args)
		f.endMsg("tool_use", 30)
		mcpText, _, mcpErr = f.call("get_entry", args)
		f.toolResult("toolu_01", mcpText, false)
		f.startMsg("msg_2", "claude-haiku-5-5")
		f.text(0, "Anna works in `Sales`.")
		f.endMsg("end_turn", 12)
		f.line(obj{"type": "rate_limit_event", "rate_limit_info": obj{"status": "allowed", "rateLimitType": "five_hour"}})
		f.result(0.0042, nil)
	})
	id := h.newChat()
	h.send(id, "What is Anna's department?")
	h.wait(id)
	if mcpErr != nil {
		t.Fatal(mcpErr)
	}
	if !strings.Contains(mcpText, "Sales") || strings.Contains(mcpText, sentinelPW) {
		t.Fatalf("MCP result (redaction): %s", mcpText)
	}
	inv, _ := cli.last()
	if !strings.Contains(inv.Stdin, "<ldapilot_context>") || !strings.Contains(inv.Stdin, "What is Anna's department?") || strings.Contains(inv.Stdin, "<previous_conversation>") {
		t.Fatalf("prompt %q", inv.Stdin)
	}
	if v, _ := argValue(inv.Args, "--model"); v != "haiku" {
		t.Fatalf("args %v", inv.Args)
	}
	if v, _ := argValue(inv.Args, "--allowedTools"); !strings.Contains(v, "mcp__ldapilot__get_entry") || strings.Contains(v, "modify_entry") {
		t.Fatalf("allowed tools %q", v)
	}
	if slices.Contains(inv.Env, "CLAUDECODE=1") {
		t.Fatal("nested-session variable passed on")
	}
	// The run's private files are gone.
	if es, _ := os.ReadDir(runs); len(es) != 0 {
		t.Fatalf("run files left: %v", es)
	}
	rs := eventsOf[*ai.RunStartedEvent](h, ai.EventRunStarted)
	if rs[0].Engine != "claudecode" || rs[0].Provider != "claudecode" || rs[0].Model != "haiku" {
		t.Fatalf("run_started %+v", rs[0])
	}
	ms := eventsOf[*ai.MessageStartedEvent](h, ai.EventMessageStarted)
	ts := eventsOf[*ai.ToolStartEvent](h, ai.EventToolStart)
	te := eventsOf[*ai.ToolEndEvent](h, ai.EventToolEnd)
	if len(ms) != 2 || len(ts) != 1 || len(te) != 1 || ts[0].MessageID != ms[0].MessageID || ts[0].Name != "get_entry" || ts[0].ConnectionID != adID ||
		te[0].Status != ai.ToolOK || te[0].Result != mcpText {
		t.Fatalf("messages %+v tools %+v %+v", ms, ts, te)
	}
	var text string
	for _, d := range eventsOf[*ai.DeltaEvent](h, ai.EventTextDelta) {
		text += d.Text
	}
	if text != "Let me look.Anna works in `Sales`." {
		t.Fatalf("text %q", text)
	}
	us := eventsOf[*ai.UsageEvent](h, ai.EventUsage)
	lastU := us[len(us)-1]
	if lastU.CostUSD != 0.0042 || lastU.Totals.CostUSD != 0.0042 || lastU.ContextWindow != 200000 || us[0].ContextTokens != 1110 {
		t.Fatalf("usage %+v / %+v", us[0], lastU)
	}
	d := h.done()
	if d.Status != ai.RunCompleted || d.Totals.CostUSD != 0.0042 {
		t.Fatalf("done %+v", d)
	}
	c := h.chat(id)
	if len(c.Messages) != 4 {
		t.Fatalf("history %d: %+v", len(c.Messages), c.Messages)
	}
	a1, res, a2 := c.Messages[1], c.Messages[2], c.Messages[3]
	if a1.Role != ai.RoleAssistant || len(a1.Blocks) != 2 || a1.Blocks[0].Text != "Let me look." || a1.Blocks[1].Type != ai.BlockToolUse ||
		a1.Blocks[1].ProviderCallID != "toolu_01" || a1.Model != "claude-haiku-5-5" || a1.Provider != "claudecode" || a1.StopReason != ai.StopToolUse {
		t.Fatalf("assistant 1 %+v", a1)
	}
	if res.Role != ai.RoleUser || res.Blocks[0].ToolUseID != a1.Blocks[1].ID || res.Blocks[0].Content != mcpText {
		t.Fatalf("results %+v", res)
	}
	if visibleText(a2) != "Anna works in `Sales`." || d.FinalMessageID != a2.ID {
		t.Fatalf("final %+v %s", a2, d.FinalMessageID)
	}
	if c.Usage.CostUSD != 0.0042 || c.ClaudeSessionID != "" {
		t.Fatalf("chat usage %+v session %q", c.Usage, c.ClaudeSessionID)
	}
	for _, l := range h.rec.all() {
		if strings.Contains(l, sentinelPW) {
			t.Fatalf("sentinel in event %s", l)
		}
	}
	checkSeq(t, h.rec)

	// Second turn: the first one is replayed (no resume by default).
	h.send(id, "And her account name?")
	h.wait(id)
	inv, _ = cli.last()
	if !strings.Contains(inv.Stdin, "<previous_conversation>") || !strings.Contains(inv.Stdin, "What is Anna's department?") ||
		!strings.Contains(inv.Stdin, "[tool get_entry(") || !strings.Contains(inv.Stdin, "Anna works in") || strings.Contains(inv.Stdin, sentinelPW) ||
		!strings.HasSuffix(inv.Stdin, "And her account name?") || slices.Contains(inv.Args, "--resume") {
		t.Fatalf("replay prompt %q", inv.Stdin)
	}
	// Only text and tool summaries are replayed (§11 c): raw directory
	// values never become user-turn text.
	if strings.Contains(inv.Stdin, "result excerpt") || strings.Contains(inv.Stdin, `"anna"`) {
		t.Fatalf("result excerpt replayed: %q", inv.Stdin)
	}
}

// A Claude Code session is not resumed when the built-in engine added turns
// in between: the conversation is replayed instead.
func TestClaudeCodeStaleSessionNotResumed(t *testing.T) {
	h, cli, _ := ccHarness(t, "read", false, func(f *fakeRun) {
		f.init("claude-haiku-5-5")
		f.startMsg("msg_1", "claude-haiku-5-5")
		f.text(0, "Hi.")
		f.endMsg("end_turn", 3)
		f.result(0.001, obj{"session_id": "sess-77"})
	})
	h.cfg.update(func(c *config.AIConfig) { c.ClaudeCode.AllowResume = true })
	id := h.newChat()
	h.send(id, "Hello")
	h.wait(id)
	h.cfg.update(func(c *config.AIConfig) { c.Engine = "builtin" })
	h.prov.Push(fake.Step{Text: "BUILTIN-ANSWER-XYZ"})
	h.send(id, "BUILTIN-QUESTION-ABC")
	h.wait(id)
	if h.chat(id).ClaudeSessionID != "sess-77" {
		t.Fatal("session forgotten by the built-in engine")
	}
	h.cfg.update(func(c *config.AIConfig) { c.Engine = EngineClaudeCode })
	h.send(id, "Back to CC")
	h.wait(id)
	inv, _ := cli.last()
	if slices.Contains(inv.Args, "--resume") || !strings.Contains(inv.Stdin, "BUILTIN-QUESTION-ABC") || !strings.Contains(inv.Stdin, "BUILTIN-ANSWER-XYZ") {
		t.Fatalf("stale session resumed: %v %q", inv.Args, inv.Stdin)
	}
	// The run that replayed stores the new session: the next send resumes.
	h.send(id, "Next")
	h.wait(id)
	inv, _ = cli.last()
	if v, _ := argValue(inv.Args, "--resume"); v != "sess-77" {
		t.Fatalf("current session not resumed: %v", inv.Args)
	}
}

func argValue(args []string, flag string) (string, bool) {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1], true
		}
	}
	return "", false
}

func TestClaudeCodeResumeOptIn(t *testing.T) {
	h, cli, _ := ccHarness(t, "read", false, func(f *fakeRun) {
		f.init("claude-haiku-5-5")
		f.startMsg("msg_1", "claude-haiku-5-5")
		f.text(0, "Hi.")
		f.endMsg("end_turn", 3)
		f.result(0.001, obj{"session_id": "sess-77"})
	})
	h.cfg.update(func(c *config.AIConfig) { c.ClaudeCode.AllowResume = true })
	id := h.newChat()
	h.send(id, "Hello")
	h.wait(id)
	inv, _ := cli.last()
	if slices.Contains(inv.Args, "--no-session-persistence") || slices.Contains(inv.Args, "--resume") {
		t.Fatalf("first run args %v", inv.Args)
	}
	if c := h.chat(id); c.ClaudeSessionID != "sess-77" {
		t.Fatalf("session %q", c.ClaudeSessionID)
	}
	h.send(id, "Again")
	h.wait(id)
	inv, _ = cli.last()
	if v, _ := argValue(inv.Args, "--resume"); v != "sess-77" || strings.Contains(inv.Stdin, "<previous_conversation>") {
		t.Fatalf("resume args %v prompt %q", inv.Args, inv.Stdin)
	}
	// Opting out forgets the session and replays again.
	h.cfg.update(func(c *config.AIConfig) { c.ClaudeCode.AllowResume = false })
	h.send(id, "Third")
	h.wait(id)
	inv, _ = cli.last()
	if slices.Contains(inv.Args, "--resume") || !strings.Contains(inv.Stdin, "<previous_conversation>") || h.chat(id).ClaudeSessionID != "" {
		t.Fatalf("after opt-out %v", inv.Args)
	}
}

func TestClaudeCodeWriteApprovalAndDenial(t *testing.T) {
	approve := `{"dn":"` + anna + `","changes":[{"operation":"replace","attribute":"description","values":["Marketing"]}],"explanation":"Asked."}`
	deny := `{"dn":"` + anna + `","changes":[{"operation":"replace","attribute":"description","values":["Finance"]}],"explanation":"Asked."}`
	var r1, r2 string
	var e1, e2 bool
	h, _, _ := ccHarness(t, "write", true, func(f *fakeRun) {
		f.init("claude-haiku-5-5")
		f.startMsg("msg_1", "claude-haiku-5-5")
		f.toolUse(0, "toolu_w1", "modify_entry", approve)
		f.endMsg("tool_use", 20)
		r1, e1, _ = f.call("modify_entry", approve)
		f.toolResult("toolu_w1", r1, e1)
		f.startMsg("msg_2", "claude-haiku-5-5")
		f.toolUse(0, "toolu_w2", "modify_entry", deny)
		f.endMsg("tool_use", 20)
		r2, e2, _ = f.call("modify_entry", deny)
		f.toolResult("toolu_w2", r2, e2)
		f.startMsg("msg_3", "claude-haiku-5-5")
		f.text(0, "Changed to Marketing; Finance was declined.")
		f.endMsg("end_turn", 9)
		f.result(0.01, nil)
	})
	id := h.newChat()
	h.send(id, "Set Anna's description to Marketing, then Finance.")
	h.waitEvent(ai.EventApprovalRequest, 1)
	req := h.rec.find(ai.EventApprovalRequest)[0].(*ai.ApprovalRequest)
	if req.Tool != "modify_entry" || req.Preview == nil || !strings.Contains(req.Preview.LDIF, "Marketing") || req.Connection.ProfileID != adID {
		t.Fatalf("approval %+v", req)
	}
	if _, err := h.m.Respond(req.ApprovalID, ai.DecisionApprove, ""); err != nil {
		t.Fatal(err)
	}
	h.waitEvent(ai.EventApprovalRequest, 2)
	req2 := h.rec.find(ai.EventApprovalRequest)[1].(*ai.ApprovalRequest)
	if _, err := h.m.Respond(req2.ApprovalID, ai.DecisionDeny, "not now"); err != nil {
		t.Fatal(err)
	}
	h.wait(id)
	if e1 || !strings.Contains(r1, `"ok":true`) || !e2 || !strings.Contains(r2, "DECLINED_BY_USER") || !strings.Contains(r2, "not now") {
		t.Fatalf("results %v %s / %v %s", e1, r1, e2, r2)
	}
	if v := h.ad.Get(anna); !hasValue(v, "description", "Marketing") || hasValue(v, "description", "Finance") {
		t.Fatalf("entry %+v", v)
	}
	au := h.audit.all()
	if len(au) != 1 || !strings.Contains(au[0], "MODIFY") || !strings.Contains(au[0], "claudecode/claude-haiku-5-5, approved)") {
		t.Fatalf("audit %v", au)
	}
	c := h.chat(id)
	for _, m := range c.Messages {
		for _, b := range m.Blocks {
			if b.Type == ai.BlockToolUse && b.Meta != nil && b.Meta.Executing {
				t.Fatalf("executing flag left: %+v", b)
			}
		}
	}
	if s := c.Summary(); s.PendingWrite {
		t.Fatal("pending write")
	}
	te := eventsOf[*ai.ToolEndEvent](h, ai.EventToolEnd)
	if len(te) != 2 || te[0].Status != ai.ToolOK || te[0].Write == nil || te[1].Status != ai.ToolDenied {
		t.Fatalf("tool ends %+v", te)
	}
	checkSeq(t, h.rec)
}

func TestClaudeCodeStopDuringApproval(t *testing.T) {
	args := `{"dn":"` + anna + `","changes":[{"operation":"replace","attribute":"description","values":["X"]}],"explanation":"Asked."}`
	var callErr error
	var callText string
	h, cli, _ := ccHarness(t, "write", true, func(f *fakeRun) {
		f.init("claude-haiku-5-5")
		f.startMsg("msg_1", "claude-haiku-5-5")
		f.text(0, "Changing it.")
		f.toolUse(1, "toolu_w1", "modify_entry", args)
		f.endMsg("tool_use", 20)
		callText, _, callErr = f.call("modify_entry", args)
		<-f.ctx.Done() // like the CLI: exits on SIGINT
	})
	id := h.newChat()
	h.send(id, "Change it.")
	h.waitEvent(ai.EventApprovalRequest, 1)
	start := time.Now()
	if err := h.m.Stop(id); err != nil {
		t.Fatal(err)
	}
	h.wait(id)
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("stop took %v", el)
	}
	_, run := cli.last()
	select {
	case <-run.interrupted:
	default:
		t.Fatal("CLI not interrupted")
	}
	if d := h.done(); d.Status != ai.RunCancelled {
		t.Fatalf("done %+v", d)
	}
	ar := eventsOf[*ai.ApprovalResolvedEvent](h, ai.EventApprovalResolved)
	if len(ar) != 1 || ar[0].Decision != ai.ResolvedCancelled {
		t.Fatalf("resolved %+v", ar)
	}
	if callErr == nil && !strings.Contains(callText, "CANCELLED") {
		t.Fatalf("call result %q %v", callText, callErr)
	}
	if v := h.ad.Get(anna); hasValue(v, "description", "X") {
		t.Fatal("written although stopped")
	}
	// The tool_use has its (cancelled) result; text kept.
	c := h.chat(id)
	var uses, results int
	for _, m := range c.Messages {
		for _, b := range m.Blocks {
			switch b.Type {
			case ai.BlockToolUse:
				uses++
			case ai.BlockToolResult:
				results++
				if !b.IsError {
					t.Fatalf("result %+v", b)
				}
			}
		}
	}
	if uses != 1 || results != 1 || visibleText(c.Messages[1]) != "Changing it." {
		t.Fatalf("history %+v", c.Messages)
	}
	checkSeq(t, h.rec)
}

func TestClaudeCodeErrors(t *testing.T) {
	cases := []struct {
		name   string
		script func(f *fakeRun)
		code   string
		status string
		want   string
	}{
		{"budget", func(f *fakeRun) {
			f.init("claude-haiku-5-5")
			f.line(obj{"type": "result", "subtype": "error_max_budget_usd", "is_error": true, "total_cost_usd": 0.26, "session_id": "s", "errors": []string{"Reached maximum budget"}})
		}, ai.CodeBudgetExceeded, ai.RunFailed, "$0.25"},
		{"auth", func(f *fakeRun) {
			f.line(obj{"type": "result", "subtype": "success", "is_error": true, "result": "Invalid API key · Please run /login", "api_error_status": 401})
		}, ai.CodeAuthFailed, ai.RunFailed, "log in"},
		{"model", func(f *fakeRun) {
			f.line(obj{"type": "result", "subtype": "success", "is_error": true, "result": "There's an issue with the selected model (claude-nope). It may not exist or you may not have access to it."})
		}, ai.CodeModelNotFound, ai.RunFailed, "claude-nope"},
		{"no result", func(f *fakeRun) {
			f.stderr = "Error: something broke\nstack..."
		}, ai.CodeProviderUnreachable, ai.RunFailed, "something broke"},
		{"usage limit with text", func(f *fakeRun) {
			f.init("claude-haiku-5-5")
			f.startMsg("msg_1", "<synthetic>")
			f.text(0, "You've hit your session limit · resets 11:20pm")
			f.endMsg("stop_sequence", 0)
			f.line(obj{"type": "result", "subtype": "success", "is_error": true, "result": "You've hit your session limit · resets 11:20pm", "session_id": "s"})
		}, ai.CodeRateLimited, ai.RunFailed, "usage limit"},
		{"max turns", func(f *fakeRun) {
			f.line(obj{"type": "result", "subtype": "error_max_turns", "is_error": true})
		}, "", ai.RunStepLimit, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, _, _ := ccHarness(t, "read", false, tc.script)
			id := h.newChat()
			h.send(id, "Hi")
			h.wait(id)
			d := h.done()
			if d.Status != tc.status {
				t.Fatalf("done %+v\n%s", d, strings.Join(h.rec.all(), "\n"))
			}
			errs := eventsOf[*ai.ErrorEvent](h, ai.EventError)
			if tc.code == "" {
				if len(errs) != 0 || !d.CanContinue {
					t.Fatalf("errors %+v done %+v", errs, d)
				}
				return
			}
			if len(errs) != 1 || errs[0].Code != tc.code || !strings.Contains(errs[0].Message, tc.want) {
				t.Fatalf("error %+v", errs)
			}
			// The error is persisted on the last assistant message, so the
			// UI shows the error card after a reload too.
			c := h.chat(id)
			last := c.Messages[len(c.Messages)-1]
			if last.Role != ai.RoleAssistant || last.Error == nil || last.Error.Code != tc.code {
				t.Fatalf("persisted %+v", c.Messages)
			}
		})
	}
}

func TestClaudeCodeCLIMissing(t *testing.T) {
	h, _, _ := ccHarness(t, "read", false, func(f *fakeRun) {})
	h.m.d.ClaudeCode.FindCLI = func(string) (string, error) { return "", errors.New("Claude Code CLI not found") }
	id := h.newChat()
	h.send(id, "Hi")
	h.wait(id)
	errs := eventsOf[*ai.ErrorEvent](h, ai.EventError)
	if len(errs) != 1 || errs[0].Code != ai.CodeConfigMissing || !strings.Contains(errs[0].Message, "not found") {
		t.Fatalf("errors %+v", errs)
	}
}

// An MCP call whose tool_use never shows up in the stream (or shows up
// late) is still recorded, attached to the current message.
func TestClaudeCodeUncorrelatedCallAndWarnings(t *testing.T) {
	args := `{"dn":"` + anna + `"}`
	h, _, _ := ccHarness(t, "read", false, func(f *fakeRun) {
		f.line(obj{"type": "system", "subtype": "init", "session_id": "s", "model": "claude-haiku-5-5", "mcp_servers": []obj{{"name": "ldapilot", "status": "failed"}}})
		f.line(obj{"type": "system", "subtype": "informational", "level": "warning", "content": "Model \"haiku\" is restricted. Using claude-opus-5-5 instead."})
		f.startMsg("msg_1", "claude-haiku-5-5")
		f.text(0, "Reading.")
		f.endMsg("tool_use", 5)
		text, _, err := f.call("get_entry", args)
		if err != nil || !strings.Contains(text, "Anna") {
			panic(fmt.Sprint("call: ", err, text))
		}
		f.toolResult("toolu_bash", "Permission to use Bash has been denied.", true)
		f.startMsg("msg_2", "claude-haiku-5-5")
		f.text(0, "Done.")
		f.endMsg("end_turn", 5)
		f.result(0.002, obj{"permission_denials": []obj{{"tool_name": "Bash", "tool_use_id": "toolu_bash"}}})
	})
	id := h.newChat()
	h.send(id, "Read Anna.")
	h.wait(id)
	var warnings []string
	for _, st := range eventsOf[*ai.StatusEvent](h, ai.EventStatus) {
		warnings = append(warnings, st.Message)
	}
	all := strings.Join(warnings, "\n")
	for _, w := range []string{"status \"failed\"", "restricted", "did not run toolu_bash", "denied these tool calls: Bash"} {
		if !strings.Contains(all, w) {
			t.Fatalf("missing warning %q in:\n%s", w, all)
		}
	}
	c := h.chat(id)
	if len(c.Messages) != 4 || c.Messages[1].Blocks[1].Type != ai.BlockToolUse || c.Messages[1].Blocks[1].ProviderCallID != "" ||
		c.Messages[2].Blocks[0].ToolUseID != c.Messages[1].Blocks[1].ID {
		t.Fatalf("history %+v", c.Messages)
	}
	if h.done().Status != ai.RunCompleted {
		t.Fatal("not completed")
	}
}

func TestClaudeCodeStepLimitAndCompact(t *testing.T) {
	args := `{"dn":"` + anna + `"}`
	h, _, _ := ccHarness(t, "read", false, func(f *fakeRun) {
		f.init("claude-haiku-5-5")
		for i := 1; i <= 3; i++ {
			id := fmt.Sprintf("toolu_%d", i)
			f.startMsg(fmt.Sprintf("msg_%d", i), "claude-haiku-5-5")
			f.toolUse(0, id, "get_entry", args)
			f.endMsg("tool_use", 5)
			text, isErr, _ := f.call("get_entry", args)
			f.toolResult(id, text, isErr)
		}
		f.startMsg("msg_9", "claude-haiku-5-5")
		f.text(0, "Summary.")
		f.endMsg("end_turn", 5)
		f.result(0.003, nil)
	})
	h.cfg.update(func(c *config.AIConfig) { c.MaxSteps = 3 })
	id := h.newChat()
	h.send(id, "Loop.")
	h.wait(id)
	te := eventsOf[*ai.ToolEndEvent](h, ai.EventToolEnd)
	if len(te) != 3 || te[2].Status != ai.ToolNotExecuted || te[2].ErrorCode != "STEP_LIMIT" {
		t.Fatalf("tool ends %+v", te)
	}
	if d := h.done(); d.Status != ai.RunStepLimit || !d.CanContinue {
		t.Fatalf("done %+v", d)
	}
	if _, err := h.m.Compact(id); err != nil {
		t.Fatal(err)
	}
	h.wait(id)
	errs := eventsOf[*ai.ErrorEvent](h, ai.EventError)
	if len(errs) != 1 || !strings.Contains(errs[0].Message, "/compact") {
		t.Fatalf("compact %+v", errs)
	}
}

// replayCapture writes a recorded stream-json run line by line and makes
// the MCP call of every recorded LDAPilot tool_use right after its
// assistant line, like the CLI does.
func replayCapture(path string) func(f *fakeRun) {
	return func(f *fakeRun) {
		b, err := os.ReadFile(path)
		if err != nil {
			panic(err)
		}
		for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
			_, _ = f.pw.Write([]byte(line + "\n"))
			l, err := claudecode.ParseLine([]byte(line))
			if err != nil || l.Type != claudecode.LineAssistant || l.Message == nil {
				continue
			}
			for _, c := range l.Message.Content {
				if c.Type == "tool_use" && strings.HasPrefix(c.Name, claudecode.ToolPrefix) {
					if _, _, err := f.call(strings.TrimPrefix(c.Name, claudecode.ToolPrefix), string(c.Input)); err != nil {
						panic(err)
					}
				}
			}
		}
	}
}

func TestClaudeCodeReplayRealCapture(t *testing.T) {
	h, _, _ := ccHarness(t, "read", false, replayCapture("../claudecode/testdata/stream-mcp-2.1.308.jsonl"))
	id := h.newChat()
	h.send(id, "Which accounts are locked out in the AD lab?")
	h.wait(id)
	ms := eventsOf[*ai.MessageStartedEvent](h, ai.EventMessageStarted)
	ts := eventsOf[*ai.ToolStartEvent](h, ai.EventToolStart)
	te := eventsOf[*ai.ToolEndEvent](h, ai.EventToolEnd)
	if len(ms) != 2 || ms[0].Model != "claude-haiku-5-5" || len(ts) != 1 || ts[0].Name != "find_accounts" || ts[0].MessageID != ms[0].MessageID || len(te) != 1 {
		t.Fatalf("messages %+v tools %+v", ms, ts)
	}
	var text string
	for _, d := range eventsOf[*ai.DeltaEvent](h, ai.EventTextDelta) {
		text += d.Text
	}
	if !strings.Contains(text, "test.locked") || len(eventsOf[*ai.DeltaEvent](h, ai.EventThinkingDelta)) != 0 {
		t.Fatalf("text %q", text)
	}
	d := h.done()
	if d.Status != ai.RunCompleted || d.Totals.CostUSD != 0.00250727 || d.Totals.OutputTokens != 490 {
		t.Fatalf("done %+v", d)
	}
	c := h.chat(id)
	if len(c.Messages) != 4 || c.Messages[1].Blocks[0].ProviderCallID != "toolu_01RC1tqfsKH8cSjqw1ahriog" || c.Messages[3].Model != "claude-haiku-5-5" {
		t.Fatalf("history %+v", c.Messages)
	}
	// The thinking block had no displayable text: not stored.
	for _, b := range c.Messages[3].Blocks {
		if b.Type == ai.BlockThinking {
			t.Fatalf("empty thinking stored: %+v", b)
		}
	}
	checkSeq(t, h.rec)
}

// The CLI cancels an MCP call (its own timeout): the pending approval of
// that call resolves as cancelled and the run goes on.
func TestClaudeCodeClientCancelResolvesApproval(t *testing.T) {
	args := `{"dn":"` + anna + `","changes":[{"operation":"replace","attribute":"description","values":["Y"]}],"explanation":"Asked."}`
	cancelNow := make(chan struct{})
	h, _, _ := ccHarness(t, "write", true, func(f *fakeRun) {
		f.init("claude-haiku-5-5")
		f.startMsg("msg_1", "claude-haiku-5-5")
		f.toolUse(0, "toolu_w1", "modify_entry", args)
		f.endMsg("tool_use", 20)
		ctx, cancel := context.WithCancel(f.ctx)
		go func() {
			<-cancelNow
			cancel()
		}()
		_, _, err := f.callCtx(ctx, "modify_entry", args)
		f.toolResult("toolu_w1", fmt.Sprint("MCP error: ", err), true)
		f.startMsg("msg_2", "claude-haiku-5-5")
		f.text(0, "The change timed out.")
		f.endMsg("end_turn", 5)
		f.result(0.001, nil)
	})
	id := h.newChat()
	h.send(id, "Change it.")
	h.waitEvent(ai.EventApprovalRequest, 1)
	close(cancelNow)
	h.waitEvent(ai.EventApprovalResolved, 1)
	h.wait(id)
	ar := eventsOf[*ai.ApprovalResolvedEvent](h, ai.EventApprovalResolved)
	te := eventsOf[*ai.ToolEndEvent](h, ai.EventToolEnd)
	if ar[0].Decision != ai.ResolvedCancelled || len(te) != 1 || te[0].Status != ai.ToolCancelled || h.done().Status != ai.RunCompleted {
		t.Fatalf("resolved %+v tool %+v done %+v", ar, te, h.done())
	}
	if v := h.ad.Get(anna); hasValue(v, "description", "Y") {
		t.Fatal("written after cancel")
	}
}
