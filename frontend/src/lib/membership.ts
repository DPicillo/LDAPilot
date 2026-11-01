/**
 * Pure helpers for the membership views (no React, no backend calls). Only
 * types and `.ts` modules are imported, so node tests can load it.
 */
import type { LDAPEntry } from '../types/ldap';
import type {
  MembershipChangeResult,
  MembershipCycle,
  MembershipDirection,
  MembershipItem,
  MembershipResult,
} from '../types/membership';
import { escapeFilterValue } from './ldapFilter.ts';
import { normalizeDN, splitDN as splitDNParts, unescapeDNValue } from './dn.ts';
import { toCSV } from './bulk.ts';
import { KIND_ATTRIBUTES, kindNeedsAttributes } from '../components/ui/objectKind.ts';

export type MembershipMode = 'direct' | 'effective';

/** Anything with LDAP attributes (LDAPEntry and lighter shapes). */
export interface AttrHolder {
  attributes?: { name: string; values: string[] }[];
}

/** Lowercase object classes that make an entry a group (mirrors Go groupClasses). */
export const GROUP_CLASSES = [
  'group', 'groupofnames', 'groupofuniquenames', 'posixgroup', 'groupofurls', 'groupofentries', 'groupofmembers',
];

/** Object classes of entries that can be put into groups. */
const MEMBER_CLASSES = [
  'person', 'user', 'organizationalperson', 'inetorgperson', 'computer', 'posixaccount', 'account', 'contact',
  'foreignsecurityprincipal', 'simplesecurityobject',
];

/** Splits a DN into its trimmed RDNs (escape-aware, lib/dn.ts); [] for ''. */
export function splitDN(dn: string): string[] {
  return dn.trim() ? splitDNParts(dn).map((p) => p.trim()) : [];
}

/** Display name of a DN: the unescaped value of its first RDN ("CN=Doe\, John,OU=x" → "Doe, John"). */
export function rdnValue(dn: string): string {
  const first = splitDN(dn)[0] ?? dn;
  const eq = first.indexOf('=');
  if (eq < 0) return dn;
  return unescapeDNValue(first.slice(eq + 1).trim());
}

/** Case-insensitive comparison key of a DN (spaces around separators ignored). */
export function dnKey(dn: string): string {
  return normalizeDN(dn);
}

function attrValues(entry: AttrHolder | undefined, name: string): string[] {
  const lower = name.toLowerCase();
  return entry?.attributes?.find((a) => a.name.toLowerCase() === lower)?.values ?? [];
}

/** Lowercase object classes of an entry. */
export function objectClassesOf(entry: AttrHolder | undefined): string[] {
  return attrValues(entry, 'objectClass').map((v) => v.toLowerCase());
}

export function isGroupEntry(entry: AttrHolder | undefined): boolean {
  return objectClassesOf(entry).some((oc) => GROUP_CLASSES.includes(oc));
}

/** Whether a posixGroup is involved, so plain uids (memberUid) may be added. */
export function acceptsUidMembers(entry: AttrHolder | undefined): boolean {
  return objectClassesOf(entry).includes('posixgroup');
}

/**
 * Raw counts from the entry's own attributes (members: member + uniqueMember
 * + memberUid). memberOf counts the AD primary group (primaryGroupID) too:
 * AD never lists it in memberOf, but the Member Of list shows it, so the
 * sub-tab badge, the summary header and the list agree.
 */
export function rawMembershipCounts(entry: AttrHolder | undefined): { members: number; memberOf: number } {
  const memberOf = new Set(attrValues(entry, 'memberOf').map(dnKey));
  const primary = attrValues(entry, 'primaryGroupID').some((v) => /^\d+$/.test(v.trim()) && v.trim() !== '0') && !isGroupEntry(entry) ? 1 : 0;
  // One member is counted once: the same DN in member and uniqueMember, or
  // (RFC 2307bis) a memberUid whose uid is the uid= RDN of a listed DN, as the
  // Members list shows it.
  const dns = new Set([...attrValues(entry, 'member'), ...attrValues(entry, 'uniqueMember')].map((v) => dnKey(stripOptionalUID(v))));
  const uidsOfDNs = new Set([...dns].map((k) => /^uid=([^,]+),/i.exec(k)?.[1]).filter((u): u is string => !!u));
  const uids = new Set(attrValues(entry, 'memberUid').map((u) => u.trim().toLowerCase()).filter((u) => u && !uidsOfDNs.has(u)));
  return {
    members: dns.size + uids.size,
    memberOf: memberOf.size + primary,
  };
}

/**
 * Whether the Membership tab is useful for the entry: it has membership
 * attributes, is a group, has a primary group, or is an object that can be
 * added to groups.
 */
export function hasMembershipInfo(entry: AttrHolder | undefined): boolean {
  if (!entry?.attributes) return false;
  const names = new Set(entry.attributes.map((a) => a.name.toLowerCase()));
  if (['member', 'uniquemember', 'memberuid', 'memberof', 'primarygroupid', 'gidnumber'].some((n) => names.has(n))) return true;
  const classes = objectClassesOf(entry);
  return classes.some((oc) => GROUP_CLASSES.includes(oc) || MEMBER_CLASSES.includes(oc));
}

/** Classifies an object by its object classes (mirrors Go memberObjectType). */
export function objectTypeFromClasses(classes: string[], presentAttributes?: readonly string[] | null): string {
  const has = new Set(classes.map((c) => c.toLowerCase()));
  if (GROUP_CLASSES.some((c) => has.has(c))) return 'group';
  // LDAP devices / hosts are computers, as in the tree and the menus (M-05).
  if (has.has('computer') || has.has('device') || has.has('iphost')) return 'computer';
  if (has.has('foreignsecurityprincipal')) return 'foreignSecurityPrincipal';
  if (has.has('contact')) return 'contact';
  // An LDAP person without an account class, uid or a password is a contact, as in the tree (M-06).
  if (presentAttributes && kindNeedsAttributes(classes)) {
    const present = new Set(presentAttributes.map((a) => a.toLowerCase().split(';')[0]));
    if (!KIND_ATTRIBUTES.some((a) => present.has(a.toLowerCase()))) return 'contact';
  }
  if (['user', 'person', 'inetorgperson', 'organizationalperson', 'posixaccount', 'account', 'simplesecurityobject'].some((c) => has.has(c))) return 'user';
  return 'other';
}

/** Strips the optional "#'0101'B" UID of a uniqueMember value. */
export function stripOptionalUID(value: string): string {
  return value.replace(/#'[01]*'B$/, '');
}

/**
 * Builds a direct-only result from the entry's own attributes. Used when the
 * backend is not available (browser preview); types are unknown.
 */
export function rawMembershipResult(entry: LDAPEntry, direction: MembershipDirection): MembershipResult {
  const items: MembershipItem[] = [];
  const add = (dn: string, name: string, unresolved = false) =>
    items.push({ dn, name, objectType: direction === 'memberOf' ? 'group' : 'unknown', direct: true, depth: 1, path: [], unresolved });
  if (direction === 'members') {
    for (const v of [...attrValues(entry, 'member'), ...attrValues(entry, 'uniqueMember')]) {
      const dn = stripOptionalUID(v);
      add(dn, rdnValue(dn));
    }
    for (const uid of attrValues(entry, 'memberUid')) add('', uid, true);
  } else {
    for (const dn of attrValues(entry, 'memberOf')) add(dn, rdnValue(dn));
  }
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const typeCounts: Record<string, number> = {};
  for (const it of items) typeCounts[it.objectType] = (typeCounts[it.objectType] ?? 0) + 1;
  return {
    dn: entry.dn,
    direction,
    effective: false,
    method: 'raw',
    isGroup: isGroupEntry(entry),
    items,
    directCount: items.length,
    maxDepth: items.length ? 1 : 0,
    typeCounts,
    cycles: [],
    truncated: false,
    warnings: ['Read from the entry attributes only (nested groups and primary groups are not resolved)'],
    queries: 0,
    durationMs: 0,
  };
}

/** Display names of the path groups of an item. */
export function pathNames(item: MembershipItem): string[] {
  return (item.path ?? []).map(rdnValue);
}

/**
 * Filters items by a free-text query (name, DN, path groups, type) and an
 * optional object type.
 */
export function filterMembershipItems(items: MembershipItem[], query: string, type?: string | null): MembershipItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((it) => {
    if (type && it.objectType !== type) return false;
    if (!q) return true;
    return (
      it.name.toLowerCase().includes(q) ||
      it.dn.toLowerCase().includes(q) ||
      it.objectType.toLowerCase().includes(q) ||
      pathNames(it).some((n) => n.toLowerCase().includes(q))
    );
  });
}

const TYPE_ORDER = ['user', 'group', 'computer', 'contact', 'foreignSecurityPrincipal', 'other', 'unknown'];
const TYPE_NAMES: Record<string, [string, string]> = {
  user: ['user', 'users'],
  group: ['group', 'groups'],
  computer: ['computer', 'computers'],
  contact: ['contact', 'contacts'],
  foreignSecurityPrincipal: ['foreign principal', 'foreign principals'],
  other: ['other', 'other'],
  unknown: ['unknown', 'unknown'],
};

/** "1 user", "3 groups", ... */
export function typeLabel(type: string, count: number): string {
  const [one, many] = TYPE_NAMES[type] ?? [type, type];
  return `${count} ${count === 1 ? one : many}`;
}

/** Type counts in a fixed order, without zero entries. */
export function orderedTypeCounts(counts: Record<string, number> | undefined): { type: string; count: number }[] {
  const entries = Object.entries(counts ?? {}).filter(([, n]) => n > 0);
  entries.sort(([a], [b]) => {
    const ia = TYPE_ORDER.indexOf(a), ib = TYPE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return entries.map(([type, count]) => ({ type, count }));
}

/**
 * The membership chain of an item as names, from the resolved entry to the
 * item: memberOf "user → G1 → G2" (is member of), members "group → G1 → user"
 * (contains).
 */
export function membershipChain(rootName: string, item: MembershipItem): string[] {
  return [rootName, ...pathNames(item), item.name];
}

/** Tooltip text explaining how an item belongs to the resolved entry. */
export function membershipTooltip(rootName: string, item: MembershipItem, direction: MembershipDirection): string {
  const lines: string[] = [];
  const relation = direction === 'memberOf' ? 'is member of' : 'contains';
  if (item.primary) {
    const attr = item.primary === 'posix' ? 'gidNumber' : 'primaryGroupID';
    const kind = `${item.primary === 'posix' ? 'POSIX primary group' : 'primary group'} (${attr})`;
    if (item.path.length > 0) {
      lines.push(`Member of ${rdnValue(item.path[item.path.length - 1])} through its ${kind}`);
    } else {
      lines.push(direction === 'memberOf' ? kind[0].toUpperCase() + kind.slice(1) : `Member through its ${kind}`);
      if (item.primaryOnly) {
        lines.push(`Not stored in the group's member list; change ${attr} of the ${direction === 'memberOf' ? 'entry' : 'member'} to change it`);
      }
    }
  }
  if (item.depth === 0) {
    lines.push(direction === 'memberOf'
      ? 'Listed in memberOf by the server, but no search found how the entry belongs to it (e.g. hidden by access rights or outside the search base); the path is unknown'
      : 'Reported by the server; the nesting path could not be determined');
  } else if (item.direct) {
    if (!item.primaryOnly) lines.push(direction === 'memberOf' ? 'Direct membership' : 'Direct member');
  } else {
    lines.push(`Inherited (nesting level ${item.depth}): ${membershipChain(rootName, item).join(' → ')}`);
    lines.push(`(${relation})`);
    for (const dn of item.path) lines.push(`  via ${dn}`);
  }
  if (item.inCycle) lines.push('Part of a circular group nesting');
  if (item.unresolved) lines.push(item.dn ? 'Object not found or not readable' : 'memberUid without matching account');
  if (item.external) lines.push('Held by another server (e.g. another domain of the forest); not resolved here');
  if (item.dn) lines.push(item.dn);
  return lines.join('\n');
}

/** "GG-A → GG-B → GG-A" */
export function cycleText(cycle: MembershipCycle): string {
  return cycle.path.map(rdnValue).join(' → ');
}

/** Stable key of an item (DN, or uid for an unresolved memberUid). */
export function itemKey(item: MembershipItem): string {
  return item.dn ? dnKey(item.dn) : 'uid:' + item.name.toLowerCase();
}

/** The value to send for removing an item: its DN, or its uid for an unresolved memberUid. */
export function removalValue(item: MembershipItem): string {
  return item.dn || item.name;
}

/**
 * Direct items stored in a member attribute can be removed. Membership only
 * through the primary group (primaryGroupID / gidNumber) is not stored in the
 * group and cannot be removed there.
 */
export function canRemoveItem(item: MembershipItem, readOnly: boolean): boolean {
  return !readOnly && item.direct && !item.primaryOnly && (item.dn !== '' || item.name !== '');
}

/**
 * Number shown on the Members / Member Of view tabs: direct items plus those
 * the server reported with unknown path (depth 0), which may be direct.
 */
export function listedDirectCount(result: MembershipResult): number {
  return result.items.filter((it) => it.direct || it.depth === 0).length;
}

/** Whether an error message means the resolution was cancelled. */
export function isCancelledMessage(message: string): boolean {
  return /search cancelled/i.test(message);
}

/** Splits pasted text into DNs/uids: one per line, trimmed, without duplicates. */
export function parseDNList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const v = line.trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/** Search filter for the member/group picker (input escaped per RFC 4515). */
export function pickerSearchFilter(text: string, groupsOnly: boolean): string {
  const v = escapeFilterValue(text.trim());
  const name = `(|(cn=*${v}*)(sAMAccountName=*${v}*)(uid=*${v}*)(displayName=*${v}*))`;
  if (!groupsOnly) return name;
  const groups = '(|(objectClass=group)(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))';
  return `(&${groups}${name})`;
}

// --- Member picker ---

/**
 * What typed picker text stands for: a DN (contains "="), a plain uid
 * (posix groups only, no whitespace), or nothing that can be added as is.
 */
export function pickerTypedKind(text: string, acceptsUid: boolean): 'dn' | 'uid' | null {
  const v = text.trim();
  if (!v) return null;
  if (v.includes('=')) return 'dn';
  if (acceptsUid && !/\s/.test(v)) return 'uid';
  return null;
}

export interface PickerState {
  text: string;
  acceptsUid: boolean;
  /** Suggestions shown in the dropdown (possibly still those of an earlier text). */
  suggestionCount: number;
  /** The search for the current text has not answered yet. */
  pending: boolean;
  /** Highlighted option: 0..suggestionCount-1 a suggestion, suggestionCount the "add memberUid" option, -1 none. */
  selectedIdx: number;
  chipCount: number;
  /** The typed uid is already in the chips (no "add memberUid" option then). */
  uidTaken?: boolean;
}

/**
 * Whether the dropdown offers adding the typed text as memberUid. Only shown
 * once the search for the text has answered, after the suggestions, so that
 * a plain uid is only ever added by choosing it explicitly.
 */
export function uidOptionVisible(s: Pick<PickerState, 'text' | 'acceptsUid' | 'pending' | 'uidTaken'>): boolean {
  return pickerTypedKind(s.text, s.acceptsUid) === 'uid' && !s.pending && !s.uidTaken;
}

/** Number of dropdown options: the suggestions plus the "add memberUid" option. */
export function pickerOptionCount(s: Pick<PickerState, 'text' | 'acceptsUid' | 'pending' | 'suggestionCount' | 'uidTaken'>): number {
  return s.suggestionCount + (uidOptionVisible(s) ? 1 : 0);
}

export type PickerEnterAction =
  /** Add option `index` (a suggestion, or the "add memberUid" option) to the chips. */
  | { kind: 'pick'; index: number }
  /** Add the typed DN to the chips. */
  | { kind: 'addDN' }
  /** Submit the chips. */
  | { kind: 'submit' }
  | { kind: 'none' };

/**
 * What Enter does in the member picker: add the highlighted option, the only
 * suggestion, or a typed DN to the chips; with empty input submit the chips.
 * A search term is never added as a value by itself, so "chris" cannot end
 * up as memberUid when the suggestion "christian.braun" was meant.
 */
export function pickerEnterAction(s: PickerState): PickerEnterAction {
  const kind = pickerTypedKind(s.text, s.acceptsUid);
  if (!s.text.trim()) return s.chipCount > 0 ? { kind: 'submit' } : { kind: 'none' };
  if (kind === 'dn') return { kind: 'addDN' };
  if (s.selectedIdx >= 0 && s.selectedIdx < pickerOptionCount(s)) return { kind: 'pick', index: s.selectedIdx };
  if (!s.pending && s.suggestionCount === 1) return { kind: 'pick', index: 0 };
  return { kind: 'none' };
}

export interface ChangeSummary {
  level: 'success' | 'info' | 'warning' | 'error';
  message: string;
  detail?: string;
}

/**
 * Summarizes a MembershipChangeResult for a toast, e.g. "Added 2 members,
 * 1 already a member, 1 failed". Failures and warnings go into the detail.
 */
export function describeMembershipChange(
  result: MembershipChangeResult,
  op: 'add' | 'remove',
  noun: 'member' | 'group',
): ChangeSummary {
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const changed = result.changed?.length ?? 0;
  const unchanged = result.unchanged?.length ?? 0;
  const failed = result.failed ?? [];
  const parts: string[] = [];
  if (changed) {
    if (noun === 'member') parts.push(`${op === 'add' ? 'Added' : 'Removed'} ${n(changed, 'member')}`);
    else parts.push(`${op === 'add' ? 'Added to' : 'Removed from'} ${n(changed, 'group')}`);
  }
  if (unchanged) parts.push(op === 'add' ? `${unchanged} already a member` : `${unchanged} not a member`);
  const warnings = result.warnings ?? [];
  if (failed.length) parts.push(`${failed.length} failed`);
  if (warnings.length) parts.push(n(warnings.length, 'warning'));
  const message = parts.length ? parts.join(', ') : 'Nothing to change';
  const lines = [...failed.map((f) => `${f.dn}: ${f.error}`), ...warnings];
  const detail = lines.length ? lines.join('\n') : undefined;
  const level = failed.length ? 'error' : warnings.length ? 'warning' : changed ? 'success' : 'info';
  return { level, message, detail };
}

// --- Export, picker ranking, add planning (LIFE-10) ---

/** "via" text of an item: the path group names ("G1 > G2"), '' for direct items. */
export function viaText(item: MembershipItem): string {
  return pathNames(item).join(' > ');
}

/** Flags of an item for exports ("primary", "cycle", "itself", …). */
function itemFlags(item: MembershipItem): string {
  const f: string[] = [];
  if (item.self) f.push('itself');
  if (item.primary) f.push(item.primary === 'posix' ? 'primary (gid)' : 'primary');
  if (item.inCycle) f.push('cycle');
  if (item.unresolved) f.push(item.dn ? 'not found' : 'no account');
  if (item.external) f.push('other server');
  return f.join(' ');
}

const EXPORT_HEADER = ['name', 'type', 'dn', 'via', 'depth', 'flags'];

function exportRows(items: MembershipItem[]): (string | number)[][] {
  return items.map((it) => [it.name, it.objectType, it.dn || `memberUid: ${it.name}`, viaText(it), it.depth, itemFlags(it)]);
}

/** CSV of a membership list (name, type, DN, via, depth, flags); formula-safe. */
export function membershipCSV(items: MembershipItem[]): string {
  return toCSV(EXPORT_HEADER, exportRows(items));
}

/** Tab-separated table with a header line (Copy as table: pastes into spreadsheets). */
export function membershipTable(items: MembershipItem[]): string {
  const clean = (v: string | number) => String(v).replace(/[\t\r\n]+/g, ' ');
  return [EXPORT_HEADER, ...exportRows(items)].map((r) => r.map(clean).join('\t')).join('\n') + '\n';
}

/** File name for an export: "<name>-members.csv" / "<name>-member-of.csv" (safe characters only). */
export function membershipExportName(dn: string, direction: MembershipDirection, effective: boolean): string {
  const base = rdnValue(dn).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'entry';
  return `${base}-${direction === 'members' ? 'members' : 'member-of'}${effective ? '-effective' : ''}.csv`;
}

const KIND_RANK: Record<string, number> = { user: 0, group: 1, computer: 2, contact: 3, foreignSecurityPrincipal: 4, other: 5, unknown: 6 };

export interface PickerHit {
  dn: string;
  name: string;
  type: string;
}

/**
 * Picker suggestions in a useful order: exact name match first, then names
 * starting with the query, then the rest; within each, users before groups
 * before computers (groups first when only groups are searched anyway),
 * then by name.
 */
export function rankPickerHits<T extends PickerHit>(hits: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  const tier = (h: T) => {
    const n = h.name.toLowerCase();
    return n === q ? 0 : n.startsWith(q) ? 1 : 2;
  };
  return [...hits].sort((a, b) =>
    tier(a) - tier(b)
    || (KIND_RANK[a.type] ?? 9) - (KIND_RANK[b.type] ?? 9)
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/**
 * Splits the values to add into those to send and those already present
 * (direct members / groups by DN, memberUid values by uid): known values are
 * not sent to the server and reported as "unchanged".
 */
export function splitKnownMembers(values: string[], items: MembershipItem[]): { send: string[]; known: string[] } {
  const keys = new Set<string>();
  for (const it of items) {
    if (!it.direct) continue;
    if (it.dn) keys.add(dnKey(it.dn));
    else if (it.name) keys.add('uid:' + it.name.toLowerCase());
  }
  const send: string[] = [];
  const known: string[] = [];
  for (const v of values) {
    const k = v.includes('=') ? dnKey(v) : 'uid:' + v.trim().toLowerCase();
    (keys.has(k) ? known : send).push(v);
  }
  return { send, known };
}

/** A change result with the values skipped client-side added as unchanged. */
export function withSkippedUnchanged(result: MembershipChangeResult | null, skipped: string[]): MembershipChangeResult {
  const base = result ?? { changed: [], unchanged: [], failed: [], warnings: [] };
  return { ...base, unchanged: [...(base.unchanged ?? []), ...skipped] };
}

/** True when value names the entry itself (a group cannot contain itself). */
export function isSelfReference(value: string, selfDN: string): boolean {
  return value.includes('=') && dnKey(value) === dnKey(selfDN);
}

/**
 * Values that would close a circular nesting: `nesting` holds the DNs that
 * already contain the entry through nesting (members view: the entry's
 * effective groups; Member Of view: the effective members of the entry,
 * when the entry is a group). Adding one of them makes A ∈ B ∈ … ∈ A.
 */
export function cycleCreatingValues(values: string[], nesting: string[]): string[] {
  const keys = new Set(nesting.map(dnKey));
  return values.filter((v) => v.includes('=') && keys.has(dnKey(v)));
}

/** "n of N shown" while a filter hides items, else ''. */
export function shownText(shown: number, total: number): string {
  return shown < total ? `${shown} of ${total} shown` : '';
}
