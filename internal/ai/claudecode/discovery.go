// Package claudecode integrates the locally installed Claude Code CLI as an
// AI engine (headless only: LDAPilot starts `claude -p` itself). This file
// holds CLI detection, the child environment and the free model discovery
// via the stream-json "initialize" control request.
package claudecode

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

// DiscoveryTimeout bounds the initialize round trip (Addendum A: 15 s).
const DiscoveryTimeout = 15 * time.Second

const initRequestID = "req_init_1"

// FallbackAliases are offered when initialize fails or times out.
var FallbackAliases = []string{"default", "opus", "sonnet", "haiku"}

// InitResult is the tolerant parse of the initialize control response.
// Only models[].value/displayName/resolvedModel are relied upon; every
// other field is optional.
type InitResult struct {
	Models  []ai.ModelInfo `json:"models"`
	Version string         `json:"version,omitempty"` // claude_code_version, when reported
	Account *Account       `json:"account,omitempty"`
}

// Account is the non-identifying part of the initialize account info.
// The e-mail address and organization are deliberately not kept.
type Account struct {
	SubscriptionType string `json:"subscriptionType,omitempty"`
	APIProvider      string `json:"apiProvider,omitempty"`
}

type initModel struct {
	Value                    string   `json:"value"`
	ResolvedModel            string   `json:"resolvedModel"`
	DisplayName              string   `json:"displayName"`
	Description              string   `json:"description"`
	SupportsEffort           *bool    `json:"supportsEffort"`
	SupportedEffortLevels    []string `json:"supportedEffortLevels"`
	SupportsAdaptiveThinking *bool    `json:"supportsAdaptiveThinking"`
	SupportsThinkingOff      *bool    `json:"supportsThinkingOff"`
}

// ErrNoInitResponse is returned when the CLI output holds no initialize
// response.
var ErrNoInitResponse = errors.New("no initialize response from claude")

// ParseInitialize reads stream-json lines until the control_response for
// the initialize request and returns its models. Unknown fields and
// unrelated lines are ignored.
func ParseInitialize(r io.Reader) (*InitResult, error) {
	br := bufio.NewReaderSize(r, 256<<10)
	for {
		line, err := br.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			if res, ok := parseInitLine(line); ok {
				return res, nil
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, ErrNoInitResponse
			}
			return nil, err
		}
	}
}

func parseInitLine(line []byte) (*InitResult, bool) {
	var env struct {
		Type     string `json:"type"`
		Response struct {
			Subtype   string          `json:"subtype"`
			RequestID string          `json:"request_id"`
			Error     string          `json:"error"`
			Response  json.RawMessage `json:"response"`
		} `json:"response"`
	}
	if json.Unmarshal(bytes.TrimSpace(line), &env) != nil || env.Type != "control_response" {
		return nil, false
	}
	if env.Response.RequestID != "" && env.Response.RequestID != initRequestID {
		return nil, false
	}
	var body struct {
		Models  []json.RawMessage `json:"models"`
		Version string            `json:"claude_code_version"`
		Account *struct {
			SubscriptionType string `json:"subscriptionType"`
			APIProvider      string `json:"apiProvider"`
		} `json:"account"`
	}
	if len(env.Response.Response) == 0 || json.Unmarshal(env.Response.Response, &body) != nil {
		return &InitResult{}, true
	}
	res := &InitResult{Version: body.Version}
	if body.Account != nil {
		res.Account = &Account{SubscriptionType: body.Account.SubscriptionType, APIProvider: body.Account.APIProvider}
	}
	for _, raw := range body.Models {
		var m initModel
		if json.Unmarshal(raw, &m) != nil || strings.TrimSpace(m.Value) == "" {
			continue
		}
		res.Models = append(res.Models, modelInfo(m))
	}
	return res, true
}

func modelInfo(m initModel) ai.ModelInfo {
	info := ai.ModelInfo{
		ID:            m.Value,
		DisplayName:   m.DisplayName,
		ResolvedModel: m.ResolvedModel,
		Description:   m.Description,
		Tools:         ai.CapYes,
		ToolsVerified: true,
		Vision:        ai.CapYes,
		Thinking:      ai.CapUnknown,
		Default:       m.Value == "default",
		Remote:        true,
	}
	if info.DisplayName == "" {
		info.DisplayName = m.Value
	}
	if m.SupportsAdaptiveThinking != nil {
		if *m.SupportsAdaptiveThinking {
			info.Thinking = ai.CapYes
			info.ThinkingModes = append(info.ThinkingModes, "adaptive")
		}
	}
	if m.SupportsThinkingOff != nil && *m.SupportsThinkingOff {
		info.ThinkingModes = append(info.ThinkingModes, "disabled")
	}
	if m.SupportsEffort != nil && *m.SupportsEffort {
		info.SupportsEffort = true
		info.EffortLevels = append([]string(nil), m.SupportedEffortLevels...)
	}
	return info
}

// FallbackModels returns the alias list used when initialize fails.
func FallbackModels() []ai.ModelInfo {
	out := make([]ai.ModelInfo, 0, len(FallbackAliases))
	for _, a := range FallbackAliases {
		name := strings.ToUpper(a[:1]) + a[1:]
		if a == "default" {
			name = "Default (CLI default)"
		}
		out = append(out, ai.ModelInfo{ID: a, DisplayName: name, Tools: ai.CapYes, Vision: ai.CapUnknown, Thinking: ai.CapUnknown, Default: a == "default", Remote: true, Note: "alias (model list unavailable)"})
	}
	return out
}

// DiscoverOptions configure DiscoverModels.
type DiscoverOptions struct {
	Path            string   // CLI path (required)
	WorkDir         string   // dedicated empty directory ("" = os.TempDir())
	Environ         []string // base environment (nil = os.Environ())
	UseAnthropicEnv bool     // keep ANTHROPIC_* variables
	Timeout         time.Duration
}

// DiscoverModels runs the CLI in stream-json mode with all tools and
// settings disabled, sends the initialize control request on stdin, closes
// stdin and reads the control response. No model call is made, so it is
// free. On any failure the fallback aliases are returned together with the
// error.
func DiscoverModels(ctx context.Context, o DiscoverOptions) (*InitResult, error) {
	res, err := runInitialize(ctx, o)
	if err != nil || len(res.Models) == 0 {
		if err == nil {
			err = errors.New("claude reported no models")
		}
		fb := &InitResult{Models: FallbackModels()}
		if res != nil {
			fb.Version, fb.Account = res.Version, res.Account
		}
		return fb, err
	}
	return res, nil
}

// InitializeArgs are the CLI arguments of the discovery run.
func InitializeArgs() []string {
	return []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
		"--tools", "", "--strict-mcp-config", "--no-session-persistence", "--restricted"}
}

func runInitialize(ctx context.Context, o DiscoverOptions) (*InitResult, error) {
	if o.Path == "" {
		return nil, errors.New("Claude Code CLI not found")
	}
	timeout := o.Timeout
	if timeout <= 0 {
		timeout = DiscoveryTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, o.Path, InitializeArgs()...)
	cmd.Dir = o.WorkDir
	if cmd.Dir == "" {
		cmd.Dir = os.TempDir()
	}
	env := o.Environ
	if env == nil {
		env = os.Environ()
	}
	cmd.Env = ChildEnv(env, o.UseAnthropicEnv)
	cmd.WaitDelay = 2 * time.Second
	prepareProcess(cmd)
	req := `{"type":"control_request","request_id":"` + initRequestID + `","request":{"subtype":"initialize"}}` + "\n"
	cmd.Stdin = strings.NewReader(req) // EOF after the request: the CLI exits on its own
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr limitedBuffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("cannot start %s: %w", o.Path, err)
	}
	res, perr := ParseInitialize(stdout)
	if perr == nil {
		// Got what we need: do not wait for the CLI to finish on its own.
		_ = killProcess(cmd)
	}
	werr := cmd.Wait()
	if perr != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("claude did not answer the initialize request within %s", timeout)
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" && werr != nil {
			msg = werr.Error()
		}
		if msg != "" {
			return nil, fmt.Errorf("%w: %s", perr, truncate(msg, 500))
		}
		return nil, perr
	}
	return res, nil
}

// limitedBuffer keeps the first 8 KB written to it.
type limitedBuffer struct{ b bytes.Buffer }

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if room := 8<<10 - l.b.Len(); room > 0 {
		if len(p) > room {
			l.b.Write(p[:room])
		} else {
			l.b.Write(p)
		}
	}
	return len(p), nil
}

func (l *limitedBuffer) String() string { return l.b.String() }

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

var versionRe = regexp.MustCompile(`\d+\.\d+\.\d+[0-9A-Za-z.+-]*`)

// Version runs `claude --version` and returns the version number
// ("2.1.308").
func Version(ctx context.Context, path string, environ []string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	if environ == nil {
		environ = os.Environ()
	}
	cmd.Env = ChildEnv(environ, false)
	cmd.Stdin = nil
	cmd.WaitDelay = time.Second
	prepareProcess(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("%s --version failed: %w", path, err)
	}
	v := versionRe.FindString(string(out))
	if v == "" {
		return strings.TrimSpace(string(out)), nil
	}
	return v, nil
}

// claudeCodeAlways are CLAUDE_CODE_* variables that configure the CLI
// itself rather than mark a nested session: always passed through.
var claudeCodeAlways = map[string]bool{
	"CLAUDE_CODE_GIT_BASH_PATH": true, // Windows: where Git Bash is
}

// claudeCodeCredentials are CLAUDE_CODE_* variables that select the
// backend or carry the login of a headless setup (claude setup-token,
// Bedrock, Vertex, Foundry). They pass through only with "use my
// environment's Anthropic settings", like ANTHROPIC_*.
var claudeCodeCredentials = map[string]bool{
	"CLAUDE_CODE_OAUTH_TOKEN":           true,
	"CLAUDE_CODE_USE_BEDROCK":           true,
	"CLAUDE_CODE_USE_VERTEX":            true,
	"CLAUDE_CODE_USE_FOUNDRY":           true,
	"CLAUDE_CODE_SKIP_BEDROCK_AUTH":     true,
	"CLAUDE_CODE_SKIP_VERTEX_AUTH":      true,
	"CLAUDE_CODE_SKIP_FOUNDRY_AUTH":     true,
	"CLAUDE_CODE_API_KEY_HELPER_TTL_MS": true,
}

// ChildEnv returns environ without the variables that make the CLI think
// it runs nested in another Claude Code session (CLAUDECODE, CLAUDE_CODE_*,
// CLAUDE_PID, CLAUDE_EFFORT) and, unless keepAnthropic, without ANTHROPIC_*
// and the Claude Code login/backend variables (claudeCodeCredentials).
// PATH, HOME, proxy variables and CLAUDE_CODE_GIT_BASH_PATH are kept.
func ChildEnv(environ []string, keepAnthropic bool) []string {
	out := make([]string, 0, len(environ))
	for _, kv := range environ {
		k := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			k = kv[:i]
		}
		uk := strings.ToUpper(k)
		switch {
		case claudeCodeAlways[uk]:
		case claudeCodeCredentials[uk] && keepAnthropic:
		case uk == "CLAUDECODE", uk == "CLAUDE_PID", uk == "CLAUDE_EFFORT", strings.HasPrefix(uk, "CLAUDE_CODE_"):
			continue
		case strings.HasPrefix(uk, "ANTHROPIC_") && !keepAnthropic:
			continue
		}
		out = append(out, kv)
	}
	return out
}

// CandidatePaths lists where the CLI is looked for, in order, after PATH.
func CandidatePaths() []string {
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "windows" {
		appData := os.Getenv("APPDATA")
		return []string{
			filepath.Join(home, ".local", "bin", "claude.exe"),
			filepath.Join(appData, "npm", "claude.cmd"),
			filepath.Join(appData, "npm", "claude.exe"),
		}
	}
	return []string{
		filepath.Join(home, ".local", "bin", "claude"),
		filepath.Join(home, ".claude", "local", "claude"),
		"/home/linuxbrew/.linuxbrew/bin/claude",
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
		filepath.Join(home, ".npm-global", "bin", "claude"),
	}
}

// FindCLI returns the CLI path: the explicit path if set (it must exist),
// else the first match on PATH or in CandidatePaths.
func FindCLI(explicit string) (string, error) {
	if explicit != "" {
		if isExecutable(explicit) {
			return explicit, nil
		}
		return "", fmt.Errorf("Claude Code CLI not found at %s", explicit)
	}
	if p, err := exec.LookPath("claude"); err == nil {
		if abs, err := filepath.Abs(p); err == nil {
			return abs, nil
		}
		return p, nil
	}
	for _, c := range CandidatePaths() {
		if isExecutable(c) {
			return c, nil
		}
	}
	return "", errors.New("Claude Code CLI not found (looked on PATH, ~/.local/bin, Homebrew and npm global locations)")
}

func isExecutable(p string) bool {
	st, err := os.Stat(p)
	if err != nil || st.IsDir() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return st.Mode()&0o111 != 0
}
