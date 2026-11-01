package services

import (
	"testing"
	"time"
)

func TestCallRegistryCancelByRequestID(t *testing.T) {
	r := newCallRegistry()
	ctxA, doneA := r.track("p1", "a")
	ctxB, doneB := r.track("p1", "b")
	ctxC, doneC := r.track("p2", "a")
	defer doneA()
	defer doneB()
	defer doneC()

	if n := r.cancel("p1", "a"); n != 1 {
		t.Fatalf("cancel(p1, a) = %d, want 1", n)
	}
	if ctxA.Err() == nil {
		t.Error("request a of p1 must be cancelled")
	}
	if ctxB.Err() != nil || ctxC.Err() != nil {
		t.Error("other requests must keep running")
	}
	if n := r.cancel("p1", ""); n != 2 { // a (already cancelled, still running) and b
		t.Fatalf("cancel(p1, \"\") = %d, want 2", n)
	}
	if ctxB.Err() == nil {
		t.Error("cancel with empty ID must cancel all calls of the profile")
	}
	if ctxC.Err() != nil {
		t.Error("calls of other profiles must keep running")
	}
}

func TestCallRegistryDoneUnregisters(t *testing.T) {
	r := newCallRegistry()
	ctx, done := r.track("p", "x")
	done()
	if ctx.Err() == nil {
		t.Error("done must release the context")
	}
	if len(r.running) != 0 {
		t.Errorf("finished call still registered: %v", r.running)
	}
	// A cancel after the call finished must not cancel a later call with
	// another ID.
	r.cancel("p", "x")
	ctx2, done2 := r.track("p", "y")
	defer done2()
	if ctx2.Err() != nil {
		t.Error("unrelated call cancelled")
	}
}

func TestCallRegistryEarlyCancel(t *testing.T) {
	now := time.Unix(1000, 0)
	r := newCallRegistry()
	r.now = func() time.Time { return now }

	// The cancel arrives before the call (concurrent dispatch).
	if n := r.cancel("p", "early"); n != 0 {
		t.Fatalf("cancel of a call that has not started = %d, want 0", n)
	}
	ctx, done := r.track("p", "early")
	defer done()
	if ctx.Err() == nil {
		t.Error("a call cancelled before it started must start cancelled")
	}
	if len(r.early) != 0 {
		t.Error("early cancel must be consumed")
	}

	// Expired early cancels are ignored and pruned.
	r.cancel("p", "late")
	now = now.Add(2 * earlyCancelTTL)
	ctx2, done2 := r.track("p", "late")
	defer done2()
	if ctx2.Err() != nil {
		t.Error("an expired early cancel must not cancel the call")
	}
	r.cancel("p", "other")
	now = now.Add(2 * earlyCancelTTL)
	r.cancel("p", "")
	if len(r.early) != 0 {
		t.Errorf("expired early cancels not pruned: %v", r.early)
	}

	// Without request ID nothing is remembered.
	r.cancel("p", "")
	ctx3, done3 := r.track("p", "")
	defer done3()
	if ctx3.Err() != nil {
		t.Error("calls without request ID must not be cancelled early")
	}
}
