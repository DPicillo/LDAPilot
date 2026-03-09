package ldap

import (
	"crypto/tls"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// parseReferralURL parses an LDAP referral URL and extracts host, port, and base DN.
// LDAP URL format: ldap://host[:port]/baseDN[?attrs?scope?filter?extensions]
func parseReferralURL(ref string) (host string, port string, baseDN string, err error) {
	// Trim whitespace
	ref = strings.TrimSpace(ref)

	// Handle both ldap:// and ldaps://
	if !strings.HasPrefix(ref, "ldap://") && !strings.HasPrefix(ref, "ldaps://") {
		return "", "", "", fmt.Errorf("invalid referral URL scheme: %s", ref)
	}

	u, err := url.Parse(ref)
	if err != nil {
		return "", "", "", fmt.Errorf("invalid referral URL: %w", err)
	}

	host = u.Hostname()
	port = u.Port()
	if port == "" {
		if u.Scheme == "ldaps" {
			port = "636"
		} else {
			port = "389"
		}
	}

	// The base DN is the URL path without the leading slash
	baseDN = strings.TrimPrefix(u.Path, "/")
	// URL-decode the base DN
	if decoded, err := url.PathUnescape(baseDN); err == nil {
		baseDN = decoded
	}

	if host == "" {
		return "", "", "", fmt.Errorf("no host in referral URL: %s", ref)
	}

	return host, port, baseDN, nil
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

// followReferralSearch connects to a referral target and performs the given search.
// It uses the same TLS and authentication settings from the original profile.
// The caller must NOT hold c.mu when calling this method.
func (c *Client) followReferralSearch(referralURL string, scope int, filter string, attrs []string, sizeLimit int) ([]*goldap.Entry, error) {
	host, port, baseDN, err := parseReferralURL(referralURL)
	if err != nil {
		return nil, err
	}

	// Create a temporary connection to the referral target
	address := fmt.Sprintf("%s:%s", host, port)
	timeout := time.Duration(c.profile.Timeout) * time.Second
	if timeout == 0 {
		timeout = 10 * time.Second
	}

	tlsConfig := &tls.Config{
		InsecureSkipVerify: c.profile.TLSSkipVerify,
		ServerName:         host,
	}

	var conn *goldap.Conn

	switch c.profile.TLSMode {
	case models.TLSSSL:
		conn, err = goldap.DialTLS("tcp", address, tlsConfig)
	case models.TLSStartTLS:
		conn, err = goldap.DialURL(fmt.Sprintf("ldap://%s", address))
		if err != nil {
			return nil, fmt.Errorf("referral connect failed: %v", err)
		}
		if err = conn.StartTLS(tlsConfig); err != nil {
			conn.Close()
			return nil, fmt.Errorf("referral StartTLS failed: %v", err)
		}
	default:
		// Auto-detect: if port is 636, use TLS; otherwise plain
		if port == "636" {
			conn, err = goldap.DialTLS("tcp", address, tlsConfig)
		} else {
			conn, err = goldap.DialURL(fmt.Sprintf("ldap://%s", address))
		}
	}

	if err != nil {
		return nil, fmt.Errorf("referral connect to %s failed: %v", address, err)
	}
	defer conn.Close()
	conn.SetTimeout(timeout)

	// Bind with the same credentials
	switch c.profile.AuthMethod {
	case models.AuthSimple:
		if err := conn.Bind(c.profile.BindDN, c.profile.Password); err != nil {
			return nil, fmt.Errorf("referral bind to %s failed: %v", address, ldapErrorDetail(err))
		}
	case models.AuthNone:
		if err := conn.UnauthenticatedBind(""); err != nil {
			return nil, fmt.Errorf("referral anonymous bind to %s failed: %v", address, ldapErrorDetail(err))
		}
	}

	// Perform the search
	searchReq := goldap.NewSearchRequest(
		baseDN,
		scope,
		goldap.NeverDerefAliases,
		sizeLimit, int(timeout.Seconds()), false,
		filter,
		attrs,
		nil,
	)

	result, err := conn.Search(searchReq)
	if err != nil {
		// Accept partial results on size limit exceeded
		if goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) && result != nil {
			return result.Entries, nil
		}
		return nil, fmt.Errorf("referral search on %s failed: %v", address, ldapErrorDetail(err))
	}

	return result.Entries, nil
}

// followReferralGetEntry connects to a referral target and reads a single entry.
func (c *Client) followReferralGetEntry(referralURL string) (*models.LDAPEntry, error) {
	entries, err := c.followReferralSearch(referralURL, goldap.ScopeBaseObject, "(objectClass=*)", []string{"*", "+"}, 0)
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("referral target returned no entry")
	}
	entry := entries[0]
	c.resolveRangedAttributes(entry.DN, entry)
	return convertEntry(entry), nil
}
