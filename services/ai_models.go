package services

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/agent"
	"github.com/dpicillo/LDAPilot/internal/ai/claudecode"
	"github.com/dpicillo/LDAPilot/internal/ai/provider"
	"github.com/dpicillo/LDAPilot/internal/config"
)

// Model discovery for the AI settings and chat (Addendum A): every
// provider and the Claude Code CLI list their models automatically.

const (
	modelsCacheFile    = "ai_models_cache.json"
	claudeCodeWorkDir  = "claude-code-workdir"
	claudeCodeFilesDir = "claude-code-runs"
	discoveryCallLimit = 20 * time.Second
)

// aiModels holds the discovery state of the AI facade.
type aiModels struct {
	once  sync.Once
	cache *provider.DiscoveryCache
	clock ai.Clock
	// slot serializes discovery per process (cheap, avoids duplicate CLI
	// spawns). A channel, not a mutex: a stopped CheckProvider must not wait
	// for a background discovery that is still dialing an endpoint that does
	// not answer (UX P4: Stop freed the composer only ~10 s later).
	slot chan struct{}

	// checks are the running CheckProvider calls (CancelProviderCheck stops them).
	checkMu  sync.Mutex
	checkSeq int
	checks   map[int]context.CancelFunc
}

func (m *aiModels) init() {
	m.once.Do(func() {
		m.clock = ai.SystemClock()
		path := ""
		if dir, err := config.ConfigDir(); err == nil {
			path = filepath.Join(dir, modelsCacheFile)
		}
		m.cache = provider.OpenDiscoveryCache(path, m.clock)
		m.slot = make(chan struct{}, 1)
	})
}

// acquire takes the discovery slot, or gives up when ctx ends first.
func (m *aiModels) acquire(ctx context.Context) error {
	select {
	case m.slot <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *aiModels) release() { <-m.slot }

// emit sends a Wails event when the app context is set.
func (s *AIService) emit(name string, payload any) {
	if s.emitter != nil {
		s.emitter(name, payload)
		return
	}
	if s.ctx != nil {
		runtime.EventsEmit(s.ctx, name, payload)
	}
}

// providerOptions maps a (possibly unsaved) config to provider options.
func (s *AIService) providerOptions(cfg config.AIConfig, key string) provider.Options {
	s.models.init()
	flavor := cfg.Flavor
	if cfg.Provider == provider.KindOpenAI && flavor == "" {
		flavor = provider.FlavorCustom
	}
	if cfg.Provider != provider.KindOpenAI {
		flavor = ""
	}
	return provider.Options{
		Kind:            cfg.Provider,
		Flavor:          flavor,
		BaseURL:         config.NormalizeAIURL(cfg.Provider, cfg.URL),
		APIKey:          key,
		AnthropicAuth:   cfg.AnthropicAuth,
		TLSSkipVerify:   cfg.TLSSkipVerify,
		RequestTimeout:  time.Duration(cfg.RequestTimeoutSec) * time.Second,
		KeepAlive:       cfg.OllamaKeepAlive,
		ToolCallIDStyle: cfg.ToolCallIDStyle,
		Concurrency:     cfg.EndpointConcurrency,
		ContextWindow:   cfg.ContextWindow,
		Clock:           s.models.clock,
		Params:          s.models.cache,
	}
}

// DiscoverModels lists the models of a provider or of the Claude Code CLI.
// cfg may be unsaved (the settings form); the stored API key is only used
// when provider, flavor and URL are unchanged. Discovery errors are
// returned inside the result (with the last cached list), never as an
// error; an error is returned only for an invalid config. Nothing is
// persisted except the model cache.
func (s *AIService) DiscoverModels(cfg config.AIConfig, refresh bool) (ai.ModelDiscovery, error) {
	return s.discoverModels(context.Background(), cfg, refresh)
}

func (s *AIService) discoverModels(parent context.Context, cfg config.AIConfig, refresh bool) (ai.ModelDiscovery, error) {
	s.models.init()
	ctx, cancel := context.WithTimeout(parent, discoveryCallLimit)
	defer cancel()
	if cfg.Engine == "claudecode" {
		return s.discoverClaudeCode(ctx, cfg, refresh), nil
	}
	if cfg.Provider == "" {
		return ai.ModelDiscovery{Models: []ai.ModelInfo{}, Error: "No AI provider is configured."}, nil
	}
	norm := cfg
	norm.URL = config.NormalizeAIURL(cfg.Provider, cfg.URL)
	if norm.URL == "" {
		norm.URL = config.DefaultAIURL(cfg.Provider, cfg.Flavor)
	}
	if norm.Provider == provider.KindOpenAI && norm.Flavor == "" {
		norm.Flavor = provider.FlavorCustom
	}
	key := s.configStore.EffectiveKey(norm)
	if err := config.ValidateAIConfig(norm, key != ""); err != nil {
		return ai.ModelDiscovery{}, err
	}
	p, err := provider.NewUnwrapped(s.providerOptions(norm, key))
	if err != nil {
		return ai.ModelDiscovery{}, err
	}
	kind := norm.Provider
	if kind == provider.KindOpenAI {
		kind = p.Key()
	}
	if err := s.models.acquire(ctx); err != nil {
		return discoveryStopped(p.Key(), norm.URL, err), nil
	}
	defer s.models.release()
	return provider.Discover(ctx, s.models.cache, provider.DiscoverRequest{
		CacheKey:    provider.CacheKey(norm.Provider, normFlavor(norm), norm.URL),
		ProviderKey: p.Key(),
		BaseURL:     norm.URL,
		Configured:  norm.Model,
		Kind:        kind,
		Refresh:     refresh,
		List:        p.ListModels,
		Scrub:       provider.NewScrubber(key),
	}), nil
}

// CheckProvider is the composer's check before a run (UX A-19): a fresh
// model listing. It fails (code provider_unreachable or timeout, message
// with host:port and cause) only when the endpoint did not answer; any
// other listing error (a key without permission for the model list, a
// gateway without /models) is returned inside the result, since the run
// itself may still work.
//
// CancelProviderCheck stops it (Stop / Esc in the composer while it runs,
// UX P4); a stopped check fails with code cancelled.
func (s *AIService) CheckProvider(cfg config.AIConfig) (ai.ModelDiscovery, error) {
	ctx, cancel := context.WithCancel(context.Background())
	m := &s.models
	m.checkMu.Lock()
	if m.checks == nil {
		m.checks = map[int]context.CancelFunc{}
	}
	m.checkSeq++
	id := m.checkSeq
	m.checks[id] = cancel
	m.checkMu.Unlock()
	defer func() {
		m.checkMu.Lock()
		delete(m.checks, id)
		m.checkMu.Unlock()
		cancel()
	}()
	d, err := s.discoverModels(ctx, cfg, true)
	if ctx.Err() != nil {
		return d, &aiError{code: ai.CodeCancelled, msg: "The check of the AI provider was stopped."}
	}
	if err != nil {
		return d, err
	}
	if d.Error != "" && (d.ErrorCode == ai.CodeProviderUnreachable || d.ErrorCode == ai.CodeTimeout) {
		return d, &aiError{code: d.ErrorCode, msg: d.Error}
	}
	return d, nil
}

// CancelProviderCheck stops every running CheckProvider (the composer's
// Stop / Esc during "Checking the AI provider … before sending").
func (s *AIService) CancelProviderCheck() {
	m := &s.models
	m.checkMu.Lock()
	defer m.checkMu.Unlock()
	for _, cancel := range m.checks {
		cancel()
	}
}

// discoveryStopped is the result of a discovery that ended while it waited
// for the discovery slot (stopped, or its time limit passed).
func discoveryStopped(providerKey, baseURL string, err error) ai.ModelDiscovery {
	d := ai.ModelDiscovery{Provider: providerKey, BaseURL: baseURL, Models: []ai.ModelInfo{}}
	if errors.Is(err, context.Canceled) {
		d.Error, d.ErrorCode = "The check was stopped.", ai.CodeCancelled
	} else {
		d.Error, d.ErrorCode = "Model discovery is busy with another request; try again.", ai.CodeTimeout
	}
	return d
}

func normFlavor(c config.AIConfig) string {
	if c.Provider != provider.KindOpenAI {
		return ""
	}
	return c.Flavor
}

// discoverClaudeCode runs the free initialize request of the CLI (cached
// per CLI path and version; re-detected when `claude --version` changes).
func (s *AIService) discoverClaudeCode(ctx context.Context, cfg config.AIConfig, refresh bool) ai.ModelDiscovery {
	path, err := s.findClaude(cfg.ClaudeCode.Path)
	if err != nil {
		return ai.ModelDiscovery{Provider: "claudecode", Models: claudecode.FallbackModels(), Error: err.Error(), EffectiveModel: orDefault(cfg.ClaudeCode.Model)}
	}
	version, verr := claudecode.Version(ctx, path, nil)
	workDir := ""
	if dir, err := config.ConfigDir(); err == nil {
		workDir = filepath.Join(dir, claudeCodeWorkDir)
		_ = os.MkdirAll(workDir, 0o700)
	}
	if err := s.models.acquire(ctx); err != nil {
		d := discoveryStopped("claudecode", path, err)
		d.Models = claudecode.FallbackModels()
		return d
	}
	defer s.models.release()
	d := provider.Discover(ctx, s.models.cache, provider.DiscoverRequest{
		CacheKey:    "claudecode|" + path,
		ProviderKey: "claudecode",
		BaseURL:     path,
		Configured:  orDefault(cfg.ClaudeCode.Model),
		Kind:        "claudecode",
		Refresh:     refresh,
		Version:     version,
		List: func(ctx context.Context) ([]ai.ModelInfo, error) {
			res, err := claudecode.DiscoverModels(ctx, claudecode.DiscoverOptions{Path: path, WorkDir: workDir, UseAnthropicEnv: cfg.ClaudeCode.UseAnthropicEnv})
			if err != nil {
				return nil, err
			}
			return res.Models, nil
		},
	})
	if len(d.Models) == 0 {
		d.Models = claudecode.FallbackModels()
		d.EffectiveModel, d.ModelMissing, _ = provider.ResolveModel("claudecode", orDefault(cfg.ClaudeCode.Model), d.Models)
	}
	if verr != nil {
		d.Warnings = append(d.Warnings, verr.Error())
	}
	return d
}

func orDefault(model string) string {
	if model == "" {
		return "default"
	}
	return model
}

// ListModels returns the model IDs of the saved config (legacy binding).
func (s *AIService) ListModels() ([]string, error) {
	d, err := s.DiscoverModels(s.configStore.GetMasked(), false)
	if err != nil {
		return nil, err
	}
	if len(d.Models) == 0 && d.Error != "" {
		return nil, fmt.Errorf("%s", d.Error)
	}
	ids := make([]string, 0, len(d.Models))
	for _, m := range d.Models {
		ids = append(ids, m.ID)
	}
	return ids, nil
}

// effectiveModel returns the configured model, or the discovered fallback
// when none is configured or it disappeared (cached discovery only).
func (s *AIService) effectiveModel(cfg config.AIConfig) string {
	s.models.init()
	if cfg.Provider == "" {
		return cfg.Model
	}
	key := provider.CacheKey(cfg.Provider, normFlavor(cfg), config.NormalizeAIURL(cfg.Provider, cfg.URL))
	if e, ok := s.models.cache.Get(key); ok && len(e.Models) > 0 {
		kind := cfg.Provider
		if kind == provider.KindOpenAI {
			kind = provider.ProviderKey(kind, cfg.Flavor)
		}
		eff, _, _ := provider.ResolveModel(kind, cfg.Model, e.Models)
		return eff
	}
	return cfg.Model
}

// backgroundDiscovery refreshes the model list of the saved config and
// emits ai:models_updated. At startup only loopback endpoints (and an
// explicitly selected Claude Code engine) are contacted (§4.5).
func (s *AIService) backgroundDiscovery(startup bool) {
	if !s.autoDiscover {
		return
	}
	cfg := s.configStore.GetMasked()
	if startup {
		local := cfg.Engine == "claudecode" || (cfg.Provider != "" && ai.IsLoopbackURL(cfg.URL))
		if !local {
			return
		}
	}
	if cfg.Engine != "claudecode" && cfg.Provider == "" {
		return
	}
	go func() {
		d, err := s.DiscoverModels(cfg, !startup)
		if err != nil {
			log.Printf("AI model discovery: %v", err)
			return
		}
		s.emit(ai.EventModelsUpdated, ai.ModelsUpdatedEvent{ProviderKey: d.Provider, Models: d.Models, Discovery: d})
	}()
}

// endpointChanged reports whether a config change requires re-discovery.
func endpointChanged(a, b config.AIConfig) bool {
	return a.Engine != b.Engine || a.Provider != b.Provider || normFlavor(a) != normFlavor(b) ||
		config.NormalizeAIURL(a.Provider, a.URL) != config.NormalizeAIURL(b.Provider, b.URL) ||
		a.HasKey != b.HasKey || a.ClaudeCode.Path != b.ClaudeCode.Path
}

// claudeCodeEnv wires the Claude Code engine: a dedicated empty working
// directory and a private directory for per-run files under the config
// directory, and the model fallback from the cached discovery.
func (s *AIService) claudeCodeEnv() *agent.ClaudeCodeEnv {
	env := &agent.ClaudeCodeEnv{Launcher: s.ccLauncher, FindCLI: s.ccFindCLI, ResolveModel: s.resolveClaudeModel}
	if dir, err := config.ConfigDir(); err == nil {
		env.WorkDir = filepath.Join(dir, claudeCodeWorkDir)
		env.FilesDir = filepath.Join(dir, claudeCodeFilesDir)
	}
	return env
}

func (s *AIService) findClaude(explicit string) (string, error) {
	if s.ccFindCLI != nil {
		return s.ccFindCLI(explicit)
	}
	return claudecode.FindCLI(explicit)
}

// resolveClaudeModel keeps the configured model when the last discovery
// lists it (by alias or resolved model ID) and otherwise falls back to the
// CLI default with a notice (Addendum A). Without a cached list the
// configured model is used as is.
func (s *AIService) resolveClaudeModel(cfg config.AIConfig, configured string) (string, string) {
	s.models.init()
	path, err := s.findClaude(cfg.ClaudeCode.Path)
	if err != nil {
		return configured, ""
	}
	e, ok := s.models.cache.Get("claudecode|" + path)
	if !ok || len(e.Models) == 0 {
		return configured, ""
	}
	for _, m := range e.Models {
		if m.ID == configured || (m.ResolvedModel != "" && m.ResolvedModel == configured) {
			return configured, ""
		}
	}
	eff, _, _ := provider.ResolveModel("claudecode", configured, e.Models)
	if eff == "" || eff == configured {
		return configured, ""
	}
	return eff, fmt.Sprintf("Claude Code does not offer the model %q; using %q instead.", configured, eff)
}
