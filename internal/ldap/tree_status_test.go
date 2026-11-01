package ldap

import (
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
)

func TestTreeNodeStatus(t *testing.T) {
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	past := strconv.FormatInt(timeToFileTime(now.Add(-24*time.Hour)), 10)
	future := strconv.FormatInt(timeToFileTime(now.Add(24*time.Hour)), 10)
	adUser := []string{"top", "person", "organizationalPerson", "user"}
	cases := []struct {
		name  string
		oc    []string
		attrs accountAttrs
		want  []string
	}{
		{"AD normal", adUser, accountAttrs{"useraccountcontrol": {"512"}, "accountexpires": {"9223372036854775807"}}, nil},
		{"AD disabled", adUser, accountAttrs{"useraccountcontrol": {"514"}, "accountexpires": {"0"}}, []string{TreeStatusDisabled}},
		{"AD expired", adUser, accountAttrs{"useraccountcontrol": {"512"}, "accountexpires": {past}}, []string{TreeStatusExpired}},
		{"AD expires later", adUser, accountAttrs{"useraccountcontrol": {"512"}, "accountexpires": {future}}, nil},
		{"AD disabled computer", []string{"top", "person", "organizationalPerson", "user", "computer"}, accountAttrs{"useraccountcontrol": {"4098"}}, []string{TreeStatusDisabled}},
		// A stale lockoutTime is never shown as "locked".
		{"AD lockoutTime ignored", adUser, accountAttrs{"useraccountcontrol": {"512"}, "lockouttime": {"133000000000000000"}}, nil},
		{"AD group with UAC-like attr", []string{"top", "group"}, accountAttrs{"useraccountcontrol": {"2"}}, nil},
		{"AD contact", []string{"top", "person", "organizationalPerson", "contact"}, accountAttrs{}, nil},
		{"OpenLDAP permanent lock", []string{"inetOrgPerson"}, accountAttrs{"pwdaccountlockedtime": {"000001010000Z"}}, []string{TreeStatusDisabled}},
		// Without the policy-aware evaluation a timed lock is not shown (it may have expired).
		{"OpenLDAP timed lockout", []string{"inetOrgPerson"}, accountAttrs{"pwdaccountlockedtime": {"20261031110000Z"}}, nil},
		// RW1-P-02: 389DS lockouts by accountUnlockTime.
		{"389DS locked until admin", []string{"inetOrgPerson"}, accountAttrs{"accountunlocktime": {"19700101000000Z"}}, []string{TreeStatusLocked}},
		{"389DS locked until later", []string{"inetOrgPerson"}, accountAttrs{"accountunlocktime": {"20261031130000Z"}}, []string{TreeStatusLocked}},
		{"389DS lockout over", []string{"inetOrgPerson"}, accountAttrs{"accountunlocktime": {"20261031110000Z"}}, nil},
		{"389DS disabled and locked", []string{"inetOrgPerson"}, accountAttrs{"nsaccountlock": {"TRUE"}, "accountunlocktime": {"19700101000000Z"}}, []string{TreeStatusDisabled, TreeStatusLocked}},
		{"389DS nsAccountLock", []string{"inetOrgPerson", "nsAccount"}, accountAttrs{"nsaccountlock": {"TRUE"}}, []string{TreeStatusDisabled}},
		{"389DS unlocked", []string{"inetOrgPerson"}, accountAttrs{"nsaccountlock": {"false"}}, nil},
		{"OU", []string{"organizationalUnit"}, accountAttrs{"nsaccountlock": {"TRUE"}}, nil},
	}
	for _, c := range cases {
		got := treeNodeStatus(c.oc, c.attrs, now)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}

	// RW1-P-02: an OpenLDAP timed lock is shown when the policy evaluation confirms it.
	ol := accountAttrs{"pwdaccountlockedtime": {"20261031110000Z"}}
	if got := treeNodeStatus([]string{"inetOrgPerson"}, ol, now, func(accountAttrs) bool { return true }); !reflect.DeepEqual(got, []string{TreeStatusLocked}) {
		t.Errorf("OL locked by policy: %v", got)
	}
	if got := treeNodeStatus([]string{"inetOrgPerson"}, ol, now, func(accountAttrs) bool { return false }); got != nil {
		t.Errorf("OL lockout expired by policy: %v", got)
	}
	// The policy evaluation itself: lockout duration 0 = locked until an administrator unlocks it.
	pol := &models.AccountPolicy{Readable: true, LockoutEnabled: true, LockoutDurationSeconds: 0}
	st := newAccountStatus("uid=x", models.ServerTypeOpenLDAP, now)
	computePPolicyStatus(st, ol, pol, now)
	if !st.Locked {
		t.Error("duration 0: locked")
	}
	pol.LockoutDurationSeconds = 600 // 10 min after 11:00 = over at 12:00
	st = newAccountStatus("uid=x", models.ServerTypeOpenLDAP, now)
	computePPolicyStatus(st, ol, pol, now)
	if st.Locked {
		t.Error("duration elapsed: not locked")
	}
}

// M-06: which tree children need the login-attribute presence read.
func TestTreeKindNeedsAttributes(t *testing.T) {
	cases := []struct {
		oc   []string
		want bool
	}{
		{[]string{"top", "person", "organizationalPerson", "inetOrgPerson"}, true},
		{[]string{"inetOrgPerson", "posixAccount"}, false},
		{[]string{"top", "person", "organizationalPerson", "user"}, false},
		{[]string{"top", "person", "organizationalPerson", "contact"}, false},
		{[]string{"inetOrgPerson", "uidObject"}, false},
		{[]string{"organizationalUnit"}, false},
		{[]string{"device"}, false},
	}
	for _, c := range cases {
		if got := treeKindNeedsAttributes(c.oc); got != c.want {
			t.Errorf("%v: got %v", c.oc, got)
		}
	}
	if normalizeTreeDN("CN=A, OU=B,dc=x") != normalizeTreeDN("cn=a,ou=b,DC=X") {
		t.Error("normalizeTreeDN")
	}
}
