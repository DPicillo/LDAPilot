package ldaptools_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ai/aitest/fake"
	"github.com/dpicillo/LDAPilot/internal/ai/ldaptools"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
	"github.com/dpicillo/LDAPilot/internal/models"
)

func prepare(t *testing.T, s *ldaptools.Session, c *fake.FakeClient, name, args string) (*ldaptools.Prepared, *tools.Result) {
	t.Helper()
	tool := ldaptools.Lookup(name)
	a, _, err := tools.Validate(tool.Def().Params, json.RawMessage(args))
	if err != nil {
		t.Fatalf("validate %s: %v", name, err)
	}
	call := &ldaptools.Call{ID: "tc", Tool: name, Args: a, Conn: s.Conns[0], Client: c}
	return tool.(ldaptools.Writer).Prepare(context.Background(), s, call)
}

func TestProtectedAreasRefused(t *testing.T) {
	c := newClient(models.ServerTypeOpenLDAP)
	s := session(c, false)
	for _, dn := range []string{"olcDatabase={1}mdb,cn=config", "cn=schema,cn=config", "CN=Schema,CN=Configuration," + base, "CN=Sites,CN=Configuration," + base} {
		_, res := prepare(t, s, c, "modify_entry", `{"dn":"`+dn+`","changes":[{"operation":"replace","attribute":"description","values":["x"]}],"explanation":"x"}`)
		if res == nil || res.Code() != tools.ErrProtectedArea {
			t.Errorf("%s not refused: %+v", dn, res)
		}
	}
}

func TestRiskBySID(t *testing.T) {
	c := newClient(models.ServerTypeAD)
	groups := map[string]map[string][]string{
		"CN=Domänen-Admins," + base:       {"objectClass": {"group"}, "objectSid": {"S-1-5-21-1-2-3-512"}},
		"CN=Organisations-Admins," + base: {"objectClass": {"group"}, "objectSid": {"S-1-5-21-1-2-3-519"}},
		"CN=Administratoren," + base:      {"objectClass": {"group"}, "objectSid": {"S-1-5-32-544"}},
		"CN=Prot," + base:                 {"objectClass": {"user"}, "adminCount": {"1"}},
		"CN=DnsAdmins," + base:            {"objectClass": {"group"}, "sAMAccountName": {"DnsAdmins"}, "objectSid": {"S-1-5-21-1-2-3-1101"}},
		"CN=DC1," + base:                  {"objectClass": {"computer"}, "userAccountControl": {"532480"}},
	}
	for dn, attrs := range groups {
		c.Put(dn, attrs)
	}
	s := session(c, false)
	for dn := range groups {
		p, res := prepare(t, s, c, "modify_entry", `{"dn":"`+dn+`","changes":[{"operation":"replace","attribute":"description","values":["x"]}],"explanation":"x"}`)
		if res != nil {
			t.Fatalf("%s: %s", dn, res.Render(0))
		}
		if p.Preview.Risk != "high" || p.Preview.GrantScope != nil {
			t.Errorf("%s risk %s %v", dn, p.Preview.Risk, p.Preview.RiskReasons)
		}
	}
	p, _ := prepare(t, s, c, "modify_entry", `{"dn":"`+anna+`","changes":[{"operation":"replace","attribute":"servicePrincipalName","values":["HTTP/x"]}],"explanation":"x"}`)
	if p.Preview.Risk != "high" {
		t.Error("servicePrincipalName not high risk")
	}
	p, _ = prepare(t, s, c, "modify_entry", `{"dn":"`+anna+`","changes":[{"operation":"replace","attribute":"description","values":["ok"]}],"explanation":"x"}`)
	if p.Preview.Risk != "medium" || p.Preview.GrantScope == nil {
		t.Errorf("plain change: %+v", p.Preview)
	}
	p, _ = prepare(t, s, c, "create_entry", `{"dn":"CN=PC9,`+base+`","attributes":[{"attribute":"objectClass","values":["computer"]},{"attribute":"cn","values":["PC9"]}],"explanation":"x"}`)
	if p == nil || p.Preview.Risk != "high" {
		t.Error("creating a computer is not high risk")
	}
}

func TestModifyRejections(t *testing.T) {
	c := newClient(models.ServerTypeAD)
	s := session(c, false)
	for _, tc := range []struct{ args, code string }{
		{`{"dn":"` + anna + `","changes":[{"operation":"replace","attribute":"unicodePwd","values":["x"]}],"explanation":"x"}`, tools.ErrRedactedAttribute},
		{`{"dn":"` + anna + `","changes":[{"operation":"replace","attribute":"2.5.4.35","values":["x"]}],"explanation":"x"}`, tools.ErrRedactedAttribute},
		{`{"dn":"` + anna + `","changes":[{"operation":"replace","attribute":"jpegPhoto","values":["x"]}],"explanation":"x"}`, tools.ErrInvalidArguments},
		{`{"dn":"` + anna + `","changes":[{"operation":"replace","attribute":"cn","values":["x"]}],"explanation":"x"}`, tools.ErrInvalidArguments},
		{`{"dn":"` + anna + `","changes":[{"operation":"add","attribute":"mail"}],"explanation":"x"}`, tools.ErrInvalidArguments},
		{`{"dn":"CN=Nobody,` + base + `","changes":[{"operation":"replace","attribute":"description","values":["x"]}],"explanation":"x"}`, tools.ErrNoSuchObject},
		{`{"dn":"` + anna + `","changes":[{"operation":"replace","attribute":"description","values":["` + strings.Repeat("x", 60000) + `","` + strings.Repeat("y", 60000) + `","` + strings.Repeat("z", 60000) + `","` + strings.Repeat("w", 60000) + `","` + strings.Repeat("v", 60000) + `"]}],"explanation":"x"}`, tools.ErrInvalidArguments},
	} {
		_, res := prepare(t, s, c, "modify_entry", tc.args)
		if res == nil || res.Code() != tc.code {
			t.Errorf("%.80s → %v, want %s", tc.args, res, tc.code)
		}
	}
}

func TestAssertionAndEntryChanged(t *testing.T) {
	// With the assertion control the before-state is checked by the server.
	c := newClient(models.ServerTypeOpenLDAP, "1.3.6.1.1.12")
	s := session(c, false)
	p, res := prepare(t, s, c, "modify_entry", `{"dn":"`+anna+`","changes":[{"operation":"replace","attribute":"description","values":["new"]}],"explanation":"x"}`)
	if res != nil {
		t.Fatal(res.Render(0))
	}
	if !p.Preview.Assertion {
		t.Fatal("assertion not used")
	}
	c.Put(anna, map[string][]string{"objectClass": {"person"}, "cn": {"Anna"}, "description": {"changed meanwhile"}})
	out, _ := p.Execute(context.Background())
	if out.Code() != tools.ErrEntryChanged {
		t.Fatalf("assertion: %s", out.Render(0))
	}
	var sawAssert bool
	for _, op := range c.Recorded() {
		if op.Op == "modify" && strings.Contains(op.Assert, "description") {
			sawAssert = true
		}
	}
	if !sawAssert {
		t.Fatal("modify without assertion control")
	}
	// Without assertion support (AD) the BeforeHash re-read is used.
	c2 := newClient(models.ServerTypeAD)
	s2 := session(c2, false)
	p2, _ := prepare(t, s2, c2, "modify_entry", `{"dn":"`+anna+`","changes":[{"operation":"replace","attribute":"description","values":["new"]}],"explanation":"x"}`)
	c2.Put(anna, map[string][]string{"objectClass": {"user"}, "cn": {"Anna"}, "description": {"changed meanwhile"}})
	out2, _ := p2.Execute(context.Background())
	if out2.Code() != tools.ErrEntryChanged {
		t.Fatalf("before hash: %s", out2.Render(0))
	}
	for _, op := range c2.Recorded() {
		if op.Op == "modify" {
			t.Fatal("modify sent although the entry changed")
		}
	}
}

// reset_password delegates the method to the password track (here the
// fake): the value never reaches a result, the storage preview reaches the
// approval card, and a cleartext password over an unencrypted connection is
// a stated risk.
func TestPasswordResetDelegate(t *testing.T) {
	args := `{"dn":"` + anna + `","explanation":"x"}`
	// AD without TLS → refused by the delegate.
	ad2 := fake.NewFakeClient(ldaptools.ConnInfo{ProfileID: "p1", Name: "Lab", Host: "h", BaseDN: base, TLSMode: "none"}, &models.ServerInfo{ServerType: models.ServerTypeAD, DefaultNamingContext: base})
	ad2.Put(anna, map[string][]string{"objectClass": {"user"}})
	if _, res := prepare(t, session(ad2, false), ad2, "reset_password", args); res == nil || res.Code() != tools.ErrUnsupportedOnServer {
		t.Fatalf("AD without TLS: %v", res)
	}
	// AD with TLS → replace unicodePwd + pwdLastSet 0, value never in the result.
	ad := newClient(models.ServerTypeAD)
	p, res := prepare(t, session(ad, false), ad, "reset_password", args)
	if res != nil {
		t.Fatal(res.Render(0))
	}
	if p.Preview.Password == nil || p.Preview.Password.Method != ldaptools.PasswordAD {
		t.Fatalf("no storage preview: %+v", p.Preview)
	}
	out, secret := p.Execute(context.Background())
	if out.IsError() || len(secret) < 16 || strings.Contains(out.Render(0), string(secret)) {
		t.Fatalf("reset: %s", out.Render(0))
	}
	ops := ad.Recorded()
	last := ops[len(ops)-1]
	if last.Op != "modify" || last.Changes[0].Attribute != "unicodePwd" || last.Changes[1].Attribute != "pwdLastSet" {
		t.Fatalf("AD change %+v", last)
	}
	// Password Modify over plain LDAP → the card states the cleartext risk.
	ol2 := fake.NewFakeClient(ldaptools.ConnInfo{ProfileID: "p1", Name: "Lab", Host: "h", BaseDN: base, TLSMode: "none"},
		&models.ServerInfo{ServerType: models.ServerTypeOpenLDAP, DefaultNamingContext: base, SupportedExtensions: []string{"1.3.6.1.4.1.4203.1.11.1"}})
	ol2.Put(anna, map[string][]string{"objectClass": {"inetOrgPerson"}, "cn": {"Anna"}})
	p, _ = prepare(t, session(ol2, false), ol2, "reset_password", `{"dn":"`+anna+`","must_change_at_next_logon":false,"explanation":"x"}`)
	// Stated once (2b defect 4): by the storage preview (the card's red box
	// under "Password storage"), not again in the risk list; still high
	// risk, so the card needs the confirmation.
	if !p.Preview.Password.Unencrypted || strings.Contains(strings.Join(p.Preview.RiskReasons, " "), "cleartext") || p.Preview.Risk != "high" {
		t.Fatalf("unencrypted not stated exactly once: %+v", p.Preview)
	}
	for _, w := range p.Preview.Warnings {
		if strings.Contains(w, "cleartext") {
			t.Fatalf("cleartext risk repeated as a warning: %q", w)
		}
	}
	_, secret = p.Execute(context.Background())
	var used string
	for _, op := range ol2.Recorded() {
		if op.Op == "passwd" {
			used = op.Value
		}
	}
	if used == "" || used != string(secret) {
		t.Fatal("PasswordModify not used")
	}
	// Client-side hash → the result names the stored scheme, never a value.
	ol := newClient(models.ServerTypeOpenLDAP)
	p, _ = prepare(t, session(ol, false), ol, "reset_password", args)
	out, _ = p.Execute(context.Background())
	if !strings.Contains(out.Render(0), `"stored_as":"{SSHA}"`) || strings.Contains(out.Render(0), "{SSHA}hashed") {
		t.Fatalf("stored scheme: %s", out.Render(0))
	}
}

// serverDecidesClient serves a password delegate whose plan says that the
// server's policy decides "must change" (389 DS, services/ai_delegates.go).
type serverDecidesClient struct {
	*fake.FakeClient
	known, on bool
}

func (c serverDecidesClient) Passwords() ldaptools.PasswordSetter { return serverDecides{c} }

type serverDecides struct{ c serverDecidesClient }

func (s serverDecides) Plan(ctx context.Context, dn string, must bool) (*ldaptools.PasswordPlan, error) {
	p, err := s.c.FakeClient.Passwords().Plan(ctx, dn, must)
	if err != nil {
		return nil, err
	}
	p.MustChange, p.MustChangeKnown = s.c.on, s.c.known
	p.MustChangeBy = "389 DS password policy (passwordMustChange: on, global policy in cn=config)"
	if !s.c.known {
		p.MustChangeBy = "389 DS password policy (passwordMustChange, not readable with this account)"
	}
	p.Storage.MustChange = p.MustChange
	return p, nil
}

func (s serverDecides) Apply(ctx context.Context, plan *ldaptools.PasswordPlan, value string) (*ldaptools.PasswordOutcome, error) {
	if plan.RequestMustChange() {
		return nil, context.Canceled // the delegate must never request it
	}
	return s.c.FakeClient.Passwords().Apply(ctx, plan, value)
}

// 2b defect 2: when the server's policy decides "must change" (389 DS),
// the tool result and the audit say so, whatever the argument was.
func TestPasswordResetMustChangeDecidedByServer(t *testing.T) {
	for _, tc := range []struct {
		name, args string
		known, on  bool
		want       string
	}{
		{"policy on, argument false", `{"dn":"` + anna + `","must_change_at_next_logon":false,"explanation":"x"}`, true, true, `"must_change_at_next_logon":true`},
		{"policy off, argument true", `{"dn":"` + anna + `","must_change_at_next_logon":true,"explanation":"x"}`, true, false, `"must_change_at_next_logon":false`},
		{"policy not readable", `{"dn":"` + anna + `","explanation":"x"}`, false, false, `"must_change_at_next_logon":"decided by the server's password policy"`},
	} {
		fc := newClient(models.ServerType389DS)
		c := serverDecidesClient{FakeClient: fc, known: tc.known, on: tc.on}
		s := session(fc, false)
		tool := ldaptools.Lookup("reset_password")
		a, _, err := tools.Validate(tool.Def().Params, json.RawMessage(tc.args))
		if err != nil {
			t.Fatal(err)
		}
		p, res := tool.(ldaptools.Writer).Prepare(context.Background(), s, &ldaptools.Call{ID: "tc", Tool: "reset_password", Args: a, Conn: s.Conns[0], Client: c})
		if res != nil {
			t.Fatalf("%s: %s", tc.name, res.Render(0))
		}
		if p.Preview.Password.MustChange != (tc.known && tc.on) || !strings.Contains(p.AuditDetail, "decided by the 389 DS password policy") {
			t.Fatalf("%s: card/audit %+v %q", tc.name, p.Preview.Password, p.AuditDetail)
		}
		out, _ := p.Execute(context.Background())
		r := out.Render(0)
		if out.IsError() || !strings.Contains(r, tc.want) || !strings.Contains(r, `"must_change_decided_by":"389 DS password policy`) {
			t.Fatalf("%s: result %s", tc.name, r)
		}
	}
}

func TestGeneratePassword(t *testing.T) {
	for i := 0; i < 50; i++ {
		pw, err := ldaptools.GeneratePassword(20)
		if err != nil || len(pw) != 20 {
			t.Fatal(err)
		}
		s := string(pw)
		if strings.ContainsAny(s, "0O1lI") || !strings.ContainsAny(s, "ABCDEFGHJKLMNPQRSTUVWXYZ") || !strings.ContainsAny(s, "abcdefghijkmnopqrstuvwxyz") ||
			!strings.ContainsAny(s, "23456789") || !strings.ContainsAny(s, "!#%+-=?@_") {
			t.Fatalf("bad password %q", s)
		}
	}
}

func TestDeleteRefusesNonLeaf(t *testing.T) {
	c := newClient(models.ServerTypeAD)
	_, res := prepare(t, session(c, false), c, "delete_entry", `{"dn":"OU=Users,`+base+`","explanation":"x"}`)
	if res == nil || res.Code() != tools.ErrNotAllowedOnNonLeaf {
		t.Fatalf("%v", res)
	}
	p, res := prepare(t, session(c, false), c, "delete_entry", `{"dn":"`+anna+`","explanation":"x"}`)
	if res != nil || p.Preview.Risk != "high" {
		t.Fatalf("leaf delete: %v", res)
	}
}

func TestGroupMembershipAndNested(t *testing.T) {
	c := newClient(models.ServerTypeOpenLDAP)
	l1, l2, l3 := "CN=L1,"+base, "CN=L2,"+base, "CN=L3,"+base
	deep := "CN=Deep,OU=Users," + base
	c.Put(deep, map[string][]string{"objectClass": {"inetOrgPerson"}, "cn": {"Deep"}, "uid": {"deep.user"}})
	c.Put(l3, map[string][]string{"objectClass": {"groupOfNames"}, "cn": {"L3"}, "member": {deep}})
	c.Put(l2, map[string][]string{"objectClass": {"groupOfNames"}, "cn": {"L2"}, "member": {l3}})
	c.Put(l1, map[string][]string{"objectClass": {"groupOfNames"}, "cn": {"L1"}, "member": {l2, l1}})
	s := session(c, false)
	_, out := run(t, s, c, "get_membership", `{"dn":"`+l1+`","direction":"members","transitive":true}`)
	if !strings.Contains(out, `"via":["CN=L2,DC=corp,DC=test","CN=L3,DC=corp,DC=test"]`) || !strings.Contains(out, "cycles") {
		t.Fatalf("nested: %s", out)
	}
	// update_group_membership skips present members.
	p, res := prepare(t, s, c, "update_group_membership", `{"group_dn":"`+l3+`","add":["`+deep+`","`+anna+`"],"explanation":"x"}`)
	if res != nil {
		t.Fatal(res.Render(0))
	}
	if len(p.Preview.Unchanged) != 1 || !strings.Contains(p.Preview.LDIF, "add: member") || strings.Count(p.Preview.LDIF, "member: ") != 1 {
		t.Fatalf("preview %+v", p.Preview)
	}
}

func TestFindAccountsOwnFilters(t *testing.T) {
	c := newClient(models.ServerTypeAD)
	s := session(c, false)
	res, out := run(t, s, c, "find_accounts", `{"status":"password_never_expires"}`)
	if res.IsError() || !strings.Contains(out, "userAccountControl:1.2.840.113556.1.4.803:=65536") || !strings.Contains(out, "CN=Anna") {
		t.Fatalf("%s", out)
	}
	_, out = run(t, s, c, "find_accounts", `{"status":"inactive","include_disabled":true}`)
	if strings.Contains(out, "1.2.840.113556.1.4.803:=2)") {
		t.Fatalf("include_disabled ignored: %s", out)
	}
	ol := newClient(models.ServerTypeOpenLDAP)
	res, _ = run(t, session(ol, false), ol, "find_accounts", `{"status":"expired"}`)
	if res.Code() != tools.ErrUnsupportedOnServer {
		t.Fatal(res.Render(0))
	}
}

// The naming attribute is implied by the DN: create_entry adds it when the
// model left it out (as AD does), but rejects a conflicting value.
func TestCreateEntryAddsRDNAttribute(t *testing.T) {
	c := newClient(models.ServerTypeAD)
	s := session(c, false)
	p, res := prepare(t, s, c, "create_entry", `{"dn":"CN=New User,`+base+`","attributes":[{"attribute":"objectClass","values":["user"]},{"attribute":"sAMAccountName","values":["new.user"]}],"explanation":"x"}`)
	if res != nil {
		t.Fatal(res.Render(0))
	}
	if !strings.Contains(p.Preview.LDIF, "CN: New User") {
		t.Fatalf("RDN attribute missing from the preview:\n%s", p.Preview.LDIF)
	}
	_, res = prepare(t, s, c, "create_entry", `{"dn":"CN=New User,`+base+`","attributes":[{"attribute":"objectClass","values":["user"]},{"attribute":"cn","values":["Other"]}],"explanation":"x"}`)
	if res == nil || res.Code() != tools.ErrInvalidArguments {
		t.Fatalf("conflicting cn accepted: %+v", res)
	}
}

// Review 2b: the audit of an AI account action records the changes the
// account track actually sent (re-plan, Relax Rules fallback), not the
// approved plan; the note to the model names the cause.
func TestAccountActionAuditsSentChanges(t *testing.T) {
	locked := "CN=Locked,OU=Users," + base
	put := func(c *fake.FakeClient) {
		c.Put(locked, map[string][]string{"objectClass": {"top", "person", "user"}, "objectCategory": {"person"}, "cn": {"Locked"},
			"userAccountControl": {"512"}, "lockoutTime": {"133748928000000000"}, "pwdFailureTime": {"20260101000000Z"}})
	}
	for _, tc := range []struct {
		name      string
		hook      func([]models.AttributeChange) []models.AttributeChange
		wantAudit string
		notAudit  string
		wantNote  string
	}{
		{"relax refused", func(pl []models.AttributeChange) []models.AttributeChange { return pl[:1] },
			"(replace lockoutTime=[0])", "pwdFailureTime", "Relax Rules"},
		{"re-planned", func([]models.AttributeChange) []models.AttributeChange {
			return []models.AttributeChange{{Operation: models.ChangeDelete, Attribute: "lockoutTime"}}
		}, "(delete lockoutTime)", "replace lockoutTime", "planned the action again"},
		{"as planned", nil, "delete pwdFailureTime", "", ""},
	} {
		c := newClient(models.ServerTypeAD)
		put(c)
		c.AccountApplyHook = tc.hook
		s := session(c, false)
		p, res := prepare(t, s, c, "unlock_account", `{"dn":"`+locked+`","explanation":"x"}`)
		if res != nil {
			t.Fatalf("%s: %s", tc.name, res.Render(0))
		}
		if !strings.Contains(p.AuditDetail, "pwdFailureTime") {
			t.Fatalf("%s: plan %q", tc.name, p.AuditDetail)
		}
		out, _ := p.Execute(context.Background())
		if out.IsError() {
			t.Fatalf("%s: %s", tc.name, out.Render(0))
		}
		if !strings.Contains(p.AuditDetail, tc.wantAudit) || tc.notAudit != "" && strings.Contains(p.AuditDetail, tc.notAudit) {
			t.Fatalf("%s: audit %q", tc.name, p.AuditDetail)
		}
		r := out.Render(0)
		if tc.wantNote != "" && !strings.Contains(r, tc.wantNote) || tc.wantNote == "" && strings.Contains(r, "LDAPilot sent") {
			t.Fatalf("%s: %s", tc.name, r)
		}
	}
}
