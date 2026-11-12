package services

import (
	"context"
	"runtime"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/claudecode"
	"github.com/dpicillo/LDAPilot/internal/config"
)

// Where the Claude Code CLI is: found natively, or (Windows) inside a WSL
// distribution. Looking in WSL starts the distribution and its login shell
// (seconds; on a cold start of WSL much longer), so the result is kept and
// shared by the runs, the model discovery and the settings.

const (
	// ccFailTTL is how long a failed search is reused (the user may
	// install Claude Code meanwhile).
	ccFailTTL = 30 * time.Second
	// ccRecheckAfter: an explicit refresh (settings Refresh / Test, the
	// check before sending) searches again when the result is older.
	ccRecheckAfter = 30 * time.Second
	// ccResolveLimit bounds one search (automatic mode may probe several
	// distributions).
	ccResolveLimit = 6 * time.Minute
)

// ccCLICache caches the CLI search per settings (one search at a time).
type ccCLICache struct {
	mu      sync.Mutex
	key     string
	cli     claudecode.CLI
	err     error
	at      time.Time
	pending *ccSearch
}

type ccSearch struct {
	key  string
	done chan struct{}
	cli  claudecode.CLI
	err  error
}

func ccCacheKey(cc config.ClaudeCodeConfig) string {
	return cc.Runtime + "\x00" + cc.Path + "\x00" + cc.WSLDistro + "\x00" + cc.WSLPath
}

func ccResolveOptions(cc config.ClaudeCodeConfig) claudecode.ResolveOptions {
	return claudecode.ResolveOptions{Runtime: cc.Runtime, Path: cc.Path, Distro: cc.WSLDistro, WSLPath: cc.WSLPath}
}

// resolveClaudeCode returns where the CLI is. A cached result is reused
// unless refresh asks again (and it is older than ccRecheckAfter) or it is
// a failure older than ccFailTTL. The search itself runs to its end in the
// background (a stopped run or check does not waste a WSL cold start);
// ctx only ends the wait.
func (s *AIService) resolveClaudeCode(ctx context.Context, cc config.ClaudeCodeConfig, refresh bool) (claudecode.CLI, error) {
	c := &s.ccCLI
	key := ccCacheKey(cc)
	c.mu.Lock()
	if c.key == key && !c.at.IsZero() {
		age := time.Since(c.at)
		if (c.err == nil && (!refresh || age < ccRecheckAfter)) || (c.err != nil && age < ccFailTTL && !refresh) {
			cli, err := c.cli, c.err
			c.mu.Unlock()
			return cli, err
		}
	}
	p := c.pending
	if p == nil || p.key != key {
		p = &ccSearch{key: key, done: make(chan struct{})}
		c.pending = p
		go func() {
			sctx, cancel := context.WithTimeout(context.Background(), ccResolveLimit)
			defer cancel()
			p.cli, p.err = s.searchClaudeCode(sctx, cc)
			c.mu.Lock()
			if c.pending == p {
				c.pending = nil
				c.key, c.cli, c.err, c.at = key, p.cli, p.err, time.Now()
			}
			c.mu.Unlock()
			close(p.done)
		}()
	}
	c.mu.Unlock()
	select {
	case <-p.done:
		return p.cli, p.err
	case <-ctx.Done():
		return claudecode.CLI{}, ctx.Err()
	}
}

// searchClaudeCode runs the search (test hooks: ccResolve, ccFindCLI).
func (s *AIService) searchClaudeCode(ctx context.Context, cc config.ClaudeCodeConfig) (claudecode.CLI, error) {
	if s.ccResolve != nil {
		return s.ccResolve(ctx, ccResolveOptions(cc))
	}
	return claudecode.Resolver{FindNative: s.ccFindCLI}.Resolve(ctx, ccResolveOptions(cc))
}

// cachedClaudeCode is the last successful search for these settings, if
// any (never searches: used where a run must not wait).
func (s *AIService) cachedClaudeCode(cc config.ClaudeCodeConfig) (claudecode.CLI, bool) {
	c := &s.ccCLI
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.key == ccCacheKey(cc) && c.err == nil && !c.at.IsZero() {
		return c.cli, true
	}
	return claudecode.CLI{}, false
}

// forgetClaudeCode drops the cached search (a run's CLI did not start or
// exited without an answer).
func (s *AIService) forgetClaudeCode() {
	c := &s.ccCLI
	c.mu.Lock()
	c.key, c.at = "", time.Time{}
	c.mu.Unlock()
}

// claudeCodeLocation describes cli for the settings.
func claudeCodeLocation(cli claudecode.CLI) *ai.ClaudeCodeLocation {
	if cli.WSL == nil {
		return &ai.ClaudeCodeLocation{Runtime: "native", Path: cli.Path}
	}
	return &ai.ClaudeCodeLocation{Runtime: "wsl", Path: cli.Path, Distro: cli.WSL.Distro, WSLVersion: cli.WSL.Version, EnvSource: cli.WSL.EnvSource}
}

// GetClaudeCodeHosts says where the Claude Code CLI can run: on Windows the
// installed WSL distributions (listed without starting one), elsewhere
// only natively.
func (s *AIService) GetClaudeCodeHosts() ai.ClaudeCodeHosts {
	goos := s.ccGOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	h := ai.ClaudeCodeHosts{OS: goos}
	if goos != "windows" {
		return h
	}
	list := s.ccListWSL
	if list == nil {
		list = claudecode.Resolver{}.ListWSL
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	distros, err := list(ctx)
	h.WSL = &ai.WSLStatus{Distros: []ai.WSLDistro{}}
	if err != nil {
		h.WSL.Error = err.Error()
		return h
	}
	for _, d := range distros {
		if claudecode.IsHelperDistro(d.Name) {
			continue
		}
		h.WSL.Distros = append(h.WSL.Distros, ai.WSLDistro{Name: d.Name, Default: d.Default, State: d.State, Version: d.Version})
	}
	h.WSL.Available = len(h.WSL.Distros) > 0
	if !h.WSL.Available {
		h.WSL.Error = "No Linux distribution is installed (wsl --install)."
	}
	return h
}
