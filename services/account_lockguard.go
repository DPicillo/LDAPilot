package services

import (
	"fmt"

	"github.com/dpicillo/LDAPilot/internal/ldap"
)

// lockKeptNote is the result message of a successful re-lock.
const lockKeptNote = "account kept disabled: permanent ppolicy lock (pwdAccountLockedTime) set again after the password change"

// keepAccountDisabled restores the permanent ppolicy lock after a
// successful change guarded by guard (ldap.PermanentLockGuard: OpenLDAP
// accounts disabled in the account panel stay disabled when their password
// changes) and audits the re-lock as MODIFY with cause ("password reset",
// "bulk modify", …). note describes a successful re-lock for result
// messages ("" when none was needed); err reports a failed one: the change
// itself is applied, but the account is enabled now.
func keepAccountDisabled(guard *ldap.PermanentLockGuard, audit func(operation, dn, details string, err error), dn, cause string) (note string, err error) {
	r := guard.Restore()
	if r == nil {
		return "", nil
	}
	audit("MODIFY", dn, "keep account disabled after "+cause+": "+describeChangesForAudit(r.Changes), r.Err)
	if r.Err != nil {
		return "", fmt.Errorf("the change was applied, but the ppolicy overlay cleared the permanent lock (pwdAccountLockedTime) of this disabled account, so it is enabled now; disabling it again failed: %w", r.Err)
	}
	return lockKeptNote, nil
}
