package services

import (
	"fmt"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// Account status, account actions and account reports. The status and
// reports are read operations of BrowserService; the actions are writes of
// EditorService that go through ModifyEntry (one atomic modify, read-only
// enforced) and are written to the audit log.

// GetAccountStatus returns the normalized account status of dn (enabled,
// locked, password and account expiry, logons, effective policy). For
// entries that are no accounts the status has applicable=false.
func (s *BrowserService) GetAccountStatus(profileID string, dn string) (*models.AccountStatus, error) {
	if strings.TrimSpace(dn) == "" {
		return nil, fmt.Errorf("DN must not be empty")
	}
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.AccountStatus(dn)
}

// GetNewAccountPolicy returns the password policy an account created below
// parentDN gets (New User dialog: whether "must change password at next
// logon" is offered and preselected on OpenLDAP and 389DS); nil for server
// types without account policies.
func (s *BrowserService) GetNewAccountPolicy(profileID string, parentDN string) (*models.AccountPolicy, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.NewAccountPolicy(parentDN)
}

// RunAccountReport runs an account report: "locked" (lockouts still in
// effect), "disabled", "passwordExpiring" (within params.Days days),
// "passwordExpired" or "neverLoggedOn", or one of the group reports
// "emptyGroups" (without primary-group members) and "privilegedMembers"
// (AD). With params.DNs only those rows are read again.
func (s *BrowserService) RunAccountReport(profileID string, params models.AccountReportParams) (*models.AccountReportResult, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.AccountReport(params)
}

// GetReportAvailability tells the Reports panel the server type and which
// backend reports cannot run on this server (e.g. "neverLoggedOn" when no
// entry has a recorded logon time), with the reason to show.
func (s *BrowserService) GetReportAvailability(profileID string, baseDN string) (*models.ReportAvailability, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.AccountReportAvailability(baseDN)
}

// UnlockAccount removes a password lockout (AD lockoutTime=0, OpenLDAP
// pwdAccountLockedTime/pwdFailureTime, 389DS accountUnlockTime/
// passwordRetryCount).
func (s *EditorService) UnlockAccount(profileID string, dn string) error {
	return s.applyAccountChange(profileID, dn, ldap.AccountChange{Action: models.AccountActionUnlock})
}

// SetAccountEnabled enables or disables an account (AD ACCOUNTDISABLE flag,
// 389DS nsAccountLock, OpenLDAP permanent ppolicy lock 000001010000Z).
func (s *EditorService) SetAccountEnabled(profileID string, dn string, enabled bool) error {
	action := models.AccountActionDisable
	if enabled {
		action = models.AccountActionEnable
	}
	return s.applyAccountChange(profileID, dn, ldap.AccountChange{Action: action})
}

// SetMustChangePassword sets or clears "user must change password at next
// logon" (AD pwdLastSet 0/-1, OpenLDAP pwdReset, 389DS
// passwordExpirationTime 19700101000000Z).
func (s *EditorService) SetMustChangePassword(profileID string, dn string, mustChange bool) error {
	return s.applyAccountChange(profileID, dn, ldap.AccountChange{Action: models.AccountActionMustChange, Set: mustChange})
}

// SetPasswordNeverExpires sets or clears the AD DONT_EXPIRE_PASSWORD flag.
func (s *EditorService) SetPasswordNeverExpires(profileID string, dn string, neverExpires bool) error {
	return s.applyAccountChange(profileID, dn, ldap.AccountChange{Action: models.AccountActionNeverExpires, Set: neverExpires})
}

// SetAccountExpiration sets the AD account expiration (accountExpires) to
// expires, an RFC 3339 time; an empty string removes the expiration.
func (s *EditorService) SetAccountExpiration(profileID string, dn string, expires string) error {
	ch := ldap.AccountChange{Action: models.AccountActionAccountExpires}
	if strings.TrimSpace(expires) != "" {
		t, err := time.Parse(time.RFC3339, strings.TrimSpace(expires))
		if err != nil {
			return fmt.Errorf("invalid expiration time %q: use RFC 3339", expires)
		}
		ch.Set = true
		ch.Expires = t
	}
	return s.applyAccountChange(profileID, dn, ch)
}

// SetUserAccountControl replaces the AD userAccountControl value. expected
// is the value the caller based its edit on; the change fails when the value
// on the server differs, so concurrent changes are not overwritten. Account
// type bits and the computed LOCKOUT / PASSWORD_EXPIRED bits cannot be changed.
func (s *EditorService) SetUserAccountControl(profileID string, dn string, expected int64, value int64) error {
	return s.applyAccountChange(profileID, dn, ldap.AccountChange{Action: models.AccountActionUAC, ExpectedUAC: expected, UAC: value})
}

// applyAccountChange performs an account action and writes the audit entry
// (operation MODIFY, details "<action>: <changes>").
func (s *EditorService) applyAccountChange(profileID, dn string, ch ldap.AccountChange) error {
	if strings.TrimSpace(dn) == "" {
		return fmt.Errorf("DN must not be empty")
	}
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return err
	}
	changes, err := client.ApplyAccountChange(dn, ch)
	if changes == nil {
		// Nothing was sent (the action does not apply); not audited.
		return err
	}
	s.audit(profileID, "MODIFY", dn, ch.Describe()+": "+describeChangesForAudit(changes), err)
	return err
}
