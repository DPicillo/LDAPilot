package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/chatstore"
	"github.com/dpicillo/LDAPilot/internal/ai/contextmgr"
	"github.com/dpicillo/LDAPilot/internal/ai/ldaptools"
	"github.com/dpicillo/LDAPilot/internal/ai/permission"
	"github.com/dpicillo/LDAPilot/internal/ai/provider"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
	"github.com/dpicillo/LDAPilot/internal/config"
)

type runOptions struct {
	compactOnly bool
}

const (
	nudgeText         = "Answer the user's last request using the tool results above."
	firstNudgeText    = "Answer the user's last request; call the tools if you need directory data."
	emptyAnswerNotice = "The model returned an empty answer."
	truncatedNotice   = "The model used its whole output budget (probably for reasoning). Raise 'max output tokens' or choose a lower thinking level."
	compactThreshold  = 0.70
	// The title names the topic, not the first answer's outcome: titles such
	// as "Samba AD User Creation Successful" went stale as the chat moved on
	// (UX area A, S4).
	titlePrompt = "Write a 3–6 word title for this conversation in its language. Name what the user asked about (the task or the question), not its outcome: no words like successful, done, completed or updated. Reply with the title only."
	// retitleTurn: after this many user messages a model-written title is
	// written once more from all of them, so it covers the whole chat.
	retitleTurn        = 3
	truncationV1Notice = "Ollama's OpenAI-compatible endpoint cut the conversation to fit its context window (often 4096 tokens), so the model did not see LDAPilot's instructions. Use the 'Ollama (native)' preset, or a model whose num_ctx is large enough (16k+)."
)

func (m *Manager) start(r *run, userMsgID string, o runOptions) {
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		s := &loopState{m: m, r: r, opts: o, userMsgID: userMsgID}
		status, rerr := s.run()
		s.finalize(status, rerr)
	}()
}

// loopState is the state of one run of the built-in engine.
type loopState struct {
	m         *Manager
	r         *run
	opts      runOptions
	userMsgID string

	cfg         config.AIConfig
	prov        provider.Provider
	providerKey string
	model       string
	caps        provider.Caps
	budget      contextmgr.Budget
	live        *permission.Live
	sess        *ldaptools.Session
	specs       []tools.Spec
	offered     map[string]ldaptools.Tool
	x           *executor
	ollamaV1    bool

	history     []ai.Message
	compactions []ai.CompactionMarker
	calib       *ai.Calibration
	egress      map[string]*ai.EgressRecord

	steps, calls  int
	totals        ai.Usage
	emptyRetried  bool
	compactedOnce bool
	modelRetried  bool
	lastActual    int
	suspect       bool
	finalMsgID    string
	finalText     string
	canContinue   bool
	contextEdited bool
	firstRun      bool
	// retitle: this run's chat gets its model-written title again (retitleTurn).
	retitle bool
	// rawOverhead is the uncalibrated estimate of the system prompt and
	// tool schemas; the budget holds it scaled by the calibration factor.
	rawOverhead int
	// respModel is the model the provider named in its last response
	// (thinking blocks are stamped with it, §4.4).
	respModel string
	// started is set once ai:run_started was emitted; statuses before it
	// (e.g. the model fallback warning) wait in preStart (§3.5 ordering).
	started  bool
	preStart []*ai.StatusEvent
	// announcedModel is the model ai:run_started named (the configured one;
	// discovery may replace it after the announcement).
	announcedModel string

	// hmu guards history and the run's chat-store writes against the
	// concurrent MCP handlers of the Claude Code engine.
	hmu sync.Mutex
	// actualModel is the model the engine reports (Claude Code init).
	actualModel atomic.Pointer[string]
	cc          *ccRun
}

// auditModel is the model named in audit entries.
func (s *loopState) auditModel() string {
	if m := s.actualModel.Load(); m != nil && *m != "" {
		return *m
	}
	return s.model
}

func (s *loopState) now() time.Time { return s.m.d.Clock.Now() }

func (s *loopState) emit(name string, p ai.Enveloped) { s.r.em.Emit(name, p) }

func (s *loopState) status(kind, msg string) {
	ev := &ai.StatusEvent{Kind: kind, Message: msg}
	if !s.started {
		s.preStart = append(s.preStart, ev)
		return
	}
	s.emit(ai.EventStatus, ev)
}

func runErr(code, format string, args ...any) *ai.RunError {
	return &ai.RunError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// --- setup ---

// setup prepares the run without contacting the provider (chat, config,
// provider client, configured model); setupProvider does the rest. The run
// is announced between the two (UX P4): model discovery or a dial to an
// unreachable endpoint can take 10–15 s, and before ai:run_started the chat
// had no Stop button and Esc did nothing.
func (s *loopState) setup() *ai.RunError {
	m := s.m
	s.cfg = m.d.Config.Current()
	chat, err := m.d.Store.Get(s.r.chatID)
	if err != nil {
		return runErr(ai.CodeInternal, "%v", MapStoreError(err))
	}
	s.history = chat.Messages
	s.compactions = chat.Compactions
	s.calib = chat.Calibration
	s.egress = map[string]*ai.EgressRecord{}
	for i := range chat.Egress {
		e := chat.Egress[i]
		s.egress[e.ProfileID+"|"+e.ProviderHost] = &e
	}
	userTurns := 0
	for _, msg := range chat.Messages {
		if msg.Role == ai.RoleUser && hasUserText(msg) {
			userTurns++
		}
	}
	s.firstRun = userTurns == 1 && chat.TitleSource == "auto"
	// also when the first title could not be written (source still "auto")
	s.retitle = userTurns == retitleTurn && chat.TitleSource != "user"
	if s.cfg.Engine == EngineClaudeCode {
		return s.setupClaudeCode(chat)
	}
	if s.cfg.Provider == "" {
		return runErr(ai.CodeConfigMissing, "No AI provider is configured. Open the AI settings to choose one.")
	}
	s.model = chat.ModelOverride
	if s.model == "" {
		s.model = s.cfg.Model
	}
	prov, err := m.d.Providers.Provider(s.cfg)
	if err != nil {
		return provider.AsRunError(err)
	}
	s.prov = prov
	s.providerKey = prov.Key()
	s.announcedModel = s.model
	return nil
}

// setupProvider is the part of the setup that talks to the provider: model
// discovery when no model is configured, the model's capabilities and
// context window. It runs after ai:run_started, so Stop cancels it.
func (s *loopState) setupProvider() *ai.RunError {
	if s.cc != nil || s.prov == nil {
		return nil // Claude Code: set up completely by setup()
	}
	prov := s.prov
	if s.model == "" {
		models, err := prov.ListModels(s.r.ctx)
		if err != nil && provider.IsReachabilityError(err) {
			return provider.AsRunError(err)
		}
		if err == nil && len(models) > 0 {
			eff, _, _ := provider.ResolveModel(prov.Key(), "", models)
			s.model = eff
		}
	}
	if s.model == "" {
		return runErr(ai.CodeConfigMissing, "No model is configured. Choose a model in the AI settings.")
	}
	return s.configureModel(true)
}

// ollamaKind reports Ollama (native or /v1), where cloud models run remotely.
func (s *loopState) ollamaKind() bool {
	k := s.prov.Key()
	return k == provider.KindOllama || k == provider.ProviderKey(provider.KindOpenAI, provider.FlavorOllama)
}

// configureModel derives caps, the live policy, the tools and the budget
// for s.model. With checkMissing, a model that is not in the provider's
// listing falls back like discovery does (§4.5), also when a context
// window is configured.
func (s *loopState) configureModel(checkMissing bool) *ai.RunError {
	m, prov := s.m, s.prov
	caps, err := prov.ModelCaps(s.r.ctx, s.model)
	if err == nil && checkMissing && !caps.Listed && caps.Source != "table" {
		if models, lerr := prov.ListModels(s.r.ctx); lerr == nil && len(models) > 0 {
			if eff, missing, notice := provider.ResolveModel(prov.Key(), s.model, models); missing && eff != "" && eff != s.model {
				s.status(ai.StatusWarning, firstNonEmpty(notice, "The configured model "+s.model+" is not available; using "+eff+"."))
				s.model = eff
				caps, err = prov.ModelCaps(s.r.ctx, s.model)
			}
		}
	}
	if err != nil {
		if provider.IsReachabilityError(err) {
			return provider.AsRunError(err)
		}
		caps = provider.Caps{ContextWindow: 8192, Tools: ai.CapUnknown, Thinking: ai.CapUnknown, Source: "default"}
	}
	if s.ollamaKind() && provider.IsCloudModel(s.model) {
		caps.Remote = true // fail closed when the listing could not say so (§6.8)
	}
	s.caps = caps
	if caps.Tools == ai.CapNo {
		s.status(ai.StatusWarning, "This model does not support tools; LDAP tools will not work with it.")
	}
	s.live = m.livePolicy(s.cfg, caps.Remote)
	s.specs, s.offered = nil, nil
	s.buildTools()
	window, source := caps.ContextWindow, caps.Source
	s.ollamaV1 = prov.Kind() == provider.KindOpenAI && (s.cfg.Flavor == provider.FlavorOllama || strings.Contains(s.cfg.URL, ":11434"))
	if s.ollamaV1 && s.cfg.ContextWindow == 0 {
		window, source = s.preflightOllamaV1()
	}
	s.rawOverhead = contextmgr.EstimateText(SystemPrompt) + contextmgr.EstimateTools(s.specs)
	k := contextmgr.Factor(s.calib, s.providerKey, s.model)
	overhead := int(float64(s.rawOverhead) * k)
	if prov.Kind() == provider.KindOllama && s.cfg.ContextWindow == 0 && source != "config" {
		// Native Ollama sends num_ctx = budget.Window: grow the automatic
		// 16k window as far as the offered tools need (test-1 D2).
		if w := contextmgr.AutoWindow(window, caps.MaxContext, caps, s.cfg.MaxOutputTokens, overhead); w != window {
			window, source = w, "auto, sized for the tools"
		}
	}
	s.budget = contextmgr.Compute(window, source, caps, s.cfg.MaxOutputTokens, overhead)
	if s.budget.TooSmall() {
		s.storeContextInfo(0)
		return runErr(ai.CodeContextTooSmall, "%s", s.budget.TooSmallMessage())
	}
	return nil
}

// preflightOllamaV1 reads the effective window of Ollama's /v1 endpoint:
// the loaded context from /api/ps (loading the model first), else the
// Modelfile num_ctx, else 4096 (§4.2).
func (s *loopState) preflightOllamaV1() (int, string) {
	rt, ok := provider.AsOllamaRuntime(s.prov)
	if !ok {
		return 4096, "default"
	}
	ctx, cancel := context.WithTimeout(s.r.ctx, 5*time.Minute)
	defer cancel()
	// An instance loaded by a native request may run with another num_ctx;
	// a /v1 request uses the model's default options and makes Ollama
	// reload it. Loading with the default options first (a no-op when they
	// already match) makes /api/ps report the window /v1 will really use.
	if _, loaded, err := rt.LoadedContext(ctx, s.model); err != nil || !loaded {
		s.status(ai.StatusModelLoading, "Loading the model…")
	}
	if err := rt.LoadModel(ctx, s.model, s.cfg.OllamaKeepAlive); err == nil {
		if n, loaded, err := rt.LoadedContext(ctx, s.model); err == nil && loaded && n > 0 {
			return n, "api/ps"
		}
	}
	if _, configured, err := rt.ModelContext(ctx, s.model); err == nil && configured > 0 {
		return configured, "api/show"
	}
	return 4096, "default"
}

// buildTools fixes the offered tools and connection enums at run start.
func (s *loopState) buildTools() {
	m := s.m
	var conns []*ldaptools.Conn
	var writeLabels []string
	if m.d.Directory != nil {
		for _, c := range ldaptools.LabelConnections(m.d.Directory.Connections()) {
			lvl, _ := effectiveLevel(s.live, m.consents, s.r.chatID, c.Info.ProfileID)
			if lvl == permission.LevelNone {
				continue
			}
			conns = append(conns, c)
			// A read-only profile at level write keeps the write tools: the
			// gate answers READ_ONLY_PROFILE (§6.2 gate 3, scenario S8)
			// instead of the model guessing why no write tool exists.
			if lvl == permission.LevelWrite {
				writeLabels = append(writeLabels, c.Label)
			}
		}
	}
	s.sess = &ldaptools.Session{ChatID: s.r.chatID, RunID: s.r.id, Dir: m.d.Directory, Conns: conns, ActiveProfileID: s.r.ui.ActiveProfileID,
		Access: &accessView{live: s.live, consents: m.consents, chatID: s.r.chatID}, Shared: m.shared, Clock: m.d.Clock,
		Redact: func() ldaptools.RedactPolicy {
			return ldaptools.RedactPolicy{User: s.live.Redact(), Extra: m.d.SensitiveAttr, MaskPasswordValues: s.live.MaskPasswords()}
		}}
	readLabels := ldaptools.Labels(conns)
	s.offered = map[string]ldaptools.Tool{}
	writes := s.live.AllowWrites() && len(writeLabels) > 0
	for _, t := range ldaptools.All() {
		def := t.Def()
		if def.Kind == tools.KindWrite {
			if !writes {
				continue
			}
			s.specs = append(s.specs, def.Spec(writeLabels))
		} else {
			if def.Directory && !def.ConnectionOptional && len(conns) == 0 {
				continue
			}
			s.specs = append(s.specs, def.Spec(readLabels))
		}
		s.offered[def.Name] = t
	}
	s.x = newExecutor(s)
}

type accessView struct {
	live     *permission.Live
	consents *permission.Consents
	chatID   string
}

func (a *accessView) Level(profileID string) (string, bool) {
	return effectiveLevel(a.live, a.consents, a.chatID, profileID)
}

func (a *accessView) WritesAllowed() bool { return a.live.AllowWrites() }

// --- run ---

func (s *loopState) run() (string, *ai.RunError) {
	rerr := s.setup()
	// Announced before the provider is contacted (UX P4): the run has its
	// Stop button and Esc while discovery or the dial is still waiting.
	s.emitRunStarted()
	if rerr == nil {
		rerr = s.setupProvider()
	}
	if s.r.ctx.Err() != nil {
		// Stopped while the provider was contacted: no error card.
		return ai.RunCancelled, nil
	}
	if rerr != nil {
		return ai.RunFailed, rerr
	}
	s.r.setStatus(ai.RunRunning)
	if s.cc != nil {
		return s.runClaudeCode()
	}
	if s.opts.compactOnly {
		ok, rerr := s.compact(1, true)
		if rerr != nil {
			return ai.RunFailed, rerr
		}
		if !ok {
			s.status(ai.StatusWarning, "There is nothing to compact yet.")
			// Nothing changed: the last real token count still describes
			// the history (test-1 D4: the meter fell back to the estimate
			// and rose after a no-op /compact).
			if v, found := s.m.ctxInfo.Load(s.r.chatID); found {
				if prev := v.(ai.ContextInfo); prev.Model == s.model && prev.Provider == s.providerKey && prev.ContextWindow == s.budget.Window {
					s.lastActual = prev.LastActualTokens
				}
			}
		}
		return ai.RunCompleted, nil
	}
	maxSteps := s.cfg.MaxSteps
	if maxSteps <= 0 {
		maxSteps = config.DefaultMaxSteps
	}
	retryBudget := 0
	retriedThisStep := false
	nudge := "" // text appended to the request once after an empty answer
	for {
		if s.r.ctx.Err() != nil {
			return ai.RunCancelled, nil
		}
		if s.calls >= maxSteps+4 {
			s.canContinue = true
			return ai.RunStepLimit, nil
		}
		norm, projected, locked, rerr := s.prepareHistory()
		if rerr != nil {
			return ai.RunFailed, rerr
		}
		rawEst := s.rawEstimate(norm)
		msgs := norm.Messages
		if nudge != "" {
			msgs = appendNudge(msgs, nudge)
		}
		maxOut := s.budget.MaxOutput
		if retryBudget > 0 {
			maxOut = retryBudget
		}
		req := &provider.Request{Model: s.model, System: SystemPrompt, Messages: msgs, Tools: s.specs, MaxOutputTokens: maxOut,
			Thinking: s.cfg.Thinking, ShowThinking: !s.cfg.HideThinking, Effort: s.cfg.Effort, ContextWindow: s.budget.Window,
			TurnStartIndex: norm.TurnStartIndex}
		if s.prov.Kind() != provider.KindOllama {
			req.ContextWindow = 0
		}
		msgID := s.m.d.IDs.NewID()
		started := &ai.MessageStartedEvent{MessageID: msgID, Step: s.steps + 1}
		if s.model != s.announcedModel {
			// ai:run_started named the configured model before discovery
			// replaced it (no model configured, or a fallback, §4.5).
			started.Model = s.model
		}
		s.emit(ai.EventMessageStarted, started)
		resp, err := s.stream(msgID, req)
		s.calls++
		if err != nil {
			if s.r.ctx.Err() != nil {
				s.persistPartial(msgID, ai.StopCancelled, nil)
				return ai.RunCancelled, nil
			}
			if s.steps == 0 && !s.modelRetried && provider.AsRunError(err).Code == ai.CodeModelNotFound {
				// The model disappeared although it was listed (or a window
				// is configured): discover again and fall back once (§4.5).
				s.modelRetried = true
				if s.fallbackModel() {
					s.emit(ai.EventStepDiscarded, &ai.StepDiscardedEvent{MessageID: msgID, Reason: "model_fallback"})
					s.clearPartial()
					continue
				}
			}
			if errors.Is(err, provider.ErrContextExceeded) && !s.compactedOnce && !locked {
				s.compactedOnce = true
				s.emit(ai.EventStepDiscarded, &ai.StepDiscardedEvent{MessageID: msgID, Reason: "context_retry"})
				s.clearPartial()
				if ok, rerr := s.compact(2, false); rerr == nil && ok {
					continue
				}
			}
			rerr := provider.AsRunError(err)
			if errors.Is(err, provider.ErrContextExceeded) {
				rerr.Code = ai.CodeContextExceeded
				rerr.Message = "The conversation is too long for this model's context window. Use /compact or start a new chat."
			}
			s.persistPartial(msgID, ai.StopError, rerr)
			return ai.RunFailed, rerr
		}
		s.clearPartial()
		if resp.Model != "" {
			s.respModel = resp.Model
		}
		s.recordUsage(resp, projected, rawEst)
		blocks := resp.Message.Blocks
		for i := range blocks {
			if blocks[i].Type == ai.BlockToolUse && blocks[i].ID == "" {
				blocks[i].ID = s.m.d.IDs.NewID()
			}
		}
		asst := ai.Message{ID: msgID, Role: ai.RoleAssistant, Blocks: blocks, CreatedAt: s.now().UnixMilli(), RunID: s.r.id,
			Provider: s.providerKey, Model: firstNonEmpty(resp.Model, s.model), StopReason: resp.StopReason}
		u := resp.Usage
		asst.Usage = &u
		uses := toolUses(asst)
		visible := visibleText(asst)
		for _, w := range resp.Warnings {
			if strings.Contains(w, "salvaged") {
				continue
			}
			s.status(ai.StatusWarning, w)
		}
		retried := retriedThisStep
		retriedThisStep, retryBudget = false, 0
		nudgeWas := nudge != ""
		nudge = ""

		switch {
		case resp.StopReason == ai.StopRefusal:
			asst.Blocks = withoutToolUses(asst.Blocks)
			if resp.Refusal != "" && visible == "" {
				asst.Blocks = append(asst.Blocks, ai.Block{Type: ai.BlockText, Text: "The model declined to answer (" + resp.Refusal + ")."})
			}
			s.steps++
			if err := s.appendMessage(asst); err != nil {
				return s.storeFailure(err)
			}
			s.final(asst)
			return ai.RunRefusal, nil

		case resp.StopReason == ai.StopMaxTokens:
			if visible == "" {
				rb := min(2*maxOut, s.budget.Window-s.lastActual-s.budget.Margin)
				if s.caps.MaxOutput > 0 {
					rb = min(rb, s.caps.MaxOutput)
				}
				if rb > maxOut && !retried {
					s.emit(ai.EventStepDiscarded, &ai.StepDiscardedEvent{MessageID: msgID, Reason: "max_tokens_retry"})
					retryBudget, retriedThisStep = rb, true
					continue
				}
				s.status(ai.StatusTruncatedOutput, truncatedNotice)
				asst.Blocks = []ai.Block{{Type: ai.BlockText, Text: truncatedNotice, Meta: &ai.BlockMeta{Synthetic: true}}}
				asst.Truncated = true
				if err := s.appendMessage(asst); err != nil {
					return s.storeFailure(err)
				}
				s.final(asst)
				s.canContinue = true
				return ai.RunTruncated, nil
			}
			// Partial text: keep it, never run tools from a max_tokens step.
			asst.Blocks = withoutToolUses(asst.Blocks)
			asst.Truncated = true
			s.steps++
			if err := s.appendMessage(asst); err != nil {
				return s.storeFailure(err)
			}
			s.status(ai.StatusTruncatedOutput, "The answer was cut off at the output limit.")
			s.final(asst)
			s.canContinue = true
			return ai.RunTruncated, nil

		case resp.StopReason == ai.StopContextExceeded:
			// Anthropic model_context_window_exceeded (§4.4, §7.4 step 5):
			// never run tools from a cut-off step; compact once and retry
			// where the history may be edited, else fail.
			if !s.compactedOnce && !locked {
				s.compactedOnce = true
				s.emit(ai.EventStepDiscarded, &ai.StepDiscardedEvent{MessageID: msgID, Reason: "context_retry"})
				if ok, rerr := s.compact(2, false); rerr == nil && ok {
					continue
				}
			}
			rerr := &ai.RunError{Code: ai.CodeContextExceeded, Message: "The conversation is too long for this model's context window. Use /compact or start a new chat."}
			asst.Blocks = withoutToolUses(asst.Blocks)
			if visible != "" {
				asst.Truncated, asst.Error = true, rerr
				if err := s.appendMessage(asst); err != nil {
					return s.storeFailure(err)
				}
				s.finalMsgID = asst.ID
			}
			return ai.RunFailed, rerr

		case s.ollamaV1 && s.suspectTruncation(projected, resp):
			s.suspect = true
			if err := s.appendMessage(asst); err != nil {
				return s.storeFailure(err)
			}
			if len(uses) > 0 {
				s.x.synthetic(msgID, uses, tools.ErrContextTruncated, "Not executed: the server truncated the conversation, so the request could not be trusted.", "", ai.ToolNotExecuted)
			}
			rerr := &ai.RunError{Code: ai.CodeContextTruncated, Message: truncationV1Notice}
			s.storeContextInfo(projected)
			return ai.RunFailed, rerr

		case len(uses) > 0:
			s.steps++
			if err := s.appendMessage(asst); err != nil {
				return s.storeFailure(err)
			}
			if s.steps >= maxSteps {
				s.x.synthetic(msgID, uses, tools.ErrStepLimit, "Not executed: the step limit was reached.",
					"Summarize what you found so far; the user can press Continue.", ai.ToolNotExecuted)
				s.canContinue = true
				return ai.RunStepLimit, nil
			}
			// The next request as it will really be sent: the normalized
			// history (thinking that is not replayed does not count).
			projectedNext := s.projected(s.normalize())
			capTokens, avail := contextmgr.CallBudget(s.budget.InputBudget, projectedNext, len(uses))
			if !s.x.runBatch(msgID, uses, capTokens, avail) {
				return s.storeFailure(chatstore.ErrNotFound)
			}
			if s.r.ctx.Err() != nil {
				return ai.RunCancelled, nil
			}
			continue

		case visible == "":
			if !nudgeWas && !s.emptyRetried {
				// Retry once, after tool results and also for an empty
				// first answer (small models sometimes stop after a few
				// thinking tokens, test-1 D5).
				s.emptyRetried = true
				s.emit(ai.EventStepDiscarded, &ai.StepDiscardedEvent{MessageID: msgID, Reason: "empty_retry"})
				nudge = firstNudgeText
				if s.lastIsToolResults() {
					nudge = nudgeText
				}
				continue
			}
			asst.Blocks = append(asst.Blocks, ai.Block{Type: ai.BlockText, Text: emptyAnswerNotice, Meta: &ai.BlockMeta{Synthetic: true}})
			if err := s.appendMessage(asst); err != nil {
				return s.storeFailure(err)
			}
			s.final(asst)
			return ai.RunCompleted, nil

		default:
			s.steps++
			if resp.StopReason == ai.StopUnknown {
				s.status(ai.StatusWarning, "The server did not say why the answer ended.")
			}
			if err := s.appendMessage(asst); err != nil {
				return s.storeFailure(err)
			}
			s.final(asst)
			return ai.RunCompleted, nil
		}
	}
}

func (s *loopState) emitRunStarted() {
	s.emit(ai.EventRunStarted, &ai.RunStartedEvent{UserMessageID: s.userMsgID, Kind: s.r.kind, Engine: firstNonEmpty(s.cfg.Engine, "builtin"),
		Provider: s.providerKey, Model: s.model, StartedAt: s.r.started.UnixMilli()})
	s.started = true
	for _, ev := range s.preStart {
		s.emit(ai.EventStatus, ev)
	}
	s.preStart = nil
}

// fallbackModel re-discovers the models after model_not_found and switches
// to the provider default (§4.5). It reports whether the run can retry.
func (s *loopState) fallbackModel() bool {
	models, err := s.prov.ListModels(s.r.ctx)
	if err != nil || len(models) == 0 {
		return false
	}
	eff, missing, notice := provider.ResolveModel(s.prov.Key(), s.model, models)
	if !missing || eff == "" || eff == s.model {
		return false
	}
	s.status(ai.StatusWarning, firstNonEmpty(notice, "The configured model "+s.model+" is not available; using "+eff+"."))
	s.model = eff
	return s.configureModel(false) == nil
}

func (s *loopState) storeFailure(err error) (string, *ai.RunError) {
	if errors.Is(err, chatstore.ErrNotFound) {
		// The chat was deleted during the run: discard, never resurrect.
		return ai.RunCancelled, nil
	}
	return ai.RunFailed, runErr(ai.CodeStoreUnavailable, "%v", MapStoreError(err))
}

func (s *loopState) final(m ai.Message) {
	s.finalMsgID = m.ID
	s.finalText = visibleText(m)
}

// contextTokens is the prompt size of a step: Anthropic reports cache reads
// and writes separately from input_tokens; OpenAI-compatible servers and
// Ollama include cached tokens in prompt_tokens / prompt_eval_count.
func contextTokens(kind string, u ai.Usage) int {
	if kind == provider.KindAnthropic {
		return u.InputTokens + u.CacheReadTokens + u.CacheWriteTokens
	}
	return u.InputTokens
}

// suspectTruncation is the Ollama /v1 detector (§4.2).
func (s *loopState) suspectTruncation(projected int, resp *provider.Response) bool {
	reported := contextTokens(s.prov.Kind(), resp.Usage)
	return reported > 0 && provider.DetectV1Truncation(projected, reported)
}

func (s *loopState) lastIsToolResults() bool {
	if n := len(s.history); n > 0 {
		for _, b := range s.history[n-1].Blocks {
			if b.Type == ai.BlockToolResult {
				return true
			}
		}
	}
	return false
}

func appendNudge(msgs []ai.Message, nudgeText string) []ai.Message {
	out := append([]ai.Message(nil), msgs...)
	n := len(out)
	if n > 0 && out[n-1].Role == ai.RoleUser {
		last := out[n-1]
		last.Blocks = append(append([]ai.Block{}, last.Blocks...), ai.Block{Type: ai.BlockText, Text: nudgeText})
		out[n-1] = last
		return out
	}
	return append(out, ai.Message{Role: ai.RoleUser, Blocks: []ai.Block{{Type: ai.BlockText, Text: nudgeText}}})
}

// --- streaming ---

func (s *loopState) stream(msgID string, req *provider.Request) (*provider.Response, error) {
	s.r.mu.Lock()
	s.r.partial = &ai.Message{ID: msgID, Role: ai.RoleAssistant, RunID: s.r.id, Partial: true, Provider: s.providerKey, Model: s.model}
	s.r.mu.Unlock()
	sink := func(ev provider.Event) {
		switch ev.Kind {
		case provider.EvTextDelta:
			s.partialAppend(ev.BlockIndex, ai.BlockText, ev.Text, false)
			s.r.em.Delta(ai.EventTextDelta, msgID, ev.BlockIndex, ev.Text)
		case provider.EvThinkingDelta:
			s.partialAppend(ev.BlockIndex, ai.BlockThinking, ev.Text, false)
			s.r.em.Delta(ai.EventThinkingDelta, msgID, ev.BlockIndex, ev.Text)
		case provider.EvTextReplaced:
			s.partialAppend(ev.BlockIndex, ai.BlockText, ev.Text, true)
			s.emit(ai.EventTextReplaced, &ai.DeltaEvent{MessageID: msgID, BlockIndex: ev.BlockIndex, Text: ev.Text})
		case provider.EvStatus:
			if ev.Status != nil {
				s.emit(ai.EventStatus, &ai.StatusEvent{Kind: ev.Status.Kind, Message: ev.Status.Message, Attempt: ev.Status.Attempt, DelayMs: ev.Status.DelayMs, Param: ev.Status.Param})
			}
		case provider.EvWarning:
			if ev.Warning != "" && !strings.Contains(ev.Warning, "salvaged") {
				s.status(ai.StatusWarning, ev.Warning)
			}
		case provider.EvDiscarded:
			s.clearPartialBlocks()
			reason := ev.Reason
			if reason == "" {
				reason = "param_retry"
			}
			s.emit(ai.EventStepDiscarded, &ai.StepDiscardedEvent{MessageID: msgID, Reason: reason})
		}
	}
	resp, err := s.prov.Stream(s.r.ctx, req, sink)
	s.r.em.Flush()
	return resp, err
}

func (s *loopState) partialAppend(idx int, t ai.BlockType, text string, replace bool) {
	s.r.mu.Lock()
	defer s.r.mu.Unlock()
	p := s.r.partial
	if p == nil {
		return
	}
	for len(p.Blocks) <= idx {
		p.Blocks = append(p.Blocks, ai.Block{Type: t})
	}
	b := &p.Blocks[idx]
	b.Type = t
	switch {
	case t == ai.BlockThinking:
		b.Thinking += text
	case replace:
		b.Text = text
	default:
		b.Text += text
	}
}

func (s *loopState) clearPartialBlocks() {
	s.r.mu.Lock()
	if s.r.partial != nil {
		s.r.partial.Blocks = nil
	}
	s.r.mu.Unlock()
}

func (s *loopState) clearPartial() {
	s.r.mu.Lock()
	s.r.partial = nil
	s.r.mu.Unlock()
}

// persistPartial stores the text streamed so far (cancel, error).
func (s *loopState) persistPartial(msgID string, stop ai.StopReason, rerr *ai.RunError) {
	s.r.mu.Lock()
	p := s.r.partial
	s.r.partial = nil
	s.r.mu.Unlock()
	var blocks []ai.Block
	if p != nil {
		for _, b := range p.Blocks {
			if b.Type == ai.BlockText && strings.TrimSpace(b.Text) != "" {
				blocks = append(blocks, b)
			}
		}
	}
	if len(blocks) == 0 {
		// Nothing was streamed. Close the turn with a marker answer when
		// the history ends with a user message (the user's text or tool
		// results), so the next message never follows another user
		// message (no repair needed, §7.6), and so an error survives a
		// reload. The marker has a kind: the UI does not show its text.
		if rerr == nil && !s.endsWithUser() {
			return
		}
		blocks = []ai.Block{stopMarker(stop, rerr)}
	}
	msg := ai.Message{ID: msgID, Role: ai.RoleAssistant, Blocks: blocks, CreatedAt: s.now().UnixMilli(), RunID: s.r.id, Provider: s.providerKey,
		Model: s.model, StopReason: stop, Partial: true, Error: rerr}
	if err := s.appendMessage(msg); err == nil {
		s.finalMsgID = msg.ID
	}
}

// stopMarker is the text of an answer that ended before the model wrote
// anything (Meta.Kind "stopped" or "error").
func stopMarker(stop ai.StopReason, rerr *ai.RunError) ai.Block {
	if rerr != nil {
		return ai.Block{Type: ai.BlockText, Text: "[No answer: the request failed (" + rerr.Code + ").]", Meta: &ai.BlockMeta{Kind: "error", Synthetic: true}}
	}
	return ai.Block{Type: ai.BlockText, Text: "[The user stopped this answer before it was finished.]", Meta: &ai.BlockMeta{Kind: "stopped", Synthetic: true}}
}

func (s *loopState) endsWithUser() bool {
	s.hmu.Lock()
	defer s.hmu.Unlock()
	n := len(s.history)
	return n > 0 && s.history[n-1].Role == ai.RoleUser
}

// --- usage and context info ---

func (s *loopState) recordUsage(resp *provider.Response, projected, rawEst int) {
	u := resp.Usage
	s.totals.Add(u)
	ctxTokens := contextTokens(s.prov.Kind(), u)
	if ctxTokens > 0 {
		s.lastActual = ctxTokens
		if !(s.ollamaV1 && s.suspectTruncation(projected, resp)) {
			// k relates the actual prompt to the raw estimate (messages and
			// the fixed overhead); the overhead follows the new k (§7.1).
			s.calib = contextmgr.Calibrate(s.calib, s.providerKey, s.model, rawEst, ctxTokens)
			s.budget.Overhead = int(float64(s.rawOverhead) * contextmgr.Factor(s.calib, s.providerKey, s.model))
		}
	}
	pct := 0.0
	if s.budget.Window > 0 {
		pct = float64(ctxTokens) / float64(s.budget.Window) * 100
	}
	s.emit(ai.EventUsage, &ai.UsageEvent{Step: s.steps + 1, Usage: u, ContextTokens: ctxTokens, ContextWindow: s.budget.Window,
		ContextPercent: round1(pct), Totals: s.totals, CostUSD: u.CostUSD})
	calib := s.calib
	_ = s.m.d.Store.Update(s.r.chatID, func(c *chatstore.Chat) error {
		c.Usage.Add(u)
		c.Calibration = calib
		return nil
	})
	s.storeContextInfo(ctxTokens)
}

func round1(f float64) float64 { return float64(int(f*10+0.5)) / 10 }

func (s *loopState) storeContextInfo(actual int) {
	// Estimate what the model sees (after clearing and compaction), not the
	// whole stored transcript.
	msgs := s.history
	if s.prov != nil {
		msgs = s.normalize().Messages
	}
	// Calibrated like the projection (defect D4: after a compact-only run
	// the meter fell back to the raw estimate and rose although the
	// history shrank).
	est := int(float64(contextmgr.EstimateMessages(msgs)) * contextmgr.Factor(s.calib, s.providerKey, s.model))
	info := ai.ContextInfo{ContextWindow: s.budget.Window, MaxOutput: s.budget.MaxOutput, InputBudget: s.budget.InputBudget,
		FixedOverhead: s.budget.Overhead, EstimatedTokens: est + s.budget.Overhead, LastActualTokens: actual, AutoCompactAt: compactThreshold,
		Compactions: len(s.compactions), WindowSource: s.budget.WindowSource, Suspect: s.suspect, Model: s.model, Provider: s.providerKey,
		Breakdown: map[string]int{"system": contextmgr.EstimateText(SystemPrompt), "tools": contextmgr.EstimateTools(s.specs), "messages": est}}
	used := actual
	if used == 0 {
		used = info.EstimatedTokens
	}
	if s.budget.Window > 0 {
		info.Percent = round1(float64(used) / float64(s.budget.Window) * 100)
	}
	s.m.ctxInfo.Store(s.r.chatID, info)
}

// estimateContext computes context info without a run.
func (m *Manager) estimateContext(chatID string) (ai.ContextInfo, error) {
	if err := m.storeErr(); err != nil {
		return ai.ContextInfo{}, err
	}
	c, err := m.d.Store.Get(chatID)
	if err != nil {
		return ai.ContextInfo{}, MapStoreError(err)
	}
	msgs := c.Messages
	if n := len(c.Compactions); n > 0 {
		last := c.Compactions[n-1]
		msgs = contextmgr.Normalize(c.Messages, contextmgr.NormalizeOptions{SummaryText: last.Summary, UpToMessageID: last.UpToMessageID}).Messages
	}
	est := contextmgr.EstimateMessages(msgs)
	return ai.ContextInfo{EstimatedTokens: est, AutoCompactAt: compactThreshold, Compactions: len(c.Compactions),
		Breakdown: map[string]int{"messages": est}, WindowSource: "unknown"}, nil
}

// --- history, budget, clearing, compaction (§7.4) ---

func (s *loopState) latestSummary() (string, string) {
	if n := len(s.compactions); n > 0 {
		c := s.compactions[n-1]
		return c.Summary, c.UpToMessageID
	}
	return "", ""
}

func (s *loopState) replayThinking() bool {
	return s.prov != nil && (s.prov.Kind() == provider.KindAnthropic || s.cfg.Flavor == provider.FlavorLiteLLM && s.prov.Kind() == provider.KindOpenAI)
}

func (s *loopState) normalizeOptions() contextmgr.NormalizeOptions {
	o := contextmgr.NormalizeOptions{ReplayThinking: s.replayThinking(), TargetProducer: provider.Producer(s.providerKey, s.model)}
	if s.respModel != "" && s.respModel != s.model {
		// Thinking blocks carry the model named in the response (e.g. a
		// dated ID for an alias); the adapter makes the same mapping.
		o.TargetProducers = []string{provider.Producer(s.providerKey, s.respModel)}
	}
	s.consentOptions(&o)
	o.SummaryText, o.UpToMessageID, _ = s.visibleSummary(o.Withhold)
	return o
}

// visibleSummary returns the latest compaction summary as the current
// destination may see it: a summary that may contain data of a connection
// the destination may not see (level none, or no consent for this host) is
// replaced by a placeholder (§6.1). withheld reports the replacement.
func (s *loopState) visibleSummary(withhold func(ai.Block) (string, bool)) (text, upTo string, withheld bool) {
	n := len(s.compactions)
	if n == 0 {
		return "", "", false
	}
	c := s.compactions[n-1]
	if withhold != nil {
		for _, pid := range c.Connections {
			if reason, ok := withhold(ai.Block{Type: ai.BlockToolResult, Meta: &ai.BlockMeta{ConnectionID: pid}}); ok {
				return "[Summary of the earlier turns withheld. " + reason + "]", c.UpToMessageID, true
			}
		}
	}
	return c.Summary, c.UpToMessageID, false
}

// summaryConnections lists the profiles whose data a summary of fold may
// contain: tool calls and results in fold, connections whose label it names,
// and those of the summary it extends.
func (s *loopState) summaryConnections(fold []ai.Message, summary string, prev []string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(pid string) {
		if pid != "" && !seen[pid] {
			seen[pid] = true
			out = append(out, pid)
		}
	}
	for _, pid := range prev {
		add(pid)
	}
	for _, m := range fold {
		for _, b := range m.Blocks {
			if b.Meta != nil && (b.Type == ai.BlockToolResult || b.Type == ai.BlockToolUse) {
				add(b.Meta.ConnectionID)
			}
		}
	}
	if s.m.d.Directory != nil {
		for _, c := range ldaptools.LabelConnections(s.m.d.Directory.Connections()) {
			if c.Label != "" && strings.Contains(summary, c.Label) {
				add(c.Info.ProfileID)
			}
		}
	}
	return out
}

func (s *loopState) normalize() contextmgr.Result {
	return contextmgr.Normalize(s.history, s.normalizeOptions())
}

// consentOptions withholds earlier tool results and context blocks of
// connections the current destination may not see (§6.1): level none, or
// ask without consent for this provider host. Tightening applies at once,
// and switching from a local to a remote provider never re-sends data
// read under local consent.
func (s *loopState) consentOptions(o *contextmgr.NormalizeOptions) {
	if s.live == nil || s.m.d.Directory == nil {
		return
	}
	host := s.live.Dest.Host
	labels := map[string]string{}
	var hidden, unconsented []string
	// secrets are strings that name a connection the destination may not
	// see in a result of no connection (list_connections): the label of a
	// none connection, the base DN of any withheld one.
	var secrets []string
	for _, c := range ldaptools.LabelConnections(s.m.d.Directory.Connections()) {
		labels[c.Info.ProfileID] = c.Label
		lvl, needs := effectiveLevel(s.live, s.m.consents, s.r.chatID, c.Info.ProfileID)
		switch {
		case lvl == permission.LevelNone:
			hidden = append(hidden, quote(c.Label))
			secrets = append(secrets, c.Label, c.Info.BaseDN)
		case needs:
			unconsented = append(unconsented, quote(c.Label))
			secrets = append(secrets, c.Info.BaseDN)
		}
	}
	runMsg := s.userMsgID
	o.DropContext = func(msgID, text string) bool {
		if msgID == runMsg {
			return false // rendered for this run under the current consent
		}
		for _, line := range strings.Split(text, "\n") {
			for _, l := range hidden {
				if strings.Contains(line, l) {
					return true
				}
			}
			for _, l := range unconsented {
				// Label and server type may be shown before consent; a base
				// DN or an entry of the connection may not.
				if i := strings.Index(line, l+" — "); i >= 0 {
					seg := line[i:]
					if j := strings.Index(seg, "; "); j >= 0 {
						seg = seg[:j]
					}
					if strings.Contains(seg, ", base ") {
						return true
					}
				}
				if strings.Contains(line, "(connection "+l+")") {
					return true
				}
			}
		}
		return false
	}
	chatID := s.r.chatID
	o.Withhold = func(b ai.Block) (string, bool) {
		pid := b.Meta.ConnectionID
		if pid == "" {
			low := strings.ToLower(b.Content)
			for _, sec := range secrets {
				if sec != "" && strings.Contains(low, strings.ToLower(sec)) {
					return "Result withheld: it names directories that are not shared with " + host + " in this chat.", true
				}
			}
			return "", false
		}
		lvl, needs := effectiveLevel(s.live, s.m.consents, chatID, pid)
		if _, known := labels[pid]; !known {
			// A profile that no longer exists or is not connected: its
			// level is still the configured one.
			lvl, needs = s.live.Level(pid), false
			if lvl == permission.LevelAsk && s.m.consents.Get(chatID, pid, host) != "approved" {
				needs = true
			}
		}
		switch {
		case lvl == permission.LevelNone:
			return "Result withheld: this directory is not shared with the assistant.", true
		case needs:
			if b.Meta.ConsentHost != "" && strings.EqualFold(b.Meta.ConsentHost, host) {
				return "", false // read through an @entry mention for this host
			}
			label := labels[pid]
			if label == "" {
				label = "this directory"
			} else {
				label = quote(label)
			}
			return fmt.Sprintf("Result withheld: %s is not shared with %s in this chat yet. Call a tool on it again and LDAPilot asks the user.", label, host), true
		}
		return "", false
	}
}

// rawEstimate is the uncalibrated estimate of a request.
func (s *loopState) rawEstimate(norm contextmgr.Result) int {
	return contextmgr.EstimateMessages(norm.Messages) + s.rawOverhead
}

func (s *loopState) projected(norm contextmgr.Result) int {
	k := contextmgr.Factor(s.calib, s.providerKey, s.model)
	return int(float64(s.rawEstimate(norm)) * k)
}

// turnLocked reports whether the history before this request may not be
// edited: inside a turn whose replayed thinking is bound to the unedited
// prefix (Anthropic, LiteLLM thinking_blocks; §4.4, §7.4). The first
// request of a new user turn is a turn boundary.
func (s *loopState) turnLocked(norm contextmgr.Result) bool {
	if s.calls == 0 && s.r.kind != ai.RunKindContinue {
		return false
	}
	if s.prov.Kind() == provider.KindAnthropic {
		return true
	}
	if !s.replayThinking() {
		return false
	}
	for _, m := range norm.Messages[min(norm.TurnStartIndex, len(norm.Messages)):] {
		for _, b := range m.Blocks {
			if b.Type == ai.BlockThinking || b.Type == ai.BlockRedactedThinking {
				return true
			}
		}
	}
	return false
}

// prepareHistory applies §7.4 before a provider call. Auto-compaction
// triggers when the messages use more than 70 % of what the fixed overhead
// leaves of the input budget (the overhead alone can exceed 70 % of a 16k
// window). Inside a locked turn only results the model has not seen yet
// may be shrunk.
func (s *loopState) prepareHistory() (contextmgr.Result, int, bool, *ai.RunError) {
	norm := s.normalize()
	proj := s.projected(norm)
	locked := s.turnLocked(norm)
	limit := s.budget.Overhead + int(compactThreshold*float64(s.budget.InputBudget-s.budget.Overhead))
	if proj > limit && !locked {
		now := s.now().UnixMilli()
		if contextmgr.ClearOld(s.history, 2, now) {
			s.contextEdited = true
			_ = s.m.d.Store.Update(s.r.chatID, func(c *chatstore.Chat) error {
				contextmgr.ClearOld(c.Messages, 2, now)
				return nil
			})
			norm = s.normalize()
			proj = s.projected(norm)
		}
	}
	if proj > limit && !locked {
		if ok, _ := s.compact(2, false); ok {
			norm = s.normalize()
			proj = s.projected(norm)
		}
	}
	if proj > s.budget.InputBudget {
		if s.x.shrinkRunResults(locked) {
			s.contextEdited = true
			norm = s.normalize()
			proj = s.projected(norm)
		}
	}
	if proj > s.budget.InputBudget {
		s.storeContextInfo(proj)
		return norm, proj, locked, &ai.RunError{Code: ai.CodeContextExceeded, Message: "The conversation is too long for this model's context window. Use /compact or start a new chat."}
	}
	return norm, proj, locked, nil
}

// compact folds older turns into an LLM summary (§7.5). It reports
// whether a summary was stored.
func (s *loopState) compact(keepTurns int, manual bool) (bool, *ai.RunError) {
	_, prevUpTo := s.latestSummary()
	fold, upTo := contextmgr.CompactionSplit(s.history, prevUpTo, keepTurns)
	if len(fold) == 0 && keepTurns > 1 {
		fold, upTo = contextmgr.CompactionSplit(s.history, prevUpTo, 1)
	}
	if len(fold) == 0 {
		return false, nil
	}
	// A cut must not separate a tool round from its results.
	if fold[len(fold)-1].Role == ai.RoleAssistant && len(toolUses(fold[len(fold)-1])) > 0 {
		return false, nil
	}
	s.status(ai.StatusCompacting, "Summarizing earlier messages…")
	// Both numbers are the calibrated estimate of the request the model
	// sees (system prompt, tools and the normalized history), the same
	// measure as the context meter (defect D4).
	before := s.projected(s.normalize())
	maxOut := max(2048, min(4096, s.budget.MaxOutput))
	maxOut = min(maxOut, s.budget.Window/2)
	chunkTokens := s.budget.Window - maxOut - contextmgr.EstimateText(contextmgr.CompactionPrompt) - s.budget.Margin
	var consent contextmgr.NormalizeOptions
	s.consentOptions(&consent)
	// The summary is built for (and sent to) the current destination: an
	// earlier summary it may not see is not folded in.
	summary, _, prevWithheld := s.visibleSummary(consent.Withhold)
	var prevConns []string
	if n := len(s.compactions); n > 0 && !prevWithheld {
		prevConns = s.compactions[n-1].Connections
	}
	if prevWithheld {
		summary = ""
	}
	fold = contextmgr.Prepare(fold, contextmgr.NormalizeOptions{Withhold: consent.Withhold, DropContext: consent.DropContext})
	chunks := contextmgr.ChunkTurns(fold, chunkTokens, 4)
	for i, ch := range chunks {
		// progress for a slow local model (UX A-03: 98 s with one static line)
		if len(chunks) > 1 {
			s.status(ai.StatusCompacting, fmt.Sprintf("Summarizing earlier messages (part %d of %d)… Esc stops", i+1, len(chunks)))
		} else {
			s.status(ai.StatusCompacting, "Summarizing earlier messages… Esc stops")
		}
		transcript := provider.FlattenTranscript(ch)
		if summary != "" {
			transcript = "[Earlier summary]\n" + summary + "\n\n" + transcript
		}
		req := &provider.Request{Model: s.model, System: contextmgr.CompactionPrompt, ToolLess: true, MaxOutputTokens: maxOut,
			Messages: []ai.Message{{Role: ai.RoleUser, Blocks: []ai.Block{{Type: ai.BlockText, Text: transcript}}}}, ContextWindow: s.budget.Window}
		if s.prov.Kind() != provider.KindOllama {
			req.ContextWindow = 0
		}
		resp, err := s.prov.Stream(s.r.ctx, req, func(provider.Event) {})
		if err != nil {
			if manual {
				return false, provider.AsRunError(err)
			}
			return false, nil
		}
		text := strings.TrimSpace(visibleText(resp.Message))
		if text == "" {
			return false, nil
		}
		text, _, _ = ai.SanitizeUntrusted(text)
		summary = text
	}
	marker := ai.CompactionMarker{ID: s.m.d.IDs.NewID(), At: s.now().UnixMilli(), UpToMessageID: upTo, Summary: summary,
		TokensBefore: before, Model: s.model, Chunks: len(chunks), Connections: s.summaryConnections(fold, summary, prevConns)}
	s.compactions = append(s.compactions, marker)
	marker.TokensAfter = s.projected(s.normalize())
	s.compactions[len(s.compactions)-1] = marker
	// The last real token count describes the request before the summary.
	s.lastActual = 0
	err := s.m.d.Store.Update(s.r.chatID, func(c *chatstore.Chat) error {
		c.Compactions = append(c.Compactions, marker)
		return nil
	})
	if err != nil {
		return false, nil
	}
	s.contextEdited = true
	s.status(ai.StatusCompacted, fmt.Sprintf("Earlier messages were summarized (%d → %d tokens).", marker.TokensBefore, marker.TokensAfter))
	return true, nil
}

// --- persistence ---

// appendMessage persists a message and mirrors it in memory.
func (s *loopState) appendMessage(msg ai.Message) error {
	s.hmu.Lock()
	defer s.hmu.Unlock()
	err := s.m.d.Store.Update(s.r.chatID, func(c *chatstore.Chat) error {
		c.Messages = append(c.Messages, msg)
		return nil
	})
	if err != nil {
		return err
	}
	s.history = append(s.history, msg)
	s.r.mu.Lock()
	s.r.persisted = append(s.r.persisted, msg)
	s.r.mu.Unlock()
	return nil
}

// upsertMessage replaces (or appends) a message by ID; fn may adjust the
// stored chat in the same update (e.g. clear Executing flags).
func (s *loopState) upsertMessage(msg ai.Message, fn func(c *chatstore.Chat)) error {
	s.hmu.Lock()
	defer s.hmu.Unlock()
	err := s.m.d.Store.Update(s.r.chatID, func(c *chatstore.Chat) error {
		found := false
		for i := range c.Messages {
			if c.Messages[i].ID == msg.ID {
				c.Messages[i] = msg
				found = true
			}
		}
		if !found {
			c.Messages = append(c.Messages, msg)
		}
		if fn != nil {
			fn(c)
		}
		s.mergeEgress(c)
		return nil
	})
	if err != nil {
		return err
	}
	found := false
	for i := range s.history {
		if s.history[i].ID == msg.ID {
			s.history[i] = msg
			found = true
		}
	}
	if !found {
		s.history = append(s.history, msg)
	}
	s.r.mu.Lock()
	found = false
	for i := range s.r.persisted {
		if s.r.persisted[i].ID == msg.ID {
			s.r.persisted[i] = msg
			found = true
		}
	}
	if !found {
		s.r.persisted = append(s.r.persisted, msg)
	}
	s.r.mu.Unlock()
	return nil
}

func (s *loopState) mergeEgress(c *chatstore.Chat) {
	if s.x != nil {
		s.x.mu.Lock()
		defer s.x.mu.Unlock()
	}
	if len(s.egress) == 0 {
		return
	}
	var out []ai.EgressRecord
	for _, e := range s.egress {
		out = append(out, *e)
	}
	sortEgress(out)
	c.Egress = out
}

// --- finalization (§3.6: persist → ai:done → remove) ---

func (s *loopState) finalize(status string, rerr *ai.RunError) {
	r := s.r
	if status == ai.RunCancelled && r.ctx.Err() != nil {
		s.persistPartial(firstNonEmpty(s.currentPartialID(), s.m.d.IDs.NewID()), ai.StopCancelled, nil)
	}
	if rerr != nil && s.finalMsgID == "" && !s.opts.compactOnly && s.history != nil && s.endsWithUser() {
		// A failed run that persisted nothing (setup errors such as
		// context_too_small): store the error so it survives a reload and
		// the next message does not follow the user message directly.
		s.persistPartial(s.m.d.IDs.NewID(), ai.StopError, rerr)
	}
	if rerr != nil {
		s.emit(ai.EventError, &ai.ErrorEvent{Code: rerr.Code, Message: rerr.Message, Retryable: rerr.Retryable, Status: rerr.Status, RequestID: rerr.RequestID})
	}
	if s.budget.Window > 0 {
		s.storeContextInfo(s.lastActual)
	}
	s.emit(ai.EventDone, &ai.DoneEvent{Status: status, FinalMessageID: s.finalMsgID, DurationMs: s.now().Sub(r.started).Milliseconds(),
		Totals: s.totals, CanContinue: s.canContinue && (status == ai.RunStepLimit || status == ai.RunTruncated), ContextEdited: s.contextEdited})
	r.em.Close()
	r.mu.Lock()
	r.doneStatus, r.finalMsgID, r.finalText, r.status = status, s.finalMsgID, s.finalText, status
	r.mu.Unlock()
	s.m.end(r)
	if status == ai.RunCompleted && (s.firstRun || s.retitle) && !s.cfg.DisableTitleGeneration && s.prov != nil {
		s.m.wg.Add(1)
		go func() {
			defer s.m.wg.Done()
			s.generateTitle()
		}()
	}
}

func (s *loopState) currentPartialID() string {
	s.r.mu.Lock()
	defer s.r.mu.Unlock()
	if s.r.partial != nil {
		return s.r.partial.ID
	}
	return ""
}

// titleInput is the transcript the title is written from: the first
// request and its answer after the first run; all requests (no answers)
// when the chat is titled again (retitleTurn), so the title covers them.
func titleInput(history []ai.Message, finalText string, all bool) string {
	var reqs []string
	for _, m := range history {
		if m.Role != ai.RoleUser || !hasUserText(m) {
			continue
		}
		t := ""
		for _, b := range m.Blocks {
			if b.Type == ai.BlockText && (b.Meta == nil || b.Meta.Kind == "") {
				t = b.Text
			}
		}
		if t != "" {
			reqs = append(reqs, t)
		}
	}
	var text string
	if all && len(reqs) > 1 {
		var sb strings.Builder
		sb.WriteString("User requests:")
		for _, r := range reqs {
			if utf8.RuneCountInString(r) > 300 {
				r = string([]rune(r)[:300]) + "…"
			}
			sb.WriteString("\n- " + strings.ReplaceAll(r, "\n", " "))
		}
		text = sb.String()
	} else {
		first := ""
		if len(reqs) > 0 {
			first = reqs[0]
		}
		text = "User: " + first + "\nAssistant: " + finalText
	}
	if utf8.RuneCountInString(text) > 1000 {
		text = string([]rune(text)[:1000])
	}
	return text
}

// generateTitle asks the model for a short title after the first
// completed run and once more at retitleTurn (failures are silent; user
// titles are never replaced).
func (s *loopState) generateTitle() {
	text := titleInput(s.history, s.finalText, s.retitle)
	text, _, _ = ai.SanitizeUntrusted(text)
	ctx, cancel := context.WithTimeout(s.m.ctx, 60*time.Second)
	defer cancel()
	// Thinking off: a reasoning model (qwen3-vl:8b) spent the whole output
	// budget on thinking and wrote no title, so the chat kept the text of
	// its first message as title (UX area A, S4).
	req := &provider.Request{Model: s.model, System: titlePrompt, ToolLess: true, MaxOutputTokens: 1024, Thinking: "off",
		Messages: []ai.Message{{Role: ai.RoleUser, Blocks: []ai.Block{{Type: ai.BlockText, Text: "<transcript>\n" + text + "\n</transcript>"}}}}, ContextWindow: s.budget.Window}
	if s.prov.Kind() != provider.KindOllama {
		req.ContextWindow = 0
	}
	resp, err := s.prov.Stream(ctx, req, func(provider.Event) {})
	if err != nil {
		return
	}
	title := strings.Trim(strings.TrimSpace(visibleText(resp.Message)), "\"'“”„«»*#` ")
	if i := strings.IndexByte(title, '\n'); i >= 0 {
		title = title[:i]
	}
	title = chatstore.CleanTitle(title)
	if title == "" {
		return
	}
	var updated int64
	err = s.m.d.Store.Update(s.r.chatID, func(c *chatstore.Chat) error {
		if c.TitleSource == "user" {
			return errors.New("user title")
		}
		c.Title, c.TitleSource = title, "llm"
		return nil
	})
	if err == nil {
		if c, err := s.m.d.Store.Get(s.r.chatID); err == nil {
			updated = c.UpdatedAt
		}
		s.m.emit(ai.EventChatUpdated, ai.ChatUpdatedEvent{ChatID: s.r.chatID, Title: title, UpdatedAt: updated})
	}
}

// --- helpers ---

func toolUses(m ai.Message) []ai.Block {
	var out []ai.Block
	for _, b := range m.Blocks {
		if b.Type == ai.BlockToolUse {
			out = append(out, b)
		}
	}
	return out
}

func withoutToolUses(blocks []ai.Block) []ai.Block {
	var out []ai.Block
	for _, b := range blocks {
		if b.Type != ai.BlockToolUse {
			out = append(out, b)
		}
	}
	return out
}

func visibleText(m ai.Message) string {
	var parts []string
	for _, b := range m.Blocks {
		if b.Type == ai.BlockText && strings.TrimSpace(b.Text) != "" && (b.Meta == nil || b.Meta.Kind == "") {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n\n")
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}
