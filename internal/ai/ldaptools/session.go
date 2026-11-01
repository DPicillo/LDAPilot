package ldaptools

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// Conn is a connection offered to the model in a run.
type Conn struct {
	Info  ConnInfo
	Label string
}

// AccessView answers access questions for the run's chat with the live
// policy (the stricter of run-start and current).
type AccessView interface {
	// Level returns the effective level of the profile (none | ask | read
	// | write) and whether the user still has to consent (ask level).
	Level(profileID string) (level string, needsConsent bool)
	// WritesAllowed reports the master switch.
	WritesAllowed() bool
}

// Session is the per-run state shared by the tools of one run.
type Session struct {
	ChatID          string
	RunID           string
	Dir             Directory
	Conns           []*Conn // offered at run start (level ask, read or write)
	ActiveProfileID string
	Access          AccessView
	Redact          func() RedactPolicy // live redaction policy
	Shared          *Shared
	Clock           ai.Clock
}

func (s *Session) now() time.Time {
	if s.Clock == nil {
		return time.Now()
	}
	return s.Clock.Now()
}

// Call is one validated tool call with its resolved connection.
type Call struct {
	ID        string
	Tool      string
	Args      tools.Args
	Conn      *Conn     // nil for local tools
	Client    DirClient // client of Conn
	Defaulted bool      // the active connection was used because none was named
	Notes     []string  // validation notes (ignored arguments)
	// MentionOnly: the call was allowed only by an @entry mention on an
	// "ask" directory (consent for exactly that DN, §6.1); the tool must
	// not read anything else, e.g. same-named candidates of a missing DN.
	MentionOnly bool
}

// --- connection labels and resolution ---

// LabelConnections assigns labels: the profile name; duplicates become
// "Name (host)", then "Name (host) [id8]".
func LabelConnections(infos []ConnInfo) []*Conn {
	sorted := append([]ConnInfo(nil), infos...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].Name != sorted[j].Name {
			return sorted[i].Name < sorted[j].Name
		}
		return sorted[i].ProfileID < sorted[j].ProfileID
	})
	count := map[string]int{}
	for _, c := range sorted {
		count[strings.ToLower(c.Name)]++
	}
	out := make([]*Conn, 0, len(sorted))
	used := map[string]int{}
	for _, c := range sorted {
		label := strings.TrimSpace(c.Name)
		if label == "" {
			label = c.Host
		}
		if count[strings.ToLower(c.Name)] > 1 {
			label = fmt.Sprintf("%s (%s)", label, c.Host)
		}
		used[strings.ToLower(label)]++
		out = append(out, &Conn{Info: c, Label: label})
	}
	for _, c := range out {
		if used[strings.ToLower(c.Label)] > 1 {
			id := c.Info.ProfileID
			if len(id) > 8 {
				id = id[:8]
			}
			c.Label = fmt.Sprintf("%s [%s]", c.Label, id)
		}
	}
	return out
}

// Labels returns the labels of conns.
func Labels(conns []*Conn) []string {
	out := make([]string, len(conns))
	for i, c := range conns {
		out[i] = c.Label
	}
	return out
}

// ResolveConn resolves the connection argument (§5.1): exact label →
// profile ID → case-insensitive unique name → the only connection → the
// UI's active connection (defaulted) → UNKNOWN_CONNECTION.
func ResolveConn(tool string, conns []*Conn, arg, activeProfileID string) (*Conn, bool, *tools.Result) {
	arg = strings.TrimSpace(arg)
	if arg != "" {
		for _, c := range conns {
			if c.Label == arg {
				return c, false, nil
			}
		}
		for _, c := range conns {
			if c.Info.ProfileID == arg {
				return c, false, nil
			}
		}
		var match *Conn
		n := 0
		for _, c := range conns {
			if strings.EqualFold(c.Label, arg) || strings.EqualFold(c.Info.Name, arg) {
				match = c
				n++
			}
		}
		if n == 1 {
			return match, false, nil
		}
	} else {
		if len(conns) == 1 {
			return conns[0], false, nil
		}
		for _, c := range conns {
			if c.Info.ProfileID == activeProfileID && activeProfileID != "" {
				return c, true, nil
			}
		}
	}
	msg := "No directory with this name is available."
	if arg == "" {
		msg = "Several directories are available; name one with the connection argument."
	}
	r := tools.Errorf(tool, tools.ErrUnknownConnection,
		"Valid connections: "+strings.Join(quoteAll(Labels(conns)), ", ")+". Connections opened after this turn started become available with the user's next message.",
		"%s", msg)
	return nil, false, r.WithExtra("valid_connections", Labels(conns))
}

func quoteAll(ss []string) []string {
	out := make([]string, len(ss))
	for i, s := range ss {
		out[i] = fmt.Sprintf("%q", s)
	}
	return out
}

// --- shared caches ---

// Shared holds caches shared by all runs: schemas and server info per
// profile, and the per-chat result caches.
type Shared struct {
	mu      sync.Mutex
	clock   ai.Clock
	schemas map[string]*schemaEntry
	chats   map[string]*ChatCache
	extra   func(string) bool
}

type schemaEntry struct {
	s  *Schema
	at time.Time
}

// NewShared creates the shared caches.
func NewShared(clock ai.Clock) *Shared {
	if clock == nil {
		clock = ai.SystemClock()
	}
	return &Shared{clock: clock, schemas: map[string]*schemaEntry{}, chats: map[string]*ChatCache{}}
}

const schemaTTL = 10 * time.Minute

// Schema returns the cached schema of the client's profile, reading it if
// needed. nil when the schema cannot be read.
func (sh *Shared) Schema(ctx context.Context, dc DirClient) *Schema {
	id := dc.Info().ProfileID
	sh.mu.Lock()
	e := sh.schemas[id]
	sh.mu.Unlock()
	if e != nil && sh.clock.Now().Sub(e.at) < schemaTTL {
		return e.s
	}
	at, oc, err := dc.Schema(ctx)
	if err != nil {
		if e != nil {
			return e.s
		}
		return nil
	}
	s := ParseSchema(at, oc)
	sh.mu.Lock()
	sh.schemas[id] = &schemaEntry{s: s, at: sh.clock.Now()}
	sh.mu.Unlock()
	return s
}

// Chat returns the result cache of a chat.
func (sh *Shared) Chat(chatID string) *ChatCache {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	c := sh.chats[chatID]
	if c == nil {
		c = &ChatCache{clock: sh.clock}
		sh.chats[chatID] = c
	}
	return c
}

// DropChat forgets a chat's cache.
func (sh *Shared) DropChat(chatID string) {
	sh.mu.Lock()
	delete(sh.chats, chatID)
	sh.mu.Unlock()
}

// Invalidate drops every AI cache entry of a profile in every chat (after
// an AI write).
func (sh *Shared) Invalidate(profileID string) {
	sh.mu.Lock()
	chats := make([]*ChatCache, 0, len(sh.chats))
	for _, c := range sh.chats {
		chats = append(chats, c)
	}
	sh.mu.Unlock()
	for _, c := range chats {
		c.invalidate(profileID)
	}
}

// ChatCache is a small LRU (5 entries, 10 min) of tool results per chat.
type ChatCache struct {
	mu      sync.Mutex
	clock   ai.Clock
	entries []*cacheEntry
}

type cacheEntry struct {
	key, profile string
	v            any
	at           time.Time
}

const (
	chatCacheSize = 5
	chatCacheTTL  = 10 * time.Minute
)

// Get returns a cached value.
func (c *ChatCache) Get(key string) (any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.clock.Now()
	for i, e := range c.entries {
		if e.key == key {
			if now.Sub(e.at) > chatCacheTTL {
				c.entries = append(c.entries[:i], c.entries[i+1:]...)
				return nil, false
			}
			// move to front
			c.entries = append([]*cacheEntry{e}, append(c.entries[:i:i], c.entries[i+1:]...)...)
			return e.v, true
		}
	}
	return nil, false
}

// Put stores a value for a profile.
func (c *ChatCache) Put(profileID, key string, v any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i, e := range c.entries {
		if e.key == key {
			c.entries = append(c.entries[:i], c.entries[i+1:]...)
			break
		}
	}
	c.entries = append([]*cacheEntry{{key: key, profile: profileID, v: v, at: c.clock.Now()}}, c.entries...)
	if len(c.entries) > chatCacheSize {
		c.entries = c.entries[:chatCacheSize]
	}
}

func (c *ChatCache) invalidate(profileID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	kept := c.entries[:0]
	for _, e := range c.entries {
		if e.profile != profileID {
			kept = append(kept, e)
		}
	}
	c.entries = kept
}

// --- helpers used by the tools ---

func (s *Session) redactor(ctx context.Context, dc DirClient) *Redactor {
	var pol RedactPolicy
	if s.Redact != nil {
		pol = s.Redact()
	}
	var sch *Schema
	if dc != nil && s.Shared != nil {
		sch = s.Shared.Schema(ctx, dc)
	}
	return NewRedactor(pol, sch)
}

// serverType returns the server type of the client ("other" if unknown).
func serverType(ctx context.Context, dc DirClient) string {
	if t := dc.Info().ServerType; t != "" {
		return t
	}
	if si, err := dc.ServerInfo(ctx); err == nil && si.ServerType != "" {
		return si.ServerType
	}
	return models.ServerTypeOther
}

// baseDN returns the default base DN of a connection.
func baseDN(ctx context.Context, dc DirClient) string {
	if b := dc.Info().BaseDN; b != "" {
		return b
	}
	if si, err := dc.ServerInfo(ctx); err == nil {
		if si.DefaultNamingContext != "" {
			return si.DefaultNamingContext
		}
		if len(si.NamingContexts) > 0 {
			return si.NamingContexts[0]
		}
	}
	return ""
}

// noiseAttrs are omitted by get_entry without an attribute list.
var noiseAttrs = toSet("dSCorePropagationData", "uSNChanged", "uSNCreated", "replPropertyMetaData", "replUpToDateVector",
	"repsFrom", "repsTo", "msDS-RevealedUsers", "msDS-ReplAttributeMetaData", "msDS-ReplValueMetaData",
	"nTSecurityDescriptor", "instanceType", "objectCategory", "showInAdvancedViewOnly", "codePage", "countryCode",
	"revision", "msDS-NCType")

// rangeInfo parses "member;range=0-1499".
func rangeInfo(name string) (base string, start int, end int, isRange bool) {
	parts := strings.Split(name, ";")
	base = parts[0]
	for _, p := range parts[1:] {
		if strings.HasPrefix(strings.ToLower(p), "range=") {
			r := p[len("range="):]
			lo, hi, ok := strings.Cut(r, "-")
			if !ok {
				continue
			}
			fmt.Sscanf(lo, "%d", &start)
			if hi == "*" {
				end = -1
			} else {
				fmt.Sscanf(hi, "%d", &end)
			}
			return base, start, end, true
		}
	}
	return base, 0, 0, false
}

// renderAttrs renders an entry's attributes for the model: secrets
// redacted, binary summarized, values sanitized and annotated, long lists
// cut to maxValues with "<attr>_count".
func renderAttrs(e models.LDAPEntry, red *Redactor, z *Sanitizer, maxValues int, omit map[string]bool, notes *[]string) (tools.Fields, []string, []string) {
	var f tools.Fields
	var omitted, redacted []string
	dn := e.DN
	for _, a := range e.Attributes {
		base, start, end, ranged := rangeInfo(a.Name)
		name := base
		if omit != nil && omit[strings.ToLower(name)] {
			omitted = append(omitted, name)
			continue
		}
		label := z.Text(name, "attribute name", dn)
		if red.IsSecret(name) {
			f.Add(label, RedactedValue)
			redacted = append(redacted, name)
			continue
		}
		dnSyntax := red.Schema().IsDNSyntax(name)
		vals := make([]string, 0, min(len(a.Values), maxValues))
		for i, v := range a.Values {
			if i >= maxValues {
				break
			}
			switch {
			case a.Binary:
				vals = append(vals, BinarySummary(v))
			default:
				sv := z.Value(name, dn, v, dnSyntax)
				if ann := Annotate(name, v); ann != "" {
					sv += " [" + ann + "]"
				}
				vals = append(vals, sv)
			}
		}
		if len(vals) == 1 && len(a.Values) == 1 && !ranged {
			f.Add(label, vals[0])
		} else {
			f.Add(label, vals)
		}
		switch {
		case ranged && end >= 0:
			f.Add(label+"_count_at_least", end+1)
			*notes = append(*notes, fmt.Sprintf("%s has more than %d values (range retrieval); use get_membership for group members.", name, end+1-start))
		case ranged:
			f.Add(label+"_count", start+len(a.Values))
		case len(a.Values) > maxValues:
			f.Add(label+"_count", len(a.Values))
		}
	}
	return f, omitted, redacted
}

// objectClasses returns the objectClass values of an entry.
func objectClasses(e models.LDAPEntry) []string {
	for _, a := range e.Attributes {
		if strings.EqualFold(a.Name, "objectClass") {
			return a.Values
		}
	}
	return nil
}

// attrValues returns the values of an attribute (case-insensitive).
func attrValues(e *models.LDAPEntry, name string) []string {
	if e == nil {
		return nil
	}
	for _, a := range e.Attributes {
		if strings.EqualFold(BaseAttr(a.Name), name) {
			return a.Values
		}
	}
	return nil
}

func attrValue(e *models.LDAPEntry, name string) string {
	if v := attrValues(e, name); len(v) > 0 {
		return v[0]
	}
	return ""
}

func hasClass(e *models.LDAPEntry, classes ...string) bool {
	for _, oc := range attrValues(e, "objectClass") {
		for _, c := range classes {
			if strings.EqualFold(oc, c) {
				return true
			}
		}
	}
	return false
}

// objectType derives a coarse type from objectClass.
func objectType(ocs []string) string {
	has := map[string]bool{}
	for _, o := range ocs {
		has[strings.ToLower(o)] = true
	}
	switch {
	case has["computer"]:
		return "computer"
	case has["group"] || has["groupofnames"] || has["groupofuniquenames"] || has["posixgroup"] || has["groupofurls"]:
		return "group"
	case has["contact"]:
		return "contact"
	case has["user"] || has["inetorgperson"] || has["person"] || has["posixaccount"] || has["organizationalperson"]:
		return "user"
	case has["organizationalunit"]:
		return "ou"
	case has["container"] || has["builtindomain"] || has["domain"] || has["domaindns"] || has["dcobject"] || has["organization"]:
		return "container"
	}
	return "other"
}

// rdnOf returns the first RDN of a DN.
func rdnOf(dn string) string {
	parts := splitDN(dn)
	if len(parts) == 0 {
		return dn
	}
	return parts[0]
}

// parentOf returns the parent DN ("" for a single RDN).
func parentOf(dn string) string {
	parts := splitDN(dn)
	if len(parts) <= 1 {
		return ""
	}
	return strings.Join(parts[1:], ",")
}

// rdnValue returns the value of the first RDN.
func rdnValue(dn string) string {
	_, v, _ := strings.Cut(rdnOf(dn), "=")
	return v
}
