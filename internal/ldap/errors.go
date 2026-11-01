package ldap

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

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

	// ErrSearchCancelled is returned when a search was cancelled by the user
	// (Client.CancelSearches) or its context ended before it completed.
	ErrSearchCancelled = errors.New("search cancelled")

	// ErrReadOnly is returned by every write operation on a client whose
	// profile is marked read-only.
	ErrReadOnly = errors.New("connection is read-only")

	// ErrConnectCancelled is returned by Pool.Connect when the profile was
	// disconnected while the connection was being established. It unwraps to
	// ErrNotConnected.
	ErrConnectCancelled = fmt.Errorf("%w: connection attempt cancelled", ErrNotConnected)
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

// opError is the error of a failed client operation. It keeps the
// human-readable message and unwraps to the go-ldap error (and to the package
// sentinel, if any), so callers can use errors.Is(err, ErrSearchFailed) as well
// as goldap.IsErrorWithCode(err, code).
type opError struct {
	msg      string
	sentinel error // optional
	cause    error
}

func (e *opError) Error() string { return e.msg }

func (e *opError) Unwrap() []error {
	if e.sentinel != nil {
		return []error{e.sentinel, e.cause}
	}
	return []error{e.cause}
}

// searchError wraps a failed read as "LDAP search failed: <detail>".
// ErrNotConnected and ErrSearchCancelled are returned unchanged.
func searchError(err error) error {
	if err == nil || errors.Is(err, ErrNotConnected) || errors.Is(err, ErrSearchCancelled) {
		return err
	}
	return &opError{msg: ErrSearchFailed.Error() + ": " + ldapErrorDetail(err), sentinel: ErrSearchFailed, cause: err}
}

// writeError wraps a failed write as "<what> failed: <detail>".
// ErrNotConnected and ErrReadOnly are returned unchanged.
func writeError(what string, err error) error {
	if err == nil || errors.Is(err, ErrNotConnected) || errors.Is(err, ErrReadOnly) {
		return err
	}
	return &opError{msg: what + " failed: " + ldapErrorDetail(err), cause: err}
}

// adBindDataCode finds the sub-status ("data 52e") that Active Directory and
// Samba put into the diagnostic message of a failed bind, e.g.
// "80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data 52e, v4563".
var adBindDataCode = regexp.MustCompile(`(?i)\bdata\s+([0-9a-f]{3,8})\b`)

// adBindDataHints translates the AD bind sub-status codes (Win32 error codes
// in hex) into what an administrator has to do.
var adBindDataHints = map[string]string{
	"525": "the user does not exist (check the bind DN / user name)",
	"52e": "wrong password or user name",
	"530": "logon is not permitted at this time (logon hours of the account)",
	"531": "logon is not permitted from this workstation (userWorkstations of the account)",
	"532": "the password has expired",
	"533": "the account is disabled",
	"568": "the account is in too many groups (token too large)",
	"701": "the account has expired (accountExpires)",
	"773": "the password must be changed before the first logon (pwdLastSet = 0)",
	"775": "the account is locked out",
}

// BindErrorHint returns a readable explanation of an Active Directory bind
// error ("data 52e" → "wrong password or user name"), or "" when err carries
// no known AD sub-status. Connect and Test Connection append it to their
// error message.
func BindErrorHint(err error) string {
	if err == nil {
		return ""
	}
	return bindHintFromText(err.Error())
}

func bindHintFromText(text string) string {
	m := adBindDataCode.FindStringSubmatch(text)
	if m == nil {
		return ""
	}
	code := strings.TrimLeft(strings.ToLower(m[1]), "0")
	if hint, ok := adBindDataHints[code]; ok {
		return hint + " (AD code " + code + ")"
	}
	return ""
}

// EntriesText is "1 entry" / "n entries" for log texts (RW3-R-04: every
// single-entry read in the Operations log ended with "-> 1 entries").
func EntriesText(n int) string {
	if n == 1 {
		return "1 entry"
	}
	return fmt.Sprintf("%d entries", n)
}
