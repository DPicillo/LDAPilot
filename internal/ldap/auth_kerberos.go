package ldap

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
	"github.com/go-ldap/ldap/v3/gssapi"
	krbclient "github.com/jcmturner/gokrb5/v8/client"
	krbconfig "github.com/jcmturner/gokrb5/v8/config"
	"github.com/jcmturner/gokrb5/v8/credentials"
)

// defaultKDCPort is the Kerberos KDC port used when a KDC override has none.
const defaultKDCPort = "88"

// kerberosPrincipal returns user name and realm of a password-based
// Kerberos profile. BindDN may be "user", "user@REALM" or "DOMAIN\user"
// (the NetBIOS domain is not a realm and is dropped). The realm is, in this
// order: KrbRealm, the realm part of user@REALM or the DNS domain of the DC=
// components of BaseDN - always uppercased (see kerberosRealm).
func kerberosPrincipal(profile models.ConnectionProfile) (user, realm string, err error) {
	name := strings.TrimSpace(profile.BindDN)
	if i := strings.LastIndex(name, `\`); i >= 0 {
		name = name[i+1:]
	}
	var nameRealm string
	if i := strings.LastIndex(name, "@"); i >= 0 {
		name, nameRealm = name[:i], name[i+1:]
	}
	if name == "" {
		return "", "", configErrorf("Kerberos: a user name is required")
	}
	if strings.ContainsAny(name, "=,") {
		return "", "", configErrorf("Kerberos: %q looks like a DN; enter a user name (user or user@REALM)", profile.BindDN)
	}
	realm = kerberosRealm(profile, nameRealm)
	if realm == "" {
		return "", "", configErrorf("Kerberos: the realm is unknown; set the realm or enter the user as user@REALM")
	}
	return name, realm, nil
}

// kerberosRealm returns the realm of profile: KrbRealm, else nameRealm
// (from user@REALM), else the DC= domain of BaseDN. The result is
// uppercased: realms are case-sensitive, Active Directory / Samba realms are
// the DNS domain in uppercase, and a KDC answers a request for
// "ad.example.com" with "CRealm in response does not match". Realms that
// really are lowercase are not supported.
func kerberosRealm(profile models.ConnectionProfile, nameRealm string) string {
	if r := strings.TrimSpace(profile.KrbRealm); r != "" {
		return strings.ToUpper(r)
	}
	if nameRealm != "" {
		return strings.ToUpper(nameRealm)
	}
	return strings.ToUpper(dnDomain(profile.BaseDN))
}

// kerberosSPN returns the service principal for a GSSAPI bind to host: the
// profile's SPN override for its own host, ldap/<host> otherwise (referral
// servers always get their own SPN).
func kerberosSPN(profile models.ConnectionProfile, host string) string {
	h := normalizeHost(host)
	if spn := strings.TrimSpace(profile.KrbSPN); spn != "" && (h == "" || h == normalizeHost(profile.Host)) {
		return spn
	}
	if h == "" {
		h = normalizeHost(profile.Host)
	}
	return "ldap/" + h
}

// kdcAddress returns host:port of a KDC override ("host", "host:port",
// "[v6]:port" or a bare IPv6 address), using port 88 by default.
func kdcAddress(kdc string) (string, error) {
	kdc = strings.TrimSpace(kdc)
	if kdc == "" {
		return "", errors.New("empty KDC")
	}
	if host, port, err := net.SplitHostPort(kdc); err == nil {
		if host == "" {
			return "", fmt.Errorf("KDC %q has no host", kdc)
		}
		if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
			return "", fmt.Errorf("KDC %q has an invalid port", kdc)
		}
		return net.JoinHostPort(host, port), nil
	}
	host := strings.TrimSuffix(strings.TrimPrefix(kdc, "["), "]")
	if strings.ContainsAny(host, " /") {
		return "", fmt.Errorf("invalid KDC %q", kdc)
	}
	return net.JoinHostPort(host, defaultKDCPort), nil
}

// Krb5ConfigPath returns the krb5.conf used when a profile sets no KDC: the
// first file of KRB5_CONFIG, else the platform default.
func Krb5ConfigPath() string {
	if env := os.Getenv("KRB5_CONFIG"); env != "" {
		return strings.Split(env, string(os.PathListSeparator))[0]
	}
	if runtime.GOOS == "windows" {
		if pd := os.Getenv("ProgramData"); pd != "" {
			return filepath.Join(pd, "MIT", "Kerberos5", "krb5.ini")
		}
		return `C:\ProgramData\MIT\Kerberos5\krb5.ini`
	}
	return "/etc/krb5.conf"
}

// kerberosConfig returns the Kerberos configuration for realm. With a KDC
// override it is built programmatically (that KDC only, TCP only, no DNS);
// otherwise the system krb5.conf is read if present and DNS SRV lookup of
// KDCs is enabled for realms it does not list.
func kerberosConfig(realm, kdc string) (*krbconfig.Config, error) {
	if strings.TrimSpace(kdc) != "" {
		addr, err := kdcAddress(kdc)
		if err != nil {
			return nil, configErrorf("Kerberos: %v", err)
		}
		cfg := krbconfig.New()
		cfg.LibDefaults.DefaultRealm = realm
		cfg.LibDefaults.DNSLookupKDC = false
		cfg.LibDefaults.DNSLookupRealm = false
		cfg.LibDefaults.UDPPreferenceLimit = 1 // TCP only
		cfg.Realms = []krbconfig.Realm{{Realm: realm, KDC: []string{addr}}}
		return cfg, nil
	}

	cfg := krbconfig.New()
	path := Krb5ConfigPath()
	if _, err := os.Stat(path); err == nil {
		loaded, lerr := krbconfig.Load(path)
		var unsupported krbconfig.UnsupportedDirective
		if lerr != nil && !errors.As(lerr, &unsupported) {
			return nil, configErrorf("Kerberos: cannot read %s: %v (set a KDC in the profile to bypass it)", path, lerr)
		}
		if loaded != nil {
			cfg = loaded
		}
	}
	if cfg.LibDefaults.DefaultRealm == "" {
		cfg.LibDefaults.DefaultRealm = realm
	}
	known := false
	for _, r := range cfg.Realms {
		if r.Realm == realm && len(r.KDC) > 0 {
			known = true
		}
	}
	if !known {
		cfg.LibDefaults.DNSLookupKDC = true
	}
	return cfg, nil
}

// krbSettings are the gokrb5 client settings: FAST is disabled because
// Active Directory does not support it without armoring.
func krbSettings() []func(*krbclient.Settings) {
	return []func(*krbclient.Settings){krbclient.DisablePAFXFAST(true)}
}

// newPasswordGSSAPIClient logs in with user name and password and returns a
// GSSAPI client and a description of the principal.
func newPasswordGSSAPIClient(profile models.ConnectionProfile) (*gssapi.Client, string, error) {
	user, realm, err := kerberosPrincipal(profile)
	if err != nil {
		return nil, "", err
	}
	principal := user + "@" + realm
	if profile.Password == "" {
		return nil, principal, configErrorf("Kerberos: a password is required for %s", principal)
	}
	cfg, err := kerberosConfig(realm, profile.KrbKDC)
	if err != nil {
		return nil, principal, err
	}
	cl := krbclient.NewWithPassword(user, realm, profile.Password, cfg, krbSettings()...)
	if err := cl.Login(); err != nil {
		cl.Destroy()
		return nil, principal, fmt.Errorf("Kerberos login as %s failed: %s", principal, kerberosErrorText(err))
	}
	return &gssapi.Client{Client: cl}, principal, nil
}

// newCCacheGSSAPIClient returns a GSSAPI client using the ticket-granting
// ticket of a credential cache (kinit) and a description of its principal.
func newCCacheGSSAPIClient(profile models.ConnectionProfile) (*gssapi.Client, string, error) {
	env := currentCCacheEnv()
	loc, err := resolveCCache(profile.KrbCCache, env)
	if err != nil {
		return nil, "", err
	}
	path := loc.Path
	cc, err := credentials.LoadCCache(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			hint := fmt.Sprintf("run \"kinit -c FILE:%s\" first", path)
			if loc.Source != ccacheSourceProfile {
				hint = fmt.Sprintf("run kinit first; if your kinit keeps tickets elsewhere (KCM:, KEYRING:, API:), run \"kinit -c FILE:%s\" or enter a cache file in the profile", path)
			}
			return nil, "", fmt.Errorf("Kerberos: no ticket cache at %s (%s); %s", path, loc.Source, hint)
		}
		return nil, "", fmt.Errorf("Kerberos: cannot read credential cache %s (%s): %v (run kinit again)", path, loc.Source, err)
	}
	realm := cc.DefaultPrincipal.Realm
	principal := strings.Join(cc.DefaultPrincipal.PrincipalName.NameString, "/") + "@" + realm
	cfg, err := kerberosConfig(realm, profile.KrbKDC)
	if err != nil {
		return nil, principal, err
	}
	cl, err := krbclient.NewFromCCache(cc, cfg, krbSettings()...)
	if err != nil {
		return nil, principal, fmt.Errorf("Kerberos: credential cache %s: %s (run kinit again)", path, kerberosErrorText(err))
	}
	return &gssapi.Client{Client: cl}, principal + " (ticket cache " + path + ")", nil
}

// kerberosBind performs a SASL GSSAPI bind on conn, which is connected to
// host, and returns a description of the identity and SPN used.
func kerberosBind(conn *goldap.Conn, profile models.ConnectionProfile, host string) (string, error) {
	spn := kerberosSPN(profile, host)
	var (
		client  goldap.GSSAPIClient
		closeFn func()
		who     string
		err     error
	)
	if profile.KrbCredSource == models.KrbCredSystem {
		client, closeFn, who, err = newSystemGSSAPIClient(conn, profile)
	} else {
		var c *gssapi.Client
		c, who, err = newPasswordGSSAPIClient(profile)
		if c != nil {
			client, closeFn = c, func() { _ = c.Close() }
		}
	}
	summary := "Kerberos (GSSAPI)"
	if who != "" {
		summary += " as " + who
	}
	summary += ", SPN " + spn
	if err != nil {
		return summary, err
	}
	defer closeFn()
	if err := conn.GSSAPIBind(client, spn, ""); err != nil {
		var ldapErr *goldap.Error
		if errors.As(err, &ldapErr) {
			return summary, err
		}
		return summary, fmt.Errorf("GSSAPI bind with SPN %s failed: %s", spn, kerberosErrorText(err))
	}
	return summary, nil
}

// kerberosErrorHints explain the Kerberos errors users run into most.
var kerberosErrorHints = []struct{ match, hint string }{
	{"CRealm in response does not match", "the KDC spells the realm differently; enter the realm exactly as the KDC reports it (Active Directory: the DNS domain in uppercase)"},
	{"KDC_ERR_PREAUTH_FAILED", "wrong password"},
	{"KDC_ERR_C_PRINCIPAL_UNKNOWN", "unknown user name in this realm"},
	{"KDC_ERR_S_PRINCIPAL_UNKNOWN", "the KDC does not know the service principal; set the SPN (ldap/<DC host name>)"},
	{"KDC_ERR_CLIENT_REVOKED", "the account is disabled, locked or expired"},
	{"KDC_ERR_KEY_EXPIRED", "the password has expired"},
	{"KRB_AP_ERR_SKEW", "the clocks of this computer and the KDC differ by more than 5 minutes"},
	{"KDC_ERR_WRONG_REALM", "wrong realm"},
	{"KDC_ERR_ETYPE_NOSUPP", "no common encryption type (the account may need AES keys)"},
	{"no KDCs defined", "no KDC known for the realm; set the KDC in the profile or configure krb5.conf / DNS"},
	{"no KDC SRV records", "no KDC found in DNS for the realm; set the KDC in the profile"},
	{"connection refused", "the KDC is not reachable"},
	{"i/o timeout", "the KDC is not reachable"},
}

// kerberosErrorText returns err's message with a hint for common errors.
func kerberosErrorText(err error) string {
	msg := err.Error()
	for _, h := range kerberosErrorHints {
		if strings.Contains(msg, h.match) {
			return h.hint + " (" + msg + ")"
		}
	}
	return msg
}
