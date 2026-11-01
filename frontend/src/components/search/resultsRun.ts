/**
 * The run behind the panel's results (report name, filter, base, time) for
 * the results strip and for a results tab taken of them (DEF-16). The
 * shell's lastSearch, except one followed by a failure: then the strip
 * keeps naming the rows that are still shown.
 */
import { create } from 'zustand'
import { useShellState, type SearchRun } from '../layout/shellState'
import { useSearchStore, type ResultsSearch } from '../../stores/searchStore'
import type { SearchResult } from '../../types/ldap'

export const useStripRun = create<{ run: SearchRun | null }>(() => ({ run: null }))
useShellState.subscribe((s, prev) => {
  if (!s.lastSearch || s.lastSearch === prev.lastSearch) return
  const failure = useSearchStore.getState().lastFailure
  if (failure && failure.at >= s.lastSearch.startedAt) return
  useStripRun.setState({ run: s.lastSearch })
})

/**
 * The run of `results`: the strip run of their search (a filter report's
 * name), or the run recorded with rows written directly (account reports);
 * null without results.
 */
export function runOfResults(results: SearchResult | null, rs: ResultsSearch | null, stripRun: SearchRun | null): SearchRun | null {
  if (!results) return null
  if (!rs) return stripRun
  return stripRun && stripRun.startedAt >= rs.startedAt && stripRun.startedAt <= rs.finishedAt ? stripRun : null
}
