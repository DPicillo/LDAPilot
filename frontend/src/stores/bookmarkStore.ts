import { create } from 'zustand'
import { firstRDN, isDNAtOrBelow, normalizeDN, parseRDN } from '../lib/dn.ts'
import {
  ENTRY_DELETED,
  ENTRY_LOADED,
  ENTRY_MISSING,
  ENTRY_MOVED,
  ENTRY_RESTORED,
  onEntryEvent,
  rebaseDN,
  type EntryDeletedDetail,
  type EntryLoadedDetail,
  type EntryMovedDetail,
  type EntryRefDetail,
} from '../lib/treesearch.ts'

export interface Bookmark {
  dn: string;
  label: string;
  profileId: string;
  timestamp: number;
  /** objectClass when known (icon in the bookmarks panel; updated whenever the entry loads). */
  objectClass?: string[];
  /**
   * The entry was deleted or could not be found (TREE-12): the panel marks
   * the bookmark and offers Remove / Search by Name instead of a dead link.
   */
  stale?: boolean;
  /**
   * The id the server keeps through renames and moves, "<attribute>:<value>"
   * (objectGUID on AD, nsUniqueId on 389DS, entryUUID on OpenLDAP; RW3-R-01).
   * A bookmark whose DN no longer exists is found again by it
   * (components/bookmarks/bookmarkSync.ts). Older bookmarks get it on the
   * next connect.
   */
  stableId?: string;
  /** Name the user gave the bookmark (DEF-24); shown instead of the RDN value. */
  name?: string;
  /**
   * Manual position (DEF-24). Reordering numbers every bookmark of the
   * connection; without numbers the list is sorted by name.
   */
  order?: number;
}

interface BookmarkState {
  bookmarks: Bookmark[];
  addBookmark: (profileId: string, dn: string, objectClass?: string[]) => void;
  /** Puts removed bookmarks back (Undo). */
  restoreBookmarks: (bookmarks: Bookmark[]) => void;
  removeBookmark: (profileId: string, dn: string) => void;
  isBookmarked: (profileId: string, dn: string) => boolean;
  getBookmarks: (profileId: string) => Bookmark[];
  clearBookmarks: (profileId: string) => void;
  /** Sets (or clears, with '' / the RDN value) the bookmark's own name. */
  renameBookmark: (profileId: string, dn: string, name: string) => void;
  /** Moves the bookmark to `toIndex` of the connection's shown order (switches the connection to manual order). */
  moveBookmark: (profileId: string, dn: string, toIndex: number) => void;
  /** Back to the name order (drops the manual positions of the connection). */
  sortBookmarksByName: (profileId: string) => void;
  /** Stores stable ids read from the server (DN → id). */
  setStableIds: (profileId: string, ids: Record<string, string>) => void;
  /** Marks (or clears) bookmarks of these DNs as stale. */
  markStale: (profileId: string, dns: string[], stale: boolean) => void;
}

const STORAGE_KEY = 'ldapilot-bookmarks';

const isStr = (v: unknown): v is string => typeof v === 'string';

/**
 * Bookmarks as stored, of any version (pure, RW3-R-01 / DEF-24): entries
 * without a DN or profile are dropped, unknown or ill-typed fields ignored,
 * duplicates (same profile and DN) kept once. Version 1 bookmarks (no
 * stableId / name / order) stay as they are; their stable id is read on the
 * next connect.
 */
export function migrateBookmarks(raw: unknown): Bookmark[] {
  if (!Array.isArray(raw)) return [];
  const out: Bookmark[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (!isStr(o.dn) || !o.dn.trim() || !isStr(o.profileId) || !o.profileId) continue;
    if (out.some((b) => isSameBookmark(b, o.profileId as string, o.dn as string))) continue;
    const b: Bookmark = {
      dn: o.dn,
      label: isStr(o.label) && o.label ? o.label : firstRDN(o.dn) || o.dn,
      profileId: o.profileId,
      timestamp: typeof o.timestamp === 'number' && Number.isFinite(o.timestamp) ? o.timestamp : 0,
    };
    if (Array.isArray(o.objectClass) && o.objectClass.every(isStr) && o.objectClass.length) b.objectClass = o.objectClass;
    if (o.stale === true) b.stale = true;
    if (isStr(o.stableId) && /^[A-Za-z]+:.+/.test(o.stableId)) b.stableId = o.stableId;
    if (isStr(o.name) && o.name.trim()) b.name = o.name.trim();
    if (typeof o.order === 'number' && Number.isFinite(o.order)) b.order = o.order;
    out.push(b);
  }
  return out;
}

// Persist bookmarks to localStorage
function loadBookmarks(): Bookmark[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    return migrateBookmarks(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
  } catch {
    return [];
  }
}

function saveBookmarks(bookmarks: Bookmark[]) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
  } catch {
    /* blocked storage (private mode): kept for this session only */
  }
}

/** Same bookmark target: profile and DN (case- and blank-insensitive). */
export function isSameBookmark(b: Pick<Bookmark, 'profileId' | 'dn'>, profileId: string, dn: string): boolean {
  return b.profileId === profileId && normalizeDN(b.dn) === normalizeDN(dn);
}

// --- Lifecycle (pure; the window listeners below apply them) ----------------------------

/**
 * Bookmarks after `oldDN` was renamed/moved to `newDN`: bookmarks at or below
 * it follow (label re-derived, stale cleared). A moved bookmark whose new DN
 * is already bookmarked is dropped. Same array when nothing changed.
 */
export function rekeyBookmarks(list: Bookmark[], profileId: string, oldDN: string, newDN: string): Bookmark[] {
  let changed = false;
  const moved: Bookmark[] = [];
  const kept: Bookmark[] = [];
  for (const b of list) {
    const dn = b.profileId === profileId ? rebaseDN(b.dn, oldDN, newDN) : null;
    if (dn === null) {
      kept.push(b);
      continue;
    }
    changed = true;
    const next: Bookmark = { ...b, dn, label: firstRDN(dn) || dn };
    delete next.stale;
    moved.push(next);
  }
  if (!changed) return list;
  const out = [...kept];
  for (const m of moved) if (!out.some((b) => isSameBookmark(b, m.profileId, m.dn))) out.push(m);
  return out;
}

/** Marks (stale = true) or clears (false) bookmarks of `dn` (and below it when `subtree`). */
export function markBookmarksStale(list: Bookmark[], profileId: string, dn: string, subtree: boolean, stale: boolean): Bookmark[] {
  let changed = false;
  const out = list.map((b) => {
    if (b.profileId !== profileId) return b;
    const hit = subtree ? isDNAtOrBelow(b.dn, dn) : normalizeDN(b.dn) === normalizeDN(dn);
    if (!hit || !!b.stale === stale) return b;
    changed = true;
    if (stale) return { ...b, stale: true };
    const next = { ...b };
    delete next.stale;
    return next;
  });
  return changed ? out : list;
}

/** The entry loaded: remember its objectClass (kind icon) and clear a stale mark. */
export function noteBookmarkLoaded(list: Bookmark[], profileId: string, dn: string, objectClass: string[]): Bookmark[] {
  let changed = false;
  const out = list.map((b) => {
    if (!isSameBookmark(b, profileId, dn)) return b;
    const sameOC = !objectClass.length || JSON.stringify(b.objectClass ?? []) === JSON.stringify(objectClass);
    if (sameOC && !b.stale) return b;
    changed = true;
    const next: Bookmark = { ...b, ...(objectClass.length ? { objectClass } : {}) };
    delete next.stale;
    return next;
  });
  return changed ? out : list;
}

/** The RDN value of the bookmarked DN ("Special Cases", not the stored "OU=Special Cases"). */
export function bookmarkRdnName(b: Pick<Bookmark, 'dn' | 'label'>): string {
  return parseRDN(firstRDN(b.dn)).value || b.label || b.dn;
}

/** The name a bookmark shows: the name the user gave it (DEF-24), else its RDN value. */
export function bookmarkName(b: Pick<Bookmark, 'dn' | 'label'> & { name?: string }): string {
  return b.name?.trim() || bookmarkRdnName(b);
}

type Sortable = Pick<Bookmark, 'dn' | 'label' | 'stale'> & { name?: string; order?: number };

/**
 * Bookmark order of every list (panel, welcome screen): a connection the
 * user reordered keeps its manual order (DEF-24; numbered ones first); else
 * live ones first, stale (deleted / not found) last, each alphabetical by
 * the shown name. RW3-R-02: the panel sorted by the stored "CN=…" / "OU=…"
 * label, so all CN bookmarks came before all OU ones and stale ones were
 * mixed in.
 */
export function compareBookmarks(a: Sortable, b: Sortable): number {
  const ao = typeof a.order === 'number';
  const bo = typeof b.order === 'number';
  if (ao && bo && a.order !== b.order) return (a.order as number) - (b.order as number);
  if (ao !== bo) return ao ? -1 : 1;
  return Number(!!a.stale) - Number(!!b.stale) || bookmarkName(a).localeCompare(bookmarkName(b), undefined, { sensitivity: 'base' }) || a.dn.localeCompare(b.dn);
}

/** The connection's bookmarks in the shown order. */
export function profileBookmarks(list: Bookmark[], profileId: string): Bookmark[] {
  return list.filter((b) => b.profileId === profileId).sort(compareBookmarks);
}

/** The connection is in manual order (DEF-24): one of its bookmarks has a position. */
export function hasManualOrder(list: Bookmark[], profileId: string): boolean {
  return list.some((b) => b.profileId === profileId && typeof b.order === 'number');
}

/**
 * Moves the bookmark to `toIndex` of the connection's shown order and
 * numbers all of its bookmarks 0…n-1 (pure). Same array when nothing moves.
 */
export function reorderBookmarks(list: Bookmark[], profileId: string, dn: string, toIndex: number): Bookmark[] {
  const shown = profileBookmarks(list, profileId);
  const from = shown.findIndex((b) => isSameBookmark(b, profileId, dn));
  if (from < 0) return list;
  const to = Math.max(0, Math.min(shown.length - 1, Math.trunc(toIndex)));
  if (to === from && hasManualOrder(list, profileId)) return list;
  const next = [...shown];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  const pos = new Map(next.map((b, i) => [b, i]));
  return list.map((b) => (pos.has(b) ? { ...b, order: pos.get(b)! } : b));
}

/** Drops the manual positions of the connection's bookmarks (pure). */
export function sortByName(list: Bookmark[], profileId: string): Bookmark[] {
  if (!hasManualOrder(list, profileId)) return list;
  return list.map((b) => {
    if (b.profileId !== profileId || typeof b.order !== 'number') return b;
    const next = { ...b };
    delete next.order;
    return next;
  });
}

/**
 * Sets the bookmark's own name (pure). Blank, or the RDN value itself,
 * clears it (the bookmark shows the RDN value again).
 */
export function renameBookmarkIn(list: Bookmark[], profileId: string, dn: string, name: string): Bookmark[] {
  const trimmed = name.trim();
  let changed = false;
  const out = list.map((b) => {
    if (!isSameBookmark(b, profileId, dn)) return b;
    const custom = trimmed && trimmed !== bookmarkRdnName(b) ? trimmed : undefined;
    if (custom === b.name) return b;
    changed = true;
    const next = { ...b };
    if (custom) next.name = custom;
    else delete next.name;
    return next;
  });
  return changed ? out : list;
}

/** Attributes that carry a stable id, in the order bookmarkSync prefers them (as services/recycle_stableid.go). */
export const STABLE_ID_ATTRIBUTES = ['objectGUID', 'nsUniqueId', 'entryUUID'] as const;

/** The stable id of a loaded entry ("objectGUID:…"), from its attributes; undefined when it has none. */
export function stableIdFromAttributes(attributes: readonly { name: string; values?: readonly string[] | null; binary?: boolean }[] | null | undefined): string | undefined {
  if (!attributes) return undefined;
  for (const name of STABLE_ID_ATTRIBUTES) {
    const a = attributes.find((x) => x.name.toLowerCase() === name.toLowerCase());
    const v = a && !a.binary ? a.values?.[0]?.trim() : undefined;
    if (v) return `${name}:${v}`;
  }
  return undefined;
}

/**
 * Stores stable ids (DN → id; pure). Two bookmarks of the connection with
 * the same id are the same entry (one was bookmarked again under its new
 * DN): the live one is kept and takes the other's name and position.
 */
export function applyStableIds(list: Bookmark[], profileId: string, ids: Record<string, string>): Bookmark[] {
  const byDN = new Map(Object.entries(ids).filter(([, id]) => !!id).map(([dn, id]) => [normalizeDN(dn), id]));
  if (!byDN.size) return list;
  let changed = false;
  let out = list.map((b) => {
    if (b.profileId !== profileId) return b;
    const id = byDN.get(normalizeDN(b.dn));
    if (!id || id === b.stableId) return b;
    changed = true;
    return { ...b, stableId: id };
  });
  // Duplicates by id: keep the first live one.
  const seen = new Map<string, number>();
  const drop = new Set<number>();
  out.forEach((b, i) => {
    if (b.profileId !== profileId || !b.stableId) return;
    const j = seen.get(b.stableId);
    if (j === undefined) {
      seen.set(b.stableId, i);
      return;
    }
    const keepNew = !!out[j].stale && !b.stale;
    const keep = keepNew ? i : j;
    const gone = keepNew ? j : i;
    const k = out[keep];
    const g = out[gone];
    out[keep] = { ...k, ...(k.name || !g.name ? {} : { name: g.name }), ...(typeof k.order === 'number' || typeof g.order !== 'number' ? {} : { order: g.order }) };
    drop.add(gone);
    if (keepNew) seen.set(b.stableId, i);
    changed = true;
  });
  if (drop.size) out = out.filter((_, i) => !drop.has(i));
  return changed ? out : list;
}

/** The connection's bookmark with this stable id. */
export function findByStableId(list: Bookmark[], profileId: string, stableId: string): Bookmark | undefined {
  return stableId ? list.find((b) => b.profileId === profileId && b.stableId === stableId) : undefined;
}

export const useBookmarkStore = create<BookmarkState>((set, get) => ({
  bookmarks: loadBookmarks(),

  addBookmark: (profileId: string, dn: string, objectClass?: string[]) => {
    const state = get();
    if (state.bookmarks.some(b => isSameBookmark(b, profileId, dn))) return;
    const label = firstRDN(dn) || dn;
    // A connection in manual order appends the new bookmark at the end (DEF-24).
    const orders = state.bookmarks.filter((b) => b.profileId === profileId && typeof b.order === 'number').map((b) => b.order as number);
    const order = orders.length ? { order: Math.max(...orders) + 1 } : {};
    const next = [...state.bookmarks, { dn, label, profileId, timestamp: Date.now(), ...(objectClass?.length ? { objectClass } : {}), ...order }];
    saveBookmarks(next);
    set({ bookmarks: next });
  },

  restoreBookmarks: (restored: Bookmark[]) => {
    const cur = get().bookmarks;
    const next = [...cur, ...restored.filter(r => !cur.some(b => isSameBookmark(b, r.profileId, r.dn)))];
    saveBookmarks(next);
    set({ bookmarks: next });
  },

  removeBookmark: (profileId: string, dn: string) => {
    const next = get().bookmarks.filter(b => !isSameBookmark(b, profileId, dn));
    saveBookmarks(next);
    set({ bookmarks: next });
  },

  isBookmarked: (profileId: string, dn: string) => {
    return get().bookmarks.some(b => isSameBookmark(b, profileId, dn));
  },

  getBookmarks: (profileId: string) => {
    return profileBookmarks(get().bookmarks, profileId);
  },

  clearBookmarks: (profileId: string) => {
    const next = get().bookmarks.filter(b => b.profileId !== profileId);
    saveBookmarks(next);
    set({ bookmarks: next });
  },

  renameBookmark: (profileId, dn, name) => apply((l) => renameBookmarkIn(l, profileId, dn, name)),
  moveBookmark: (profileId, dn, toIndex) => apply((l) => reorderBookmarks(l, profileId, dn, toIndex)),
  sortBookmarksByName: (profileId) => apply((l) => sortByName(l, profileId)),
  setStableIds: (profileId, ids) => apply((l) => applyStableIds(l, profileId, ids)),
  markStale: (profileId, dns, stale) => apply((l) => dns.reduce((acc, dn) => markBookmarksStale(acc, profileId, dn, false, stale), l)),
}));

function apply(update: (list: Bookmark[]) => Bookmark[]) {
  const cur = useBookmarkStore.getState().bookmarks;
  const next = update(cur);
  if (next === cur) return;
  saveBookmarks(next);
  useBookmarkStore.setState({ bookmarks: next });
}

// Entry lifecycle events (TRIAGE §0.1). Rename = move within the parent.
onEntryEvent<EntryMovedDetail>(ENTRY_MOVED, (d) => {
  if (d.profileId && d.oldDN && d.newDN) apply((l) => rekeyBookmarks(l, d.profileId, d.oldDN, d.newDN));
});
onEntryEvent<EntryDeletedDetail>(ENTRY_DELETED, (d) => {
  if (d.profileId && d.dn) apply((l) => markBookmarksStale(l, d.profileId, d.dn, !!d.subtree, true));
});
onEntryEvent<EntryRefDetail>(ENTRY_MISSING, (d) => {
  if (d.profileId && d.dn) apply((l) => markBookmarksStale(l, d.profileId, d.dn, false, true));
});
onEntryEvent<EntryRefDetail>(ENTRY_RESTORED, (d) => {
  if (d.profileId && d.dn) apply((l) => markBookmarksStale(l, d.profileId, d.dn, false, false));
});
onEntryEvent<EntryLoadedDetail>(ENTRY_LOADED, (d) => {
  if (d.profileId && d.dn) apply((l) => noteBookmarkLoaded(l, d.profileId, d.dn, Array.isArray(d.objectClass) ? d.objectClass : []));
});
