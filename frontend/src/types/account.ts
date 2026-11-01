/**
 * Account status types - mirror internal/models/account.go.
 * All times are RFC 3339 strings (UTC); "" or missing means not set/unknown.
 */
import type { LDAPEntry } from './ldap';

export type AccountKind = 'user' | 'computer' | 'serviceAccount';

/** Action ids, also the keys of AccountStatus.unsupported. */
export type AccountActionId =
  | 'unlock'
  | 'enable'
  | 'disable'
  | 'mustChange'
  | 'neverExpires'
  | 'accountExpires'
  | 'uac'
  | 'resetPassword';

export type AccountPolicySource =
  | 'pso'
  | 'domain'
  | 'subentry'
  | 'default'
  | 'assumed'
  | 'global'
  | 'unknown'
  | 'none';

/** Effective password / lockout policy - mirrors Go AccountPolicy. */
export interface AccountPolicy {
  dn?: string;
  name: string;
  source: AccountPolicySource;
  readable: boolean;
  lockoutEnabled: boolean;
  lockoutThreshold: number;
  /** 0 = locked until an administrator unlocks. */
  lockoutDurationSeconds: number;
  observationWindowSeconds: number;
  /** 0 = passwords never expire. */
  maxPasswordAgeSeconds: number;
  minPasswordAgeSeconds: number;
  minPasswordLength: number;
  passwordHistory: number;
  expireWarningSeconds: number;
  graceLogins: number;
  mustChangeEnforced: boolean;
  /** complexityEnabled / reversibleEncryption were read (AD pwdProperties, PSO, 389DS passwordCheckSyntax). */
  complexityKnown?: boolean;
  complexityEnabled?: boolean;
  reversibleEncryption?: boolean;
}

/** Normalized account status - mirrors Go AccountStatus. */
export interface AccountStatus {
  dn: string;
  serverType: string;
  applicable: boolean;
  reason?: string;
  kind?: AccountKind;
  evaluated: string;

  enabled: boolean;
  disabledBy?: string;
  disabledByRole?: boolean;

  locked: boolean;
  lockedPermanently?: boolean;
  lockedAt?: string;
  lockedUntil?: string;
  lockoutExpired?: boolean;
  badPasswordCount: number;
  lastBadPassword?: string;

  passwordLastSet?: string;
  passwordExpires?: string;
  passwordExpired: boolean;
  passwordNeverExpires: boolean;
  passwordExpiryNote?: string;
  mustChangePassword: boolean;

  accountExpires?: string;
  accountExpired: boolean;
  accountNeverExpires: boolean;

  lastLogon?: string;
  lastLogonReplicated?: string;
  logonCount: number;
  hasLogonCount: boolean;
  created?: string;

  userAccountControl: number;
  userAccountControlComputed: number;

  policy?: AccountPolicy;
  /** How the policy was found (e.g. OpenLDAP: assumed default); shown once, not as a warning. */
  policyNote?: string;
  unsupported: Partial<Record<AccountActionId, string>>;
  warnings: string[];
}

export type AccountReportKind =
  | 'locked'
  | 'disabled'
  | 'passwordExpiring'
  | 'passwordExpired'
  | 'neverLoggedOn'
  /** Groups without members (AD: minus primary groups; LDAP: minus POSIX primary groups). */
  | 'emptyGroups'
  /** AD: direct and nested members of the built-in privileged groups. */
  | 'privilegedMembers';

/** Mirrors Go AccountReportParams. */
export interface AccountReportParams {
  report: AccountReportKind;
  baseDN: string;
  days: number;
  sizeLimit: number;
  /** Re-read only these rows (after an account action); result.matches says whether each still matches. */
  dns?: string[];
}

/** Mirrors Go AccountReportResult. */
export interface AccountReportResult {
  entries: LDAPEntry[];
  totalCount: number;
  truncated: boolean;
  candidates: number;
  columns: string[];
  notes: string[];
  /** Computed account status of each entry (same order; account reports only). */
  statuses?: AccountStatus[];
  /** Computed columns of each entry by title (same order), e.g. "Privileged groups". */
  extra?: Record<string, string>[];
  /** Re-read rows only: whether each entry still matches the report. */
  matches?: boolean[];
}

/** Mirrors Go ReportAvailability. */
export interface ReportAvailability {
  serverType: string;
  /** Report kind -> reason it cannot run on this server. */
  unavailable: Record<string, string>;
}
