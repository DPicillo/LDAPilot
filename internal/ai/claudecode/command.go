package claudecode

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// MCPServerName is the server name in --mcp-config; Claude Code names the
// tools mcp__<server>__<tool>.
const MCPServerName = "ldapilot"

// ToolPrefix is the prefix Claude Code puts in front of the tool names.
const ToolPrefix = "mcp__" + MCPServerName + "__"

// MCPToolTimeoutMs bounds one MCP tool call on the CLI side. It must
// exceed the 10-minute approval wait (§11 d). Per the Claude Code docs
// (env-vars, mcp: "Time limits on MCP tool calls") MCP_TOOL_TIMEOUT
// defaults to 100000000 ms, but an HTTP server's per-request timer is only
// 60 s unless MCP_TOOL_TIMEOUT or the per-server "timeout" is raised, and
// a call without response or progress aborts after the 5-minute idle
// window (CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).
const MCPToolTimeoutMs = 900000

// Invocation is everything needed to start one `claude -p` run.
type Invocation struct {
	Path  string   // CLI path
	Args  []string // without the path
	Env   []string
	Dir   string // working directory (dedicated, empty)
	Stdin string // the prompt (written to stdin, then stdin is closed)

	// Informational, for fakes and diagnostics.
	MCPURL      string
	MCPToken    string
	MCPConfig   string // path of the --mcp-config file
	SystemFile  string // path of the --append-system-prompt-file file
	Model       string
	ResumeID    string
	AllowedTool []string
}

// RunOptions configure BuildInvocation.
type RunOptions struct {
	Path            string
	WorkDir         string // cwd of the CLI: a dedicated empty directory
	FilesDir        string // private (0700) directory for this run's files
	MCPURL          string
	MCPToken        string
	Tools           []string // offered tool names without prefix
	SystemPrompt    string   // appended to Claude Code's system prompt
	Prompt          string   // the user turn (stdin)
	Model           string   // "" or "default" = the CLI's default
	MaxBudgetUSD    float64  // > 0: --max-budget-usd
	ResumeSessionID string   // --resume (only with Persist)
	Persist         bool     // keep Claude Code's own session copy (resume opt-in)
	UseAnthropicEnv bool     // pass ANTHROPIC_* through
	Environ         []string // base environment (nil = os.Environ())
}

// MCPConfigJSON is the --mcp-config document: one HTTP server with the
// bearer token, always loaded up front (no tool search) and with a
// per-server tool timeout above the approval wait.
func MCPConfigJSON(url, token string) ([]byte, error) {
	doc := map[string]any{"mcpServers": map[string]any{MCPServerName: map[string]any{
		"type":       "http",
		"url":        url,
		"headers":    map[string]string{"Authorization": "Bearer " + token},
		"timeout":    MCPToolTimeoutMs,
		"alwaysLoad": true,
	}}}
	return json.Marshal(doc)
}

// AllowedTools returns the --allowedTools entries: the exact prefixed
// names of the offered tools (exact names avoid any dependency on the
// wildcard rules).
func AllowedTools(tools []string) []string {
	out := make([]string, 0, len(tools))
	for _, t := range tools {
		out = append(out, ToolPrefix+t)
	}
	return out
}

// BuildArgs returns the CLI arguments of a run. Secrets and the prompt are
// never on the command line: the MCP config (with the token) and the
// system prompt are files, the prompt goes to stdin.
func BuildArgs(o RunOptions, mcpConfigPath, systemPromptPath string) []string {
	args := []string{"-p",
		"--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--mcp-config", mcpConfigPath, "--strict-mcp-config",
		"--tools", "",
		"--allowedTools", strings.Join(AllowedTools(o.Tools), ","),
		"--permission-prompts", "none",
		"--restricted",
		"--disable-slash-commands",
	}
	if systemPromptPath != "" {
		args = append(args, "--append-system-prompt-file", systemPromptPath)
	}
	if m := strings.TrimSpace(o.Model); m != "" && m != "default" {
		args = append(args, "--model", m)
	}
	if o.MaxBudgetUSD > 0 {
		args = append(args, "--max-budget-usd", strconv.FormatFloat(o.MaxBudgetUSD, 'f', -1, 64))
	}
	if !o.Persist {
		args = append(args, "--no-session-persistence")
	} else if o.ResumeSessionID != "" {
		args = append(args, "--resume", o.ResumeSessionID)
	}
	return args
}

// fixedEnv are set by LDAPilot for every run (after RunEnv removed any
// inherited value).
var fixedEnv = []string{
	"MCP_TOOL_TIMEOUT=" + strconv.Itoa(MCPToolTimeoutMs),
	"CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=" + strconv.Itoa(MCPToolTimeoutMs),
	// A long call (an approval wait) must not move to a background task.
	"CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0",
	// LDAPilot's tools are few: load them up front, no ToolSearch step.
	"ENABLE_TOOL_SEARCH=false",
	// The user's coding memories and CLAUDE.md files are not LDAPilot's
	// business and would only cost tokens.
	"CLAUDE_CODE_DISABLE_CLAUDE_MDS=1",
	"CLAUDE_CODE_DISABLE_AUTO_MEMORY=1",
}

// RunEnv is ChildEnv plus LDAPilot's fixed settings for a run.
func RunEnv(environ []string, keepAnthropic bool) []string {
	base := ChildEnv(environ, keepAnthropic)
	override := map[string]bool{}
	for _, kv := range fixedEnv {
		override[strings.ToUpper(kv[:strings.IndexByte(kv, '=')])] = true
	}
	out := make([]string, 0, len(base)+len(fixedEnv))
	for _, kv := range base {
		k := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			k = kv[:i]
		}
		if override[strings.ToUpper(k)] {
			continue
		}
		out = append(out, kv)
	}
	return append(out, fixedEnv...)
}

// RunFilesPrefix names the per-run directories inside the private files
// root; CleanRunFiles removes stale ones at startup.
const RunFilesPrefix = "run-"

// NewRunDir creates a private 0700 directory for one run's files below
// root (created 0700 if missing).
func NewRunDir(root string) (string, error) {
	if root == "" {
		return "", errors.New("no directory for Claude Code run files")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", err
	}
	_ = os.Chmod(root, 0o700)
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	dir := filepath.Join(root, RunFilesPrefix+hex.EncodeToString(b[:]))
	if err := os.Mkdir(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

// CleanRunFiles removes run directories left by an earlier process (crash
// or kill). Directories younger than minAge are kept (another LDAPilot
// instance may be running).
func CleanRunFiles(root string, minAge time.Duration) int {
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), RunFilesPrefix) {
			continue
		}
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) < minAge {
			continue
		}
		if os.RemoveAll(filepath.Join(root, e.Name())) == nil {
			n++
		}
	}
	return n
}

func writePrivate(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// BuildInvocation writes the run's private files (MCP config with the
// token, system prompt) into o.FilesDir and returns the invocation. The
// caller removes o.FilesDir when the run ends.
func BuildInvocation(o RunOptions) (*Invocation, error) {
	if o.Path == "" {
		return nil, errors.New("Claude Code CLI not found")
	}
	if o.FilesDir == "" {
		return nil, errors.New("no directory for Claude Code run files")
	}
	cfg, err := MCPConfigJSON(o.MCPURL, o.MCPToken)
	if err != nil {
		return nil, err
	}
	mcpPath := filepath.Join(o.FilesDir, "mcp.json")
	if err := writePrivate(mcpPath, cfg); err != nil {
		return nil, fmt.Errorf("cannot write the MCP config: %w", err)
	}
	sysPath := ""
	if o.SystemPrompt != "" {
		sysPath = filepath.Join(o.FilesDir, "system-prompt.txt")
		if err := writePrivate(sysPath, []byte(o.SystemPrompt)); err != nil {
			return nil, fmt.Errorf("cannot write the system prompt: %w", err)
		}
	}
	env := o.Environ
	if env == nil {
		env = os.Environ()
	}
	if o.WorkDir != "" {
		if err := os.MkdirAll(o.WorkDir, 0o700); err != nil {
			return nil, err
		}
	}
	return &Invocation{Path: o.Path, Args: BuildArgs(o, mcpPath, sysPath), Env: RunEnv(env, o.UseAnthropicEnv), Dir: o.WorkDir, Stdin: o.Prompt,
		MCPURL: o.MCPURL, MCPToken: o.MCPToken, MCPConfig: mcpPath, SystemFile: sysPath, Model: o.Model, ResumeID: o.ResumeSessionID,
		AllowedTool: AllowedTools(o.Tools)}, nil
}
