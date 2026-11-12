package mcprelay_test

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai/claudecode"
	"github.com/dpicillo/LDAPilot/internal/ai/mcprelay"
	"github.com/dpicillo/LDAPilot/internal/ai/mcpserver"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
)

// The test binary doubles as the relay executable (as LDAPilot.exe does).
func TestMain(m *testing.M) {
	if len(os.Args) >= 2 && os.Args[1] == mcprelay.Flag {
		os.Exit(mcprelay.Main(os.Args[2:]))
	}
	os.Exit(m.Run())
}

// TestRelayWithRealClaudeCode runs the installed Claude Code CLI with the
// MCP config of a WSL run (stdio server = this binary in relay mode) and
// checks that it connects through the relay and lists LDAPilot's tools.
// The model does not exist, so no model call is billed. Opt-in:
//
//	LDAPILOT_REAL_CLAUDE=1 go test ./internal/ai/mcprelay -run RealClaude -v
func TestRelayWithRealClaudeCode(t *testing.T) {
	if os.Getenv("LDAPILOT_REAL_CLAUDE") != "1" {
		t.Skip("set LDAPILOT_REAL_CLAUDE=1 to run against the installed Claude Code CLI")
	}
	path, err := claudecode.FindCLI("")
	if err != nil {
		t.Skip(err)
	}
	list := []mcpserver.Tool{
		{Spec: tools.Spec{Name: "get_entry", Description: "Read one entry.", Parameters: json.RawMessage(`{"type":"object","properties":{"dn":{"type":"string"}},"required":["dn"]}`)}, Title: "Get entry", ReadOnly: true},
		{Spec: tools.Spec{Name: "modify_entry", Description: "Change an entry.", Parameters: json.RawMessage(`{"type":"object","properties":{"dn":{"type":"string"}}}`)}, Title: "Modify entry"},
	}
	srv, err := mcpserver.Start(list, func(ctx context.Context, c mcpserver.Call) mcpserver.Result {
		return mcpserver.Result{Text: `{"ok":true}`}
	}, mcpserver.Options{Instructions: "LDAP tools"})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close(time.Second)
	dir := t.TempDir()
	relayFile := filepath.Join(dir, "relay.json")
	rc, _ := json.Marshal(mcprelay.Config{URL: srv.URL(), Token: srv.Token()})
	if err := os.WriteFile(relayFile, rc, 0o600); err != nil {
		t.Fatal(err)
	}
	self, _ := filepath.Abs(os.Args[0])
	cfg, err := claudecode.RelayMCPConfigJSON(self, relayFile)
	if err != nil {
		t.Fatal(err)
	}
	mcpFile := filepath.Join(dir, "mcp.json")
	if err := os.WriteFile(mcpFile, cfg, 0o600); err != nil {
		t.Fatal(err)
	}
	opts := claudecode.RunOptions{Tools: []string{"get_entry", "modify_entry"}, Model: "ldapilot-no-such-model"}
	args := claudecode.BuildArgs(opts, mcpFile, "")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = claudecode.RunEnv(os.Environ(), false)
	cmd.Dir = t.TempDir()
	cmd.Stdin = strings.NewReader("Say hi.")
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	rd := claudecode.NewReader(bufio.NewReader(out))
	for {
		l, err := rd.Next()
		if err != nil {
			t.Fatalf("no init line: %v (stderr %q)", err, stderr.String())
		}
		if l.Init == nil {
			continue
		}
		t.Logf("init: tools %v mcp %+v", l.Init.Tools, l.Init.MCPServers)
		connected := false
		for _, s := range l.Init.MCPServers {
			connected = connected || (s.Name == claudecode.MCPServerName && s.Status == "connected")
		}
		tools := strings.Join(l.Init.Tools, ",")
		if !connected || !strings.Contains(tools, claudecode.ToolPrefix+"get_entry") || !strings.Contains(tools, claudecode.ToolPrefix+"modify_entry") {
			t.Fatalf("relay server not connected: %+v", l.Init)
		}
		for _, tool := range l.Init.Tools {
			if !strings.HasPrefix(tool, claudecode.ToolPrefix) {
				t.Errorf("tool outside LDAPilot's server offered: %s", tool)
			}
		}
		return
	}
}
