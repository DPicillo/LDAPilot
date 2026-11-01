package ldaptools

import (
	"encoding/base64"
	"fmt"
	"regexp"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

// Warning prefixes added to tool results (§6.5, §6.6).
const (
	WarnInjection = "possible_prompt_injection"
	WarnHidden    = "hidden_unicode"
	WarnSanitized = "value_sanitized"
	WarnMasked    = "value_masked"
)

// MaxValueRunes is the per-value cap in tool results.
const MaxValueRunes = 512

const maxWarnings = 20

// credentialsRe scrubs embedded credentials (olcSyncrepl, olcDbURI,
// replication agreements).
var credentialsRe = regexp.MustCompile(`(?i)\b(credentials|bindpw|bindpassword|passwd)\s*=\s*("[^"]*"|\S+)`)

// passwordLikeRe finds password-like free text ("PW: …", "Kennwort: …").
var passwordLikeRe = regexp.MustCompile(`(?i)\b(pass(wort|word)?|pwd|kennwort|pw|initial(es)? ?passwort)\s*[:=]\s*\S+`)

// PasswordLike reports whether s contains password-like text.
func PasswordLike(s string) bool { return passwordLikeRe.MatchString(s) }

// writeToolNames are used by the "call <write tool>" heuristic.
var writeToolNames = []string{"modify_entry", "create_entry", "move_or_rename_entry", "delete_entry",
	"update_group_membership", "unlock_account", "set_account_enabled", "set_password_must_change", "reset_password"}

var allToolNames = append([]string{"list_connections", "get_server_info", "search_ldap", "get_entry", "get_children",
	"get_schema_definition", "validate_filter", "decode_value", "get_membership", "get_account_status", "find_accounts",
	"count_entries", "list_deleted_objects"},
	writeToolNames...)

var injectionPatterns = func() []*regexp.Regexp {
	pats := []string{
		// English
		`(?i)ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)`,
		`(?i)system\s+prompt`,
		`(?i)you\s+are\s+now`,
		`(?im)^\s*(assistant|system|user)\s*:`,
		`(?i)do\s+not\s+(tell|inform|show)\s+the\s+user`,
		`(?i)new\s+instructions?\s*:`,
		// German
		`(?i)ignorier(e|en)?\s+(alle\s+|sämtliche\s+)?(vorherigen|bisherigen|obigen|früheren)\s+(anweisungen|instruktionen|befehle|regeln)`,
		`(?i)du\s+bist\s+(jetzt|nun|ab\s+sofort)`,
		`(?i)system-?prompt`,
		`(?i)(sag|teile|zeige)\s+(es\s+)?(dem|den)\s+(benutzer|nutzer|anwender)(n)?\s+nicht`,
		`(?i)neue\s+anweisung(en)?\s*:`,
		// tool names followed by "(", or call/rufe + write tool
		`(?i)\b(` + strings.Join(allToolNames, "|") + `)\s*\(`,
		`(?i)\b(call|rufe)\s+(` + strings.Join(writeToolNames, "|") + `)\b`,
	}
	out := make([]*regexp.Regexp, len(pats))
	for i, p := range pats {
		out[i] = regexp.MustCompile(p)
	}
	return out
}()

// LooksLikeInjection reports whether s matches a prompt-injection pattern.
func LooksLikeInjection(s string) bool {
	for _, re := range injectionPatterns {
		if re.MatchString(s) {
			return true
		}
	}
	return false
}

// Sanitizer processes untrusted directory values for one tool result and
// collects warnings.
type Sanitizer struct {
	MaskPasswords bool
	warnings      []string
	seen          map[string]bool
	dropped       int
	Suspicious    bool // injection pattern, sanitized token or hidden characters seen
	Masked        bool
}

// NewSanitizer creates a sanitizer.
func NewSanitizer(maskPasswords bool) *Sanitizer {
	return &Sanitizer{MaskPasswords: maskPasswords, seen: map[string]bool{}}
}

func (z *Sanitizer) warn(w string) {
	if z.seen[w] {
		return
	}
	z.seen[w] = true
	if len(z.warnings) >= maxWarnings {
		z.dropped++
		return
	}
	z.warnings = append(z.warnings, w)
}

// Warnings returns the collected warnings.
func (z *Sanitizer) Warnings() []string {
	out := append([]string(nil), z.warnings...)
	if z.dropped > 0 {
		out = append(out, fmt.Sprintf("%d more warnings omitted", z.dropped))
	}
	return out
}

// Text sanitizes an untrusted string that is not an attribute value (a DN,
// an RDN, a name): invisible characters are escaped and chat-template
// tokens neutralized.
func (z *Sanitizer) Text(s, attr, dn string) string {
	out, hidden, neutralized := ai.SanitizeUntrusted(s)
	if hidden {
		z.Suspicious = true
		z.warn(fmt.Sprintf("%s: %s of %s", WarnHidden, safeAttr(attr), warnDN(dn)))
	}
	if neutralized {
		z.Suspicious = true
		z.warn(WarnSanitized)
	}
	return out
}

// DN sanitizes a DN for output.
func (z *Sanitizer) DN(dn string) string { return z.Text(dn, "dn", dn) }

// Value sanitizes one attribute value: embedded credentials and (if
// enabled) password-like text are masked, injection patterns flagged,
// invisible characters escaped, template tokens neutralized and the value
// capped at MaxValueRunes.
func (z *Sanitizer) Value(attr, dn, v string, dnSyntax bool) string {
	if credentialsRe.MatchString(v) {
		v = credentialsRe.ReplaceAllString(v, "${1}=[redacted]")
		z.Masked = true
		z.warn(fmt.Sprintf("%s: %s of %s", WarnMasked, safeAttr(attr), warnDN(dn)))
	}
	if z.MaskPasswords && !dnSyntax && passwordLikeRe.MatchString(v) {
		v = passwordLikeRe.ReplaceAllStringFunc(v, func(m string) string {
			i := strings.IndexAny(m, ":=")
			return m[:i+1] + " [redacted]"
		})
		z.Masked = true
		z.warn(fmt.Sprintf("%s: %s of %s", WarnMasked, safeAttr(attr), warnDN(dn)))
	}
	if LooksLikeInjection(v) {
		z.Suspicious = true
		z.warn(fmt.Sprintf("%s: %s of %s", WarnInjection, safeAttr(attr), warnDN(dn)))
	}
	v = z.Text(v, attr, dn)
	return truncRunes(v, MaxValueRunes)
}

func truncRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + fmt.Sprintf("…(+%d chars)", len(r)-n)
}

// warnDN is the DN as named in a warning: the first two RDNs, sanitized
// like the DN itself. Warnings are part of the rendered result, so the raw
// DN would put the hidden characters and template tokens the warning
// reports right next to their neutralized copy.
func warnDN(dn string) string {
	s, _, _ := ai.SanitizeUntrusted(shortDN(dn))
	return s
}

// safeAttr sanitizes an attribute name for a warning (names come from the
// directory's entries too).
func safeAttr(attr string) string {
	s, _, _ := ai.SanitizeUntrusted(attr)
	return s
}

// shortDN keeps warnings short: the first two RDNs.
func shortDN(dn string) string {
	parts := splitDN(dn)
	if len(parts) <= 2 {
		return dn
	}
	return strings.Join(parts[:2], ",") + ",…"
}

// splitDN splits on unescaped commas.
func splitDN(dn string) []string {
	var out []string
	start := 0
	esc := false
	for i := 0; i < len(dn); i++ {
		switch {
		case esc:
			esc = false
		case dn[i] == '\\':
			esc = true
		case dn[i] == ',':
			out = append(out, strings.TrimSpace(dn[start:i]))
			start = i + 1
		}
	}
	if s := strings.TrimSpace(dn[start:]); s != "" || len(out) == 0 {
		out = append(out, s)
	}
	return out
}

// BinarySummary describes a base64 binary value without its content.
func BinarySummary(b64 string) string {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return fmt.Sprintf("<binary %d bytes, data>", base64.StdEncoding.DecodedLen(len(b64)))
	}
	return fmt.Sprintf("<binary %d bytes, %s>", len(raw), sniffMIME(raw))
}

func sniffMIME(b []byte) string {
	switch {
	case len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF:
		return "image/jpeg"
	case len(b) >= 8 && string(b[:8]) == "\x89PNG\r\n\x1a\n":
		return "image/png"
	case len(b) >= 4 && string(b[:4]) == "GIF8":
		return "image/gif"
	case len(b) >= 4 && b[0] == 0x30 && b[1] == 0x82:
		return "application/pkix-cert"
	}
	return "data"
}
