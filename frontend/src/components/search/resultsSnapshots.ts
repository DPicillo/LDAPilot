/**
 * Results tabs (DEF-16 / DEF-22 / DEF-17): a main-area tab holds its own
 * copy of result rows with the query, the connection and the run that
 * produced them, next to the live results in the bottom panel (the next
 * search replaces those, never a tab). A tab has its own selection, sort
 * and attribute columns, re-runs its own search (or report, or DN list)
 * into itself, and its rows follow entry events like the panel's.
 *
 * Kinds: 'search' (Open Results as Tab), 'report' (every report run opens
 * or re-uses its report's tab), 'list' (Open in List: the entries of an
 * LDIF import or bulk run, read by DN).
 *
 * Tab ids are `__results__:<n>` (editorStore special tabs, label = title);
 * the data lives here and goes when the tab closes. Not persisted.
 */
import { create } from 'zustand'
import type { LDAPEntry, SearchParams, SearchResult, ServerType } from '../../types/ldap'
import type { SortState } from '../ui/DataTable'
import type { SearchRun } from '../layout/shellState'
import { OPERATIONAL_STATUS_ATTRIBUTES, currentResultsSearch, searchDetached, useSearchStore, type ResultsSearch, type SearchFailure } from '../../stores/searchStore'
import { useEditorStore } from '../../stores/editorStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { forgetAccountStatuses } from '../../stores/accountStatusCache'
import * as wails from '../../lib/wails'
import { restrictToAttributes } from '../../lib/bulk'
import { refreshAfterBulkApply } from '../../lib/bulkRefresh'
import { newRunId } from '../../lib/wails-bulk'
import { onAccountChanged } from '../../lib/wails-account'
import { readRowEntryShared } from '../../lib/rowRead'
import type { AccountStatus } from '../../types/account'
import { onEntryEvent } from '../../lib/entryEvents'
import { normalizeDN } from '../../lib/dn'
import type { BulkApplyResult } from '../../types/bulk'
import { ACCOUNT_STATUS_ATTRIBUTES } from '../ui/accountStatus'
import { ensureServerType } from '../ui/commands'
import { runOfResults, useStripRun } from './resultsRun'
import { CancelSearchRun, ReadEntries } from './searchApi'
import { defaultResultColumns, withStatusAttributes } from './searchModel'
import {
  isResultsTabId, keepPresent, rekeyChecked, resultsTabId, snapshotTitle, withFoundCount, withMovedRows, withoutDeletedRows,
  type CountedResult,
} from './snapshotModel'

export type SnapshotKind = 'search' | 'report' | 'list'

/** Loads a tab's rows: `changes` of the search (Load all: sizeLimit 0), `runId` for SearchRun / CancelSearchRun. */
export type SnapshotLoader = (changes?: Partial<SearchParams>, ctx?: { runId?: string }) => Promise<SnapshotData>

/** What a (re-)run of a tab delivers. */
export interface SnapshotData {
  results: SearchResult
  /** The search behind the rows (null: a report or a DN list without one). */
  search?: ResultsSearch | null
  run?: SearchRun | null
  displayColumns?: string[]
  /** One line about the rows ("2 of 24 entries no longer exist"). */
  note?: string | null
}

export interface ResultsSnapshot {
  id: string
  kind: SnapshotKind
  profileId: string
  title: string
  results: CountedResult
  search: ResultsSearch | null
  run: SearchRun | null
  note: string | null
  displayColumns: string[]
  sort: SortState | null
  checked: ReadonlySet<string>
  anchor: string | null
  /** The highlighted row (keyboard / click): the command selection when nothing is checked. */
  focus: string | null
  /** When the rows were taken (the last successful run). */
  takenAt: number
  loading: boolean
  cancelling: boolean
  /** The last re-run failed or was cancelled; the rows are the previous ones. */
  failure: SearchFailure | null
  /** A report re-uses its tab: `report:<profile>:<report id>`. */
  reuseKey?: string
  /** Re-run of a report or a DN list (a 'search' tab re-runs `search`); `runId` makes a search cancellable. */
  rerun?: SnapshotLoader
  /** Re-reads rows (account changes, after a bulk modify); default: GetEntry, keeping the row's columns. */
  refreshRows?: (entries: LDAPEntry[], dns: string[]) => Promise<LDAPEntry[] | null>
  /**
   * Patches the row of `dn` from the status an account action read after its
   * write (`ldapilot:account-changed` with `status`): no second read (RW1-P-06 c).
   * null = not patchable (the row is re-read with refreshRows / GetEntry).
   */
  patchFromStatus?: (entries: LDAPEntry[], dn: string, status: AccountStatus, displayColumns: readonly string[]) => LDAPEntry[] | null
}

interface SnapshotState {
  snapshots: Record<string, ResultsSnapshot>
}

export const useResultsSnapshots = create<SnapshotState>(() => ({ snapshots: {} }))

let seq = 0
/** Newest run per tab: results of a replaced run are dropped. */
const runTokens = new Map<string, number>()
let tokenSeq = 0

const EMPTY: ReadonlySet<string> = new Set()

export function getSnapshot(id: string | null | undefined): ResultsSnapshot | null {
  return id ? useResultsSnapshots.getState().snapshots[id] ?? null : null
}

function patch(id: string, fn: (s: ResultsSnapshot) => Partial<ResultsSnapshot> | null) {
  useResultsSnapshots.setState((st) => {
    const cur = st.snapshots[id]
    if (!cur) return st
    const p = fn(cur)
    if (!p) return st
    return { snapshots: { ...st.snapshots, [id]: { ...cur, ...p } } }
  })
}

function setTitle(id: string, title: string) {
  useEditorStore.getState().setSpecialTabLabel(id, title)
}

/** The tab of a reuse key (a report's tab), if open. */
export function snapshotByKey(key: string): ResultsSnapshot | null {
  return Object.values(useResultsSnapshots.getState().snapshots).find((s) => s.reuseKey === key) ?? null
}

export interface OpenSnapshotInput extends SnapshotData {
  kind: SnapshotKind
  profileId: string
  title: string
  sort?: SortState | null
  reuseKey?: string
  rerun?: ResultsSnapshot['rerun']
  refreshRows?: ResultsSnapshot['refreshRows']
  patchFromStatus?: ResultsSnapshot['patchFromStatus']
}

/**
 * Opens a results tab with these rows (activated), or fills the open tab
 * of the same reuse key (a report run again). Returns the tab id.
 */
export function openSnapshot(input: OpenSnapshotInput): string {
  const existing = input.reuseKey ? snapshotByKey(input.reuseKey) : null
  const id = existing?.id ?? resultsTabId(++seq)
  const results = withFoundCount(input.results)
  const next: ResultsSnapshot = {
    id,
    kind: input.kind,
    profileId: input.profileId,
    title: input.title,
    results,
    search: input.search ?? null,
    run: input.run ?? null,
    note: input.note ?? null,
    displayColumns: [...(input.displayColumns ?? existing?.displayColumns ?? useSearchStore.getState().displayColumns)],
    sort: input.sort !== undefined ? input.sort : existing?.sort ?? null,
    checked: existing ? keepPresent(existing.checked, results.entries) : EMPTY,
    anchor: null,
    focus: null,
    takenAt: Date.now(),
    loading: false,
    cancelling: false,
    failure: null,
    reuseKey: input.reuseKey,
    rerun: input.rerun,
    refreshRows: input.refreshRows,
    patchFromStatus: input.patchFromStatus,
  }
  runTokens.delete(id)
  runIds.delete(id)
  useResultsSnapshots.setState((st) => ({ snapshots: { ...st.snapshots, [id]: next } }))
  const es = useEditorStore.getState()
  if (es.tabs.some((t) => t.id === id)) {
    setTitle(id, input.title)
    es.setActiveTab(id)
  } else {
    es.addSpecialTab(id, input.title)
  }
  return id
}

/**
 * Open Results as Tab (DEF-16): the panel's results as a tab of their own,
 * with their search (re-runnable when they came from one), run, columns
 * and sort. Null when there are no results.
 */
export function openResultsSnapshot(): string | null {
  const ss = useSearchStore.getState()
  const results = ss.results
  if (!results) return null
  const rs = currentResultsSearch(ss)
  const profileId = ss.resultsProfileId ?? rs?.profileId ?? useConnectionStore.getState().activeProfileId
  if (!profileId) return null
  const run = runOfResults(results, rs, useStripRun.getState().run)
  const title = snapshotTitle({ source: run?.source, mode: rs?.mode, quickText: rs?.quick?.text, filter: rs?.params.filter ?? run?.filter })
  return openSnapshot({
    kind: 'search',
    profileId,
    title,
    // A copy: later changes of the panel's results never reach the tab.
    results: { ...results, entries: [...results.entries] },
    search: rs,
    run,
    displayColumns: ss.displayColumns,
    sort: ss.resultsSort,
  })
}

// --- Re-run ----------------------------------------------------------------------

/** True when the tab can run again (a search behind it, or its own re-run). */
export function canRerun(s: ResultsSnapshot | null): boolean {
  return !!s && (!!s.rerun || !!s.search)
}

const runIds = new Map<string, string>()

/**
 * Runs the tab's search (with `changes`, e.g. sizeLimit 0 = Load all), its
 * report or its DN list again into the tab. The rows stay until the new
 * ones arrive; a failure keeps them ("Previous results — …").
 */
export async function rerunSnapshot(id: string, changes?: Partial<SearchParams>, opts: { mode?: 'quick' | 'advanced' } = {}): Promise<void> {
  const s = getSnapshot(id)
  if (!s || !canRerun(s)) return
  const token = ++tokenSeq
  runTokens.set(id, token)
  const runId = newRunId()
  runIds.set(id, runId)
  patch(id, () => ({ loading: true, cancelling: false }))
  const startedAt = Date.now()
  try {
    let data: SnapshotData
    if (s.rerun) {
      data = await s.rerun(changes, { runId })
    } else {
      const rs = s.search!
      const { result, search } = await searchDetached(s.profileId, { ...rs.params, ...changes }, { mode: opts.mode ?? rs.mode, quick: rs.quick, serverType: rs.serverType, runId })
      data = {
        results: result,
        search,
        run: s.run ? { ...s.run, filter: search.params.filter, baseDN: search.params.baseDN, startedAt, durationMs: Date.now() - startedAt } : null,
      }
    }
    if (runTokens.get(id) !== token) return
    const results = withFoundCount(data.results)
    patch(id, (cur) => ({
      results,
      search: data.search !== undefined ? data.search : cur.search,
      run: data.run !== undefined ? data.run : cur.run,
      note: data.note !== undefined ? data.note : cur.note,
      displayColumns: data.displayColumns ? [...data.displayColumns] : cur.displayColumns,
      checked: keepPresent(cur.checked, results.entries),
      anchor: null,
      takenAt: Date.now(),
      loading: false,
      cancelling: false,
      failure: null,
    }))
  } catch (err) {
    if (runTokens.get(id) !== token) return
    const cancelled = wails.isSearchCancelled(err)
    const cur = getSnapshot(id)
    patch(id, () => ({
      loading: false,
      cancelling: false,
      failure: {
        kind: cancelled ? 'cancelled' : 'error',
        message: cancelled ? 'cancelled' : err instanceof Error ? err.message : String(err),
        profileId: s.profileId,
        params: { ...(cur?.search?.params ?? s.search?.params ?? { baseDN: s.run?.baseDN ?? '', filter: s.run?.filter ?? '', scope: 2, attributes: [], sizeLimit: 0, timeLimit: 30 }), ...changes },
        at: Date.now(),
      },
    }))
  } finally {
    if (runTokens.get(id) === token) {
      runTokens.delete(id)
      runIds.delete(id)
    }
  }
}

/** Cancels the tab's running search (only that run; the panel's search goes on). */
export async function cancelSnapshotRun(id: string): Promise<void> {
  const runId = runIds.get(id)
  if (!runId) return
  patch(id, () => ({ cancelling: true }))
  const ok = await CancelSearchRun(runId).catch(() => false)
  if (!ok) patch(id, () => ({ cancelling: false }))
}

/**
 * Runs `load` into the tab of `reuseKey` (reports, DEF-22): an open tab of
 * that key shows the run (spinner, old rows) and gets the new rows; without
 * one a tab opens once the rows are there. `load` is the tab's re-run too.
 * Throws what `load` throws (the caller reports it); an open tab then shows
 * the failure.
 */
export async function runIntoSnapshot(
  input: Omit<OpenSnapshotInput, keyof SnapshotData | 'rerun'> & { reuseKey: string; load: SnapshotLoader },
): Promise<string> {
  const existing = snapshotByKey(input.reuseKey)
  const token = ++tokenSeq
  const runId = newRunId()
  if (existing) {
    runTokens.set(existing.id, token)
    runIds.set(existing.id, runId)
    patch(existing.id, () => ({ loading: true, cancelling: false, title: input.title }))
    setTitle(existing.id, input.title)
    useEditorStore.getState().setActiveTab(existing.id)
  }
  try {
    const { load, ...rest } = input
    const data = await load(undefined, { runId })
    if (existing && runTokens.get(existing.id) !== token && getSnapshot(existing.id)) return existing.id
    return openSnapshot({ ...rest, ...data, rerun: load })
  } catch (err) {
    if (existing && runTokens.get(existing.id) === token) {
      runTokens.delete(existing.id)
      runIds.delete(existing.id)
      const cancelled = wails.isSearchCancelled(err)
      patch(existing.id, (cur) => ({
        loading: false,
        cancelling: false,
        failure: {
          kind: cancelled ? 'cancelled' : 'error', message: cancelled ? 'cancelled' : err instanceof Error ? err.message : String(err), profileId: input.profileId,
          params: cur.search?.params ?? { baseDN: cur.run?.baseDN ?? '', filter: cur.run?.filter ?? '', scope: 2, attributes: [], sizeLimit: 0, timeLimit: 30 },
          at: Date.now(),
        },
      }))
    }
    throw err
  }
}

// --- Open in List (DEF-17) ---------------------------------------------------------

/**
 * The entries of `dns` as a results tab ("Open in List" after an LDIF
 * import or a bulk run): read by DN with the status attributes; DNs that
 * no longer exist are named in the strip. Re-run reads them again.
 */
export async function openEntriesInList(profileId: string, dns: string[], title: string, origin?: string): Promise<string> {
  const serverType: ServerType | null = await ensureServerType(profileId).catch(() => null)
  const unique = [...new Map(dns.filter(Boolean).map((d) => [normalizeDN(d), d])).values()]
  const read = async (): Promise<SnapshotData> => {
    const startedAt = Date.now()
    const attrs = withStatusAttributes(['*'], ACCOUNT_STATUS_ATTRIBUTES, OPERATIONAL_STATUS_ATTRIBUTES)
    const res = await ReadEntries(profileId, unique, attrs.request)
    forgetAccountStatuses(profileId, res.entries.map((e) => e.dn))
    const lost = res.missing.length + res.errors.length
    const note = [
      res.missing.length ? `${res.missing.length} of ${unique.length} ${unique.length === 1 ? 'entry no longer exists' : 'entries no longer exist'}` : '',
      res.errors.length ? `${res.errors.length} could not be read (${res.errors[0].message})` : '',
      res.truncated ? 'only the first 5000 are shown' : '',
    ].filter(Boolean).join(' · ')
    return {
      results: { entries: res.entries, totalCount: res.entries.length, truncated: res.truncated },
      search: null,
      run: { source: title, description: origin ?? `${unique.length} ${unique.length === 1 ? 'entry' : 'entries'} by DN`, filter: '', baseDN: '', startedAt, durationMs: Date.now() - startedAt },
      note: lost || res.truncated ? note : null,
    }
  }
  const data = await read()
  return openSnapshot({ kind: 'list', profileId, title, ...data, displayColumns: defaultResultColumns(serverType), rerun: () => read() })
}

// --- Selection, sort, columns -------------------------------------------------------

export function selectSnapshotRows(id: string, checked: ReadonlySet<string>, anchor: string | null) {
  patch(id, () => ({ checked, anchor }))
}

export function setSnapshotFocus(id: string, dn: string | null) {
  patch(id, (s) => (s.focus === dn ? null : { focus: dn }))
}

export function setSnapshotSort(id: string, sort: SortState | null) {
  patch(id, () => ({ sort }))
}

export function addSnapshotColumn(id: string, column: string) {
  patch(id, (s) => (s.displayColumns.some((c) => c.toLowerCase() === column.toLowerCase()) ? null : { displayColumns: [...s.displayColumns, column] }))
}

export function removeSnapshotColumn(id: string, column: string) {
  patch(id, (s) => ({ displayColumns: s.displayColumns.filter((c) => c !== column) }))
}

// --- Row refresh ----------------------------------------------------------------------

/**
 * Re-reads rows by GetEntry (6 at a time), keeping each row's columns.
 * `shared`: after an entry event, the read is shared with the other views
 * of the row (lib/rowRead.ts); a bulk refresh reads anew.
 */
async function readRows(profileId: string, entries: LDAPEntry[], dns: string[], keep: string[], shared = false): Promise<LDAPEntry[] | null> {
  const wanted = new Set(dns.map((d) => normalizeDN(d)))
  const shown = entries.filter((e) => wanted.has(normalizeDN(e.dn))).map((e) => e.dn)
  if (!shown.length) return null
  const fresh = new Map<string, LDAPEntry>()
  let next = 0
  const worker = async () => {
    while (next < shown.length) {
      const dn = shown[next++]
      try {
        const e = shared ? await readRowEntryShared(profileId, dn) : await wails.GetEntry(profileId, dn)
        if (e) fresh.set(dn, e)
      } catch {
        /* keep the row */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, shown.length) }, worker))
  if (!fresh.size) return null
  return entries.map((e) => {
    const f = fresh.get(e.dn)
    return f ? restrictToAttributes(f, e, keep) : e
  })
}

/**
 * Re-reads the rows of `dns` in the tab (its own refreshRows, else GetEntry); the selection stays.
 * `shared`: the read follows an entry event and may be shared with the panel's results (lib/rowRead.ts).
 */
export async function refreshSnapshotRows(id: string, dns: string[], opts: { shared?: boolean } = {}): Promise<void> {
  const s = getSnapshot(id)
  if (!s || !dns.length) return
  const before = s.results
  const entries = s.refreshRows
    ? await s.refreshRows(before.entries, dns).catch(() => null)
    : await readRows(s.profileId, before.entries, dns, [...s.displayColumns, ...ACCOUNT_STATUS_ATTRIBUTES], !!opts.shared)
  if (!entries) return
  patch(id, (cur) => {
    if (cur.results !== before) return null // replaced meanwhile (re-run)
    const results: CountedResult = { ...cur.results, entries, totalCount: entries.length }
    // A report's refresh can drop rows (an unlocked account): that is no deletion.
    if (entries.length !== cur.results.entries.length) results.found = entries.length
    return { results, checked: keepPresent(cur.checked, entries) }
  })
}

/** After a bulk modify from a tab: tree / editor tabs, then the changed rows. */
export async function refreshSnapshotAfterBulk(id: string, profileId: string, result: BulkApplyResult): Promise<void> {
  refreshAfterBulkApply(profileId, result).catch(() => {})
  const dns = (result.items || []).filter((it) => it.status === 'success').map((it) => it.dn)
  await refreshSnapshotRows(id, dns)
}

// --- Entry events: the rows of every tab follow them --------------------------------

function forProfile(profileId: string): ResultsSnapshot[] {
  return Object.values(useResultsSnapshots.getState().snapshots).filter((s) => s.profileId === profileId)
}

const pendingRefresh = new Map<string, Set<string>>()
let refreshTimer: ReturnType<typeof setTimeout> | null = null

function scheduleRefresh(id: string, dn: string) {
  const set = pendingRefresh.get(id) ?? new Set<string>()
  set.add(dn)
  pendingRefresh.set(id, set)
  if (refreshTimer) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    const jobs = [...pendingRefresh.entries()]
    pendingRefresh.clear()
    for (const [tab, dns] of jobs) void refreshSnapshotRows(tab, [...dns], { shared: true })
  }, 300)
}

onEntryEvent('ldapilot:entry-moved', ({ profileId, oldDN, newDN }) => {
  for (const s of forProfile(profileId)) {
    const moved = withMovedRows(s.results, oldDN, newDN)
    if (!moved) continue
    patch(s.id, (cur) => ({
      results: moved.next,
      checked: rekeyChecked(cur.checked, moved.renamed),
      anchor: cur.anchor ? moved.renamed.get(cur.anchor) ?? cur.anchor : null,
      focus: cur.focus ? moved.renamed.get(cur.focus) ?? cur.focus : null,
    }))
    // The renamed entry's own attributes (cn, name) changed too.
    scheduleRefresh(s.id, newDN)
  }
})

onEntryEvent('ldapilot:entry-deleted', ({ profileId, dn, subtree }) => {
  for (const s of forProfile(profileId)) {
    const next = withoutDeletedRows(s.results, dn, !!subtree)
    if (!next) continue
    patch(s.id, (cur) => ({ results: next, checked: keepPresent(cur.checked, next.entries), focus: cur.focus && next.entries.some((e) => e.dn === cur.focus) ? cur.focus : null }))
  }
})

onAccountChanged(({ profileId, dn, status }) => {
  const key = normalizeDN(dn)
  for (const s of forProfile(profileId)) {
    if (!s.results.entries.some((e) => normalizeDN(e.dn) === key)) continue
    // The status read right after the action patches a report row: no second read (RW1-P-06 c).
    const entries = status && s.patchFromStatus ? s.patchFromStatus(s.results.entries, dn, status, s.displayColumns) : null
    if (entries) {
      const before = s.results
      patch(s.id, (cur) => (cur.results !== before ? null : { results: { ...cur.results, entries } }))
      continue
    }
    scheduleRefresh(s.id, dn)
  }
})

// A closed tab drops its rows.
useEditorStore.subscribe((s, prev) => {
  if (s.tabs === prev.tabs) return
  const open = new Set(s.tabs.filter((t) => isResultsTabId(t.id)).map((t) => t.id))
  const all = useResultsSnapshots.getState().snapshots
  const gone = Object.keys(all).filter((id) => !open.has(id))
  if (!gone.length) return
  const next = { ...all }
  for (const id of gone) {
    delete next[id]
    runTokens.delete(id)
    const runId = runIds.get(id)
    if (runId) void CancelSearchRun(runId).catch(() => false)
    runIds.delete(id)
  }
  useResultsSnapshots.setState({ snapshots: next })
})
