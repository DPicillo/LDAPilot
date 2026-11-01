package services

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/chatstore"
	"github.com/dpicillo/LDAPilot/internal/config"
)

func newTestAIService(t *testing.T) (*AIService, *config.AIConfigStore) {
	t.Helper()
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)
	t.Setenv("HOME", base)
	store, err := config.OpenAIConfigStore(filepath.Join(base, "ai_config.json"))
	if err != nil {
		t.Fatal(err)
	}
	chats, err := config.NewChatStore()
	if err != nil {
		t.Fatal(err)
	}
	s := NewAIService(nil, store, chats)
	return s, store
}

func TestDiscoverModelsUnsavedConfigKeyRule(t *testing.T) {
	var mu sync.Mutex
	auth := map[string]string{}
	handler := func(name string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			auth[name] = r.Header.Get("Authorization")
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"data":[{"id":"model-a"},{"id":"text-embedding-3-small"}]}`))
		}
	}
	a := httptest.NewServer(handler("a"))
	defer a.Close()
	b := httptest.NewServer(handler("b"))
	defer b.Close()

	s, store := newTestAIService(t)
	var events []string
	s.emitter = func(name string, payload any) { events = append(events, name) }
	cfg := store.GetMasked()
	cfg.Provider, cfg.Flavor, cfg.URL, cfg.APIKey, cfg.Model = "openai", "custom", a.URL+"/v1", "stored-key", "model-a"
	if err := s.SaveAIConfig(cfg); err != nil {
		t.Fatal(err)
	}

	// Same endpoint, no key in the form → stored key used.
	d, err := s.DiscoverModels(store.GetMasked(), true)
	if err != nil || len(d.Models) != 1 || d.Models[0].ID != "model-a" || d.EffectiveModel != "model-a" {
		t.Fatalf("discovery %+v %v", d, err)
	}
	// Unsaved config pointing elsewhere → no key sent there.
	other := store.GetMasked()
	other.URL = b.URL + "/v1"
	if _, err := s.DiscoverModels(other, true); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if auth["a"] != "Bearer stored-key" || auth["b"] != "" {
		t.Fatalf("auth %v", auth)
	}
	// Nothing persisted by discovery.
	if store.Get().URL != a.URL+"/v1" {
		t.Fatal("discovery changed the saved config")
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "LDAPilot", modelsCacheFile)); err != nil {
		t.Fatalf("models cache not written: %v", err)
	}
}

func TestSaveAIConfigLegacyShape(t *testing.T) {
	s, store := newTestAIService(t)
	var mu sync.Mutex
	var events []string
	s.emitter = func(name string, payload any) { mu.Lock(); events = append(events, name); mu.Unlock() }
	s.configStore.Subscribe(func(c config.AIConfig) { s.emit(ai.EventConfigUpdated, ai.ConfigUpdatedEvent{Revision: c.Revision}) })
	// The legacy settings form sends only these four fields (no version).
	legacy := config.AIConfig{Provider: "litellm", URL: "https://gw.example.com/v1/", APIKey: "k", Model: "gpt-4o"}
	if err := s.SaveAIConfig(legacy); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveAIConfig(config.AIConfig{Provider: "litellm", URL: "https://gw.example.com/v1", Model: "gpt-4.1"}); err != nil {
		t.Fatal(err)
	}
	got := store.Get()
	if got.Provider != "openai" || got.Flavor != "litellm" || got.URL != "https://gw.example.com/v1" || got.APIKey != "k" || got.Model != "gpt-4.1" || got.Revision != 2 {
		t.Fatalf("%+v", got)
	}
	// The legacy form displays the v2 provider ("openai") and saves it back:
	// the LiteLLM flavor and the key survive.
	if err := s.SaveAIConfig(config.AIConfig{Provider: "openai", URL: "https://gw.example.com/v1", Model: "gpt-4.1"}); err != nil {
		t.Fatal(err)
	}
	if got := store.Get(); got.Flavor != "litellm" || got.APIKey != "k" {
		t.Fatalf("round trip through the legacy form: %+v", got)
	}
	mu.Lock()
	n := len(events)
	mu.Unlock()
	if n < 2 {
		t.Fatalf("config_updated events: %d", n)
	}
}

func TestLegacyChatIDValidation(t *testing.T) {
	s, _ := newTestAIService(t)
	parent := filepath.Dir(s.chatStore.Dir())
	conn := filepath.Join(parent, "connections.json")
	os.WriteFile(conn, []byte("[]"), 0o600)
	if err := s.DeleteChat("../connections"); !errors.Is(err, chatstore.ErrInvalidChatID) {
		t.Fatalf("err %v", err)
	}
	if _, err := os.Stat(conn); err != nil {
		t.Fatal("connections.json deleted")
	}
	if _, err := s.Chat("../x", "hi"); !errors.Is(err, chatstore.ErrInvalidChatID) {
		t.Fatal(err)
	}
}
