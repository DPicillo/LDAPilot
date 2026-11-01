package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai/ldaptools"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
	internalldap "github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// Review 2b: Client.SearchContext reports an ended context as
// ErrSearchCancelled; the AI adapter maps a tool deadline to TIMEOUT
// ("narrow the filter"), not SEARCH_CANCELLED ("retry").
func TestAISearchErrMapsDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel()
	<-ctx.Done()
	err := aiSearchErr(ctx, internalldap.ErrSearchCancelled)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline: %v", err)
	}
	if code := ldaptools.ErrorResult("search_ldap", err, "").Code(); code != tools.ErrTimeout {
		t.Fatalf("deadline code %s", code)
	}
	stopped, stop := context.WithCancel(context.Background())
	stop()
	if code := ldaptools.ErrorResult("search_ldap", aiSearchErr(stopped, internalldap.ErrSearchCancelled), "").Code(); code != tools.ErrCancelled {
		t.Fatalf("run stop code %s", code)
	}
	// A cancellation by LDAPilot itself (live context) stays SEARCH_CANCELLED.
	if code := ldaptools.ErrorResult("search_ldap", aiSearchErr(context.Background(), internalldap.ErrSearchCancelled), "").Code(); code != tools.ErrSearchCancelled {
		t.Fatalf("LDAPilot cancel code %s", code)
	}
	if aiSearchErr(ctx, nil) != nil {
		t.Fatal("nil error changed")
	}
}

// Review 2b: the approval card's "runs as" is the auth identity, like the
// audit log (NTLM domain, Kerberos, client certificate).
func TestAIConnInfoIdentity(t *testing.T) {
	for _, tc := range []struct {
		p    models.ConnectionProfile
		want string
	}{
		{models.ConnectionProfile{AuthMethod: models.AuthNone}, "anonymous"},
		{models.ConnectionProfile{BindDN: "cn=admin,dc=x"}, "cn=admin,dc=x"},
	} {
		if got := aiIdentity(tc.p); got != tc.want {
			t.Errorf("%+v: %q", tc.p, got)
		}
	}
	p := models.ConnectionProfile{AuthMethod: models.AuthExternal}
	if got := aiIdentity(p); got == "" || got != internalldap.AuthIdentity(p) {
		t.Errorf("external: %q", got)
	}
}
