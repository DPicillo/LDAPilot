package services

import (
	"slices"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

func clientPolicy(tls bool) models.EffectivePasswordPolicy {
	return models.EffectivePasswordPolicy{
		Policy: models.PasswordPolicyClient, Scheme: ldap.SchemeCryptSHA512, SchemeLabel: ldap.SchemeLabel(ldap.SchemeCryptSHA512),
		ServerType: models.ServerTypeOpenLDAP, TLS: tls, Warnings: []string{},
	}
}

const policyTestLDIF = `version: 1

dn: uid=new,ou=people,dc=example,dc=org
changetype: add
objectClass: inetOrgPerson
uid: new
cn: New
sn: User
userPassword: Initial2026!

dn: uid=old,ou=people,dc=example,dc=org
changetype: modify
replace: userPassword
userPassword: {SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=
-

dn: uid=gone,ou=people,dc=example,dc=org
changetype: delete
`

// TestPlanPasswordWriteLDIF covers the LDIF opt-out: by default cleartext
// values follow the policy, with AsIs they are stored exactly as in the
// file (and need a confirmation on an unencrypted connection).
func TestPlanPasswordWriteLDIF(t *testing.T) {
	plan, err := planPasswordWrite(clientPolicy(true), models.PasswordWritePlanRequest{LDIF: policyTestLDIF})
	if err != nil {
		t.Fatal(err)
	}
	if !plan.HasPasswords || plan.Values != 2 || plan.Hashed != 1 || plan.Kept != 1 || plan.Cleartext != 0 || plan.AsIs || plan.NeedsConfirm {
		t.Errorf("policy plan: %+v", plan)
	}

	plan, err = planPasswordWrite(clientPolicy(true), models.PasswordWritePlanRequest{LDIF: policyTestLDIF, Options: models.PasswordWriteOptions{AsIs: true}})
	if err != nil {
		t.Fatal(err)
	}
	if !plan.AsIs || plan.Hashed != 0 || plan.Cleartext != 1 || plan.Kept != 1 || plan.NeedsConfirm {
		t.Errorf("as-is plan: %+v", plan)
	}
	if !slices.ContainsFunc(plan.Warnings, func(w string) bool { return strings.Contains(w, "stored as given") }) {
		t.Errorf("as-is plan lacks the cleartext warning: %q", plan.Warnings)
	}

	plan, err = planPasswordWrite(clientPolicy(false), models.PasswordWritePlanRequest{LDIF: policyTestLDIF, Options: models.PasswordWriteOptions{AsIs: true}})
	if err != nil || !plan.NeedsConfirm || !plan.Unencrypted {
		t.Errorf("as-is plan without TLS: %+v %v", plan, err)
	}
	plan, err = planPasswordWrite(clientPolicy(false), models.PasswordWritePlanRequest{LDIF: policyTestLDIF})
	if err != nil || plan.NeedsConfirm {
		t.Errorf("hashing plan without TLS needs no confirmation: %+v %v", plan, err)
	}

	// The apply path uses the same options per record.
	parsed := parseLDIFChanges(policyTestLDIF)
	if len(parsed.Errors) != 0 || len(parsed.Records) != 3 {
		t.Fatalf("parse: %+v", parsed.Errors)
	}
	for _, asIs := range []bool{false, true} {
		pw := &ldifPasswordPlanning{policy: clientPolicy(true), opts: models.PasswordWriteOptions{AsIs: asIs}}
		rp := models.LDIFRecordPreview{Errors: []string{}, Warnings: []string{}}
		pw.annotate(&rp, &parsed.Records[0])
		joined := strings.Join(rp.Notes, "\n")
		if asIs != strings.Contains(joined, "stored exactly as given") || asIs == strings.Contains(joined, "hashed on the client") {
			t.Errorf("asIs=%v: notes %q", asIs, rp.Notes)
		}
		if asIs != (len(rp.Warnings) > 0) {
			t.Errorf("asIs=%v: warnings %q", asIs, rp.Warnings)
		}
		for _, m := range append(rp.Notes, rp.Warnings...) {
			if strings.Contains(m, "Initial2026!") {
				t.Errorf("message contains the password: %q", m)
			}
		}
	}
	// delete records carry no passwords
	rp := models.LDIFRecordPreview{}
	(&ldifPasswordPlanning{policy: clientPolicy(true)}).annotate(&rp, &parsed.Records[2])
	if len(rp.Notes)+len(rp.Warnings)+len(rp.Errors) != 0 {
		t.Errorf("delete record annotated: %+v", rp)
	}
	if !ldifHasPasswords(parsed) || ldifHasPasswords(parseLDIFChanges("dn: cn=x,dc=example,dc=org\nchangetype: delete\n")) {
		t.Error("ldifHasPasswords")
	}
}

func TestPlanPasswordWriteAsk(t *testing.T) {
	ask := models.EffectivePasswordPolicy{Policy: models.PasswordPolicyAsk, ServerType: models.ServerTypeOther, TLS: true, Warnings: []string{}}
	changes := []models.AttributeChange{{Operation: "replace", Attribute: "userPassword", Values: []string{"%uid%-Init"}}}
	plan, err := planPasswordWrite(ask, models.PasswordWritePlanRequest{Changes: changes})
	if err != nil || !plan.NeedsDecision {
		t.Fatalf("ask: %+v %v", plan, err)
	}
	plan, err = planPasswordWrite(ask, models.PasswordWritePlanRequest{Changes: changes, Options: models.PasswordWriteOptions{Policy: "client", Scheme: "SSHA"}})
	if err != nil || plan.NeedsDecision || plan.Hashed != 1 || plan.Policy.Policy != models.PasswordPolicyClient || plan.Policy.Scheme != "SSHA" {
		t.Fatalf("ask answered: %+v %v", plan, err)
	}
	// a request without passwords keeps the connection policy
	plan, err = planPasswordWrite(ask, models.PasswordWritePlanRequest{Attributes: []models.LDAPAttribute{{Name: "cn", Values: []string{"x"}}}})
	if err != nil || plan.HasPasswords || plan.Policy.Policy != models.PasswordPolicyAsk {
		t.Fatalf("no passwords: %+v %v", plan, err)
	}
}

func TestBatchPreviewPasswordPlan(t *testing.T) {
	pe := models.BulkPreviewEntry{Status: models.BulkStatusChange, Errors: []string{}, Warnings: []string{}, Notes: []string{}}
	resolved := []models.AttributeChange{{Operation: "replace", Attribute: "userPassword", Values: []string{"jdoe-Init2026"}}}
	addPasswordPlan(&pe, clientPolicy(false), resolved, models.PasswordWriteOptions{})
	if len(pe.Notes) != 1 || !strings.Contains(pe.Notes[0], "hashed on the client") || len(pe.Warnings) != 0 || pe.Status != models.BulkStatusChange {
		t.Errorf("client: %+v", pe)
	}
	pe = models.BulkPreviewEntry{Status: models.BulkStatusChange}
	server := models.EffectivePasswordPolicy{Policy: models.PasswordPolicyServer, ServerType: models.ServerType389DS, ServerHashes: true, ServerHashing: "389", Warnings: []string{}}
	addPasswordPlan(&pe, server, resolved, models.PasswordWriteOptions{})
	if !slices.ContainsFunc(pe.Warnings, func(w string) bool { return strings.Contains(w, "confirm") }) {
		t.Errorf("server over plain LDAP must announce the confirmation: %+v", pe)
	}
	if !hasPasswordChange(resolved) || hasPasswordChange([]models.AttributeChange{{Operation: "delete", Attribute: "userPassword", Values: []string{"x"}}}) {
		t.Error("hasPasswordChange")
	}
}

func TestPasswordChangeSendsCleartext(t *testing.T) {
	tests := []struct {
		req  models.PasswordChangeRequest
		want bool
	}{
		{models.PasswordChangeRequest{Method: models.PasswordMethodUnicodePwd}, true},
		{models.PasswordChangeRequest{Method: models.PasswordMethodExop}, true},
		{models.PasswordChangeRequest{Method: models.PasswordMethodUserPassword, Scheme: "cleartext"}, true},
		{models.PasswordChangeRequest{Method: models.PasswordMethodUserPassword, Scheme: "CRYPT-SHA512"}, false},
		{models.PasswordChangeRequest{Method: models.PasswordMethodUserPassword, Scheme: "SSHA", VerifyBind: true}, true},
	}
	for _, tt := range tests {
		if got := passwordChangeSendsCleartext(tt.req); got != tt.want {
			t.Errorf("%+v: %v", tt.req, got)
		}
	}
}

func TestNormalizePasswordPolicySettings(t *testing.T) {
	p := models.ConnectionProfile{PasswordPolicy: "Client", PasswordScheme: "crypt-bcrypt"}
	if err := normalizePasswordPolicySettings(&p); err != nil || p.PasswordPolicy != "client" || p.PasswordScheme != ldap.SchemeBcrypt {
		t.Errorf("client: %+v %v", p, err)
	}
	p = models.ConnectionProfile{PasswordPolicy: "auto", PasswordScheme: "SSHA"}
	if err := normalizePasswordPolicySettings(&p); err != nil || p.PasswordPolicy != "" || p.PasswordScheme != "" {
		t.Errorf("auto: %+v %v", p, err)
	}
	for _, bad := range []models.ConnectionProfile{{PasswordPolicy: "always"}, {PasswordPolicy: "client", PasswordScheme: "CLEARTEXT"}, {PasswordPolicy: "client", PasswordScheme: "ROT13"}} {
		if err := normalizePasswordPolicySettings(&bad); err == nil {
			t.Errorf("%+v accepted", bad)
		}
	}
	// Export/import keeps the setting.
	imp := importProfile(exportProfiles([]models.ConnectionProfile{{Name: "x", PasswordPolicy: "client", PasswordScheme: ldap.SchemeSSHA}})[0])
	if imp.PasswordPolicy != "client" || imp.PasswordScheme != ldap.SchemeSSHA {
		t.Errorf("import: %+v", imp)
	}
	imp = importProfile(exportProfile{Name: "x", PasswordPolicy: "bogus"})
	if imp.PasswordPolicy != "" {
		t.Errorf("bogus import: %+v", imp)
	}
}

func TestDescribePasswordReport(t *testing.T) {
	if describePasswordReport(nil) != "" {
		t.Error("nil report")
	}
	r := &models.PasswordWriteReport{Actions: []string{"userPassword: 1 value hashed on the client with {CRYPT} SHA-512-crypt ($6$)"}}
	if got := describePasswordReport(r); !strings.Contains(got, "password storage:") {
		t.Errorf("got %q", got)
	}
}

// TestBulkPasswordWarnings: password problems found by the read-back mark
// a successful bulk item and are counted per run.
func TestBulkPasswordWarnings(t *testing.T) {
	tests := []struct {
		report *models.PasswordWriteReport
		want   string
	}{
		{nil, ""},
		{&models.PasswordWriteReport{Actions: []string{"stored as {SSHA}"}}, ""},
		{&models.PasswordWriteReport{Ineffective: true, Cleartext: true}, models.PasswordWarningIneffective},
		{&models.PasswordWriteReport{Cleartext: true}, models.PasswordWarningCleartext},
		{&models.PasswordWriteReport{Unconfirmed: true}, models.PasswordWarningUnconfirmed},
		{&models.PasswordWriteReport{Warnings: []string{"w"}}, models.PasswordWarningOther},
	}
	res := &models.BulkApplyResult{}
	for _, tt := range tests {
		got := passwordReportWarning(tt.report)
		if got != tt.want {
			t.Errorf("passwordReportWarning(%+v) = %q, want %q", tt.report, got, tt.want)
		}
		addResultItem(res, models.BulkResultItem{Status: models.BulkResultSuccess, PasswordWarning: got})
	}
	if res.Succeeded != len(tests) || res.PasswordIneffective != 1 || res.PasswordCleartext != 1 || res.PasswordWarnings != 2 {
		t.Errorf("counts %+v", res)
	}

	// keepDisabledAfterBulk puts the password warnings into the message.
	item := models.BulkResultItem{DN: "uid=x"}
	report := &models.PasswordWriteReport{Ineffective: true, Warnings: []string{"the new password will NOT work"}}
	if err := keepDisabledAfterBulk(&item, passwordReportMessages(report), nil, nil); err != nil {
		t.Fatal(err)
	}
	if item.Status != models.BulkResultSuccess || !strings.HasPrefix(item.Message, "the new password will NOT work") {
		t.Errorf("item %+v", item)
	}
}

// ACCT-08: a disabled OpenLDAP account re-locked after a password change
// says so in the write report (the toast reads "account stays disabled").
func TestWithLockKeptNote(t *testing.T) {
	if r := withLockKeptNote(nil, ""); r != nil {
		t.Errorf("no re-lock, no report: %+v", r)
	}
	r := withLockKeptNote(nil, lockKeptNote)
	if r == nil || len(r.Actions) != 1 || r.Actions[0] != lockKeptNote || r.Warnings == nil || r.StoredSchemes == nil {
		t.Errorf("new report %+v", r)
	}
	existing := &models.PasswordWriteReport{Actions: []string{"userPassword: 1 value hashed on the client with {CRYPT} SHA-512-crypt ($6$)"}}
	r = withLockKeptNote(withLockKeptNote(existing, lockKeptNote), lockKeptNote)
	if len(r.Actions) != 2 || r.Actions[1] != lockKeptNote {
		t.Errorf("appended once: %v", r.Actions)
	}
}
