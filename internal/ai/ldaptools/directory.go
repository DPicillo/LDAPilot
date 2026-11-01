// Package ldaptools implements LDAPilot's task-shaped LDAP/AD tools for
// the AI harness: the Directory abstraction (implemented over the
// connection pool in services/ai_backend.go), the delegate interfaces for
// membership, account state, password resets and deleted objects (served by
// the merged feature tracks through services/ai_backend.go), redaction,
// value sanitizing and annotation, change previews with risk
// classification, and the read and write tools themselves.
package ldaptools

import (
	"context"
	"errors"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// Directory lists the connected profiles and hands out clients.
type Directory interface {
	Connections() []ConnInfo // connected profiles only
	Client(profileID string) (DirClient, error)
}

// ConnInfo describes a connected profile. It is sanitized: no password, no
// key material, no bind secret.
type ConnInfo struct {
	ProfileID  string
	Name       string
	Host       string
	Port       int
	ServerType string // from ServerInfo when known ("" before the first read)
	BaseDN     string
	TLSMode    string // none | ssl | starttls
	ReadOnly   bool
	Identity   string // "runs as": ldap.AuthIdentity of the profile, as in the audit log ("anonymous" for anonymous binds)
	Timeout    time.Duration
}

// TLS reports whether the connection is encrypted.
func (c ConnInfo) TLS() bool { return c.TLSMode == "ssl" || c.TLSMode == "starttls" }

// DirClient is a directory connection for the AI. Every method acquires
// the profile's AI semaphore with ctx and releases it when the underlying
// call returns.
type DirClient interface {
	Info() ConnInfo
	ServerInfo(ctx context.Context) (*models.ServerInfo, error)
	// RootDSE reads the named RootDSE attributes.
	RootDSE(ctx context.Context, attrs []string) (*models.LDAPEntry, error)
	// Search is Client.SearchContext.
	Search(ctx context.Context, p models.SearchParams) (*models.SearchResult, error)
	// SearchTypesOnly returns the attribute names per entry (typesOnly).
	SearchTypesOnly(ctx context.Context, p models.SearchParams) (map[string][]string, error)
	// Schema returns the raw schema definitions (attributeTypes and
	// objectClasses values of the subschema entry).
	Schema(ctx context.Context) (attributeTypes, objectClasses []string, err error)
	// Modify runs one atomic modify; assert is an RFC 4515 filter sent as
	// an RFC 4528 assertion control ("" = none).
	Modify(ctx context.Context, dn string, changes []models.AttributeChange, assert string) error
	Add(ctx context.Context, dn string, attrs []models.LDAPAttribute) error
	ModifyDN(ctx context.Context, dn, newRDN string, deleteOld bool, newSuperior string) error
	Delete(ctx context.Context, dn string, assert string) error
	// PasswordModify runs the RFC 3062 Password Modify extended operation.
	PasswordModify(ctx context.Context, dn, value string) error

	Membership() MembershipResolver
	Accounts() AccountInspector
	Planner() AccountPlanner
	Passwords() PasswordSetter
	Recycle() DeletedObjectsReader
}

// Auditor records executed writes in LDAPilot's audit log.
type Auditor interface {
	Record(profileID, op, dn, details string, err error)
}

// ErrNotConnected is returned by Directory.Client for a profile that is
// not connected.
var ErrNotConnected = errors.New("not connected")

// --- delegate interfaces (§5.4) ---
//
// The membership, account, password and recycle tracks implement the
// authoritative logic; services/ai_backend.go adapts their APIs
// (Client.ResolveMembers/ResolveMemberOf/GroupMembership/MembershipChange,
// Client.AccountStatus/AccountReport/PlanAccountChange/ApplyAccountChange,
// the password reset core of EditorService.SetPassword with the
// connection's password storage policy, Client.ListDeletedObjects). The
// tools never re-implement them; aitest/fake has in-memory test doubles.

// MembershipResolver resolves group membership.
type MembershipResolver interface {
	Members(ctx context.Context, groupDN string, transitive bool) (*Membership, error)
	MemberOf(ctx context.Context, dn string, transitive bool) (*Membership, error)
	GroupInfo(ctx context.Context, groupDN string) (*GroupInfo, error)
	// MemberValues returns the single values that stand for member in the
	// group for op (add | delete), primary member attribute first, then
	// the companion values the membership track writes too: the memberUid
	// of an RFC 2307bis member, uniqueMember values with an optional UID
	// ("dn#'0101'B") for a delete.
	MemberValues(ctx context.Context, g *GroupInfo, op, memberDN string) ([]MemberValue, error)
}

// MemberValue is one value of a member attribute.
type MemberValue struct {
	Attr, Value string
}

// Membership is a resolved member or member-of list.
type Membership struct {
	DN        string
	Method    string // e.g. "ad-chain", "search", "ad-direct", "search-direct"
	Items     []MemberItem
	Cycles    [][]string
	Truncated bool
	Warnings  []string
}

// MemberItem is one resolved member or group.
type MemberItem struct {
	DN          string
	Name        string
	Type        string // user | group | computer | contact | other
	Depth       int
	Via         []string // nesting path (group DNs)
	Primary     bool
	PrimaryOnly bool
	InCycle     bool
	Unresolved  bool
	// External: held by another server (referral, other forest domain).
	External bool
}

// GroupInfo describes a group for membership changes.
type GroupInfo struct {
	DN          string
	ObjectClass []string
	MemberAttrs []string            // member | uniqueMember | memberUid (in preference order)
	Values      map[string][]string // current values per member attribute (lower-case keys)
	POSIX       bool                // posixGroup (memberUid companions)
	MemberUIDs  bool                // RFC 2307bis group that keeps memberUid values too
	SID         string
	// PrimaryToken is the AD primaryGroupToken (RID).
	PrimaryToken int
}

// AccountInspector reads account state.
type AccountInspector interface {
	Status(ctx context.Context, dn string) (*AccountStatus, error)
	Report(ctx context.Context, p ReportParams) (*AccountReport, error)
}

// AccountStatus is the state of one account.
type AccountStatus struct {
	DN                   string
	ServerType           string
	Applicable           bool
	Reason               string
	AccountType          string // user | computer | serviceAccount
	Enabled              bool
	DisabledBy           string
	LockedOut            bool
	LockedPermanently    bool
	LockoutTime          string
	LockedUntil          string
	LockoutExpired       bool
	MustChangePassword   bool
	PasswordNeverExpires bool
	PasswordLastSet      string
	PasswordExpires      string
	PasswordExpired      bool
	AccountExpires       string
	Expired              bool
	LastLogon            string
	LastLogonReplicated  string
	BadPasswordCount     *int
	Policy               map[string]string
	UnsupportedActions   []string
	Warnings             []string
	Notes                []string
}

// ReportParams selects an account report.
type ReportParams struct {
	Kind       string // locked | disabled | passwordExpired
	BaseDN     string
	ObjectKind string // users | computers | all
	Limit      int    // max accounts to verify and return (0 = default)
}

// AccountReport is the result of a report.
type AccountReport struct {
	Accounts []ReportItem
	// ExpiredLockouts lists accounts whose lockout has already expired
	// (lockoutTime still set) for the locked report.
	ExpiredLockouts []ReportItem
	Total           int
	Truncated       bool
	Method          string
	Notes           []string
}

// ReportItem is one account of a report.
type ReportItem struct {
	DN, Login, Name, Detail string
	// Lockout of a locked account (the "locked" report): when it started,
	// when it ends by itself, or that only an administrator ends it (UX
	// A-23: small models invented lockout windows for permanent OpenLDAP
	// lockouts).
	LockedAt, LockedUntil string
	LockedPermanently     bool
}

// AccountPlanner plans and performs account actions.
type AccountPlanner interface {
	// Plan returns the exact change for the action on the account's
	// current state (a no-op plan when it is already in that state).
	Plan(ctx context.Context, dn, action string) (*AccountPlan, error)
	// Apply performs the approved plan as one atomic modify: the account
	// track re-plans the action from the current state (and retries once
	// when a value changed in between). It returns the changes sent.
	Apply(ctx context.Context, plan *AccountPlan) ([]models.AttributeChange, error)
}

// Account actions.
const (
	ActionUnlock          = "unlock"
	ActionEnable          = "enable"
	ActionDisable         = "disable"
	ActionMustChange      = "must_change"       // require a password change at next logon
	ActionClearMustChange = "clear_must_change" // clear it
)

// AccountPlan is the exact change for an account action.
type AccountPlan struct {
	DN      string
	Action  string
	Changes []models.AttributeChange
	NoOp    bool
	Reason  string              // why it is a no-op / note
	Hint    string              // e.g. "use set_account_enabled"
	Before  map[string][]string // touched attributes before the change
	Notes   []string
}

// ErrAccountConflict means the account changed between plan and apply.
var ErrAccountConflict = errors.New("the account was changed by someone else")

// ErrNotApplicable means the action does not apply to the entry.
var ErrNotApplicable = errors.New("not applicable")

// PasswordSetter resets passwords through the password track: the method
// comes from the server type and the connection's password storage policy
// (GitHub issue #1), the write from EditorService.SetPassword's core.
type PasswordSetter interface {
	Plan(ctx context.Context, dn string, mustChange bool) (*PasswordPlan, error)
	// Apply sets value; the outcome carries stored scheme labels and
	// warnings, never values.
	Apply(ctx context.Context, plan *PasswordPlan, value string) (*PasswordOutcome, error)
}

// Password methods (models.PasswordMethod*).
const (
	PasswordAD           = models.PasswordMethodUnicodePwd
	PasswordRFC3062      = models.PasswordMethodExop
	PasswordUserPassword = models.PasswordMethodUserPassword
)

// PasswordPlan is the prepared password reset.
type PasswordPlan struct {
	DN         string
	Method     string
	Scheme     string // client-side scheme for userPassword (PasswordScheme ID)
	MustChange bool
	Notes      []string
	LDIF       string // preview with a placeholder instead of the value
	// Storage is the password storage outcome shown on the approval card.
	Storage *ai.PasswordPreview
	// AllowUnencrypted: the reset sends the cleartext password over a
	// connection without TLS. The approval card says so and asks for the
	// confirmation (reset_password is high risk); only that approval lets
	// Apply send it.
	AllowUnencrypted bool
	// MustChangeBy is set when the server, not the reset request, decides
	// "must change at next logon" (389 DS: its password policy's
	// passwordMustChange, whatever must_change_at_next_logon says). It
	// names the deciding policy and its value for the tool result and the
	// audit. MustChange is then the policy's outcome (false when unknown)
	// and is never sent with the request (RequestMustChange);
	// MustChangeKnown is false when the policy is not readable.
	MustChangeBy    string
	MustChangeKnown bool
}

// RequestMustChange reports whether the reset itself sets "must change at
// next logon" (not when the server's policy decides).
func (p *PasswordPlan) RequestMustChange() bool { return p.MustChange && p.MustChangeBy == "" }

// PasswordOutcome is what the server stored (no values).
type PasswordOutcome struct {
	StoredSchemeLabel string
	Ineffective       bool
	Unconfirmed       bool
	MustChangeIgnored bool
	Operations        []string
	Warnings          []string
}

// DeletedObjectsReader lists deleted AD objects (recycle track).
type DeletedObjectsReader interface {
	// List returns the deleted objects of the naming context nc ("" =
	// default) whose name contains text, at most limit (newest first).
	List(ctx context.Context, nc, text string, limit int) (*models.DeletedObjectsList, error)
	Info(ctx context.Context) (*models.RecycleBinInfo, error)
}

// ErrUnsupported marks an operation the server does not support.
var ErrUnsupported = errors.New("unsupported on this server")
