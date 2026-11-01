package services

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

func TestRestoreOrderParentsFirst(t *testing.T) {
	ou := `OU=Proj\0ADEL:1,CN=Deleted Objects,DC=ad`
	sub := `OU=Sub\0ADEL:2,CN=Deleted Objects,DC=ad`
	user := `CN=u\0ADEL:3,CN=Deleted Objects,DC=ad`
	other := `CN=o\0ADEL:4,CN=Deleted Objects,DC=ad`
	reqs := []models.RestoreRequest{{DN: user}, {DN: other}, {DN: sub}, {DN: ou}}
	objs := []*models.DeletedObject{
		{DN: user, LastKnownParent: sub},
		{DN: other, LastKnownParent: "OU=Live,DC=ad"},
		{DN: sub, LastKnownParent: ou},
		{DN: ou, LastKnownParent: "DC=ad"},
	}
	order := restoreOrder(reqs, objs)
	pos := map[string]int{}
	for p, i := range order {
		pos[reqs[i].DN] = p
	}
	if !(pos[ou] < pos[sub] && pos[sub] < pos[user]) {
		t.Errorf("parents must come first: order %v", order)
	}
	if len(order) != 4 {
		t.Fatalf("order %v", order)
	}

	// unreadable objects and cycles must not hang or drop requests
	objs[3] = nil
	objs[1].LastKnownParent = other
	order = restoreOrder(reqs, objs)
	sorted := slices.Clone(order)
	slices.Sort(sorted)
	if !slices.Equal(sorted, []int{0, 1, 2, 3}) {
		t.Errorf("order %v", order)
	}
}

func TestResolveSubtreeMethod(t *testing.T) {
	cases := []struct {
		method    string
		supported bool
		want      string
		wantErr   bool
	}{
		{"", true, models.SubtreeDeleteTreeDelete, false},
		{"auto", false, models.SubtreeDeleteClientSide, false},
		{"treeDelete", true, models.SubtreeDeleteTreeDelete, false},
		{"treeDelete", false, "", true},
		{"clientSide", true, models.SubtreeDeleteClientSide, false},
		{"bogus", true, "", true},
	}
	for _, c := range cases {
		got, err := resolveSubtreeMethod(c.method, c.supported)
		if (err != nil) != c.wantErr || got != c.want {
			t.Errorf("resolveSubtreeMethod(%q, %v) = %q, %v", c.method, c.supported, got, err)
		}
	}
}

func TestDeletedParentDisplayName(t *testing.T) {
	if got := deletedParentDisplayName(`OU=Old Project\0ADEL:ec31b532-9e70,CN=Deleted Objects,DC=ad`); got != "OU=Old Project" {
		t.Errorf("got %q", got)
	}
	if got := deletedParentDisplayName("OU=Live,DC=ad"); got != "OU=Live" {
		t.Errorf("got %q", got)
	}
}

func TestDeleteSubtreeNeedsConfirmation(t *testing.T) {
	s := NewEditorService(nil)
	_, err := s.DeleteSubtree("p", "OU=x,DC=y", models.SubtreeDeleteOptions{})
	if err == nil || !strings.Contains(err.Error(), "confirmation") {
		t.Errorf("expected confirmation error, got %v", err)
	}
}

func TestDeletedParentKey(t *testing.T) {
	child := &models.DeletedObject{LastKnownParent: `OU=Proj\0ADEL:1,CN=Deleted Objects,DC=ad`, ParentDeleted: true}
	if got := deletedParentKey(child, nil); got == "" || !strings.Contains(got, "deleted objects") {
		t.Errorf("got %q", got)
	}
	if got := deletedParentKey(child, errors.New("x")); got != "" {
		t.Errorf("read error: got %q", got)
	}
	if got := deletedParentKey(nil, nil); got != "" {
		t.Errorf("nil: got %q", got)
	}
	if got := deletedParentKey(&models.DeletedObject{LastKnownParent: "OU=Live,DC=ad"}, nil); got != "" {
		t.Errorf("live parent: got %q", got)
	}
}

func TestSubtreeDeleteErrorMessage(t *testing.T) {
	denied := goldap.NewError(goldap.LDAPResultInsufficientAccessRights, errors.New("denied"))
	if got := subtreeDeleteErrorMessage(denied, true); !strings.Contains(got, "accidental deletion") {
		t.Errorf("AD hint missing: %q", got)
	}
	if got := subtreeDeleteErrorMessage(denied, false); strings.Contains(got, "accidental") || !strings.Contains(got, "insufficient rights") {
		t.Errorf("non-AD hint: %q", got)
	}
	nonLeaf := goldap.NewError(goldap.LDAPResultNotAllowedOnNonLeaf, errors.New("x"))
	if got := subtreeDeleteErrorMessage(nonLeaf, false); !strings.Contains(got, "children") {
		t.Errorf("non-leaf: %q", got)
	}
}

func TestLeftoverDeleted(t *testing.T) {
	cases := []struct{ total, remaining, want int }{
		{35, 34, 0},  // nothing gone: root + 34 descendants left
		{35, 20, 14}, // 14 descendants gone
		{35, 0, 34},  // only the root is left
		{5, 10, 0},   // more than before (created concurrently): never negative
	}
	for _, c := range cases {
		if got := leftoverDeleted(c.total, c.remaining); got != c.want {
			t.Errorf("leftoverDeleted(%d, %d) = %d, want %d", c.total, c.remaining, got, c.want)
		}
	}
}

func TestBatchMoveTargetProblem(t *testing.T) {
	dns := []string{"CN=Doe\\, John,OU=A,DC=x", "uid=u1,ou=People,dc=x"}
	cases := []struct {
		target string
		bad    bool
	}{
		{"", true},
		{"OU=B,DC=x", false},
		{"ou=people,dc=x", false}, // the current parent: unchanged, not refused
		{"cn=doe\\, john, ou=a, dc=x", true},
		{"OU=Sub,CN=Doe\\, John,OU=A,DC=x", true},
		{"OU=A,DC=x", false},
	}
	for _, c := range cases {
		if got := batchMoveTargetProblem(dns, c.target); (got != "") != c.bad {
			t.Errorf("batchMoveTargetProblem(%q) = %q, want problem=%v", c.target, got, c.bad)
		}
	}
	if !batchSameDN(batchParentDN("uid=u1,ou=People,dc=x"), "OU=people, DC=x") {
		t.Error("same parent not recognised")
	}
	if batchSameDN("", "") {
		t.Error("empty parents must not count as the same container")
	}
}

func TestRecordDeletedDN(t *testing.T) {
	r := &models.SubtreeDeleteResult{}
	for i := 0; i < models.SubtreeDeletedDNsLimit+2; i++ {
		recordDeletedDN(r, "cn=x")
	}
	if len(r.DeletedDNs) != models.SubtreeDeletedDNsLimit || !r.DeletedDNsTruncated {
		t.Errorf("deleted DNs = %d, truncated = %v", len(r.DeletedDNs), r.DeletedDNsTruncated)
	}
}
