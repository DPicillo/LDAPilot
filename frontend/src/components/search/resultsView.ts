/**
 * One results view for SearchResults, its actions and the results strip:
 * the bottom panel's live results (search store), or a results tab
 * (resultsSnapshots) when rendered inside <ResultsSnapshotContext value={id}>.
 */
import { createContext, useContext } from 'react'
import type { SearchParams, SearchResult } from '../../types/ldap'
import type { SortState } from '../ui/DataTable'
import type { BulkApplyResult } from '../../types/bulk'
import type { SearchRun } from '../layout/shellState'
import { currentResultsSearch, useSearchStore, type ResultsSearch, type SearchFailure, type SearchOrigin } from '../../stores/searchStore'
import { useSearchChecked, useSearchSelectionStore } from '../../stores/searchSelectionStore'
import { refreshSearchResultsAfterBulk } from '../../lib/bulkRefresh'
import { runOfResults, useStripRun } from './resultsRun'
import {
  addSnapshotColumn, cancelSnapshotRun, canRerun, getSnapshot, refreshSnapshotAfterBulk, removeSnapshotColumn, rerunSnapshot, selectSnapshotRows,
  setSnapshotSort, useResultsSnapshots, type ResultsSnapshot,
} from './resultsSnapshots'
import { useEditorStore } from '../../stores/editorStore'

/** The results tab a view renders (null: the panel's live results). */
export const ResultsSnapshotContext = createContext<string | null>(null)

export function useSnapshotId(): string | null {
  return useContext(ResultsSnapshotContext)
}

export interface ResultsView {
  /** The results tab, or null for the live results. */
  snapshotId: string | null
  snapshot: ResultsSnapshot | null
  results: SearchResult | null
  profileId: string | null
  /** The search behind the rows (null: written by others, a report or a DN list). */
  search: ResultsSearch | null
  /** Report name / filter / base / time of the rows. */
  run: SearchRun | null
  loading: boolean
  cancelling: boolean
  failure: SearchFailure | null
  displayColumns: string[]
  sort: SortState | null
  checked: ReadonlySet<string>
  /** Can run again (live: a search behind the rows; tab: its search, report or DN list). */
  rerunnable: boolean
  /** Changes when new rows arrive (scrolls the grid back to the Name column). */
  runKey: unknown
}

/** The view of the surrounding results (tab or panel). */
export function useResultsView(): ResultsView {
  const snapshotId = useSnapshotId()
  const snapshot = useResultsSnapshots((s) => (snapshotId ? s.snapshots[snapshotId] ?? null : null))
  const liveResults = useSearchStore((s) => s.results)
  const liveProfileId = useSearchStore((s) => s.resultsProfileId)
  const liveSearch = useSearchStore(currentResultsSearch)
  const liveLoading = useSearchStore((s) => s.loading)
  const liveCancelling = useSearchStore((s) => s.cancelling)
  const liveFailure = useSearchStore((s) => s.lastFailure)
  const liveColumns = useSearchStore((s) => s.displayColumns)
  const liveSort = useSearchStore((s) => s.resultsSort)
  const liveChecked = useSearchChecked(liveResults)
  const stripRun = useStripRun((s) => s.run)
  if (snapshotId) {
    return {
      snapshotId,
      snapshot,
      results: snapshot?.results ?? null,
      profileId: snapshot?.profileId ?? null,
      search: snapshot?.search ?? null,
      run: snapshot?.run ?? null,
      loading: !!snapshot?.loading,
      cancelling: !!snapshot?.cancelling,
      failure: snapshot?.failure ?? null,
      displayColumns: snapshot?.displayColumns ?? [],
      sort: snapshot?.sort ?? null,
      checked: snapshot?.checked ?? EMPTY,
      rerunnable: canRerun(snapshot),
      runKey: snapshot?.takenAt,
    }
  }
  return {
    snapshotId: null,
    snapshot: null,
    results: liveResults,
    profileId: liveProfileId,
    search: liveSearch,
    run: runOfResults(liveResults, liveSearch, stripRun),
    loading: liveLoading,
    cancelling: liveCancelling,
    failure: liveFailure,
    displayColumns: liveColumns,
    sort: liveSort,
    checked: liveChecked,
    rerunnable: !!liveSearch,
    runKey: stripRun?.startedAt,
  }
}

const EMPTY: ReadonlySet<string> = new Set()

/** What the user can do with the rows of a view (plain functions: safe in callbacks). */
export interface ResultsActions {
  select: (results: SearchResult, checked: ReadonlySet<string>, anchor: string | null) => void
  clearSelection: () => void
  setSort: (sort: SortState | null) => void
  addColumn: (column: string) => void
  removeColumn: (column: string) => void
  /** Live: Clear the results; tab: close it. */
  clear: () => void
  rerun: (changes?: Partial<SearchParams>) => Promise<void>
  cancel: () => Promise<void>
  /** After a bulk modify of rows of this view (tree, tabs and the changed rows). */
  refreshAfterBulk: (profileId: string, result: BulkApplyResult) => void
  /** A follow-up search with another filter (AD name resolution: "names containing"). */
  searchWith: (profileId: string, filter: string, origin: SearchOrigin) => void
}

export function resultsActions(snapshotId: string | null): ResultsActions {
  if (snapshotId) {
    return {
      select: (_results, checked, anchor) => selectSnapshotRows(snapshotId, checked, anchor),
      clearSelection: () => selectSnapshotRows(snapshotId, EMPTY, null),
      setSort: (sort) => setSnapshotSort(snapshotId, sort),
      addColumn: (c) => addSnapshotColumn(snapshotId, c),
      removeColumn: (c) => removeSnapshotColumn(snapshotId, c),
      clear: () => useEditorStore.getState().closeTab(snapshotId),
      rerun: (changes) => rerunSnapshot(snapshotId, changes),
      cancel: () => cancelSnapshotRun(snapshotId),
      refreshAfterBulk: (profileId, result) => void refreshSnapshotAfterBulk(snapshotId, profileId, result).catch(() => {}),
      searchWith: (_profileId, filter, origin) => {
        // The tab runs the new filter itself (the panel's results stay).
        const s = getSnapshot(snapshotId)
        if (!s?.search) return
        void rerunSnapshot(snapshotId, { filter, ...origin.overrides }, { mode: origin.mode })
      },
    }
  }
  const ss = () => useSearchStore.getState()
  return {
    select: (results, checked, anchor) => useSearchSelectionStore.getState().select(results, checked, anchor),
    clearSelection: () => useSearchSelectionStore.getState().clear(),
    setSort: (sort) => ss().setResultsSort(sort),
    addColumn: (c) => ss().addDisplayColumn(c),
    removeColumn: (c) => ss().removeDisplayColumn(c),
    clear: () => ss().clearResults(),
    rerun: (changes) => ss().rerunResults(changes ?? {}),
    cancel: () => ss().cancelSearch(),
    refreshAfterBulk: (profileId, result) => void refreshSearchResultsAfterBulk(profileId, result).catch(() => {}),
    searchWith: (profileId, filter, origin) => void ss().executeSearch(profileId, filter, origin),
  }
}
