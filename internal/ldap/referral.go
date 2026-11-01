package ldap

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
	"golang.org/x/net/publicsuffix"
)

// referralTarget is a parsed LDAP referral URL.
type referralTarget struct {
	scheme string // "ldap" or "ldaps"
	host   string
	port   string // explicit port or the scheme's default
	baseDN string // DN from the URL path; empty if the URL names none
}

// parseReferralURL parses an LDAP referral URL and extracts scheme, host, port, and base DN.
// LDAP URL format: ldap://host[:port]/baseDN[?attrs?scope?filter?extensions]
func parseReferralURL(ref string) (referralTarget, error) {
	// Trim whitespace
	ref = strings.TrimSpace(ref)

	// Handle both ldap:// and ldaps://
	if !strings.HasPrefix(ref, "ldap://") && !strings.HasPrefix(ref, "ldaps://") {
		return referralTarget{}, fmt.Errorf("invalid referral URL scheme: %s", ref)
	}

	u, err := url.Parse(ref)
	if err != nil {
		return referralTarget{}, fmt.Errorf("invalid referral URL: %w", err)
	}

	t := referralTarget{scheme: u.Scheme, host: u.Hostname(), port: u.Port()}
	if t.port == "" {
		if u.Scheme == "ldaps" {
			t.port = "636"
		} else {
			t.port = "389"
		}
	}

	// The base DN is the URL path without the leading slash; url.Parse
	// already percent-decoded it.
	t.baseDN = strings.TrimPrefix(u.Path, "/")

	if t.host == "" {
		return referralTarget{}, fmt.Errorf("no host in referral URL: %s", ref)
	}
	return t, nil
}

// referralTLSMode returns how to connect to a referral target: ldaps:// and
// ldap:// on port 636 use LDAPS; any other ldap:// URL uses StartTLS when the
// profile uses TLS, so following a referral never downgrades the protection
// of the profile, and plain LDAP otherwise.
func referralTLSMode(profile models.ConnectionProfile, t referralTarget) models.TLSMode {
	if t.scheme == "ldaps" || t.port == "636" {
		return models.TLSSSL
	}
	if profile.TLSMode == models.TLSSSL || profile.TLSMode == models.TLSStartTLS {
		return models.TLSStartTLS
	}
	return models.TLSNone
}

// normalizeHost lowercases a host name and strips a trailing dot and IPv6 brackets.
func normalizeHost(host string) string {
	host = strings.ToLower(strings.TrimSpace(host))
	host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	return strings.TrimSuffix(host, ".")
}

// standardLDAPPorts are the ports of LDAP, LDAPS and the AD global catalog.
var standardLDAPPorts = []string{"389", "636", "3268", "3269"}

// dnDomain returns the DNS domain formed by the trailing DC= components of
// dn, lowercased, or "" if dn has none.
func dnDomain(dn string) string {
	parsed, err := goldap.ParseDN(dn)
	if err != nil {
		return ""
	}
	var labels []string
	for i := len(parsed.RDNs) - 1; i >= 0; i-- {
		rdn := parsed.RDNs[i]
		if len(rdn.Attributes) != 1 || !strings.EqualFold(rdn.Attributes[0].Type, "dc") {
			break
		}
		labels = append([]string{strings.ToLower(rdn.Attributes[0].Value)}, labels...)
	}
	return strings.Join(labels, ".")
}

// trustedReferralDomains returns the DNS domains whose hosts may receive the
// profile's credentials: the domains formed by the trailing DC= components
// of the given DNs (the profile base DN and the server's default naming
// context). A domain on the public suffix list ("com", "co.uk", shared
// hosting zones such as "ngrok.io") is never trusted as a whole.
//
// The domain of the profile host is deliberately not derived from its name:
// the parent of a host name is often a zone shared with other parties
// (e.g. "eastus.cloudapp.azure.com"), which the public suffix list does not
// always cover.
func trustedReferralDomains(dns ...string) []string {
	var domains []string
	for _, dn := range dns {
		d := dnDomain(dn)
		if d == "" || slices.Contains(domains, d) {
			continue
		}
		if _, err := publicsuffix.EffectiveTLDPlusOne(d); err != nil {
			// d is a public suffix or a single label.
			continue
		}
		domains = append(domains, d)
	}
	return domains
}

// referralCredentialsAllowed decides whether the profile credentials may be
// sent to the referral server refHost:refPort: only to the profile's own
// server (same host and port) or to a host in one of the trusted domains
// (including subdomains) listening on a standard LDAP port (389, 636, 3268,
// 3269) or the profile port. Other ports on a trusted host may belong to any
// local user or service. The returned reason explains the decision for the
// operation log.
func referralCredentialsAllowed(profile models.ConnectionProfile, domains []string, refHost, refPort string) (bool, string) {
	host := normalizeHost(refHost)
	profilePort := strconv.Itoa(profile.Port)
	sameHost := host == normalizeHost(profile.Host)
	if sameHost && refPort == profilePort {
		return true, "same server as the profile"
	}
	if net.ParseIP(host) == nil {
		for _, d := range domains {
			if host != d && !strings.HasSuffix(host, "."+d) {
				continue
			}
			if refPort != profilePort && !slices.Contains(standardLDAPPorts, refPort) {
				return false, fmt.Sprintf("port %s of %s is neither a standard LDAP port nor the profile port", refPort, host)
			}
			return true, fmt.Sprintf("host in domain %s", d)
		}
	}
	switch {
	case sameHost:
		return false, fmt.Sprintf("port %s on the profile host differs from the profile port %s", refPort, profilePort)
	case net.ParseIP(host) != nil:
		return false, fmt.Sprintf("referral host %s is an IP address other than the profile host", host)
	case len(domains) == 0:
		return false, fmt.Sprintf("referral host %s differs from the profile host and no trusted domain is known", host)
	}
	return false, fmt.Sprintf("referral host %s is outside the trusted domains %s", host, strings.Join(domains, ", "))
}

// referralTrustDomains returns the trusted referral domains of the client,
// from the profile base DN and the default naming context the server
// announces (cached RootDSE, see ServerInfo), so profiles without a base DN
// are covered as well.
func (c *Client) referralTrustDomains(profile models.ConnectionProfile) []string {
	dns := []string{profile.BaseDN}
	if info, err := c.ServerInfo(); err == nil {
		dns = append(dns, info.DefaultNamingContext)
	}
	return trustedReferralDomains(dns...)
}

// extractReferralURLs extracts referral URLs from a go-ldap error.
func extractReferralURLs(err error) []string {
	var ldapErr *goldap.Error
	if !errors.As(err, &ldapErr) || ldapErr.ResultCode != goldap.LDAPResultReferral {
		return nil
	}

	if ldapErr.Packet == nil || len(ldapErr.Packet.Children) < 2 {
		return nil
	}

	var refs []string
	response := ldapErr.Packet.Children[1]
	for _, child := range response.Children {
		// Referral container: ClassContext(128), TypeConstructed(32), Tag=3
		if child.ClassType == 128 && child.TagType == 32 {
			for _, refChild := range child.Children {
				if s, ok := refChild.Value.(string); ok && (strings.HasPrefix(s, "ldap://") || strings.HasPrefix(s, "ldaps://")) {
					refs = append(refs, s)
				}
			}
		}
	}

	return refs
}

// withReferralConn opens a temporary connection to the server named in
// referralURL and calls fn with it and the DN to operate on: the DN of the
// URL, or originalDN if the URL names none (RFC 4511, 4.1.10).
//
// The connection is never less protected than the profile's (see
// referralTLSMode) and uses the profile's timeout. The profile credentials
// are only sent to trusted servers (see referralCredentialsAllowed); other
// servers get an anonymous bind. The decision is written to the operation log.
// The connection is closed when fn returns, or earlier when ctx is done,
// which aborts the operation in flight on the referral server as well.
func (c *Client) withReferralConn(ctx context.Context, referralURL, originalDN string, fn func(conn *goldap.Conn, baseDN string) error) error {
	start := time.Now()
	profile := c.Profile()
	target, err := parseReferralURL(referralURL)
	if err != nil {
		return err
	}
	address := net.JoinHostPort(target.host, target.port)
	baseDN := target.baseDN
	if baseDN == "" {
		baseDN = originalDN
	}
	tlsMode := referralTLSMode(profile, target)

	bindProfile := profile
	bindNote := "anonymous bind (profile is anonymous)"
	if profile.AuthMethod != models.AuthNone && profile.AuthMethod != "" {
		if ok, reason := referralCredentialsAllowed(profile, c.referralTrustDomains(profile), target.host, target.port); ok {
			bindNote = "bind with " + authSummaryHost(profile, target.host) + " (" + reason + ")"
		} else {
			bindProfile = withoutCredentials(profile)
			bindNote = "anonymous bind, credentials withheld: " + reason
		}
	}
	logDetails := fmt.Sprintf("Following %s via %s (TLS: %s), %s", referralURL, address, tlsMode, bindNote)

	if ctx.Err() != nil {
		return ErrSearchCancelled
	}
	// bindProfile: a server that gets no credentials gets no client
	// certificate either.
	conn, err := dialServer(bindProfile, target.host, target.port, tlsMode)
	if err != nil {
		err = fmt.Errorf("referral connect to %s failed: %s", address, dialErrorDetail(err, profile))
		c.logger.Log("REFERRAL", logDetails, time.Since(start), err)
		return err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()

	if _, err := bindConnHost(conn, bindProfile, target.host); err != nil {
		err = fmt.Errorf("referral bind to %s failed: %s", address, ldapErrorDetail(err))
		c.logger.Log("REFERRAL", logDetails, time.Since(start), err)
		return err
	}
	c.logger.Log("REFERRAL", logDetails, time.Since(start), nil)
	return fn(conn, baseDN)
}

// followReferralSearch connects to a referral target and performs the given
// paged search there, sending controls with it. originalBase is searched if
// the referral URL names no DN.
func (c *Client) followReferralSearch(ctx context.Context, referralURL, originalBase string, scope int, filter string, attrs []string, sizeLimit int, controls []goldap.Control) ([]*goldap.Entry, error) {
	var entries []*goldap.Entry
	err := c.withReferralConn(ctx, referralURL, originalBase, func(conn *goldap.Conn, baseDN string) error {
		searchReq := goldap.NewSearchRequest(
			baseDN,
			scope,
			goldap.NeverDerefAliases,
			sizeLimit, int(profileTimeout(c.Profile()).Seconds()), false,
			filter,
			attrs,
			controls,
		)

		var err error
		entries, _, err = searchPages(ctx, conn, searchReq, c.pageSize())
		if err != nil {
			// Accept partial results on size limit exceeded
			if goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
				return nil
			}
			return fmt.Errorf("referral search on %s failed: %s", referralURL, ldapErrorDetail(err))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return entries, nil
}

// followReferralGetEntry connects to a referral target and reads a single entry,
// resolving ranged attributes on the referral server. dn is read if the
// referral URL names no DN.
func (c *Client) followReferralGetEntry(referralURL, dn string) (*models.LDAPEntry, error) {
	var entry *goldap.Entry
	err := c.withReferralConn(context.Background(), referralURL, dn, func(conn *goldap.Conn, baseDN string) error {
		searchReq := goldap.NewSearchRequest(
			baseDN,
			goldap.ScopeBaseObject,
			goldap.NeverDerefAliases,
			0, int(profileTimeout(c.Profile()).Seconds()), false,
			"(objectClass=*)",
			[]string{"*", "+"},
			nil,
		)
		result, err := conn.Search(searchReq)
		if err != nil {
			return fmt.Errorf("referral search on %s failed: %s", referralURL, ldapErrorDetail(err))
		}
		if len(result.Entries) == 0 {
			return fmt.Errorf("referral target returned no entry")
		}
		entry = result.Entries[0]
		// Ranged attributes are fetched from the referral server, not from
		// the client's own connection.
		_ = resolveRangedAttributes(conn, entry.DN, entry)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return convertEntry(entry), nil
}
