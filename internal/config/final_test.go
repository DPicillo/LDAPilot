package config

import (
	"strings"
	"testing"
)

// RW3-R-04: clearing a log with one entry says "1 entry removed".
func TestAuditClearRecordSingular(t *testing.T) {
	withTempConfig(t)
	st := NewAuditStore()
	if err := st.Append("p1", AuditEntry{Timestamp: "2026-11-01 10:00:00", Operation: "MODIFY", DN: "cn=a"}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.ClearWithRecord("p1", AuditEntry{Details: "audit log cleared", User: "admin@host"}); err != nil {
		t.Fatal(err)
	}
	all, _ := st.GetEntries("p1", 0)
	if len(all) != 1 || !strings.Contains(all[0].Details, "(1 entry removed)") {
		t.Fatalf("clear record = %+v", all)
	}
}
