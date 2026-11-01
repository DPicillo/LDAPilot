/**
 * Pure helpers of the results views (live panel and results tabs; DEF-16):
 * rows that follow entry events, the count of rows deletions removed, tab
 * titles and the unified column chooser's layout rules. Runs under
 * `node --test` (tests/search.snapshot.test.ts).
 */
import type { SearchResult } from '../../types/ldap'
import { isDNAtOrBelow, normalizeDN } from '../../lib/dn.ts'
import { rekeyDN } from './searchModel.ts'

/** Id prefix of a results tab (a snapshot of rows; editorStore special tab). */
export const RESULTS_TAB_PREFIX = '__results__:'

export function resultsTabId(seq: number): string {
  return `${RESULTS_TAB_PREFIX}${seq}`
}

export function isResultsTabId(id: string | null | undefined): boolean {
  return !!id && id.startsWith(RESULTS_TAB_PREFIX)
}

/**
 * Results that remember how many rows their search found (`found`), so
 * rows removed later — only deletions remove rows (entry-deleted events,
 * the delete dialog's prune) — can be told apart from "nothing found": the
 * empty state then says the rows were deleted instead of "No entries found
 * · Check the filter" (cross-note S via M). Row updates copy the results
 * (`{ ...prev, entries }`) and so keep `found`.
 */
export type CountedResult = SearchResult & { searchId?: number; found?: number }

/** Rows removed (by deletions) since the search found them. */
export function deletedCount(r: SearchResult | null | undefined): number {
  const found = (r as CountedResult | null | undefined)?.found
  return r && found !== undefined ? Math.max(0, found - r.entries.length) : 0
}

/** `r` marked with its current row count as found (a search's results, a new results tab). */
export function withFoundCount<T extends SearchResult>(r: T): T & { found: number } {
  const found = (r as CountedResult).found
  return { ...r, found: found !== undefined ? found : r.entries.length }
}

/** True when deletions removed every row the search found. */
export function emptiedByDeletions(r: SearchResult | null | undefined): boolean {
  return !!r && r.entries.length === 0 && deletedCount(r) > 0
}

/** "3 entries", "1 entry", "0 entries · 3 deleted". */
export function resultsCountText(r: SearchResult): string {
  const n = r.totalCount || r.entries.length
  const d = deletedCount(r)
  return `${n} ${n === 1 ? 'entry' : 'entries'}${d ? ` · ${d} deleted` : ''}`
}

/** The empty state of results that deletions emptied (null: not emptied by deletions). */
export function deletedEmptyState(r: SearchResult | null | undefined): { title: string; hint: string } | null {
  if (!emptiedByDeletions(r)) return null
  const d = deletedCount(r)
  return {
    title: d === 1 ? 'The entry found was deleted' : `All ${d} entries found were deleted`,
    hint: `The search found ${d} ${d === 1 ? 'entry' : 'entries'}; ${d === 1 ? 'it was' : 'they were'} deleted since. Run the search again to see the current state.`,
  }
}

/**
 * The results without the rows of a deleted entry (and, with `subtree`,
 * the rows below it); null when no row matched. Results without a found
 * count get the one before the removal, so emptied results still know
 * what was found.
 */
export function withoutDeletedRows<T extends SearchResult>(prev: T, dn: string, subtree: boolean): T | null {
  const key = normalizeDN(dn)
  const entries = prev.entries.filter((e) => !(subtree ? isDNAtOrBelow(e.dn, dn) : normalizeDN(e.dn) === key))
  const removed = prev.entries.length - entries.length
  if (!removed) return null
  return { ...prev, entries, totalCount: Math.max(0, prev.totalCount - removed), found: (prev as CountedResult).found ?? prev.entries.length }
}

/** The results with the rows at / below a moved entry re-keyed; null when no row moved. `renamed`: old DN → new DN. */
export function withMovedRows<T extends SearchResult>(prev: T, oldDN: string, newDN: string): { next: T; renamed: Map<string, string> } | null {
  const renamed = new Map<string, string>()
  const entries = prev.entries.map((e) => {
    const dn = rekeyDN(e.dn, oldDN, newDN)
    if (dn === null || dn === e.dn) return e
    renamed.set(e.dn, dn)
    return { ...e, dn }
  })
  if (!renamed.size) return null
  return { next: { ...prev, entries }, renamed }
}

/** A checked set after rows were re-keyed (moved entries stay checked). */
export function rekeyChecked(checked: ReadonlySet<string>, renamed: ReadonlyMap<string, string>): Set<string> {
  return new Set([...checked].map((dn) => renamed.get(dn) ?? dn))
}

/** A checked set without DNs no longer among the rows. */
export function keepPresent(checked: ReadonlySet<string>, rows: readonly { dn: string }[]): ReadonlySet<string> {
  const present = new Set(rows.map((e) => e.dn))
  const kept = [...checked].filter((dn) => present.has(dn))
  return kept.length === checked.size ? checked : new Set(kept)
}

/** A filter shortened for a tab label (the full one is in the tooltip). */
export function shortFilter(filter: string, max = 40): string {
  const f = filter.trim().replace(/\s+/g, ' ')
  return f.length > max ? `${f.slice(0, max - 1)}…` : f
}

/**
 * The label of a results tab: a report or another named source by its
 * name, a quick search by its text, an advanced search by its filter.
 */
export function snapshotTitle(input: { source?: string | null; mode?: 'quick' | 'advanced' | null; quickText?: string | null; filter?: string | null }): string {
  const source = input.source?.trim()
  if (source && source !== 'Search' && source !== 'Quick search') return source
  const text = input.quickText?.trim()
  if (input.mode === 'quick' && text) return `Search “${shortFilter(text, 32)}”`
  if (input.filter?.trim()) return shortFilter(input.filter)
  return 'Search Results'
}

// --- Unified column chooser (DEF-15) -------------------------------------------

/** Column ids in display order: `order` first (known ids), then the others as declared (DataTable's rule). */
export function orderedColumnIds(declared: readonly string[], order: readonly string[]): string[] {
  const known = new Set(declared)
  const out: string[] = []
  for (const id of order) {
    if (known.has(id) && !out.includes(id)) out.push(id)
  }
  return [...out, ...declared.filter((id) => !out.includes(id))]
}

/** The full display order after moving `id` one place up (-1) or down (1). */
export function moveColumnId(declared: readonly string[], order: readonly string[], id: string, dir: -1 | 1): string[] {
  const ids = orderedColumnIds(declared, order)
  const i = ids.indexOf(id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= ids.length) return ids
  ;[ids[i], ids[j]] = [ids[j], ids[i]]
  return ids
}

/** Hidden ids after showing (on) or hiding a column; never hides the last visible one. */
export function setColumnShown(declared: readonly string[], hidden: readonly string[], id: string, on: boolean): string[] {
  const set = new Set(hidden)
  if (on) set.delete(id)
  else {
    const visible = declared.filter((c) => !set.has(c))
    if (visible.length <= 1 && visible[0] === id) return [...hidden]
    set.add(id)
  }
  return [...set]
}

// --- Open in List (DEF-17) -----------------------------------------------------------

/**
 * The entries a bulk run (LDIF import, batch modify) created or changed and
 * that still exist: successful add / modify records by DN, modrdn records
 * by their new DN; deletes and failures are left out. Unique, in run order.
 */
export function touchedEntryDNs(items: readonly { dn: string; operation?: string; status: string; newDn?: string }[]): string[] {
  const out = new Map<string, string>()
  for (const it of items) {
    if (it.status !== 'success') continue
    const op = (it.operation ?? '').toLowerCase()
    if (op === 'delete') {
      out.delete(normalizeDN(it.dn))
      continue
    }
    if (op === 'modrdn' || op === 'moddn') {
      out.delete(normalizeDN(it.dn))
      if (it.newDn) out.set(normalizeDN(it.newDn), it.newDn)
      continue
    }
    if (it.dn) out.set(normalizeDN(it.dn), it.dn)
  }
  return [...out.values()]
}
