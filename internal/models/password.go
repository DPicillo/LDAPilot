package models

// Password change methods for PasswordChangeRequest.Method.
const (
	// PasswordMethodUnicodePwd resets an Active Directory password by
	// replacing unicodePwd (the plain-text value is encoded as quoted
	// UTF-16LE by the LDAP layer).
	PasswordMethodUnicodePwd = "unicodePwd"
	// PasswordMethodExop uses the Password Modify extended operation
	// (RFC 3062, OID 1.3.6.1.4.1.4203.1.11.1); the server hashes the
	// password according to its own policy.
	PasswordMethodExop = "exop"
	// PasswordMethodUserPassword replaces userPassword with a value hashed
	// on the client (PasswordChangeRequest.Scheme), or cleartext.
	PasswordMethodUserPassword = "userPassword"
)

// PasswordChangeRequest describes an administrative password reset of one
// entry (EditorService.SetPassword).
type PasswordChangeRequest struct {
	DN       string `json:"dn"`
	Password string `json:"password"`
	// Method is one of the PasswordMethod* constants.
	Method string `json:"method"`
	// Scheme is the client-side hashing scheme for PasswordMethodUserPassword
	// (a PasswordScheme ID such as "SSHA" or "CLEARTEXT"). Ignored otherwise.
	Scheme string `json:"scheme"`
	// MustChange forces a password change at the next logon: pwdLastSet=0
	// on AD, pwdReset=TRUE on OpenLDAP with the ppolicy overlay.
	MustChange bool `json:"mustChange"`
	// Unlock clears an account lockout: lockoutTime=0 on AD; on OpenLDAP
	// with ppolicy the pwdAccountLockedTime/pwdFailureTime attributes.
	Unlock bool `json:"unlock"`
	// VerifyBind binds as DN with the new password on a separate connection
	// after the change to prove that the server accepts it.
	VerifyBind bool `json:"verifyBind"`
	// AllowUnencrypted confirms sending the cleartext password (Password
	// Modify, cleartext userPassword, verification bind) over a connection
	// without TLS; without it SetPassword refuses. unicodePwd is always
	// refused without TLS (the server would reject it anyway).
	AllowUnencrypted bool `json:"allowUnencrypted"`
	// Enable enables a disabled account together with the reset: AD clears
	// ACCOUNTDISABLE (in the same modify as unicodePwd), 389DS removes
	// nsAccountLock; on OpenLDAP it works like Unlock (ppolicy clears the
	// permanent lock with the password change and it is not set again).
	Enable bool `json:"enable,omitempty"`
}

// PasswordChangeResult reports what SetPassword did.
type PasswordChangeResult struct {
	Method string `json:"method"`
	// Scheme is the client-side scheme used (PasswordMethodUserPassword).
	Scheme string `json:"scheme"`
	// StoredScheme is the scheme of the userPassword value read back after
	// the change ("SSHA", "CLEARTEXT", ...); empty when it is not readable.
	StoredScheme string `json:"storedScheme"`
	// StoredSchemeLabel describes it for display ("{SSHA}", "{CRYPT}
	// SHA-512-crypt ($6$)", "cleartext"; ldap.PasswordSchemeLabel).
	StoredSchemeLabel string `json:"storedSchemeLabel"`
	// Operations lists the applied changes without values, e.g.
	// "replace unicodePwd", "replace pwdLastSet=0".
	Operations []string `json:"operations"`
	Warnings   []string `json:"warnings"`
	// Verified is true when the verification bind succeeded; VerifyError
	// holds its error when it failed. Both are empty without VerifyBind.
	Verified    bool   `json:"verified"`
	VerifyError string `json:"verifyError"`
	// Ineffective: the new password most likely does not work (the server
	// re-hashed or does not support the client-side scheme, a hashed
	// userPassword on AD, or the verification bind failed).
	Ineffective bool `json:"ineffective"`
	// Unconfirmed: nothing proves that the server can verify the stored
	// value (the scheme needs a server module or its support is unknown) and
	// no verification bind was made.
	Unconfirmed bool `json:"unconfirmed"`
	// MustChangeIgnored: pwdLastSet=0 was written, but AD does not enforce
	// it because the account's password never expires.
	MustChangeIgnored bool `json:"mustChangeIgnored"`
}

// Server support levels for PasswordSchemeSupport.Level.
const (
	SchemeSupportNative = "native" // built into the server
	SchemeSupportModule = "module" // needs a module/plugin or a newer version
	SchemeSupportNone   = "no"     // not supported
	// SchemeSupportSystem: verified by the system crypt(3) library of the
	// server host, so it depends on the platform ({CRYPT} bcrypt needs
	// libxcrypt or a BSD libc).
	SchemeSupportSystem = "system"
)

// PasswordSchemeSupport describes whether a server type verifies a scheme.
type PasswordSchemeSupport struct {
	// Server is a ServerType* constant.
	Server string `json:"server"`
	// Level is a SchemeSupport* constant.
	Level string `json:"level"`
	Note  string `json:"note"`
}

// PasswordScheme describes a client-side userPassword storage scheme.
type PasswordScheme struct {
	// ID is the scheme name without braces ("SSHA", "PBKDF2-SHA512",
	// "CLEARTEXT").
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
	// Security is "strong", "good", "weak" or "none".
	Security string                  `json:"security"`
	Support  []PasswordSchemeSupport `json:"support"`
}

// PasswordContext is everything the password dialog needs to pick sensible
// defaults for an entry (EditorService.GetPasswordContext).
type PasswordContext struct {
	DN            string `json:"dn"`
	ServerType    string `json:"serverType"`
	VendorName    string `json:"vendorName"`
	VendorVersion string `json:"vendorVersion"`
	// TLS is true when the connection uses LDAPS or StartTLS.
	TLS     bool   `json:"tls"`
	TLSMode string `json:"tlsMode"`
	// PasswordModifyExop: the server announces RFC 3062 Password Modify.
	PasswordModifyExop bool `json:"passwordModifyExop"`
	// PPolicyControl: the server announces the password policy control
	// 1.3.6.1.4.1.42.2.27.8.5.1.
	PPolicyControl bool     `json:"ppolicyControl"`
	ObjectClasses  []string `json:"objectClasses"`
	// IsADAccount: AD entry whose class has a password (user, computer,
	// inetOrgPerson).
	IsADAccount bool `json:"isADAccount"`
	// HasUserPassword: the entry has a readable userPassword value;
	// CurrentScheme is its scheme ("SSHA", "CLEARTEXT", ...).
	HasUserPassword bool   `json:"hasUserPassword"`
	CurrentScheme   string `json:"currentScheme"`
	// CurrentSchemeLabel describes CurrentScheme for display
	// (ldap.PasswordSchemeLabel).
	CurrentSchemeLabel string `json:"currentSchemeLabel"`
	// Locked: the account is currently locked out (AD lockout, OpenLDAP
	// pwdAccountLockedTime).
	Locked bool `json:"locked"`
	// MustChange: a password change is already pending (AD: password
	// expired per msDS-User-Account-Control-Computed, or pwdLastSet=0 without
	// DONT_EXPIRE_PASSWORD; OpenLDAP/389DS: pwdReset=TRUE).
	MustChange bool `json:"mustChange"`
	// Disabled: AD account disabled (userAccountControl ACCOUNTDISABLE).
	Disabled bool `json:"disabled"`
	// PasswordNeverExpires: AD userAccountControl DONT_EXPIRE_PASSWORD
	// (0x10000); AD then ignores pwdLastSet=0 ("must change at next logon").
	PasswordNeverExpires bool `json:"passwordNeverExpires"`
	// ReadOnly: the profile is read-only; SetPassword will fail.
	ReadOnly bool `json:"readOnly"`
	// Schemes are the client-side userPassword schemes, DefaultScheme the
	// recommended one.
	Schemes       []PasswordScheme `json:"schemes"`
	DefaultScheme string           `json:"defaultScheme"`
	// Policy is the connection's password storage policy; the dialog
	// preselects its method and scheme.
	Policy EffectivePasswordPolicy `json:"policy"`
	// AccountPolicy is the entry's effective password and lockout policy
	// (AccountStatus.Policy): the dialog shows its requirements (minimum
	// length, complexity, history) and takes the "must change" default from
	// it (OpenLDAP pwdMustChange). nil when unknown.
	AccountPolicy *AccountPolicy `json:"accountPolicy,omitempty"`
	// AccountNames are the entry's name values (sAMAccountName, uid, cn,
	// givenName, sn, displayName) for the "contains the account name" check
	// of the strength meter.
	AccountNames []string `json:"accountNames"`
}
