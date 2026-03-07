package ldap

import "errors"

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
