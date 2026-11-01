package permission

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

// ApprovalTimeout is how long an approval or access request waits.
const ApprovalTimeout = 10 * time.Minute

// Outcome is the resolution of an approval request.
type Outcome struct {
	Decision  string // event decision: approved | approved_chat | approved_always | denied | timeout | cancelled | policy_denied
	By        string // user | grant | policy | timeout | run
	Raw       string // the request decision (approve, approve_chat, deny_remaining, …)
	Note      string // deny note (≤ 500 runes)
	Code      string // policy_denied: the tool error code
	Message   string // policy_denied: message
	Remaining bool   // deny_remaining
}

// Approved reports whether the outcome allows the operation.
func (o Outcome) Approved() bool {
	switch o.Decision {
	case ai.ResolvedApproved, ai.ResolvedApprovedChat, ai.ResolvedApprovedAlways:
		return true
	}
	return false
}

// Emit sends a run event (the run emitter assigns the envelope).
type Emit func(name string, payload ai.Enveloped)

type pending struct {
	req     ai.ApprovalRequest
	runID   string
	chatID  string
	key     string
	emit    Emit
	recheck func() (code, msg string) // "" = still permitted

	mu       sync.Mutex
	resolved bool
	out      Outcome
	done     chan struct{}
}

// Broker holds pending approval and access requests.
type Broker struct {
	mu      sync.Mutex
	clock   ai.Clock
	ids     ai.IDGen
	pending map[string]*pending // approvalID → pending
	shared  map[string]*pending // key → pending (access requests)
	onCount func(n int)

	recentMu sync.Mutex
	recent   map[string]Outcome
	recentQ  []string
}

// NewBroker creates a broker.
func NewBroker(clock ai.Clock, ids ai.IDGen) *Broker {
	if clock == nil {
		clock = ai.SystemClock()
	}
	if ids == nil {
		ids = ai.UUIDGen()
	}
	return &Broker{clock: clock, ids: ids, pending: map[string]*pending{}, shared: map[string]*pending{}, recent: map[string]Outcome{}}
}

// AllowedDecisions returns what RespondApproval accepts (§6.3 table).
func AllowedDecisions(kind string, requireConfirm, allowGrant bool) []string {
	switch {
	case kind == ai.ApprovalAccess:
		return []string{ai.DecisionApprove, ai.DecisionApproveAlways, ai.DecisionDeny}
	case requireConfirm:
		return []string{ai.DecisionApproveConfirmed, ai.DecisionDeny, ai.DecisionDenyRemaining}
	case allowGrant:
		return []string{ai.DecisionApprove, ai.DecisionApproveChat, ai.DecisionDeny, ai.DecisionDenyRemaining}
	}
	return []string{ai.DecisionApprove, ai.DecisionDeny, ai.DecisionDenyRemaining}
}

func eventDecision(raw string) string {
	switch raw {
	case ai.DecisionApprove, ai.DecisionApproveConfirmed:
		return ai.ResolvedApproved
	case ai.DecisionApproveChat:
		return ai.ResolvedApprovedChat
	case ai.DecisionApproveAlways:
		return ai.ResolvedApprovedAlways
	}
	return ai.ResolvedDenied
}

// AskOptions configure a request.
type AskOptions struct {
	RunID, ChatID string
	Emit          Emit
	// SharedKey makes parallel requests with the same key share one
	// pending request (access requests per chat and profile).
	SharedKey string
	// Recheck is called when the configuration changes; a non-empty code
	// resolves the request as policy_denied.
	Recheck func() (code, msg string)
	// OnPending is called after the request was emitted (run status).
	OnPending func(waiting bool)
}

// Ask emits an approval request and blocks until it is resolved by the
// user, a policy change, the timeout or ctx (cancellation). req.ApprovalID
// and ExpiresAt are filled in.
func (b *Broker) Ask(ctx context.Context, req ai.ApprovalRequest, o AskOptions) Outcome {
	b.mu.Lock()
	if o.SharedKey != "" {
		if p := b.shared[o.SharedKey]; p != nil {
			b.mu.Unlock()
			return b.wait(ctx, p, false)
		}
	}
	if req.ApprovalID == "" {
		req.ApprovalID = b.ids.NewID()
	}
	req.ExpiresAt = b.clock.Now().Add(ApprovalTimeout).UnixMilli()
	p := &pending{req: req, runID: o.RunID, chatID: o.ChatID, key: o.SharedKey, emit: o.Emit, recheck: o.Recheck, done: make(chan struct{})}
	b.pending[req.ApprovalID] = p
	if o.SharedKey != "" {
		b.shared[o.SharedKey] = p
	}
	n := len(b.pending)
	b.mu.Unlock()
	b.count(n)
	if o.Emit != nil {
		r := p.req
		o.Emit(ai.EventApprovalRequest, &r)
	}
	if o.OnPending != nil {
		o.OnPending(true)
		defer o.OnPending(false)
	}
	return b.wait(ctx, p, true)
}

func (b *Broker) wait(ctx context.Context, p *pending, owner bool) Outcome {
	timer := b.clock.NewTimer(ApprovalTimeout)
	defer timer.Stop()
	select {
	case <-p.done:
	case <-ctx.Done():
		if !owner {
			return Outcome{Decision: ai.ResolvedCancelled, By: ai.ByRun}
		}
		o := Outcome{Decision: ai.ResolvedCancelled, By: ai.ByRun}
		if b.resolve(p, o) {
			b.remember(p.req.ApprovalID, o)
		}
	case <-timer.C():
		if owner {
			o := Outcome{Decision: ai.ResolvedTimeout, By: ai.ByTimeout}
			if b.resolve(p, o) {
				b.remember(p.req.ApprovalID, o)
			}
		} else {
			select {
			case <-p.done:
			case <-ctx.Done():
				return Outcome{Decision: ai.ResolvedCancelled, By: ai.ByRun}
			}
		}
	}
	// The owner always attempted the resolution, so done is closed: the
	// outcome is exactly what the compare-and-swap decided.
	<-p.done
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.out
}

// resolve is the compare-and-swap: the first resolution wins.
func (b *Broker) resolve(p *pending, out Outcome) bool {
	p.mu.Lock()
	if p.resolved {
		p.mu.Unlock()
		return false
	}
	p.resolved = true
	p.out = out
	close(p.done)
	p.mu.Unlock()

	b.mu.Lock()
	delete(b.pending, p.req.ApprovalID)
	if p.key != "" && b.shared[p.key] == p {
		delete(b.shared, p.key)
	}
	n := len(b.pending)
	b.mu.Unlock()
	b.count(n)
	if p.emit != nil {
		p.emit(ai.EventApprovalResolved, &ai.ApprovalResolvedEvent{ApprovalID: p.req.ApprovalID, ToolCallID: p.req.ToolCallID, Decision: out.Decision, By: out.By})
	}
	return true
}

func (b *Broker) count(n int) {
	if b.onCount != nil {
		b.onCount(n)
	}
}

// OnCount registers a callback for the number of pending requests.
func (b *Broker) OnCount(fn func(n int)) { b.onCount = fn }

// ErrUnknownApproval is returned for an unknown approval ID.
var ErrUnknownApproval = errors.New("unknown approval request")

// Respond applies a user decision. A decision outside AllowedDecisions is
// an error and changes nothing; a late answer returns already_resolved.
func (b *Broker) Respond(approvalID, decision, note string) (ai.ApprovalResult, error) {
	b.mu.Lock()
	p := b.pending[approvalID]
	b.mu.Unlock()
	if p == nil {
		if r, ok := b.recentlyResolved(approvalID); ok {
			return r, nil
		}
		return ai.ApprovalResult{}, ErrUnknownApproval
	}
	allowed := false
	for _, d := range p.req.AllowedDecisions {
		if d == decision {
			allowed = true
		}
	}
	if !allowed {
		return ai.ApprovalResult{}, fmt.Errorf("decision %q is not allowed for this request (allowed: %v)", decision, p.req.AllowedDecisions)
	}
	if utf8.RuneCountInString(note) > 500 {
		note = string([]rune(note)[:500])
	}
	out := Outcome{Decision: eventDecision(decision), By: ai.ByUser, Raw: decision, Note: note, Remaining: decision == ai.DecisionDenyRemaining}
	if !b.resolve(p, out) {
		p.mu.Lock()
		o := p.out
		p.mu.Unlock()
		return ai.ApprovalResult{Status: "already_resolved", Decision: o.Decision, By: o.By}, nil
	}
	b.remember(approvalID, out)
	return ai.ApprovalResult{Status: "applied", Decision: out.Decision, By: out.By}, nil
}

// Resolved requests are remembered briefly so that a late
// RespondApproval gets already_resolved instead of an error.
func (b *Broker) remember(id string, o Outcome) {
	b.recentMu.Lock()
	defer b.recentMu.Unlock()
	b.recent[id] = o
	b.recentQ = append(b.recentQ, id)
	if len(b.recentQ) > 256 {
		delete(b.recent, b.recentQ[0])
		b.recentQ = b.recentQ[1:]
	}
}

func (b *Broker) recentlyResolved(id string) (ai.ApprovalResult, bool) {
	b.recentMu.Lock()
	defer b.recentMu.Unlock()
	o, ok := b.recent[id]
	if !ok {
		return ai.ApprovalResult{}, false
	}
	return ai.ApprovalResult{Status: "already_resolved", Decision: o.Decision, By: o.By}, true
}

// CancelRun resolves every pending request of a run as cancelled.
func (b *Broker) CancelRun(runID string) {
	for _, p := range b.list(func(p *pending) bool { return p.runID == runID }) {
		if b.resolve(p, Outcome{Decision: ai.ResolvedCancelled, By: ai.ByRun}) {
			b.remember(p.req.ApprovalID, Outcome{Decision: ai.ResolvedCancelled, By: ai.ByRun})
		}
	}
}

// Recheck re-evaluates every pending request after a config change; one
// that is no longer permitted resolves as policy_denied.
func (b *Broker) Recheck() {
	for _, p := range b.list(func(*pending) bool { return true }) {
		if p.recheck == nil {
			continue
		}
		if code, msg := p.recheck(); code != "" {
			out := Outcome{Decision: ai.ResolvedPolicyDenied, By: ai.ByPolicy, Code: code, Message: msg}
			if b.resolve(p, out) {
				b.remember(p.req.ApprovalID, out)
			}
		}
	}
}

func (b *Broker) list(f func(*pending) bool) []*pending {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []*pending
	for _, p := range b.pending {
		if f(p) {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].req.ApprovalID < out[j].req.ApprovalID })
	return out
}

// Pending returns the pending requests of a chat (UI re-sync).
func (b *Broker) Pending(chatID string) []ai.ApprovalRequest {
	var out []ai.ApprovalRequest
	for _, p := range b.list(func(p *pending) bool { return p.chatID == chatID }) {
		out = append(out, p.req)
	}
	return out
}

// Count returns the number of pending requests.
func (b *Broker) Count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.pending)
}
