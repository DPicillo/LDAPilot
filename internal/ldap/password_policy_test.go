package ldap

import (
	"encoding/base64"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
)

func TestIsHashedPasswordValue(t *testing.T) {
	tests := map[string]bool{
		"{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=":      true,
		"{ssha}W6ph5Mm5Pz8GgiULbPgzG37mj9g=":      true, // case-insensitive
		"{CRYPT}$6$salt$hash":                     true,
		"{crypt}$5$salt$hash":                     true,
		"{CRYPT}$2b$10$abcdefghijklmnopqrstuu":    true, // bcrypt
		"{crypt}$2b$10$abcdefghijklmnopqrstuu":    true,
		"{CRYPT}$2y$12$x":                         true,
		"{PBKDF2-SHA512}100000$c2FsdA==$aGFzaA==": true,
		"{ARGON2}$argon2id$v=19$m=65536,t=3,p=1$": true,
		"{SASL}user@EXAMPLE.ORG":                  true,  // pass-through authentication
		"{CLEARTEXT}secret":                       false, // explicit cleartext tags store cleartext
		"{CLEAR}secret":                           false,
		"{plain}secret":                           false,
		"{Summer}2026!":                           false, // unknown tag: a typed password
		"{a}bcdefgh":                              false,
		"{ssha}garbage":                           false, // known tag, not base64 of a digest
		"{SSHA}YWJj":                              false, // base64, but shorter than a SHA-1 digest
		"{CRYPT}hunter2":                          false, // not a crypt(3) string
		"{CRYPT}$6":                               false,
		"{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g":       true, // unpadded base64
		"{CRYPT}abJnggxhB/yWI":                    true, // traditional DES
		"{CRYPT}_J9..rasmBYk8r9AiWNc":             true, // BSDi extended DES
		"{CRYPT}!$6$salt$hash":                    true, // locked
		"{CRYPT}*":                                true,
		"{CRYPT-SHA512}$6$salt$hash":              true, // 389DS
		"{PBKDF2_SHA256}AAAnEA==":                 true,
		"{GOST_YESCRYPT}$gy$j9T$salt$hash":        true,
		"{K5KEY}x":                                true,
		"secret":                                  false,
		"":                                        false,
		"Grüße!Straße2026€":                       false,
		"{}secret":                                false,
		"{my secret}x":                            false, // blank: not a scheme name
		"{SSHA}":                                  false, // nothing after the tag
		" {SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=":     false,
		"{" + strings.Repeat("A", 33) + "}x":      false, // tag too long
		"{SSHA":                                   false,
		"{ü}x":                                    false,
	}
	for in, want := range tests {
		if got := IsHashedPasswordValue(in); got != want {
			t.Errorf("IsHashedPasswordValue(%q) = %v, want %v", in, got, want)
		}
	}
}

// fakeHash is a deterministic hasher for the decision table.
func fakeHash(scheme, password string) (string, error) {
	return "{HASHED-" + scheme + "}" + password, nil
}

func testPolicy(policy string, mods ...func(*models.EffectivePasswordPolicy)) models.EffectivePasswordPolicy {
	eff := models.EffectivePasswordPolicy{Policy: policy, ServerType: models.ServerTypeOpenLDAP, TLS: true, Warnings: []string{}}
	if policy == models.PasswordPolicyClient {
		eff.Scheme = SchemeCryptSHA512
	}
	if policy == models.PasswordPolicyAD {
		eff.ServerType = models.ServerTypeAD
	}
	for _, m := range mods {
		m(&eff)
	}
	return eff
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func pwChange(op string, values ...string) models.AttributeChange {
	return models.AttributeChange{Operation: op, Attribute: "userPassword", Values: values}
}

// TestPasswordPolicyDecisions is the decision table of the write hook.
func TestPasswordPolicyDecisions(t *testing.T) {
	noTLS := func(e *models.EffectivePasswordPolicy) { e.TLS = false }
	exopServer := func(e *models.EffectivePasswordPolicy) { e.PasswordModifyExop = true }
	hashingServer := func(e *models.EffectivePasswordPolicy) {
		e.ServerHashes, e.PasswordModifyExop, e.ServerType = true, true, models.ServerType389DS
	}

	tests := []struct {
		name    string
		eff     models.EffectivePasswordPolicy
		opts    models.PasswordWriteOptions
		changes []models.AttributeChange
		// want are the values sent per change.
		want     [][]string
		exop     string // exop password, "" = no exop
		check    func(t *testing.T, p models.PasswordWritePlan)
		wantErr  error
		mustWarn string
	}{
		{
			name: "client hashes cleartext", eff: testPolicy(models.PasswordPolicyClient),
			changes: []models.AttributeChange{pwChange("replace", "secret")},
			want:    [][]string{{"{HASHED-CRYPT-SHA512}secret"}},
			check: func(t *testing.T, p models.PasswordWritePlan) {
				if p.Hashed != 1 || p.CleartextSent || p.NeedsConfirm {
					t.Errorf("plan %+v", p)
				}
			},
		},
		{
			name: "client keeps hashed values (scheme prefix, case-insensitive)", eff: testPolicy(models.PasswordPolicyClient),
			changes: []models.AttributeChange{pwChange("add", "{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=", "{ssha}W6ph5Mm5Pz8GgiULbPgzG37mj9g=", "{crypt}$2b$10$abc", "{CRYPT}$6$s$h", "{PBKDF2-SHA512}1$a$b")},
			want:    [][]string{{"{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=", "{ssha}W6ph5Mm5Pz8GgiULbPgzG37mj9g=", "{crypt}$2b$10$abc", "{CRYPT}$6$s$h", "{PBKDF2-SHA512}1$a$b"}},
			check: func(t *testing.T, p models.PasswordWritePlan) {
				if p.Kept != 5 || p.Hashed != 0 || p.Values != 5 {
					t.Errorf("plan %+v", p)
				}
			},
		},
		{
			name: "mixed values in one change", eff: testPolicy(models.PasswordPolicyClient),
			changes: []models.AttributeChange{pwChange("replace", "{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=", "new")},
			want:    [][]string{{"{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=", "{HASHED-CRYPT-SHA512}new"}},
		},
		{
			name: "delete passes values unchanged", eff: testPolicy(models.PasswordPolicyClient),
			changes: []models.AttributeChange{pwChange("delete", "{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g="), pwChange("delete", "old-cleartext"), pwChange("delete")},
			want:    [][]string{{"{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g="}, {"old-cleartext"}, nil},
			check: func(t *testing.T, p models.PasswordWritePlan) {
				if p.Values != 0 || p.Hashed != 0 || !p.CleartextSent {
					t.Errorf("plan %+v", p)
				}
			},
		},
		{
			name: "binary cleartext is hashed, binary hash kept", eff: testPolicy(models.PasswordPolicyClient),
			changes: []models.AttributeChange{
				{Operation: "replace", Attribute: "userPassword", Values: []string{b64("s\xe9cret")}, Binary: true},
				{Operation: "add", Attribute: "userPassword", Values: []string{b64("{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=")}, Binary: true},
			},
			want: [][]string{{b64("{HASHED-CRYPT-SHA512}s\xe9cret")}, {b64("{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=")}},
		},
		{
			name: "attribute options and case", eff: testPolicy(models.PasswordPolicyClient),
			changes: []models.AttributeChange{{Operation: "REPLACE", Attribute: "USERPASSWORD;x-test", Values: []string{"pw"}}},
			want:    [][]string{{"{HASHED-CRYPT-SHA512}pw"}},
		},
		{
			name: "other attributes untouched", eff: testPolicy(models.PasswordPolicyClient),
			changes: []models.AttributeChange{{Operation: "replace", Attribute: "description", Values: []string{"secret"}}, {Operation: "add", Attribute: "userPasswordHint", Values: []string{"x"}}},
			want:    [][]string{{"secret"}, {"x"}},
			check: func(t *testing.T, p models.PasswordWritePlan) {
				if p.HasPasswords {
					t.Errorf("plan %+v", p)
				}
			},
		},
		{
			name: "AD passes userPassword through, even with a client decision", eff: testPolicy(models.PasswordPolicyAD),
			opts:     models.PasswordWriteOptions{Policy: models.PasswordPolicyClient, Scheme: SchemeSSHA},
			changes:  []models.AttributeChange{pwChange("replace", "secret")},
			want:     [][]string{{"secret"}},
			mustWarn: "Active Directory treats userPassword specially",
			check: func(t *testing.T, p models.PasswordWritePlan) {
				if p.Hashed != 0 || p.Cleartext != 1 {
					t.Errorf("plan %+v", p)
				}
			},
		},
		{
			name: "AD unicodePwd is never touched", eff: testPolicy(models.PasswordPolicyAD),
			changes: []models.AttributeChange{{Operation: "replace", Attribute: "unicodePwd", Values: []string{"Secret1!"}}},
			want:    [][]string{{"Secret1!"}},
			check: func(t *testing.T, p models.PasswordWritePlan) {
				if !p.CleartextSent || p.Values != 0 {
					t.Errorf("plan %+v", p)
				}
			},
		},
		{
			name: "ask without decision is refused", eff: testPolicy(models.PasswordPolicyAsk),
			changes: []models.AttributeChange{pwChange("replace", "secret")},
			wantErr: ErrPasswordDecisionRequired,
		},
		{
			name: "ask with already hashed values needs no decision", eff: testPolicy(models.PasswordPolicyAsk),
			changes: []models.AttributeChange{pwChange("replace", "{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=")},
			want:    [][]string{{"{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g="}},
		},
		{
			name: "ask answered with client", eff: testPolicy(models.PasswordPolicyAsk),
			opts:    models.PasswordWriteOptions{Policy: models.PasswordPolicyClient, Scheme: SchemeSSHA512},
			changes: []models.AttributeChange{pwChange("replace", "secret")},
			want:    [][]string{{"{HASHED-SSHA512}secret"}},
			check: func(t *testing.T, p models.PasswordWritePlan) {
				if p.Policy.Source != models.PasswordPolicySourceWrite || p.Policy.Scheme != SchemeSSHA512 {
					t.Errorf("policy %+v", p.Policy)
				}
			},
		},
		{
			name: "ask answered with server", eff: testPolicy(models.PasswordPolicyAsk, hashingServer),
			opts:    models.PasswordWriteOptions{Policy: models.PasswordPolicyServer},
			changes: []models.AttributeChange{pwChange("replace", "secret")},
			want:    [][]string{{"secret"}},
		},
		{
			name: "server known to hash gets cleartext, no exop", eff: testPolicy(models.PasswordPolicyServer, hashingServer),
			changes: []models.AttributeChange{pwChange("replace", "secret")},
			want:    [][]string{{"secret"}},
			check: func(t *testing.T, p models.PasswordWritePlan) {
				if p.Exop || p.Cleartext != 1 || len(p.Warnings) != 0 {
					t.Errorf("plan %+v", p)
				}
			},
		},
		{
			name: "server not known to hash: single replace uses RFC 3062", eff: testPolicy(models.PasswordPolicyServer, exopServer),
			changes: []models.AttributeChange{pwChange("replace", "secret")},
			want:    [][]string{{"secret"}},
			exop:    "secret",
		},
		{
			name: "server not known to hash: binary single replace uses RFC 3062 with the raw value", eff: testPolicy(models.PasswordPolicyServer, exopServer),
			changes: []models.AttributeChange{{Operation: "replace", Attribute: "userPassword", Values: []string{b64("s\xe9cret")}, Binary: true}},
			want:    [][]string{{b64("s\xe9cret")}},
			exop:    "s\xe9cret",
		},
		{
			name: "server not known to hash: multi-change modify stays atomic and warns", eff: testPolicy(models.PasswordPolicyServer, exopServer),
			changes:  []models.AttributeChange{pwChange("replace", "secret"), {Operation: "replace", Attribute: "description", Values: []string{"x"}}},
			want:     [][]string{{"secret"}, {"x"}},
			mustWarn: "may be stored in cleartext",
		},
		{
			name: "server not known to hash: add is not a replace", eff: testPolicy(models.PasswordPolicyServer, exopServer),
			changes:  []models.AttributeChange{pwChange("add", "secret")},
			want:     [][]string{{"secret"}},
			mustWarn: "may be stored in cleartext",
		},
		{
			name: "as is keeps cleartext (LDIF opt-out)", eff: testPolicy(models.PasswordPolicyClient),
			opts:     models.PasswordWriteOptions{AsIs: true},
			changes:  []models.AttributeChange{pwChange("replace", "secret", "{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=")},
			want:     [][]string{{"secret", "{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g="}},
			mustWarn: "stored as given",
			check: func(t *testing.T, p models.PasswordWritePlan) {
				if !p.AsIs || p.Cleartext != 1 || p.Kept != 1 || p.Hashed != 0 {
					t.Errorf("plan %+v", p)
				}
			},
		},
		{
			name: "as is with ask needs no decision", eff: testPolicy(models.PasswordPolicyAsk),
			opts:    models.PasswordWriteOptions{AsIs: true},
			changes: []models.AttributeChange{pwChange("replace", "secret")},
			want:    [][]string{{"secret"}},
		},
		{
			name: "cleartext over an unencrypted connection needs a confirmation", eff: testPolicy(models.PasswordPolicyServer, hashingServer, noTLS),
			changes: []models.AttributeChange{pwChange("replace", "secret")},
			wantErr: ErrPasswordUnencrypted,
		},
		{
			name: "confirmed cleartext over an unencrypted connection", eff: testPolicy(models.PasswordPolicyServer, hashingServer, noTLS),
			opts:    models.PasswordWriteOptions{AllowUnencrypted: true},
			changes: []models.AttributeChange{pwChange("replace", "secret")},
			want:    [][]string{{"secret"}},
		},
		{
			name: "client hash over an unencrypted connection needs no confirmation", eff: testPolicy(models.PasswordPolicyClient, noTLS),
			changes: []models.AttributeChange{pwChange("replace", "secret")},
			want:    [][]string{{"{HASHED-CRYPT-SHA512}secret"}},
		},
		{
			name: "deleting a cleartext value over an unencrypted connection needs a confirmation", eff: testPolicy(models.PasswordPolicyClient, noTLS),
			changes: []models.AttributeChange{pwChange("delete", "old-cleartext")},
			wantErr: ErrPasswordUnencrypted,
		},
		{
			name: "unicodePwd over an unencrypted connection needs a confirmation", eff: testPolicy(models.PasswordPolicyAD, noTLS),
			changes: []models.AttributeChange{{Operation: "replace", Attribute: "unicodePwd", Values: []string{"Secret1!"}}},
			wantErr: ErrPasswordUnencrypted,
		},
		{
			name: "unknown decision", eff: testPolicy(models.PasswordPolicyAsk),
			opts:    models.PasswordWriteOptions{Policy: "maybe"},
			changes: []models.AttributeChange{pwChange("replace", "secret")},
			wantErr: errors.New("unknown password storage decision"),
		},
		{
			name: "cleartext is not a client scheme", eff: testPolicy(models.PasswordPolicyAsk),
			opts:    models.PasswordWriteOptions{Policy: models.PasswordPolicyClient, Scheme: SchemeCleartext},
			changes: []models.AttributeChange{pwChange("replace", "secret")},
			wantErr: errors.New("must hash"),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			orig := make([][]string, len(tt.changes))
			for i, ch := range tt.changes {
				orig[i] = slices.Clone(ch.Values)
			}
			plan, planErr1 := PlanPasswordChanges(tt.eff, tt.changes, tt.opts)
			err := planErr1
			if err == nil {
				err = planErr(plan)
			}
			if tt.wantErr != nil {
				if err == nil {
					t.Fatalf("no error, want %v", tt.wantErr)
				}
				if errors.Is(tt.wantErr, ErrPasswordDecisionRequired) || errors.Is(tt.wantErr, ErrPasswordUnencrypted) {
					if !errors.Is(err, tt.wantErr) {
						t.Fatalf("error %v, want %v", err, tt.wantErr)
					}
				} else if !strings.Contains(err.Error(), tt.wantErr.Error()) {
					t.Fatalf("error %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("plan: %v", err)
			}
			p, err := newPasswordPlanner(tt.eff, tt.opts, fakeHash)
			if err != nil {
				t.Fatal(err)
			}
			out, exopPW, exop, err := p.changes(tt.changes)
			if err != nil {
				t.Fatal(err)
			}
			final := p.finish()
			for i, ch := range out {
				if !slices.Equal(ch.Values, tt.want[i]) {
					t.Errorf("change %d values = %q, want %q", i, ch.Values, tt.want[i])
				}
				if !slices.Equal(tt.changes[i].Values, orig[i]) {
					t.Errorf("change %d input modified", i)
				}
			}
			if exop != (tt.exop != "") || exopPW != tt.exop || final.Exop != exop {
				t.Errorf("exop = %v %q, want %q", exop, exopPW, tt.exop)
			}
			// The dry-run plan matches the plan of the write.
			if plan.Hashed != final.Hashed || plan.Kept != final.Kept || plan.Cleartext != final.Cleartext || plan.Exop != final.Exop {
				t.Errorf("dry run %+v differs from write %+v", plan, final)
			}
			if tt.mustWarn != "" && !slices.ContainsFunc(final.Warnings, func(w string) bool { return strings.Contains(w, tt.mustWarn) }) {
				t.Errorf("warnings %q lack %q", final.Warnings, tt.mustWarn)
			}
			if tt.check != nil {
				tt.check(t, final)
			}
		})
	}
}

func TestPasswordPolicyAttributes(t *testing.T) {
	attrs := []models.LDAPAttribute{
		{Name: "objectClass", Values: []string{"inetOrgPerson"}},
		{Name: "cn", Values: []string{"x"}},
		{Name: "userPassword", Values: []string{"secret", "{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g="}},
	}
	p, err := newPasswordPlanner(testPolicy(models.PasswordPolicyClient), models.PasswordWriteOptions{}, fakeHash)
	if err != nil {
		t.Fatal(err)
	}
	out, err := p.attributes(attrs)
	if err != nil {
		t.Fatal(err)
	}
	if got := out[2].Values; !slices.Equal(got, []string{"{HASHED-CRYPT-SHA512}secret", "{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g="}) {
		t.Errorf("userPassword = %q", got)
	}
	if attrs[2].Values[0] != "secret" {
		t.Error("input modified")
	}
	plan := p.finish()
	if plan.Hashed != 1 || plan.Kept != 1 || len(plan.Actions) != 2 {
		t.Errorf("plan %+v", plan)
	}

	// LDIF opt-out on an add.
	asIs, err := PlanPasswordAttributes(testPolicy(models.PasswordPolicyClient, func(e *models.EffectivePasswordPolicy) { e.TLS = false }), attrs, models.PasswordWriteOptions{AsIs: true})
	if err != nil || !asIs.AsIs || asIs.Hashed != 0 || asIs.Cleartext != 1 || !asIs.NeedsConfirm {
		t.Errorf("as is: %+v %v", asIs, err)
	}
}

func TestDefaultPasswordPolicy(t *testing.T) {
	tests := []struct {
		serverType, policy, scheme string
	}{
		{models.ServerTypeOpenLDAP, models.PasswordPolicyClient, SchemeCryptSHA512},
		{models.ServerType389DS, models.PasswordPolicyServer, ""},
		{models.ServerTypeAD, models.PasswordPolicyAD, ""},
		{models.ServerTypeOther, models.PasswordPolicyAsk, ""},
		{"", models.PasswordPolicyAsk, ""},
	}
	for _, tt := range tests {
		d := DefaultPasswordPolicy(tt.serverType)
		if d.Policy != tt.policy || d.Scheme != tt.scheme || d.Reason == "" {
			t.Errorf("DefaultPasswordPolicy(%q) = %+v", tt.serverType, d)
		}
	}
	// The OpenLDAP default must be built into a stock server.
	level, _ := supportLevel(DefaultClientScheme(models.ServerTypeOpenLDAP), models.ServerTypeOpenLDAP)
	if level != models.SchemeSupportNative {
		t.Errorf("OpenLDAP default scheme support = %q", level)
	}
	level, _ = supportLevel(DefaultClientScheme(models.ServerType389DS), models.ServerType389DS)
	if level != models.SchemeSupportNative {
		t.Errorf("389DS default scheme support = %q", level)
	}
	if len(PasswordPolicyDefaults()) != 4 {
		t.Error("defaults incomplete")
	}
}

// supportLevel returns the catalog support of scheme on serverType.
func supportLevel(scheme, serverType string) (string, string) {
	for _, s := range PasswordSchemes() {
		if s.ID == scheme {
			for _, sup := range s.Support {
				if sup.Server == serverType {
					return sup.Level, sup.Note
				}
			}
		}
	}
	return "", ""
}

func TestResolvePasswordPolicy(t *testing.T) {
	openldap := &models.ServerInfo{ServerType: models.ServerTypeOpenLDAP, SupportedExtensions: []string{OIDPasswordModify}}
	ds := &models.ServerInfo{ServerType: models.ServerType389DS}
	ad := &models.ServerInfo{ServerType: models.ServerTypeAD}
	other := &models.ServerInfo{ServerType: models.ServerTypeOther}
	prof := func(policy, scheme string, tls models.TLSMode) models.ConnectionProfile {
		return models.ConnectionProfile{PasswordPolicy: policy, PasswordScheme: scheme, TLSMode: tls}
	}
	unknown := serverPasswordHashing{note: "unknown"}

	eff := ResolvePasswordPolicy(prof("", "", models.TLSNone), openldap, unknown)
	if eff.Policy != models.PasswordPolicyClient || eff.Scheme != SchemeCryptSHA512 || eff.Source != models.PasswordPolicySourceDefault ||
		eff.Configured != models.PasswordPolicyAuto || eff.TLS || !eff.PasswordModifyExop || eff.SchemeLabel != "{CRYPT} SHA-512-crypt ($6$)" || len(eff.Warnings) != 0 {
		t.Errorf("openldap auto: %+v", eff)
	}
	eff = ResolvePasswordPolicy(prof("auto", "", models.TLSStartTLS), ds, serverPasswordHashing{hashes: true, note: "389"})
	if eff.Policy != models.PasswordPolicyServer || !eff.ServerHashes || !eff.TLS || eff.Scheme != "" {
		t.Errorf("389ds auto: %+v", eff)
	}
	eff = ResolvePasswordPolicy(prof("client", "SSHA512", models.TLSSSL), openldap, unknown)
	if eff.Policy != models.PasswordPolicyClient || eff.Scheme != SchemeSSHA512 || eff.Source != models.PasswordPolicySourceProfile || len(eff.Warnings) != 1 {
		t.Errorf("openldap client SSHA512 (needs pw-sha2): %+v", eff)
	}
	eff = ResolvePasswordPolicy(prof("client", "", models.TLSSSL), ds, unknown)
	if eff.Scheme != SchemePBKDF2SHA512 {
		t.Errorf("389ds client default scheme: %+v", eff)
	}
	eff = ResolvePasswordPolicy(prof("client", "nope", models.TLSSSL), openldap, unknown)
	if eff.Scheme != SchemeCryptSHA512 || len(eff.Warnings) == 0 {
		t.Errorf("unknown scheme falls back: %+v", eff)
	}
	eff = ResolvePasswordPolicy(prof("client", "CRYPT-BCRYPT", models.TLSSSL), openldap, unknown)
	if eff.Scheme != SchemeBcrypt || len(eff.Warnings) != 1 || !strings.Contains(eff.Warnings[0], "crypt(3)") {
		t.Errorf("bcrypt on OpenLDAP warns: %+v", eff)
	}
	eff = ResolvePasswordPolicy(prof("client", "SSHA", models.TLSSSL), ad, unknown)
	if eff.Policy != models.PasswordPolicyAD || eff.Scheme != "" || len(eff.Warnings) != 1 {
		t.Errorf("AD ignores the setting: %+v", eff)
	}
	eff = ResolvePasswordPolicy(prof("", "", models.TLSSSL), other, unknown)
	if eff.Policy != models.PasswordPolicyAsk {
		t.Errorf("other auto: %+v", eff)
	}
	eff = ResolvePasswordPolicy(prof("sometimes", "", models.TLSSSL), openldap, unknown)
	if eff.Policy != models.PasswordPolicyClient || len(eff.Warnings) == 0 {
		t.Errorf("invalid setting falls back to the default: %+v", eff)
	}
	eff = ResolvePasswordPolicy(prof("server", "SSHA", models.TLSSSL), nil, unknown)
	if eff.Policy != models.PasswordPolicyServer || eff.ServerType != models.ServerTypeOther || eff.Summary == "" {
		t.Errorf("no server info: %+v", eff)
	}
}

func TestNormalizePasswordPolicy(t *testing.T) {
	for in, want := range map[string]string{"": "", "auto": "", "AUTO": "", "client": "client", " Server ": "server", "ask": "ask"} {
		if got, err := NormalizePasswordPolicy(in); err != nil || got != want {
			t.Errorf("NormalizePasswordPolicy(%q) = %q, %v", in, got, err)
		}
	}
	if _, err := NormalizePasswordPolicy("ad"); err == nil {
		t.Error("ad accepted as a setting")
	}
	if got, err := ValidateClientScheme("crypt-bcrypt"); err != nil || got != SchemeBcrypt {
		t.Errorf("ValidateClientScheme = %q, %v", got, err)
	}
	if _, err := ValidateClientScheme("CLEARTEXT"); err == nil {
		t.Error("cleartext accepted as client scheme")
	}
}

func TestPasswordValueClassification(t *testing.T) {
	tests := []struct {
		value, label, scheme string
	}{
		{"{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=", "{SSHA}", SchemeSSHA},
		{"{CLEARTEXT}secret", "cleartext", SchemeCleartext},
		{"{CLEAR}secret", "cleartext", SchemeCleartext},
		{"{Summer}2026!", "unknown scheme", SchemeCleartext},
		{"{ssha}garbage", "invalid {SSHA}", SchemeCleartext},
		{"{CRYPT}hunter2", "invalid {CRYPT}", SchemeCleartext},
		{"{CRYPT}abJnggxhB/yWI", "{CRYPT}", "CRYPT"},
		{"secret", "cleartext", SchemeCleartext},
	}
	for _, tt := range tests {
		if got := PasswordSchemeLabel(tt.value); got != tt.label {
			t.Errorf("PasswordSchemeLabel(%q) = %q, want %q", tt.value, got, tt.label)
		}
		if got := PasswordSchemeOf(tt.value); got != tt.scheme {
			t.Errorf("PasswordSchemeOf(%q) = %q, want %q", tt.value, got, tt.scheme)
		}
	}
	// An unknown tag may be part of the password: never echoed.
	if l := PasswordSchemeLabel("{Summer}2026!"); strings.Contains(strings.ToUpper(l), "SUMMER") {
		t.Errorf("label %q leaks the tag", l)
	}
}

// TestPasswordPolicyTaggedCleartext: values with a "{...}" prefix that are
// not hashes of a known scheme are cleartext passwords for every policy.
func TestPasswordPolicyTaggedCleartext(t *testing.T) {
	plain := func(e *models.EffectivePasswordPolicy) { e.TLS = false }
	for _, v := range []string{"{Summer}2026!", "{CLEARTEXT}secret", "{CLEAR}x", "{ssha}garbage", "{CRYPT}hunter2"} {
		// client: hashed (the whole value), with a warning
		p, err := newPasswordPlanner(testPolicy(models.PasswordPolicyClient, plain), models.PasswordWriteOptions{}, fakeHash)
		if err != nil {
			t.Fatal(err)
		}
		out, _, _, err := p.changes([]models.AttributeChange{pwChange("replace", v)})
		if err != nil {
			t.Fatal(err)
		}
		plan := p.finish()
		if out[0].Values[0] != "{HASHED-CRYPT-SHA512}"+v || plan.Kept != 0 || plan.Hashed != 1 || plan.CleartextSent || plan.NeedsConfirm {
			t.Errorf("client %q: %q %+v", v, out[0].Values, plan)
		}
		if !slices.ContainsFunc(plan.Warnings, func(w string) bool { return strings.Contains(w, "not a hash of a known storage scheme") }) {
			t.Errorf("client %q: warnings %q", v, plan.Warnings)
		}
		for _, w := range append(plan.Warnings, plan.Actions...) {
			if strings.Contains(w, v) || strings.Contains(strings.ToUpper(w), "SUMMER") {
				t.Errorf("message %q contains the value", w)
			}
		}
		// server over plain LDAP: cleartext on the wire needs a confirmation
		sp, err := PlanPasswordChanges(testPolicy(models.PasswordPolicyServer, plain), []models.AttributeChange{pwChange("replace", v)}, models.PasswordWriteOptions{})
		if err != nil || !sp.CleartextSent || !sp.NeedsConfirm || sp.Kept != 0 {
			t.Errorf("server %q: %+v %v", v, sp, err)
		}
		// ask: needs a decision
		ap, err := PlanPasswordChanges(testPolicy(models.PasswordPolicyAsk), []models.AttributeChange{pwChange("replace", v)}, models.PasswordWriteOptions{})
		if err != nil || !ap.NeedsDecision {
			t.Errorf("ask %q: %+v %v", v, ap, err)
		}
		// LDIF opt-out over plain LDAP: sent as given, confirmation needed
		ip, err := PlanPasswordChanges(testPolicy(models.PasswordPolicyClient, plain), []models.AttributeChange{pwChange("add", v)}, models.PasswordWriteOptions{AsIs: true})
		if err != nil || !ip.NeedsConfirm || ip.Cleartext != 1 {
			t.Errorf("as is %q: %+v %v", v, ip, err)
		}
		// delete over plain LDAP: the value is a cleartext password on the wire
		dp, err := PlanPasswordChanges(testPolicy(models.PasswordPolicyClient, plain), []models.AttributeChange{pwChange("delete", v)}, models.PasswordWriteOptions{})
		if err != nil || !dp.NeedsConfirm {
			t.Errorf("delete %q: %+v %v", v, dp, err)
		}
	}
	// {CLEAR} sent as given warns before the write.
	cp, _ := PlanPasswordChanges(testPolicy(models.PasswordPolicyServer, func(e *models.EffectivePasswordPolicy) { e.ServerType = models.ServerType389DS; e.ServerHashes = true }),
		[]models.AttributeChange{pwChange("replace", "{CLEAR}x")}, models.PasswordWriteOptions{})
	if !slices.ContainsFunc(cp.Warnings, func(w string) bool { return strings.Contains(w, "cleartext tag") }) {
		t.Errorf("{CLEAR} warnings %q", cp.Warnings)
	}
}

// TestPasswordPolicyOID: userPassword (2.5.4.35) and unicodePwd written by
// their OID go through the hook like their names.
func TestPasswordPolicyOID(t *testing.T) {
	for _, name := range []string{"2.5.4.35", "2.5.4.35;binary"} {
		if !IsPasswordAttribute(name) {
			t.Errorf("IsPasswordAttribute(%q) = false", name)
		}
	}
	if IsPasswordAttribute("2.5.4.3") || IsPasswordAttribute("12.5.4.35") {
		t.Error("other OIDs are not userPassword")
	}
	if !IsUnicodePwdAttribute("1.2.840.113556.1.4.90") || !IsUnicodePwdAttribute("unicodePwd;binary") {
		t.Error("unicodePwd OID not recognized")
	}
	plain := testPolicy(models.PasswordPolicyClient, func(e *models.EffectivePasswordPolicy) { e.TLS = false })
	changes := []models.AttributeChange{{Operation: "replace", Attribute: "2.5.4.35", Values: []string{"Secret1!"}}}
	if !hasPasswordValues(changes) || !hasUserPasswordValues(changes) {
		t.Fatal("OID write skips the hook")
	}
	p, err := newPasswordPlanner(plain, models.PasswordWriteOptions{}, fakeHash)
	if err != nil {
		t.Fatal(err)
	}
	out, _, _, err := p.changes(changes)
	if err != nil || out[0].Values[0] != "{HASHED-CRYPT-SHA512}Secret1!" {
		t.Errorf("OID values %q %v", out[0].Values, err)
	}
	sp, _ := PlanPasswordChanges(testPolicy(models.PasswordPolicyServer, func(e *models.EffectivePasswordPolicy) { e.TLS = false }), changes, models.PasswordWriteOptions{})
	if !sp.NeedsConfirm {
		t.Errorf("OID cleartext over plain LDAP: %+v", sp)
	}
	up, _ := PlanPasswordChanges(plain, []models.AttributeChange{{Operation: "replace", Attribute: "1.2.840.113556.1.4.90", Values: []string{"x"}}}, models.PasswordWriteOptions{})
	if !up.NeedsConfirm {
		t.Errorf("unicodePwd OID over plain LDAP: %+v", up)
	}
	if !ChangesClearPermanentLock(changes) {
		t.Error("OID password change does not guard the permanent lock")
	}
}

// TestPasswordReportSupport: a client-side scheme the server type may not
// verify is reported after the write (configured and per-write decision).
func TestPasswordReportSupport(t *testing.T) {
	bcrypt := testPolicy(models.PasswordPolicyClient, func(e *models.EffectivePasswordPolicy) { e.Scheme = SchemeBcrypt })
	p, err := newPasswordPlanner(bcrypt, models.PasswordWriteOptions{}, fakeHash)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := p.changes([]models.AttributeChange{pwChange("replace", "secret")}); err != nil {
		t.Fatal(err)
	}
	plan := p.finish()
	if !slices.ContainsFunc(plan.Warnings, func(w string) bool { return strings.Contains(w, "crypt(3)") }) {
		t.Errorf("plan warnings %q", plan.Warnings)
	}
	// Stored as sent ({CRYPT}$2b$ on a glibc OpenLDAP): unconfirmed.
	r := buildPasswordReport(p, plan, []string{"{CRYPT}$2b$10$abcdefghijklmnopqrstuuE.raKqW7PfznPwPMZX1rcxu70SU8Kn6"}, nil, nil)
	if !r.Unconfirmed || r.Ineffective || len(r.Warnings) == 0 {
		t.Errorf("bcrypt report %+v", r)
	}
	// Not readable: still unconfirmed.
	if r := buildPasswordReport(p, plan, nil, nil, nil); !r.Unconfirmed {
		t.Errorf("unread report %+v", r)
	}
	// Re-hashed: ineffective, the support warning is superseded.
	if r := buildPasswordReport(p, plan, []string{"{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g="}, nil, nil); !r.Ineffective || r.Unconfirmed {
		t.Errorf("re-hashed report %+v", r)
	}

	// A per-write "ask" decision gets the same warnings.
	ap, err := PlanPasswordChanges(testPolicy(models.PasswordPolicyAsk), []models.AttributeChange{pwChange("replace", "secret")},
		models.PasswordWriteOptions{Policy: models.PasswordPolicyClient, Scheme: SchemeArgon2})
	if err != nil || !slices.ContainsFunc(ap.Warnings, func(w string) bool { return strings.Contains(w, "argon2") }) {
		t.Errorf("ask decision warnings %q %v", ap.Warnings, err)
	}
	// A native scheme has none.
	native, _ := newPasswordPlanner(testPolicy(models.PasswordPolicyClient), models.PasswordWriteOptions{}, fakeHash)
	native.changes([]models.AttributeChange{pwChange("replace", "secret")})
	nplan := native.finish()
	if r := buildPasswordReport(native, nplan, []string{"{CRYPT}$6$salt$hash"}, nil, nil); r.Unconfirmed || r.Ineffective || len(r.Warnings) != 0 {
		t.Errorf("native report %+v", r)
	}
	// A scheme the server type does not support: ineffective.
	none := testPolicy(models.PasswordPolicyClient, func(e *models.EffectivePasswordPolicy) {
		e.ServerType, e.Scheme = models.ServerType389DS, SchemeArgon2
	})
	np, _ := newPasswordPlanner(none, models.PasswordWriteOptions{}, fakeHash)
	np.changes([]models.AttributeChange{pwChange("replace", "secret")})
	if r := buildPasswordReport(np, np.finish(), nil, nil, nil); !r.Ineffective {
		t.Errorf("unsupported scheme report %+v", r)
	}
}

func TestAssessStoredPasswords(t *testing.T) {
	r := &models.PasswordWriteReport{}
	assessStoredPasswords(r, []string{"{CRYPT}$6$salt$hash"}, []string{SchemeCryptSHA512}, nil, false)
	if r.Cleartext || r.Ineffective || len(r.Warnings) != 0 || !slices.Equal(r.StoredSchemes, []string{"{CRYPT} SHA-512-crypt ($6$)"}) {
		t.Errorf("matching scheme: %+v", r)
	}
	r = &models.PasswordWriteReport{}
	assessStoredPasswords(r, []string{"secret"}, nil, nil, false)
	if !r.Cleartext || len(r.Warnings) != 1 || !slices.Equal(r.StoredSchemes, []string{"cleartext"}) || !strings.Contains(r.Warnings[0], "client") {
		t.Errorf("cleartext: %+v", r)
	}
	ad := &models.PasswordWriteReport{}
	assessStoredPasswords(ad, []string{"secret"}, nil, nil, true)
	if !ad.Cleartext || len(ad.Warnings) != 1 || !strings.Contains(ad.Warnings[0], "unicodePwd") {
		t.Errorf("AD cleartext: %+v", ad)
	}
	for _, w := range r.Warnings {
		if strings.Contains(w, "secret") {
			t.Error("warning contains the password")
		}
	}
	// The server re-hashed a {SSHA512} hash string as cleartext (OpenLDAP
	// without pw-sha2 and with olcPPolicyHashCleartext).
	r = &models.PasswordWriteReport{}
	assessStoredPasswords(r, []string{"{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g="}, []string{SchemeSSHA512}, nil, false)
	if !r.Ineffective || len(r.Warnings) != 1 || !strings.Contains(r.Warnings[0], "will NOT work") {
		t.Errorf("re-hashed: %+v", r)
	}
	// Explicit cleartext tags and unknown tags are flagged as cleartext;
	// the unknown tag is not echoed.
	for _, v := range []string{"{CLEAR}secret", "{Summer}2026!", "{ssha}garbage"} {
		r = &models.PasswordWriteReport{}
		assessStoredPasswords(r, []string{v}, nil, nil, false)
		if !r.Cleartext || len(r.Warnings) != 1 {
			t.Errorf("%q: %+v", v, r)
		}
		for _, m := range append(r.Warnings, r.Actions...) {
			if strings.Contains(strings.ToUpper(m), "SUMMER") {
				t.Errorf("%q: message %q leaks the tag", v, m)
			}
		}
	}
}

// TestPasswordReportAddedValues: after adding a value, only the added
// value is judged; an older cleartext value gets its own warning instead
// of blaming the policy that hashed the new one.
func TestPasswordReportAddedValues(t *testing.T) {
	p, err := newPasswordPlanner(testPolicy(models.PasswordPolicyClient), models.PasswordWriteOptions{}, fakeHash)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := p.changes([]models.AttributeChange{pwChange("add", "secret")}); err != nil {
		t.Fatal(err)
	}
	plan := p.finish()
	before := []string{"legacy-cleartext"}
	stored := []string{"legacy-cleartext", "{CRYPT}$6$salt$hash"}
	r := buildPasswordReport(p, plan, stored, before, nil)
	if r.Cleartext || r.Ineffective || !slices.Equal(r.StoredSchemes, []string{"{CRYPT} SHA-512-crypt ($6$)"}) {
		t.Errorf("added value judged wrongly: %+v", r)
	}
	if len(r.Warnings) != 1 || !strings.Contains(r.Warnings[0], "not set by this write") || strings.Contains(r.Warnings[0], "legacy") {
		t.Errorf("older cleartext warning: %q", r.Warnings)
	}
	// Without the values from before, every value is judged.
	if r := buildPasswordReport(p, plan, stored, nil, nil); !r.Cleartext {
		t.Errorf("no before: %+v", r)
	}
	// A re-hashed added value is still caught when an older value has the
	// scheme that was sent.
	r = buildPasswordReport(p, plan, []string{"{CRYPT}$6$old$hash", "{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g="}, []string{"{CRYPT}$6$old$hash"}, nil)
	if !r.Ineffective {
		t.Errorf("re-hashed added value: %+v", r)
	}
	if added, older := splitStoredPasswords([]string{"a", "a", "b"}, []string{"a"}); !slices.Equal(added, []string{"a", "b"}) || !slices.Equal(older, []string{"a"}) {
		t.Errorf("split %q %q", added, older)
	}
}

func TestMergePasswordPlans(t *testing.T) {
	a := models.PasswordWritePlan{Values: 1, Hashed: 1, Actions: []string{"x"}, Warnings: []string{}}
	b := models.PasswordWritePlan{HasPasswords: true, Values: 2, Cleartext: 2, NeedsConfirm: true, Actions: []string{"x", "y"}, Warnings: []string{"w"}}
	m := MergePasswordPlans(a, b)
	if !m.HasPasswords || m.Values != 3 || m.Hashed != 1 || m.Cleartext != 2 || !m.NeedsConfirm || !slices.Equal(m.Actions, []string{"x", "y"}) || len(m.Warnings) != 1 {
		t.Errorf("merged %+v", m)
	}
}

// TestPasswordReportKeptSchemes (issue #1, D1): an already hashed value is
// sent unchanged; a server that cannot verify its scheme hashes the hash
// string again (OpenLDAP with olcPPolicyHashCleartext, 389DS), so the
// password stops working. The write must say "will not work" instead of
// "nothing needs attention".
func TestPasswordReportKeptSchemes(t *testing.T) {
	ssha512, err := HashPassword(SchemeSSHA512, "secret")
	if err != nil {
		t.Fatal(err)
	}
	ssha, _ := HashPassword(SchemeSSHA, "secret")
	const argon2 = "{ARGON2}$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo"
	const bcryptValue = "{CRYPT}$2b$10$abcdefghijklmnopqrstuuE.raKqW7PfznPwPMZX1rcxu70SU8Kn6"

	plan := func(t *testing.T, eff models.EffectivePasswordPolicy, values ...string) (*passwordPlanner, models.PasswordWritePlan) {
		t.Helper()
		p, err := newPasswordPlanner(eff, models.PasswordWriteOptions{}, fakeHash)
		if err != nil {
			t.Fatal(err)
		}
		out, _, _, err := p.changes([]models.AttributeChange{pwChange("replace", values...)})
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(out[0].Values, values) {
			t.Fatalf("kept values changed: %q", out[0].Values)
		}
		return p, p.finish()
	}
	contains := func(list []string, sub string) bool {
		return slices.ContainsFunc(list, func(w string) bool { return strings.Contains(w, sub) })
	}

	// OpenLDAP without pw-sha2 re-hashes a kept {SSHA512} value as {SSHA}.
	ol := testPolicy(models.PasswordPolicyClient)
	p, pl := plan(t, ol, ssha512)
	if pl.Kept != 1 || pl.Hashed != 0 || !contains(pl.Warnings, "already hashed {SSHA512}") || !contains(pl.Warnings, "pw-sha2") {
		t.Errorf("plan %+v", pl)
	}
	r := buildPasswordReport(p, pl, []string{ssha}, nil, nil)
	if !r.Ineffective || r.Unconfirmed || !contains(r.Warnings, "already hashed {SSHA512} salted SHA-512 value that was sent") || !contains(r.Warnings, "will NOT work") {
		t.Errorf("re-hashed kept value: %+v", r)
	}
	for _, w := range r.Warnings {
		if strings.Contains(w, ssha512[len("{SSHA512}"):]) || strings.Contains(w, ssha[len("{SSHA}"):]) {
			t.Errorf("warning leaks a stored value: %q", w)
		}
	}
	// Stored as sent: the server may still lack the module (unconfirmed).
	if r := buildPasswordReport(p, pl, []string{ssha512}, nil, nil); r.Ineffective || !r.Unconfirmed {
		t.Errorf("kept {SSHA512} stored as sent: %+v", r)
	}

	// 389DS has no argon2: never works, before and after the read-back.
	ds := testPolicy(models.PasswordPolicyServer, func(e *models.EffectivePasswordPolicy) {
		e.ServerType, e.ServerHashes, e.PasswordModifyExop = models.ServerType389DS, true, true
	})
	p, pl = plan(t, ds, argon2)
	if pl.Exop || pl.Kept != 1 || !contains(pl.Warnings, "does not support the scheme") {
		t.Errorf("389DS {ARGON2} plan %+v", pl)
	}
	if r := buildPasswordReport(p, pl, []string{"{PBKDF2-SHA512}10000$c2FsdA$aGFzaA"}, nil, nil); !r.Ineffective || !contains(r.Warnings, "already hashed {ARGON2} argon2id") {
		t.Errorf("389DS re-hashed {ARGON2}: %+v", r)
	}
	if r := buildPasswordReport(p, pl, nil, nil, nil); !r.Ineffective {
		t.Errorf("389DS {ARGON2} not readable: %+v", r)
	}

	// A scheme the server knows natively: nothing needs attention.
	p, pl = plan(t, ol, ssha)
	if len(pl.Warnings) != 0 {
		t.Errorf("native kept scheme warns: %q", pl.Warnings)
	}
	if r := buildPasswordReport(p, pl, []string{ssha}, nil, nil); r.Ineffective || r.Unconfirmed || len(r.Warnings) != 0 {
		t.Errorf("native kept scheme report %+v", r)
	}

	// A kept scheme outside the catalog is judged by the read-back alone.
	const ssha384 = "{SSHA384}W6ph5Mm5Pz8GgiULbPgzG37mj9gW6ph5Mm5Pz8GgiULbPgzG37mj9gW6ph5Mm5Pz8GgiUL"
	p, pl = plan(t, ol, ssha384)
	if len(pl.Warnings) != 0 {
		t.Errorf("uncatalogued kept scheme warns before the write: %q", pl.Warnings)
	}
	if r := buildPasswordReport(p, pl, []string{ssha}, nil, nil); !r.Ineffective || !contains(r.Warnings, "{SSHA384}") {
		t.Errorf("uncatalogued kept scheme re-hashed: %+v", r)
	}

	// bcrypt kept on OpenLDAP (crypt(3) may lack it): "may not work".
	p, pl = plan(t, ol, bcryptValue)
	if r := buildPasswordReport(p, pl, []string{bcryptValue}, nil, nil); r.Ineffective || !r.Unconfirmed || !contains(r.Warnings, "crypt(3)") {
		t.Errorf("kept bcrypt: %+v", r)
	}

	// Client hashing plus a kept value of the same scheme: one warning set.
	sameScheme := testPolicy(models.PasswordPolicyClient, func(e *models.EffectivePasswordPolicy) { e.Scheme = SchemeSSHA512 })
	p, pl = plan(t, sameScheme, ssha512)
	p2, _ := newPasswordPlanner(sameScheme, models.PasswordWriteOptions{}, fakeHash)
	p2.changes([]models.AttributeChange{pwChange("replace", ssha512, "new")})
	pl2 := p2.finish()
	if n := len(pl2.Warnings); n != 1 {
		t.Errorf("same scheme hashed and kept: %d warnings %q", n, pl2.Warnings)
	}
	_ = p

	// AD: the AD warning covers every value; no kept-scheme verdict.
	adp, adpl := plan(t, testPolicy(models.PasswordPolicyAD), ssha)
	if contains(adpl.Warnings, "already hashed") {
		t.Errorf("AD plan %q", adpl.Warnings)
	}
	if r := buildPasswordReport(adp, adpl, []string{ssha}, nil, nil); r.Ineffective {
		t.Errorf("AD report %+v", r)
	}
}
