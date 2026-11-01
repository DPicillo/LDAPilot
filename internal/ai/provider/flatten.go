package provider

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

const flattenExcerptChars = 600

// FlattenTranscript renders a history as one plain-text transcript for
// tool-less requests (compaction, titles): tool calls become
// "[tool name(args) → summary]" lines with a short result excerpt, only the
// latest hidden context block and the latest summary are kept, thinking
// and IDs are dropped, and every excerpt is neutralized.
func FlattenTranscript(msgs []ai.Message) string {
	return flatten(msgs, true)
}

// FlattenReplay renders a history for a model that continues the
// conversation (the Claude Code replay, §11 c): user and assistant text and
// "[tool name(args) → summary]" lines only. Result excerpts (raw directory
// data) and hidden context blocks are left out, so untrusted values never
// reach the model as user-turn text.
func FlattenReplay(msgs []ai.Message) string {
	return flatten(msgs, false)
}

func flatten(msgs []ai.Message, excerpts bool) string {
	lastCtx, lastSummary := -1, -1
	for mi, m := range msgs {
		for _, b := range m.Blocks {
			if b.Type == ai.BlockText && b.Meta != nil {
				switch b.Meta.Kind {
				case "context":
					lastCtx = mi
				case "summary":
					lastSummary = mi
				}
			}
		}
	}
	calls := map[string]ai.Block{}
	var sb strings.Builder
	sb.WriteString("<transcript>\n")
	for mi, m := range msgs {
		for _, b := range m.Blocks {
			switch b.Type {
			case ai.BlockText:
				kind := ""
				if b.Meta != nil {
					kind = b.Meta.Kind
				}
				switch kind {
				case "context":
					if excerpts && mi == lastCtx {
						fmt.Fprintf(&sb, "[context: %s]\n", oneLine(safe(b.Text), 400))
					}
					continue
				case "summary":
					if mi == lastSummary {
						fmt.Fprintf(&sb, "[Earlier summary]\n%s\n\n", safe(b.Text))
					}
					continue
				}
				who := "User"
				if m.Role == ai.RoleAssistant {
					who = "Assistant"
				}
				if strings.TrimSpace(b.Text) != "" {
					fmt.Fprintf(&sb, "%s: %s\n", who, safe(b.Text))
				}
			case ai.BlockToolUse:
				calls[b.ID] = b
			case ai.BlockToolResult:
				use := calls[b.ToolUseID]
				name := use.Name
				if name == "" {
					name = "tool"
				}
				summary := ""
				if b.Meta != nil {
					summary = b.Meta.Summary
				}
				switch {
				case b.IsError:
					code := ""
					if b.Meta != nil {
						code = b.Meta.ErrorCode
					}
					if code == "" {
						code = "error"
					}
					fmt.Fprintf(&sb, "[tool %s(%s) → %s]\n", name, compactArgs(use.Input), code)
				default:
					if summary == "" {
						summary = "done"
					}
					fmt.Fprintf(&sb, "[tool %s(%s) → %s]\n", name, compactArgs(use.Input), oneLine(safe(summary), 200))
					cleared := b.Meta != nil && b.Meta.ClearedAt > 0
					if excerpts && !cleared && strings.TrimSpace(b.Content) != "" {
						fmt.Fprintf(&sb, "  result excerpt: %s\n", oneLine(safe(b.Content), flattenExcerptChars))
					}
				}
			}
		}
	}
	sb.WriteString("</transcript>")
	return sb.String()
}

// flattenedUserMessage wraps a transcript as the single user message of a
// tool-less request. If msgs already hold a single text-only user message
// it is used as is.
func flattenedMessages(msgs []ai.Message) []ai.Message {
	if len(msgs) == 1 && msgs[0].Role == ai.RoleUser {
		textOnly := true
		for _, b := range msgs[0].Blocks {
			if b.Type != ai.BlockText {
				textOnly = false
			}
		}
		if textOnly {
			return msgs
		}
	}
	return []ai.Message{{Role: ai.RoleUser, Blocks: []ai.Block{{Type: ai.BlockText, Text: FlattenTranscript(msgs)}}}}
}

// SafeText neutralizes template tokens and invisible characters.
func SafeText(s string) string { return safe(s) }

func safe(s string) string {
	out, _, _ := ai.SanitizeUntrusted(s)
	return out
}

func oneLine(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len([]rune(s)) > max {
		r := []rune(s)
		s = string(r[:max]) + "…"
	}
	return s
}

func compactArgs(in json.RawMessage) string {
	if len(in) == 0 {
		return ""
	}
	return oneLine(safe(string(in)), 200)
}
