package ldap

import (
	"errors"
	"fmt"

	goldap "github.com/go-ldap/ldap/v3"
)

var (
	// ErrNotConnected is returned when an operation is attempted without an active connection.
	ErrNotConnected = errors.New("not connected to LDAP server")

	// ErrConnectionFailed is returned when the initial connection to the LDAP server fails.
	ErrConnectionFailed = errors.New("failed to connect to LDAP server")

	// ErrBindFailed is returned when the bind (authentication) step fails.
	ErrBindFailed = errors.New("LDAP bind failed")

	// ErrSearchFailed is returned when an LDAP search operation fails.
	ErrSearchFailed = errors.New("LDAP search failed")

	// ErrNotFound is returned when the requested entry does not exist.
	ErrNotFound = errors.New("LDAP entry not found")
)

// ldapErrorDetail extracts the LDAP result code name and diagnostic message
// from a go-ldap error, returning a human-readable string with technical details.
func ldapErrorDetail(err error) string {
	var ldapErr *goldap.Error
	if errors.As(err, &ldapErr) {
		code := goldap.LDAPResultCodeMap[ldapErr.ResultCode]
		if code == "" {
			code = fmt.Sprintf("code %d", ldapErr.ResultCode)
		}
		detail := code
		if ldapErr.Err != nil {
			detail += ": " + ldapErr.Err.Error()
		}
		return detail
	}
	return err.Error()
}
