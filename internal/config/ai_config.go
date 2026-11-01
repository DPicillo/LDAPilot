package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"
)

const aiConfigFileName = "ai_config.json"

// AIConfigVersion is the current on-disk format of ai_config.json.
const AIConfigVersion = 2

// AIConfig is the AI assistant configuration (format v2).
//
// APIKey is write-only from the UI: GetMasked always returns "" and sets
// HasKey/KeyError instead. HasKey, KeyError, Warnings and ClearAPIKey are
// never persisted.
type AIConfig struct {
	Version  int    `json:"version"`
	Revision int64  `json:"revision"` // bumped on every write; Set rejects a stale value
	Engine   string `json:"engine"`   // "builtin" (default) | "claudecode"

	Provider string `json:"provider"`         // "openai" | "ollama" | "anthropic" | "" (not configured)
	Flavor   string `json:"flavor,omitempty"` // provider=openai: openai|litellm|ollama|vllm|lmstudio|custom
	URL      string `json:"url"`

	APIKey      string   `json:"apiKey"`                // AES-GCM at rest; "" in responses
	HasKey      bool     `json:"hasKey"`                // response only
	ClearAPIKey bool     `json:"clearApiKey,omitempty"` // request only
	KeyError    string   `json:"keyError,omitempty"`    // response only
	Warnings    []string `json:"warnings,omitempty"`    // response only

	AnthropicAuth       string `json:"anthropicAuth,omitempty"`     // "x-api-key" (default) | "bearer"
	AnthropicFallback   *bool  `json:"anthropicFallback,omitempty"` // nil = off
	AllowInsecureHTTP   bool   `json:"allowInsecureHttp,omitempty"`
	TLSSkipVerify       bool   `json:"tlsSkipVerify,omitempty"`
	EndpointLocal       bool   `json:"endpointLocal,omitempty"`       // user asserts a loopback gateway does not forward
	EndpointConcurrency int    `json:"endpointConcurrency,omitempty"` // 0 = auto
	ToolCallIDStyle     string `json:"toolCallIdStyle,omitempty"`     // "" auto | "openai" | "alnum9"

	Model             string `json:"model"`
	ContextWindow     int    `json:"contextWindow"`   // 0 = auto; else 2048..2000000
	MaxOutputTokens   int    `json:"maxOutputTokens"` // 0 = auto
	MaxSteps          int    `json:"maxSteps"`        // 0 = 12; 2..50
	Thinking          string `json:"thinking"`        // "" | off | low | medium | high
	HideThinking      bool   `json:"hideThinking"`
	Effort            string `json:"effort,omitempty"` // anthropic: "" | low | medium | high | xhigh | max
	RequestTimeoutSec int    `json:"requestTimeoutSec"`
	OllamaKeepAlive   string `json:"ollamaKeepAlive,omitempty"` // "" = "30m"

	AllowWrites            bool                   `json:"allowWrites"`
	DefaultAccess          string                 `json:"defaultAccess"`      // "" = "ask" | "none" | "read"
	ConnectionAccess       map[string]AccessEntry `json:"connectionAccess"`   // profileID → entry
	RedactAttributes       []string               `json:"redactAttributes"`   // user additions
	MaskPasswordValues     string                 `json:"maskPasswordValues"` // "" = "remote" | "always" | "never"
	DisableTitleGeneration bool                   `json:"disableTitleGeneration"`
	// ConnectionNotes are the user's notes per profile (conventions, OUs,
	// naming rules), shown to the assistant like a CLAUDE.md for that
	// directory once it may access the directory.
	ConnectionNotes map[string]string `json:"connectionNotes,omitempty"`

	ClaudeCode ClaudeCodeConfig `json:"claudeCode"`
}

// AccessEntry is the AI access level of one connection profile.
type AccessEntry struct {
	Level string   `json:"level"`           // none | ask | read | write
	Hosts []string `json:"hosts,omitempty"` // remote provider hosts this level was granted for
	// ReadHosts are remote provider hosts allowed to read only although the
	// level is write ("Always allow read" on an access card, §6.1): an
	// access card never widens write access to a remote host.
	ReadHosts []string `json:"readHosts,omitempty"`
}

// ClaudeCodeConfig configures the Claude Code CLI engine.
type ClaudeCodeConfig struct {
	Path            string  `json:"path,omitempty"`            // "" = auto-detect
	Model           string  `json:"model,omitempty"`           // "" = the CLI's default
	MaxBudgetUSD    float64 `json:"maxBudgetUsd,omitempty"`    // per message; 0 = DefaultClaudeCodeBudgetUSD
	AllowResume     bool    `json:"allowResume,omitempty"`     // keep Claude Code's own (unencrypted) session copy
	UseAnthropicEnv bool    `json:"useAnthropicEnv,omitempty"` // pass ANTHROPIC_* variables to the CLI
}

// Defaults and limits used by validation and by the harness.
const (
	DefaultMaxSteps            = 12
	DefaultRequestTimeoutSec   = 120
	DefaultOllamaKeepAlive     = "30m"
	DefaultClaudeCodeBudgetUSD = 1.0
	MaxRedactEntries           = 100
	MaxConnectionNoteRunes     = 2000
)

// Access levels.
const (
	AccessNone  = "none"
	AccessAsk   = "ask"
	AccessRead  = "read"
	AccessWrite = "write"
)

// ErrStaleRevision is returned by Set when the config changed since the
// caller read it.
var ErrStaleRevision = errors.New("Settings were changed elsewhere (for example by an approval). Reload them and apply your change again.")

// legacyAIConfig is the v1 file format (no "version" field).
type legacyAIConfig struct {
	Provider string `json:"provider"`
	URL      string `json:"url"`
	APIKey   string `json:"apiKey"`
	Model    string `json:"model"`
}

// AIConfigStore provides thread-safe, encrypted storage for the AI
// configuration. The API key is held in memory in plaintext; on disk it is
// encrypted with the application key.
type AIConfigStore struct {
	mu        sync.RWMutex
	config    AIConfig
	encKey    string // the stored ciphertext ("ENC:..."), re-persisted unchanged while the key is unchanged
	keyError  string // set when the stored key could not be decrypted
	filePath  string
	listeners []func(AIConfig)
	validator func(AIConfig) error
}

// NewAIConfigStore opens ai_config.json in the config directory, migrating
// a v1 file to v2 (written back atomically).
func NewAIConfigStore() (*AIConfigStore, error) {
	dir, err := ConfigDir()
	if err != nil {
		return nil, fmt.Errorf("failed to determine config dir: %w", err)
	}
	return OpenAIConfigStore(filepath.Join(dir, aiConfigFileName))
}

// OpenAIConfigStore opens the AI config at an explicit path.
func OpenAIConfigStore(path string) (*AIConfigStore, error) {
	s := &AIConfigStore{filePath: path}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

// DefaultAIConfig returns the configuration used when no file exists.
func DefaultAIConfig() AIConfig {
	return AIConfig{Version: AIConfigVersion, Engine: "builtin", ConnectionAccess: map[string]AccessEntry{}}
}

func (s *AIConfigStore) load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.filePath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			s.config = DefaultAIConfig()
			return nil
		}
		return fmt.Errorf("failed to read AI config: %w", err)
	}

	var probe struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return fmt.Errorf("failed to parse AI config: %w", err)
	}

	var cfg AIConfig
	migrated := false
	if probe.Version == 0 {
		var v1 legacyAIConfig
		if err := json.Unmarshal(data, &v1); err != nil {
			return fmt.Errorf("failed to parse AI config: %w", err)
		}
		cfg = MigrateLegacyAIConfig(v1.Provider, v1.URL, v1.Model)
		cfg.APIKey = v1.APIKey
		migrated = true
	} else {
		if err := json.Unmarshal(data, &cfg); err != nil {
			return fmt.Errorf("failed to parse AI config: %w", err)
		}
	}
	cfg.Version = AIConfigVersion
	if cfg.Engine == "" {
		cfg.Engine = "builtin"
	}
	if cfg.ConnectionAccess == nil {
		cfg.ConnectionAccess = map[string]AccessEntry{}
	}
	cfg.HasKey, cfg.KeyError, cfg.Warnings, cfg.ClearAPIKey = false, "", nil, false

	// Decrypt the API key. A value that cannot be decrypted is never used
	// as a bearer token; the ciphertext stays on disk until the user enters
	// a new key or the endpoint changes.
	s.encKey = ""
	s.keyError = ""
	if stored := cfg.APIKey; stored != "" {
		cfg.APIKey = ""
		if strings.HasPrefix(stored, encPrefix) {
			s.encKey = stored
			plain, derr := DecryptPassword(stored)
			switch {
			case derr == nil:
				cfg.APIKey = plain
			case errors.Is(derr, ErrKeyUnavailable):
				s.keyError = fmt.Sprintf("The stored API key cannot be used: LDAPilot cannot read its encryption key (%v).", derr)
			default:
				s.keyError = "The stored API key could not be decrypted. Please enter it again."
			}
		} else {
			// Plaintext from a very old version: use it and encrypt on write-back.
			cfg.APIKey = stored
			migrated = true
		}
	}

	s.config = cfg
	if migrated {
		// Best effort: a failed write-back keeps the in-memory migration.
		_ = s.saveLocked()
	}
	return nil
}

// MigrateLegacyAIConfig converts the v1 provider/url/model triple to v2.
func MigrateLegacyAIConfig(provider, rawURL, model string) AIConfig {
	cfg := DefaultAIConfig()
	cfg.Model = strings.TrimSpace(model)
	u := strings.TrimSpace(rawURL)
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "litellm":
		cfg.Provider, cfg.Flavor = "openai", "litellm"
	case "openai":
		cfg.Provider, cfg.Flavor = "openai", "openai"
	case "ollama":
		cfg.Provider = "ollama"
	case "anthropic":
		cfg.Provider = "anthropic"
	case "":
		if u != "" {
			cfg.Provider, cfg.Flavor = "openai", "custom"
		}
	default:
		cfg.Provider, cfg.Flavor = "openai", "custom"
	}
	cfg.URL = NormalizeAIURL(cfg.Provider, u)
	return cfg
}

// NormalizeAIURL trims whitespace and trailing slashes; for the native
// Ollama provider it also strips a trailing "/v1".
func NormalizeAIURL(provider, raw string) string {
	u := strings.TrimRight(strings.TrimSpace(raw), "/")
	if provider == "ollama" {
		u = strings.TrimRight(strings.TrimSuffix(u, "/v1"), "/")
	}
	return u
}

// DefaultAIURL returns the preset base URL for a provider/flavor.
func DefaultAIURL(provider, flavor string) string {
	switch provider {
	case "ollama":
		return "http://localhost:11434"
	case "anthropic":
		return "https://api.anthropic.com"
	case "openai":
		switch flavor {
		case "openai":
			return "https://api.openai.com/v1"
		case "litellm":
			return "http://localhost:4000/v1"
		case "ollama":
			return "http://localhost:11434/v1"
		case "vllm":
			return "http://localhost:8000/v1"
		case "lmstudio":
			return "http://localhost:1234/v1"
		}
	}
	return ""
}

func (s *AIConfigStore) saveLocked() error {
	cfg := s.config
	cfg.Version = AIConfigVersion
	switch {
	case cfg.APIKey != "":
		enc, err := EncryptPassword(cfg.APIKey)
		if err != nil {
			return fmt.Errorf("failed to encrypt API key: %w", err)
		}
		cfg.APIKey = enc
		s.encKey = enc
	case s.encKey != "":
		cfg.APIKey = s.encKey // undecryptable or not yet readable: keep it as it is
	}
	cfg.HasKey, cfg.KeyError, cfg.Warnings, cfg.ClearAPIKey = false, "", nil, false

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal AI config: %w", err)
	}
	if err := writeFileAtomic(s.filePath, data); err != nil {
		return fmt.Errorf("failed to write AI config: %w", err)
	}
	return nil
}

// Get returns the current config including the plaintext API key. Internal
// use only; never send it to the frontend.
func (s *AIConfigStore) Get() AIConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneAIConfig(s.config)
}

// GetMasked returns the config without the API key, with HasKey, KeyError
// and Warnings set. Safe for the frontend.
func (s *AIConfigStore) GetMasked() AIConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cfg := cloneAIConfig(s.config)
	cfg.HasKey = cfg.APIKey != ""
	cfg.APIKey = ""
	cfg.KeyError = s.keyError
	cfg.Warnings = configWarnings(cfg, cfg.HasKey)
	return cfg
}

// Revision returns the current revision.
func (s *AIConfigStore) Revision() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.config.Revision
}

// KeyError returns the reason the stored API key is unusable ("" if fine).
func (s *AIConfigStore) KeyError() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.keyError
}

// Subscribe registers fn to be called (synchronously, without the store
// lock held) after every successful change with the new config, including
// the plaintext key.
func (s *AIConfigStore) Subscribe(fn func(AIConfig)) {
	s.mu.Lock()
	s.listeners = append(s.listeners, fn)
	s.mu.Unlock()
}

// SetValidator installs an additional validation step for Set (for example
// a thinking/effort check against discovered model capabilities).
func (s *AIConfigStore) SetValidator(fn func(AIConfig) error) {
	s.mu.Lock()
	s.validator = fn
	s.mu.Unlock()
}

// EffectiveKey returns the API key to use for cfg, which may be an unsaved
// config from the settings form: cfg.APIKey if set; the stored key only if
// provider, flavor and normalized URL are unchanged; else "".
func (s *AIConfigStore) EffectiveKey(cfg AIConfig) string {
	if cfg.ClearAPIKey {
		return ""
	}
	if cfg.APIKey != "" {
		return cfg.APIKey
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if sameEndpoint(s.config, cfg) {
		return s.config.APIKey
	}
	return ""
}

func sameEndpoint(a, b AIConfig) bool {
	return a.Provider == b.Provider && normalizedFlavor(a) == normalizedFlavor(b) &&
		NormalizeAIURL(a.Provider, a.URL) == NormalizeAIURL(b.Provider, b.URL)
}

func normalizedFlavor(c AIConfig) string {
	if c.Provider == "openai" && c.Flavor == "" {
		return "custom"
	}
	return c.Flavor
}

// Set validates and stores cfg. The rules:
//  1. cfg.Revision must equal the stored revision (ErrStaleRevision).
//  2. ClearAPIKey drops the key.
//  3. A non-empty APIKey replaces the key.
//  4. An empty APIKey keeps the stored key only if provider, flavor and the
//     normalized URL are unchanged; otherwise the key is dropped.
//
// On success the revision is bumped, the file is written atomically and
// subscribers are notified.
func (s *AIConfigStore) Set(cfg AIConfig) error {
	s.mu.Lock()
	if cfg.Revision != s.config.Revision {
		s.mu.Unlock()
		return ErrStaleRevision
	}
	next := cloneAIConfig(cfg)
	next.Version = AIConfigVersion
	if next.Engine == "" {
		next.Engine = "builtin"
	}
	if next.Provider == "openai" && next.Flavor == "" {
		next.Flavor = "custom"
	}
	next.URL = NormalizeAIURL(next.Provider, next.URL)
	if next.URL == "" && next.Provider != "" {
		next.URL = DefaultAIURL(next.Provider, next.Flavor)
	}
	if next.ConnectionAccess == nil {
		next.ConnectionAccess = map[string]AccessEntry{}
	}
	for id, e := range next.ConnectionAccess {
		e.Hosts = normalizeHosts(e.Hosts)
		e.ReadHosts = withoutHosts(normalizeHosts(e.ReadHosts), e.Hosts)
		if e.Level == AccessNone || e.Level == AccessAsk {
			e.Hosts, e.ReadHosts = nil, nil
		}
		next.ConnectionAccess[id] = e
	}

	oldEnc, oldErr := s.encKey, s.keyError
	keepEnc := false
	switch {
	case next.ClearAPIKey:
		next.APIKey = ""
	case next.APIKey != "":
		// new key
	case sameEndpoint(s.config, next):
		next.APIKey = s.config.APIKey
		keepEnc = s.config.APIKey == ""
	default:
		next.APIKey = ""
	}
	next.HasKey, next.KeyError, next.Warnings, next.ClearAPIKey = false, "", nil, false

	if err := ValidateAIConfig(next, next.APIKey != "" || (keepEnc && oldEnc != "")); err != nil {
		s.mu.Unlock()
		return err
	}
	if s.validator != nil {
		if err := s.validator(next); err != nil {
			s.mu.Unlock()
			return err
		}
	}

	prev := s.config
	next.Revision = prev.Revision + 1
	s.config = next
	if !keepEnc {
		s.encKey, s.keyError = "", ""
	}
	if err := s.saveLocked(); err != nil {
		s.config, s.encKey, s.keyError = prev, oldEnc, oldErr
		s.mu.Unlock()
		return err
	}
	out, listeners := cloneAIConfig(s.config), append([]func(AIConfig){}, s.listeners...)
	s.mu.Unlock()
	for _, fn := range listeners {
		fn(out)
	}
	return nil
}

// SetConnectionAccess patches the access level of one profile without the
// revision check, bumps the revision and notifies subscribers. bindHost, if
// non-empty, is a remote provider host the level is granted for (read and
// write levels only); it is added to the entry's Hosts. A lower level keeps
// the hosts; "none" and "ask" clear them.
func (s *AIConfigStore) SetConnectionAccess(profileID, level, bindHost string) (int64, error) {
	if strings.TrimSpace(profileID) == "" {
		return 0, fmt.Errorf("profile ID is required")
	}
	if !validAccessLevel(level) {
		return 0, fmt.Errorf("invalid access level %q", level)
	}
	s.mu.Lock()
	prev := s.config
	next := cloneAIConfig(prev)
	entry := next.ConnectionAccess[profileID]
	entry.Level = level
	switch level {
	case AccessNone, AccessAsk:
		entry.Hosts, entry.ReadHosts = nil, nil
	default:
		if h := strings.ToLower(strings.TrimSpace(bindHost)); h != "" {
			entry.Hosts = normalizeHosts(append(entry.Hosts, h))
			entry.ReadHosts = withoutHosts(entry.ReadHosts, entry.Hosts)
		}
	}
	next.ConnectionAccess[profileID] = entry
	next.Revision = prev.Revision + 1
	s.config = next
	if err := s.saveLocked(); err != nil {
		s.config = prev
		s.mu.Unlock()
		return 0, err
	}
	out, listeners := cloneAIConfig(s.config), append([]func(AIConfig){}, s.listeners...)
	s.mu.Unlock()
	for _, fn := range listeners {
		fn(out)
	}
	return out.Revision, nil
}

// AllowReadHost lets a remote provider host read one profile ("Always
// allow read" on an access card, §6.1) without the revision check. A
// profile at level write keeps write for its consented hosts and gets the
// host as a read-only host; otherwise the level becomes (at least) read for
// the host. Write access is never widened to a new host here.
func (s *AIConfigStore) AllowReadHost(profileID, host string) (int64, error) {
	h := strings.ToLower(strings.TrimSpace(host))
	if strings.TrimSpace(profileID) == "" || h == "" {
		return 0, fmt.Errorf("profile ID and host are required")
	}
	s.mu.Lock()
	prev := s.config
	next := cloneAIConfig(prev)
	entry := next.ConnectionAccess[profileID]
	switch entry.Level {
	case AccessWrite:
		if !hostListed(entry.Hosts, h) {
			entry.ReadHosts = normalizeHosts(append(entry.ReadHosts, h))
		}
	case AccessRead:
		entry.Hosts = normalizeHosts(append(entry.Hosts, h))
		entry.ReadHosts = withoutHosts(entry.ReadHosts, entry.Hosts)
	default:
		entry.Level = AccessRead
		entry.Hosts, entry.ReadHosts = []string{h}, nil
	}
	next.ConnectionAccess[profileID] = entry
	next.Revision = prev.Revision + 1
	s.config = next
	if err := s.saveLocked(); err != nil {
		s.config = prev
		s.mu.Unlock()
		return 0, err
	}
	out, listeners := cloneAIConfig(s.config), append([]func(AIConfig){}, s.listeners...)
	s.mu.Unlock()
	for _, fn := range listeners {
		fn(out)
	}
	return out.Revision, nil
}

func hostListed(hosts []string, h string) bool {
	for _, x := range hosts {
		if strings.EqualFold(strings.TrimSpace(x), h) {
			return true
		}
	}
	return false
}

func withoutHosts(hosts, remove []string) []string {
	var out []string
	for _, h := range hosts {
		if !hostListed(remove, h) {
			out = append(out, h)
		}
	}
	return out
}

func normalizeHosts(hosts []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, h := range hosts {
		h = strings.ToLower(strings.TrimSpace(h))
		if h == "" || seen[h] {
			continue
		}
		seen[h] = true
		out = append(out, h)
	}
	return out
}

func cloneAIConfig(c AIConfig) AIConfig {
	out := c
	if c.ConnectionAccess != nil {
		out.ConnectionAccess = make(map[string]AccessEntry, len(c.ConnectionAccess))
		for k, v := range c.ConnectionAccess {
			v.Hosts = append([]string(nil), v.Hosts...)
			v.ReadHosts = append([]string(nil), v.ReadHosts...)
			out.ConnectionAccess[k] = v
		}
	}
	out.RedactAttributes = append([]string(nil), c.RedactAttributes...)
	out.Warnings = append([]string(nil), c.Warnings...)
	if c.ConnectionNotes != nil {
		out.ConnectionNotes = make(map[string]string, len(c.ConnectionNotes))
		for k, v := range c.ConnectionNotes {
			out.ConnectionNotes[k] = v
		}
	}
	if c.AnthropicFallback != nil {
		v := *c.AnthropicFallback
		out.AnthropicFallback = &v
	}
	return out
}

func configWarnings(cfg AIConfig, hasKey bool) []string {
	var w []string
	if cfg.TLSSkipVerify && hasKey {
		w = append(w, "TLS certificate checks are off while an API key is sent")
	}
	return w
}

// --- validation ---

var (
	redactEntryRe = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9-]*\*?|[0-9]+(\.[0-9]+)+)$`)
	keepAliveRe   = regexp.MustCompile(`^-?[0-9]+(\.[0-9]+)?(ms|s|m|h)?$`)
	ccModelRe     = regexp.MustCompile(`^[A-Za-z0-9._:\[\]/-]{0,128}$`)
)

func validAccessLevel(l string) bool {
	switch l {
	case AccessNone, AccessAsk, AccessRead, AccessWrite:
		return true
	}
	return false
}

// ValidateAIConfig checks cfg (after the key rules were applied). hasKey
// tells whether an API key will be sent.
func ValidateAIConfig(cfg AIConfig, hasKey bool) error {
	if len(cfg.ConnectionNotes) > 200 {
		return fmt.Errorf("too many connection notes")
	}
	for _, n := range cfg.ConnectionNotes {
		if utf8.RuneCountInString(n) > MaxConnectionNoteRunes {
			return fmt.Errorf("a connection note is longer than %d characters", MaxConnectionNoteRunes)
		}
	}
	switch cfg.Engine {
	case "", "builtin", "claudecode":
	default:
		return fmt.Errorf("unknown engine %q", cfg.Engine)
	}
	switch cfg.Provider {
	case "":
		if cfg.URL != "" {
			return fmt.Errorf("choose a provider for the URL %q", cfg.URL)
		}
	case "openai":
		switch cfg.Flavor {
		case "openai", "litellm", "ollama", "vllm", "lmstudio", "custom":
		default:
			return fmt.Errorf("unknown OpenAI-compatible flavor %q", cfg.Flavor)
		}
	case "ollama", "anthropic":
		if cfg.Flavor != "" {
			return fmt.Errorf("flavor %q is only valid for OpenAI-compatible providers", cfg.Flavor)
		}
	default:
		return fmt.Errorf("unknown provider %q", cfg.Provider)
	}
	if cfg.Provider != "" {
		u, err := url.Parse(cfg.URL)
		if err != nil {
			return fmt.Errorf("invalid URL: %v", err)
		}
		if u.Scheme != "http" && u.Scheme != "https" {
			return fmt.Errorf("the URL must start with http:// or https://")
		}
		if u.Hostname() == "" {
			return fmt.Errorf("the URL has no host")
		}
		if u.User != nil {
			return fmt.Errorf("the URL must not contain a user name or password; enter the API key in its own field")
		}
		loop := isLoopbackHost(u.Hostname())
		if u.Scheme == "http" && hasKey && !loop && !cfg.AllowInsecureHTTP {
			return fmt.Errorf("the API key would be sent unencrypted over http:// to %s; use https:// or allow insecure HTTP explicitly", u.Hostname())
		}
		if cfg.EndpointLocal && !loop {
			return fmt.Errorf("\"runs on this machine\" can only be set for localhost or 127.0.0.1 endpoints")
		}
	}
	switch cfg.AnthropicAuth {
	case "", "x-api-key", "bearer":
	default:
		return fmt.Errorf("unknown Anthropic auth mode %q", cfg.AnthropicAuth)
	}
	switch cfg.ToolCallIDStyle {
	case "", "openai", "alnum9":
	default:
		return fmt.Errorf("unknown tool call ID style %q", cfg.ToolCallIDStyle)
	}
	if cfg.EndpointConcurrency < 0 || cfg.EndpointConcurrency > 16 {
		return fmt.Errorf("endpoint concurrency must be between 1 and 16 (0 = automatic)")
	}
	if cfg.ContextWindow != 0 && (cfg.ContextWindow < 2048 || cfg.ContextWindow > 2000000) {
		return fmt.Errorf("context window must be between 2048 and 2000000 tokens (0 = automatic)")
	}
	if cfg.MaxOutputTokens != 0 && (cfg.MaxOutputTokens < 256 || cfg.MaxOutputTokens > 262144) {
		return fmt.Errorf("max output tokens must be between 256 and 262144 (0 = automatic)")
	}
	if cfg.MaxSteps != 0 && (cfg.MaxSteps < 2 || cfg.MaxSteps > 50) {
		return fmt.Errorf("max steps must be between 2 and 50 (0 = %d)", DefaultMaxSteps)
	}
	if cfg.RequestTimeoutSec != 0 && (cfg.RequestTimeoutSec < 10 || cfg.RequestTimeoutSec > 3600) {
		return fmt.Errorf("request timeout must be between 10 and 3600 seconds (0 = %d)", DefaultRequestTimeoutSec)
	}
	if cfg.OllamaKeepAlive != "" && !keepAliveRe.MatchString(cfg.OllamaKeepAlive) {
		return fmt.Errorf("invalid Ollama keep-alive %q (examples: 30m, 1h, -1)", cfg.OllamaKeepAlive)
	}
	switch cfg.Thinking {
	case "", "off", "low", "medium", "high":
	default:
		return fmt.Errorf("unknown thinking level %q", cfg.Thinking)
	}
	switch cfg.Effort {
	case "":
	case "low", "medium", "high", "xhigh", "max":
		if cfg.Provider != "anthropic" {
			return fmt.Errorf("effort is only supported by the Anthropic provider")
		}
	default:
		return fmt.Errorf("unknown effort level %q", cfg.Effort)
	}
	if err := ValidateAnthropicThinking(cfg.Model, cfg.Thinking, cfg.Effort); cfg.Provider == "anthropic" && err != nil {
		return err
	}
	switch cfg.DefaultAccess {
	case "", AccessAsk, AccessNone, AccessRead:
	case AccessWrite:
		return fmt.Errorf("the default access level cannot be \"write\"; grant write access per connection")
	default:
		return fmt.Errorf("invalid default access level %q", cfg.DefaultAccess)
	}
	for id, e := range cfg.ConnectionAccess {
		if strings.TrimSpace(id) == "" {
			return fmt.Errorf("connection access entry without a profile ID")
		}
		if !validAccessLevel(e.Level) {
			return fmt.Errorf("invalid access level %q", e.Level)
		}
	}
	if len(cfg.RedactAttributes) > MaxRedactEntries {
		return fmt.Errorf("at most %d redacted attributes are allowed", MaxRedactEntries)
	}
	for _, a := range cfg.RedactAttributes {
		if !redactEntryRe.MatchString(a) {
			return fmt.Errorf("invalid redacted attribute %q: use an attribute name, a prefix ending in * or a numeric OID", a)
		}
	}
	switch cfg.MaskPasswordValues {
	case "", "remote", "always", "never":
	default:
		return fmt.Errorf("invalid password masking mode %q", cfg.MaskPasswordValues)
	}
	cc := cfg.ClaudeCode
	if cc.MaxBudgetUSD != 0 && (cc.MaxBudgetUSD < 0.01 || cc.MaxBudgetUSD > 100 || math.IsNaN(cc.MaxBudgetUSD)) {
		return fmt.Errorf("the Claude Code budget must be between 0.01 and 100 USD per message")
	}
	if cc.Path != "" && !filepath.IsAbs(cc.Path) {
		return fmt.Errorf("the Claude Code path must be absolute")
	}
	if !ccModelRe.MatchString(cc.Model) {
		return fmt.Errorf("invalid Claude Code model %q", cc.Model)
	}
	return nil
}

// ValidateAnthropicThinking rejects thinking/effort combinations that the
// Anthropic API refuses, for models known statically. Discovered model
// capabilities are checked additionally by the validator the AI service
// installs (SetValidator).
func ValidateAnthropicThinking(model, thinking, effort string) error {
	m := strings.ToLower(model)
	switch {
	case strings.HasPrefix(m, "claude-haiku-4-5"):
		if effort != "" {
			return fmt.Errorf("Claude Haiku 4.5 does not support the effort setting")
		}
	case strings.HasPrefix(m, "claude-sonnet-5-5"):
		if thinking == "off" && (effort == "xhigh" || effort == "max") {
			return fmt.Errorf("Claude Sonnet 5.5 can only turn thinking off (between_tools) at effort high or lower")
		}
	}
	return nil
}

// isLoopbackHost reports whether host is a literal loopback name or address
// (localhost, 127.0.0.0/8, ::1). Host names that merely resolve to loopback
// do not count.
func isLoopbackHost(host string) bool {
	h := strings.ToLower(strings.TrimSuffix(strings.Trim(host, "[]"), "."))
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}
