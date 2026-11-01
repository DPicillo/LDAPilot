package ldaptools_test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ai/ldaptools"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
	internalldap "github.com/dpicillo/LDAPilot/internal/ldap"
)

// The password storage policy errors of internal/ldap (GitHub issue #1)
// reach the model as "ask the user" results, never as raw LDAP errors.
func TestErrorResultPasswordPolicy(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
		code string
	}{
		// A dedicated code: UNSUPPORTED_ON_SERVER was confused with the AI
		// access level "ask" (test-1 D8).
		{fmt.Errorf("modify entry failed: %w", internalldap.ErrPasswordDecisionRequired), "decision", tools.ErrPasswordDecision},
		{fmt.Errorf("modify entry failed: %w", internalldap.ErrPasswordUnencrypted), "unencrypted", tools.ErrUnsupportedOnServer},
	} {
		r := ldaptools.ErrorResult("reset_password", tc.err, "uid=a,dc=x")
		if r.Code() != tc.code {
			t.Errorf("%v: code %s", tc.err, r.Code())
		}
		out := r.Render(4000)
		if !strings.Contains(out, tc.want) || !strings.Contains(out, "nothing was changed") || !strings.Contains(out, "Do not retry") {
			t.Errorf("%v: %s", tc.err, out)
		}
	}
}
