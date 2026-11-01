package ldap

import (
	"errors"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

func TestAcceptedADBindError(t *testing.T) {
	adErr := func(code uint16, data string) error {
		return &goldap.Error{ResultCode: code, Err: errors.New("80090308: LdapErr: DSID-0C09041C, comment: AcceptSecurityContext error, data " + data + ", v1db1")}
	}
	tests := []struct {
		name       string
		err        error
		accepted   bool
		mustChange bool
		detail     string
	}{
		{"must change", adErr(goldap.LDAPResultInvalidCredentials, "773"), true, true, "must change"},
		{"password expired", adErr(goldap.LDAPResultInvalidCredentials, "532"), true, true, "password expired"},
		{"disabled", adErr(goldap.LDAPResultInvalidCredentials, "533"), true, false, "account disabled (AD data 533)"},
		{"account expired", adErr(goldap.LDAPResultInvalidCredentials, "701"), true, false, "account expired"},
		{"logon hours", adErr(goldap.LDAPResultInvalidCredentials, "530"), true, false, "logon hours"},
		{"workstation", adErr(goldap.LDAPResultInvalidCredentials, "531"), true, false, "workstation"},
		{"wrong password", adErr(goldap.LDAPResultInvalidCredentials, "52e"), false, false, ""},
		{"locked out", adErr(goldap.LDAPResultInvalidCredentials, "775"), false, false, ""},
		{"other result code", adErr(goldap.LDAPResultUnwillingToPerform, "533"), false, false, ""},
		{"no data code", &goldap.Error{ResultCode: goldap.LDAPResultInvalidCredentials, Err: errors.New("invalid credentials")}, false, false, ""},
		{"nil", nil, false, false, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			check, ok := acceptedADBindError(tt.err)
			if ok != tt.accepted {
				t.Fatalf("accepted = %v, want %v", ok, tt.accepted)
			}
			if !ok {
				return
			}
			if check.MustChange != tt.mustChange {
				t.Errorf("MustChange = %v, want %v", check.MustChange, tt.mustChange)
			}
			if !strings.Contains(check.Detail, tt.detail) || !strings.HasPrefix(check.Detail, "password accepted") {
				t.Errorf("Detail = %q, want it to contain %q", check.Detail, tt.detail)
			}
		})
	}
}

// CheckBind dials without the profile's own credentials: an NTLM profile
// must not pre-bind as the profile user (dialServerNTLM, preBound), while
// server, TLS trust and client certificate stay.
func TestBindCheckProfile(t *testing.T) {
	in := models.ConnectionProfile{
		Host: "dc1.example.org", Port: 636, TLSMode: models.TLSSSL, Timeout: 7,
		AuthMethod: models.AuthNTLM, BindDN: `EXAMPLE\admin`, Password: "secret", NTLMDomain: "EXAMPLE",
		KrbCredSource: models.KrbCredSystem, KrbCCache: "/tmp/cc", KrbRealm: "EXAMPLE.ORG",
		TLSCACertPEM: "-----BEGIN CERTIFICATE-----", TLSClientCertFile: "/c.pem", TLSClientKeyFile: "/k.pem",
		TLSPinnedCerts: []string{"AA:BB"},
	}
	p := bindCheckProfile(in)
	if p.AuthMethod != models.AuthNone || p.BindDN != "" || p.Password != "" || p.NTLMDomain != "" || p.KrbCredSource != "" || p.KrbCCache != "" {
		t.Errorf("credentials kept: %+v", p)
	}
	if p.Host != in.Host || p.Port != in.Port || p.TLSMode != in.TLSMode || p.Timeout != in.Timeout ||
		p.TLSCACertPEM != in.TLSCACertPEM || p.TLSClientCertFile != in.TLSClientCertFile || p.TLSClientKeyFile != in.TLSClientKeyFile ||
		len(p.TLSPinnedCerts) != 1 {
		t.Errorf("server/TLS settings lost: %+v", p)
	}
	if in.AuthMethod != models.AuthNTLM || in.Password != "secret" {
		t.Error("the client's profile was modified")
	}
}
