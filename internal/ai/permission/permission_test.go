package permission

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/aitest"
	"github.com/dpicillo/LDAPilot/internal/config"
)

func TestClassify(t *testing.T) {
	cases := []struct {
		cfg    config.AIConfig
		remote bool
		local  bool
	}{
		{config.AIConfig{Provider: "ollama", URL: "http://localhost:11434"}, false, true},
		{config.AIConfig{Provider: "ollama", URL: "http://127.0.0.1:11434"}, true, false}, // cloud model
		{config.AIConfig{Provider: "openai", Flavor: "ollama", URL: "http://[::1]:11434/v1"}, false, true},
		{config.AIConfig{Provider: "ollama", URL: "http://myhost:11434"}, false, false}, // name aliased to loopback counts as remote
		{config.AIConfig{Provider: "openai", Flavor: "litellm", URL: "http://localhost:4000"}, false, false},
		{config.AIConfig{Provider: "openai", Flavor: "litellm", URL: "http://localhost:4000", EndpointLocal: true}, false, true},
		{config.AIConfig{Provider: "openai", Flavor: "openai", URL: "https://api.openai.com/v1"}, false, false},
		{config.AIConfig{Provider: "anthropic", URL: "https://api.anthropic.com"}, false, false},
		{config.AIConfig{Engine: "claudecode"}, false, false},
	}
	for i, tc := range cases {
		d := Classify(tc.cfg, tc.remote)
		if d.Local != tc.local || d.Remote == d.Local {
			t.Errorf("case %d: %+v", i, d)
		}
	}
}

func TestLevelMatrix(t *testing.T) {
	local := Destination{Host: "localhost", Local: true}
	remote := Destination{Host: "api.openai.com", Remote: true}
	p := FromConfig(config.AIConfig{DefaultAccess: "ask", ConnectionAccess: map[string]config.AccessEntry{
		"r": {Level: "read"}, "w": {Level: "write"}, "n": {Level: "none"}, "rh": {Level: "read", Hosts: []string{"api.openai.com"}}}})
	for _, tc := range []struct {
		id   string
		d    Destination
		want string
	}{
		{"r", local, "read"}, {"w", local, "write"}, {"n", local, "none"}, {"x", local, "ask"},
		{"r", remote, "ask"}, {"w", remote, "ask"}, {"rh", remote, "read"}, {"n", remote, "none"},
	} {
		if got := p.Level(tc.id, tc.d); got != tc.want {
			t.Errorf("%s @%s = %s, want %s", tc.id, tc.d.Host, got, tc.want)
		}
	}
}

func TestLiveStricterAndWriteGate(t *testing.T) {
	cur := FromConfig(config.AIConfig{AllowWrites: true, ConnectionAccess: map[string]config.AccessEntry{"p": {Level: "write"}}})
	l := &Live{Start: cur, Current: func() *Policy { return cur }, Dest: Destination{Host: "localhost", Local: true}}
	if code, _ := l.WriteGate("p", false); code != "" {
		t.Fatal(code)
	}
	if code, _ := l.WriteGate("p", true); code != "READ_ONLY_PROFILE" {
		t.Fatal(code)
	}
	// Tightening applies at once.
	cur = FromConfig(config.AIConfig{AllowWrites: false, ConnectionAccess: map[string]config.AccessEntry{"p": {Level: "write"}}})
	if code, _ := l.WriteGate("p", false); code != "WRITES_DISABLED" {
		t.Fatal(code)
	}
	cur = FromConfig(config.AIConfig{AllowWrites: true, ConnectionAccess: map[string]config.AccessEntry{"p": {Level: "read"}}})
	if code, _ := l.WriteGate("p", false); code != "ACCESS_DENIED_BY_POLICY" {
		t.Fatal(code)
	}
	// Loosening does not apply to the running run.
	l2 := &Live{Start: FromConfig(config.AIConfig{ConnectionAccess: map[string]config.AccessEntry{"p": {Level: "read"}}}),
		Current: func() *Policy {
			return FromConfig(config.AIConfig{AllowWrites: true, ConnectionAccess: map[string]config.AccessEntry{"p": {Level: "write"}}, RedactAttributes: []string{"x"}})
		}, Dest: Destination{Local: true}}
	if l2.Level("p") != "read" || l2.AllowWrites() || len(l2.Redact()) != 1 {
		t.Fatal("loosening applied mid-run, or redaction entry not added")
	}
}

func TestAllowedDecisions(t *testing.T) {
	if got := AllowedDecisions(ai.ApprovalWrite, true, true); len(got) != 3 || got[0] != ai.DecisionApproveConfirmed {
		t.Fatal(got)
	}
	if got := AllowedDecisions(ai.ApprovalWrite, false, false); len(got) != 3 || got[0] != ai.DecisionApprove {
		t.Fatal(got)
	}
	if got := AllowedDecisions(ai.ApprovalWrite, false, true); len(got) != 4 {
		t.Fatal(got)
	}
	if got := AllowedDecisions(ai.ApprovalAccess, false, false); got[1] != ai.DecisionApproveAlways {
		t.Fatal(got)
	}
}

type recEmit struct {
	mu    sync.Mutex
	names []string
}

func (r *recEmit) emit(name string, p ai.Enveloped) {
	r.mu.Lock()
	r.names = append(r.names, name)
	r.mu.Unlock()
}

// TestApproveVsStopRace fires the user's answer and the cancellation at
// the same time: exactly one wins and a late answer is already_resolved.
func TestApproveVsStopRace(t *testing.T) {
	for i := 0; i < 200; i++ {
		b := NewBroker(aitest.NewFakeClock(), &aitest.SeqIDs{})
		ctx, cancel := context.WithCancel(context.Background())
		r := &recEmit{}
		req := ai.ApprovalRequest{ApprovalID: "a1", ToolCallID: "t1", Kind: ai.ApprovalWrite, AllowedDecisions: AllowedDecisions(ai.ApprovalWrite, false, false)}
		out := make(chan Outcome, 1)
		go func() { out <- b.Ask(ctx, req, AskOptions{RunID: "run", ChatID: "c", Emit: r.emit}) }()
		for b.Count() == 0 {
			time.Sleep(time.Microsecond)
		}
		var wg sync.WaitGroup
		var res ai.ApprovalResult
		wg.Add(2)
		go func() { defer wg.Done(); res, _ = b.Respond("a1", ai.DecisionApprove, "") }()
		go func() { defer wg.Done(); cancel(); b.CancelRun("run") }()
		wg.Wait()
		o := <-out
		if o.Approved() != (res.Status == "applied") {
			t.Fatalf("iteration %d: outcome %+v, respond %+v", i, o, res)
		}
		late, err := b.Respond("a1", ai.DecisionDeny, "")
		if err != nil || late.Status != "already_resolved" {
			t.Fatalf("late answer %+v %v", late, err)
		}
		n := 0
		for _, name := range r.names {
			if name == ai.EventApprovalResolved {
				n++
			}
		}
		if n != 1 {
			t.Fatalf("resolved %d times", n)
		}
	}
}

func TestDecisionOutsideAllowedRejected(t *testing.T) {
	b := NewBroker(aitest.NewFakeClock(), &aitest.SeqIDs{})
	req := ai.ApprovalRequest{ApprovalID: "a1", AllowedDecisions: AllowedDecisions(ai.ApprovalWrite, true, false)}
	go b.Ask(context.Background(), req, AskOptions{})
	for b.Count() == 0 {
		time.Sleep(time.Microsecond)
	}
	if _, err := b.Respond("a1", ai.DecisionApprove, ""); err == nil {
		t.Fatal("plain approve accepted with RequireConfirm")
	}
	if _, err := b.Respond("a1", ai.DecisionApproveChat, ""); err == nil {
		t.Fatal("approve_chat accepted")
	}
	if b.Count() != 1 {
		t.Fatal("rejected decision changed the state")
	}
	if _, err := b.Respond("nope", ai.DecisionDeny, ""); err == nil {
		t.Fatal("unknown approval accepted")
	}
	r, err := b.Respond("a1", ai.DecisionDenyRemaining, "x")
	if err != nil || r.Decision != ai.ResolvedDenied {
		t.Fatal(r, err)
	}
}

func TestGrants(t *testing.T) {
	clock := aitest.NewFakeClock()
	g := NewGrants(clock, &aitest.SeqIDs{})
	var events int
	g.OnChange(func(string, []ai.Grant) { events++ })
	scope := ai.GrantScope{Tool: "modify_entry", ProfileID: "p", Subtree: "OU=Users,DC=x", Attributes: []string{"description", "telephonenumber"}}
	g.Add("chat", "Lab", scope)
	m := MatchRequest{Tool: "modify_entry", ProfileID: "p", TargetDN: "CN=A,OU=Users,DC=x", Attributes: []string{"description"}}
	if _, ok := g.Match("chat", m); !ok {
		t.Fatal("covered write not matched")
	}
	for _, bad := range []MatchRequest{
		{Tool: "modify_entry", ProfileID: "p", TargetDN: "CN=A,OU=Admins,DC=x", Attributes: []string{"description"}},
		{Tool: "modify_entry", ProfileID: "p", TargetDN: "CN=A,OU=Users,DC=x", Attributes: []string{"mail"}},
		{Tool: "create_entry", ProfileID: "p", TargetDN: "CN=A,OU=Users,DC=x"},
		{Tool: "modify_entry", ProfileID: "q", TargetDN: "CN=A,OU=Users,DC=x", Attributes: []string{"description"}},
		{Tool: "modify_entry", ProfileID: "p", TargetDN: "OU=Users,DC=x", Attributes: []string{"description"}}, // the parent itself
	} {
		if _, ok := g.Match("chat", bad); ok {
			t.Errorf("out of scope matched: %+v", bad)
		}
	}
	for i := 0; i < 9; i++ {
		if _, ok := g.Match("chat", m); !ok {
			t.Fatalf("use %d", i+2)
		}
	}
	if _, ok := g.Match("chat", m); ok {
		t.Fatal("11th use matched")
	}
	g.Add("chat", "Lab", scope)
	clock.Advance(31 * time.Minute)
	if _, ok := g.Match("chat", m); ok {
		t.Fatal("expired grant matched")
	}
	gr := g.Add("chat", "Lab", scope)
	if err := g.Revoke("chat", gr.ID); err != nil || len(g.List("chat")) != 0 {
		t.Fatal("revoke")
	}
	if events < 4 {
		t.Fatalf("grants_updated events %d", events)
	}
}

func TestSharedAccessRequestAndTimeout(t *testing.T) {
	clock := aitest.NewFakeClock()
	b := NewBroker(clock, &aitest.SeqIDs{})
	r := &recEmit{}
	req := ai.ApprovalRequest{Kind: ai.ApprovalAccess, AllowedDecisions: AllowedDecisions(ai.ApprovalAccess, false, false)}
	outs := make(chan Outcome, 3)
	for i := 0; i < 3; i++ {
		go func() {
			outs <- b.Ask(context.Background(), req, AskOptions{ChatID: "c", Emit: r.emit, SharedKey: "c|p"})
		}()
	}
	clock.WaitForTimers(t, 3)
	if b.Count() != 1 {
		t.Fatalf("pending %d", b.Count())
	}
	clock.Advance(ApprovalTimeout + time.Second)
	for i := 0; i < 3; i++ {
		if o := <-outs; o.Decision != ai.ResolvedTimeout {
			t.Fatalf("%+v", o)
		}
	}
}

func TestRecheckPolicyDenied(t *testing.T) {
	b := NewBroker(aitest.NewFakeClock(), &aitest.SeqIDs{})
	allowed := true
	var mu sync.Mutex
	out := make(chan Outcome, 1)
	go func() {
		out <- b.Ask(context.Background(), ai.ApprovalRequest{AllowedDecisions: []string{"approve"}}, AskOptions{Recheck: func() (string, string) {
			mu.Lock()
			defer mu.Unlock()
			if allowed {
				return "", ""
			}
			return "WRITES_DISABLED", "off"
		}})
	}()
	for b.Count() == 0 {
		time.Sleep(time.Microsecond)
	}
	b.Recheck()
	if b.Count() != 1 {
		t.Fatal("resolved while still permitted")
	}
	mu.Lock()
	allowed = false
	mu.Unlock()
	b.Recheck()
	if o := <-out; o.Decision != ai.ResolvedPolicyDenied || o.Code != "WRITES_DISABLED" {
		t.Fatalf("%+v", o)
	}
}

// A host allowed to read only (ReadHosts) gets read although the level is
// write; writes for a remote host need it in Hosts.
func TestReadHostsCapAtRead(t *testing.T) {
	p := FromConfig(config.AIConfig{ConnectionAccess: map[string]config.AccessEntry{
		"p": {Level: LevelWrite, Hosts: []string{"api.anthropic.com"}, ReadHosts: []string{"api.openai.com"}}}})
	for host, want := range map[string]string{"api.anthropic.com": LevelWrite, "api.openai.com": LevelRead, "other.example": LevelAsk} {
		if got := p.Level("p", Destination{Host: host, Remote: true}); got != want {
			t.Errorf("%s: %s, want %s", host, got, want)
		}
	}
	if got := p.Level("p", Destination{Host: "localhost", Local: true}); got != LevelWrite {
		t.Errorf("local: %s", got)
	}
	if p.Configured("p") != LevelWrite || p.Configured("x") != LevelAsk {
		t.Error("configured")
	}
}
