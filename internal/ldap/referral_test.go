package ldap

import (
	"reflect"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
)

func TestParseReferralURL(t *testing.T) {
	tests := []struct {
		url  string
		want referralTarget
	}{
		{"ldap://dc2.example.com/DC=child,DC=example,DC=com", referralTarget{"ldap", "dc2.example.com", "389", "DC=child,DC=example,DC=com"}},
		{"ldaps://dc2.example.com:3269/OU=a%20b,DC=x", referralTarget{"ldaps", "dc2.example.com", "3269", "OU=a b,DC=x"}},
		{"ldaps://dc2.example.com", referralTarget{"ldaps", "dc2.example.com", "636", ""}},
		{"ldap://[::1]:1389/dc=x??sub", referralTarget{"ldap", "::1", "1389", "dc=x"}},
	}
	for _, tt := range tests {
		got, err := parseReferralURL(tt.url)
		if err != nil || got != tt.want {
			t.Errorf("parseReferralURL(%q) = %+v, %v; want %+v", tt.url, got, err, tt.want)
		}
	}
	for _, bad := range []string{"http://x/", "ldap:///dc=x"} {
		if _, err := parseReferralURL(bad); err == nil {
			t.Errorf("parseReferralURL(%q): expected error", bad)
		}
	}
}

func TestReferralTLSMode(t *testing.T) {
	plain := models.ConnectionProfile{TLSMode: models.TLSNone}
	ldaps := models.ConnectionProfile{TLSMode: models.TLSSSL}
	startTLS := models.ConnectionProfile{TLSMode: models.TLSStartTLS}
	ldapRef := referralTarget{scheme: "ldap", port: "389"}
	ldapsRef := referralTarget{scheme: "ldaps", port: "636"}
	ldap636 := referralTarget{scheme: "ldap", port: "636"}

	tests := []struct {
		name    string
		profile models.ConnectionProfile
		target  referralTarget
		want    models.TLSMode
	}{
		{"plain profile, ldap url", plain, ldapRef, models.TLSNone},
		{"plain profile, ldaps url", plain, ldapsRef, models.TLSSSL},
		{"plain profile, port 636", plain, ldap636, models.TLSSSL},
		{"ldaps profile, ldap url is upgraded", ldaps, ldapRef, models.TLSStartTLS},
		{"ldaps profile, ldaps url", ldaps, ldapsRef, models.TLSSSL},
		{"starttls profile, ldap url", startTLS, ldapRef, models.TLSStartTLS},
		{"starttls profile, ldaps url", startTLS, ldapsRef, models.TLSSSL},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := referralTLSMode(tt.profile, tt.target); got != tt.want {
				t.Errorf("referralTLSMode = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestTrustedReferralDomains(t *testing.T) {
	tests := []struct {
		dns  []string
		want []string
	}{
		{[]string{"DC=ad,DC=example,DC=com"}, []string{"ad.example.com"}},
		{[]string{"OU=People,DC=corp,DC=example,DC=com", "DC=corp,DC=example,DC=com"}, []string{"corp.example.com"}},
		{[]string{"", "DC=Child,DC=Example,DC=com"}, []string{"child.example.com"}},
		{[]string{"dc=demo,dc=local"}, []string{"demo.local"}},
		{[]string{"dc=com"}, nil},                      // single label
		{[]string{"DC=co,DC=uk", "DC=com,DC=au"}, nil}, // public suffixes
		{[]string{"DC=contoso,DC=co,DC=uk"}, []string{"contoso.co.uk"}},
		{[]string{"DC=ngrok,DC=io", "DC=eu-central-1,DC=compute,DC=amazonaws,DC=com"}, nil}, // shared hosting zones
		{[]string{"o=Example,c=DE", "", "not a dn"}, nil},
		{[]string{"DC=x,OU=y,DC=example,DC=org"}, []string{"example.org"}}, // only the trailing DC= run counts
	}
	for _, tt := range tests {
		got := trustedReferralDomains(tt.dns...)
		if !reflect.DeepEqual(got, tt.want) {
			t.Errorf("trustedReferralDomains(%q) = %v, want %v", tt.dns, got, tt.want)
		}
	}
}

func TestReferralCredentialsAllowed(t *testing.T) {
	profile := models.ConnectionProfile{Host: "dc1.ad.example.com", Port: 389, BaseDN: "DC=ad,DC=example,DC=com"}
	domains := trustedReferralDomains(profile.BaseDN)
	tests := []struct {
		host, port string
		want       bool
	}{
		{"dc1.ad.example.com", "389", true},
		{"DC1.AD.EXAMPLE.COM.", "389", true},
		{"dc1.ad.example.com", "636", true},  // standard port, host in domain
		{"dc1.ad.example.com", "3269", true}, // global catalog
		{"dc2.ad.example.com", "389", true},
		{"child.ad.example.com", "3268", true},
		{"dc.child.ad.example.com", "636", true},
		{"ad.example.com", "389", true},
		{"dc2.ad.example.com", "31337", false}, // non-standard port in the domain
		{"dc1.ad.example.com", "31337", false}, // non-standard port on the profile host
		{"example.com", "389", false},
		{"evil.com", "389", false},
		{"ad.example.com.evil.com", "389", false},
		{"notad.example.com", "389", false},
		{"10.0.0.5", "389", false},
	}
	for _, tt := range tests {
		if got, reason := referralCredentialsAllowed(profile, domains, tt.host, tt.port); got != tt.want {
			t.Errorf("referralCredentialsAllowed(%s:%s) = %v (%s), want %v", tt.host, tt.port, got, reason, tt.want)
		}
	}

	// Non-standard profile port: allowed in the domain as well.
	lab := models.ConnectionProfile{Host: "dc1.ad.example.com", Port: 2389, BaseDN: "DC=ad,DC=example,DC=com"}
	if ok, reason := referralCredentialsAllowed(lab, domains, "dc2.ad.example.com", "2389"); !ok {
		t.Errorf("profile port in the trusted domain must be allowed: %s", reason)
	}

	// localhost (SSH tunnels, several directories on one host): only the
	// exact profile port.
	local := models.ConnectionProfile{Host: "localhost", Port: 389}
	if ok, _ := referralCredentialsAllowed(local, nil, "localhost", "389"); !ok {
		t.Error("same host and port must be trusted")
	}
	for _, port := range []string{"31337", "4389", "636"} {
		if ok, reason := referralCredentialsAllowed(local, nil, "localhost", port); ok {
			t.Errorf("localhost:%s must not receive the credentials of localhost:389 (%s)", port, reason)
		}
	}

	ipProfile := models.ConnectionProfile{Host: "10.0.0.1", Port: 389}
	if ok, _ := referralCredentialsAllowed(ipProfile, nil, "10.0.0.1", "389"); !ok {
		t.Error("same IP and port must be trusted")
	}
	if ok, _ := referralCredentialsAllowed(ipProfile, nil, "dc.example.com", "389"); ok {
		t.Error("IP profile without trusted domain must not trust other hosts")
	}
}

// TestReferralCredentialsPublicSuffix covers profile hosts that are a
// registrable domain or live in a shared hosting zone: the zone of the host
// must never become trusted.
func TestReferralCredentialsPublicSuffix(t *testing.T) {
	tests := []struct {
		host, baseDN string
		refHost      string
	}{
		{"contoso.co.uk", "DC=contoso,DC=co,DC=uk", "ldap.attacker.co.uk"},
		{"example.co.uk", "", "attacker.co.uk"},
		{"contoso.com.au", "DC=contoso,DC=com,DC=au", "evil.com.au"},
		{"ldap01.eastus.cloudapp.azure.com", "DC=corp,DC=contoso,DC=com", "evil.eastus.cloudapp.azure.com"},
		{"ldap01.eastus.cloudapp.azure.com", "o=contoso", "evil.eastus.cloudapp.azure.com"},
		{"ec2-3-120-1-2.eu-central-1.compute.amazonaws.com", "", "ec2-9-9-9-9.eu-central-1.compute.amazonaws.com"},
		{"a1b2.ngrok.io", "dc=demo,dc=local", "evil.ngrok.io"},
	}
	for _, tt := range tests {
		profile := models.ConnectionProfile{Host: tt.host, Port: 389, BaseDN: tt.baseDN}
		domains := trustedReferralDomains(profile.BaseDN)
		if ok, reason := referralCredentialsAllowed(profile, domains, tt.refHost, "389"); ok {
			t.Errorf("profile %s (base %q): %s must not receive credentials (%s)", tt.host, tt.baseDN, tt.refHost, reason)
		}
	}

	// The registrable AD domain itself stays trusted.
	profile := models.ConnectionProfile{Host: "contoso.co.uk", Port: 389, BaseDN: "DC=contoso,DC=co,DC=uk"}
	if ok, reason := referralCredentialsAllowed(profile, trustedReferralDomains(profile.BaseDN), "dc2.contoso.co.uk", "389"); !ok {
		t.Errorf("dc2.contoso.co.uk must be trusted: %s", reason)
	}
}
