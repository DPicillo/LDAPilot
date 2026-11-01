/**
 * Deleted objects (AD tombstones / Recycle Bin), restore and subtree delete.
 * Mirrors internal/models/recycle.go.
 */

/**
 * - deleted: Recycle Bin enabled, all attributes and memberships kept, fully restorable
 * - tombstone: Recycle Bin not enabled, most attributes + all memberships stripped, restorable
 * - recycled: Recycle Bin enabled and deleted-object lifetime passed, not restorable
 */
export type DeletedObjectState = 'deleted' | 'tombstone' | 'recycled';

export type NamingContextKind = 'domain' | 'configuration' | 'application';

export interface DeletedObjectsContainer {
  namingContext: string;
  /** "CN=Deleted Objects,<nc>"; empty when error is set */
  dn: string;
  kind: NamingContextKind;
  error?: string;
}

export interface RecycleBinInfo {
  supported: boolean;
  /** Why deleted objects are not available (non-AD server, missing control) */
  reason?: string;
  serverType: string;
  recycleBinEnabled: boolean;
  /** false when msDS-EnabledFeature could not be read */
  recycleBinKnown: boolean;
  showRecycledSupported: boolean;
  treeDeleteSupported: boolean;
  /** 0 = not set (server default) */
  tombstoneLifetimeDays: number;
  deletedObjectLifetimeDays: number;
  defaultNamingContext: string;
  containers: DeletedObjectsContainer[];
}

export interface DeletedObject {
  /** Current DN (mangled "\0ADEL:<guid>" RDN below CN=Deleted Objects) */
  dn: string;
  /** Original name without the DEL suffix */
  name: string;
  rdnAttribute: string;
  objectClass: string[];
  structuralClass: string;
  lastKnownRDN: string;
  lastKnownParent: string;
  /** lastKnownParent is itself a deleted object */
  parentDeleted: boolean;
  /** whenChanged (RFC 3339) */
  deletedAt: string;
  whenCreated: string;
  isRecycled: boolean;
  state: DeletedObjectState;
  restorable: boolean;
  objectSid: string;
  objectGuid: string;
  sAMAccountName: string;
  /** DN a plain restore recreates (RDN + lastKnownParent) */
  originalDN: string;
  namingContext: string;
}

export interface DeletedObjectsList {
  containerDN: string;
  objects: DeletedObject[];
  /** The size limit was reached: objects holds the `limit` most recently deleted (where the server sorts) */
  truncated: boolean;
  /** Size limit that was applied */
  limit: number;
  recycledIncluded: boolean;
}

export interface RestoreRequest {
  dn: string;
  /** Empty = last known parent */
  targetParentDN?: string;
  /** Empty = original name */
  newName?: string;
}

export type RestoreErrorKind =
  | 'parentMissing'
  | 'parentDeleted'
  | 'conflict'
  | 'permission'
  | 'notRestorable'
  | 'notFound'
  | 'invalidTarget'
  | 'readOnly'
  | 'other';

export interface RestoreResult {
  dn: string;
  name: string;
  targetDN: string;
  success: boolean;
  error?: string;
  errorKind?: RestoreErrorKind;
  /** State the object was restored from ('deleted' | 'tombstone') */
  state?: DeletedObjectState;
  /** Attributes the restored object came back without (replication metadata; secrets as "password") */
  without?: string[];
  /** Further missing attributes whose names could not be resolved */
  withoutOther?: number;
  /** Tombstone: group memberships and other links were removed at deletion */
  linksRemoved?: boolean;
}

export interface DescendantCount {
  dn: string;
  /** Descendants (the entry itself excluded); when capped there are more than `limit` */
  count: number;
  capped: boolean;
  limit: number;
  treeDeleteSupported: boolean;
  serverType: string;
}

export type SubtreeDeleteMethod = 'auto' | 'treeDelete' | 'clientSide';

export interface SubtreeDeleteOptions {
  operationId: string;
  method: SubtreeDeleteMethod;
  stopOnError: boolean;
  /** Must be true: the user confirmed deleting all descendants */
  confirmed: boolean;
}

export interface SubtreeDeleteError {
  dn: string;
  message: string;
  skipped?: boolean;
}

export interface SubtreeDeleteResult {
  dn: string;
  method: 'treeDelete' | 'clientSide';
  /** Entries incl. the root; -1 = unknown (tree delete without count) */
  total: number;
  /** Tree delete of more entries than the count limit: total/deleted are lower bounds */
  totalCapped?: boolean;
  deleted: number;
  /** A failed tree delete may have deleted part of the subtree; the number is unknown (deleted is 0) */
  deletedUnknown?: boolean;
  failed: number;
  skipped: number;
  cancelled: boolean;
  errors: SubtreeDeleteError[];
  durationMs: number;
  /** Entries a client-side run deleted (deepest first); a tree delete lists only its root */
  deletedDNs?: string[];
  deletedDNsTruncated?: boolean;
}

/** Payload of the "recycle:delete-progress" Wails event */
export interface SubtreeDeleteProgress {
  operationId: string;
  dn: string;
  phase: 'enumerating' | 'deleting' | 'done';
  method: string;
  current: number;
  total: number;
  deleted: number;
  failed: number;
  currentDN: string;
}

// --- Lifecycle helpers (BrowserService.EntriesExist / NextPosixIDs; BatchService.BatchMove) ---

/** Existence check of one DN - mirrors Go models.EntryCheck */
export interface EntryCheck {
  dn: string;
  exists: boolean;
  /** Set when the DN could not be checked (invalid syntax, referral, connection) */
  error?: string;
}

/** Next free POSIX IDs - mirrors Go models.PosixIDs */
export interface PosixIDs {
  uidNumber: number;
  gidNumber: number;
  /** gidNumber most accounts use as primary group (0 = no accounts) */
  primaryGidNumber: number;
}

/** BatchService.BatchMove result (Go services.BatchResult incl. the move fields) */
export interface BatchMoveResult {
  total: number;
  succeeded: number;
  failed: number;
  errors: { dn: string; message: string }[];
  /** Entries already in the target container */
  unchanged?: number;
  /** Old and new DN of every moved entry */
  moved?: { dn: string; newDN: string }[];
  /** Nothing ran: the target does not exist, is one of the entries or lies below one (reason in errors) */
  refused?: boolean;
}
