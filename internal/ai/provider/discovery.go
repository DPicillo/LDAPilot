package provider

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

// Model discovery cache (§4.5, Addendum A): ai_models_cache.json, keyed by
// kind|flavor|baseURL. It also stores the unsupported-parameter facts. It
// never contains API keys (URLs with userinfo are rejected by the config).

const discoveryCacheVersion = 1

// DefaultDiscoveryMaxAge is how long a listing is served from cache
// without a refresh request.
const DefaultDiscoveryMaxAge = 10 * time.Minute

// CacheEntry is one cached listing.
type CacheEntry struct {
	Provider  string              `json:"provider"`
	BaseURL   string              `json:"baseUrl"`
	Models    []ai.ModelInfo      `json:"models"`
	FetchedAt int64               `json:"fetchedAt"`
	Error     string              `json:"error,omitempty"`
	ErrorAt   int64               `json:"errorAt,omitempty"`
	Version   string              `json:"version,omitempty"` // Claude Code CLI version
	Dropped   map[string][]string `json:"dropped,omitempty"` // model → unsupported parameters
}

type cacheFile struct {
	Version int                    `json:"version"`
	Entries map[string]*CacheEntry `json:"entries"`
}

// DiscoveryCache persists model listings and parameter facts. It is safe
// for concurrent use and implements ParamFacts.
type DiscoveryCache struct {
	mu    sync.Mutex
	path  string
	clock ai.Clock
	data  cacheFile
}

// OpenDiscoveryCache loads the cache file; a missing or corrupt file gives
// an empty cache. path "" keeps the cache in memory only.
func OpenDiscoveryCache(path string, clock ai.Clock) *DiscoveryCache {
	if clock == nil {
		clock = ai.SystemClock()
	}
	c := &DiscoveryCache{path: path, clock: clock, data: cacheFile{Version: discoveryCacheVersion, Entries: map[string]*CacheEntry{}}}
	if path == "" {
		return c
	}
	if b, err := os.ReadFile(path); err == nil {
		var f cacheFile
		if json.Unmarshal(b, &f) == nil && f.Version == discoveryCacheVersion && f.Entries != nil {
			c.data = f
		}
	}
	return c
}

// Get returns a copy of the entry for key.
func (c *DiscoveryCache) Get(key string) (CacheEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.data.Entries[key]
	if !ok {
		return CacheEntry{}, false
	}
	return copyEntry(e), true
}

func copyEntry(e *CacheEntry) CacheEntry {
	out := *e
	out.Models = append([]ai.ModelInfo(nil), e.Models...)
	if e.Dropped != nil {
		out.Dropped = map[string][]string{}
		for k, v := range e.Dropped {
			out.Dropped[k] = append([]string(nil), v...)
		}
	}
	return out
}

func (c *DiscoveryCache) entry(key string) *CacheEntry {
	e := c.data.Entries[key]
	if e == nil {
		e = &CacheEntry{}
		c.data.Entries[key] = e
	}
	return e
}

// PutModels stores a successful listing.
func (c *DiscoveryCache) PutModels(key, providerKey, baseURL, version string, models []ai.ModelInfo) {
	c.mu.Lock()
	e := c.entry(key)
	e.Provider, e.BaseURL, e.Version = providerKey, baseURL, version
	e.Models = append([]ai.ModelInfo(nil), models...)
	e.FetchedAt = c.clock.Now().UnixMilli()
	e.Error, e.ErrorAt = "", 0
	c.saveLocked()
	c.mu.Unlock()
}

// PutError records a failed listing (the models stay).
func (c *DiscoveryCache) PutError(key, providerKey, baseURL, msg string) {
	c.mu.Lock()
	e := c.entry(key)
	e.Provider, e.BaseURL = providerKey, baseURL
	e.Error, e.ErrorAt = msg, c.clock.Now().UnixMilli()
	c.saveLocked()
	c.mu.Unlock()
}

// DroppedParams implements ParamFacts.
func (c *DiscoveryCache) DroppedParams(key, model string) map[string]bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := map[string]bool{}
	if e := c.data.Entries[key]; e != nil {
		for _, p := range e.Dropped[model] {
			out[p] = true
		}
	}
	return out
}

// RecordDroppedParam implements ParamFacts.
func (c *DiscoveryCache) RecordDroppedParam(key, model, param string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.entry(key)
	if e.Dropped == nil {
		e.Dropped = map[string][]string{}
	}
	for _, p := range e.Dropped[model] {
		if p == param {
			return
		}
	}
	e.Dropped[model] = append(e.Dropped[model], param)
	c.saveLocked()
}

func (c *DiscoveryCache) saveLocked() {
	if c.path == "" {
		return
	}
	data, err := json.MarshalIndent(c.data, "", "  ")
	if err != nil {
		return
	}
	suffix := make([]byte, 6)
	_, _ = rand.Read(suffix)
	tmp := filepath.Join(filepath.Dir(c.path), "."+filepath.Base(c.path)+".tmp-"+hex.EncodeToString(suffix))
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return
	}
	if err := os.Rename(tmp, c.path); err != nil {
		_ = os.Remove(tmp)
	}
}

// DiscoverRequest describes one discovery call.
type DiscoverRequest struct {
	CacheKey    string
	ProviderKey string
	BaseURL     string
	Configured  string // configured model ("" = none)
	Kind        string // KindOpenAI | KindOllama | KindAnthropic | "claudecode"
	Refresh     bool
	MaxAge      time.Duration // 0 = DefaultDiscoveryMaxAge
	Version     string        // Claude Code CLI version; a change invalidates the cache
	List        func(ctx context.Context) ([]ai.ModelInfo, error)
	Scrub       Scrubber
}

// Discover returns the model list, from cache when fresh, else from the
// provider. On error it returns the last cached list plus Error; it never
// fails.
func Discover(ctx context.Context, cache *DiscoveryCache, r DiscoverRequest) ai.ModelDiscovery {
	maxAge := r.MaxAge
	if maxAge <= 0 {
		maxAge = DefaultDiscoveryMaxAge
	}
	out := ai.ModelDiscovery{Provider: r.ProviderKey, BaseURL: r.BaseURL, ConfiguredModel: r.Configured, Version: r.Version}
	cached, hasCache := cache.Get(r.CacheKey)
	fresh := hasCache && cached.FetchedAt > 0 && cached.Version == r.Version &&
		cache.clock.Now().Sub(time.UnixMilli(cached.FetchedAt)) < maxAge
	if fresh && !r.Refresh {
		out.Models, out.FetchedAt, out.FromCache = cached.Models, cached.FetchedAt, true
	} else {
		models, err := r.List(ctx)
		if err != nil && errors.Is(ctx.Err(), context.Canceled) {
			// Stopped by the caller (the composer's Stop during the check
			// before a run, UX P4): nothing is known about the endpoint, so
			// nothing is cached.
			out.Error, out.ErrorCode = "The check was stopped.", ai.CodeCancelled
			if hasCache {
				out.Models, out.FetchedAt, out.FromCache = cached.Models, cached.FetchedAt, true
			}
		} else if err != nil {
			msg := r.Scrub.Scrub(err.Error())
			code := ""
			var pe *Error
			if errors.As(err, &pe) {
				code = pe.Code
			}
			if pe != nil && pe.Message != "" {
				// transportError's words: host:port and the cause
				msg = r.Scrub.Scrub(pe.Message)
			} else if errors.Is(err, context.DeadlineExceeded) {
				// A dial that hangs (a firewall dropping packets, a closed
				// port behind some NATs) ends here, not as "refused" (UX A-19).
				msg = fmt.Sprintf("No answer from %s in time (model discovery timed out). The AI server may not be running, or a firewall drops the connection; check the URL in the AI settings.", hostPort(r.BaseURL))
				code = ai.CodeTimeout
			}
			cache.PutError(r.CacheKey, r.ProviderKey, r.BaseURL, msg)
			out.Error, out.ErrorCode = msg, code
			if hasCache {
				out.Models, out.FetchedAt, out.FromCache = cached.Models, cached.FetchedAt, true
			}
		} else {
			cache.PutModels(r.CacheKey, r.ProviderKey, r.BaseURL, r.Version, models)
			out.Models, out.FetchedAt = models, cache.clock.Now().UnixMilli()
		}
	}
	if out.Models == nil {
		out.Models = []ai.ModelInfo{}
	}
	eff, missing, notice := ResolveModel(r.Kind, r.Configured, out.Models)
	out.EffectiveModel, out.ModelMissing = eff, missing
	if notice != "" {
		out.Warnings = append(out.Warnings, notice)
	}
	for _, m := range out.Models {
		if m.ID == eff && m.Tools == ai.CapNo {
			out.Warnings = append(out.Warnings, fmt.Sprintf("%s does not support tools; LDAP tools will not work with this model.", eff))
		}
	}
	return out
}

// ResolveModel picks the model to use. A configured model that is listed
// is used as is. If it disappeared (or none is configured), the provider
// default applies: Ollama → the first tools-capable model; Anthropic →
// claude-opus-5-5; Claude Code → "default"; others → the first listed
// model. An empty list keeps the configured model (nothing to verify).
func ResolveModel(kind, configured string, models []ai.ModelInfo) (effective string, missing bool, notice string) {
	if len(models) == 0 {
		return configured, false, ""
	}
	if configured != "" {
		for _, m := range models {
			if m.ID == configured || m.ID == configured+":latest" || strings.TrimSuffix(m.ID, ":latest") == configured {
				return m.ID, false, ""
			}
		}
	}
	pick := ""
	switch kind {
	case KindOllama, "openai/ollama":
		for _, m := range models {
			if m.Tools == ai.CapYes && !m.Remote {
				pick = m.ID
				break
			}
		}
		if pick == "" {
			for _, m := range models {
				if m.Tools == ai.CapYes {
					pick = m.ID
					break
				}
			}
		}
	case KindAnthropic:
		for _, m := range models {
			if m.ID == defaultAnthropicModel {
				pick = m.ID
			}
		}
	case "claudecode":
		for _, m := range models {
			if m.ID == "default" {
				pick = m.ID
			}
		}
	}
	if pick == "" {
		sorted := append([]ai.ModelInfo(nil), models...)
		sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Default && !sorted[j].Default })
		pick = sorted[0].ID
	}
	if configured == "" {
		return pick, false, ""
	}
	return pick, true, fmt.Sprintf("The configured model %q is no longer available; using %q.", configured, pick)
}
