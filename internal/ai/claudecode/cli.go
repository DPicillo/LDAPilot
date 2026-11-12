package claudecode

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Where the CLI runs (config.ClaudeCodeConfig.Runtime). Only Windows has a
// choice; elsewhere the CLI always runs natively.
const (
	RuntimeAuto    = ""        // native if found, else WSL (Windows)
	RuntimeWindows = "windows" // native Windows CLI only
	RuntimeWSL     = "wsl"     // the CLI inside a WSL distribution
)

// CLI is a Claude Code CLI found by a Resolver: a native executable or one
// inside a WSL distribution.
type CLI struct {
	// Path is the executable: a native path, or the absolute Linux path
	// inside the distribution.
	Path string
	// WSL is set when the CLI runs in WSL.
	WSL *WSLTarget
}

// WSLTarget is the distribution a CLI runs in and what the probe learned
// about it.
type WSLTarget struct {
	Exe       string   // wsl.exe
	Distro    string   // distribution name (always explicit after the probe)
	Version   int      // WSL 1 or 2; 0 = unknown
	MountRoot string   // drvfs automount root ("/mnt/")
	Env       []string // the login shell's environment (cleaned; NAME=value)
	EnvSource string   // "login" (interactive login shell) or "plain"
	Shell     string   // the login shell
	Relay     string   // Windows path of the MCP relay executable (LDAPilot.exe)
}

// Key identifies the CLI for caches (the model list is per CLI).
func (c CLI) Key() string {
	if c.WSL != nil {
		return "wsl:" + c.WSL.Distro + ":" + c.Path
	}
	return c.Path
}

// Describe names the CLI in messages.
func (c CLI) Describe() string {
	if c.WSL != nil {
		return fmt.Sprintf("%s in WSL (%s)", c.Path, c.WSL.Distro)
	}
	return c.Path
}

// command returns the program, arguments and environment that run the CLI
// with args. hostEnv is LDAPilot's environment; run adds LDAPilot's fixed
// run settings (RunEnv); markPID makes a WSL run report its PID on stderr.
func (c CLI) command(args, hostEnv []string, keepAnthropic, run, markPID bool) (string, []string, []string) {
	if c.WSL == nil {
		if run {
			return c.Path, args, RunEnv(hostEnv, keepAnthropic)
		}
		return c.Path, args, ChildEnv(hostEnv, keepAnthropic)
	}
	linux := withCLIDir(c.WSL.Env, c.Path)
	if run {
		linux = setEnv(RunEnv(linux, keepAnthropic), "MCP_TIMEOUT="+strconv.Itoa(wslMCPStartupMs))
	} else {
		linux = ChildEnv(linux, keepAnthropic)
	}
	vars, wslenv, envScript := wslEnvScript(linux)
	script := wslExecScript(envScript, c.Path, args, markPID)
	return c.WSL.Exe, wslArgs(c.WSL.Distro, script), wslHostEnv(hostEnv, vars, wslenv)
}

// setEnv sets kv in env, replacing an entry of the same name.
func setEnv(env []string, kv string) []string {
	k, _, _ := strings.Cut(kv, "=")
	out := make([]string, 0, len(env)+1)
	for _, e := range env {
		if ek, _, _ := strings.Cut(e, "="); ek == k {
			continue
		}
		out = append(out, e)
	}
	return append(out, kv)
}

// commandTimeout is the limit of a short CLI call (--version, initialize).
func (c CLI) commandTimeout(native time.Duration) time.Duration {
	if c.WSL != nil && native < WSLCommandTimeout {
		return WSLCommandTimeout
	}
	return native
}

// ResolveOptions say where to look for the CLI (the AI settings).
type ResolveOptions struct {
	Runtime string // RuntimeAuto, RuntimeWindows or RuntimeWSL (Windows only)
	Path    string // explicit native path ("" = detect)
	Distro  string // WSL distribution ("" = the default one)
	WSLPath string // explicit Linux path inside the distribution ("" = detect)
}

// Resolver finds the CLI. The zero value works on the real system; the
// fields replace parts of it in tests.
type Resolver struct {
	GOOS       string                                // "" = runtime.GOOS
	FindNative func(explicit string) (string, error) // nil = FindCLI
	WSLExe     string                                // "" = %SystemRoot%\System32\wsl.exe
	// Run runs one wsl.exe call with stdin and returns its stdout and
	// stderr (nil = exec in os.TempDir()).
	Run        func(ctx context.Context, prog string, args, env []string, stdin string) (stdout, stderr []byte, err error)
	Environ    func() []string        // nil = os.Environ
	Executable func() (string, error) // the relay (nil = os.Executable)
}

// NotFoundError is returned when no usable CLI was found; its text names
// every place LDAPilot looked at and what to do.
type NotFoundError struct{ Msg string }

func (e *NotFoundError) Error() string { return e.Msg }

func (r Resolver) goos() string {
	if r.GOOS != "" {
		return r.GOOS
	}
	return runtime.GOOS
}

func (r Resolver) environ() []string {
	if r.Environ != nil {
		return r.Environ()
	}
	return os.Environ()
}

// Resolve finds the CLI. On Windows, Runtime decides: Windows only, WSL
// only, or automatic (a native CLI wins; without one, the default WSL
// distribution and then the others are checked). Elsewhere the CLI is
// always native.
func (r Resolver) Resolve(ctx context.Context, o ResolveOptions) (CLI, error) {
	native := func() (CLI, error) {
		find := r.FindNative
		if find == nil {
			find = FindCLI
		}
		p, err := find(o.Path)
		if err != nil {
			return CLI{}, err
		}
		return CLI{Path: p}, nil
	}
	if r.goos() != "windows" {
		return native()
	}
	switch o.Runtime {
	case RuntimeWindows:
		cli, err := native()
		if err != nil {
			return CLI{}, &NotFoundError{Msg: err.Error() + ". Install Claude Code for Windows, set its path, or choose WSL under “Claude Code runs in” in the AI settings."}
		}
		return cli, nil
	case RuntimeWSL:
		cli, note, err := r.resolveWSL(ctx, o, true)
		if err != nil {
			return CLI{}, err
		}
		if cli == nil {
			return CLI{}, &NotFoundError{Msg: "Claude Code CLI not found in WSL (" + note + "). Install it in that distribution (" + wslInstallHint + "), set its Linux path, or choose another distribution in the AI settings."}
		}
		return *cli, nil
	}
	if o.Path != "" {
		return native()
	}
	cli, nerr := native()
	if nerr == nil {
		return cli, nil
	}
	wcli, note, err := r.resolveWSL(ctx, o, false)
	if err != nil {
		return CLI{}, err
	}
	if wcli != nil {
		return *wcli, nil
	}
	if ctx.Err() != nil {
		return CLI{}, ctx.Err()
	}
	return CLI{}, &NotFoundError{Msg: "Claude Code CLI not found. Windows: not found " + strings.TrimPrefix(nerr.Error(), "Claude Code CLI not found ") +
		". WSL: " + note + ". Install Claude Code for Windows (" + windowsInstallHint + ") or inside a WSL distribution (" + wslInstallHint +
		"), or set where it runs in the AI settings."}
}

const (
	windowsInstallHint = "irm https://claude.ai/install.ps1 | iex in PowerShell"
	wslInstallHint     = "curl -fsSL https://claude.ai/install.sh | bash, then run claude once to log in"
)

// resolveWSL probes the configured (or default) distribution and, in
// automatic mode, the other ones. It returns the CLI, or nil and a note
// for the message; err only for a CLI that was found but cannot be used
// (no interop, no drive mounts, no relay).
func (r Resolver) resolveWSL(ctx context.Context, o ResolveOptions, explicit bool) (*CLI, string, error) {
	exe, err := r.wslExe()
	if err != nil {
		return nil, err.Error(), nil
	}
	var notes []string
	probe := func(distro string) (*CLI, error) {
		p, perr := r.probe(ctx, exe, distro, o.WSLPath)
		name := distro
		if name == "" && p != nil {
			name = p.Distro
		}
		if name == "" {
			name = "default distribution"
		}
		if perr != nil {
			notes = append(notes, name+": "+perr.Error())
			return nil, nil
		}
		if p.Claude == "" {
			if o.WSLPath != "" {
				notes = append(notes, name+": "+o.WSLPath+" is not an executable file")
			} else {
				notes = append(notes, name+": no claude on the login shell's PATH, in ~/.local/bin, npm global or nvm")
			}
			return nil, nil
		}
		cli, uerr := r.wslCLI(exe, p, distro)
		if uerr != nil {
			return nil, fmt.Errorf("Claude Code was found in WSL (%s) but cannot be used: %v", name, uerr)
		}
		return cli, nil
	}
	if o.Distro != "" || explicit {
		cli, err := probe(o.Distro)
		return cli, strings.Join(notes, "; "), err
	}
	// Automatic mode: the default distribution first, then the others;
	// listing starts none of them, so a machine without WSL (or with only
	// Docker Desktop's distributions) costs no distribution start.
	list, lerr := r.ListWSL(ctx)
	if lerr != nil {
		return nil, lerr.Error(), nil
	}
	ordered := make([]WSLDistro, 0, len(list))
	for _, d := range list {
		if !IsHelperDistro(d.Name) {
			if d.Default {
				ordered = append([]WSLDistro{d}, ordered...)
			} else {
				ordered = append(ordered, d)
			}
		}
	}
	for _, d := range ordered {
		if ctx.Err() != nil {
			break
		}
		if cli, err := probe(d.Name); cli != nil || err != nil {
			return cli, "", err
		}
	}
	if len(ordered) == 0 {
		notes = append(notes, "no Linux distribution installed")
	}
	return nil, strings.Join(notes, "; "), nil
}

// wslCLI checks that a found CLI can be connected to LDAPilot's tools and
// builds it.
func (r Resolver) wslCLI(exe string, p *wslProbe, distro string) (*CLI, error) {
	if !p.Interop {
		return nil, errors.New("Windows interop is disabled in this distribution ([interop] enabled=false in /etc/wsl.conf); LDAPilot needs it to connect Claude Code to its tools")
	}
	root := p.MountRoot()
	if root == "" {
		return nil, errors.New("drive C: is not mounted in this distribution ([automount] in /etc/wsl.conf); LDAPilot needs it for its run files")
	}
	executable := r.Executable
	if executable == nil {
		executable = os.Executable
	}
	relay, err := executable()
	if err != nil {
		return nil, fmt.Errorf("cannot locate LDAPilot.exe: %v", err)
	}
	if _, err := WindowsToWSLPath(relay, root); err != nil {
		return nil, fmt.Errorf("LDAPilot must run from a drive letter for the WSL mode: %v", err)
	}
	name := distro // the distribution asked for; the probe names the default one
	if name == "" {
		name = p.Distro
	}
	if !ValidWSLDistroName(name) {
		return nil, fmt.Errorf("unexpected distribution name %q", name)
	}
	return &CLI{Path: p.Claude, WSL: &WSLTarget{Exe: exe, Distro: name, Version: p.WSLVersion(), MountRoot: root,
		Env: cleanProbedEnv(p.Env), EnvSource: p.EnvSource, Shell: p.Shell, Relay: relay}}, nil
}

// probe runs ProbeScript in distro ("" = the default distribution).
func (r Resolver) probe(ctx context.Context, exe, distro, want string) (*wslProbe, error) {
	ctx, cancel := context.WithTimeout(ctx, WSLProbeTimeout)
	defer cancel()
	var args []string
	if distro != "" {
		args = append(args, "-d", distro)
	}
	args = append(args, "--exec", "/bin/sh", "-s")
	env := setEnv(ChildEnv(r.environ(), false), "WSL_UTF8=1")
	stdout, stderr, err := r.run(ctx, exe, args, env, ProbeScript(want))
	if ctx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("no answer within %s (WSL did not start?)", WSLProbeTimeout)
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	p, perr := parseProbe(stdout)
	if perr != nil {
		return nil, wslListError(DecodeWSLOutput(stderr)+"\n"+DecodeWSLOutput(stdout), firstErr(err, perr))
	}
	return p, nil
}

func firstErr(errs ...error) error {
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}

// ListWSL lists the installed distributions (`wsl.exe --list --verbose`;
// no distribution is started).
func (r Resolver) ListWSL(ctx context.Context) ([]WSLDistro, error) {
	exe, err := r.wslExe()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, wslListTimeout)
	defer cancel()
	env := setEnv(ChildEnv(r.environ(), false), "WSL_UTF8=1")
	stdout, stderr, err := r.run(ctx, exe, []string{"--list", "--verbose"}, env, "")
	out := DecodeWSLOutput(stdout)
	if err == nil {
		if list := ParseWSLList(out, true); len(list) > 0 {
			return list, nil
		}
	}
	// Older wsl.exe without --verbose, or no distribution at all.
	qout, qerr, qrunErr := r.run(ctx, exe, []string{"--list", "--quiet"}, env, "")
	if qrunErr == nil {
		if list := ParseWSLList(DecodeWSLOutput(qout), false); len(list) > 0 {
			return list, nil
		}
	}
	if ctx.Err() != nil {
		return nil, fmt.Errorf("wsl.exe did not answer within %s", wslListTimeout)
	}
	return nil, wslListError(strings.TrimSpace(out+"\n"+DecodeWSLOutput(stderr)+"\n"+DecodeWSLOutput(qerr)), firstErr(err, qrunErr))
}

// wslExe locates wsl.exe.
func (r Resolver) wslExe() (string, error) {
	if r.WSLExe != "" {
		return r.WSLExe, nil
	}
	if root := os.Getenv("SystemRoot"); root != "" {
		p := filepath.Join(root, "System32", "wsl.exe")
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, nil
		}
	}
	if p, err := exec.LookPath("wsl.exe"); err == nil {
		return p, nil
	}
	return "", errors.New("WSL is not installed (wsl.exe not found)")
}

func (r Resolver) run(ctx context.Context, prog string, args, env []string, stdin string) ([]byte, []byte, error) {
	if r.Run != nil {
		return r.Run(ctx, prog, args, env, stdin)
	}
	cmd := exec.CommandContext(ctx, prog, args...)
	cmd.Env = env
	cmd.Dir = os.TempDir()
	cmd.Stdin = strings.NewReader(stdin)
	var stdout, stderr cappedBuffer
	stdout.max, stderr.max = 4<<20, 64<<10
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.WaitDelay = 2 * time.Second
	prepareProcess(cmd)
	err := cmd.Run()
	return stdout.b.Bytes(), stderr.b.Bytes(), err
}

// cappedBuffer keeps the first max bytes written to it.
type cappedBuffer struct {
	b   bytes.Buffer
	max int
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if room := c.max - c.b.Len(); room > 0 {
		if len(p) > room {
			c.b.Write(p[:room])
		} else {
			c.b.Write(p)
		}
	}
	return len(p), nil
}
