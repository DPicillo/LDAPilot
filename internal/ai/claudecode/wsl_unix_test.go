//go:build !windows

package claudecode

// WSL mode end to end on a POSIX host: the probe script runs in the real
// /bin/sh and login shell, and the test binary itself plays wsl.exe
// (fakeWSLMain): it starts `--exec <prog> args…` as a separate process
// group with only the variables named in WSLENV, like the Linux side of a
// real wsl.exe call.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai/mcprelay"
)

func TestMain(m *testing.M) {
	if os.Getenv("LDAPILOT_FAKE_WSL") == "1" {
		os.Exit(fakeWSLMain())
	}
	os.Exit(m.Run())
}

func fakeWSLMain() int {
	args := os.Args[1:]
	if log := os.Getenv("LDAPILOT_FAKE_WSL_LOG"); log != "" {
		if f, err := os.OpenFile(log, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			_, _ = f.WriteString(strings.Join(args, " ") + "\n\x00\n")
			f.Close()
		}
	}
	distro := "Ubuntu"
	if len(args) >= 2 && args[0] == "-d" {
		distro, args = args[1], args[2:]
	}
	if len(args) < 2 || args[0] != "--exec" {
		os.Stderr.WriteString("fake wsl: unsupported arguments\n")
		return 2
	}
	args = args[1:]
	env := []string{"HOME=" + os.Getenv("LDAPILOT_FAKE_WSL_HOME"), "PATH=/usr/bin:/bin", "WSL_DISTRO_NAME=" + distro, "WSLENV=" + os.Getenv("WSLENV")}
	for _, n := range strings.Split(os.Getenv("WSLENV"), ":") {
		if v, ok := os.LookupEnv(n); ok && n != "" {
			env = append(env, n+"="+v)
		}
	}
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // not reached by signals to "wsl.exe"
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode()
		}
		return 1
	}
	return 0
}

// fakeWSLTarget is a WSL target whose wsl.exe is this test binary.
func fakeWSLTarget(t *testing.T, env ...string) (*WSLTarget, string) {
	t.Helper()
	log := filepath.Join(t.TempDir(), "wsl.log")
	t.Setenv("LDAPILOT_FAKE_WSL", "1") // also for the stop signal, which uses os.Environ()
	t.Setenv("LDAPILOT_FAKE_WSL_LOG", log)
	t.Setenv("LDAPILOT_FAKE_WSL_HOME", t.TempDir())
	old := hostPathInWSL
	hostPathInWSL = func(p, root string) (string, error) {
		if strings.HasPrefix(p, "/") {
			return p, nil // a POSIX temp path stands for a drive path here
		}
		return WindowsToWSLPath(p, root)
	}
	t.Cleanup(func() { hostPathInWSL = old })
	return &WSLTarget{Exe: os.Args[0], Distro: "Ubuntu-24.04", MountRoot: "/mnt/", Env: env, Relay: `C:\Program Files\LDAPilot\LDAPilot.exe`}, log
}

func hostEnv() []string {
	return []string{"LDAPILOT_FAKE_WSL=1", "LDAPILOT_FAKE_WSL_LOG=" + os.Getenv("LDAPILOT_FAKE_WSL_LOG"), "LDAPILOT_FAKE_WSL_HOME=" + os.Getenv("LDAPILOT_FAKE_WSL_HOME"),
		"PATH=/usr/bin:/bin", "ANTHROPIC_API_KEY=sk-windows", "CLAUDECODE=1"}
}

// The run: arguments (with the empty --tools value) and the environment
// arrive in the distribution, the files are readable under the paths
// passed, the MCP config names the relay (no token in it), the token is
// only in the relay file, and nothing of it is on the command line.
func TestWSLRunEndToEnd(t *testing.T) {
	w, _ := fakeWSLTarget(t, "HOME=/home/u", "PATH=/usr/bin:/bin", "HTTPS_PROXY=http://u:pw@proxy:3128", "LANG=de_DE.UTF-8")
	cli := script(t, `prompt=$(cat)
mcp=""; tools="unset"
while [ $# -gt 0 ]; do
  case "$1" in
    --mcp-config) mcp=$2; shift ;;
    --tools) tools="[$2]"; shift ;;
  esac
  shift
done
printf '{"type":"result","subtype":"success","result":"%s|%s|%s|%s|%s|%s|%s"}\n' "$prompt" "$tools" "$MCP_TOOL_TIMEOUT" "$HTTPS_PROXY" "$WSL_DISTRO_NAME" "$ANTHROPIC_API_KEY$CLAUDECODE$WSLENV" "$(cat "$mcp" | tr -d '"')"
`)
	files := filepath.Join(t.TempDir(), "run-1")
	if err := os.Mkdir(files, 0o700); err != nil {
		t.Fatal(err)
	}
	token := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	inv, err := BuildInvocation(RunOptions{CLI: CLI{Path: cli, WSL: w}, WorkDir: t.TempDir(), FilesDir: files, MCPURL: "http://127.0.0.1:4242/mcp", MCPToken: token,
		Tools: []string{"get_entry"}, SystemPrompt: "You are LDAPilot.", Prompt: "Which accounts are locked?", Model: "haiku", Environ: hostEnv()})
	if err != nil {
		t.Fatal(err)
	}
	cmdline := inv.Path + " " + strings.Join(inv.Args, " ")
	for _, secret := range []string{token, "pw@proxy", "sk-windows", "Which accounts", "You are LDAPilot"} {
		if strings.Contains(cmdline, secret) {
			t.Fatalf("%q on the command line", secret)
		}
	}
	if inv.WSL != w || inv.Path != os.Args[0] || inv.RelayFile != filepath.Join(files, "relay.json") {
		t.Fatalf("invocation %+v", inv)
	}
	var rc mcprelay.Config
	if b, err := os.ReadFile(inv.RelayFile); err != nil || json.Unmarshal(b, &rc) != nil || rc.Token != token || rc.URL != "http://127.0.0.1:4242/mcp" {
		t.Fatalf("relay file %+v %v", rc, err)
	}
	if b, _ := os.ReadFile(inv.MCPConfig); strings.Contains(string(b), token) {
		t.Fatal("token in the MCP config of a WSL run")
	}

	proc, err := ExecLauncher{}.Launch(context.Background(), inv)
	if err != nil {
		t.Fatal(err)
	}
	l, err := NewReader(proc.Stdout()).Next()
	if err != nil {
		t.Fatalf("%v (stderr %q)", err, proc.Stderr())
	}
	if err := proc.Wait(); err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(l.Result.Result, "|")
	if len(parts) != 7 || parts[0] != "Which accounts are locked?" || parts[1] != "[]" || parts[2] != "900000" || parts[3] != "http://u:pw@proxy:3128" || parts[4] != "Ubuntu-24.04" || parts[5] != "" {
		t.Fatalf("seen in WSL: %q", parts)
	}
	mcp := parts[6]
	if !strings.Contains(mcp, "type:stdio") || !strings.Contains(mcp, "command:/mnt/c/Program Files/LDAPilot/LDAPilot.exe") ||
		!strings.Contains(mcp, "args:[--ldapilot-mcp-relay,"+inv.RelayFile+"]") || !strings.Contains(mcp, "timeout:900000") {
		t.Fatalf("mcp config seen in WSL: %s", mcp)
	}
	if strings.Contains(proc.Stderr(), pidMarker) {
		t.Fatalf("PID marker kept in stderr: %q", proc.Stderr())
	}
}

// Stop signals the CLI inside the distribution: killing "wsl.exe" alone
// would not reach it (separate process group here, a separate Linux
// process on Windows).
func TestWSLStopSignalsTheCLI(t *testing.T) {
	w, log := fakeWSLTarget(t, "PATH=/usr/bin:/bin")
	marker := filepath.Join(t.TempDir(), "got-int")
	cli := script(t, `trap 'echo int > `+marker+`; exit 0' INT
echo '{"type":"system","subtype":"init","model":"m"}'
while true; do sleep 0.05; done
`)
	inv, err := BuildInvocation(RunOptions{CLI: CLI{Path: cli, WSL: w}, WorkDir: t.TempDir(), FilesDir: t.TempDir(), MCPURL: "http://127.0.0.1:1/mcp", MCPToken: "t", Environ: hostEnv()})
	if err != nil {
		t.Fatal(err)
	}
	proc, err := ExecLauncher{}.Launch(context.Background(), inv)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := bufio.NewReader(proc.Stdout()).ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	ep := proc.(*execProcess)
	deadline := time.Now().Add(5 * time.Second)
	for ep.pid.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	pid := ep.pid.Load()
	if pid == 0 {
		t.Fatal("the run did not report its PID")
	}
	start := time.Now()
	Stop(proc, 3*time.Second)
	if time.Since(start) > 2500*time.Millisecond {
		t.Fatalf("stop took %v (SIGINT did not reach the CLI)", time.Since(start))
	}
	if b, err := os.ReadFile(marker); err != nil || strings.TrimSpace(string(b)) != "int" {
		t.Fatalf("CLI got no SIGINT: %v", err)
	}
	b, _ := os.ReadFile(log)
	if !strings.Contains(string(b), "-d Ubuntu-24.04 --exec /bin/sh -c kill -s INT "+itoa(pid)) {
		t.Fatalf("wsl.exe calls: %q", b)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

// --version and the initialize request also run through wsl.exe.
func TestWSLVersionAndDiscovery(t *testing.T) {
	w, log := fakeWSLTarget(t, "PATH=/usr/bin:/bin")
	fixture, _ := filepath.Abs("testdata/init-2.1.308.jsonl")
	cli := script(t, `case "$1" in
  --version) echo "2.1.311 (Claude Code)"; exit 0 ;;
esac
read line
case "$line" in
  *'"subtype":"initialize"'*) cat '`+fixture+`' ;;
esac
`)
	c := CLI{Path: cli, WSL: w}
	t.Setenv("PATH", "/usr/bin:/bin")
	v, err := Version(context.Background(), c, hostEnv())
	if err != nil || v != "2.1.311" {
		t.Fatalf("version %q %v", v, err)
	}
	res, err := DiscoverModels(context.Background(), DiscoverOptions{CLI: c, WorkDir: t.TempDir(), Environ: hostEnv()})
	if err != nil || len(res.Models) != 7 {
		t.Fatalf("discovery %+v %v", res, err)
	}
	b, _ := os.ReadFile(log)
	if strings.Count(string(b), "-d Ubuntu-24.04 --exec /bin/sh -c") != 2 {
		t.Fatalf("wsl.exe calls %q", b)
	}
	if c.commandTimeout(versionTimeout) != WSLCommandTimeout || (CLI{}).commandTimeout(versionTimeout) != versionTimeout {
		t.Fatal("timeouts")
	}
}

// The probe in the real /bin/sh: the interactive login shell's rc file
// puts claude on the PATH (as nvm does behind the interactivity guard of
// ~/.bashrc); rc noise on stdout does not disturb the result.
func TestProbeScriptRealShell(t *testing.T) {
	shell := ""
	if out, err := exec.Command("sh", "-c", `getent passwd "$(id -un)" | cut -d: -f7`).Output(); err == nil {
		shell = filepath.Base(strings.TrimSpace(string(out)))
	}
	home := t.TempDir()
	nvm := filepath.Join(home, "nvm", "bin")
	if err := os.MkdirAll(nvm, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nvm, "claude"), []byte("#!/bin/sh\necho 1.0.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	rc := "case $- in *i*) ;; *) return ;; esac\nexport PATH=\"$HOME/nvm/bin:$PATH\"\nexport CLAUDE_CONFIG_DIR=\"$HOME/.claude-work\"\necho 'Welcome (rc noise)'\n"
	for _, f := range []string{".bashrc", ".zshrc"} {
		if err := os.WriteFile(filepath.Join(home, f), []byte(rc), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(home, ".bash_profile"), []byte(". \"$HOME/.bashrc\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run := func(want string) *wslProbe {
		t.Helper()
		cmd := exec.Command("/bin/sh", "-s")
		cmd.Stdin = strings.NewReader(ProbeScript(want))
		cmd.Env = []string{"HOME=" + home, "PATH=/usr/bin:/bin", "USER=" + os.Getenv("USER"), "WSL_DISTRO_NAME=Test"}
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("probe: %v", err)
		}
		p, err := parseProbe(out)
		if err != nil {
			t.Fatalf("parse: %v\n%s", err, out)
		}
		return p
	}
	p := run("")
	if p.Distro != "Test" || p.Interop || p.Shell == "" {
		t.Fatalf("head %+v", p)
	}
	if shell == "bash" || shell == "zsh" {
		env := strings.Join(p.Env, "\n")
		if p.Claude != filepath.Join(nvm, "claude") || p.EnvSource != "login" || !strings.Contains(env, "CLAUDE_CONFIG_DIR="+home+"/.claude-work") {
			t.Fatalf("login shell %s: claude %q source %q", shell, p.Claude, p.EnvSource)
		}
	} else {
		t.Logf("login shell %q: interactive rc case not checked", shell)
	}
	// An explicit path is only checked.
	if p := run(filepath.Join(home, "missing")); p.Claude != "" {
		t.Fatalf("missing explicit path found: %q", p.Claude)
	}
	if p := run(filepath.Join(nvm, "claude")); p.Claude != filepath.Join(nvm, "claude") {
		t.Fatalf("explicit path: %q", p.Claude)
	}
	// Not on any PATH: the usual install location is found.
	os.Remove(filepath.Join(home, ".bashrc"))
	os.Remove(filepath.Join(home, ".zshrc"))
	local := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(local, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(local, "claude"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if p := run(""); p.Claude != filepath.Join(local, "claude") {
		t.Fatalf("fallback location: %q", p.Claude)
	}
}
