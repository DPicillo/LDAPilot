package agent

import (
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/aitest/fake"
	"github.com/dpicillo/LDAPilot/internal/ai/provider"
)

// UX A-08: the "directory data sent" ledger is readable while the run is
// still going, right after the first tool result.
func TestEgressIsLiveDuringRun(t *testing.T) {
	h := newHarness(t, "read", false)
	release := make(chan struct{})
	h.prov.Push(fake.Step{Calls: []fake.ToolCall{call("get_entry", `{"dn":"`+anna+`","attributes":["cn"]}`)}},
		fake.Step{Text: "Done.", OnRequest: func(*provider.Request) { <-release }})
	id := h.newChat()
	if eg, err := h.m.Egress(id); err != nil || len(eg) != 0 {
		t.Fatalf("before: %v %v", eg, err)
	}
	h.send(id, "Who is Anna?")
	h.waitEvent(ai.EventToolEnd, 1)
	eg, err := h.m.Egress(id)
	if err != nil || len(eg) != 1 || eg[0].ProfileID != adID || eg[0].ToolResults != 1 || eg[0].Bytes == 0 {
		t.Fatalf("live: %+v %v", eg, err)
	}
	close(release)
	h.wait(id)
	stored, err := h.m.Egress(id)
	if err != nil || len(stored) != 1 || stored[0].ToolResults != 1 {
		t.Fatalf("stored: %+v %v", stored, err)
	}
	if _, err := h.m.Egress("not-a-chat"); err == nil {
		t.Fatal("invalid chat ID accepted")
	}
}

// UX A-13: a password in the message never reaches the history, the title
// or the provider.
func TestSendMasksPasswords(t *testing.T) {
	h := newHarness(t, "read", false)
	h.prov.Push(fake.Step{Text: "I will use reset_password."}, fake.Step{Text: "ok"})
	id := h.newChat()
	h.send(id, "Set the password of anna to Passw0rd!2026")
	h.wait(id)
	c := h.chat(id)
	for _, m := range c.Messages {
		for _, b := range m.Blocks {
			if strings.Contains(b.Text, "Passw0rd") {
				t.Fatalf("stored: %q", b.Text)
			}
		}
	}
	if strings.Contains(c.Title, "Passw0rd") {
		t.Fatalf("title: %q", c.Title)
	}
	for _, body := range h.prov.Bodies() {
		if strings.Contains(body, "Passw0rd") {
			t.Fatal("the provider received the password")
		}
	}
	if !strings.Contains(c.Messages[0].Blocks[len(c.Messages[0].Blocks)-1].Text, ai.PasswordPlaceholder) {
		t.Fatalf("placeholder missing: %+v", c.Messages[0].Blocks)
	}
	// Edit and resend masks too.
	if _, err := h.m.EditLast(id, "Kennwort auf Sommer2026! setzen", ai.UIContext{ActiveProfileID: adID}); err != nil {
		t.Fatal(err)
	}
	h.wait(id)
	for _, m := range h.chat(id).Messages {
		for _, b := range m.Blocks {
			if strings.Contains(b.Text, "Sommer2026") {
				t.Fatalf("edit stored: %q", b.Text)
			}
		}
	}
}

// UX A-19: an endpoint that cannot be reached fails the run with that
// error, not with a guessed 8k window ("context window too small").
func TestUnreachableProviderIsReported(t *testing.T) {
	h := newHarness(t, "read", false)
	h.prov.CapsErr = &provider.Error{Code: ai.CodeProviderUnreachable, Retryable: true, Message: "Nothing is listening at localhost:11999 (connection refused)."}
	id := h.newChat()
	h.send(id, "hello")
	h.wait(id)
	errs := h.rec.find(ai.EventError)
	if len(errs) != 1 {
		t.Fatalf("errors: %d", len(errs))
	}
	e := errs[0].(*ai.ErrorEvent)
	if e.Code != ai.CodeProviderUnreachable || !strings.Contains(e.Message, "connection refused") {
		t.Fatalf("%+v", e)
	}
	msgs := h.chat(id).Messages
	if last := msgs[len(msgs)-1]; last.Error == nil || last.Error.Code != ai.CodeProviderUnreachable {
		t.Fatalf("not persisted: %+v", last)
	}
	if len(h.prov.Bodies()) != 0 {
		t.Fatal("a chat request was sent")
	}
}
