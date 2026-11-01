package provider

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
)

func jsonUnmarshal(data []byte, v any) error { return json.Unmarshal(data, v) }

// stepBuilder assembles the canonical assistant message of one step while
// emitting live events. Content passes through the think filter and the
// salvage hold-back; reasoning passes through the reasoning filter.
type stepBuilder struct {
	sink        func(Event)
	providerKey string
	offered     []tools.Spec
	salvage     bool

	blocks    []ai.Block
	open      int // index of the open text/thinking block, or -1
	textIdx   []int
	think     *thinkFilter
	hold      *holdBack
	reasoning *reasoningFilter
	warnings  []string

	sawReasoning bool
}

func newStepBuilder(sink func(Event), providerKey string, offered []tools.Spec, knownThinker, salvage bool) *stepBuilder {
	b := &stepBuilder{sink: sink, providerKey: providerKey, offered: offered, salvage: salvage && len(offered) > 0, open: -1}
	b.hold = newHoldBack(b.salvage, b.appendText)
	b.think = newThinkFilter(knownThinker, func(k segmentKind, s string) {
		if k == segThinking {
			b.appendThinking(s)
			return
		}
		b.hold.push(s)
	})
	b.reasoning = newReasoningFilter(b.appendThinking)
	return b
}

// content feeds answer text (may contain <think> tags and leaked calls).
func (b *stepBuilder) content(s string) {
	if b.sawReasoning && b.think.probing {
		// The server splits reasoning into its own field: a lone </think>
		// in content is not expected, so stop holding text back.
		b.think.stopProbing()
	}
	b.think.push(s)
}

// reasoningText feeds a separate reasoning field.
func (b *stepBuilder) reasoningText(s string) {
	if s != "" {
		b.sawReasoning = true
	}
	b.reasoning.push(s)
}

func (b *stepBuilder) appendText(s string) {
	if s == "" {
		return
	}
	if b.open < 0 || b.blocks[b.open].Type != ai.BlockText {
		b.blocks = append(b.blocks, ai.Block{Type: ai.BlockText})
		b.open = len(b.blocks) - 1
		b.textIdx = append(b.textIdx, b.open)
	}
	b.blocks[b.open].Text += s
	b.sink(Event{Kind: EvTextDelta, BlockIndex: b.open, Text: s})
}

func (b *stepBuilder) appendThinking(s string) {
	if s == "" {
		return
	}
	if b.open < 0 || b.blocks[b.open].Type != ai.BlockThinking {
		b.blocks = append(b.blocks, ai.Block{Type: ai.BlockThinking})
		b.open = len(b.blocks) - 1
	}
	b.blocks[b.open].Thinking += s
	b.sink(Event{Kind: EvThinkingDelta, BlockIndex: b.open, Text: s})
}

// addToolUse appends a finished tool_use block.
func (b *stepBuilder) addToolUse(blk ai.Block) {
	b.blocks = append(b.blocks, blk)
	b.open = -1
}

// finish flushes the filters and runs text tool-call salvage when the step
// has no native tool calls. It returns the salvaged tool_use blocks
// (already appended).
func (b *stepBuilder) finish(model string, nativeCalls bool) []ai.Block {
	out := b.finishText(model, nativeCalls)
	// Models sometimes copy the <conversation_summary> wrapper of a
	// compacted history into the answer (defect D2): drop the tags.
	for _, idx := range b.textIdx {
		if t := StripSummaryTags(b.blocks[idx].Text); t != b.blocks[idx].Text {
			b.blocks[idx].Text = t
			b.sink(Event{Kind: EvTextReplaced, BlockIndex: idx, Text: t})
		}
	}
	return out
}

var summaryTagRe = regexp.MustCompile(`(?i)[ \t]*</?conversation_summary\b[^>]*>[ \t]*\r?\n?`)

// StripSummaryTags removes <conversation_summary …> and
// </conversation_summary> tags (LDAPilot's wrapper of a compacted history)
// from model text; the text between them stays.
func StripSummaryTags(s string) string {
	if !strings.Contains(strings.ToLower(s), "conversation_summary") {
		return s
	}
	return strings.TrimSpace(summaryTagRe.ReplaceAllString(s, ""))
}

func (b *stepBuilder) finishText(model string, nativeCalls bool) []ai.Block {
	b.think.flush()
	b.reasoning.flush()
	flushed, held := b.hold.finish()
	if !b.salvage || nativeCalls {
		b.appendText(held)
		b.setProducer(model)
		return nil
	}
	full := flushed + held
	calls, rest, failed := salvageText(full, b.offered)
	if len(calls) == 0 {
		b.appendText(held)
		if failed {
			b.warn()
		}
		b.setProducer(model)
		return nil
	}
	if strings.HasPrefix(rest, flushed) {
		b.appendText(strings.TrimRight(rest[len(flushed):], " \t\r\n"))
	} else {
		// Text that was already shown is part of a salvaged call: replace
		// the step's text blocks.
		newText := strings.TrimSpace(rest)
		for i, idx := range b.textIdx {
			t := ""
			if i == 0 {
				t = newText
			}
			if b.blocks[idx].Text != t {
				b.blocks[idx].Text = t
				b.sink(Event{Kind: EvTextReplaced, BlockIndex: idx, Text: t})
			}
		}
		if len(b.textIdx) == 0 && newText != "" {
			b.appendText(newText)
		}
	}
	if failed {
		b.warn()
	}
	var out []ai.Block
	for _, c := range calls {
		args := normalizeArgValue(c.args)
		blk := toolUseBlock(b.providerKey, model, "", c.name, args, b.offered)
		if blk.Meta == nil {
			blk.Meta = &ai.BlockMeta{}
		}
		blk.Meta.Warnings = appendUnique(blk.Meta.Warnings, warnSalvaged)
		b.addToolUse(blk)
		b.sink(Event{Kind: EvToolUseStart, ToolName: blk.Name})
		out = append(out, blk)
	}
	b.warnings = appendUnique(b.warnings, warnSalvaged)
	b.setProducer(model)
	return out
}

func (b *stepBuilder) warn() {
	b.sink(Event{Kind: EvStatus, Status: &Status{Kind: ai.StatusWarning, Message: salvageWarning}})
}

func (b *stepBuilder) setProducer(model string) {
	for i := range b.blocks {
		switch b.blocks[i].Type {
		case ai.BlockThinking, ai.BlockRedactedThinking, ai.BlockToolUse:
			if b.blocks[i].Producer == "" {
				b.blocks[i].Producer = Producer(b.providerKey, model)
			}
		}
	}
}

// message returns the final blocks: empty text blocks are dropped.
func (b *stepBuilder) message() []ai.Block {
	out := make([]ai.Block, 0, len(b.blocks))
	for _, blk := range b.blocks {
		if blk.Type == ai.BlockText && strings.TrimSpace(blk.Text) == "" {
			continue
		}
		out = append(out, blk)
	}
	return out
}

func (b *stepBuilder) hasToolUse() bool {
	for _, blk := range b.blocks {
		if blk.Type == ai.BlockToolUse {
			return true
		}
	}
	return false
}

func (b *stepBuilder) hasVisibleText() bool {
	for _, blk := range b.blocks {
		if blk.Type == ai.BlockText && strings.TrimSpace(blk.Text) != "" {
			return true
		}
	}
	return false
}

// joinText concatenates the text blocks of a message.
func joinText(m ai.Message) string {
	var parts []string
	for _, b := range m.Blocks {
		if b.Type == ai.BlockText && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n\n")
}
