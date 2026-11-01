package agent

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	goldap "github.com/go-ldap/ldap/v3"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/ldaptools"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// Target check (2b defect 1): the system prompt lets an entry named in the
// message win over selected_entry, but a small model still writes the
// UI-selected entry now and then (qwen3-vl:8b, 1 of 3 UI trials). The
// approval card therefore warns when a write targets the selected entry
// while the user's latest message names another entry: an @mention or a DN
// that is not the target, or an identifier that is the RDN value or logon
// name of another entry but not of the target. A message that names the
// target itself, or no entry at all ("this user"), gives no warning.

const (
	maxTargetTokens     = 24
	targetLookupLimit   = 100
	targetLookupTimeout = 5 * time.Second
)

// targetLookupAttrs are the naming attributes an identifier from the
// message is matched against: RDN types and logon names.
var targetLookupAttrs = []string{"cn", "uid", "ou", "sAMAccountName", "userPrincipalName", "mail"}

// targetStopwords are common request words (English and German) that are
// never looked up as entry names.
var targetStopwords = func() map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.Fields(`the and for from with into onto this that these those there here its his her their
		please set sets change changes modify update add adds remove removes delete deletes reset enable disable unlock lock
		user users account accounts group groups entry entries member members object objects attribute attributes value values
		description password passwords name names new old next logon login must should can could would will now also only
		all any each every some not but yes was were has have had are you your our make give show tell what which who
		der die das den dem des und oder für fuer von vom mit bitte setze setzen ändere aendere ändern aendern lösche loesche
		löschen loeschen füge fuege hinzu entferne entfernen benutzer benutzers gruppe gruppen konto kontos eintrag einträge
		beschreibung passwort kennwort aktiviere deaktiviere entsperre auf aus zum zur diesen dieses dieser diese ein eine
		einen einem einer ist sind nicht auch nur alle neue neuen neues alte alten`) {
		m[w] = true
	}
	return m
}()

// latestUserMessage returns what the user typed in the latest user turn
// (no context block, no "Continue" text) and that message's UI context.
func latestUserMessage(history []ai.Message) (string, *ai.UIContext) {
	for i := len(history) - 1; i >= 0; i-- {
		m := history[i]
		if m.Role != ai.RoleUser || !hasUserText(m) {
			continue
		}
		var parts []string
		for _, b := range m.Blocks {
			if b.Type == ai.BlockText && (b.Meta == nil || b.Meta.Kind == "") {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n"), m.UIContext
	}
	return "", nil
}

// dnCandidate is DN-like text from a message: at least two attr=value RDNs.
type dnCandidate struct {
	text string // as typed (trimmed)
	key  string // ldaptools.DNKey
	// cut: the last value was cut at the first blank (the DN ran into
	// prose), so it may be a prefix of the real last value.
	cut        bool
	start, end int
}

var rdnTypeRe = regexp.MustCompile(`^\s*([A-Za-z][A-Za-z0-9-]*|[0-9]+(?:\.[0-9]+)+)\s*=\s*`)

// dnValueStop ends an RDN value (besides an unescaped , ; or +).
func dnValueStop(r byte) bool {
	switch r {
	case '"', '`', '\n', '\r', '<', '>', '(', ')', '[', ']', '{', '}':
		return true
	}
	return false
}

// closingQuote: the ' at s[j] ends a quoted DN ('cn=a,ou=b'), unlike the
// one in a name such as O'Brien.
func closingQuote(s string, j int) bool {
	if j+1 >= len(s) {
		return true
	}
	r, _ := utf8.DecodeRuneInString(s[j+1:])
	return !unicode.IsLetter(r) && !unicode.IsDigit(r)
}

// extractDNs finds DN-like text (≥ 2 RDNs) in s.
func extractDNs(s string) []dnCandidate {
	var out []dnCandidate
	for i := 0; i < len(s); {
		// An RDN starts at the beginning or after a non-name character.
		if i > 0 {
			p := s[i-1]
			if p == '\\' || p == '=' || p == '-' || p == '.' || p == '_' || p >= '0' && p <= '9' || p >= 'A' && p <= 'Z' || p >= 'a' && p <= 'z' {
				i++
				continue
			}
		}
		c, ok := parseDNAt(s, i)
		if !ok {
			i++
			continue
		}
		out = append(out, c)
		i = c.end
	}
	return out
}

// parseDNAt parses RDNs starting at s[i:].
func parseDNAt(s string, i int) (dnCandidate, bool) {
	var comps []string
	pos := i
	cut := false
	for {
		m := rdnTypeRe.FindStringSubmatchIndex(s[pos:])
		if m == nil {
			break
		}
		typ := s[pos+m[2] : pos+m[3]]
		v0 := pos + m[1]
		j, esc := v0, false
		for ; j < len(s); j++ {
			ch := s[j]
			if esc {
				esc = false
				continue
			}
			if ch == '\\' {
				esc = true
				continue
			}
			if ch == ',' || ch == ';' || ch == '+' || dnValueStop(ch) || ch == '\'' && closingQuote(s, j) {
				break
			}
		}
		val := strings.TrimSpace(s[v0:j])
		more := j < len(s) && (s[j] == ',' || s[j] == ';' || s[j] == '+') && rdnTypeRe.MatchString(s[j+1:])
		if !more {
			// Last RDN: the value ends at the first blank (the DN ran into
			// prose) and loses trailing punctuation.
			if k := strings.IndexFunc(val, unicode.IsSpace); k >= 0 {
				val, cut = val[:k], true
			}
			val = strings.TrimRight(val, `'".,;:!?`)
			if val == "" {
				break
			}
			comps = append(comps, typ+"="+val)
			end := v0 + strings.Index(s[v0:], val) + len(val)
			if len(comps) < 2 {
				return dnCandidate{}, false
			}
			text := strings.Join(comps, ",")
			return dnCandidate{text: text, key: ldaptools.DNKey(text), cut: cut, start: i, end: end}, true
		}
		if val == "" {
			break
		}
		comps = append(comps, typ+"="+val)
		pos = j + 1
	}
	return dnCandidate{}, false
}

// refersTo reports whether a DN typed in the message names the entry with
// the DN key tk (exactly, as a leading part of it, or with a last value
// that was cut at a blank).
func (c dnCandidate) refersTo(tk string) bool {
	if c.key == tk || strings.HasPrefix(tk, c.key+",") {
		return true
	}
	return c.cut && strings.HasPrefix(tk, c.key)
}

var tokenRe = regexp.MustCompile(`[\p{L}\p{N}_$][\p{L}\p{N}._@$-]*`)

// identifierLike: a digit or an inner . _ @ $ - (logon names like
// "j.doe", "ai.uiacct.2051", "pc-0815$").
func identifierLike(t string) bool {
	return strings.ContainsAny(t, "0123456789._@$-")
}

// extractTokens returns the words of s that may name an entry: at least 3
// characters, not a number, not a request word, not part of the values
// being written (excluded, lower-case), identifier-like ones first.
func extractTokens(s, excluded string, attrs map[string]bool) []string {
	var idents, words []string
	seen := map[string]bool{}
	for _, t := range tokenRe.FindAllString(s, -1) {
		t = strings.TrimRight(t, ".-@")
		l := strings.ToLower(t)
		if utf8.RuneCountInString(t) < 3 || seen[l] || targetStopwords[l] || attrs[l] || strings.Trim(t, "0123456789") == "" {
			continue
		}
		if excluded != "" && strings.Contains(excluded, l) {
			continue
		}
		seen[l] = true
		if identifierLike(t) {
			idents = append(idents, t)
		} else {
			words = append(words, t)
		}
	}
	out := append(idents, words...)
	if len(out) > maxTargetTokens {
		out = out[:maxTargetTokens]
	}
	return out
}

// changeContext collects what the change itself writes or names (values,
// new DN, group): references to those are not "another entry".
func changeContext(pv *ai.ChangePreview, groupDN string) (excluded string, attrs map[string]bool) {
	var b strings.Builder
	attrs = map[string]bool{}
	add := func(v string) {
		b.WriteString(strings.ToLower(v))
		b.WriteByte('\n')
		if k := ldaptools.DNKey(v); strings.Contains(k, "=") {
			b.WriteString(k)
			b.WriteByte('\n')
		}
	}
	if pv != nil {
		for _, c := range pv.Changes {
			attrs[strings.ToLower(c.Attribute)] = true
			for _, vs := range [][]string{c.Before, c.After, c.Values} {
				for _, v := range vs {
					add(v)
				}
			}
		}
		for _, a := range pv.EntrySummary {
			attrs[strings.ToLower(a.Attribute)] = true
			for _, v := range a.Values {
				add(v)
			}
		}
		if pv.NewDN != "" {
			add(pv.NewDN)
		}
	}
	if groupDN != "" {
		add(groupDN)
	}
	return b.String(), attrs
}

// rdnValueOf returns the (unescaped) value of the first RDN.
func rdnValueOf(dn string) string {
	d, err := goldap.ParseDN(dn)
	if err != nil || len(d.RDNs) == 0 || len(d.RDNs[0].Attributes) == 0 {
		return ""
	}
	return d.RDNs[0].Attributes[0].Value
}

// targetLookup finds the entries whose naming attributes equal one of the
// tokens: token (lower-case) → DNs.
type targetLookup func(ctx context.Context, tokens []string) (map[string][]string, error)

// directoryLookup searches the connection's naming context(s).
func directoryLookup(dc ldaptools.DirClient, baseDN string) targetLookup {
	return func(ctx context.Context, tokens []string) (map[string][]string, error) {
		var f strings.Builder
		f.WriteString("(|")
		for _, t := range tokens {
			for _, a := range targetLookupAttrs {
				fmt.Fprintf(&f, "(%s=%s)", a, goldap.EscapeFilter(t))
			}
		}
		f.WriteString(")")
		bases := []string{baseDN}
		if baseDN == "" {
			bases = nil
			if si, err := dc.ServerInfo(ctx); err == nil {
				if si.DefaultNamingContext != "" {
					bases = []string{si.DefaultNamingContext}
				} else {
					for _, nc := range si.NamingContexts {
						if !strings.HasPrefix(strings.ToLower(nc), "cn=") && len(bases) < 3 {
							bases = append(bases, nc)
						}
					}
				}
			}
		}
		hits := map[string][]string{}
		var lastErr error
		for _, b := range bases {
			res, err := dc.Search(ctx, models.SearchParams{BaseDN: b, Filter: f.String(), Scope: models.ScopeSub, SizeLimit: targetLookupLimit,
				TimeLimit: int(targetLookupTimeout.Seconds()), Attributes: targetLookupAttrs})
			if err != nil {
				lastErr = err
			}
			if res == nil {
				continue
			}
			for _, e := range res.Entries {
				names := map[string]bool{strings.ToLower(rdnValueOf(e.DN)): true}
				for _, at := range e.Attributes {
					for _, v := range at.Values {
						names[strings.ToLower(v)] = true
					}
				}
				for _, t := range tokens {
					if l := strings.ToLower(t); names[l] {
						hits[l] = append(hits[l], e.DN)
					}
				}
			}
		}
		if len(hits) == 0 && lastErr != nil {
			return nil, lastErr
		}
		return hits, nil
	}
}

// targetConflict returns the card warning for a write to targetDN, which
// is the UI-selected entry, when text (the user's latest message) and
// mentions name other entries but not the target ("" otherwise). lookup
// may be nil (then identifiers are not checked).
func targetConflict(ctx context.Context, profileID, targetDN string, pv *ai.ChangePreview, groupDN, text string, mentions []ai.Mention, lookup targetLookup) string {
	tk := ldaptools.DNKey(targetDN)
	excluded, attrs := changeContext(pv, groupDN)
	namesTarget := false
	var others []string // other entries the message names, as shown on the card
	seen := map[string]bool{}
	other := func(key, text string) {
		if !seen[key] {
			seen[key] = true
			others = append(others, text)
		}
	}
	for _, m := range mentions {
		if m.DN == "" {
			continue
		}
		mk := ldaptools.DNKey(m.DN)
		if m.ProfileID == profileID && mk == tk {
			namesTarget = true
		} else if !strings.Contains(excluded, mk) {
			other(m.ProfileID+"|"+mk, m.DN)
		}
	}
	dns := extractDNs(text)
	rest := []byte(text)
	for _, c := range dns {
		for i := c.start; i < c.end && i < len(rest); i++ {
			rest[i] = ' '
		}
		switch {
		case c.refersTo(tk):
			namesTarget = true
		case strings.HasSuffix(tk, ","+c.key), strings.Contains(excluded, c.key):
			// The target's container, or a DN the change writes.
		default:
			other(profileID+"|"+c.key, c.text)
		}
	}
	if namesTarget {
		return ""
	}
	tokens := extractTokens(string(rest), excluded, attrs)
	targetName := strings.ToLower(rdnValueOf(targetDN))
	var lookupTokens []string
	for _, t := range tokens {
		if strings.ToLower(t) == targetName {
			return ""
		}
		lookupTokens = append(lookupTokens, t)
	}
	if len(lookupTokens) > 0 && lookup != nil {
		lctx, cancel := context.WithTimeout(ctx, targetLookupTimeout)
		hits, err := lookup(lctx, lookupTokens)
		cancel()
		if err == nil {
			for _, t := range lookupTokens {
				var dnsHit []string
				for _, dn := range hits[strings.ToLower(t)] {
					k := ldaptools.DNKey(dn)
					if k == tk {
						return "" // the identifier is the target's name
					}
					if !strings.Contains(excluded, k) {
						dnsHit = append(dnsHit, dn)
					}
				}
				switch len(dnsHit) {
				case 0:
				case 1:
					other(profileID+"|"+ldaptools.DNKey(dnsHit[0]), fmt.Sprintf("%s (%s)", t, dnsHit[0]))
				default:
					other("token|"+strings.ToLower(t), fmt.Sprintf("%s (%d entries, e.g. %s)", t, len(dnsHit), dnsHit[0]))
				}
			}
		}
	}
	if len(others) == 0 {
		return ""
	}
	y := others[0]
	if len(others) > 1 {
		y += fmt.Sprintf(" and %d more", len(others)-1)
	}
	x, _, _ := ai.SanitizeUntrusted(targetDN)
	y, _, _ = ai.SanitizeUntrusted(y)
	return fmt.Sprintf("This change targets the selected entry %s, but your message names %s — check before approving.", x, y)
}

// targetWarning applies targetConflict to a prepared write: only when its
// target is the entry selected in the UI (when the run started, or when
// the latest user message was sent).
func (x *executor) targetWarning(ctx context.Context, cs *callState, prep *ldaptools.Prepared, dc ldaptools.DirClient) string {
	s := x.s
	if prep == nil || prep.TargetDN == "" || cs.conn == nil {
		return ""
	}
	s.hmu.Lock()
	text, msgUI := latestUserMessage(s.history)
	s.hmu.Unlock()
	pid := cs.conn.Info.ProfileID
	tk := ldaptools.DNKey(prep.TargetDN)
	selected := func(ui *ai.UIContext) bool {
		return ui != nil && ui.SelectedDN != "" && ui.SelectedProfileID == pid && ldaptools.DNKey(ui.SelectedDN) == tk
	}
	if !selected(&s.r.ui) && !selected(msgUI) {
		return ""
	}
	mentions := append([]ai.Mention(nil), s.r.ui.Mentions...)
	if msgUI != nil {
		mentions = append(mentions, msgUI.Mentions...)
	}
	var lookup targetLookup
	if dc != nil {
		lookup = directoryLookup(dc, cs.conn.Info.BaseDN)
	}
	return targetConflict(ctx, pid, prep.TargetDN, prep.Preview, prep.GroupDN, text, mentions, lookup)
}
