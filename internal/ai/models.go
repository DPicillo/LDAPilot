package ai

// Tri-state capability values used by ModelInfo and provider capabilities.
const (
	CapYes     = "yes"
	CapNo      = "no"
	CapUnknown = "unknown"
)

// ModelInfo describes one model offered by a provider or engine.
type ModelInfo struct {
	ID            string `json:"id"` // value to configure (Claude Code: the --model value, e.g. "sonnet")
	DisplayName   string `json:"displayName"`
	ContextWindow int    `json:"contextWindow"` // maximum context the model supports (0 = unknown)
	MaxOutput     int    `json:"maxOutput"`     // 0 = unknown
	Tools         string `json:"tools"`         // "yes" | "no" | "unknown" (unknown = unverified, assumed yes)
	Vision        string `json:"vision"`
	Thinking      string `json:"thinking"`
	Family        string `json:"family,omitempty"`
	ParamSize     string `json:"paramSize,omitempty"`
	Note          string `json:"note,omitempty"`
	Remote        bool   `json:"remote"` // runs elsewhere although the endpoint is local (Ollama cloud models)

	// Optional details (shown when present).
	ResolvedModel  string   `json:"resolvedModel,omitempty"`  // Claude Code: alias → model ID
	Description    string   `json:"description,omitempty"`    // Claude Code
	ThinkingModes  []string `json:"thinkingModes,omitempty"`  // e.g. adaptive, between_tools, disabled, enabled; Ollama: false, true, low…
	EffortLevels   []string `json:"effortLevels,omitempty"`   // e.g. low … max
	LoadedContext  int      `json:"loadedContext,omitempty"`  // Ollama: context of the currently loaded instance
	ConfiguredCtx  int      `json:"configuredCtx,omitempty"`  // Ollama: num_ctx from the Modelfile
	Default        bool     `json:"default,omitempty"`        // the provider's default model
	ContextSource  string   `json:"contextSource,omitempty"`  // where ContextWindow came from
	ToolsVerified  bool     `json:"toolsVerified,omitempty"`  // Tools came from the provider, not assumed
	SupportsEffort bool     `json:"supportsEffort,omitempty"` // Claude Code / Anthropic
}

// ModelDiscovery is the result of a model listing for one provider config.
type ModelDiscovery struct {
	Provider  string      `json:"provider"` // provider key, e.g. "ollama", "openai/litellm", "anthropic", "claudecode"
	BaseURL   string      `json:"baseUrl"`
	Models    []ModelInfo `json:"models"`
	FetchedAt int64       `json:"fetchedAt"` // unix ms of the last successful fetch
	FromCache bool        `json:"fromCache"`
	Error     string      `json:"error,omitempty"` // discovery error; Models is then the last cached list
	// ErrorCode classifies Error for AIService.CheckProvider
	// (provider_unreachable / timeout = the endpoint did not answer;
	// auth_failed, bad_request, … = it answered). Not sent to the UI.
	ErrorCode string   `json:"-"`
	Warnings  []string `json:"warnings,omitempty"`

	ConfiguredModel string `json:"configuredModel,omitempty"`
	EffectiveModel  string `json:"effectiveModel,omitempty"` // the model that will be used (fallback applied)
	ModelMissing    bool   `json:"modelMissing,omitempty"`   // the configured model is not in Models
	Version         string `json:"version,omitempty"`        // Claude Code CLI version
}

// ProviderTestResult is returned by the settings "Test" action.
type ProviderTestResult struct {
	OK            bool     `json:"ok"`
	LatencyMs     int64    `json:"latencyMs"`
	ModelFound    bool     `json:"modelFound"`
	Tools         string   `json:"tools"`
	ContextWindow int      `json:"contextWindow"`
	Local         bool     `json:"local"`
	Message       string   `json:"message"`
	Warnings      []string `json:"warnings,omitempty"`
}
