/**
 * Pure helpers for the Deleted Objects view and the recursive delete flow.
 * No React, no Wails: everything here is deterministic and easy to test.
 */
import type {
  DeletedObject, DeletedObjectState, DescendantCount, RecycleBinInfo,
  RestoreErrorKind, RestoreResult, SubtreeDeleteProgress,
} from '../types/recycle';
import { dnDepth, escapeDNValue, firstRDN as firstRDNOf, getParentDN, isDNAtOrBelow, isDNBelow, normalizeDN, parseRDN } from './dn.ts';

// --- DN helpers -------------------------------------------------------------
// Escape-aware helpers live in lib/dn.ts; the recycle names are kept for callers.

export { firstRDNSeparator, firstRDN, normalizeDN, dnDepth } from './dn.ts';
/** The DN without its first RDN ('' for a single RDN). Escape-aware. */
export const parentDN = getParentDN;
/** True when dn lies strictly below ancestor. */
export const isDescendantOf = isDNBelow;

/**
 * Selected DNs reduced to the roots that must be deleted: duplicates and DNs
 * below another selected DN are dropped (deleting the ancestor including its
 * children covers them). Order of the remaining DNs is kept.
 */
export function deletionRoots(dns: string[]): string[] {
  const seen = new Set<string>();
  const unique = dns.filter((dn) => {
    const key = normalizeDN(dn);
    if (!dn.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.filter((dn) => !unique.some((other) => other !== dn && isDescendantOf(dn, other)));
}

/** Escapes an RDN value (RFC 4514), like go-ldap's EscapeDN. */
export const escapeRDNValue = escapeDNValue;

/** The DN a restore creates: <rdnAttribute>=<name>,<parent>. */
export function restoreTargetDN(obj: Pick<DeletedObject, 'rdnAttribute' | 'name'>, parent: string, newName?: string): string {
  const name = (newName ?? '').trim() || obj.name;
  return `${obj.rdnAttribute || 'CN'}=${escapeRDNValue(name)},${parent.trim()}`;
}

/**
 * Target DN of every object of a restore run, as the backend computes it: an
 * object whose deleted container is part of the same run goes into that
 * container's restored DN; all others go into `container` ('' = their last
 * known parent). `newName` applies only when a single object is restored.
 */
export function plannedRestoreTargets(
  objects: Pick<DeletedObject, 'dn' | 'rdnAttribute' | 'name' | 'lastKnownParent' | 'parentDeleted'>[],
  container: string,
  newName?: string,
): Map<string, string> {
  const byKey = new Map(objects.map((o) => [normalizeDN(o.dn), o]));
  const out = new Map<string, string>();
  const single = objects.length === 1;
  const resolve = (o: (typeof objects)[number], seen: Set<string>): string => {
    const done = out.get(o.dn);
    if (done !== undefined) return done;
    const parentObj = o.parentDeleted ? byKey.get(normalizeDN(o.lastKnownParent)) : undefined;
    let parent = container.trim() || o.lastKnownParent;
    if (parentObj && !seen.has(parentObj.dn)) {
      seen.add(parentObj.dn);
      parent = resolve(parentObj, seen);
    }
    const target = restoreTargetDN(o, parent, single ? newName : undefined);
    out.set(o.dn, target);
    return target;
  };
  objects.forEach((o) => resolve(o, new Set([o.dn])));
  return out;
}

/**
 * The DN an object had before it was deleted, for the tabs, bookmarks and
 * recent entries that still use it (M-31). The backend's `originalDN` is
 * built from lastKnownParent, which for a child of a deleted container is
 * that container's mangled "…\0ADEL:…,CN=Deleted Objects" DN: such a parent
 * is resolved through the listed deleted objects to its own original DN
 * (recursively). '' when it cannot be told.
 */
export function originalDNOf(
  obj: Pick<DeletedObject, 'dn' | 'rdnAttribute' | 'name' | 'lastKnownParent' | 'parentDeleted' | 'originalDN'>,
  objects: Pick<DeletedObject, 'dn' | 'rdnAttribute' | 'name' | 'lastKnownParent' | 'parentDeleted' | 'originalDN'>[],
): string {
  const byKey = new Map(objects.map((o) => [normalizeDN(o.dn), o]));
  const resolve = (o: typeof obj, depth: number): string => {
    if (!o.lastKnownParent) return o.parentDeleted ? '' : o.originalDN || '';
    if (!o.parentDeleted && !isDeletedDN(o.lastKnownParent)) return o.originalDN || restoreTargetDN(o, o.lastKnownParent);
    const parent = byKey.get(normalizeDN(o.lastKnownParent));
    if (!parent || depth > 32) return '';
    const parentDN = resolve(parent, depth + 1);
    return parentDN ? restoreTargetDN(o, parentDN) : '';
  };
  return resolve(obj, 0);
}

/** Objects of a selection whose deleted container is selected as well. */
export function countFollowingParent(objects: Pick<DeletedObject, 'dn' | 'lastKnownParent' | 'parentDeleted'>[]): number {
  const keys = new Set(objects.map((o) => normalizeDN(o.dn)));
  return objects.filter((o) => o.parentDeleted && keys.has(normalizeDN(o.lastKnownParent))).length;
}

/**
 * Objects of a (restorable) selection that cannot go back to their last
 * known location: their container is deleted too and is not part of the
 * selection (M-32). "Restore" refuses them (the server would fail); "Restore
 * to…" still takes them.
 */
export function blockedByDeletedParent<T extends Pick<DeletedObject, 'dn' | 'lastKnownParent' | 'parentDeleted'>>(objects: T[]): T[] {
  const keys = new Set(objects.map((o) => normalizeDN(o.dn)));
  return objects.filter((o) => o.parentDeleted && !keys.has(normalizeDN(o.lastKnownParent)));
}

/** Tooltip of a Restore refused by blockedByDeletedParent. */
export function deletedParentHint(blocked: number): string {
  return blocked === 1
    ? 'The container of this object is deleted too — select it as well, or use "Restore to…"'
    : `The containers of ${blocked} selected objects are deleted too — select them as well, or use "Restore to…"`;
}

/** True when a DN points into Deleted Objects (mangled "\0ADEL:" RDN). */
export function isDeletedDN(dn: string): boolean {
  return /\\0adel:|\ndel:/i.test(dn);
}

/** Readable form of a DN that may contain deleted (mangled) RDNs. */
export function displayDN(dn: string): string {
  return dn.replace(/\\0ADEL:[0-9a-f-]+/gi, ' (deleted)');
}

// --- Counting / delete planning --------------------------------------------

/** "1,500" or "more than 10,000". */
export function describeCount(count: number, capped: boolean): string {
  return capped ? `more than ${count.toLocaleString()}` : count.toLocaleString();
}

export interface DeletionPlan {
  /** Roots without children: plain delete */
  leaves: string[];
  /** Roots with children: need recursive delete */
  withChildren: { dn: string; count: number; capped: boolean }[];
  /** Sum of descendants of all roots with children */
  totalDescendants: number;
  anyCapped: boolean;
  treeDeleteSupported: boolean;
}

/** Splits counted roots into plain deletes and recursive deletes. */
export function planDeletion(roots: string[], counts: Record<string, DescendantCount | undefined>): DeletionPlan {
  const plan: DeletionPlan = { leaves: [], withChildren: [], totalDescendants: 0, anyCapped: false, treeDeleteSupported: false };
  for (const dn of roots) {
    const c = counts[dn];
    if (c?.treeDeleteSupported) plan.treeDeleteSupported = true;
    if (!c || c.count === 0) {
      plan.leaves.push(dn);
      continue;
    }
    plan.withChildren.push({ dn, count: c.count, capped: c.capped });
    plan.totalDescendants += c.count;
    plan.anyCapped = plan.anyCapped || c.capped;
  }
  return plan;
}

/** Leaves ordered deepest first, so a selected child goes before its selected parent. */
export function deepestFirst(dns: string[]): string[] {
  return [...dns].sort((a, b) => dnDepth(b) - dnDepth(a));
}

/**
 * 0..100, or null when progress is unknown: enumeration, unknown total, and a
 * server-side tree delete (one request; the server reports no progress).
 */
export function progressPercent(p: Pick<SubtreeDeleteProgress, 'current' | 'total' | 'phase' | 'method'> | null): number | null {
  if (!p || p.phase !== 'deleting' || p.method === 'treeDelete' || p.total <= 0) return null;
  return Math.min(100, Math.round((p.current / p.total) * 100));
}

/** What one root of a delete run did, as far as the tree is concerned. */
export interface DeleteOutcomeSummary {
  dn: string;
  /** The root and everything below it are gone. */
  ok: boolean;
  /** Entries actually deleted (root included). */
  deleted: number;
  /** A failed tree delete may have deleted an unknown part of the subtree. */
  deletedUnknown?: boolean;
}

/**
 * `entries` without the ones a delete run removed: the roots of complete
 * runs and everything below them. A partly deleted subtree is kept as is
 * (which of its entries are gone is not known).
 */
export function withoutDeletedEntries<T extends { dn: string }>(entries: T[], outcomes: DeleteOutcomeSummary[]): T[] {
  const gone = outcomes.filter((o) => o.ok && o.dn.trim()).map((o) => normalizeDN(o.dn));
  if (gone.length === 0) return entries;
  return entries.filter((e) => {
    const key = normalizeDN(e.dn);
    return !gone.some((g) => key === g || key.endsWith(',' + g));
  });
}

export interface TreeRefreshPlan {
  /** Reload the root nodes (a root node of the tree is gone or changed). */
  reloadRoots: boolean;
  /**
   * Loaded tree nodes to reload, shallowest first. quiet: a node below a
   * partly deleted entry, which may be gone itself (no error toast).
   */
  reload: { key: string; quiet: boolean }[];
  /** Loaded tree nodes to drop (stale; loaded again on the next expand). */
  drop: string[];
}

/**
 * Which loaded tree nodes to refresh after a delete run. `loadedKeys` are the
 * DNs whose children the tree has loaded, `rootKeys` the tree's root nodes.
 * A root that is gone: reload its parent (or the root nodes), drop its loaded
 * subtree. A root that is only partly deleted (stopped, failed with
 * continue-on-error, failed tree delete): also reload the root itself and
 * every expanded node below it, drop collapsed loaded nodes below it. Roots
 * where nothing was deleted are left alone, and so are parents the tree has
 * not loaded (nothing of them is shown). DNs are matched case- and
 * spacing-insensitively and mapped to the tree's own spelling of the key.
 */
export function planTreeRefresh(
  outcomes: DeleteOutcomeSummary[],
  loadedKeys: string[],
  isExpanded: (key: string) => boolean,
  rootKeys: string[] = [],
): TreeRefreshPlan {
  const loaded = new Map(loadedKeys.map((k) => [normalizeDN(k), k]));
  const roots = new Set(rootKeys.map(normalizeDN));
  const parents = new Set<string>();
  const below = new Set<string>();
  const drop = new Set<string>();
  let reloadRoots = false;
  for (const o of outcomes) {
    if (!o.ok && o.deleted <= 0 && !o.deletedUnknown) continue; // nothing changed
    if (roots.has(normalizeDN(o.dn))) reloadRoots = true;
    const parentKey = loaded.get(normalizeDN(parentDN(o.dn)));
    if (parentKey) parents.add(parentKey);
    const inSubtree = loadedKeys.filter((k) => normalizeDN(k) === normalizeDN(o.dn) || isDescendantOf(k, o.dn));
    for (const k of inSubtree) {
      if (!o.ok && isExpanded(k)) below.add(k);
      else drop.add(k);
    }
  }
  const reload = [
    ...[...parents].map((key) => ({ key, quiet: false })),
    ...[...below].filter((k) => !parents.has(k)).map((key) => ({ key, quiet: true })),
  ].sort((a, b) => dnDepth(a.key) - dnDepth(b.key));
  for (const r of reload) drop.delete(r.key);
  return { reloadRoots, reload, drop: [...drop] };
}

/** Minimal tree node shape for isNamingContextNode. */
interface NCNode {
  dn: string;
  icon: string;
  children?: NCNode[];
}

/**
 * True for the tree nodes that offer "Deleted Objects…": the root nodes and
 * the domain nodes of an AD forest (globe icon, DC= DN) loaded below them.
 */
export function isNamingContextNode(dn: string, roots: NCNode[]): boolean {
  const key = normalizeDN(dn);
  if (roots.some((n) => normalizeDN(n.dn) === key)) return true;
  const walk = (list: NCNode[] | undefined): boolean => !!list?.some((n) =>
    (n.icon === 'globe' && /^dc=/i.test(n.dn.trim()) && normalizeDN(n.dn) === key) || walk(n.children));
  return walk(roots);
}

// --- Deleted objects view ----------------------------------------------------

export type DeletedTypeFilter = 'all' | 'user' | 'computer' | 'group' | 'ou' | 'contact' | 'other';

export const DELETED_TYPE_LABELS: Record<DeletedTypeFilter, string> = {
  all: 'All types',
  user: 'Users',
  computer: 'Computers',
  group: 'Groups',
  ou: 'OUs / containers',
  contact: 'Contacts',
  other: 'Other',
};

/** Category of a deleted object for the type filter. */
export function deletedTypeCategory(obj: Pick<DeletedObject, 'objectClass'>): Exclude<DeletedTypeFilter, 'all'> {
  const oc = obj.objectClass.map((c) => c.toLowerCase());
  if (oc.includes('computer')) return 'computer';
  if (oc.includes('user') || oc.includes('inetorgperson') || oc.includes('msds-groupmanagedserviceaccount') || oc.includes('msds-managedserviceaccount')) return 'user';
  if (oc.includes('group')) return 'group';
  if (oc.includes('organizationalunit') || oc.includes('container')) return 'ou';
  if (oc.includes('contact')) return 'contact';
  return 'other';
}

export interface DeletedObjectFilter {
  text: string;
  type: DeletedTypeFilter;
  hideRecycled: boolean;
}

/** Client-side filter of the loaded deleted objects. */
export function filterDeletedObjects(objects: DeletedObject[], f: DeletedObjectFilter): DeletedObject[] {
  const needle = f.text.trim().toLowerCase();
  return objects.filter((o) => {
    if (f.hideRecycled && !o.restorable) return false;
    if (f.type !== 'all' && deletedTypeCategory(o) !== f.type) return false;
    if (!needle) return true;
    return [o.name, o.sAMAccountName, o.lastKnownParent, o.structuralClass, o.objectSid, o.objectGuid]
      .some((v) => v && v.toLowerCase().includes(needle));
  });
}

export const STATE_LABELS: Record<DeletedObjectState, string> = {
  deleted: 'Deleted',
  tombstone: 'Tombstone',
  recycled: 'Recycled',
};

export const STATE_DESCRIPTIONS: Record<DeletedObjectState, string> = {
  deleted: 'Deleted while the AD Recycle Bin is enabled: all attributes and group memberships are kept and come back with a restore.',
  tombstone: 'Tombstone (Recycle Bin not enabled): most attributes and all group memberships/links were stripped. A restore brings back the object with its SID, GUID and the kept attributes only — re-add memberships, reset the password and enable the account afterwards.',
  recycled: 'Recycled: the deleted-object lifetime has passed. The object is kept only for replication and cannot be restored.',
};

/** Paragraphs explaining the server's deleted-object behaviour. */
export function recycleBinExplanation(info: RecycleBinInfo): string[] {
  if (!info.supported) return [info.reason || 'Deleted objects are not available on this server.'];
  const lines: string[] = [];
  if (!info.recycleBinKnown) {
    lines.push('The state of the AD Recycle Bin could not be read (no access to CN=Partitions in the configuration partition).');
  } else if (info.recycleBinEnabled) {
    lines.push('The AD Recycle Bin is enabled: deleted objects keep all attributes and group memberships until the deleted-object lifetime expires; after that they become recycled and can no longer be restored.');
  } else {
    lines.push('The AD Recycle Bin is not enabled: deleted objects are tombstones. They can be restored (reanimated), but most attributes and all group memberships were removed at deletion.');
  }
  const tsl = info.tombstoneLifetimeDays > 0 ? `${info.tombstoneLifetimeDays} days` : 'server default (60 or 180 days)';
  if (info.recycleBinEnabled) {
    const dol = info.deletedObjectLifetimeDays > 0 ? `${info.deletedObjectLifetimeDays} days` : `same as tombstone lifetime (${tsl})`;
    lines.push(`Deleted-object lifetime: ${dol}. Tombstone lifetime: ${tsl}.`);
  } else {
    lines.push(`Tombstone lifetime: ${tsl}; after that the object is purged.`);
  }
  if (!info.showRecycledSupported) {
    lines.push('The server does not support the Show Recycled control, so recycled objects are not listed.');
  }
  return lines;
}

export const RESTORE_ERROR_LABELS: Record<RestoreErrorKind, string> = {
  parentMissing: 'Container missing',
  parentDeleted: 'Container deleted',
  conflict: 'Name conflict',
  permission: 'No permission',
  notRestorable: 'Not restorable',
  notFound: 'Gone',
  invalidTarget: 'Invalid target',
  readOnly: 'Read-only',
  other: 'Failed',
};

/** Error kinds where choosing another target container (or name) helps. */
export function suggestsRestoreTo(kind?: RestoreErrorKind): boolean {
  return kind === 'parentMissing' || kind === 'parentDeleted' || kind === 'conflict' || kind === 'invalidTarget';
}

export interface RestoreSummary {
  ok: number;
  failed: number;
  needsTarget: number;
}

export function summarizeRestore(results: RestoreResult[]): RestoreSummary {
  let ok = 0, failed = 0, needsTarget = 0;
  for (const r of results) {
    if (r.success) ok++;
    else {
      failed++;
      if (suggestsRestoreTo(r.errorKind)) needsTarget++;
    }
  }
  return { ok, failed, needsTarget };
}

/** Local date/time of an RFC 3339 timestamp ('' stays ''). */
export function formatTimestamp(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Number of bytes encoded by a padded base64 string. */
export function base64ByteLength(b64: string): number {
  const s = b64.replace(/\s/g, '');
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

// --- Delete confirmation (LIFE-08) ------------------------------------------

/** More entries than this need the typed confirmation. */
export const TYPED_DELETE_THRESHOLD = 500;

export type DeleteConfirmKind = 'none' | 'checkbox' | 'typeDN' | 'typeCount';

export interface DeleteConfirmation {
  kind: DeleteConfirmKind;
  /** What the user must type (typeDN: the DN, typeCount: "DELETE <n>"). */
  phrase: string;
  /** Naming-context heads among the roots (the whole directory partition goes). */
  ncHeads: string[];
}

/**
 * How a delete must be confirmed: a naming-context head (tree root, AD
 * domain) or more than 500 entries need typing, one NC head its DN,
 * otherwise "DELETE <n>"; other recursive deletes a checkbox; leaves nothing.
 */
export function deleteConfirmation(roots: string[], isNCHead: (dn: string) => boolean, totalEntries: number, recursive: boolean): DeleteConfirmation {
  const ncHeads = roots.filter(isNCHead);
  if (ncHeads.length === 1 && roots.length === 1) return { kind: 'typeDN', phrase: ncHeads[0], ncHeads };
  if (ncHeads.length > 0 || totalEntries > TYPED_DELETE_THRESHOLD) return { kind: 'typeCount', phrase: `DELETE ${totalEntries}`, ncHeads };
  return { kind: recursive ? 'checkbox' : 'none', phrase: '', ncHeads };
}

/** Whether the typed text confirms (DN: compared as DN; count phrase: exact, outer blanks ignored). */
export function typedConfirmationMatches(c: Pick<DeleteConfirmation, 'kind' | 'phrase'>, typed: string): boolean {
  const t = typed.trim();
  if (c.kind === 'typeDN') return !!t && normalizeDN(t) === normalizeDN(c.phrase);
  if (c.kind === 'typeCount') return t === c.phrase;
  return true;
}

/**
 * A typed name confirmation (Clear Audit Log: the connection name): case,
 * accents, blanks and punctuation do not count, so "lab samba ad ldaps"
 * confirms "Lab · Samba AD (LDAPS)" — the middle dot is on no keyboard
 * (RW1-R-07). The letters and digits must all be typed.
 */
export function typedNameMatches(typed: string, expected: string): boolean {
  const fold = (v: string) => v.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const e = fold(expected);
  return e !== '' && fold(typed) === e;
}

/** Display name of a DN: the unescaped value of its first RDN. */
export function entryName(dn: string): string {
  const rdn = firstRDNOf(dn);
  return (rdn && parseRDN(rdn).value) || dn;
}

/** Toast text after a delete: names up to three entries ("ux-1 deleted", "3 entries deleted (a, b, c)"). */
export function deleteToastText(dns: string[]): string {
  if (dns.length === 1) return `${entryName(dns[0])} deleted`;
  const names = dns.slice(0, 3).map(entryName).join(', ');
  return dns.length <= 3 ? `${dns.length} entries deleted (${names})` : `${dns.length.toLocaleString()} entries deleted (${names}, …)`;
}

export interface DeleteReportOutcome extends DeleteOutcomeSummary {
  method: 'plain' | 'treeDelete' | 'clientSide';
  failed: number;
  skipped: number;
  cancelled: boolean;
  errors: { dn: string; message: string; skipped?: boolean }[];
  /** DNs this root's run deleted (deepest first). */
  deletedDNs?: string[];
  deletedDNsTruncated?: boolean;
}

/** Plain-text delete report (Copy report): summary, one line per root, errors and the deleted DNs. */
export function deleteReportText(outcomes: DeleteReportOutcome[], profileName = ''): string {
  const deleted = outcomes.reduce((n, o) => n + o.deleted, 0);
  const failed = outcomes.reduce((n, o) => n + o.failed, 0);
  const skipped = outcomes.reduce((n, o) => n + o.skipped, 0);
  const lines = [
    `Delete report${profileName ? ` (${profileName})` : ''}: ${deleted} deleted, ${failed} failed, ${skipped} skipped${outcomes.some((o) => o.cancelled) ? ', stopped' : ''}`,
    '',
  ];
  for (const o of outcomes) {
    const method = o.method === 'treeDelete' ? 'tree delete' : o.method === 'clientSide' ? 'client-side' : 'delete';
    lines.push(`${o.ok ? 'OK' : o.cancelled ? 'STOPPED' : 'FAILED'} ${o.dn} (${method}): deleted ${o.deletedUnknown ? 'unknown' : o.deleted}, failed ${o.failed}, skipped ${o.skipped}`);
    for (const e of o.errors) lines.push(`  ${e.skipped ? 'skipped' : 'error'} ${e.dn}: ${e.message}`);
  }
  const gone = outcomes.flatMap((o) => o.deletedDNs ?? (o.ok && o.method === 'plain' ? [o.dn] : []));
  if (gone.length > 0) {
    lines.push('', `Deleted entries (${gone.length}${outcomes.some((o) => o.deletedDNsTruncated) ? '+' : ''}):`);
    for (const dn of gone) lines.push(dn);
    if (outcomes.some((o) => o.method === 'treeDelete' && o.ok)) lines.push('(a tree delete lists only its root: the server deleted everything below it)');
  }
  return lines.join('\n');
}

/**
 * entry-deleted events of a delete run: a complete root once (subtree when
 * it was a recursive delete), the deleted entries of a partial run one by one.
 */
export function deletedEvents(outcomes: DeleteReportOutcome[]): { dn: string; subtree: boolean }[] {
  const out: { dn: string; subtree: boolean }[] = [];
  for (const o of outcomes) {
    if (o.ok) out.push({ dn: o.dn, subtree: o.method !== 'plain' });
    else for (const dn of o.deletedDNs ?? []) out.push({ dn, subtree: false });
  }
  return out;
}

// --- Deleted objects view: selection, types, restore targets (LIFE-06/07) ----

/** Friendly type name of a deleted object ("OU", "User", "Contact", …). */
export function friendlyTypeName(obj: Pick<DeletedObject, 'objectClass' | 'structuralClass'>): string {
  const oc = obj.objectClass.map((c) => c.toLowerCase());
  if (oc.includes('msds-groupmanagedserviceaccount') || oc.includes('msds-managedserviceaccount')) return 'Service account';
  if (oc.includes('computer')) return 'Computer';
  if (oc.includes('user') || oc.includes('inetorgperson')) return 'User';
  if (oc.includes('contact')) return 'Contact';
  if (oc.includes('group')) return 'Group';
  if (oc.includes('organizationalunit')) return 'OU';
  if (oc.includes('container')) return 'Container';
  if (oc.includes('dnsnode')) return 'DNS record';
  if (oc.includes('dnszone')) return 'DNS zone';
  const s = obj.structuralClass || obj.objectClass[obj.objectClass.length - 1] || '';
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Object';
}

/**
 * The object dn plus every listed deleted object below it: objects whose
 * chain of last known (deleted) parents leads to dn.
 */
export function withDeletedChildren(objects: Pick<DeletedObject, 'dn' | 'lastKnownParent' | 'parentDeleted'>[], dn: string): string[] {
  const byParent = new Map<string, string[]>();
  for (const o of objects) {
    if (!o.parentDeleted || !o.lastKnownParent) continue;
    const k = normalizeDN(o.lastKnownParent);
    byParent.set(k, [...(byParent.get(k) ?? []), o.dn]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (d: string) => {
    const k = normalizeDN(d);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(d);
    for (const c of byParent.get(k) ?? []) walk(c);
  };
  walk(dn);
  return out;
}

/** DNs from anchor to focus (inclusive) in list order; [focus] when the anchor is not listed. */
export function rangeBetween(order: string[], anchor: string | null, focus: string): string[] {
  const a = anchor ? order.indexOf(anchor) : -1;
  const f = order.indexOf(focus);
  if (f < 0) return [];
  if (a < 0) return [focus];
  return order.slice(Math.min(a, f), Math.max(a, f) + 1);
}

/**
 * Live containers a deleted object could go back to, nearest first: its
 * last known parent, or (when that is deleted too) the last known parent of
 * that deleted container (followed through listed deleted objects), then
 * every ancestor of it up to the naming context. Never CN=Users unless it is
 * on that chain. The caller checks which of them exist.
 */
export function restoreTargetCandidates(obj: Pick<DeletedObject, 'lastKnownParent'>, objects: Pick<DeletedObject, 'dn' | 'lastKnownParent'>[]): string[] {
  const byDN = new Map(objects.map((o) => [normalizeDN(o.dn), o]));
  let live = obj.lastKnownParent;
  for (let guard = 0; guard < 32 && live && isDeletedDN(live); guard++) {
    const parent = byDN.get(normalizeDN(live));
    live = parent ? parent.lastKnownParent : '';
  }
  const out: string[] = [];
  for (let dn = live, guard = 0; dn && guard < 64; dn = getParentDN(dn), guard++) out.push(dn);
  return out;
}

/**
 * The first candidate that exists (restoreTargetCandidates order); '' when
 * none is known to exist.
 */
export function nearestExisting(candidates: string[], exists: (dn: string) => boolean | undefined): string {
  return candidates.find((dn) => exists(dn) === true) ?? '';
}

/**
 * What a restore did not bring back, for the result: "mail, givenName, sn
 * and 2 more attributes, group memberships" ('' when nothing is missing).
 */
export function describeRestoreLoss(r: Pick<RestoreResult, 'without' | 'withoutOther' | 'linksRemoved'>, max = 6): string {
  const names = r.without ?? [];
  const parts: string[] = [];
  const more = Math.max(0, names.length - max) + (r.withoutOther ?? 0);
  if (names.length) parts.push(names.slice(0, max).join(', ') + (more ? ` and ${more} more attribute${more === 1 ? '' : 's'}` : ''));
  else if (more) parts.push(`${more} attribute${more === 1 ? '' : 's'}`);
  if (r.linksRemoved) parts.push('group memberships');
  return parts.join('; ');
}

/** True when dn is a naming context of the server (or at or below none of them: unknown → false). */
export function isNamingContextDN(dn: string, namingContexts: string[]): boolean {
  const k = normalizeDN(dn);
  return namingContexts.some((nc) => normalizeDN(nc) === k);
}

/** Whether `dn` lies at or below the naming context `nc`. */
export const inNamingContext = (dn: string, nc: string) => isDNAtOrBelow(dn, nc);
