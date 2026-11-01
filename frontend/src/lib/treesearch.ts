/**
 * Pure helpers for the directory tree: root lookup and tree-search bases,
 * tree-state maintenance (refresh plans, re-keying after moves), display
 * labels (naming-context heads, search hits), drag-and-drop move planning,
 * and the entry-event names of TRIAGE §0.1.
 *
 * Imports only `.ts` modules (and types), so `node --test` can load it
 * (tests/tree.*.test.ts).
 */
import type { TreeNode } from '../types/ldap'
import { getParentDN, isDNAtOrBelow, isDNBelow, normalizeDN, parseRDN, splitDN } from './dn.ts'
import { escapeFilterValue } from './ldapFilter.ts'

// Escape-aware DN helpers live in lib/dn.ts (re-exported for existing callers).
export { normalizeDN, splitDN, firstRDN, getParentDN, isDNAtOrBelow } from './dn.ts';

/**
 * The root node that contains `dn`. With nested roots (Active Directory shows
 * CN=Schema,CN=Configuration,... and CN=Configuration,... next to the
 * domain) the deepest one wins.
 */
export function findOwningRoot<T extends { dn: string }>(roots: T[], dn: string): T | null {
  let best: T | null = null;
  let bestLen = -1;
  for (const root of roots) {
    const len = normalizeDN(root.dn).length;
    if (len > bestLen && isDNAtOrBelow(dn, root.dn)) {
      best = root;
      bestLen = len;
    }
  }
  return best;
}

/**
 * The tree root an entry belongs to, for the editor breadcrumb's first crumb
 * (ED-15): the tree roots plus the naming-context heads injected below them
 * (child domains, Schema below a scoped Configuration; `isNcHead`), never an
 * ordinary preloaded child such as CN=Users, which would hide the domain.
 */
export function owningTreeRoot<T extends { dn: string; children?: T[] }>(roots: readonly T[], dn: string, isNcHead: (dn: string) => boolean): T | null {
  const candidates: T[] = [];
  const walk = (list: readonly T[] | undefined, top: boolean) => {
    for (const n of list ?? []) {
      if (top || isNcHead(n.dn)) candidates.push(n);
      walk(n.children, false);
    }
  };
  walk(roots, true);
  return findOwningRoot(candidates, dn);
}

/**
 * Former client-side guess of the tree-search bases: domain nodes (globe
 * icon, DC= DN) among the roots and their pre-loaded children.
 */
export function guessTreeSearchBases(nodes: TreeNode[]): string[] {
  const dns: string[] = [];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      if (n.icon === 'globe' && n.dn.toLowerCase().startsWith('dc=')) dns.push(n.dn);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return dns;
}

/**
 * Bases the tree search runs on: the server's list (GetTreeSearchBases) when
 * available, else the client-side guess, else the profile base DN.
 */
export function resolveTreeSearchBases(serverBases: string[] | null, nodes: TreeNode[], profileBaseDN: string): string[] {
  if (serverBases && serverBases.length > 0) return serverBases;
  const guessed = guessTreeSearchBases(nodes);
  return guessed.length > 0 ? guessed : [profileBaseDN];
}

/** Removes entries whose DN (case-insensitive) occurred before. */
export function dedupeByDN<T extends { dn: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  return entries.filter(e => {
    const key = normalizeDN(e.dn);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Per-base size limit so that all bases together return about `total` entries. */
export function perBaseSizeLimit(baseCount: number, total = 50): number {
  return Math.max(10, Math.floor(total / Math.max(1, baseCount)));
}

// --- Entry events (TRIAGE §0.1: window CustomEvents, fixed names and shapes) ----------

export const ENTRY_CREATED = 'ldapilot:entry-created';
export const ENTRY_MOVED = 'ldapilot:entry-moved';
export const ENTRY_DELETED = 'ldapilot:entry-deleted';
export const ENTRY_RESTORED = 'ldapilot:entry-restored';
export const ENTRY_LOADED = 'ldapilot:entry-loaded';
export const ENTRY_MISSING = 'ldapilot:entry-missing';
export const ACCOUNT_CHANGED = 'ldapilot:account-changed';

export interface EntryCreatedDetail { profileId: string; dn: string; parentDN: string; select?: boolean }
export interface EntryMovedDetail { profileId: string; oldDN: string; newDN: string }
export interface EntryDeletedDetail { profileId: string; dn: string; subtree: boolean }
export interface EntryRefDetail { profileId: string; dn: string }
export interface EntryLoadedDetail { profileId: string; dn: string; objectClass: string[] }

/** Listens to one entry event (no-op outside a browser); returns the disposer. */
export function onEntryEvent<T>(name: string, handler: (detail: T) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<T>).detail;
    if (detail && typeof detail === 'object') handler(detail);
  };
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
}

/** Emits one entry event (no-op outside a browser). */
export function emitEntryEvent<T>(name: string, detail: T): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/**
 * Collects keyed values and flushes them together `delayMs` after the first
 * one (repeated events for the same DN within the window become one refresh).
 */
export function createCoalescer<T>(delayMs: number, flush: (batch: Map<string, T>) => void, merge: (prev: T, next: T) => T = (_p, n) => n) {
  let pending = new Map<string, T>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    add(key: string, value: T) {
      const prev = pending.get(key);
      pending.set(key, prev === undefined ? value : merge(prev, value));
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          const batch = pending;
          pending = new Map();
          flush(batch);
        }, delayMs);
      }
    },
    /** Number of keys waiting for the flush. */
    get size() {
      return pending.size;
    },
  };
}

// --- Tree state ----------------------------------------------------------------------

/** The key of `dn` in a DN-keyed record: the exact key, else a normalized match. */
export function findDNKey(record: Record<string, unknown>, dn: string): string | undefined {
  if (dn in record) return dn;
  const want = normalizeDN(dn);
  for (const key of Object.keys(record)) if (normalizeDN(key) === want) return key;
  return undefined;
}

/** Returns `list` with the node `dn` patched (same array when nothing changed). */
export function patchNodeInList(list: TreeNode[], dn: string, patch: Partial<TreeNode>): TreeNode[] {
  const want = normalizeDN(dn);
  let changed = false;
  const next = list.map((n) => {
    if (normalizeDN(n.dn) !== want) return n;
    const keys = Object.keys(patch) as (keyof TreeNode)[];
    if (keys.every((k) => JSON.stringify(n[k]) === JSON.stringify(patch[k]))) return n;
    changed = true;
    return { ...n, ...patch };
  });
  return changed ? next : list;
}

/** Does the loaded tree know the node `dn` (a root or a child in a loaded list)? */
export function isNodeKnown(roots: TreeNode[], childNodes: Record<string, TreeNode[]>, dn: string): boolean {
  const want = normalizeDN(dn);
  if (roots.some((r) => normalizeDN(r.dn) === want)) return true;
  const key = findDNKey(childNodes, getParentDN(dn));
  return !!key && childNodes[key].some((n) => normalizeDN(n.dn) === want);
}

/**
 * Expanded containers whose row is visible (every ancestor expanded too) and
 * whose children are loaded, top-down: what "Refresh Tree" reloads.
 */
export function visibleExpandedContainers(roots: TreeNode[], childNodes: Record<string, TreeNode[]>, expanded: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (list: TreeNode[] | undefined) => {
    for (const n of list ?? []) {
      if (seen.has(n.dn) || !expanded.has(n.dn)) continue;
      seen.add(n.dn);
      if (childNodes[n.dn]) {
        out.push(n.dn);
        walk(childNodes[n.dn]);
      }
    }
  };
  walk(roots);
  return out;
}

/**
 * Refresh of one container (F5 / Refresh on it, TREE-01 limited to a node):
 * after its own list is reloaded, the visible expanded containers below it
 * are reloaded too (`reload`, parents first) and the loaded but hidden lists
 * below it (collapsed somewhere on the way) are marked stale (`stale`), so a
 * sub-container never keeps a list of deleted or renamed entries.
 */
export function subtreeRefreshPlan(dn: string, childNodes: Record<string, TreeNode[]>, expanded: Set<string>): { reload: string[]; stale: string[] } {
  const list = childNodes[dn];
  const reload = list ? visibleExpandedContainers(list, childNodes, expanded).filter((d) => d !== dn) : [];
  const shown = new Set(reload);
  const stale = Object.keys(childNodes).filter((k) => k !== dn && !shown.has(k) && isDNBelow(k, dn));
  return { reload, stale };
}

/** `dn` moved along with `oldBase` → `newBase` (null when dn is not at/below oldBase). */
export function rebaseDN(dn: string, oldBase: string, newBase: string): string | null {
  if (!isDNAtOrBelow(dn, oldBase)) return null;
  const extra = splitDN(dn).length - splitDN(oldBase).length;
  const head = splitDN(dn).slice(0, extra).map((rdn) => rdn.trim());
  return [...head, newBase].join(',');
}

/** Set with every key at/below oldBase re-keyed to newBase (same set when none). */
export function rebaseSet(set: Set<string>, oldBase: string, newBase: string): Set<string> {
  let changed = false;
  const next = new Set<string>();
  for (const key of set) {
    const moved = rebaseDN(key, oldBase, newBase);
    if (moved !== null) changed = true;
    next.add(moved ?? key);
  }
  return changed ? next : set;
}

/** Set without the keys at/below dn (same set when none). */
export function withoutSetBelow(set: Set<string>, dn: string): Set<string> {
  let changed = false;
  const next = new Set<string>();
  for (const key of set) {
    if (isDNAtOrBelow(key, dn)) changed = true;
    else next.add(key);
  }
  return changed ? next : set;
}

/** Record without the keys at/below dn (same record when none). */
export function withoutKeysBelow<V>(record: Record<string, V>, dn: string): Record<string, V> {
  const drop = Object.keys(record).filter((key) => isDNAtOrBelow(key, dn));
  if (drop.length === 0) return record;
  const next = { ...record };
  for (const key of drop) delete next[key];
  return next;
}

// --- Labels --------------------------------------------------------------------------

/** "ad.ldapilot.lab" for a DN made of DC= RDNs only, else null. */
export function dnsNameOf(dn: string): string | null {
  const rdns = splitDN(dn).map(parseRDN);
  if (rdns.length === 0 || rdns.some((r) => r.attr.toLowerCase() !== 'dc' || !r.value)) return null;
  return rdns.map((r) => r.value).join('.');
}

/** Index from which the DN's RDNs are all DC= (rdns.length when the last one is not). */
function dcSuffixStart(rdns: { attr: string }[]): number {
  let i = rdns.length;
  while (i > 0 && rdns[i - 1].attr.toLowerCase() === 'dc') i--;
  return i;
}

/**
 * Short label of a tree root / naming-context head (TREE-08): the domain's
 * DNS name ("ad.ldapilot.lab"), "DomainDnsZones", "ForestDnsZones",
 * "Configuration", "Schema"; a scoped base DN shows its name and the domain
 * ("People (demo.ldapilot.local)"). Anything else keeps the full DN.
 */
export function contextHeadLabel(dn: string): string {
  if (!dn.trim()) return dn;
  const rdns = splitDN(dn).map(parseRDN);
  const dns = dnsNameOf(dn);
  if (dns) {
    const first = rdns[0].value.toLowerCase();
    if (rdns.length > 1 && (first === 'domaindnszones' || first === 'forestdnszones')) return rdns[0].value;
    return dns;
  }
  const suffix = dcSuffixStart(rdns);
  const head = rdns.slice(0, suffix).map((r) => `${r.attr.toLowerCase()}=${r.value.toLowerCase()}`);
  if (suffix > 0 && suffix < rdns.length) {
    if (head.length === 1 && head[0] === 'cn=configuration') return 'Configuration';
    if (head.length === 2 && head[0] === 'cn=schema' && head[1] === 'cn=configuration') return 'Schema';
    if (head.length === 1 && head[0] === 'cn=domaindnszones') return 'DomainDnsZones';
    if (head.length === 1 && head[0] === 'cn=forestdnszones') return 'ForestDnsZones';
    const domain = rdns.slice(suffix).map((r) => r.value).join('.');
    return `${rdns[0].value} (${domain})`;
  }
  return dn;
}

// Rows render their tooltip text on every render: remember recent results.
const unescapedCache = new Map<string, string>();

/** The DN with every value unescaped, RDNs separated by ", " (display only). */
export function unescapedDN(dn: string): string {
  const hit = unescapedCache.get(dn);
  if (hit !== undefined) return hit;
  const out = splitDN(dn)
    .map((rdn) => {
      const { attr, value } = parseRDN(rdn);
      return attr ? `${attr}=${value}` : value;
    })
    .join(', ');
  if (unescapedCache.size >= 5000) unescapedCache.clear();
  unescapedCache.set(dn, out);
  return out;
}

/**
 * Where an entry lives, nearest container first, values unescaped, the DC=
 * suffix as a DNS name: "Special Cases, LDAPilot, ad.ldapilot.lab".
 */
export function parentPathLabel(dn: string): string {
  const parent = getParentDN(dn);
  if (!parent) return '';
  const rdns = splitDN(parent).map(parseRDN);
  const suffix = dcSuffixStart(rdns);
  const names = rdns.slice(0, suffix).map((r) => r.value);
  if (suffix < rdns.length) names.push(rdns.slice(suffix).map((r) => r.value).join('.'));
  return names.join(', ');
}

// --- Drag and drop -------------------------------------------------------------------

export type MoveSkipReason = 'into-itself' | 'already-there' | 'naming-context' | 'other-naming-context' | 'inside-moved-entry';

export interface TreeMovePlan {
  /** DNs to move, in the given order. */
  move: string[];
  skipped: { dn: string; reason: MoveSkipReason }[];
}

/**
 * Which of the dragged entries can move into `target` (TREE-02): never the
 * target itself or into an entry's own subtree, never a naming-context head
 * (`isContextHead`), never across naming contexts (the tree roots), and an
 * entry below another dragged one moves with it (not on its own).
 */
export function planTreeMove(sources: string[], target: string, roots: { dn: string }[], isContextHead: (dn: string) => boolean): TreeMovePlan {
  const plan: TreeMovePlan = { move: [], skipped: [] };
  // Normalized once per DN: the tree asks on every dragover, also for big selections.
  const unique: { dn: string; key: string }[] = [];
  const seen = new Set<string>();
  for (const dn of sources) {
    if (!dn) continue;
    const key = normalizeDN(dn);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push({ dn, key });
  }
  const targetKey = normalizeDN(target);
  const targetRoot = findOwningRoot(roots, target);
  const selfReason = ({ dn, key }: { dn: string; key: string }): MoveSkipReason | null => {
    if (isContextHead(dn)) return 'naming-context';
    if (targetKey === key || targetKey.endsWith(',' + key)) return 'into-itself';
    if (roots.length > 0 && findOwningRoot(roots, dn) !== targetRoot) return 'other-naming-context';
    return null;
  };
  const reasons = new Map<string, MoveSkipReason | null>(unique.map((u) => [u.key, selfReason(u)]));
  // Entries below another entry that moves go along with it (ancestor walk:
  // the parent of a normalized DN is normalized).
  const movers = new Set(unique.filter((u) => reasons.get(u.key) === null).map((u) => u.key));
  for (const key of movers) {
    let inside = false;
    for (let p = getParentDN(key); p; p = getParentDN(p)) {
      if (movers.has(p)) {
        inside = true;
        break;
      }
    }
    if (inside) reasons.set(key, 'inside-moved-entry');
    else if (getParentDN(key) === targetKey) reasons.set(key, 'already-there');
  }
  for (const { dn, key } of unique) {
    const reason = reasons.get(key);
    if (reason) plan.skipped.push({ dn, reason });
    else plan.move.push(dn);
  }
  return plan;
}

/** New DN of `dn` moved into `target` (same RDN). */
export function movedDN(dn: string, target: string): string {
  const rdn = splitDN(dn)[0] ?? dn;
  return `${rdn},${target}`;
}

/**
 * Filter of "Search by Name" for a stale bookmark: the old RDN value as a
 * substring of its naming attribute, on AD also by name resolution (prefix
 * on name, displayName, sAMAccountName, …). An outside rename
 * ("…-contact2" → "…-contact2-ext") is found; an exact match was not
 * (RW3-R-01). Values are escaped (RFC 4515).
 */
export function staleBookmarkFilter(type: string, value: string, ad: boolean): string {
  const v = escapeFilterValue(value.trim())
  const contains = `(${type}=*${v}*)`
  return ad ? `(|(anr=${v})${contains})` : contains
}
