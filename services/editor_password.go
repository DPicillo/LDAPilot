package services

import (
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// passwordStateAttrs are read for GetPasswordContext and SetPassword: the
// object classes, the stored userPassword (only its scheme is used) and the
// AD/ppolicy account state. Operational and constructed attributes have to
// be named explicitly.
var passwordStateAttrs = []string{
	"objectClass", "userPassword",
	// Names for the strength meter's "contains the account name" check
	"sAMAccountName", "uid", "cn", "givenName", "sn", "displayName",
	// AD
	"pwdLastSet", "lockoutTime", "userAccountControl", "msDS-User-Account-Control-Computed",
	// OpenLDAP ppolicy
	"pwdReset", "pwdAccountLockedTime", "pwdFailureTime",
}

// AD userAccountControl / msDS-User-Account-Control-Computed flags.
const (
	uacAccountDisable     = 0x0002
	uacLockout            = 0x0010
	uacDontExpirePassword = 0x10000
	uacPasswordExpired    = 0x800000 // msDS-User-Account-Control-Computed only
)

// GetPasswordContext describes the server and the entry dn for the password
// dialog: server type, TLS, Password Modify and ppolicy support, the scheme
// of the stored userPassword and the account state (locked, must change,
// disabled), plus the catalog of client-side hashing schemes.
func (s *EditorService) GetPasswordContext(profileID string, dn string) (*models.PasswordContext, error) {
	if dn == "" {
		return nil, fmt.Errorf("DN must not be empty")
	}
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	info, err := client.ServerInfo()
	if err != nil {
		return nil, err
	}
	// One read of the entry (RW1-P-06 d): the dialog's password state comes
	// with the account status read; its policy from the shared cache.
	st, entry, err := client.AccountStatusAndEntry(dn, passwordStateAttrs...)
	if err != nil {
		return nil, err
	}
	if entry == nil {
		// Server type without an account status.
		if entry, err = readPasswordState(client, dn); err != nil {
			return nil, err
		}
	}
	profile := client.Profile()
	pc := &models.PasswordContext{
		DN:                 dn,
		ServerType:         info.ServerType,
		VendorName:         info.VendorName,
		VendorVersion:      info.VendorVersion,
		TLS:                profile.TLSMode == models.TLSSSL || profile.TLSMode == models.TLSStartTLS,
		TLSMode:            string(profile.TLSMode),
		PasswordModifyExop: slices.Contains(info.SupportedExtensions, ldap.OIDPasswordModify),
		PPolicyControl:     slices.Contains(info.SupportedControls, ldap.OIDPasswordPolicyControl),
		ReadOnly:           profile.ReadOnly,
		Schemes:            ldap.PasswordSchemes(),
		DefaultScheme:      ldap.DefaultPasswordScheme,
	}
	// The connection's password storage policy decides the preselection.
	if eff, err := client.PasswordPolicy(); err == nil {
		pc.Policy = *eff
		if eff.Policy == models.PasswordPolicyClient && eff.Scheme != "" {
			pc.DefaultScheme = eff.Scheme
		}
	}
	applyPasswordState(pc, entry)
	// The account policy (requirements, OpenLDAP pwdMustChange) and the
	// 389DS lock/disabled state come from the account status.
	if st != nil && st.Applicable {
		pc.AccountPolicy = st.Policy
		if pc.ServerType == models.ServerType389DS {
			pc.Disabled = !st.Enabled
			pc.Locked = st.Locked
			pc.MustChange = pc.MustChange || st.MustChangePassword
		}
	}
	return pc, nil
}

// passwordTransportError refuses a reset before anything is sent: unicodePwd
// without TLS always (Active Directory and AD LDS reject it, so the
// cleartext password would cross the network for nothing), any other reset
// that sends the cleartext password over a connection without TLS unless
// req.AllowUnencrypted confirms it.
func passwordTransportError(req models.PasswordChangeRequest, tls bool) error {
	if tls {
		return nil
	}
	if req.Method == models.PasswordMethodUnicodePwd {
		return fmt.Errorf("%w: Active Directory accepts password resets (unicodePwd) only over LDAPS or StartTLS, so the password was not sent; reconnect with StartTLS or LDAPS", ldap.ErrPasswordNeedsTLS)
	}
	if passwordChangeSendsCleartext(req) && !req.AllowUnencrypted {
		return fmt.Errorf("%w: this reset sends the password in cleartext (%s) and the connection has no LDAPS/StartTLS; confirm it or connect with TLS", ldap.ErrPasswordUnencrypted, describePasswordTransport(req))
	}
	return nil
}

// passwordChangeSendsCleartext reports whether a password reset sends the
// cleartext password to the server: unicodePwd, Password Modify, a
// cleartext userPassword or the verification bind.
func passwordChangeSendsCleartext(req models.PasswordChangeRequest) bool {
	switch {
	case req.VerifyBind, req.Method == models.PasswordMethodUnicodePwd, req.Method == models.PasswordMethodExop:
		return true
	case req.Method == models.PasswordMethodUserPassword:
		return strings.EqualFold(req.Scheme, ldap.SchemeCleartext)
	}
	return false
}

// SetPassword resets the password of req.DN with req.Method and applies
// req.MustChange and req.Unlock, in the same modify request where the method
// allows it:
//   - "unicodePwd" (AD): replace unicodePwd, pwdLastSet=0, lockoutTime=0 in
//     one request.
//   - "userPassword": replace userPassword with the req.Scheme hash computed
//     here (or cleartext); OpenLDAP ppolicy: pwdReset=TRUE in the same
//     request.
//   - "exop": RFC 3062 Password Modify, the server hashes; pwdReset follows
//     in a second modify.
//
// Unlock on OpenLDAP relies on the ppolicy overlay, which clears
// pwdAccountLockedTime and pwdFailureTime on every password change; a lock
// that survives is removed afterwards. On 389DS an administrator reset
// clears the lockout itself, and its policy (passwordMustChange) decides
// about a forced change, so MustChange is rejected there.
//
// Afterwards the stored scheme is read back and with req.VerifyBind a bind
// as req.DN proves the new password. A server that hashes cleartext values
// (OpenLDAP ppolicy olcPPolicyHashCleartext, 389DS) re-hashes a "{X}..."
// value of a scheme it does not know, which makes the result Ineffective;
// other servers store it verbatim, so a scheme that is not built into the
// server type stays Unconfirmed unless the verification bind succeeds (see
// assessPassword). On AD, pwdLastSet=0 with DONT_EXPIRE_PASSWORD is reported
// as MustChangeIgnored. The change is audited without the password.
//
// The dialog's method and scheme are this write's decision (the
// connection's password storage policy only preselects them, see
// GetPasswordContext), so the value is written as given. A reset that sends
// the cleartext password (passwordChangeSendsCleartext) over a connection
// without TLS is refused unless req.AllowUnencrypted confirms it.
func (s *EditorService) SetPassword(profileID string, req models.PasswordChangeRequest) (*models.PasswordChangeResult, error) {
	if req.DN == "" {
		return nil, fmt.Errorf("DN must not be empty")
	}
	if req.Password == "" {
		return nil, fmt.Errorf("the new password must not be empty")
	}
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return nil, err
	}
	audit := func(op, dn, details string, err error) { s.audit(profileID, op, dn, details, err) }
	return resetPassword(client, req, audit, true)
}

// resetPassword is SetPassword's write path on a writable client, shared
// with the AI's reset_password tool (services/ai_delegates.go). audit
// records the reset itself (only with auditReset: the AI executor audits
// the reset "via AI" on its own) and the follow-up writes (re-lock of a
// disabled OpenLDAP account, unlock after the reset).
func resetPassword(client *ldap.Client, req models.PasswordChangeRequest, audit func(op, dn, details string, err error), auditReset bool) (*models.PasswordChangeResult, error) {
	if req.DN == "" || req.Password == "" {
		return nil, fmt.Errorf("DN and password must not be empty")
	}
	if err := client.CheckWritable(); err != nil {
		return nil, err
	}
	profile := client.Profile()
	tls := profile.TLSMode == models.TLSSSL || profile.TLSMode == models.TLSStartTLS
	// Before anything else talks to the server about this reset.
	if err := passwordTransportError(req, tls); err != nil {
		return nil, err
	}
	info, err := client.ServerInfo()
	if err != nil {
		return nil, err
	}
	ppolicy := slices.Contains(info.SupportedControls, ldap.OIDPasswordPolicyControl)
	// OpenLDAP: the ppolicy overlay clears the permanent lock (disabled)
	// with the password change; "enable" means not setting it again.
	if req.Enable && info.ServerType == models.ServerTypeOpenLDAP && ppolicy {
		req.Unlock = true
	}
	if req.Method == models.PasswordMethodExop && !slices.Contains(info.SupportedExtensions, ldap.OIDPasswordModify) {
		return nil, fmt.Errorf("the server does not announce the Password Modify extended operation (%s); choose client-side hashing", ldap.OIDPasswordModify)
	}
	accountChanges, err := passwordAccountChanges(info.ServerType, ppolicy, req)
	if err != nil {
		return nil, err
	}
	pwdChange, err := passwordValueChange(req)
	if err != nil {
		return nil, err
	}
	// AD / 389DS: enable the account in the same request (planned by the
	// account track, e.g. AD userAccountControl delete-old + add-new).
	var enableChanges []models.AttributeChange
	if req.Enable && info.ServerType != models.ServerTypeOpenLDAP {
		enableChanges, err = client.PlanAccountChange(req.DN, ldap.AccountChange{Action: models.AccountActionEnable})
		if err != nil {
			return nil, fmt.Errorf("the account cannot be enabled (%w); nothing was changed", err)
		}
		accountChanges = append(accountChanges, enableChanges...)
	}
	unlockOpenLDAP := req.Unlock && info.ServerType == models.ServerTypeOpenLDAP
	lockedBefore, disabledBefore := false, false
	if unlockOpenLDAP {
		entry, err := readPasswordState(client, req.DN)
		if err != nil {
			return nil, err
		}
		lock := entry.GetEqualFoldAttributeValue("pwdAccountLockedTime")
		lockedBefore = lock != ""
		disabledBefore = lock == ldap.PPolicyPermanentLock
	}
	// ppolicy clears pwdAccountLockedTime on every password change, which
	// would silently enable an account disabled with the permanent lock
	// (account panel); unless Unlock is ticked it is set again afterwards.
	guard := &ldap.PermanentLockGuard{}
	if !req.Unlock {
		guard = client.GuardPasswordChange(req.DN)
	}

	result := &models.PasswordChangeResult{Method: req.Method, Operations: []string{}, Warnings: []string{}}
	if req.Method == models.PasswordMethodUserPassword {
		result.Scheme = strings.ToUpper(req.Scheme)
	}
	// The dialog's method and scheme are the decision for this write: the
	// connection's storage policy only preselects them.
	asIs := models.PasswordWriteOptions{AsIs: true, AllowUnencrypted: true}

	var opErr error
	var applied []models.AttributeChange
	if pwdChange == nil { // exop
		opErr = client.PasswordModify(req.DN, req.Password)
		if opErr == nil {
			result.Operations = append(result.Operations, "Password Modify extended operation (RFC 3062)")
			if len(accountChanges) > 0 {
				opErr = client.ModifyEntry(req.DN, accountChanges)
				if opErr != nil {
					opErr = fmt.Errorf("the password was changed, but the account options failed: %w", opErr)
				} else {
					applied = accountChanges
				}
			}
		}
	} else {
		changes := append([]models.AttributeChange{*pwdChange}, accountChanges...)
		_, opErr = client.ModifyEntryWithPasswordPolicy(req.DN, changes, asIs)
		if opErr == nil {
			applied = changes
		}
	}
	if auditReset {
		audit("MODIFY", req.DN, describePasswordChangeForAudit(req, pwdChange, accountChanges), opErr)
	}
	if opErr != nil {
		hintServer := info.ServerType
		if req.Method == models.PasswordMethodUnicodePwd {
			// AD LDS and other unicodePwd servers share AD's error semantics.
			hintServer = models.ServerTypeAD
		}
		return nil, passwordErrorHint(hintServer, tls, opErr)
	}
	for _, ch := range applied {
		result.Operations = append(result.Operations, describePasswordOperation(ch))
	}
	if len(enableChanges) > 0 && len(applied) > 0 {
		result.Operations = append(result.Operations, "account enabled")
	}

	// The account stays disabled (and the verification bind is skipped)
	// unless re-locking it failed.
	keptDisabled := guard.Disabled()
	note, relockErr := keepAccountDisabled(guard, audit, req.DN, "password reset")
	switch {
	case relockErr != nil:
		keptDisabled = false
		result.Warnings = append(result.Warnings, "The ppolicy overlay cleared the permanent lock with the reset, so the disabled account is now enabled; disabling it again failed: "+errors.Unwrap(relockErr).Error())
	case note != "":
		result.Operations = append(result.Operations, "account kept disabled (permanent ppolicy lock set again after the reset)")
	}

	adMustChange := req.MustChange && info.ServerType == models.ServerTypeAD
	var after *goldap.Entry
	if req.Method != models.PasswordMethodUnicodePwd || unlockOpenLDAP || adMustChange {
		after, _ = readPasswordState(client, req.DN)
	}
	if unlockOpenLDAP {
		switch {
		case after != nil && after.GetEqualFoldAttributeValue("pwdAccountLockedTime") != "":
			unlock := []models.AttributeChange{{Operation: models.ChangeDelete, Attribute: "pwdAccountLockedTime"}}
			err := client.ModifyEntry(req.DN, unlock)
			audit("MODIFY", req.DN, "unlock after password reset: "+describeChangesForAudit(unlock), err)
			if err != nil {
				result.Warnings = append(result.Warnings, "The password was changed, but the account is still locked: "+err.Error())
			} else {
				result.Operations = append(result.Operations, "delete pwdAccountLockedTime")
				if disabledBefore {
					result.Operations = append(result.Operations, "account enabled")
				}
			}
		case disabledBefore:
			result.Operations = append(result.Operations, "account enabled (the ppolicy overlay cleared the permanent lock)")
		case lockedBefore:
			result.Operations = append(result.Operations, "lockout cleared by the ppolicy overlay (pwdAccountLockedTime, pwdFailureTime)")
		}
	}
	if req.Unlock && info.ServerType == models.ServerType389DS {
		result.Operations = append(result.Operations, "lockout cleared by the administrator reset (389DS resets passwordRetryCount)")
	}

	if adMustChange && after != nil && uacFlags(after, "userAccountControl")&uacDontExpirePassword != 0 {
		result.MustChangeIgnored = true
		result.Warnings = append(result.Warnings, "pwdLastSet=0 was written, but the account has \"Password never expires\" set (userAccountControl DONT_EXPIRE_PASSWORD), so Active Directory does not ask the user to change the password at the next logon.")
	}
	// Report what the server stored.
	if req.Method != models.PasswordMethodUnicodePwd && after != nil {
		if v := after.GetEqualFoldAttributeValue("userPassword"); v != "" {
			result.StoredScheme = ldap.PasswordSchemeOf(v)
			result.StoredSchemeLabel = ldap.PasswordSchemeLabel(v)
		}
	}

	if req.VerifyBind && keptDisabled {
		result.Operations = append(result.Operations, "verification bind skipped: the account is disabled")
	} else if req.VerifyBind {
		check, err := client.CheckBind(req.DN, req.Password)
		if err != nil {
			result.VerifyError = err.Error()
		} else {
			result.Verified = true
			if check.Detail != "" {
				result.Operations = append(result.Operations, "verification bind: "+check.Detail)
			}
		}
	}
	a := assessPassword(info.ServerType, req, result.StoredScheme, result.StoredSchemeLabel, result.Verified, result.VerifyError != "")
	result.Warnings = append(result.Warnings, a.warnings...)
	result.Ineffective = a.ineffective
	result.Unconfirmed = a.unconfirmed
	return result, nil
}

// describePasswordTransport names what sends the cleartext password.
func describePasswordTransport(req models.PasswordChangeRequest) string {
	var parts []string
	switch req.Method {
	case models.PasswordMethodUnicodePwd:
		parts = append(parts, "unicodePwd")
	case models.PasswordMethodExop:
		parts = append(parts, "Password Modify extended operation")
	case models.PasswordMethodUserPassword:
		if strings.EqualFold(req.Scheme, ldap.SchemeCleartext) {
			parts = append(parts, "cleartext userPassword")
		}
	}
	if req.VerifyBind {
		parts = append(parts, "verification bind")
	}
	return strings.Join(parts, ", ")
}

// uacFlags parses the userAccountControl-style integer attribute attr of
// entry (0 when absent).
func uacFlags(entry *goldap.Entry, attr string) int64 {
	v, _ := strconv.ParseInt(entry.GetEqualFoldAttributeValue(attr), 10, 64)
	return v
}

// readPasswordState reads passwordStateAttrs of dn.
func readPasswordState(client *ldap.Client, dn string) (*goldap.Entry, error) {
	req := goldap.NewSearchRequest(dn, goldap.ScopeBaseObject, goldap.NeverDerefAliases, 1, 0, false,
		"(objectClass=*)", passwordStateAttrs, nil)
	entries, err := client.SearchWithControls(req, 0)
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("entry %s not found", dn)
	}
	return entries[0], nil
}

// applyPasswordState fills the entry-dependent fields of pc from entry.
func applyPasswordState(pc *models.PasswordContext, entry *goldap.Entry) {
	pc.ObjectClasses = entry.GetEqualFoldAttributeValues("objectClass")
	if pc.ObjectClasses == nil {
		pc.ObjectClasses = []string{}
	}
	pc.AccountNames = []string{}
	for _, attr := range []string{"sAMAccountName", "uid", "cn", "givenName", "sn", "displayName"} {
		for _, v := range entry.GetEqualFoldAttributeValues(attr) {
			if v = strings.TrimSpace(v); v != "" && !slices.Contains(pc.AccountNames, v) {
				pc.AccountNames = append(pc.AccountNames, v)
			}
		}
	}
	if v := entry.GetEqualFoldAttributeValue("userPassword"); v != "" {
		pc.HasUserPassword = true
		pc.CurrentScheme = ldap.PasswordSchemeOf(v)
		pc.CurrentSchemeLabel = ldap.PasswordSchemeLabel(v)
	}
	if pc.ServerType == models.ServerTypeAD {
		for _, oc := range pc.ObjectClasses {
			if strings.EqualFold(oc, "user") || strings.EqualFold(oc, "computer") || strings.EqualFold(oc, "inetOrgPerson") {
				pc.IsADAccount = true
			}
		}
		uac := uacFlags(entry, "userAccountControl")
		pc.Disabled = uac&uacAccountDisable != 0
		pc.PasswordNeverExpires = uac&uacDontExpirePassword != 0
		if entry.GetEqualFoldAttributeValue("msDS-User-Account-Control-Computed") != "" {
			// The constructed flags reflect what AD enforces: no
			// PASSWORD_EXPIRED for pwdLastSet=0 when the password never
			// expires, no LOCKOUT once the lockout duration has passed.
			computed := uacFlags(entry, "msDS-User-Account-Control-Computed")
			pc.Locked = computed&uacLockout != 0
			pc.MustChange = computed&uacPasswordExpired != 0
		} else {
			lockout := entry.GetEqualFoldAttributeValue("lockoutTime")
			pc.Locked = lockout != "" && lockout != "0"
			pc.MustChange = entry.GetEqualFoldAttributeValue("pwdLastSet") == "0" && !pc.PasswordNeverExpires
		}
		return
	}
	pc.MustChange = strings.EqualFold(entry.GetEqualFoldAttributeValue("pwdReset"), "TRUE")
	// The permanent ppolicy lock is what the account panel writes to disable
	// an OpenLDAP account (internal/ldap/account_ppolicy.go): report it as
	// disabled, not as a lockout to clear.
	lockedTime := entry.GetEqualFoldAttributeValue("pwdAccountLockedTime")
	pc.Disabled = lockedTime == ldap.PPolicyPermanentLock
	pc.Locked = lockedTime != "" && !pc.Disabled
}

// passwordValueChange returns the modify change that stores the password
// for req.Method, or nil for the extended operation.
func passwordValueChange(req models.PasswordChangeRequest) (*models.AttributeChange, error) {
	switch req.Method {
	case models.PasswordMethodUnicodePwd:
		// The LDAP layer encodes the plain-text value as quoted UTF-16LE.
		return &models.AttributeChange{Operation: models.ChangeReplace, Attribute: "unicodePwd", Values: []string{req.Password}}, nil
	case models.PasswordMethodUserPassword:
		if req.Scheme == "" {
			return nil, fmt.Errorf("no hashing scheme selected")
		}
		value, err := ldap.HashPassword(req.Scheme, req.Password)
		if err != nil {
			return nil, err
		}
		return &models.AttributeChange{Operation: models.ChangeReplace, Attribute: "userPassword", Values: []string{value}}, nil
	case models.PasswordMethodExop:
		return nil, nil
	}
	return nil, fmt.Errorf("unknown password method %q", req.Method)
}

// passwordAccountChanges returns the modify changes for req.MustChange and
// req.Unlock on a server of serverType (see SetPassword).
func passwordAccountChanges(serverType string, ppolicy bool, req models.PasswordChangeRequest) ([]models.AttributeChange, error) {
	if !req.MustChange && !req.Unlock {
		return nil, nil
	}
	var changes []models.AttributeChange
	switch serverType {
	case models.ServerTypeAD:
		if req.MustChange {
			changes = append(changes, models.AttributeChange{Operation: models.ChangeReplace, Attribute: "pwdLastSet", Values: []string{"0"}})
		}
		if req.Unlock {
			changes = append(changes, models.AttributeChange{Operation: models.ChangeReplace, Attribute: "lockoutTime", Values: []string{"0"}})
		}
		return changes, nil
	case models.ServerTypeOpenLDAP:
		if !ppolicy {
			return nil, fmt.Errorf("the server does not announce the password policy control (%s): \"must change\" and \"unlock\" need the ppolicy overlay", ldap.OIDPasswordPolicyControl)
		}
		if req.MustChange {
			changes = append(changes, models.AttributeChange{Operation: models.ChangeReplace, Attribute: "pwdReset", Values: []string{"TRUE"}})
		}
		// Unlock: the overlay clears the lockout on the password change.
		return changes, nil
	case models.ServerType389DS:
		if req.MustChange {
			return nil, errors.New("on 389 Directory Server the password policy (passwordMustChange) decides whether the user must change the password after a reset")
		}
		// Unlock: an administrator reset clears the lockout.
		return nil, nil
	}
	return nil, fmt.Errorf("\"must change\" and \"unlock\" are only supported for Active Directory, OpenLDAP (ppolicy) and 389DS")
}

// passwordAssessment is what SetPassword concludes about a written
// password.
type passwordAssessment struct {
	warnings []string
	// ineffective: the new password most likely does not work.
	ineffective bool
	// unconfirmed: nothing proves that the server can verify the value.
	unconfirmed bool
}

// assessPassword judges a password written with req on a server of
// serverType from the scheme stored afterwards ("" when unreadable) and the
// verification bind (verified / verifyFailed; both false without one):
//   - a failed verification bind makes the result ineffective;
//   - userPassword on AD only works with fUserPwdSupport, and a hashed value
//     never (the hash string itself becomes the password);
//   - a stored scheme other than the hashed one sent means the server
//     re-hashed the "{X}..." string as cleartext: ineffective;
//   - cleartext storage is only reported;
//   - a hashed scheme that is not built into serverType (module needed or
//     unknown) is unconfirmed unless the bind proved it, one the server
//     type does not support at all is ineffective. A server without
//     cleartext hashing stores such a value verbatim, so the read-back alone
//     proves nothing.
//
// storedLabel is the display form of stored (ldap.PasswordSchemeLabel); ""
// shows it as "{stored}".
func assessPassword(serverType string, req models.PasswordChangeRequest, stored, storedLabel string, verified, verifyFailed bool) passwordAssessment {
	if storedLabel == "" {
		storedLabel = "{" + stored + "}"
	}
	var a passwordAssessment
	if req.Method == models.PasswordMethodUnicodePwd {
		a.ineffective = verifyFailed
		return a
	}
	hashed := req.Method == models.PasswordMethodUserPassword && !strings.EqualFold(req.Scheme, ldap.SchemeCleartext)

	if serverType == models.ServerTypeAD && req.Method == models.PasswordMethodUserPassword {
		w := "Active Directory treats userPassword as the account password only when dSHeuristics enables fUserPwdSupport; otherwise it is stored as an ordinary attribute and the logon password is unchanged. Use unicodePwd."
		if hashed {
			w += " A hashed value is never usable as an AD password: with fUserPwdSupport the hash itself becomes the password."
			a.ineffective = true
		} else if !verified {
			a.unconfirmed = true
		}
		a.warnings = append(a.warnings, w)
	}

	switch {
	case stored == "":
	case stored == ldap.SchemeCleartext:
		a.warnings = append(a.warnings, "The server stored the password in cleartext. Prefer a hashing scheme or server-side hashing.")
	case hashed && !strings.EqualFold(req.Scheme, stored):
		a.warnings = append(a.warnings, fmt.Sprintf(
			"The server stored %s instead of the {%s} value that was sent. It probably does not support {%s} (or does not accept pre-hashed values from this account) and hashed the value as if it were a cleartext password, so the new password will NOT work. Use server-side hashing or a scheme the server supports.",
			storedLabel, schemePrefix(req.Scheme), schemePrefix(req.Scheme)))
		a.ineffective = true
	}

	if hashed && serverType != models.ServerTypeAD && !a.ineffective && !verified {
		level, note := schemeSupportOn(req.Scheme, serverType)
		switch level {
		case models.SchemeSupportNative:
		case models.SchemeSupportNone:
			a.warnings = append(a.warnings, fmt.Sprintf("This server type does not support {%s} (%s): the new password will not work.", schemePrefix(req.Scheme), note))
			a.ineffective = true
		default:
			why := "its support on this server type is unknown"
			switch level {
			case models.SchemeSupportModule:
				why = "it " + note
			case models.SchemeSupportSystem:
				why = "it is " + note
			}
			a.warnings = append(a.warnings, fmt.Sprintf(
				"Support of {%s} is not confirmed: %s. A server that cannot verify the scheme may still store the value as sent, so the write alone proves nothing; enable \"Verify\" (bind with the new password) to make sure it works.",
				schemePrefix(req.Scheme), why))
			a.unconfirmed = true
		}
	}

	if verifyFailed {
		a.ineffective = true
	}
	return a
}

// schemeSupportOn returns the catalog support level and note of scheme on
// serverType; "" when the catalog has no entry.
func schemeSupportOn(scheme, serverType string) (level, note string) {
	for _, s := range ldap.PasswordSchemes() {
		if !strings.EqualFold(s.ID, scheme) {
			continue
		}
		for _, sup := range s.Support {
			if sup.Server == serverType {
				return sup.Level, sup.Note
			}
		}
	}
	return "", ""
}

// schemePrefix returns the brace name of a scheme ID ("CRYPT" for the
// SHA-crypt variants).
func schemePrefix(scheme string) string {
	s := strings.ToUpper(scheme)
	if strings.HasPrefix(s, "CRYPT-") {
		return "CRYPT"
	}
	return s
}

// describePasswordOperation renders a change for PasswordChangeResult
// without password values.
func describePasswordOperation(ch models.AttributeChange) string {
	if isSensitiveAttribute(ch.Attribute) || len(ch.Values) == 0 {
		return ch.Operation + " " + ch.Attribute
	}
	return ch.Operation + " " + ch.Attribute + "=" + strings.Join(ch.Values, ",")
}

// describePasswordChangeForAudit summarizes a password reset for the audit
// log; password values are masked.
func describePasswordChangeForAudit(req models.PasswordChangeRequest, pwdChange *models.AttributeChange, accountChanges []models.AttributeChange) string {
	var b strings.Builder
	b.WriteString("password reset via ")
	switch req.Method {
	case models.PasswordMethodExop:
		b.WriteString("Password Modify extended operation")
	case models.PasswordMethodUserPassword:
		b.WriteString("userPassword " + passwordSchemeAuditLabel(req.Scheme))
	default:
		b.WriteString(req.Method)
	}
	var changes []models.AttributeChange
	if pwdChange != nil {
		changes = append(changes, *pwdChange)
	}
	changes = append(changes, accountChanges...)
	if len(changes) > 0 {
		b.WriteString(": " + describeChangesForAudit(changes))
	}
	return b.String()
}

// passwordSchemeAuditLabel names a client-side scheme for the audit log
// like the stored scheme is shown: the catalog label for the crypt(3)
// variants, whose ids (CRYPT-SHA512, …) are internal and never a stored tag
// ("{CRYPT} SHA-512-crypt ($6$)"), "cleartext" for CLEARTEXT, else the tag
// ("{SSHA}").
func passwordSchemeAuditLabel(scheme string) string {
	up := strings.ToUpper(strings.TrimSpace(scheme))
	switch {
	case up == ldap.SchemeCleartext:
		return "cleartext"
	case strings.HasPrefix(up, "CRYPT-"):
		if l := ldap.SchemeLabel(up); l != "" {
			return l
		}
	}
	return "{" + up + "}"
}

// passwordErrorHint adds an explanation to common password reset errors.
func passwordErrorHint(serverType string, tls bool, err error) error {
	var hint string
	switch {
	case serverType == models.ServerTypeAD && !tls && goldap.IsErrorWithCode(err, goldap.LDAPResultUnwillingToPerform):
		hint = "Active Directory only accepts password resets over an encrypted connection; connect with LDAPS (port 636) or StartTLS"
	case goldap.IsErrorWithCode(err, goldap.LDAPResultConfidentialityRequired):
		hint = "the server only accepts this password change over an encrypted connection; connect with LDAPS or StartTLS"
	case serverType == models.ServerTypeAD && goldap.IsErrorWithCode(err, goldap.LDAPResultConstraintViolation):
		hint = "the password does not meet the domain password policy (minimum length, complexity, history)"
	case goldap.IsErrorWithCode(err, goldap.LDAPResultInsufficientAccessRights):
		hint = "the bind account is not allowed to reset this password"
	}
	if hint == "" {
		return err
	}
	return fmt.Errorf("%w (hint: %s)", err, hint)
}
