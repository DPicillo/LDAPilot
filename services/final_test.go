package services

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// RW2-C-05: a connect error of a profile whose pinned certificate the server
// no longer presents says "pinned certificate changed"; the certificate
// error stays reachable with errors.As.
func TestNotePinChange(t *testing.T) {
	problem := models.CertificateProblem{
		Host:   "127.0.0.1",
		Reason: "x509: cannot validate certificate for 127.0.0.1 because it doesn't contain any IP SANs",
		Chain:  []models.CertificateInfo{{SHA256: strings.Repeat("AB", 32)}},
	}
	err := fmt.Errorf("connect: %w", &ldap.CertificateError{Problem: problem})
	pinned := models.ConnectionProfile{TLSPinnedCerts: []string{strings.Repeat("CD", 32)}}

	got := notePinChange(err, pinned)
	if !strings.HasSuffix(got.Error(), pinChangedNote) {
		t.Errorf("error %q, want the pin note", got)
	}
	var certErr *ldap.CertificateError
	if !errors.As(got, &certErr) {
		t.Error("the certificate error is no longer reachable")
	}
	// No pins, or the presented certificate is the pinned one: unchanged.
	if notePinChange(err, models.ConnectionProfile{}) != err {
		t.Error("a profile without pins got the note")
	}
	same := models.ConnectionProfile{TLSPinnedCerts: []string{strings.Repeat("AB", 32)}}
	if notePinChange(err, same) != err {
		t.Error("a pinned certificate got the note")
	}
	if notePinChange(nil, pinned) != nil {
		t.Error("nil error changed")
	}
	other := errors.New("dial tcp: connection refused")
	if notePinChange(other, pinned) != other {
		t.Error("a non-certificate error changed")
	}
}
