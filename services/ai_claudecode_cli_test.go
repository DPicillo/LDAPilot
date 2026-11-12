package services

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/claudecode"
	"github.com/dpicillo/LDAPilot/internal/config"
)

// The search for the CLI is cached per settings, shared by concurrent
// callers, repeated on an explicit refresh (when not fresh), after a
// failure has aged and after Forget; a stopped wait does not stop it.
func TestClaudeCodeSearchCache(t *testing.T) {
	s, _ := newTestAIService(t)
	var calls atomic.Int32
	release := make(chan struct{})
	var mu sync.Mutex
	fail := false
	s.ccResolve = func(ctx context.Context, o claudecode.ResolveOptions) (claudecode.CLI, error) {
		calls.Add(1)
		<-release
		mu.Lock()
		defer mu.Unlock()
		if fail {
			return claudecode.CLI{}, &claudecode.NotFoundError{Msg: "not found"}
		}
		return claudecode.CLI{Path: "/home/u/.local/bin/claude", WSL: &claudecode.WSLTarget{Distro: o.Distro}}, nil
	}
	wsl := config.ClaudeCodeConfig{Runtime: "wsl", WSLDistro: "Ubuntu"}

	// A stopped wait (Stop during a cold start) leaves the search running.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.resolveClaudeCode(ctx, wsl, false); !errors.Is(err, context.Canceled) {
		t.Fatalf("stopped wait: %v", err)
	}
	// Two callers meanwhile: one search.
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if cli, err := s.resolveClaudeCode(context.Background(), wsl, false); err != nil || cli.WSL.Distro != "Ubuntu" {
				t.Errorf("%+v %v", cli, err)
			}
		}()
	}
	time.Sleep(20 * time.Millisecond)
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("searches %d", calls.Load())
	}
	// Cached; a refresh right after does not search again.
	if _, err := s.resolveClaudeCode(context.Background(), wsl, true); err != nil || calls.Load() != 1 {
		t.Fatalf("refresh of a fresh result: %v, %d searches", err, calls.Load())
	}
	if cli, ok := s.cachedClaudeCode(wsl); !ok || cli.Path != "/home/u/.local/bin/claude" {
		t.Fatal("not cached")
	}
	// An older result is searched again on refresh, not without.
	s.ccCLI.mu.Lock()
	s.ccCLI.at = time.Now().Add(-time.Minute)
	s.ccCLI.mu.Unlock()
	_, _ = s.resolveClaudeCode(context.Background(), wsl, false)
	if calls.Load() != 1 {
		t.Fatal("searched without refresh")
	}
	_, _ = s.resolveClaudeCode(context.Background(), wsl, true)
	if calls.Load() != 2 {
		t.Fatalf("refresh of an old result: %d searches", calls.Load())
	}
	// Other settings: a new search; the old result is not reused.
	if _, ok := s.cachedClaudeCode(config.ClaudeCodeConfig{Runtime: "wsl", WSLDistro: "Debian"}); ok {
		t.Fatal("cache shared between settings")
	}
	// A failure is reused for a while, then searched again.
	mu.Lock()
	fail = true
	mu.Unlock()
	s.forgetClaudeCode()
	if _, err := s.resolveClaudeCode(context.Background(), wsl, false); err == nil || calls.Load() != 3 {
		t.Fatalf("after forget: %v, %d searches", err, calls.Load())
	}
	if _, err := s.resolveClaudeCode(context.Background(), wsl, false); err == nil || calls.Load() != 3 {
		t.Fatalf("fresh failure not reused: %d searches", calls.Load())
	}
	if _, ok := s.cachedClaudeCode(wsl); ok {
		t.Fatal("a failure counts as cached CLI")
	}
	s.ccCLI.mu.Lock()
	s.ccCLI.at = time.Now().Add(-time.Minute)
	s.ccCLI.mu.Unlock()
	_, _ = s.resolveClaudeCode(context.Background(), wsl, false)
	if calls.Load() != 4 {
		t.Fatalf("old failure reused: %d searches", calls.Load())
	}
}

func TestGetClaudeCodeHosts(t *testing.T) {
	s, _ := newTestAIService(t)
	s.ccGOOS = "linux"
	if h := s.GetClaudeCodeHosts(); h.OS != "linux" || h.WSL != nil {
		t.Fatalf("linux %+v", h)
	}
	s.ccGOOS = "windows"
	s.ccListWSL = func(context.Context) ([]claudecode.WSLDistro, error) {
		return []claudecode.WSLDistro{{Name: "Ubuntu", Default: true, State: "Wird ausgeführt", Version: 2}, {Name: "docker-desktop", Version: 2}}, nil
	}
	h := s.GetClaudeCodeHosts()
	if h.WSL == nil || !h.WSL.Available || len(h.WSL.Distros) != 1 || h.WSL.Distros[0] != (ai.WSLDistro{Name: "Ubuntu", Default: true, State: "Wird ausgeführt", Version: 2}) {
		t.Fatalf("windows %+v", h.WSL)
	}
	s.ccListWSL = func(context.Context) ([]claudecode.WSLDistro, error) {
		return []claudecode.WSLDistro{{Name: "docker-desktop"}}, nil
	}
	if h := s.GetClaudeCodeHosts(); h.WSL.Available || h.WSL.Error == "" || h.WSL.Distros == nil {
		t.Fatalf("docker only %+v", h.WSL)
	}
	s.ccListWSL = func(context.Context) ([]claudecode.WSLDistro, error) {
		return nil, errors.New("The Windows Subsystem for Linux is not installed.")
	}
	if h := s.GetClaudeCodeHosts(); h.WSL.Available || h.WSL.Error != "The Windows Subsystem for Linux is not installed." {
		t.Fatalf("no wsl %+v", h.WSL)
	}
}

// Discovery reports where the CLI was found; a search that finds nothing
// is the discovery error (with the fallback aliases).
func TestClaudeCodeDiscoveryLocation(t *testing.T) {
	s, _ := newTestAIService(t)
	s.ccResolve = func(context.Context, claudecode.ResolveOptions) (claudecode.CLI, error) {
		return claudecode.CLI{}, &claudecode.NotFoundError{Msg: "Claude Code CLI not found. Windows: … WSL: …"}
	}
	cfg := config.AIConfig{Engine: "claudecode", ClaudeCode: config.ClaudeCodeConfig{Runtime: "wsl"}}
	d, err := s.DiscoverModels(cfg, false)
	if err != nil || d.Error != "Claude Code CLI not found. Windows: … WSL: …" || len(d.Models) != 4 || d.ClaudeCode != nil {
		t.Fatalf("not found %+v %v", d, err)
	}
	loc := claudeCodeLocation(claudecode.CLI{Path: "/usr/bin/claude", WSL: &claudecode.WSLTarget{Distro: "Debian", Version: 1, EnvSource: "login"}})
	if *loc != (ai.ClaudeCodeLocation{Runtime: "wsl", Path: "/usr/bin/claude", Distro: "Debian", WSLVersion: 1, EnvSource: "login"}) {
		t.Fatalf("location %+v", loc)
	}
	if l := claudeCodeLocation(claudecode.CLI{Path: `C:\x\claude.exe`}); l.Runtime != "native" || l.Distro != "" {
		t.Fatalf("native %+v", l)
	}
	// Changing where it runs counts as another endpoint (re-discovery).
	a := config.AIConfig{Engine: "claudecode"}
	b := a
	b.ClaudeCode.WSLDistro = "Debian"
	if !endpointChanged(a, b) {
		t.Fatal("distribution change not detected")
	}
}
