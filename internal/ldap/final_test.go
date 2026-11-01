package ldap

import (
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// UX final round (after loop round 3).

func TestServerHashingPlanLineHasNoNestedParentheses(t *testing.T) {
	eff := testPolicy(models.PasswordPolicyServer, func(e *models.EffectivePasswordPolicy) {
		e.ServerType = models.ServerType389DS
		e.ServerHashes = true
		e.ServerHashing = "389 Directory Server stores passwords with PBKDF2-SHA512 (passwordStorageScheme)"
	})
	plan, err := PlanPasswordChanges(eff, []models.AttributeChange{pwChange("add", "Secret!2026")}, models.PasswordWriteOptions{})
	if err != nil {
		t.Fatal(err)
	}
	want := "userPassword: 1 value sent in cleartext; the server hashes it with PBKDF2-SHA512"
	found := false
	for _, a := range plan.Actions {
		if a == want {
			found = true
		}
		if strings.Count(a, "(") > 1 {
			t.Errorf("nested parentheses (RW2-P-04): %q", a)
		}
	}
	if !found {
		t.Errorf("actions %q, want %q", plan.Actions, want)
	}
}

func TestEntriesTextIsSingularForOne(t *testing.T) {
	for n, want := range map[int]string{0: "0 entries", 1: "1 entry", 2: "2 entries", 1500: "1500 entries"} {
		if got := EntriesText(n); got != want {
			t.Errorf("EntriesText(%d) = %q, want %q", n, got, want)
		}
	}
}
