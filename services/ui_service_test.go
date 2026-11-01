package services

import (
	"context"
	"encoding/json"
	"os"
	"runtime/debug"
	"strings"
	"sync"
	"testing"
	"time"
)

// closeHarness drives UIService.BeforeClose with a fake clock, timer,
// event emitter and quit.
type closeHarness struct {
	s       *UIService
	mu      sync.Mutex
	now     time.Time
	events  int
	quits   int
	pending []func()
}

func newCloseHarness() *closeHarness {
	h := &closeHarness{now: time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)}
	h.s = &UIService{
		emit:  func(string) { h.mu.Lock(); h.events++; h.mu.Unlock() },
		quit:  func() { h.mu.Lock(); h.quits++; h.mu.Unlock() },
		now:   func() time.Time { return h.now },
		after: func(_ time.Duration, f func()) { h.pending = append(h.pending, f) },
	}
	return h
}

// fireTimers runs the scheduled 2 s fail-safes.
func (h *closeHarness) fireTimers() {
	p := h.pending
	h.pending = nil
	for _, f := range p {
		f()
	}
}

func (h *closeHarness) counts() (int, int) {
	time.Sleep(10 * time.Millisecond) // the event is emitted on a goroutine
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.events, h.quits
}

func TestBeforeCloseAsksTheFrontend(t *testing.T) {
	h := newCloseHarness()
	ctx := context.Background()
	if !h.s.BeforeClose(ctx) {
		t.Fatal("first close request not held back")
	}
	h.s.AckClose()
	h.fireTimers()
	if ev, q := h.counts(); ev != 1 || q != 0 {
		t.Fatalf("events %d, quits %d after an acknowledged request", ev, q)
	}
	// The frontend found nothing busy (or the user confirmed): Quit closes.
	h.s.Quit()
	if _, q := h.counts(); q != 1 {
		t.Fatalf("Quit did not quit")
	}
	if h.s.BeforeClose(ctx) {
		t.Fatal("close after Quit was prevented")
	}
}

func TestBeforeCloseFailSafes(t *testing.T) {
	// No answer within 2 s: closes anyway.
	h := newCloseHarness()
	h.s.BeforeClose(context.Background())
	h.fireTimers()
	if _, q := h.counts(); q != 1 {
		t.Fatalf("dead frontend: quits %d", q)
	}

	// A second close request within 5 s closes at once.
	h = newCloseHarness()
	h.s.BeforeClose(context.Background())
	h.s.AckClose()
	h.now = h.now.Add(3 * time.Second)
	if h.s.BeforeClose(context.Background()) {
		t.Fatal("second close request within 5 s was prevented")
	}

	// After CancelClose (the user stays) or 5 s, the next request asks again.
	h = newCloseHarness()
	h.s.BeforeClose(context.Background())
	h.s.CancelClose()
	if !h.s.BeforeClose(context.Background()) {
		t.Fatal("request after CancelClose not held back")
	}
	h.s.AckClose()
	h.now = h.now.Add(6 * time.Second)
	if !h.s.BeforeClose(context.Background()) {
		t.Fatal("request after 6 s not held back")
	}
	h.s.AckClose()
	h.fireTimers()
	if ev, q := h.counts(); ev != 3 || q != 0 {
		t.Fatalf("events %d, quits %d", ev, q)
	}
}

func TestAppInfoFrom(t *testing.T) {
	bi := &debug.BuildInfo{
		GoVersion: "go1.26.0",
		Main:      debug.Module{Version: "(devel)"},
		Deps:      []*debug.Module{{Path: "github.com/wailsapp/wails/v2", Version: "v2.17.0"}},
		Settings: []debug.BuildSetting{
			{Key: "vcs.revision", Value: "9ef4398051b9b6417d6bac4179d09be460bc62c0"},
			{Key: "vcs.time", Value: "2026-10-31T10:00:00Z"},
			{Key: "vcs.modified", Value: "true"},
		},
	}
	got := appInfoFrom(BuildInfo{}, bi)
	if got.Version != ReleaseVersion+"-dev" || got.Commit != "9ef4398051b9" || got.BuildDate != "2026-10-31T10:00:00Z" || !got.Modified ||
		got.GoVersion != "go1.26.0" || got.WailsVersion != "v2.17.0" {
		t.Fatalf("fallback = %+v", got)
	}
	got = appInfoFrom(BuildInfo{Version: "v0.5.0", Commit: "abc1234", Date: "2026-11-01"}, bi)
	if got.Version != "v0.5.0" || got.Commit != "abc1234" || got.BuildDate != "2026-11-01" {
		t.Fatalf("ldflags = %+v", got)
	}
	if got := appInfoFrom(BuildInfo{}, nil); got.Version != ReleaseVersion+"-dev" || got.GoVersion == "" {
		t.Fatalf("no build info = %+v", got)
	}
}

// TestReleaseVersionDeclarations keeps the declared version in step:
// services.ReleaseVersion, wails.json info.productVersion (Windows file
// version, macOS bundle version, installer) and frontend/package.json.
func TestReleaseVersionDeclarations(t *testing.T) {
	want := strings.TrimPrefix(ReleaseVersion, "v")
	var wailsJSON struct {
		Info struct {
			ProductVersion string `json:"productVersion"`
		} `json:"info"`
	}
	var pkg struct {
		Version string `json:"version"`
	}
	for path, dst := range map[string]any{"../wails.json": &wailsJSON, "../frontend/package.json": &pkg} {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, dst); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
	}
	if wailsJSON.Info.ProductVersion != want {
		t.Errorf("wails.json info.productVersion = %q, want %q", wailsJSON.Info.ProductVersion, want)
	}
	if pkg.Version != want {
		t.Errorf("frontend/package.json version = %q, want %q", pkg.Version, want)
	}
}
