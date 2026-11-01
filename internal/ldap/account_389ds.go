package ldap

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// 389 Directory Server account state.
//
//   - Account inactivation: nsAccountLock: true, either stored on the entry
//     or provided through the roles plugin (the entry has the nsDisabledRole
//     role, e.g. via nsRoleDN: cn=nsManagedDisabledRole,<suffix>).
//   - Password lockout (when passwordLockout is on): accountUnlockTime is
//     set when passwordRetryCount reaches passwordMaxFailure. With
//     passwordUnlock off it is 19700101000000Z (locked until an administrator
//     resets it), otherwise the time the lock ends.
//   - passwordExpirationTime 19700101000000Z: the password was reset and
//     must be changed (passwordMustChange on); otherwise it is the expiry
//     when passwordExp is on.
//   - Policy: the entry's pwdpolicysubentry (local policy, when
//     nsslapd-pwpolicy-local is on), otherwise the global policy in cn=config.

// dsAccountAttrs are read for the 389DS account status. nsRole and
// pwdpolicysubentry are virtual/operational and only returned on request.
var dsAccountAttrs = []string{
	"objectClass", "nsAccountLock", "nsRole", "nsRoleDN", "passwordRetryCount",
	"retryCountResetTime", "accountUnlockTime", "passwordExpirationTime",
	"passwordGraceUserTime", "pwdpolicysubentry", "createTimestamp",
	"lastLoginTime", "pwdUpdateTime",
}

// dsPolicyAttrs are the password policy attributes of cn=config and of
// local policy entries.
var dsPolicyAttrs = []string{
	"cn", "passwordLockout", "passwordMaxFailure", "passwordLockoutDuration",
	"passwordUnlock", "passwordResetFailureCount", "passwordExp", "passwordMaxAge",
	"passwordMinAge", "passwordWarning", "passwordMustChange", "passwordGraceLimit",
	"passwordMinLength", "passwordInHistory", "nsslapd-pwpolicy-local", "passwordCheckSyntax",
}

// Prefixes (lower case) of the 389DS account inactivation roles.
const (
	dsDisabledRolePrefix        = "cn=nsdisabledrole,"
	dsManagedDisabledRolePrefix = "cn=nsmanageddisabledrole,"
)

// dsAccountStatus reads dn and its policy and computes the status.
func (r *accountReader) dsAccountStatus(dn string, now time.Time, cache policyCache) (*models.AccountStatus, accountAttrs, error) {
	attrs, err := r.readAccount(dn, dsAccountAttrs)
	if err != nil {
		return nil, nil, err
	}
	st := newAccountStatus(dn, models.ServerType389DS, now)
	if !isGenericAccount(attrs.all("objectClass")) && !attrs.has("passwordRetryCount") && !attrs.has("nsAccountLock") {
		st.Reason = "Not an account: the entry has no person or account object class."
		return st, attrs, nil
	}
	pol, warn := r.dsPolicy(attrs.first("pwdpolicysubentry"), cache)
	if warn != "" {
		st.Warnings = append(st.Warnings, warn)
	}
	compute389Status(st, attrs, pol, now)
	return st, attrs, nil
}

// dsPolicy returns the effective 389DS policy: the local policy entry or
// the global policy in cn=config.
func (r *accountReader) dsPolicy(subentry string, cache policyCache) (*models.AccountPolicy, string) {
	global, ok := cache["#389-global"]
	if !ok {
		global = &models.AccountPolicy{DN: "cn=config", Name: "Global password policy", Source: models.PolicySourceGlobal}
		if a, err := r.readAccountEntry("cn=config", dsPolicyAttrs); err == nil {
			fill389Policy(global, a)
			if local, _ := boolAttr(a, "nsslapd-pwpolicy-local"); local {
				cache["#389-local-on"] = global
			}
		}
		cache["#389-global"] = global
	}
	if subentry == "" {
		return global, policyWarning(global)
	}
	if global.Readable {
		if _, localOn := cache["#389-local-on"]; !localOn {
			return global, fmt.Sprintf("The entry references the local policy %s, but local password policies are off (nsslapd-pwpolicy-local), so the global policy applies.", subentry)
		}
	}
	key := strings.ToLower(subentry)
	if pol, ok := cache[key]; ok {
		return pol, policyWarning(pol)
	}
	pol := &models.AccountPolicy{DN: subentry, Name: rdnValue(subentry), Source: models.PolicySourceSubentry}
	if a, err := r.readAccountEntry(subentry, dsPolicyAttrs); err == nil {
		fill389Policy(pol, a)
	}
	cache[key] = pol
	return pol, policyWarning(pol)
}

// fill389Policy fills pol from 389DS password policy attributes.
func fill389Policy(pol *models.AccountPolicy, a accountAttrs) {
	if !a.has("passwordLockout") && !a.has("passwordExp") && !a.has("passwordMaxFailure") && !a.has("passwordMustChange") {
		return
	}
	pol.Readable = true
	pol.LockoutEnabled, _ = boolAttr(a, "passwordLockout")
	pol.LockoutThreshold = int(intAttr(a, "passwordMaxFailure"))
	if unlock, _ := boolAttr(a, "passwordUnlock"); unlock {
		pol.LockoutDurationSeconds = intAttr(a, "passwordLockoutDuration")
	}
	pol.ObservationWindowSeconds = intAttr(a, "passwordResetFailureCount")
	if exp, _ := boolAttr(a, "passwordExp"); exp {
		pol.MaxPasswordAgeSeconds = intAttr(a, "passwordMaxAge")
	}
	pol.MinPasswordAgeSeconds = intAttr(a, "passwordMinAge")
	pol.MinPasswordLength = int(intAttr(a, "passwordMinLength"))
	pol.PasswordHistory = int(intAttr(a, "passwordInHistory"))
	pol.ExpireWarningSeconds = intAttr(a, "passwordWarning")
	pol.GraceLogins = int(intAttr(a, "passwordGraceLimit"))
	pol.MustChangeEnforced, _ = boolAttr(a, "passwordMustChange")
	if v, ok := boolAttr(a, "passwordCheckSyntax"); ok {
		pol.ComplexityKnown = true
		pol.ComplexityEnabled = v
	}
}

// dsHasRolePrefix reports whether an nsRole/nsRoleDN value starts with prefix.
func dsHasRolePrefix(values []string, prefix string) (string, bool) {
	for _, v := range values {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(v)), prefix) {
			return v, true
		}
	}
	return "", false
}

// compute389Status fills st from the 389DS attributes of an account and its
// effective policy.
func compute389Status(st *models.AccountStatus, a accountAttrs, pol *models.AccountPolicy, now time.Time) {
	st.Applicable = true
	st.Kind = models.AccountKindUser
	st.Policy = pol
	polKnown := pol != nil && pol.Readable
	lockoutOn := !polKnown || pol.LockoutEnabled

	// Inactivation
	_, byRole := dsHasRolePrefix(a.all("nsRole"), dsDisabledRolePrefix)
	lockAttr, _ := boolAttr(a, "nsAccountLock")
	switch {
	case byRole:
		st.Enabled = false
		st.DisabledByRole = true
		st.DisabledBy = "nsDisabledRole role (account inactivation through roles)"
	case lockAttr:
		st.Enabled = false
		st.DisabledBy = "nsAccountLock: true"
	}

	// Password lockout
	if v := strings.TrimSpace(a.first("accountUnlockTime")); v != "" {
		t, err := parseGeneralizedTime(v)
		switch {
		case !lockoutOn:
			st.LockoutExpired = true
		case err != nil:
			st.Warnings = append(st.Warnings, fmt.Sprintf("accountUnlockTime %q could not be parsed.", v))
		case t.Unix() == 0:
			// "Locked forever" unless passwordUnlock is on.
			if !polKnown || pol.LockoutDurationSeconds == 0 {
				st.Locked = true
				st.LockedPermanently = polKnown
			} else {
				st.LockoutExpired = true
			}
		case now.Before(t):
			st.Locked = true
			st.LockedUntil = isoTime(t)
			if polKnown && pol.LockoutDurationSeconds > 0 {
				st.LockedAt = isoTime(t.Add(-time.Duration(pol.LockoutDurationSeconds) * time.Second))
			}
		default:
			st.LockoutExpired = true
		}
	}
	if v, ok := a.int64("passwordRetryCount"); ok {
		st.BadPasswordCount = int(v)
	}
	if t, ok := a.generalizedTime("retryCountResetTime"); ok && polKnown && pol.ObservationWindowSeconds > 0 {
		// retryCountResetTime = last failure + passwordResetFailureCount
		st.LastBadPassword = isoTime(t.Add(-time.Duration(pol.ObservationWindowSeconds) * time.Second))
	}

	// Password
	if t, ok := a.generalizedTime("pwdUpdateTime"); ok {
		st.PasswordLastSet = isoTime(t)
	}
	expOn := polKnown && pol.MaxPasswordAgeSeconds > 0
	mustChangeOn := !polKnown || pol.MustChangeEnforced
	pet := strings.TrimSpace(a.first("passwordExpirationTime"))
	petTime, petErr := parseGeneralizedTime(pet)
	resetMarker := pet != "" && petErr == nil && petTime.Unix() == 0
	switch {
	case resetMarker && mustChangeOn:
		st.MustChangePassword = true
		st.PasswordExpiryNote = "The password was reset and must be changed at the next bind."
	case resetMarker && expOn:
		st.PasswordExpired = true
		st.PasswordExpires = isoTime(petTime)
	case resetMarker:
		st.Warnings = append(st.Warnings, "passwordExpirationTime is 19700101000000Z, but neither passwordMustChange nor passwordExp is on, so the server ignores it.")
		st.PasswordNeverExpires = true
		st.PasswordExpiryNote = "Password expiration (passwordExp) is off in the password policy."
	case polKnown && !expOn:
		st.PasswordNeverExpires = true
		st.PasswordExpiryNote = "Password expiration (passwordExp) is off in the password policy."
	case pet != "" && petErr == nil && petTime.Year() >= 2038:
		st.PasswordNeverExpires = true
		st.PasswordExpiryNote = "passwordExpirationTime is the end of time."
	case pet != "" && petErr == nil:
		st.PasswordExpires = isoTime(petTime)
		st.PasswordExpired = !now.Before(petTime)
	case expOn:
		st.PasswordExpiryNote = "No passwordExpirationTime yet; the server sets it at the next bind or password change."
	default:
		st.PasswordExpiryNote = "The password expiry is unknown (password policy not readable)."
	}

	st.AccountNeverExpires = true
	if t, ok := a.generalizedTime("lastLoginTime"); ok {
		st.LastLogon = isoTime(t)
	}
	if t, ok := a.generalizedTime("createTimestamp"); ok {
		st.Created = isoTime(t)
	}

	// Supported actions
	st.Unsupported[models.AccountActionNeverExpires] = "389 Directory Server has no per-account \"password never expires\" flag; assign a local password policy with passwordExp off instead."
	st.Unsupported[models.AccountActionAccountExpires] = "389 Directory Server has no account expiration date (the Account Policy plugin handles inactivity limits)."
	st.Unsupported[models.AccountActionUAC] = "userAccountControl exists only in Active Directory."
	if polKnown && !pol.MustChangeEnforced && !expOn {
		st.Unsupported[models.AccountActionMustChange] = "The password policy has passwordMustChange and passwordExp off, so a forced password change is not enforced."
	}
	if byRole {
		if _, managed := dsHasRolePrefix(a.all("nsRoleDN"), dsManagedDisabledRolePrefix); !managed {
			st.Unsupported[models.AccountActionEnable] = "The account is disabled through a role that includes nsDisabledRole; remove the entry from that role to enable it."
		}
	}
}

// plan389Change returns the modify changes for ch on a 389DS account.
func plan389Change(a accountAttrs, st *models.AccountStatus, ch AccountChange) ([]models.AttributeChange, error) {
	switch ch.Action {
	case models.AccountActionUnlock:
		var changes []models.AttributeChange
		if a.has("accountUnlockTime") {
			changes = append(changes, models.AttributeChange{Operation: models.ChangeDelete, Attribute: "accountUnlockTime", Values: []string{}})
		}
		if n, _ := a.int64("passwordRetryCount"); n > 0 {
			changes = append(changes, models.AttributeChange{Operation: models.ChangeReplace, Attribute: "passwordRetryCount", Values: []string{"0"}})
		}
		if a.has("retryCountResetTime") {
			changes = append(changes, models.AttributeChange{Operation: models.ChangeDelete, Attribute: "retryCountResetTime", Values: []string{}})
		}
		if len(changes) == 0 {
			return nil, errors.New("the account is not locked out")
		}
		return changes, nil

	case models.AccountActionDisable:
		if lock, _ := boolAttr(a, "nsAccountLock"); lock && !st.DisabledByRole {
			return nil, errors.New("the account is already disabled")
		}
		return []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: "nsAccountLock", Values: []string{"true"}}}, nil

	case models.AccountActionEnable:
		var changes []models.AttributeChange
		if st.DisabledByRole {
			if role, ok := dsHasRolePrefix(a.all("nsRoleDN"), dsManagedDisabledRolePrefix); ok {
				changes = append(changes, models.AttributeChange{Operation: models.ChangeDelete, Attribute: "nsRoleDN", Values: []string{role}})
			}
		} else if a.has("nsAccountLock") {
			changes = append(changes, models.AttributeChange{Operation: models.ChangeDelete, Attribute: "nsAccountLock", Values: []string{}})
		}
		if len(changes) == 0 {
			return nil, errors.New("the account is already enabled")
		}
		return changes, nil

	case models.AccountActionMustChange:
		pet := strings.TrimSpace(a.first("passwordExpirationTime"))
		isReset := pet != "" && func() bool { t, err := parseGeneralizedTime(pet); return err == nil && t.Unix() == 0 }()
		if ch.Set {
			if isReset {
				return nil, errors.New("the password already has to be changed")
			}
			return []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: "passwordExpirationTime", Values: []string{generalizedTimeZero}}}, nil
		}
		if !isReset {
			return nil, errors.New("\"must change password\" is not set")
		}
		// Without passwordExpirationTime the server sets a fresh expiry at
		// the next bind when passwordExp is on.
		return []models.AttributeChange{{Operation: models.ChangeDelete, Attribute: "passwordExpirationTime", Values: []string{}}}, nil
	}
	return nil, fmt.Errorf("the action %q is not supported on 389 Directory Server", ch.Action)
}
