package ldaptools

import (
	"context"
	"errors"
	"fmt"
	"strings"

	goldap "github.com/go-ldap/ldap/v3"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
	internalldap "github.com/dpicillo/LDAPilot/internal/ldap"
)

// ErrorResult maps an LDAP or harness error to a tool error result (§5.1).
func ErrorResult(tool string, err error, dn string) *tools.Result {
	clean := func(s string) string {
		s, _, _ = ai.SanitizeUntrusted(s)
		return truncRunes(s, 600)
	}
	switch {
	// The tool's own deadline wins over ErrSearchCancelled (which the
	// client also reports for an ended context): a timeout must say
	// "narrow the filter", not "retry".
	case errors.Is(err, context.DeadlineExceeded):
		return tools.Errorf(tool, tools.ErrTimeout, "Narrow the filter or the base DN.", "The operation took too long and was stopped.")
	case errors.Is(err, context.Canceled):
		return tools.Errorf(tool, tools.ErrCancelled, "", "Cancelled by the user before this call finished.")
	case errors.Is(err, internalldap.ErrSearchCancelled):
		return tools.Errorf(tool, tools.ErrSearchCancelled, "The search was interrupted by LDAPilot (user cancel or reconnect); retry if still needed.", "The search was cancelled.")
	case errors.Is(err, internalldap.ErrReadOnly):
		return tools.Errorf(tool, tools.ErrReadOnlyProfile, "The connection profile is read-only; the user can change that in the connection settings.", "This connection is read-only in LDAPilot.")
	case errors.Is(err, internalldap.ErrNotConnected), errors.Is(err, ErrNotConnected):
		return tools.Errorf(tool, tools.ErrNotConnected, "Ask the user to connect the directory in LDAPilot.", "The directory is not connected.")
	case errors.Is(err, ErrUnsupported):
		return tools.Errorf(tool, tools.ErrUnsupportedOnServer, "", "%s", clean(err.Error()))
	case errors.Is(err, internalldap.ErrPasswordDecisionRequired):
		// Password storage policy "ask" (GitHub issue #1): only the user decides.
		return tools.Errorf(tool, tools.ErrPasswordDecision, "Do not retry; approving or allowing AI access does not change this. Tell the user to set the password in LDAPilot's password dialog, or to choose a password storage policy (client-side hash or server-side hashing) in the connection settings under Password storage.", "This connection's password storage policy (a connection setting, unrelated to the AI access level) is \"ask\": LDAPilot needs the user's decision how to store the password; nothing was changed.")
	case errors.Is(err, internalldap.ErrPasswordUnencrypted):
		return tools.Errorf(tool, tools.ErrUnsupportedOnServer, "Do not retry. The user can switch the connection to LDAPS or StartTLS, or set the password in LDAPilot's password dialog (which asks for a confirmation).", "LDAPilot does not send a password over this unencrypted connection without the user's confirmation; nothing was changed.")
	case errors.Is(err, internalldap.ErrNotFound):
		return tools.Errorf(tool, tools.ErrNoSuchObject, "Use search_ldap to find the correct DN.", "No entry with DN %s.", dnOrDash(dn))
	case errors.Is(err, ErrAccountConflict), errors.Is(err, internalldap.ErrAccountConflict):
		return tools.Errorf(tool, tools.ErrEntryChanged, "Read the entry again before proposing a change.", "The entry was changed by someone else; nothing was changed.")
	}
	var le *goldap.Error
	if errors.As(err, &le) {
		detail := goldap.LDAPResultCodeMap[le.ResultCode]
		if le.Err != nil && le.Err.Error() != "" {
			detail += ": " + le.Err.Error()
		}
		detail = clean(detail)
		switch le.ResultCode {
		case goldap.LDAPResultNoSuchObject:
			hint := "Use search_ldap to find the correct DN."
			if le.MatchedDN != "" {
				m, _, _ := ai.SanitizeUntrusted(le.MatchedDN)
				hint = "Closest existing parent: " + m + ". " + hint
			}
			return tools.Errorf(tool, tools.ErrNoSuchObject, hint, "No entry with DN %s.", dnOrDash(dn))
		case goldap.LDAPResultReferral:
			return tools.Errorf(tool, tools.ErrNoSuchObject, "The entry is held by another server (referral); open it in LDAPilot's browser.", "The server returned a referral for %s.", dnOrDash(dn))
		case goldap.LDAPResultInsufficientAccessRights:
			return tools.Errorf(tool, tools.ErrInsufficientAccess, "The connection's account lacks the permission for this operation.", "Insufficient access rights (%s).", detail)
		case goldap.LDAPResultConstraintViolation:
			return tools.Errorf(tool, tools.ErrConstraintViolation, "Check value formats, length limits and password policy.", "Constraint violation (%s).", detail)
		case goldap.LDAPResultObjectClassViolation:
			return tools.Errorf(tool, tools.ErrObjectClassViolation, "Use get_schema_definition to check required and allowed attributes.", "Object class violation (%s).", detail)
		case goldap.LDAPResultEntryAlreadyExists:
			return tools.Errorf(tool, tools.ErrAlreadyExists, "Choose a different DN.", "An entry with this DN already exists.")
		case goldap.LDAPResultNotAllowedOnNonLeaf:
			return tools.Errorf(tool, tools.ErrNotAllowedOnNonLeaf, "The entry has children.", "Not allowed on an entry with children.")
		case goldap.LDAPResultUnwillingToPerform:
			return tools.Errorf(tool, tools.ErrUnwillingToPerform, "The server refused the operation; see the message.", "The server is unwilling to perform the operation (%s).", detail)
		case 122: // assertionFailed (RFC 4528)
			return tools.Errorf(tool, tools.ErrEntryChanged, "Read the entry again before proposing a change.", "The entry changed since the preview; nothing was changed.")
		case goldap.LDAPResultTimeLimitExceeded:
			return tools.Errorf(tool, tools.ErrTimeout, "Narrow the filter or the base DN.", "The server's time limit was exceeded.")
		case goldap.LDAPResultSizeLimitExceeded:
			return tools.Errorf(tool, tools.ErrSizeLimit, "Narrow the filter or the base DN.", "The server's size limit was exceeded.")
		case goldap.LDAPResultFilterError:
			return tools.Errorf(tool, tools.ErrInvalidFilter, "Use validate_filter to locate the problem.", "Invalid filter (%s).", detail)
		case goldap.LDAPResultConfidentialityRequired:
			return tools.Errorf(tool, tools.ErrUnsupportedOnServer, "The server requires an encrypted connection (LDAPS or StartTLS) for this operation; the user can change the connection's TLS setting.", "The server requires an encrypted connection (%s).", detail)
		case goldap.LDAPResultUnavailableCriticalExtension:
			return tools.Errorf(tool, tools.ErrUnsupportedOnServer, "", "The server does not support a required control (%s).", detail)
		case goldap.LDAPResultInvalidDNSyntax:
			return tools.Errorf(tool, tools.ErrInvalidArguments, "Give a full DN such as CN=Anna Schmidt,OU=Users,DC=example,DC=com.", "Invalid DN syntax: %s.", dnOrDash(dn))
		case goldap.LDAPResultNoSuchAttribute:
			return tools.Errorf(tool, tools.ErrLDAP, "Read the entry first; the value to delete does not exist.", "No such attribute or value (%s).", detail).WithExtra("ldap_code", int(le.ResultCode))
		case goldap.LDAPResultAttributeOrValueExists:
			return tools.Errorf(tool, tools.ErrLDAP, "The value is already present.", "Attribute or value exists (%s).", detail).WithExtra("ldap_code", int(le.ResultCode))
		}
		if le.ResultCode >= goldap.ErrorNetwork {
			return tools.Errorf(tool, tools.ErrNotConnected, "Retry once; if it fails again, ask the user to reconnect.", "Connection problem: %s.", detail)
		}
		return tools.Errorf(tool, tools.ErrLDAP, "", "LDAP error %d (%s).", le.ResultCode, detail).WithExtra("ldap_code", int(le.ResultCode))
	}
	msg := err.Error()
	if strings.Contains(strings.ToLower(msg), "timeout") || strings.Contains(strings.ToLower(msg), "timed out") {
		return tools.Errorf(tool, tools.ErrTimeout, "Narrow the request.", "%s", clean(msg))
	}
	return tools.Errorf(tool, tools.ErrLDAP, "", "%s", clean(msg))
}

func dnOrDash(dn string) string {
	if dn == "" {
		return "-"
	}
	s, _, _ := ai.SanitizeUntrusted(dn)
	return s
}

// errf is a short helper for argument errors.
func errf(tool, code, hint, format string, args ...any) *tools.Result {
	return tools.Errorf(tool, code, hint, format, args...)
}

// isNoSuchObject reports LDAP 32.
func isNoSuchObject(err error) bool {
	return goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject) || errors.Is(err, internalldap.ErrNotFound)
}

func wrapf(err error, format string, args ...any) error {
	return fmt.Errorf("%s: %w", fmt.Sprintf(format, args...), err)
}

func isSearchCancelled(err error) bool { return errors.Is(err, internalldap.ErrSearchCancelled) }
