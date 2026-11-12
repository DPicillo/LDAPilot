package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	b, _ := json.Marshal(v)
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestAIConfigMigrationV1(t *testing.T) {
	dir := withTempConfig(t)
	enc, err := EncryptPassword("sk-live")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		v1               map[string]string
		provider, flavor string
		url              string
		key              string
	}{
		{map[string]string{"provider": "litellm", "url": "https://gw.example.com/v1/", "apiKey": enc, "model": "gpt-4o"}, "openai", "litellm", "https://gw.example.com/v1", "sk-live"},
		{map[string]string{"provider": "openai", "url": "https://api.openai.com/v1", "apiKey": "plain-old-key", "model": "gpt-4o"}, "openai", "openai", "https://api.openai.com/v1", "plain-old-key"},
		{map[string]string{"provider": "ollama", "url": "http://localhost:11434/v1/", "model": ""}, "ollama", "", "http://localhost:11434", ""},
	}
	for i, c := range cases {
		path := filepath.Join(dir, "cfg"+string(rune('a'+i))+".json")
		writeJSON(t, path, c.v1)
		s, err := OpenAIConfigStore(path)
		if err != nil {
			t.Fatal(err)
		}
		cfg := s.Get()
		if cfg.Version != 2 || cfg.Provider != c.provider || cfg.Flavor != c.flavor || cfg.URL != c.url || cfg.APIKey != c.key || cfg.Engine != "builtin" {
			t.Fatalf("case %d: %+v", i, cfg)
		}
		// Written back as v2, key encrypted.
		raw, _ := os.ReadFile(path)
		var disk map[string]any
		json.Unmarshal(raw, &disk)
		if disk["version"] != float64(2) {
			t.Fatalf("case %d: not written back: %s", i, raw)
		}
		if c.key != "" && (strings.Contains(string(raw), c.key) || !strings.HasPrefix(disk["apiKey"].(string), "ENC:")) {
			t.Fatalf("case %d: key not encrypted on disk", i)
		}
		if m := s.GetMasked(); m.APIKey != "" || m.HasKey != (c.key != "") {
			t.Fatalf("case %d: masked %+v", i, m)
		}
	}
}

func TestAIConfigUndecryptableKey(t *testing.T) {
	dir := withTempConfig(t)
	path := filepath.Join(dir, "ai.json")
	writeJSON(t, path, map[string]any{"version": 2, "provider": "openai", "flavor": "litellm", "url": "https://gw.example.com/v1", "apiKey": "ENC:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "model": "m"})
	s, err := OpenAIConfigStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.Get().APIKey != "" {
		t.Fatal("ciphertext used as key")
	}
	m := s.GetMasked()
	if m.HasKey || !strings.Contains(m.KeyError, "could not be decrypted") {
		t.Fatalf("masked %+v", m)
	}
	// Saving the same endpoint keeps the ciphertext (no silent loss) and the error.
	m.Model = "m2"
	if err := s.Set(m); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), "ENC:AAAA") || s.KeyError() == "" {
		t.Fatal("ciphertext dropped on unrelated save")
	}
	// A new key replaces it.
	m = s.GetMasked()
	m.APIKey = "new-key"
	if err := s.Set(m); err != nil {
		t.Fatal(err)
	}
	if s.Get().APIKey != "new-key" || s.KeyError() != "" {
		t.Fatal("new key not applied")
	}
}

func TestAIConfigKeyRules(t *testing.T) {
	dir := withTempConfig(t)
	s, _ := OpenAIConfigStore(filepath.Join(dir, "ai.json"))
	cfg := s.GetMasked()
	cfg.Provider, cfg.Flavor, cfg.URL, cfg.APIKey, cfg.Model = "openai", "litellm", "https://gw.example.com/v1", "k1", "m"
	if err := s.Set(cfg); err != nil {
		t.Fatal(err)
	}
	var updates []int64
	s.Subscribe(func(c AIConfig) { updates = append(updates, c.Revision) })

	// Unchanged endpoint, empty key → kept.
	cfg = s.GetMasked()
	cfg.Model = "m2"
	if err := s.Set(cfg); err != nil || s.Get().APIKey != "k1" {
		t.Fatalf("key not kept: %v", err)
	}
	// Unsaved config with another URL: EffectiveKey drops the key.
	other := s.GetMasked()
	other.URL = "https://evil.example.com/v1"
	if s.EffectiveKey(other) != "" || s.EffectiveKey(s.GetMasked()) != "k1" {
		t.Fatal("EffectiveKey")
	}
	// Changed URL / flavor / provider → dropped.
	for i, mut := range []func(*AIConfig){
		func(c *AIConfig) { c.URL = "https://other.example.com/v1" },
		func(c *AIConfig) { c.Flavor = "vllm" },
		func(c *AIConfig) { c.Provider, c.Flavor = "anthropic", "" },
	} {
		cfg = s.GetMasked()
		cfg.APIKey = "k1"
		if err := s.Set(cfg); err != nil {
			t.Fatal(err)
		}
		cfg = s.GetMasked()
		mut(&cfg)
		if err := s.Set(cfg); err != nil {
			t.Fatalf("mut %d: %v", i, err)
		}
		if s.Get().APIKey != "" {
			t.Fatalf("mut %d: key carried to a new endpoint", i)
		}
	}
	// ClearAPIKey.
	cfg = s.GetMasked()
	cfg.APIKey = "k2"
	s.Set(cfg)
	cfg = s.GetMasked()
	cfg.ClearAPIKey = true
	if err := s.Set(cfg); err != nil || s.Get().APIKey != "" {
		t.Fatal("ClearAPIKey")
	}
	// Stale revision.
	stale := s.GetMasked()
	stale.Revision--
	if err := s.Set(stale); !errors.Is(err, ErrStaleRevision) {
		t.Fatalf("stale revision: %v", err)
	}
	if len(updates) == 0 || updates[len(updates)-1] != s.Revision() {
		t.Fatalf("subscribers %v", updates)
	}
}

func TestAIConfigValidation(t *testing.T) {
	dir := withTempConfig(t)
	s, _ := OpenAIConfigStore(filepath.Join(dir, "ai.json"))
	base := s.GetMasked()
	bad := []func(*AIConfig){
		func(c *AIConfig) { c.Provider = "gemini" },
		func(c *AIConfig) { c.Provider, c.Flavor = "openai", "bogus" },
		func(c *AIConfig) { c.Provider, c.URL = "openai", "ftp://x" },
		func(c *AIConfig) { c.Provider, c.URL = "openai", "https://user:pass@gw.example.com/v1" },
		func(c *AIConfig) { c.Provider, c.URL, c.APIKey = "openai", "http://gw.example.com/v1", "k" },
		func(c *AIConfig) { c.Provider, c.URL, c.EndpointLocal = "openai", "https://gw.example.com/v1", true },
		func(c *AIConfig) { c.Provider, c.MaxSteps = "ollama", 99 },
		func(c *AIConfig) { c.Provider, c.ContextWindow = "ollama", 1000 },
		func(c *AIConfig) { c.ConnectionAccess = map[string]AccessEntry{"p1": {Level: "admin"}} },
		func(c *AIConfig) { c.DefaultAccess = "write" },
		func(c *AIConfig) { c.RedactAttributes = []string{"bad name!"} },
		func(c *AIConfig) { c.Provider, c.Model, c.Effort = "anthropic", "claude-haiku-4-5", "low" },
		func(c *AIConfig) {
			c.Provider, c.Model, c.Thinking, c.Effort = "anthropic", "claude-sonnet-5-5", "off", "max"
		},
		func(c *AIConfig) { c.Provider, c.Effort = "ollama", "high" },
		func(c *AIConfig) { c.ClaudeCode.Path = "relative/claude" },
		func(c *AIConfig) { c.ClaudeCode.MaxBudgetUSD = 1000 },
		func(c *AIConfig) { c.ClaudeCode.Runtime = "docker" },
		func(c *AIConfig) { c.ClaudeCode.WSLDistro = "Ubuntu; rm -rf /" },
		func(c *AIConfig) { c.ClaudeCode.WSLDistro = "My Distro" },
		func(c *AIConfig) { c.ClaudeCode.WSLPath = `C:\Users\a\claude.exe` },
		func(c *AIConfig) { c.ClaudeCode.WSLPath = "~/.local/bin/claude" },
		func(c *AIConfig) { c.ClaudeCode.WSLPath = "/home/u/claude\n--evil" },
	}
	for i, mut := range bad {
		c := base
		c.ConnectionAccess = map[string]AccessEntry{}
		mut(&c)
		if err := s.Set(c); err == nil {
			t.Errorf("case %d accepted: %+v", i, c)
			base = s.GetMasked()
		}
	}
	// Valid: http to loopback with a key, plain http without key, insecure opt-in.
	good := []func(*AIConfig){
		func(c *AIConfig) { c.Provider, c.URL, c.APIKey = "ollama", "http://localhost:11434", "k" },
		func(c *AIConfig) {
			c.Provider, c.Flavor, c.URL, c.APIKey, c.AllowInsecureHTTP = "openai", "custom", "http://gw.lan:8000/v1", "k", true
		},
		func(c *AIConfig) {
			c.Provider, c.Flavor, c.URL, c.EndpointLocal = "openai", "litellm", "http://127.0.0.1:4000/v1", true
			c.RedactAttributes = []string{"mySecret*", "1.2.840.113556.1.4.90", "employeeID"}
			c.ConnectionAccess = map[string]AccessEntry{"p1": {Level: "write", Hosts: []string{"API.OpenAI.com"}}}
			c.Engine = "claudecode"
			c.ClaudeCode = ClaudeCodeConfig{Model: "haiku", MaxBudgetUSD: 0.25}
		},
		func(c *AIConfig) {
			c.Engine = "claudecode"
			c.ClaudeCode = ClaudeCodeConfig{Runtime: "wsl", WSLDistro: "Ubuntu-24.04", WSLPath: "/home/anna/.nvm/versions/node/v22.11.0/bin/claude"}
		},
		func(c *AIConfig) { c.ClaudeCode = ClaudeCodeConfig{Runtime: "windows"} },
	}
	for i, mut := range good {
		c := s.GetMasked()
		mut(&c)
		if err := s.Set(c); err != nil {
			t.Fatalf("good case %d: %v", i, err)
		}
	}
	if h := s.Get().ConnectionAccess["p1"].Hosts; len(h) != 1 || h[0] != "api.openai.com" {
		t.Fatalf("hosts not normalized: %v", h)
	}
	// TLS skip verify with a key → warning.
	c := s.GetMasked()
	c.Provider, c.Flavor, c.URL, c.APIKey, c.TLSSkipVerify, c.EndpointLocal = "openai", "custom", "https://gw.example.com/v1", "k", true, false
	if err := s.Set(c); err != nil {
		t.Fatal(err)
	}
	if w := s.GetMasked().Warnings; len(w) != 1 || !strings.Contains(w[0], "TLS") {
		t.Fatalf("warnings %v", w)
	}
}

func TestSetConnectionAccess(t *testing.T) {
	dir := withTempConfig(t)
	s, _ := OpenAIConfigStore(filepath.Join(dir, "ai.json"))
	var notified int64
	s.Subscribe(func(c AIConfig) { notified = c.Revision })
	before := s.Revision()
	rev, err := s.SetConnectionAccess("p1", AccessRead, "api.openai.com")
	if err != nil || rev != before+1 || notified != rev {
		t.Fatalf("rev %d notified %d err %v", rev, notified, err)
	}
	rev, _ = s.SetConnectionAccess("p1", AccessRead, "api.anthropic.com")
	e := s.Get().ConnectionAccess["p1"]
	if e.Level != AccessRead || len(e.Hosts) != 2 {
		t.Fatalf("entry %+v", e)
	}
	s.SetConnectionAccess("p1", AccessAsk, "")
	if e := s.Get().ConnectionAccess["p1"]; e.Level != AccessAsk || len(e.Hosts) != 0 {
		t.Fatalf("ask keeps hosts %+v", e)
	}
	if _, err := s.SetConnectionAccess("p1", "root", ""); err == nil {
		t.Fatal("invalid level accepted")
	}
	// Persisted.
	s2, _ := OpenAIConfigStore(filepath.Join(dir, "ai.json"))
	if s2.Revision() != s.Revision() || s2.Get().ConnectionAccess["p1"].Level != AccessAsk {
		t.Fatal("not persisted")
	}
}

func TestAIConfigKeyUnavailableKeepsCiphertext(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root")
	}
	dir := withTempConfig(t)
	enc, _ := EncryptPassword("sk-live")
	path := filepath.Join(dir, "ai.json")
	writeJSON(t, path, map[string]any{"version": 2, "provider": "anthropic", "url": "https://api.anthropic.com", "apiKey": enc, "model": "claude-opus-5-5"})
	keyPath := filepath.Join(dir, keyFileName)
	os.Chmod(keyPath, 0)
	t.Cleanup(func() { os.Chmod(keyPath, 0o600) })
	resetAppKeyCache()
	s, err := OpenAIConfigStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.Get().APIKey != "" || !strings.Contains(s.GetMasked().KeyError, "encryption key") {
		t.Fatalf("%+v", s.GetMasked())
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), enc) {
		t.Fatal("ciphertext lost while the key was unreadable")
	}
}

func TestAllowReadHostNeverWidensWrite(t *testing.T) {
	withTempConfig(t)
	st, err := NewAIConfigStore()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.SetConnectionAccess("p", AccessWrite, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AllowReadHost("p", "API.openai.com"); err != nil {
		t.Fatal(err)
	}
	e := st.Get().ConnectionAccess["p"]
	if e.Level != AccessWrite || len(e.Hosts) != 0 || len(e.ReadHosts) != 1 || e.ReadHosts[0] != "api.openai.com" {
		t.Fatalf("%+v", e)
	}
	// Raising write for the host in the settings moves it to Hosts.
	if _, err := st.SetConnectionAccess("p", AccessWrite, "api.openai.com"); err != nil {
		t.Fatal(err)
	}
	if e := st.Get().ConnectionAccess["p"]; len(e.Hosts) != 1 || len(e.ReadHosts) != 0 {
		t.Fatalf("%+v", e)
	}
	// An ask profile becomes read for the host.
	if _, err := st.AllowReadHost("q", "api.openai.com"); err != nil {
		t.Fatal(err)
	}
	if e := st.Get().ConnectionAccess["q"]; e.Level != AccessRead || len(e.Hosts) != 1 {
		t.Fatalf("%+v", e)
	}
}
