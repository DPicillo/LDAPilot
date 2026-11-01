// Package fake holds fakes for harness tests: a scripted provider and an
// in-memory directory (separate from aitest to avoid import cycles with
// the provider tests).
package fake

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"

	ber "github.com/go-asn1-ber/asn1-ber"
	goldap "github.com/go-ldap/ldap/v3"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/ldaptools"
	"github.com/dpicillo/LDAPilot/internal/ai/provider"
	"github.com/dpicillo/LDAPilot/internal/config"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// KeyCipher is a chat store cipher with a fixed key (no app key file).
type KeyCipher struct{ Key []byte }

func (k KeyCipher) Seal(p, aad []byte) ([]byte, error) { return config.SealWithKey(k.Key, p, aad) }
func (k KeyCipher) Open(s, aad []byte) ([]byte, error) { return config.OpenWithKey(k.Key, s, aad) }

// TestKey is a fixed 32-byte key.
var TestKey = []byte("0123456789abcdef0123456789abcdef")

// --- scripted provider ---

// Step is one scripted provider response.
type Step struct {
	Text      string     // streamed as text deltas (split in two)
	Thinking  string     // streamed as a thinking delta
	Calls     []ToolCall // tool_use blocks
	Stop      ai.StopReason
	Usage     ai.Usage
	Err       error
	Block     bool // block until ctx is cancelled (cancellation tests)
	OnRequest func(req *provider.Request)
}

// ToolCall is a scripted tool call.
type ToolCall struct {
	Name string
	Args string // JSON
}

// ScriptedProvider replays Steps in order and records every request.
type ScriptedProvider struct {
	mu       sync.Mutex
	steps    []Step
	Requests []RecordedRequest
	KindName string
	Model    string
	Caps     provider.Caps
	// Default is returned when the script is exhausted.
	Default *Step
	// Started is signalled whenever Stream starts (for tests).
	Started chan int
	// SummaryText answers tool-less (compaction) requests when set.
	SummaryText string
	// KeyName is the provider key when it differs from the kind (e.g.
	// "openai/ollama"); Models replaces the one-model listing.
	KeyName string
	Models  []ai.ModelInfo
	// CapsErr is returned by ModelCaps (an unreachable endpoint).
	CapsErr error
}

// RecordedRequest is a JSON snapshot of a request.
type RecordedRequest struct {
	Body     string
	ToolLess bool
	Req      provider.Request
}

// NewScripted creates a provider with the given steps.
func NewScripted(steps ...Step) *ScriptedProvider {
	return &ScriptedProvider{steps: steps, KindName: provider.KindOllama, Model: "fake-model",
		Caps: provider.Caps{ContextWindow: 32768, Tools: ai.CapYes, Thinking: ai.CapNo, Source: "test"}, Started: make(chan int, 64)}
}

// Push appends steps.
func (p *ScriptedProvider) Push(steps ...Step) {
	p.mu.Lock()
	p.steps = append(p.steps, steps...)
	p.mu.Unlock()
}

func (p *ScriptedProvider) Kind() string { return p.KindName }
func (p *ScriptedProvider) Key() string {
	if p.KeyName != "" {
		return p.KeyName
	}
	return p.KindName
}

func (p *ScriptedProvider) ListModels(ctx context.Context) ([]ai.ModelInfo, error) {
	if p.Models != nil {
		return append([]ai.ModelInfo(nil), p.Models...), nil
	}
	return []ai.ModelInfo{{ID: p.Model, Tools: ai.CapYes}}, nil
}

func (p *ScriptedProvider) ModelCaps(ctx context.Context, model string) (provider.Caps, error) {
	return p.Caps, p.CapsErr
}

// RequestsSnapshot returns a copy of the recorded requests (safe while a
// run or a background title request is still going).
func (p *ScriptedProvider) RequestsSnapshot() []RecordedRequest {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]RecordedRequest(nil), p.Requests...)
}

// Bodies returns all recorded request bodies.
func (p *ScriptedProvider) Bodies() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]string, len(p.Requests))
	for i, r := range p.Requests {
		out[i] = r.Body
	}
	return out
}

func (p *ScriptedProvider) Stream(ctx context.Context, req *provider.Request, sink func(provider.Event)) (*provider.Response, error) {
	b, _ := json.Marshal(req)
	p.mu.Lock()
	n := len(p.Requests)
	p.Requests = append(p.Requests, RecordedRequest{Body: string(b), ToolLess: req.ToolLess, Req: *req})
	var st Step
	switch {
	case req.ToolLess:
		st = Step{Text: "Summary of the conversation.", Stop: ai.StopEndTurn}
		if p.SummaryText != "" {
			st.Text = p.SummaryText
		}
	case len(p.steps) > 0:
		st = p.steps[0]
		p.steps = p.steps[1:]
	case p.Default != nil:
		st = *p.Default
	default:
		st = Step{Text: "done", Stop: ai.StopEndTurn}
	}
	p.mu.Unlock()
	select {
	case p.Started <- n:
	default:
	}
	if st.OnRequest != nil {
		st.OnRequest(req)
	}
	var blocks []ai.Block
	idx := 0
	if st.Thinking != "" {
		sink(provider.Event{Kind: provider.EvThinkingDelta, BlockIndex: idx, Text: st.Thinking})
		blocks = append(blocks, ai.Block{Type: ai.BlockThinking, Thinking: st.Thinking, Producer: provider.Producer(p.KindName, p.Model)})
		idx++
	}
	if st.Text != "" {
		half := len(st.Text) / 2
		for half > 0 && half < len(st.Text) && (st.Text[half]&0xC0) == 0x80 {
			half--
		}
		sink(provider.Event{Kind: provider.EvTextDelta, BlockIndex: idx, Text: st.Text[:half]})
		if st.Block {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		sink(provider.Event{Kind: provider.EvTextDelta, BlockIndex: idx, Text: st.Text[half:]})
		blocks = append(blocks, ai.Block{Type: ai.BlockText, Text: st.Text})
	} else if st.Block {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if st.Err != nil {
		return nil, st.Err
	}
	for i, c := range st.Calls {
		args := c.Args
		if args == "" {
			args = "{}"
		}
		blocks = append(blocks, ai.Block{Type: ai.BlockToolUse, ProviderCallID: fmt.Sprintf("call_%d", i), Name: c.Name, Input: json.RawMessage(args),
			Producer: provider.Producer(p.KindName, p.Model)})
		sink(provider.Event{Kind: provider.EvToolUseStart, ToolName: c.Name})
	}
	stop := st.Stop
	if stop == "" {
		stop = ai.StopEndTurn
		if len(st.Calls) > 0 {
			stop = ai.StopToolUse
		}
	}
	u := st.Usage
	if u.InputTokens == 0 {
		u.InputTokens, u.OutputTokens = 1000, 50
	}
	return &provider.Response{Message: ai.Message{Role: ai.RoleAssistant, Blocks: blocks}, StopReason: stop, Usage: u, Model: p.Model, Complete: true}, nil
}

// --- in-memory directory ---

// FakeDir is an in-memory ldaptools.Directory.
type FakeDir struct {
	mu      sync.Mutex
	clients map[string]*FakeClient
	order   []string
}

// NewFakeDir creates an empty directory.
func NewFakeDir() *FakeDir { return &FakeDir{clients: map[string]*FakeClient{}} }

// Add registers a connected profile.
func (d *FakeDir) Add(c *FakeClient) {
	d.mu.Lock()
	d.clients[c.info.ProfileID] = c
	d.order = append(d.order, c.info.ProfileID)
	d.mu.Unlock()
}

// Remove disconnects a profile.
func (d *FakeDir) Remove(id string) {
	d.mu.Lock()
	delete(d.clients, id)
	d.mu.Unlock()
}

func (d *FakeDir) Connections() []ldaptools.ConnInfo {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []ldaptools.ConnInfo
	for _, id := range d.order {
		if c, ok := d.clients[id]; ok {
			out = append(out, c.Info())
		}
	}
	return out
}

func (d *FakeDir) Client(id string) (ldaptools.DirClient, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	c, ok := d.clients[id]
	if !ok {
		return nil, ldaptools.ErrNotConnected
	}
	return c, nil
}

// Op is a recorded directory operation.
type Op struct {
	Op      string // search | types | modify | add | modrdn | delete | passwd | schema | serverinfo
	DN      string
	Filter  string
	Attrs   []string
	Changes []models.AttributeChange
	Assert  string
	Value   string // passwd: the value (only here, for secrecy tests)
}

// FakeClient is an in-memory DirClient.
type FakeClient struct {
	mu        sync.Mutex
	info      ldaptools.ConnInfo
	SI        *models.ServerInfo
	entries   map[string]*models.LDAPEntry
	order     []string
	AttrDefs  []string
	ClassDefs []string
	Ops       []Op
	// Password is the profile's bind password: the fake never returns it,
	// so it must never appear anywhere (sentinel tests).
	Password string
	// Hooks.
	ModifyHook func(ctx context.Context) error
	SearchHook func(p models.SearchParams) error
	// AccountApplyHook returns the changes the account delegate actually
	// sends for a plan (like the real ApplyAccountChange, which re-plans
	// and may drop the pwdFailureTime delete); nil = the plan's changes.
	AccountApplyHook func(planned []models.AttributeChange) []models.AttributeChange
	Clock            ai.Clock
	// Shuffle returns matches in a different order on every search.
	Shuffle bool
	// ServerLimit caps every search like a server size limit.
	ServerLimit int
	// Deleted is the content of the Deleted Objects container (AD).
	Deleted []models.DeletedObject
	calls   int
}

// NewFakeClient creates a client for a profile.
func NewFakeClient(info ldaptools.ConnInfo, si *models.ServerInfo) *FakeClient {
	if si.ServerType == "" {
		si.ServerType = info.ServerType
	}
	if info.ServerType == "" {
		info.ServerType = si.ServerType
	}
	return &FakeClient{info: info, SI: si, entries: map[string]*models.LDAPEntry{}}
}

// Put stores an entry (attributes as name → values).
func (c *FakeClient) Put(dn string, attrs map[string][]string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := &models.LDAPEntry{DN: dn}
	keys := make([]string, 0, len(attrs))
	for k := range attrs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		e.Attributes = append(e.Attributes, models.LDAPAttribute{Name: k, Values: attrs[k]})
	}
	key := strings.ToLower(dn)
	if _, ok := c.entries[key]; !ok {
		c.order = append(c.order, key)
	}
	c.entries[key] = e
}

// Get returns an entry copy.
func (c *FakeClient) Get(dn string) *models.LDAPEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.entries[strings.ToLower(dn)]
	if e == nil {
		return nil
	}
	cp := *e
	cp.Attributes = append([]models.LDAPAttribute(nil), e.Attributes...)
	return &cp
}

// SetReadOnly flips the profile's read-only flag (live).
func (c *FakeClient) SetReadOnly(ro bool) {
	c.mu.Lock()
	c.info.ReadOnly = ro
	c.mu.Unlock()
}

// Recorded returns the operations so far.
func (c *FakeClient) Recorded() []Op {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Op(nil), c.Ops...)
}

func (c *FakeClient) record(o Op) {
	c.mu.Lock()
	c.Ops = append(c.Ops, o)
	c.mu.Unlock()
}

func (c *FakeClient) Info() ldaptools.ConnInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.info
}

func (c *FakeClient) ServerInfo(ctx context.Context) (*models.ServerInfo, error) {
	si := *c.SI
	return &si, nil
}

func (c *FakeClient) RootDSE(ctx context.Context, attrs []string) (*models.LDAPEntry, error) {
	return &models.LDAPEntry{Attributes: []models.LDAPAttribute{{Name: "domainFunctionality", Values: []string{"7"}}, {Name: "dnsHostName", Values: []string{"dc1.example.com"}}}}, nil
}

func (c *FakeClient) Schema(ctx context.Context) ([]string, []string, error) {
	c.record(Op{Op: "schema"})
	return c.AttrDefs, c.ClassDefs, nil
}

var operational = map[string]bool{"createtimestamp": true, "modifytimestamp": true, "entryuuid": true, "msds-user-account-control-computed": true,
	"msds-resultantpso": true, "pwdaccountlockedtime": true, "pwdfailuretime": true, "pwdchangedtime": true, "pwdreset": true}

func (c *FakeClient) match(p models.SearchParams) ([]models.LDAPEntry, bool, error) {
	if c.SearchHook != nil {
		if err := c.SearchHook(p); err != nil {
			return nil, false, err
		}
	}
	filter := p.Filter
	if filter == "" {
		filter = "(objectClass=*)"
	}
	f, err := goldap.CompileFilter(filter)
	if err != nil {
		return nil, false, &goldap.Error{ResultCode: goldap.LDAPResultFilterError, Err: err}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	base := strings.ToLower(p.BaseDN)
	if _, ok := c.entries[base]; !ok && base != "" {
		return nil, false, &goldap.Error{ResultCode: goldap.LDAPResultNoSuchObject, Err: errors.New("no such object")}
	}
	var out []models.LDAPEntry
	truncated := false
	order := append([]string(nil), c.order...)
	c.calls++
	if c.Shuffle && c.calls%2 == 0 {
		for i, j := 0, len(order)-1; i < j; i, j = i+1, j-1 {
			order[i], order[j] = order[j], order[i]
		}
	}
	limit := p.SizeLimit
	if c.ServerLimit > 0 && (limit == 0 || c.ServerLimit < limit) {
		limit = c.ServerLimit
	}
	for _, key := range order {
		e := c.entries[key]
		if e == nil || !inScope(key, base, p.Scope) || !evalFilter(f, e) {
			continue
		}
		if limit > 0 && len(out) >= limit {
			truncated = true
			break
		}
		out = append(out, project(e, p.Attributes))
	}
	return out, truncated, nil
}

func inScope(dn, base string, scope models.SearchScope) bool {
	switch scope {
	case models.ScopeBase:
		return dn == base
	case models.ScopeOne:
		i := strings.Index(dn, ",")
		return i > 0 && dn[i+1:] == base
	}
	return dn == base || strings.HasSuffix(dn, ","+base) || base == ""
}

func project(e *models.LDAPEntry, attrs []string) models.LDAPEntry {
	out := models.LDAPEntry{DN: e.DN}
	all := len(attrs) == 0
	want := map[string]bool{}
	for _, a := range attrs {
		if a == "*" {
			all = true
		}
		want[strings.ToLower(a)] = true
	}
	if want["1.1"] && len(attrs) == 1 {
		return out
	}
	for _, a := range e.Attributes {
		l := strings.ToLower(a.Name)
		base := l
		if i := strings.IndexByte(l, ';'); i >= 0 {
			base = l[:i]
		}
		if want[l] || want[base] || all && !operational[base] {
			out.Attributes = append(out.Attributes, models.LDAPAttribute{Name: a.Name, Values: append([]string(nil), a.Values...), Binary: a.Binary})
		}
	}
	return out
}

func (c *FakeClient) Search(ctx context.Context, p models.SearchParams) (*models.SearchResult, error) {
	c.record(Op{Op: "search", DN: p.BaseDN, Filter: p.Filter, Attrs: append([]string(nil), p.Attributes...)})
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	es, tr, err := c.match(p)
	if err != nil {
		return nil, err
	}
	return &models.SearchResult{Entries: es, TotalCount: len(es), Truncated: tr}, nil
}

func (c *FakeClient) SearchTypesOnly(ctx context.Context, p models.SearchParams) (map[string][]string, error) {
	c.record(Op{Op: "types", DN: p.BaseDN, Filter: p.Filter})
	p.Attributes = []string{"*"}
	es, _, err := c.match(p)
	if err != nil {
		return nil, err
	}
	out := map[string][]string{}
	for _, e := range es {
		for _, a := range e.Attributes {
			out[e.DN] = append(out[e.DN], a.Name)
		}
	}
	return out, nil
}

func (c *FakeClient) checkWritable() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.info.ReadOnly {
		return errors.New("connection is read-only")
	}
	return nil
}

func (c *FakeClient) Modify(ctx context.Context, dn string, changes []models.AttributeChange, assert string) error {
	c.record(Op{Op: "modify", DN: dn, Changes: changes, Assert: assert})
	if err := c.checkWritable(); err != nil {
		return err
	}
	if c.ModifyHook != nil {
		if err := c.ModifyHook(ctx); err != nil {
			return err
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.entries[strings.ToLower(dn)]
	if e == nil {
		return &goldap.Error{ResultCode: goldap.LDAPResultNoSuchObject, Err: errors.New("no such object")}
	}
	if assert != "" {
		f, err := goldap.CompileFilter(assert)
		if err != nil || !evalFilter(f, e) {
			return &goldap.Error{ResultCode: 122, Err: errors.New("assertion failed")}
		}
	}
	for _, ch := range changes {
		idx := -1
		for i, a := range e.Attributes {
			if strings.EqualFold(a.Name, ch.Attribute) {
				idx = i
			}
		}
		switch ch.Operation {
		case models.ChangeReplace:
			if idx >= 0 {
				e.Attributes = append(e.Attributes[:idx], e.Attributes[idx+1:]...)
			}
			if len(ch.Values) > 0 {
				e.Attributes = append(e.Attributes, models.LDAPAttribute{Name: ch.Attribute, Values: append([]string(nil), ch.Values...)})
			}
		case models.ChangeAdd:
			if idx >= 0 {
				e.Attributes[idx].Values = append(e.Attributes[idx].Values, ch.Values...)
			} else {
				e.Attributes = append(e.Attributes, models.LDAPAttribute{Name: ch.Attribute, Values: append([]string(nil), ch.Values...)})
			}
		case models.ChangeDelete:
			if idx < 0 {
				return &goldap.Error{ResultCode: goldap.LDAPResultNoSuchAttribute, Err: errors.New("no such attribute")}
			}
			if len(ch.Values) == 0 {
				e.Attributes = append(e.Attributes[:idx], e.Attributes[idx+1:]...)
				continue
			}
			var kept []string
			for _, v := range e.Attributes[idx].Values {
				drop := false
				for _, d := range ch.Values {
					if strings.EqualFold(v, d) {
						drop = true
					}
				}
				if !drop {
					kept = append(kept, v)
				}
			}
			if len(kept) == len(e.Attributes[idx].Values) {
				return &goldap.Error{ResultCode: goldap.LDAPResultNoSuchAttribute, Err: errors.New("no such value")}
			}
			e.Attributes[idx].Values = kept
		}
	}
	return nil
}

func (c *FakeClient) Add(ctx context.Context, dn string, attrs []models.LDAPAttribute) error {
	c.record(Op{Op: "add", DN: dn})
	if err := c.checkWritable(); err != nil {
		return err
	}
	m := map[string][]string{}
	for _, a := range attrs {
		m[a.Name] = a.Values
	}
	c.Put(dn, m)
	return nil
}

func (c *FakeClient) ModifyDN(ctx context.Context, dn, newRDN string, deleteOld bool, newSuperior string) error {
	c.record(Op{Op: "modrdn", DN: dn})
	return c.checkWritable()
}

func (c *FakeClient) Delete(ctx context.Context, dn string, assert string) error {
	c.record(Op{Op: "delete", DN: dn, Assert: assert})
	if err := c.checkWritable(); err != nil {
		return err
	}
	c.mu.Lock()
	delete(c.entries, strings.ToLower(dn))
	c.mu.Unlock()
	return nil
}

func (c *FakeClient) PasswordModify(ctx context.Context, dn, value string) error {
	c.record(Op{Op: "passwd", DN: dn, Value: value})
	return c.checkWritable()
}

// --- filter evaluation (enough for tests) ---

func attrVals(e *models.LDAPEntry, name string) []string {
	if strings.EqualFold(name, "distinguishedName") {
		return []string{e.DN}
	}
	for _, a := range e.Attributes {
		n := a.Name
		if i := strings.IndexByte(n, ';'); i >= 0 {
			n = n[:i]
		}
		if strings.EqualFold(n, name) {
			return a.Values
		}
	}
	return nil
}

func pstr(p *ber.Packet) string {
	if s, ok := p.Value.(string); ok && s != "" {
		return s
	}
	if p.Data != nil {
		return p.Data.String()
	}
	return ""
}

func evalFilter(p *ber.Packet, e *models.LDAPEntry) bool {
	switch p.Tag {
	case goldap.FilterAnd:
		for _, c := range p.Children {
			if !evalFilter(c, e) {
				return false
			}
		}
		return true
	case goldap.FilterOr:
		for _, c := range p.Children {
			if evalFilter(c, e) {
				return true
			}
		}
		return false
	case goldap.FilterNot:
		return len(p.Children) > 0 && !evalFilter(p.Children[0], e)
	case goldap.FilterPresent:
		if strings.EqualFold(pstr(p), "objectClass") {
			return true
		}
		return len(attrVals(e, pstr(p))) > 0
	case goldap.FilterEqualityMatch, goldap.FilterApproxMatch:
		a, v := pstr(p.Children[0]), pstr(p.Children[1])
		for _, x := range attrVals(e, a) {
			if strings.EqualFold(x, v) {
				return true
			}
		}
		return false
	case goldap.FilterGreaterOrEqual, goldap.FilterLessOrEqual:
		a, v := pstr(p.Children[0]), pstr(p.Children[1])
		for _, x := range attrVals(e, a) {
			xi, err1 := strconv.ParseInt(x, 10, 64)
			vi, err2 := strconv.ParseInt(v, 10, 64)
			cmp := strings.Compare(x, v)
			if err1 == nil && err2 == nil {
				cmp = 0
				if xi < vi {
					cmp = -1
				} else if xi > vi {
					cmp = 1
				}
			}
			if p.Tag == goldap.FilterGreaterOrEqual && cmp >= 0 || p.Tag == goldap.FilterLessOrEqual && cmp <= 0 {
				return true
			}
		}
		return false
	case goldap.FilterSubstrings:
		a := pstr(p.Children[0])
		for _, x := range attrVals(e, a) {
			lx := strings.ToLower(x)
			ok := true
			pos := 0
			for _, s := range p.Children[1].Children {
				sv := strings.ToLower(pstr(s))
				switch s.Tag {
				case 0: // initial
					if !strings.HasPrefix(lx, sv) {
						ok = false
					}
					pos = len(sv)
				case 1: // any
					i := strings.Index(lx[pos:], sv)
					if i < 0 {
						ok = false
					} else {
						pos += i + len(sv)
					}
				case 2: // final
					if !strings.HasSuffix(lx[pos:], sv) {
						ok = false
					}
				}
			}
			if ok {
				return true
			}
		}
		return false
	case goldap.FilterExtensibleMatch:
		var rule, typ, val string
		for _, c := range p.Children {
			switch c.Tag {
			case 1:
				rule = pstr(c)
			case 2:
				typ = pstr(c)
			case 3:
				val = pstr(c)
			}
		}
		for _, x := range attrVals(e, typ) {
			if rule == "1.2.840.113556.1.4.803" {
				xi, _ := strconv.ParseInt(x, 10, 64)
				vi, _ := strconv.ParseInt(val, 10, 64)
				if xi&vi == vi {
					return true
				}
				continue
			}
			if strings.EqualFold(x, val) {
				return true
			}
		}
		return false
	}
	return false
}
