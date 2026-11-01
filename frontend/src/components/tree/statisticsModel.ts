/**
 * Pure parts of the statistics dialog (TREE-06, DEF-23): the text of
 * "Copy as Text", shares, the size-limit note and the request IDs of the
 * cancellable count. Runs under `node --test` (tests/rest.test.ts).
 */

/** The counts of GetStatistics / GetStatisticsRun (lib/wails ObjectStats). */
export interface StatsCounts {
  totalCount: number
  byType: Record<string, number>
  truncated?: boolean
}

/** Share of a category in percent, one decimal ("0" without entries). */
export function statsShare(count: number, total: number): string {
  return total > 0 ? ((count / total) * 100).toFixed(1) : '0'
}

/** The note of a count that stopped at the server-side size limit ("" otherwise). */
export function statsTruncatedNote(stats: Pick<StatsCounts, 'totalCount' | 'truncated'>): string {
  return stats.truncated ? `Counted the first ${stats.totalCount.toLocaleString()} entries only (size limit): the numbers are a lower bound.` : ''
}

/** The statistics as plain text (Copy as Text). */
export function statisticsText(dn: string, stats: StatsCounts): string {
  const rows = Object.entries(stats.byType).sort((a, b) => b[1] - a[1])
  const width = Math.max(13, ...rows.map(([t]) => t.length))
  const note = statsTruncatedNote(stats)
  return [
    `Object statistics below ${dn}`,
    `${'Total objects'.padEnd(width)}  ${stats.totalCount.toLocaleString()}${stats.truncated ? '+' : ''}`,
    ...rows.map(([type, count]) => `${type.padEnd(width)}  ${count.toLocaleString().padStart(7)}  ${statsShare(count, stats.totalCount).padStart(5)} %`),
    ...(note ? [note] : []),
  ].join('\n')
}

let statsSeq = 0
/** A new request ID for one count (GetStatisticsRun / CancelStatistics). */
export function nextStatsRequestId(): string {
  statsSeq += 1
  return `stats-${Date.now().toString(36)}-${statsSeq}`
}

/** Phases of the dialog: counting (Stop offered), done, stopped (no counts shown), error. */
export type StatsPhase = 'counting' | 'done' | 'stopped' | 'error'

/**
 * The phase after the count's call settled. A count the user stopped (or
 * that a newer count replaced) ends "stopped" whatever the call returned:
 * its partial or late result is discarded.
 */
export function statsPhaseAfter(outcome: 'ok' | 'error', stoppedByUser: boolean): StatsPhase {
  if (stoppedByUser) return 'stopped'
  return outcome === 'ok' ? 'done' : 'error'
}
