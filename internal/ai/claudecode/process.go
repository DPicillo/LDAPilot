package claudecode

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Process is a running `claude -p` (or a test fake).
type Process interface {
	// Stdout is the stream-json output; it ends at EOF when the CLI exits.
	Stdout() io.Reader
	// Interrupt asks the CLI to stop (SIGINT to its process group; on
	// Windows it kills, there is no console signal for a hidden child).
	Interrupt() error
	// Kill stops it at once (process group).
	Kill() error
	// Wait waits for the exit.
	Wait() error
	// Stderr returns the first 8 KB the CLI wrote to stderr.
	Stderr() string
}

// Launcher starts runs (tests inject an in-process fake).
type Launcher interface {
	Launch(ctx context.Context, inv *Invocation) (Process, error)
}

// ExecLauncher starts the real CLI.
type ExecLauncher struct{}

// Launch starts the CLI with the prompt on stdin (closed after writing, so
// the CLI never waits for more input).
func (ExecLauncher) Launch(ctx context.Context, inv *Invocation) (Process, error) {
	cmd := exec.Command(inv.Path, inv.Args...)
	cmd.Dir = inv.Dir
	cmd.Env = inv.Env
	prepareProcess(cmd)
	cmd.Cancel = nil
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	p := &execProcess{cmd: cmd, stdout: stdout, done: make(chan struct{})}
	cmd.Stderr = &p.stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("cannot start %s: %w", inv.Path, err)
	}
	go func() {
		_, _ = io.Copy(stdin, strings.NewReader(inv.Stdin))
		_ = stdin.Close()
	}()
	go func() {
		p.waitErr = cmd.Wait()
		close(p.done)
	}()
	return p, nil
}

type execProcess struct {
	cmd     *exec.Cmd
	stdout  io.Reader
	stderr  lockedBuffer
	done    chan struct{}
	waitErr error
}

func (p *execProcess) Stdout() io.Reader { return p.stdout }
func (p *execProcess) Interrupt() error  { return interruptProcess(p.cmd) }
func (p *execProcess) Kill() error       { return killProcess(p.cmd) }
func (p *execProcess) Stderr() string    { return p.stderr.String() }

func (p *execProcess) Wait() error {
	<-p.done
	return p.waitErr
}

// lockedBuffer is a limitedBuffer safe for concurrent use.
type lockedBuffer struct {
	mu sync.Mutex
	b  limitedBuffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// Stop interrupts p and kills it if it has not exited after grace. It
// returns when the process has exited (or after grace+1 s at most).
func Stop(p Process, grace time.Duration) {
	exited := make(chan struct{})
	go func() {
		_ = p.Wait()
		close(exited)
	}()
	_ = p.Interrupt()
	t := time.NewTimer(grace)
	defer t.Stop()
	select {
	case <-exited:
		return
	case <-t.C:
	}
	_ = p.Kill()
	select {
	case <-exited:
	case <-time.After(time.Second):
	}
}
