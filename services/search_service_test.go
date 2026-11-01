package services

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	internalldap "github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

func TestSearchServiceCancelSearch(t *testing.T) {
	s := NewSearchService(nil)

	ctxA1, doneA1 := s.track("a")
	ctxA2, doneA2 := s.track("a")
	ctxB, doneB := s.track("b")
	defer doneB()

	if n := s.CancelSearch("a"); n != 2 {
		t.Fatalf("CancelSearch(a) = %d, want 2", n)
	}
	if ctxA1.Err() == nil || ctxA2.Err() == nil {
		t.Fatal("searches of profile a were not cancelled")
	}
	if ctxB.Err() != nil {
		t.Fatal("search of profile b must not be cancelled")
	}

	doneA1()
	doneA2()
	if n := s.CancelSearch("a"); n != 0 {
		t.Fatalf("CancelSearch(a) after done = %d, want 0", n)
	}
	if _, ok := s.running["a"]; ok {
		t.Fatal("finished profile entry not cleaned up")
	}
	if n := s.CancelSearch("unknown"); n != 0 {
		t.Fatalf("CancelSearch(unknown) = %d, want 0", n)
	}
}

func TestSearchServiceSearchRunTracking(t *testing.T) {
	s := NewSearchService(nil)

	ctxA, doneA := s.trackRun("tab-1")
	ctxLive, doneLive := s.track("p")
	defer doneLive()

	// Cancelling the panel's searches of the profile leaves the tab's run alone, and vice versa.
	s.CancelSearch("p")
	if ctxA.Err() != nil {
		t.Fatal("CancelSearch(profile) must not cancel a SearchRun")
	}
	ctxLive2, doneLive2 := s.track("p")
	defer doneLive2()
	if !s.CancelSearchRun("tab-1") || ctxA.Err() == nil {
		t.Fatal("CancelSearchRun did not cancel the run")
	}
	if ctxLive2.Err() != nil {
		t.Fatal("CancelSearchRun must not cancel the panel's search")
	}
	_ = ctxLive

	// A newer run with the same ID cancels the older one; the older one's done keeps the newer entry.
	ctxB1, doneB1 := s.trackRun("tab-2")
	ctxB2, doneB2 := s.trackRun("tab-2")
	if ctxB1.Err() == nil {
		t.Fatal("the older run of the same ID was not cancelled")
	}
	doneB1()
	if _, ok := s.runs["tab-2"]; !ok {
		t.Fatal("the older run's done removed the newer run")
	}
	doneB2()
	doneA()
	if len(s.runs) != 0 {
		t.Fatalf("runs not cleaned up: %v", s.runs)
	}
	if ctxB2.Err() == nil {
		t.Fatal("done must release the run's context")
	}
	if s.CancelSearchRun("tab-2") {
		t.Fatal("CancelSearchRun of a finished run = true, want false")
	}
}

type fakeAttrReader struct {
	entries map[string]map[string]models.LDAPAttribute
	fail    map[string]error
	reads   int
}

func (f *fakeAttrReader) ReadAttributes(dn string, names []string) (map[string]models.LDAPAttribute, error) {
	f.reads++
	if err := f.fail[strings.ToLower(dn)]; err != nil {
		return nil, err
	}
	if e, ok := f.entries[strings.ToLower(dn)]; ok {
		return e, nil
	}
	return nil, goldap.NewError(goldap.LDAPResultNoSuchObject, errors.New("no such object"))
}

func TestReadEntries(t *testing.T) {
	f := &fakeAttrReader{
		entries: map[string]map[string]models.LDAPAttribute{
			"cn=a,dc=x":     {"mail": {Name: "mail", Values: []string{"a@x"}}, "objectclass": {Name: "objectClass", Values: []string{"person"}}, "cn": {Name: "cn", Values: []string{"a"}}},
			"cn=b,dc=x":     {"cn": {Name: "cn", Values: []string{"b"}}},
			"cn=empty,dc=x": {},
		},
		fail: map[string]error{"cn=bad,dc=x": errors.New("insufficient access")},
	}
	res, err := readEntries(f, []string{"cn=a,dc=x", " CN=A, dc=x ", "cn=gone,dc=x", "cn=bad,dc=x", "", "cn=b,dc=x", "cn=empty,dc=x"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Entries) != 2 || res.Entries[0].DN != "cn=a,dc=x" || res.Entries[1].DN != "cn=b,dc=x" {
		t.Fatalf("entries = %+v, want a then b (input order, duplicate read once)", res.Entries)
	}
	if got := res.Entries[0].Attributes; got[0].Name != "objectClass" || got[1].Name != "cn" || got[2].Name != "mail" {
		t.Fatalf("attribute order = %v, want objectClass first, then by name", got)
	}
	if strings.Join(res.Missing, "|") != "cn=gone,dc=x|cn=empty,dc=x" {
		t.Fatalf("missing = %v", res.Missing)
	}
	if len(res.Errors) != 1 || res.Errors[0].DN != "cn=bad,dc=x" {
		t.Fatalf("errors = %v", res.Errors)
	}
	if f.reads != 5 {
		t.Fatalf("reads = %d, want 5 (the duplicate and the empty DN are not read)", f.reads)
	}

	// A lost connection fails the whole call.
	f.fail["cn=b,dc=x"] = fmt.Errorf("read: %w", internalldap.ErrNotConnected)
	if _, err := readEntries(f, []string{"cn=a,dc=x", "cn=b,dc=x"}, []string{"cn"}); err == nil {
		t.Fatal("a lost connection must fail ReadEntries")
	}
}
