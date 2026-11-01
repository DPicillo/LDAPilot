package services

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/config"
	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

func TestExportProfilesHasNoSecrets(t *testing.T) {
	profiles := []models.ConnectionProfile{{
		ID: "1", Name: "AD", Host: "dc1", Port: 636, AuthMethod: models.AuthKerberos,
		BindDN: "alice@EXAMPLE.ORG", Password: "s3cret!", HasPassword: true,
		TLSMode: models.TLSSSL, KrbRealm: "EXAMPLE.ORG", KrbKDC: "kdc:88", KrbSPN: "ldap/dc1.example.org",
		KrbCredSource: models.KrbCredPassword, TLSCACertPEM: "PEM", TLSPinnedCerts: []string{"AA"},
		TLSClientCertFile: "/c.pem", TLSClientKeyFile: "/k.pem",
	}}
	data, err := json.Marshal(exportProfiles(profiles))
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	if strings.Contains(s, "s3cret") || strings.Contains(s, `"password":`) || strings.Contains(s, `"id":`) {
		t.Fatalf("export contains secrets or ids: %s", s)
	}
	var back []exportProfile
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	p := importProfile(back[0])
	if p.KrbSPN != "ldap/dc1.example.org" || p.KrbKDC != "kdc:88" || p.TLSCACertPEM != "PEM" || len(p.TLSPinnedCerts) != 1 ||
		p.TLSClientKeyFile != "/k.pem" || p.Password != "" || p.Port != 636 {
		t.Fatalf("round trip lost settings: %+v", p)
	}
}

func TestImportLegacyFile(t *testing.T) {
	var imps []exportProfile
	legacy := `[{"name":"old","host":"h","authMethod":"","bindDN":"cn=a","password":"pw","tlsMode":""}]`
	if err := json.Unmarshal([]byte(legacy), &imps); err != nil {
		t.Fatal(err)
	}
	p := importProfile(imps[0])
	if p.Password != "pw" || p.Port != 389 || p.PageSize != 500 || p.Timeout != 10 || p.AuthMethod != models.AuthSimple || p.TLSMode != models.TLSNone {
		t.Fatalf("legacy import: %+v", p)
	}
}

func TestNormalizeAuthSettings(t *testing.T) {
	fp := strings.Repeat("ab", 32)
	p := models.ConnectionProfile{
		AuthMethod: models.AuthKerberos, KrbSPN: " ldap/x ", KrbKDC: " kdc ", KrbRealm: " ad.ldapilot.lab ",
		TLSPinnedCerts: []string{fp, strings.ToUpper(fp), "", "SHA256:" + fp},
	}
	if err := normalizeAuthSettings(&p); err != nil {
		t.Fatal(err)
	}
	want, _ := ldap.NormalizeFingerprint(fp)
	if p.KrbSPN != "ldap/x" || p.KrbKDC != "kdc" || p.KrbRealm != "AD.LDAPILOT.LAB" || p.KrbCredSource != models.KrbCredPassword ||
		len(p.TLSPinnedCerts) != 1 || p.TLSPinnedCerts[0] != want {
		t.Fatalf("normalized = %+v", p)
	}
	for _, bad := range []models.ConnectionProfile{
		{AuthMethod: "digest"},
		{AuthMethod: models.AuthKerberos, KrbCredSource: "keytab"},
		{AuthMethod: models.AuthSimple, TLSPinnedCerts: []string{"xyz"}},
	} {
		if err := normalizeAuthSettings(&bad); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}

func TestMaskProfile(t *testing.T) {
	m := maskProfile(models.ConnectionProfile{Password: "pw"})
	if m.Password != "" || !m.HasPassword {
		t.Fatalf("masked = %+v", m)
	}
	if m := maskProfile(models.ConnectionProfile{}); m.HasPassword {
		t.Fatal("HasPassword without password")
	}
}

func TestRecordCertProblem(t *testing.T) {
	s := &ConnectionService{}
	certErr := &ldap.CertificateError{Problem: models.CertificateProblem{Host: "h", Kind: models.CertProblemUnknownAuthority}}
	s.recordCertProblem("p", fmt.Errorf("%w: %w", ldap.ErrConnectionFailed, certErr))
	if got := s.GetCertificateProblem("p"); got == nil || got.Host != "h" {
		t.Fatalf("problem = %+v", got)
	}
	s.recordCertProblem("p", errors.New("bind failed"))
	if got := s.GetCertificateProblem("p"); got != nil {
		t.Fatalf("problem kept: %+v", got)
	}
}

func TestDropUnusedPassword(t *testing.T) {
	cases := []struct {
		p    models.ConnectionProfile
		keep bool
	}{
		{models.ConnectionProfile{AuthMethod: models.AuthSimple}, true},
		{models.ConnectionProfile{AuthMethod: models.AuthNTLM}, true},
		{models.ConnectionProfile{AuthMethod: models.AuthKerberos, KrbCredSource: models.KrbCredPassword}, true},
		{models.ConnectionProfile{AuthMethod: models.AuthKerberos, KrbCredSource: models.KrbCredSystem}, false},
		{models.ConnectionProfile{AuthMethod: models.AuthNone}, false},
		{models.ConnectionProfile{AuthMethod: models.AuthExternal}, false},
	}
	for _, c := range cases {
		p := c.p
		p.Password = "pw"
		dropUnusedPassword(&p)
		if (p.Password != "") != c.keep {
			t.Errorf("%s/%s: password kept = %v, want %v", c.p.AuthMethod, c.p.KrbCredSource, p.Password != "", c.keep)
		}
	}
}

// TestSaveConnectionSecrets checks that passwords (bind, NTLM, Kerberos) are
// encrypted at rest, never returned to the frontend and dropped for methods
// that do not use them. It uses a temporary config directory; no network.
func TestSaveConnectionSecrets(t *testing.T) {
	dir := t.TempDir()
	for _, v := range []string{"XDG_CONFIG_HOME", "HOME", "AppData"} {
		t.Setenv(v, dir)
	}
	cfgDir, err := config.ConfigDir()
	if err != nil || !strings.HasPrefix(cfgDir, dir) {
		t.Skipf("config dir %q is not below the temporary directory", cfgDir)
	}
	store, err := config.NewStore()
	if err != nil {
		t.Fatal(err)
	}
	pool := ldap.NewPool()
	defer pool.DisconnectAll()
	s := NewConnectionService(store, pool)

	const secret = "Kerb-S3cret!"
	saved, err := s.SaveConnection(models.ConnectionProfile{Name: "krb", Host: "dc1.example.org", AuthMethod: models.AuthKerberos,
		BindDN: "alice", Password: secret, KrbKDC: " kdc:88 "})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Password != "" || !saved.HasPassword || saved.KrbCredSource != models.KrbCredPassword || saved.KrbKDC != "kdc:88" {
		t.Fatalf("saved = %+v", saved)
	}
	raw, err := os.ReadFile(filepath.Join(cfgDir, "connections.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), secret) {
		t.Fatal("plaintext password on disk")
	}
	if p, _ := s.GetConnection(saved.ID); p.Password != "" || !p.HasPassword {
		t.Fatalf("GetConnection = %+v", p)
	}
	for _, p := range s.GetConnections() {
		if p.Password != "" {
			t.Fatal("GetConnections returned a password")
		}
	}
	// An empty password keeps the stored one.
	saved.KrbSPN = "ldap/dc1.example.org"
	if _, err := s.SaveConnection(*saved); err != nil {
		t.Fatal(err)
	}
	if stored, _ := store.Get(saved.ID); stored.Password != secret || stored.KrbSPN != "ldap/dc1.example.org" {
		t.Fatalf("stored = %+v", stored)
	}
	// Switching to the system credential cache drops the password.
	saved.KrbCredSource = models.KrbCredSystem
	updated, err := s.SaveConnection(*saved)
	if err != nil {
		t.Fatal(err)
	}
	if stored, _ := store.Get(saved.ID); stored.Password != "" || updated.HasPassword {
		t.Fatalf("password kept for system credentials: %+v", stored)
	}
	// Exports never contain secrets.
	data, _ := json.Marshal(exportProfiles(store.GetAll()))
	if strings.Contains(string(data), secret) || strings.Contains(string(data), `"password"`) {
		t.Fatalf("export = %s", data)
	}
	// TrustCertificate normalizes and de-duplicates pins.
	fp := strings.Repeat("0a", 32)
	if _, err := s.TrustCertificate(saved.ID, fp); err != nil {
		t.Fatal(err)
	}
	p, err := s.TrustCertificate(saved.ID, "SHA256:"+strings.ToUpper(fp))
	if err != nil || len(p.TLSPinnedCerts) != 1 || p.TLSPinnedCerts[0] != strings.TrimSuffix(strings.Repeat("0A:", 32), ":") {
		t.Fatalf("pins = %+v, %v", p, err)
	}
	if _, err := s.TrustCertificate(saved.ID, "nope"); err == nil {
		t.Fatal("invalid fingerprint accepted")
	}
}

// newTestConnectionService returns a ConnectionService on an empty
// temporary config directory (no network, no Wails context).
func newTestConnectionService(t *testing.T) *ConnectionService {
	t.Helper()
	dir := t.TempDir()
	for _, v := range []string{"XDG_CONFIG_HOME", "HOME", "AppData"} {
		t.Setenv(v, dir)
	}
	if cfgDir, err := config.ConfigDir(); err != nil || !strings.HasPrefix(cfgDir, dir) {
		t.Skipf("config dir %q is not below the temporary directory", cfgDir)
	}
	store, err := config.NewStore()
	if err != nil {
		t.Fatal(err)
	}
	pool := ldap.NewPool()
	t.Cleanup(pool.DisconnectAll)
	return NewConnectionService(store, pool)
}

func TestAnnotatePinChange(t *testing.T) {
	oldFP := strings.TrimSuffix(strings.Repeat("AA:", 32), ":")
	newFP := strings.TrimSuffix(strings.Repeat("BB:", 32), ":")
	problem := models.CertificateProblem{Host: "dc1", Kind: models.CertProblemUnknownAuthority, Chain: []models.CertificateInfo{{SHA256: newFP}}}
	pinned := models.ConnectionProfile{TLSPinnedCerts: []string{oldFP}, TLSPinnedAt: map[string]string{oldFP: "2026-01-02T03:04:05Z"}}

	got := annotatePinChange(problem, pinned)
	if !got.PinnedChanged || len(got.PreviousPins) != 1 || got.PreviousPins[0].Fingerprint != oldFP || got.PreviousPins[0].PinnedAt != "2026-01-02T03:04:05Z" {
		t.Fatalf("changed pin = %+v", got)
	}
	// First contact (no pins) and a pinned leaf failing for another reason are no pin change.
	if got := annotatePinChange(problem, models.ConnectionProfile{}); got.PinnedChanged || got.PreviousPins != nil {
		t.Fatalf("first contact = %+v", got)
	}
	samePin := models.ConnectionProfile{TLSPinnedCerts: []string{strings.ToLower(strings.ReplaceAll(newFP, ":", ""))}}
	if got := annotatePinChange(problem, samePin); got.PinnedChanged {
		t.Fatalf("pinned leaf reported as changed: %+v", got)
	}
}

func TestNormalizeDropsUnusedAuthFieldsAndStampsPins(t *testing.T) {
	ntlm := models.ConnectionProfile{AuthMethod: models.AuthNTLM, BindDN: `EXAMPLE\alice`, NTLMDomain: "OLD", KrbCCache: "/tmp/cc", KrbRealm: "X"}
	if err := normalizeAuthSettings(&ntlm); err != nil {
		t.Fatal(err)
	}
	if ntlm.NTLMDomain != "" || ntlm.KrbCCache != "" || ntlm.KrbRealm != "" {
		t.Fatalf("ntlm = %+v", ntlm)
	}
	bare := models.ConnectionProfile{AuthMethod: models.AuthNTLM, BindDN: "alice", NTLMDomain: "EXAMPLE"}
	if _ = normalizeAuthSettings(&bare); bare.NTLMDomain != "EXAMPLE" {
		t.Fatalf("domain of a bare user name dropped: %+v", bare)
	}
	krbPw := models.ConnectionProfile{AuthMethod: models.AuthKerberos, BindDN: "alice", KrbCCache: "/tmp/cc", KrbRealm: "example.org"}
	if _ = normalizeAuthSettings(&krbPw); krbPw.KrbCCache != "" || krbPw.KrbRealm != "EXAMPLE.ORG" {
		t.Fatalf("kerberos password = %+v", krbPw)
	}
	krbSys := models.ConnectionProfile{AuthMethod: models.AuthKerberos, KrbCredSource: models.KrbCredSystem, KrbCCache: "/tmp/cc", KrbRealm: "EXAMPLE.ORG"}
	if _ = normalizeAuthSettings(&krbSys); krbSys.KrbCCache != "/tmp/cc" || krbSys.KrbRealm != "" {
		t.Fatalf("kerberos ticket cache = %+v", krbSys)
	}

	fpA := strings.TrimSuffix(strings.Repeat("0A:", 32), ":")
	fpB := strings.TrimSuffix(strings.Repeat("0B:", 32), ":")
	p := models.ConnectionProfile{AuthMethod: models.AuthSimple, TLSPinnedCerts: []string{fpA, strings.ReplaceAll(fpB, ":", "")},
		TLSPinnedAt: map[string]string{fpA: "2025-05-05T00:00:00Z", "gone": "2020-01-01T00:00:00Z"}}
	if err := normalizeAuthSettings(&p); err != nil {
		t.Fatal(err)
	}
	if len(p.TLSPinnedAt) != 2 || p.TLSPinnedAt[fpA] != "2025-05-05T00:00:00Z" || p.TLSPinnedAt[fpB] == "" {
		t.Fatalf("pin dates = %v", p.TLSPinnedAt)
	}
}

func TestClampProfileSettings(t *testing.T) {
	for _, c := range []struct{ page, timeout, wantPage, wantTimeout int }{
		{0, 0, 500, 10}, {-3, -5, 500, 10}, {100, 30, 100, 30}, {99999, 9999, 5000, 600}, {1, 1, 1, 1},
	} {
		p := models.ConnectionProfile{PageSize: c.page, Timeout: c.timeout}
		clampProfileSettings(&p)
		if p.PageSize != c.wantPage || p.Timeout != c.wantTimeout {
			t.Errorf("clamp(%d, %d) = %d, %d", c.page, c.timeout, p.PageSize, p.Timeout)
		}
	}
}

// Importing the same file twice adds nothing the second time; profiles
// without a host or with an unsupported method are listed with a reason.
func TestImportConnectionDataReport(t *testing.T) {
	s := newTestConnectionService(t)
	if _, err := s.SaveConnection(models.ConnectionProfile{Name: "Existing", Host: "DC1.example.org", Port: 636, BindDN: "CN=Admin, DC=example,DC=org", BaseDN: "DC=example,DC=org", Password: "x", AuthMethod: models.AuthSimple}); err != nil {
		t.Fatal(err)
	}
	file := `[
	 {"name":"Same as existing","host":"dc1.example.org","port":636,"bindDN":"cn=admin,dc=example,dc=org","baseDN":"dc=example,dc=org","authMethod":"simple"},
	 {"name":"OL","host":"ol","port":389,"bindDN":"cn=admin,dc=demo","baseDN":"dc=demo","authMethod":"simple","pageSize":-3},
	 {"name":"OL again","host":"OL","port":389,"bindDN":"cn=admin,dc=demo","baseDN":"dc=demo","authMethod":"simple"},
	 {"name":"Win","host":"dc2","authMethod":"sspi"},
	 {"name":"No host","host":" "},
	 {"name":"Anon","host":"anon","authMethod":"none"}
	]`
	r, err := s.importConnectionData([]byte(file))
	if err != nil {
		t.Fatal(err)
	}
	if r.Total != 6 || fmt.Sprint(r.Imported) != "[OL Anon]" || fmt.Sprint(r.Duplicates) != "[Same as existing OL again]" ||
		len(r.Skipped) != 2 || r.Skipped[0].Name != "Win" || !strings.Contains(r.Skipped[0].Reason, "sspi") || r.Skipped[1].Reason != "no host" ||
		fmt.Sprint(r.NeedPassword) != "[OL]" {
		t.Fatalf("report = %+v", r)
	}
	for _, p := range s.store.GetAll() {
		if p.Name == "OL" && p.PageSize != 500 {
			t.Fatalf("page size not clamped: %d", p.PageSize)
		}
	}
	again, err := s.importConnectionData([]byte(file))
	if err != nil || len(again.Imported) != 0 || len(again.Duplicates) != 4 {
		t.Fatalf("second import = %+v, %v", again, err)
	}
	if r, err := s.importConnectionData([]byte(`[]`)); err != nil || r.Total != 0 || len(r.Imported) != 0 {
		t.Fatalf("empty file = %+v, %v", r, err)
	}
	if _, err := s.importConnectionData([]byte(`{"oops"`)); err == nil {
		t.Fatal("invalid JSON accepted")
	}
}

// A profile that needs a password none is stored for fails before dialing
// with ErrPasswordRequired; a password typed for the session is used.
func TestConnectPasswordRequired(t *testing.T) {
	s := newTestConnectionService(t)
	saved, err := s.SaveConnection(models.ConnectionProfile{Name: "Imported", Host: "127.0.0.1", Port: 1, Timeout: 1, BindDN: "cn=admin", AuthMethod: models.AuthSimple})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Connect(saved.ID); !errors.Is(err, ErrPasswordRequired) || !strings.HasPrefix(err.Error(), "password required") {
		t.Fatalf("Connect = %v", err)
	}
	if res := s.TestConnectionDetailed(*saved); res.Success || res.Stage != "config" || !strings.Contains(res.Error, "password") {
		t.Fatalf("Test = %+v", res)
	}
	s.setSessionPassword(saved.ID, "typed")
	p, err := s.profileForConnect(saved.ID, "")
	if err != nil || p.Password != "typed" {
		t.Fatalf("profileForConnect = %+v, %v", p, err)
	}
	// Anonymous and ticket-cache profiles never need one.
	for _, prof := range []models.ConnectionProfile{
		{AuthMethod: models.AuthNone}, {AuthMethod: models.AuthSimple, BindDN: ""},
		{AuthMethod: models.AuthKerberos, KrbCredSource: models.KrbCredSystem}, {AuthMethod: models.AuthExternal},
	} {
		if profileNeedsPassword(prof) {
			t.Errorf("needs password: %+v", prof)
		}
	}
	// Saving a new password forgets the session one; deleting forgets it too.
	saved.Password = "stored"
	if _, err := s.SaveConnection(*saved); err != nil {
		t.Fatal(err)
	}
	if s.sessionPassword(saved.ID) != "" {
		t.Fatal("session password kept after saving a password")
	}
}

func TestReplacePinnedCertificates(t *testing.T) {
	s := newTestConnectionService(t)
	saved, err := s.SaveConnection(models.ConnectionProfile{Name: "pinned", Host: "dc1", AuthMethod: models.AuthNone, TLSMode: models.TLSSSL,
		TLSPinnedCerts: []string{strings.Repeat("aa", 32), strings.Repeat("bb", 32)}})
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.TLSPinnedAt) != 2 {
		t.Fatalf("pin dates not stamped: %v", saved.TLSPinnedAt)
	}
	p, err := s.ReplacePinnedCertificates(saved.ID, strings.Repeat("cc", 32))
	want := strings.TrimSuffix(strings.Repeat("CC:", 32), ":")
	if err != nil || len(p.TLSPinnedCerts) != 1 || p.TLSPinnedCerts[0] != want || len(p.TLSPinnedAt) != 1 || p.TLSPinnedAt[want] == "" {
		t.Fatalf("replace = %+v, %v", p, err)
	}
}
