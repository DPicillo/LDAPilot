package services

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/provider"
)

// UX P4 (A-19): the check before a run ("Checking the AI provider … before
// sending", up to ~18 s against an endpoint that does not answer) stops on
// CancelProviderCheck with code cancelled and caches nothing about the
// endpoint.
func TestCancelProviderCheck(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case entered <- struct{}{}:
		default:
		}
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer srv.Close()
	defer close(release)

	s, store := newTestAIService(t)
	cfg := store.GetMasked()
	cfg.Provider, cfg.Flavor, cfg.URL, cfg.Model = "openai", "custom", srv.URL+"/v1", "model-a"

	type result struct {
		d   ai.ModelDiscovery
		err error
	}
	done := make(chan result, 1)
	go func() {
		d, err := s.CheckProvider(cfg)
		done <- result{d, err}
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the check never reached the endpoint")
	}
	start := time.Now()
	s.CancelProviderCheck()
	var res result
	select {
	case res = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("CancelProviderCheck did not stop the check")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("stopping took %v", time.Since(start))
	}
	e, ok := res.err.(*aiError)
	if !ok || e.Code() != ai.CodeCancelled {
		t.Fatalf("error %v (%T)", res.err, res.err)
	}
	key := provider.CacheKey(cfg.Provider, normFlavor(cfg), cfg.URL)
	if c, ok := s.models.cache.Get(key); ok && c.Error != "" {
		t.Fatalf("a stopped check cached the error %q", c.Error)
	}
	// Nothing left to cancel; a later call is a no-op.
	s.CancelProviderCheck()
	s.models.checkMu.Lock()
	n := len(s.models.checks)
	s.models.checkMu.Unlock()
	if n != 0 {
		t.Fatalf("%d checks still registered", n)
	}
}

// A stopped check does not wait for a background discovery that still
// holds the discovery slot (it dials the same unreachable endpoint).
func TestCancelProviderCheckWhileDiscoveryBusy(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{}, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer srv.Close()
	// The background discovery still writes the model cache into the test's
	// config directory once released: wait for it before t.TempDir is removed.
	discovered := make(chan struct{})
	started := false
	defer func() {
		close(release)
		if !started {
			return
		}
		select {
		case <-discovered:
		case <-time.After(5 * time.Second):
			t.Error("the background discovery did not finish")
		}
	}()

	s, store := newTestAIService(t)
	cfg := store.GetMasked()
	cfg.Provider, cfg.Flavor, cfg.URL, cfg.Model = "openai", "custom", srv.URL+"/v1", "model-a"
	started = true
	go func() { // background discovery holding the slot
		defer close(discovered)
		_, _ = s.DiscoverModels(cfg, true)
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("discovery never reached the endpoint")
	}
	done := make(chan error, 1)
	go func() {
		_, err := s.CheckProvider(cfg)
		done <- err
	}()
	time.Sleep(100 * time.Millisecond) // the check now waits for the slot
	start := time.Now()
	s.CancelProviderCheck()
	select {
	case err := <-done:
		if e, ok := err.(*aiError); !ok || e.Code() != ai.CodeCancelled {
			t.Fatalf("error %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the stopped check waited for the busy discovery")
	}
	if time.Since(start) > time.Second {
		t.Fatalf("stopping took %v", time.Since(start))
	}
}
