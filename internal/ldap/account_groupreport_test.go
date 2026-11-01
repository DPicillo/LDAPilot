package ldap

import (
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// ACCT-04: the disabled report covers every AD account kind (computers and
// managed service accounts derive from user) and keeps them by status.
func TestADDisabledReportIncludesComputers(t *testing.T) {
	spec, _, err := adReportSpecFor(models.AccountReportParams{Report: models.AccountReportDisabled}, adPolicySet{}, testNow)
	if err != nil {
		t.Fatal(err)
	}
	if spec.filter != "(&(objectClass=user)(userAccountControl:1.2.840.113556.1.4.803:=2))" {
		t.Errorf("filter = %s", spec.filter)
	}
	if strings.Contains(spec.filter, "objectCategory=person") {
		t.Error("the disabled report must not be limited to persons")
	}
	for _, kind := range []string{models.AccountKindUser, models.AccountKindComputer, models.AccountKindServiceAccount} {
		st := newAccountStatus("cn=x,dc=ad", models.ServerTypeAD, testNow)
		computeADStatus(st, kind, attrsOf("userAccountControl", "4098"), nil, testNow)
		if !spec.match(st) {
			t.Errorf("disabled %s not matched", kind)
		}
	}
	enabled := newAccountStatus("cn=x,dc=ad", models.ServerTypeAD, testNow)
	computeADStatus(enabled, models.AccountKindComputer, attrsOf("userAccountControl", "4096"), nil, testNow)
	if spec.match(enabled) {
		t.Error("enabled computer matched")
	}
}

func TestFillADComplexity(t *testing.T) {
	pol := &models.AccountPolicy{}
	fillADComplexity(pol, attrsOf("pwdProperties", "17"), false)
	if !pol.ComplexityKnown || !pol.ComplexityEnabled || !pol.ReversibleEncryption {
		t.Errorf("domain pwdProperties 17: %+v", pol)
	}
	pol = &models.AccountPolicy{}
	fillADComplexity(pol, attrsOf("pwdProperties", "0"), false)
	if !pol.ComplexityKnown || pol.ComplexityEnabled || pol.ReversibleEncryption {
		t.Errorf("domain pwdProperties 0: %+v", pol)
	}
	pol = &models.AccountPolicy{}
	fillADComplexity(pol, attrsOf("msDS-PasswordComplexityEnabled", "TRUE", "msDS-PasswordReversibleEncryptionEnabled", "FALSE"), true)
	if !pol.ComplexityKnown || !pol.ComplexityEnabled || pol.ReversibleEncryption {
		t.Errorf("pso: %+v", pol)
	}
	pol = &models.AccountPolicy{}
	fillADComplexity(pol, attrsOf(), false)
	if pol.ComplexityKnown {
		t.Error("complexity known without pwdProperties")
	}
	ds := &models.AccountPolicy{}
	fill389Policy(ds, attrsOf("passwordExp", "on", "passwordCheckSyntax", "on"))
	if !ds.ComplexityKnown || !ds.ComplexityEnabled {
		t.Errorf("389ds passwordCheckSyntax: %+v", ds)
	}
}

func sidBytes(sub ...uint32) []byte {
	b := []byte{1, byte(len(sub)), 0, 0, 0, 0, 0, 5}
	for _, s := range sub {
		b = append(b, byte(s), byte(s>>8), byte(s>>16), byte(s>>24))
	}
	return b
}

func entryWith(dn string, attrs map[string][]string, raw map[string][]byte) *goldap.Entry {
	e := goldap.NewEntry(dn, attrs)
	for name, v := range raw {
		e.Attributes = append(e.Attributes, &goldap.EntryAttribute{Name: name, Values: []string{string(v)}, ByteValues: [][]byte{v}})
	}
	return e
}

// ACCT-05: primary groups are found by RID (AD) or gidNumber (POSIX).
func TestPrimaryGroupKey(t *testing.T) {
	domainUsers := entryWith("CN=Domain Users,CN=Users,DC=ad", map[string][]string{"objectClass": {"group"}},
		map[string][]byte{"objectSid": sidBytes(21, 1, 2, 3, 513)})
	if got := primaryGroupKey(domainUsers, models.ServerTypeAD); got != "513" {
		t.Errorf("domain group key = %q", got)
	}
	builtin := entryWith("CN=Administrators,CN=Builtin,DC=ad", map[string][]string{"objectClass": {"group"}},
		map[string][]byte{"objectSid": sidBytes(32, 544)})
	if got := primaryGroupKey(builtin, models.ServerTypeAD); got != "" {
		t.Errorf("builtin group key = %q, want none", got)
	}
	posix := goldap.NewEntry("cn=staff,ou=groups,dc=x", map[string][]string{"objectClass": {"posixGroup"}, "gidNumber": {"5000"}})
	if got := primaryGroupKey(posix, models.ServerTypeOpenLDAP); got != "5000" {
		t.Errorf("posix key = %q", got)
	}
	gon := goldap.NewEntry("cn=g,ou=groups,dc=x", map[string][]string{"objectClass": {"groupOfNames"}, "gidNumber": {"5001"}})
	if got := primaryGroupKey(gon, models.ServerTypeOpenLDAP); got != "" {
		t.Errorf("groupOfNames key = %q", got)
	}
}

func TestReportValuesFilter(t *testing.T) {
	got := reportValuesFilter("primaryGroupID", "", map[string]bool{"515": true, "513": true})
	if got != "(&(|(primaryGroupID=513)(primaryGroupID=515)))" {
		t.Errorf("filter = %s", got)
	}
	got = reportValuesFilter("gidNumber", "(objectClass=posixAccount)", map[string]bool{"5(0)": true})
	if got != `(&(objectClass=posixAccount)(|(gidNumber=5\280\29)))` {
		t.Errorf("escaped filter = %s", got)
	}
}

func TestEmptyGroupsSpecFor(t *testing.T) {
	ad := emptyGroupsSpecFor(models.ServerTypeAD)
	if ad.filter != "(&(objectClass=group)(!(member=*)))" || !acctTestHas(ad.attrs, "objectSid") {
		t.Errorf("ad spec %+v", ad)
	}
	ol := emptyGroupsSpecFor(models.ServerTypeOpenLDAP)
	for _, part := range []string{"groupOfNames", "groupOfUniqueNames", "posixGroup", "!(memberUid=*)"} {
		if !strings.Contains(ol.filter, part) {
			t.Errorf("ldap filter lacks %s: %s", part, ol.filter)
		}
	}
	if _, err := goldap.CompileFilter(ol.filter); err != nil {
		t.Errorf("ldap filter does not compile: %v", err)
	}
}

// ACCT-07: direct, nested and unknown nesting.
func TestPrivilegedVia(t *testing.T) {
	da := acctReportDNKey("CN=Domain Admins,CN=Users,DC=ad,DC=lab")
	nested := map[string]string{
		acctReportDNKey("CN=GG-Tier0,OU=Groups,DC=ad,DC=lab"): "GG-Tier0",
		acctReportDNKey("CN=GG-Ops,OU=Groups,DC=ad,DC=lab"):   "GG-Ops",
	}
	if got := privilegedVia([]string{"cn=domain admins,cn=users,dc=AD,dc=lab"}, da, nested); got != "" {
		t.Errorf("direct = %q", got)
	}
	if got := privilegedVia([]string{"CN=GG-Ops,OU=Groups,DC=ad,DC=lab", "CN=GG-Tier0,OU=Groups,DC=ad,DC=lab", "CN=Other,DC=ad,DC=lab"}, da, nested); got != "GG-Ops, GG-Tier0" {
		t.Errorf("nested = %q", got)
	}
	if got := privilegedVia(nil, da, nested); got != "nested" {
		t.Errorf("unknown = %q", got)
	}
	cols := privilegedColumns(&privilegedMember{groups: []string{"Domain Admins", "Administrators"},
		via: map[string]string{"Domain Admins": "", "Administrators": "Domain Admins"}})
	if cols[acctReportExtraGroups] != "Domain Admins, Administrators" || cols[acctReportExtraVia] != "Administrators ← Domain Admins" {
		t.Errorf("columns %v", cols)
	}
}

func TestBuiltinSID(t *testing.T) {
	sid := builtinSID(544)
	if s, ok := formatSID(sid); !ok || s != "S-1-5-32-544" {
		t.Errorf("builtinSID(544) = %q", s)
	}
	domain := sidBytes(21, 1, 2, 3)
	if s, ok := formatSID(sidAppendRID(domain, 512)); !ok || s != "S-1-5-21-1-2-3-512" {
		t.Errorf("domain admins SID = %q", s)
	}
}

func acctTestHas(list []string, v string) bool {
	for _, x := range list {
		if strings.EqualFold(x, v) {
			return true
		}
	}
	return false
}

// A re-read of group report rows (after an account action on a privileged
// member) asks for the report's own attributes, incl. the status ones.
func TestGroupReportRereadAttrs(t *testing.T) {
	priv := groupReportRereadAttrs(models.AccountReportPrivilegedMembers, models.ServerTypeAD)
	for _, a := range []string{"sAMAccountName", "memberOf", "userAccountControl", "lockoutTime", "msDS-User-Account-Control-Computed"} {
		if !acctTestHas(priv, a) {
			t.Errorf("privileged re-read lacks %s", a)
		}
	}
	if got := groupReportRereadAttrs(models.AccountReportEmptyGroups, models.ServerTypeOpenLDAP); !acctTestHas(got, "gidNumber") || acctTestHas(got, "objectSid") {
		t.Errorf("LDAP empty groups re-read attrs %v", got)
	}
	if got := groupReportRereadAttrs(models.AccountReportEmptyGroups, models.ServerTypeAD); !acctTestHas(got, "objectSid") {
		t.Errorf("AD empty groups re-read attrs %v", got)
	}
}
