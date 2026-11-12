package ldap

import (
	"slices"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// TestSASLPassThroughKept: a userPassword value "{SASL}<user>" is no
// password but a reference OpenLDAP hands to saslauthd (pass-through
// authentication, GitHub issue #1). Every policy must send it exactly as
// given: never hashed, no Password Modify, no "ask" decision and no
// unencrypted-password confirmation; the read-back has nothing to warn about.
func TestSASLPassThroughKept(t *testing.T) {
	policies := map[string]models.EffectivePasswordPolicy{
		"client": testPolicy(models.PasswordPolicyClient),
		"server": testPolicy(models.PasswordPolicyServer),
		"server with Password Modify": testPolicy(models.PasswordPolicyServer, func(e *models.EffectivePasswordPolicy) {
			e.PasswordModifyExop = true
		}),
		"server that hashes": testPolicy(models.PasswordPolicyServer, func(e *models.EffectivePasswordPolicy) {
			e.ServerHashes, e.PasswordModifyExop, e.ServerType = true, true, models.ServerType389DS
		}),
		"ask": testPolicy(models.PasswordPolicyAsk),
	}
	values := []string{"{SASL}username", "{SASL}user@EXAMPLE.ORG", "{sasl}username"}

	checkPlan := func(t *testing.T, plan models.PasswordWritePlan) {
		t.Helper()
		if plan.Kept != 1 || plan.Values != 1 || plan.Hashed != 0 || plan.Cleartext != 0 {
			t.Errorf("counts: %+v", plan)
		}
		if plan.Exop || plan.CleartextSent || plan.NeedsDecision || plan.NeedsConfirm {
			t.Errorf("flags: %+v", plan)
		}
		if len(plan.Warnings) != 0 {
			t.Errorf("warnings: %q", plan.Warnings)
		}
		if err := planErr(plan); err != nil {
			t.Errorf("write refused: %v", err)
		}
	}

	for name, eff := range policies {
		for _, tls := range []bool{true, false} {
			eff.TLS = tls
			for _, value := range values {
				for _, binary := range []bool{false, true} {
					sent := value
					if binary {
						sent = b64(value)
					}
					for _, op := range []string{"replace", "add"} {
						t.Run(name+"/"+op+"/"+value, func(t *testing.T) {
							p, err := newPasswordPlanner(eff, models.PasswordWriteOptions{}, fakeHash)
							if err != nil {
								t.Fatal(err)
							}
							ch := pwChange(op, sent)
							ch.Binary = binary
							out, _, exop, err := p.changes([]models.AttributeChange{ch})
							if err != nil {
								t.Fatal(err)
							}
							if exop || !slices.Equal(out[0].Values, []string{sent}) {
								t.Errorf("sent %q (exop %v), want %q unchanged", out[0].Values, exop, sent)
							}
							plan := p.finish()
							checkPlan(t, plan)

							r := buildPasswordReport(p, plan, []string{value}, nil, nil)
							if r.Cleartext || r.Ineffective || r.Unconfirmed || len(r.Warnings) != 0 {
								t.Errorf("report: %+v", r)
							}
							if !slices.Equal(r.StoredSchemes, []string{"{SASL}"}) {
								t.Errorf("stored schemes %q", r.StoredSchemes)
							}
						})
					}

					// A new entry (New Entry, Copy Entry, LDIF add records).
					t.Run(name+"/new entry/"+value, func(t *testing.T) {
						p, err := newPasswordPlanner(eff, models.PasswordWriteOptions{}, fakeHash)
						if err != nil {
							t.Fatal(err)
						}
						out, err := p.attributes([]models.LDAPAttribute{
							{Name: "uid", Values: []string{"username"}},
							{Name: "userPassword", Values: []string{sent}, Binary: binary},
						})
						if err != nil {
							t.Fatal(err)
						}
						if !slices.Equal(out[1].Values, []string{sent}) {
							t.Errorf("sent %q, want %q unchanged", out[1].Values, sent)
						}
						checkPlan(t, p.finish())
					})
				}
			}
		}
	}
}
