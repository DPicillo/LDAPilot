package ldaptools_test

import (
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai/aitest/fake"
	"github.com/dpicillo/LDAPilot/internal/ai/ldaptools"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// UX A-23: find_by_name finds a person by login, display name, first and
// last name or e-mail, best match first.
func TestFindByName(t *testing.T) {
	c := newClient(models.ServerTypeOpenLDAP)
	people := "OU=Users," + base
	c.Put("uid=test.photo,"+people, map[string][]string{"objectClass": {"inetOrgPerson"}, "uid": {"test.photo"}, "cn": {"Test Photo"}, "givenName": {"Test"}, "sn": {"Photo"}, "mail": {"test.photo@corp.test"}})
	c.Put("uid=aschmidt,"+people, map[string][]string{"objectClass": {"inetOrgPerson"}, "uid": {"aschmidt"}, "cn": {"Schmidt, Anna"}, "displayName": {"Anna Schmidt"}, "givenName": {"Anna"}, "sn": {"Schmidt"}})
	c.Put("uid=aschmidt2,"+people, map[string][]string{"objectClass": {"inetOrgPerson"}, "uid": {"aschmidt2"}, "cn": {"Andreas Schmidtke"}, "givenName": {"Andreas"}, "sn": {"Schmidtke"}})
	c.Put("cn=Photographers,"+people, map[string][]string{"objectClass": {"groupOfNames"}, "cn": {"Photographers"}, "member": {"uid=test.photo," + people}})
	s := session(c, false)

	cases := []struct{ args, wantFirst, wantMatch string }{
		{`{"name":"test.photo"}`, "uid=test.photo,", "exact login or e-mail"},
		{`{"name":"Test Photo"}`, "uid=test.photo,", "exact name"},
		{`{"name":"test.photo@corp.test"}`, "uid=test.photo,", "exact login or e-mail"},
		{`{"name":"Anna Schmidt"}`, "uid=aschmidt,", "exact name"},
		{`{"name":"Schmidt, Anna"}`, "uid=aschmidt,", "exact name"},
		{`{"name":"Schmidt Anna"}`, "uid=aschmidt,", "first and last name"},
		{`{"name":"photograph"}`, "cn=Photographers,", "starts with"},
		{`{"name":"photo","type":"group"}`, "cn=Photographers,", "starts with"},
		{`{"name":"graph"}`, "cn=Photographers,", "contains"},
	}
	for _, tc := range cases {
		res, out := run(t, s, c, "find_by_name", tc.args)
		if !res.OK || res.List == nil || len(res.List.Items) == 0 {
			t.Fatalf("%s: %s", tc.args, out)
		}
		if !strings.Contains(out, `"dn":"`+tc.wantFirst) || strings.Index(out, tc.wantFirst) > strings.Index(out, `"match"`) {
			t.Errorf("%s: first match is not %s:\n%s", tc.args, tc.wantFirst, out)
		}
		if !strings.Contains(out, `"match":"`+tc.wantMatch+`"`) {
			t.Errorf("%s: match %q missing:\n%s", tc.args, tc.wantMatch, out)
		}
	}
	res, out := run(t, s, c, "find_by_name", `{"name":"nobody-here"}`)
	if !res.OK || !strings.Contains(out, "do not guess a DN") || res.Summary != "no match" {
		t.Fatalf("no match: %s", out)
	}
	res, _ = run(t, s, c, "find_by_name", `{"name":"Schmid"}`)
	if res.Summary != "2 matches" {
		t.Fatalf("summary %q", res.Summary)
	}
	res, _ = run(t, s, c, "find_by_name", `{"name":"aschmidt2"}`)
	if res.Summary != "1 match" {
		t.Fatalf("summary %q", res.Summary)
	}
}

// The user's redaction list applies to find_by_name: a redacted attribute
// is neither returned nor usable in a filter (no exact or prefix probe).
func TestFindByNameRedaction(t *testing.T) {
	c := newClient(models.ServerTypeOpenLDAP)
	c.Put("uid=test.photo,OU=Users,"+base, map[string][]string{"objectClass": {"inetOrgPerson"}, "uid": {"test.photo"}, "cn": {"Test Photo"},
		"displayName": {"Secret Display"}, "mail": {"private@corp.test"}})
	s := session(c, false)
	s.Redact = func() ldaptools.RedactPolicy {
		return ldaptools.RedactPolicy{User: []string{"mail", "displayName"}, MaskPasswordValues: true}
	}
	res, out := run(t, s, c, "find_by_name", `{"name":"test.photo"}`)
	if !res.OK || !strings.Contains(out, `"login":"test.photo"`) {
		t.Fatalf("%s", out)
	}
	for _, leak := range []string{"private@corp.test", "Secret Display", "(mail=", "(displayName="} {
		if strings.Contains(out, leak) {
			t.Errorf("redacted value or filter %q in:\n%s", leak, out)
		}
	}
	if !strings.Contains(out, `"redacted_attributes":["displayName","mail"]`) {
		t.Errorf("redacted_attributes missing:\n%s", out)
	}
	for _, probe := range []string{"private@corp.test", "priv", "Secret Display"} {
		res, out := run(t, s, c, "find_by_name", `{"name":"`+probe+`"}`)
		if !res.OK || res.Summary != "no match" {
			t.Errorf("%s: a redacted attribute matched:\n%s", probe, out)
		}
	}
	for _, op := range c.Recorded() {
		if op.Op == "search" && (strings.Contains(op.Filter, "mail=") || strings.Contains(op.Filter, "displayName=")) {
			t.Errorf("filter on a redacted attribute sent: %s", op.Filter)
		}
	}
	ad := ldaptools.NameLookupFiltersFor("Anna Schmidt", models.ServerTypeAD, "", func(a string) bool { return a == "sn" })
	if strings.Contains(strings.Join(ad, ""), "anr=") || strings.Contains(strings.Join(ad, ""), "sn=") {
		t.Errorf("ANR or sn with sn redacted: %q", ad)
	}
}

func TestNameLookupFilters(t *testing.T) {
	ad := ldaptools.NameLookupFilters("Anna Schmidt", models.ServerTypeAD, "(objectClass=user)")
	if len(ad) != 3 || !strings.Contains(ad[0], "(anr=Anna Schmidt)") || !strings.Contains(ad[0], "(sAMAccountName=Anna Schmidt)") ||
		!strings.Contains(ad[0], "(&(givenName=Anna)(sn=Schmidt))") || !strings.HasPrefix(ad[0], "(&(objectClass=user)(|") {
		t.Fatalf("%q", ad)
	}
	ol := ldaptools.NameLookupFilters("a*b(c)", models.ServerTypeOpenLDAP, "(objectClass=*)")
	if strings.Contains(ol[0], "anr") || !strings.Contains(ol[0], `(uid=a\2ab\28c\29)`) || !strings.Contains(ol[1], `(uid=a\2ab\28c\29*)`) {
		t.Fatalf("%q", ol)
	}
	if got := ldaptools.NameLookupFilters("x", models.ServerTypeOpenLDAP, ""); len(got) != 1 {
		t.Fatalf("one-letter names only match exactly: %q", got)
	}
	if ldaptools.NameLookupFilters("  ", models.ServerTypeAD, "") != nil {
		t.Fatal("empty name")
	}
}

func TestPluralSummaries(t *testing.T) {
	if ldaptools.Plural(1, "entry", "entries") != "1 entry" || ldaptools.Plural(0, "entry", "entries") != "0 entries" {
		t.Fatal("plural")
	}
}

// UX A-23: find_accounts locked_out names when each lockout started and
// whether it ends by itself or only by an administrator.
func TestFindAccountsLockoutTimes(t *testing.T) {
	c := newClient(models.ServerTypeAD)
	users := "OU=Users," + base
	c.Put("CN=Temp Lock,"+users, map[string][]string{"objectClass": {"user"}, "objectCategory": {"person"}, "sAMAccountName": {"temp"}, "lockoutTime": {"2026-10-31T10:00:00Z"}, "fakeLockedUntil": {"2026-10-31T20:00:00Z"}})
	c.Put("CN=Perm Lock,"+users, map[string][]string{"objectClass": {"user"}, "objectCategory": {"person"}, "sAMAccountName": {"perm"}, "lockoutTime": {"2026-10-30T08:00:00Z"}, "fakeLockedUntil": {"permanent"}})
	s := session(c, false)
	res, out := run(t, s, c, "find_accounts", `{"status":"locked_out"}`)
	if !res.OK || res.Summary != "2 accounts" {
		t.Fatalf("%s", out)
	}
	for _, want := range []string{`"locked_at":"2026-10-31T10:00:00Z"`, `"locked_until":"2026-10-31T20:00:00Z"`, `"lockout_ends":"only when an administrator unlocks the account"`, "never assume a lockout duration"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %s:\n%s", want, out)
		}
	}
}

// UX A-25: the approval card of an AD user create says that AD creates it
// disabled and without a password.
func TestADCreateNote(t *testing.T) {
	c := newClient(models.ServerTypeAD)
	s := session(c, false)
	for args, want := range map[string]string{
		`{"dn":"CN=New User,OU=Users,DC=corp,DC=test","attributes":[{"attribute":"objectClass","values":["user"]},{"attribute":"sAMAccountName","values":["newuser"]}],"explanation":"x"}`: "creates this account disabled and without a password",
		`{"dn":"CN=New User,OU=Users,DC=corp,DC=test","attributes":[{"attribute":"objectClass","values":["user"]},{"attribute":"userAccountControl","values":["512"]}],"explanation":"x"}`: "refuses an enabled account without a password",
		`{"dn":"CN=New Group,OU=Users,DC=corp,DC=test","attributes":[{"attribute":"objectClass","values":["group"]}],"explanation":"x"}`:                                                   "",
	} {
		prep, res := prepare(t, s, c, "create_entry", args)
		if prep == nil {
			t.Fatalf("%s: %s", args, res.Render(4000))
		}
		got := strings.Join(prep.Preview.Warnings, " | ")
		if want == "" && strings.Contains(got, "Active Directory") || want != "" && !strings.Contains(got, want) {
			t.Errorf("%s: warnings %q", args, got)
		}
	}
}

// UX A-25: an AD user create with its own userPrincipalName is not high
// risk; a UPN another entry uses (or a failed check) still is.
func addPartitions(c *fake.FakeClient, domains ...string) {
	parts := "CN=Partitions,CN=Configuration," + base
	c.Put("CN=Configuration,"+base, map[string][]string{"objectClass": {"configuration"}})
	c.Put(parts, map[string][]string{"objectClass": {"crossRefContainer"}})
	c.Put("CN=Configuration,"+parts, map[string][]string{"objectClass": {"crossRef"}, "nCName": {"CN=Configuration," + base}, "systemFlags": {"1"}})
	for i, d := range domains {
		c.Put("CN=D"+strconv.Itoa(i)+","+parts, map[string][]string{"objectClass": {"crossRef"}, "nCName": {d}, "systemFlags": {"3"}})
	}
}

func TestCreateUPNRisk(t *testing.T) {
	c := newClient(models.ServerTypeAD)
	addPartitions(c, base)
	c.Put("CN=Old User,OU=Users,"+base, map[string][]string{"objectClass": {"user"}, "cn": {"Old User"}, "userPrincipalName": {"old@corp.test"}})
	s := session(c, false)
	create := func(upn string) *ldaptools.Prepared {
		t.Helper()
		args := `{"dn":"CN=New User,OU=Users,` + base + `","attributes":[{"attribute":"objectClass","values":["user"]},{"attribute":"sAMAccountName","values":["new.user"]},{"attribute":"userPrincipalName","values":["` + upn + `"]}],"explanation":"x"}`
		p, res := prepare(t, s, c, "create_entry", args)
		if p == nil {
			t.Fatalf("%s: %s", upn, res.Render(4000))
		}
		return p
	}
	if p := create("new.user@corp.test"); p.Preview.Risk != "medium" || p.Preview.GrantScope == nil {
		t.Errorf("unique UPN: risk %s %v", p.Preview.Risk, p.Preview.RiskReasons)
	}
	if p := create("OLD@corp.test"); p.Preview.Risk != "high" || !strings.Contains(strings.Join(p.Preview.RiskReasons, " "), "CN=Old User") {
		t.Errorf("duplicate UPN: risk %s %v", p.Preview.Risk, p.Preview.RiskReasons)
	}
	c.SearchHook = func(p models.SearchParams) error {
		if strings.Contains(p.Filter, "userPrincipalName") {
			return errors.New("busy")
		}
		return nil
	}
	if p := create("x@corp.test"); p.Preview.Risk != "high" {
		t.Errorf("failed check: risk %s %v", p.Preview.Risk, p.Preview.RiskReasons)
	}
	c.SearchHook = nil
	// A profile scoped to an OU still checks the whole domain (UPNs are
	// unique per forest): Administrator in CN=Users is outside OU=Users.
	c.Put("CN=Administrator,CN=Users,"+base, map[string][]string{"objectClass": {"user"}, "cn": {"Administrator"}, "userPrincipalName": {"administrator@corp.test"}})
	ou := fake.NewFakeClient(ldaptools.ConnInfo{ProfileID: "p1", Name: "Lab", Host: "h", BaseDN: "OU=Users," + base, TLSMode: "ssl", Timeout: 5 * time.Second}, c.SI)
	ou.AttrDefs, ou.ClassDefs = c.AttrDefs, c.ClassDefs
	ou.Clock = c.Clock
	for _, e := range []string{base, "OU=Users," + base, "CN=Administrator,CN=Users," + base, "CN=Configuration," + base, "CN=Partitions,CN=Configuration," + base,
		"CN=Configuration,CN=Partitions,CN=Configuration," + base, "CN=D0,CN=Partitions,CN=Configuration," + base} {
		if x := c.Get(e); x != nil {
			m := map[string][]string{}
			for _, a := range x.Attributes {
				m[a.Name] = a.Values
			}
			ou.Put(x.DN, m)
		}
	}
	so := session(ou, false)
	pOU, res := prepare(t, so, ou, "create_entry", `{"dn":"CN=New User,OU=Users,`+base+`","attributes":[{"attribute":"objectClass","values":["user"]},{"attribute":"userPrincipalName","values":["administrator@corp.test"]}],"explanation":"x"}`)
	if pOU == nil {
		t.Fatalf("%s", res.Render(4000))
	}
	if pOU.Preview.Risk != "high" || !strings.Contains(strings.Join(pOU.Preview.RiskReasons, " "), "CN=Administrator") {
		t.Errorf("OU-scoped profile: risk %s %v", pOU.Preview.Risk, pOU.Preview.RiskReasons)
	}
	// Another domain in the forest: it cannot be searched here, so high.
	addPartitions(c, base, "DC=child,"+base)
	if p := create("fresh@corp.test"); p.Preview.Risk != "high" || !strings.Contains(strings.Join(p.Preview.RiskReasons, " "), "other domains") {
		t.Errorf("multi-domain forest: risk %s %v", p.Preview.Risk, p.Preview.RiskReasons)
	}
	// modify_entry keeps userPrincipalName high risk (§6.3)
	p, _ := prepare(t, s, c, "modify_entry", `{"dn":"`+anna+`","changes":[{"operation":"replace","attribute":"userPrincipalName","values":["anna@corp.test"]}],"explanation":"x"}`)
	if p == nil || p.Preview.Risk != "high" {
		t.Error("modifying userPrincipalName is not high risk")
	}
}

// Card summaries are pluralized (A-22/A-23: "0 user", "1 entries").
func TestCountSummaryPlural(t *testing.T) {
	c := newClient(models.ServerTypeAD)
	c.Put("OU=Bulk,"+base, map[string][]string{"objectClass": {"organizationalUnit"}, "ou": {"Bulk"}})
	c.Put("CN=C1,OU=Bulk,"+base, map[string][]string{"objectClass": {"contact"}, "cn": {"C1"}})
	c.Put("CN=C2,OU=Bulk,"+base, map[string][]string{"objectClass": {"contact"}, "cn": {"C2"}})
	s := session(c, false)
	res, _ := run(t, s, c, "count_entries", `{"container":"OU=Bulk","object_type":"user"}`)
	if res.Summary != "0 users · 2 other entries" {
		t.Errorf("summary %q", res.Summary)
	}
}
