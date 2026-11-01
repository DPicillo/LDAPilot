package ldap

import (
	"errors"
	"fmt"
	"slices"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

func TestSplitDeletedName(t *testing.T) {
	cases := []struct{ in, name, guid string }{
		{"rc-probe1\nDEL:1c16176f-eda1-4482-812c-ef1af9bc7a36", "rc-probe1", "1c16176f-eda1-4482-812c-ef1af9bc7a36"},
		{`Temp Deleted 3\0ADEL:83757001-78ac-4260-bc14-0791c9430bb0`, "Temp Deleted 3", "83757001-78ac-4260-bc14-0791c9430bb0"},
		{"plain", "plain", ""},
		{"", "", ""},
	}
	for _, c := range cases {
		name, guid := splitDeletedName(c.in)
		if name != c.name || guid != c.guid {
			t.Errorf("splitDeletedName(%q) = %q, %q; want %q, %q", c.in, name, guid, c.name, c.guid)
		}
	}
}

func TestDeletedRDN(t *testing.T) {
	cases := []struct{ dn, typ, val string }{
		{`CN=rc-probe1\0ADEL:1c16176f-eda1-4482-812c-ef1af9bc7a36,CN=Deleted Objects,DC=ad,DC=lab`, "CN", "rc-probe1"},
		{`OU=Old Project\0ADEL:ec31b532-9e70-4006-b7f8-c3aa27f7e346,CN=Deleted Objects,DC=ad,DC=lab`, "OU", "Old Project"},
		{`CN=Smith\, John\0ADEL:0fa07687-2b5a-49dd-af0a-c903ca7f6c36,CN=Deleted Objects,DC=ad,DC=lab`, "CN", "Smith, John"},
		{`CN=live,OU=x,DC=ad`, "CN", "live"},
	}
	for _, c := range cases {
		typ, val := deletedRDN(c.dn)
		if typ != c.typ || val != c.val {
			t.Errorf("deletedRDN(%q) = %q, %q; want %q, %q", c.dn, typ, val, c.typ, c.val)
		}
	}
}

func TestBuildRestoreDN(t *testing.T) {
	if got := BuildRestoreDN("CN", "Smith, John", "OU=Users,DC=ad"); got != `CN=Smith\, John,OU=Users,DC=ad` {
		t.Errorf("got %q", got)
	}
	if got := BuildRestoreDN("OU", "Old Project", "DC=ad,DC=lab"); got != "OU=Old Project,DC=ad,DC=lab" {
		t.Errorf("got %q", got)
	}
	if got := BuildRestoreDN("CN", "a+b#", "DC=x"); got != `CN=a\+b#,DC=x` {
		t.Errorf("got %q", got)
	}
}

func TestClassifyDeleted(t *testing.T) {
	cases := []struct {
		recycled, bin bool
		state         string
		restorable    bool
	}{
		{false, false, models.DeletedStateTombstone, true},
		{true, false, models.DeletedStateTombstone, true}, // 2008 R2+/Samba set isRecycled on tombstones
		{false, true, models.DeletedStateDeleted, true},
		{true, true, models.DeletedStateRecycled, false},
	}
	for _, c := range cases {
		state, ok := classifyDeleted(c.recycled, c.bin)
		if state != c.state || ok != c.restorable {
			t.Errorf("classifyDeleted(%v, %v) = %q, %v", c.recycled, c.bin, state, ok)
		}
	}
}

func TestRecycleBinEnabledIn(t *testing.T) {
	if recycleBinEnabledIn(nil) {
		t.Error("nil should be disabled")
	}
	if !recycleBinEnabledIn([]string{"CN=Recycle Bin Feature,CN=Optional Features,CN=Directory Service,CN=Windows NT,CN=Services,CN=Configuration,DC=x"}) {
		t.Error("feature DN not recognised")
	}
	if recycleBinEnabledIn([]string{"CN=Privileged Access Management Feature,CN=Optional Features,CN=Directory Service,CN=Windows NT,CN=Services,CN=Configuration,DC=x"}) {
		t.Error("other feature taken as recycle bin")
	}
}

func TestRecycleTimeRFC3339(t *testing.T) {
	cases := map[string]string{
		"20261029225435.0Z": "2026-10-29T22:54:35Z",
		"20261029225435Z":   "2026-10-29T22:54:35Z",
		"":                  "",
		"garbage":           "garbage",
	}
	for in, want := range cases {
		if got := recycleTimeRFC3339(in); got != want {
			t.Errorf("recycleTimeRFC3339(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDeletedObjectsFilter(t *testing.T) {
	if got := deletedObjectsFilter("  "); got != "(isDeleted=TRUE)" {
		t.Errorf("empty: %q", got)
	}
	got := deletedObjectsFilter("a*(b)")
	want := `(&(isDeleted=TRUE)(|(name=*a\2a\28b\29*)(msDS-LastKnownRDN=*a\2a\28b\29*)(sAMAccountName=*a\2a\28b\29*)))`
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
	if _, err := goldap.CompileFilter(got); err != nil {
		t.Errorf("filter does not compile: %v", err)
	}
}

func TestRecycleParentDNAndDepth(t *testing.T) {
	cases := []struct {
		dn, parent string
		depth      int
	}{
		{"CN=a,OU=b,DC=c", "OU=b,DC=c", 3},
		{`CN=Smith\, John,OU=b,DC=c`, "OU=b,DC=c", 3},
		{`CN=x\0ADEL:abc,CN=Deleted Objects,DC=c`, "CN=Deleted Objects,DC=c", 3},
		{"DC=c", "", 1},
		{"", "", 0},
	}
	for _, c := range cases {
		if got := RecycleParentDN(c.dn); got != c.parent {
			t.Errorf("RecycleParentDN(%q) = %q, want %q", c.dn, got, c.parent)
		}
		if got := recycleDNDepth(c.dn); got != c.depth {
			t.Errorf("recycleDNDepth(%q) = %d, want %d", c.dn, got, c.depth)
		}
	}
}

func TestSortDeepestFirst(t *testing.T) {
	in := []string{
		"OU=root,DC=x",
		"OU=a,OU=root,DC=x",
		"CN=u1,OU=a,OU=root,DC=x",
		`CN=Smith\, J,OU=root,DC=x`,
		"CN=u2,OU=a,OU=root,DC=x",
	}
	got := SortDeepestFirst(in)
	want := []string{
		"CN=u1,OU=a,OU=root,DC=x",
		"CN=u2,OU=a,OU=root,DC=x",
		"OU=a,OU=root,DC=x",
		`CN=Smith\, J,OU=root,DC=x`,
		"OU=root,DC=x",
	}
	if !slices.Equal(got, want) {
		t.Errorf("got %v\nwant %v", got, want)
	}
	// every entry must come before its parent
	pos := map[string]int{}
	for i, dn := range got {
		pos[RecycleDNKey(dn)] = i
	}
	for i, dn := range got {
		if p, ok := pos[RecycleDNKey(RecycleParentDN(dn))]; ok && p < i {
			t.Errorf("%s comes after its parent", dn)
		}
	}
}

func TestRecycleDNKeyAndDeletedDN(t *testing.T) {
	if RecycleDNKey("CN=A, OU=B,DC=C") != RecycleDNKey("cn=a,ou=b,dc=c") {
		t.Error("RecycleDNKey should ignore case and spacing")
	}
	if !IsDeletedObjectDN(`OU=Track\0ADEL:e751ab5f,CN=Deleted Objects,DC=ad`) {
		t.Error("deleted DN not recognised")
	}
	if IsDeletedObjectDN("OU=Users,DC=ad") {
		t.Error("live DN taken as deleted")
	}
}

func TestClassifyRestoreError(t *testing.T) {
	wrap := func(code uint16) error {
		return writeError("restore deleted object", goldap.NewError(code, errors.New("x")))
	}
	cases := []struct {
		err  error
		kind string
	}{
		{nil, ""},
		{ErrReadOnly, models.RestoreErrReadOnly},
		{wrap(goldap.LDAPResultEntryAlreadyExists), models.RestoreErrConflict},
		{wrap(goldap.LDAPResultConstraintViolation), models.RestoreErrConflict},
		{wrap(goldap.LDAPResultInsufficientAccessRights), models.RestoreErrPermission},
		{wrap(goldap.LDAPResultNoSuchObject), models.RestoreErrParentMissing},
		{wrap(goldap.LDAPResultNamingViolation), models.RestoreErrInvalidTarget},
		{wrap(goldap.LDAPResultUnwillingToPerform), models.RestoreErrNotRestorable},
		{fmt.Errorf("boom"), models.RestoreErrOther},
	}
	for _, c := range cases {
		if got := ClassifyRestoreError(c.err); got != c.kind {
			t.Errorf("ClassifyRestoreError(%v) = %q, want %q", c.err, got, c.kind)
		}
	}
}

func TestDeletedObjectsNamingContexts(t *testing.T) {
	info := &models.ServerInfo{
		DefaultNamingContext:       "DC=ad,DC=lab",
		ConfigurationNamingContext: "CN=Configuration,DC=ad,DC=lab",
		SchemaNamingContext:        "CN=Schema,CN=Configuration,DC=ad,DC=lab",
		NamingContexts: []string{
			"CN=Configuration,DC=ad,DC=lab",
			"CN=Schema,CN=Configuration,DC=ad,DC=lab",
			"DC=DomainDnsZones,DC=ad,DC=lab",
			"dc=ad,dc=lab",
			"DC=child,DC=ad,DC=lab",
		},
	}
	got := deletedObjectsNamingContexts(info)
	want := []string{"DC=ad,DC=lab", "DC=child,DC=ad,DC=lab", "DC=DomainDnsZones,DC=ad,DC=lab", "CN=Configuration,DC=ad,DC=lab"}
	if !slices.Equal(got, want) {
		t.Errorf("got %v want %v", got, want)
	}
	if k := recycleNamingContextKind("DC=ForestDnsZones,DC=ad,DC=lab", info); k != models.NamingContextApplication {
		t.Errorf("kind = %q", k)
	}
}

func TestDeletedObjectFromEntry(t *testing.T) {
	sid := []byte{1, 5, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0, 0x75, 0x59, 0xf8, 0xae, 0x80, 0x03, 0x37, 0x6a, 0x27, 0x82, 0x88, 0x47, 0xfa, 0x04, 0, 0}
	e := goldap.NewEntry(`CN=rc-probe1\0ADEL:1c16176f-eda1-4482-812c-ef1af9bc7a36,CN=Deleted Objects,DC=ad,DC=lab`, map[string][]string{
		"objectClass":     {"top", "person", "organizationalPerson", "user"},
		"name":            {"rc-probe1\nDEL:1c16176f-eda1-4482-812c-ef1af9bc7a36"},
		"lastKnownParent": {"OU=Track-recycle,OU=LDAPilot,DC=ad,DC=lab"},
		"whenChanged":     {"20261029225435.0Z"},
		"isRecycled":      {"TRUE"},
		"objectSid":       {string(sid)},
	})
	obj := deletedObjectFromEntry(e, false, "DC=ad,DC=lab")
	if obj.Name != "rc-probe1" || obj.RDNAttribute != "CN" || obj.StructuralClass != "user" {
		t.Errorf("unexpected %+v", obj)
	}
	if obj.State != models.DeletedStateTombstone || !obj.Restorable || obj.ParentDeleted {
		t.Errorf("state %+v", obj)
	}
	if obj.OriginalDN != "CN=rc-probe1,OU=Track-recycle,OU=LDAPilot,DC=ad,DC=lab" {
		t.Errorf("original DN %q", obj.OriginalDN)
	}
	if obj.ObjectSID == "" || obj.ObjectSID[:4] != "S-1-" {
		t.Errorf("sid %q", obj.ObjectSID)
	}
	if obj.DeletedAt != "2026-10-29T22:54:35Z" {
		t.Errorf("deletedAt %q", obj.DeletedAt)
	}

	child := goldap.NewEntry(`CN=c\0ADEL:60a35b16,CN=Deleted Objects,DC=ad`, map[string][]string{
		"objectClass":       {"top", "contact"},
		"msDS-LastKnownRDN": {"child one"},
		"lastKnownParent":   {`OU=f2tree\0ADEL:ec31b532,CN=Deleted Objects,DC=ad`},
		"isRecycled":        {"TRUE"},
	})
	co := deletedObjectFromEntry(child, true, "")
	if co.Name != "child one" || !co.ParentDeleted || co.State != models.DeletedStateRecycled || co.Restorable {
		t.Errorf("child %+v", co)
	}
}

func TestDeletedObjectNamingContext(t *testing.T) {
	if got := DeletedObjectNamingContext(`CN=u\0ADEL:1,CN=Deleted Objects,DC=ad,DC=lab`); got != "DC=ad,DC=lab" {
		t.Errorf("got %q", got)
	}
	if got := DeletedObjectNamingContext(`CN=u\0ADEL:1,CN=Deleted Objects,CN=Configuration,DC=ad`); got != "CN=Configuration,DC=ad" {
		t.Errorf("got %q", got)
	}
	if got := DeletedObjectNamingContext("CN=u,OU=x,DC=ad"); got != "" {
		t.Errorf("got %q", got)
	}
}

func TestNewestFirstSortControl(t *testing.T) {
	ctrl := newestFirstSortControl()
	if ctrl.GetControlType() != goldap.ControlTypeServerSideSorting {
		t.Fatalf("type %s", ctrl.GetControlType())
	}
	value := derReverseSortKeyList("whenChanged")
	want := "\x30\x12\x30\x10\x04\x0bwhenChanged\x81\x01\xff"
	if value != want {
		t.Errorf("value % x, want % x", value, want)
	}
	// Decodes as a sort control with reverse order; not critical.
	decoded, err := goldap.DecodeControl(ctrl.Encode())
	if err != nil {
		t.Fatal(err)
	}
	sortCtrl, ok := decoded.(*goldap.ControlServerSideSorting)
	if !ok || len(sortCtrl.SortKeys) != 1 || sortCtrl.SortKeys[0].AttributeType != "whenChanged" || !sortCtrl.SortKeys[0].Reverse {
		t.Errorf("decoded %#v", decoded)
	}
	if len(ctrl.Encode().Children) != 2 {
		t.Errorf("control should carry type and value only (not critical)")
	}
}
