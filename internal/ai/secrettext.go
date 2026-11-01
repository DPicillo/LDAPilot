package ai

import (
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Passwords typed into a chat message (UX A-13). The composer refuses to
// send them (frontend/src/lib/aiPassword.ts); the facade masks what still
// arrives before a message is stored (so neither the history, the chat
// title nor the provider ever gets it) and the chat store masks older
// chats. Both scanners are checked against the same vectors
// (frontend/tests/ai/password-phrases.json); keep them in step.
//
// A match is "sure" unless it is a plain word after a label ("PW: geheim",
// "Password for jdoe: secret"): that may be a word as well, so the composer
// lets the user send it anyway, and MaskPasswords leaves it as typed.

// PasswordPlaceholder replaces a detected password value.
const PasswordPlaceholder = "[password removed]"

var placeholderRunes = []rune(PasswordPlaceholder)

var pwQuotes = map[rune]string{
	'"': `"`, '\'': "'", '`': "`", '“': "”“", '„': "“”", '‚': "‘’", '‘': "’", '«': "»", '»': "«", '‹': "›",
}

var (
	// Password words end in one of these (userPassword, unicodePwd,
	// olcRootPW, rootpw, bindpw, …); pwdLastSet or badPwdCount do not.
	pwKeywordSuffixes = []string{"password", "passwort", "kennwort", "passwd", "passphrase", "pwd", "pw"}
	pwPluralSuffixes  = []string{"passwords", "passwörter", "passwoerter", "kennwörter", "kennwoerter", "passworte", "kennworte", "passphrases"}
	pwLabelOnly       = setOf("pass", "credentials", "credential")
	pwConnectors      = setOf("to", "is", "be", "will", "should", "shall", "must", "now", "set", "as", "equals", "becomes", "become", "->", "→", "=>", ":", "=",
		"auf", "ist", "lautet", "lauten", "jetzt", "nun", "als", "zu", "wird", "werden", "soll", "sollte", "muss", "sein")
	pwTargetPreps = setOf("of", "for", "from", "on", "von", "für", "fuer", "des", "der", "vom", "beim", "bei")
	pwTargetEnd   = setOf("to", "as", "is", "=", ":", "->", "→", "=>", "auf", "als", "ist", "lautet", "zu")
	pwModals      = setOf("should", "shall", "will", "would", "must", "can", "be", "becomes", "become", "equals", "lauten",
		"soll", "sollte", "wird", "werden", "muss", "kann", "sein")
	pwImplicitEnd = setOf(":", "=", "->", "→", "=>", "to", "auf")
	pwVerbsAfter  = setOf("setzen", "setze", "ändern", "ändere", "aendern", "zurücksetzen", "zuruecksetzen", "neu", "vergeben", "festlegen",
		"change", "reset", "update")
	pwArticles = setOf("the", "a", "an", "new", "his", "her", "their", "its", "my", "your", "initial", "temporary", "default", "start",
		"das", "den", "dem", "die", "der", "ein", "eine", "einen", "sein", "seine", "ihr", "ihre", "neue", "neues", "neuen", "initiale", "initiales", "temporäre", "temporäres", "mein", "dein")
	pwStatusWords = setOf("none", "null", "empty", "blank", "n/a", "unknown", "set", "unset", "expired", "never", "required", "locked", "changed", "reset",
		"ok", "yes", "no", "true", "false", "leer", "gesetzt", "abgelaufen", "nie", "ja", "nein", "unbekannt", "keins", "keines",
		"hidden", "masked", "redacted", "removed", "hashed", "encrypted", "random", "generated", "optional", "disabled", "enabled",
		"expiring", "expires", "valid", "invalid", "wrong", "weak", "strong", "missing", "versteckt", "verschlüsselt", "zufällig",
		"generiert", "gültig", "ungültig", "falsch", "fehlt", "erforderlich")
	pwValueFollow   = setOf("and", "und", "or", "oder", "then", "dann", "please", "bitte", "|", "-", "–", "—")
	pwJoiners       = setOf(",", ";", "&", "and", "und", "sowie", "plus")
	pwParenWords    = setOf("old", "alt", "alte", "altes", "previous", "vorher", "bisher", "früher", "current", "aktuell", "aktuelles", "new", "neu", "neues", "temp")
	pwParenConn     = setOf("was", "war", "is", "ist", "lautet", "lautete", ":", "=")
	pwGenericTarget = setOf("user", "users", "account", "accounts", "benutzer", "benutzerin", "konto", "nutzer", "nutzerin", "person", "entry", "eintrag", "object", "objekt")
	pwUseVerbs      = setOf("use", "take", "try", "verwende", "nimm", "benutze", "nehme")
)

var (
	pwPlaceholderRe = []*regexp.Regexp{regexp.MustCompile(`^[*xX•·.…?_\-]+$`), regexp.MustCompile(`^<[^<>]*>$`), regexp.MustCompile(`^\[[^\[\]]*\]$`), regexp.MustCompile(`^\{[^{}]*\}$`), regexp.MustCompile(`^\([^()]*\)[,;.!?]?$`)}
	pwDateRe        = []*regexp.Regexp{regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`), regexp.MustCompile(`^\d{1,2}\.\d{1,2}\.(\d{2}|\d{4})\.?$`), regexp.MustCompile(`^\d{1,2}:\d{2}`), regexp.MustCompile(`(?i)^\d{8,14}(\.\d+)?Z$`)}
	pwAttrEqRe      = regexp.MustCompile(`^[A-Za-z][\w-]*=`)
	pwMailRe        = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
	pwHostRe        = regexp.MustCompile(`^[A-Z]{1,15}\d{1,4}$`)
	pwFQDNRe        = regexp.MustCompile(`^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$`)
	pwWeakSkipRe    = regexp.MustCompile(`[/\\,=():@]`)
	pwHexRe         = regexp.MustCompile(`(?i)^[0-9a-f-]+$`)
	// OpenLDAP clients whose -w (ldappasswd: also -s/-a) takes a password
	pwLDAPClientRe = regexp.MustCompile("(?i)(^|[\\s`$>|;&(])ldap(search|modify|add|delete|modrdn|passwd|whoami|compare|exop|url)\\b")
	pwFlagWRe      = regexp.MustCompile(`\s-w\s`)
	pwFlagWSARe    = regexp.MustCompile(`\s-[wsa]\s`)
)

func setOf(xs ...string) map[string]bool {
	m := make(map[string]bool, len(xs))
	for _, x := range xs {
		m[x] = true
	}
	return m
}

type pwTok struct {
	start, end int // rune offsets, quotes included
	text       string
	quoted     bool
}

type pwHit struct {
	start, end   int
	sure, quoted bool
}

func pwSpace(c rune) bool { return c == ' ' || c == '\t' || c == '\u00a0' }

func pwLetterOrNumber(c rune) bool { return unicode.IsLetter(c) || unicode.IsNumber(c) }

func pwStartsWith(t []rune, i int, p []rune) bool {
	if i < 0 || i+len(p) > len(t) {
		return false
	}
	for k := range p {
		if t[i+k] != p[k] {
			return false
		}
	}
	return true
}

func pwClosingQuote(t []rune, i int) int {
	open := t[i]
	closers, ok := pwQuotes[open]
	if !ok {
		return -1
	}
	if open == '\'' && i > 0 && pwLetterOrNumber(t[i-1]) {
		return -1
	}
	if i+1 >= len(t) || pwSpace(t[i+1]) || t[i+1] == '\n' {
		return -1
	}
	for j := i + 1; j < len(t) && j-i <= 129; j++ {
		c := t[j]
		if c == '\n' {
			return -1
		}
		if strings.ContainsRune(closers, c) && !pwSpace(t[j-1]) {
			if open == '\'' && j+1 < len(t) && pwLetterOrNumber(t[j+1]) {
				continue
			}
			return j
		}
	}
	return -1
}

func pwTokenAt(t []rune, i int) *pwTok {
	for i < len(t) && pwSpace(t[i]) {
		i++
	}
	if i >= len(t) || t[i] == '\n' || t[i] == '\r' {
		return nil
	}
	if pwStartsWith(t, i, placeholderRunes) {
		return &pwTok{start: i, end: i + len(placeholderRunes), text: PasswordPlaceholder}
	}
	if c := pwClosingQuote(t, i); c > i {
		return &pwTok{start: i, end: c + 1, text: string(t[i+1 : c]), quoted: true}
	}
	j := i
	for j < len(t) && !pwSpace(t[j]) && t[j] != '\n' && t[j] != '\r' {
		// "jdoe=[password removed]," stays one token
		if pwStartsWith(t, j, placeholderRunes) {
			j += len(placeholderRunes)
		} else {
			j++
		}
	}
	return &pwTok{start: i, end: j, text: string(t[i:j])}
}

// pwNextLineToken: the first token of the next line when the rest of this
// line from i is empty ("Password:\n  X").
func pwNextLineToken(t []rune, i int) *pwTok {
	for i < len(t) && pwSpace(t[i]) {
		i++
	}
	if i < len(t) && t[i] == '\r' {
		i++
	}
	if i >= len(t) || t[i] != '\n' {
		return nil
	}
	return pwTokenAt(t, i+1)
}

func pwExpectsValue(w string) bool { return pwConnectors[w] || pwTargetEnd[w] || pwModals[w] }

func pwTokensAfter(t []rune, i, max int, crossLine bool) []pwTok {
	var out []pwTok
	pos := i
	crossed := false
	for len(out) < max {
		tk := pwTokenAt(t, pos)
		if tk == nil && crossLine && !crossed && len(out) > 0 && !out[len(out)-1].quoted && pwExpectsValue(pwBare(out[len(out)-1].text)) {
			crossed = true
			tk = pwNextLineToken(t, pos)
		}
		if tk == nil {
			break
		}
		pos = tk.end
		r := []rune(tk.text)
		if !tk.quoted && len(r) > 1 && (r[0] == ':' || r[0] == '=') && r[1] != r[0] {
			out = append(out, pwTok{start: tk.start, end: tk.start + 1, text: string(r[0])}, pwTok{start: tk.start + 1, end: tk.end, text: string(r[1:])})
			continue
		}
		if !tk.quoted && len(r) > 1 && (r[len(r)-1] == ':' || r[len(r)-1] == '=') && !(r[len(r)-2] == ':' || r[len(r)-2] == '=') {
			out = append(out, pwTok{start: tk.start, end: tk.end - 1, text: string(r[:len(r)-1])}, pwTok{start: tk.end - 1, end: tk.end, text: string(r[len(r)-1])})
			continue
		}
		out = append(out, *tk)
	}
	return out
}

func pwIsCloser(c rune) bool {
	for _, cl := range pwQuotes {
		if strings.ContainsRune(cl, c) {
			return true
		}
	}
	return false
}

func pwTokensBefore(t []rune, i, max int) []pwTok {
	var out []pwTok
	pos := i
	for len(out) < max {
		j := pos
		for j > 0 && pwSpace(t[j-1]) {
			j--
		}
		if j == 0 || t[j-1] == '\n' {
			break
		}
		end := j
		if end >= len(placeholderRunes) && pwStartsWith(t, end-len(placeholderRunes), placeholderRunes) {
			out = append(out, pwTok{start: end - len(placeholderRunes), end: end, text: PasswordPlaceholder})
			pos = end - len(placeholderRunes)
			continue
		}
		last := t[end-1]
		var quoted *pwTok
		for s := end - 2; s >= 0 && end-s <= 130; s-- {
			if t[s] == '\n' {
				break
			}
			if _, ok := pwQuotes[t[s]]; ok && pwClosingQuote(t, s) == end-1 && (s == 0 || pwSpace(t[s-1]) || t[s-1] == '\n') {
				quoted = &pwTok{start: s, end: end, text: string(t[s+1 : end-1]), quoted: true}
				break
			}
		}
		if quoted != nil && pwIsCloser(last) {
			out = append(out, *quoted)
			pos = quoted.start
			continue
		}
		k := end
		for k > 0 && !pwSpace(t[k-1]) && t[k-1] != '\n' {
			k--
		}
		out = append(out, pwTok{start: k, end: end, text: string(t[k:end])})
		pos = k
	}
	return out
}

// pwBare: lower case, without the brackets, quotes and punctuation around a word.
func pwBare(w string) string {
	return strings.TrimRight(strings.TrimLeft(strings.ToLower(w), "([„“\"'«‹"), ",;.!?)]\"'”“»›")
}

func pwEndsSentence(tk pwTok) bool {
	return !tk.quoted && strings.ContainsAny(lastRune(tk.text), ".?!")
}

func lastRune(s string) string {
	r := []rune(s)
	if len(r) == 0 {
		return ""
	}
	return string(r[len(r)-1])
}

func pwHas(s string, f func(rune) bool) bool { return strings.IndexFunc(s, f) >= 0 }

func pwSpecial(c rune) bool { return !pwLetterOrNumber(c) && c != '-' && c != '.' && c != '_' }

func pwLen(s string) int { return utf8.RuneCountInString(s) }

func pwPlaceholder(v string) bool {
	s := strings.TrimSpace(v)
	if s == "" {
		return true
	}
	for _, re := range pwPlaceholderRe {
		if re.MatchString(s) {
			return true
		}
	}
	return pwStatusWords[pwBare(s)]
}

func pwDate(s string) bool {
	for _, re := range pwDateRe {
		if re.MatchString(s) {
			return true
		}
	}
	return false
}

// pwAttrEq: "cn=x", "uid=jdoe" (but not base64 padding: "U29tbWVy=").
func pwAttrEq(s string) bool {
	m := pwAttrEqRe.FindString(s)
	return m != "" && strings.ReplaceAll(s[len(m):], "=", "") != ""
}

func pwName(s string) bool {
	if strings.HasPrefix(s, "(") || strings.Contains(s, "://") || pwAttrEq(s) || pwMailRe.MatchString(s) || pwHostRe.MatchString(s) {
		return true
	}
	if pwFQDNRe.MatchString(s) && strings.IndexFunc(s, func(r rune) bool { return r >= 'a' && r <= 'z' }) >= 0 {
		return true
	}
	return pwDate(s)
}

func pwTrimTrailing(s string) string { return strings.TrimRight(s, ",;") }

// pwStripEmphasis: Markdown emphasis around a word ("**generated**:") does
// not make it password-shaped.
func pwStripEmphasis(s string) string { return strings.Trim(s, "*_~") }

// pwUnbalancedClose: "Winter2025!)" → "Winter2025!" (a closing bracket the
// token did not open).
func pwUnbalancedClose(s string) string {
	out := pwTrimTrailing(s)
	for {
		switch {
		case strings.HasSuffix(out, ")") && !strings.Contains(out, "("),
			strings.HasSuffix(out, "]") && !strings.Contains(out, "["):
			out = pwTrimTrailing(out[:len(out)-1])
		default:
			return out
		}
	}
}

func pwStrictLike(raw string) bool {
	s := strings.TrimRight(pwStripEmphasis(strings.TrimRight(pwTrimTrailing(raw), ".?!")), ".?!")
	n := pwLen(s)
	if n < 6 || n > 64 || pwName(s) || pwPlaceholder(s) {
		return false
	}
	if !pwHas(s, unicode.IsLetter) || !(pwHas(s, unicode.IsNumber) || pwHas(s, pwSpecial)) {
		return false
	}
	return (pwHas(s, unicode.IsUpper) && pwHas(s, unicode.IsLower)) || pwHas(s, pwSpecial)
}

func pwLooseLike(raw string) bool {
	s := pwStripEmphasis(pwTrimTrailing(pwUnbalancedClose(raw)))
	n := pwLen(s)
	if n < 4 || n > 128 || pwName(s) || pwPlaceholder(s) {
		return false
	}
	if pwHas(s, unicode.IsNumber) && (pwHas(s, unicode.IsLetter) || n >= 6) {
		return true
	}
	stripped := s
	if r := []rune(s); strings.ContainsRune(".!?", r[len(r)-1]) {
		stripped = string(r[:len(r)-1])
	}
	return pwHas(stripped, pwSpecial) && pwHas(s, unicode.IsLetter)
}

func pwQuotedValue(tk pwTok) bool {
	n := pwLen(tk.text)
	if n < 1 || n > 128 || pwPlaceholder(tk.text) {
		return false
	}
	// a quoted phrase ("never expires", 'User must change') is a value only
	// when it looks like one
	if !pwHas(strings.TrimSpace(tk.text), unicode.IsSpace) {
		return true
	}
	noSpace := strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, tk.text)
	return pwHas(tk.text, unicode.IsNumber) || pwHas(noSpace, pwSpecial)
}

// pwValueHit: the span of a value token; quotes kept, a trailing comma or
// unopened bracket left out ("Sommer2026!," → "Sommer2026!").
func pwValueHit(tk pwTok, sure bool) *pwHit {
	if tk.quoted {
		return &pwHit{start: tk.start, end: tk.end, sure: sure, quoted: true}
	}
	v := pwUnbalancedClose(tk.text)
	if !sure {
		// a plain word keeps its sentence punctuation outside ("PW: geheim.")
		v = strings.TrimRight(v, ".!?")
	}
	n := pwLen(v)
	if n < 1 {
		n = 1
	}
	return &pwHit{start: tk.start, end: tk.start + n, sure: sure}
}

func pwOnlyPunct(s string) bool { return strings.IndexFunc(s, pwLetterOrNumber) < 0 }

// pwLabelValue: the value after a label (":"/"="). A password-shaped or
// quoted value is sure; a plain word only counts as the whole value (end of
// the line, a comma, "and …"), and is not sure.
func pwLabelValue(tk, next *pwTok) *pwHit {
	if tk == nil || tk.text == PasswordPlaceholder {
		return nil
	}
	if tk.quoted {
		if pwQuotedValue(*tk) {
			return pwValueHit(*tk, true)
		}
		return nil
	}
	s := pwTrimTrailing(tk.text)
	if s == "" || pwLen(s) > 128 || strings.HasPrefix(s, "*") || pwPlaceholder(s) || pwName(strings.TrimRight(s, ".!?")) || pwOnlyPunct(s) {
		return nil
	}
	if pwLooseLike(tk.text) {
		return pwValueHit(*tk, true)
	}
	ends := next == nil || strings.ContainsAny(lastRune(tk.text), ",;.!?)]") || pwValueFollow[pwBare(next.text)] || next.text == PasswordPlaceholder
	if ends {
		return pwValueHit(*tk, false)
	}
	return nil
}

type pwKeyword struct {
	start, end        int
	word              string
	plural, labelOnly bool
}

func pwHasSuffix(lw string, sfx []string) bool {
	for _, s := range sfx {
		if strings.HasSuffix(lw, s) {
			return true
		}
	}
	return false
}

func pwKeywords(t []rune) []pwKeyword {
	var out []pwKeyword
	i := 0
	for i < len(t) {
		if !unicode.IsLetter(t[i]) {
			i++
			continue
		}
		j := i
		for j < len(t) && unicode.IsLetter(t[j]) {
			j++
		}
		word := string(t[i:j])
		lw := strings.ToLower(word)
		var prev, next rune
		if i > 0 {
			prev = t[i-1]
		}
		if j < len(t) {
			next = t[j]
		}
		okNext := next == 0 || pwSpace(next) || next == '\n' || next == '\r' || strings.ContainsRune(":=：,;.!?)\"'“”„«»`", next)
		okPrev := !unicode.IsNumber(prev)
		inPlaceholder := i > 0 && pwStartsWith(t, i-1, placeholderRunes)
		plural := pwHasSuffix(lw, pwPluralSuffixes)
		labelOnly := pwLabelOnly[lw]
		isKW := labelOnly || plural || pwHasSuffix(lw, pwKeywordSuffixes)
		if okNext && okPrev && !inPlaceholder && isKW && !(prev == '(' && strings.ContainsRune("=~><", next)) {
			out = append(out, pwKeyword{start: i, end: j, word: word, plural: plural, labelOnly: labelOnly})
		}
		i = j
	}
	return out
}

type pwKwScan struct {
	hits   []*pwHit
	target string
	anchor int // where a continuation may start (after the value, also a removed one)
}

// pwPairValue: "jdoe=X" / "jdoe:X", the value part of a name/value pair.
func pwPairValue(tk pwTok) *pwTok {
	if tk.quoted {
		return nil
	}
	s := []rune(pwTrimTrailing(tk.text))
	k := -1
	for i, c := range s {
		if c == '=' || c == ':' {
			k = i
			break
		}
		if unicode.IsSpace(c) {
			return nil
		}
	}
	if k < 1 || k > 64 || k+1 >= len(s) {
		return nil
	}
	rest := string(s[k+1:])
	if strings.HasPrefix(rest, "//") || strings.HasPrefix(rest, "=") || strings.HasPrefix(rest, ":") {
		return nil
	}
	r := []rune(tk.text)
	return &pwTok{start: tk.start + k + 1, end: tk.end, text: string(r[k+1:])}
}

func pwAt(toks []pwTok, i int) *pwTok {
	if i < len(toks) {
		return &toks[i]
	}
	return nil
}

// pwScanPairList: "passwords: jdoe=X, anna=Y", "Passwörter: X".
func pwScanPairList(t []rune, from int) *pwKwScan {
	toks := pwTokensAfter(t, from, 24, false)
	out := &pwKwScan{anchor: from}
	i := 0
	for i < len(toks) {
		tk := toks[i]
		if !tk.quoted && (pwJoiners[tk.text] || pwJoiners[pwBare(tk.text)]) {
			i++
			continue
		}
		if pv := pwPairValue(tk); pv != nil {
			if !strings.HasPrefix(pv.text, PasswordPlaceholder) && (pwLooseLike(pv.text) || pwLabelValue(pv, pwAt(toks, i+1)) != nil) {
				out.hits = append(out.hits, pwValueHit(*pv, true))
			}
			out.anchor = pv.end
			i++
			continue
		}
		if !tk.quoted && i+2 < len(toks) && (toks[i+1].text == ":" || toks[i+1].text == "=") {
			if v := pwLabelValue(&toks[i+2], pwAt(toks, i+3)); v != nil {
				v.sure = true
				out.hits = append(out.hits, v)
				out.anchor = toks[i+2].end
				i += 3
				continue
			}
			break
		}
		if i == 0 {
			if v := pwLabelValue(&tk, pwAt(toks, 1)); v != nil {
				out.hits = append(out.hits, v)
				out.anchor = tk.end
				i++
				continue
			}
		}
		break
	}
	return out
}

func pwScanKeyword(t []rune, k pwKeyword) *pwKwScan {
	// 1. "password: X", "pw=X", LDIF "userPassword:: <base64>", "Password:\n  X"
	j := k.end
	for j < len(t) && pwSpace(t[j]) {
		j++
	}
	if j < len(t) && (t[j] == ':' || t[j] == '=' || t[j] == '：') {
		v := j + 1
		if t[j] == ':' && v < len(t) && (t[v] == ':' || t[v] == '<') {
			v++ // LDIF base64 / URL value
		}
		if k.plural {
			return pwScanPairList(t, v)
		}
		tk := pwTokenAt(t, v)
		if tk == nil {
			tk = pwNextLineToken(t, v)
		}
		// "**Password:** X": the emphasis right after the colon is not the value
		if tk != nil && !tk.quoted && tk.start == v && strings.Trim(tk.text, "*_~") == "" {
			e := tk.end
			if tk = pwTokenAt(t, e); tk == nil {
				tk = pwNextLineToken(t, e)
			}
		}
		if tk == nil {
			return nil
		}
		if h := pwLabelValue(tk, pwTokenAt(t, tk.end)); h != nil {
			return &pwKwScan{hits: []*pwHit{h}, anchor: h.end}
		}
		if tk.text == PasswordPlaceholder {
			return &pwKwScan{anchor: tk.end}
		}
		return nil
	}
	if k.labelOnly {
		return nil
	}
	// 2. "password 'X'", "password of jdoe to X", "Kennwort auf X", "password Sommer2026!"
	toks := pwTokensAfter(t, k.end, 14, true)
	phase, label, implicit, skipped, verbs := "after", false, false, 0, 0
	var target []string
	done := func(tk pwTok, h *pwHit) *pwKwScan {
		tg := strings.TrimRight(strings.Join(target, " "), ",;:")
		if implicit && len(target) > 1 {
			tg = ""
		}
		if h != nil {
			return &pwKwScan{hits: []*pwHit{h}, target: tg, anchor: h.end}
		}
		if tk.text == PasswordPlaceholder {
			return &pwKwScan{target: tg, anchor: tk.end}
		}
		return nil
	}
	for idx, tk := range toks {
		w := pwBare(tk.text)
		switch phase {
		case "after":
			if tk.quoted {
				if pwQuotedValue(tk) {
					return done(tk, pwValueHit(tk, true))
				}
				return done(tk, nil)
			}
			if pwTargetPreps[w] {
				phase = "target"
				continue
			}
			if pwConnectors[w] {
				phase, label = "value", w == ":" || w == "="
				continue
			}
			if pwVerbsAfter[w] && verbs < 2 {
				verbs++
				continue
			}
			if pwStrictLike(tk.text) {
				return done(tk, pwValueHit(tk, true))
			}
			if tk.text == PasswordPlaceholder || pwEndsSentence(tk) || pwArticles[w] {
				return nil
			}
			// "Password jdoe: X", "Kennwort jdoe -> X"
			phase, implicit = "target", true
			target = append(target, tk.text)
			continue
		case "target":
			end := pwTargetEnd[w]
			if implicit {
				end = pwImplicitEnd[w]
			}
			if !tk.quoted && end {
				phase, label = "value", w == ":" || w == "="
				continue
			}
			if !tk.quoted && !implicit && len(target) > 0 && pwModals[w] {
				phase = "value"
				continue
			}
			if len(target) == 0 && !tk.quoted && pwArticles[w] {
				continue
			}
			// "New password for jdoe Sommer2026!": a password-shaped value with a special character
			if !implicit && !tk.quoted && pwNamedTarget(target) && pwStrictLike(tk.text) && pwHas(pwTrimTrailing(tk.text), pwSpecial) {
				return done(tk, pwValueHit(tk, true))
			}
			target = append(target, tk.text)
			limit := 5
			if implicit {
				limit = 2
			}
			if len(target) > limit || pwEndsSentence(tk) || tk.text == PasswordPlaceholder {
				return nil
			}
			continue
		}
		// value
		if !tk.quoted && (pwConnectors[w] || pwArticles[w]) && skipped < 3 {
			skipped++
			if w == ":" || w == "=" {
				label = true
			}
			continue
		}
		if label {
			return done(tk, pwLabelValue(&toks[idx], pwAt(toks, idx+1)))
		}
		ok := false
		if tk.quoted {
			ok = pwQuotedValue(tk)
		} else {
			ok = pwLooseLike(tk.text)
		}
		if ok {
			return done(tk, pwValueHit(tk, true))
		}
		return done(tk, nil)
	}
	return nil
}

func pwNamedTarget(target []string) bool {
	for _, x := range target {
		if !pwGenericTarget[pwBare(x)] {
			return true
		}
	}
	return false
}

// pwConnValue: the value after a connector w ("to X", ": X").
func pwConnValue(w string, v, next *pwTok) *pwHit {
	if v == nil {
		return nil
	}
	if w == ":" || w == "=" {
		return pwLabelValue(v, next)
	}
	if (v.quoted && pwQuotedValue(*v)) || (!v.quoted && pwLooseLike(v.text)) {
		return pwValueHit(*v, true)
	}
	return nil
}

// pwScanContinuation: further passwords in the same sentence after a match:
// "…, and of anna to Y", "…, für anna: Y", "… (old one was Y)".
func pwScanContinuation(t []rune, from int) []*pwHit {
	var out []*pwHit
	pos := from
	for round := 0; round < 5; round++ {
		toks := pwTokensAfter(t, pos, 10, false)
		i := 0
		joined := false
		for i < len(toks) && !toks[i].quoted && (pwJoiners[toks[i].text] || pwJoiners[pwBare(toks[i].text)]) {
			i++
			joined = true
		}
		if i >= len(toks) {
			break
		}
		first := toks[i]
		var hit *pwHit
		end := -1
		fw := pwBare(first.text)
		switch {
		case !first.quoted && strings.HasPrefix(first.text, "(") && pwParenWords[fw]:
			for k := i + 1; k < len(toks) && k <= i+4; k++ {
				w := pwBare(toks[k].text)
				if !toks[k].quoted && pwParenConn[w] {
					if v := pwAt(toks, k+1); v != nil {
						hit, end = pwConnValue(w, v, pwAt(toks, k+2)), v.end
					}
					break
				}
			}
		case !first.quoted && pwTargetPreps[fw] && (joined || round == 0):
			n := 0
			for k := i + 1; k < len(toks) && n < 4; k++ {
				w := pwBare(toks[k].text)
				if !toks[k].quoted && pwTargetEnd[w] && n > 0 {
					if v := pwAt(toks, k+1); v != nil {
						hit, end = pwConnValue(w, v, pwAt(toks, k+2)), v.end
					}
					break
				}
				if pwEndsSentence(toks[k]) {
					break
				}
				if !(n == 0 && pwArticles[w]) {
					n++
				}
			}
		}
		if hit == nil {
			break
		}
		out = append(out, hit)
		pos = hit.end
		if end > pos {
			pos = end
		}
	}
	return out
}

// pwScanBefore: "Sommer2026! as the new password", "„X“ ist das Kennwort",
// "Use X for the password".
func pwScanBefore(t []rune, k pwKeyword) *pwHit {
	if k.labelOnly || k.plural {
		return nil
	}
	toks := pwTokensBefore(t, k.start, 6)
	i := 0
	for i < len(toks) && !toks[i].quoted && pwArticles[pwBare(toks[i].text)] {
		i++
	}
	if i >= len(toks) || toks[i].quoted || i+1 >= len(toks) {
		return nil
	}
	v := toks[i+1]
	switch pwBare(toks[i].text) {
	case "as", "als", "is", "ist":
	case "for", "für", "fuer":
		if i+2 >= len(toks) || toks[i+2].quoted || !pwUseVerbs[pwBare(toks[i+2].text)] {
			return nil
		}
	default:
		return nil
	}
	if (v.quoted && pwQuotedValue(v)) || (!v.quoted && pwLooseLike(v.text)) {
		return pwValueHit(v, true)
	}
	return nil
}

// pwScanClientFlags: "ldapsearch … -w Secret123", "ldappasswd … -s NewPw1".
func pwScanClientFlags(t []rune) []*pwHit {
	var out []*pwHit
	lineStart := 0
	for _, line := range strings.Split(string(t), "\n") {
		if m := pwLDAPClientRe.FindStringSubmatchIndex(line); m != nil {
			re := pwFlagWRe
			if strings.EqualFold(line[m[4]:m[5]], "passwd") {
				re = pwFlagWSARe
			}
			from := m[1]
			for _, f := range re.FindAllStringIndex(line[from:], -1) {
				at := lineStart + utf8.RuneCountInString(line[:from+f[1]-1])
				if tk := pwTokenAt(t, at); tk != nil && !strings.HasPrefix(tk.text, "-") && tk.text != PasswordPlaceholder {
					out = append(out, pwValueHit(*tk, true))
				}
			}
		}
		lineStart += utf8.RuneCountInString(line) + 1
	}
	return out
}

func pwScan(text string) ([]rune, []*pwHit) {
	t := []rune(text)
	var hits []*pwHit
	add := func(h *pwHit) {
		for _, x := range hits {
			if x.start < h.end && h.start < x.end {
				return
			}
		}
		hits = append(hits, h)
	}
	for _, k := range pwKeywords(t) {
		if r := pwScanKeyword(t, k); r != nil {
			for _, h := range r.hits {
				add(h)
			}
			for _, h := range pwScanContinuation(t, r.anchor) {
				add(h)
			}
			continue
		}
		if b := pwScanBefore(t, k); b != nil {
			add(b)
		}
	}
	for _, h := range pwScanClientFlags(t) {
		add(h)
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].start < hits[j].start })
	return t, hits
}

func pwMask(text string, all bool) string {
	t, hits := pwScan(text)
	var b strings.Builder
	last, n := 0, 0
	for _, h := range hits {
		if !h.sure && !all {
			continue
		}
		b.WriteString(string(t[last:h.start]))
		b.WriteString(PasswordPlaceholder)
		last = h.end
		n++
	}
	if n == 0 {
		return text
	}
	b.WriteString(string(t[last:]))
	return b.String()
}

// HasPasswordValue reports whether text contains a sure password value
// next to a password word ("password: X", "set the password of jdoe to X", …).
func HasPasswordValue(text string) bool {
	_, hits := pwScan(text)
	for _, h := range hits {
		if h.sure {
			return true
		}
	}
	return false
}

// MaskPasswords replaces every sure password value next to a password word
// with PasswordPlaceholder (what the facade stores). A plain word after a
// label ("PW: geheim") stays: the composer asked the user about it. Text
// without a sure value is returned unchanged.
func MaskPasswords(text string) string { return pwMask(text, false) }

// MaskPasswordsAll also replaces the plain words after a label, for text
// the user could not confirm (the note of a denied approval).
func MaskPasswordsAll(text string) string { return pwMask(text, true) }

// PasswordValues returns the sure password values in text (without their
// quotes), for removing the same values from other parts of a chat.
func PasswordValues(text string) []string {
	t, hits := pwScan(text)
	var out []string
	for _, h := range hits {
		if !h.sure {
			continue
		}
		v := t[h.start:h.end]
		if h.quoted && len(v) >= 2 {
			v = v[1 : len(v)-1]
		}
		out = append(out, string(v))
	}
	return out
}

// LooksRandomToken reports a long random-looking token (≥ 20 characters,
// three character classes and a digit) that is no DN, filter, GUID or
// e-mail address — the composer's weak password warning.
func LooksRandomToken(text string) bool {
	for _, tok := range strings.Fields(text) {
		if len(tok) < 20 || len(tok) > 200 || pwWeakSkipRe.MatchString(tok) || pwHexRe.MatchString(tok) {
			continue
		}
		classes := 0
		digit := false
		for _, f := range []func(rune) bool{
			func(r rune) bool { return r >= 'a' && r <= 'z' },
			func(r rune) bool { return r >= 'A' && r <= 'Z' },
			func(r rune) bool { return r >= '0' && r <= '9' },
			func(r rune) bool { return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') },
		} {
			if strings.IndexFunc(tok, f) >= 0 {
				classes++
			}
		}
		digit = strings.IndexFunc(tok, func(r rune) bool { return r >= '0' && r <= '9' }) >= 0
		if classes >= 3 && digit {
			return true
		}
	}
	return false
}
