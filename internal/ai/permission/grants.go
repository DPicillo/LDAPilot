package permission

import (
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

// Grant limits (§6.3).
const (
	GrantUses     = 10
	GrantLifetime = 30 * time.Minute
)

// Grants holds "approve for this chat" grants in memory (lost on restart).
type Grants struct {
	mu       sync.Mutex
	clock    ai.Clock
	ids      ai.IDGen
	byChat   map[string][]*grant
	onChange func(chatID string, grants []ai.Grant)
}

type grant struct {
	g       ai.Grant
	scope   ai.GrantScope
	expires time.Time
}

// NewGrants creates the grant store.
func NewGrants(clock ai.Clock, ids ai.IDGen) *Grants {
	if clock == nil {
		clock = ai.SystemClock()
	}
	if ids == nil {
		ids = ai.UUIDGen()
	}
	return &Grants{clock: clock, ids: ids, byChat: map[string][]*grant{}}
}

// OnChange registers the ai:grants_updated callback.
func (g *Grants) OnChange(fn func(chatID string, grants []ai.Grant)) { g.onChange = fn }

// Add creates a grant from an approved change's scope.
func (g *Grants) Add(chatID, label string, scope ai.GrantScope) ai.Grant {
	now := g.clock.Now()
	gr := &grant{scope: scope, expires: now.Add(GrantLifetime)}
	gr.g = ai.Grant{ID: g.ids.NewID(), Tool: scope.Tool, ProfileID: scope.ProfileID, ConnectionLabel: label, Scope: scope.Description,
		Subtree: scope.Subtree, Attributes: append([]string{}, scope.Attributes...), UsesLeft: GrantUses, ExpiresAt: gr.expires.UnixMilli(), DNs: []string{}}
	if scope.GroupDN != "" {
		gr.g.DNs = []string{scope.GroupDN}
	}
	g.mu.Lock()
	g.byChat[chatID] = append(g.byChat[chatID], gr)
	g.mu.Unlock()
	g.changed(chatID)
	return gr.g
}

// MatchRequest describes a write to check against the grants.
type MatchRequest struct {
	Tool, ProfileID, TargetDN, GroupDN, Action string
	Attributes                                 []string // lower-case
}

// Match finds a valid grant covering the write and consumes one use.
func (g *Grants) Match(chatID string, m MatchRequest) (ai.Grant, bool) {
	now := g.clock.Now()
	g.mu.Lock()
	var hit *grant
	for _, gr := range g.byChat[chatID] {
		if gr.g.UsesLeft <= 0 || !now.Before(gr.expires) {
			continue
		}
		s := gr.scope
		if s.Tool != m.Tool || s.ProfileID != m.ProfileID || s.Action != m.Action {
			continue
		}
		if s.GroupDN != "" {
			if !strings.EqualFold(normalize(s.GroupDN), normalize(m.GroupDN)) {
				continue
			}
		} else if !strictlyUnder(m.TargetDN, s.Subtree) {
			// The approved entry's parent itself is never covered: a grant
			// for entries below OU=Users does not touch OU=Users.
			continue
		}
		if !subset(m.Attributes, s.Attributes) {
			continue
		}
		hit = gr
		break
	}
	var out ai.Grant
	if hit != nil {
		hit.g.UsesLeft--
		out = hit.g
	}
	g.mu.Unlock()
	if hit != nil {
		g.changed(chatID)
	}
	return out, hit != nil
}

func strictlyUnder(dn, base string) bool {
	return DNUnder(dn, base) && !DNUnder(base, dn)
}

func normalize(dn string) string { return strings.ToLower(strings.ReplaceAll(dn, " ", "")) }

func subset(a, b []string) bool {
	set := map[string]bool{}
	for _, x := range b {
		set[strings.ToLower(x)] = true
	}
	for _, x := range a {
		if !set[strings.ToLower(x)] {
			return false
		}
	}
	return true
}

// List returns the active grants of a chat (expired and used-up ones are
// pruned).
func (g *Grants) List(chatID string) []ai.Grant {
	now := g.clock.Now()
	g.mu.Lock()
	defer g.mu.Unlock()
	var kept []*grant
	out := []ai.Grant{}
	for _, gr := range g.byChat[chatID] {
		if gr.g.UsesLeft > 0 && now.Before(gr.expires) {
			kept = append(kept, gr)
			out = append(out, gr.g)
		}
	}
	g.byChat[chatID] = kept
	sort.Slice(out, func(i, j int) bool { return out[i].ExpiresAt < out[j].ExpiresAt })
	return out
}

// ErrUnknownGrant is returned by Revoke for an unknown grant.
var ErrUnknownGrant = errors.New("unknown grant")

// Revoke removes a grant.
func (g *Grants) Revoke(chatID, id string) error {
	g.mu.Lock()
	found := false
	list := g.byChat[chatID]
	for i, gr := range list {
		if gr.g.ID == id {
			g.byChat[chatID] = append(list[:i:i], list[i+1:]...)
			found = true
			break
		}
	}
	g.mu.Unlock()
	if !found {
		return ErrUnknownGrant
	}
	g.changed(chatID)
	return nil
}

// Drop forgets all grants of a chat.
func (g *Grants) Drop(chatID string) {
	g.mu.Lock()
	delete(g.byChat, chatID)
	g.mu.Unlock()
}

func (g *Grants) changed(chatID string) {
	if g.onChange != nil {
		g.onChange(chatID, g.List(chatID))
	}
}

// Consents holds per-chat access decisions for ask-level connections,
// bound to the provider host (memory only).
type Consents struct {
	mu sync.Mutex
	m  map[string]string // chat|profile|host → approved | denied
}

// NewConsents creates the consent store.
func NewConsents() *Consents { return &Consents{m: map[string]string{}} }

func consentKey(chatID, profileID, host string) string {
	return chatID + "|" + profileID + "|" + strings.ToLower(host)
}

// Get returns "approved", "denied" or "".
func (c *Consents) Get(chatID, profileID, host string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.m[consentKey(chatID, profileID, host)]
}

// Set records a decision.
func (c *Consents) Set(chatID, profileID, host, decision string) {
	c.mu.Lock()
	c.m[consentKey(chatID, profileID, host)] = decision
	c.mu.Unlock()
}

// DropChat forgets the decisions of a chat.
func (c *Consents) DropChat(chatID string) {
	c.mu.Lock()
	for k := range c.m {
		if strings.HasPrefix(k, chatID+"|") {
			delete(c.m, k)
		}
	}
	c.mu.Unlock()
}
