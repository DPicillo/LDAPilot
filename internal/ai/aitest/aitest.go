// Package aitest holds test helpers for the AI harness: a fake clock,
// deterministic IDs, an event recorder and a goroutine-leak check.
package aitest

import (
	"fmt"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

// FakeClock is a manually advanced clock. Timers fire when Advance moves
// the time past their deadline.
type FakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
	// waiters is signalled whenever a timer is created or reset, so tests
	// can wait until code under test is sleeping.
	waiters chan struct{}
}

// NewFakeClock starts at a fixed instant.
func NewFakeClock() *FakeClock {
	return &FakeClock{now: time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC), waiters: make(chan struct{}, 1024)}
}

func (c *FakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *FakeClock) After(d time.Duration) <-chan time.Time { return c.NewTimer(d).C() }

func (c *FakeClock) NewTimer(d time.Duration) ai.Timer {
	c.mu.Lock()
	t := &fakeTimer{c: c, ch: make(chan time.Time, 1), at: c.now.Add(d), active: true}
	c.timers = append(c.timers, t)
	if d <= 0 {
		t.fireLocked(c.now)
	}
	c.mu.Unlock()
	c.signal()
	return t
}

func (c *FakeClock) signal() {
	select {
	case c.waiters <- struct{}{}:
	default:
	}
}

// Advance moves the clock and fires due timers.
func (c *FakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	now := c.now
	for _, t := range c.timers {
		if t.active && !t.at.After(now) {
			t.fireLocked(now)
		}
	}
	c.mu.Unlock()
}

// Pending returns the number of active timers.
func (c *FakeClock) Pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, t := range c.timers {
		if t.active {
			n++
		}
	}
	return n
}

// WaitForTimers blocks until at least n timers are active (or 2 s pass).
func (c *FakeClock) WaitForTimers(t testing.TB, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for c.Pending() < n {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d timers (have %d)", n, c.Pending())
		}
		select {
		case <-c.waiters:
		case <-time.After(5 * time.Millisecond):
		}
	}
}

type fakeTimer struct {
	c      *FakeClock
	ch     chan time.Time
	at     time.Time
	active bool
}

func (t *fakeTimer) fireLocked(now time.Time) {
	t.active = false
	select {
	case t.ch <- now:
	default:
	}
}

func (t *fakeTimer) C() <-chan time.Time { return t.ch }

func (t *fakeTimer) Stop() bool {
	t.c.mu.Lock()
	defer t.c.mu.Unlock()
	was := t.active
	t.active = false
	return was
}

func (t *fakeTimer) Reset(d time.Duration) bool {
	t.c.mu.Lock()
	was := t.active
	t.at = t.c.now.Add(d)
	t.active = true
	if d <= 0 {
		t.fireLocked(t.c.now)
	}
	t.c.mu.Unlock()
	t.c.signal()
	return was
}

// SeqIDs returns deterministic UUID-shaped IDs: 00000000-0000-4000-8000-000000000001, …
type SeqIDs struct {
	mu sync.Mutex
	n  int
}

func (s *SeqIDs) NewID() string {
	s.mu.Lock()
	s.n++
	n := s.n
	s.mu.Unlock()
	return fmt.Sprintf("00000000-0000-4000-8000-%012d", n)
}

// Recorder records emitted events.
type Recorder struct {
	mu     sync.Mutex
	Events []Recorded
}

// Recorded is one recorded event.
type Recorded struct {
	Name    string
	Payload any
}

func (r *Recorder) Emit(name string, payload any) {
	r.mu.Lock()
	r.Events = append(r.Events, Recorded{name, payload})
	r.mu.Unlock()
}

// Names returns the recorded event names.
func (r *Recorder) Names() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, len(r.Events))
	for i, e := range r.Events {
		out[i] = e.Name
	}
	return out
}

// CheckGoroutines snapshots the goroutines and, at cleanup, polls for up to
// 2 s until no goroutine with "internal/ai/" in its stack remains beyond
// the snapshot.
func CheckGoroutines(t testing.TB) {
	t.Helper()
	before := aiGoroutines()
	t.Cleanup(func() {
		deadline := time.Now().Add(2 * time.Second)
		for {
			leaked := diff(aiGoroutines(), before)
			if len(leaked) == 0 {
				return
			}
			if time.Now().After(deadline) {
				t.Errorf("leaked goroutines:\n%s", strings.Join(leaked, "\n\n"))
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	})
}

func aiGoroutines() map[string]string {
	buf := make([]byte, 1<<20)
	n := runtime.Stack(buf, true)
	out := map[string]string{}
	for _, g := range strings.Split(string(buf[:n]), "\n\n") {
		if !strings.Contains(g, "internal/ai/") || strings.Contains(g, "testing.tRunner") {
			continue // not ours, or a test goroutine itself
		}
		id := strings.SplitN(g, " ", 3)
		if len(id) >= 2 {
			out[id[1]] = g
		}
	}
	return out
}

func diff(now, before map[string]string) []string {
	var out []string
	for id, g := range now {
		if _, ok := before[id]; !ok {
			out = append(out, g)
		}
	}
	sort.Strings(out)
	return out
}
