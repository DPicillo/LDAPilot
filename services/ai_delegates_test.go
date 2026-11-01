package services

import (
	"errors"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ai/ldaptools"
	internalldap "github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// The AI's reset method follows the connection's password storage policy
// like the password dialog (lib/passwordMethod.ts policySelection).
func TestAIPasswordSelection(t *testing.T) {
	pol := func(p, scheme string, hashes, exop bool) *models.EffectivePasswordPolicy {
		return &models.EffectivePasswordPolicy{Policy: p, Scheme: scheme, ServerHashes: hashes, PasswordModifyExop: exop}
	}
	for _, tc := range []struct {
		name           string
		st             string
		eff            *models.EffectivePasswordPolicy
		tls            bool
		method, scheme string
		err            error
	}{
		{"AD over TLS", models.ServerTypeAD, nil, true, models.PasswordMethodUnicodePwd, "", nil},
		{"AD without TLS", models.ServerTypeAD, nil, false, "", "", ldaptools.ErrUnsupported},
		{"OpenLDAP client {CRYPT}$6$", models.ServerTypeOpenLDAP, pol("client", "CRYPT-SHA512", false, true), false, models.PasswordMethodUserPassword, "CRYPT-SHA512", nil},
		{"client unknown scheme", models.ServerTypeOpenLDAP, pol("client", "NOPE", false, true), true, "", "", ldaptools.ErrUnsupported},
		{"389DS server over TLS", models.ServerType389DS, pol("server", "", true, true), true, models.PasswordMethodExop, "", nil},
		{"389DS server plain", models.ServerType389DS, pol("server", "", true, true), false, models.PasswordMethodUserPassword, internalldap.SchemeCleartext, nil},
		{"server, not hashing, exop", models.ServerTypeOpenLDAP, pol("server", "", false, true), false, models.PasswordMethodExop, "", nil},
		{"server, neither", models.ServerTypeOther, pol("server", "", false, false), true, "", "", ldaptools.ErrUnsupported},
		{"ask", models.ServerTypeOther, pol("ask", "", false, true), true, "", "", internalldap.ErrPasswordDecisionRequired},
	} {
		m, s, err := aiPasswordSelection(tc.st, tc.eff, tc.tls)
		if m != tc.method || s != tc.scheme || (tc.err == nil) != (err == nil) || tc.err != nil && !errors.Is(err, tc.err) {
			t.Errorf("%s: got %q %q %v", tc.name, m, s, err)
		}
	}
	// A cleartext password on the wire is exactly what the dialog confirms.
	for _, tc := range []struct {
		req  models.PasswordChangeRequest
		want bool
	}{
		{models.PasswordChangeRequest{Method: models.PasswordMethodExop}, true},
		{models.PasswordChangeRequest{Method: models.PasswordMethodUserPassword, Scheme: "CLEARTEXT"}, true},
		{models.PasswordChangeRequest{Method: models.PasswordMethodUserPassword, Scheme: "CRYPT-SHA512"}, false},
	} {
		if got := passwordChangeSendsCleartext(tc.req); got != tc.want {
			t.Errorf("%+v: %v", tc.req, got)
		}
	}
}

// 2b defect 2: on 389 DS the password policy decides "must change at next
// logon" after a reset; the plan always says so (with passwordMustChange
// when readable) and never requests it, whatever the argument was.
func TestAIDSMustChangeFromPolicy(t *testing.T) {
	global := func(on bool) *models.AccountPolicy {
		return &models.AccountPolicy{DN: "cn=config", Name: "Global password policy", Source: models.PolicySourceGlobal, Readable: true, MustChangeEnforced: on}
	}
	for _, tc := range []struct {
		name        string
		pol         *models.AccountPolicy
		requested   bool
		must, known bool
		by, note    string
	}{
		{"global on, not requested", global(true), false, true, true, "passwordMustChange: on, global policy in cn=config", "passwordMustChange is on (global policy in cn=config), so the user must change"},
		{"global off, requested", global(false), true, false, true, "passwordMustChange: off, global policy in cn=config", "passwordMustChange is off"},
		{"local policy on", &models.AccountPolicy{DN: "cn=ux,cn=nsPwPolicyContainer,ou=people,dc=x", Name: "ux", Source: models.PolicySourceSubentry, Readable: true, MustChangeEnforced: true},
			false, true, true, "local policy ux", "passwordMustChange is on (local policy ux)"},
		{"cn=config not readable", &models.AccountPolicy{DN: "cn=config", Source: models.PolicySourceGlobal}, true, false, false, "not readable", "cannot read"},
		{"no policy (status failed)", nil, true, false, false, "not readable", "cannot read"},
	} {
		plan := &ldaptools.PasswordPlan{DN: "uid=u,dc=x", MustChange: tc.requested}
		aiDSMustChange(plan, tc.pol)
		if plan.MustChange != tc.must || plan.MustChangeKnown != tc.known || plan.RequestMustChange() ||
			!strings.Contains(plan.MustChangeBy, tc.by) || len(plan.Notes) != 1 || !strings.Contains(plan.Notes[0], tc.note) ||
			!strings.Contains(plan.Notes[0], "must_change_at_next_logon has no effect") {
			t.Errorf("%s: %+v", tc.name, plan)
		}
		// The request built from the plan is valid on 389 DS (must-change
		// is refused there when sent).
		req := models.PasswordChangeRequest{DN: plan.DN, Method: models.PasswordMethodExop, MustChange: plan.RequestMustChange()}
		if _, err := passwordAccountChanges(models.ServerType389DS, false, req); err != nil {
			t.Errorf("%s: %v", tc.name, err)
		}
	}
	// Elsewhere MustChange is the request itself.
	if p := (&ldaptools.PasswordPlan{MustChange: true}); !p.RequestMustChange() {
		t.Error("AD/OpenLDAP must-change not requested")
	}
}

func TestAIAccountNoOp(t *testing.T) {
	locked := &models.AccountStatus{ServerType: models.ServerTypeAD, Applicable: true, Enabled: true, Locked: true}
	if r, _ := aiAccountNoOp(locked, ldaptools.ActionUnlock); r != "" {
		t.Fatal("unlock of a locked account is a no-op")
	}
	if r, h := aiAccountNoOp(locked, ldaptools.ActionEnable); r == "" || h == "" {
		t.Fatal("enable of an enabled, locked account: want no-op with an unlock hint")
	}
	olDisabled := &models.AccountStatus{ServerType: models.ServerTypeOpenLDAP, Applicable: true}
	if r, h := aiAccountNoOp(olDisabled, ldaptools.ActionUnlock); r == "" || h == "" {
		t.Fatal("unlock of a disabled OpenLDAP account must point to set_account_enabled")
	}
	if r, _ := aiAccountNoOp(&models.AccountStatus{MustChangePassword: true}, ldaptools.ActionMustChange); r == "" {
		t.Fatal("must change already set")
	}
	if ch, err := aiAccountChange(ldaptools.ActionClearMustChange); err != nil || ch.Action != models.AccountActionMustChange || ch.Set {
		t.Fatalf("%+v %v", ch, err)
	}
}

func TestAIMembershipAndReportConversion(t *testing.T) {
	m := aiMembershipFrom(&models.MembershipResult{DN: "cn=g", Method: "ad-chain", IsGroup: true,
		Items: []models.MembershipItem{{DN: "cn=u", Name: "u", ObjectType: models.MemberTypeUser, Depth: 2, Path: []string{"cn=n"}, Primary: "ad"},
			{DN: "cn=x", ObjectType: models.MemberTypeFSP, External: true}},
		Cycles: []models.MembershipCycle{{Path: []string{"cn=a", "cn=b", "cn=a"}}}})
	if len(m.Items) != 2 || !m.Items[0].Primary || m.Items[0].Via[0] != "cn=n" || m.Items[1].Type != "other" || !m.Items[1].External || len(m.Cycles) != 1 {
		t.Fatalf("%+v", m)
	}
	res := &models.AccountReportResult{Entries: []models.LDAPEntry{
		{DN: "cn=a", Attributes: []models.LDAPAttribute{{Name: "objectClass", Values: []string{"user"}}, {Name: "sAMAccountName", Values: []string{"a"}}}},
		{DN: "cn=pc", Attributes: []models.LDAPAttribute{{Name: "objectClass", Values: []string{"user", "computer"}}}},
	}}
	if r := aiReportFrom(res, "locked", "users"); r.Total != 1 || r.Accounts[0].Login != "a" {
		t.Fatalf("users: %+v", r)
	}
	if r := aiReportFrom(res, "locked", "computers"); r.Total != 1 || r.Accounts[0].DN != "cn=pc" {
		t.Fatalf("computers: %+v", r)
	}
}
