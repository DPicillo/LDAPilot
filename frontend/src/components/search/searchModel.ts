/**
 * Pure model of the search panel (no React, no stores): quick-search
 * snapshots, the per-connection history (deduplicated, pinned first),
 * saved searches, return attributes with the hidden status attributes, DN
 * re-keying of result rows after a move, and attribute name suggestions.
 *
 * Runs under `node --test` (frontend/tests/search.*.test.ts): imports only
 * types and `.ts` modules without side effects.
 */
import type { SearchParams, ServerType } from '../../types/ldap'
import type { MatchType } from '../../types/treesearch'
import { dnDepth, isDNAtOrBelow, isDNBelow, normalizeDN, splitDN } from '../../lib/dn.ts'

/** Quick (one text box) or Advanced (LDAP filter) mode of the search panel. */
export type SearchPanelMode = 'quick' | 'advanced'

/** What the quick mode shows: the text and its options (the filter is generated from them). */
export interface QuickSearchSnapshot {
  text: string
  /** "Search in": an attribute, or '*any' (Any name). */
  attr: string
  matchType: MatchType
  /** Object type key of lib/searchFilter.ts quickObjectTypes ('' = all). */
  objectType: string
}

export const DEFAULT_QUICK: QuickSearchSnapshot = { text: '', attr: '*any', matchType: 'contains', objectType: '' }

export interface SearchHistoryItem {
  id: string
  /** The search that ran (the generated filter for quick searches). */
  params: SearchParams
  resultCount: number
  timestamp: number
  pinned: boolean
  /** Connection the search ran on (older entries have none). */
  profileId?: string
  /** Panel mode of the search; quick searches keep their text and options. */
  mode?: SearchPanelMode
  quick?: QuickSearchSnapshot
}

export interface SavedSearch {
  id: string
  name: string
  params: SearchParams
  displayColumns: string[]
  createdAt: number
  /** Connection (and its name / server type when saved) the search belongs to. */
  profileId?: string
  profileName?: string
  serverType?: ServerType | null
  /** Saved in this panel mode; quick searches restore the text and options. */
  mode?: SearchPanelMode
  quick?: QuickSearchSnapshot
}

/** Identity of a history entry: the same search on the same connection and base is one entry. */
export function historyKey(item: Pick<SearchHistoryItem, 'params' | 'profileId' | 'mode' | 'quick'>): string {
  const p = item.params
  const base = [item.profileId ?? '', normalizeDN(p.baseDN || '')]
  if (item.mode === 'quick' && item.quick) {
    const q = item.quick
    return JSON.stringify([...base, 'q', q.text.trim(), q.attr, q.matchType, q.objectType])
  }
  return JSON.stringify([...base, 'a', p.filter.trim(), p.scope, (p.attributes || []).map((a) => a.toLowerCase()).join(',')])
}

/**
 * Adds a search to the history: an existing entry of the same search is
 * replaced (its pin kept) and the new one is put first; each connection
 * keeps at most `maxPerProfile` unpinned entries.
 */
export function addToHistory(history: SearchHistoryItem[], item: SearchHistoryItem, maxPerProfile = 50): SearchHistoryItem[] {
  const key = historyKey(item)
  let pinned = item.pinned
  const rest = history.filter((h) => {
    if (historyKey(h) !== key) return true
    pinned = pinned || h.pinned
    return false
  })
  const next = [{ ...item, pinned }, ...rest]
  const count = new Map<string, number>()
  return next.filter((h) => {
    if (h.pinned) return true
    const p = h.profileId ?? ''
    const n = (count.get(p) ?? 0) + 1
    count.set(p, n)
    return n <= maxPerProfile
  })
}

/** History of one connection, pinned first, then newest first (entries without a connection are shown everywhere). */
export function historyFor(history: SearchHistoryItem[], profileId: string | null): SearchHistoryItem[] {
  return history
    .filter((h) => !h.profileId || h.profileId === profileId)
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.timestamp - a.timestamp)
}

/** One-line description of a quick search ("schmidt" in Any name · Users). */
export function describeQuick(q: QuickSearchSnapshot, attrLabel: (attr: string) => string, typeLabel: (type: string) => string): string {
  // A type-only search lists the type: "All contacts", not '"" in Any name · Contacts' (RW2-S-05).
  if (!q.text.trim() && q.objectType) return `All ${typeLabel(q.objectType).toLowerCase()}`
  const parts = [`"${q.text.trim()}" in ${attrLabel(q.attr)}`]
  if (q.attr !== '*any' && q.matchType !== 'contains') parts[0] += ` (${q.matchType === 'startsWith' ? 'starts' : q.matchType === 'endsWith' ? 'ends' : 'exact'})`
  if (q.objectType) parts.push(typeLabel(q.objectType))
  return parts.join(' · ')
}

/**
 * Why a quick search (saved, or from the history) cannot run on this
 * server: no text and no object type filter here — its type does not exist
 * on this server type. Null when it can run. RW3-S-01: an AD "All contacts"
 * run on OpenLDAP became (objectClass=*) over the whole directory.
 */
export function quickRunProblem(q: QuickSearchSnapshot, typeFilter: string, typeLabel: (type: string) => string, where: string): string | null {
  if (q.text.trim() || typeFilter) return null
  if (q.objectType) return `${typeLabel(q.objectType)} is not an object type on ${where}: the search was not run.`
  return 'Type something to search for, or choose an object type: the search was not run.'
}

/** Scope of a search for labels: '' for a subtree (the default), else "one level" / "base entry". */
export function scopeLabel(scope: number | undefined): string {
  return scope === 0 ? 'base entry' : scope === 1 ? 'one level' : ''
}

/** "1 result" / "3 results". */
export function resultCountText(n: number): string {
  return `${n} result${n === 1 ? '' : 's'}`
}

/**
 * Default attribute columns of the results by server type (RW3-S-03: the AD
 * set with an always empty sAMAccountName on every server).
 */
export function defaultResultColumns(serverType: ServerType | null | undefined): string[] {
  if (serverType === 'ad') return ['cn', 'description', 'mail', 'sAMAccountName']
  if (!serverType) return ['cn', 'description', 'mail']
  return ['cn', 'uid', 'mail', 'description']
}

/**
 * The base DN to use when a saved search of another connection is loaded:
 * its own base when it lies within this connection's base (same directory),
 * else this connection's base (`replaced` = true, the panel warns).
 */
export function baseForProfile(savedBase: string, profileBase: string): { baseDN: string; replaced: boolean } {
  if (!savedBase.trim()) return { baseDN: profileBase, replaced: false }
  if (!profileBase.trim() || isDNAtOrBelow(savedBase, profileBase)) return { baseDN: savedBase, replaced: false }
  return { baseDN: profileBase, replaced: true }
}

/**
 * Attributes to request for a search: the user's list plus `always`
 * (objectClass and the account status attributes, so rows keep their type,
 * status and verbs). `hidden` (lower case) are the added ones, which result
 * columns and exports leave out unless the user asked for them. An empty
 * list (all user attributes) adds `operational` (status attributes `*` does
 * not return).
 */
export function withStatusAttributes(attributes: string[], always: string[], operational: string[]): { request: string[]; hidden: string[] } {
  const asked = attributes.map((a) => a.trim()).filter(Boolean)
  const all = asked.length === 0 || asked.includes('*')
  const extra = asked.length === 0 ? operational : always
  const have = new Set(asked.map((a) => a.toLowerCase()))
  const add: string[] = []
  for (const a of extra) {
    const l = a.toLowerCase()
    if (have.has(l) || (all && !operational.some((o) => o.toLowerCase() === l))) continue
    have.add(l)
    add.push(a)
  }
  return { request: asked.length === 0 ? ['*', ...add] : [...asked, ...add], hidden: add.map((a) => a.toLowerCase()) }
}

/**
 * DN of a row after `oldDN` was renamed / moved to `newDN`: the same DN for
 * the entry itself, the new suffix for entries below it, null when the row
 * is not affected.
 */
export function rekeyDN(dn: string, oldDN: string, newDN: string): string | null {
  if (!oldDN || !newDN) return null
  if (normalizeDN(dn) === normalizeDN(oldDN)) return newDN
  if (!isDNBelow(dn, oldDN)) return null
  const keep = dnDepth(dn) - dnDepth(oldDN)
  return [...splitDN(dn).slice(0, keep).map((r) => r.trim()), newDN].join(',')
}

/**
 * Attribute names for a combobox: names starting with the query first, then
 * names containing it, case-insensitive, at most `limit` (all names in
 * alphabetical order for an empty query).
 */
export function suggestNames(names: string[], query: string, limit = 50): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return names.slice(0, limit)
  const starts: string[] = []
  const contains: string[] = []
  for (const n of names) {
    const l = n.toLowerCase()
    if (l.startsWith(q)) starts.push(n)
    else if (l.includes(q)) contains.push(n)
    if (starts.length >= limit) break
  }
  return [...starts, ...contains].slice(0, limit)
}

/** localStorage helpers that never throw (private windows, blocked storage). */
export function readJSON<T>(key: string, fallback: T): T {
  try {
    if (typeof localStorage === 'undefined') return fallback
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function writeJSON(key: string, value: unknown): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* blocked storage: the value lives for this session only */
  }
}
