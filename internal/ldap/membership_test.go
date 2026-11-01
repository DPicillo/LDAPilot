package ldap

import (
	"encoding/binary"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

func TestNormDN(t *testing.T) {
	same := [][2]string{
		{"CN=Doe\\, John,OU=Users,DC=ex,DC=com", "cn=doe\\2c john, ou=users, dc=EX, dc=com"},
		{"uid=a+cn=b,dc=x", "CN=B+UID=A,DC=X"},
		{"cn=Jürgen,dc=x", "CN=JÜRGEN,DC=x"},
		{" cn=a,dc=x ", "cn=a,dc=x"},
	}
	for _, p := range same {
		if normDN(p[0]) != normDN(p[1]) {
			t.Errorf("normDN(%q)=%q != normDN(%q)=%q", p[0], normDN(p[0]), p[1], normDN(p[1]))
		}
	}
	if normDN("cn=a,dc=x") == normDN("cn=b,dc=x") {
		t.Error("different DNs normalize equally")
	}
	if normDN("cn=a\\,b,dc=x") == normDN("cn=a,cn=b,dc=x") {
		t.Error("escaped comma must not be a separator")
	}
	if got := normDN("not a dn"); got != "not a dn" {
		t.Errorf("unparsable DN: %q", got)
	}
}

func TestDNUnder(t *testing.T) {
	if !dnUnder("cn=a,ou=b,dc=x", "DC=X") || !dnUnder("dc=x", "dc=x") {
		t.Error("expected under")
	}
	if dnUnder("cn=a,dc=xy", "dc=y") || dnUnder("dc=x", "cn=a,dc=x") {
		t.Error("expected not under")
	}
}

func TestRDNHelpers(t *testing.T) {
	if got := rdnValue("CN=Doe\\, John,OU=x"); got != "Doe, John" {
		t.Errorf("rdnValue = %q", got)
	}
	cases := map[string]string{
		"uid=jdoe,ou=People,dc=x": "(uid=jdoe)",
		"cn=C\\2b\\2b (Dev),dc=x": "(cn=C++ \\28Dev\\29)",
		"cn=a*b,dc=x":             "(cn=a\\2ab)",
		"cn=a+sn=b,dc=x":          "(&(cn=a)(sn=b))",
		"CN=Zoë Ångström 日本,DC=x": "(CN=Zo\\c3\\ab \\c3\\85ngstr\\c3\\b6m \\e6\\97\\a5\\e6\\9c\\ac)",
	}
	for dn, want := range cases {
		got, ok := rdnFilter(dn)
		if !ok || got != want {
			t.Errorf("rdnFilter(%q) = %q, %v; want %q", dn, got, ok, want)
		}
	}
	if _, ok := rdnFilter("garbage"); ok {
		t.Error("rdnFilter accepted garbage")
	}
	if got := stripOptionalUID("cn=a,dc=x#'0101'B"); got != "cn=a,dc=x" {
		t.Errorf("stripOptionalUID = %q", got)
	}
	if got := stripOptionalUID("cn=a\\#1,dc=x"); got != "cn=a\\#1,dc=x" {
		t.Errorf("stripOptionalUID changed a plain DN: %q", got)
	}
}

func TestFilters(t *testing.T) {
	if got := chainFilter("member", "CN=A (x)*,DC=x"); got != "(member:1.2.840.113556.1.4.1941:=CN=A \\28x\\29\\2a,DC=x)" {
		t.Errorf("chainFilter = %q", got)
	}
	if got := orFilter([]string{"(a=1)"}); got != "(a=1)" {
		t.Errorf("orFilter single = %q", got)
	}
	if got := orFilter([]string{"(a=1)", "(b=2)"}); got != "(|(a=1)(b=2))" {
		t.Errorf("orFilter = %q", got)
	}
	for _, f := range []string{chainFilter("memberOf", "CN=Doe\\, John,DC=x"), orFilter([]string{"(a=1)", "(b=2)"})} {
		if _, err := goldap.CompileFilter(f); err != nil {
			t.Errorf("filter %q does not compile: %v", f, err)
		}
	}
	if got := chunks([]int{1, 2, 3, 4, 5}, 2); !reflect.DeepEqual(got, [][]int{{1, 2}, {3, 4}, {5}}) {
		t.Errorf("chunks = %v", got)
	}
	if got := chunks([]int{}, 2); len(got) != 0 {
		t.Errorf("chunks(empty) = %v", got)
	}
}

// testSID builds S-1-5-21-a-b-c-rid.
func testSID(rid uint32) []byte {
	sid := []byte{1, 5, 0, 0, 0, 0, 0, 5}
	for _, sub := range []uint32{21, 2935511413, 1781990272, 1200128551, rid} {
		sid = binary.LittleEndian.AppendUint32(sid, sub)
	}
	return sid
}

func TestSIDHelpers(t *testing.T) {
	user := testSID(1198)
	rid, ok := sidRID(user)
	if !ok || rid != 1198 {
		t.Fatalf("sidRID = %d, %v", rid, ok)
	}
	group, ok := sidWithRID(user, 513)
	if !ok {
		t.Fatal("sidWithRID failed")
	}
	if s, _ := formatSID(group); s != "S-1-5-21-2935511413-1781990272-1200128551-513" {
		t.Errorf("group SID = %s", s)
	}
	if s, _ := formatSID(user); s != "S-1-5-21-2935511413-1781990272-1200128551-1198" {
		t.Errorf("sidWithRID modified its input: %s", s)
	}
	dom, ok := sidDomain(user)
	if s, _ := formatSID(dom); !ok || s != "S-1-5-21-2935511413-1781990272-1200128551" {
		t.Errorf("sidDomain = %s", s)
	}
	if got := sidAppendRID(dom, 1198); string(got) != string(user) {
		t.Errorf("sidAppendRID = %v", got)
	}
	if !sameDomain(user, group) {
		t.Error("sameDomain(user, group) = false")
	}
	builtinUsers := []byte{1, 2, 0, 0, 0, 0, 0, 5}
	builtinUsers = binary.LittleEndian.AppendUint32(builtinUsers, 32)
	builtinUsers = binary.LittleEndian.AppendUint32(builtinUsers, 545)
	if sameDomain(user, builtinUsers) {
		t.Error("builtin SID in the account domain")
	}
	if _, ok := sidRID([]byte{1, 5, 0}); ok {
		t.Error("sidRID accepted a short SID")
	}
	if got := escapeBinaryFilter([]byte{0x01, 0xab, 0x2a}); got != "\\01\\ab\\2a" {
		t.Errorf("escapeBinaryFilter = %q", got)
	}
	if rid, ok := parseRID(" 513 "); !ok || rid != 513 {
		t.Errorf("parseRID = %d, %v", rid, ok)
	}
}

func TestObjectTypes(t *testing.T) {
	cases := []struct {
		classes []string
		want    string
	}{
		{[]string{"top", "person", "organizationalPerson", "user"}, models.MemberTypeUser},
		{[]string{"top", "person", "organizationalPerson", "user", "computer"}, models.MemberTypeComputer},
		{[]string{"top", "person", "organizationalPerson", "contact"}, models.MemberTypeContact},
		{[]string{"top", "group"}, models.MemberTypeGroup},
		{[]string{"groupOfNames"}, models.MemberTypeGroup},
		{[]string{"inetOrgPerson", "posixAccount"}, models.MemberTypeUser},
		{[]string{"top", "foreignSecurityPrincipal"}, models.MemberTypeFSP},
		{[]string{"organizationalUnit"}, models.MemberTypeOther},
		// M-05: LDAP devices / hosts are computers.
		{[]string{"top", "device"}, models.MemberTypeComputer},
		{[]string{"device", "ipHost"}, models.MemberTypeComputer},
	}
	for _, c := range cases {
		if got := memberObjectType(c.classes); got != c.want {
			t.Errorf("memberObjectType(%v) = %s, want %s", c.classes, got, c.want)
		}
	}
	attrs := map[string][]string{
		"member":       {"top", "group"},
		"uniqueMember": {"groupOfUniqueNames"},
		"memberUid":    {"posixGroup"},
	}
	for want, classes := range attrs {
		if got := groupMemberAttribute(classes); got != want {
			t.Errorf("groupMemberAttribute(%v) = %s", classes, got)
		}
	}
	if got := groupMemberAttribute([]string{"groupOfNames", "posixGroup"}); got != "member" {
		t.Errorf("rfc2307bis group uses %s", got)
	}
}

// buildGraph creates a graph from "from>to" edges ("from>>to" = primary).
func buildGraph(t *testing.T, root string, edges ...string) (*memGraph, *memNode) {
	t.Helper()
	g := newMemGraph(0)
	r := g.node(root)
	for _, e := range edges {
		primary := ""
		sep := ">"
		if strings.Contains(e, ">>") {
			primary, sep = models.PrimaryGroupAD, ">>"
		}
		parts := strings.SplitN(e, sep, 2)
		g.addEdge(g.node(parts[0]), g.node(parts[1]), primary)
	}
	return g, r
}

func itemsByName(items []models.MembershipItem) map[string]models.MembershipItem {
	out := map[string]models.MembershipItem{}
	for _, it := range items {
		out[it.Name] = it
	}
	return out
}

func TestLayoutNestedPaths(t *testing.T) {
	// deep.user memberOf: L3 (direct), L3 ∈ L2 ∈ L1, primary Domain Users ∈ Users.
	g, root := buildGraph(t, "cn=deep,dc=x",
		"cn=deep,dc=x>cn=L3,dc=x",
		"cn=L3,dc=x>cn=L2,dc=x",
		"cn=L2,dc=x>cn=L1,dc=x",
		"cn=deep,dc=x>>cn=DU,dc=x",
		"cn=DU,dc=x>cn=Users,dc=x",
	)
	res := layoutMembership(g, root, 32, true)
	items := itemsByName(res.items)
	if len(items) != 5 {
		t.Fatalf("items = %v", res.items)
	}
	if it := items["L3"]; !it.Direct || it.Depth != 1 || len(it.Path) != 0 {
		t.Errorf("L3 = %+v", it)
	}
	if it := items["L1"]; it.Direct || it.Depth != 3 || !reflect.DeepEqual(it.Path, []string{"cn=L3,dc=x", "cn=L2,dc=x"}) {
		t.Errorf("L1 = %+v", it)
	}
	if it := items["DU"]; !it.Direct || it.Primary != models.PrimaryGroupAD || !it.PrimaryOnly {
		t.Errorf("DU = %+v", it)
	}
	if it := items["L3"]; it.PrimaryOnly {
		t.Errorf("L3 marked primary only: %+v", it)
	}
	if it := items["Users"]; it.Primary != "" || it.PrimaryOnly || !reflect.DeepEqual(it.Path, []string{"cn=DU,dc=x"}) {
		t.Errorf("Users = %+v", it)
	}
	if len(res.cycles) != 0 || res.depthLimited {
		t.Errorf("cycles = %v, depthLimited = %v", res.cycles, res.depthLimited)
	}
	// Sorted by depth, then name.
	if res.items[0].Depth != 1 || res.items[len(res.items)-1].Name != "L1" {
		t.Errorf("order = %v", res.items)
	}

	r := &models.MembershipResult{Items: res.items}
	summarizeItems(r)
	if r.DirectCount != 2 || r.MaxDepth != 3 || r.TypeCounts[models.MemberTypeUnknown] != 5 {
		t.Errorf("summary = %+v", r)
	}
}

func TestLayoutPrimaryAndPlainEdge(t *testing.T) {
	// POSIX: listed in memberUid and primary group by gidNumber (either
	// order): primary, but still removable from memberUid.
	for _, edges := range [][]string{
		{"cn=u,dc=x>cn=g,dc=x", "cn=u,dc=x>>cn=g,dc=x"},
		{"cn=u,dc=x>>cn=g,dc=x", "cn=u,dc=x>cn=g,dc=x"},
	} {
		g, root := buildGraph(t, "cn=u,dc=x", edges...)
		res := layoutMembership(g, root, 32, true)
		if len(res.items) != 1 {
			t.Fatalf("items = %+v", res.items)
		}
		if it := res.items[0]; it.Primary != models.PrimaryGroupAD || it.PrimaryOnly || !it.Direct {
			t.Errorf("%v: item = %+v", edges, it)
		}
	}
	// Nested below a primary group: the primary marker describes the last
	// link, but only direct items are primary only.
	g, root := buildGraph(t, "cn=parent,dc=x", "cn=parent,dc=x>cn=du,dc=x", "cn=du,dc=x>>cn=u,dc=x")
	res := layoutMembership(g, root, 32, true)
	if it := itemsByName(res.items)["u"]; it.Primary != models.PrimaryGroupAD || it.PrimaryOnly || it.Depth != 2 {
		t.Errorf("nested primary = %+v", it)
	}
}

func TestLayoutShortestPathAndDepthLimit(t *testing.T) {
	g, root := buildGraph(t, "cn=g,dc=x",
		"cn=g,dc=x>cn=a,dc=x",
		"cn=a,dc=x>cn=b,dc=x",
		"cn=b,dc=x>cn=u,dc=x",
		"cn=g,dc=x>cn=u,dc=x",
	)
	res := layoutMembership(g, root, 32, true)
	if it := itemsByName(res.items)["u"]; !it.Direct || it.Depth != 1 {
		t.Errorf("u = %+v (shortest path expected)", it)
	}
	res = layoutMembership(g, root, 1, true)
	if !res.depthLimited || len(res.items) != 2 {
		t.Errorf("depth 1: limited=%v items=%v", res.depthLimited, res.items)
	}
}

func TestLayoutCycles(t *testing.T) {
	// GG-Circular-A ⇄ GG-Circular-B, resolved from A.
	g, root := buildGraph(t, "cn=A,dc=x",
		"cn=A,dc=x>cn=B,dc=x",
		"cn=B,dc=x>cn=A,dc=x",
	)
	res := layoutMembership(g, root, 32, true)
	if len(res.items) != 1 || res.items[0].Name != "B" || !res.items[0].InCycle {
		t.Fatalf("items = %+v", res.items)
	}
	if len(res.cycles) != 1 || !reflect.DeepEqual(res.cycles[0].Path, []string{"cn=A,dc=x", "cn=B,dc=x", "cn=A,dc=x"}) {
		t.Errorf("cycles = %+v", res.cycles)
	}

	// A cycle further down, a self-loop and an acyclic branch.
	g, root = buildGraph(t, "cn=u,dc=x",
		"cn=u,dc=x>cn=p,dc=x",
		"cn=p,dc=x>cn=q,dc=x",
		"cn=q,dc=x>cn=r,dc=x",
		"cn=r,dc=x>cn=p,dc=x",
		"cn=u,dc=x>cn=s,dc=x",
		"cn=s,dc=x>cn=s,dc=x",
		"cn=u,dc=x>cn=t,dc=x",
	)
	res = layoutMembership(g, root, 32, true)
	if len(res.cycles) != 2 {
		t.Fatalf("cycles = %+v", res.cycles)
	}
	if !reflect.DeepEqual(res.cycles[0].Path, []string{"cn=p,dc=x", "cn=q,dc=x", "cn=r,dc=x", "cn=p,dc=x"}) {
		t.Errorf("cycle 0 = %v", res.cycles[0].Path)
	}
	if !reflect.DeepEqual(res.cycles[1].Path, []string{"cn=s,dc=x", "cn=s,dc=x"}) {
		t.Errorf("cycle 1 = %v", res.cycles[1].Path)
	}
	items := itemsByName(res.items)
	if !items["q"].InCycle || !items["s"].InCycle || items["t"].InCycle {
		t.Errorf("inCycle flags: %+v", res.items)
	}
}

func TestLayoutReported(t *testing.T) {
	g, root := buildGraph(t, "cn=u,dc=x", "cn=u,dc=x>cn=a,dc=x")
	g.node("cn=far,dc=x").reported = true
	if res := layoutMembership(g, root, 32, false); len(res.items) != 1 {
		t.Errorf("direct layout includes reported: %v", res.items)
	}
	res := layoutMembership(g, root, 32, true)
	it := itemsByName(res.items)["far"]
	if len(res.items) != 2 || it.Depth != 0 || it.Direct || len(it.Path) != 0 {
		t.Errorf("reported item = %+v", it)
	}
	if res.items[len(res.items)-1].Name != "far" {
		t.Error("items with unknown path must come last")
	}
}

func TestGraphLimitAndUIDNodes(t *testing.T) {
	g := newMemGraph(2)
	root := g.node("cn=root,dc=x")
	for i, dn := range []string{"cn=a,dc=x", "cn=b,dc=x", "cn=c,dc=x"} {
		n := g.node(dn)
		if (n == nil) != (i == 2) {
			t.Errorf("node %d: %v", i, n)
		}
		g.addEdge(root, n, "")
	}
	if !g.full || len(root.edges) != 2 {
		t.Errorf("full=%v edges=%d", g.full, len(root.edges))
	}

	g = newMemGraph(0)
	root = g.node("cn=root,dc=x")
	u := g.uidNode("JDoe")
	g.addEdge(root, u, "")
	g.addEdge(root, g.uidNode("jdoe"), "")
	if len(root.edges) != 1 || !u.unresolved || u.dn != "" || u.name != "JDoe" {
		t.Errorf("uid node = %+v, edges = %d", u, len(root.edges))
	}
	n1, created1 := g.nodeNew("CN=X,DC=x")
	n2, created2 := g.nodeNew("cn=x, dc=X")
	if n1 != n2 || !created1 || created2 {
		t.Error("nodeNew does not match equivalent DNs")
	}
}

func TestMembershipSearchBase(t *testing.T) {
	ad := &models.ServerInfo{
		NamingContexts:       []string{"DC=ad,DC=lab", "CN=Configuration,DC=ad,DC=lab", "DC=DomainDnsZones,DC=ad,DC=lab"},
		DefaultNamingContext: "DC=ad,DC=lab",
	}
	if got := membershipSearchBase(ad, "OU=LDAPilot,DC=ad,DC=lab", "CN=x,DC=ad,DC=lab"); got != "DC=ad,DC=lab" {
		t.Errorf("AD base = %s", got)
	}
	if got := membershipSearchBase(ad, "", "CN=x,CN=Configuration,DC=ad,DC=lab"); got != "CN=Configuration,DC=ad,DC=lab" {
		t.Errorf("longest naming context expected, got %s", got)
	}
	none := &models.ServerInfo{}
	if got := membershipSearchBase(none, "dc=x", "cn=a,dc=x"); got != "dc=x" {
		t.Errorf("fallback to base DN: %s", got)
	}
	if got := membershipSearchBase(&models.ServerInfo{NamingContexts: []string{"dc=y"}}, "", "cn=a,dc=x"); got != "dc=y" {
		t.Errorf("fallback to first naming context: %s", got)
	}
}

func TestIsMembershipNoop(t *testing.T) {
	exists := goldap.NewError(goldap.LDAPResultAttributeOrValueExists, errors.New("exists"))
	adExists := goldap.NewError(goldap.LDAPResultEntryAlreadyExists, errors.New("exists"))
	noAttr := goldap.NewError(goldap.LDAPResultNoSuchAttribute, errors.New("no such"))
	other := goldap.NewError(goldap.LDAPResultInsufficientAccessRights, errors.New("denied"))
	if !IsMembershipNoop("add", writeError("modify entry", exists)) || !IsMembershipNoop("add", adExists) {
		t.Error("duplicate add not recognized")
	}
	if !IsMembershipNoop("delete", noAttr) || IsMembershipNoop("add", noAttr) || IsMembershipNoop("delete", exists) {
		t.Error("delete noop classification wrong")
	}
	samba := goldap.NewError(goldap.LDAPResultUnwillingToPerform, errors.New("Attribute member already deleted for target GUID d9d57ba7"))
	ad := goldap.NewError(goldap.LDAPResultUnwillingToPerform, errors.New("00000561: SvcErr: DSID-031A1254, problem 5003 (WILL_NOT_PERFORM), data 0"))
	unwilling := goldap.NewError(goldap.LDAPResultUnwillingToPerform, errors.New("something else"))
	if !IsMembershipNoop("delete", writeError("modify entry", samba)) || !IsMembershipNoop("delete", ad) {
		t.Error("AD/Samba non-member delete not recognized")
	}
	if IsMembershipNoop("delete", unwilling) || IsMembershipNoop("add", samba) {
		t.Error("other unwillingToPerform errors must not be noops")
	}
	if IsMembershipNoop("add", other) || IsMembershipNoop("add", nil) {
		t.Error("other errors must not be noops")
	}
	viol := goldap.NewError(goldap.LDAPResultObjectClassViolation, errors.New("violation"))
	if MembershipErrorHint("delete", "member", viol) == "" || MembershipErrorHint("add", "member", other) != "" {
		t.Error("MembershipErrorHint")
	}
}

func TestOutsideNamingContexts(t *testing.T) {
	ncs := []string{"DC=ad,DC=example", "CN=Configuration,DC=ad,DC=example", ""}
	cases := []struct {
		dn   string
		ncs  []string
		want bool
	}{
		{"CN=u,OU=x,DC=ad,DC=example", ncs, false},
		{"cn=u,dc=AD,dc=Example", ncs, false},
		{"CN=u,DC=child,DC=ad,DC=example", ncs, false}, // below the parent NC by name
		{"CN=u,DC=other,DC=example", ncs, true},
		{"CN=u,DC=other,DC=example", nil, false},          // unknown: not external
		{"CN=u,DC=other,DC=example", []string{""}, false}, // only empty NCs
	}
	for _, c := range cases {
		if got := outsideNamingContexts(c.dn, c.ncs); got != c.want {
			t.Errorf("outsideNamingContexts(%q, %v) = %v, want %v", c.dn, c.ncs, got, c.want)
		}
	}
}

func TestMatchingMemberValues(t *testing.T) {
	values := []string{
		"uid=a,ou=People,dc=x#'0101'B",
		"uid=a,ou=people,dc=x",
		"UID=A, OU=People, DC=x#'1'B",
		"uid=b,ou=People,dc=x#'0101'B",
		"cn=admin,dc=x",
	}
	got := matchingMemberValues(values, "uid=a,ou=people,dc=x")
	want := []string{"uid=a,ou=People,dc=x#'0101'B", "UID=A, OU=People, DC=x#'1'B"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("matchingMemberValues = %q, want %q", got, want)
	}
	if got := matchingMemberValues(values, "cn=admin,dc=x"); len(got) != 0 {
		t.Errorf("exact value must not be repeated: %q", got)
	}
}

func TestLayoutSelfMembership(t *testing.T) {
	// A group stored as a member of itself (Samba accepts it): listed as a
	// direct, removable self item next to the real members, and as a cycle.
	g, root := buildGraph(t, "cn=g,dc=x",
		"cn=g,dc=x>cn=g,dc=x",
		"cn=g,dc=x>cn=u,dc=x",
	)
	res := layoutMembership(g, root, 32, true)
	items := itemsByName(res.items)
	if len(res.items) != 2 {
		t.Fatalf("items = %+v", res.items)
	}
	self := items["g"]
	if !self.Self || !self.Direct || self.Depth != 1 || !self.InCycle || self.PrimaryOnly || self.DN != "cn=g,dc=x" {
		t.Errorf("self item = %+v", self)
	}
	if it := items["u"]; it.Self || !it.Direct {
		t.Errorf("member = %+v", it)
	}
	if len(res.cycles) != 1 || !reflect.DeepEqual(res.cycles[0].Path, []string{"cn=g,dc=x", "cn=g,dc=x"}) {
		t.Errorf("cycles = %+v", res.cycles)
	}
	// A cycle through another group does not list the root.
	g, root = buildGraph(t, "cn=a,dc=x", "cn=a,dc=x>cn=b,dc=x", "cn=b,dc=x>cn=a,dc=x")
	for _, it := range layoutMembership(g, root, 32, true).items {
		if it.Self || it.Name == "a" {
			t.Errorf("root listed for an indirect cycle: %+v", it)
		}
	}
}

func TestMembershipLogOutcome(t *testing.T) {
	if outcome, err := membershipLogOutcome(ErrSearchCancelled); err != nil || outcome == "" {
		t.Errorf("cancelled: outcome %q, err %v (want no error)", outcome, err)
	}
	if outcome, err := membershipLogOutcome(fmt.Errorf("wrapped: %w", ErrSearchCancelled)); err != nil || outcome == "" {
		t.Errorf("wrapped cancel: outcome %q, err %v", outcome, err)
	}
	other := errors.New("LDAP search failed: no such object")
	if outcome, err := membershipLogOutcome(other); err != other || outcome != "" {
		t.Errorf("failure: outcome %q, err %v", outcome, err)
	}
}
