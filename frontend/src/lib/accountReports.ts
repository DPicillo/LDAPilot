/**
 * Pure helpers of the Reports panel: the report catalog per server type,
 * availability, the Days parameter, the summary and empty texts, and the
 * display rows of backend reports (computed columns, sorted by name).
 */
import type { AccountReportKind, AccountReportResult, AccountStatus } from '../types/account';
import type { LDAPAttribute, LDAPEntry } from '../types/ldap';
import { formatSortableDateTime, wholeDaysUntil } from './accountTime.ts';
import { firstRDN, normalizeDN, parseRDN } from './dn.ts';

export type ReportCategory = 'users' | 'security' | 'groups' | 'system';

/** AD or a generic LDAP server (OpenLDAP, 389DS, other). */
type Family = 'ad' | 'ldap';

export interface ReportDefinition {
  id: string;
  name: string;
  /** Shown below the name; "N" is replaced with the Days value. */
  description: string;
  category: ReportCategory;
  /** Filter of a plain search report per server family (ldap falls back to ad). */
  filters?: Partial<Record<Family, string>>;
  /** Backend report (statuses computed per account, group reports). */
  accountReport?: AccountReportKind;
  /** Takes a "within N days" parameter. */
  takesDays?: boolean;
  /** Display columns of a filter report per server family. */
  columns?: Partial<Record<Family, string[]>>;
  /** Lists accounts: the search also asks for the account status attributes (Status column). */
  accounts?: boolean;
  /** Only meaningful on Active Directory (greyed elsewhere). */
  adOnly?: boolean;
  /** Positive text for an empty result ("No locked-out accounts"); "N" = days. */
  empty: string;
}

const AD_USERS = '(&(objectCategory=person)(objectClass=user))';
const LDAP_USERS = '(|(objectClass=inetOrgPerson)(objectClass=posixAccount)(objectClass=account))';
const ALL_GROUPS = '(|(objectClass=group)(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))';

export const REPORTS: ReportDefinition[] = [
  // Users
  {
    id: 'all-users', name: 'All Users', description: 'All user accounts', category: 'users', accounts: true,
    filters: { ad: AD_USERS, ldap: LDAP_USERS },
    columns: { ad: ['sAMAccountName', 'mail', 'description'], ldap: ['uid', 'mail', 'description'] },
    empty: 'No user accounts below the base DN',
  },
  {
    id: 'users-no-email', name: 'Users Without Email', description: 'Users who have no email address set', category: 'users', accounts: true,
    filters: { ad: `(&${AD_USERS}(!(mail=*)))`, ldap: `(&${LDAP_USERS}(!(mail=*)))` },
    columns: { ad: ['sAMAccountName', 'description', 'department'], ldap: ['uid', 'description', 'ou'] },
    empty: 'Every user has an email address',
  },
  {
    id: 'users-no-login', name: 'Users Never Logged On', description: 'Accounts without any recorded logon', category: 'users',
    accountReport: 'neverLoggedOn', empty: 'Every account has logged on at least once',
  },
  {
    id: 'service-accounts', name: 'Service Accounts', description: 'Managed service accounts (MSA and gMSA)', category: 'users', adOnly: true, accounts: true,
    filters: { ad: '(|(objectClass=msDS-ManagedServiceAccount)(objectClass=msDS-GroupManagedServiceAccount))' },
    columns: { ad: ['sAMAccountName', 'description', 'whenCreated'] },
    empty: 'No managed service accounts',
  },
  {
    id: 'posix-users', name: 'POSIX Users', description: 'Accounts with POSIX attributes (RFC 2307 uidNumber)', category: 'users', accounts: true,
    filters: { ad: '(&(objectClass=user)(|(objectClass=posixAccount)(uidNumber=*)))', ldap: '(|(objectClass=posixAccount)(uidNumber=*))' },
    columns: { ad: ['sAMAccountName', 'uidNumber', 'gidNumber', 'unixHomeDirectory'], ldap: ['uid', 'uidNumber', 'gidNumber', 'homeDirectory'] },
    empty: 'No accounts with POSIX attributes',
  },

  // Security
  {
    id: 'disabled-accounts', name: 'Disabled Accounts', description: 'Users, computers and service accounts that are disabled', category: 'security',
    accountReport: 'disabled', empty: 'No disabled accounts',
  },
  {
    id: 'locked-accounts', name: 'Locked-Out Users', description: 'Lockouts still in effect (expired lockouts are skipped)', category: 'security',
    accountReport: 'locked', empty: 'No locked-out accounts',
  },
  {
    id: 'pwd-expiring', name: 'Passwords Expiring Soon', description: 'Enabled accounts whose password expires within N days', category: 'security',
    accountReport: 'passwordExpiring', takesDays: true, empty: 'No password expires within N days',
  },
  {
    id: 'pwd-expired', name: 'Expired Passwords', description: 'Enabled accounts whose password has expired', category: 'security',
    accountReport: 'passwordExpired', empty: 'No expired passwords (accounts that must change their password are not counted)',
  },
  {
    id: 'pwd-never-expires', name: 'Password Never Expires', description: 'Accounts with non-expiring passwords', category: 'security', adOnly: true, accounts: true,
    filters: { ad: '(&(objectClass=user)(userAccountControl:1.2.840.113556.1.4.803:=65536))' },
    columns: { ad: ['sAMAccountName', 'mail', 'description'] },
    empty: 'No account has "Password never expires" set',
  },
  {
    id: 'pwd-not-required', name: 'Password Not Required', description: "Accounts that don't require a password (security risk)", category: 'security', adOnly: true, accounts: true,
    filters: { ad: '(&(objectClass=user)(userAccountControl:1.2.840.113556.1.4.803:=32))' },
    columns: { ad: ['sAMAccountName', 'description'] },
    empty: 'No account has "Password not required" set',
  },
  {
    id: 'privileged-members', name: 'Privileged Group Members', description: 'Direct and nested members of Domain/Enterprise/Schema Admins, Administrators and the operator groups', category: 'security',
    accountReport: 'privilegedMembers', adOnly: true, empty: 'The privileged groups have no account members',
  },
  {
    id: 'admin-accounts', name: 'Admin Accounts', description: 'Accounts protected by AdminSDHolder (adminCount=1)', category: 'security', adOnly: true, accounts: true,
    filters: { ad: '(&(objectClass=user)(adminCount=1))' },
    columns: { ad: ['sAMAccountName', 'mail', 'description'] },
    empty: 'No account has adminCount=1',
  },

  // Groups
  {
    id: 'all-groups', name: 'All Groups', description: 'Groups of every kind (group, groupOfNames, groupOfUniqueNames, posixGroup)', category: 'groups',
    filters: { ad: ALL_GROUPS },
    columns: { ad: ['sAMAccountName', 'description', 'mail'], ldap: ['description', 'gidNumber'] },
    empty: 'No groups below the base DN',
  },
  {
    id: 'empty-groups', name: 'Empty Groups', description: 'Groups without members (primary groups are not empty)', category: 'groups',
    accountReport: 'emptyGroups', empty: 'No empty groups',
  },
  {
    id: 'posix-groups', name: 'POSIX Groups', description: 'Groups with a gidNumber (RFC 2307)', category: 'groups',
    filters: { ad: '(|(objectClass=posixGroup)(&(objectClass=group)(gidNumber=*)))' },
    columns: { ad: ['gidNumber', 'description', 'sAMAccountName'], ldap: ['gidNumber', 'memberUid', 'description'] },
    empty: 'No POSIX groups',
  },

  // System
  {
    id: 'all-ous', name: 'Organizational Units', description: 'All OUs in the directory', category: 'system',
    filters: { ad: '(objectClass=organizationalUnit)' }, columns: { ad: ['ou', 'description', 'l', 'st'] },
    empty: 'No organizational units below the base DN',
  },
  {
    id: 'all-computers', name: 'Computers', description: 'Computer accounts (AD) or devices and hosts (LDAP)', category: 'system', accounts: true,
    filters: {
      ad: '(&(objectClass=computer)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))',
      ldap: '(|(objectClass=device)(objectClass=ipHost))',
    },
    columns: { ad: ['description', 'operatingSystem', 'operatingSystemVersion'], ldap: ['description', 'ipHostNumber', 'serialNumber'] },
    empty: 'No computers below the base DN',
  },
  {
    id: 'all-entries', name: 'All Entries', description: 'Everything below the base DN', category: 'system',
    filters: { ad: '(objectClass=*)' }, columns: { ad: ['description'] },
    empty: 'No entries below the base DN',
  },
];

function family(serverType: string | null | undefined): Family {
  return serverType === 'ad' ? 'ad' : 'ldap';
}

/** The filter of a filter report on a server type (LDAP servers fall back to the common filter). */
export function reportFilter(def: ReportDefinition, serverType: string | null | undefined): string {
  const f = def.filters ?? {};
  return (family(serverType) === 'ad' ? f.ad : f.ldap ?? f.ad) ?? '';
}

/** The display columns of a filter report on a server type. */
export function reportColumns(def: ReportDefinition, serverType: string | null | undefined): string[] {
  const c = def.columns ?? {};
  return (family(serverType) === 'ad' ? c.ad : c.ldap ?? c.ad) ?? [];
}

/**
 * Why a report cannot run on this server (shown greyed with the reason), or
 * null: AD-only reports on other servers ("Active Directory only"), backend
 * reports the server cannot answer (unavailable from GetReportAvailability,
 * e.g. no logon tracking). Unknown server type: everything is offered.
 */
export function reportUnavailableReason(
  def: ReportDefinition,
  serverType: string | null | undefined,
  unavailable: Record<string, string> | null | undefined,
): string | null {
  if (def.adOnly && serverType && serverType !== 'ad') return 'Active Directory only';
  if (def.accountReport && unavailable?.[def.accountReport]) return unavailable[def.accountReport];
  return null;
}

/** Inserts the Days value for "N" in a description or empty text. */
export function withDays(text: string, days: number): string {
  return text.replace(/\bN\b/g, String(days)).replace(/\b1 days\b/g, '1 day');
}

export const REPORT_DAYS_MIN = 1;
export const REPORT_DAYS_MAX = 3650;
export const REPORT_DAYS_DEFAULT = 14;

/** Days parameter of the "passwords expiring" report: an integer in 1..3650, 14 when invalid. */
export function clampReportDays(input: string | number): number {
  return correctReportDays(input).days;
}

/**
 * Validates the Days field: the value to use and, when the input was not a
 * whole number in 1..3650, the corrected value and why (the field shows the
 * corrected value instead of silently running with another one).
 */
export function correctReportDays(input: string | number): { days: number; corrected: boolean; message?: string } {
  const raw = typeof input === 'number' ? input : Number(String(input).trim());
  if (String(input).trim() === '' || !Number.isFinite(raw)) {
    return { days: REPORT_DAYS_DEFAULT, corrected: true, message: `Enter 1 to ${REPORT_DAYS_MAX} days; using ${REPORT_DAYS_DEFAULT}.` };
  }
  const n = Math.floor(raw);
  if (n < REPORT_DAYS_MIN) return { days: REPORT_DAYS_MIN, corrected: true, message: 'At least 1 day; corrected to 1.' };
  if (n > REPORT_DAYS_MAX) return { days: REPORT_DAYS_MAX, corrected: true, message: `At most ${REPORT_DAYS_MAX} days; corrected to ${REPORT_DAYS_MAX}.` };
  if (n !== raw) return { days: n, corrected: true, message: `Whole days only; corrected to ${n}.` };
  return { days: n, corrected: false };
}

export interface ReportSummary {
  title: string;
  /** 'success' for an empty (good news) result, 'info' otherwise. */
  tone: 'success' | 'info';
  lines: string[];
}

/** Title and text lines summarizing a backend report result. */
export function summarizeAccountReport(
  name: string,
  result: AccountReportResult | null | undefined,
  emptyText = '',
  noun: [string, string] = ['account', 'accounts'],
): ReportSummary {
  if (!result) return { title: name, tone: 'info', lines: [`${name}: no result (not running under Wails?)`] };
  const n = result.entries?.length ?? 0;
  const lines = n === 0 && emptyText
    ? [`${emptyText} (${result.candidates} checked).`]
    : [`${n} ${n === 1 ? noun[0] : noun[1]} (${result.candidates} checked)`];
  if (result.truncated) lines.push('The result is incomplete (size limit reached).');
  for (const note of result.notes || []) lines.push(note);
  return { title: name, tone: n === 0 && !result.truncated ? 'success' : 'info', lines };
}

/** Value of the first RDN, the name a report row is sorted by. */
export function entryName(dn: string): string {
  return parseRDN(firstRDN(dn)).value || dn;
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Entries sorted by name (first RDN value), then DN. */
export function sortEntriesByName<T extends { dn: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => nameCollator.compare(entryName(a.dn), entryName(b.dn)) || nameCollator.compare(a.dn, b.dn));
}

/**
 * Computed report columns are named like their header ("Days left"). They
 * contain a blank, so they can never be an LDAP attribute description and
 * exports that write LDIF can leave them out.
 */
export function isComputedReportColumn(name: string): boolean {
  return /\s/.test(name);
}

function nameColumn(serverType: string | null | undefined): string {
  return family(serverType) === 'ad' ? 'sAMAccountName' : 'uid';
}

/** The computed columns (title -> value) of one account of a backend report. */
export function accountReportColumns(kind: AccountReportKind, st: AccountStatus | undefined, now: Date): Record<string, string> {
  if (!st) return {};
  switch (kind) {
    case 'locked':
      // A row re-read after Unlock shows no lock any more.
      if (!st.locked) return { 'Failed logons': String(st.badPasswordCount ?? 0) };
      return {
        'Locked since': formatSortableDateTime(st.lockedAt),
        'Locked until': st.lockedUntil ? formatSortableDateTime(st.lockedUntil) : st.lockedPermanently ? 'permanent' : 'unknown',
        'Failed logons': String(st.badPasswordCount ?? 0),
      };
    case 'disabled':
      return { 'Disabled by': st.disabledBy ?? '' };
    case 'passwordExpiring':
      return {
        'Password expires': formatSortableDateTime(st.passwordExpires),
        'Days left': st.passwordExpires ? String(Math.max(0, wholeDaysUntil(new Date(st.passwordExpires), now))) : '',
      };
    case 'passwordExpired':
      return { 'Password expired': formatSortableDateTime(st.passwordExpires) };
    case 'neverLoggedOn':
      return { 'Created': formatSortableDateTime(st.created), 'Password last set': formatSortableDateTime(st.passwordLastSet) };
    default:
      return {};
  }
}

/** The display columns of a backend report (computed ones included). */
export function accountReportDisplayColumns(kind: AccountReportKind, serverType: string | null | undefined, backend: string[]): string[] {
  const name = nameColumn(serverType);
  switch (kind) {
    case 'locked':
      return [name, 'Locked since', 'Locked until', 'Failed logons'];
    case 'disabled':
      // AD always says "ACCOUNTDISABLE flag"; LDAP servers differ (nsAccountLock, role, permanent ppolicy lock).
      return family(serverType) === 'ad' ? [name, 'description', 'whenChanged'] : [name, 'Disabled by', 'description'];
    case 'passwordExpiring':
      return [name, 'mail', 'Password expires', 'Days left'];
    case 'passwordExpired':
      return [name, 'mail', 'Password expired'];
    case 'neverLoggedOn':
      return [name, 'Created', 'Password last set', 'description'];
    default:
      return backend;
  }
}

function withColumns(entry: LDAPEntry, cols: Record<string, string>): LDAPEntry {
  const extra: LDAPAttribute[] = Object.entries(cols)
    .filter(([, v]) => v !== '')
    .map(([name, v]): LDAPAttribute => ({ name, values: [v], binary: false }));
  if (extra.length === 0) return entry;
  const names = new Set(extra.map((a) => a.name.toLowerCase()));
  return { ...entry, attributes: [...(entry.attributes ?? []).filter((a) => !names.has(a.name.toLowerCase())), ...extra] };
}

export interface ReportRow {
  entry: LDAPEntry;
  status?: AccountStatus;
}

/**
 * The rows of a backend report for the results table: each entry with its
 * computed columns (account report: from its status; group reports: the
 * backend's extra columns), sorted by name.
 */
export function buildReportRows(kind: AccountReportKind, result: AccountReportResult, now: Date): ReportRow[] {
  const rows = (result.entries ?? []).map((entry, i) => {
    const status = result.statuses?.[i];
    const cols = { ...accountReportColumns(kind, status, now), ...(result.extra?.[i] ?? {}) };
    return { entry: withColumns(entry, cols), status };
  });
  const order = sortEntriesByName(rows.map((r, i) => ({ dn: r.entry.dn, i })));
  return order.map((o) => rows[o.i]);
}

/**
 * Group reports (empty groups, privileged members): their computed columns
 * come from the whole report, so a re-read row keeps them (the backend
 * re-reads only the entry's attributes).
 */
export function isGroupReport(kind: AccountReportKind): boolean {
  return kind === 'emptyGroups' || kind === 'privilegedMembers';
}

/**
 * The current report rows after re-reading some of them (account action):
 * re-read entries replace their row in place, requested DNs that came back
 * no more (deleted) are removed, other rows stay. With keepComputed (group
 * reports) a re-read row keeps the old row's computed columns it lacks;
 * account reports compute them again from the new status (an unlocked row
 * loses "Locked until").
 */
export function patchReportRows(current: LDAPEntry[], requested: string[], reread: ReportRow[], keepComputed = false): LDAPEntry[] {
  const fresh = new Map(reread.map((r) => [normalizeDN(r.entry.dn), r.entry]));
  const gone = new Set(requested.map(normalizeDN).filter((k) => !fresh.has(k)));
  const out: LDAPEntry[] = [];
  for (const e of current) {
    const k = normalizeDN(e.dn);
    if (gone.has(k)) continue;
    const next = fresh.get(k);
    if (!next) {
      out.push(e);
    } else if (keepComputed) {
      const have = new Set((next.attributes ?? []).map((a) => a.name.toLowerCase()));
      const kept = (e.attributes ?? []).filter((a) => isComputedReportColumn(a.name) && !have.has(a.name.toLowerCase()));
      out.push(kept.length > 0 ? { ...next, attributes: [...(next.attributes ?? []), ...kept] } : next);
    } else {
      out.push(next);
    }
  }
  return out;
}
