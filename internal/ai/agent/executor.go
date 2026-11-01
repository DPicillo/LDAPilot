package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/chatstore"
	"github.com/dpicillo/LDAPilot/internal/ai/contextmgr"
	"github.com/dpicillo/LDAPilot/internal/ai/ldaptools"
	"github.com/dpicillo/LDAPilot/internal/ai/permission"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
)

const (
	maxParallelReads = 4
	prepareTimeout   = 30 * time.Second
	settingsChanged  = "LDAPilot settings changed while this was waiting."
)

// executor runs the tool calls of one run (§6.2, §6.3).
type executor struct {
	s *loopState

	mu         sync.Mutex
	guard      map[string]*guardEntry
	declined   map[string]bool
	suspicious bool
	structured map[string]*structured
	consented  map[string]bool
	ctxUpdated map[string]bool
	mentioned  map[string]bool // tool call IDs allowed by an @entry mention
	lastBatch  string          // assistant message of the latest batch (results not sent yet)
}

type guardEntry struct {
	count   int
	content string
	isError bool
	res     *tools.Result
}

type structured struct {
	res    *tools.Result
	cap    int
	msgID  string
	shrunk bool
}

func newExecutor(s *loopState) *executor {
	return &executor{s: s, guard: map[string]*guardEntry{}, declined: map[string]bool{}, structured: map[string]*structured{},
		consented: map[string]bool{}, ctxUpdated: map[string]bool{}, mentioned: map[string]bool{}}
}

// callState is one tool call in a batch.
type callState struct {
	tu        ai.Block
	tool      ldaptools.Tool
	def       *tools.Def
	args      tools.Args
	notes     []string
	conn      *ldaptools.Conn
	defaulted bool
	key       string
	leader    int // index of the identical call this one copies (-1 = none)

	start    time.Time
	status   string
	res      *tools.Result
	content  string
	approval *ai.ApprovalRecord
	write    *ai.WriteInfo
	done     bool
}

// batchState is shared by the calls of one step.
type batchState struct {
	denyRemaining int // > 0 after deny_remaining: number of writes denied together
	writes        int
	writeIndex    int
	resultsMsgID  string
}

func canonicalKey(name string, input json.RawMessage) string {
	var v any
	if json.Unmarshal(input, &v) != nil {
		return name + "|" + string(input)
	}
	b, _ := json.Marshal(v)
	return name + "|" + string(b)
}

// prepare resolves the tool, validates the arguments and resolves the
// connection (no permission checks yet). Problems become cs.res.
func (x *executor) prepare(tu ai.Block) *callState {
	cs := &callState{tu: tu, leader: -1, start: x.s.now(), status: ai.ToolQueued}
	cs.key = canonicalKey(tu.Name, tu.Input)
	t, ok := x.s.offered[tu.Name]
	if !ok || (tu.Meta != nil && tu.Meta.ErrorCode == "UNKNOWN_TOOL") {
		names := make([]string, 0, len(x.s.offered))
		for n := range x.s.offered {
			names = append(names, n)
		}
		sort.Strings(names)
		msg := fmt.Sprintf("Unknown tool %q.", tu.Name)
		if !ok && ldaptools.IsWrite(tu.Name) {
			cs.tool = ldaptools.Lookup(tu.Name)
			cs.def = cs.tool.Def()
			cs.res = x.writeNotOffered(tu)
			return cs
		}
		cs.res = tools.Errorf(tu.Name, tools.ErrUnknownTool, "Use one of the valid tools.", "%s", msg).WithExtra("valid_tools", names)
		return cs
	}
	cs.tool, cs.def = t, t.Def()
	if tu.Meta != nil && tu.Meta.ErrorCode == "INVALID_ARGUMENTS" {
		cs.res = tools.Errorf(tu.Name, tools.ErrInvalidArguments, "Send the arguments as one JSON object, e.g. "+tools.Example(tu.Name, cs.def.Params),
			"The arguments could not be parsed: %s", tu.Meta.Summary)
		return cs
	}
	args, notes, err := tools.Validate(cs.def.Params, tu.Input)
	if err != nil {
		cs.res = tools.Errorf(tu.Name, tools.ErrInvalidArguments, "Example: "+tools.Example(tu.Name, cs.def.Params), "%v", err)
		return cs
	}
	cs.args, cs.notes = args, notes
	if cs.def.Directory && (!cs.def.ConnectionOptional || strings.TrimSpace(args.Str(tools.ConnectionParam)) != "") {
		conns := x.s.sess.Conns
		if cs.def.Kind == tools.KindWrite {
			conns = x.writeConns()
		}
		conn, defaulted, res := ldaptools.ResolveConn(tu.Name, conns, args.Str(tools.ConnectionParam), x.s.r.ui.ActiveProfileID)
		if res != nil {
			if cs.def.Kind == tools.KindWrite {
				if c2, _, r2 := ldaptools.ResolveConn(tu.Name, x.s.sess.Conns, args.Str(tools.ConnectionParam), x.s.r.ui.ActiveProfileID); r2 == nil {
					// A known connection without write access.
					cs.conn = c2
					return cs
				}
			}
			cs.res = res
			return cs
		}
		cs.conn, cs.defaulted = conn, defaulted
	}
	return cs
}

// writeNotOffered explains a call to a write tool that was not offered,
// following the gate order of §6.2.
func (x *executor) writeNotOffered(tu ai.Block) *tools.Result {
	hint := "Explain to the user how to make the change in LDAPilot."
	if !x.s.live.AllowWrites() {
		return tools.Errorf(tu.Name, tools.ErrWritesDisabled, hint, "Changes through the assistant are disabled in LDAPilot's AI settings.")
	}
	var arg string
	var m map[string]any
	if json.Unmarshal(tu.Input, &m) == nil {
		arg, _ = m[tools.ConnectionParam].(string)
	}
	conn, _, res := ldaptools.ResolveConn(tu.Name, x.s.sess.Conns, arg, x.s.r.ui.ActiveProfileID)
	if res != nil {
		return res
	}
	info, _ := x.liveInfo(conn.Info.ProfileID)
	code, msg := x.s.live.WriteGate(conn.Info.ProfileID, info.ReadOnly || conn.Info.ReadOnly)
	if code == "" {
		code, msg = tools.ErrAccessDenied, "The user has given you read-only access to this directory."
	}
	if code == tools.ErrReadOnlyProfile {
		hint = "The connection profile is read-only; the user can change that in the connection settings."
	}
	return tools.Errorf(tu.Name, code, hint, "%s", msg)
}

// writeConns are the connections offered to write tools.
func (x *executor) writeConns() []*ldaptools.Conn {
	var out []*ldaptools.Conn
	for _, c := range x.s.sess.Conns {
		lvl, _ := effectiveLevel(x.s.live, x.s.m.consents, x.s.r.chatID, c.Info.ProfileID)
		if lvl == permission.LevelWrite && !c.Info.ReadOnly {
			out = append(out, c)
		}
	}
	return out
}

func escapedArgs(cs *callState) string {
	var b []byte
	if cs.args != nil {
		b = []byte(cs.args.Canonical())
	} else {
		b = cs.tu.Input
	}
	s, _ := ai.EscapeInvisible(string(b))
	return s
}

// runBatch executes the calls of one step and persists the results. It
// returns false when the chat disappeared.
func (x *executor) runBatch(msgID string, uses []ai.Block, capTokens, avail int) bool {
	s := x.s
	x.mu.Lock()
	x.lastBatch = msgID
	x.mu.Unlock()
	calls := make([]*callState, len(uses))
	bs := &batchState{resultsMsgID: s.m.d.IDs.NewID()}
	first := map[string]int{}
	hasWrite := false
	for i, tu := range uses {
		cs := x.prepare(tu)
		if j, ok := first[cs.key]; ok {
			cs.leader = j
		} else {
			first[cs.key] = i
		}
		if cs.def != nil && cs.def.Kind == tools.KindWrite && cs.res == nil {
			hasWrite = true
			if cs.leader < 0 {
				bs.writes++
			}
		}
		calls[i] = cs
	}
	for _, cs := range calls {
		ev := &ai.ToolStartEvent{MessageID: msgID, ToolCallID: cs.tu.ID, Name: cs.tu.Name, Args: escapedArgs(cs), Status: ai.ToolQueued, Warnings: []string{}}
		if cs.def != nil {
			ev.DisplayName, ev.Kind = cs.def.DisplayName, string(cs.def.Kind)
		} else {
			ev.DisplayName, ev.Kind = cs.tu.Name, string(tools.KindRead)
		}
		if cs.conn != nil {
			ev.ConnectionID, ev.ConnectionLabel = cs.conn.Info.ProfileID, cs.conn.Label
		}
		if cs.tu.Meta != nil {
			ev.Warnings = append(ev.Warnings, cs.tu.Meta.Warnings...)
		}
		s.emit(ai.EventToolStart, ev)
	}
	capChars := int(float64(capTokens) * tools.CharsPerToken)
	finish := func(cs *callState) {
		x.complete(cs, capChars, avail, msgID)
	}
	if hasWrite {
		for i, cs := range calls {
			if cs.leader >= 0 {
				continue
			}
			x.execOne(s.r.ctx, cs, bs)
			finish(cs)
			if cs.def != nil && cs.def.Kind == tools.KindWrite {
				// Persist the results so far right after every write
				// (write-ahead: Executing is cleared together with it).
				if err := x.persistResults(bs.resultsMsgID, calls[:i+1]); err != nil {
					return false
				}
			}
		}
	} else {
		sem := make(chan struct{}, maxParallelReads)
		var wg sync.WaitGroup
		for _, cs := range calls {
			if cs.leader >= 0 {
				continue
			}
			wg.Add(1)
			sem <- struct{}{}
			go func(cs *callState) {
				defer wg.Done()
				defer func() { <-sem }()
				x.execOne(s.r.ctx, cs, bs)
				finish(cs)
			}(cs)
		}
		wg.Wait()
	}
	for _, cs := range calls {
		if cs.leader >= 0 {
			l := calls[cs.leader]
			cs.res, cs.content, cs.status, cs.approval, cs.write = l.res, l.content, l.status, l.approval, l.write
			cs.done = true
			s.emit(ai.EventToolEnd, x.endEvent(cs))
		}
	}
	return x.persistResults(bs.resultsMsgID, calls) == nil
}

// execOne runs one call (guard, permission, read or write). ctx is the
// run context, or a per-call context of an MCP request (Claude Code
// engine) that also ends when the client cancels the call.
func (x *executor) execOne(ctx context.Context, cs *callState, bs *batchState) {
	if cs.res != nil {
		cs.status = ai.ToolError
		return
	}
	x.mu.Lock()
	g := x.guard[cs.key]
	if g != nil && g.count >= 2 {
		g.count++
		x.mu.Unlock()
		cs.res = cloneResult(g.res)
		cs.res.Note("You already made this exact call twice in this turn; this is the earlier result. Change the arguments or answer the user.")
		cs.status = ai.ToolOK
		if cs.res.IsError() {
			cs.status = ai.ToolError
		}
		return
	}
	x.mu.Unlock()
	if cs.def.Kind == tools.KindWrite {
		x.execWrite(ctx, cs, bs)
	} else {
		x.execRead(ctx, cs)
	}
	x.mu.Lock()
	if g == nil {
		g = &guardEntry{}
		x.guard[cs.key] = g
	}
	g.count++
	g.res = cs.res
	x.mu.Unlock()
}

func cloneResult(r *tools.Result) *tools.Result {
	c := *r
	c.Notes = append([]string(nil), r.Notes...)
	c.Warnings = append([]string(nil), r.Warnings...)
	c.Fields = append(tools.Fields(nil), r.Fields...)
	return &c
}

func (x *executor) setStatus(cs *callState, status string) {
	cs.status = status
	x.s.emit(ai.EventToolUpdate, &ai.ToolUpdateEvent{ToolCallID: cs.tu.ID, Status: status})
}

// --- reads ---

func (x *executor) execRead(callCtx context.Context, cs *callState) {
	s := x.s
	call := &ldaptools.Call{ID: cs.tu.ID, Tool: cs.tu.Name, Args: cs.args, Conn: cs.conn, Defaulted: cs.defaulted, Notes: cs.notes}
	newlyConsented := false
	if cs.conn != nil {
		res, consented := x.authorizeRead(callCtx, cs)
		if res != nil {
			cs.res, cs.status = res, ai.ToolError
			if res.Code() == tools.ErrCancelled {
				cs.status = ai.ToolCancelled
			} else if res.Code() == tools.ErrAccessDenied {
				cs.status = ai.ToolDenied
			}
			return
		}
		newlyConsented = consented
		x.mu.Lock()
		mentioned := x.mentioned[cs.tu.ID]
		x.mu.Unlock()
		// Allowed only by the @entry mention (no read level, no chat
		// consent): the tool may read exactly that DN and nothing else.
		call.MentionOnly = mentioned && s.m.consents.Get(s.r.chatID, cs.conn.Info.ProfileID, s.live.Dest.Host) != "approved"
		dc, err := s.m.d.Directory.Client(cs.conn.Info.ProfileID)
		if err != nil {
			cs.res, cs.status = ldaptools.ErrorResult(cs.tu.Name, ldaptools.ErrNotConnected, ""), ai.ToolError
			return
		}
		call.Client = dc
	}
	x.setStatus(cs, ai.ToolRunning)
	timeout := cs.def.Timeout
	if timeout <= 0 {
		timeout = ldaptools.TimeoutRead
	}
	ctx, cancel := context.WithTimeout(callCtx, timeout)
	defer cancel()
	res := cs.tool.(ldaptools.Reader).Run(ctx, s.sess, call)
	if callCtx.Err() != nil {
		res = tools.Errorf(cs.tu.Name, tools.ErrCancelled, "", "Cancelled by the user before this call finished.")
	}
	if res == nil {
		res = tools.Errorf(cs.tu.Name, tools.ErrLDAP, "", "The tool returned no result.")
	}
	if cs.conn != nil && res.Err == nil {
		pid := cs.conn.Info.ProfileID
		x.mu.Lock()
		pending := (newlyConsented || x.consented[pid]) && !x.ctxUpdated[pid]
		if pending && s.r.ui.SelectedProfileID == pid && s.r.ui.SelectedDN != "" {
			x.ctxUpdated[pid] = true
			dn, _, _ := ai.SanitizeUntrusted(s.r.ui.SelectedDN)
			res.Fields = append(res.Fields, tools.Field{K: "context_update", V: tools.Fs("selected_entry", dn)})
		}
		x.mu.Unlock()
	}
	cs.res = res
	cs.status = ai.ToolOK
	if res.IsError() {
		cs.status = ai.ToolError
		if res.Code() == tools.ErrCancelled {
			cs.status = ai.ToolCancelled
		}
	}
}

// authorizeRead applies the access level and consent (§6.1). It returns
// an error result, or nil plus whether consent was given just now.
func (x *executor) authorizeRead(ctx context.Context, cs *callState) (*tools.Result, bool) {
	s := x.s
	pid := cs.conn.Info.ProfileID
	host := s.live.Dest.Host
	lvl := s.live.Level(pid)
	switch lvl {
	case permission.LevelNone:
		return tools.Errorf(cs.tu.Name, tools.ErrAccessDenied, "Do not use this directory.", "Access to this directory is turned off in LDAPilot's AI settings."), false
	case permission.LevelRead, permission.LevelWrite:
		x.auditAccess(pid, "level "+lvl, lvl)
		return nil, false
	}
	// ask: an @entry mention is consent for exactly that DN.
	if cs.tu.Name == "get_entry" || cs.tu.Name == "get_account_status" {
		dn := strings.TrimSpace(cs.args.Str("dn"))
		for _, mn := range s.r.ui.Mentions {
			if mn.ProfileID == pid && strings.EqualFold(normDN(mn.DN), normDN(dn)) {
				x.mu.Lock()
				x.mentioned[cs.tu.ID] = true
				x.mu.Unlock()
				return nil, false
			}
		}
	}
	switch s.m.consents.Get(s.r.chatID, pid, host) {
	case "approved":
		return nil, false
	case "denied":
		return tools.Errorf(cs.tu.Name, tools.ErrAccessDenied, "Do not retry; the user declined access in this chat.", "The user declined access to this directory."), false
	}
	req := ai.ApprovalRequest{ToolCallID: cs.tu.ID, Kind: ai.ApprovalAccess, Tool: cs.tu.Name, ToolDisplayName: cs.def.DisplayName,
		Connection: x.approvalConn(cs.conn), ProviderHost: host, ProviderRemote: !s.live.Dest.Local,
		AllowedDecisions: permission.AllowedDecisions(ai.ApprovalAccess, false, false), Position: ai.ApprovalPosition{Index: 1, Total: 1}}
	x.setStatus(cs, ai.ToolAwaitingApproval)
	s.r.setStatus(ai.RunAwaitingApproval)
	out := s.m.broker.Ask(ctx, req, permission.AskOptions{RunID: s.r.id, ChatID: s.r.chatID, Emit: s.emit,
		SharedKey: s.r.chatID + "|" + pid, Recheck: func() (string, string) {
			if s.live.Level(pid) == permission.LevelNone {
				return tools.ErrAccessDenied, "Access to this directory was turned off."
			}
			return "", ""
		}})
	s.r.setStatus(ai.RunRunning)
	cs.approval = &ai.ApprovalRecord{Decision: out.Decision, By: out.By, At: s.now().UnixMilli()}
	switch out.Decision {
	case ai.ResolvedApproved, ai.ResolvedApprovedChat:
		s.m.consents.Set(s.r.chatID, pid, host, "approved")
		x.markConsented(pid)
		x.auditAccess(pid, "approved", permission.LevelRead)
		return nil, true
	case ai.ResolvedApprovedAlways:
		// "Always allow read" grants exactly read for this host: a remote
		// host gets a read-only binding even when the profile is at write
		// (write for a remote host comes only from the settings, §6.1).
		s.m.consents.Set(s.r.chatID, pid, host, "approved")
		var err error
		if s.live.Dest.Local {
			level := permission.LevelRead
			if permission.FromConfig(s.m.d.Config.Current()).Configured(pid) == permission.LevelWrite {
				level = permission.LevelWrite
			}
			err = s.m.d.Config.SetConnectionAccess(pid, level, "")
		} else {
			err = s.m.d.Config.AllowReadHost(pid, host)
		}
		if err != nil {
			s.m.d.Logf("ai: cannot store access level: %v", err)
		}
		x.markConsented(pid)
		x.auditAccess(pid, "always", permission.LevelRead)
		return nil, true
	case ai.ResolvedDenied:
		s.m.consents.Set(s.r.chatID, pid, host, "denied")
		return tools.Errorf(cs.tu.Name, tools.ErrAccessDenied, "Do not retry; the user declined access in this chat.", "The user declined access to this directory."), false
	case ai.ResolvedTimeout:
		return tools.Errorf(cs.tu.Name, tools.ErrAccessDenied, "The user did not respond to the access request.", "Access to this directory was not granted."), false
	case ai.ResolvedPolicyDenied:
		return tools.Errorf(cs.tu.Name, tools.ErrAccessDenied, settingsChanged, "Access to this directory is not allowed."), false
	}
	return tools.Errorf(cs.tu.Name, tools.ErrCancelled, "", "Cancelled by the user before this call ran."), false
}

func (x *executor) markConsented(pid string) {
	x.mu.Lock()
	x.consented[pid] = true
	x.mu.Unlock()
}

// auditAccess writes one AI_ACCESS audit entry per chat, profile and
// provider host (§6.4).
func (x *executor) auditAccess(pid, how, level string) {
	s := x.s
	if s.m.d.Auditor == nil {
		return
	}
	key := s.r.chatID + "|" + pid + "|" + s.live.Dest.Host
	if _, loaded := s.m.accessAudited.LoadOrStore(key, true); loaded {
		return
	}
	loc := "remote"
	if s.live.Dest.Local {
		loc = "local"
	}
	s.m.d.Auditor.Record(pid, "AI_ACCESS", "", fmt.Sprintf("AI provider %s (%s) granted %s access (chat %s, %s)", s.live.Dest.Host, loc, level, id8(s.r.chatID), how), nil)
}

func id8(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func (x *executor) approvalConn(c *ldaptools.Conn) ai.ApprovalConnection {
	info := c.Info
	if live, ok := x.liveInfo(info.ProfileID); ok {
		info = live
	}
	st := info.ServerType
	return ai.ApprovalConnection{ProfileID: info.ProfileID, Label: c.Label, ServerType: st, Host: info.Host, Identity: info.Identity,
		ReadOnly: info.ReadOnly, LocalProvider: x.s.live.Dest.Local}
}

// liveInfo returns the current ConnInfo (ReadOnly can change live).
func (x *executor) liveInfo(pid string) (ldaptools.ConnInfo, bool) {
	if x.s.m.d.Directory == nil {
		return ldaptools.ConnInfo{}, false
	}
	for _, c := range x.s.m.d.Directory.Connections() {
		if c.ProfileID == pid {
			return c, true
		}
	}
	return ldaptools.ConnInfo{}, false
}

// --- writes ---

func (x *executor) writeGate(cs *callState) *tools.Result {
	pid := cs.conn.Info.ProfileID
	info, ok := x.liveInfo(pid)
	if !ok {
		return ldaptools.ErrorResult(cs.tu.Name, ldaptools.ErrNotConnected, "")
	}
	code, msg := x.s.live.WriteGate(pid, info.ReadOnly)
	if code == "" {
		return nil
	}
	hint := "Explain to the user how to make the change in LDAPilot."
	if code == tools.ErrReadOnlyProfile {
		hint = "The connection profile is read-only; the user can change that in the connection settings."
	}
	return tools.Errorf(cs.tu.Name, code, hint, "%s", msg)
}

func writeTimeout(c *ldaptools.Conn) time.Duration {
	if c != nil && c.Info.Timeout > 0 {
		return c.Info.Timeout
	}
	return 30 * time.Second
}

func (x *executor) execWrite(ctx context.Context, cs *callState, bs *batchState) {
	s := x.s
	if cs.conn == nil {
		cs.res, cs.status = tools.Errorf(cs.tu.Name, tools.ErrUnknownConnection, "", "No directory is available for changes."), ai.ToolError
		return
	}
	// Gates 1–3 (§6.2), no approval card.
	if res := x.writeGate(cs); res != nil {
		cs.res, cs.status = res, ai.ToolDenied
		if res.Code() == tools.ErrNotConnected {
			cs.status = ai.ToolError
		}
		return
	}
	dc, err := s.m.d.Directory.Client(cs.conn.Info.ProfileID)
	if err != nil {
		cs.res, cs.status = ldaptools.ErrorResult(cs.tu.Name, ldaptools.ErrNotConnected, ""), ai.ToolError
		return
	}
	call := &ldaptools.Call{ID: cs.tu.ID, Tool: cs.tu.Name, Args: cs.args, Conn: cs.conn, Client: dc, Defaulted: cs.defaulted, Notes: cs.notes}
	x.setStatus(cs, ai.ToolRunning)
	pctx, cancel := context.WithTimeout(ctx, prepareTimeout)
	prep, res := cs.tool.(ldaptools.Writer).Prepare(pctx, s.sess, call)
	cancel()
	if ctx.Err() != nil {
		cs.res, cs.status = tools.Errorf(cs.tu.Name, tools.ErrCancelled, "", "Cancelled by the user before this call ran."), ai.ToolCancelled
		return
	}
	if res != nil {
		cs.res = res
		cs.status = ai.ToolOK
		if res.IsError() {
			cs.status = ai.ToolError
		}
		return
	}
	bs.writeIndex++
	// Repeated identical write after a denial, or "deny remaining".
	x.mu.Lock()
	declined := x.declined[cs.key]
	x.mu.Unlock()
	if declined {
		cs.res = declinedResult(cs.tu.Name, "", "already declined in this turn")
		cs.status = ai.ToolDenied
		return
	}
	if bs.denyRemaining > 0 {
		cs.res = declinedResult(cs.tu.Name, "", fmt.Sprintf("denied together with %d other changes", bs.denyRemaining))
		cs.status = ai.ToolDenied
		return
	}
	pv := prep.Preview
	// A write to the UI-selected entry while the message names another
	// entry gets a warning on the card (2b defect 1) and is never
	// auto-approved by a chat grant: the user has to see it.
	targetWarn := x.targetWarning(ctx, cs, prep, dc)
	if targetWarn != "" {
		pv.Warnings = append([]string{targetWarn}, pv.Warnings...)
	}
	x.mu.Lock()
	suspicious := x.suspicious
	x.mu.Unlock()
	if !suspicious {
		// A flagged result from an earlier run that the model still sees
		// keeps grants suspended in this chat (§6.6 item 6).
		suspicious = x.historySuspicious()
	}
	var grantID string
	approved := false
	grantAllowed := cs.def.AllowChatGrant && pv.Risk != "high"
	if !grantAllowed {
		pv.GrantScope = nil
	}
	req := ai.ApprovalRequest{ToolCallID: cs.tu.ID, Kind: ai.ApprovalWrite, Tool: cs.tu.Name, ToolDisplayName: cs.def.DisplayName,
		Connection: x.approvalConn(cs.conn), Position: ai.ApprovalPosition{Index: bs.writeIndex, Total: max(bs.writes, bs.writeIndex)},
		Preview: pv, RequireConfirm: pv.Risk == "high", GrantsSuspended: suspicious && grantAllowed}
	if grantAllowed && !suspicious && targetWarn == "" {
		if g, ok := s.m.grants.Match(s.r.chatID, permission.MatchRequest{Tool: cs.tu.Name, ProfileID: cs.conn.Info.ProfileID, TargetDN: prep.TargetDN,
			GroupDN: prep.GroupDN, Action: prep.Action, Attributes: prep.Attributes}); ok {
			grantID = g.ID
			approved = true
			req.ApprovalID = s.m.d.IDs.NewID()
			req.AllowedDecisions = []string{}
			req.ExpiresAt = s.now().UnixMilli()
			r := req
			s.emit(ai.EventApprovalRequest, &r)
			s.emit(ai.EventApprovalResolved, &ai.ApprovalResolvedEvent{ApprovalID: req.ApprovalID, ToolCallID: cs.tu.ID, Decision: ai.ResolvedApproved, By: ai.ByGrant})
			cs.approval = &ai.ApprovalRecord{Decision: ai.ResolvedApproved, By: ai.ByGrant, At: s.now().UnixMilli(), PreviewHash: pv.BeforeHash, GrantID: g.ID}
		}
	}
	if !approved {
		req.AllowedDecisions = permission.AllowedDecisions(ai.ApprovalWrite, req.RequireConfirm, grantAllowed && !suspicious)
		if suspicious || !grantAllowed {
			pv.GrantScope = nil
		}
		x.setStatus(cs, ai.ToolAwaitingApproval)
		s.r.setStatus(ai.RunAwaitingApproval)
		out := s.m.broker.Ask(ctx, req, permission.AskOptions{RunID: s.r.id, ChatID: s.r.chatID, Emit: s.emit,
			Recheck: func() (string, string) {
				info, ok := x.liveInfo(cs.conn.Info.ProfileID)
				if !ok {
					return tools.ErrNotConnected, "The directory was disconnected."
				}
				return s.live.WriteGate(cs.conn.Info.ProfileID, info.ReadOnly)
			}})
		s.r.setStatus(ai.RunRunning)
		cs.approval = &ai.ApprovalRecord{Decision: out.Decision, By: out.By, At: s.now().UnixMilli(), PreviewHash: pv.BeforeHash}
		switch out.Decision {
		case ai.ResolvedApproved, ai.ResolvedApprovedChat:
			approved = true
			if out.Decision == ai.ResolvedApprovedChat && pv.GrantScope != nil {
				g := s.m.grants.Add(s.r.chatID, cs.conn.Label, *pv.GrantScope)
				cs.approval.GrantID = g.ID
			}
		case ai.ResolvedDenied:
			x.mu.Lock()
			x.declined[cs.key] = true
			x.mu.Unlock()
			if out.Remaining {
				bs.denyRemaining = max(1, bs.writes-bs.writeIndex)
			}
			cs.res, cs.status = declinedResult(cs.tu.Name, out.Note, ""), ai.ToolDenied
			return
		case ai.ResolvedTimeout:
			cs.res, cs.status = tools.Errorf(cs.tu.Name, tools.ErrApprovalTimeout, "The user did not respond; do not retry unless they ask again.", "The change was not approved in time; nothing was changed."), ai.ToolDenied
			return
		case ai.ResolvedPolicyDenied:
			cs.res, cs.status = tools.Errorf(cs.tu.Name, firstNonEmpty(out.Code, tools.ErrAccessDenied), settingsChanged, "%s", firstNonEmpty(out.Message, "The change is no longer allowed.")), ai.ToolDenied
			return
		default:
			cs.res, cs.status = tools.Errorf(cs.tu.Name, tools.ErrCancelled, "", "Cancelled by the user before this call ran."), ai.ToolCancelled
			return
		}
	}
	// Re-check gates 1–3 right before Execute (live policy).
	if res := x.writeGate(cs); res != nil {
		res.Err.Hint = settingsChanged
		cs.res, cs.status = res, ai.ToolDenied
		cs.approval.Decision, cs.approval.By = ai.ResolvedPolicyDenied, ai.ByPolicy
		return
	}
	if ctx.Err() != nil {
		cs.res, cs.status = tools.Errorf(cs.tu.Name, tools.ErrCancelled, "", "Cancelled by the user before this call ran."), ai.ToolCancelled
		return
	}
	// Write-ahead: mark the call as executing before the directory is
	// touched (outcome-unknown recovery after a crash).
	if err := x.markExecuting(cs, true); err != nil {
		cs.res, cs.status = tools.Errorf(cs.tu.Name, tools.ErrCancelled, "", "The chat was deleted; nothing was changed."), ai.ToolCancelled
		return
	}
	s.r.mu.Lock()
	s.r.writing++
	s.r.mu.Unlock()
	wctx, wcancel := context.WithTimeout(context.WithoutCancel(ctx), writeTimeout(cs.conn))
	type execOut struct {
		res    *tools.Result
		secret []byte
	}
	ch := make(chan execOut, 1)
	go func() {
		r, sec := prep.Execute(wctx)
		ch <- execOut{r, sec}
	}()
	var out execOut
	select {
	case out = <-ch:
	case <-ctx.Done():
		x.setStatus(cs, ai.ToolFinishingWrite)
		s.status(ai.StatusFinishingWrite, "Finishing a change that was already being applied…")
		out = <-ch
	}
	wcancel()
	s.r.mu.Lock()
	s.r.writing--
	s.r.mu.Unlock()
	res = out.res
	if res == nil {
		res = tools.Errorf(cs.tu.Name, tools.ErrLDAP, "", "The write returned no result.")
	}
	// Audit every executed write, successful or failed (§6.4).
	how := "approved"
	if grantID != "" {
		how = "auto-approved grant " + id8(grantID)
	}
	details := fmt.Sprintf("via AI (chat %s, %s/%s, %s): %s", id8(s.r.chatID), s.providerKey, s.auditModel(), how, prep.AuditDetail)
	var auditErr error
	if res.IsError() {
		auditErr = fmt.Errorf("%s: %s", res.Code(), res.Err.Message)
	}
	if s.m.d.Auditor != nil {
		dn := prep.TargetDN
		s.m.d.Auditor.Record(cs.conn.Info.ProfileID, prep.AuditOp, dn, details, auditErr)
	}
	s.m.shared.Invalidate(cs.conn.Info.ProfileID)
	cs.res = res
	cs.status = ai.ToolOK
	if res.IsError() {
		cs.status = ai.ToolError
	} else {
		cs.write = prep.Write
	}
	if len(out.secret) > 0 {
		if !res.IsError() {
			exp := s.m.vault.Put(cs.tu.ID, s.r.chatID, "password", prep.TargetDN, out.secret)
			s.emit(ai.EventSecretAvailable, &ai.SecretAvailableEvent{ToolCallID: cs.tu.ID, Kind: "password", DN: prep.TargetDN, ExpiresAt: exp.UnixMilli()})
		} else {
			zero(out.secret)
		}
	}
}

func declinedResult(tool, note, extra string) *tools.Result {
	r := tools.Errorf(tool, tools.ErrDeclined, "Do not retry this change unless the user asks for it again.", "The user declined this change.")
	if note != "" {
		n, _, _ := ai.SanitizeUntrusted(note)
		r.WithExtra("user_note", n)
	}
	if extra != "" {
		r.Note("%s", extra)
	}
	return r
}

// markExecuting sets or clears Meta.Executing on the stored tool_use.
func (x *executor) markExecuting(cs *callState, on bool) error {
	s := x.s
	now := s.now().UnixMilli()
	apply := func(msgs []ai.Message) {
		for mi := range msgs {
			for bi := range msgs[mi].Blocks {
				b := &msgs[mi].Blocks[bi]
				if b.Type == ai.BlockToolUse && b.ID == cs.tu.ID {
					if b.Meta == nil {
						b.Meta = &ai.BlockMeta{}
					}
					b.Meta.Kind = "write"
					b.Meta.Executing = on
					if on {
						b.Meta.ExecutingSince = now
					} else {
						b.Meta.ExecutingSince = 0
					}
					if cs.approval != nil {
						a := *cs.approval
						b.Meta.Approval = &a
					}
					if cs.conn != nil {
						b.Meta.ConnectionID, b.Meta.ConnectionLabel = cs.conn.Info.ProfileID, cs.conn.Label
					}
				}
			}
		}
	}
	s.hmu.Lock()
	defer s.hmu.Unlock()
	if err := s.m.d.Store.Update(s.r.chatID, func(c *chatstore.Chat) error {
		apply(c.Messages)
		return nil
	}); err != nil {
		return err
	}
	apply(s.history)
	return nil
}

// complete renders the result, updates run-wide state and emits tool_end.
func (x *executor) complete(cs *callState, capChars, avail int, msgID string) {
	s := x.s
	res := cs.res
	if avail < minCallTokens && !res.IsError() && cs.def != nil && cs.def.Kind == tools.KindRead {
		// Less than the 300-token floor remains: reject only a result that
		// really does not fit once rendered (a small one still does).
		if contextmgr.EstimateJSON(len(res.Render(capChars))) > max(avail, 0) {
			res = tools.Errorf(cs.tu.Name, tools.ErrResultTooLarge, "The context is nearly full; narrow the request.", "The result does not fit into the remaining context budget.")
			cs.res = res
			cs.status = ai.ToolError
		}
	}
	if cs.def != nil && cs.def.Kind == tools.KindWrite {
		capChars = 0 // write results are small and must never be cut
	}
	cs.content = res.Render(capChars)
	if res.RenderedTooLarge() {
		// The model gets a RESULT_TOO_LARGE error: the card, the stored
		// block and the summary must say so too, not "ok".
		res = res.TooLargeError()
		cs.res, cs.status = res, ai.ToolError
		cs.content = res.Render(0)
	}
	if shown, total, ok := res.Shown(); ok && shown < total {
		// The summary is what the model sees once the result is cleared
		// (§7.4); it must name what was actually delivered.
		res.Summary = fmt.Sprintf("%s; %d of %d shown (context budget)", firstNonEmpty(res.Summary, res.Tool), shown, total)
	}
	for _, w := range res.Warnings {
		if suspiciousWarning(w) {
			x.mu.Lock()
			x.suspicious = true
			x.mu.Unlock()
		}
	}
	if cs.conn != nil && (res.ConnectionID != "" && !res.IsError() || carriesDirectoryData(res)) {
		x.recordEgress(cs.conn.Info.ProfileID, len(cs.content))
	}
	x.mu.Lock()
	x.structured[cs.tu.ID] = &structured{res: res, cap: capChars, msgID: msgID}
	x.mu.Unlock()
	cs.done = true
	s.emit(ai.EventToolEnd, x.endEvent(cs))
}

func (x *executor) endEvent(cs *callState) *ai.ToolEndEvent {
	res := cs.res
	ev := &ai.ToolEndEvent{ToolCallID: cs.tu.ID, Status: cs.status, DurationMs: x.s.now().Sub(cs.start).Milliseconds(), Summary: res.Summary,
		Result: cs.content, IsError: res.IsError(), ErrorCode: res.Code(), Warnings: append([]string{}, res.Warnings...), DNs: append([]string{}, res.DNs...), Write: cs.write}
	if cs.tu.Meta != nil {
		ev.Warnings = append(ev.Warnings, cs.tu.Meta.Warnings...)
	}
	if ev.Summary == "" {
		ev.Summary = res.Code()
	}
	return ev
}

// carriesDirectoryData reports an error result that still hands directory
// data to the model (the DNs of same-named entries for a missing DN).
func carriesDirectoryData(res *tools.Result) bool {
	if res.Err == nil {
		return false
	}
	_, ok := res.Err.Extra.Get("candidates")
	return ok
}

func (x *executor) recordEgress(pid string, n int) {
	s := x.s
	key := pid + "|" + s.live.Dest.Host
	now := s.now().UnixMilli()
	x.mu.Lock()
	defer x.mu.Unlock()
	e := s.egress[key]
	if e == nil {
		e = &ai.EgressRecord{ProfileID: pid, ProviderHost: s.live.Dest.Host, Remote: !s.live.Dest.Local, FirstAt: now}
		s.egress[key] = e
	}
	e.ToolResults++
	e.Bytes += int64(n)
	e.LastAt = now
	snap := make([]ai.EgressRecord, 0, len(s.egress))
	for _, x := range s.egress {
		snap = append(snap, *x)
	}
	sortEgress(snap)
	s.r.mu.Lock()
	s.r.egress = snap
	s.r.mu.Unlock()
}

func sortEgress(es []ai.EgressRecord) {
	sort.Slice(es, func(i, j int) bool {
		if es[i].FirstAt != es[j].FirstAt {
			return es[i].FirstAt < es[j].FirstAt
		}
		return es[i].ProfileID+es[i].ProviderHost < es[j].ProfileID+es[j].ProviderHost
	})
}

// minCallTokens is the per-call floor of the result budget (§5.1).
const minCallTokens = 300

// noBudget is the avail value of calls without a step budget (Claude Code).
const noBudget = 1 << 30

func suspiciousWarning(w string) bool {
	return strings.HasPrefix(w, ldaptools.WarnInjection) || strings.HasPrefix(w, ldaptools.WarnHidden) || w == ldaptools.WarnSanitized
}

// historySuspicious reports a flagged tool result (injection, hidden
// characters, sanitized values) that is still in the model's view of this
// chat: not cleared and not folded into a compaction summary.
func (x *executor) historySuspicious() bool {
	s := x.s
	_, upTo := s.latestSummary()
	s.hmu.Lock()
	defer s.hmu.Unlock()
	start := 0
	if upTo != "" {
		for i, m := range s.history {
			if m.ID == upTo {
				start = i + 1
			}
		}
	}
	for _, m := range s.history[start:] {
		for _, b := range m.Blocks {
			if b.Type != ai.BlockToolResult || b.Meta == nil || b.Meta.ClearedAt > 0 {
				continue
			}
			for _, w := range b.Meta.Warnings {
				if suspiciousWarning(w) {
					return true
				}
			}
		}
	}
	return false
}

// resultBlock builds the stored tool_result block.
func (x *executor) resultBlock(cs *callState) ai.Block {
	res := cs.res
	kind := "read"
	if cs.def != nil && cs.def.Kind == tools.KindWrite {
		kind = "write"
	}
	meta := &ai.BlockMeta{Kind: kind, DurationMs: x.s.now().Sub(cs.start).Milliseconds(), Summary: res.Summary, ErrorCode: res.Code(),
		Warnings: append([]string(nil), res.Warnings...), DNs: append([]string(nil), res.DNs...), Approval: cs.approval}
	if cs.conn != nil {
		meta.ConnectionID, meta.ConnectionLabel = cs.conn.Info.ProfileID, cs.conn.Label
		x.mu.Lock()
		if x.mentioned[cs.tu.ID] {
			meta.ConsentHost = x.s.live.Dest.Host
		}
		x.mu.Unlock()
	}
	if meta.Summary == "" {
		meta.Summary = res.Code()
	}
	return ai.Block{Type: ai.BlockToolResult, ToolUseID: cs.tu.ID, Content: cs.content, IsError: res.IsError(), Meta: meta}
}

// persistResults upserts the step's tool-result message with the finished
// calls and clears Executing for them in the same update.
func (x *executor) persistResults(id string, calls []*callState) error {
	s := x.s
	var blocks []ai.Block
	done := map[string]bool{}
	for _, cs := range calls {
		if !cs.done {
			continue
		}
		blocks = append(blocks, x.resultBlock(cs))
		done[cs.tu.ID] = true
	}
	msg := ai.Message{ID: id, Role: ai.RoleUser, Blocks: blocks, CreatedAt: s.now().UnixMilli(), RunID: s.r.id}
	clear := func(msgs []ai.Message) {
		for mi := range msgs {
			for bi := range msgs[mi].Blocks {
				b := &msgs[mi].Blocks[bi]
				if b.Type == ai.BlockToolUse && done[b.ID] && b.Meta != nil && b.Meta.Executing {
					b.Meta.Executing, b.Meta.ExecutingSince = false, 0
				}
			}
		}
	}
	err := s.upsertMessage(msg, func(c *chatstore.Chat) { clear(c.Messages) })
	if err == nil {
		s.hmu.Lock()
		clear(s.history)
		s.hmu.Unlock()
	}
	return err
}

// synthetic answers calls that are not executed (step limit, truncation)
// and persists the results.
func (x *executor) synthetic(msgID string, uses []ai.Block, code, message, hint, status string) {
	s := x.s
	var calls []*callState
	for _, tu := range uses {
		cs := &callState{tu: tu, leader: -1, start: s.now(), status: status, done: true}
		if t, ok := s.offered[tu.Name]; ok {
			cs.tool, cs.def = t, t.Def()
		}
		cs.res = tools.Errorf(tu.Name, code, hint, "%s", message)
		cs.content = cs.res.Render(0)
		ev := &ai.ToolStartEvent{MessageID: msgID, ToolCallID: tu.ID, Name: tu.Name, DisplayName: tu.Name, Kind: string(tools.KindRead), Args: escapedArgs(cs), Status: ai.ToolQueued, Warnings: []string{}}
		if cs.def != nil {
			ev.DisplayName, ev.Kind = cs.def.DisplayName, string(cs.def.Kind)
		}
		s.emit(ai.EventToolStart, ev)
		s.emit(ai.EventToolEnd, x.endEvent(cs))
		calls = append(calls, cs)
	}
	_ = x.persistResults(s.m.d.IDs.NewID(), calls)
}

// shrinkRunResults re-renders the largest not-yet-shrunk results of the
// current run at half their cap (§7.4 step 4). Content stays unchanged;
// the shrunk JSON goes into Meta.Shrunk.
func (x *executor) shrinkRunResults(onlyUnsent bool) bool {
	s := x.s
	x.mu.Lock()
	type cand struct {
		id   string
		st   *structured
		size int
	}
	var cs []cand
	for id, st := range x.structured {
		if st.shrunk || st.res.IsError() || onlyUnsent && st.msgID != x.lastBatch {
			continue
		}
		cs = append(cs, cand{id, st, len(st.res.Render(st.cap))})
	}
	x.mu.Unlock()
	if len(cs) == 0 {
		return false
	}
	sort.Slice(cs, func(i, j int) bool { return cs[i].size > cs[j].size })
	changed := map[string]string{}
	for i := 0; i < len(cs) && i < 3; i++ {
		c := cs[i]
		cp := c.st.cap
		if cp <= 0 {
			cp = c.size
		}
		sh := c.st.res.Render(cp / 2)
		if len(sh) < c.size {
			changed[c.id] = sh
			c.st.shrunk = true
		}
	}
	if len(changed) == 0 {
		return false
	}
	apply := func(msgs []ai.Message) {
		for mi := range msgs {
			for bi := range msgs[mi].Blocks {
				b := &msgs[mi].Blocks[bi]
				if sh, ok := changed[b.ToolUseID]; ok && b.Type == ai.BlockToolResult {
					if b.Meta == nil {
						b.Meta = &ai.BlockMeta{}
					}
					b.Meta.Shrunk = sh
				}
			}
		}
	}
	s.hmu.Lock()
	apply(s.history)
	_ = s.m.d.Store.Update(s.r.chatID, func(c *chatstore.Chat) error {
		apply(c.Messages)
		return nil
	})
	s.hmu.Unlock()
	return true
}

func normDN(dn string) string {
	parts := strings.Split(dn, ",")
	for i, p := range parts {
		k, v, _ := strings.Cut(p, "=")
		parts[i] = strings.ToLower(strings.TrimSpace(k)) + "=" + strings.ToLower(strings.TrimSpace(v))
	}
	return strings.Join(parts, ",")
}
