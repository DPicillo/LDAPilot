// Package agent runs LDAPilot's built-in AI harness: the run manager
// (per-chat runs without a global lock, cancellation, ordering), the agent
// loop (§3.8), the tool executor with permission gates and approvals
// (§6), the system prompt and per-turn context block (§9) and the secrets
// vault for generated passwords (§6.7).
package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/chatstore"
	"github.com/dpicillo/LDAPilot/internal/ai/ldaptools"
	"github.com/dpicillo/LDAPilot/internal/ai/permission"
	"github.com/dpicillo/LDAPilot/internal/ai/provider"
	"github.com/dpicillo/LDAPilot/internal/config"
)

// ProviderFactory builds the provider for a config (tests: scripted fakes).
type ProviderFactory interface {
	Provider(cfg config.AIConfig) (provider.Provider, error)
}

// ProviderFunc adapts a function to ProviderFactory.
type ProviderFunc func(cfg config.AIConfig) (provider.Provider, error)

// Provider implements ProviderFactory.
func (f ProviderFunc) Provider(cfg config.AIConfig) (provider.Provider, error) { return f(cfg) }

// ConfigSource gives the current AI config (with the decrypted API key)
// and persists "always allow read" decisions.
type ConfigSource interface {
	Current() config.AIConfig
	SetConnectionAccess(profileID, level, bindHost string) error
	// AllowReadHost lets a remote host read a profile without widening
	// write access to it (config.AIConfigStore.AllowReadHost).
	AllowReadHost(profileID, host string) error
}

// Deps are every side effect of the Manager (§3.9).
type Deps struct {
	Emitter   ai.Emitter
	Clock     ai.Clock
	IDs       ai.IDGen
	Directory ldaptools.Directory
	Auditor   ldaptools.Auditor
	Store     *chatstore.Store // nil = degraded mode (StoreError explains why)
	StoreErr  string
	Providers ProviderFactory
	Config    ConfigSource
	// SensitiveAttr is services.isSensitiveAttribute (redaction superset).
	SensitiveAttr func(string) bool
	Logf          func(format string, args ...any)
	// MaxRuns is the soft cap of concurrent runs (0 = 4).
	MaxRuns int
	// FinalizeWait bounds the wait for a stopped run (0 = 2 s).
	FinalizeWait time.Duration
	// ClaudeCode enables the Claude Code engine (nil = not available).
	ClaudeCode *ClaudeCodeEnv
}

// Error is a facade error with an ai.Code* code.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func errCode(code, format string, args ...any) error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// MaxMessageBytes is the SendMessage text limit.
const MaxMessageBytes = 64 * 1024

// Manager owns the runs.
type Manager struct {
	d        Deps
	ctx      context.Context
	cancel   context.CancelFunc
	mu       sync.Mutex
	runs     map[string]*run
	broker   *permission.Broker
	grants   *permission.Grants
	consents *permission.Consents
	vault    *Vault
	shared   *ldaptools.Shared
	wg       sync.WaitGroup

	accessAudited sync.Map // chat|profile|host → true
	ctxInfo       sync.Map // chatID → ai.ContextInfo (last run)
	ccWindows     sync.Map // Claude Code model → reported context window
}

// NewManager creates the manager.
func NewManager(d Deps) *Manager {
	if d.Clock == nil {
		d.Clock = ai.SystemClock()
	}
	if d.IDs == nil {
		d.IDs = ai.UUIDGen()
	}
	if d.Logf == nil {
		d.Logf = func(string, ...any) {}
	}
	if d.MaxRuns <= 0 {
		d.MaxRuns = 4
	}
	if d.FinalizeWait <= 0 {
		d.FinalizeWait = 2 * time.Second
	}
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{d: d, ctx: ctx, cancel: cancel, runs: map[string]*run{},
		broker: permission.NewBroker(d.Clock, d.IDs), grants: permission.NewGrants(d.Clock, d.IDs),
		consents: permission.NewConsents(), vault: NewVault(d.Clock), shared: ldaptools.NewShared(d.Clock)}
	m.grants.OnChange(func(chatID string, gs []ai.Grant) {
		m.emit(ai.EventGrantsUpdated, ai.GrantsUpdatedEvent{ChatID: chatID, Grants: gs})
	})
	return m
}

func (m *Manager) emit(name string, payload any) {
	if m.d.Emitter != nil {
		m.d.Emitter.Emit(name, payload)
	}
}

// Store returns the chat store (nil in degraded mode).
func (m *Manager) Store() *chatstore.Store { return m.d.Store }

func (m *Manager) storeErr() error {
	if m.d.Store == nil {
		msg := m.d.StoreErr
		if msg == "" {
			msg = "Chats are unavailable."
		}
		return errCode(ai.CodeStoreUnavailable, "%s", msg)
	}
	return nil
}

// MapStoreError maps chatstore errors to facade errors.
func MapStoreError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, chatstore.ErrInvalidChatID):
		return errCode(ai.CodeInvalidChatID, "invalid chat ID")
	case errors.Is(err, chatstore.ErrReadOnly):
		return errCode(ai.CodeStoreReadOnly, "%s", chatstore.ErrReadOnly.Error())
	case errors.Is(err, chatstore.ErrNotFound):
		return errCode("not_found", "chat not found")
	}
	var ue *chatstore.UnavailableError
	if errors.As(err, &ue) {
		return errCode(ai.CodeStoreUnavailable, "%s", ue.Reason)
	}
	return err
}

func (m *Manager) writable() error {
	if err := m.storeErr(); err != nil {
		return err
	}
	if m.d.Store.ReadOnly() {
		return errCode(ai.CodeStoreReadOnly, "%s", chatstore.ErrReadOnly.Error())
	}
	return nil
}

// --- run bookkeeping ---

type run struct {
	id, chatID, kind string
	ctx              context.Context
	cancel           context.CancelFunc
	started          time.Time
	em               *runEmitter
	done             chan struct{}
	ui               ai.UIContext

	mu            sync.Mutex
	status        string
	baseMessageID string
	persisted     []ai.Message
	partial       *ai.Message
	toolStatus    map[string]string
	usage         *ai.UsageEvent
	writing       int
	writeDone     chan struct{} // closed when no write is in flight
	finalMsgID    string
	finalText     string
	doneStatus    string
	contextEdited bool
	// egress is the chat's ledger as of the last tool result of this run
	// (nil until the first one); the chat store gets it with the next
	// message, the chat info reads it live (UX A-08).
	egress []ai.EgressRecord
}

func (r *run) setStatus(s string) {
	r.mu.Lock()
	r.status = s
	r.mu.Unlock()
}

// record keeps snapshot state in sync with emitted events.
func (r *run) record(name string, p ai.Enveloped) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch ev := p.(type) {
	case *ai.ToolStartEvent:
		r.toolStatus[ev.ToolCallID] = ev.Status
	case *ai.ToolUpdateEvent:
		r.toolStatus[ev.ToolCallID] = ev.Status
	case *ai.ToolEndEvent:
		r.toolStatus[ev.ToolCallID] = ev.Status
	case *ai.UsageEvent:
		u := *ev
		r.usage = &u
	}
}

// begin registers a run for chatID; it fails with run_active or busy.
func (m *Manager) begin(chatID, kind string, ui ai.UIContext) (*run, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ctx.Err() != nil {
		return nil, errCode(ai.CodeInternal, "LDAPilot is shutting down")
	}
	if _, ok := m.runs[chatID]; ok {
		return nil, errCode(ai.CodeRunActive, "a response is still running in this chat")
	}
	if len(m.runs) >= m.d.MaxRuns {
		return nil, errCode(ai.CodeBusy, "%d AI responses are already running; wait for one to finish", m.d.MaxRuns)
	}
	ctx, cancel := context.WithCancel(m.ctx)
	r := &run{id: m.d.IDs.NewID(), chatID: chatID, kind: kind, ctx: ctx, cancel: cancel, started: m.d.Clock.Now(), done: make(chan struct{}),
		ui: ui, status: ai.RunQueued, toolStatus: map[string]string{}}
	r.em = newRunEmitter(m.d.Emitter, m.d.Clock, chatID, r.id)
	r.em.onRecord = r.record
	m.runs[chatID] = r
	return r, nil
}

func (m *Manager) end(r *run) {
	m.mu.Lock()
	if m.runs[r.chatID] == r {
		delete(m.runs, r.chatID)
	}
	m.mu.Unlock()
	r.cancel()
	close(r.done)
}

func (m *Manager) runFor(chatID string) *run {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.runs[chatID]
}

// Running reports whether a chat has a run.
func (m *Manager) Running(chatID string) bool { return m.runFor(chatID) != nil }

// Egress returns the chat's "directory data sent" ledger: the running
// run's live state when it has sent tool results, else the stored one.
func (m *Manager) Egress(chatID string) ([]ai.EgressRecord, error) {
	if err := chatstore.ValidateID(chatID); err != nil {
		return nil, errCode(ai.CodeInvalidChatID, "invalid chat ID")
	}
	if r := m.runFor(chatID); r != nil {
		r.mu.Lock()
		live := append([]ai.EgressRecord(nil), r.egress...)
		r.mu.Unlock()
		if live != nil {
			return live, nil
		}
	}
	if err := m.storeErr(); err != nil {
		return nil, err
	}
	c, err := m.d.Store.Get(chatID)
	if err != nil {
		return nil, MapStoreError(err)
	}
	out := append([]ai.EgressRecord{}, c.Egress...)
	return out, nil
}

// --- public operations ---

// Send persists the user message and starts a run (§3.4).
func (m *Manager) Send(req ai.SendRequest) (ai.SendResult, error) {
	if err := chatstore.ValidateID(req.ChatID); err != nil {
		return ai.SendResult{}, errCode(ai.CodeInvalidChatID, "invalid chat ID")
	}
	if len(req.Text) > MaxMessageBytes {
		return ai.SendResult{}, errCode(ai.CodeMessageTooLarge, "The message is larger than 64 KB.")
	}
	if strings.TrimSpace(req.Text) == "" {
		return ai.SendResult{}, errCode(ai.CodeBadRequest, "The message is empty.")
	}
	if err := m.writable(); err != nil {
		return ai.SendResult{}, err
	}
	// A password typed into the message never reaches the history, the
	// chat title or the provider (the composer refuses it already; UX A-13).
	req.Text = ai.MaskPasswords(req.Text)
	r, err := m.begin(req.ChatID, ai.RunKindSend, req.UI)
	if err != nil {
		return ai.SendResult{}, err
	}
	userID := m.d.IDs.NewID()
	ui := req.UI
	msg := ai.Message{ID: userID, Role: ai.RoleUser, CreatedAt: m.d.Clock.Now().UnixMilli(), RunID: r.id, UIContext: &ui,
		Blocks: []ai.Block{{Type: ai.BlockText, Text: req.Text}}}
	if err := m.persistUserMessage(r, msg, heuristicTitle(req.Text)); err != nil {
		m.end(r)
		return ai.SendResult{}, MapStoreError(err)
	}
	m.start(r, userID, runOptions{})
	return ai.SendResult{RunID: r.id, UserMessageID: userID}, nil
}

// persistUserMessage adds the context block (when needed) and stores the
// user message before the run starts (fixes audit 2.2).
func (m *Manager) persistUserMessage(r *run, msg ai.Message, title string) error {
	var base string
	err := m.d.Store.Update(r.chatID, func(c *chatstore.Chat) error {
		if n := len(c.Messages); n > 0 {
			base = c.Messages[n-1].ID
		}
		if block, hash, ok := m.contextFor(c, r.ui); ok {
			msg.Blocks = append([]ai.Block{{Type: ai.BlockText, Text: block, Meta: &ai.BlockMeta{Kind: "context"}}}, msg.Blocks...)
			c.LastContextHash = hash
			c.LastContextAt = m.d.Clock.Now().UnixMilli()
		}
		c.Messages = append(c.Messages, msg)
		if title != "" && c.TitleSource != "user" && (len(c.Messages) == 1 || c.Title == "" || c.Title == "New chat" || c.Title == "New Chat") {
			c.Title, c.TitleSource = chatstore.CleanTitle(title), "auto"
		}
		c.PromptVersion = PromptVersion
		return nil
	})
	if err != nil {
		return err
	}
	r.mu.Lock()
	r.baseMessageID = base
	r.persisted = append(r.persisted, msg)
	r.mu.Unlock()
	return nil
}

// contextFor renders the context block for a chat if it must be sent.
func (m *Manager) contextFor(c *chatstore.Chat, ui ai.UIContext) (string, string, bool) {
	text, hash := m.contextText(c, ui)
	now := m.d.Clock.Now()
	first := true
	for _, msg := range c.Messages {
		if msg.Role == ai.RoleUser {
			first = false
			break
		}
	}
	if !needContextBlock(first, c.LastContextHash, c.LastContextAt, hash, now, ui.TimeZone) {
		return "", "", false
	}
	return text, hash, true
}

// contextText renders the context block for a chat and UI state.
func (m *Manager) contextText(c *chatstore.Chat, ui ai.UIContext) (string, string) {
	cfg := m.d.Config.Current()
	live := m.livePolicy(cfg, false)
	conns := m.ctxConns(c.ID, live, cfg)
	return contextBlock(m.d.Clock.Now(), ui.TimeZone, m.filterUI(ui, conns), conns, live.AllowWrites())
}

// filterUI removes UI context that belongs to connections the model may
// not see (§6.1): none-level profiles, selected entries before consent.
func (m *Manager) filterUI(ui ai.UIContext, conns []ctxConn) ai.UIContext {
	ok := map[string]bool{}
	for _, c := range conns {
		ok[c.conn.Info.ProfileID] = true
	}
	out := ui
	if !ok[ui.ActiveProfileID] {
		out.ActiveProfileID = ""
	}
	if !ok[ui.SelectedProfileID] {
		out.SelectedProfileID, out.SelectedDN = "", ""
	}
	out.Mentions = nil
	for _, mn := range ui.Mentions {
		if ok[mn.ProfileID] {
			out.Mentions = append(out.Mentions, mn)
		}
	}
	return out
}

// ctxConns lists the connections visible to the model with their levels.
func (m *Manager) ctxConns(chatID string, live *permission.Live, cfg config.AIConfig) []ctxConn {
	var out []ctxConn
	if m.d.Directory == nil {
		return nil
	}
	pol := permission.FromConfig(cfg)
	for _, c := range ldaptools.LabelConnections(m.d.Directory.Connections()) {
		lvl, needs := effectiveLevel(live, m.consents, chatID, c.Info.ProfileID)
		if lvl == permission.LevelNone {
			continue
		}
		cc := ctxConn{conn: c, level: lvl, needsConsent: needs, note: cfg.ConnectionNotes[c.Info.ProfileID]}
		if lvl != permission.LevelWrite && !live.Dest.Local && cfg.AllowWrites && pol.Configured(c.Info.ProfileID) == permission.LevelWrite {
			cc.writeHost = live.Dest.Host
		}
		out = append(out, cc)
	}
	return out
}

// livePolicy builds the live policy for a config; modelRemote marks an
// Ollama cloud model.
func (m *Manager) livePolicy(cfg config.AIConfig, modelRemote bool) *permission.Live {
	return &permission.Live{Start: permission.FromConfig(cfg), Current: func() *permission.Policy {
		return permission.FromConfig(m.d.Config.Current())
	}, Dest: permission.Classify(cfg, modelRemote)}
}

// Continue starts a run after step_limit or truncated (§3.8).
func (m *Manager) Continue(chatID string, ui ai.UIContext) (ai.SendResult, error) {
	if err := chatstore.ValidateID(chatID); err != nil {
		return ai.SendResult{}, errCode(ai.CodeInvalidChatID, "invalid chat ID")
	}
	if err := m.writable(); err != nil {
		return ai.SendResult{}, err
	}
	r, err := m.begin(chatID, ai.RunKindContinue, ui)
	if err != nil {
		return ai.SendResult{}, err
	}
	userID := m.d.IDs.NewID()
	msg := ai.Message{ID: userID, Role: ai.RoleUser, CreatedAt: m.d.Clock.Now().UnixMilli(), RunID: r.id, UIContext: &ui,
		Blocks: []ai.Block{{Type: ai.BlockText, Text: ContinueText, Meta: &ai.BlockMeta{Kind: "continue"}}}}
	if err := m.persistUserMessage(r, msg, ""); err != nil {
		m.end(r)
		return ai.SendResult{}, MapStoreError(err)
	}
	m.start(r, userID, runOptions{})
	return ai.SendResult{RunID: r.id, UserMessageID: userID}, nil
}

// ContinueText is the model-facing user message of ContinueRun. It says
// what "continue" means, because small models read a bare "Continue." after
// a STEP_LIMIT result as a refusal they have to explain.
const ContinueText = "Continue where you stopped. You have a new step budget: run the tool calls that were not executed (STEP_LIMIT) again if they are still needed, then finish the answer."

// Regenerate removes the last answer and runs the last user turn again.
func (m *Manager) Regenerate(chatID string, ui ai.UIContext) (ai.SendResult, error) {
	return m.rewind(chatID, ui, ai.RunKindRegenerate, nil)
}

// EditLast replaces the text of the last user message and runs again.
func (m *Manager) EditLast(chatID, text string, ui ai.UIContext) (ai.SendResult, error) {
	if len(text) > MaxMessageBytes {
		return ai.SendResult{}, errCode(ai.CodeMessageTooLarge, "The message is larger than 64 KB.")
	}
	if strings.TrimSpace(text) == "" {
		return ai.SendResult{}, errCode(ai.CodeBadRequest, "The message is empty.")
	}
	text = ai.MaskPasswords(text)
	return m.rewind(chatID, ui, ai.RunKindEdit, &text)
}

func (m *Manager) rewind(chatID string, ui ai.UIContext, kind string, newText *string) (ai.SendResult, error) {
	if err := chatstore.ValidateID(chatID); err != nil {
		return ai.SendResult{}, errCode(ai.CodeInvalidChatID, "invalid chat ID")
	}
	if err := m.writable(); err != nil {
		return ai.SendResult{}, err
	}
	r, err := m.begin(chatID, kind, ui)
	if err != nil {
		return ai.SendResult{}, err
	}
	var userID, base string
	var userMsg ai.Message
	err = m.d.Store.Update(chatID, func(c *chatstore.Chat) error {
		idx := -1
		for i := len(c.Messages) - 1; i >= 0; i-- {
			if c.Messages[i].Role == ai.RoleUser && hasUserText(c.Messages[i]) {
				idx = i
				break
			}
		}
		if idx < 0 {
			return errCode(ai.CodeBadRequest, "There is no user message to run again.")
		}
		for _, msg := range c.Messages[idx:] {
			for _, b := range msg.Blocks {
				if b.Type == ai.BlockToolUse && b.Meta != nil && b.Meta.Kind == "write" && b.Meta.Approval != nil && b.Meta.Approval.Decision != ai.ResolvedDenied {
					return errCode(ai.CodeBadRequest, "The last turn changed the directory; send a new message instead of regenerating it.")
				}
			}
		}
		um := c.Messages[idx]
		if newText != nil {
			var blocks []ai.Block
			replaced := false
			for _, b := range um.Blocks {
				if b.Type == ai.BlockText && (b.Meta == nil || b.Meta.Kind == "") && !replaced {
					b.Text = *newText
					replaced = true
				}
				if b.Type == ai.BlockText && (b.Meta == nil || b.Meta.Kind == "") && replaced && b.Text != *newText {
					continue
				}
				blocks = append(blocks, b)
			}
			um.Blocks = blocks
		}
		um.RunID = r.id
		// Render the hidden context block again: access levels, consent
		// or the selection may have changed since the message was sent.
		var kept []ai.Block
		hadCtx := false
		for _, b := range um.Blocks {
			if b.Type == ai.BlockText && b.Meta != nil && b.Meta.Kind == "context" {
				hadCtx = true
				continue
			}
			kept = append(kept, b)
		}
		um.Blocks = kept
		c.Messages = c.Messages[:idx]
		block, hash, ok := m.contextFor(c, ui)
		if hadCtx && !ok {
			block, hash = m.contextText(c, ui)
			ok = true
		}
		if ok {
			um.Blocks = append([]ai.Block{{Type: ai.BlockText, Text: block, Meta: &ai.BlockMeta{Kind: "context"}}}, um.Blocks...)
			c.LastContextHash, c.LastContextAt = hash, m.d.Clock.Now().UnixMilli()
		}
		c.Messages = append(c.Messages, um)
		if idx > 0 {
			base = c.Messages[idx-1].ID
		}
		userID, userMsg = um.ID, um
		return nil
	})
	if err != nil {
		m.end(r)
		var fe *Error
		if errors.As(err, &fe) {
			return ai.SendResult{}, fe
		}
		return ai.SendResult{}, MapStoreError(err)
	}
	r.mu.Lock()
	r.baseMessageID = base
	r.persisted = []ai.Message{userMsg}
	r.mu.Unlock()
	m.start(r, userID, runOptions{})
	return ai.SendResult{RunID: r.id, UserMessageID: userID}, nil
}

func hasUserText(msg ai.Message) bool {
	for _, b := range msg.Blocks {
		if b.Type == ai.BlockText && (b.Meta == nil || b.Meta.Kind == "") {
			return true
		}
	}
	return false
}

// Compact runs a manual /compact (keepTurns = 1).
func (m *Manager) Compact(chatID string) (ai.SendResult, error) {
	if err := chatstore.ValidateID(chatID); err != nil {
		return ai.SendResult{}, errCode(ai.CodeInvalidChatID, "invalid chat ID")
	}
	if err := m.writable(); err != nil {
		return ai.SendResult{}, err
	}
	r, err := m.begin(chatID, ai.RunKindCompact, ai.UIContext{})
	if err != nil {
		return ai.SendResult{}, err
	}
	m.start(r, "", runOptions{compactOnly: true})
	return ai.SendResult{RunID: r.id}, nil
}

// Stop cancels the chat's run and returns at once; finalization is
// asynchronous (§3.6).
func (m *Manager) Stop(chatID string) error {
	if err := chatstore.ValidateID(chatID); err != nil {
		return errCode(ai.CodeInvalidChatID, "invalid chat ID")
	}
	r := m.runFor(chatID)
	if r == nil {
		return nil
	}
	r.cancel()
	m.broker.CancelRun(r.id)
	return nil
}

// Wait blocks until the chat's run (if any) has finished or the timeout
// passed; it reports whether the run finished.
func (m *Manager) Wait(chatID string, timeout time.Duration) bool {
	r := m.runFor(chatID)
	if r == nil {
		return true
	}
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case <-r.done:
		return true
	case <-t.C:
		return false
	}
}

// waitBound is the finalization wait: 2 s, or the profile timeout + 2 s
// while a write is in flight.
func (m *Manager) waitBound(r *run) time.Duration {
	r.mu.Lock()
	writing := r.writing > 0
	r.mu.Unlock()
	if !writing {
		return m.d.FinalizeWait
	}
	return writeTimeout(nil) + m.d.FinalizeWait
}

// DeleteChat stops the run, waits for finalization and deletes the chat;
// grants, consents, caches and secrets of the chat are dropped.
func (m *Manager) DeleteChat(chatID string) error {
	if err := chatstore.ValidateID(chatID); err != nil {
		return errCode(ai.CodeInvalidChatID, "invalid chat ID")
	}
	if err := m.writable(); err != nil {
		return err
	}
	if r := m.runFor(chatID); r != nil {
		_ = m.Stop(chatID)
		m.Wait(chatID, m.waitBound(r))
	}
	err := m.d.Store.Delete(chatID)
	m.grants.Drop(chatID)
	m.consents.DropChat(chatID)
	m.vault.DropChat(chatID)
	m.shared.DropChat(chatID)
	m.ctxInfo.Delete(chatID)
	return MapStoreError(err)
}

// DeleteChatLater hides a chat for the Undo time of the chat list (A-07);
// DeleteChat deletes it for good, RestoreChat brings it back. A chat still
// waiting when LDAPilot quits is deleted then (or at the next start after a
// crash). A running chat is deleted at once.
func (m *Manager) DeleteChatLater(chatID string) error {
	if err := chatstore.ValidateID(chatID); err != nil {
		return errCode(ai.CodeInvalidChatID, "invalid chat ID")
	}
	if err := m.writable(); err != nil {
		return err
	}
	if m.runFor(chatID) != nil {
		return m.DeleteChat(chatID)
	}
	return MapStoreError(m.d.Store.DeleteLater(chatID))
}

// RestoreChat undoes DeleteChatLater; not_found when it is already deleted.
func (m *Manager) RestoreChat(chatID string) error {
	if err := chatstore.ValidateID(chatID); err != nil {
		return errCode(ai.CodeInvalidChatID, "invalid chat ID")
	}
	if err := m.writable(); err != nil {
		return err
	}
	return MapStoreError(m.d.Store.Restore(chatID))
}

// Respond applies a user decision to a pending approval. A password typed
// into the note of a denial is removed before the note reaches the model
// and the history (UX A-13; the card removes it as well).
func (m *Manager) Respond(approvalID, decision, note string) (ai.ApprovalResult, error) {
	return m.broker.Respond(approvalID, decision, ai.MaskPasswordsAll(note))
}

// RevealSecret returns a generated password once.
func (m *Manager) RevealSecret(toolCallID string) (ai.SecretValue, error) {
	return m.vault.Reveal(toolCallID)
}

// Grants returns the active grants of a chat.
func (m *Manager) Grants(chatID string) ([]ai.Grant, error) {
	if err := chatstore.ValidateID(chatID); err != nil {
		return nil, errCode(ai.CodeInvalidChatID, "invalid chat ID")
	}
	return m.grants.List(chatID), nil
}

// RevokeGrant removes a grant.
func (m *Manager) RevokeGrant(chatID, grantID string) error {
	if err := chatstore.ValidateID(chatID); err != nil {
		return errCode(ai.CodeInvalidChatID, "invalid chat ID")
	}
	return m.grants.Revoke(chatID, grantID)
}

// ConfigChanged re-checks pending approvals against the new policy.
func (m *Manager) ConfigChanged() { m.broker.Recheck() }

// PendingApprovals returns the number of pending approval requests.
func (m *Manager) PendingApprovals() int { return m.broker.Count() }

// RunState returns the snapshot of a chat's run (nil when idle).
func (m *Manager) RunState(chatID string) (*ai.RunSnapshot, error) {
	if err := chatstore.ValidateID(chatID); err != nil {
		return nil, errCode(ai.CodeInvalidChatID, "invalid chat ID")
	}
	r := m.runFor(chatID)
	if r == nil {
		return nil, nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	snap := &ai.RunSnapshot{ChatID: chatID, RunID: r.id, Status: r.status, Kind: r.kind, StartedAt: r.started.UnixMilli(),
		LastSeq: r.em.LastSeq(), BaseMessageID: r.baseMessageID, Messages: append([]ai.Message{}, r.persisted...),
		PendingApprovals: m.broker.Pending(chatID), ToolStatus: map[string]string{}, Usage: r.usage}
	for k, v := range r.toolStatus {
		snap.ToolStatus[k] = v
	}
	if r.partial != nil {
		p := *r.partial
		p.Blocks = append([]ai.Block{}, r.partial.Blocks...)
		snap.Partial = &p
	}
	if snap.PendingApprovals == nil {
		snap.PendingApprovals = []ai.ApprovalRequest{}
	}
	return snap, nil
}

// ContextInfo returns the last known context budget of a chat.
func (m *Manager) ContextInfo(chatID string) (ai.ContextInfo, error) {
	if err := chatstore.ValidateID(chatID); err != nil {
		return ai.ContextInfo{}, errCode(ai.CodeInvalidChatID, "invalid chat ID")
	}
	if v, ok := m.ctxInfo.Load(chatID); ok {
		return v.(ai.ContextInfo), nil
	}
	return m.estimateContext(chatID)
}

// Shutdown cancels all runs and waits up to 2 s for finalization.
func (m *Manager) Shutdown() {
	m.cancel()
	m.mu.Lock()
	for _, r := range m.runs {
		m.broker.CancelRun(r.id)
	}
	m.mu.Unlock()
	done := make(chan struct{})
	go func() { m.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(m.d.FinalizeWait):
	}
	m.vault.Clear()
}
