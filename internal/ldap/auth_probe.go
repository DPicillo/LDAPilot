package ldap

import (
	"crypto/tls"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// TestProfile connects and binds exactly like Connect, asks the server who
// the connection is bound as, closes the connection and reports which
// authentication method and TLS mode were used, how the server certificate
// was verified and, if it was not trusted, the certificate chain the server
// presented.
func TestProfile(profile models.ConnectionProfile) models.ConnectionTestResult {
	start := time.Now()
	if profile.TLSMode == "" {
		profile.TLSMode = models.TLSNone
	}
	res := models.ConnectionTestResult{
		AuthMethod: profile.AuthMethod,
		TLSMode:    profile.TLSMode,
	}
	client := NewClient(profile)
	conn, info, err := client.dialDetailed()
	res.DurationMs = time.Since(start).Milliseconds()
	if info != nil {
		res.AuthSummary = info.authSummary
		if info.tls != nil {
			res.TLSVerification = info.tls.verification
			for _, c := range info.tls.peer {
				res.ServerCertificates = append(res.ServerCertificates, CertificateInfoOf(c))
			}
		}
	}
	if err != nil {
		res.Error = err.Error()
		if info != nil {
			res.Stage = info.stage
		}
		var certErr *CertificateError
		if errors.As(err, &certErr) {
			p := certErr.Problem
			res.CertProblem = &p
		}
		if res.Stage == "bind" && profile.AuthMethod == models.AuthKerberos {
			// A wrong SPN is the usual reason when the host is an IP address
			// or alias: the server's own name suggests the right one.
			if host, perr := ProbeDNSHostName(profile); perr == nil {
				res.DNSHostName = host
			}
		}
		return res
	}
	defer conn.Close()

	if state, ok := conn.TLSConnectionState(); ok {
		res.TLSVersion = tlsVersionName(state.Version)
		res.TLSCipherSuite = tls.CipherSuiteName(state.CipherSuite)
	}
	if who, err := conn.WhoAmI(nil); err == nil && who != nil {
		res.BoundAs = who.AuthzID
	}
	// What the server offers: type and naming contexts ("Use as base DN").
	if info := probeServerInfo(conn); info != nil {
		res.ServerType = info.ServerType
		res.VendorName = info.VendorName
		res.VendorVersion = info.VendorVersion
		res.NamingContexts = info.NamingContexts
		res.DefaultNamingContext = info.DefaultNamingContext
		res.DNSHostName = strings.ToLower(strings.TrimSpace(info.DNSHostName))
	}
	res.Warnings = securityWarnings(profile, info.tls, time.Now())
	res.Success = true
	res.DurationMs = time.Since(start).Milliseconds()
	return res
}

// securityWarnings lists the weaknesses of a working connection made with
// profile; out is its TLS outcome (nil without TLS).
func securityWarnings(profile models.ConnectionProfile, out *tlsOutcome, now time.Time) []string {
	var w []string
	plain := profile.TLSMode == models.TLSNone || profile.TLSMode == ""
	if !plain && profile.TLSSkipVerify {
		w = append(w, "Certificate verification is disabled: anyone between you and the server can intercept the connection. Trust (pin) the certificate or configure its CA instead.")
	}
	if out != nil && out.verification == models.TLSVerifyPinned && len(out.peer) > 0 {
		leaf := out.peer[0]
		if now.After(leaf.NotAfter) {
			w = append(w, "The pinned server certificate expired on "+leaf.NotAfter.UTC().Format("2006-01-02")+"; the pin must be renewed when the server gets a new certificate.")
		}
	}
	if out != nil && out.hasClientCert && !out.clientRequested {
		w = append(w, "The server did not ask for the client certificate, so it was not sent.")
	}
	if plain {
		switch profile.AuthMethod {
		case models.AuthSimple:
			w = append(w, "The password is sent unencrypted (no TLS). Use LDAPS or StartTLS.")
		case models.AuthNTLM:
			w = append(w, "NTLM without TLS: LDAPilot does not negotiate NTLM signing/sealing, so the session is unprotected. Use LDAPS or StartTLS.")
		case models.AuthKerberos:
			w = append(w, "Kerberos (GSSAPI) here authenticates only; LDAPilot does not negotiate signing/sealing, so the traffic is unencrypted. Domain controllers requiring LDAP signing reject this bind; use LDAPS or StartTLS.")
		}
	}
	return w
}

// probeServerInfo reads the RootDSE capabilities on a freshly bound test
// connection; nil when the server refuses the read (the test still passes).
func probeServerInfo(conn *goldap.Conn) *models.ServerInfo {
	req := goldap.NewSearchRequest("", goldap.ScopeBaseObject, goldap.NeverDerefAliases, 0, 0, false,
		"(objectClass=*)", rootDSECapabilityAttrs, nil)
	result, err := conn.Search(req)
	if err != nil || len(result.Entries) == 0 {
		return nil
	}
	return serverInfoFromRootDSE(result.Entries[0])
}

// maxProbeTimeout caps the timeout of ProbeDNSHostName (seconds).
const maxProbeTimeout = 10

// ErrNoDNSHostName is returned by ProbeDNSHostName when the server's RootDSE
// has no dnsHostName (servers other than Active Directory / Samba DCs).
var ErrNoDNSHostName = errors.New("the server's RootDSE names no dnsHostName (only Active Directory and Samba domain controllers announce it)")

// ProbeDNSHostName reads the server's own DNS name (RootDSE dnsHostName,
// lowercase) with an anonymous bind over the transport of profile, so a
// Kerberos SPN (ldap/<dnsHostName>) can be suggested for a profile that
// dials an IP address or alias. No credentials are sent. The certificate
// is not verified for this read (the dialog asks before it is trusted, and
// the name is only a suggestion the Kerberos bind itself checks); a client
// certificate of the profile is still offered.
func ProbeDNSHostName(profile models.ConnectionProfile) (string, error) {
	p := withoutCredentials(profile)
	p.AuthMethod = "" // no bind at all: the RootDSE is readable before one
	p.TLSClientCertFile, p.TLSClientKeyFile = profile.TLSClientCertFile, profile.TLSClientKeyFile
	p.TLSSkipVerify = true
	if p.TLSMode == "" {
		p.TLSMode = models.TLSNone
	}
	if p.Timeout <= 0 || p.Timeout > maxProbeTimeout {
		p.Timeout = maxProbeTimeout
	}
	conn, _, err := NewClient(p).dialDetailed()
	if err != nil {
		return "", err
	}
	defer conn.Close()
	req := goldap.NewSearchRequest("", goldap.ScopeBaseObject, goldap.NeverDerefAliases, 1, p.Timeout, false,
		"(objectClass=*)", []string{"dnsHostName"}, nil)
	result, err := conn.Search(req)
	if err != nil {
		return "", fmt.Errorf("reading the RootDSE failed: %w", err)
	}
	if len(result.Entries) == 0 {
		return "", ErrNoDNSHostName
	}
	host := strings.ToLower(strings.TrimSpace(result.Entries[0].GetEqualFoldAttributeValue("dnsHostName")))
	if host == "" {
		return "", ErrNoDNSHostName
	}
	return host, nil
}

// ErrProbeNoTLS is returned by ProbeServerCertificates for a profile
// without TLS (there is no certificate to read).
var ErrProbeNoTLS = errors.New("the connection does not use TLS, so the server presents no certificate")

// ProbeServerCertificates returns the certificate chain the server of
// profile presents (leaf first), read over its TLS mode without a bind: the
// connection dialog refreshes the details of pinned certificates from it.
// The chain is not verified (it is only described); no credentials are sent,
// a client certificate of the profile is still offered.
func ProbeServerCertificates(profile models.ConnectionProfile) ([]models.CertificateInfo, error) {
	if profile.TLSMode == "" || profile.TLSMode == models.TLSNone {
		return nil, ErrProbeNoTLS
	}
	p := withoutCredentials(profile)
	p.AuthMethod = ""
	p.TLSClientCertFile, p.TLSClientKeyFile = profile.TLSClientCertFile, profile.TLSClientKeyFile
	p.TLSSkipVerify = true
	if p.Timeout <= 0 || p.Timeout > maxProbeTimeout {
		p.Timeout = maxProbeTimeout
	}
	conn, info, err := NewClient(p).dialDetailed()
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	var out []models.CertificateInfo
	if info != nil && info.tls != nil {
		for _, c := range info.tls.peer {
			out = append(out, CertificateInfoOf(c))
		}
	}
	if len(out) == 0 {
		return nil, errors.New("the server presented no certificate")
	}
	return out, nil
}
