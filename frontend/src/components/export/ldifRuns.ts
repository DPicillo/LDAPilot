/**
 * Recent LDIF changes grouped by import run (DEF-18). The audit details of
 * an applied LDIF record name its run ("LDIF import [run 1a2b3c4d], …",
 * services/bulk_ldif.go ldifAuditDetails); rows written before the run tag
 * existed are grouped by time (consecutive rows at most RUN_GAP_S apart).
 * Pure: runs under `node --test` (tests/search.ldifruns.test.ts).
 */

export interface AuditRowLike {
  timestamp: string
  operation: string
  dn: string
  details?: string
  error?: string
}

/** Audit details of LDIF apply runs start with this ("LDIF import", "LDIF modify", …). */
export const LDIF_AUDIT_PREFIX = 'LDIF '

/** Untagged rows further apart than this (seconds) belong to different runs. */
export const RUN_GAP_S = 10

export interface LDIFRun<R extends AuditRowLike = AuditRowLike> {
  /** Stable key: the run tag, else the time of the run's newest row. */
  key: string
  tag: string | null
  /** Newest first, as the audit log lists them. */
  rows: R[]
  /** Time of the first (oldest) and the last (newest) record. */
  startedAt: string
  endedAt: string
  /** Rows per operation (CREATE, MODIFY, DELETE, RENAME / MOVE). */
  counts: Record<string, number>
  failed: number
}

/** The run tag of an LDIF audit row, or null (older rows, other operations). */
export function ldifRunTag(details: string | undefined): string | null {
  const m = /^LDIF \S+ \[run ([0-9a-z]+)\]/i.exec(details ?? '')
  return m ? m[1].toLowerCase() : null
}

/** Seconds of a "2006-01-02 15:04:05" audit timestamp (NaN when unreadable). */
function seconds(ts: string): number {
  const t = Date.parse(ts.replace(' ', 'T'))
  return Number.isNaN(t) ? NaN : t / 1000
}

/**
 * The LDIF rows of `rows` (audit log order, newest first) grouped by run,
 * newest run first; at most `maxRuns` runs.
 */
export function groupLDIFRuns<R extends AuditRowLike>(rows: readonly R[], maxRuns = 10): LDIFRun<R>[] {
  const runs: LDIFRun<R>[] = []
  const byTag = new Map<string, LDIFRun<R>>()
  let open: LDIFRun<R> | null = null // the untagged run being collected
  let lastAt = NaN
  for (const r of rows) {
    if (!(r.details ?? '').startsWith(LDIF_AUDIT_PREFIX)) continue
    const tag = ldifRunTag(r.details)
    let run: LDIFRun<R> | undefined
    if (tag) {
      run = byTag.get(tag)
      open = null
    } else {
      const at = seconds(r.timestamp)
      run = open && Math.abs(lastAt - at) <= RUN_GAP_S ? open : undefined
      lastAt = at
    }
    if (!run) {
      if (runs.length >= maxRuns) {
        if (tag) continue
        break
      }
      run = { key: tag ?? `t:${r.timestamp}:${runs.length}`, tag, rows: [], startedAt: r.timestamp, endedAt: r.timestamp, counts: {}, failed: 0 }
      runs.push(run)
      if (tag) byTag.set(tag, run)
      else open = run
    }
    run.rows.push(r)
    if (r.timestamp < run.startedAt) run.startedAt = r.timestamp
    if (r.timestamp > run.endedAt) run.endedAt = r.timestamp
    const op = r.operation.toUpperCase()
    run.counts[op] = (run.counts[op] ?? 0) + 1
    if (r.error) run.failed++
  }
  return runs
}

const OP_WORD: Record<string, [string, string]> = {
  CREATE: ['created', 'created'],
  ADD: ['created', 'created'],
  MODIFY: ['modified', 'modified'],
  DELETE: ['deleted', 'deleted'],
  RENAME: ['renamed', 'renamed'],
  MOVE: ['moved', 'moved'],
}

/** "24 records · 22 created, 2 modified · 1 failed". */
export function runSummary(run: LDIFRun): string {
  const n = run.rows.length
  const parts = Object.entries(run.counts)
    .sort((a, b) => b[1] - a[1])
    .map(([op, c]) => `${c} ${OP_WORD[op]?.[0] ?? op.toLowerCase()}`)
  return [`${n} ${n === 1 ? 'record' : 'records'}`, parts.join(', '), run.failed ? `${run.failed} failed` : ''].filter(Boolean).join(' · ')
}

/** "15:36:12" of a "2026-11-01 15:36:12" timestamp; with the date when it is not `today` ("2026-11-01"). */
export function runTime(ts: string, today: string): string {
  const [date, time] = ts.split(' ')
  return date === today ? (time ?? ts) : `${date} ${(time ?? '').slice(0, 5)}`.trim()
}
