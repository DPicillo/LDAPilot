//go:build !windows

package claudecode

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func script(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// The prompt arrives on stdin (then EOF), args and env as built.
func TestExecLauncherStdinAndEnv(t *testing.T) {
	p := script(t, `prompt=$(cat)
printf '{"type":"result","subtype":"success","result":"%s|%s|%s"}\n' "$prompt" "$1" "$ENABLE_TOOL_SEARCH"
echo "warn on stderr" >&2
`)
	inv := &Invocation{Path: p, Args: []string{"-p"}, Env: RunEnv(os.Environ(), false), Dir: t.TempDir(), Stdin: "Which accounts are locked?"}
	proc, err := ExecLauncher{}.Launch(context.Background(), inv)
	if err != nil {
		t.Fatal(err)
	}
	l, err := NewReader(proc.Stdout()).Next()
	if err != nil {
		t.Fatal(err)
	}
	if err := proc.Wait(); err != nil {
		t.Fatal(err)
	}
	if l.Result == nil || l.Result.Result != "Which accounts are locked?|-p|false" {
		t.Fatalf("result %+v", l.Result)
	}
	if !strings.Contains(proc.Stderr(), "warn on stderr") {
		t.Fatalf("stderr %q", proc.Stderr())
	}
}

// Stop sends SIGINT first; a CLI that ignores it is killed after the
// grace period, children included.
func TestStopInterruptThenKill(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "got-int")
	p := script(t, `trap 'echo int > `+marker+`; exit 0' INT
echo '{"type":"system","subtype":"init","model":"m"}'
while true; do sleep 0.05; done
`)
	proc, err := ExecLauncher{}.Launch(context.Background(), &Invocation{Path: p, Env: os.Environ(), Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if l, err := NewReader(proc.Stdout()).Next(); err != nil || l.Init == nil {
		t.Fatalf("%v %v", l, err)
	}
	start := time.Now()
	Stop(proc, 2*time.Second)
	if el := time.Since(start); el > 1500*time.Millisecond {
		t.Fatalf("interrupt took %v", el)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("SIGINT not delivered")
	}

	stubborn := script(t, `trap '' INT
echo '{"type":"system","subtype":"init","model":"m"}'
sleep 30 &
wait
`)
	proc, err = ExecLauncher{}.Launch(context.Background(), &Invocation{Path: stubborn, Env: os.Environ(), Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	out := proc.Stdout()
	if l, err := NewReader(out).Next(); err != nil || l.Init == nil {
		t.Fatalf("%v %v", l, err)
	}
	start = time.Now()
	Stop(proc, 200*time.Millisecond)
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("kill took %v", el)
	}
	// The child sleep was killed with the group: stdout reaches EOF.
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, out)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("child process kept stdout open")
	}
}
