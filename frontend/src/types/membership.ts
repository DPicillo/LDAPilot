/**
 * Group membership types, mirroring internal/models/membership.go.
 */

export type MembershipDirection = 'memberOf' | 'members';

export type MemberObjectType =
  | 'user'
  | 'group'
  | 'computer'
  | 'contact'
  | 'foreignSecurityPrincipal'
  | 'other'
  | 'unknown';

/** "ad" = AD primaryGroupID, "posix" = posixAccount gidNumber. */
export type PrimaryGroupKind = 'ad' | 'posix';

export interface MembershipItem {
  /** Empty for a memberUid without matching account. */
  dn: string;
  /** RDN value (or the uid of an unresolved memberUid). */
  name: string;
  objectType: MemberObjectType | string;
  /** Depth 1: direct group / direct member (including primary group). Depth 0 items are not direct. */
  direct: boolean;
  /** Nesting depth along the shortest path; 0 = reported by the server, path unknown. */
  depth: number;
  /** Intermediate group DNs between the resolved entry and this item, nearest to the entry first. */
  path: string[];
  primary?: PrimaryGroupKind | '';
  /** Direct item that belongs to the entry only through the primary group (not stored in a member attribute, not removable there). */
  primaryOnly?: boolean;
  inCycle?: boolean;
  /** Object not found / not readable, or memberUid without account. */
  unresolved?: boolean;
  /** Held by another server (referral, outside its naming contexts, e.g. another forest domain); not resolved here. */
  external?: boolean;
  /** The resolved group itself, stored as a member of itself (removable self-reference). */
  self?: boolean;
}

export interface MembershipCycle {
  /** Group DNs in nesting order, ending with the first one. */
  path: string[];
}

export interface MembershipResult {
  dn: string;
  direction: MembershipDirection;
  effective: boolean;
  /** "ad-chain", "ad-direct", "search" or "search-direct" ("raw" = built from the entry's attributes in the frontend). */
  method: string;
  isGroup: boolean;
  /** member, uniqueMember or memberUid (members direction). */
  memberAttribute?: string;
  items: MembershipItem[];
  directCount: number;
  maxDepth: number;
  typeCounts: Record<string, number>;
  cycles: MembershipCycle[];
  truncated: boolean;
  warnings: string[];
  queries: number;
  durationMs: number;
}

export interface MembershipChangeFailure {
  dn: string;
  error: string;
}

export interface MembershipChangeResult {
  changed: string[];
  unchanged: string[];
  failed: MembershipChangeFailure[];
  /** Changes made that may not be what was meant (e.g. memberUid without account). */
  warnings?: string[];
}
