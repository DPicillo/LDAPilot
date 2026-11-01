/**
 * What produced the rows (report / filter, base, scope, count, time) above
 * the panel's results and above a results tab (RW2-R-03, DEF-16). A results
 * tab adds when its rows were taken, a note (entries of a DN list that no
 * longer exist) and Re-run / Cancel of its own search.
 */
import { RefreshCw, TableProperties } from 'lucide-react'
import { useSearchStore } from '../../stores/searchStore'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import { TruncatedText } from '../ui/TruncatedText'
import { SearchFailureNote, SizeLimitBadge } from './SearchResults'
import { resultsActions, useResultsView } from './resultsView'
import { deletedCount } from './snapshotModel'

const SCOPE_LABEL: Record<number, string> = { 0: 'base entry only', 1: 'one level' }

/** "15:36:12" (today) or "2026-10-31 15:36". */
function takenText(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  const now = new Date()
  return d.toDateString() === now.toDateString() ? time : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${time.slice(0, 5)}`
}

export function ResultsStrip() {
  const view = useResultsView()
  const { results, loading, cancelling, failure, snapshot, run } = view
  const rs = view.search
  // The panel: while a search runs, what it searches (a tab's re-run keeps its own parameters).
  const running = useSearchStore((s) => s.runningParams)
  const params = useSearchStore((s) => s.params)
  const tab = !!view.snapshotId
  const actions = resultsActions(view.snapshotId)
  // While a search runs: what it searches. Otherwise: the parameters the rows
  // were searched with (a failure after them adds "Showing previous results").
  const shown: { filter: string; baseDN: string; scope?: number } | null = loading && !tab
    ? (running ?? params)
    : rs
      ? rs.params
      : run
        ? { filter: run.filter, baseDN: run.baseDN }
        : failure
          ? failure.params
          : null
  const count = results ? results.totalCount || results.entries?.length || 0 : 0
  const deleted = deletedCount(results)
  const durationMs = rs && !(tab && run?.durationMs != null) ? rs.finishedAt - rs.startedAt : (run?.durationMs ?? null)
  const failedAfter = !loading && !!failure && (tab || (rs ? failure.at >= rs.finishedAt : run ? failure.at >= run.startedAt : true))
  const source = ((!loading || tab) && run?.source) || (rs?.mode === 'quick' && (!loading || tab) ? 'Quick search' : 'Search')
  const scope = shown?.scope !== undefined ? SCOPE_LABEL[shown.scope] : undefined

  return (
    <div className="@container flex items-center gap-3 h-7 px-3 border-b border-border text-xs text-muted-foreground shrink-0 min-w-0" aria-label={tab ? 'Results context' : 'Search context'}>
      <span className="inline-flex items-center gap-1 font-medium text-foreground shrink-0 max-w-[30%] min-w-0">
        <TableProperties size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
        <TruncatedText text={source} />
      </span>
      {(!loading || tab) && !rs && run?.description && !run.filter ? (
        <TruncatedText text={run.description} className="min-w-0 max-w-[40%]" />
      ) : (
        shown?.filter && <TruncatedText text={shown.filter} className="font-mono min-w-0 max-w-[40%]" />
      )}
      {shown?.baseDN && (
        <span className="hidden @[560px]:inline-flex items-center gap-1 min-w-0 max-w-[25%]">
          <span className="shrink-0">in</span>
          <TruncatedText text={shown.baseDN} className="font-mono min-w-0" />
          {scope && <span className="shrink-0">({scope})</span>}
        </span>
      )}
      {snapshot?.note && !failedAfter && <TruncatedText text={snapshot.note} className="min-w-0 text-warning" />}
      {failedAfter && <SearchFailureNote className="min-w-[120px] flex-1" />}
      <span className="ml-auto inline-flex items-center gap-2 shrink-0 tabular-nums">
        {loading ? (
          <>
            <Spinner size="sm" label={tab ? 'Running again' : 'Searching'} />
            <span>{cancelling ? 'Cancelling…' : tab ? 'Running again…' : 'Searching…'}</span>
            {(!tab || !!rs) && (
              <Button size="sm" variant="ghost" disabled={cancelling} onClick={() => void actions.cancel()}>
                Cancel
              </Button>
            )}
          </>
        ) : results ? (
          <>
            <span>
              {count} entr{count === 1 ? 'y' : 'ies'}
              {deleted > 0 && ` · ${deleted} deleted`}
              {durationMs != null && ` · ${durationMs} ms`}
            </span>
            {results.truncated && <SizeLimitBadge />}
          </>
        ) : null}
        {snapshot && (
          <>
            <span title={`The rows as of ${new Date(snapshot.takenAt).toLocaleString()}; later searches do not change them`}>as of {takenText(snapshot.takenAt)}</span>
            {view.rerunnable && (
              <Button size="sm" variant="ghost" leftIcon={RefreshCw} disabled={loading} onClick={() => void actions.rerun()} title={snapshot.kind === 'report' ? 'Run the report again (into this tab)' : snapshot.kind === 'list' ? 'Read these entries again' : 'Run this search again (into this tab)'}>
                {snapshot.kind === 'list' ? 'Refresh' : 'Run Again'}
              </Button>
            )}
          </>
        )}
      </span>
    </div>
  )
}
