package agent

import (
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/aitest/fake"
)

func TestExtractDNs(t *testing.T) {
	for _, tc := range []struct {
		text string
		want []string
		cut  bool
	}{
		{"Set the description of CN=ai.uiacct.2051,OU=Users,DC=corp,DC=test to 'x'.", []string{"CN=ai.uiacct.2051,OU=Users,DC=corp,DC=test"}, true},
		{"Disable `uid=jdoe,ou=People,dc=demo,dc=local` please", []string{"uid=jdoe,ou=People,dc=demo,dc=local"}, false},
		{"Move CN=Schmidt\\, Anna, OU=Users, DC=corp now", []string{"CN=Schmidt\\, Anna,OU=Users,DC=corp"}, true},
		{"Is 'cn=a,ou=b' or \"cn=c,ou=d\" locked?", []string{"cn=a,ou=b", "cn=c,ou=d"}, false},
		{"Unlock CN=O'Brien\\, Pat,OU=Users,DC=corp!", []string{"CN=O'Brien\\, Pat,OU=Users,DC=corp"}, false},
		{"Search (&(cn=foo)(sn=bar)) and set description=foo", nil, false},
		{"Set it, foo=bar", nil, false},
		{"foo.cn=a,ou=b", nil, false},
	} {
		got := extractDNs(tc.text)
		var texts []string
		for _, c := range got {
			texts = append(texts, c.text)
		}
		if strings.Join(texts, "|") != strings.Join(tc.want, "|") {
			t.Errorf("%q: got %q", tc.text, texts)
			continue
		}
		if len(got) > 0 && got[0].cut != tc.cut {
			t.Errorf("%q: cut %v", tc.text, got[0].cut)
		}
	}
	// A last value cut at a blank may be the start of the real one
	// ("o=Example Corp" typed in prose); an uncut one must match whole RDNs.
	c := extractDNs("set CN=Anna Schmidt,OU=Users,DC=corp,DC=test to x")[0]
	if !c.cut || !c.refersTo("cn=anna schmidt,ou=users,dc=corp,dc=test") || !c.refersTo("cn=anna schmidt,ou=users,dc=corp,dc=test corp") ||
		c.refersTo("cn=anna schmidt,ou=users,dc=corp2,dc=test") {
		t.Errorf("refersTo %+v", c)
	}
	d := extractDNs("`cn=a,ou=b`")[0]
	if !d.refersTo("cn=a,ou=b,dc=x") || d.refersTo("cn=a,ou=bc,dc=x") || d.refersTo("cn=ab,ou=b") {
		t.Errorf("refersTo %+v", d)
	}
}

func TestExtractTokens(t *testing.T) {
	got := extractTokens("Set the description of ai.uiacct.2051 to 'D1 named wins'.", "d1 named wins\n", map[string]bool{"description": true})
	if strings.Join(got, ",") != "ai.uiacct.2051" {
		t.Fatalf("got %q", got)
	}
	got = extractTokens("Bitte setze die Beschreibung von jdoe und PC-0815$ auf 4711", "", nil)
	if strings.Join(got, ",") != "PC-0815$,jdoe" {
		t.Fatalf("got %q", got)
	}
}

func TestLatestUserMessage(t *testing.T) {
	ui := &ai.UIContext{SelectedDN: "cn=x"}
	h := []ai.Message{
		{Role: ai.RoleUser, UIContext: ui, Blocks: []ai.Block{{Type: ai.BlockText, Text: "<ldapilot_context>selected_entry: cn=x</ldapilot_context>", Meta: &ai.BlockMeta{Kind: "context"}},
			{Type: ai.BlockText, Text: "Set the description of jdoe."}}},
		{Role: ai.RoleAssistant, Blocks: []ai.Block{{Type: ai.BlockText, Text: "STEP_LIMIT"}}},
		{Role: ai.RoleUser, Blocks: []ai.Block{{Type: ai.BlockText, Text: ContinueText, Meta: &ai.BlockMeta{Kind: "continue"}}}},
	}
	text, got := latestUserMessage(h)
	if text != "Set the description of jdoe." || got != ui {
		t.Fatalf("%q %+v", text, got)
	}
}

const (
	selUI    = "CN=ai.ui.2051,OU=Users,DC=corp,DC=test"
	namedAcc = "CN=ai.uiacct.2051,OU=Users,DC=corp,DC=test"
)

func targetHarness(t *testing.T) *harness {
	h := newHarness(t, "write", true)
	h.ad.Put(selUI, map[string][]string{"objectClass": {"top", "person", "user"}, "cn": {"ai.ui.2051"}, "sAMAccountName": {"ai.ui.2051"}})
	h.ad.Put(namedAcc, map[string][]string{"objectClass": {"top", "person", "user"}, "cn": {"ai.uiacct.2051"}, "sAMAccountName": {"ai.uiacct.2051"}})
	return h
}

// cardWarnings runs one message whose write targets target with selected
// selected in the UI and returns the warnings of the first card.
func cardWarnings(t *testing.T, h *harness, text, selected, target string, mentions []ai.Mention) []string {
	t.Helper()
	return cardWarningsValue(t, h, text, selected, target, "D1 named wins", mentions)
}

func cardWarningsValue(t *testing.T, h *harness, text, selected, target, value string, mentions []ai.Mention) []string {
	t.Helper()
	h.prov.Push(fake.Step{Calls: []fake.ToolCall{modifyDesc(target, value)}}, fake.Step{Text: "ok"})
	id := h.newChat()
	if _, err := h.m.Send(ai.SendRequest{ChatID: id, Text: text, UI: ai.UIContext{ActiveProfileID: adID, SelectedProfileID: adID, SelectedDN: selected,
		Mentions: mentions, TimeZone: "UTC"}}); err != nil {
		t.Fatal(err)
	}
	n := h.rec.count(ai.EventApprovalRequest)
	h.waitEvent(ai.EventApprovalRequest, n+1)
	req := h.rec.find(ai.EventApprovalRequest)[n].(*ai.ApprovalRequest)
	if _, err := h.m.Respond(req.ApprovalID, ai.DecisionDeny, ""); err != nil {
		t.Fatal(err)
	}
	h.wait(id)
	return req.Preview.Warnings
}

func hasTargetWarning(ws []string) string {
	for _, w := range ws {
		if strings.HasPrefix(w, "This change targets the selected entry") {
			return w
		}
	}
	return ""
}

// 2b defect 1: the card warns when the write targets the selected entry
// but the message names another one (identifier, DN or @mention).
func TestTargetWarningWhenMessageNamesAnotherEntry(t *testing.T) {
	h := targetHarness(t)
	for _, tc := range []struct {
		name, text string
		mentions   []ai.Mention
		names      string
	}{
		{"identifier", "Set the description of ai.uiacct.2051 to 'D1 named wins'.", nil, "ai.uiacct.2051 (" + namedAcc + ")"},
		{"DN", "Set the description of `" + namedAcc + "` to 'D1 named wins'.", nil, namedAcc},
		{"mention", "Set the description of @entry to 'D1 named wins'.", []ai.Mention{{ProfileID: adID, DN: namedAcc}}, namedAcc},
	} {
		w := hasTargetWarning(cardWarnings(t, h, tc.text, selUI, selUI, tc.mentions))
		want := "This change targets the selected entry " + selUI + ", but your message names " + tc.names + " — check before approving."
		if w != want {
			t.Errorf("%s:\n got %q\nwant %q", tc.name, w, want)
		}
	}
}

func TestNoTargetWarning(t *testing.T) {
	h := targetHarness(t)
	for _, tc := range []struct {
		name, text, selected, target string
		mentions                     []ai.Mention
	}{
		{"no name", "Set the description to 'D1 named wins'.", selUI, selUI, nil},
		{"this user", "Set the description of this user to 'D1 named wins'.", selUI, selUI, nil},
		{"name of the target", "Set the description of ai.ui.2051 to 'D1 named wins'.", selUI, selUI, nil},
		{"logon name of the target", "Set the description of anna to 'D1 named wins'.", anna, anna, nil},
		{"DN of the target", "Set the description of CN=ai.ui.2051,OU=Users to 'D1 named wins'.", selUI, selUI, nil},
		{"mention of the target", "Set the description of @entry to 'D1 named wins'.", selUI, selUI, []ai.Mention{{ProfileID: adID, DN: selUI}}},
		{"target and another entry named", "Copy the description of ai.uiacct.2051 to ai.ui.2051.", selUI, selUI, nil},
		{"named entry is the target", "Set the description of ai.uiacct.2051 to 'D1 named wins'.", selUI, namedAcc, nil},
		{"unknown identifier", "Set the description of this user to 'D1 named wins' as in ticket INC-4711.", selUI, selUI, nil},
	} {
		if w := hasTargetWarning(cardWarnings(t, h, tc.text, tc.selected, tc.target, tc.mentions)); w != "" {
			t.Errorf("%s: unexpected %q", tc.name, w)
		}
	}
	// An identifier that is the value being written is not an entry reference.
	if w := hasTargetWarning(cardWarningsValue(t, h, "Set the description of this user to ai.uiacct.2051.", selUI, selUI, "ai.uiacct.2051", nil)); w != "" {
		t.Errorf("value: unexpected %q", w)
	}
	// Without a selection conflict no lookup is sent to the directory.
	before := len(h.ad.Recorded())
	cardWarnings(t, h, "Set the description of ai.uiacct.2051 to 'D1 named wins'.", selUI, namedAcc, nil)
	for _, op := range h.ad.Recorded()[before:] {
		if op.Op == "search" && strings.Contains(op.Filter, "sAMAccountName=") {
			t.Fatalf("lookup without a selection conflict: %+v", op)
		}
	}
}

// A chat grant never auto-approves a write that carries the warning.
func TestTargetWarningSuspendsGrant(t *testing.T) {
	h := targetHarness(t)
	bob := "CN=Bob,OU=Users,DC=corp,DC=test"
	h.ad.Put(bob, map[string][]string{"objectClass": {"user"}, "cn": {"Bob"}})
	h.prov.Push(fake.Step{Calls: []fake.ToolCall{modifyDesc(bob, "A")}}, fake.Step{Calls: []fake.ToolCall{modifyDesc(selUI, "B")}}, fake.Step{Text: "ok"})
	id := h.newChat()
	if _, err := h.m.Send(ai.SendRequest{ChatID: id, Text: "Set the description of Bob to A and of ai.uiacct.2051 to B.",
		UI: ai.UIContext{ActiveProfileID: adID, SelectedProfileID: adID, SelectedDN: selUI, TimeZone: "UTC"}}); err != nil {
		t.Fatal(err)
	}
	h.waitEvent(ai.EventApprovalRequest, 1)
	first := h.rec.find(ai.EventApprovalRequest)[0].(*ai.ApprovalRequest)
	if hasTargetWarning(first.Preview.Warnings) != "" || first.Preview.GrantScope == nil {
		t.Fatalf("first card %+v", first.Preview)
	}
	if _, err := h.m.Respond(first.ApprovalID, ai.DecisionApproveChat, ""); err != nil {
		t.Fatal(err)
	}
	h.waitEvent(ai.EventApprovalRequest, 2)
	second := h.rec.find(ai.EventApprovalRequest)[1].(*ai.ApprovalRequest)
	if hasTargetWarning(second.Preview.Warnings) == "" || len(second.AllowedDecisions) == 0 {
		t.Fatalf("second card auto-approved or without warning: %+v %+v", second, second.Preview.Warnings)
	}
	if _, err := h.m.Respond(second.ApprovalID, ai.DecisionDeny, ""); err != nil {
		t.Fatal(err)
	}
	h.wait(id)
	if v := h.ad.Get(selUI); hasValue(v, "description", "B") {
		t.Fatal("selected entry written")
	}
}
