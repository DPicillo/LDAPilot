package services

import (
	"errors"
	"fmt"
	"maps"
	"os"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// TestConnectionDetailed connects with profile (saved or not) like Connect,
// binds, closes the connection again and reports which authentication
// method and TLS mode were used and how the server certificate was verified.
// If the certificate is not trusted, CertProblem holds the presented chain
// so the dialog can offer to pin it. An empty password of a saved profile
// means "use the stored password". It never returns an error; failures are
// reported in the result.
func (s *ConnectionService) TestConnectionDetailed(profile models.ConnectionProfile) models.ConnectionTestResult {
	if profile.Password == "" && profile.ID != "" {
		if existing, err := s.store.Get(profile.ID); err == nil {
			profile.Password = existing.Password
		}
		if profile.Password == "" {
			profile.Password = s.sessionPassword(profile.ID)
		}
	}
	if err := normalizeAuthSettings(&profile); err != nil {
		return models.ConnectionTestResult{
			AuthMethod: profile.AuthMethod,
			TLSMode:    profile.TLSMode,
			Stage:      "config",
			Error:      err.Error(),
		}
	}
	if profile.Password == "" && profileNeedsPassword(profile) {
		msg := "Enter the password: no password is stored for this connection."
		if profile.AskPassword {
			msg = "Enter the password: this connection asks for it on every connect and stores none."
		}
		return models.ConnectionTestResult{
			AuthMethod: profile.AuthMethod,
			TLSMode:    profile.TLSMode,
			Stage:      "config",
			Error:      msg,
		}
	}
	res := ldap.TestProfile(profile)
	if res.CertProblem != nil {
		p := annotatePinChange(*res.CertProblem, profile)
		res.CertProblem = &p
	}
	return res
}

// annotatePinChange marks a certificate problem of a profile that trusts
// pinned certificates: the server presented a certificate other than the
// pinned ones (the pinned certificate changed - renewed, or someone in
// between), which the trust prompt must not present like a first contact.
func annotatePinChange(problem models.CertificateProblem, profile models.ConnectionProfile) models.CertificateProblem {
	problem.PinnedChanged = false
	problem.PreviousPins = nil
	if len(profile.TLSPinnedCerts) == 0 || len(problem.Chain) == 0 {
		return problem
	}
	leaf, err := ldap.NormalizeFingerprint(problem.Chain[0].SHA256)
	if err != nil {
		return problem
	}
	for _, fp := range profile.TLSPinnedCerts {
		if norm, err := ldap.NormalizeFingerprint(fp); err == nil && norm == leaf {
			return problem // the presented certificate is pinned; another reason failed
		}
	}
	problem.PinnedChanged = true
	for _, fp := range profile.TLSPinnedCerts {
		info := profile.TLSPinnedInfo[fp]
		problem.PreviousPins = append(problem.PreviousPins, models.PinnedCertificate{
			Fingerprint: fp, PinnedAt: profile.TLSPinnedAt[fp],
			Subject: info.Subject, Issuer: info.Issuer, NotAfter: info.NotAfter,
		})
	}
	return problem
}

// pinChangedNote is appended to a connect error whose certificate differs
// from the profile's pinned ones (see notePinChange).
const pinChangedNote = " (pinned certificate changed)"

// notePinChange appends pinChangedNote to an untrusted-certificate error of
// a profile whose pinned certificate the server no longer presents, so the
// connect error itself says "changed" (the Connections list summary), like
// the trust prompt does (RW2-C-05: the x509 reason never mentions the pin).
// errors.As still finds the *ldap.CertificateError.
func notePinChange(err error, profile models.ConnectionProfile) error {
	var certErr *ldap.CertificateError
	if err == nil || !errors.As(err, &certErr) {
		return err
	}
	if !annotatePinChange(certErr.Problem, profile).PinnedChanged {
		return err
	}
	return fmt.Errorf("%w%s", err, pinChangedNote)
}

// GetCertificateProblem returns the untrusted server certificate that made
// the last Connect or Reconnect of the profile fail, or nil if the last
// attempt did not fail for that reason.
// PinnedChanged and PreviousPins say whether the profile had pinned another
// certificate (see annotatePinChange).
func (s *ConnectionService) GetCertificateProblem(profileID string) *models.CertificateProblem {
	s.certMu.Lock()
	p := s.certProblems[profileID]
	s.certMu.Unlock()
	if p == nil {
		return nil
	}
	cp := *p
	if s.store != nil {
		if profile, err := s.store.Get(profileID); err == nil {
			cp = annotatePinChange(cp, *profile)
		}
	}
	return &cp
}

// TrustCertificate pins the server certificate with the given SHA-256
// fingerprint (any common notation) in the saved profile, so the next
// Connect accepts it even though its chain, host name or validity cannot be
// verified. It returns the updated profile (password masked).
func (s *ConnectionService) TrustCertificate(profileID string, fingerprint string) (*models.ConnectionProfile, error) {
	return s.pinCertificate(profileID, fingerprint, false)
}

// ReplacePinnedCertificates trusts the certificate like TrustCertificate and
// removes every other pin of the profile: the server's certificate changed
// (renewed), so the old one should no longer be accepted.
func (s *ConnectionService) ReplacePinnedCertificates(profileID string, fingerprint string) (*models.ConnectionProfile, error) {
	return s.pinCertificate(profileID, fingerprint, true)
}

func (s *ConnectionService) pinCertificate(profileID, fingerprint string, replace bool) (*models.ConnectionProfile, error) {
	fp, err := ldap.NormalizeFingerprint(fingerprint)
	if err != nil {
		return nil, err
	}
	profile, err := s.store.Get(profileID)
	if err != nil {
		return nil, err
	}
	if replace {
		profile.TLSPinnedCerts = nil
	}
	if !slices.Contains(profile.TLSPinnedCerts, fp) {
		profile.TLSPinnedCerts = append(profile.TLSPinnedCerts, fp)
	}
	// The certificate the trust prompt showed: remember what it is.
	s.certMu.Lock()
	var chain []models.CertificateInfo
	if p := s.certProblems[profileID]; p != nil {
		chain = p.Chain
	}
	s.certMu.Unlock()
	recordPinInfo(profile, chain)
	stampPinDates(profile, time.Now())
	prunePinInfo(profile)
	saved, err := s.store.Update(*profile)
	if err != nil {
		return nil, err
	}
	s.certMu.Lock()
	delete(s.certProblems, profileID)
	s.certMu.Unlock()
	masked := maskProfile(*saved)
	return &masked, nil
}

// GetAuthEnvironment describes the local Kerberos environment (OS, SSPI,
// krb5.conf, default credential cache) for the connection dialog.
func (s *ConnectionService) GetAuthEnvironment() models.AuthEnvironment {
	env := models.AuthEnvironment{
		OS:            runtime.GOOS,
		SSPIAvailable: ldap.SSPIAvailable,
		Krb5Config:    ldap.Krb5ConfigPath(),
	}
	if _, err := os.Stat(env.Krb5Config); err == nil {
		env.Krb5ConfigFound = true
	}
	if !ldap.SSPIAvailable {
		env.DefaultCCache, env.DefaultCCacheSource, env.CCacheSupported = ldap.DefaultCCachePath()
	}
	return env
}

// DetectServerHostName reads the server's own DNS name (RootDSE
// dnsHostName) of the host, port and TLS mode of profile anonymously, for
// the connection dialog's Kerberos SPN suggestion (ldap/<name>) when the
// host is an IP address or alias. No credentials are sent.
func (s *ConnectionService) DetectServerHostName(profile models.ConnectionProfile) (string, error) {
	if strings.TrimSpace(profile.Host) == "" {
		return "", errors.New("enter the host first")
	}
	if err := normalizeAuthSettings(&profile); err != nil {
		return "", err
	}
	return ldap.ProbeDNSHostName(profile)
}

// GetServerCertificates returns the certificate chain the server of
// profile presents over its TLS mode (leaf first), without a bind and
// without verifying it: the dialog refreshes the details (subject, issuer,
// expiry) of pinned certificates from it.
func (s *ConnectionService) GetServerCertificates(profile models.ConnectionProfile) ([]models.CertificateInfo, error) {
	if strings.TrimSpace(profile.Host) == "" {
		return nil, errors.New("enter the host first")
	}
	if err := normalizeAuthSettings(&profile); err != nil {
		return nil, err
	}
	return ldap.ProbeServerCertificates(profile)
}

// DescribeCACertificates parses the CA certificates given as file path
// and/or PEM text (the profile fields TLSCACertFile and TLSCACertPEM) and
// describes them, so the dialog can show what will be trusted.
func (s *ConnectionService) DescribeCACertificates(file string, pemText string) ([]models.CertificateInfo, error) {
	return ldap.DescribeCACertificates(file, pemText)
}

// BrowseCertificateFile opens a file dialog for a certificate or key file
// and returns the chosen path ("" if cancelled). kind is "ca", "cert",
// "key" or "ccache" and only selects the dialog title and filters.
func (s *ConnectionService) BrowseCertificateFile(kind string) (string, error) {
	title := "Select certificate file"
	filters := []wailsruntime.FileFilter{
		{DisplayName: "Certificates (*.pem, *.crt, *.cer)", Pattern: "*.pem;*.crt;*.cer;*.der"},
	}
	switch kind {
	case "ca":
		title = "Select CA certificate"
	case "cert":
		title = "Select client certificate"
	case "key":
		title = "Select client private key"
		filters = []wailsruntime.FileFilter{{DisplayName: "Private keys (*.key, *.pem)", Pattern: "*.key;*.pem"}}
	case "ccache":
		title = "Select Kerberos credential cache"
		filters = nil
	}
	filters = append(filters, wailsruntime.FileFilter{DisplayName: "All Files (*.*)", Pattern: "*.*"})
	path, err := wailsruntime.OpenFileDialog(s.ctx, wailsruntime.OpenDialogOptions{Title: title, Filters: filters})
	if err != nil {
		return "", fmt.Errorf("dialog failed: %w", err)
	}
	return path, nil
}

// recordCertProblem remembers the certificate problem of a failed connect
// for GetCertificateProblem, or forgets it after any other outcome.
func (s *ConnectionService) recordCertProblem(profileID string, err error) {
	var certErr *ldap.CertificateError
	s.certMu.Lock()
	defer s.certMu.Unlock()
	if s.certProblems == nil {
		s.certProblems = make(map[string]*models.CertificateProblem)
	}
	if errors.As(err, &certErr) {
		p := certErr.Problem
		s.certProblems[profileID] = &p
		return
	}
	delete(s.certProblems, profileID)
}

// maskProfile removes the password of a profile sent to the frontend and
// sets HasPassword instead.
func maskProfile(p models.ConnectionProfile) models.ConnectionProfile {
	p.HasPassword = p.Password != ""
	p.Password = ""
	p.TLSPinnedCerts = slices.Clone(p.TLSPinnedCerts)
	p.TLSPinnedAt = maps.Clone(p.TLSPinnedAt)
	p.TLSPinnedInfo = maps.Clone(p.TLSPinnedInfo)
	return p
}

// dropUnusedPassword removes the password of a profile whose authentication
// does not use one (anonymous, SASL EXTERNAL, Kerberos with the system
// credentials), so no secret is stored that is never needed, and of a
// profile that asks for it on every connect (AskPassword stores none). The
// AskPassword option itself is dropped when the method sends no password.
func dropUnusedPassword(p *models.ConnectionProfile) {
	switch {
	case p.AuthMethod == models.AuthNone, p.AuthMethod == models.AuthExternal,
		p.AuthMethod == models.AuthKerberos && p.KrbCredSource == models.KrbCredSystem:
		p.Password = ""
	case p.AskPassword:
		p.Password = ""
	}
	if p.AskPassword && !profileNeedsPassword(*p) {
		p.AskPassword = false
	}
}

// normalizeAuthSettings trims the authentication and TLS fields of profile,
// uppercases the Kerberos realm, defaults the Kerberos credential source,
// drops settings the chosen method ignores (NTLM domain when the user name
// carries one, a credential cache for a password login, the realm for the
// ticket cache, Kerberos/NTLM fields of other methods), converts pinned
// fingerprints to the canonical form (dropping duplicates) and records the
// date of new pins. It fails on an invalid fingerprint or authentication
// method.
func normalizeAuthSettings(p *models.ConnectionProfile) error {
	switch p.AuthMethod {
	case "", models.AuthNone, models.AuthSimple, models.AuthNTLM, models.AuthKerberos, models.AuthExternal:
	default:
		return fmt.Errorf("unsupported authentication method %q", p.AuthMethod)
	}
	for _, f := range []*string{&p.NTLMDomain, &p.KrbRealm, &p.KrbKDC, &p.KrbSPN, &p.KrbCCache,
		&p.TLSCACertFile, &p.TLSClientCertFile, &p.TLSClientKeyFile} {
		*f = strings.TrimSpace(*f)
	}
	p.TLSCACertPEM = strings.TrimSpace(p.TLSCACertPEM)
	// Realms are case-sensitive and AD/Samba realms are uppercase; the bind
	// uppercases them anyway (ldap.kerberosRealm), store what is used.
	p.KrbRealm = strings.ToUpper(p.KrbRealm)
	if p.AuthMethod == models.AuthKerberos && p.KrbCredSource == "" {
		p.KrbCredSource = models.KrbCredPassword
	}
	if p.KrbCredSource != "" && p.KrbCredSource != models.KrbCredPassword && p.KrbCredSource != models.KrbCredSystem {
		return fmt.Errorf("unsupported Kerberos credential source %q", p.KrbCredSource)
	}
	dropUnusedAuthFields(p)
	var pins []string
	for _, fp := range p.TLSPinnedCerts {
		if strings.TrimSpace(fp) == "" {
			continue
		}
		norm, err := ldap.NormalizeFingerprint(fp)
		if err != nil {
			return fmt.Errorf("pinned certificate %q: %v", fp, err)
		}
		if !slices.Contains(pins, norm) {
			pins = append(pins, norm)
		}
	}
	p.TLSPinnedCerts = pins
	stampPinDates(p, time.Now())
	prunePinInfo(p)
	return nil
}

// dropUnusedAuthFields clears settings the authentication method of p does
// not use, so a stale value (an old NTLM domain, a ticket cache path after
// switching to a password) is neither shown nor exported later.
func dropUnusedAuthFields(p *models.ConnectionProfile) {
	if p.AuthMethod != models.AuthNTLM || strings.ContainsAny(p.BindDN, `\@`) {
		// The user name DOMAIN\user or user@domain names the domain itself.
		p.NTLMDomain = ""
	}
	switch {
	case p.AuthMethod != models.AuthKerberos:
		p.KrbCredSource, p.KrbRealm, p.KrbKDC, p.KrbSPN, p.KrbCCache = "", "", "", "", ""
	case p.KrbCredSource == models.KrbCredSystem:
		p.KrbRealm = "" // taken from the ticket cache / Windows logon
	default:
		p.KrbCCache = "" // only used with the ticket cache
	}
}

// stampPinDates records the current time for pinned fingerprints without a
// date and drops dates of pins that were removed.
func stampPinDates(p *models.ConnectionProfile, now time.Time) {
	if len(p.TLSPinnedCerts) == 0 {
		p.TLSPinnedAt = nil
		return
	}
	dates := make(map[string]string, len(p.TLSPinnedCerts))
	for _, fp := range p.TLSPinnedCerts {
		when := ""
		for k, v := range p.TLSPinnedAt {
			if norm, err := ldap.NormalizeFingerprint(k); err == nil && norm == fp {
				when = v
				break
			}
		}
		if when == "" {
			when = now.UTC().Format(time.RFC3339)
		}
		dates[fp] = when
	}
	p.TLSPinnedAt = dates
}

// recordPinInfo stores subject, issuer and validity of the pinned
// certificates found in chain (certificates a server presented), so the
// pin list can say which certificate a fingerprint is.
func recordPinInfo(p *models.ConnectionProfile, chain []models.CertificateInfo) {
	for _, c := range chain {
		fp, err := ldap.NormalizeFingerprint(c.SHA256)
		if err != nil || !slices.Contains(p.TLSPinnedCerts, fp) {
			continue
		}
		if p.TLSPinnedInfo == nil {
			p.TLSPinnedInfo = map[string]models.PinnedCertificateInfo{}
		}
		p.TLSPinnedInfo[fp] = pinInfoOf(c)
	}
}

// pinInfoOf is what a pin records of a certificate.
func pinInfoOf(c models.CertificateInfo) models.PinnedCertificateInfo {
	return models.PinnedCertificateInfo{Subject: c.Subject, Issuer: c.Issuer, NotBefore: c.NotBefore, NotAfter: c.NotAfter}
}

// maxPinInfoText caps each text of a stored pin description (it comes from
// the frontend form).
const maxPinInfoText = 1024

// prunePinInfo keys the pin descriptions by the canonical fingerprint, drops
// those of pins that were removed (and empty ones) and trims their texts.
func prunePinInfo(p *models.ConnectionProfile) {
	if len(p.TLSPinnedInfo) == 0 || len(p.TLSPinnedCerts) == 0 {
		p.TLSPinnedInfo = nil
		return
	}
	clip := func(v string) string {
		v = strings.TrimSpace(v)
		if len(v) > maxPinInfoText {
			v = v[:maxPinInfoText]
		}
		return v
	}
	out := make(map[string]models.PinnedCertificateInfo, len(p.TLSPinnedInfo))
	for k, info := range p.TLSPinnedInfo {
		fp, err := ldap.NormalizeFingerprint(k)
		if err != nil || !slices.Contains(p.TLSPinnedCerts, fp) {
			continue
		}
		info = models.PinnedCertificateInfo{Subject: clip(info.Subject), Issuer: clip(info.Issuer), NotBefore: clip(info.NotBefore), NotAfter: clip(info.NotAfter)}
		if info == (models.PinnedCertificateInfo{}) {
			continue
		}
		out[fp] = info
	}
	if len(out) == 0 {
		out = nil
	}
	p.TLSPinnedInfo = out
}

// exportProfile is the JSON form of a connection profile in an export file.
// It holds no secrets: exports never contain passwords.
type exportProfile struct {
	Name             string `json:"name"`
	Host             string `json:"host"`
	Port             int    `json:"port"`
	BaseDN           string `json:"baseDN"`
	AuthMethod       string `json:"authMethod"`
	BindDN           string `json:"bindDN"`
	TLSMode          string `json:"tlsMode"`
	TLSSkipVerify    bool   `json:"tlsSkipVerify"`
	PageSize         int    `json:"pageSize"`
	Timeout          int    `json:"timeout"`
	ReadOnly         bool   `json:"readOnly"`
	DisableReferrals bool   `json:"disableReferrals"`
	// AskPassword: the profile asks for the password on every connect.
	AskPassword bool `json:"askPassword,omitempty"`

	NTLMDomain        string                                  `json:"ntlmDomain,omitempty"`
	KrbCredSource     string                                  `json:"krbCredSource,omitempty"`
	KrbRealm          string                                  `json:"krbRealm,omitempty"`
	KrbKDC            string                                  `json:"krbKDC,omitempty"`
	KrbSPN            string                                  `json:"krbSPN,omitempty"`
	KrbCCache         string                                  `json:"krbCCache,omitempty"`
	TLSCACertFile     string                                  `json:"tlsCACertFile,omitempty"`
	TLSCACertPEM      string                                  `json:"tlsCACertPEM,omitempty"`
	TLSClientCertFile string                                  `json:"tlsClientCertFile,omitempty"`
	TLSClientKeyFile  string                                  `json:"tlsClientKeyFile,omitempty"`
	TLSPinnedCerts    []string                                `json:"tlsPinnedCerts,omitempty"`
	TLSPinnedAt       map[string]string                       `json:"tlsPinnedAt,omitempty"`
	TLSPinnedInfo     map[string]models.PinnedCertificateInfo `json:"tlsPinnedInfo,omitempty"`
	PasswordPolicy    string                                  `json:"passwordPolicy,omitempty"`
	PasswordScheme    string                                  `json:"passwordScheme,omitempty"`

	// Password is only read: files exported by older LDAPilot versions
	// contained plaintext passwords. It is never written.
	Password string `json:"password,omitempty"`
}

// exportProfiles converts profiles to their export form without secrets.
func exportProfiles(profiles []models.ConnectionProfile) []exportProfile {
	out := make([]exportProfile, 0, len(profiles))
	for _, p := range profiles {
		out = append(out, exportProfile{
			Name:              p.Name,
			Host:              p.Host,
			Port:              p.Port,
			BaseDN:            p.BaseDN,
			AuthMethod:        string(p.AuthMethod),
			BindDN:            p.BindDN,
			TLSMode:           string(p.TLSMode),
			TLSSkipVerify:     p.TLSSkipVerify,
			PageSize:          p.PageSize,
			Timeout:           p.Timeout,
			ReadOnly:          p.ReadOnly,
			DisableReferrals:  p.DisableReferrals,
			AskPassword:       p.AskPassword,
			NTLMDomain:        p.NTLMDomain,
			KrbCredSource:     p.KrbCredSource,
			KrbRealm:          p.KrbRealm,
			KrbKDC:            p.KrbKDC,
			KrbSPN:            p.KrbSPN,
			KrbCCache:         p.KrbCCache,
			TLSCACertFile:     p.TLSCACertFile,
			TLSCACertPEM:      p.TLSCACertPEM,
			TLSClientCertFile: p.TLSClientCertFile,
			TLSClientKeyFile:  p.TLSClientKeyFile,
			TLSPinnedCerts:    slices.Clone(p.TLSPinnedCerts),
			TLSPinnedAt:       maps.Clone(p.TLSPinnedAt),
			TLSPinnedInfo:     maps.Clone(p.TLSPinnedInfo),
			PasswordPolicy:    p.PasswordPolicy,
			PasswordScheme:    p.PasswordScheme,
		})
	}
	return out
}

// importProfile converts an exported profile back, applying the defaults of
// a new profile.
func importProfile(imp exportProfile) models.ConnectionProfile {
	p := models.ConnectionProfile{
		Name:              imp.Name,
		Host:              imp.Host,
		Port:              imp.Port,
		BaseDN:            imp.BaseDN,
		AuthMethod:        models.AuthMethod(imp.AuthMethod),
		BindDN:            imp.BindDN,
		Password:          imp.Password,
		TLSMode:           models.TLSMode(imp.TLSMode),
		TLSSkipVerify:     imp.TLSSkipVerify,
		PageSize:          imp.PageSize,
		Timeout:           imp.Timeout,
		ReadOnly:          imp.ReadOnly,
		DisableReferrals:  imp.DisableReferrals,
		AskPassword:       imp.AskPassword,
		NTLMDomain:        imp.NTLMDomain,
		KrbCredSource:     imp.KrbCredSource,
		KrbRealm:          imp.KrbRealm,
		KrbKDC:            imp.KrbKDC,
		KrbSPN:            imp.KrbSPN,
		KrbCCache:         imp.KrbCCache,
		TLSCACertFile:     imp.TLSCACertFile,
		TLSCACertPEM:      imp.TLSCACertPEM,
		TLSClientCertFile: imp.TLSClientCertFile,
		TLSClientKeyFile:  imp.TLSClientKeyFile,
		TLSPinnedCerts:    slices.Clone(imp.TLSPinnedCerts),
		TLSPinnedAt:       maps.Clone(imp.TLSPinnedAt),
		TLSPinnedInfo:     maps.Clone(imp.TLSPinnedInfo),
		PasswordPolicy:    imp.PasswordPolicy,
		PasswordScheme:    imp.PasswordScheme,
	}
	if normalizePasswordPolicySettings(&p) != nil {
		p.PasswordPolicy, p.PasswordScheme = "", "" // unknown setting: auto
	}
	if p.Port == 0 {
		p.Port = 389
	}
	clampProfileSettings(&p)
	if p.AuthMethod == "" {
		p.AuthMethod = models.AuthSimple
	}
	if p.TLSMode == "" {
		p.TLSMode = models.TLSNone
	}
	return p
}
