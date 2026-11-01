package ldap

import (
	"errors"
	"fmt"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// bindConn authenticates conn, connected to the profile's own server, with
// the method and credentials of profile.
func bindConn(conn *goldap.Conn, profile models.ConnectionProfile) error {
	_, err := bindConnHost(conn, profile, profile.Host)
	return err
}

// bindConnHost authenticates conn, which is connected to host (the profile
// host or a referral server), with the method and credentials of profile. It
// returns a description of the bind for logs and the UI that never contains
// secrets. The main connection, the temporary paging connections and
// referral connections all bind through it.
func bindConnHost(conn *goldap.Conn, profile models.ConnectionProfile, host string) (string, error) {
	if summary, ok := takePreBound(conn); ok {
		return summary, nil
	}
	switch profile.AuthMethod {
	case "":
		return "no bind (anonymous)", nil
	case models.AuthNone:
		return "anonymous bind", conn.UnauthenticatedBind("")
	case models.AuthSimple:
		return "simple bind as " + profile.BindDN, conn.Bind(profile.BindDN, profile.Password)
	case models.AuthNTLM:
		domain, user := ntlmCredentials(profile.BindDN, profile.NTLMDomain)
		summary := "NTLM as " + user
		if user == "" {
			return "NTLM", configErrorf("NTLM: a user name is required (DOMAIN\\user, user@domain or user with a domain)")
		}
		if profile.Password == "" {
			return summary, configErrorf("NTLM: a password is required for %s", user)
		}
		return summary, conn.NTLMBind(domain, user, profile.Password)
	case models.AuthKerberos:
		return kerberosBind(conn, profile, host)
	case models.AuthExternal:
		summary := "SASL EXTERNAL"
		if profile.TLSClientCertFile != "" {
			summary += " with client certificate " + profile.TLSClientCertFile
		}
		if _, ok := conn.TLSConnectionState(); !ok {
			return summary, configErrorf("SASL EXTERNAL needs a TLS connection (LDAPS or StartTLS) with a client certificate")
		}
		return summary, conn.ExternalBind()
	}
	return string(profile.AuthMethod), configErrorf("unsupported authentication method %q", profile.AuthMethod)
}

// ntlmCredentials returns the domain announced in the NTLM negotiate message
// and the user name for the authenticate message. go-ntlmssp takes the
// authentication domain from the user name only (DOMAIN\user, or a UPN
// user@domain with an empty domain), so a separate domain is prepended.
func ntlmCredentials(username, domain string) (negotiateDomain, user string) {
	username = strings.TrimSpace(username)
	domain = strings.TrimSpace(domain)
	switch {
	case username == "":
		return "", ""
	case strings.Contains(username, `\`):
		d, u, _ := strings.Cut(username, `\`)
		return d, d + `\` + u
	case strings.Contains(username, "@"):
		return "", username
	case domain != "":
		return domain, domain + `\` + username
	}
	return "", username
}

// AuthSummary describes how profile authenticates, without secrets, e.g.
// "Kerberos (GSSAPI) as alice@EXAMPLE.COM, SPN ldap/dc1.example.com".
func AuthSummary(profile models.ConnectionProfile) string {
	return authSummaryHost(profile, profile.Host)
}

// authSummaryHost is AuthSummary for a bind to host (the Kerberos SPN
// depends on the server).
func authSummaryHost(profile models.ConnectionProfile, host string) string {
	switch profile.AuthMethod {
	case models.AuthNone, "":
		return "anonymous"
	case models.AuthSimple:
		return "simple bind as " + profile.BindDN
	case models.AuthNTLM:
		_, user := ntlmCredentials(profile.BindDN, profile.NTLMDomain)
		return "NTLM as " + user
	case models.AuthKerberos:
		spn := kerberosSPN(profile, host)
		if profile.KrbCredSource == models.KrbCredSystem {
			if SSPIAvailable {
				return "Kerberos (GSSAPI) as the logged-on Windows user, SPN " + spn
			}
			return "Kerberos (GSSAPI) with the ticket cache, SPN " + spn
		}
		if user, realm, err := kerberosPrincipal(profile); err == nil {
			return "Kerberos (GSSAPI) as " + user + "@" + realm + ", SPN " + spn
		}
		return "Kerberos (GSSAPI), SPN " + spn
	case models.AuthExternal:
		return "SASL EXTERNAL (client certificate)"
	}
	return string(profile.AuthMethod)
}

// AuthIdentity returns the identity a profile binds as, for audit records:
// the bind DN, the NTLM user, the Kerberos principal, or a placeholder for
// identities only the server knows (ticket cache, Windows logon, client
// certificate). It is empty for anonymous profiles.
func AuthIdentity(profile models.ConnectionProfile) string {
	switch profile.AuthMethod {
	case models.AuthSimple:
		return profile.BindDN
	case models.AuthNTLM:
		_, user := ntlmCredentials(profile.BindDN, profile.NTLMDomain)
		return user
	case models.AuthKerberos:
		if profile.KrbCredSource == models.KrbCredSystem {
			if SSPIAvailable {
				return "(Kerberos: Windows logon)"
			}
			return "(Kerberos: ticket cache)"
		}
		if user, realm, err := kerberosPrincipal(profile); err == nil {
			return user + "@" + realm
		}
		return profile.BindDN
	case models.AuthExternal:
		return "(client certificate)"
	}
	return profile.BindDN
}

// bindFailure wraps a failed bind as ErrBindFailed with the server's detail
// and the bind summary. A known Active Directory sub-status ("data 775") is
// explained at the end ("— the account is locked out (AD code 775)").
func bindFailure(err error, summary string) error {
	var cfgErr *AuthConfigError
	if errors.As(err, &cfgErr) {
		return fmt.Errorf("%w: %w", ErrBindFailed, cfgErr)
	}
	detail := ldapErrorDetail(err)
	if hint := bindHintFromText(detail); hint != "" {
		return fmt.Errorf("%w: %s (%s) — %s", ErrBindFailed, detail, summary, hint)
	}
	return fmt.Errorf("%w: %s (%s)", ErrBindFailed, detail, summary)
}

// withoutCredentials returns profile reduced to an anonymous bind without a
// client certificate, for servers that must not receive the credentials
// (see referralCredentialsAllowed).
func withoutCredentials(profile models.ConnectionProfile) models.ConnectionProfile {
	profile.AuthMethod = models.AuthNone
	profile.BindDN, profile.Password, profile.NTLMDomain = "", "", ""
	profile.KrbCredSource, profile.KrbCCache = "", ""
	profile.TLSClientCertFile, profile.TLSClientKeyFile = "", ""
	return profile
}
