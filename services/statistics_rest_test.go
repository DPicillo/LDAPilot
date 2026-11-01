package services

import (
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
)

func statsEntry(dn string, classes ...string) models.LDAPEntry {
	return models.LDAPEntry{DN: dn, Attributes: []models.LDAPAttribute{{Name: "objectClass", Values: classes}}}
}

// DEF-23: the counts come from one pure pass; a size-limited search is marked.
func TestStatisticsOfCountsAndTruncation(t *testing.T) {
	res := &models.SearchResult{
		Entries: []models.LDAPEntry{
			statsEntry("ou=a,dc=x", "top", "organizationalUnit"),
			statsEntry("uid=u,ou=a,dc=x", "top", "inetOrgPerson"),
			statsEntry("cn=g,ou=a,dc=x", "top", "groupOfNames"),
		},
		TotalCount: 3,
		Truncated:  true,
	}
	st := statisticsOf("ou=a,dc=x", res)
	if st.TotalCount != 3 || st.ByType["OUs"] != 1 || st.ByType["Users"] != 1 || st.ByType["Groups"] != 1 {
		t.Fatalf("counts = %d %v", st.TotalCount, st.ByType)
	}
	if !st.Truncated {
		t.Fatal("a size-limited count must be marked truncated")
	}
	if st.Filters["Users"] == "" || st.Filters["Computers"] != "" {
		t.Fatalf("filters = %v", st.Filters)
	}
	if st2 := statisticsOf("dc=x", &models.SearchResult{}); st2.Truncated || st2.TotalCount != 0 {
		t.Fatalf("empty = %+v", st2)
	}
}

// Closing the statistics dialog right after it opened cancels a count that
// has not registered yet: the cancel is remembered and the count stops at once.
func TestStatisticsCancelBeforeStart(t *testing.T) {
	if n := statisticsCalls.cancel("p-stats", "req-1"); n != 0 {
		t.Fatalf("nothing runs yet, cancelled %d", n)
	}
	ctx, done := statisticsCalls.track("p-stats", "req-1")
	defer done()
	if ctx.Err() == nil {
		t.Fatal("an early cancel must stop the count when it starts")
	}
	ctx2, done2 := statisticsCalls.track("p-stats", "req-2")
	if ctx2.Err() != nil {
		t.Fatal("another request is not affected")
	}
	if n := statisticsCalls.cancel("p-stats", "req-2"); n != 1 || ctx2.Err() == nil {
		t.Fatalf("running count not cancelled (%d)", n)
	}
	done2()
}
