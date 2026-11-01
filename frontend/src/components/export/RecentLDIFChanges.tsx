/**
 * Recent LDIF changes of the Import / Export panel, grouped by import run
 * (DEF-18): a header per run ("15:36:12 · 24 records · 22 created, 2
 * modified · 1 failed", expandable, the newest run open) with "Open in
 * List" (the run's entries that still exist as a results tab, DEF-17), and
 * the run's records below it. A record opens its entry (following later
 * renames); a deleted one says so (`onOpenRow` decides, as before).
 */
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, ListChecks } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { AuditEntry } from '../../lib/wails'
import { deletedForGood, forwardDN, auditNewDN, opTone } from '../layout/opTone'
import { rdnValue } from '../ui/dn'
import { IconButton } from '../ui/Button'
import { toast } from '../ui/Toast'
import { openEntriesInList } from '../search/resultsSnapshots'
import { groupLDIFRuns, runSummary, runTime, type LDIFRun } from './ldifRuns'

/** Rows shown per run before "… n more". */
const ROWS_PER_RUN = 50

function todayText(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The entries of a run that still exist, in run order, at their current DN. */
function runEntryDNs(run: LDIFRun<AuditEntry>, all: readonly AuditEntry[]): string[] {
  const out = new Map<string, string>()
  for (const r of [...run.rows].reverse()) {
    if (r.error) continue
    const op = r.operation.toUpperCase()
    if (op === 'DELETE') {
      out.delete(r.dn.toLowerCase())
      continue
    }
    const dn = op === 'RENAME' || op === 'MOVE' ? auditNewDN(r) || r.dn : r.dn
    if (op === 'RENAME' || op === 'MOVE') out.delete(r.dn.toLowerCase())
    const now = forwardDN(all, dn, r.timestamp)
    out.set(now.toLowerCase(), now)
  }
  return [...out.values()]
}

export function RecentLDIFChanges({ profileId, auditRows, loading, serverType, onOpenRow }: {
  profileId: string | null
  /** The connection's audit log, newest first (the panel reads 500 rows). */
  auditRows: AuditEntry[]
  loading: boolean
  serverType: string | null
  onOpenRow: (row: AuditEntry) => void
}) {
  const runs = useMemo(() => groupLDIFRuns(auditRows, 10), [auditRows])
  // Open runs by key; the newest run is open until the user closes it.
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const isOpen = (run: LDIFRun, i: number) => toggled[run.key] ?? i === 0
  const today = todayText()

  const openInList = async (run: LDIFRun<AuditEntry>) => {
    if (!profileId) return
    const dns = runEntryDNs(run, auditRows)
    if (!dns.length) {
      toast.info('No entry of this run exists any more')
      return
    }
    try {
      await openEntriesInList(profileId, dns, `LDIF import ${runTime(run.startedAt, today)} (${dns.length})`, `${dns.length} ${dns.length === 1 ? 'entry' : 'entries'} of the LDIF import of ${run.startedAt}`)
    } catch (err) {
      toast.error('Could not open the entries', err instanceof Error ? err.message : String(err))
    }
  }

  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">{loading ? 'Loading…' : 'No LDIF changes in the audit log yet.'}</p>
  }
  return (
    <ul className="-mx-1 space-y-1" aria-label="LDIF import runs">
      {runs.map((run, i) => {
        const open = isOpen(run, i)
        const listId = `ldif-run-${i}`
        const summary = runSummary(run)
        return (
          <li key={run.key}>
            <div className="group flex items-center gap-1 h-6 rounded-sm hover:bg-accent focus-within:bg-accent">
              <button type="button"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => setToggled((t) => ({ ...t, [run.key]: !open }))}
                title={`${summary}\n${run.startedAt === run.endedAt ? run.startedAt : `${run.startedAt} – ${run.endedAt}`}${run.tag ? `\nRun ${run.tag}` : ''}`}
                className="flex-1 min-w-0 flex items-center gap-1 h-6 px-1 rounded-sm text-left text-sm focus-ring-inset"
              >
                {open ? <ChevronDown size={12} strokeWidth={1.75} aria-hidden className="shrink-0" /> : <ChevronRight size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />}
                <span className="shrink-0 tabular-nums text-foreground font-medium">{runTime(run.startedAt, today)}</span>
                <span className={cn('min-w-0 truncate text-xs', run.failed ? 'text-destructive' : 'text-muted-foreground')}>{summary}</span>
              </button>
              <IconButton label={`Open the entries of this run in a list`} icon={ListChecks} size="sm" revealOnRowHover className="mr-0.5" onClick={() => void openInList(run)} />
            </div>
            {open && (
              <ul id={listId} className="pl-4" aria-label={`Records of the run at ${run.startedAt}`}>
                {run.rows.slice(0, ROWS_PER_RUN).map((e, j) => {
                  const gone = deletedForGood(auditRows, e)
                  return (
                    <li key={`${e.timestamp}-${e.dn}-${j}`}>
                      <button type="button"
                        onClick={() => onOpenRow(e)}
                        title={[`${e.operation} ${e.dn}`, e.error, gone ? (serverType === 'ad' ? 'Deleted: opens Deleted Objects' : 'Deleted: no entry to open') : ''].filter(Boolean).join('\n')}
                        className="w-full flex items-center gap-2 h-6 px-1 rounded-sm text-left text-sm hover:bg-accent focus-ring-inset"
                      >
                        <span className={cn('text-xs font-semibold shrink-0 w-14', opTone(e.operation))}>{e.operation}</span>
                        <span className={cn('min-w-0 truncate', gone ? 'text-muted-foreground line-through' : 'text-foreground')}>{rdnValue(e.dn) || e.dn}</span>
                        {e.error && <span className="text-xs text-destructive shrink-0">failed</span>}
                        <span className="ml-auto text-xs text-muted-foreground tabular-nums shrink-0">{runTime(e.timestamp, today)}</span>
                      </button>
                    </li>
                  )
                })}
                {run.rows.length > ROWS_PER_RUN && (
                  <li className="px-1 text-xs text-muted-foreground">… {run.rows.length - ROWS_PER_RUN} more (Open in List shows all)</li>
                )}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}
