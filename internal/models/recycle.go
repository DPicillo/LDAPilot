package models

// States of a deleted AD object (DeletedObject.State).
const (
	// DeletedStateDeleted is a deleted object while the AD Recycle Bin is
	// enabled: it keeps all attributes and link values (group memberships)
	// and can be restored completely.
	DeletedStateDeleted = "deleted"
	// DeletedStateTombstone is a deleted object while the Recycle Bin is not
	// enabled: most attributes and all link values were stripped; it can be
	// reanimated, but only with the attributes that were kept.
	DeletedStateTombstone = "tombstone"
	// DeletedStateRecycled is a recycled object (Recycle Bin enabled and the
	// deleted object lifetime has passed): it cannot be restored.
	DeletedStateRecycled = "recycled"
)

// Kinds of a naming context holding a Deleted Objects container.
const (
	NamingContextDomain        = "domain"
	NamingContextConfiguration = "configuration"
	NamingContextApplication   = "application"
)

// DeletedObjectsContainer is the Deleted Objects container of one naming
// context, found via its well-known GUID.
type DeletedObjectsContainer struct {
	NamingContext string `json:"namingContext"`
	// DN of the container ("CN=Deleted Objects,<nc>"); empty when Error is set.
	DN string `json:"dn"`
	// Kind is "domain", "configuration" or "application".
	Kind  string `json:"kind"`
	Error string `json:"error,omitempty"`
}

// RecycleBinInfo describes what the server offers for deleted objects.
type RecycleBinInfo struct {
	// Supported is false for servers without AD deleted objects (non-AD or
	// missing Show Deleted control); Reason then explains why.
	Supported  bool   `json:"supported"`
	Reason     string `json:"reason,omitempty"`
	ServerType string `json:"serverType"`
	// RecycleBinEnabled reports whether the AD Recycle Bin optional feature is
	// enabled (msDS-EnabledFeature on CN=Partitions); RecycleBinKnown is false
	// when that could not be read.
	RecycleBinEnabled bool `json:"recycleBinEnabled"`
	RecycleBinKnown   bool `json:"recycleBinKnown"`
	// ShowRecycledSupported reports the Show Recycled control (recycled
	// objects are listed only with it).
	ShowRecycledSupported bool `json:"showRecycledSupported"`
	// TreeDeleteSupported reports the tree delete control.
	TreeDeleteSupported bool `json:"treeDeleteSupported"`
	// TombstoneLifetimeDays and DeletedObjectLifetimeDays are the configured
	// lifetimes (CN=Directory Service); 0 = not set (server default).
	TombstoneLifetimeDays     int                       `json:"tombstoneLifetimeDays"`
	DeletedObjectLifetimeDays int                       `json:"deletedObjectLifetimeDays"`
	DefaultNamingContext      string                    `json:"defaultNamingContext"`
	Containers                []DeletedObjectsContainer `json:"containers"`
}

// DeletedObject is one entry of a Deleted Objects container.
type DeletedObject struct {
	// DN is the current DN of the deleted object (with the "\0ADEL:<guid>"
	// mangled RDN, below CN=Deleted Objects).
	DN string `json:"dn"`
	// Name is the original name, without the "\nDEL:<guid>" suffix.
	Name string `json:"name"`
	// RDNAttribute is the RDN attribute type (CN, OU, ...).
	RDNAttribute    string   `json:"rdnAttribute"`
	ObjectClass     []string `json:"objectClass"`
	StructuralClass string   `json:"structuralClass"`
	// LastKnownRDN is msDS-LastKnownRDN (empty when the server does not keep it).
	LastKnownRDN string `json:"lastKnownRDN"`
	// LastKnownParent is the DN of the container the object was deleted from.
	// When that container is deleted as well, it points into Deleted Objects
	// (ParentDeleted); after the container was restored it is its live DN.
	LastKnownParent string `json:"lastKnownParent"`
	ParentDeleted   bool   `json:"parentDeleted"`
	// DeletedAt is whenChanged (the deletion time for unchanged tombstones)
	// in RFC 3339; WhenCreated likewise.
	DeletedAt   string `json:"deletedAt"`
	WhenCreated string `json:"whenCreated"`
	IsRecycled  bool   `json:"isRecycled"`
	// State is "deleted", "tombstone" or "recycled"; Restorable is false for
	// recycled objects.
	State          string `json:"state"`
	Restorable     bool   `json:"restorable"`
	ObjectSID      string `json:"objectSid"`
	ObjectGUID     string `json:"objectGuid"`
	SAMAccountName string `json:"sAMAccountName"`
	// OriginalDN is the DN a plain restore recreates: RDN + LastKnownParent
	// (empty when LastKnownParent is unknown).
	OriginalDN    string `json:"originalDN"`
	NamingContext string `json:"namingContext"`
}

// DeletedObjectsList is the content of one Deleted Objects container.
type DeletedObjectsList struct {
	ContainerDN string          `json:"containerDN"`
	Objects     []DeletedObject `json:"objects"`
	// Truncated is true when the size limit was reached: Objects holds the
	// Limit most recently deleted objects (where the server sorts).
	Truncated bool `json:"truncated"`
	// Limit is the size limit that was applied.
	Limit int `json:"limit"`
	// RecycledIncluded tells whether recycled objects were requested
	// (Show Recycled control).
	RecycledIncluded bool `json:"recycledIncluded"`
}

// RestoreRequest asks to restore (reanimate) a deleted object.
type RestoreRequest struct {
	// DN of the deleted object (as listed in DeletedObject.DN).
	DN string `json:"dn"`
	// TargetParentDN is the container to restore into; empty = the last
	// known parent.
	TargetParentDN string `json:"targetParentDN,omitempty"`
	// NewName replaces the original RDN value (e.g. to avoid a name
	// conflict); empty = the original name.
	NewName string `json:"newName,omitempty"`
}

// Error kinds of a failed restore (RestoreResult.ErrorKind).
const (
	RestoreErrParentMissing = "parentMissing" // target container does not exist
	RestoreErrParentDeleted = "parentDeleted" // target container is deleted too
	RestoreErrConflict      = "conflict"      // name / unique attribute already in use
	RestoreErrPermission    = "permission"    // missing rights
	RestoreErrNotRestorable = "notRestorable" // recycled object or refused by the server
	RestoreErrNotFound      = "notFound"      // deleted object is gone (garbage collected)
	RestoreErrInvalidTarget = "invalidTarget" // object not allowed in the target container
	RestoreErrReadOnly      = "readOnly"
	RestoreErrOther         = "other"
)

// RestoreResult is the outcome of one RestoreRequest.
type RestoreResult struct {
	DN       string `json:"dn"`
	Name     string `json:"name"`
	TargetDN string `json:"targetDN"`
	Success  bool   `json:"success"`
	Error    string `json:"error,omitempty"`
	// ErrorKind is one of the RestoreErr* constants.
	ErrorKind string `json:"errorKind,omitempty"`
	// State is the state the object was restored from ("deleted",
	// "tombstone"); empty when the object could not be read.
	State string `json:"state,omitempty"`
	// Without lists attributes a restored tombstone no longer has although
	// they were set before the deletion (from the replication metadata;
	// tombstones lose most attributes), sorted, secrets summarised as
	// "password". Empty when nothing is missing, the metadata is unreadable
	// or the object came from the Recycle Bin (it keeps its attributes).
	Without []string `json:"without,omitempty"`
	// WithoutOther counts further missing attributes whose names could not be
	// resolved (attribute IDs outside the well-known prefixes).
	WithoutOther int `json:"withoutOther,omitempty"`
	// LinksRemoved is true for a tombstone: its group memberships and other
	// links were removed at deletion and are not restored.
	LinksRemoved bool `json:"linksRemoved,omitempty"`
}

// DescendantCount is the number of entries below an entry.
type DescendantCount struct {
	DN string `json:"dn"`
	// Count of descendants (the entry itself excluded); when Capped, there
	// are more than Limit.
	Count  int  `json:"count"`
	Capped bool `json:"capped"`
	Limit  int  `json:"limit"`
	// TreeDeleteSupported reports the tree delete control
	// (1.2.840.113556.1.4.805) in the server's supportedControls.
	TreeDeleteSupported bool   `json:"treeDeleteSupported"`
	ServerType          string `json:"serverType"`
}

// Methods of a subtree delete (SubtreeDeleteOptions.Method).
const (
	SubtreeDeleteAuto       = "auto"       // tree delete control if supported, else client side
	SubtreeDeleteTreeDelete = "treeDelete" // server-side with the tree delete control
	SubtreeDeleteClientSide = "clientSide" // entry by entry, deepest first
)

// SubtreeDeleteOptions controls DeleteSubtree.
type SubtreeDeleteOptions struct {
	// OperationID identifies the run for progress events and
	// CancelSubtreeDelete; chosen by the caller.
	OperationID string `json:"operationId"`
	// Method is "auto" (default), "treeDelete" or "clientSide".
	Method string `json:"method"`
	// StopOnError stops a client-side delete at the first failure; otherwise
	// it continues and skips the ancestors of failed entries.
	StopOnError bool `json:"stopOnError"`
	// Confirmed must be true: the user explicitly confirmed deleting the
	// entry including all its descendants.
	Confirmed bool `json:"confirmed"`
}

// SubtreeDeleteError is one failed or skipped entry of a subtree delete.
type SubtreeDeleteError struct {
	DN      string `json:"dn"`
	Message string `json:"message"`
	Skipped bool   `json:"skipped,omitempty"`
}

// SubtreeDeleteResult is the final report of DeleteSubtree.
type SubtreeDeleteResult struct {
	DN     string `json:"dn"`
	Method string `json:"method"` // "treeDelete" or "clientSide"
	// Total is the number of entries in the subtree including the root
	// (client side; for tree delete the number counted beforehand, -1 if
	// unknown).
	Total int `json:"total"`
	// TotalCapped is true for a tree delete whose count reached the limit:
	// Total (and Deleted) are then lower bounds.
	TotalCapped bool `json:"totalCapped,omitempty"`
	Deleted     int  `json:"deleted"`
	// DeletedUnknown is true when a failed tree delete may have removed part
	// of the subtree but the number could not be determined (Deleted is 0
	// then). Servers delete large trees in several transactions, so a failed
	// tree delete is not necessarily all-or-nothing.
	DeletedUnknown bool                 `json:"deletedUnknown,omitempty"`
	Failed         int                  `json:"failed"`
	Skipped        int                  `json:"skipped"`
	Cancelled      bool                 `json:"cancelled"`
	Errors         []SubtreeDeleteError `json:"errors"`
	// DurationMs is the run time in milliseconds.
	DurationMs int64 `json:"durationMs"`
	// DeletedDNs lists the entries a client-side run deleted, deepest first
	// (at most SubtreeDeletedDNsLimit; DeletedDNsTruncated then). A tree
	// delete is one request: it lists only the root when it succeeded.
	DeletedDNs          []string `json:"deletedDNs,omitempty"`
	DeletedDNsTruncated bool     `json:"deletedDNsTruncated,omitempty"`
}

// SubtreeDeletedDNsLimit caps SubtreeDeleteResult.DeletedDNs.
const SubtreeDeletedDNsLimit = 10000

// SubtreeDeleteProgress is sent as the "recycle:delete-progress" event.
type SubtreeDeleteProgress struct {
	OperationID string `json:"operationId"`
	DN          string `json:"dn"`
	// Phase is "enumerating", "deleting" or "done".
	Phase     string `json:"phase"`
	Method    string `json:"method"`
	Current   int    `json:"current"`
	Total     int    `json:"total"`
	Deleted   int    `json:"deleted"`
	Failed    int    `json:"failed"`
	CurrentDN string `json:"currentDN"`
}

// EntryCheck is the result of an existence check of one DN (target
// containers of move, copy, create and restore).
type EntryCheck struct {
	DN     string `json:"dn"`
	Exists bool   `json:"exists"`
	// Error is set when the DN could not be checked (invalid syntax,
	// referral, connection error); Exists is false then.
	Error string `json:"error,omitempty"`
}

// PosixIDs are the next free POSIX IDs (BrowserService.NextPosixIDs).
type PosixIDs struct {
	UIDNumber int `json:"uidNumber"`
	GIDNumber int `json:"gidNumber"`
	// PrimaryGIDNumber is the gidNumber most existing accounts use as
	// primary group (0 = no accounts): the default for a new account.
	PrimaryGIDNumber int `json:"primaryGidNumber"`
}
