package ldap

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// RW1-C-03: every entry names its profile and carries a per-profile sequence
// number, so views can filter the shared "operation:log" stream and drop
// entries they already loaded with GetLogs.
func TestLoggerStampsProfileAndSeq(t *testing.T) {
	p := NewPool()
	a := p.Logger("prof-a")
	b := p.Logger("prof-b")
	var streamed []LogEntry
	a.SetListener(func(e LogEntry) { streamed = append(streamed, e) })

	a.Log("SEARCH", "base=dc=x", time.Millisecond, nil)
	a.Log("CONNECT", "host=x", time.Millisecond, errors.New("connection refused"))
	b.Log("SEARCH", "base=dc=y", time.Millisecond, nil)

	got := a.GetEntries()
	if len(got) != 2 || got[0].Seq != 1 || got[1].Seq != 2 {
		t.Fatalf("seq: %+v", got)
	}
	for _, e := range got {
		if e.ProfileID != "prof-a" {
			t.Fatalf("profile: %+v", e)
		}
		// At = 2006-01-02T15:04:05.000…, Timestamp = 15:04:05.000
		if !strings.Contains(e.At, "T"+e.Timestamp) {
			t.Fatalf("at %q vs timestamp %q", e.At, e.Timestamp)
		}
	}
	if len(streamed) != 2 || streamed[1].Seq != 2 || streamed[1].ProfileID != "prof-a" {
		t.Fatalf("stream: %+v", streamed)
	}
	if e := b.GetEntries(); len(e) != 1 || e[0].ProfileID != "prof-b" || e[0].Seq != 1 {
		t.Fatalf("other profile: %+v", e)
	}

	// Clear keeps counting: a view never mistakes a new entry for an old one.
	a.Clear()
	a.Log("SEARCH", "base=dc=x", time.Millisecond, nil)
	if e := a.GetEntries(); len(e) != 1 || e[0].Seq != 3 {
		t.Fatalf("after clear: %+v", e)
	}
	// The logger stays the same across lookups (and therefore across clients).
	if p.Logger("prof-a") != a {
		t.Fatal("logger replaced")
	}
}
