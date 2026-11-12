package claudecode

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestParseInitialize2_1_308(t *testing.T) {
	f, err := os.Open("testdata/init-2.1.308.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	res, err := ParseInitialize(f)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, m := range res.Models {
		got = append(got, m.ID+"→"+m.ResolvedModel)
	}
	want := "default→claude-opus-5-5,opus→claude-opus-5-5,sonnet→claude-sonnet-5-5,haiku→claude-haiku-5-5,claude-sonnet-5→claude-sonnet-5,claude-opus-5→claude-opus-5,claude-opus-4-8→claude-opus-4-8"
	if strings.Join(got, ",") != want {
		t.Fatalf("models %s", strings.Join(got, ","))
	}
	if res.Version != "2.1.308" || res.Account == nil || res.Account.SubscriptionType != "Claude Team" {
		t.Fatalf("version %q account %+v", res.Version, res.Account)
	}
	d := res.Models[0]
	if !d.Default || d.DisplayName != "Default (recommended)" || len(d.EffortLevels) != 5 || d.Thinking != "yes" || !d.Remote || d.Tools != "yes" {
		t.Fatalf("default model %+v", d)
	}
	s5 := res.Models[4]
	if !strings.Contains(strings.Join(s5.ThinkingModes, ","), "disabled") {
		t.Fatalf("supportsThinkingOff not mapped: %+v", s5)
	}
}

func TestParseInitialize2_1_285Tolerant(t *testing.T) {
	f, err := os.Open("testdata/init-2.1.285.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	res, err := ParseInitialize(f)
	if err != nil {
		t.Fatal(err)
	}
	// Older key set (no claude_code_version, no haiku alias).
	if len(res.Models) != 6 || res.Version != "" || res.Models[2].ID != "sonnet" {
		t.Fatalf("%+v", res)
	}
}

func TestParseInitializeIgnoresNoise(t *testing.T) {
	in := strings.Join([]string{
		`{"type":"system","subtype":"init","model":"x"}`,
		`not json`,
		`{"type":"control_response","response":{"subtype":"success","request_id":"other","response":{}}}`,
		`{"type":"control_response","response":{"subtype":"success","request_id":"req_init_1","response":{"models":[{"value":"sonnet","displayName":"Sonnet","futureField":{"x":1}},{"displayName":"no value"}],"brandNewTopLevel":true}}}`,
	}, "\n")
	res, err := ParseInitialize(strings.NewReader(in))
	if err != nil || len(res.Models) != 1 || res.Models[0].ID != "sonnet" {
		t.Fatalf("%+v %v", res, err)
	}
	if _, err := ParseInitialize(strings.NewReader(`{"type":"result"}`)); err != ErrNoInitResponse {
		t.Fatal(err)
	}
}

func TestChildEnv(t *testing.T) {
	env := []string{"PATH=/bin", "HOME=/h", "CLAUDECODE=1", "CLAUDE_CODE_ENTRYPOINT=cli", "CLAUDE_CODE_SESSION_ID=x", "CLAUDE_PID=1", "CLAUDE_EFFORT=high",
		"ANTHROPIC_API_KEY=k", "HTTPS_PROXY=http://p", "CLAUDE_CONFIG_DIR=/c"}
	got := strings.Join(ChildEnv(env, false), ";")
	if got != "PATH=/bin;HOME=/h;HTTPS_PROXY=http://p;CLAUDE_CONFIG_DIR=/c" {
		t.Fatal(got)
	}
	if !strings.Contains(strings.Join(ChildEnv(env, true), ";"), "ANTHROPIC_API_KEY=k") {
		t.Fatal("ANTHROPIC_* not kept on opt-in")
	}
	// Login and backend variables of a headless setup follow the opt-in;
	// the Git Bash path always passes; nested-session markers never do.
	env = []string{"CLAUDE_CODE_OAUTH_TOKEN=t", "CLAUDE_CODE_USE_BEDROCK=1", "CLAUDE_CODE_USE_VERTEX=1", "CLAUDE_CODE_GIT_BASH_PATH=C:\\bash.exe",
		"CLAUDE_CODE_ENTRYPOINT=cli", "CLAUDE_CODE_CHILD_SESSION=1", "AWS_REGION=us-east-1"}
	if got := strings.Join(ChildEnv(env, false), ";"); got != "CLAUDE_CODE_GIT_BASH_PATH=C:\\bash.exe;AWS_REGION=us-east-1" {
		t.Fatal(got)
	}
	if got := strings.Join(ChildEnv(env, true), ";"); got != "CLAUDE_CODE_OAUTH_TOKEN=t;CLAUDE_CODE_USE_BEDROCK=1;CLAUDE_CODE_USE_VERTEX=1;CLAUDE_CODE_GIT_BASH_PATH=C:\\bash.exe;AWS_REGION=us-east-1" {
		t.Fatal(got)
	}
	if got := strings.Join(RunEnv([]string{"CLAUDE_CODE_USE_BEDROCK=1"}, true), ";"); !strings.Contains(got, "CLAUDE_CODE_USE_BEDROCK=1") {
		t.Fatal(got)
	}
}

// fakeCLI writes a shell script that answers the initialize request from a
// fixture after checking its arguments and environment.
func fakeCLI(t *testing.T, script string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell script fake CLI")
	}
	p := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestDiscoverModelsWithFakeCLI(t *testing.T) {
	fixture, _ := filepath.Abs("testdata/init-2.1.308.jsonl")
	cli := fakeCLI(t, `
case "$*" in
  *"--restricted"*) ;;
  *) echo "missing --restricted" >&2; exit 3 ;;
esac
[ -n "$CLAUDECODE" ] && { echo "nested env leaked" >&2; exit 4; }
read line
case "$line" in
  *'"subtype":"initialize"'*) cat '`+fixture+`' ;;
  *) echo "bad request" >&2; exit 5 ;;
esac
sleep 30
`)
	t.Setenv("CLAUDECODE", "1")
	start := time.Now()
	res, err := DiscoverModels(context.Background(), DiscoverOptions{CLI: CLI{Path: cli}, WorkDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Models) != 7 || time.Since(start) > 5*time.Second {
		t.Fatalf("models %d in %v", len(res.Models), time.Since(start))
	}
}

func TestDiscoverModelsFallback(t *testing.T) {
	cli := fakeCLI(t, "echo 'boom: not logged in' >&2; exit 1\n")
	res, err := DiscoverModels(context.Background(), DiscoverOptions{CLI: CLI{Path: cli}})
	if err == nil || !strings.Contains(err.Error(), "not logged in") {
		t.Fatalf("err %v", err)
	}
	var ids []string
	for _, m := range res.Models {
		ids = append(ids, m.ID)
	}
	if strings.Join(ids, ",") != "default,opus,sonnet,haiku" {
		t.Fatal(ids)
	}
	slow := fakeCLI(t, "sleep 30\n")
	start := time.Now()
	_, err = DiscoverModels(context.Background(), DiscoverOptions{CLI: CLI{Path: slow}, Timeout: 300 * time.Millisecond})
	if err == nil || time.Since(start) > 5*time.Second {
		t.Fatalf("timeout err %v after %v", err, time.Since(start))
	}
}

func TestVersionAndFind(t *testing.T) {
	cli := fakeCLI(t, `echo "2.1.308 (Claude Code)"`+"\n")
	v, err := Version(context.Background(), CLI{Path: cli}, nil)
	if err != nil || v != "2.1.308" {
		t.Fatalf("%q %v", v, err)
	}
	if p, err := FindCLI(cli); err != nil || p != cli {
		t.Fatal(err)
	}
	if _, err := FindCLI(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("missing CLI accepted")
	}
}
