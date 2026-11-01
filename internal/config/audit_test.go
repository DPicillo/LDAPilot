package config

import (
	"strings"
	"testing"
)

// Clearing leaves one AUDIT_CLEARED record (who, when, how many) and
// notifies the listener; the range query filters by timestamp prefix.
func TestAuditClearWithRecordAndRange(t *testing.T) {
	withTempConfig(t)
	st := NewAuditStore()
	var seen []AuditEntry
	st.SetListener(func(profileID string, e AuditEntry) {
		if profileID == "p1" {
			seen = append(seen, e)
		}
	})
	for _, e := range []AuditEntry{
		{Timestamp: "2026-10-29 10:00:00", Operation: "CREATE", DN: "cn=a"},
		{Timestamp: "2026-10-30 09:00:00", Operation: "MODIFY", DN: "cn=a"},
		{Timestamp: "2026-10-31 23:59:59", Operation: "DELETE", DN: "cn=a"},
	} {
		if err := st.Append("p1", e); err != nil {
			t.Fatal(err)
		}
	}
	if len(seen) != 3 {
		t.Fatalf("listener saw %d entries, want 3", len(seen))
	}
	got, err := st.GetEntriesBetween("p1", "2026-10-30", "2026-10-31", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Operation != "DELETE" || got[1].Operation != "MODIFY" {
		t.Fatalf("range 30..31 (newest first) = %+v", got)
	}
	if got, _ := st.GetEntriesBetween("p1", "", "2026-10-29", 0); len(got) != 1 || got[0].Operation != "CREATE" {
		t.Fatalf("open start, to = one day: %+v", got)
	}

	n, err := st.ClearWithRecord("p1", AuditEntry{Details: "audit log cleared", User: "admin@host"})
	if err != nil || n != 3 {
		t.Fatalf("ClearWithRecord = %d, %v", n, err)
	}
	all, _ := st.GetEntries("p1", 0)
	if len(all) != 1 {
		t.Fatalf("after clear: %+v", all)
	}
	rec := all[0]
	if rec.Operation != AuditOperationCleared || rec.User != "admin@host" || rec.Timestamp == "" || !strings.Contains(rec.Details, "3 entries removed") {
		t.Fatalf("clear record = %+v", rec)
	}
	if last := seen[len(seen)-1]; last.Operation != AuditOperationCleared {
		t.Fatalf("listener did not see the clear record: %+v", last)
	}
	// Other profiles are untouched.
	if other, _ := st.GetEntries("p2", 0); len(other) != 0 {
		t.Fatalf("p2 = %+v", other)
	}
}
