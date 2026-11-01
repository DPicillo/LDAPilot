/**
 * Entry and account events (UX triage §0.1): `window` CustomEvents with a
 * fixed name and `detail` shape, so features that cannot import each other
 * can still tell the editor tabs, the recent entries, the tree and the
 * bookmarks that an entry was moved, deleted, restored or changed.
 *
 * `emitEntryEvent` / `onEntryEvent` are the typed helpers (other features may
 * dispatch the raw events; `onEntryEvent` drops a detail of the wrong shape).
 * The rest of this module is the pure logic of how editor tabs, the
 * navigation history and the recent entries follow these events (node --test:
 * tests/editor.events.test.ts), plus the load-failure classification and the
 * connection markers of editor tabs.
 */
import { firstRDN, isDNAtOrBelow, normalizeDN, parseRDN, splitDN } from './dn.ts'
import type { EditorTab } from '../types/ui.ts'

// --- Events -------------------------------------------------------------------------

export interface EntryEventMap {
  'ldapilot:entry-created': { profileId: string; dn: string; parentDN: string; select?: boolean }
  /** One per entry; a rename is a move within the parent. Descendants follow their ancestor. */
  'ldapilot:entry-moved': { profileId: string; oldDN: string; newDN: string }
  /** `subtree`: everything at or below `dn` is gone. */
  'ldapilot:entry-deleted': { profileId: string; dn: string; subtree: boolean }
  'ldapilot:entry-restored': { profileId: string; dn: string }
  /** After every successful entry load of the editor. */
  'ldapilot:entry-loaded': { profileId: string; dn: string; objectClass: string[] }
  /** An editor load failed with noSuchObject (32). */
  'ldapilot:entry-missing': { profileId: string; dn: string }
  'ldapilot:account-changed': { profileId: string; dn: string }
  'ldapilot:audit-filter': { profileId: string; dn: string }
  'ldapilot:export-request': { profileId: string; dns: string[] }
}

export type EntryEventName = keyof EntryEventMap

export const ENTRY_EVENTS = {
  created: 'ldapilot:entry-created',
  moved: 'ldapilot:entry-moved',
  deleted: 'ldapilot:entry-deleted',
  restored: 'ldapilot:entry-restored',
  loaded: 'ldapilot:entry-loaded',
  missing: 'ldapilot:entry-missing',
  accountChanged: 'ldapilot:account-changed',
  auditFilter: 'ldapilot:audit-filter',
  exportRequest: 'ldapilot:export-request',
} as const satisfies Record<string, EntryEventName>

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** True when `detail` has the shape §0.1 defines for `name` (raw events of other features are checked before use). */
export function isEntryEventDetail<N extends EntryEventName>(name: N, detail: unknown): detail is EntryEventMap[N] {
  if (!detail || typeof detail !== 'object') return false
  const d = detail as Record<string, unknown>
  if (!isStr(d.profileId)) return false
  switch (name) {
    case 'ldapilot:entry-moved':
      return isStr(d.oldDN) && isStr(d.newDN)
    case 'ldapilot:entry-deleted':
      return isStr(d.dn) && (d.subtree === undefined || typeof d.subtree === 'boolean')
    case 'ldapilot:entry-created':
      return isStr(d.dn) && typeof d.parentDN === 'string'
    case 'ldapilot:entry-loaded':
      return isStr(d.dn) && Array.isArray(d.objectClass)
    case 'ldapilot:export-request':
      return Array.isArray(d.dns)
    default:
      return isStr(d.dn)
  }
}

/** Dispatches an entry event on `window` (no-op outside a browser, e.g. node tests). */
export function emitEntryEvent<N extends EntryEventName>(name: N, detail: EntryEventMap[N]): void {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

/** Listens to an entry event; returns the disposer. Details of the wrong shape are ignored. */
export function onEntryEvent<N extends EntryEventName>(name: N, handler: (detail: EntryEventMap[N]) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<unknown>).detail
    if (isEntryEventDetail(name, detail)) handler(detail)
  }
  window.addEventListener(name, listener)
  return () => window.removeEventListener(name, listener)
}

// --- DNs and tab ids --------------------------------------------------------------------

/** Editor tab id of an entry. */
export const tabIdOf = (profileId: string, dn: string) => `${profileId}:${dn}`

/**
 * Tab / recent label of a DN: the unescaped value of its first RDN; a domain
 * root (every RDN dc=…) is named by its DNS name like the tree root
 * ("ad.ldapilot.lab", not "ad"; RW2-N-07).
 */
export function entryLabel(dn: string): string {
  const rdns = dn.trim() ? splitDN(dn).map(parseRDN) : []
  if (rdns.length > 1 && rdns.every((r) => r.attr.toLowerCase() === 'dc' && r.value)) {
    const first = rdns[0].value.toLowerCase()
    if (first !== 'domaindnszones' && first !== 'forestdnszones') return rdns.map((r) => r.value).join('.')
  }
  return parseRDN(firstRDN(dn)).value || dn
}

/**
 * The DN a tab adopts after a load: the server's spelling of the same entry
 * (RW2-N-01: an entry created as "ou=x,OU=…" is "OU=x,OU=…" on the server and
 * in every listing), or null when nothing changes.
 */
export function adoptServerDN(tabDN: string, serverDN: string | undefined | null): string | null {
  if (!serverDN || serverDN === tabDN || !sameDN(serverDN, tabDN)) return null
  return serverDN
}

/** Same entry (case and blanks around separators ignored). */
export const sameDN = (a: string, b: string) => normalizeDN(a) === normalizeDN(b)

/**
 * The DN `dn` gets when its ancestor-or-self `oldBase` is moved to `newBase`
 * (the RDNs below the base are kept as written), or null when `dn` is not at
 * or below `oldBase`.
 */
export function rebaseDN(dn: string, oldBase: string, newBase: string): string | null {
  if (!dn.trim() || !oldBase.trim() || !isDNAtOrBelow(dn, oldBase)) return null
  const own = splitDN(dn)
  const depth = own.length - splitDN(oldBase).length
  if (depth <= 0) return newBase
  return [...own.slice(0, depth).map((r) => r.trim()), newBase].join(',')
}

// --- Editor tabs ------------------------------------------------------------------------

export interface TabsAfterMove {
  tabs: EditorTab[]
  /** Old tab id -> new tab id (a moved tab whose new id was already open maps to that tab and is dropped). */
  renamed: Record<string, string>
}

/**
 * Re-keys the tabs of `oldDN` (and of entries below it) to their new DN:
 * id, dn and label change, everything else (preview, dirty, position) stays.
 * A moved tab whose new id is already open is merged into that tab.
 */
export function tabsAfterMove(tabs: EditorTab[], profileId: string, oldDN: string, newDN: string): TabsAfterMove {
  const renamed: Record<string, string> = {}
  const moved = new Map<string, EditorTab>()
  for (const t of tabs) {
    if (t.profileId !== profileId || !t.dn) continue
    const dn = rebaseDN(t.dn, oldDN, newDN)
    if (dn === null || dn === t.dn) continue
    const id = tabIdOf(profileId, dn)
    moved.set(t.id, { ...t, id, dn, label: entryLabel(dn), state: undefined, loadedAt: undefined })
    renamed[t.id] = id
  }
  if (!moved.size) return { tabs, renamed }
  const staying = new Set(tabs.filter((t) => !moved.has(t.id)).map((t) => t.id))
  const out: EditorTab[] = []
  const seen = new Set<string>()
  for (const t of tabs) {
    const next = moved.get(t.id) ?? t
    // The new id is open already (or two moved tabs collide): keep the first one.
    if (moved.has(t.id) && (staying.has(next.id) || seen.has(next.id))) continue
    seen.add(next.id)
    out.push(next)
  }
  return { tabs: out, renamed }
}

/**
 * The re-keyed tabs of a move / rename whose view state and kept drafts go
 * with them (tabViewState, scoped unsaved edits): old id, new id, new DN.
 * A tab dropped for an already open tab of its new DN carries nothing (the
 * open tab keeps its own state). RW3-E-01: a rename threw away the draft of
 * the renamed entry's hidden tab without asking.
 */
export function movedTabCarries(before: readonly EditorTab[], after: TabsAfterMove): { from: string; to: string; dn: string }[] {
  const byId = new Map(after.tabs.map((t) => [t.id, t]))
  const open = new Set(before.map((t) => t.id))
  const used = new Set<string>()
  const out: { from: string; to: string; dn: string }[] = []
  for (const [from, to] of Object.entries(after.renamed)) {
    if (from === to || open.has(to) || used.has(to)) continue
    const t = byId.get(to)
    if (!t) continue
    used.add(to)
    out.push({ from, to, dn: t.dn })
  }
  return out
}

/** Marks the tabs of `dn` (and with `subtree` every tab below it) deleted; `hit` = their ids. */
export function tabsAfterDelete(tabs: EditorTab[], profileId: string, dn: string, subtree: boolean, at: number): { tabs: EditorTab[]; hit: string[] } {
  const hit: string[] = []
  const next = tabs.map((t) => {
    if (t.profileId !== profileId || !t.dn) return t
    const match = subtree ? isDNAtOrBelow(t.dn, dn) : sameDN(t.dn, dn)
    if (!match) return t
    hit.push(t.id)
    return { ...t, state: { kind: 'deleted' as const, at, subtree }, loadedAt: undefined }
  })
  return { tabs: hit.length ? next : tabs, hit }
}

/** Ids of the tabs that show `dn` of `profileId`. */
export function tabsOfDN(tabs: EditorTab[], profileId: string, dn: string): EditorTab[] {
  return tabs.filter((t) => t.profileId === profileId && !!t.dn && sameDN(t.dn, dn))
}

/**
 * openEntry on an open tab reloads it when it is deleted / missing / failed,
 * or older than the last move or restore of its DN (ED-22).
 */
export function tabNeedsReload(tab: Pick<EditorTab, 'state' | 'loadedAt'>, changedAt: number | undefined): boolean {
  if (tab.state) return true
  return changedAt !== undefined && (tab.loadedAt ?? 0) < changedAt
}

export interface NavEntry {
  profileId: string
  dn: string
}

/** The navigation history after a move (entries at or below oldDN follow it). */
export function historyAfterMove(history: NavEntry[], profileId: string, oldDN: string, newDN: string): NavEntry[] {
  let changed = false
  const out = history.map((h) => {
    if (h.profileId !== profileId) return h
    const dn = rebaseDN(h.dn, oldDN, newDN)
    if (dn === null || dn === h.dn) return h
    changed = true
    return { ...h, dn }
  })
  return changed ? out : history
}

// --- Recent entries (localStorage `ldapilot-recent-entries`) ------------------------------

export const RECENTS_KEY = 'ldapilot-recent-entries'
export const MAX_RECENTS = 30

export interface RecentEntry {
  profileId: string
  dn: string
  label: string
  timestamp: number
  /** objectClass of the last successful load (icons, palette verbs); absent for older records. */
  objectClass?: string[]
}

/** Recent entries from their stored JSON (bad JSON or records -> dropped). */
export function parseRecents(raw: string | null | undefined): RecentEntry[] {
  try {
    const list = JSON.parse(raw || '[]') as unknown
    if (!Array.isArray(list)) return []
    return list.filter(
      (r): r is RecentEntry => !!r && typeof r === 'object' && isStr((r as RecentEntry).profileId) && isStr((r as RecentEntry).dn),
    )
  } catch {
    return []
  }
}

const recentMatch = (r: RecentEntry, profileId: string, dn: string) => r.profileId === profileId && sameDN(r.dn, dn)

/** Puts the entry first (keeps a known objectClass), at most MAX_RECENTS. */
export function recentsTouch(list: RecentEntry[], profileId: string, dn: string, now: number): RecentEntry[] {
  const old = list.find((r) => recentMatch(r, profileId, dn))
  const rest = list.filter((r) => !recentMatch(r, profileId, dn))
  const entry: RecentEntry = { profileId, dn, label: entryLabel(dn), timestamp: now }
  if (old?.objectClass?.length) entry.objectClass = old.objectClass
  return [entry, ...rest].slice(0, MAX_RECENTS)
}

/** Stores the objectClass of a loaded entry; null when nothing changed. */
export function recentsSetObjectClass(list: RecentEntry[], profileId: string, dn: string, objectClass: string[]): RecentEntry[] | null {
  let changed = false
  const out = list.map((r) => {
    if (!recentMatch(r, profileId, dn)) return r
    if (r.objectClass && r.objectClass.length === objectClass.length && r.objectClass.every((v, i) => v === objectClass[i])) return r
    changed = true
    return { ...r, objectClass: [...objectClass] }
  })
  return changed ? out : null
}

/** Recent entries after a move (entries at or below oldDN follow it); null when nothing changed. */
export function recentsAfterMove(list: RecentEntry[], profileId: string, oldDN: string, newDN: string): RecentEntry[] | null {
  let changed = false
  const out: RecentEntry[] = []
  const seen = new Set<string>()
  for (const r of list) {
    const dn = r.profileId === profileId ? rebaseDN(r.dn, oldDN, newDN) : null
    const next = dn !== null && dn !== r.dn ? { ...r, dn, label: entryLabel(dn) } : r
    if (next !== r) changed = true
    const key = `${next.profileId}\n${normalizeDN(next.dn)}`
    if (seen.has(key)) {
      changed = true
      continue
    }
    seen.add(key)
    out.push(next)
  }
  return changed ? out : null
}

/** Recent entries without a deleted entry (with `subtree` also everything below it); null when nothing changed. */
export function recentsAfterDelete(list: RecentEntry[], profileId: string, dn: string, subtree: boolean): RecentEntry[] | null {
  const out = list.filter((r) => !(r.profileId === profileId && (subtree ? isDNAtOrBelow(r.dn, dn) : sameDN(r.dn, dn))))
  return out.length === list.length ? null : out
}

// --- Load failures ----------------------------------------------------------------------

/** LDAP result code names as go-ldap prints them (LDAPResultCodeMap) -> code. */
const RESULT_CODES: [RegExp, number][] = [
  [/\bNo Such Object\b/i, 32],
  [/\bInsufficient Access Rights\b/i, 50],
  [/\bInvalid DN Syntax\b/i, 34],
  [/\bUnwilling To Perform\b/i, 53],
  [/\bBusy\b/, 51],
  [/\bUnavailable\b/, 52],
  [/\bTime Limit Exceeded\b/i, 3],
  [/\bSize Limit Exceeded\b/i, 4],
  [/\bOperations Error\b/i, 1],
  [/\bProtocol Error\b/i, 2],
  [/\bAdmin Limit Exceeded\b/i, 11],
  [/\bConfidentiality Required\b/i, 13],
  [/\bStrong Auth Required\b/i, 8],
  [/\bReferral\b/, 10],
  [/\bNetwork Error\b/i, 200],
]

const OFFLINE = /not connected to LDAP server|connection attempt cancelled|connection (is )?closed|connection reset|broken pipe|\bEOF\b|use of closed network connection|i\/o timeout/i

export interface LoadFailure {
  /** missing: noSuchObject; offline: no usable connection (the values are kept, marked stale); error: anything else. */
  kind: 'missing' | 'offline' | 'error'
  code?: number
  /** The reason without the "LDAP search failed:" prefix. */
  message: string
}

/** Text of a rejected Wails call (a string) or an Error. */
export function errorText(err: unknown, fallback = 'Failed to load the entry'): string {
  if (typeof err === 'string' && err) return err
  if (err instanceof Error && err.message) return err.message
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') return (err as { message: string }).message || fallback
  return fallback
}

/** Classifies a failed entry load (BrowserService.GetEntry error). */
export function classifyLoadError(err: unknown): LoadFailure {
  const raw = errorText(err)
  const message = raw.replace(/^LDAP search failed:\s*/i, '').trim() || raw
  let code: number | undefined
  const m = /LDAP Result Code (\d+)/i.exec(raw)
  if (m) code = Number(m[1])
  else {
    for (const [re, c] of RESULT_CODES) {
      if (re.test(message)) {
        code = c
        break
      }
    }
  }
  if (/^LDAP entry not found\b/i.test(raw)) code = 32
  if (code === 32) return { kind: 'missing', code, message }
  if (code === 200 || OFFLINE.test(raw)) return { kind: 'offline', code, message }
  return { kind: 'error', code, message }
}

// --- Connection markers -------------------------------------------------------------------

const MARKER_MAX = 12

/**
 * Short, distinct markers for the connections that have open tabs (ED-06):
 * the words all names share at the start are dropped ("Lab · OpenLDAP" /
 * "Lab · 389 DS" -> "OpenLDAP" / "389 DS"), the rest is cut at 12
 * characters; the second and later of equal markers get " #n".
 */
export function connectionMarkers(names: Record<string, string>): Record<string, string> {
  const ids = Object.keys(names)
  const words = ids.map((id) => (names[id] || id).split(/[\s·•|]+/).filter(Boolean))
  let common = 0
  if (ids.length > 1) {
    const first = words[0]
    while (common < first.length - 1 && words.every((w) => w.length > common + 1 && w[common].toLowerCase() === first[common].toLowerCase())) common++
  }
  const cut = (s: string) => (s.length > MARKER_MAX ? `${s.slice(0, MARKER_MAX - 1).trimEnd()}…` : s)
  const out: Record<string, string> = {}
  ids.forEach((id, i) => {
    out[id] = cut(words[i].slice(common).join(' ') || names[id] || id)
  })
  const counts = new Map<string, number>()
  for (const id of ids) counts.set(out[id], (counts.get(out[id]) ?? 0) + 1)
  const used = new Map<string, number>()
  for (const id of ids) {
    if ((counts.get(out[id]) ?? 0) < 2) continue
    const base = out[id]
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    out[id] = n === 1 ? base : `${cut(base)} #${n}`
  }
  return out
}
