package models

// Directions of a membership resolution (MembershipResult.Direction).
const (
	MembershipDirectionMemberOf = "memberOf" // groups the entry belongs to
	MembershipDirectionMembers  = "members"  // members of a group
)

// Kinds of primary group membership (MembershipItem.Primary).
const (
	PrimaryGroupAD    = "ad"    // AD primaryGroupID (RID of the group's objectSid)
	PrimaryGroupPOSIX = "posix" // posixAccount gidNumber = posixGroup gidNumber
)

// Object types reported in MembershipItem.ObjectType and
// MembershipResult.TypeCounts.
const (
	MemberTypeUser     = "user"
	MemberTypeGroup    = "group"
	MemberTypeComputer = "computer"
	MemberTypeContact  = "contact"
	MemberTypeFSP      = "foreignSecurityPrincipal"
	MemberTypeOther    = "other"
	MemberTypeUnknown  = "unknown" // not found / not readable / unresolved memberUid
)

// MembershipItem is one group (memberOf direction) or one member (members
// direction) of a membership resolution.
type MembershipItem struct {
	DN string `json:"dn"` // empty for a memberUid that matches no account
	// Name is the RDN value (or the uid of an unresolved memberUid).
	Name       string `json:"name"`
	ObjectType string `json:"objectType"`
	// Direct is true for depth 1: a direct group of the entry / a direct
	// member of the group (including primary group membership).
	Direct bool `json:"direct"`
	// Depth is the nesting depth along the shortest path, 1 = direct.
	Depth int `json:"depth"`
	// Path lists the DNs of the intermediate groups between the resolved
	// entry and this item, nearest to the entry first: for memberOf "entry is
	// member of Path[0], which is member of Path[1], ..., member of this
	// group"; for members "group contains Path[0], which contains ..., which
	// contains this member". Empty for direct items.
	Path []string `json:"path"`
	// Primary is set when the item was reached through a primary group
	// relation: "ad" (primaryGroupID) or "posix" (gidNumber). For memberOf it
	// marks the primary group; for members the accounts whose primary group
	// is the group (or, for nested items, the group at the end of Path).
	Primary string `json:"primary,omitempty"`
	// PrimaryOnly is set on a direct item that belongs to the entry only
	// through the primary group relation: it is not stored in the group's
	// member attribute, so it cannot be removed there (AD: change the
	// primaryGroupID; POSIX: change the gidNumber).
	PrimaryOnly bool `json:"primaryOnly,omitempty"`
	// InCycle marks items that are part of a circular group nesting.
	InCycle bool `json:"inCycle,omitempty"`
	// Unresolved is true when the referenced object could not be read (it
	// does not exist or is not readable) or a memberUid has no matching
	// account.
	Unresolved bool `json:"unresolved,omitempty"`
	// External is true when the referenced object is held by another server
	// (the server answered with a referral, or the DN lies outside all of its
	// naming contexts, e.g. another domain of an AD forest), so it was not
	// resolved here. Its type is unknown, but it may well exist.
	External bool `json:"external,omitempty"`
	// Self marks the resolved entry itself: a group that is stored as a
	// member of itself (member = own DN). It is listed as a direct, removable
	// item (InCycle set) so the self-reference can be seen and removed.
	Self bool `json:"self,omitempty"`
}

// MembershipCycle is a circular group nesting. Path lists group DNs in
// nesting order and ends with its first element (A → B → A).
type MembershipCycle struct {
	Path []string `json:"path"`
}

// MembershipResult is the result of resolving the groups of an entry or the
// members of a group.
type MembershipResult struct {
	DN        string `json:"dn"`
	Direction string `json:"direction"` // "memberOf" or "members"
	Effective bool   `json:"effective"` // false = direct only
	// Method describes how the result was computed: "ad-chain" (AD
	// LDAP_MATCHING_RULE_IN_CHAIN), "ad-direct", "search" (BFS with searches)
	// or "search-direct".
	Method string `json:"method"`
	// IsGroup reports whether the resolved entry is a group.
	IsGroup bool `json:"isGroup"`
	// MemberAttribute is the attribute that holds the members of the group
	// (members direction): member, uniqueMember or memberUid.
	MemberAttribute string           `json:"memberAttribute,omitempty"`
	Items           []MembershipItem `json:"items"`
	DirectCount     int              `json:"directCount"`
	MaxDepth        int              `json:"maxDepth"`
	// TypeCounts counts Items per ObjectType.
	TypeCounts map[string]int    `json:"typeCounts"`
	Cycles     []MembershipCycle `json:"cycles"`
	// Truncated is true when the size or depth limit was hit; Items is then
	// incomplete.
	Truncated bool     `json:"truncated"`
	Warnings  []string `json:"warnings"`
	// Queries is the number of LDAP requests the resolution needed.
	Queries    int   `json:"queries"`
	DurationMs int64 `json:"durationMs"`
}

// MembershipChangeFailure is a value that could not be added or removed.
type MembershipChangeFailure struct {
	DN    string `json:"dn"`
	Error string `json:"error"`
}

// MembershipChangeResult reports the outcome of adding or removing several
// members (or groups) one value at a time.
type MembershipChangeResult struct {
	// Changed lists the DNs whose membership was changed.
	Changed []string `json:"changed"`
	// Unchanged lists DNs that needed no change (already a member when
	// adding, not a member when removing).
	Unchanged []string                  `json:"unchanged"`
	Failed    []MembershipChangeFailure `json:"failed"`
	// Warnings lists changes that were made but may not be what was meant,
	// e.g. a memberUid without a matching account.
	Warnings []string `json:"warnings"`
}
