package services

// Tests of the v0.5 open-points package "conn": ask for the password on
// every connect (DEF-07), choose the profiles to export (DEF-06), pinned
// certificate details (DEF-04).

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

func fingerprintOf(hexPair string) string {
	return strings.TrimSuffix(strings.Repeat(hexPair+":", 32), ":")
}

// A profile that asks for the password on every connect stores none, never
// keeps a typed one for the next Connect and asks again on Reconnect.
func TestAskPasswordProfile(t *testing.T) {
	s := newTestConnectionService(t)
	saved, err := s.SaveConnection(models.ConnectionProfile{
		Name: "Ask", Host: "127.0.0.1", Port: 1, Timeout: 1, AuthMethod: models.AuthSimple,
		BindDN: "cn=admin", Password: "typed-in-the-dialog", AskPassword: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if saved.HasPassword || !saved.AskPassword {
		t.Fatalf("saved = %+v", saved)
	}
	if stored, _ := s.store.Get(saved.ID); stored.Password != "" {
		t.Fatal("password stored for an ask-password profile")
	}
	for name, call := range map[string]func() error{
		"Connect":   func() error { return s.Connect(saved.ID) },
		"Reconnect": func() error { return s.Reconnect(saved.ID) },
	} {
		err := call()
		if !errors.Is(err, ErrPasswordRequired) || !strings.HasPrefix(err.Error(), "password required") || !strings.Contains(err.Error(), "every connect") {
			t.Fatalf("%s = %v", name, err)
		}
	}
	// A password typed for the session (older flow) is ignored; a typed one is used for this connect only.
	s.setSessionPassword(saved.ID, "session")
	if _, err := s.profileForConnect(saved.ID, ""); !errors.Is(err, ErrPasswordRequired) {
		t.Fatalf("session password used: %v", err)
	}
	s.setSessionPassword(saved.ID, "")
	if p, err := s.profileForConnect(saved.ID, "typed"); err != nil || p.Password != "typed" {
		t.Fatalf("typed = %+v, %v", p, err)
	}
	// ConnectWithPassword with "save" neither stores nor keeps it (the dial itself fails: port 1).
	if err := s.ConnectWithPassword(saved.ID, "typed", true); err == nil || errors.Is(err, ErrPasswordRequired) {
		t.Fatalf("ConnectWithPassword = %v", err)
	}
	if stored, _ := s.store.Get(saved.ID); stored.Password != "" || s.sessionPassword(saved.ID) != "" {
		t.Fatalf("typed password kept: stored %q, session %q", stored.Password, s.sessionPassword(saved.ID))
	}
	if res := s.TestConnectionDetailed(*saved); res.Success || res.Stage != "config" || !strings.Contains(res.Error, "every connect") {
		t.Fatalf("Test = %+v", res)
	}

	// Switching a profile with a stored password to "ask" removes the password.
	other, err := s.SaveConnection(models.ConnectionProfile{Name: "Stored", Host: "h", AuthMethod: models.AuthNTLM, BindDN: `AD\alice`, Password: "pw"})
	if err != nil || !other.HasPassword {
		t.Fatalf("other = %+v, %v", other, err)
	}
	other.AskPassword = true
	other, err = s.SaveConnection(*other)
	if err != nil || other.HasPassword {
		t.Fatalf("switched = %+v, %v", other, err)
	}
	// The option is dropped for methods that send no password.
	anon, err := s.SaveConnection(models.ConnectionProfile{Name: "Anon", Host: "h", AuthMethod: models.AuthNone, AskPassword: true})
	if err != nil || anon.AskPassword {
		t.Fatalf("anonymous = %+v, %v", anon, err)
	}
	krb, err := s.SaveConnection(models.ConnectionProfile{Name: "Krb", Host: "h", AuthMethod: models.AuthKerberos, KrbCredSource: models.KrbCredSystem, AskPassword: true})
	if err != nil || krb.AskPassword {
		t.Fatalf("ticket cache = %+v, %v", krb, err)
	}
	kpw, err := s.SaveConnection(models.ConnectionProfile{Name: "KrbPw", Host: "h", AuthMethod: models.AuthKerberos, BindDN: "alice@AD.LAB", AskPassword: true})
	if err != nil || !kpw.AskPassword {
		t.Fatalf("kerberos password = %+v, %v", kpw, err)
	}
}

// Exports carry "ask for the password" and the pin details, never a
// password; imports list ask-password profiles apart from "needs a password".
func TestAskPasswordExportImport(t *testing.T) {
	fp := fingerprintOf("AB")
	profiles := []models.ConnectionProfile{
		{ID: "1", Name: "Ask", Host: "dc1", Port: 636, AuthMethod: models.AuthSimple, BindDN: "cn=a", AskPassword: true, TLSMode: models.TLSSSL,
			TLSPinnedCerts: []string{fp}, TLSPinnedInfo: map[string]models.PinnedCertificateInfo{fp: {Subject: "CN=dc1", Issuer: "CN=CA", NotAfter: "2030-01-01T00:00:00Z"}}},
		{ID: "2", Name: "Plain", Host: "dc2", Port: 389, AuthMethod: models.AuthSimple, BindDN: "cn=b", Password: "secret"},
	}
	data, err := json.Marshal(exportProfiles(profiles))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if strings.Contains(text, "secret") || !strings.Contains(text, `"askPassword":true`) || !strings.Contains(text, `"tlsPinnedInfo"`) || !strings.Contains(text, "CN=dc1") {
		t.Fatalf("export = %s", text)
	}
	s := newTestConnectionService(t)
	// A legacy file with a plaintext password for an ask-password profile: the password is dropped.
	legacy := strings.Replace(text, `"askPassword":true`, `"askPassword":true,"password":"legacy"`, 1)
	report, err := s.importConnectionData([]byte(legacy))
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Imported) != 2 || len(report.AskPassword) != 1 || report.AskPassword[0] != "Ask" || len(report.NeedPassword) != 1 || report.NeedPassword[0] != "Plain" {
		t.Fatalf("report = %+v", report)
	}
	for _, p := range s.store.GetAll() {
		if p.Name == "Ask" {
			if p.Password != "" || !p.AskPassword || p.TLSPinnedInfo[fp].Subject != "CN=dc1" {
				t.Fatalf("imported = %+v", p)
			}
		}
	}
}

// ExportSelectedConnections exports only the chosen profiles, in list order.
func TestSelectProfiles(t *testing.T) {
	all := []models.ConnectionProfile{{ID: "a", Name: "A"}, {ID: "b", Name: "B"}, {ID: "c", Name: "C"}}
	got := selectProfiles(all, []string{"c", "a", "gone"})
	if len(got) != 2 || got[0].ID != "a" || got[1].ID != "c" {
		t.Fatalf("selected = %+v", got)
	}
	if len(selectProfiles(all, nil)) != 0 {
		t.Fatal("empty selection exported something")
	}
	s := newTestConnectionService(t)
	if _, err := s.ExportSelectedConnections([]string{"unknown"}); err == nil {
		t.Fatal("export of no profile did not fail")
	}
}

// Pin details are keyed by the canonical fingerprint, dropped with their
// pin, recorded from the trust prompt's chain and passed on as previous pins.
func TestPinnedCertificateDetails(t *testing.T) {
	fpA, fpB := fingerprintOf("AA"), fingerprintOf("BB")
	p := models.ConnectionProfile{
		AuthMethod: models.AuthNone, TLSMode: models.TLSSSL, TLSPinnedCerts: []string{strings.ToLower(strings.ReplaceAll(fpA, ":", ""))},
		TLSPinnedInfo: map[string]models.PinnedCertificateInfo{
			strings.ToLower(fpA): {Subject: " CN=dc1 ", Issuer: "CN=CA", NotAfter: "2030-01-01T00:00:00Z"},
			fpB:                  {Subject: "CN=removed"},
		},
	}
	if err := normalizeAuthSettings(&p); err != nil {
		t.Fatal(err)
	}
	if len(p.TLSPinnedInfo) != 1 || p.TLSPinnedInfo[fpA].Subject != "CN=dc1" {
		t.Fatalf("pin info = %+v", p.TLSPinnedInfo)
	}
	p.TLSPinnedCerts = nil
	if err := normalizeAuthSettings(&p); err != nil || p.TLSPinnedInfo != nil {
		t.Fatalf("info of removed pins kept: %+v, %v", p.TLSPinnedInfo, err)
	}

	// annotatePinChange names the old certificate.
	prof := models.ConnectionProfile{TLSPinnedCerts: []string{fpA}, TLSPinnedInfo: map[string]models.PinnedCertificateInfo{fpA: {Subject: "CN=old", Issuer: "CN=CA", NotAfter: "2026-01-01T00:00:00Z"}}}
	got := annotatePinChange(models.CertificateProblem{Chain: []models.CertificateInfo{{SHA256: fpB}}}, prof)
	if !got.PinnedChanged || len(got.PreviousPins) != 1 || got.PreviousPins[0].Subject != "CN=old" || got.PreviousPins[0].NotAfter == "" {
		t.Fatalf("previous pins = %+v", got.PreviousPins)
	}

	// TrustCertificate records the details of the certificate the prompt showed.
	s := newTestConnectionService(t)
	saved, err := s.SaveConnection(models.ConnectionProfile{Name: "ds", Host: "ds1", AuthMethod: models.AuthNone, TLSMode: models.TLSSSL})
	if err != nil {
		t.Fatal(err)
	}
	s.recordCertProblem(saved.ID, &ldap.CertificateError{Problem: models.CertificateProblem{Chain: []models.CertificateInfo{
		{SHA256: fpB, Subject: "CN=ds1.lab", Issuer: "CN=Lab CA", NotBefore: "2025-01-01T00:00:00Z", NotAfter: "2028-10-29T00:00:00Z"},
		{SHA256: fingerprintOf("CC"), Subject: "CN=Lab CA", IsCA: true},
	}}})
	pinned, err := s.TrustCertificate(saved.ID, fpB)
	if err != nil {
		t.Fatal(err)
	}
	info := pinned.TLSPinnedInfo[fpB]
	if info.Subject != "CN=ds1.lab" || info.Issuer != "CN=Lab CA" || info.NotAfter != "2028-10-29T00:00:00Z" || len(pinned.TLSPinnedInfo) != 1 {
		t.Fatalf("pinned info = %+v", pinned.TLSPinnedInfo)
	}
	// A manual pin (no presented certificate) has no details.
	manual, err := s.TrustCertificate(saved.ID, fpA)
	if err != nil || len(manual.TLSPinnedInfo) != 1 || manual.TLSPinnedInfo[fpA].Subject != "" {
		t.Fatalf("manual pin = %+v, %v", manual.TLSPinnedInfo, err)
	}
}
