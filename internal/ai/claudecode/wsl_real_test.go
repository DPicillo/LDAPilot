package claudecode

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai/mcpserver"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
)

// TestRealWSL runs the WSL mode against the real wsl.exe on Windows: the
// search, --version, the model list, a run whose tools reach LDAPilot's
// server through the relay (LDAPilot.exe), and Stop. The model does not
// exist, so no model call is billed. Opt-in (Windows only):
//
//	set LDAPILOT_REAL_WSL=1
//	set LDAPILOT_RELAY_EXE=C:\path\to\LDAPilot.exe
//	set LDAPILOT_WSL_DISTRO=Ubuntu   (optional; default distribution)
//	claudecode.test.exe -test.run RealWSL -test.v
func TestRealWSL(t *testing.T) {
	if runtime.GOOS != "windows" || os.Getenv("LDAPILOT_REAL_WSL") != "1" {
		t.Skip("Windows only; set LDAPILOT_REAL_WSL=1 and LDAPILOT_RELAY_EXE")
	}
	relay := os.Getenv("LDAPILOT_RELAY_EXE")
	r := Resolver{Executable: func() (string, error) { return relay, nil }}
	ctx := context.Background()
	if list, err := r.ListWSL(ctx); err != nil {
		t.Fatalf("list: %v", err)
	} else {
		t.Logf("distributions: %+v", list)
	}
	start := time.Now()
	cli, err := r.Resolve(ctx, ResolveOptions{Runtime: RuntimeWSL, Distro: os.Getenv("LDAPILOT_WSL_DISTRO")})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	w := cli.WSL
	t.Logf("found in %v: %s (distro %s, WSL %d, mount %s, env %s, shell %s, %d variables)", time.Since(start), cli.Path, w.Distro, w.Version, w.MountRoot, w.EnvSource, w.Shell, len(w.Env))

	start = time.Now()
	v, err := Version(ctx, cli, nil)
	t.Logf("version %q %v (%v)", v, err, time.Since(start))
	if err != nil {
		t.Fatal(err)
	}
	start = time.Now()
	res, err := DiscoverModels(ctx, DiscoverOptions{CLI: cli, WorkDir: t.TempDir()})
	t.Logf("models %d, err %v (%v)", len(res.Models), err, time.Since(start))

	list := []mcpserver.Tool{{Spec: tools.Spec{Name: "get_entry", Description: "Read one entry.", Parameters: json.RawMessage(`{"type":"object","properties":{"dn":{"type":"string"}}}`)}, Title: "Get entry", ReadOnly: true}}
	srv, err := mcpserver.Start(list, func(context.Context, mcpserver.Call) mcpserver.Result { return mcpserver.Result{Text: `{"ok":true}`} }, mcpserver.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close(time.Second)
	inv, err := BuildInvocation(RunOptions{CLI: cli, WorkDir: t.TempDir(), FilesDir: t.TempDir(), MCPURL: srv.URL(), MCPToken: srv.Token(),
		Tools: []string{"get_entry"}, SystemPrompt: "Test.", Prompt: "Say hi.", Model: "ldapilot-no-such-model"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(inv.Args, " "), srv.Token()) {
		t.Fatal("token on the command line")
	}
	proc, err := ExecLauncher{}.Launch(ctx, inv)
	if err != nil {
		t.Fatal(err)
	}
	rd := NewReader(bufio.NewReader(proc.Stdout()))
	initSeen := false
	for {
		l, err := rd.Next()
		if err != nil {
			t.Logf("stream ended: %v; stderr %q", err, proc.Stderr())
			break
		}
		if l.Init != nil {
			t.Logf("init: tools %v mcp %+v", l.Init.Tools, l.Init.MCPServers)
			for _, s := range l.Init.MCPServers {
				initSeen = initSeen || (s.Name == MCPServerName && s.Status == "connected")
			}
			break
		}
	}
	if !initSeen {
		t.Errorf("LDAPilot's server not connected through the relay; stderr %q", proc.Stderr())
	}
	pid := proc.(*execProcess).pid.Load()
	start = time.Now()
	Stop(proc, 3*time.Second)
	t.Logf("stopped in %v (PID in WSL %d); stderr %q", time.Since(start), pid, proc.Stderr())
	if pid > 0 {
		out, _ := exec.Command(w.Exe, "-d", w.Distro, "--exec", "/bin/sh", "-c", "kill -0 "+strconv.FormatInt(pid, 10)+" 2>/dev/null && echo alive || echo gone").Output()
		if got := strings.TrimSpace(DecodeWSLOutput(out)); got != "gone" {
			t.Errorf("the CLI still runs in WSL after Stop: %q", got)
		}
	}
}
