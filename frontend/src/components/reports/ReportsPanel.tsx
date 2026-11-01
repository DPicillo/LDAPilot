/**
 * Reports (SPEC 10.2): PanelHeader, category SegmentedControl, tone icons
 * (object-kind reports in their oc-* colour, problem reports in warning /
 * danger), the search panel's former filter templates merged in.
 *
 * - The catalog (lib/accountReports.ts) has a filter per server type (AD vs
 *   OpenLDAP / 389DS); AD-only reports and backend reports the server cannot
 *   answer (no logon tracking) are greyed with the reason.
 * - Every report runs into its own main-area results tab (DEF-22,
 *   components/search/resultsSnapshots `runIntoSnapshot`): one tab per
 *   report and connection, re-used (and renamed: "Days") when the report
 *   runs again, with Run Again, export and bulk actions; the panel's search
 *   results stay as they are.
 * - Filter reports run a search (`searchDetached`). Account-like ones also
 *   ask for the account status attributes, so the Status column works.
 *   "Edit as Search" copies the filter into the search panel's advanced
 *   mode and focuses it.
 * - Backend reports (account statuses, empty groups, privileged members)
 *   come with computed columns ("Locked until", "Days left", "Privileged
 *   groups"), are sorted by name and keep their rows current after account
 *   actions (`ldapilot:account-changed`: the tab re-reads the rows through
 *   the report, `refreshRows`).
 * - No toasts (a report is a read; UX-9): one summary/hint banner below the
 *   list (positive for an empty result), cleared on a server switch. A
 *   failed report opens no tab; its open tab says "Previous results — the
 *   last run failed".
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  Clock,
  FileText,
  Folder,
  Info,
  KeyRound,
  Lock,
  Monitor,
  Pencil,
  Play,
  Shield,
  ShieldAlert,
  UserCog,
  UserX,
  Users,
  User,
  X,
} from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { searchDetached, useSearchStore } from '../../stores/searchStore'
import { useUIStore } from '../../stores/uiStore'
import { rememberAccountStatus } from '../../stores/accountStatusCache'
import { cn } from '../../lib/utils'
import type { AccountReportKind, AccountReportResult, AccountStatus, ReportAvailability } from '../../types/account'
import type { LDAPEntry, SearchParams, SearchResult, ServerType } from '../../types/ldap'
import { GetReportAvailability, RunAccountReport, errorMessage, seedAccountStatus } from '../../lib/wails-account'
import { runIntoSnapshot, type SnapshotData } from '../search/resultsSnapshots'
import { canPatchFromStatus, patchReportRowFromStatus } from '../account/reportRows'
import {
  REPORTS, accountReportDisplayColumns, buildReportRows, correctReportDays, isGroupReport, patchReportRows, reportColumns, reportFilter,
  reportUnavailableReason, sortEntriesByName, summarizeAccountReport, withDays, type ReportCategory, type ReportDefinition,
} from '../../lib/accountReports'
import { ACCOUNT_STATUS_ATTRIBUTES } from '../ui/accountStatus'
import type { IconType } from '../ui/Button'
import { IconButton } from '../ui/Button'
import { PanelHeader } from '../ui/PanelHeader'
import { SegmentedControl } from '../ui/SegmentedControl'
import { EmptyState } from '../ui/EmptyState'
import { Input } from '../ui/Input'
import { Spinner } from '../ui/Spinner'
import { TruncatedText } from '../ui/TruncatedText'

/** Icon colour: an object kind (what the report lists) or a problem tone. */
type ReportTone = 'oc-user' | 'oc-group' | 'oc-ou' | 'oc-computer' | 'oc-service' | 'warning' | 'danger' | 'info' | 'neutral'

const TONE_CLASS: Record<ReportTone, string> = {
  'oc-user': 'text-oc-user',
  'oc-group': 'text-oc-group',
  'oc-ou': 'text-oc-ou',
  'oc-computer': 'text-oc-computer',
  'oc-service': 'text-oc-service',
  warning: 'text-warning',
  danger: 'text-destructive',
  info: 'text-info',
  neutral: 'text-muted-foreground',
}

const LOOK: Record<string, { icon: IconType; tone: ReportTone }> = {
  'all-users': { icon: User, tone: 'oc-user' },
  'users-no-email': { icon: UserX, tone: 'warning' },
  'users-no-login': { icon: Clock, tone: 'warning' },
  'service-accounts': { icon: UserCog, tone: 'oc-service' },
  'posix-users': { icon: User, tone: 'oc-user' },
  'disabled-accounts': { icon: UserX, tone: 'neutral' },
  'locked-accounts': { icon: Lock, tone: 'warning' },
  'pwd-expiring': { icon: CalendarClock, tone: 'warning' },
  'pwd-expired': { icon: KeyRound, tone: 'danger' },
  'pwd-never-expires': { icon: KeyRound, tone: 'warning' },
  'pwd-not-required': { icon: AlertTriangle, tone: 'danger' },
  'privileged-members': { icon: ShieldAlert, tone: 'danger' },
  'admin-accounts': { icon: Shield, tone: 'warning' },
  'all-groups': { icon: Users, tone: 'oc-group' },
  'empty-groups': { icon: Users, tone: 'warning' },
  'posix-groups': { icon: Users, tone: 'oc-group' },
  'all-ous': { icon: Folder, tone: 'oc-ou' },
  'all-computers': { icon: Monitor, tone: 'oc-computer' },
  'all-entries': { icon: FileText, tone: 'neutral' },
}

const CATEGORIES: { value: 'all' | ReportCategory; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'users', label: 'Users' },
  { value: 'security', label: 'Security' },
  { value: 'groups', label: 'Groups' },
  { value: 'system', label: 'System' },
]

/** The banner below the list: summary of the last report, a hint or a failure. */
interface Notice {
  profileId: string
  tone: 'success' | 'info' | 'danger'
  title: string
  lines: string[]
}

/** Noun of a backend report's rows in the summary. */
function nounOf(kind: AccountReportKind): [string, string] {
  if (kind === 'emptyGroups') return ['group', 'groups']
  return ['account', 'accounts']
}

/** Puts the focus into the search panel's filter once it is shown (Edit as Search). */
function focusSearchFilter(tries = 12) {
  if (typeof document === 'undefined') return
  const el = [...document.querySelectorAll<HTMLTextAreaElement>('[data-search-filter]')]
    .find((t) => t.getClientRects().length > 0)
  if (el) {
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  } else if (tries > 0) {
    requestAnimationFrame(() => focusSearchFilter(tries - 1))
  }
}

/** A report row's server status: cached for the menus and shared with an action started from the row (RW1-P-06). */
function rememberStatus(profileId: string, status: AccountStatus) {
  rememberAccountStatus(profileId, status)
  seedAccountStatus(profileId, status)
}

/** The tab of a report on a connection (re-used when it runs again). */
const reportTabKey = (profileId: string, report: ReportDefinition) => `report:${profileId}:${report.id}`

/**
 * Re-reads rows of a backend report through the report (`dns`): group
 * reports keep their "Nested via" / privileged-group columns, account
 * reports their computed status columns; rows that no longer match go.
 */
function backendRowRefresher(profileId: string, kind: AccountReportKind, baseDN: string, days: number) {
  return async (entries: LDAPEntry[], dns: string[]): Promise<LDAPEntry[] | null> => {
    const res = await RunAccountReport(profileId, { report: kind, baseDN, days, sizeLimit: dns.length, dns })
    if (!res) return null
    const rows = buildReportRows(kind, res, new Date())
    for (const r of rows) if (r.status) rememberStatus(profileId, r.status)
    return patchReportRows(entries, dns, rows, isGroupReport(kind))
  }
}

export function ReportsPanel() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId)
  const isConnected = useConnectionStore((s) => (s.activeProfileId ? s.connectionStatuses[s.activeProfileId] === true : false))
  const activeProfile = useConnectionStore((s) => s.profiles.find((p) => p.id === s.activeProfileId) ?? null)
  const [runningReport, setRunningReport] = useState<string | null>(null)
  const [category, setCategory] = useState<'all' | ReportCategory>('all')
  const [days, setDays] = useState('14')
  const [daysNote, setDaysNote] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [availability, setAvailability] = useState<{ profileId: string; data: ReportAvailability } | null>(null)

  const baseDN = activeProfile?.baseDN || ''
  const avail = availability && availability.profileId === activeProfileId ? availability.data : null
  const serverType = avail?.serverType ?? null

  // Server type and backend report support of the connection; a server switch clears the banner.
  useEffect(() => {
    setNotice(null)
    if (!activeProfileId || !isConnected) return
    let cancelled = false
    GetReportAvailability(activeProfileId, baseDN)
      .then((data) => {
        if (!cancelled && data) setAvailability({ profileId: activeProfileId, data })
      })
      .catch(() => {
        /* everything stays offered; a report that cannot run says why */
      })
    return () => {
      cancelled = true
    }
  }, [activeProfileId, isConnected, baseDN])

  /** Validates the Days field and writes the corrected value back. */
  function currentDays(): number {
    const c = correctReportDays(days)
    if (c.corrected) {
      setDays(String(c.days))
      setDaysNote(c.message ?? null)
    } else {
      setDaysNote(null)
    }
    return c.days
  }

  /** Reads the server type and the backend reports the server cannot answer; null when unknown. */
  async function loadAvailability(profileId: string): Promise<ReportAvailability | null> {
    try {
      const data = await GetReportAvailability(profileId, baseDN)
      if (data) setAvailability({ profileId, data })
      return data
    } catch {
      return null
    }
  }

  /** A report that did not run: the banner says why (no tab opens; an open one keeps its rows, marked). */
  function failed(profileId: string, report: ReportDefinition, msg: string, tone: 'danger' | 'info' = 'danger') {
    setNotice({ profileId, tone, title: tone === 'danger' ? `${report.name} failed` : report.name, lines: [msg] })
  }

  async function runBackendReport(profileId: string, report: ReportDefinition, kind: AccountReportKind, type: string | null) {
    const n = report.takesDays ? currentDays() : 14
    const title = report.takesDays ? `${report.name} (${n} ${n === 1 ? 'day' : 'days'})` : report.name
    let last: AccountReportResult | null = null
    // The tab's Run Again runs this again (same base, days and server type).
    const load = async (): Promise<SnapshotData> => {
      const startedAt = Date.now()
      const result: AccountReportResult | null = await RunAccountReport(profileId, { report: kind, baseDN, days: n, sizeLimit: 5000 })
      last = result
      const rows = result ? buildReportRows(kind, result, new Date()) : []
      for (const r of rows.slice(0, 200)) if (r.status) rememberStatus(profileId, r.status)
      const entries = rows.map((r) => r.entry)
      const results: SearchResult = { entries, totalCount: entries.length, truncated: !!result?.truncated }
      return {
        results,
        search: null,
        // The strip names the report (no filter: its description).
        run: { source: title, description: withDays(report.description, n), empty: withDays(report.empty, n), filter: '', baseDN, startedAt, durationMs: Date.now() - startedAt },
        displayColumns: accountReportDisplayColumns(kind, type ?? result?.statuses?.[0]?.serverType, result?.columns ?? []),
      }
    }
    try {
      await runIntoSnapshot({
        kind: 'report', profileId, title, reuseKey: reportTabKey(profileId, report), sort: null, load,
        refreshRows: backendRowRefresher(profileId, kind, baseDN, n),
        // An account action's post-write status patches its row (no report re-read, RW1-P-06 c);
        // the tab's current columns decide (an added whenChanged column needs the re-read).
        patchFromStatus: (entries, dn, status, columns) =>
          canPatchFromStatus(kind, columns) ? patchReportRowFromStatus(entries, dn, kind, status, new Date()) : null,
      })
      const summary = summarizeAccountReport(title, last, withDays(report.empty, n), nounOf(kind))
      setNotice({ profileId, ...summary })
    } catch (err) {
      const msg = errorMessage(err, `${report.name} failed`)
      // The server's configuration may have changed since the panel looked (logon tracking
      // switched off): then it is a hint with the reason and the row turns grey, not a failure.
      const fresh = await loadAvailability(profileId)
      const reason = fresh ? reportUnavailableReason(report, fresh.serverType, fresh.unavailable) : null
      failed(profileId, report, reason ?? msg, reason ? 'info' : 'danger')
    }
  }

  async function runFilterReport(profileId: string, report: ReportDefinition, type: string | null) {
    const filter = reportFilter(report, type)
    if (!filter) return
    // Account-like reports read the status attributes too (Status column; operational ones must be named).
    const params: SearchParams = {
      ...useSearchStore.getState().params,
      baseDN, filter, scope: 2, sizeLimit: 5000, timeLimit: 30,
      attributes: report.accounts ? ['*', ...ACCOUNT_STATUS_ATTRIBUTES] : [],
      showDeleted: false, showRecycled: false, manageDsaIT: false,
    }
    let truncated = false
    let count = 0
    const load = async (changes?: Partial<SearchParams>, ctx?: { runId?: string }): Promise<SnapshotData> => {
      const startedAt = Date.now()
      const { result, search } = await searchDetached(profileId, { ...params, ...changes }, { mode: 'advanced', serverType: (type as ServerType | null) ?? null, runId: ctx?.runId })
      truncated = result.truncated
      count = result.entries.length
      return {
        // Reports list their rows by name.
        results: { ...result, entries: sortEntriesByName(result.entries) },
        search,
        run: { source: report.name, empty: report.empty, filter: search.params.filter, baseDN: search.params.baseDN, startedAt, durationMs: Date.now() - startedAt },
        displayColumns: reportColumns(report, type),
      }
    }
    try {
      await runIntoSnapshot({ kind: 'report', profileId, title: report.name, reuseKey: reportTabKey(profileId, report), sort: null, load })
      setNotice({
        profileId,
        tone: count === 0 ? 'success' : 'info',
        title: report.name,
        lines: [count === 0 ? `${report.empty}.` : `${count} ${count === 1 ? 'entry' : 'entries'}${truncated ? ' (size limit reached, incomplete)' : ''}.`],
      })
    } catch (err) {
      failed(profileId, report, errorMessage(err, `${report.name} failed`))
    }
  }

  async function runReport(report: ReportDefinition) {
    if (!activeProfileId || !isConnected || runningReport) return
    if (reportUnavailableReason(report, serverType, avail?.unavailable)) return
    const profileId = activeProfileId
    setRunningReport(report.id)
    setNotice(null)
    try {
      // The filter depends on the server type: read it first if the panel does not know it yet
      // (an AD must never get the LDAP variant because the report was clicked early).
      const info = avail ?? (await loadAvailability(profileId))
      const type = info?.serverType ?? null
      const reason = reportUnavailableReason(report, type, info?.unavailable)
      if (reason) {
        setNotice({ profileId, tone: 'info', title: report.name, lines: [reason] })
        return
      }
      if (report.accountReport) await runBackendReport(profileId, report, report.accountReport, type)
      else await runFilterReport(profileId, report, type)
    } finally {
      setRunningReport(null)
    }
  }

  /** The former search templates: the report's filter, editable in the search panel's advanced mode. */
  async function editAsSearch(report: ReportDefinition) {
    if (!activeProfileId) return
    const type = (avail ?? (await loadAvailability(activeProfileId)))?.serverType ?? null
    const filter = reportFilter(report, type)
    if (!filter) return
    const ss = useSearchStore.getState()
    // Return attributes stay empty: objectClass and the account status are always read, and the
    // report's columns become result columns (RW2-S-09: the internal list confused, and stayed on OpenLDAP).
    ss.setParams({ baseDN: baseDN || ss.params.baseDN, filter, attributes: [] })
    ss.setDisplayColumns(reportColumns(report, type), activeProfileId)
    ss.setPanelMode('advanced')
    useUIStore.getState().setActivity('search')
    requestAnimationFrame(() => focusSearchFilter())
  }

  if (!isConnected) {
    return (
      <div className="h-full flex flex-col bg-sidebar">
        <PanelHeader title="Reports" />
        <EmptyState icon={BarChart3} title="Not connected" hint="Connect to a directory to run reports." />
      </div>
    )
  }

  const displayReports = category === 'all' ? REPORTS : REPORTS.filter((r) => r.category === category)
  const shownNotice = notice && notice.profileId === activeProfileId ? notice : null
  const dayCount = correctReportDays(days).days

  return (
    <div className="h-full flex flex-col bg-sidebar">
      <PanelHeader
        title="Reports"
        filter={
          <SegmentedControl
            aria-label="Report category"
            options={CATEGORIES.map((c) => ({ ...c, count: c.value === 'all' ? undefined : REPORTS.filter((r) => r.category === c.value).length }))}
            value={category}
            onValueChange={setCategory}
            // Fits the default sidebar (280px) with tight segments; narrower sidebars wrap instead of clipping "System".
            className="w-full flex-wrap [&>button]:flex-1 [&>button]:px-1"
          />
        }
      />

      <ul className="flex-1 overflow-auto p-1.5 space-y-0.5" aria-label="Reports">
        {displayReports.map((report) => {
          const reason = reportUnavailableReason(report, serverType, avail?.unavailable)
          const editFilter = !report.accountReport && !reason ? reportFilter(report, serverType) : ''
          return (
            <ReportRow
              key={report.id}
              report={report}
              description={report.takesDays ? withDays(report.description, dayCount) : report.description}
              unavailable={reason}
              running={runningReport === report.id}
              busy={!!runningReport}
              onRun={() => void runReport(report)}
              onEdit={editFilter ? () => void editAsSearch(report) : undefined}
            >
              {report.takesDays && !reason && (
                <div className="pl-8 pr-2 pb-1.5 text-xs text-muted-foreground">
                  <label className="flex items-center gap-1.5">
                    within
                    <Input
                      type="number"
                      size="sm"
                      min={1}
                      max={3650}
                      step={1}
                      value={days}
                      invalid={!!daysNote}
                      onChange={(e) => {
                        setDays(e.target.value)
                        setDaysNote(null)
                      }}
                      onBlur={() => currentDays()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !runningReport) void runReport(report)
                      }}
                      className="w-16 tabular-nums"
                      aria-label="Days (1 to 3650)"
                    />
                    days
                  </label>
                  {daysNote && <p className="mt-0.5 text-warning" role="status">{daysNote}</p>}
                </div>
              )}
            </ReportRow>
          )
        })}
      </ul>

      {shownNotice && (
        <div className="shrink-0 border-t border-border px-3 py-2 text-xs text-muted-foreground space-y-0.5 max-h-[30%] overflow-auto" role="status">
          <div className="flex items-center gap-1 text-foreground font-medium">
            {shownNotice.tone === 'success' ? (
              <CheckCircle2 size={12} strokeWidth={1.75} aria-hidden className="text-success" />
            ) : shownNotice.tone === 'danger' ? (
              <AlertTriangle size={12} strokeWidth={1.75} aria-hidden className="text-destructive" />
            ) : (
              <Info size={12} strokeWidth={1.75} aria-hidden className="text-info" />
            )}
            <span className="flex-1 min-w-0 truncate">{shownNotice.title}</span>
            <IconButton label="Dismiss summary" icon={X} size="sm" onClick={() => setNotice(null)} />
          </div>
          {shownNotice.lines.map((l, i) => (
            <p key={i} className={cn('break-words', i === 0 && shownNotice.tone === 'success' && 'text-success', i === 0 && shownNotice.tone === 'danger' && 'text-destructive')}>
              {l}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

function ReportRow({ report, description, unavailable, running, busy, onRun, onEdit, children }: {
  report: ReportDefinition
  description: string
  /** Why the report cannot run on this server (greyed). */
  unavailable: string | null
  running: boolean
  busy: boolean
  onRun: () => void
  onEdit?: () => void
  children?: ReactNode
}) {
  const look = LOOK[report.id] ?? { icon: FileText, tone: 'neutral' as ReportTone }
  const Icon = look.icon
  const off = !!unavailable
  return (
    <li className={cn('group rounded-md focus-within:bg-accent', !off && 'hover:bg-accent')}>
      <div className="flex items-center">
        {/* While a report runs the other rows stay focusable (aria-disabled), so keyboard focus is not lost. */}
        <button type="button"
          onClick={() => { if (!busy) onRun() }}
          disabled={off}
          aria-disabled={(busy && !off) || undefined}
          aria-busy={running || undefined}
          title={unavailable ?? undefined}
          className="flex-1 min-w-0 flex items-center gap-2.5 px-2 py-2 text-left rounded-md focus-ring-inset disabled:cursor-not-allowed aria-disabled:cursor-progress"
        >
          <span className={cn('shrink-0', off ? 'text-disabled-foreground' : TONE_CLASS[look.tone])}>
            {running ? <Spinner size="md" label={`Running ${report.name}`} /> : <Icon size={16} strokeWidth={1.75} aria-hidden />}
          </span>
          <span className="flex-1 min-w-0">
            <TruncatedText text={report.name} className={cn('text-sm font-medium', off ? 'text-disabled-foreground' : 'text-foreground')} />
            {off ? (
              <TruncatedText text={unavailable!} className="text-xs text-muted-foreground italic" />
            ) : (
              <TruncatedText text={description} className="text-xs text-muted-foreground" />
            )}
          </span>
          {!off && <Play size={12} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted-foreground invisible group-hover:visible group-focus-within:visible" />}
        </button>
        {onEdit && <IconButton label="Edit as Search" icon={Pencil} size="md" revealOnRowHover className="mr-1" onClick={onEdit} />}
      </div>
      {children}
    </li>
  )
}
