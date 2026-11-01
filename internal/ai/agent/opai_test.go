package agent

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/aitest/fake"
	"github.com/dpicillo/LDAPilot/internal/ai/provider"
	"github.com/dpicillo/LDAPilot/internal/config"
)

// hangingProvider is an endpoint that does not answer: ModelCaps waits
// until the run's context ends (a dial into a firewall, ~10–15 s in the lab).
type hangingProvider struct {
	*fake.ScriptedProvider
	entered chan struct{}
}

func (p *hangingProvider) ModelCaps(ctx context.Context, model string) (provider.Caps, error) {
	select {
	case p.entered <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return provider.Caps{}, ctx.Err()
}

// UX P4 (A-19): the run is announced before the provider is contacted, so
// the chat shows Stop and Esc works while the endpoint does not answer; a
// Stop then ends the run as cancelled, without an error card.
func TestRunAnnouncedBeforeProviderContact(t *testing.T) {
	h := newHarness(t, "read", false)
	hp := &hangingProvider{ScriptedProvider: h.prov, entered: make(chan struct{}, 1)}
	h.m.d.Providers = ProviderFunc(func(config.AIConfig) (provider.Provider, error) { return hp, nil })
	id := h.newChat()
	h.send(id, "How many users are there?")
	select {
	case <-hp.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the provider was never contacted")
	}
	if n := h.rec.count(ai.EventRunStarted); n != 1 {
		t.Fatalf("ai:run_started while the provider is contacted: %d; events:\n%s", n, strings.Join(h.rec.all(), "\n"))
	}
	started := h.rec.find(ai.EventRunStarted)[0].(*ai.RunStartedEvent)
	if started.Model != "fake-model" || started.Provider != "ollama" {
		t.Fatalf("run_started names %q / %q", started.Provider, started.Model)
	}
	if err := h.m.Stop(id); err != nil {
		t.Fatal(err)
	}
	h.wait(id)
	if d := h.done(); d.Status != ai.RunCancelled {
		t.Fatalf("status %q", d.Status)
	}
	if n := h.rec.count(ai.EventError); n != 0 {
		t.Fatalf("a stopped setup shows an error card: %v", h.rec.find(ai.EventError))
	}
	checkSeq(t, h.rec)
}

// A provider that fails during setup still gets run_started first, then the
// error and done (the order the reducer needs).
func TestSetupFailureAfterAnnouncement(t *testing.T) {
	h := newHarness(t, "read", false)
	h.prov.CapsErr = &provider.Error{Code: ai.CodeProviderUnreachable, Message: "No connection to localhost:11999"}
	id := h.newChat()
	h.send(id, "Hello")
	h.wait(id)
	names := h.rec.all()
	iStart, iErr, iDone := -1, -1, -1
	for i, n := range names {
		switch {
		case strings.HasPrefix(n, ai.EventRunStarted) && iStart < 0:
			iStart = i
		case strings.HasPrefix(n, ai.EventError) && iErr < 0:
			iErr = i
		case strings.HasPrefix(n, ai.EventDone) && iDone < 0:
			iDone = i
		}
	}
	if iStart < 0 || iErr < iStart || iDone < iErr {
		t.Fatalf("order run_started %d, error %d, done %d:\n%s", iStart, iErr, iDone, strings.Join(names, "\n"))
	}
	if d := h.done(); d.Status != ai.RunFailed {
		t.Fatalf("status %q", d.Status)
	}
}

// The model the run really uses is named on message_started when discovery
// replaced the configured one after ai:run_started.
func TestMessageStartedNamesDiscoveredModel(t *testing.T) {
	h := newHarness(t, "read", false)
	h.cfg.update(func(c *config.AIConfig) { c.Model = "" })
	h.prov.Model = "found-model"
	id := h.newChat()
	h.send(id, "Hello")
	h.wait(id)
	st := h.rec.find(ai.EventRunStarted)[0].(*ai.RunStartedEvent)
	ms := h.rec.find(ai.EventMessageStarted)
	if len(ms) == 0 {
		t.Fatal("no message_started")
	}
	if got := ms[0].(*ai.MessageStartedEvent).Model; st.Model != "" || got != "found-model" {
		t.Fatalf("run_started model %q, message_started model %q", st.Model, got)
	}
}

// UX area A (S4, stale titles): the title prompt asks for the topic, not
// the outcome, and the title is written again from all requests at the
// third message.
func TestTitleInput(t *testing.T) {
	msg := func(role ai.Role, text string) ai.Message {
		return ai.Message{Role: role, Blocks: []ai.Block{{Type: ai.BlockText, Text: text}}}
	}
	hist := []ai.Message{msg(ai.RoleUser, "Create user Max in OU Sales"), msg(ai.RoleAssistant, "Created."),
		msg(ai.RoleUser, "Add him to group Sales"), msg(ai.RoleAssistant, "Added."),
		msg(ai.RoleUser, "Disable the account\nof Anna"), msg(ai.RoleAssistant, "Disabled.")}
	first := titleInput(hist[:2], "Created.", false)
	if first != "User: Create user Max in OU Sales\nAssistant: Created." {
		t.Fatalf("first title input %q", first)
	}
	all := titleInput(hist, "Disabled.", true)
	for _, want := range []string{"User requests:", "- Create user Max in OU Sales", "- Add him to group Sales", "- Disable the account of Anna"} {
		if !strings.Contains(all, want) {
			t.Fatalf("retitle input lacks %q: %q", want, all)
		}
	}
	if strings.Contains(all, "Disabled.") {
		t.Fatalf("retitle input contains an answer: %q", all)
	}
	if !strings.Contains(titlePrompt, "not its outcome") {
		t.Fatalf("title prompt: %q", titlePrompt)
	}
}

func TestRetitleAtThirdMessage(t *testing.T) {
	h := newHarness(t, "read", false)
	h.cfg.update(func(c *config.AIConfig) { c.DisableTitleGeneration = false })
	h.prov.SummaryText = "User management in Sales"
	id := h.newChat()
	titleReqs := func() []string {
		var out []string
		for _, r := range h.prov.RequestsSnapshot() {
			if r.ToolLess && r.Req.System == titlePrompt {
				if r.Req.Thinking != "off" {
					t.Errorf("title request with thinking %q", r.Req.Thinking)
				}
				out = append(out, r.Body)
			}
		}
		return out
	}
	waitTitle := func(n int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			got := len(titleReqs())
			if got >= n && h.chat(id).TitleSource == "llm" {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("title requests %d, want %d (source %q)", got, n, h.chat(id).TitleSource)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	for i, text := range []string{"Create user Max", "Add him to Sales", "Disable Anna"} {
		h.send(id, text)
		h.wait(id)
		if i == 0 {
			waitTitle(1)
		}
	}
	waitTitle(2)
	h.m.wg.Wait()
	reqs := titleReqs()
	if len(reqs) != 2 || !strings.Contains(reqs[1], "User requests:") || !strings.Contains(reqs[1], "Disable Anna") {
		t.Fatalf("title requests %d: %v", len(reqs), reqs)
	}
	if c := h.chat(id); c.Title != "User management in Sales" {
		t.Fatalf("title %q", c.Title)
	}
}
