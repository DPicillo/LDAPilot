package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

func argValue(args []string, flag string) (string, bool) {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1], true
		}
	}
	return "", false
}

func TestBuildInvocation(t *testing.T) {
	files, err := NewRunDir(filepath.Join(t.TempDir(), "runs"))
	if err != nil {
		t.Fatal(err)
	}
	work := filepath.Join(t.TempDir(), "work")
	token := "tok-0123456789abcdef"
	env := []string{"PATH=/usr/bin", "HOME=/home/u", "CLAUDECODE=1", "CLAUDE_CODE_ENTRYPOINT=cli", "CLAUDE_CODE_SESSION_ID=x", "CLAUDE_PID=7",
		"CLAUDE_EFFORT=high", "ANTHROPIC_API_KEY=sk-secret", "HTTPS_PROXY=http://proxy:3128", "MCP_TOOL_TIMEOUT=5", "ENABLE_TOOL_SEARCH=true"}
	inv, err := BuildInvocation(RunOptions{CLI: CLI{Path: "/usr/bin/claude"}, WorkDir: work, FilesDir: files, MCPURL: "http://127.0.0.1:4242/mcp", MCPToken: token,
		Tools: []string{"search_ldap", "get_entry"}, SystemPrompt: "SYSTEM", Prompt: "Which accounts are locked?", Model: "haiku", MaxBudgetUSD: 0.25, Environ: env})
	if err != nil {
		t.Fatal(err)
	}
	cmdline := strings.Join(inv.Args, " ")
	// No secret and no prompt text on the command line (§11 a).
	for _, s := range []string{token, "Which accounts", "SYSTEM", "sk-secret"} {
		if strings.Contains(cmdline, s) {
			t.Fatalf("%q on the command line: %s", s, cmdline)
		}
	}
	for _, flag := range []string{"-p", "--verbose", "--include-partial-messages", "--strict-mcp-config", "--restricted", "--disable-slash-commands", "--no-session-persistence"} {
		if !slices.Contains(inv.Args, flag) {
			t.Fatalf("missing %s: %v", flag, inv.Args)
		}
	}
	want := map[string]string{"--output-format": "stream-json", "--tools": "", "--permission-prompts": "none", "--model": "haiku", "--max-budget-usd": "0.25",
		"--allowedTools": "mcp__ldapilot__search_ldap,mcp__ldapilot__get_entry", "--mcp-config": inv.MCPConfig, "--append-system-prompt-file": inv.SystemFile}
	for k, v := range want {
		if got, ok := argValue(inv.Args, k); !ok || got != v {
			t.Fatalf("%s = %q (%v), want %q", k, got, ok, v)
		}
	}
	if slices.Contains(inv.Args, "--resume") || inv.Stdin != "Which accounts are locked?" || inv.Dir != work {
		t.Fatalf("invocation %+v", inv)
	}
	// The MCP config file: private, with the token, alwaysLoad and the timeout.
	b, err := os.ReadFile(inv.MCPConfig)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		MCPServers map[string]struct {
			Type       string            `json:"type"`
			URL        string            `json:"url"`
			Headers    map[string]string `json:"headers"`
			Timeout    int               `json:"timeout"`
			AlwaysLoad bool              `json:"alwaysLoad"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	srv := doc.MCPServers["ldapilot"]
	if srv.Type != "http" || srv.URL != "http://127.0.0.1:4242/mcp" || srv.Headers["Authorization"] != "Bearer "+token || srv.Timeout != 900000 || !srv.AlwaysLoad {
		t.Fatalf("mcp config %s", b)
	}
	if sys, _ := os.ReadFile(inv.SystemFile); string(sys) != "SYSTEM" {
		t.Fatalf("system prompt %q", sys)
	}
	if runtime.GOOS != "windows" {
		for _, p := range []string{inv.MCPConfig, inv.SystemFile} {
			st, _ := os.Stat(p)
			if st.Mode().Perm() != 0o600 {
				t.Fatalf("%s mode %v", p, st.Mode())
			}
		}
		st, _ := os.Stat(files)
		if st.Mode().Perm() != 0o700 {
			t.Fatalf("run dir mode %v", st.Mode())
		}
	}
	// Environment: nested-session and Anthropic variables stripped, our
	// fixed settings present exactly once, the rest kept.
	envs := strings.Join(inv.Env, "\n")
	for _, bad := range []string{"CLAUDECODE=", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_EFFORT", "ANTHROPIC_API_KEY", "MCP_TOOL_TIMEOUT=5", "ENABLE_TOOL_SEARCH=true"} {
		if strings.Contains(envs, bad) {
			t.Fatalf("env keeps %s:\n%s", bad, envs)
		}
	}
	for _, good := range []string{"PATH=/usr/bin", "HOME=/home/u", "HTTPS_PROXY=http://proxy:3128", "MCP_TOOL_TIMEOUT=900000", "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=900000",
		"CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0", "ENABLE_TOOL_SEARCH=false", "CLAUDE_CODE_DISABLE_CLAUDE_MDS=1", "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1"} {
		if strings.Count(envs, good) != 1 {
			t.Fatalf("env misses %s:\n%s", good, envs)
		}
	}
}

func TestBuildArgsModelResumeAnthropicEnv(t *testing.T) {
	a := BuildArgs(RunOptions{Model: "default", Persist: true, ResumeSessionID: "sess-9"}, "/m.json", "")
	if _, ok := argValue(a, "--model"); ok {
		t.Fatalf("default model passed: %v", a)
	}
	if v, _ := argValue(a, "--resume"); v != "sess-9" || slices.Contains(a, "--no-session-persistence") || slices.Contains(a, "--append-system-prompt-file") {
		t.Fatalf("resume args %v", a)
	}
	a = BuildArgs(RunOptions{Model: "", ResumeSessionID: "ignored-without-persist"}, "/m.json", "")
	if slices.Contains(a, "--resume") || !slices.Contains(a, "--no-session-persistence") || slices.Contains(a, "--max-budget-usd") {
		t.Fatalf("args %v", a)
	}
	// The opt-in passes ANTHROPIC_* and the Claude Code backend/login
	// variables (review fix); without it neither reaches the CLI.
	env := RunEnv([]string{"ANTHROPIC_BASE_URL=https://gw", "CLAUDE_CODE_USE_BEDROCK=1", "CLAUDE_CODE_ENTRYPOINT=cli"}, true)
	if !slices.Contains(env, "ANTHROPIC_BASE_URL=https://gw") || !slices.Contains(env, "CLAUDE_CODE_USE_BEDROCK=1") || slices.Contains(env, "CLAUDE_CODE_ENTRYPOINT=cli") {
		t.Fatalf("env %v", env)
	}
	env = RunEnv([]string{"ANTHROPIC_BASE_URL=https://gw", "CLAUDE_CODE_USE_BEDROCK=1"}, false)
	if slices.Contains(env, "ANTHROPIC_BASE_URL=https://gw") || slices.Contains(env, "CLAUDE_CODE_USE_BEDROCK=1") {
		t.Fatalf("env without opt-in %v", env)
	}
}

func TestCleanRunFiles(t *testing.T) {
	root := t.TempDir()
	old, _ := NewRunDir(root)
	young, _ := NewRunDir(root)
	_ = os.WriteFile(filepath.Join(old, "mcp.json"), []byte("{}"), 0o600)
	past := time.Now().Add(-time.Hour)
	_ = os.Chtimes(old, past, past)
	keep := filepath.Join(root, "unrelated")
	_ = os.Mkdir(keep, 0o700)
	_ = os.Chtimes(keep, past, past)
	if n := CleanRunFiles(root, 10*time.Minute); n != 1 {
		t.Fatalf("removed %d", n)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("old run dir kept")
	}
	for _, p := range []string{young, keep} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("%s removed", p)
		}
	}
}
