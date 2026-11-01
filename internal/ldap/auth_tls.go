package ldap

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// certErrorPrefix starts the message of every CertificateError; the
// frontend recognises certificate failures of Connect by it.
const certErrorPrefix = "untrusted TLS certificate"

// CertificateError is returned when the TLS certificate of the server is not
// trusted: its chain does not lead to a trusted root (system roots plus the
// profile's CA certificates), it is not valid for the host name or not valid
// at the current time, and its fingerprint is not pinned in the profile.
// Problem carries the presented chain so the user can inspect and pin it.
type CertificateError struct {
	Problem models.CertificateProblem
}

func (e *CertificateError) Error() string {
	return fmt.Sprintf("%s for %s: %s", certErrorPrefix, e.Problem.Host, e.Problem.Reason)
}

// AuthConfigError reports invalid authentication or TLS settings in a
// profile (missing realm, unreadable CA file, ...), detected before or
// while connecting.
type AuthConfigError struct {
	Msg string
}

func (e *AuthConfigError) Error() string { return e.Msg }

func configErrorf(format string, args ...any) error {
	return &AuthConfigError{Msg: fmt.Sprintf(format, args...)}
}

// tlsTrust is the parsed TLS trust configuration of a profile.
type tlsTrust struct {
	roots      *x509.CertPool      // nil: system roots only
	custom     []*x509.Certificate // CA certificates from the profile
	pins       map[string]bool     // canonical SHA-256 fingerprints
	skip       bool
	clientCert *tls.Certificate
}

// tlsOutcome records the server certificate verification of one handshake.
type tlsOutcome struct {
	verification    string // models.TLSVerify*
	certErr         *CertificateError
	peer            []*x509.Certificate
	clientRequested bool // the server asked for a client certificate
	hasClientCert   bool
}

// expandHome replaces a leading "~/" with the user's home directory.
func expandHome(path string) string {
	path = strings.TrimSpace(path)
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, path[2:])
		}
	}
	return path
}

// ParseCertificates parses all certificates in data: PEM ("CERTIFICATE"
// blocks, other blocks are ignored) or, if data contains no PEM block, DER.
func ParseCertificates(data []byte) ([]*x509.Certificate, error) {
	var certs []*x509.Certificate
	rest := data
	sawPEM := false
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		sawPEM = true
		if block.Type != "CERTIFICATE" {
			continue
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("invalid certificate: %v", err)
		}
		certs = append(certs, cert)
	}
	if !sawPEM && len(bytes.TrimSpace(data)) > 0 {
		der, err := x509.ParseCertificates(data)
		if err != nil {
			return nil, errors.New("no PEM certificate found and not a DER certificate")
		}
		certs = der
	}
	if len(certs) == 0 {
		return nil, errors.New("no certificate found")
	}
	return certs, nil
}

// profileCACertificates returns the CA certificates configured in profile
// (file and pasted PEM).
func profileCACertificates(profile models.ConnectionProfile) ([]*x509.Certificate, error) {
	var certs []*x509.Certificate
	if path := expandHome(profile.TLSCACertFile); path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, configErrorf("CA certificate file: %v", err)
		}
		c, err := ParseCertificates(data)
		if err != nil {
			return nil, configErrorf("CA certificate file %s: %v", path, err)
		}
		certs = append(certs, c...)
	}
	if text := strings.TrimSpace(profile.TLSCACertPEM); text != "" {
		c, err := ParseCertificates([]byte(text))
		if err != nil {
			return nil, configErrorf("CA certificate (PEM): %v", err)
		}
		certs = append(certs, c...)
	}
	return certs, nil
}

// loadTLSTrust parses the TLS trust settings of profile.
func loadTLSTrust(profile models.ConnectionProfile) (*tlsTrust, error) {
	trust := &tlsTrust{skip: profile.TLSSkipVerify, pins: map[string]bool{}}

	custom, err := profileCACertificates(profile)
	if err != nil {
		return nil, err
	}
	if len(custom) > 0 {
		pool, perr := x509.SystemCertPool()
		if perr != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		for _, c := range custom {
			pool.AddCert(c)
		}
		trust.roots = pool
		trust.custom = custom
	}

	for _, fp := range profile.TLSPinnedCerts {
		norm, err := NormalizeFingerprint(fp)
		if err != nil {
			return nil, configErrorf("pinned certificate %q: %v", fp, err)
		}
		trust.pins[norm] = true
	}

	certFile, keyFile := expandHome(profile.TLSClientCertFile), expandHome(profile.TLSClientKeyFile)
	switch {
	case certFile != "" && keyFile != "":
		cert, err := tls.LoadX509KeyPair(certFile, keyFile)
		if err != nil {
			return nil, configErrorf("client certificate: %v", err)
		}
		trust.clientCert = &cert
	case certFile != "" || keyFile != "":
		return nil, configErrorf("client certificate: both the certificate and the key file are required")
	}
	return trust, nil
}

// buildTLSConfig returns the TLS configuration for a connection to
// serverName with the trust settings of profile, and the outcome record the
// handshake fills in.
//
// Go's built-in verification is replaced by verifyServerCertificates (run in
// VerifyConnection): it does the same chain and host name checks, but also
// accepts pinned certificates and records the presented chain, so a failure
// can be shown to the user (CertificateError).
func buildTLSConfig(profile models.ConnectionProfile, serverName string) (*tls.Config, *tlsOutcome, error) {
	trust, err := loadTLSTrust(profile)
	if err != nil {
		return nil, nil, err
	}
	out := &tlsOutcome{hasClientCert: trust.clientCert != nil}
	host := normalizeHost(serverName)
	cfg := &tls.Config{
		ServerName: host,
		// Verification is done by VerifyConnection below.
		InsecureSkipVerify: true, //nolint:gosec
		VerifyConnection: func(cs tls.ConnectionState) error {
			out.peer = cs.PeerCertificates
			mode, cerr := verifyServerCertificates(cs.PeerCertificates, host, trust, time.Now())
			if cerr != nil {
				out.certErr = cerr
				return cerr
			}
			out.verification = mode
			return nil
		},
	}
	if trust.clientCert != nil {
		cert := trust.clientCert
		// Always offer the configured certificate when asked; the server
		// decides whether it is acceptable.
		cfg.GetClientCertificate = func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
			out.clientRequested = true
			return cert, nil
		}
	}
	return cfg, out, nil
}

// verifyServerCertificates checks the chain certs (leaf first) presented by
// serverName. It returns the verification mode on success.
func verifyServerCertificates(certs []*x509.Certificate, serverName string, trust *tlsTrust, now time.Time) (string, *CertificateError) {
	if trust.skip {
		return models.TLSVerifySkipped, nil
	}
	if len(certs) == 0 {
		return "", &CertificateError{Problem: models.CertificateProblem{
			Host: serverName, Kind: models.CertProblemInvalid,
			Reason: "the server sent no certificate", Issues: []string{"the server sent no certificate"},
		}}
	}
	leaf := certs[0]
	if trust.pins[CertificateFingerprint(leaf)] {
		return models.TLSVerifyPinned, nil
	}
	opts := x509.VerifyOptions{
		Roots:         trust.roots,
		Intermediates: x509.NewCertPool(),
		DNSName:       serverName,
		CurrentTime:   now,
	}
	for _, c := range certs[1:] {
		opts.Intermediates.AddCert(c)
	}
	chains, err := leaf.Verify(opts)
	if err == nil {
		if len(chains) > 0 && len(chains[0]) > 0 {
			root := chains[0][len(chains[0])-1]
			for _, c := range trust.custom {
				if c.Equal(root) {
					return models.TLSVerifyCustomCA, nil
				}
			}
		}
		return models.TLSVerifySystem, nil
	}
	return "", newCertificateError(certs, serverName, opts, err)
}

// newCertificateError analyses why certs failed verification with opts
// (verr) and lists every problem: authority, host name and validity periods.
func newCertificateError(certs []*x509.Certificate, serverName string, opts x509.VerifyOptions, verr error) *CertificateError {
	leaf := certs[0]
	now := opts.CurrentTime
	p := models.CertificateProblem{Host: serverName, Reason: verr.Error()}
	for _, c := range certs {
		p.Chain = append(p.Chain, CertificateInfoOf(c))
	}

	// Trust: x509 checks validity periods before the issuer, so the chain is
	// checked (without host name) at a time when all presented certificates
	// are valid, if there is one; an expired chain is reported separately.
	var authority string
	chainOpts := opts
	chainOpts.DNSName = ""
	chainOpts.CurrentTime = chainCheckTime(certs, now)
	_, err := leaf.Verify(chainOpts)
	var inv x509.CertificateInvalidError
	if errors.As(err, &inv) && inv.Reason == x509.Expired && len(certs) > 1 {
		// No time at which the whole chain is valid (e.g. a leaf issued
		// after its CA expired): check the top of the chain on its own.
		top := certs[len(certs)-1]
		topOpts := chainOpts
		topOpts.Intermediates = x509.NewCertPool()
		topOpts.CurrentTime = top.NotBefore.Add(top.NotAfter.Sub(top.NotBefore) / 2)
		if _, terr := top.Verify(topOpts); terr != nil {
			err = terr
		}
	}
	if err != nil {
		var ua x509.UnknownAuthorityError
		switch {
		case errors.As(err, &ua):
			last := certs[len(certs)-1]
			switch {
			case len(certs) == 1 && isSelfSigned(leaf):
				authority = "the certificate is self-signed and not trusted"
			case isSelfSigned(last):
				authority = fmt.Sprintf("the certificate is issued by %q, which is not a trusted CA", commonName(last))
			default:
				issuer := leaf.Issuer.CommonName
				if issuer == "" {
					issuer = leaf.Issuer.String()
				}
				authority = fmt.Sprintf("the certificate is issued by %q, which is not trusted", issuer)
			}
		case errors.As(err, &inv) && inv.Reason == x509.Expired:
			// Covered by the validity checks below.
		default:
			authority = err.Error()
		}
	}

	var hostname string
	if serverName != "" {
		if err := leaf.VerifyHostname(serverName); err != nil {
			names := append([]string{}, leaf.DNSNames...)
			for _, ip := range leaf.IPAddresses {
				names = append(names, ip.String())
			}
			if len(names) == 0 && leaf.Subject.CommonName != "" {
				names = append(names, leaf.Subject.CommonName+" (CN only)")
			}
			hostname = fmt.Sprintf("the certificate is not valid for %s (valid for: %s)", serverName, strings.Join(names, ", "))
		}
	}

	var validity []string
	leafExpired, leafNotYet := now.After(leaf.NotAfter), now.Before(leaf.NotBefore)
	for i, c := range certs {
		what := "the certificate"
		if i > 0 {
			what = fmt.Sprintf("the CA certificate %q", commonName(c))
		}
		switch {
		case now.After(c.NotAfter):
			validity = append(validity, what+" expired on "+c.NotAfter.UTC().Format("2006-01-02"))
		case now.Before(c.NotBefore):
			validity = append(validity, what+" is not valid before "+c.NotBefore.UTC().Format("2006-01-02"))
		}
	}

	if authority != "" {
		p.Issues = append(p.Issues, authority)
	}
	if hostname != "" {
		p.Issues = append(p.Issues, hostname)
	}
	p.Issues = append(p.Issues, validity...)
	switch {
	case authority != "":
		p.Kind = models.CertProblemUnknownAuthority
	case hostname != "":
		p.Kind = models.CertProblemHostname
	case leafNotYet:
		p.Kind = models.CertProblemNotYetValid
	case leafExpired || len(validity) > 0:
		p.Kind = models.CertProblemExpired
	default:
		p.Kind = models.CertProblemInvalid
	}
	if len(p.Issues) == 0 {
		p.Issues = append(p.Issues, verr.Error())
	}
	return &CertificateError{Problem: p}
}

// chainCheckTime returns now if all certs are valid at that time, else the
// middle of the period in which all of them are valid, else the middle of
// the leaf's validity period.
func chainCheckTime(certs []*x509.Certificate, now time.Time) time.Time {
	lo, hi := certs[0].NotBefore, certs[0].NotAfter
	for _, c := range certs[1:] {
		if c.NotBefore.After(lo) {
			lo = c.NotBefore
		}
		if c.NotAfter.Before(hi) {
			hi = c.NotAfter
		}
	}
	if !now.Before(lo) && !now.After(hi) {
		return now
	}
	if lo.Before(hi) {
		return lo.Add(hi.Sub(lo) / 2)
	}
	return certs[0].NotBefore.Add(certs[0].NotAfter.Sub(certs[0].NotBefore) / 2)
}

// commonName returns the subject CN of cert, or its full subject.
func commonName(cert *x509.Certificate) string {
	if cert.Subject.CommonName != "" {
		return cert.Subject.CommonName
	}
	return cert.Subject.String()
}

// isSelfSigned reports whether cert is signed by its own key. (Unlike
// CheckSignatureFrom this does not require the CA flag, which self-signed
// server certificates often lack.)
func isSelfSigned(cert *x509.Certificate) bool {
	return bytes.Equal(cert.RawIssuer, cert.RawSubject) &&
		cert.CheckSignature(cert.SignatureAlgorithm, cert.RawTBSCertificate, cert.Signature) == nil
}

// CertificateFingerprint returns the SHA-256 fingerprint of cert in the
// canonical form: uppercase hex pairs separated by colons.
func CertificateFingerprint(cert *x509.Certificate) string {
	sum := sha256.Sum256(cert.Raw)
	return formatFingerprint(sum[:])
}

func formatFingerprint(sum []byte) string {
	h := strings.ToUpper(hex.EncodeToString(sum))
	var b strings.Builder
	for i := 0; i < len(h); i += 2 {
		if i > 0 {
			b.WriteByte(':')
		}
		b.WriteString(h[i : i+2])
	}
	return b.String()
}

// NormalizeFingerprint converts a SHA-256 fingerprint in any common notation
// (with or without colons or spaces, any case, optional "SHA256:" or
// "sha256 Fingerprint=" prefix as printed by openssl) to the canonical form.
func NormalizeFingerprint(s string) (string, error) {
	s = strings.TrimSpace(s)
	if i := strings.LastIndex(s, "="); i >= 0 {
		s = s[i+1:]
	}
	lower := strings.ToLower(s)
	for _, prefix := range []string{"sha256:", "sha-256:", "sha256 "} {
		if strings.HasPrefix(lower, prefix) {
			s = s[len(prefix):]
			break
		}
	}
	s = strings.NewReplacer(":", "", " ", "", "-", "").Replace(s)
	raw, err := hex.DecodeString(s)
	if err != nil || len(raw) != sha256.Size {
		return "", errors.New("not a SHA-256 fingerprint (64 hex digits)")
	}
	return formatFingerprint(raw), nil
}

// CertificateInfoOf describes cert for the UI. Subject and issuer are
// rendered from the raw DER names like the certificate viewer does
// (certDistinguishedName: RFC 4514 order, DC= instead of the OID hex that
// pkix.Name.String() prints for AD CS issued names).
func CertificateInfoOf(cert *x509.Certificate) models.CertificateInfo {
	info := models.CertificateInfo{
		Subject:            certDistinguishedName(cert.RawSubject, cert.Subject),
		Issuer:             certDistinguishedName(cert.RawIssuer, cert.Issuer),
		SerialNumber:       strings.ToUpper(cert.SerialNumber.Text(16)),
		DNSNames:           append([]string{}, cert.DNSNames...),
		IPAddresses:        []string{},
		NotBefore:          cert.NotBefore.UTC().Format(time.RFC3339),
		NotAfter:           cert.NotAfter.UTC().Format(time.RFC3339),
		IsCA:               cert.IsCA,
		SelfSigned:         isSelfSigned(cert),
		KeyAlgorithm:       keyDescription(cert),
		SignatureAlgorithm: cert.SignatureAlgorithm.String(),
		SHA256:             CertificateFingerprint(cert),
		PEM:                string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw})),
	}
	for _, ip := range cert.IPAddresses {
		info.IPAddresses = append(info.IPAddresses, ip.String())
	}
	return info
}

// keyDescription names the public key type and size, e.g. "RSA 2048".
func keyDescription(cert *x509.Certificate) string {
	switch k := cert.PublicKey.(type) {
	case *rsa.PublicKey:
		return fmt.Sprintf("RSA %d", k.N.BitLen())
	case *ecdsa.PublicKey:
		return "ECDSA " + k.Curve.Params().Name
	case ed25519.PublicKey:
		return "Ed25519"
	}
	return cert.PublicKeyAlgorithm.String()
}

// DescribeCACertificates parses the CA certificates of a profile's
// TLSCACertFile and TLSCACertPEM for display; it returns an error naming
// the field that cannot be read.
func DescribeCACertificates(file, pemText string) ([]models.CertificateInfo, error) {
	certs, err := profileCACertificates(models.ConnectionProfile{TLSCACertFile: file, TLSCACertPEM: pemText})
	if err != nil {
		return nil, err
	}
	infos := make([]models.CertificateInfo, 0, len(certs))
	for _, c := range certs {
		infos = append(infos, CertificateInfoOf(c))
	}
	return infos, nil
}

// clientCertRejection returns a clearer error for err if the server asked
// for the configured client certificate and then aborted the TLS session
// with an alert (it does not accept the certificate), or nil.
func clientCertRejection(err error, out *tlsOutcome) error {
	if err == nil || out == nil || !out.hasClientCert || !out.clientRequested {
		return nil
	}
	msg := err.Error()
	i := strings.Index(msg, "remote error: tls: ")
	if i < 0 {
		return nil
	}
	return fmt.Errorf("the server rejected the TLS client certificate (%s): %w", msg[i+len("remote error: "):], err)
}

// tlsVersionName returns a readable TLS version, e.g. "TLS 1.3".
func tlsVersionName(v uint16) string {
	switch v {
	case tls.VersionTLS10:
		return "TLS 1.0"
	case tls.VersionTLS11:
		return "TLS 1.1"
	case tls.VersionTLS12:
		return "TLS 1.2"
	case tls.VersionTLS13:
		return "TLS 1.3"
	}
	return fmt.Sprintf("0x%04x", v)
}
