package ldap

import (
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
)

func TestPasswordExpiresWithin(t *testing.T) {
	in := func(d time.Duration) string { return isoTime(testNow.Add(d)) }
	tests := []struct {
		name string
		st   models.AccountStatus
		want bool
	}{
		{"in 5 days", models.AccountStatus{Enabled: true, PasswordExpires: in(5 * 24 * time.Hour)}, true},
		{"in 8 days", models.AccountStatus{Enabled: true, PasswordExpires: in(8 * 24 * time.Hour)}, false},
		{"already expired", models.AccountStatus{Enabled: true, PasswordExpires: in(-time.Hour), PasswordExpired: true}, false},
		{"disabled", models.AccountStatus{Enabled: false, PasswordExpires: in(time.Hour)}, false},
		{"never", models.AccountStatus{Enabled: true, PasswordNeverExpires: true}, false},
		{"must change", models.AccountStatus{Enabled: true, MustChangePassword: true, PasswordExpires: in(time.Hour)}, false},
	}
	for _, tt := range tests {
		if got := passwordExpiresWithin(&tt.st, testNow, 7); got != tt.want {
			t.Errorf("%s: got %v", tt.name, got)
		}
	}
}

func TestNeverLoggedOnMatch(t *testing.T) {
	if !neverLoggedOnMatch(&models.AccountStatus{}) {
		t.Error("empty status should match")
	}
	if !neverLoggedOnMatch(&models.AccountStatus{HasLogonCount: true}) {
		t.Error("logonCount 0 should match")
	}
	if neverLoggedOnMatch(&models.AccountStatus{LastLogon: isoTime(testNow)}) {
		t.Error("lastLogon set")
	}
	if neverLoggedOnMatch(&models.AccountStatus{LastLogonReplicated: isoTime(testNow)}) {
		t.Error("lastLogonTimestamp set")
	}
	if neverLoggedOnMatch(&models.AccountStatus{HasLogonCount: true, LogonCount: 3}) {
		t.Error("logonCount 3")
	}
}

func TestReportSpecs(t *testing.T) {
	for _, report := range []string{models.AccountReportLocked, models.AccountReportDisabled, models.AccountReportPasswordExpiring,
		models.AccountReportPasswordExpired, models.AccountReportNeverLoggedOn} {
		p := models.AccountReportParams{Report: report, Days: 14}
		ol, err := ppolicyReportSpec(p, testNow)
		if err != nil || ol.filter == "" || len(ol.columns) == 0 || ol.match == nil {
			t.Errorf("openldap %s: %+v %v", report, ol, err)
		}
		ds, err := dsReportSpec(p, testNow)
		if err != nil || ds.filter == "" || len(ds.columns) == 0 || ds.match == nil {
			t.Errorf("389ds %s: %+v %v", report, ds, err)
		}
	}
	if _, err := ppolicyReportSpec(models.AccountReportParams{Report: "bogus"}, testNow); err == nil {
		t.Error("unknown report accepted")
	}
	nl, _ := ppolicyReportSpec(models.AccountReportParams{Report: models.AccountReportNeverLoggedOn}, testNow)
	if nl.requireAny == "" || nl.requireMsg == "" {
		t.Error("openldap neverLoggedOn must probe for recorded logons")
	}
	disabled, _ := ppolicyReportSpec(models.AccountReportParams{Report: models.AccountReportDisabled}, testNow)
	if !strings.Contains(disabled.filter, ppolicyPermanentLock) {
		t.Errorf("openldap disabled filter: %s", disabled.filter)
	}
}

func TestADReportSpecForNarrowing(t *testing.T) {
	domain := &models.AccountPolicy{Name: "Domain password policy", Source: models.PolicySourceDomain, Readable: true,
		LockoutDurationSeconds: 1800, MaxPasswordAgeSeconds: 42 * 86400}
	pso := &models.AccountPolicy{Name: "PSO-Short", Source: models.PolicySourcePSO, Readable: true,
		LockoutDurationSeconds: 36000, MaxPasswordAgeSeconds: 5 * 86400}
	hidden := &models.AccountPolicy{Name: "PSO-Hidden", Source: models.PolicySourcePSO}

	sets := map[string]adPolicySet{
		"complete":        {policies: []*models.AccountPolicy{domain, pso}, complete: true},
		"unreadable PSO":  {policies: []*models.AccountPolicy{domain, hidden}},
		"no PSOs visible": {policies: []*models.AccountPolicy{domain}},
	}
	for name, set := range sets {
		// The locked report never narrows by lockout duration: the DC's
		// computed LOCKOUT bit decides.
		locked, _, err := adReportSpecFor(models.AccountReportParams{Report: models.AccountReportLocked}, set, testNow)
		if err != nil || locked.filter != "(&(objectClass=user)(lockoutTime>=1))" {
			t.Errorf("%s: locked filter %q %v", name, locked.filter, err)
		}
		for _, report := range []string{models.AccountReportPasswordExpiring, models.AccountReportPasswordExpired} {
			spec, _, err := adReportSpecFor(models.AccountReportParams{Report: report, Days: 7}, set, testNow)
			if err != nil {
				t.Fatalf("%s %s: %v", name, report, err)
			}
			bounded := strings.Contains(spec.filter, "pwdLastSet<=")
			if bounded != set.complete {
				t.Errorf("%s %s: bounded=%v, filter %s", name, report, bounded, spec.filter)
			}
		}
	}

	// With a complete set the bound uses the shortest maximum age (5 days):
	// expired = pwdLastSet older than now-5d.
	spec, notes, _ := adReportSpecFor(models.AccountReportParams{Report: models.AccountReportPasswordExpired}, sets["complete"], testNow)
	want := "(pwdLastSet<=" + strconv.FormatInt(timeToFileTime(testNow.Add(-5*24*time.Hour)), 10) + ")"
	if !strings.Contains(spec.filter, want) {
		t.Errorf("expired bound: %s, want %s", spec.filter, want)
	}
	if len(notes) == 0 || !strings.Contains(notes[0], "PSO-Short") {
		t.Errorf("notes: %v", notes)
	}
	_, notes, _ = adReportSpecFor(models.AccountReportParams{Report: models.AccountReportLocked}, sets["unreadable PSO"], testNow)
	for _, n := range notes {
		if strings.Contains(n, "PSO-Hidden") {
			t.Errorf("unreadable PSO listed as considered: %v", notes)
		}
	}
	if _, _, err := adReportSpecFor(models.AccountReportParams{Report: "bogus"}, sets["complete"], testNow); err == nil {
		t.Error("unknown report accepted")
	}
}

func TestUnreadablePSONote(t *testing.T) {
	names := map[string]bool{"PSO-B": true, "PSO-A": true}
	note := unreadablePSONote(models.AccountReportLocked, names)
	if !strings.Contains(note, "PSO-A, PSO-B") {
		t.Errorf("note: %q", note)
	}
	if unreadablePSONote(models.AccountReportDisabled, names) != "" {
		t.Error("disabled report needs no PSO note")
	}
	if unreadablePSONote(models.AccountReportPasswordExpired, map[string]bool{}) != "" {
		t.Error("note without unreadable PSOs")
	}
}

func TestMarkReadViaReferral(t *testing.T) {
	st := newAccountStatus("cn=x,dc=child,dc=example,dc=com", models.ServerTypeAD, testNow)
	st.Applicable = true
	markReadViaReferral(st, "CN=X,DC=child,DC=example,DC=com", "ldap://child.example.com/CN=x,DC=child,DC=example,DC=com")
	if st.DN != "CN=X,DC=child,DC=example,DC=com" {
		t.Errorf("DN: %s", st.DN)
	}
	for _, action := range []string{models.AccountActionUnlock, models.AccountActionEnable, models.AccountActionDisable,
		models.AccountActionMustChange, models.AccountActionNeverExpires, models.AccountActionAccountExpires,
		models.AccountActionUAC, models.AccountActionResetPassword} {
		if !strings.Contains(st.Unsupported[action], "child.example.com:389") {
			t.Errorf("%s: %q", action, st.Unsupported[action])
		}
	}
	if len(st.Warnings) != 1 || !strings.Contains(st.Warnings[0], "referral") {
		t.Errorf("warnings: %v", st.Warnings)
	}
	if err := checkApplicable(st, AccountChange{Action: models.AccountActionUnlock}); err == nil {
		t.Error("actions on a referral status must be refused")
	}
}

func TestAccountReferralError(t *testing.T) {
	err := accountReferralError("cn=x,dc=example,dc=com", errors.New("referral"), true)
	if !strings.Contains(err.Error(), "referral following is disabled") {
		t.Errorf("disabled: %v", err)
	}
	err = accountReferralError("cn=x,dc=example,dc=com", errors.New("referral"), false)
	if !strings.Contains(err.Error(), "names no server") {
		t.Errorf("no URL: %v", err)
	}
	if got := referralHost("ldaps://dc2.child.example.com/DC=child,DC=example,DC=com"); got != "dc2.child.example.com:636" {
		t.Errorf("referralHost: %s", got)
	}
}
