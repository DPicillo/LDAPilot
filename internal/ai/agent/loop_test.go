package agent

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/aitest/fake"
	"github.com/dpicillo/LDAPilot/internal/ai/chatstore"
	"github.com/dpicillo/LDAPilot/internal/ai/contextmgr"
	"github.com/dpicillo/LDAPilot/internal/ai/provider"
	"github.com/dpicillo/LDAPilot/internal/config"
	"github.com/dpicillo/LDAPilot/internal/models"
)

func call(name, args string) fake.ToolCall { return fake.ToolCall{Name: name, Args: args} }

func TestGoldenToolLoop(t *testing.T) {
	h := newHarness(t, "read", false)
	h.prov.Push(fake.Step{Calls: []fake.ToolCall{call("get_entry", `{"dn":"`+anna+`","attributes":["cn","description"]}`)}},
		fake.Step{Text: "Anna works in Sales.", Stop: ai.StopEndTurn})
	id := h.newChat()
	h.send(id, "What does Anna do?")
	h.wait(id)
	checkSeq(t, h.rec)
	h.golden("tool_loop")
	c := h.chat(id)
	if len(c.Messages) != 4 || c.Messages[3].Role != ai.RoleAssistant {
		t.Fatalf("messages: %d", len(c.Messages))
	}
	if !strings.HasPrefix(c.Messages[0].Blocks[0].Text, "<ldapilot_context>") {
		t.Fatal("first user message lacks the context block")
	}
	if d := h.done(); d.Status != ai.RunCompleted || d.FinalMessageID != c.Messages[3].ID {
		t.Fatalf("done %+v", d)
	}
	// SendMessage right after ai:done never sees run_active.
	h.prov.Push(fake.Step{Text: "ok"})
	if _, err := h.m.Send(ai.SendRequest{ChatID: id, Text: "again"}); err != nil {
		t.Fatalf("send after done: %v", err)
	}
	h.wait(id)
}

func TestGoldenStepLimitContinue(t *testing.T) {
	h := newHarness(t, "read", false)
	h.cfg.update(func(c *config.AIConfig) { c.MaxSteps = 2 })
	h.prov.Push(fake.Step{Calls: []fake.ToolCall{call("get_entry", `{"dn":"`+anna+`","attributes":["cn"]}`)}},
		fake.Step{Calls: []fake.ToolCall{call("get_entry", `{"dn":"`+admins+`","attributes":["cn"]}`)}},
		fake.Step{Text: "Here is what I found.", Stop: ai.StopEndTurn})
	id := h.newChat()
	h.send(id, "Look around.")
	h.wait(id)
	d := h.done()
	if d.Status != ai.RunStepLimit || !d.CanContinue {
		t.Fatalf("done %+v", d)
	}
	c := h.chat(id)
	last := c.Messages[len(c.Messages)-1]
	if !strings.Contains(last.Blocks[0].Content, "STEP_LIMIT") {
		t.Fatalf("no STEP_LIMIT result: %+v", last)
	}
	if _, err := h.m.Continue(id, ai.UIContext{ActiveProfileID: adID, TimeZone: "UTC"}); err != nil {
		t.Fatal(err)
	}
	h.wait(id)
	if d := h.done(); d.Status != ai.RunCompleted {
		t.Fatalf("continue: %+v", d)
	}
	// The continue text is merged after the tool results in the request.
	reqs := h.prov.Requests
	lastReq := reqs[len(reqs)-1].Req
	um := lastReq.Messages[len(lastReq.Messages)-1]
	if um.Role != ai.RoleUser || um.Blocks[0].Type != ai.BlockToolResult || um.Blocks[len(um.Blocks)-1].Text != ContinueText {
		t.Fatalf("continue message: %+v", um)
	}
	checkSeq(t, h.rec)
	h.golden("step_limit_continue")
}

func TestGoldenMaxTokensRetry(t *testing.T) {
	h := newHarness(t, "read", false)
	h.prov.Push(fake.Step{Thinking: "thinking a lot", Stop: ai.StopMaxTokens}, fake.Step{Text: "Short answer."})
	id := h.newChat()
	h.send(id, "Explain LDAP.")
	h.wait(id)
	if len(h.prov.Requests) != 2 {
		t.Fatalf("requests %d", len(h.prov.Requests))
	}
	if a, b := h.prov.Requests[0].Req.MaxOutputTokens, h.prov.Requests[1].Req.MaxOutputTokens; b <= a {
		t.Fatalf("retry budget %d → %d", a, b)
	}
	checkSeq(t, h.rec)
	h.golden("max_tokens_retry")
}

func TestMaxTokensNeverRunsTools(t *testing.T) {
	h := newHarness(t, "read", false)
	h.prov.Push(fake.Step{Text: "Partial", Calls: []fake.ToolCall{call("get_entry", `{"dn":"`+anna+`"}`)}, Stop: ai.StopMaxTokens})
	id := h.newChat()
	h.send(id, "x")
	h.wait(id)
	for _, op := range h.ad.Recorded() {
		if op.Op == "search" || op.Op == "types" {
			t.Fatalf("tool ran on max_tokens: %+v", op)
		}
	}
	c := h.chat(id)
	last := c.Messages[len(c.Messages)-1]
	if !last.Truncated || last.StopReason != ai.StopMaxTokens {
		t.Fatalf("last %+v", last)
	}
	if d := h.done(); d.Status != ai.RunTruncated || !d.CanContinue {
		t.Fatalf("done %+v", d)
	}
}

func TestEmptyAnswerNudge(t *testing.T) {
	h := newHarness(t, "read", false)
	h.prov.Push(fake.Step{Calls: []fake.ToolCall{call("decode_value", `{"kind":"filetime","value":"0"}`)}}, fake.Step{}, fake.Step{Text: "Zero means not set."})
	id := h.newChat()
	h.send(id, "decode 0")
	h.wait(id)
	if n := len(h.prov.Requests); n != 3 {
		t.Fatalf("requests %d", n)
	}
	last := h.prov.Requests[2].Req.Messages
	tail := last[len(last)-1]
	if tail.Blocks[len(tail.Blocks)-1].Text != nudgeText {
		t.Fatal("nudge not sent")
	}
	for _, m := range h.chat(id).Messages {
		for _, b := range m.Blocks {
			if b.Text == nudgeText {
				t.Fatal("nudge persisted")
			}
		}
	}
}

// test-1 D5: an empty first answer (no tool results yet) is retried once
// too; a second empty answer ends with the notice.
func TestEmptyFirstAnswerRetried(t *testing.T) {
	h := newHarness(t, "read", false)
	h.prov.Push(fake.Step{Thinking: "hmm"}, fake.Step{Text: "Hello."})
	id := h.newChat()
	h.send(id, "hi")
	h.wait(id)
	if n := len(h.prov.Requests); n != 2 {
		t.Fatalf("requests %d", n)
	}
	last := h.prov.Requests[1].Req.Messages
	tail := last[len(last)-1]
	if tail.Blocks[len(tail.Blocks)-1].Text != firstNudgeText {
		t.Fatal("nudge not sent")
	}
	c := h.chat(id)
	if got := c.Messages[len(c.Messages)-1]; visibleText(got) != "Hello." {
		t.Fatalf("answer %+v", got)
	}
	h2 := newHarness(t, "read", false)
	h2.prov.Push(fake.Step{}, fake.Step{})
	id2 := h2.newChat()
	h2.send(id2, "hi")
	h2.wait(id2)
	if n := len(h2.prov.Requests); n != 2 {
		t.Fatalf("second empty answer retried again: %d requests", n)
	}
	c2 := h2.chat(id2)
	if got := c2.Messages[len(c2.Messages)-1]; !strings.Contains(visibleText(got), emptyAnswerNotice) {
		t.Fatalf("notice %+v", got)
	}
}

func TestProviderErrorAfterToolRoundPersists(t *testing.T) {
	h := newHarness(t, "read", false)
	h.prov.Push(fake.Step{Calls: []fake.ToolCall{call("decode_value", `{"kind":"filetime","value":"0"}`)}},
		fake.Step{Err: &provider.Error{Code: ai.CodeBadRequest, Message: "bad request", Status: 400}})
	id := h.newChat()
	h.send(id, "x")
	h.wait(id)
	c := h.chat(id)
	if len(c.Messages) < 3 {
		t.Fatalf("user message and completed steps not persisted: %d", len(c.Messages))
	}
	if d := h.done(); d.Status != ai.RunFailed {
		t.Fatalf("%+v", d)
	}
	if h.rec.count(ai.EventError) != 1 {
		t.Fatal("no ai:error")
	}
}

func TestGoldenCancelStream(t *testing.T) {
	h := newHarness(t, "read", false)
	h.prov.Push(fake.Step{Text: "Hello world, this is long", Block: true})
	id := h.newChat()
	h.send(id, "hi")
	<-h.prov.Started
	time.Sleep(10 * time.Millisecond)
	start := time.Now()
	if err := h.m.Stop(id); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 50*time.Millisecond {
		t.Fatal("StopRun blocked")
	}
	h.wait(id)
	if time.Since(start) > 2*time.Second {
		t.Fatal("ai:done later than 2 s")
	}
	c := h.chat(id)
	last := c.Messages[len(c.Messages)-1]
	if !last.Partial || last.StopReason != ai.StopCancelled || !strings.HasPrefix("Hello world, this is long", last.Blocks[0].Text) {
		t.Fatalf("partial %+v", last)
	}
	checkSeq(t, h.rec)
	h.golden("cancel_stream")
	// The next run succeeds.
	h.prov.Push(fake.Step{Text: "fine"})
	h.send(id, "again")
	h.wait(id)
	if h.done().Status != ai.RunCompleted {
		t.Fatal("next run failed")
	}
}

func TestCancelDuringReadGetsSyntheticResults(t *testing.T) {
	h := newHarness(t, "read", false)
	block := make(chan struct{})
	var once sync.Once
	h.ad.SearchHook = func(p models.SearchParams) error {
		once.Do(func() { close(block) })
		time.Sleep(200 * time.Millisecond)
		return nil
	}
	h.prov.Push(fake.Step{Calls: []fake.ToolCall{call("get_entry", `{"dn":"`+anna+`"}`)}})
	id := h.newChat()
	h.send(id, "x")
	<-block
	_ = h.m.Stop(id)
	h.wait(id)
	if h.done().Status != ai.RunCancelled {
		t.Fatalf("%+v", h.done())
	}
	// History stays valid: every tool_use has a result after normalization.
	norm := contextmgr.Normalize(h.chat(id).Messages, contextmgr.NormalizeOptions{})
	if norm.Repairs != 0 {
		t.Fatalf("persisted history needs %d repairs", norm.Repairs)
	}
}

func TestInvalidIDAndTooLarge(t *testing.T) {
	h := newHarness(t, "read", false)
	if _, err := h.m.Send(ai.SendRequest{ChatID: "../connections", Text: "x"}); err == nil || err.(*Error).Code != ai.CodeInvalidChatID {
		t.Fatalf("%v", err)
	}
	id := h.newChat()
	_, err := h.m.Send(ai.SendRequest{ChatID: id, Text: strings.Repeat("x", MaxMessageBytes+1)})
	if err == nil || err.(*Error).Code != ai.CodeMessageTooLarge {
		t.Fatalf("%v", err)
	}
}

func TestConcurrentChatsAndBusy(t *testing.T) {
	h := newHarness(t, "read", false)
	release := make(chan struct{})
	// Chat A blocks; chat B must still complete.
	h.prov.Push(fake.Step{Text: "slow", OnRequest: func(*provider.Request) { <-release }})
	a := h.newChat()
	h.send(a, "slow one")
	<-h.prov.Started
	h.prov.Push(fake.Step{Text: "fast"})
	b := h.newChat()
	h.send(b, "fast one")
	h.wait(b)
	if !h.m.Running(a) {
		t.Fatal("A finished early")
	}
	if _, err := h.m.Send(ai.SendRequest{ChatID: a, Text: "again"}); err == nil || err.(*Error).Code != ai.CodeRunActive {
		t.Fatalf("run_active: %v", err)
	}
	// Fill up to 4 runs, the 5th is busy.
	var blocked []string
	for i := 0; i < 3; i++ {
		h.prov.Push(fake.Step{Text: "x", OnRequest: func(*provider.Request) { <-release }})
		c := h.newChat()
		h.send(c, "block")
		blocked = append(blocked, c)
	}
	e := h.newChat()
	if _, err := h.m.Send(ai.SendRequest{ChatID: e, Text: "fifth"}); err == nil || err.(*Error).Code != ai.CodeBusy {
		t.Fatalf("busy: %v", err)
	}
	close(release)
	h.wait(a)
	for _, c := range blocked {
		h.wait(c)
	}
}

func TestDeleteDuringRunNoResurrection(t *testing.T) {
	h := newHarness(t, "read", false)
	h.prov.Push(fake.Step{Text: "Hello", Block: true})
	id := h.newChat()
	h.send(id, "x")
	<-h.prov.Started
	if err := h.m.DeleteChat(id); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.Get(id); err == nil {
		t.Fatal("chat resurrected")
	}
}

func TestRenameDuringRunKept(t *testing.T) {
	h := newHarness(t, "read", false)
	release := make(chan struct{})
	h.prov.Push(fake.Step{Text: "answer", OnRequest: func(*provider.Request) { <-release }})
	id := h.newChat()
	h.send(id, "x")
	<-h.prov.Started
	if err := h.store.Rename(id, "My title"); err != nil {
		t.Fatal(err)
	}
	close(release)
	h.wait(id)
	if c := h.chat(id); c.Title != "My title" {
		t.Fatalf("title overwritten: %q", c.Title)
	}
}

func TestRepetitionGuard(t *testing.T) {
	h := newHarness(t, "read", false)
	args := `{"dn":"` + anna + `","attributes":["cn"]}`
	h.prov.Push(fake.Step{Calls: []fake.ToolCall{call("get_entry", args), call("get_entry", args)}},
		fake.Step{Calls: []fake.ToolCall{call("get_entry", args)}},
		fake.Step{Calls: []fake.ToolCall{call("get_entry", args)}},
		fake.Step{Text: "done"})
	id := h.newChat()
	h.send(id, "x")
	h.wait(id)
	n := 0
	for _, op := range h.ad.Recorded() {
		if op.Op == "search" && op.DN == anna {
			n++
		}
	}
	if n != 2 {
		t.Fatalf("expected 2 executions (same-step dedupe + third call cached), got %d", n)
	}
	found := false
	for _, m := range h.chat(id).Messages {
		for _, b := range m.Blocks {
			if strings.Contains(b.Content, "You already made this exact call twice") {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("no repetition note")
	}
}

func TestStepCapHardLimit(t *testing.T) {
	h := newHarness(t, "read", false)
	h.cfg.update(func(c *config.AIConfig) { c.MaxSteps = 3 })
	h.prov.Default = &fake.Step{Thinking: "x", Stop: ai.StopMaxTokens} // discarded forever
	id := h.newChat()
	h.send(id, "x")
	h.wait(id)
	if n := len(h.prov.Requests); n > 3+4 {
		t.Fatalf("calls %d exceed MaxSteps+4", n)
	}
}

func TestContextTooSmallRefused(t *testing.T) {
	h := newHarness(t, "read", false)
	h.prov.Caps.ContextWindow = 4096
	h.prov.Caps.Thinking = ai.CapYes
	id := h.newChat()
	h.send(id, "x")
	h.wait(id)
	errs := h.rec.find(ai.EventError)
	if len(errs) != 1 || errs[0].(*ai.ErrorEvent).Code != ai.CodeContextTooSmall {
		t.Fatalf("errors %+v", errs)
	}
	if len(h.prov.Requests) != 0 {
		t.Fatal("request sent despite context_too_small")
	}
}

func TestGetRunStateSnapshot(t *testing.T) {
	h := newHarness(t, "read", false)
	h.prov.Push(fake.Step{Text: "Hello world", Block: true})
	id := h.newChat()
	h.send(id, "x")
	<-h.prov.Started
	time.Sleep(20 * time.Millisecond)
	snap, err := h.m.RunState(id)
	if err != nil || snap == nil {
		t.Fatal(snap, err)
	}
	if snap.LastSeq < 2 || snap.Partial == nil || snap.BaseMessageID != "" && len(snap.Messages) == 0 {
		t.Fatalf("snapshot %+v", snap)
	}
	_ = h.m.Stop(id)
	h.wait(id)
	if s, _ := h.m.RunState(id); s != nil {
		t.Fatal("snapshot after done")
	}
}

func TestOutcomeUnknownRecovery(t *testing.T) {
	h := newHarness(t, "write", true)
	id := h.newChat()
	tu := ai.Block{Type: ai.BlockToolUse, ID: "00000000-0000-4000-8000-0000000000aa", Name: "modify_entry", Input: json.RawMessage(`{"dn":"` + anna + `"}`),
		Meta: &ai.BlockMeta{Executing: true, ConnectionID: adID, Kind: "write"}}
	err := h.store.Update(id, func(c *chatstore.Chat) error {
		c.Messages = append(c.Messages, ai.Message{ID: "u1", Role: ai.RoleUser, Blocks: []ai.Block{{Type: ai.BlockText, Text: "change it"}}},
			ai.Message{ID: "a1", Role: ai.RoleAssistant, Blocks: []ai.Block{tu}})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// normalizeHistory alone repairs it.
	norm := contextmgr.Normalize(h.chat(id).Messages, contextmgr.NormalizeOptions{})
	if !strings.Contains(norm.Messages[len(norm.Messages)-1].Blocks[0].Content, "OUTCOME_UNKNOWN") {
		t.Fatal("normalize did not repair")
	}
	if n := h.m.Recover(); n != 1 {
		t.Fatalf("recovered %d", n)
	}
	c := h.chat(id)
	if len(c.Messages) != 3 || !strings.Contains(c.Messages[2].Blocks[0].Content, "OUTCOME_UNKNOWN") || !strings.Contains(c.Messages[2].Blocks[0].Content, anna) {
		t.Fatalf("recovery %+v", c.Messages)
	}
	if c.Messages[1].Blocks[0].Meta.Executing {
		t.Fatal("Executing not cleared")
	}
	if c.Summary().PendingWrite {
		t.Fatal("PendingWrite not cleared")
	}
	au := h.audit.all()
	if len(au) != 1 || !strings.Contains(au[0], "outcome unknown") {
		t.Fatalf("audit %v", au)
	}
	if n := h.m.Recover(); n != 0 {
		t.Fatal("recovered twice")
	}
}

func TestCompactManual(t *testing.T) {
	h := newHarness(t, "read", false)
	id := h.newChat()
	for i := 0; i < 3; i++ {
		h.prov.Push(fake.Step{Text: fmt.Sprintf("answer %d", i)})
		h.send(id, fmt.Sprintf("question %d", i))
		h.wait(id)
	}
	if _, err := h.m.Compact(id); err != nil {
		t.Fatal(err)
	}
	h.wait(id)
	c := h.chat(id)
	if len(c.Compactions) != 1 || c.Compactions[0].Summary == "" {
		t.Fatalf("compactions %+v", c.Compactions)
	}
	// The next request carries the summary and only the kept turns.
	h.prov.Push(fake.Step{Text: "ok"})
	h.send(id, "next")
	h.wait(id)
	req := h.prov.Requests[len(h.prov.Requests)-1].Req
	if !strings.Contains(req.Messages[0].Blocks[0].Text, "<conversation_summary") {
		t.Fatalf("summary not placed: %+v", req.Messages[0])
	}
	for _, m := range req.Messages {
		for _, b := range m.Blocks {
			if strings.Contains(b.Text, "question 0") {
				t.Fatal("folded turn still sent")
			}
		}
	}
}

// test-1 D4: a /compact with nothing to fold keeps the last real token
// count, so the context meter does not jump to the raw estimate.
func TestNoOpCompactKeepsMeter(t *testing.T) {
	h := newHarness(t, "read", false)
	id := h.newChat()
	h.prov.Push(fake.Step{Text: "answer", Usage: ai.Usage{InputTokens: 4321, OutputTokens: 5}})
	h.send(id, "question")
	h.wait(id)
	before, err := h.m.ContextInfo(id)
	if err != nil || before.LastActualTokens == 0 {
		t.Fatalf("before %+v %v", before, err)
	}
	if _, err := h.m.Compact(id); err != nil {
		t.Fatal(err)
	}
	h.wait(id)
	if c := h.chat(id); len(c.Compactions) != 0 {
		t.Fatalf("compacted %+v", c.Compactions)
	}
	after, _ := h.m.ContextInfo(id)
	if after.LastActualTokens != before.LastActualTokens || after.Percent != before.Percent {
		t.Fatalf("meter moved: %v%% (%d) → %v%% (%d)", before.Percent, before.LastActualTokens, after.Percent, after.LastActualTokens)
	}
}

func TestShutdownCancelsRuns(t *testing.T) {
	h := newHarness(t, "read", false)
	h.prov.Push(fake.Step{Text: "x", Block: true})
	id := h.newChat()
	h.send(id, "x")
	<-h.prov.Started
	start := time.Now()
	h.m.Shutdown()
	if time.Since(start) > 2500*time.Millisecond {
		t.Fatal("shutdown too slow")
	}
	if h.m.Running(id) {
		t.Fatal("run still active")
	}
}
