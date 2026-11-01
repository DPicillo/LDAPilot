package ai

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// WordJoiner (U+2060) is inserted into chat-template tokens found in
// untrusted text, so that local chat templates cannot interpret them.
const WordJoiner = "⁠"

// templateTokens lists tokens whose first character gets a word joiner
// appended when they occur in untrusted text (§6.6 item 3). The check is
// case-sensitive for the bracket tokens and case-insensitive for the tags.
var templateTokens = []string{
	"<think>", "</think>", "<tool_call>", "</tool_call>", "<tool_response>", "</tool_response>",
	"<function=", "<|python_tag|>", "<start_of_turn>", "<end_of_turn>", "<s>", "</s>",
	"[INST]", "[/INST]", "[TOOL_CALLS]", "[TOOL_RESULTS]", "[/TOOL_RESULTS]", "[AVAILABLE_TOOLS]",
	"[/AVAILABLE_TOOLS]", "[SYSTEM_PROMPT]", "[/SYSTEM_PROMPT]", "[ARGS]",
}

// NeutralizeTemplateTokens inserts U+2060 after the opening '<' or '['
// of chat-template tokens: every "<|…|>" and "<｜…｜>" token and the fixed
// list above. It reports whether anything was changed.
func NeutralizeTemplateTokens(s string) (string, bool) {
	if !strings.ContainsAny(s, "<[") {
		return s, false
	}
	var b strings.Builder
	changed := false
	for i := 0; i < len(s); {
		c := s[i]
		if (c == '<' || c == '[') && matchesTemplateToken(s[i:]) {
			b.WriteByte(c)
			b.WriteString(WordJoiner)
			changed = true
			i++
			continue
		}
		b.WriteByte(c)
		i++
	}
	if !changed {
		return s, false
	}
	return b.String(), true
}

func matchesTemplateToken(rest string) bool {
	// <|…|> with a short body (special tokens like <|im_start|>).
	if strings.HasPrefix(rest, "<|") {
		if end := strings.Index(rest[2:], "|>"); end >= 0 && end <= 64 && !strings.ContainsAny(rest[2:2+end], " \n<>") {
			return true
		}
	}
	// DeepSeek full-width variant <｜…｜>.
	if strings.HasPrefix(rest, "<｜") {
		if end := strings.Index(rest[len("<｜"):], "｜>"); end >= 0 && end <= 96 {
			return true
		}
	}
	for _, t := range templateTokens {
		if len(rest) >= len(t) {
			if t[0] == '<' {
				if strings.EqualFold(rest[:len(t)], t) {
					return true
				}
			} else if rest[:len(t)] == t {
				return true
			}
		}
	}
	return false
}

// StripWordJoiners removes U+2060 from model-supplied text (DNs, filters,
// values), undoing the neutralization before the text is used.
func StripWordJoiners(s string) string {
	if !strings.Contains(s, WordJoiner) {
		return s
	}
	return strings.ReplaceAll(s, WordJoiner, "")
}

// IsInvisibleRune reports whether r is an invisible or format character that
// is escaped in untrusted text (§6.6 item 4): Unicode tag characters,
// bidi controls, zero-width characters and other format (Cf) characters.
func IsInvisibleRune(r rune) bool {
	switch {
	case r >= 0xE0000 && r <= 0xE007F:
		return true
	case r >= 0x202A && r <= 0x202E, r >= 0x2066 && r <= 0x2069, r == 0x200E, r == 0x200F, r == 0x061C:
		return true
	case r >= 0x200B && r <= 0x200D, r >= 0x2060 && r <= 0x2064, r == 0xFEFF:
		return true
	}
	return unicode.Is(unicode.Cf, r)
}

// EscapeInvisible replaces invisible characters with a visible escape like
// "⟨U+200B⟩" and reports whether any were found. Invalid UTF-8 bytes are
// replaced with U+FFFD.
func EscapeInvisible(s string) (string, bool) {
	found := false
	for _, r := range s {
		if IsInvisibleRune(r) {
			found = true
			break
		}
	}
	if !found {
		if utf8.ValidString(s) {
			return s, false
		}
		return strings.ToValidUTF8(s, "�"), false
	}
	var b strings.Builder
	for _, r := range s {
		if IsInvisibleRune(r) {
			fmt.Fprintf(&b, "⟨U+%04X⟩", r)
			continue
		}
		b.WriteRune(r)
	}
	return b.String(), true
}

// SanitizeUntrusted escapes invisible characters first (so that the word
// joiners added afterwards are never flagged) and then neutralizes template
// tokens.
func SanitizeUntrusted(s string) (out string, hidden, neutralized bool) {
	out, hidden = EscapeInvisible(s)
	out, neutralized = NeutralizeTemplateTokens(out)
	return out, hidden, neutralized
}
