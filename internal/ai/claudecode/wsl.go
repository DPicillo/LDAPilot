package claudecode

// WSL mode (Windows): Claude Code installed only inside a WSL distribution.
// LDAPilot starts every call through wsl.exe:
//
//	wsl.exe -d <distro> --exec /bin/sh -c <script>
//
// Only the script crosses the Windows command line (wsl.exe's own argument
// parsing never sees the empty `--tools ""` argument); it is one line (no
// line breaks for wsl.exe to pass on) and holds paths, flags and variable
// names, never a value of the environment, the token or the prompt. The
// longer probe script goes to `/bin/sh -s` on stdin instead. Environment values travel through WSLENV under stand-in names
// (LDAPILOT_E<n>) that the script exports under their real names, so they
// collide with nothing wsl.exe itself needs (PATH) and never appear on a
// command line. The environment is the one of the user's login shell in that
// distribution (probed once, see ProbeScript), which is where nvm,
// npm-global and ~/.local/bin put `claude` on the PATH.
//
// The tool server stays on the Windows loopback: in WSL, Claude Code gets a
// stdio MCP server whose command is LDAPilot.exe itself in relay mode
// (internal/ai/mcprelay), started through the WSL interop. The relay is a
// Windows process, so it reaches 127.0.0.1 with NAT, mirrored networking and
// WSL 1 alike; nothing listens on another interface.
//
// The logic here is string work and runs (and is tested) on every platform;
// only Windows ever executes it.

import (
	"bytes"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

// WSL timeouts: the first command in a stopped distribution (or after
// Windows started) boots the WSL VM, which can take far longer than the
// native CLI needs.
const (
	// WSLProbeTimeout bounds the probe (cold start + login shell).
	WSLProbeTimeout = 2 * time.Minute
	// WSLCommandTimeout bounds `claude --version` and the initialize
	// request in WSL.
	WSLCommandTimeout = 60 * time.Second
	// wslListTimeout bounds `wsl.exe --list` (no distribution is started).
	wslListTimeout = 20 * time.Second
	// wslSignalTimeout bounds the `kill` sent into the distribution on Stop.
	wslSignalTimeout = 10 * time.Second
	// wslMCPStartupMs is MCP_TIMEOUT in WSL: starting the relay (a Windows
	// process through the interop) may take a few seconds on a cold system.
	wslMCPStartupMs = 60000
)

// WSLDistro is one installed WSL distribution (`wsl.exe --list --verbose`).
type WSLDistro struct {
	Name    string `json:"name"`
	Default bool   `json:"default,omitempty"`
	// State is the state as wsl.exe reports it (localized: "Running",
	// "Stopped", "Wird ausgeführt", …); for display only.
	State   string `json:"state,omitempty"`
	Version int    `json:"version,omitempty"` // WSL 1 or 2; 0 = unknown
}

// wslDistroNameRe is what LDAPilot accepts as a distribution name (WSL
// allows letters, digits, '.', '-' and '_').
var wslDistroNameRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// ValidWSLDistroName reports whether name can be passed to wsl.exe -d.
func ValidWSLDistroName(name string) bool { return wslDistroNameRe.MatchString(name) }

// IsHelperDistro reports the internal distributions of Docker Desktop and
// Rancher Desktop, which cannot run Claude Code and are never probed.
func IsHelperDistro(name string) bool {
	switch strings.ToLower(name) {
	case "docker-desktop", "docker-desktop-data", "rancher-desktop", "rancher-desktop-data":
		return true
	}
	return false
}

// DecodeWSLOutput decodes what wsl.exe writes about itself: UTF-16LE in
// older versions or without WSL_UTF8=1 (with or without BOM), else UTF-8.
// NULs and carriage returns are removed.
func DecodeWSLOutput(b []byte) string {
	if len(b) >= 2 && b[0] == 0xFF && b[1] == 0xFE {
		return cleanWSLText(decodeUTF16LE(b[2:]))
	}
	if looksUTF16LE(b) {
		return cleanWSLText(decodeUTF16LE(b))
	}
	return cleanWSLText(string(b))
}

// looksUTF16LE: ASCII text in UTF-16LE has a zero in (nearly) every odd
// byte; UTF-8 text has none.
func looksUTF16LE(b []byte) bool {
	if len(b) < 2 {
		return false
	}
	zeros, pairs := 0, len(b)/2
	for i := 1; i < len(b); i += 2 {
		if b[i] == 0 {
			zeros++
		}
	}
	return zeros*2 > pairs
}

func decodeUTF16LE(b []byte) string {
	u := make([]uint16, 0, len(b)/2)
	for i := 0; i+1 < len(b); i += 2 {
		u = append(u, uint16(b[i])|uint16(b[i+1])<<8)
	}
	return string(utf16.Decode(u))
}

func cleanWSLText(s string) string {
	s = strings.ReplaceAll(s, "\x00", "")
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	return strings.TrimPrefix(s, "\uFEFF")
}

// ParseWSLList parses `wsl.exe --list --verbose` (verbose: header line,
// "*" before the default, NAME STATE VERSION columns; the header and the
// state are localized) or `wsl.exe --list --quiet` (one name per line).
// Lines that do not name a valid distribution are skipped.
func ParseWSLList(out string, verbose bool) []WSLDistro {
	var res []WSLDistro
	header := verbose
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if header {
			header = false
			continue
		}
		f := strings.Fields(line)
		d := WSLDistro{}
		if len(f) > 0 && f[0] == "*" {
			d.Default = true
			f = f[1:]
		} else if len(f) > 0 && strings.HasPrefix(f[0], "*") {
			d.Default = true
			f[0] = strings.TrimPrefix(f[0], "*")
		}
		if len(f) == 0 || !ValidWSLDistroName(f[0]) {
			continue
		}
		d.Name = f[0]
		if verbose {
			// NAME STATE… VERSION; anything else is a message line.
			v, err := strconv.Atoi(f[len(f)-1])
			if len(f) < 3 || err != nil || (v != 1 && v != 2) {
				continue
			}
			d.Version = v
			d.State = strings.Join(f[1:len(f)-1], " ")
		} else if len(f) != 1 {
			continue // a message, not a name
		}
		res = append(res, d)
	}
	return res
}

// wslListError turns a failed `wsl.exe --list` into the message shown in
// the settings ("WSL is not installed", "no distribution installed", …):
// the text wsl.exe printed, without its "Error code:" lines.
func wslListError(out string, err error) error {
	var lines []string
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(strings.ToLower(l), "error code:") || strings.HasPrefix(strings.ToLower(l), "fehlercode:") {
			continue
		}
		lines = append(lines, l)
	}
	if len(lines) > 0 {
		return errors.New(truncate(strings.Join(lines, " "), 300))
	}
	if err != nil {
		return err
	}
	return errors.New("wsl.exe listed no distribution")
}

// --- probe -----------------------------------------------------------------

// Probe markers (stdout of the probe script).
const (
	probeHeader   = "LDAPILOT-PROBE 1"
	probeEnvBegin = "LDAPILOT-ENV-BEGIN "
	probeEnvNUL   = "LDAPILOT-ENV0"
	probeEnvNL    = "LDAPILOT-ENVNL"
	probeEnvEnd   = "LDAPILOT-ENV-END"
)

// probeInner runs in /bin/sh started by the login shell, so it sees the
// login shell's exported environment: it reports where `claude` is (PATH,
// then the usual install locations) and that environment. It holds no
// single quote (it is single-quoted in the outer script).
const probeInner = `want="$LDAPILOT_WANT"; c=""
if [ -n "$want" ]; then
  [ -x "$want" ] && c="$want"
else
  c=$(command -v claude 2>/dev/null) || c=""
  case "$c" in /*) ;; *) c="" ;; esac
  if [ -z "$c" ]; then
    for f in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" "$HOME/.npm-global/bin/claude" "$HOME/.volta/bin/claude" "$HOME/.bun/bin/claude" /usr/local/bin/claude /usr/bin/claude /home/linuxbrew/.linuxbrew/bin/claude "$HOME"/.nvm/versions/node/*/bin/claude; do
      [ -x "$f" ] && c="$f"
      [ -n "$c" ] && [ "${f#"$HOME"/.nvm/}" = "$f" ] && break
    done
  fi
fi
printf "\n%s%s\n" "` + probeEnvBegin + `" "$LDAPILOT_MODE"
printf "claude=%s\n" "$c"
if env -0 >/dev/null 2>&1; then printf "%s\n" "` + probeEnvNUL + `"; env -0; else printf "%s\n" "` + probeEnvNL + `"; env; fi
printf "\n%s\n" "` + probeEnvEnd + `"
`

// ProbeScript returns the /bin/sh script (run as `sh -s`, read from stdin)
// that inspects a distribution:
// its name, kernel (WSL 1 or 2), the drvfs mount of C:, whether the
// Windows interop works, the login shell, and — once from the interactive
// login shell (nvm and friends live in ~/.bashrc), once from a plain shell
// as a fallback — where `claude` is and the environment. want is an
// explicit Linux path of the CLI ("" = look for it).
func ProbeScript(want string) string {
	var b strings.Builder
	b.WriteString("export LDAPILOT_WANT=" + shellQuote(want) + "\n")
	b.WriteString("export LDAPILOT_INNER=" + shellQuote(probeInner) + "\n")
	b.WriteString(`printf "%s\n" "` + probeHeader + `"
printf "distro=%s\n" "$WSL_DISTRO_NAME"
printf "kernel=%s\n" "$(uname -r 2>/dev/null)"
printf "mount=%s\n" "$(wslpath -u "C:\\" 2>/dev/null)"
if [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop-late ]; then printf "interop=1\n"; else printf "interop=0\n"; fi
u=$(id -un 2>/dev/null); s=$(getent passwd "$u" 2>/dev/null | cut -d: -f7)
[ -n "$s" ] && [ -x "$s" ] || s=/bin/sh
printf "shell=%s\n" "$s"
t=""; command -v timeout >/dev/null 2>&1 && t="timeout 30"
case "${s##*/}" in
  bash|zsh|ksh|mksh|fish) LDAPILOT_MODE=login $t "$s" -i -l -c 'exec /bin/sh -c "$LDAPILOT_INNER"' </dev/null 2>/dev/null ;;
  *) LDAPILOT_MODE=login $t "$s" -l -c 'exec /bin/sh -c "$LDAPILOT_INNER"' </dev/null 2>/dev/null ;;
esac
LDAPILOT_MODE=plain /bin/sh -c "$LDAPILOT_INNER" </dev/null 2>/dev/null
exit 0
`)
	return b.String()
}

// wslProbe is the parsed probe output.
type wslProbe struct {
	Distro    string
	Kernel    string
	Mount     string // drvfs path of C:\ ("/mnt/c/"); "" when wslpath failed
	Interop   bool
	Shell     string
	Claude    string   // absolute Linux path; "" = not found
	Env       []string // NAME=value of the shell the path came from
	EnvSource string   // "login" (interactive login shell) or "plain"
}

// WSLVersion derives WSL 1 or 2 from the kernel release ("…-microsoft-
// standard-WSL2" vs "4.4.0-19041-Microsoft"); 0 = unknown.
func (p *wslProbe) WSLVersion() int {
	k := strings.ToLower(p.Kernel)
	switch {
	case strings.Contains(k, "wsl2") || strings.Contains(k, "microsoft-standard"):
		return 2
	case strings.Contains(k, "microsoft"):
		return 1
	}
	return 0
}

// MountRoot is the drvfs automount root ("/mnt/") derived from the path of
// C:\; "" when unknown.
func (p *wslProbe) MountRoot() string {
	m := strings.TrimRight(p.Mount, "/")
	if strings.HasSuffix(strings.ToLower(m), "/c") {
		return m[:len(m)-1]
	}
	return ""
}

// errProbeOutput is returned when the probe printed no header (the
// distribution did not start, /bin/sh is missing, …).
var errProbeOutput = errors.New("the distribution did not run LDAPilot's check")

// parseProbe reads the probe output. The login shell's block wins when it
// is complete and found the CLI (or no block found it); stray output of
// rc files around the markers is ignored.
func parseProbe(out []byte) (*wslProbe, error) {
	s := string(out)
	i := strings.Index(s, probeHeader+"\n")
	if i < 0 {
		return nil, errProbeOutput
	}
	s = s[i+len(probeHeader)+1:]
	p := &wslProbe{}
	head := s
	if j := strings.Index(s, "\n"+probeEnvBegin); j >= 0 {
		head = s[:j]
	}
	for _, line := range strings.Split(head, "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch k {
		case "distro":
			p.Distro = v
		case "kernel":
			p.Kernel = v
		case "mount":
			p.Mount = v
		case "interop":
			p.Interop = v == "1"
		case "shell":
			p.Shell = v
		}
	}
	blocks := probeBlocks(s)
	var pick *probeBlock
	for i := range blocks {
		b := &blocks[i]
		if pick == nil || (pick.claude == "" && b.claude != "") {
			pick = b
		}
	}
	if pick != nil {
		p.Claude, p.Env, p.EnvSource = pick.claude, pick.env, pick.mode
	}
	return p, nil
}

type probeBlock struct {
	mode   string
	claude string
	env    []string
}

// probeBlocks returns the complete environment blocks in output order.
func probeBlocks(s string) []probeBlock {
	var res []probeBlock
	for {
		i := strings.Index(s, "\n"+probeEnvBegin)
		if i < 0 {
			return res
		}
		s = s[i+1+len(probeEnvBegin):]
		end := strings.Index(s, "\n"+probeEnvEnd)
		if end < 0 {
			return res
		}
		body := s[:end]
		s = s[end+1:]
		mode, rest, _ := strings.Cut(body, "\n")
		b := probeBlock{mode: strings.TrimSpace(mode)}
		claudeLine, rest, _ := strings.Cut(rest, "\n")
		if v, ok := strings.CutPrefix(claudeLine, "claude="); ok && strings.HasPrefix(v, "/") {
			b.claude = v
		}
		kind, envText, _ := strings.Cut(rest, "\n")
		switch kind {
		case probeEnvNUL:
			for _, kv := range strings.Split(envText, "\x00") {
				if kv = strings.TrimPrefix(kv, "\n"); isEnvEntry(kv) {
					b.env = append(b.env, kv)
				}
			}
		case probeEnvNL:
			for _, kv := range strings.Split(envText, "\n") {
				if isEnvEntry(kv) {
					b.env = append(b.env, kv)
				} else if n := len(b.env); n > 0 && kv != "" {
					b.env[n-1] += "\n" + kv // a value with a line break
				}
			}
		}
		res = append(res, b)
	}
}

var envNameRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func isEnvEntry(kv string) bool {
	k, _, ok := strings.Cut(kv, "=")
	return ok && envNameRe.MatchString(k)
}

// wslEnvDeny are variables of the probed shell that describe that shell
// session or the probe, not the user's setup: never replayed into a run.
var wslEnvDeny = map[string]bool{
	"WSL_INTEROP": true, // the interop socket of that wsl.exe instance
	"WSLENV":      true,
	"PWD":         true, "OLDPWD": true, "SHLVL": true, "_": true,
	"TERM": true, "COLORTERM": true, "LS_COLORS": true, "LSCOLORS": true,
	"PS1": true, "PS2": true, "PS4": true, "PROMPT_COMMAND": true,
	"TMUX": true, "TMUX_PANE": true, "STY": true,
	"SSH_AUTH_SOCK": true, "SSH_AGENT_PID": true, "SSH_CONNECTION": true, "SSH_CLIENT": true, "SSH_TTY": true,
}

// cleanProbedEnv drops session and probe variables (wslEnvDeny,
// LDAPILOT_*), keeps one entry per name (the last) and sorts by name.
func cleanProbedEnv(env []string) []string {
	byName := map[string]string{}
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		if wslEnvDeny[k] || strings.HasPrefix(k, "LDAPILOT_") || strings.HasPrefix(k, "BASH_FUNC_") {
			continue
		}
		byName[k] = kv
	}
	out := make([]string, 0, len(byName))
	for _, kv := range byName {
		out = append(out, kv)
	}
	sort.Strings(out)
	return out
}

// withCLIDir puts the directory of the CLI first on PATH when it is not on
// it yet (a CLI found in a fallback location, e.g. under ~/.nvm, needs the
// `node` next to it).
func withCLIDir(env []string, cliPath string) []string {
	dir := cliPath
	if i := strings.LastIndex(dir, "/"); i > 0 {
		dir = dir[:i]
	} else {
		return env
	}
	out := append([]string(nil), env...)
	for i, kv := range out {
		if v, ok := strings.CutPrefix(kv, "PATH="); ok {
			for _, p := range strings.Split(v, ":") {
				if p == dir {
					return out
				}
			}
			out[i] = "PATH=" + dir + ":" + v
			return out
		}
	}
	return append(out, "PATH="+dir+":/usr/local/bin:/usr/bin:/bin")
}

// --- paths -------------------------------------------------------------------

var winDrivePathRe = regexp.MustCompile(`^([A-Za-z]):(?:[\\/](.*))?$`)

// WindowsToWSLPath maps a Windows path on a drive letter to its drvfs path
// below mountRoot ("/mnt/"): C:\Users\a b\x → /mnt/c/Users/a b/x. UNC
// paths (\\server\share, \\wsl.localhost\…) are refused: they have no
// drvfs mount.
func WindowsToWSLPath(p, mountRoot string) (string, error) {
	if mountRoot == "" {
		return "", errors.New("the drive mount point in WSL is unknown (is automount disabled in /etc/wsl.conf?)")
	}
	p = strings.TrimPrefix(p, `\\?\`)
	m := winDrivePathRe.FindStringSubmatch(p)
	if m == nil {
		return "", fmt.Errorf("%s is not on a drive letter that WSL mounts", p)
	}
	root := strings.TrimRight(mountRoot, "/") + "/"
	rest := strings.ReplaceAll(m[2], `\`, "/")
	rest = strings.TrimRight(rest, "/")
	out := root + strings.ToLower(m[1])
	if rest != "" {
		out += "/" + rest
	}
	return out, nil
}

// --- commands ----------------------------------------------------------------

// shellQuote quotes s for POSIX sh: single quotes, an embedded quote is
// closed, escaped and reopened.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// wslEnvPrefix names the stand-in variables that carry environment values
// through WSLENV.
const wslEnvPrefix = "LDAPILOT_E"

// wslEnvScript encodes linuxEnv for one wsl.exe call: the stand-in
// variables for the Windows environment of wsl.exe, their WSLENV list, and
// the script lines that export them under their real names. Entries with
// a name that is no shell identifier are dropped.
func wslEnvScript(linuxEnv []string) (vars []string, wslenv string, script string) {
	var names []string
	var b strings.Builder
	n := 0
	for _, kv := range linuxEnv {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || !envNameRe.MatchString(k) || strings.HasPrefix(k, wslEnvPrefix) {
			continue
		}
		stand := wslEnvPrefix + strconv.Itoa(n)
		n++
		vars = append(vars, stand+"="+v)
		names = append(names, stand)
		fmt.Fprintf(&b, "export %s=\"$%s\"; unset %s; ", k, stand, stand)
	}
	b.WriteString("unset WSLENV; ")
	return vars, strings.Join(names, ":"), b.String()
}

// wslHostEnv is the Windows environment of wsl.exe: the caller's
// environment without what the CLI must not see (ChildEnv: Claude Code
// session markers, ANTHROPIC_*), without an inherited WSLENV/WSL_UTF8, plus
// WSL_UTF8=1 (wsl.exe's own messages in UTF-8) and the stand-in variables.
func wslHostEnv(windowsEnv, vars []string, wslenv string) []string {
	base := ChildEnv(windowsEnv, false)
	out := make([]string, 0, len(base)+len(vars)+2)
	for _, kv := range base {
		k, _, _ := strings.Cut(kv, "=")
		switch uk := strings.ToUpper(k); {
		case uk == "WSLENV", uk == "WSL_UTF8", strings.HasPrefix(uk, wslEnvPrefix):
			continue
		}
		out = append(out, kv)
	}
	out = append(out, "WSL_UTF8=1")
	out = append(out, vars...)
	if wslenv != "" {
		out = append(out, "WSLENV="+wslenv)
	}
	return out
}

// wslArgs are the wsl.exe arguments that run script with /bin/sh in distro.
func wslArgs(distro, script string) []string {
	return []string{"-d", distro, "--exec", "/bin/sh", "-c", script}
}

// pidMarker is the stderr line the run script writes before it execs the
// CLI ($$ is then the CLI's PID inside the distribution).
const pidMarker = "LDAPILOT_PID="

// wslExecScript is the one-line script that exports linuxEnv (through the
// stand-in variables) and execs the CLI with args; with markPID it first
// reports its PID on stderr.
func wslExecScript(envScript, cli string, args []string, markPID bool) string {
	var b strings.Builder
	b.WriteString(envScript)
	if markPID {
		b.WriteString(`printf '` + pidMarker + `%s\n' "$$" >&2; `)
	}
	b.WriteString("exec " + shellQuote(cli))
	for _, a := range args {
		b.WriteString(" " + shellQuote(strings.ReplaceAll(a, "\n", " ")))
	}
	return b.String()
}

// pidFilter is the stderr writer of a WSL run: it records the PID the run
// script reports and keeps the line out of the stored stderr (which ends
// up in error messages).
type pidFilter struct {
	next    interface{ Write([]byte) (int, error) }
	partial []byte
	pid     int
	scanned int
	onPID   func(int)
}

func (f *pidFilter) Write(p []byte) (int, error) {
	if f.pid != 0 || f.scanned > 64<<10 {
		return f.next.Write(p)
	}
	f.scanned += len(p)
	data := append(f.partial, p...)
	f.partial = nil
	for len(data) > 0 {
		i := bytes.IndexByte(data, '\n')
		if i < 0 {
			if f.pid == 0 && len(data) < 256 {
				f.partial = append([]byte(nil), data...)
				return len(p), nil
			}
			_, _ = f.next.Write(data)
			break
		}
		line := data[:i+1]
		data = data[i+1:]
		if f.pid == 0 {
			if v, ok := bytes.CutPrefix(bytes.TrimRight(line, "\r\n"), []byte(pidMarker)); ok {
				if n, err := strconv.Atoi(string(v)); err == nil && n > 0 {
					f.pid = n
					if f.onPID != nil {
						f.onPID(n)
					}
					continue
				}
			}
		}
		_, _ = f.next.Write(line)
	}
	return len(p), nil
}

// Flush passes on a held incomplete line (called after the process exited).
func (f *pidFilter) Flush() {
	if len(f.partial) > 0 {
		_, _ = f.next.Write(f.partial)
		f.partial = nil
	}
}
