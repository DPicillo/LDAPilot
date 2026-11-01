package ldap

import (
	"errors"
	"strings"
	"testing"

	goldap "github.com/go-ldap/ldap/v3"
)

func TestBindErrorHint(t *testing.T) {
	ad := func(code string) error {
		return goldap.NewError(goldap.LDAPResultInvalidCredentials,
			errors.New("80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data "+code+", v4563"))
	}
	for code, want := range map[string]string{
		"52e": "wrong password", "525": "does not exist", "530": "logon hours", "531": "workstation",
		"532": "password has expired", "533": "disabled", "701": "account has expired", "773": "must be changed", "775": "locked out",
	} {
		hint := BindErrorHint(ad(code))
		if !strings.Contains(hint, want) || !strings.Contains(hint, "AD code "+code) {
			t.Errorf("data %s: hint %q", code, hint)
		}
	}
	for _, err := range []error{nil, errors.New("connection refused"), ad("999"), goldap.NewError(goldap.LDAPResultInvalidCredentials, errors.New("invalid DN"))} {
		if hint := BindErrorHint(err); hint != "" {
			t.Errorf("%v: unexpected hint %q", err, hint)
		}
	}
	// Leading zeros (Samba prints "data 0000052e" on some versions).
	if !strings.Contains(BindErrorHint(errors.New("… data 0000052e, v1db1")), "wrong password") {
		t.Error("zero-padded code not recognised")
	}
	// bindFailure appends the hint and stays an ErrBindFailed with the raw detail.
	err := bindFailure(ad("775"), "simple bind as cn=x")
	if !errors.Is(err, ErrBindFailed) || !strings.Contains(err.Error(), "data 775") || !strings.HasSuffix(err.Error(), "the account is locked out (AD code 775)") {
		t.Fatalf("bindFailure = %v", err)
	}
}
