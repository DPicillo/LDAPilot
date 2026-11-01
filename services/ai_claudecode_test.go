package services

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/claudecode"
)

type scriptedProc struct {
	r    *io.PipeReader
	done chan struct{}
}

func (p *scriptedProc) Stdout() io.Reader { return p.r }
func (p *scriptedProc) Interrupt() error  { return nil }
func (p *scriptedProc) Kill() error       { return nil }
func (p *scriptedProc) Wait() error       { <-p.done; return nil }
func (p *scriptedProc) Stderr() string    { return "" }

type scriptedLauncher struct {
	lines []string
	inv   *claudecode.Invocation
	files []string
}

func (l *scriptedLauncher) Launch(ctx context.Context, inv *claudecode.Invocation) (claudecode.Process, error) {
	l.inv = inv
	ents, _ := os.ReadDir(filepath.Dir(inv.MCPConfig))
	for _, e := range ents {
		l.files = append(l.files, e.Name())
	}
	r, w := io.Pipe()
	p := &scriptedProc{r: r, done: make(chan struct{})}
	go func() {
		defer close(p.done)
		for _, s := range l.lines {
			_, _ = w.Write([]byte(s + "\n"))
		}
		w.Close()
	}()
	return p, nil
}

// The facade wires the Claude Code engine: private run files under the
// config dir (removed after the run), the model fallback from the cached
// discovery, and the same events as the built-in engine.
func TestClaudeCodeFacadeWiring(t *testing.T) {
	s, store := newTestAIService(t)
	const cli = "/opt/claude/bin/claude"
	s.ccFindCLI = func(string) (string, error) { return cli, nil }
	l := &scriptedLauncher{lines: []string{
		`{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-5-5","mcp_servers":[{"name":"ldapilot","status":"connected"}]}`,
		`{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":3}}}}`,
		`{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from Claude Code."}}}`,
		`{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}}`,
		`{"type":"stream_event","event":{"type":"message_stop"}}`,
		`{"type":"result","subtype":"success","is_error":false,"result":"Hello from Claude Code.","total_cost_usd":0.002,"session_id":"s1","usage":{"input_tokens":3,"output_tokens":5}}`,
	}}
	s.ccLauncher = l
	var events []string
	s.emitter = func(name string, payload any) { events = append(events, name) }

	cfg := store.GetMasked()
	cfg.Engine = "claudecode"
	cfg.ClaudeCode.Model = "gone-model"
	if err := s.SaveAIConfig(cfg); err != nil {
		t.Fatal(err)
	}
	s.models.init()
	s.models.cache.PutModels("claudecode|"+cli, "claudecode", cli, "2.1.308", []ai.ModelInfo{
		{ID: "default", ResolvedModel: "claude-opus-5-5"}, {ID: "haiku", ResolvedModel: "claude-haiku-5-5"}})
	for in, want := range map[string]string{"haiku": "haiku", "claude-haiku-5-5": "claude-haiku-5-5", "gone-model": "default"} {
		got, notice := s.resolveClaudeModel(store.Get(), in)
		if got != want || (in == "gone-model") != (notice != "") {
			t.Fatalf("%s → %s %q", in, got, notice)
		}
	}

	env := s.claudeCodeEnv()
	root := filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "LDAPilot")
	if env.WorkDir != filepath.Join(root, claudeCodeWorkDir) || env.FilesDir != filepath.Join(root, claudeCodeFilesDir) {
		t.Fatalf("env %+v", env)
	}

	c, err := s.CreateChat("")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SendMessage(ai.SendRequest{ChatID: c.ID, Text: "Hello?", UI: ai.UIContext{TimeZone: "Europe/Berlin"}}); err != nil {
		t.Fatal(err)
	}
	if !s.mgr.Wait(c.ID, 10*time.Second) {
		t.Fatal("run did not finish")
	}
	if v := argOf(l.inv.Args, "--model"); v != "default" && v != "" {
		t.Fatalf("model arg %q", v)
	}
	if strings.Join(l.files, ",") != "mcp.json,system-prompt.txt" {
		t.Fatalf("run files %v", l.files)
	}
	if ents, _ := os.ReadDir(env.FilesDir); len(ents) != 0 {
		t.Fatalf("run files left: %v", ents)
	}
	view, err := s.GetChat(c.ID)
	if err != nil {
		t.Fatal(err)
	}
	last := view.Messages[len(view.Messages)-1]
	if last.Role != ai.RoleAssistant || last.Model != "claude-opus-5-5" || last.Provider != "claudecode" || last.Blocks[0].Text != "Hello from Claude Code." {
		t.Fatalf("last message %+v", last)
	}
	joined := strings.Join(events, ",")
	for _, e := range []string{ai.EventRunStarted, ai.EventStatus, ai.EventMessageStarted, ai.EventTextDelta, ai.EventUsage, ai.EventDone} {
		if !strings.Contains(joined, e) {
			t.Fatalf("missing %s in %s", e, joined)
		}
	}
}

func argOf(args []string, flag string) string {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}
