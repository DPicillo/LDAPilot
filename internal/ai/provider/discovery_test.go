package provider

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/aitest"
)

func TestDiscoverCachingAndErrors(t *testing.T) {
	clock := aitest.NewFakeClock()
	path := filepath.Join(t.TempDir(), "ai_models_cache.json")
	cache := OpenDiscoveryCache(path, clock)
	calls := 0
	var fail error
	list := func(ctx context.Context) ([]ai.ModelInfo, error) {
		calls++
		if fail != nil {
			return nil, fail
		}
		return []ai.ModelInfo{{ID: "a", Tools: ai.CapYes}, {ID: "b", Tools: ai.CapNo}}, nil
	}
	req := DiscoverRequest{CacheKey: "ollama||http://localhost:11434", ProviderKey: "ollama", BaseURL: "http://localhost:11434", Kind: KindOllama, Configured: "b", List: list, Scrub: NewScrubber("secret-key")}
	d := Discover(context.Background(), cache, req)
	if calls != 1 || d.FromCache || len(d.Models) != 2 || d.EffectiveModel != "b" || !containsSub(d.Warnings, "does not support tools") {
		t.Fatalf("first %+v", d)
	}
	d = Discover(context.Background(), cache, req)
	if calls != 1 || !d.FromCache {
		t.Fatal("not served from cache")
	}
	clock.Advance(11 * time.Minute)
	fail = errors.New("connection refused with secret-key")
	d = Discover(context.Background(), cache, req)
	if calls != 2 || !d.FromCache || len(d.Models) != 2 || d.Error == "" || strings.Contains(d.Error, "secret-key") {
		t.Fatalf("error path %+v", d)
	}
	// Refresh bypasses the cache; the file survives a reload and holds no key.
	fail = nil
	req.Refresh = true
	req.Configured = "gone"
	d = Discover(context.Background(), cache, req)
	if calls != 3 || d.FromCache || d.EffectiveModel != "a" || !d.ModelMissing {
		t.Fatalf("refresh %+v", d)
	}
	cache.RecordDroppedParam(req.CacheKey, "a", ParamReasoningEffort)
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), "secret") {
		t.Fatal("secret in cache file")
	}
	re := OpenDiscoveryCache(path, clock)
	if e, ok := re.Get(req.CacheKey); !ok || len(e.Models) != 2 {
		t.Fatal("cache not persisted")
	}
	if !re.DroppedParams(req.CacheKey, "a")[ParamReasoningEffort] {
		t.Fatal("param facts not persisted")
	}
	// A changed CLI version invalidates the cache.
	req.Refresh, req.Version = false, "2.1.309"
	Discover(context.Background(), cache, req)
	if calls != 4 {
		t.Fatal("version change did not re-detect")
	}
}

func TestResolveModel(t *testing.T) {
	models := []ai.ModelInfo{{ID: "x", Tools: ai.CapNo}, {ID: "cloud:1", Tools: ai.CapYes, Remote: true}, {ID: "qwen:latest", Tools: ai.CapYes}}
	if eff, missing, _ := ResolveModel(KindOllama, "qwen", models); eff != "qwen:latest" || missing {
		t.Fatal(eff)
	}
	if eff, missing, n := ResolveModel(KindOllama, "", models); eff != "qwen:latest" || missing || n != "" {
		t.Fatal(eff)
	}
	if eff, _, _ := ResolveModel("claudecode", "gone", []ai.ModelInfo{{ID: "opus"}, {ID: "default"}}); eff != "default" {
		t.Fatal(eff)
	}
	if eff, missing, _ := ResolveModel(KindOllama, "keep", nil); eff != "keep" || missing {
		t.Fatal(eff)
	}
}
