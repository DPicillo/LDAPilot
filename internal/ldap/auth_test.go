package ldap

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
)

func TestNTLMCredentials(t *testing.T) {
	tests := []struct {
		user, domain         string
		wantDomain, wantUser string
	}{
		{`LDAPILOT\Administrator`, "", "LDAPILOT", `LDAPILOT\Administrator`},
		{`LDAPILOT\Administrator`, "OTHER", "LDAPILOT", `LDAPILOT\Administrator`},
		{"administrator@ad.ldapilot.lab", "", "", "administrator@ad.ldapilot.lab"},
		{"administrator@ad.ldapilot.lab", "LDAPILOT", "", "administrator@ad.ldapilot.lab"},
		{"Administrator", "LDAPILOT", "LDAPILOT", `LDAPILOT\Administrator`},
		{" Administrator ", " LDAPILOT ", "LDAPILOT", `LDAPILOT\Administrator`},
		{"Administrator", "", "", "Administrator"},
		{"", "LDAPILOT", "", ""},
	}
	for _, tt := range tests {
		d, u := ntlmCredentials(tt.user, tt.domain)
		if d != tt.wantDomain || u != tt.wantUser {
			t.Errorf("ntlmCredentials(%q, %q) = %q, %q; want %q, %q", tt.user, tt.domain, d, u, tt.wantDomain, tt.wantUser)
		}
	}
}

func TestKerberosPrincipal(t *testing.T) {
	base := "DC=ad,DC=ldapilot,DC=lab"
	tests := []struct {
		name                string
		p                   models.ConnectionProfile
		wantUser, wantRealm string
		wantErr             string
	}{
		{"upn", models.ConnectionProfile{BindDN: "Administrator@ad.ldapilot.lab"}, "Administrator", "AD.LDAPILOT.LAB", ""},
		{"realm field wins", models.ConnectionProfile{BindDN: "alice@ad.ldapilot.lab", KrbRealm: "EXAMPLE.ORG"}, "alice", "EXAMPLE.ORG", ""},
		{"realm field uppercased", models.ConnectionProfile{BindDN: "alice", KrbRealm: " ad.ldapilot.lab "}, "alice", "AD.LDAPILOT.LAB", ""},
		{"from base DN", models.ConnectionProfile{BindDN: "alice", BaseDN: base}, "alice", "AD.LDAPILOT.LAB", ""},
		{"netbios form", models.ConnectionProfile{BindDN: `LDAPILOT\alice`, BaseDN: base}, "alice", "AD.LDAPILOT.LAB", ""},
		{"no realm", models.ConnectionProfile{BindDN: "alice", BaseDN: "o=example"}, "", "", "realm is unknown"},
		{"no user", models.ConnectionProfile{BindDN: "", KrbRealm: "X"}, "", "", "user name is required"},
		{"dn", models.ConnectionProfile{BindDN: "cn=admin,dc=example,dc=com", KrbRealm: "X"}, "", "", "looks like a DN"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			u, r, err := kerberosPrincipal(tt.p)
			if tt.wantErr != "" {
				var cfgErr *AuthConfigError
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) || !errors.As(err, &cfgErr) {
					t.Fatalf("err = %v, want AuthConfigError containing %q", err, tt.wantErr)
				}
				return
			}
			if err != nil || u != tt.wantUser || r != tt.wantRealm {
				t.Fatalf("got %q, %q, %v; want %q, %q", u, r, err, tt.wantUser, tt.wantRealm)
			}
		})
	}
}

func TestKerberosSPN(t *testing.T) {
	p := models.ConnectionProfile{Host: "localhost"}
	if got := kerberosSPN(p, "localhost"); got != "ldap/localhost" {
		t.Errorf("default SPN = %q", got)
	}
	p.KrbSPN = "ldap/dc1.ad.ldapilot.lab"
	if got := kerberosSPN(p, "LOCALHOST"); got != "ldap/dc1.ad.ldapilot.lab" {
		t.Errorf("override SPN = %q", got)
	}
	// A referral server gets its own SPN, never the override.
	if got := kerberosSPN(p, "dc2.child.ad.ldapilot.lab"); got != "ldap/dc2.child.ad.ldapilot.lab" {
		t.Errorf("referral SPN = %q", got)
	}
	if got := kerberosSPN(models.ConnectionProfile{Host: "[::1]"}, "[::1]"); got != "ldap/::1" {
		t.Errorf("IPv6 SPN = %q", got)
	}
}

func TestKDCAddress(t *testing.T) {
	ok := map[string]string{
		"localhost":        "localhost:88",
		"localhost:88":     "localhost:88",
		" kdc.example:750": "kdc.example:750",
		"10.0.0.1":         "10.0.0.1:88",
		"[::1]:88":         "[::1]:88",
		"::1":              "[::1]:88",
	}
	for in, want := range ok {
		got, err := kdcAddress(in)
		if err != nil || got != want {
			t.Errorf("kdcAddress(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", ":88", "host:0", "host:99999", "host:x", "a b"} {
		if got, err := kdcAddress(in); err == nil {
			t.Errorf("kdcAddress(%q) = %q, want error", in, got)
		}
	}
}

func TestKerberosConfigOverride(t *testing.T) {
	cfg, err := kerberosConfig("AD.LDAPILOT.LAB", "localhost")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LibDefaults.DefaultRealm != "AD.LDAPILOT.LAB" || cfg.LibDefaults.UDPPreferenceLimit != 1 || cfg.LibDefaults.DNSLookupKDC {
		t.Fatalf("libdefaults = %+v", cfg.LibDefaults)
	}
	n, kdcs, err := cfg.GetKDCs("AD.LDAPILOT.LAB", true)
	if err != nil || n != 1 || kdcs[1] != "localhost:88" {
		t.Fatalf("GetKDCs = %d %v %v", n, kdcs, err)
	}
	if _, err := kerberosConfig("X", "bad host"); err == nil {
		t.Fatal("invalid KDC accepted")
	}

	// Without override: an unknown realm is looked up in DNS.
	t.Setenv("KRB5_CONFIG", filepath.Join(t.TempDir(), "missing.conf"))
	cfg, err = kerberosConfig("EXAMPLE.ORG", "")
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.LibDefaults.DNSLookupKDC || cfg.LibDefaults.DefaultRealm != "EXAMPLE.ORG" {
		t.Fatalf("libdefaults = %+v", cfg.LibDefaults)
	}

	// A krb5.conf listing the realm is used as is.
	conf := filepath.Join(t.TempDir(), "krb5.conf")
	_ = os.WriteFile(conf, []byte("[libdefaults]\n default_realm = EXAMPLE.ORG\n[realms]\n EXAMPLE.ORG = {\n  kdc = kdc.example.org\n }\n"), 0o600)
	t.Setenv("KRB5_CONFIG", conf)
	cfg, err = kerberosConfig("EXAMPLE.ORG", "")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LibDefaults.DNSLookupKDC {
		t.Fatal("DNS lookup enabled for a configured realm")
	}
}

func TestResolveCCache(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "missing.conf")
	tests := []struct {
		name, override, env, conf, goos string
		want, wantSource                string
		wantErr                         string
	}{
		{name: "platform default", conf: missing, want: "/tmp/krb5cc_1000", wantSource: "system default"},
		{name: "env file", env: "FILE:/tmp/krb5cc_x", want: "/tmp/krb5cc_x", wantSource: "from KRB5CCNAME"},
		{name: "env plain", env: "/tmp/plain", want: "/tmp/plain", wantSource: "from KRB5CCNAME"},
		{name: "profile wins", override: "/tmp/profile", env: "FILE:/tmp/env", want: "/tmp/profile", wantSource: "set in the profile"},
		{name: "profile FILE:", override: "FILE:/tmp/profile", want: "/tmp/profile", wantSource: "set in the profile"},
		{name: "keyring", env: "KEYRING:persistent:1000", wantErr: "type KEYRING"},
		{name: "kcm", env: "KCM:", wantErr: "kinit -c FILE:/tmp/krb5cc_1000"},
		{name: "api", override: "API:foo", wantErr: "type API"},
		{name: "empty file", override: "FILE:", wantErr: "has no file"},
		{name: "windows drive", override: `C:\krb5cc`, goos: "windows", want: `C:\krb5cc`, wantSource: "set in the profile"},
		{name: "macOS without file cache", conf: missing, goos: "darwin", wantErr: "type API"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := ccacheEnv{krb5ccname: tt.env, krb5Conf: tt.conf, goos: tt.goos, uid: 1000, username: "alice"}
			if e.goos == "" {
				e.goos = "linux"
			}
			if e.goos == "darwin" {
				e.uid = 2147480001 // no /tmp/krb5cc_<uid> file
			}
			loc, err := resolveCCache(tt.override, e)
			if tt.wantErr != "" {
				var cfgErr *AuthConfigError
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) || !errors.As(err, &cfgErr) {
					t.Fatalf("err = %v, want AuthConfigError containing %q", err, tt.wantErr)
				}
				return
			}
			if err != nil || loc.Path != tt.want || loc.Source != tt.wantSource {
				t.Fatalf("got %+v, %v; want %q (%s)", loc, err, tt.want, tt.wantSource)
			}
		})
	}
}

func TestCCacheFromKrb5Conf(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	e := ccacheEnv{goos: "linux", uid: 1000, username: "alice"}

	// Fedora: includedir at the top, KCM default in a drop-in file, and a
	// commented-out value in the main file.
	confd := filepath.Join(dir, "krb5.conf.d")
	write("krb5.conf.d/kcm_default_ccache", "[libdefaults]\n    default_ccache_name = KCM:\n")
	write("krb5.conf.d/.hidden.conf", "[libdefaults]\n default_ccache_name = FILE:/hidden\n")
	write("krb5.conf.d/backup~", "[libdefaults]\n default_ccache_name = FILE:/backup\n")
	e.krb5Conf = write("fedora.conf", "includedir "+confd+"\n\n[libdefaults]\n  # default_ccache_name = KEYRING:persistent:%{uid}\n  dns_lookup_realm = false\n")
	loc, err := resolveCCache("", e)
	if err == nil || !strings.Contains(err.Error(), "type KCM") || !strings.Contains(err.Error(), "kcm_default_ccache") || loc.Name != "KCM:" {
		t.Fatalf("fedora: %+v, %v", loc, err)
	}
	path, _, supported := func() (string, string, bool) {
		t.Setenv("KRB5CCNAME", "")
		t.Setenv("KRB5_CONFIG", e.krb5Conf)
		return DefaultCCachePath()
	}()
	if supported || path != "KCM:" {
		t.Fatalf("DefaultCCachePath = %q, %v; want KCM:, unsupported", path, supported)
	}

	// A FILE: default with tokens; realm subsections and other sections are skipped.
	e.krb5Conf = write("file.conf", `[realms]
 EXAMPLE.ORG = {
  default_ccache_name = FILE:/wrong
 }
[libdefaults]
 EXAMPLE.ORG = {
  default_ccache_name = FILE:/wrong-too
 }
 default_ccache_name = "FILE:%{TEMP}/krb5cc_%{uid}_%{username}%{null}"
 default_ccache_name = FILE:/second
`)
	t.Setenv("TMPDIR", "/var/tmp")
	loc, err = resolveCCache("", e)
	if err != nil || loc.Path != "/var/tmp/krb5cc_1000_alice" || loc.Source != "from "+e.krb5Conf {
		t.Fatalf("file default: %+v, %v", loc, err)
	}

	// include FILE, and KRB5CCNAME beats krb5.conf.
	inc := write("inc.conf", "[libdefaults]\n default_ccache_name = DIR:/run/user/%{uid}/krb5cc\n")
	e.krb5Conf = write("main.conf", "include "+inc+"\n")
	if _, err := resolveCCache("", e); err == nil || !strings.Contains(err.Error(), "DIR:/run/user/1000/krb5cc") {
		t.Fatalf("include: %v", err)
	}
	e.krb5ccname = "FILE:/tmp/env"
	if loc, err := resolveCCache("", e); err != nil || loc.Path != "/tmp/env" {
		t.Fatalf("env over krb5.conf: %+v, %v", loc, err)
	}

	// An include loop terminates.
	loop := filepath.Join(dir, "loop.conf")
	write("loop.conf", "include "+loop+"\n")
	if v, _ := krb5ConfLookup(loop, "libdefaults", "default_ccache_name", 0); v != "" {
		t.Fatalf("loop = %q", v)
	}
}

func TestKerberosErrorText(t *testing.T) {
	msg := "[Root cause: KRBMessage_Handling_Error] KRBMessage_Handling_Error: AS Exchange Error: AS_REP is not valid or client password/keytab incorrect < KRBMessage_Handling_Error: CRealm in response does not match what was requested. Requested: ad.ldapilot.lab; Reply: AD.LDAPILOT.LAB"
	got := kerberosErrorText(errors.New(msg))
	if !strings.HasPrefix(got, "the KDC spells the realm differently") || !strings.Contains(got, msg) {
		t.Fatalf("kerberosErrorText = %q", got)
	}
}

func TestNormalizeFingerprint(t *testing.T) {
	want := "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89"
	plain := strings.ReplaceAll(want, ":", "")
	for _, in := range []string{
		want,
		strings.ToLower(want),
		plain,
		"SHA256:" + plain,
		"sha256 Fingerprint=" + want,
		"  " + strings.ReplaceAll(want, ":", " ") + " ",
	} {
		got, err := NormalizeFingerprint(in)
		if err != nil || got != want {
			t.Errorf("NormalizeFingerprint(%q) = %q, %v", in, got, err)
		}
	}
	for _, in := range []string{"", "abc", plain[:62], plain + "00", strings.Replace(plain, "A", "G", 1)} {
		if _, err := NormalizeFingerprint(in); err == nil {
			t.Errorf("NormalizeFingerprint(%q) accepted", in)
		}
	}
}

// testPKI is a CA with a leaf for localhost and a self-signed certificate.
type testPKI struct {
	ca, leaf, self, expired *x509.Certificate
	leafKey, selfKey        *ecdsa.PrivateKey
	caPEM                   string
}

func newTestCert(t *testing.T, tmpl *x509.Certificate, parent *x509.Certificate, parentKey *ecdsa.PrivateKey) (*x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if parent == nil {
		parent, parentKey = tmpl, key
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, &key.PublicKey, parentKey)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return cert, key
}

func newTestPKI(t *testing.T) *testPKI {
	t.Helper()
	now := time.Now()
	caTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Test CA"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	ca, caKey := newTestCert(t, caTmpl, nil, nil)
	leafTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "localhost"},
		DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	leaf, leafKey := newTestCert(t, leafTmpl, ca, caKey)
	selfTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(3), Subject: pkix.Name{CommonName: "ldap.example"},
		DNSNames:  []string{"ldap.example"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	self, selfKey := newTestCert(t, selfTmpl, nil, nil)
	expTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(4), Subject: pkix.Name{CommonName: "localhost"},
		DNSNames:  []string{"localhost"},
		NotBefore: now.Add(-48 * time.Hour), NotAfter: now.Add(-24 * time.Hour),
	}
	expired, _ := newTestCert(t, expTmpl, ca, caKey)
	return &testPKI{
		ca: ca, leaf: leaf, self: self, expired: expired, leafKey: leafKey, selfKey: selfKey,
		caPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ca.Raw})),
	}
}

func TestVerifyServerCertificates(t *testing.T) {
	pki := newTestPKI(t)
	now := time.Now()
	customTrust, err := loadTLSTrust(models.ConnectionProfile{TLSCACertPEM: pki.caPEM})
	if err != nil {
		t.Fatal(err)
	}
	system := &tlsTrust{pins: map[string]bool{}}

	// Untrusted CA: unknown authority, chain reported.
	_, cerr := verifyServerCertificates([]*x509.Certificate{pki.leaf, pki.ca}, "localhost", system, now)
	if cerr == nil || cerr.Problem.Kind != models.CertProblemUnknownAuthority || len(cerr.Problem.Chain) != 2 {
		t.Fatalf("untrusted CA: %+v", cerr)
	}
	if cerr.Problem.Chain[0].SHA256 != CertificateFingerprint(pki.leaf) || !strings.HasPrefix(cerr.Error(), certErrorPrefix) {
		t.Fatalf("problem = %+v", cerr.Problem)
	}

	// Custom CA.
	if mode, cerr := verifyServerCertificates([]*x509.Certificate{pki.leaf}, "localhost", customTrust, now); cerr != nil || mode != models.TLSVerifyCustomCA {
		t.Fatalf("custom CA: %q %v", mode, cerr)
	}
	if mode, cerr := verifyServerCertificates([]*x509.Certificate{pki.leaf}, "127.0.0.1", customTrust, now); cerr != nil || mode != models.TLSVerifyCustomCA {
		t.Fatalf("custom CA by IP: %q %v", mode, cerr)
	}
	// Custom CA, wrong host name.
	_, cerr = verifyServerCertificates([]*x509.Certificate{pki.leaf}, "dc1.example", customTrust, now)
	if cerr == nil || cerr.Problem.Kind != models.CertProblemHostname || len(cerr.Problem.Issues) != 1 {
		t.Fatalf("hostname: %+v", cerr)
	}
	// Custom CA, expired leaf.
	_, cerr = verifyServerCertificates([]*x509.Certificate{pki.expired}, "localhost", customTrust, now)
	if cerr == nil || cerr.Problem.Kind != models.CertProblemExpired {
		t.Fatalf("expired: %+v", cerr)
	}
	// Self-signed, wrong host: both issues listed.
	_, cerr = verifyServerCertificates([]*x509.Certificate{pki.self}, "localhost", system, now)
	if cerr == nil || cerr.Problem.Kind != models.CertProblemUnknownAuthority || len(cerr.Problem.Issues) != 2 ||
		!strings.Contains(cerr.Problem.Issues[0], "self-signed") || !cerr.Problem.Chain[0].SelfSigned {
		t.Fatalf("self-signed: %+v", cerr)
	}

	// Pinned leaf: accepted despite the unknown issuer and host name.
	pinned := &tlsTrust{pins: map[string]bool{CertificateFingerprint(pki.self): true}}
	if mode, cerr := verifyServerCertificates([]*x509.Certificate{pki.self}, "localhost", pinned, now); cerr != nil || mode != models.TLSVerifyPinned {
		t.Fatalf("pinned: %q %v", mode, cerr)
	}
	// A pinned CA certificate does not vouch for an arbitrary leaf in the chain.
	caPinned := &tlsTrust{pins: map[string]bool{CertificateFingerprint(pki.ca): true}}
	if _, cerr := verifyServerCertificates([]*x509.Certificate{pki.self, pki.ca}, "ldap.example", caPinned, now); cerr == nil {
		t.Fatal("pinned CA accepted an unrelated leaf")
	}

	// Leaf issued after its CA expired (no common validity period): the
	// untrusted CA and its expiry are both reported.
	oldCATmpl := &x509.Certificate{
		SerialNumber: big.NewInt(10), Subject: pkix.Name{CommonName: "Old CA"},
		NotBefore: now.Add(-72 * time.Hour), NotAfter: now.Add(-24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	oldCA, oldKey := newTestCert(t, oldCATmpl, nil, nil)
	lateLeaf, _ := newTestCert(t, &x509.Certificate{
		SerialNumber: big.NewInt(11), Subject: pkix.Name{CommonName: "localhost"}, DNSNames: []string{"localhost"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
	}, oldCA, oldKey)
	_, cerr = verifyServerCertificates([]*x509.Certificate{lateLeaf, oldCA}, "localhost", system, now)
	if cerr == nil || cerr.Problem.Kind != models.CertProblemUnknownAuthority || len(cerr.Problem.Issues) != 2 ||
		!strings.Contains(cerr.Problem.Issues[0], `"Old CA", which is not a trusted CA`) || !strings.Contains(cerr.Problem.Issues[1], `CA certificate "Old CA" expired`) {
		t.Fatalf("late leaf: %+v", cerr)
	}
	oldTrust, _ := loadTLSTrust(models.ConnectionProfile{TLSCACertPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: oldCA.Raw}))})
	_, cerr = verifyServerCertificates([]*x509.Certificate{lateLeaf, oldCA}, "localhost", oldTrust, now)
	if cerr == nil || cerr.Problem.Kind != models.CertProblemExpired || len(cerr.Problem.Issues) != 1 {
		t.Fatalf("late leaf, trusted CA: %+v", cerr)
	}

	// Skip verification.
	if mode, cerr := verifyServerCertificates([]*x509.Certificate{pki.self}, "x", &tlsTrust{skip: true}, now); cerr != nil || mode != models.TLSVerifySkipped {
		t.Fatalf("skip: %q %v", mode, cerr)
	}
	// No certificate.
	if _, cerr := verifyServerCertificates(nil, "x", system, now); cerr == nil {
		t.Fatal("empty chain accepted")
	}
}

func TestLoadTLSTrustErrors(t *testing.T) {
	dir := t.TempDir()
	notPEM := filepath.Join(dir, "x.pem")
	_ = os.WriteFile(notPEM, []byte("hello"), 0o600)
	for name, p := range map[string]models.ConnectionProfile{
		"missing CA file": {TLSCACertFile: filepath.Join(dir, "missing.pem")},
		"garbage CA file": {TLSCACertFile: notPEM},
		"garbage PEM":     {TLSCACertPEM: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"},
		"cert w/o key":    {TLSClientCertFile: notPEM},
		"bad key pair":    {TLSClientCertFile: notPEM, TLSClientKeyFile: notPEM},
		"bad pin":         {TLSPinnedCerts: []string{"abc"}},
	} {
		var cfgErr *AuthConfigError
		if _, err := loadTLSTrust(p); err == nil || !errors.As(err, &cfgErr) {
			t.Errorf("%s: err = %v, want AuthConfigError", name, err)
		}
	}
}

func TestParseCertificatesDER(t *testing.T) {
	pki := newTestPKI(t)
	certs, err := ParseCertificates(pki.ca.Raw)
	if err != nil || len(certs) != 1 || !certs[0].Equal(pki.ca) {
		t.Fatalf("DER: %v %v", certs, err)
	}
	infos, err := DescribeCACertificates("", pki.caPEM+"\n"+pki.caPEM)
	if err != nil || len(infos) != 2 || !infos[0].IsCA || infos[0].Subject != "CN=Test CA" {
		t.Fatalf("describe: %+v %v", infos, err)
	}
}

// startTLSListener serves TLS handshakes with cert/key on 127.0.0.1 and
// returns the port; connections are closed right after the handshake.
func startTLSListener(t *testing.T, cert *x509.Certificate, key *ecdsa.PrivateKey, chain ...*x509.Certificate) string {
	t.Helper()
	tlsCert := tls.Certificate{Certificate: [][]byte{cert.Raw}, PrivateKey: key, Leaf: cert}
	for _, c := range chain {
		tlsCert.Certificate = append(tlsCert.Certificate, c.Raw)
	}
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{tlsCert}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				_ = c.(*tls.Conn).Handshake()
				time.Sleep(200 * time.Millisecond)
				c.Close()
			}()
		}
	}()
	return strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)
}

func TestDialServerTLSCertificates(t *testing.T) {
	pki := newTestPKI(t)
	port := startTLSListener(t, pki.self, pki.selfKey)
	profile := models.ConnectionProfile{Host: "localhost", TLSMode: models.TLSSSL, Timeout: 5}

	// Untrusted: structured error with the presented chain.
	_, out, err := dialServerTLS(profile, "localhost", port, models.TLSSSL)
	var certErr *CertificateError
	if !errors.As(err, &certErr) || out == nil || len(certErr.Problem.Chain) != 1 {
		t.Fatalf("err = %v (%T)", err, err)
	}
	wrapped := connectFailure(err, profile)
	if !errors.Is(wrapped, ErrConnectionFailed) || !errors.As(wrapped, &certErr) || !strings.Contains(wrapped.Error(), certErrorPrefix) {
		t.Fatalf("connectFailure = %v", wrapped)
	}

	// Pinned: accepted.
	profile.TLSPinnedCerts = []string{strings.ToLower(strings.ReplaceAll(certErr.Problem.Chain[0].SHA256, ":", ""))}
	conn, out, err := dialServerTLS(profile, "localhost", port, models.TLSSSL)
	if err != nil {
		t.Fatalf("pinned dial: %v", err)
	}
	conn.Close()
	if out.verification != models.TLSVerifyPinned {
		t.Fatalf("verification = %q", out.verification)
	}

	// Custom CA for a CA-issued server certificate.
	port2 := startTLSListener(t, pki.leaf, pki.leafKey, pki.ca)
	conn, out, err = dialServerTLS(models.ConnectionProfile{Timeout: 5, TLSCACertPEM: pki.caPEM}, "localhost", port2, models.TLSSSL)
	if err != nil {
		t.Fatalf("custom CA dial: %v", err)
	}
	conn.Close()
	if out.verification != models.TLSVerifyCustomCA || len(out.peer) != 2 {
		t.Fatalf("outcome = %+v", out)
	}

	// Invalid settings fail before dialing.
	_, _, err = dialServerTLS(models.ConnectionProfile{TLSPinnedCerts: []string{"nope"}}, "localhost", port, models.TLSSSL)
	var cfgErr *AuthConfigError
	if !errors.As(err, &cfgErr) {
		t.Fatalf("bad settings: %v", err)
	}
}

func TestAuthSummaryAndIdentity(t *testing.T) {
	krb := models.ConnectionProfile{AuthMethod: models.AuthKerberos, Host: "localhost", BindDN: "Administrator@ad.ldapilot.lab", KrbSPN: "ldap/dc1.ad.ldapilot.lab", Password: "secret"}
	if got := AuthSummary(krb); got != "Kerberos (GSSAPI) as Administrator@AD.LDAPILOT.LAB, SPN ldap/dc1.ad.ldapilot.lab" {
		t.Errorf("summary = %q", got)
	}
	if got := AuthIdentity(krb); got != "Administrator@AD.LDAPILOT.LAB" {
		t.Errorf("identity = %q", got)
	}
	ntlm := models.ConnectionProfile{AuthMethod: models.AuthNTLM, BindDN: "Administrator", NTLMDomain: "LDAPILOT", Password: "secret"}
	if got := AuthIdentity(ntlm); got != `LDAPILOT\Administrator` {
		t.Errorf("ntlm identity = %q", got)
	}
	for _, p := range []models.ConnectionProfile{krb, ntlm, {AuthMethod: models.AuthSimple, BindDN: "cn=x", Password: "secret"}} {
		if strings.Contains(AuthSummary(p), "secret") || strings.Contains(AuthIdentity(p), "secret") {
			t.Errorf("secret leaked for %s", p.AuthMethod)
		}
	}
	w := withoutCredentials(models.ConnectionProfile{AuthMethod: models.AuthKerberos, BindDN: "a", Password: "b", TLSClientCertFile: "c", TLSClientKeyFile: "d", TLSCACertPEM: "e"})
	if w.AuthMethod != models.AuthNone || w.BindDN != "" || w.Password != "" || w.TLSClientCertFile != "" || w.TLSClientKeyFile != "" || w.TLSCACertPEM != "e" {
		t.Errorf("withoutCredentials = %+v", w)
	}
}

func TestSecurityWarnings(t *testing.T) {
	plainKrb := securityWarnings(models.ConnectionProfile{AuthMethod: models.AuthKerberos, TLSMode: models.TLSNone}, nil, time.Now())
	if len(plainKrb) != 1 || !strings.Contains(plainKrb[0], "signing") {
		t.Errorf("kerberos plain: %v", plainKrb)
	}
	skip := securityWarnings(models.ConnectionProfile{AuthMethod: models.AuthSimple, TLSMode: models.TLSSSL, TLSSkipVerify: true}, &tlsOutcome{verification: models.TLSVerifySkipped}, time.Now())
	if len(skip) != 1 || !strings.Contains(skip[0], "verification is disabled") {
		t.Errorf("skip: %v", skip)
	}
	if w := securityWarnings(models.ConnectionProfile{AuthMethod: models.AuthKerberos, TLSMode: models.TLSStartTLS}, &tlsOutcome{verification: models.TLSVerifyCustomCA}, time.Now()); len(w) != 0 {
		t.Errorf("secure: %v", w)
	}
}

func TestClientCertRejection(t *testing.T) {
	alert := errors.New("unable to read LDAP response packet: remote error: tls: unknown certificate authority")
	sent := &tlsOutcome{hasClientCert: true, clientRequested: true}
	if err := clientCertRejection(alert, sent); err == nil || !strings.Contains(err.Error(), "rejected the TLS client certificate (tls: unknown certificate authority)") || !errors.Is(err, alert) {
		t.Fatalf("rejection = %v", err)
	}
	for _, out := range []*tlsOutcome{nil, {hasClientCert: true}, {clientRequested: true}} {
		if err := clientCertRejection(alert, out); err != nil {
			t.Errorf("%+v: unexpected %v", out, err)
		}
	}
	if err := clientCertRejection(errors.New("Invalid Credentials"), sent); err != nil {
		t.Errorf("non-alert error converted: %v", err)
	}
}
