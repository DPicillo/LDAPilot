package claudecode

import (
	"context"
	"errors"
	"strings"
	"testing"
	"unicode/utf16"
)

func utf16le(s string, bom bool) []byte {
	var b []byte
	if bom {
		b = append(b, 0xFF, 0xFE)
	}
	for _, u := range utf16.Encode([]rune(s)) {
		b = append(b, byte(u), byte(u>>8))
	}
	return b
}

func TestDecodeWSLOutput(t *testing.T) {
	text := "  NAME      STATE           VERSION\r\n* Ubuntu    Running         2\r\n"
	want := "  NAME      STATE           VERSION\n* Ubuntu    Running         2\n"
	for name, in := range map[string][]byte{
		"utf16 with BOM":    utf16le(text, true),
		"utf16 without BOM": utf16le(text, false),
		"utf8 (WSL_UTF8=1)": []byte(text),
	} {
		if got := DecodeWSLOutput(in); got != want {
			t.Errorf("%s: %q", name, got)
		}
	}
	// German umlauts survive either encoding.
	de := "Wird ausgeführt"
	if got := DecodeWSLOutput(utf16le(de, false)); got != de {
		t.Errorf("utf16 umlaut: %q", got)
	}
	if got := DecodeWSLOutput([]byte(de)); got != de {
		t.Errorf("utf8 umlaut: %q", got)
	}
}

func TestParseWSLList(t *testing.T) {
	en := "  NAME                   STATE           VERSION\n* Ubuntu-24.04           Running         2\n  docker-desktop         Stopped         2\n  Legacy                 Stopped         1\n"
	got := ParseWSLList(en, true)
	if len(got) != 3 || got[0] != (WSLDistro{Name: "Ubuntu-24.04", Default: true, State: "Running", Version: 2}) ||
		got[1].Name != "docker-desktop" || got[1].Default || got[2].Version != 1 {
		t.Fatalf("english: %+v", got)
	}
	// German Windows: localized header and a state with blanks.
	de := DecodeWSLOutput(utf16le("  NAME      STATUS            VERSION\r\n* Debian    Wird ausgeführt   2\r\n  Ubuntu    Beendet           2\r\n", false))
	got = ParseWSLList(de, true)
	if len(got) != 2 || !got[0].Default || got[0].Name != "Debian" || got[0].State != "Wird ausgeführt" || got[1].Name != "Ubuntu" || got[1].Default {
		t.Fatalf("german: %+v", got)
	}
	q := ParseWSLList("Ubuntu\nDebian\n\n", false)
	if len(q) != 2 || q[1].Name != "Debian" || q[0].Default {
		t.Fatalf("quiet: %+v", q)
	}
	// A message instead of a list yields no distribution.
	if got := ParseWSLList("Windows Subsystem for Linux has no installed distributions.\nUse 'wsl.exe --list --online' to list available distributions\n", false); len(got) != 0 {
		t.Fatalf("message parsed as list: %+v", got)
	}
	if !IsHelperDistro("Docker-Desktop-Data") || IsHelperDistro("Ubuntu") {
		t.Fatal("helper distros")
	}
	if ValidWSLDistroName("a b") || ValidWSLDistroName("x;rm") || !ValidWSLDistroName("Ubuntu-22.04") {
		t.Fatal("distro names")
	}
	err := wslListError("Windows Subsystem for Linux has no installed distributions.\nError code: Wsl/WSL_E_DEFAULT_DISTRO_NOT_FOUND\n", errors.New("exit status 1"))
	if err.Error() != "Windows Subsystem for Linux has no installed distributions." {
		t.Fatalf("list error %q", err)
	}
}

// probeOut builds what the probe prints: rc-file noise, the header, and
// the environment blocks of the login shell and the plain shell.
func probeOut(loginClaude, plainClaude string, env ...string) []byte {
	var b strings.Builder
	b.WriteString("Welcome to Ubuntu (motd noise)\n" + probeHeader + "\n")
	b.WriteString("distro=Ubuntu\nkernel=6.6.87.2-microsoft-standard-WSL2\nmount=/mnt/c/\ninterop=1\nshell=/bin/bash\n")
	b.WriteString("bash: cannot set terminal process group\n")
	block := func(mode, claude string) {
		b.WriteString("\n" + probeEnvBegin + mode + "\nclaude=" + claude + "\n" + probeEnvNUL + "\n")
		for _, kv := range env {
			b.WriteString(kv + "\x00")
		}
		b.WriteString("\n" + probeEnvEnd + "\n")
	}
	block("login", loginClaude)
	block("plain", plainClaude)
	return []byte(b.String())
}

func TestParseProbe(t *testing.T) {
	p, err := parseProbe(probeOut("/home/u/.nvm/versions/node/v22.1.0/bin/claude", "", "PATH=/home/u/.nvm/versions/node/v22.1.0/bin:/usr/bin", "MULTI=a\nb", "WSL_INTEROP=/run/WSL/1_interop"))
	if err != nil {
		t.Fatal(err)
	}
	if p.Distro != "Ubuntu" || !p.Interop || p.Shell != "/bin/bash" || p.WSLVersion() != 2 || p.MountRoot() != "/mnt/" {
		t.Fatalf("head %+v", p)
	}
	if p.Claude != "/home/u/.nvm/versions/node/v22.1.0/bin/claude" || p.EnvSource != "login" || len(p.Env) != 3 || p.Env[1] != "MULTI=a\nb" {
		t.Fatalf("block %+v", p)
	}
	// The plain shell's block is used when only it found the CLI.
	p, _ = parseProbe(probeOut("", "/home/u/.local/bin/claude"))
	if p.Claude != "/home/u/.local/bin/claude" || p.EnvSource != "plain" {
		t.Fatalf("plain %+v", p)
	}
	// Not found anywhere: the login environment is still reported.
	p, _ = parseProbe(probeOut("", ""))
	if p.Claude != "" || p.EnvSource != "login" {
		t.Fatalf("none %+v", p)
	}
	// Newline-separated env (no env -0) with a continued value.
	out := probeHeader + "\nmount=/c/\ninterop=0\nkernel=4.4.0-19041-Microsoft\n\n" + probeEnvBegin + "plain\nclaude=/usr/local/bin/claude\n" + probeEnvNL + "\nA=1\nB=two\nlines\n\n" + probeEnvEnd + "\n"
	p, _ = parseProbe([]byte(out))
	if p.Claude != "/usr/local/bin/claude" || len(p.Env) != 2 || p.Env[1] != "B=two\nlines" || p.Interop || p.WSLVersion() != 1 || p.MountRoot() != "/" {
		t.Fatalf("nl %+v root %q", p, p.MountRoot())
	}
	if _, err := parseProbe([]byte("wsl: There is no distribution with the supplied name.\n")); err == nil {
		t.Fatal("no header accepted")
	}
	// An incomplete block (probe cut off) is ignored.
	p, _ = parseProbe([]byte(probeHeader + "\n\n" + probeEnvBegin + "login\nclaude=/x/claude\n" + probeEnvNUL + "\nA=1\x00"))
	if p.Claude != "" {
		t.Fatalf("incomplete block used: %+v", p)
	}
}

func TestCleanProbedEnvAndCLIDir(t *testing.T) {
	env := cleanProbedEnv([]string{"WSL_INTEROP=/run/WSL/8_interop", "PATH=/usr/bin", "PWD=/home/u", "LDAPILOT_MODE=login", "HTTPS_PROXY=http://p:3128", "PATH=/home/u/bin:/usr/bin", "BASH_FUNC_x%%=() {}", "TERM=xterm"})
	if strings.Join(env, "|") != "HTTPS_PROXY=http://p:3128|PATH=/home/u/bin:/usr/bin" {
		t.Fatalf("clean %q", env)
	}
	got := withCLIDir(env, "/home/u/.nvm/versions/node/v22/bin/claude")
	if got[1] != "PATH=/home/u/.nvm/versions/node/v22/bin:/home/u/bin:/usr/bin" || env[1] != "PATH=/home/u/bin:/usr/bin" {
		t.Fatalf("cli dir %q (input changed: %q)", got, env)
	}
	if got := withCLIDir(env, "/home/u/bin/claude"); got[1] != env[1] {
		t.Fatalf("dir already on PATH: %q", got)
	}
	if got := withCLIDir(nil, "/opt/c/claude"); len(got) != 1 || !strings.HasPrefix(got[0], "PATH=/opt/c:") {
		t.Fatalf("no PATH: %q", got)
	}
}

func TestWindowsToWSLPath(t *testing.T) {
	for in, want := range map[string]string{
		`C:\Users\Anna Schmidt\AppData\Roaming\LDAPilot\claude-code-runs\run-1\mcp.json`: "/mnt/c/Users/Anna Schmidt/AppData/Roaming/LDAPilot/claude-code-runs/run-1/mcp.json",
		`d:/Tools/LDAPilot.exe`:      "/mnt/d/Tools/LDAPilot.exe",
		`C:\`:                        "/mnt/c",
		`C:`:                         "/mnt/c",
		`\\?\C:\Program Files\x.exe`: "/mnt/c/Program Files/x.exe",
	} {
		if got, err := WindowsToWSLPath(in, "/mnt/"); err != nil || got != want {
			t.Errorf("%s: %q %v", in, got, err)
		}
	}
	if got, _ := WindowsToWSLPath(`C:\x`, "/"); got != "/c/x" {
		t.Errorf("root /: %q", got)
	}
	for _, bad := range []string{`\\server\share\LDAPilot.exe`, `\\wsl.localhost\Ubuntu\home\u`, `relative\path`, `/home/u/x`} {
		if _, err := WindowsToWSLPath(bad, "/mnt/"); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	if _, err := WindowsToWSLPath(`C:\x`, ""); err == nil {
		t.Error("accepted an unknown mount root")
	}
}

func testWSLCLI() CLI {
	return CLI{Path: "/home/u/.local/bin/claude", WSL: &WSLTarget{Exe: `C:\Windows\System32\wsl.exe`, Distro: "Ubuntu", MountRoot: "/mnt/",
		Env:   []string{"HOME=/home/u", "PATH=/usr/bin:/bin", "HTTPS_PROXY=http://user:secret@proxy:3128", "ANTHROPIC_API_KEY=sk-wsl", "CLAUDECODE=1", "CLAUDE_CODE_ENTRYPOINT=cli", "MCP_TOOL_TIMEOUT=5"},
		Relay: `C:\Program Files\LDAPilot\LDAPilot.exe`}}
}

// envOf decodes the Linux environment a wsl.exe call carries: the
// stand-in variables named in WSLENV, mapped back through the script's
// export lines.
func envOf(t *testing.T, args, hostEnv []string) map[string]string {
	t.Helper()
	host := map[string]string{}
	for _, kv := range hostEnv {
		k, v, _ := strings.Cut(kv, "=")
		host[k] = v
	}
	listed := map[string]bool{}
	for _, n := range strings.Split(host["WSLENV"], ":") {
		listed[n] = true
	}
	out := map[string]string{}
	script := args[len(args)-1]
	for _, line := range strings.Split(script, "; ") {
		var name, stand string
		if _, err := fmtSscanExport(line, &name, &stand); err != nil {
			continue
		}
		if !listed[stand] {
			t.Fatalf("%s not forwarded by WSLENV %q", stand, host["WSLENV"])
		}
		out[name] = host[stand]
	}
	return out
}

func fmtSscanExport(line string, name, stand *string) (int, error) {
	// export NAME="$LDAPILOT_E3" (the "; unset …" is the next part)
	rest, ok := strings.CutPrefix(line, "export ")
	if !ok {
		return 0, errors.New("no export")
	}
	n, v, ok := strings.Cut(rest, `="$`)
	if !ok {
		return 0, errors.New("no value")
	}
	s, _, _ := strings.Cut(v, `"`)
	*name, *stand = n, s
	return 2, nil
}

func TestWSLCommand(t *testing.T) {
	cli := testWSLCLI()
	windows := []string{`SystemRoot=C:\Windows`, `PATH=C:\Windows\system32`, "ANTHROPIC_API_KEY=sk-windows", "WSLENV=USERPROFILE/p", "CLAUDECODE=1", "WSL_UTF8=0"}
	args := []string{"-p", "--tools", "", "--mcp-config", "/mnt/c/Users/Anna Schmidt/run/mcp.json", "--model", "it's"}
	prog, argv, env := cli.command(args, windows, false, true, true)
	if prog != cli.WSL.Exe || len(argv) != 6 || strings.Join(argv[:5], " ") != "-d Ubuntu --exec /bin/sh -c" {
		t.Fatalf("argv %q", argv)
	}
	script := argv[5]
	if strings.Contains(script, "\n") || !strings.Contains(script, `printf 'LDAPILOT_PID=%s\n' "$$" >&2; exec`) ||
		!strings.Contains(script, `exec '/home/u/.local/bin/claude' '-p' '--tools' '' '--mcp-config' '/mnt/c/Users/Anna Schmidt/run/mcp.json' '--model' 'it'\''s'`) {
		t.Fatalf("script %s", script)
	}
	// No value of the environment on the command line.
	for _, secret := range []string{"secret", "sk-wsl", "sk-windows", "/usr/bin:/bin"} {
		if strings.Contains(strings.Join(argv, " "), secret) {
			t.Fatalf("%q on the command line", secret)
		}
	}
	linux := envOf(t, argv, env)
	if linux["PATH"] != "/home/u/.local/bin:/usr/bin:/bin" || linux["HTTPS_PROXY"] != "http://user:secret@proxy:3128" || linux["HOME"] != "/home/u" {
		t.Fatalf("linux env %v", linux)
	}
	if linux["MCP_TOOL_TIMEOUT"] != "900000" || linux["ENABLE_TOOL_SEARCH"] != "false" || linux["MCP_TIMEOUT"] != "60000" {
		t.Fatalf("run settings %v", linux)
	}
	if _, ok := linux["ANTHROPIC_API_KEY"]; ok {
		t.Fatal("ANTHROPIC_API_KEY passed without the setting")
	}
	if _, ok := linux["CLAUDECODE"]; ok {
		t.Fatal("nested-session marker passed")
	}
	host := strings.Join(env, "\n")
	if !strings.Contains(host, "\nWSL_UTF8=1") || strings.Contains(host, "WSL_UTF8=0") || strings.Contains(host, "USERPROFILE/p") ||
		strings.Contains(host, "sk-windows") || strings.Contains(host, "CLAUDECODE") || !strings.Contains(host, `SystemRoot=C:\Windows`) {
		t.Fatalf("host env %q", env)
	}

	// "Use my environment's Anthropic settings": the WSL shell's value.
	_, argv, env = cli.command([]string{"--version"}, windows, true, false, false)
	linux = envOf(t, argv, env)
	if linux["ANTHROPIC_API_KEY"] != "sk-wsl" || strings.Contains(argv[5], "LDAPILOT_PID") || linux["MCP_TOOL_TIMEOUT"] != "5" {
		t.Fatalf("version env %v script %s", linux, argv[5])
	}

	// Native: unchanged behaviour.
	prog, argv, env = CLI{Path: `C:\x\claude.exe`}.command(args, windows, false, true, true)
	if prog != `C:\x\claude.exe` || len(argv) != len(args) || !strings.Contains(strings.Join(env, "|"), "ENABLE_TOOL_SEARCH=false") || strings.Contains(strings.Join(env, "|"), "LDAPILOT_E") {
		t.Fatalf("native %s %q %q", prog, argv, env)
	}
	if (CLI{Path: "/x"}).Key() != "/x" || cli.Key() != "wsl:Ubuntu:/home/u/.local/bin/claude" || !strings.Contains(cli.Describe(), "WSL (Ubuntu)") {
		t.Fatal("key/describe")
	}
}

func TestPIDFilter(t *testing.T) {
	var out strings.Builder
	got := 0
	f := &pidFilter{next: &out, onPID: func(n int) { got = n }}
	for _, chunk := range []string{"wsl: A localhost proxy configuration was detected but not mirrored into WSL.\nLDAPILOT_", "PID=4711\n", "Error: boom\n", "tail without newline"} {
		_, _ = f.Write([]byte(chunk))
	}
	f.Flush()
	if got != 4711 || out.String() != "wsl: A localhost proxy configuration was detected but not mirrored into WSL.\nError: boom\ntail without newline" {
		t.Fatalf("pid %d out %q", got, out.String())
	}
	// Without a marker, a short incomplete line is still passed on.
	out.Reset()
	f = &pidFilter{next: &out}
	_, _ = f.Write([]byte("wsl: error"))
	f.Flush()
	if out.String() != "wsl: error" {
		t.Fatalf("flush %q", out.String())
	}
}

// fakeWSL answers the resolver's wsl.exe calls.
type fakeWSL struct {
	list   []byte            // --list --verbose output
	listQ  []byte            // --list --quiet output
	listOK bool              // exit status 0 for --list
	probes map[string][]byte // distro ("" = default) → probe output
	calls  []string
}

func (f *fakeWSL) run(_ context.Context, prog string, args, env []string, stdin string) ([]byte, []byte, error) {
	if prog != `C:\Windows\System32\wsl.exe` {
		return nil, nil, errors.New("wrong program " + prog)
	}
	hasUTF8 := false
	for _, kv := range env {
		hasUTF8 = hasUTF8 || kv == "WSL_UTF8=1"
	}
	if !hasUTF8 {
		return nil, nil, errors.New("WSL_UTF8 not set")
	}
	f.calls = append(f.calls, strings.Join(args[:min(len(args), 3)], " "))
	switch {
	case len(args) >= 2 && args[0] == "--list" && args[1] == "--verbose":
		if !f.listOK {
			return f.list, nil, errors.New("exit status 1")
		}
		return f.list, nil, nil
	case len(args) >= 2 && args[0] == "--list":
		if !f.listOK {
			return f.listQ, nil, errors.New("exit status 1")
		}
		return f.listQ, nil, nil
	}
	distro := ""
	if args[0] == "-d" {
		distro = args[1]
		args = args[2:]
	}
	if len(args) != 3 || args[0] != "--exec" || args[1] != "/bin/sh" || args[2] != "-s" || !strings.Contains(stdin, probeHeader) {
		return nil, nil, errors.New("unexpected probe call")
	}
	out, ok := f.probes[distro]
	if !ok {
		return nil, utf16le("There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n", false), errors.New("exit status 1")
	}
	return out, nil, nil
}

func testResolver(f *fakeWSL, native func(string) (string, error)) Resolver {
	return Resolver{GOOS: "windows", FindNative: native, WSLExe: `C:\Windows\System32\wsl.exe`, Run: f.run,
		Environ:    func() []string { return []string{`SystemRoot=C:\Windows`} },
		Executable: func() (string, error) { return `C:\Program Files\LDAPilot\LDAPilot.exe`, nil }}
}

func noNative(string) (string, error) {
	return "", errors.New("Claude Code CLI not found (looked on PATH, ~/.local/bin, Homebrew and npm global locations)")
}

func TestResolveAuto(t *testing.T) {
	list := utf16le("  NAME              STATE      VERSION\r\n  docker-desktop    Running    2\r\n  Debian            Stopped    2\r\n* Ubuntu            Running    2\r\n", true)
	f := &fakeWSL{list: list, listOK: true, probes: map[string][]byte{
		"Ubuntu": probeOut("", ""),
		"Debian": probeOut("/home/u/.local/bin/claude", "", "HOME=/home/u", "PATH=/home/u/.local/bin:/usr/bin", "WSL_INTEROP=/run/WSL/1_interop"),
	}}
	// A native CLI wins: WSL is not even listed.
	cli, err := testResolver(f, func(string) (string, error) { return `C:\Users\u\.local\bin\claude.exe`, nil }).Resolve(context.Background(), ResolveOptions{})
	if err != nil || cli.WSL != nil || len(f.calls) != 0 {
		t.Fatalf("native: %+v %v calls %q", cli, err, f.calls)
	}
	// Without one: the default distribution first, then the others; Docker
	// Desktop's is never started.
	cli, err = testResolver(f, noNative).Resolve(context.Background(), ResolveOptions{})
	if err != nil || cli.WSL == nil || cli.WSL.Distro != "Debian" || cli.Path != "/home/u/.local/bin/claude" {
		t.Fatalf("wsl: %+v %v", cli, err)
	}
	if strings.Join(f.calls, ",") != "--list --verbose,-d Ubuntu --exec,-d Debian --exec" {
		t.Fatalf("calls %q", f.calls)
	}
	w := cli.WSL
	if w.MountRoot != "/mnt/" || w.Version != 2 || w.Relay != `C:\Program Files\LDAPilot\LDAPilot.exe` || strings.Join(w.Env, "|") != "HOME=/home/u|PATH=/home/u/.local/bin:/usr/bin" || w.EnvSource != "login" {
		t.Fatalf("target %+v", w)
	}

	// Nothing anywhere: one message naming both places and both installs.
	f = &fakeWSL{list: list, listOK: true, probes: map[string][]byte{"Ubuntu": probeOut("", ""), "Debian": probeOut("", "")}}
	_, err = testResolver(f, noNative).Resolve(context.Background(), ResolveOptions{})
	var nf *NotFoundError
	if !errors.As(err, &nf) || !strings.Contains(err.Error(), "Windows: not found (looked on PATH") || !strings.Contains(err.Error(), "WSL: Ubuntu: no claude") ||
		!strings.Contains(err.Error(), "Debian: no claude") || !strings.Contains(err.Error(), "install.ps1") || !strings.Contains(err.Error(), "install.sh") {
		t.Fatalf("not found: %v", err)
	}
	// WSL not installed: the stub's message (UTF-16) is named.
	f = &fakeWSL{list: utf16le("The Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'.\r\n", false)}
	_, err = testResolver(f, noNative).Resolve(context.Background(), ResolveOptions{})
	if err == nil || !strings.Contains(err.Error(), "WSL: The Windows Subsystem for Linux is not installed") {
		t.Fatalf("no wsl: %v", err)
	}
	// Only Docker Desktop's distributions.
	f = &fakeWSL{list: utf16le("  NAME            STATE    VERSION\r\n* docker-desktop  Running  2\r\n", false), listOK: true}
	_, err = testResolver(f, noNative).Resolve(context.Background(), ResolveOptions{})
	if err == nil || !strings.Contains(err.Error(), "no Linux distribution installed") || len(f.calls) != 1 {
		t.Fatalf("docker only: %v %q", err, f.calls)
	}
	// An explicit native path is native, also in automatic mode.
	f = &fakeWSL{}
	if _, err := testResolver(f, noNative).Resolve(context.Background(), ResolveOptions{Path: `C:\x\claude.exe`}); err == nil || len(f.calls) != 0 {
		t.Fatalf("explicit native path: %v %q", err, f.calls)
	}
}

func TestResolveExplicit(t *testing.T) {
	f := &fakeWSL{probes: map[string][]byte{
		"":       probeOut("/usr/local/bin/claude", ""),
		"Debian": probeOut("/opt/claude/claude", ""),
	}}
	r := testResolver(f, func(string) (string, error) { return `C:\claude.exe`, nil })
	// WSL is chosen: a native CLI does not count; the default distribution
	// is probed without -d and named after the probe.
	cli, err := r.Resolve(context.Background(), ResolveOptions{Runtime: RuntimeWSL})
	if err != nil || cli.WSL == nil || cli.WSL.Distro != "Ubuntu" || f.calls[0] != "--exec /bin/sh -s" {
		t.Fatalf("default: %+v %v %q", cli, err, f.calls)
	}
	cli, err = r.Resolve(context.Background(), ResolveOptions{Runtime: RuntimeWSL, Distro: "Debian", WSLPath: "/opt/claude/claude"})
	if err != nil || cli.Path != "/opt/claude/claude" || f.calls[1] != "-d Debian --exec" {
		t.Fatalf("debian: %+v %v %q", cli, err, f.calls)
	}
	// A distribution that does not exist: wsl.exe's message.
	_, err = r.Resolve(context.Background(), ResolveOptions{Runtime: RuntimeWSL, Distro: "Arch"})
	if err == nil || !strings.Contains(err.Error(), "Arch: There is no distribution with the supplied name.") || strings.Contains(err.Error(), "Error code") {
		t.Fatalf("missing distro: %v", err)
	}
	// Windows chosen: WSL is never asked.
	f.calls = nil
	cli, err = r.Resolve(context.Background(), ResolveOptions{Runtime: RuntimeWindows})
	if err != nil || cli.WSL != nil || len(f.calls) != 0 {
		t.Fatalf("windows: %+v %v", cli, err)
	}
	_, err = testResolver(f, noNative).Resolve(context.Background(), ResolveOptions{Runtime: RuntimeWindows})
	if err == nil || !strings.Contains(err.Error(), "choose WSL") {
		t.Fatalf("windows missing: %v", err)
	}
	// Other systems: always native, whatever the setting says.
	r.GOOS = "linux"
	f.calls = nil
	if cli, err := r.Resolve(context.Background(), ResolveOptions{Runtime: RuntimeWSL}); err != nil || cli.WSL != nil || len(f.calls) != 0 {
		t.Fatalf("linux: %+v %v", cli, err)
	}
}

func TestResolveUnusable(t *testing.T) {
	noInterop := []byte(strings.Replace(string(probeOut("/usr/bin/claude", "")), "interop=1", "interop=0", 1))
	noMount := []byte(strings.Replace(string(probeOut("/usr/bin/claude", "")), "mount=/mnt/c/", "mount=", 1))
	for name, out := range map[string][]byte{"interop": noInterop, "mounted": noMount} {
		f := &fakeWSL{probes: map[string][]byte{"": out}}
		_, err := testResolver(f, noNative).Resolve(context.Background(), ResolveOptions{Runtime: RuntimeWSL})
		if err == nil || !strings.Contains(err.Error(), "cannot be used") || !strings.Contains(err.Error(), name) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// LDAPilot started from a network share: no drvfs path for the relay.
	f := &fakeWSL{probes: map[string][]byte{"": probeOut("/usr/bin/claude", "")}}
	r := testResolver(f, noNative)
	r.Executable = func() (string, error) { return `\\server\apps\LDAPilot.exe`, nil }
	if _, err := r.Resolve(context.Background(), ResolveOptions{Runtime: RuntimeWSL}); err == nil || !strings.Contains(err.Error(), "drive letter") {
		t.Fatalf("unc relay: %v", err)
	}
}

func TestListWSL(t *testing.T) {
	f := &fakeWSL{list: []byte("NAME STATE VERSION\n* Ubuntu Running 2\n"), listOK: true}
	list, err := testResolver(f, noNative).ListWSL(context.Background())
	if err != nil || len(list) != 1 || !list[0].Default {
		t.Fatalf("%+v %v", list, err)
	}
	// Old wsl.exe without --verbose: the quiet list.
	f = &fakeWSL{list: utf16le("Invalid command line option: --verbose\r\n", false), listQ: utf16le("Ubuntu\r\nDebian\r\n", false), listOK: true}
	f.list = nil
	list, err = testResolver(f, noNative).ListWSL(context.Background())
	if err != nil || len(list) != 2 || list[1].Name != "Debian" {
		t.Fatalf("quiet: %+v %v", list, err)
	}
}
