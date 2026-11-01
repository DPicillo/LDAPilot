package contextmgr

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/provider"
)

func TestBudgetExamples(t *testing.T) {
	thinking := provider.Caps{Thinking: ai.CapYes}
	b := Compute(4096, "api/ps", thinking, 0, 4500)
	if b.MaxOutput != 2048 || !b.TooSmall() {
		t.Fatalf("4096: %+v", b)
	}
	if !strings.Contains(b.TooSmallMessage(), "16k") {
		t.Fatal(b.TooSmallMessage())
	}
	b = Compute(16384, "api/show", thinking, 0, 4500)
	if b.TooSmall() || b.MaxOutput != 4096 {
		t.Fatalf("16384: %+v", b)
	}
	b = Compute(0, "", provider.Caps{}, 0, 1000)
	if b.Window != 8192 || b.WindowSource != "default" {
		t.Fatalf("unknown: %+v", b)
	}
	// "thinking off" never lowers the output budget for thinking models.
	if Compute(32768, "", thinking, 0, 0).MaxOutput < 4096 {
		t.Fatal("thinking floor")
	}
}

func TestResultCapExample(t *testing.T) {
	c, tooLarge := ResultCap(11500, 4500, 4)
	if tooLarge || c < 1300 || c > 1500 {
		t.Fatalf("cap %d", c)
	}
	if _, tooLarge := ResultCap(5000, 4900, 4); !tooLarge {
		t.Fatal("tiny budget not flagged")
	}
}

func tu(id, name string) ai.Block {
	return ai.Block{Type: ai.BlockToolUse, ID: id, Name: name, Input: json.RawMessage(`{"dn":"CN=x"}`)}
}

func tr(id, content string) ai.Block {
	return ai.Block{Type: ai.BlockToolResult, ToolUseID: id, Content: content}
}

func text(s string) ai.Block { return ai.Block{Type: ai.BlockText, Text: s} }

func TestNormalizeRepairs(t *testing.T) {
	executing := tu("w", "modify_entry")
	executing.Meta = &ai.BlockMeta{Executing: true}
	msgs := []ai.Message{
		{ID: "0", Role: ai.RoleAssistant, Blocks: []ai.Block{text("orphan assistant first")}},
		{ID: "1", Role: ai.RoleUser, Blocks: []ai.Block{text("hi")}},
		{ID: "2", Role: ai.RoleAssistant, Blocks: []ai.Block{}}, // empty → dropped
		{ID: "3", Role: ai.RoleAssistant, Blocks: []ai.Block{tu("a", "get_entry"), tu("b", "get_entry")}},
		{ID: "4", Role: ai.RoleUser, Blocks: []ai.Block{text("continue text"), tr("b", "B"), tr("zzz", "orphan")}},
		{ID: "5", Role: ai.RoleAssistant, Blocks: []ai.Block{executing}},
		{ID: "6", Role: ai.RoleUser, Blocks: []ai.Block{text("next")}},
	}
	orig, _ := json.Marshal(msgs)
	res := Normalize(msgs, NormalizeOptions{})
	after, _ := json.Marshal(msgs)
	if string(orig) != string(after) {
		t.Fatal("Normalize mutated its input")
	}
	m := res.Messages
	if m[0].Role != ai.RoleUser {
		t.Fatal("first message not from the user")
	}
	// Results first, synthetic result for "a", orphan dropped.
	var u ai.Message
	for _, x := range m {
		if x.Role == ai.RoleUser && len(x.Blocks) > 0 && x.Blocks[0].Type == ai.BlockToolResult && x.Blocks[0].ToolUseID == "a" {
			u = x
		}
	}
	if len(u.Blocks) != 3 || u.Blocks[1].ToolUseID != "b" || u.Blocks[2].Text != "continue text" || !strings.Contains(u.Blocks[0].Content, "interrupted") {
		t.Fatalf("pairing %+v", u.Blocks)
	}
	last := m[len(m)-1]
	if last.Blocks[0].ToolUseID != "w" || !strings.Contains(last.Blocks[0].Content, "OUTCOME_UNKNOWN") || last.Blocks[1].Text != "next" {
		t.Fatalf("outcome unknown repair %+v", last.Blocks)
	}
	for _, x := range m {
		for _, b := range x.Blocks {
			if b.Meta != nil {
				t.Fatal("Meta not stripped")
			}
		}
	}
	if res.Repairs == 0 {
		t.Fatal("no repairs counted")
	}
	// A valid history needs no repairs.
	if r := Normalize(m, NormalizeOptions{}); r.Repairs != 0 {
		t.Fatalf("repairs on a valid history: %d", r.Repairs)
	}
}

func TestClearedShrunkAndSummary(t *testing.T) {
	cleared := tr("a", `{"ok":true,"big":"data"}`)
	cleared.Meta = &ai.BlockMeta{ClearedAt: 1, Summary: "3 entries"}
	shrunk := tr("b", `{"ok":true,"big":"more data"}`)
	shrunk.Meta = &ai.BlockMeta{Shrunk: `{"ok":true}`}
	msgs := []ai.Message{
		{ID: "1", Role: ai.RoleUser, Blocks: []ai.Block{text("old")}},
		{ID: "2", Role: ai.RoleAssistant, Blocks: []ai.Block{text("old answer")}},
		{ID: "3", Role: ai.RoleUser, Blocks: []ai.Block{text("q")}},
		{ID: "4", Role: ai.RoleAssistant, Blocks: []ai.Block{tu("a", "search_ldap"), tu("b", "get_entry")}},
		{ID: "5", Role: ai.RoleUser, Blocks: []ai.Block{cleared, shrunk}},
	}
	res := Normalize(msgs, NormalizeOptions{SummaryText: "the summary", UpToMessageID: "2"})
	m := res.Messages
	if !strings.Contains(m[0].Blocks[0].Text, "<conversation_summary") || m[0].Blocks[1].Text != "q" {
		t.Fatalf("summary placement %+v", m[0].Blocks)
	}
	if got := m[2].Blocks[0].Content; got != `{"cleared":true,"ok":true,"summary":"3 entries","tool":"search_ldap"}` && !strings.Contains(got, `"cleared":true`) {
		t.Fatalf("cleared %s", got)
	}
	if m[2].Blocks[1].Content != `{"ok":true}` {
		t.Fatal("shrunk not rendered")
	}
	if msgs[4].Blocks[0].Content != `{"ok":true,"big":"data"}` {
		t.Fatal("stored Content changed")
	}
	// Results whose tool_use was folded into the summary are orphans: they
	// are dropped by the repair that runs before the summary is placed.
	res = Normalize(msgs, NormalizeOptions{SummaryText: "s", UpToMessageID: "4"})
	if len(res.Messages) != 1 || len(res.Messages[0].Blocks) != 1 || !strings.Contains(res.Messages[0].Blocks[0].Text, "conversation_summary") {
		t.Fatalf("orphans after compaction: %+v", res.Messages)
	}
	// With results in the first retained message (mid-turn compaction),
	// the summary goes after them.
	keep := []ai.Message{{ID: "a", Role: ai.RoleAssistant, Blocks: []ai.Block{tu("z", "get_entry")}}, {ID: "b", Role: ai.RoleUser, Blocks: []ai.Block{tr("z", "{}"), text("more")}}}
	res = Normalize(keep, NormalizeOptions{SummaryText: "s"})
	if res.Messages[0].Role != ai.RoleUser || res.Messages[0].Blocks[0].Type != ai.BlockText {
		t.Fatalf("first message: %+v", res.Messages[0])
	}
}

func TestThinkingRules(t *testing.T) {
	th := ai.Block{Type: ai.BlockThinking, Thinking: "t", Signature: "sig", Producer: "anthropic:m"}
	other := ai.Block{Type: ai.BlockThinking, Thinking: "t", Signature: "sig", Producer: "anthropic:other"}
	msgs := []ai.Message{
		{Role: ai.RoleUser, Blocks: []ai.Block{text("1")}},
		{Role: ai.RoleAssistant, Blocks: []ai.Block{th, text("a")}},
		{Role: ai.RoleUser, Blocks: []ai.Block{text("2")}},
		{Role: ai.RoleAssistant, Blocks: []ai.Block{th, other, tu("x", "get_entry")}},
		{Role: ai.RoleUser, Blocks: []ai.Block{tr("x", "{}")}},
	}
	res := Normalize(msgs, NormalizeOptions{ReplayThinking: true, TargetProducer: "anthropic:m"})
	if res.TurnStartIndex != 2 || len(res.Messages[1].Blocks) != 1 || len(res.Messages[3].Blocks) != 2 {
		t.Fatalf("turn %d, blocks %d / %d", res.TurnStartIndex, len(res.Messages[1].Blocks), len(res.Messages[3].Blocks))
	}
	res = Normalize(msgs, NormalizeOptions{})
	for _, m := range res.Messages {
		for _, b := range m.Blocks {
			if b.Type == ai.BlockThinking {
				t.Fatal("thinking sent to a non-replay provider")
			}
		}
	}
}

func TestClearOldAndCalibration(t *testing.T) {
	msgs := []ai.Message{
		{Role: ai.RoleUser, Blocks: []ai.Block{text("1")}},
		{Role: ai.RoleAssistant, Blocks: []ai.Block{tu("a", "x")}},
		{Role: ai.RoleUser, Blocks: []ai.Block{tr("a", "A")}},
		{Role: ai.RoleUser, Blocks: []ai.Block{text("2")}},
		{Role: ai.RoleAssistant, Blocks: []ai.Block{tu("b", "x")}},
		{Role: ai.RoleUser, Blocks: []ai.Block{tr("b", "B")}},
		{Role: ai.RoleUser, Blocks: []ai.Block{text("3")}},
	}
	if !ClearOld(msgs, 2, 99) || msgs[2].Blocks[0].Meta.ClearedAt != 99 || msgs[5].Blocks[0].Meta != nil {
		t.Fatal("clearing boundary")
	}
	c := Calibrate(nil, "ollama", "m", 1000, 1500)
	if c.K != 1.25 {
		t.Fatal(c.K)
	}
	c = Calibrate(c, "ollama", "m", 1000, 5000)
	if c.K != 2.0 {
		t.Fatal("clamp", c.K)
	}
	if Factor(c, "ollama", "other") != 1 {
		t.Fatal("k not reset on a model change")
	}
}

// test-1 D2: the automatic Ollama window grows from 16k (in 8k steps, at
// most 32k and the trained context) until the fixed overhead leaves 8k.
func TestAutoWindow(t *testing.T) {
	thinking := provider.Caps{Thinking: ai.CapYes}
	for _, tc := range []struct {
		window, maxCtx, overhead, want int
	}{
		{16384, 262144, 8226, 24576},  // writes enabled: 3.2k free at 16k
		{16384, 262144, 2500, 16384},  // small overhead: unchanged
		{16384, 20000, 8226, 20000},   // capped at the trained context
		{16384, 262144, 30000, 32768}, // never beyond 32k
		{16384, 0, 8226, 16384},       // unknown trained context: unchanged
		{8192, 8192, 8226, 8192},
	} {
		got := AutoWindow(tc.window, tc.maxCtx, thinking, 0, tc.overhead)
		if got != tc.want {
			t.Errorf("%+v: got %d", tc, got)
		}
		if got > tc.window {
			if b := Compute(got, "", thinking, 0, tc.overhead); b.InputBudget-tc.overhead < AutoWindowMinFree && got < min(AutoWindowCeiling, tc.maxCtx) {
				t.Errorf("%+v: %d leaves %d", tc, got, b.InputBudget-tc.overhead)
			}
		}
	}
}
