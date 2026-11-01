package ldap

import (
	"errors"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// The certificate probe of the pin "Refresh details" (DEF-04) needs TLS; the
// RootDSE name probe (DEF-05) reports an unreachable server quickly and never
// binds (the profile's credentials are dropped).
func TestServerProbes(t *testing.T) {
	plain := models.ConnectionProfile{Host: "127.0.0.1", Port: 1, TLSMode: models.TLSNone, Timeout: 1}
	if _, err := ProbeServerCertificates(plain); !errors.Is(err, ErrProbeNoTLS) {
		t.Fatalf("plain profile: %v", err)
	}
	start := time.Now()
	withCreds := plain
	withCreds.AuthMethod, withCreds.BindDN, withCreds.Password = models.AuthSimple, "cn=admin", "secret"
	if _, err := ProbeDNSHostName(withCreds); err == nil {
		t.Fatal("probe of a closed port succeeded")
	}
	tls := withCreds
	tls.TLSMode = models.TLSSSL
	if _, err := ProbeServerCertificates(tls); err == nil {
		t.Fatal("certificate probe of a closed port succeeded")
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("probes took %v", d)
	}
}
