package models

// Account kinds of an AccountStatus.
const (
	AccountKindUser           = "user"
	AccountKindComputer       = "computer"
	AccountKindServiceAccount = "serviceAccount" // AD (g)MSA: password managed by AD
)

// Account action identifiers. They are the keys of AccountStatus.Unsupported
// and name the operations of the account actions in the editor service.
const (
	AccountActionUnlock         = "unlock"
	AccountActionEnable         = "enable"
	AccountActionDisable        = "disable"
	AccountActionMustChange     = "mustChange"     // set or clear "must change password at next logon"
	AccountActionNeverExpires   = "neverExpires"   // set or clear "password never expires"
	AccountActionAccountExpires = "accountExpires" // set or clear the account expiration date
	AccountActionUAC            = "uac"            // edit userAccountControl flags
	AccountActionResetPassword  = "resetPassword"  // set a new password (PasswordDialog)
)

// AccountStatus is the normalized state of a user or computer account,
// computed from the server specific attributes (AD userAccountControl and
// friends, OpenLDAP ppolicy, 389DS password policy and account inactivation).
//
// All times are RFC 3339 strings in UTC; an empty string means "not set" or
// "unknown". Durations are seconds.
type AccountStatus struct {
	DN         string `json:"dn"`
	ServerType string `json:"serverType"`
	// Applicable is false when the entry is no account (group, OU, contact)
	// or the server type has no account model; Reason says why.
	Applicable bool   `json:"applicable"`
	Reason     string `json:"reason,omitempty"`
	Kind       string `json:"kind,omitempty"`
	// Evaluated is the time the status was computed at.
	Evaluated string `json:"evaluated"`

	Enabled bool `json:"enabled"`
	// DisabledBy explains a disabled account, e.g. "ACCOUNTDISABLE flag in
	// userAccountControl" or "nsAccountLock: true".
	DisabledBy string `json:"disabledBy,omitempty"`
	// DisabledByRole is set when a 389DS role (nsDisabledRole) disables the
	// account.
	DisabledByRole bool `json:"disabledByRole,omitempty"`

	Locked bool `json:"locked"`
	// LockedPermanently: locked until an administrator unlocks it.
	LockedPermanently bool   `json:"lockedPermanently,omitempty"`
	LockedAt          string `json:"lockedAt,omitempty"`
	LockedUntil       string `json:"lockedUntil,omitempty"`
	// LockoutExpired: a lockout timestamp is still stored but the lockout
	// duration has passed, so the account is not locked anymore.
	LockoutExpired   bool   `json:"lockoutExpired,omitempty"`
	BadPasswordCount int    `json:"badPasswordCount"`
	LastBadPassword  string `json:"lastBadPassword,omitempty"`

	PasswordLastSet      string `json:"passwordLastSet,omitempty"`
	PasswordExpires      string `json:"passwordExpires,omitempty"`
	PasswordExpired      bool   `json:"passwordExpired"`
	PasswordNeverExpires bool   `json:"passwordNeverExpires"`
	// PasswordExpiryNote explains a never expiring or unknown expiry, e.g.
	// "DONT_EXPIRE_PASSWORD flag" or "the policy has no maximum age".
	PasswordExpiryNote string `json:"passwordExpiryNote,omitempty"`
	MustChangePassword bool   `json:"mustChangePassword"`

	AccountExpires      string `json:"accountExpires,omitempty"`
	AccountExpired      bool   `json:"accountExpired"`
	AccountNeverExpires bool   `json:"accountNeverExpires"`

	// LastLogon is the last logon seen by the connected server (AD lastLogon
	// is not replicated); LastLogonReplicated is AD lastLogonTimestamp
	// (replicated, may lag up to 14 days).
	LastLogon           string `json:"lastLogon,omitempty"`
	LastLogonReplicated string `json:"lastLogonReplicated,omitempty"`
	LogonCount          int    `json:"logonCount"`
	HasLogonCount       bool   `json:"hasLogonCount"`
	Created             string `json:"created,omitempty"`

	// UserAccountControl and UserAccountControlComputed (AD only; the
	// computed value is msDS-User-Account-Control-Computed).
	UserAccountControl         int64 `json:"userAccountControl"`
	UserAccountControlComputed int64 `json:"userAccountControlComputed"`

	// Policy is the effective password/lockout policy, nil when unknown.
	Policy *AccountPolicy `json:"policy,omitempty"`
	// PolicyNote is an informational note about how the policy was found
	// (e.g. OpenLDAP: cn=config is not readable, so the only pwdPolicy entry
	// is assumed to be the default). It is the same for every account of
	// the connection, so the UI shows it once instead of as a warning.
	PolicyNote string `json:"policyNote,omitempty"`

	// Unsupported maps an action (AccountAction*) that cannot be used on this
	// account or server to the reason. Actions not listed are supported; the
	// state (e.g. "not locked") is left to the caller.
	Unsupported map[string]string `json:"unsupported"`
	// Warnings are problems found while computing the status (policy not
	// readable, inconsistent attributes).
	Warnings []string `json:"warnings"`
}

// Account policy sources.
const (
	PolicySourcePSO      = "pso"      // AD fine-grained password policy (msDS-ResultantPSO)
	PolicySourceDomain   = "domain"   // AD domain policy on the domain NC head
	PolicySourceSubentry = "subentry" // OpenLDAP pwdPolicySubentry / 389DS pwdpolicysubentry
	PolicySourceDefault  = "default"  // OpenLDAP olcPPolicyDefault
	PolicySourceAssumed  = "assumed"  // OpenLDAP: the only pwdPolicy entry found (cn=config not readable)
	PolicySourceGlobal   = "global"   // 389DS global policy in cn=config
	PolicySourceUnknown  = "unknown"  // no policy could be determined
	PolicySourceNoPolicy = "none"     // no policy applies
)

// AccountPolicy is the effective password and lockout policy of an account.
type AccountPolicy struct {
	DN     string `json:"dn,omitempty"`
	Name   string `json:"name"`
	Source string `json:"source"`
	// Readable is false when the policy entry exists but could not be read;
	// the values below are then zero.
	Readable bool `json:"readable"`

	LockoutEnabled   bool `json:"lockoutEnabled"`
	LockoutThreshold int  `json:"lockoutThreshold"`
	// LockoutDurationSeconds 0 means: locked until an administrator unlocks.
	LockoutDurationSeconds   int64 `json:"lockoutDurationSeconds"`
	ObservationWindowSeconds int64 `json:"observationWindowSeconds"`
	// MaxPasswordAgeSeconds 0 means: passwords never expire.
	MaxPasswordAgeSeconds int64 `json:"maxPasswordAgeSeconds"`
	MinPasswordAgeSeconds int64 `json:"minPasswordAgeSeconds"`
	MinPasswordLength     int   `json:"minPasswordLength"`
	PasswordHistory       int   `json:"passwordHistory"`
	ExpireWarningSeconds  int64 `json:"expireWarningSeconds"`
	GraceLogins           int   `json:"graceLogins"`
	// MustChangeEnforced: the server enforces "must change password" flags
	// (OpenLDAP pwdMustChange, 389DS passwordMustChange; always true on AD).
	MustChangeEnforced bool `json:"mustChangeEnforced"`
	// ComplexityKnown: ComplexityEnabled and ReversibleEncryption were read
	// (AD domain pwdProperties, PSO msDS-PasswordComplexityEnabled /
	// msDS-PasswordReversibleEncryptionEnabled, 389DS passwordCheckSyntax).
	ComplexityKnown bool `json:"complexityKnown"`
	// ComplexityEnabled: passwords must meet complexity requirements (AD:
	// three of four character classes and no parts of the account name;
	// 389DS: passwordCheckSyntax).
	ComplexityEnabled bool `json:"complexityEnabled"`
	// ReversibleEncryption: AD stores passwords with reversible encryption
	// (pwdProperties DOMAIN_PASSWORD_STORE_CLEARTEXT).
	ReversibleEncryption bool `json:"reversibleEncryption"`
}

// Account report kinds of AccountReportParams.
const (
	AccountReportLocked           = "locked"
	AccountReportDisabled         = "disabled"
	AccountReportPasswordExpiring = "passwordExpiring"
	AccountReportPasswordExpired  = "passwordExpired"
	AccountReportNeverLoggedOn    = "neverLoggedOn"
	// AccountReportEmptyGroups lists groups without members. On AD a group
	// that is some account's primary group (primaryGroupID) is not empty;
	// on LDAP servers a posixGroup whose gidNumber is an account's
	// gidNumber is not either.
	AccountReportEmptyGroups = "emptyGroups"
	// AccountReportPrivilegedMembers lists the accounts that are direct or
	// nested members of the AD built-in privileged groups (AD only).
	AccountReportPrivilegedMembers = "privilegedMembers"
)

// AccountReportParams selects an account report.
type AccountReportParams struct {
	Report string `json:"report"`
	// BaseDN to search below; empty uses the profile base DN or the default
	// naming context.
	BaseDN string `json:"baseDN"`
	// Days is the window of the passwordExpiring report.
	Days int `json:"days"`
	// SizeLimit caps the number of returned entries (default 5000).
	SizeLimit int `json:"sizeLimit"`
	// DNs, when set, re-reads only these entries (e.g. report rows after an
	// account action): each is read with the report's attributes and
	// returned whether it still matches or not (AccountReportResult.Matches).
	// Only for the account reports (locked, disabled, password*, neverLoggedOn).
	DNs []string `json:"dns,omitempty"`
}

// AccountReportResult is the result of an account report: the matching
// entries with the attributes needed to judge them.
type AccountReportResult struct {
	Entries    []LDAPEntry `json:"entries"`
	TotalCount int         `json:"totalCount"`
	Truncated  bool        `json:"truncated"`
	// Candidates is the number of entries checked.
	Candidates int `json:"candidates"`
	// Columns are suggested display columns for the server type.
	Columns []string `json:"columns"`
	// Notes explain how the report was computed (policy used, fallbacks).
	Notes []string `json:"notes"`
	// Statuses are the computed account statuses of Entries (same order;
	// account reports only, empty for group reports).
	Statuses []AccountStatus `json:"statuses"`
	// Extra are computed report columns of Entries (same order), keyed by
	// column title, e.g. "Privileged groups"; empty when the report has none.
	Extra []map[string]string `json:"extra"`
	// Matches tells for a re-read (AccountReportParams.DNs) whether each
	// entry still matches the report.
	Matches []bool `json:"matches,omitempty"`
}

// ReportAvailability says which reports work on a connection.
type ReportAvailability struct {
	ServerType string `json:"serverType"`
	// Unavailable maps a report kind (AccountReport*) that cannot run on this
	// server to the reason, e.g. neverLoggedOn without logon tracking.
	Unavailable map[string]string `json:"unavailable"`
}
