package models

// Per-connection password storage policy (GitHub issue #1): how cleartext
// userPassword values are stored by every write path (create, modify,
// attribute edits, bulk modify, LDIF import). See ldap.ResolvePasswordPolicy
// and the write hook in internal/ldap/password_policy.go.

// Password policies (ConnectionProfile.PasswordPolicy and
// EffectivePasswordPolicy.Policy).
const (
	// PasswordPolicyAuto picks the default of the detected server type
	// (ldap.DefaultPasswordPolicy). Stored as "" in the profile.
	PasswordPolicyAuto = "auto"
	// PasswordPolicyClient hashes cleartext userPassword values on the
	// client with ConnectionProfile.PasswordScheme before they are sent.
	PasswordPolicyClient = "client"
	// PasswordPolicyServer sends cleartext and lets the server hash it: as
	// is to servers known to hash cleartext values (389DS, OpenLDAP with
	// ppolicy olcPPolicyHashCleartext), else with the Password Modify
	// extended operation (RFC 3062) where the write allows it, else with a
	// warning.
	PasswordPolicyServer = "server"
	// PasswordPolicyAsk makes every write with a cleartext userPassword
	// value ask how to store it (PasswordWriteOptions.Policy).
	PasswordPolicyAsk = "ask"
	// PasswordPolicyAD is only an effective policy: on Active Directory
	// userPassword values are passed to the server unchanged (passwords are
	// set through unicodePwd; AD treats userPassword specially).
	PasswordPolicyAD = "ad"
)

// Sources of an effective policy (EffectivePasswordPolicy.Source).
const (
	PasswordPolicySourceProfile = "profile" // set in the connection profile
	PasswordPolicySourceDefault = "default" // default of the server type
	PasswordPolicySourceWrite   = "write"   // decided for this write (PasswordWriteOptions.Policy)
)

// EffectivePasswordPolicy is the policy that applies to the writes of a
// connection: the profile setting resolved against the detected server.
type EffectivePasswordPolicy struct {
	// Configured is the profile setting ("auto" when not set).
	Configured string `json:"configured"`
	// Policy is client, server, ask or ad.
	Policy string `json:"policy"`
	// Scheme is the client-side scheme ID (PasswordScheme.ID) for client;
	// SchemeLabel its display label.
	Scheme      string `json:"scheme"`
	SchemeLabel string `json:"schemeLabel"`
	// Source is a PasswordPolicySource* constant; Reason explains a default.
	Source string `json:"source"`
	Reason string `json:"reason"`
	// ServerType is the detected server type (ServerType* constant).
	ServerType string `json:"serverType"`
	// ServerHashes: the server is known to hash cleartext userPassword
	// values itself; ServerHashing says why or why not ("389 Directory
	// Server stores passwords with PBKDF2-SHA512", "unknown: cn=config is
	// not readable").
	ServerHashes  bool   `json:"serverHashes"`
	ServerHashing string `json:"serverHashing"`
	// PasswordModifyExop: the server announces RFC 3062.
	PasswordModifyExop bool `json:"passwordModifyExop"`
	// TLS: the connection is encrypted (LDAPS or StartTLS).
	TLS bool `json:"tls"`
	// Summary describes the policy in one sentence for dialogs.
	Summary string `json:"summary"`
	// Warnings about the configuration (unknown scheme, scheme not
	// supported by the server type).
	Warnings []string `json:"warnings"`
}

// PasswordWriteOptions are the per-write decisions of a caller.
type PasswordWriteOptions struct {
	// AsIs stores userPassword values exactly as given, without the policy
	// (LDIF import opt-out "store passwords exactly as in the file"; the
	// password dialog, which hashes itself).
	AsIs bool `json:"asIs"`
	// Policy overrides the connection policy for this write: "client" (with
	// Scheme) or "server". Answers the "ask" policy; ignored on AD.
	Policy string `json:"policy,omitempty"`
	// Scheme is the client-side scheme for Policy "client" ("" = the
	// policy's scheme).
	Scheme string `json:"scheme,omitempty"`
	// AllowUnencrypted confirms sending a cleartext password (userPassword,
	// unicodePwd, Password Modify) over a connection without TLS.
	AllowUnencrypted bool `json:"allowUnencrypted"`
}

// PasswordWritePlanRequest describes a write for EditorService.
// PlanPasswordWrite: the attributes of an add, the changes of a modify, or
// the content of an LDIF file (add and modify records).
type PasswordWritePlanRequest struct {
	Attributes []LDAPAttribute      `json:"attributes,omitempty"`
	Changes    []AttributeChange    `json:"changes,omitempty"`
	LDIF       string               `json:"ldif,omitempty"`
	Options    PasswordWriteOptions `json:"options"`
}

// PasswordWritePlan is what the policy does with the password values of a
// write, computed without writing (and without hashing).
type PasswordWritePlan struct {
	Policy EffectivePasswordPolicy `json:"policy"`
	// HasPasswords: the write contains userPassword or unicodePwd values.
	HasPasswords bool `json:"hasPasswords"`
	// Values counts the userPassword values to add or replace: Hashed are
	// hashed on the client, Kept already carry a {SCHEME} and are sent
	// unchanged, Cleartext are sent as cleartext (server policy, AD, as is).
	Values    int `json:"values"`
	Hashed    int `json:"hashed"`
	Kept      int `json:"kept"`
	Cleartext int `json:"cleartext"`
	// Exop: the password is set with the Password Modify extended operation
	// (server policy, a single replace of userPassword).
	Exop bool `json:"exop"`
	AsIs bool `json:"asIs"`
	// CleartextSent: a cleartext password goes over the wire (userPassword
	// value without scheme, unicodePwd, Password Modify, delete of a
	// cleartext value).
	CleartextSent bool `json:"cleartextSent"`
	// Unencrypted: the connection has no TLS.
	Unencrypted bool `json:"unencrypted"`
	// NeedsConfirm: CleartextSent over an unencrypted connection without
	// PasswordWriteOptions.AllowUnencrypted; the write is refused until the
	// user confirms.
	NeedsConfirm bool `json:"needsConfirm"`
	// NeedsDecision: the policy is "ask" and the options carry no decision;
	// the write is refused until the user decides.
	NeedsDecision bool `json:"needsDecision"`
	// Actions describe what happens ("userPassword: 1 value hashed on the
	// client with {CRYPT} SHA-512-crypt ($6$)"), Warnings what to watch out
	// for. Never contain password values.
	Actions  []string `json:"actions"`
	Warnings []string `json:"warnings"`
}

// PasswordWriteReport is the outcome of a write with password values:
// what the policy did and what the server stored (read back after the
// write when readable).
type PasswordWriteReport struct {
	Actions  []string `json:"actions"`
	Warnings []string `json:"warnings"`
	// StoredSchemes are the display labels of the userPassword values read
	// back ("{SSHA}", "{CRYPT} SHA-512-crypt ($6$)", "cleartext"); empty
	// when not readable.
	StoredSchemes []string `json:"storedSchemes"`
	// Cleartext: a stored userPassword value has no storage scheme.
	Cleartext bool `json:"cleartext"`
	// Ineffective: the server re-hashed a client-side hash as if it were a
	// cleartext password, or the server type does not support the scheme:
	// the password does not work.
	Ineffective bool `json:"ineffective"`
	// Unconfirmed: the client-side scheme is not built into the server type
	// (module or system crypt(3) needed); the server may store the hash
	// without being able to verify it, so the password may not work.
	Unconfirmed bool `json:"unconfirmed"`
	// Exop: the password was set with the Password Modify extended
	// operation.
	Exop bool `json:"exop"`
}

// PasswordPolicyDefault is the default policy of a server type.
type PasswordPolicyDefault struct {
	ServerType string `json:"serverType"`
	Policy     string `json:"policy"`
	Scheme     string `json:"scheme"`
	Reason     string `json:"reason"`
}

// PasswordPolicyCatalog is what the connection dialog needs to edit the
// policy: the client-side schemes and the defaults per server type.
type PasswordPolicyCatalog struct {
	Schemes  []PasswordScheme        `json:"schemes"`
	Defaults []PasswordPolicyDefault `json:"defaults"`
}
