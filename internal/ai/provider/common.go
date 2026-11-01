package provider

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

// Options configure a provider instance.
type Options struct {
	Kind            string // KindOpenAI | KindOllama | KindAnthropic
	Flavor          string // OpenAI-compatible flavor
	BaseURL         string
	APIKey          string
	AnthropicAuth   string // "x-api-key" (default) | "bearer"
	TLSSkipVerify   bool
	RequestTimeout  time.Duration // remote response-header timeout (0 = 120 s)
	KeepAlive       string        // Ollama keep_alive ("" = 30m)
	ToolCallIDStyle string        // "" auto | "openai" | "alnum9"
	Concurrency     int           // endpoint limit (0 = auto)
	ContextWindow   int           // config override (0 = auto)

	Clock      ai.Clock
	Limiters   *Limiters
	Params     ParamFacts
	HTTPClient *http.Client // tests; nil = NewHTTPClient
}

// CacheKey identifies a provider endpoint in caches: kind|flavor|baseURL.
func CacheKey(kind, flavor, baseURL string) string {
	return kind + "|" + flavor + "|" + strings.TrimRight(baseURL, "/")
}

// ProviderKey returns the Producer key for kind/flavor.
func ProviderKey(kind, flavor string) string {
	if kind == KindOpenAI {
		if flavor == "" {
			flavor = FlavorCustom
		}
		return KindOpenAI + "/" + flavor
	}
	return kind
}

// New creates a provider wrapped with the harness retry policy.
func New(o Options) (Provider, error) {
	p, err := NewUnwrapped(o)
	if err != nil {
		return nil, err
	}
	return WithRetry(p, o.Clock), nil
}

// NewUnwrapped creates a provider without the retry wrapper.
func NewUnwrapped(o Options) (Provider, error) {
	if o.Clock == nil {
		o.Clock = ai.SystemClock()
	}
	if o.Limiters == nil {
		o.Limiters = DefaultLimiters
	}
	if o.Params == nil {
		o.Params = NewMemoryParamFacts()
	}
	if strings.TrimSpace(o.BaseURL) == "" {
		return nil, &Error{Code: ai.CodeConfigMissing, Message: "No AI provider URL is configured."}
	}
	o.BaseURL = strings.TrimRight(strings.TrimSpace(o.BaseURL), "/")
	switch o.Kind {
	case KindOpenAI:
		if o.Flavor == "" {
			o.Flavor = FlavorCustom
		}
		return newOpenAI(o), nil
	case KindOllama:
		o.BaseURL = strings.TrimRight(strings.TrimSuffix(o.BaseURL, "/v1"), "/")
		return newOllama(o), nil
	case KindAnthropic:
		return newAnthropic(o)
	}
	return nil, &Error{Code: ai.CodeConfigMissing, Message: fmt.Sprintf("Unknown AI provider %q.", o.Kind)}
}

// common holds what every adapter shares.
type common struct {
	opts     Options
	http     httpBase
	key      string // provider key
	cacheKey string

	mu        sync.Mutex
	caps      map[string]Caps   // model → caps from discovery
	listed    []ai.ModelInfo    // last successful listing
	respModel map[string]string // requested model → model named in responses
}

func newCommon(o Options) common {
	client := o.HTTPClient
	if client == nil {
		client = NewHTTPClient(HTTPOptions{BaseURL: o.BaseURL, TLSSkipVerify: o.TLSSkipVerify, RequestTimeout: o.RequestTimeout})
	}
	return common{
		opts:      o,
		http:      httpBase{baseURL: o.BaseURL, client: client, clock: o.Clock, scrub: NewScrubber(o.APIKey), loop: ai.IsLoopbackURL(o.BaseURL)},
		key:       ProviderKey(o.Kind, o.Flavor),
		cacheKey:  CacheKey(o.Kind, o.Flavor, o.BaseURL),
		caps:      map[string]Caps{},
		respModel: map[string]string{},
	}
}

func (c *common) Key() string { return c.key }

// limit returns the endpoint concurrency limit.
func (c *common) limit() int {
	if c.opts.Concurrency > 0 {
		return c.opts.Concurrency
	}
	if c.http.loop && (c.opts.Kind == KindOllama || c.opts.Flavor == FlavorOllama || isOllamaPort(c.opts.BaseURL)) {
		return 1
	}
	return 4
}

// acquire takes an endpoint slot, emitting a queued status while waiting.
func (c *common) acquire(ctx context.Context, sink func(Event)) (func(), error) {
	return c.opts.Limiters.Acquire(ctx, endpointKey(c.opts.BaseURL), c.limit(), func() {
		sink(Event{Kind: EvStatus, Status: &Status{Kind: ai.StatusQueued, Message: "Waiting for the model (another chat is using it)"}})
	})
}

func (c *common) storeModels(models []ai.ModelInfo, toCaps func(ai.ModelInfo) Caps) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.listed = append([]ai.ModelInfo(nil), models...)
	for _, m := range models {
		caps := toCaps(m)
		caps.Listed = true
		c.caps[m.ID] = caps
	}
}

func (c *common) cachedCaps(model string) (Caps, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	caps, ok := c.caps[model]
	return caps, ok
}

func (c *common) noteResponseModel(requested, reported string) {
	if reported == "" {
		return
	}
	c.mu.Lock()
	c.respModel[requested] = reported
	c.mu.Unlock()
}

// currentProducer returns the Producer value for thinking replay: the
// model as named in this provider's responses for the requested model.
func (c *common) currentProducer(requested string) string {
	c.mu.Lock()
	m := c.respModel[requested]
	c.mu.Unlock()
	if m == "" {
		m = requested
	}
	return Producer(c.key, m)
}

// knownThinker reports whether cached caps say the model thinks.
func (c *common) knownThinker(model string) bool {
	caps, ok := c.cachedCaps(model)
	return ok && caps.Thinking == ai.CapYes
}

// capsFromInfo converts discovered model info to caps.
func capsFromInfo(m ai.ModelInfo, source string, override int) Caps {
	caps := Caps{
		ContextWindow: m.ContextWindow,
		MaxContext:    m.ContextWindow,
		MaxOutput:     m.MaxOutput,
		Tools:         nz(m.Tools),
		Vision:        nz(m.Vision),
		Thinking:      nz(m.Thinking),
		ThinkingModes: m.ThinkingModes,
		EffortLevels:  m.EffortLevels,
		Source:        source,
		Remote:        m.Remote,
	}
	if m.ContextSource != "" {
		caps.Source = m.ContextSource
	}
	if override > 0 {
		caps.ContextWindow = override
		caps.Source = "config"
	}
	return caps
}

func nz(s string) string {
	if s == "" {
		return ai.CapUnknown
	}
	return s
}

// defaultCaps are used when nothing is known about a model.
func defaultCaps(override int) Caps {
	c := Caps{ContextWindow: 8192, Tools: ai.CapUnknown, Vision: ai.CapUnknown, Thinking: ai.CapUnknown, Source: "default"}
	if override > 0 {
		c.ContextWindow, c.Source = override, "config"
	}
	return c
}

// listedModels returns the last listing (nil if none).
func (c *common) listedModels() []ai.ModelInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]ai.ModelInfo(nil), c.listed...)
}
