// Package permission enforces the AI access model in Go (§6): per-connection
// access levels bound to the provider destination, per-chat consent, the
// live policy (the stricter of run-start and current settings), the
// approval broker (compare-and-swap resolution, shared access requests,
// timeouts) and narrowly scoped grants.
package permission

import (
	"strings"

	goldap "github.com/go-ldap/ldap/v3"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/config"
)

// Access levels.
const (
	LevelNone  = config.AccessNone
	LevelAsk   = config.AccessAsk
	LevelRead  = config.AccessRead
	LevelWrite = config.AccessWrite
)

// Rank orders levels: none < ask < read < write.
func Rank(level string) int {
	switch level {
	case LevelAsk:
		return 1
	case LevelRead:
		return 2
	case LevelWrite:
		return 3
	}
	return 0
}

func minLevel(a, b string) string {
	if Rank(a) <= Rank(b) {
		return a
	}
	return b
}

// Destination is where model requests go.
type Destination struct {
	Host   string // provider host ("" for a missing config)
	Local  bool   // §6.8
	Remote bool   // !Local
}

// Classify decides whether the provider endpoint is local (§6.8):
// Ollama native and the ollama flavor on a literal loopback host with a
// local model; litellm/custom/vllm/lmstudio on loopback only with the
// user's EndpointLocal assertion; OpenAI, Anthropic and Claude Code never.
func Classify(cfg config.AIConfig, modelRemote bool) Destination {
	if cfg.Engine == "claudecode" {
		return Destination{Host: "api.anthropic.com (Claude Code)", Remote: true}
	}
	host := ai.URLHost(cfg.URL)
	if host == "" {
		host = ai.URLHost(config.DefaultAIURL(cfg.Provider, cfg.Flavor))
	}
	loop := ai.IsLoopbackHost(host)
	local := false
	switch {
	case cfg.Provider == "ollama", cfg.Provider == "openai" && cfg.Flavor == "ollama":
		local = loop && !modelRemote
	case cfg.Provider == "openai" && (cfg.Flavor == "litellm" || cfg.Flavor == "custom" || cfg.Flavor == "vllm" || cfg.Flavor == "lmstudio" || cfg.Flavor == ""):
		local = loop && cfg.EndpointLocal && !modelRemote
	}
	return Destination{Host: host, Local: local, Remote: !local}
}

// Policy is the safety-relevant part of the AI config.
type Policy struct {
	AllowWrites        bool
	DefaultAccess      string
	Access             map[string]config.AccessEntry
	Redact             []string
	MaskPasswordValues string // remote | always | never
}

// FromConfig extracts the policy.
func FromConfig(c config.AIConfig) *Policy {
	p := &Policy{AllowWrites: c.AllowWrites, DefaultAccess: c.DefaultAccess, Access: map[string]config.AccessEntry{},
		Redact: append([]string(nil), c.RedactAttributes...), MaskPasswordValues: c.MaskPasswordValues}
	for k, v := range c.ConnectionAccess {
		p.Access[k] = config.AccessEntry{Level: v.Level, Hosts: append([]string(nil), v.Hosts...), ReadHosts: append([]string(nil), v.ReadHosts...)}
	}
	if p.DefaultAccess == "" {
		p.DefaultAccess = LevelAsk
	}
	if p.MaskPasswordValues == "" {
		p.MaskPasswordValues = "remote"
	}
	return p
}

// Level returns the configured level of a profile bound to the destination:
// read and write with a remote provider apply only when its host was
// consented (Hosts); a host consented for reading only (ReadHosts, "Always
// allow read") gets read; otherwise the connection behaves like ask.
func (p *Policy) Level(profileID string, d Destination) string {
	e, ok := p.Access[profileID]
	lvl := p.DefaultAccess
	if ok && e.Level != "" {
		lvl = e.Level
	}
	if lvl == LevelWrite && p.DefaultAccess == lvl && !ok {
		lvl = LevelRead // the default can never be write
	}
	if (lvl == LevelRead || lvl == LevelWrite) && !d.Local {
		switch {
		case hostIn(e.Hosts, d.Host):
		case hostIn(e.ReadHosts, d.Host):
			return LevelRead
		default:
			return LevelAsk
		}
	}
	if Rank(lvl) == 0 && lvl != LevelNone {
		return LevelAsk // unknown values behave like ask
	}
	return lvl
}

// Configured returns the stored level of a profile, without the
// destination binding (write is never the default).
func (p *Policy) Configured(profileID string) string {
	e, ok := p.Access[profileID]
	if ok && e.Level != "" {
		return e.Level
	}
	if p.DefaultAccess == LevelWrite {
		return LevelRead
	}
	return p.DefaultAccess
}

func hostIn(hosts []string, h string) bool {
	for _, x := range hosts {
		if strings.EqualFold(strings.TrimSpace(x), h) {
			return true
		}
	}
	return false
}

// MaskPasswords reports whether password-like free text is masked.
func (p *Policy) MaskPasswords(d Destination) bool {
	switch p.MaskPasswordValues {
	case "always":
		return true
	case "never":
		return false
	}
	return !d.Local
}

// Live combines the run-start policy with the current one: every check uses
// the stricter of the two, so tightening applies at once and loosening only
// from the next run (§3.6).
type Live struct {
	Start   *Policy
	Current func() *Policy
	Dest    Destination
}

func (l *Live) cur() *Policy {
	if l.Current == nil {
		return l.Start
	}
	if p := l.Current(); p != nil {
		return p
	}
	return l.Start
}

// Level returns the stricter level.
func (l *Live) Level(profileID string) string {
	return minLevel(l.Start.Level(profileID, l.Dest), l.cur().Level(profileID, l.Dest))
}

// AllowWrites is the stricter master switch.
func (l *Live) AllowWrites() bool { return l.Start.AllowWrites && l.cur().AllowWrites }

// Redact is the union of both redaction lists.
func (l *Live) Redact() []string {
	out := append([]string(nil), l.Start.Redact...)
	for _, r := range l.cur().Redact {
		dup := false
		for _, x := range out {
			if strings.EqualFold(x, r) {
				dup = true
			}
		}
		if !dup {
			out = append(out, r)
		}
	}
	return out
}

// MaskPasswords is true when either policy masks.
func (l *Live) MaskPasswords() bool {
	return l.Start.MaskPasswords(l.Dest) || l.cur().MaskPasswords(l.Dest)
}

// WriteGate checks gates 1–3 of §6.2. It returns "" when the write may be
// proposed, else a tool error code and message.
func (l *Live) WriteGate(profileID string, readOnly bool) (code, msg string) {
	switch {
	case !l.AllowWrites():
		return "WRITES_DISABLED", "Changes through the assistant are disabled in LDAPilot's AI settings."
	case l.Level(profileID) != LevelWrite:
		return "ACCESS_DENIED_BY_POLICY", "The user has given you read-only access to this directory."
	case readOnly:
		return "READ_ONLY_PROFILE", "This connection is read-only in LDAPilot."
	}
	return "", ""
}

// DNUnder reports whether dn equals base or lies below it.
func DNUnder(dn, base string) bool {
	if base == "" {
		return false
	}
	d, err1 := goldap.ParseDN(dn)
	b, err2 := goldap.ParseDN(base)
	if err1 != nil || err2 != nil {
		return strings.EqualFold(dn, base) || strings.HasSuffix(strings.ToLower(dn), ","+strings.ToLower(base))
	}
	return b.EqualFold(d) || b.AncestorOfFold(d)
}
