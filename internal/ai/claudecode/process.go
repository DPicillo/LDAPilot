package claudecode

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Process is a running `claude -p` (or a test fake).
type Process interface {
	// Stdout is the stream-json output; it ends at EOF when the CLI exits.
	Stdout() io.Reader
	// Interrupt asks the CLI to stop (SIGINT to its process group; on
	// Windows it kills, there is no console signal for a hidden child; in
	// WSL it sends SIGINT to the CLI inside the distribution).
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
	p := &execProcess{cmd: cmd, stdout: stdout, done: make(chan struct{}), wsl: inv.WSL}
	cmd.Stderr = &p.stderr
	if inv.WSL != nil {
		// The run script reports the CLI's PID inside the distribution:
		// killing wsl.exe alone may leave the Linux process running.
		p.pidOut = &pidFilter{next: &p.stderr, onPID: func(n int) { p.pid.Store(int64(n)) }}
		cmd.Stderr = p.pidOut
	}
	if err := cmd.Start(); err != nil {
		if inv.WSL != nil {
			return nil, fmt.Errorf("cannot start wsl.exe for Claude Code in WSL (%s): %w", inv.WSL.Distro, err)
		}
		return nil, fmt.Errorf("cannot start %s: %w", inv.Path, err)
	}
	go func() {
		_, _ = io.Copy(stdin, strings.NewReader(inv.Stdin))
		_ = stdin.Close()
	}()
	go func() {
		p.waitErr = cmd.Wait()
		if p.pidOut != nil {
			p.pidOut.Flush()
		}
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

	wsl    *WSLTarget // the run is in WSL
	pidOut *pidFilter
	pid    atomic.Int64 // the CLI's PID inside the distribution (0 = not reported yet)
}

func (p *execProcess) Stdout() io.Reader { return p.stdout }
func (p *execProcess) Stderr() string    { return p.stderr.String() }

func (p *execProcess) Interrupt() error {
	if p.wsl != nil {
		if pid := p.pid.Load(); pid > 0 && wslSignal(p.wsl, pid, "INT") == nil {
			return nil
		}
	}
	return interruptProcess(p.cmd)
}

func (p *execProcess) Kill() error {
	if p.wsl != nil {
		if pid := p.pid.Load(); pid > 0 {
			_ = wslSignal(p.wsl, pid, "KILL")
		}
	}
	return killProcess(p.cmd)
}

// wslSignal sends sig to pid inside the run's distribution (through a
// second wsl.exe; the shell builtin kill needs no binary on the PATH).
func wslSignal(w *WSLTarget, pid int64, sig string) error {
	ctx, cancel := context.WithTimeout(context.Background(), wslSignalTimeout)
	defer cancel()
	script := "kill -s " + sig + " " + strconv.FormatInt(pid, 10)
	cmd := exec.CommandContext(ctx, w.Exe, wslArgs(w.Distro, script)...)
	cmd.Env = setEnv(ChildEnv(os.Environ(), false), "WSL_UTF8=1")
	cmd.Dir = os.TempDir()
	cmd.WaitDelay = time.Second
	prepareProcess(cmd)
	return cmd.Run()
}

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
