package ldap

import (
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// UX loop round 3.

func TestHashingPhraseHasNoNestedParentheses(t *testing.T) {
	cases := map[string]string{
		"389 Directory Server stores passwords with PBKDF2-SHA512 (passwordStorageScheme)": " with PBKDF2-SHA512",
		"PBKDF2-SHA512": " with PBKDF2-SHA512",
		"ppolicy olcPPolicyHashCleartext (cn=config)": " (ppolicy olcPPolicyHashCleartext)",
		"":                                  "",
		"unknown whether the server hashes": " (unknown whether the server hashes)",
	}
	for in, want := range cases {
		if got := hashingPhrase(in); got != want {
			t.Errorf("hashingPhrase(%q) = %q, want %q", in, got, want)
		}
	}
	got := policySummary(models.EffectivePasswordPolicy{Policy: models.PasswordPolicyServer, ServerHashes: true, ServerHashing: "389 Directory Server stores passwords with PBKDF2-SHA512 (passwordStorageScheme)"})
	if got != "Cleartext userPassword values are sent to the server, which hashes them with PBKDF2-SHA512." {
		t.Errorf("summary %q", got)
	}
}

func TestMemberNodePersonLikeAndLogin(t *testing.T) {
	n := &memNode{}
	n.applyEntry(&goldap.Entry{DN: "cn=c,ou=x", Attributes: []*goldap.EntryAttribute{{Name: "objectClass", Values: []string{"top", "inetOrgPerson"}}}})
	if !n.personLike || n.hasLogin || n.objectType != models.MemberTypeUser {
		t.Errorf("contact candidate: %+v", n)
	}
	u := &memNode{}
	u.applyEntry(&goldap.Entry{DN: "uid=u,ou=x", Attributes: []*goldap.EntryAttribute{
		{Name: "objectClass", Values: []string{"inetOrgPerson"}}, {Name: "uid", Values: []string{"u"}},
	}})
	if !u.hasLogin {
		t.Errorf("uid read: a user, no extra check")
	}
	p := &memNode{}
	p.applyEntry(&goldap.Entry{DN: "uid=p,ou=x", Attributes: []*goldap.EntryAttribute{{Name: "objectClass", Values: []string{"inetOrgPerson", "posixAccount"}}}})
	if p.personLike {
		t.Errorf("an account class is never a contact candidate")
	}
}

func TestSchemaAttributeAliases(t *testing.T) {
	at := parseAttributeType("( 2.5.4.4 NAME ( 'sn' 'surname' ) SUP name )")
	if at == nil || at.Name != "sn" || len(at.Aliases) != 1 || at.Aliases[0] != "surname" {
		t.Fatalf("aliases: %+v", at)
	}
	one := parseAttributeType("( 0.9.2342.19200300.100.1.1 NAME 'uid' EQUALITY caseIgnoreMatch )")
	if one == nil || len(one.Aliases) != 0 {
		t.Fatalf("single name: %+v", one)
	}
}
