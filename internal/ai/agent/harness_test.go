package agent

import (
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/aitest"
	"github.com/dpicillo/LDAPilot/internal/ai/aitest/fake"
	"github.com/dpicillo/LDAPilot/internal/ai/chatstore"
	"github.com/dpicillo/LDAPilot/internal/ai/ldaptools"
	"github.com/dpicillo/LDAPilot/internal/ai/provider"
	"github.com/dpicillo/LDAPilot/internal/config"
	"github.com/dpicillo/LDAPilot/internal/models"
)

var update = flag.Bool("update", false, "rewrite golden files")

// jsonRecorder marshals every event when it is emitted.
type jsonRecorder struct {
	mu     sync.Mutex
	lines  []string
	names  []string
	values []any
}

func (r *jsonRecorder) Emit(name string, payload any) {
	b, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	r.mu.Lock()
	r.lines = append(r.lines, name+" "+string(b))
	r.names = append(r.names, name)
	r.values = append(r.values, payload)
	r.mu.Unlock()
}

func (r *jsonRecorder) all() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.lines...)
}

func (r *jsonRecorder) count(name string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, x := range r.names {
		if x == name {
			n++
		}
	}
	return n
}

// find returns the payloads of an event name.
func (r *jsonRecorder) find(name string) []any {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []any
	for i, x := range r.names {
		if x == name {
			out = append(out, r.values[i])
		}
	}
	return out
}

type fakeConfig struct {
	mu  sync.Mutex
	cfg config.AIConfig
	m   *Manager
}

func (f *fakeConfig) Current() config.AIConfig {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.cfg
	acc := map[string]config.AccessEntry{}
	for k, v := range f.cfg.ConnectionAccess {
		acc[k] = v
	}
	c.ConnectionAccess = acc
	return c
}

func (f *fakeConfig) SetConnectionAccess(profileID, level, bindHost string) error {
	f.mu.Lock()
	e := f.cfg.ConnectionAccess[profileID]
	e.Level = level
	if bindHost != "" {
		e.Hosts = append(e.Hosts, bindHost)
	}
	f.cfg.ConnectionAccess[profileID] = e
	f.mu.Unlock()
	if f.m != nil {
		f.m.ConfigChanged()
	}
	return nil
}

func (f *fakeConfig) AllowReadHost(profileID, host string) error {
	f.mu.Lock()
	e := f.cfg.ConnectionAccess[profileID]
	switch e.Level {
	case config.AccessWrite:
		e.ReadHosts = append(e.ReadHosts, host)
	case config.AccessRead:
		e.Hosts = append(e.Hosts, host)
	default:
		e.Level, e.Hosts = config.AccessRead, []string{host}
	}
	f.cfg.ConnectionAccess[profileID] = e
	f.mu.Unlock()
	if f.m != nil {
		f.m.ConfigChanged()
	}
	return nil
}

func (f *fakeConfig) update(fn func(c *config.AIConfig)) {
	f.mu.Lock()
	fn(&f.cfg)
	f.mu.Unlock()
	if f.m != nil {
		f.m.ConfigChanged()
	}
}

type auditRec struct {
	mu      sync.Mutex
	entries []string
}

func (a *auditRec) Record(profileID, op, dn, details string, err error) {
	e := profileID + "|" + op + "|" + dn + "|" + details
	if err != nil {
		e += "|err=" + err.Error()
	}
	a.mu.Lock()
	a.entries = append(a.entries, e)
	a.mu.Unlock()
}

func (a *auditRec) all() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.entries...)
}

type harness struct {
	t     *testing.T
	m     *Manager
	clock *aitest.FakeClock
	rec   *jsonRecorder
	store *chatstore.Store
	dir   *fake.FakeDir
	ad    *fake.FakeClient
	prov  *fake.ScriptedProvider
	cfg   *fakeConfig
	audit *auditRec
	path  string
}

const (
	adID       = "11111111-1111-4111-8111-111111111111"
	anna       = "CN=Anna Schmidt,OU=Users,DC=corp,DC=test"
	admins     = "CN=Domain Admins,CN=Users,DC=corp,DC=test"
	sentinelPW = "SENTINEL-Pw-7f3a"
)

func newHarness(t *testing.T, level string, writes bool) *harness {
	t.Helper()
	clock := aitest.NewFakeClock()
	ids := &aitest.SeqIDs{}
	dir := t.TempDir()
	st, err := chatstore.Open(dir, chatstore.Options{Cipher: fake.KeyCipher{Key: fake.TestKey}, Clock: clock, IDs: ids})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	ad := fake.NewFakeClient(ldaptools.ConnInfo{ProfileID: adID, Name: "Lab AD", Host: "dc1.corp.test", Port: 636, BaseDN: "DC=corp,DC=test",
		TLSMode: "ssl", Identity: "CN=admin,DC=corp,DC=test", Timeout: 10 * time.Second},
		&models.ServerInfo{ServerType: models.ServerTypeAD, DefaultNamingContext: "DC=corp,DC=test", ConfigurationNamingContext: "CN=Configuration,DC=corp,DC=test",
			SchemaNamingContext: "CN=Schema,CN=Configuration,DC=corp,DC=test", NamingContexts: []string{"DC=corp,DC=test"}})
	ad.Password = sentinelPW
	ad.Clock = clock
	ad.Put("DC=corp,DC=test", map[string][]string{"objectClass": {"top", "domain", "domainDNS"}, "lockoutDuration": {"-18000000000"}, "maxPwdAge": {"-36288000000000"}})
	ad.Put("OU=Users,DC=corp,DC=test", map[string][]string{"objectClass": {"top", "organizationalUnit"}, "ou": {"Users"}})
	ad.Put("CN=Users,DC=corp,DC=test", map[string][]string{"objectClass": {"top", "container"}, "cn": {"Users"}})
	ad.Put(anna, map[string][]string{"objectClass": {"top", "person", "organizationalPerson", "user"}, "cn": {"Anna Schmidt"}, "sAMAccountName": {"anna"},
		"description": {"Sales"}, "userPassword": {sentinelPW}, "ms-Mcs-AdmPwd": {sentinelPW}, "userAccountControl": {"512"}, "pwdLastSet": {"0"},
		"objectSid": {"S-1-5-21-1-2-3-1105"}})
	ad.Put(admins, map[string][]string{"objectClass": {"top", "group"}, "cn": {"Domain Admins"}, "sAMAccountName": {"Domain Admins"},
		"objectSid": {"S-1-5-21-1-2-3-512"}, "member": {anna}})
	fd := fake.NewFakeDir()
	fd.Add(ad)
	prov := fake.NewScripted()
	cfg := &fakeConfig{cfg: config.AIConfig{Version: 2, Engine: "builtin", Provider: "ollama", URL: "http://localhost:11434", Model: "fake-model",
		AllowWrites: writes, DefaultAccess: "ask", DisableTitleGeneration: true, ConnectionAccess: map[string]config.AccessEntry{adID: {Level: level}}}}
	rec := &jsonRecorder{}
	audit := &auditRec{}
	m := NewManager(Deps{Emitter: rec, Clock: clock, IDs: ids, Directory: fd, Auditor: audit, Store: st, Config: cfg,
		Providers: ProviderFunc(func(config.AIConfig) (provider.Provider, error) { return prov, nil })})
	cfg.m = m
	t.Cleanup(m.Shutdown)
	return &harness{t: t, m: m, clock: clock, rec: rec, store: st, dir: fd, ad: ad, prov: prov, cfg: cfg, audit: audit, path: dir}
}

func (h *harness) newChat() string {
	c, err := h.store.Create("")
	if err != nil {
		h.t.Fatal(err)
	}
	return c.ID
}

func (h *harness) send(chatID, text string) ai.SendResult {
	h.t.Helper()
	r, err := h.m.Send(ai.SendRequest{ChatID: chatID, Text: text, UI: ai.UIContext{ActiveProfileID: adID, TimeZone: "UTC"}})
	if err != nil {
		h.t.Fatal(err)
	}
	return r
}

func (h *harness) wait(chatID string) {
	h.t.Helper()
	if !h.m.Wait(chatID, 10*time.Second) {
		h.t.Fatalf("run did not finish; events:\n%s", strings.Join(h.rec.all(), "\n"))
	}
}

// waitEvent polls until an event with the name appeared n times.
func (h *harness) waitEvent(name string, n int) {
	h.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for h.rec.count(name) < n {
		if time.Now().After(deadline) {
			h.t.Fatalf("no %s event; events:\n%s", name, strings.Join(h.rec.all(), "\n"))
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func (h *harness) approvalID(i int) string {
	reqs := h.rec.find(ai.EventApprovalRequest)
	return reqs[i].(*ai.ApprovalRequest).ApprovalID
}

func (h *harness) done() *ai.DoneEvent {
	ds := h.rec.find(ai.EventDone)
	if len(ds) == 0 {
		h.t.Fatal("no ai:done")
	}
	return ds[len(ds)-1].(*ai.DoneEvent)
}

func (h *harness) chat(id string) *chatstore.Chat {
	c, err := h.store.Get(id)
	if err != nil {
		h.t.Fatal(err)
	}
	return c
}

// golden compares the recorded events with testdata/<name>.events.golden.jsonl.
func (h *harness) golden(name string) {
	h.t.Helper()
	got := strings.Join(h.rec.all(), "\n") + "\n"
	path := filepath.Join("testdata", name+".events.golden.jsonl")
	if *update {
		_ = os.MkdirAll("testdata", 0o755)
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			h.t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		h.t.Fatalf("missing golden file %s (run with -update): %v", path, err)
	}
	if string(want) != got {
		wl, gl := strings.Split(string(want), "\n"), strings.Split(got, "\n")
		for i := 0; i < len(wl) || i < len(gl); i++ {
			var w, g string
			if i < len(wl) {
				w = wl[i]
			}
			if i < len(gl) {
				g = gl[i]
			}
			if w != g {
				h.t.Fatalf("golden %s differs at line %d:\nwant: %s\n got: %s", name, i+1, w, g)
			}
		}
	}
}

// checkSeq asserts monotonic seq per run and ai:done last.
func checkSeq(t *testing.T, rec *jsonRecorder) {
	t.Helper()
	last := map[string]int64{}
	doneSeen := map[string]bool{}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	for i, v := range rec.values {
		env, ok := v.(ai.Enveloped)
		if !ok {
			continue
		}
		b, _ := json.Marshal(env)
		var e ai.Envelope
		_ = json.Unmarshal(b, &e)
		if doneSeen[e.RunID] {
			t.Fatalf("event %s after ai:done", rec.names[i])
		}
		if e.Seq <= last[e.RunID] {
			t.Fatalf("seq not monotonic at %s", rec.names[i])
		}
		last[e.RunID] = e.Seq
		if rec.names[i] == ai.EventDone {
			doneSeen[e.RunID] = true
		}
	}
}

var errBoom = errors.New("boom")
