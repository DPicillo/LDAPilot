package ldap

import (
	"math"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
)

var testNow = time.Date(2026, 10, 29, 23, 0, 0, 0, time.UTC)

func ft(t time.Time) string { return strconv.FormatInt(timeToFileTime(t), 10) }

func attrsOf(kv ...string) accountAttrs {
	a := accountAttrs{}
	for i := 0; i+1 < len(kv); i += 2 {
		k := strings.ToLower(kv[i])
		a[k] = append(a[k], kv[i+1])
	}
	return a
}

func TestParseGeneralizedTime(t *testing.T) {
	tests := []struct {
		in   string
		want time.Time
		ok   bool
	}{
		{"20261029205856Z", time.Date(2026, 10, 29, 20, 58, 56, 0, time.UTC), true},
		{"20261029205856.127214Z", time.Date(2026, 10, 29, 20, 58, 56, 127214000, time.UTC), true},
		{"20261029205922.0Z", time.Date(2026, 10, 29, 20, 59, 22, 0, time.UTC), true},
		{"19700101000000Z", time.Unix(0, 0).UTC(), true},
		{"000001010000Z", time.Date(0, 1, 1, 0, 0, 0, 0, time.UTC), true},
		{"2026102921Z", time.Date(2026, 10, 29, 21, 0, 0, 0, time.UTC), true},
		{"20261029220000+0100", time.Date(2026, 10, 29, 21, 0, 0, 0, time.UTC), true},
		{"20261029220000-02", time.Date(2026, 10, 30, 0, 0, 0, 0, time.UTC), true},
		{"20261029220000", time.Time{}, false},
		{"2026-10-29", time.Time{}, false},
		{"20261329220000Z", time.Time{}, false},
		{"20261029220000ZX", time.Time{}, false},
		{"", time.Time{}, false},
	}
	for _, tt := range tests {
		got, err := parseGeneralizedTime(tt.in)
		if (err == nil) != tt.ok {
			t.Errorf("parseGeneralizedTime(%q) err = %v, want ok=%v", tt.in, err, tt.ok)
			continue
		}
		if tt.ok && !got.Equal(tt.want) {
			t.Errorf("parseGeneralizedTime(%q) = %v, want %v", tt.in, got, tt.want)
		}
	}
	if got := formatGeneralizedTime(time.Date(2026, 1, 2, 3, 4, 5, 6, time.UTC)); got != "20260102030405Z" {
		t.Errorf("formatGeneralizedTime = %s", got)
	}
}

func TestFileTime(t *testing.T) {
	// 134377811718595510 is the lockoutTime of the lab's test.locked.
	got, ok := fileTimeToTime(134377811718595510)
	if !ok || got.Format(time.RFC3339) != "2026-10-29T20:59:31Z" {
		t.Errorf("fileTimeToTime = %v %v", got, ok)
	}
	if _, ok := fileTimeToTime(0); ok {
		t.Error("0 must not be a time")
	}
	if _, ok := fileTimeToTime(math.MaxInt64); ok {
		t.Error("never must not be a time")
	}
	tm := time.Date(2030, 5, 6, 7, 8, 9, 123456700, time.UTC)
	if back, _ := fileTimeToTime(timeToFileTime(tm)); !back.Equal(tm) {
		t.Errorf("round trip %v != %v", back, tm)
	}
	if v := adIntervalSeconds(-18000000000); v != 1800 {
		t.Errorf("30 min = %d", v)
	}
	if v := adIntervalSeconds(math.MinInt64); v != 0 {
		t.Errorf("forever = %d", v)
	}
	if v := adIntervalSeconds(0); v != 0 {
		t.Errorf("zero = %d", v)
	}
}

func TestADDomainDN(t *testing.T) {
	tests := map[string]string{
		"CN=Test Locked,OU=Special Cases,OU=LDAPilot,DC=ad,DC=ldapilot,DC=lab": "DC=ad,DC=ldapilot,DC=lab",
		"cn=x,dc=child,dc=ad,dc=lab":        "DC=child,DC=ad,DC=lab",
		"DC=ad,DC=lab":                      "DC=ad,DC=lab",
		"CN=Schmidt\\, Anna,OU=X,DC=a,DC=b": "DC=a,DC=b",
		"cn=x,o=org":                        "",
		"not a dn":                          "",
	}
	for in, want := range tests {
		if got := adDomainDN(in); got != want {
			t.Errorf("adDomainDN(%q) = %q, want %q", in, got, want)
		}
	}
}

func adPolicy(durationSec, maxAgeSec int64) *models.AccountPolicy {
	return &models.AccountPolicy{Readable: true, Source: models.PolicySourceDomain, LockoutEnabled: true, LockoutThreshold: 3,
		LockoutDurationSeconds: durationSec, MaxPasswordAgeSeconds: maxAgeSec, MustChangeEnforced: true}
}

func adStatus(a accountAttrs, pol *models.AccountPolicy) *models.AccountStatus {
	st := newAccountStatus("CN=x,DC=a", models.ServerTypeAD, testNow)
	kind, _ := adAccountKind(a.all("objectClass"))
	computeADStatus(st, kind, a, pol, testNow)
	return st
}

func TestComputeADStatus(t *testing.T) {
	lockedAt := testNow.Add(-10 * time.Minute)
	pwdSet := testNow.Add(-40 * 24 * time.Hour)

	t.Run("locked by computed bit, until from policy", func(t *testing.T) {
		st := adStatus(attrsOf("objectClass", "user", "userAccountControl", "512", "msDS-User-Account-Control-Computed", "16",
			"lockoutTime", ft(lockedAt), "badPwdCount", "3"), adPolicy(1800, 0))
		if !st.Locked || st.LockedUntil != isoTime(lockedAt.Add(30*time.Minute)) || st.LockedPermanently || st.BadPasswordCount != 3 {
			t.Errorf("%+v", st)
		}
	})
	t.Run("stale lockout is not locked", func(t *testing.T) {
		st := adStatus(attrsOf("objectClass", "user", "userAccountControl", "512", "msDS-User-Account-Control-Computed", "0",
			"lockoutTime", ft(testNow.Add(-2*time.Hour))), adPolicy(1800, 0))
		if st.Locked || !st.LockoutExpired {
			t.Errorf("%+v", st)
		}
	})
	t.Run("fallback without computed attribute", func(t *testing.T) {
		a := attrsOf("objectClass", "user", "userAccountControl", "512", "lockoutTime", ft(testNow.Add(-2*time.Hour)))
		if st := adStatus(a, adPolicy(1800, 0)); st.Locked || !st.LockoutExpired {
			t.Errorf("expired: %+v", st)
		}
		if st := adStatus(a, adPolicy(0, 0)); !st.Locked || !st.LockedPermanently {
			t.Errorf("until unlocked: %+v", st)
		}
		if st := adStatus(a, nil); !st.Locked || len(st.Warnings) == 0 {
			t.Errorf("unknown policy: %+v", st)
		}
	})
	t.Run("disabled, password expiry from computed attribute", func(t *testing.T) {
		exp := pwdSet.Add(42 * 24 * time.Hour)
		st := adStatus(attrsOf("objectClass", "user", "userAccountControl", "514", "pwdLastSet", ft(pwdSet),
			"msDS-UserPasswordExpiryTimeComputed", ft(exp), "accountExpires", "9223372036854775807"), adPolicy(1800, 42*86400))
		if st.Enabled || st.DisabledBy == "" || st.PasswordExpires != isoTime(exp) || st.PasswordExpired || !st.AccountNeverExpires {
			t.Errorf("%+v", st)
		}
	})
	t.Run("password expiry fallback from policy and expired", func(t *testing.T) {
		st := adStatus(attrsOf("objectClass", "user", "userAccountControl", "512", "pwdLastSet", ft(pwdSet)), adPolicy(0, 30*86400))
		if !st.PasswordExpired || st.PasswordExpires != isoTime(pwdSet.Add(30*24*time.Hour)) {
			t.Errorf("%+v", st)
		}
	})
	t.Run("must change", func(t *testing.T) {
		st := adStatus(attrsOf("objectClass", "user", "userAccountControl", "512", "pwdLastSet", "0",
			"msDS-User-Account-Control-Computed", "8388608", "msDS-UserPasswordExpiryTimeComputed", "0"), adPolicy(0, 42*86400))
		if !st.MustChangePassword || st.PasswordExpired || st.PasswordExpires != "" {
			t.Errorf("%+v", st)
		}
	})
	t.Run("must change ignored with never expires", func(t *testing.T) {
		st := adStatus(attrsOf("objectClass", "user", "userAccountControl", "66048", "pwdLastSet", "0"), adPolicy(0, 42*86400))
		if st.MustChangePassword || !st.PasswordNeverExpires || len(st.Warnings) == 0 {
			t.Errorf("%+v", st)
		}
	})
	t.Run("account expired and expiring", func(t *testing.T) {
		st := adStatus(attrsOf("objectClass", "user", "userAccountControl", "512", "accountExpires", ft(testNow.Add(-time.Hour))), nil)
		if !st.AccountExpired || st.AccountNeverExpires {
			t.Errorf("expired: %+v", st)
		}
		st = adStatus(attrsOf("objectClass", "user", "userAccountControl", "512", "accountExpires", ft(testNow.Add(5*24*time.Hour))), nil)
		if st.AccountExpired || st.AccountExpires == "" {
			t.Errorf("expiring: %+v", st)
		}
		st = adStatus(attrsOf("objectClass", "user", "userAccountControl", "512", "accountExpires", "0"), nil)
		if !st.AccountNeverExpires {
			t.Errorf("0: %+v", st)
		}
	})
	t.Run("computer and gMSA", func(t *testing.T) {
		st := adStatus(attrsOf("objectClass", "user", "objectClass", "computer", "userAccountControl", "4096", "pwdLastSet", "0"), nil)
		if st.Kind != models.AccountKindComputer || st.MustChangePassword || !st.PasswordNeverExpires ||
			st.Unsupported[models.AccountActionMustChange] == "" || st.Unsupported[models.AccountActionResetPassword] == "" {
			t.Errorf("computer: %+v", st)
		}
		st = adStatus(attrsOf("objectClass", "msDS-GroupManagedServiceAccount", "userAccountControl", "4096"), nil)
		if st.Kind != models.AccountKindServiceAccount || st.Unsupported[models.AccountActionResetPassword] == "" {
			t.Errorf("gmsa: %+v", st)
		}
	})
	t.Run("uac not readable", func(t *testing.T) {
		st := adStatus(attrsOf("objectClass", "user"), nil)
		if st.Unsupported[models.AccountActionDisable] == "" || st.Unsupported[models.AccountActionUAC] == "" {
			t.Errorf("%+v", st)
		}
	})
	if _, ok := adAccountKind([]string{"top", "person", "organizationalPerson", "contact"}); ok {
		t.Error("contact is no account")
	}
}

func changesString(changes []models.AttributeChange) string {
	parts := []string{}
	for _, c := range changes {
		parts = append(parts, c.Operation+":"+c.Attribute+"="+strings.Join(c.Values, "|"))
	}
	return strings.Join(parts, ",")
}

func TestPlanADChange(t *testing.T) {
	user := attrsOf("objectClass", "user", "userAccountControl", "512", "pwdLastSet", "134377811598516296",
		"lockoutTime", "134377811718595510", "accountExpires", "9223372036854775807")
	st := adStatus(user, adPolicy(1800, 0))
	exp := time.Date(2026, 11, 3, 23, 0, 0, 0, time.UTC)
	tests := []struct {
		name string
		ch   AccountChange
		want string // "" = error expected
	}{
		{"unlock", AccountChange{Action: models.AccountActionUnlock}, "replace:lockoutTime=0"},
		{"disable", AccountChange{Action: models.AccountActionDisable}, "delete:userAccountControl=512,add:userAccountControl=514"},
		{"enable noop", AccountChange{Action: models.AccountActionEnable}, ""},
		{"never expires", AccountChange{Action: models.AccountActionNeverExpires, Set: true}, "delete:userAccountControl=512,add:userAccountControl=66048"},
		{"clear never expires noop", AccountChange{Action: models.AccountActionNeverExpires}, ""},
		{"must change", AccountChange{Action: models.AccountActionMustChange, Set: true}, "replace:pwdLastSet=0"},
		{"clear must change noop", AccountChange{Action: models.AccountActionMustChange}, ""},
		{"expires", AccountChange{Action: models.AccountActionAccountExpires, Set: true, Expires: exp}, "replace:accountExpires=" + ft(exp)},
		{"clear expires noop", AccountChange{Action: models.AccountActionAccountExpires}, ""},
		{"uac", AccountChange{Action: models.AccountActionUAC, ExpectedUAC: 512, UAC: 512 | 0x400000}, "delete:userAccountControl=512,add:userAccountControl=4194816"},
		{"uac stale", AccountChange{Action: models.AccountActionUAC, ExpectedUAC: 514, UAC: 512}, ""},
		{"uac account type", AccountChange{Action: models.AccountActionUAC, ExpectedUAC: 512, UAC: 4096}, ""},
		{"uac lockout bit", AccountChange{Action: models.AccountActionUAC, ExpectedUAC: 512, UAC: 512 | 0x10}, ""},
		{"unknown", AccountChange{Action: "bogus"}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			changes, err := planADChange(user, st, tt.ch)
			if tt.want == "" {
				if err == nil {
					t.Errorf("expected error, got %s", changesString(changes))
				}
				return
			}
			if err != nil {
				t.Fatalf("error: %v", err)
			}
			if got := changesString(changes); got != tt.want {
				t.Errorf("got %s, want %s", got, tt.want)
			}
		})
	}

	mustChange := attrsOf("objectClass", "user", "userAccountControl", "514", "pwdLastSet", "0", "accountExpires", ft(exp))
	st = adStatus(mustChange, adPolicy(1800, 0))
	if c, err := planADChange(mustChange, st, AccountChange{Action: models.AccountActionMustChange}); err != nil || changesString(c) != "replace:pwdLastSet=-1" {
		t.Errorf("clear must change: %v %s", err, changesString(c))
	}
	if c, err := planADChange(mustChange, st, AccountChange{Action: models.AccountActionEnable}); err != nil || changesString(c) != "delete:userAccountControl=514,add:userAccountControl=512" {
		t.Errorf("enable: %v %s", err, changesString(c))
	}
	if c, err := planADChange(mustChange, st, AccountChange{Action: models.AccountActionAccountExpires}); err != nil || changesString(c) != "replace:accountExpires=9223372036854775807" {
		t.Errorf("clear expires: %v %s", err, changesString(c))
	}
	if _, err := planADChange(mustChange, st, AccountChange{Action: models.AccountActionUnlock}); err == nil {
		t.Error("unlock of unlocked account")
	}
	neverExp := attrsOf("objectClass", "user", "userAccountControl", "66048", "pwdLastSet", "134377811598516296")
	if _, err := planADChange(neverExp, adStatus(neverExp, nil), AccountChange{Action: models.AccountActionMustChange, Set: true}); err == nil {
		t.Error("must change with never expires")
	}
}

func ppolicy(lockout bool, durationSec, maxAgeSec int64, mustChange bool) *models.AccountPolicy {
	return &models.AccountPolicy{Readable: true, Source: models.PolicySourceDefault, LockoutEnabled: lockout, LockoutThreshold: 3,
		LockoutDurationSeconds: durationSec, MaxPasswordAgeSeconds: maxAgeSec, MustChangeEnforced: mustChange}
}

func olStatus(a accountAttrs, pol *models.AccountPolicy) *models.AccountStatus {
	st := newAccountStatus("uid=x,dc=a", models.ServerTypeOpenLDAP, testNow)
	computePPolicyStatus(st, a, pol, testNow)
	return st
}

func TestComputePPolicyStatus(t *testing.T) {
	lockedAt := formatGeneralizedTime(testNow.Add(-10 * time.Minute))
	t.Run("locked until admin", func(t *testing.T) {
		st := olStatus(attrsOf("pwdAccountLockedTime", lockedAt, "pwdFailureTime", "20261029225000Z", "pwdFailureTime", "20261029225001.5Z"),
			ppolicy(true, 0, 0, true))
		if !st.Locked || !st.LockedPermanently || st.BadPasswordCount != 2 || st.LastBadPassword != "2026-10-29T22:50:01Z" || !st.Enabled {
			t.Errorf("%+v", st)
		}
	})
	t.Run("locked with duration and expired lock", func(t *testing.T) {
		st := olStatus(attrsOf("pwdAccountLockedTime", lockedAt), ppolicy(true, 3600, 0, true))
		if !st.Locked || st.LockedUntil != isoTime(testNow.Add(50*time.Minute)) {
			t.Errorf("%+v", st)
		}
		st = olStatus(attrsOf("pwdAccountLockedTime", lockedAt), ppolicy(true, 60, 0, true))
		if st.Locked || !st.LockoutExpired {
			t.Errorf("expired: %+v", st)
		}
	})
	t.Run("permanent lock is disabled", func(t *testing.T) {
		st := olStatus(attrsOf("pwdAccountLockedTime", ppolicyPermanentLock), ppolicy(true, 0, 0, true))
		if st.Enabled || st.Locked {
			t.Errorf("%+v", st)
		}
	})
	t.Run("lockout off ignores lock", func(t *testing.T) {
		st := olStatus(attrsOf("pwdAccountLockedTime", ppolicyPermanentLock), ppolicy(false, 0, 0, true))
		if !st.Enabled || st.Locked || len(st.Warnings) == 0 || st.Unsupported[models.AccountActionDisable] == "" {
			t.Errorf("%+v", st)
		}
	})
	t.Run("password expiry", func(t *testing.T) {
		changed := testNow.Add(-80 * 24 * time.Hour)
		st := olStatus(attrsOf("pwdChangedTime", formatGeneralizedTime(changed)), ppolicy(true, 0, 90*86400, true))
		if st.PasswordExpires != isoTime(changed.Add(90*24*time.Hour)) || st.PasswordExpired || st.PasswordLastSet == "" {
			t.Errorf("%+v", st)
		}
		if !passwordExpiresWithin(st, testNow, 14) || passwordExpiresWithin(st, testNow, 7) {
			t.Errorf("expiresWithin wrong for %s", st.PasswordExpires)
		}
		st = olStatus(attrsOf("objectClass", "person"), ppolicy(true, 0, 90*86400, true))
		if !st.PasswordNeverExpires || st.PasswordExpiryNote == "" {
			t.Errorf("no pwdChangedTime: %+v", st)
		}
	})
	t.Run("pwdReset", func(t *testing.T) {
		if st := olStatus(attrsOf("pwdReset", "TRUE"), ppolicy(true, 0, 0, true)); !st.MustChangePassword {
			t.Errorf("%+v", st)
		}
		if st := olStatus(attrsOf("pwdReset", "TRUE"), ppolicy(true, 0, 0, false)); st.MustChangePassword || st.Unsupported[models.AccountActionMustChange] == "" {
			t.Errorf("not enforced: %+v", st)
		}
	})
	t.Run("failures left after unlock", func(t *testing.T) {
		st := olStatus(attrsOf("pwdFailureTime", "20261029225000Z", "pwdFailureTime", "20261029225001Z", "pwdFailureTime", "20261029225002Z"), ppolicy(true, 0, 0, true))
		if st.Locked || len(st.Warnings) == 0 {
			t.Errorf("%+v", st)
		}
	})
}

func TestPlanPPolicyChange(t *testing.T) {
	pol := ppolicy(true, 0, 0, true)
	locked := attrsOf("pwdAccountLockedTime", "20261029205856Z", "pwdFailureTime", "20261029205856Z")
	c, err := planPPolicyChange(locked, olStatus(locked, pol), AccountChange{Action: models.AccountActionUnlock})
	if err != nil || changesString(c) != "delete:pwdAccountLockedTime=,delete:pwdFailureTime=" {
		t.Errorf("unlock: %v %s", err, changesString(c))
	}
	c, err = planPPolicyChange(locked, olStatus(locked, pol), AccountChange{Action: models.AccountActionDisable})
	if err != nil || changesString(c) != "replace:pwdAccountLockedTime=000001010000Z" {
		t.Errorf("disable: %v %s", err, changesString(c))
	}
	disabled := attrsOf("pwdAccountLockedTime", ppolicyPermanentLock)
	if _, err := planPPolicyChange(disabled, olStatus(disabled, pol), AccountChange{Action: models.AccountActionUnlock}); err == nil {
		t.Error("unlock of disabled account")
	}
	c, err = planPPolicyChange(disabled, olStatus(disabled, pol), AccountChange{Action: models.AccountActionEnable})
	if err != nil || changesString(c) != "delete:pwdAccountLockedTime=" {
		t.Errorf("enable: %v %s", err, changesString(c))
	}
	plain := attrsOf("objectClass", "inetOrgPerson")
	if _, err := planPPolicyChange(plain, olStatus(plain, pol), AccountChange{Action: models.AccountActionEnable}); err == nil {
		t.Error("enable of enabled account")
	}
	c, err = planPPolicyChange(plain, olStatus(plain, pol), AccountChange{Action: models.AccountActionMustChange, Set: true})
	if err != nil || changesString(c) != "replace:pwdReset=TRUE" {
		t.Errorf("must change: %v %s", err, changesString(c))
	}
	reset := attrsOf("pwdReset", "TRUE")
	c, err = planPPolicyChange(reset, olStatus(reset, pol), AccountChange{Action: models.AccountActionMustChange})
	if err != nil || changesString(c) != "delete:pwdReset=" {
		t.Errorf("clear must change: %v %s", err, changesString(c))
	}
}

func dsPolicyT(unlock bool) *models.AccountPolicy {
	p := &models.AccountPolicy{Readable: true, Source: models.PolicySourceGlobal, LockoutEnabled: true, LockoutThreshold: 3,
		ObservationWindowSeconds: 600, MustChangeEnforced: true}
	if unlock {
		p.LockoutDurationSeconds = 3600
	}
	return p
}

func dsStatus(a accountAttrs, pol *models.AccountPolicy) *models.AccountStatus {
	st := newAccountStatus("uid=x,dc=a", models.ServerType389DS, testNow)
	compute389Status(st, a, pol, testNow)
	return st
}

func TestCompute389Status(t *testing.T) {
	st := dsStatus(attrsOf("passwordRetryCount", "3", "accountUnlockTime", generalizedTimeZero, "retryCountResetTime", "20261029230500Z",
		"passwordExpirationTime", generalizedTimeZero), dsPolicyT(false))
	if !st.Locked || !st.LockedPermanently || st.BadPasswordCount != 3 || !st.MustChangePassword || st.LastBadPassword != "2026-10-29T22:55:00Z" {
		t.Errorf("locked forever: %+v", st)
	}
	st = dsStatus(attrsOf("accountUnlockTime", generalizedTimeZero), dsPolicyT(true))
	if st.Locked {
		t.Errorf("unlock on, zero time: %+v", st)
	}
	st = dsStatus(attrsOf("accountUnlockTime", "20261029233000Z"), dsPolicyT(true))
	if !st.Locked || st.LockedUntil != "2026-10-29T23:30:00Z" || st.LockedAt != "2026-10-29T22:30:00Z" {
		t.Errorf("timed lock: %+v", st)
	}
	st = dsStatus(attrsOf("accountUnlockTime", "20261029220000Z"), dsPolicyT(true))
	if st.Locked || !st.LockoutExpired {
		t.Errorf("expired lock: %+v", st)
	}
	st = dsStatus(attrsOf("nsAccountLock", "TRUE"), dsPolicyT(false))
	if st.Enabled || st.DisabledByRole {
		t.Errorf("nsAccountLock: %+v", st)
	}
	role := attrsOf("nsRole", "cn=nsDisabledRole,dc=x", "nsAccountLock", "true")
	st = dsStatus(role, dsPolicyT(false))
	if st.Enabled || !st.DisabledByRole || st.Unsupported[models.AccountActionEnable] == "" {
		t.Errorf("role: %+v", st)
	}
	managed := attrsOf("nsRole", "cn=nsDisabledRole,dc=x", "nsRoleDN", "cn=nsManagedDisabledRole,dc=x")
	st = dsStatus(managed, dsPolicyT(false))
	if _, unsupported := st.Unsupported[models.AccountActionEnable]; unsupported {
		t.Errorf("managed role: %+v", st)
	}
	if c, err := plan389Change(managed, st, AccountChange{Action: models.AccountActionEnable}); err != nil || changesString(c) != "delete:nsRoleDN=cn=nsManagedDisabledRole,dc=x" {
		t.Errorf("enable via role: %v %s", err, changesString(c))
	}
	exp := dsPolicyT(false)
	exp.MaxPasswordAgeSeconds = 90 * 86400
	st = dsStatus(attrsOf("passwordExpirationTime", "20261105000000Z"), exp)
	if st.PasswordExpires != "2026-11-05T00:00:00Z" || st.PasswordExpired {
		t.Errorf("expiry: %+v", st)
	}
	st = dsStatus(attrsOf("passwordExpirationTime", "20261105000000Z"), dsPolicyT(false))
	if !st.PasswordNeverExpires {
		t.Errorf("passwordExp off: %+v", st)
	}
}

func TestPlan389Change(t *testing.T) {
	pol := dsPolicyT(false)
	locked := attrsOf("passwordRetryCount", "3", "accountUnlockTime", generalizedTimeZero, "retryCountResetTime", "20261029230500Z")
	c, err := plan389Change(locked, dsStatus(locked, pol), AccountChange{Action: models.AccountActionUnlock})
	if err != nil || changesString(c) != "delete:accountUnlockTime=,replace:passwordRetryCount=0,delete:retryCountResetTime=" {
		t.Errorf("unlock: %v %s", err, changesString(c))
	}
	plain := attrsOf("objectClass", "inetOrgPerson")
	if _, err := plan389Change(plain, dsStatus(plain, pol), AccountChange{Action: models.AccountActionUnlock}); err == nil {
		t.Error("unlock of unlocked account")
	}
	c, err = plan389Change(plain, dsStatus(plain, pol), AccountChange{Action: models.AccountActionDisable})
	if err != nil || changesString(c) != "replace:nsAccountLock=true" {
		t.Errorf("disable: %v %s", err, changesString(c))
	}
	disabled := attrsOf("nsAccountLock", "true")
	c, err = plan389Change(disabled, dsStatus(disabled, pol), AccountChange{Action: models.AccountActionEnable})
	if err != nil || changesString(c) != "delete:nsAccountLock=" {
		t.Errorf("enable: %v %s", err, changesString(c))
	}
	c, err = plan389Change(plain, dsStatus(plain, pol), AccountChange{Action: models.AccountActionMustChange, Set: true})
	if err != nil || changesString(c) != "replace:passwordExpirationTime=19700101000000Z" {
		t.Errorf("must change: %v %s", err, changesString(c))
	}
	reset := attrsOf("passwordExpirationTime", generalizedTimeZero)
	c, err = plan389Change(reset, dsStatus(reset, pol), AccountChange{Action: models.AccountActionMustChange})
	if err != nil || changesString(c) != "delete:passwordExpirationTime=" {
		t.Errorf("clear must change: %v %s", err, changesString(c))
	}
	if _, err := plan389Change(plain, dsStatus(plain, pol), AccountChange{Action: models.AccountActionNeverExpires, Set: true}); err == nil {
		t.Error("never expires on 389DS")
	}
}

func TestAccountChangeDescribe(t *testing.T) {
	if got := (AccountChange{Action: models.AccountActionUAC, ExpectedUAC: 512, UAC: 514}).Describe(); got != "Set userAccountControl 0x200 -> 0x202" {
		t.Errorf("Describe = %q", got)
	}
}
