package ldap

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// OpenLDAP ppolicy overlay (draft-behera-ldap-password-policy).
//
// Semantics implemented by OpenLDAP 2.4+ and mirrored here:
//   - The policy is the entry's pwdPolicySubentry, otherwise the overlay's
//     olcPPolicyDefault. Without a policy ppolicy ignores the entry.
//   - pwdAccountLockedTime locks the account when the policy has pwdLockout
//     TRUE: for pwdLockoutDuration seconds, or until an administrator removes
//     it when the duration is 0. The special value 000001010000Z locks the
//     account permanently; LDAPilot shows that as "disabled".
//   - pwdReset TRUE forces a password change after the next bind when the
//     policy has pwdMustChange TRUE.
//   - The password expires pwdMaxAge seconds after pwdChangedTime; without
//     pwdChangedTime (password set before ppolicy was active) it does not.

// ppolicyAccountAttrs are read for the OpenLDAP account status. Attributes
// of newer OpenLDAP versions (pwdLastSuccess, pwdEndTime) and of the lastbind
// overlay (authTimestamp) are ignored by servers that do not know them.
var ppolicyAccountAttrs = []string{
	"objectClass", "pwdAccountLockedTime", "pwdFailureTime", "pwdChangedTime",
	"pwdReset", "pwdPolicySubentry", "pwdGraceUseTime", "pwdLastSuccess",
	"authTimestamp", "pwdEndTime", "createTimestamp",
}

// ppolicyPolicyAttrs are the attributes of a pwdPolicy entry.
var ppolicyPolicyAttrs = []string{
	"cn", "pwdAttribute", "pwdLockout", "pwdLockoutDuration", "pwdMaxFailure", "pwdFailureCountInterval",
	"pwdMaxAge", "pwdMinAge", "pwdInHistory", "pwdMinLength", "pwdExpireWarning",
	"pwdGraceAuthNLimit", "pwdMustChange",
}

// ppolicyAccountStatus reads dn and its policy and computes the status.
func (r *accountReader) ppolicyAccountStatus(dn string, info *models.ServerInfo, now time.Time, cache policyCache) (*models.AccountStatus, accountAttrs, error) {
	attrs, err := r.readAccount(dn, ppolicyAccountAttrs)
	if err != nil {
		return nil, nil, err
	}
	st := newAccountStatus(dn, models.ServerTypeOpenLDAP, now)
	if !isGenericAccount(attrs.all("objectClass")) && !attrs.has("pwdAccountLockedTime") && !attrs.has("pwdChangedTime") {
		st.Reason = "Not an account: the entry has no person or account object class."
		return st, attrs, nil
	}
	pol, warn := r.ppolicyPolicy(dn, attrs.first("pwdPolicySubentry"), info, cache)
	switch {
	case warn == "":
	case pol != nil && pol.Source == models.PolicySourceAssumed:
		// Informational and the same for every account: not a warning.
		st.PolicyNote = warn
	default:
		st.Warnings = append(st.Warnings, warn)
	}
	computePPolicyStatus(st, attrs, pol, now)
	return st, attrs, nil
}

// ppolicyPolicy returns the effective policy of dn: its pwdPolicySubentry or
// the default policy of the overlay.
func (r *accountReader) ppolicyPolicy(dn, subentry string, info *models.ServerInfo, cache policyCache) (*models.AccountPolicy, string) {
	if subentry != "" {
		pol := r.readPPolicy(subentry, models.PolicySourceSubentry, cache)
		return pol, policyWarning(pol)
	}
	nc := namingContextOf(dn, info)
	key := "#ppolicy-default:" + strings.ToLower(nc)
	if pol, ok := cache[key]; ok {
		return pol, ppolicyDefaultWarning(pol)
	}
	defDN, source, note := r.ppolicyDefaultDN(nc)
	var pol *models.AccountPolicy
	switch {
	case defDN != "":
		pol = r.readPPolicy(defDN, source, cache)
	case source == models.PolicySourceNoPolicy:
		pol = &models.AccountPolicy{Name: "No password policy", Source: models.PolicySourceNoPolicy, Readable: true}
	default:
		pol = &models.AccountPolicy{Name: "Unknown", Source: models.PolicySourceUnknown}
	}
	if note != "" && pol.Source == models.PolicySourceUnknown {
		pol.Name = note
	}
	cache[key] = pol
	return pol, ppolicyDefaultWarning(pol)
}

func ppolicyDefaultWarning(pol *models.AccountPolicy) string {
	switch pol.Source {
	case models.PolicySourceUnknown:
		return "The default password policy could not be determined (cn=config is not readable and no single pwdPolicy entry was found); lock and expiry evaluation assumes lockout is enabled."
	case models.PolicySourceAssumed:
		return fmt.Sprintf("cn=config is not readable; %s is assumed to be the default password policy because it is the only pwdPolicy entry.", pol.DN)
	}
	return policyWarning(pol)
}

// ppolicyDefaultDN finds the default policy for the naming context nc:
// olcPPolicyDefault from cn=config when readable, otherwise the only
// pwdPolicy entry in nc. source is PolicySourceDefault, PolicySourceAssumed,
// PolicySourceNoPolicy (cn=config readable, no default policy) or
// PolicySourceUnknown.
func (r *accountReader) ppolicyDefaultDN(nc string) (dn, source, note string) {
	req := goldap.NewSearchRequest("cn=config", goldap.ScopeWholeSubtree, goldap.NeverDerefAliases,
		0, 0, false, "(objectClass=olcPPolicyConfig)", []string{"olcPPolicyDefault"}, nil)
	entries, err := r.configProbe(req)
	if err == nil && len(entries) > 0 {
		var defaults []string
		for _, e := range entries {
			defaults = append(defaults, e.GetAttributeValues("olcPPolicyDefault")...)
		}
		for _, d := range defaults {
			if nc == "" || isDNUnder(d, nc) {
				return d, models.PolicySourceDefault, ""
			}
		}
		if len(defaults) == 0 {
			return "", models.PolicySourceNoPolicy, ""
		}
		return defaults[0], models.PolicySourceDefault, ""
	}

	// cn=config not readable: look for pwdPolicy entries in the naming context.
	if nc == "" {
		return "", models.PolicySourceUnknown, ""
	}
	req = goldap.NewSearchRequest(nc, goldap.ScopeWholeSubtree, goldap.NeverDerefAliases,
		20, 0, false, "(objectClass=pwdPolicy)", []string{"1.1"}, nil)
	entries, err = r.search(req)
	if err != nil && !goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
		return "", models.PolicySourceUnknown, ""
	}
	switch len(entries) {
	case 0:
		return "", models.PolicySourceUnknown, ""
	case 1:
		return entries[0].DN, models.PolicySourceAssumed, ""
	}
	for _, e := range entries {
		if strings.Contains(strings.ToLower(rdnValue(e.DN)), "default") {
			return e.DN, models.PolicySourceAssumed, ""
		}
	}
	return "", models.PolicySourceUnknown, fmt.Sprintf("Unknown (%d pwdPolicy entries)", len(entries))
}

// readPPolicy reads a pwdPolicy entry (cached).
func (r *accountReader) readPPolicy(dn, source string, cache policyCache) *models.AccountPolicy {
	key := strings.ToLower(dn)
	if pol, ok := cache[key]; ok {
		cp := *pol
		cp.Source = source
		return &cp
	}
	pol := &models.AccountPolicy{DN: dn, Name: rdnValue(dn), Source: source}
	if a, err := r.readAccountEntry(dn, ppolicyPolicyAttrs); err == nil {
		fillPPolicy(pol, a)
	}
	cache[key] = pol
	return pol
}

// fillPPolicy fills pol from pwdPolicy attributes. An entry without any
// pwdPolicy attribute (not readable) stays unreadable.
func fillPPolicy(pol *models.AccountPolicy, a accountAttrs) {
	if !a.has("pwdAttribute") && !a.has("pwdLockout") && !a.has("pwdMaxAge") && !a.has("pwdMaxFailure") &&
		!a.has("pwdMustChange") && !a.has("pwdLockoutDuration") && !a.has("pwdMinLength") {
		return
	}
	pol.Readable = true
	pol.LockoutEnabled, _ = boolAttr(a, "pwdLockout")
	pol.LockoutThreshold = int(intAttr(a, "pwdMaxFailure"))
	pol.LockoutDurationSeconds = intAttr(a, "pwdLockoutDuration")
	pol.ObservationWindowSeconds = intAttr(a, "pwdFailureCountInterval")
	pol.MaxPasswordAgeSeconds = intAttr(a, "pwdMaxAge")
	pol.MinPasswordAgeSeconds = intAttr(a, "pwdMinAge")
	pol.MinPasswordLength = int(intAttr(a, "pwdMinLength"))
	pol.PasswordHistory = int(intAttr(a, "pwdInHistory"))
	pol.ExpireWarningSeconds = intAttr(a, "pwdExpireWarning")
	pol.GraceLogins = int(intAttr(a, "pwdGraceAuthNLimit"))
	pol.MustChangeEnforced, _ = boolAttr(a, "pwdMustChange")
}

// computePPolicyStatus fills st from the ppolicy attributes of an account and
// its effective policy.
func computePPolicyStatus(st *models.AccountStatus, a accountAttrs, pol *models.AccountPolicy, now time.Time) {
	st.Applicable = true
	st.Kind = models.AccountKindUser
	st.Policy = pol
	polKnown := pol != nil && pol.Readable
	noPolicy := pol != nil && pol.Source == models.PolicySourceNoPolicy
	// Lockout settings apply unless the policy is known to disable them.
	lockoutOn := !noPolicy && (!polKnown || pol.LockoutEnabled)

	// pwdAccountLockedTime: permanent lock (disabled) or failure lockout.
	if locked := strings.TrimSpace(a.first("pwdAccountLockedTime")); locked != "" {
		switch {
		case !lockoutOn:
			st.Warnings = append(st.Warnings, "pwdAccountLockedTime is set, but the effective policy does not enable lockout (pwdLockout), so OpenLDAP ignores it.")
		case locked == ppolicyPermanentLock:
			st.Enabled = false
			st.DisabledBy = "pwdAccountLockedTime 000001010000Z (permanent lock: disabled until enabled again)"
		default:
			t, err := parseGeneralizedTime(locked)
			if err != nil {
				// OpenLDAP treats an unparsable time as a permanent lock.
				st.Locked = true
				st.LockedPermanently = true
				break
			}
			st.LockedAt = isoTime(t)
			switch {
			case polKnown && pol.LockoutDurationSeconds > 0:
				until := t.Add(time.Duration(pol.LockoutDurationSeconds) * time.Second)
				if now.Before(until) {
					st.Locked = true
					st.LockedUntil = isoTime(until)
				} else {
					st.LockoutExpired = true
				}
			default:
				st.Locked = true
				st.LockedPermanently = polKnown
			}
		}
	}
	failures := a.all("pwdFailureTime")
	st.BadPasswordCount = len(failures)
	var lastFailure time.Time
	for _, f := range failures {
		if t, err := parseGeneralizedTime(f); err == nil && t.After(lastFailure) {
			lastFailure = t
		}
	}
	st.LastBadPassword = isoTime(lastFailure)
	if !st.Locked && st.Enabled && polKnown && pol.LockoutEnabled && pol.LockoutThreshold > 0 && st.BadPasswordCount >= pol.LockoutThreshold {
		st.Warnings = append(st.Warnings, fmt.Sprintf("pwdFailureTime still records %d failed binds, so the next failed bind locks the account again; a successful bind or a password reset clears them.", st.BadPasswordCount))
	}

	// Password
	changed, hasChanged := a.generalizedTime("pwdChangedTime")
	if hasChanged {
		st.PasswordLastSet = isoTime(changed)
	}
	if reset, _ := boolAttr(a, "pwdReset"); reset {
		if noPolicy || (polKnown && !pol.MustChangeEnforced) {
			st.Warnings = append(st.Warnings, "pwdReset is TRUE, but the effective policy does not have pwdMustChange TRUE, so OpenLDAP does not enforce the change.")
		} else {
			st.MustChangePassword = true
		}
	}
	switch {
	case noPolicy:
		st.PasswordNeverExpires = true
		st.PasswordExpiryNote = "No password policy applies to this entry."
	case !polKnown:
		if hasChanged {
			st.PasswordExpiryNote = "The password policy is not readable, so the expiry is unknown."
		} else {
			st.PasswordExpiryNote = "No pwdChangedTime is recorded; the expiry is unknown."
		}
	case pol.MaxPasswordAgeSeconds == 0:
		st.PasswordNeverExpires = true
		st.PasswordExpiryNote = "The password policy has no pwdMaxAge."
	case !hasChanged:
		st.PasswordNeverExpires = true
		st.PasswordExpiryNote = "No pwdChangedTime is recorded (password set before the policy was active), so OpenLDAP does not expire it until it is changed."
	default:
		t := changed.Add(time.Duration(pol.MaxPasswordAgeSeconds) * time.Second)
		st.PasswordExpires = isoTime(t)
		st.PasswordExpired = !now.Before(t)
	}

	// Account validity (OpenLDAP 2.5+ pwdEndTime)
	if t, ok := a.generalizedTime("pwdEndTime"); ok {
		st.AccountExpires = isoTime(t)
		st.AccountExpired = !now.Before(t)
	} else {
		st.AccountNeverExpires = true
	}

	if t, ok := a.generalizedTime("pwdLastSuccess"); ok {
		st.LastLogon = isoTime(t)
	} else if t, ok := a.generalizedTime("authTimestamp"); ok {
		st.LastLogon = isoTime(t)
	}
	if t, ok := a.generalizedTime("createTimestamp"); ok {
		st.Created = isoTime(t)
	}

	// Supported actions
	st.Unsupported[models.AccountActionNeverExpires] = "OpenLDAP ppolicy has no per-account \"password never expires\" flag; point pwdPolicySubentry to a policy without pwdMaxAge instead."
	st.Unsupported[models.AccountActionAccountExpires] = "OpenLDAP ppolicy has no account expiration date that can be set here."
	st.Unsupported[models.AccountActionUAC] = "userAccountControl exists only in Active Directory."
	switch {
	case noPolicy:
		reason := "No password policy applies to this entry, so OpenLDAP ignores pwdAccountLockedTime and pwdReset."
		st.Unsupported[models.AccountActionDisable] = reason
		st.Unsupported[models.AccountActionMustChange] = reason
	case polKnown && !pol.LockoutEnabled:
		st.Unsupported[models.AccountActionDisable] = "The password policy has pwdLockout FALSE, so OpenLDAP ignores pwdAccountLockedTime."
	}
	if polKnown && !pol.MustChangeEnforced {
		st.Unsupported[models.AccountActionMustChange] = "The password policy has pwdMustChange FALSE, so OpenLDAP ignores pwdReset."
	}
}

// planPPolicyChange returns the modify changes for ch on an OpenLDAP account.
// Deletes are only sent for attributes that exist, so the modify does not
// fail with noSuchAttribute.
func planPPolicyChange(a accountAttrs, st *models.AccountStatus, ch AccountChange) ([]models.AttributeChange, error) {
	locked := strings.TrimSpace(a.first("pwdAccountLockedTime"))
	removeLock := func() []models.AttributeChange {
		var changes []models.AttributeChange
		if locked != "" {
			changes = append(changes, models.AttributeChange{Operation: models.ChangeDelete, Attribute: "pwdAccountLockedTime", Values: []string{}})
		}
		if a.has("pwdFailureTime") {
			changes = append(changes, models.AttributeChange{Operation: models.ChangeDelete, Attribute: "pwdFailureTime", Values: []string{}})
		}
		return changes
	}

	switch ch.Action {
	case models.AccountActionUnlock:
		if locked == ppolicyPermanentLock {
			return nil, errors.New("the account is disabled (permanently locked); enable it instead")
		}
		changes := removeLock()
		if len(changes) == 0 {
			return nil, errors.New("the account is not locked out")
		}
		return changes, nil

	case models.AccountActionEnable:
		if locked == "" {
			return nil, errors.New("the account is already enabled")
		}
		return removeLock(), nil

	case models.AccountActionDisable:
		if locked == ppolicyPermanentLock {
			return nil, errors.New("the account is already disabled")
		}
		return []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: "pwdAccountLockedTime", Values: []string{ppolicyPermanentLock}}}, nil

	case models.AccountActionMustChange:
		reset, _ := boolAttr(a, "pwdReset")
		if ch.Set {
			if reset {
				return nil, errors.New("pwdReset is already TRUE")
			}
			return []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: "pwdReset", Values: []string{"TRUE"}}}, nil
		}
		if !a.has("pwdReset") {
			return nil, errors.New("\"must change password\" (pwdReset) is not set")
		}
		return []models.AttributeChange{{Operation: models.ChangeDelete, Attribute: "pwdReset", Values: []string{}}}, nil
	}
	return nil, fmt.Errorf("the action %q is not supported on OpenLDAP", ch.Action)
}
