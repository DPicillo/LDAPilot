package services

import (
	"context"
	"errors"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/agent"
	"github.com/dpicillo/LDAPilot/internal/ai/chatstore"
	"github.com/dpicillo/LDAPilot/internal/ai/claudecode"
	"github.com/dpicillo/LDAPilot/internal/ai/ldaptools"
	"github.com/dpicillo/LDAPilot/internal/ai/permission"
	"github.com/dpicillo/LDAPilot/internal/ai/provider"
	"github.com/dpicillo/LDAPilot/internal/config"
	internalldap "github.com/dpicillo/LDAPilot/internal/ldap"
)

// AIService is the Wails facade of the AI harness (§3.4). It owns the
// encrypted chat store and the run manager; all harness logic lives in
// internal/ai. Errors returned to JS are "<code>: <message>".
type AIService struct {
	ctx         context.Context
	pool        *internalldap.Pool
	configStore *config.AIConfigStore
	chatStore   *config.ChatStore
	auditStore  *config.AuditStore

	models       aiModels
	emitter      func(name string, payload any) // tests; nil = Wails runtime.EventsEmit
	autoDiscover bool                           // set by SetContext: background discovery on config changes

	store    *chatstore.Store
	storeErr string
	mgr      *agent.Manager
	dir      ldaptools.Directory
	initOnce sync.Once
	// providerOverride replaces the provider factory (tests).
	providerOverride agent.ProviderFactory
	// ccLauncher and ccFindCLI replace the Claude Code CLI (tests).
	ccLauncher claudecode.Launcher
	ccFindCLI  func(explicit string) (string, error)
}

// aiError is a facade error: "<code>: <message>"; it unwraps to the
// chatstore sentinel for invalid IDs.
type aiError struct {
	code, msg string
	cause     error
}

func (e *aiError) Error() string { return e.code + ": " + e.msg }
func (e *aiError) Unwrap() error { return e.cause }

// Code returns the error code.
func (e *aiError) Code() string { return e.code }

func facadeErr(err error) error {
	if err == nil {
		return nil
	}
	var ae *aiError
	if errors.As(err, &ae) {
		return ae
	}
	err = agent.MapStoreError(err)
	var e *agent.Error
	if errors.As(err, &e) {
		out := &aiError{code: e.Code, msg: e.Message}
		switch e.Code {
		case ai.CodeInvalidChatID:
			out.cause = chatstore.ErrInvalidChatID
		case ai.CodeStoreReadOnly:
			out.cause = chatstore.ErrReadOnly
		case "not_found":
			out.cause = chatstore.ErrNotFound
		}
		return out
	}
	msg := provider.NewScrubber().Scrub(err.Error())
	return &aiError{code: ai.CodeInternal, msg: msg, cause: err}
}

func invalidID() error {
	return &aiError{code: ai.CodeInvalidChatID, msg: "invalid chat ID", cause: chatstore.ErrInvalidChatID}
}

// NewAIService creates the AI facade. The encrypted chat store is opened
// on chatStore's directory (legacy plaintext chats are migrated there);
// when that fails, chats run in degraded mode and settings keep working.
func NewAIService(pool *internalldap.Pool, configStore *config.AIConfigStore, chatStore *config.ChatStore) *AIService {
	s := &AIService{pool: pool, configStore: configStore, chatStore: chatStore}
	s.configStore.Subscribe(func(c config.AIConfig) {
		s.emit(ai.EventConfigUpdated, ai.ConfigUpdatedEvent{Revision: c.Revision})
		if s.mgr != nil {
			s.mgr.ConfigChanged()
		}
	})
	return s
}

// SetAuditStore wires the audit log for AI writes ("via AI") and access
// grants (AI_ACCESS).
func (s *AIService) SetAuditStore(store *config.AuditStore) { s.auditStore = store }

// ensure opens the chat store and creates the manager once.
func (s *AIService) ensure() {
	s.initOnce.Do(func() {
		if s.chatStore != nil {
			st, err := chatstore.Open(s.chatStore.Dir(), chatstore.Options{Logf: log.Printf})
			if err != nil {
				s.storeErr = err.Error()
				log.Printf("AI chats unavailable: %v", err)
			} else {
				s.store = st
			}
		} else {
			s.storeErr = "No chat directory is configured."
		}
		if s.dir == nil && s.pool != nil {
			dir := newAIDirectory(s.pool, ai.SystemClock())
			dir.audit = func(profileID, op, dn, details string, err error) {
				writeAudit(s.auditStore, s.pool, profileID, op, dn, details, err)
			}
			s.dir = dir
		}
		providers := s.providerOverride
		if providers == nil {
			providers = agent.ProviderFunc(func(cfg config.AIConfig) (provider.Provider, error) {
				return provider.New(s.providerOptions(cfg, cfg.APIKey))
			})
		}
		s.mgr = agent.NewManager(agent.Deps{Emitter: facadeEmitter{s}, Directory: s.dir, Auditor: &aiAuditor{s}, Store: s.store,
			StoreErr: s.storeErr, Providers: providers, Config: &configSource{s}, SensitiveAttr: isSensitiveAttribute, Logf: log.Printf,
			ClaudeCode: s.claudeCodeEnv()})
	})
}

// SetContext installs the Wails context, recovers interrupted AI writes
// (outcome unknown) and starts loopback-only model discovery.
func (s *AIService) SetContext(ctx context.Context) {
	s.ctx = ctx
	s.autoDiscover = true
	s.ensure()
	if dir, err := config.ConfigDir(); err == nil {
		// Run files (MCP config with its token, system prompt) of runs a
		// crash or kill left behind (§11 a).
		claudecode.CleanRunFiles(filepath.Join(dir, claudeCodeFilesDir), 10*time.Minute)
	}
	if n := s.mgr.Recover(); n > 0 {
		log.Printf("AI: %d interrupted write(s) marked as outcome unknown", n)
	}
	if s.store != nil {
		// Chats created and never used in earlier sessions (older than an
		// hour, so another window's fresh chat is never touched).
		if n := s.store.PruneEmpty(time.Now().Add(-time.Hour).UnixMilli()); n > 0 {
			log.Printf("AI: %d unused empty chat(s) removed", n)
		}
	}
	s.backgroundDiscovery(true)
}

// Shutdown stops runs (waiting ≤ 2 s) and releases the chat store lock.
// Correctness never depends on it (§3.6).
func (s *AIService) Shutdown() {
	if s.mgr != nil {
		s.mgr.Shutdown()
	}
	if s.store != nil {
		s.store.Close()
	}
}

// --- configuration ---

// GetAIConfig returns the current AI configuration (API key masked).
func (s *AIService) GetAIConfig() config.AIConfig {
	return s.configStore.GetMasked()
}

// SaveAIConfig validates and saves the AI configuration (API key encrypted
// at rest). A config without "version" comes from the legacy settings form
// (provider/url/apiKey/model only) and is merged into the stored v2 config.
func (s *AIService) SaveAIConfig(cfg config.AIConfig) error {
	before := s.configStore.GetMasked()
	if cfg.Version == 0 {
		m := config.MigrateLegacyAIConfig(cfg.Provider, cfg.URL, cfg.Model)
		if m.Provider == "openai" && before.Provider == "openai" && strings.EqualFold(strings.TrimSpace(cfg.Provider), "openai") {
			// The legacy form shows every OpenAI-compatible flavor as
			// "openai"; saving it back must not turn LiteLLM into OpenAI
			// (that would also drop the stored key).
			m.Flavor = before.Flavor
		}
		merged := before
		merged.Provider, merged.Flavor, merged.URL, merged.Model = m.Provider, m.Flavor, m.URL, m.Model
		merged.APIKey = cfg.APIKey
		cfg = merged
	}
	if err := s.configStore.Set(cfg); err != nil {
		return err
	}
	if endpointChanged(before, s.configStore.GetMasked()) {
		s.backgroundDiscovery(false)
	}
	return nil
}

// SetConnectionAccess sets one profile's AI access level (none, ask, read,
// write). With a remote provider the level is bound to its host (§6.1).
func (s *AIService) SetConnectionAccess(profileID, level string) error {
	if strings.TrimSpace(profileID) == "" {
		return &aiError{code: ai.CodeBadRequest, msg: "profile ID is required"}
	}
	cfg := s.configStore.Get()
	dest := permission.Classify(cfg, false)
	bind := ""
	if !dest.Local && (level == config.AccessRead || level == config.AccessWrite) {
		bind = dest.Host
	}
	if _, err := s.configStore.SetConnectionAccess(profileID, level, bind); err != nil {
		return &aiError{code: ai.CodeBadRequest, msg: err.Error()}
	}
	return nil
}

// GetBuiltinRedactions lists the built-in secret attributes (read-only in
// the settings).
func (s *AIService) GetBuiltinRedactions() []string { return ldaptools.BuiltinSecretNames() }

// TestProvider checks an unsaved config (never persisted): reachability,
// latency, the model, tool support, the context window and locality.
func (s *AIService) TestProvider(cfg config.AIConfig) (ai.ProviderTestResult, error) {
	if cfg.Engine == "claudecode" {
		// `claude --version` plus the free initialize request: no model
		// call, no cost.
		start := time.Now()
		d, err := s.DiscoverModels(cfg, true)
		if err != nil {
			return ai.ProviderTestResult{}, err
		}
		msg := d.Error
		if msg == "" {
			msg = fmt.Sprintf("Claude Code %s answered in %d ms with %s (checked without a model call).", firstNonEmptyStr(d.Version, "(unknown version)"),
				time.Since(start).Milliseconds(), ldaptools.Plural(len(d.Models), "model", "models"))
		}
		return ai.ProviderTestResult{OK: d.Error == "", LatencyMs: time.Since(start).Milliseconds(), ModelFound: !d.ModelMissing, Tools: ai.CapYes,
			Message: msg, Warnings: d.Warnings}, nil
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
		return ai.ProviderTestResult{}, err
	}
	p, err := provider.NewUnwrapped(s.providerOptions(norm, key))
	if err != nil {
		return ai.ProviderTestResult{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), discoveryCallLimit)
	defer cancel()
	start := time.Now()
	models, err := p.ListModels(ctx)
	res := ai.ProviderTestResult{LatencyMs: time.Since(start).Milliseconds(), Tools: ai.CapUnknown}
	if err != nil {
		res.Message = provider.NewScrubber(key).Scrub(err.Error())
		return res, nil
	}
	res.OK = true
	model := norm.Model
	for _, m := range models {
		if m.ID == model {
			res.ModelFound = true
		}
	}
	if model == "" && len(models) > 0 {
		model, _, _ = provider.ResolveModel(p.Key(), "", models)
		res.Warnings = append(res.Warnings, "No model selected; "+model+" would be used.")
		res.ModelFound = true
	}
	caps, _ := p.ModelCaps(ctx, model)
	res.Tools, res.ContextWindow = caps.Tools, caps.ContextWindow
	res.Local = permission.Classify(norm, caps.Remote).Local
	if norm.Provider == provider.KindOpenAI && norm.Flavor == provider.FlavorOllama {
		if rt, ok := provider.AsOllamaRuntime(p); ok {
			if n, loaded, err := rt.LoadedContext(ctx, model); err == nil && loaded {
				res.ContextWindow = n
				if n < 16384 {
					res.Warnings = append(res.Warnings, fmt.Sprintf("Ollama /v1 uses the model's loaded context (%d tokens); use the 'Ollama (native)' preset for 16k+.", n))
				}
			}
		}
	}
	if caps.Tools == ai.CapNo {
		res.Warnings = append(res.Warnings, "LDAP tools will not work with this model.")
	}
	if !res.ModelFound {
		res.Message = fmt.Sprintf("Connected (%s), but the model %q was not found.", ldaptools.Plural(len(models), "model", "models"), model)
	} else {
		res.Message = fmt.Sprintf("Connected in %d ms; %s available.", res.LatencyMs, ldaptools.Plural(len(models), "model", "models"))
	}
	return res, nil
}

func firstNonEmptyStr(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

// --- chats ---

func (s *AIService) chats() (*chatstore.Store, error) {
	s.ensure()
	if s.store == nil {
		return nil, &aiError{code: ai.CodeStoreUnavailable, msg: firstNonEmptyStr(s.storeErr, "Chats are unavailable.")}
	}
	return s.store, nil
}

// ListChats returns all chats, most recently updated first.
func (s *AIService) ListChats() ([]ai.ChatSummary, error) {
	st, err := s.chats()
	if err != nil {
		return nil, err
	}
	list, err := st.List()
	if err != nil {
		return nil, facadeErr(err)
	}
	for i := range list {
		list[i].Running = s.mgr.Running(list[i].ID)
	}
	return list, nil
}

// GetChat returns a chat with all messages.
func (s *AIService) GetChat(id string) (*ai.ChatView, error) {
	if chatstore.ValidateID(id) != nil {
		return nil, invalidID()
	}
	st, err := s.chats()
	if err != nil {
		return nil, err
	}
	c, err := st.Get(id)
	if err != nil {
		return nil, facadeErr(err)
	}
	v := &ai.ChatView{ChatSummary: c.Summary(), ModelOverride: c.ModelOverride, Messages: c.Messages, Compactions: c.Compactions, Egress: c.Egress, ReadOnly: st.ReadOnly()}
	v.Running = s.mgr.Running(id)
	if v.Messages == nil {
		v.Messages = []ai.Message{}
	}
	if v.Compactions == nil {
		v.Compactions = []ai.CompactionMarker{}
	}
	if v.Egress == nil {
		v.Egress = []ai.EgressRecord{}
	}
	return v, nil
}

// GetChatEgress returns the chat's "directory data sent" ledger, live while
// a response runs (the chat info popover refreshes it after each tool
// result).
func (s *AIService) GetChatEgress(id string) ([]ai.EgressRecord, error) {
	if chatstore.ValidateID(id) != nil {
		return nil, invalidID()
	}
	if _, err := s.chats(); err != nil {
		return nil, err
	}
	out, err := s.mgr.Egress(id)
	if err != nil {
		return nil, facadeErr(err)
	}
	return out, nil
}

// GetMessages returns the messages after sinceMessageID ("" = all).
func (s *AIService) GetMessages(chatID, sinceMessageID string) ([]ai.Message, error) {
	if chatstore.ValidateID(chatID) != nil {
		return nil, invalidID()
	}
	st, err := s.chats()
	if err != nil {
		return nil, err
	}
	msgs, err := st.Messages(chatID, sinceMessageID)
	if err != nil {
		return nil, facadeErr(err)
	}
	if msgs == nil {
		msgs = []ai.Message{}
	}
	return msgs, nil
}

// CreateChat creates an empty chat.
func (s *AIService) CreateChat(title string) (*ai.ChatSummary, error) {
	st, err := s.chats()
	if err != nil {
		return nil, err
	}
	c, err := st.Create(title)
	if err != nil {
		return nil, facadeErr(err)
	}
	sum := c.Summary()
	return &sum, nil
}

// DeleteChat stops the chat's run, waits for finalization and deletes it.
// The ID must be a canonical UUID, so no path outside the chats directory
// can be addressed.
func (s *AIService) DeleteChat(id string) error {
	if chatstore.ValidateID(id) != nil {
		return invalidID()
	}
	if _, err := s.chats(); err != nil {
		return err
	}
	return facadeErr(s.mgr.DeleteChat(id))
}

// DeleteChatLater hides a chat for the Undo time of the chat list (A-07);
// DeleteChat then deletes it, RestoreChat undoes it. LDAPilot deletes chats
// still waiting when it quits (or at the next start after a crash).
func (s *AIService) DeleteChatLater(id string) error {
	if chatstore.ValidateID(id) != nil {
		return invalidID()
	}
	if _, err := s.chats(); err != nil {
		return err
	}
	return facadeErr(s.mgr.DeleteChatLater(id))
}

// RestoreChat undoes DeleteChatLater (not_found: already deleted).
func (s *AIService) RestoreChat(id string) error {
	if chatstore.ValidateID(id) != nil {
		return invalidID()
	}
	if _, err := s.chats(); err != nil {
		return err
	}
	return facadeErr(s.mgr.RestoreChat(id))
}

// RenameChat sets a user title (never replaced by generated titles).
func (s *AIService) RenameChat(id string, title string) error {
	if chatstore.ValidateID(id) != nil {
		return invalidID()
	}
	st, err := s.chats()
	if err != nil {
		return err
	}
	if err := st.Rename(id, title); err != nil {
		return facadeErr(err)
	}
	if c, err := st.Get(id); err == nil {
		s.emit(ai.EventChatUpdated, ai.ChatUpdatedEvent{ChatID: id, Title: c.Title, UpdatedAt: c.UpdatedAt})
	}
	return nil
}

// SetChatModel sets a per-chat model ("" = the configured model).
func (s *AIService) SetChatModel(id string, model string) error {
	if chatstore.ValidateID(id) != nil {
		return invalidID()
	}
	st, err := s.chats()
	if err != nil {
		return err
	}
	model = strings.TrimSpace(model)
	return facadeErr(st.Update(id, func(c *chatstore.Chat) error {
		if c.ModelOverride != model {
			c.ModelOverride = model
			c.Calibration = nil // k resets on a model change (§7.1)
		}
		return nil
	}))
}

// ExportChatMarkdown renders the transcript without hidden blocks.
func (s *AIService) ExportChatMarkdown(id string) (string, error) {
	if chatstore.ValidateID(id) != nil {
		return "", invalidID()
	}
	st, err := s.chats()
	if err != nil {
		return "", err
	}
	c, err := st.Get(id)
	if err != nil {
		return "", facadeErr(err)
	}
	return exportMarkdown(c), nil
}

func exportMarkdown(c *chatstore.Chat) string {
	var b strings.Builder
	// The chat store already masked passwords typed into older chats (and
	// the answers that repeated them); the title is masked again here for
	// chats passed in directly.
	fmt.Fprintf(&b, "# %s\n\n", ai.MaskPasswords(c.Title))
	names := map[string]string{}
	for _, m := range c.Messages {
		for _, blk := range m.Blocks {
			if blk.Type == ai.BlockToolUse {
				names[blk.ID] = blk.Name
			}
		}
	}
	for _, m := range c.Messages {
		var parts []string
		for _, blk := range m.Blocks {
			switch blk.Type {
			case ai.BlockText:
				if blk.Meta != nil && (blk.Meta.Kind == "context" || blk.Meta.Kind == "summary") {
					continue
				}
				if strings.TrimSpace(blk.Text) != "" {
					t := blk.Text
					if m.Role == ai.RoleUser {
						t = ai.MaskPasswords(t)
					}
					parts = append(parts, t)
				}
			case ai.BlockToolUse:
				parts = append(parts, fmt.Sprintf("*Tool call: `%s` %s*", blk.Name, string(blk.Input)))
			case ai.BlockToolResult:
				sum := ""
				if blk.Meta != nil {
					sum = blk.Meta.Summary
				}
				parts = append(parts, fmt.Sprintf("*Result of `%s`: %s*", names[blk.ToolUseID], sum))
			}
		}
		if len(parts) == 0 {
			continue
		}
		who := "User"
		if m.Role == ai.RoleAssistant {
			who = "Assistant"
		}
		fmt.Fprintf(&b, "## %s (%s)\n\n%s\n\n", who, time.UnixMilli(m.CreatedAt).UTC().Format(time.RFC3339), strings.Join(parts, "\n\n"))
	}
	return b.String()
}

// GetGrants returns the active "approve for this chat" grants.
func (s *AIService) GetGrants(chatID string) ([]ai.Grant, error) {
	s.ensure()
	gs, err := s.mgr.Grants(chatID)
	return gs, facadeErr(err)
}

// RevokeGrant removes a grant.
func (s *AIService) RevokeGrant(chatID, grantID string) error {
	s.ensure()
	return facadeErr(s.mgr.RevokeGrant(chatID, grantID))
}

// --- runs ---

// legacyChatWait bounds the blocking legacy Chat call.
const legacyChatWait = 30 * time.Minute

// Chat is the legacy blocking call: SendMessage, then wait for the run to
// finish and return the final answer text. Approvals still go through the
// UI events.
func (s *AIService) Chat(chatID string, message string) (string, error) {
	if chatstore.ValidateID(chatID) != nil {
		return "", invalidID()
	}
	res, err := s.SendMessage(ai.SendRequest{ChatID: chatID, Text: message})
	if err != nil {
		return "", err
	}
	if !s.mgr.Wait(chatID, legacyChatWait) {
		return "", &aiError{code: ai.CodeTimeout, msg: "the response did not finish in time"}
	}
	msgs, err := s.store.Messages(chatID, res.UserMessageID)
	if err != nil {
		return "", facadeErr(err)
	}
	var text string
	var rerr *ai.RunError
	for _, m := range msgs {
		if m.Role != ai.RoleAssistant {
			continue
		}
		if m.Error != nil {
			rerr = m.Error
		}
		var parts []string
		for _, b := range m.Blocks {
			if b.Type == ai.BlockText && strings.TrimSpace(b.Text) != "" && (b.Meta == nil || b.Meta.Kind == "") {
				parts = append(parts, b.Text)
			}
		}
		if len(parts) > 0 {
			text = strings.Join(parts, "\n\n")
		}
	}
	if text == "" && rerr != nil {
		return "", &aiError{code: rerr.Code, msg: rerr.Message}
	}
	return text, nil
}

// SendMessage persists the user message and starts a run.
func (s *AIService) SendMessage(req ai.SendRequest) (ai.SendResult, error) {
	if chatstore.ValidateID(req.ChatID) != nil {
		return ai.SendResult{}, invalidID()
	}
	if _, err := s.chats(); err != nil {
		return ai.SendResult{}, err
	}
	r, err := s.mgr.Send(req)
	return r, facadeErr(err)
}

// ContinueRun continues after step_limit or truncated.
func (s *AIService) ContinueRun(chatID string, ui ai.UIContext) (ai.SendResult, error) {
	if _, err := s.chats(); err != nil {
		return ai.SendResult{}, err
	}
	r, err := s.mgr.Continue(chatID, ui)
	return r, facadeErr(err)
}

// RegenerateLast runs the last user turn again.
func (s *AIService) RegenerateLast(chatID string, ui ai.UIContext) (ai.SendResult, error) {
	if _, err := s.chats(); err != nil {
		return ai.SendResult{}, err
	}
	r, err := s.mgr.Regenerate(chatID, ui)
	return r, facadeErr(err)
}

// EditLastUserMessage replaces the last user message and runs again.
func (s *AIService) EditLastUserMessage(chatID string, text string, ui ai.UIContext) (ai.SendResult, error) {
	if _, err := s.chats(); err != nil {
		return ai.SendResult{}, err
	}
	r, err := s.mgr.EditLast(chatID, text, ui)
	return r, facadeErr(err)
}

// CompactChat summarizes older turns (/compact).
func (s *AIService) CompactChat(chatID string) (ai.SendResult, error) {
	if _, err := s.chats(); err != nil {
		return ai.SendResult{}, err
	}
	r, err := s.mgr.Compact(chatID)
	return r, facadeErr(err)
}

// StopRun stops the chat's run; it returns at once (finalization is
// asynchronous).
func (s *AIService) StopRun(chatID string) error {
	s.ensure()
	return facadeErr(s.mgr.Stop(chatID))
}

// RespondApproval answers an approval or access request.
func (s *AIService) RespondApproval(approvalID, decision, note string) (ai.ApprovalResult, error) {
	s.ensure()
	r, err := s.mgr.Respond(approvalID, decision, note)
	if err != nil {
		return r, &aiError{code: ai.CodeBadRequest, msg: err.Error()}
	}
	return r, nil
}

// RevealSecret returns a generated password once (§6.7).
func (s *AIService) RevealSecret(toolCallID string) (ai.SecretValue, error) {
	s.ensure()
	v, err := s.mgr.RevealSecret(toolCallID)
	if err != nil {
		return v, &aiError{code: "secret_gone", msg: err.Error()}
	}
	return v, nil
}

// GetRunState returns the running run of a chat (nil when idle).
func (s *AIService) GetRunState(chatID string) (*ai.RunSnapshot, error) {
	s.ensure()
	r, err := s.mgr.RunState(chatID)
	return r, facadeErr(err)
}

// GetContextInfo returns the context budget of a chat.
func (s *AIService) GetContextInfo(chatID string) (ai.ContextInfo, error) {
	if _, err := s.chats(); err != nil {
		return ai.ContextInfo{}, err
	}
	ci, err := s.mgr.ContextInfo(chatID)
	return ci, facadeErr(err)
}
