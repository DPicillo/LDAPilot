package services

import (
	"errors"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

func TestPasswordAccountChanges(t *testing.T) {
	req := func(must, unlock bool) models.PasswordChangeRequest {
		return models.PasswordChangeRequest{MustChange: must, Unlock: unlock}
	}
	render := func(changes []models.AttributeChange) string {
		parts := []string{}
		for _, c := range changes {
			parts = append(parts, c.Operation+" "+c.Attribute+"="+strings.Join(c.Values, ","))
		}
		return strings.Join(parts, "; ")
	}
	tests := []struct {
		name       string
		serverType string
		ppolicy    bool
		req        models.PasswordChangeRequest
		want       string
		wantErr    bool
	}{
		{"nothing", models.ServerTypeAD, false, req(false, false), "", false},
		{"ad must change", models.ServerTypeAD, false, req(true, false), "replace pwdLastSet=0", false},
		{"ad unlock", models.ServerTypeAD, false, req(false, true), "replace lockoutTime=0", false},
		{"ad both", models.ServerTypeAD, false, req(true, true), "replace pwdLastSet=0; replace lockoutTime=0", false},
		{"openldap must change", models.ServerTypeOpenLDAP, true, req(true, false), "replace pwdReset=TRUE", false},
		{"openldap unlock is done by ppolicy", models.ServerTypeOpenLDAP, true, req(false, true), "", false},
		{"openldap without ppolicy", models.ServerTypeOpenLDAP, false, req(true, false), "", true},
		{"openldap unlock without ppolicy", models.ServerTypeOpenLDAP, false, req(false, true), "", true},
		{"389ds must change", models.ServerType389DS, true, req(true, false), "", true},
		{"389ds unlock is done by the reset", models.ServerType389DS, true, req(false, true), "", false},
		{"other", models.ServerTypeOther, true, req(true, false), "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := passwordAccountChanges(tt.serverType, tt.ppolicy, tt.req)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if r := render(got); r != tt.want {
				t.Errorf("changes = %q, want %q", r, tt.want)
			}
		})
	}
}

func TestPasswordValueChange(t *testing.T) {
	ch, err := passwordValueChange(models.PasswordChangeRequest{Method: models.PasswordMethodUnicodePwd, Password: "Grüße!"})
	if err != nil || ch.Attribute != "unicodePwd" || ch.Operation != models.ChangeReplace || ch.Values[0] != "Grüße!" || ch.Binary {
		t.Errorf("unicodePwd change = %+v, %v", ch, err)
	}
	ch, err = passwordValueChange(models.PasswordChangeRequest{Method: models.PasswordMethodUserPassword, Password: "pw", Scheme: "ssha512"})
	if err != nil || ch.Attribute != "userPassword" || !strings.HasPrefix(ch.Values[0], "{SSHA512}") {
		t.Errorf("userPassword change = %+v, %v", ch, err)
	}
	ch, err = passwordValueChange(models.PasswordChangeRequest{Method: models.PasswordMethodUserPassword, Password: "pw", Scheme: "CLEARTEXT"})
	if err != nil || ch.Values[0] != "pw" {
		t.Errorf("cleartext change = %+v, %v", ch, err)
	}
	if ch, err := passwordValueChange(models.PasswordChangeRequest{Method: models.PasswordMethodExop, Password: "pw"}); ch != nil || err != nil {
		t.Errorf("exop = %+v, %v", ch, err)
	}
	for _, bad := range []models.PasswordChangeRequest{
		{Method: "bogus", Password: "pw"},
		{Method: models.PasswordMethodUserPassword, Password: "pw"},
		{Method: models.PasswordMethodUserPassword, Password: "pw", Scheme: "NOPE"},
	} {
		if _, err := passwordValueChange(bad); err == nil {
			t.Errorf("%+v accepted", bad)
		}
	}
}

func TestPasswordAuditNeverContainsSecrets(t *testing.T) {
	const pw = "S3cret!Grüße"
	for _, method := range []string{models.PasswordMethodUnicodePwd, models.PasswordMethodUserPassword, models.PasswordMethodExop} {
		req := models.PasswordChangeRequest{Method: method, Password: pw, Scheme: "SSHA", MustChange: true}
		pwdChange, err := passwordValueChange(req)
		if err != nil {
			t.Fatal(err)
		}
		account := []models.AttributeChange{{Operation: "replace", Attribute: "pwdLastSet", Values: []string{"0"}}}
		details := describePasswordChangeForAudit(req, pwdChange, account)
		if strings.Contains(details, pw) {
			t.Errorf("%s: audit contains the password: %s", method, details)
		}
		if pwdChange != nil && strings.Contains(details, pwdChange.Values[0]) {
			t.Errorf("%s: audit contains the stored value: %s", method, details)
		}
		if !strings.Contains(details, "password reset via") || !strings.Contains(details, "pwdLastSet=[0]") {
			t.Errorf("%s: unexpected audit details %q", method, details)
		}
		if pwdChange != nil {
			if op := describePasswordOperation(*pwdChange); strings.Contains(op, pw) || strings.Contains(op, "=") {
				t.Errorf("%s: operation shows the value: %q", method, op)
			}
		}
	}
	if got := describePasswordOperation(models.AttributeChange{Operation: "replace", Attribute: "pwdReset", Values: []string{"TRUE"}}); got != "replace pwdReset=TRUE" {
		t.Errorf("describePasswordOperation = %q", got)
	}
}

func TestAssessPassword(t *testing.T) {
	userPw := func(scheme string) models.PasswordChangeRequest {
		return models.PasswordChangeRequest{Method: models.PasswordMethodUserPassword, Scheme: scheme}
	}
	exop := models.PasswordChangeRequest{Method: models.PasswordMethodExop}
	unicode := models.PasswordChangeRequest{Method: models.PasswordMethodUnicodePwd}
	tests := []struct {
		name         string
		server       string
		req          models.PasswordChangeRequest
		stored       string
		verified     bool
		verifyFailed bool
		ineffective  bool
		unconfirmed  bool
		warn         string // substring of the warnings; "" = no warnings
	}{
		{"native scheme stored as sent", models.ServerTypeOpenLDAP, userPw("SSHA"), "SSHA", false, false, false, false, ""},
		{"native on 389DS", models.ServerType389DS, userPw("PBKDF2-SHA512"), "PBKDF2-SHA512", false, false, false, false, ""},
		{"re-hashed by ppolicy", models.ServerTypeOpenLDAP, userPw("SSHA512"), "SSHA", false, false, true, false, "will NOT work"},
		{"crypt re-hashed", models.ServerTypeOpenLDAP, userPw("CRYPT-SHA512"), "SSHA", false, false, true, false, "{CRYPT}"},
		// OpenLDAP without olcPPolicyHashCleartext stores an unknown scheme verbatim.
		{"module scheme stored verbatim", models.ServerTypeOpenLDAP, userPw("SSHA512"), "SSHA512", false, false, false, true, "pw-sha2"},
		{"module scheme proven by bind", models.ServerTypeOpenLDAP, userPw("SSHA512"), "SSHA512", true, false, false, false, ""},
		{"module scheme, bind failed", models.ServerTypeOpenLDAP, userPw("SSHA512"), "SSHA512", false, true, true, true, "pw-sha2"},
		{"unsupported scheme", models.ServerType389DS, userPw("ARGON2"), "ARGON2", false, false, true, false, "does not support"},
		{"unsupported scheme re-hashed", models.ServerType389DS, userPw("ARGON2"), "PBKDF2-SHA512", false, false, true, false, "will NOT work"},
		{"unknown server type", models.ServerTypeOther, userPw("SSHA"), "SSHA", false, false, false, true, "unknown"},
		{"unknown server type, unreadable", models.ServerTypeOther, userPw("SSHA"), "", false, false, false, true, "not confirmed"},
		{"unknown server type, verified", models.ServerTypeOther, userPw("SSHA"), "SSHA", true, false, false, false, ""},
		{"cleartext hashed by the server", models.ServerTypeOpenLDAP, userPw("CLEARTEXT"), "SSHA", false, false, false, false, ""},
		{"cleartext stored as such works", models.ServerTypeOpenLDAP, userPw("CLEARTEXT"), "CLEARTEXT", false, false, false, false, "stored the password in cleartext"},
		{"exop stored in cleartext works", models.ServerTypeOther, exop, "CLEARTEXT", true, false, false, false, "stored the password in cleartext"},
		{"exop", models.ServerType389DS, exop, "PBKDF2-SHA512", false, false, false, false, ""},
		{"exop bind failed", models.ServerTypeOpenLDAP, exop, "SSHA", false, true, true, false, ""},
		{"AD hashed userPassword", models.ServerTypeAD, userPw("SSHA"), "SSHA", false, false, true, false, "hash itself"},
		{"AD cleartext userPassword", models.ServerTypeAD, userPw("CLEARTEXT"), "CLEARTEXT", false, false, false, true, "fUserPwdSupport"},
		{"AD cleartext userPassword verified", models.ServerTypeAD, userPw("CLEARTEXT"), "", true, false, false, false, "fUserPwdSupport"},
		{"AD unicodePwd", models.ServerTypeAD, unicode, "", false, false, false, false, ""},
		{"AD unicodePwd bind failed", models.ServerTypeAD, unicode, "", false, true, true, false, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := assessPassword(tt.server, tt.req, tt.stored, "", tt.verified, tt.verifyFailed)
			if a.ineffective != tt.ineffective || a.unconfirmed != tt.unconfirmed {
				t.Errorf("ineffective=%v unconfirmed=%v, want %v %v (warnings %v)", a.ineffective, a.unconfirmed, tt.ineffective, tt.unconfirmed, a.warnings)
			}
			all := strings.Join(a.warnings, "\n")
			if tt.warn == "" && len(a.warnings) > 0 {
				t.Errorf("unexpected warnings %v", a.warnings)
			}
			if tt.warn != "" && !strings.Contains(all, tt.warn) {
				t.Errorf("warnings %q lack %q", all, tt.warn)
			}
		})
	}
}

func TestAssessPasswordStoredLabel(t *testing.T) {
	req := models.PasswordChangeRequest{Method: models.PasswordMethodUserPassword, Scheme: ldap.SchemeSSHA512}
	a := assessPassword(models.ServerTypeOpenLDAP, req, ldap.SchemeCryptSHA512, "{CRYPT} SHA-512-crypt ($6$)", false, false)
	all := strings.Join(a.warnings, "\n")
	if !strings.Contains(all, "stored {CRYPT} SHA-512-crypt ($6$) instead of the {SSHA512} value") || strings.Contains(all, "{CRYPT-SHA512}") {
		t.Errorf("warnings %q", all)
	}
}

func TestSchemeSupportOn(t *testing.T) {
	if l, _ := schemeSupportOn("ssha512", models.ServerTypeOpenLDAP); l != models.SchemeSupportModule {
		t.Errorf("SSHA512/openldap = %q", l)
	}
	if l, _ := schemeSupportOn("SSHA", models.ServerTypeAD); l != models.SchemeSupportNone {
		t.Errorf("SSHA/ad = %q", l)
	}
	if l, _ := schemeSupportOn("CLEARTEXT", models.ServerTypeAD); l != "" {
		t.Errorf("CLEARTEXT/ad = %q", l)
	}
	if l, _ := schemeSupportOn("SSHA", models.ServerTypeOther); l != "" {
		t.Errorf("SSHA/other = %q", l)
	}
}

func entry(attrs map[string][]string) *goldap.Entry {
	return goldap.NewEntry("cn=x", attrs)
}

func TestApplyPasswordState(t *testing.T) {
	// OpenLDAP: the permanent ppolicy lock is "disabled" (account panel), a
	// timed lock is a lockout.
	pcOL := &models.PasswordContext{ServerType: models.ServerTypeOpenLDAP}
	applyPasswordState(pcOL, entry(map[string][]string{"objectClass": {"inetOrgPerson"}, "pwdAccountLockedTime": {"000001010000Z"}}))
	if !pcOL.Disabled || pcOL.Locked {
		t.Errorf("OpenLDAP disabled state = %+v", pcOL)
	}
	pcOL = &models.PasswordContext{ServerType: models.ServerTypeOpenLDAP}
	applyPasswordState(pcOL, entry(map[string][]string{"objectClass": {"inetOrgPerson"}, "pwdAccountLockedTime": {"20261030010203Z"}}))
	if pcOL.Disabled || !pcOL.Locked {
		t.Errorf("OpenLDAP locked state = %+v", pcOL)
	}
	pc := &models.PasswordContext{ServerType: models.ServerTypeAD}
	applyPasswordState(pc, entry(map[string][]string{
		"objectClass":                        {"top", "person", "organizationalPerson", "user"},
		"pwdLastSet":                         {"0"},
		"userAccountControl":                 {"514"},
		"lockoutTime":                        {"134377888780000000"},
		"msDS-User-Account-Control-Computed": {"8388624"}, // LOCKOUT | PASSWORD_EXPIRED
	}))
	if !pc.IsADAccount || !pc.MustChange || !pc.Disabled || !pc.Locked || pc.HasUserPassword {
		t.Errorf("AD state = %+v", pc)
	}
	// An expired lockout leaves lockoutTime set; the computed flag decides.
	pc = &models.PasswordContext{ServerType: models.ServerTypeAD}
	applyPasswordState(pc, entry(map[string][]string{
		"objectClass": {"user", "computer"}, "lockoutTime": {"1"}, "msDS-User-Account-Control-Computed": {"0"},
		"pwdLastSet": {"134377888787595553"}, "userAccountControl": {"4096"},
	}))
	if !pc.IsADAccount || pc.Locked || pc.MustChange || pc.Disabled {
		t.Errorf("AD computer state = %+v", pc)
	}
	// pwdLastSet=0 with DONT_EXPIRE_PASSWORD: AD does not enforce the change
	// (lab: UAC 66048, computed 0) - not pending.
	pc = &models.PasswordContext{ServerType: models.ServerTypeAD}
	applyPasswordState(pc, entry(map[string][]string{
		"objectClass": {"user"}, "pwdLastSet": {"0"}, "userAccountControl": {"66048"}, "msDS-User-Account-Control-Computed": {"0"},
	}))
	if !pc.PasswordNeverExpires || pc.MustChange || pc.Disabled {
		t.Errorf("AD never-expires state = %+v", pc)
	}
	// Without the constructed attribute pwdLastSet decides, unless the
	// password never expires.
	pc = &models.PasswordContext{ServerType: models.ServerTypeAD}
	applyPasswordState(pc, entry(map[string][]string{"objectClass": {"user"}, "pwdLastSet": {"0"}, "userAccountControl": {"66048"}}))
	if pc.MustChange || !pc.PasswordNeverExpires {
		t.Errorf("AD never-expires without computed = %+v", pc)
	}
	pc = &models.PasswordContext{ServerType: models.ServerTypeAD}
	applyPasswordState(pc, entry(map[string][]string{"objectClass": {"user"}, "pwdLastSet": {"0"}, "userAccountControl": {"512"}}))
	if !pc.MustChange || pc.PasswordNeverExpires {
		t.Errorf("AD must change without computed = %+v", pc)
	}
	pc = &models.PasswordContext{ServerType: models.ServerTypeAD}
	applyPasswordState(pc, entry(map[string][]string{"objectClass": {"contact"}, "lockoutTime": {"5"}}))
	if pc.IsADAccount || !pc.Locked {
		t.Errorf("AD contact state = %+v", pc)
	}

	pc = &models.PasswordContext{ServerType: models.ServerTypeOpenLDAP}
	applyPasswordState(pc, entry(map[string][]string{
		"objectClass":          {"inetOrgPerson"},
		"userPassword":         {"{CRYPT}$6$abc$def"},
		"pwdReset":             {"TRUE"},
		"pwdAccountLockedTime": {"20261029230851Z"},
	}))
	if pc.IsADAccount || !pc.HasUserPassword || pc.CurrentScheme != "CRYPT-SHA512" || !pc.MustChange || !pc.Locked {
		t.Errorf("OpenLDAP state = %+v", pc)
	}
	pc = &models.PasswordContext{ServerType: models.ServerTypeOpenLDAP}
	applyPasswordState(pc, entry(map[string][]string{}))
	if pc.ObjectClasses == nil || pc.HasUserPassword || pc.Locked {
		t.Errorf("empty state = %+v", pc)
	}
}

func TestPasswordErrorHint(t *testing.T) {
	ldapErr := func(code uint16) error {
		return &goldap.Error{ResultCode: code, Err: errors.New("x")}
	}
	tests := []struct {
		serverType string
		tls        bool
		err        error
		want       string
	}{
		{models.ServerTypeAD, false, ldapErr(goldap.LDAPResultUnwillingToPerform), "encrypted connection"},
		{models.ServerTypeAD, true, ldapErr(goldap.LDAPResultUnwillingToPerform), ""},
		{models.ServerType389DS, false, ldapErr(goldap.LDAPResultConfidentialityRequired), "LDAPS or StartTLS"},
		{models.ServerTypeAD, true, ldapErr(goldap.LDAPResultConstraintViolation), "domain password policy"},
		{models.ServerTypeOpenLDAP, true, ldapErr(goldap.LDAPResultConstraintViolation), ""},
		{models.ServerTypeOpenLDAP, true, ldapErr(goldap.LDAPResultInsufficientAccessRights), "not allowed"},
	}
	for _, tt := range tests {
		got := passwordErrorHint(tt.serverType, tt.tls, tt.err)
		if !errors.Is(got, tt.err) {
			t.Errorf("hint lost the cause: %v", got)
		}
		if tt.want == "" && got != tt.err {
			t.Errorf("%s/%v: unexpected hint %q", tt.serverType, tt.tls, got)
		}
		if tt.want != "" && !strings.Contains(got.Error(), tt.want) {
			t.Errorf("%s/%v: %q lacks %q", tt.serverType, tt.tls, got, tt.want)
		}
	}
}

// ACCT-02: unicodePwd is refused over a connection without TLS before
// anything is sent, even when the cleartext send was confirmed.
func TestPasswordTransportError(t *testing.T) {
	tests := []struct {
		name    string
		req     models.PasswordChangeRequest
		tls     bool
		wantErr error
	}{
		{"unicodePwd plain", models.PasswordChangeRequest{Method: models.PasswordMethodUnicodePwd}, false, ldap.ErrPasswordNeedsTLS},
		{"unicodePwd plain confirmed", models.PasswordChangeRequest{Method: models.PasswordMethodUnicodePwd, AllowUnencrypted: true}, false, ldap.ErrPasswordNeedsTLS},
		{"unicodePwd TLS", models.PasswordChangeRequest{Method: models.PasswordMethodUnicodePwd}, true, nil},
		{"exop plain", models.PasswordChangeRequest{Method: models.PasswordMethodExop}, false, ldap.ErrPasswordUnencrypted},
		{"exop plain confirmed", models.PasswordChangeRequest{Method: models.PasswordMethodExop, AllowUnencrypted: true}, false, nil},
		{"cleartext userPassword plain", models.PasswordChangeRequest{Method: models.PasswordMethodUserPassword, Scheme: "CLEARTEXT"}, false, ldap.ErrPasswordUnencrypted},
		{"hashed userPassword plain", models.PasswordChangeRequest{Method: models.PasswordMethodUserPassword, Scheme: "SSHA"}, false, nil},
		{"hashed + verify bind plain", models.PasswordChangeRequest{Method: models.PasswordMethodUserPassword, Scheme: "SSHA", VerifyBind: true}, false, ldap.ErrPasswordUnencrypted},
	}
	for _, tt := range tests {
		err := passwordTransportError(tt.req, tt.tls)
		if tt.wantErr == nil {
			if err != nil {
				t.Errorf("%s: unexpected error %v", tt.name, err)
			}
			continue
		}
		if !errors.Is(err, tt.wantErr) {
			t.Errorf("%s: error %v, want %v", tt.name, err, tt.wantErr)
		}
	}
	if err := passwordTransportError(models.PasswordChangeRequest{Method: models.PasswordMethodUnicodePwd, AllowUnencrypted: true}, false); errors.Is(err, ldap.ErrPasswordUnencrypted) {
		t.Error("unicodePwd without TLS must not look like a confirmable cleartext send")
	}
}

// ACCT-10: the audit names the crypt(3) schemes like the stored value, never
// the internal id in braces.
func TestPasswordSchemeAuditLabel(t *testing.T) {
	for scheme, want := range map[string]string{
		"CRYPT-SHA512":  "{CRYPT} SHA-512-crypt ($6$)",
		"crypt-sha256":  "{CRYPT} SHA-256-crypt ($5$)",
		"CRYPT-BCRYPT":  "{CRYPT} bcrypt ($2b$)",
		"SSHA":          "{SSHA}",
		"pbkdf2-sha512": "{PBKDF2-SHA512}",
		"CLEARTEXT":     "cleartext",
	} {
		if got := passwordSchemeAuditLabel(scheme); got != want {
			t.Errorf("passwordSchemeAuditLabel(%q) = %q, want %q", scheme, got, want)
		}
	}
	req := models.PasswordChangeRequest{Method: models.PasswordMethodUserPassword, Password: "x", Scheme: "CRYPT-SHA512"}
	ch, err := passwordValueChange(req)
	if err != nil {
		t.Fatal(err)
	}
	details := describePasswordChangeForAudit(req, ch, nil)
	if strings.Contains(details, "{CRYPT-SHA512}") || !strings.Contains(details, "{CRYPT} SHA-512-crypt ($6$)") {
		t.Errorf("audit details %q", details)
	}
}

func TestApplyPasswordStateAccountNames(t *testing.T) {
	e := goldap.NewEntry("uid=jdoe,dc=x", map[string][]string{
		"objectClass": {"inetOrgPerson"}, "uid": {"jdoe"}, "cn": {"John Doe"}, "givenName": {"John"}, "sn": {"Doe"},
	})
	pc := &models.PasswordContext{ServerType: models.ServerTypeOpenLDAP}
	applyPasswordState(pc, e)
	want := []string{"jdoe", "John Doe", "John", "Doe"}
	if strings.Join(pc.AccountNames, "|") != strings.Join(want, "|") {
		t.Errorf("AccountNames = %v, want %v", pc.AccountNames, want)
	}
}
