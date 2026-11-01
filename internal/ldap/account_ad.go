package ldap

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// userAccountControl flags used by the account status.
const (
	uacAccountDisable       int64 = 0x0002
	uacLockout              int64 = 0x0010
	uacPasswdCantChange     int64 = 0x0040
	uacTempDuplicateAccount int64 = 0x0100
	uacNormalAccount        int64 = 0x0200
	uacInterdomainTrust     int64 = 0x0800
	uacWorkstationTrust     int64 = 0x1000
	uacServerTrust          int64 = 0x2000
	uacDontExpirePassword   int64 = 0x10000
	uacPasswordExpired      int64 = 0x800000
	uacPartialSecrets       int64 = 0x4000000
)

// uacProtectedBits cannot be changed with the userAccountControl editor:
// the account type bits, bits computed by the DC (LOCKOUT, PASSWORD_EXPIRED,
// which AD reports in msDS-User-Account-Control-Computed) and
// PASSWD_CANT_CHANGE, which AD stores as an ACE, not in userAccountControl.
const uacProtectedBits = uacLockout | uacPasswordExpired | uacPasswdCantChange |
	uacTempDuplicateAccount | uacNormalAccount | uacInterdomainTrust |
	uacWorkstationTrust | uacServerTrust | uacPartialSecrets

// adAccountAttrs are read for the AD account status. The msDS-* attributes
// are constructed and only returned when requested by name.
var adAccountAttrs = []string{
	"objectClass", "userAccountControl", "msDS-User-Account-Control-Computed",
	"lockoutTime", "badPwdCount", "badPasswordTime", "pwdLastSet",
	"msDS-UserPasswordExpiryTimeComputed", "accountExpires",
	"lastLogon", "lastLogonTimestamp", "logonCount", "whenCreated",
	"msDS-ResultantPSO",
}

// adDomainPolicyAttrs are the policy attributes on the domain NC head.
var adDomainPolicyAttrs = []string{
	"lockoutDuration", "lockoutThreshold", "lockOutObservationWindow",
	"maxPwdAge", "minPwdAge", "minPwdLength", "pwdHistoryLength", "pwdProperties",
}

// adPSOAttrs are the attributes of a fine-grained password policy.
var adPSOAttrs = []string{
	"cn", "msDS-LockoutDuration", "msDS-LockoutThreshold", "msDS-LockoutObservationWindow",
	"msDS-MaximumPasswordAge", "msDS-MinimumPasswordAge", "msDS-MinimumPasswordLength",
	"msDS-PasswordHistoryLength", "msDS-PasswordComplexityEnabled", "msDS-PasswordReversibleEncryptionEnabled",
}

// Domain pwdProperties flags (DOMAIN_PASSWORD_INFORMATION).
const (
	adPwdPropComplex        int64 = 0x01 // DOMAIN_PASSWORD_COMPLEX
	adPwdPropStoreCleartext int64 = 0x10 // DOMAIN_PASSWORD_STORE_CLEARTEXT
)

// fillADComplexity reads the complexity and reversible encryption settings
// of a domain policy (pwdProperties) or a PSO (msDS-Password*Enabled).
func fillADComplexity(pol *models.AccountPolicy, a accountAttrs, pso bool) {
	if pso {
		complexity, ok1 := boolAttr(a, "msDS-PasswordComplexityEnabled")
		reversible, ok2 := boolAttr(a, "msDS-PasswordReversibleEncryptionEnabled")
		if ok1 || ok2 {
			pol.ComplexityKnown = true
			pol.ComplexityEnabled = complexity
			pol.ReversibleEncryption = reversible
		}
		return
	}
	if v, ok := a.int64("pwdProperties"); ok {
		pol.ComplexityKnown = true
		pol.ComplexityEnabled = v&adPwdPropComplex != 0
		pol.ReversibleEncryption = v&adPwdPropStoreCleartext != 0
	}
}

// adAccountKind classifies an AD entry by its object classes; ok is false
// for entries that are no accounts (contacts, groups, OUs...).
func adAccountKind(objectClasses []string) (kind string, ok bool) {
	has := func(name string) bool {
		for _, oc := range objectClasses {
			if strings.EqualFold(oc, name) {
				return true
			}
		}
		return false
	}
	switch {
	case has("msDS-GroupManagedServiceAccount") || has("msDS-ManagedServiceAccount"):
		return models.AccountKindServiceAccount, true
	case has("computer"):
		return models.AccountKindComputer, true
	case has("user"):
		return models.AccountKindUser, true
	}
	return "", false
}

// adDomainDN returns the domain part (trailing DC= RDNs) of dn.
func adDomainDN(dn string) string {
	d, err := goldap.ParseDN(dn)
	if err != nil {
		return ""
	}
	start := len(d.RDNs)
	for i := len(d.RDNs) - 1; i >= 0; i-- {
		r := d.RDNs[i]
		if len(r.Attributes) != 1 || !strings.EqualFold(r.Attributes[0].Type, "dc") {
			break
		}
		start = i
	}
	if start == len(d.RDNs) {
		return ""
	}
	parts := make([]string, 0, len(d.RDNs)-start)
	for _, r := range d.RDNs[start:] {
		parts = append(parts, "DC="+r.Attributes[0].Value)
	}
	return strings.Join(parts, ",")
}

// adAccountStatus reads dn and its effective policy and computes the status.
func (r *accountReader) adAccountStatus(dn string, now time.Time, cache policyCache) (*models.AccountStatus, accountAttrs, error) {
	attrs, err := r.readAccount(dn, adAccountAttrs)
	if err != nil {
		return nil, nil, err
	}
	st := newAccountStatus(dn, models.ServerTypeAD, now)
	kind, ok := adAccountKind(attrs.all("objectClass"))
	if !ok {
		st.Reason = "Not an account: only users, computers and managed service accounts have an account status."
		return st, attrs, nil
	}
	pol, warn := r.adPolicy(dn, attrs.first("msDS-ResultantPSO"), cache)
	if warn != "" {
		st.Warnings = append(st.Warnings, warn)
	}
	computeADStatus(st, kind, attrs, pol, now)
	return st, attrs, nil
}

// adPolicy returns the effective policy of an account: its resultant PSO or
// the domain policy. A policy that cannot be read is returned with
// Readable false together with a warning.
func (r *accountReader) adPolicy(userDN, psoDN string, cache policyCache) (*models.AccountPolicy, string) {
	if psoDN != "" {
		key := strings.ToLower(psoDN)
		if pol, ok := cache[key]; ok {
			return pol, policyWarning(pol)
		}
		pol := &models.AccountPolicy{DN: psoDN, Name: rdnValue(psoDN), Source: models.PolicySourcePSO}
		a, err := r.readAccountEntry(psoDN, adPSOAttrs)
		if err == nil && a.has("msDS-LockoutThreshold") {
			fillADPolicy(pol, a, "msDS-LockoutDuration", "msDS-LockoutThreshold", "msDS-LockoutObservationWindow",
				"msDS-MaximumPasswordAge", "msDS-MinimumPasswordAge", "msDS-MinimumPasswordLength", "msDS-PasswordHistoryLength")
			fillADComplexity(pol, a, true)
		}
		cache[key] = pol
		return pol, policyWarning(pol)
	}
	domainDN := adDomainDN(userDN)
	if domainDN == "" {
		return nil, "The domain of the entry could not be determined, so the domain password policy is unknown."
	}
	key := strings.ToLower(domainDN)
	if pol, ok := cache[key]; ok {
		return pol, policyWarning(pol)
	}
	pol := &models.AccountPolicy{DN: domainDN, Name: "Domain password policy", Source: models.PolicySourceDomain}
	a, err := r.readAccountEntry(domainDN, adDomainPolicyAttrs)
	if err == nil && (a.has("lockoutDuration") || a.has("maxPwdAge")) {
		fillADPolicy(pol, a, "lockoutDuration", "lockoutThreshold", "lockOutObservationWindow",
			"maxPwdAge", "minPwdAge", "minPwdLength", "pwdHistoryLength")
		fillADComplexity(pol, a, false)
	}
	cache[key] = pol
	return pol, policyWarning(pol)
}

// policyWarning returns the warning for a policy that could not be read.
func policyWarning(pol *models.AccountPolicy) string {
	if pol == nil || pol.Readable {
		return ""
	}
	switch pol.Source {
	case models.PolicySourcePSO:
		return fmt.Sprintf("The password settings object %s is not readable with this connection; lockout end and password expiry may be incomplete.", pol.Name)
	case models.PolicySourceDomain:
		return "The domain password policy is not readable with this connection; lockout end and password expiry may be incomplete."
	}
	return fmt.Sprintf("The password policy %s is not readable with this connection.", pol.DN)
}

// fillADPolicy fills pol from AD policy attributes (domain or PSO names).
func fillADPolicy(pol *models.AccountPolicy, a accountAttrs, duration, threshold, window, maxAge, minAge, minLen, history string) {
	pol.Readable = true
	pol.LockoutThreshold = int(intAttr(a, threshold))
	pol.LockoutEnabled = pol.LockoutThreshold > 0
	pol.LockoutDurationSeconds = adIntervalSeconds(intAttr(a, duration))
	pol.ObservationWindowSeconds = adIntervalSeconds(intAttr(a, window))
	pol.MaxPasswordAgeSeconds = adIntervalSeconds(intAttr(a, maxAge))
	pol.MinPasswordAgeSeconds = adIntervalSeconds(intAttr(a, minAge))
	pol.MinPasswordLength = int(intAttr(a, minLen))
	pol.PasswordHistory = int(intAttr(a, history))
	pol.MustChangeEnforced = true
}

// computeADStatus fills st from the AD attributes of an account of the given
// kind and its effective policy (nil or unreadable when unknown).
//
// The DC's own view (msDS-User-Account-Control-Computed for lockout and
// expired password, msDS-UserPasswordExpiryTimeComputed for the expiry) wins
// over values computed from the policy; the policy is used for the end of a
// lockout and as fallback when the constructed attributes are missing.
func computeADStatus(st *models.AccountStatus, kind string, a accountAttrs, pol *models.AccountPolicy, now time.Time) {
	st.Applicable = true
	st.Kind = kind
	st.Policy = pol
	polKnown := pol != nil && pol.Readable

	uac, hasUAC := a.int64("userAccountControl")
	computed, hasComputed := a.int64("msDS-User-Account-Control-Computed")
	st.UserAccountControl = uac
	st.UserAccountControlComputed = computed

	// Enabled / disabled
	if hasUAC {
		if uac&uacAccountDisable != 0 {
			st.Enabled = false
			st.DisabledBy = "ACCOUNTDISABLE flag (0x2) in userAccountControl"
		}
	} else {
		st.Warnings = append(st.Warnings, "userAccountControl is not readable with this connection; the enabled state is unknown.")
		reason := "userAccountControl is not readable with this connection."
		st.Unsupported[models.AccountActionEnable] = reason
		st.Unsupported[models.AccountActionDisable] = reason
		st.Unsupported[models.AccountActionNeverExpires] = reason
		st.Unsupported[models.AccountActionUAC] = reason
	}

	// Lockout
	lockedAt, hasLockedAt := a.fileTime("lockoutTime")
	if hasLockedAt {
		st.LockedAt = isoTime(lockedAt)
	}
	switch {
	case hasComputed:
		st.Locked = computed&uacLockout != 0
	case hasLockedAt:
		// Fallback without the constructed attribute.
		if !polKnown {
			st.Locked = true
			st.Warnings = append(st.Warnings, "msDS-User-Account-Control-Computed is not available and the lockout duration is unknown; the account is shown as locked because lockoutTime is set.")
		} else {
			d := pol.LockoutDurationSeconds
			st.Locked = d == 0 || now.Before(lockedAt.Add(time.Duration(d)*time.Second))
		}
	}
	if st.Locked {
		switch {
		case polKnown && pol.LockoutDurationSeconds == 0:
			st.LockedPermanently = true
		case polKnown && hasLockedAt:
			until := lockedAt.Add(time.Duration(pol.LockoutDurationSeconds) * time.Second)
			if until.After(now) {
				st.LockedUntil = isoTime(until)
			}
		}
	} else if hasLockedAt {
		st.LockoutExpired = true
	}
	if v, ok := a.int64("badPwdCount"); ok {
		st.BadPasswordCount = int(v)
	}
	if t, ok := a.fileTime("badPasswordTime"); ok {
		st.LastBadPassword = isoTime(t)
	}

	// Password
	pwdLastSet, hasPwdLastSet := a.int64("pwdLastSet")
	if t, ok := fileTimeToTime(pwdLastSet); ok {
		st.PasswordLastSet = isoTime(t)
	}
	dontExpire := hasUAC && uac&uacDontExpirePassword != 0
	if hasPwdLastSet && pwdLastSet == 0 && kind == models.AccountKindUser {
		if dontExpire {
			st.Warnings = append(st.Warnings, "pwdLastSet is 0, but \"Password never expires\" is set, so the user is not asked to change the password.")
		} else {
			st.MustChangePassword = true
		}
	}
	expiryRaw, hasExpiry := a.int64("msDS-UserPasswordExpiryTimeComputed")
	switch {
	case kind == models.AccountKindComputer:
		st.PasswordNeverExpires = true
		st.PasswordExpiryNote = "Computer accounts change their password automatically."
	case kind == models.AccountKindServiceAccount:
		st.PasswordNeverExpires = true
		st.PasswordExpiryNote = "The password of a managed service account is changed by AD automatically."
	case dontExpire:
		st.PasswordNeverExpires = true
		st.PasswordExpiryNote = "DONT_EXPIRE_PASSWORD flag (password never expires) is set."
	case st.MustChangePassword:
		st.PasswordExpiryNote = "The password must be changed at the next logon."
	case hasExpiry && expiryRaw == fileTimeNever:
		st.PasswordNeverExpires = true
		st.PasswordExpiryNote = "The password policy has no maximum password age."
	case hasExpiry && expiryRaw > 0:
		t, _ := fileTimeToTime(expiryRaw)
		st.PasswordExpires = isoTime(t)
		st.PasswordExpired = !now.Before(t)
	case polKnown && pol.MaxPasswordAgeSeconds == 0:
		st.PasswordNeverExpires = true
		st.PasswordExpiryNote = "The password policy has no maximum password age."
	case polKnown && pwdLastSet > 0:
		last, _ := fileTimeToTime(pwdLastSet)
		t := last.Add(time.Duration(pol.MaxPasswordAgeSeconds) * time.Second)
		st.PasswordExpires = isoTime(t)
		st.PasswordExpired = !now.Before(t)
	default:
		st.PasswordExpiryNote = "The password expiry is unknown (policy or pwdLastSet not readable)."
	}
	if hasComputed && computed&uacPasswordExpired != 0 && !st.MustChangePassword && !st.PasswordNeverExpires {
		st.PasswordExpired = true
	}

	// Account expiration
	if t, ok := a.fileTime("accountExpires"); ok {
		st.AccountExpires = isoTime(t)
		st.AccountExpired = !now.Before(t)
	} else {
		st.AccountNeverExpires = true
	}

	// Logons and creation
	if t, ok := a.fileTime("lastLogon"); ok {
		st.LastLogon = isoTime(t)
	}
	if t, ok := a.fileTime("lastLogonTimestamp"); ok {
		st.LastLogonReplicated = isoTime(t)
	}
	if v, ok := a.int64("logonCount"); ok {
		st.LogonCount = int(v)
		st.HasLogonCount = true
	}
	if t, ok := a.generalizedTime("whenCreated"); ok {
		st.Created = isoTime(t)
	}

	// Actions that do not apply to the kind of account
	switch kind {
	case models.AccountKindComputer:
		st.Unsupported[models.AccountActionMustChange] = "Computer accounts change their password automatically."
		st.Unsupported[models.AccountActionNeverExpires] = "Computer accounts change their password automatically."
		st.Unsupported[models.AccountActionResetPassword] = "Setting a computer password by hand breaks the computer's secure channel; reset the computer account instead."
	case models.AccountKindServiceAccount:
		reason := "The password of a managed service account is managed by AD."
		st.Unsupported[models.AccountActionMustChange] = reason
		st.Unsupported[models.AccountActionNeverExpires] = reason
		st.Unsupported[models.AccountActionResetPassword] = reason
	}
	if !hasPwdLastSet {
		if _, ok := st.Unsupported[models.AccountActionMustChange]; !ok {
			st.Unsupported[models.AccountActionMustChange] = "pwdLastSet is not readable with this connection."
		}
	}
}

// planADChange returns the modify changes for ch on an AD account with the
// attributes a and status st.
//
// userAccountControl changes are sent as delete of the current value plus
// add of the new one: the server rejects them (noSuchAttribute) when the
// value changed in the meantime, so concurrent edits are never overwritten.
func planADChange(a accountAttrs, st *models.AccountStatus, ch AccountChange) ([]models.AttributeChange, error) {
	uac, hasUAC := a.int64("userAccountControl")
	swapUAC := func(newUAC int64, noop string) ([]models.AttributeChange, error) {
		if !hasUAC {
			return nil, errors.New("userAccountControl is not readable with this connection")
		}
		if newUAC == uac {
			return nil, errors.New(noop)
		}
		return []models.AttributeChange{
			{Operation: models.ChangeDelete, Attribute: "userAccountControl", Values: []string{strconv.FormatInt(uac, 10)}},
			{Operation: models.ChangeAdd, Attribute: "userAccountControl", Values: []string{strconv.FormatInt(newUAC, 10)}},
		}, nil
	}

	switch ch.Action {
	case models.AccountActionUnlock:
		lockoutTime, _ := a.int64("lockoutTime")
		if lockoutTime <= 0 && !st.Locked {
			return nil, errors.New("the account is not locked out")
		}
		return []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: "lockoutTime", Values: []string{"0"}}}, nil

	case models.AccountActionEnable:
		return swapUAC(uac&^uacAccountDisable, "the account is already enabled")

	case models.AccountActionDisable:
		return swapUAC(uac|uacAccountDisable, "the account is already disabled")

	case models.AccountActionNeverExpires:
		if ch.Set {
			return swapUAC(uac|uacDontExpirePassword, "\"Password never expires\" is already set")
		}
		return swapUAC(uac&^uacDontExpirePassword, "\"Password never expires\" is not set")

	case models.AccountActionMustChange:
		pwdLastSet, ok := a.int64("pwdLastSet")
		if !ok {
			return nil, errors.New("pwdLastSet is not readable with this connection")
		}
		if ch.Set {
			if hasUAC && uac&uacDontExpirePassword != 0 {
				return nil, errors.New("\"Password never expires\" is set, so AD would not ask for a new password; clear it first")
			}
			if pwdLastSet == 0 {
				return nil, errors.New("the user already has to change the password at the next logon")
			}
			return []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: "pwdLastSet", Values: []string{"0"}}}, nil
		}
		if pwdLastSet != 0 {
			return nil, errors.New("\"must change password at next logon\" is not set")
		}
		// -1 makes the DC store the current time.
		return []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: "pwdLastSet", Values: []string{"-1"}}}, nil

	case models.AccountActionAccountExpires:
		value := strconv.FormatInt(fileTimeNever, 10)
		if ch.Set {
			if ch.Expires.IsZero() {
				return nil, errors.New("no expiration date given")
			}
			value = strconv.FormatInt(timeToFileTime(ch.Expires), 10)
		} else if st.AccountNeverExpires {
			return nil, errors.New("the account has no expiration date")
		}
		return []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: "accountExpires", Values: []string{value}}}, nil

	case models.AccountActionUAC:
		if !hasUAC {
			return nil, errors.New("userAccountControl is not readable with this connection")
		}
		if uac != ch.ExpectedUAC {
			return nil, fmt.Errorf("%w (userAccountControl is now 0x%X, expected 0x%X)", ErrAccountConflict, uac, ch.ExpectedUAC)
		}
		if ch.UAC < 0 || ch.UAC > 0xFFFFFFFF {
			return nil, fmt.Errorf("invalid userAccountControl value %d", ch.UAC)
		}
		if changed := (uac ^ ch.UAC) & uacProtectedBits; changed != 0 {
			return nil, fmt.Errorf("flags 0x%X cannot be changed here (account type, computed or ACL based flags)", changed)
		}
		return swapUAC(ch.UAC, "userAccountControl is unchanged")
	}
	return nil, fmt.Errorf("unknown account action %q", ch.Action)
}
