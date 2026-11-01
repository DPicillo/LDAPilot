/**
 * Bottom panel (SPEC 7.6). 32px header with panel Tabs (Results N /
 * Operations / Audit Log) and actions (Open as Tab = a results tab with a
 * snapshot of the rows, DEF-16; Maximize, Hide).
 * Results: context strip of the search that produced the rows (source,
 * filter, base DN, "12 entries · 84 ms", "Size limit reached · Load all");
 * a failed or cancelled search keeps it and says "Showing previous results —
 * …" (the only error surface of a search).
 * Logs: DataTable (virtualized, sticky header, sortable), op colours from
 * text-op-*, Error-only SegmentedControl, Export CSV. Operations: double-click
 * / Enter opens the row's DN, row menu (Copy Line, Copy DN, Show in Tree,
 * Filter by This DN), Clear also resets the status bar's last operation.
 * Audit log: date range, live updates (audit:entry), RENAME/MOVE rows link to
 * the new DN, the "ldapilot:audit-filter" event shows it filtered to a DN,
 * Clear needs the connection name typed (or Export, then Clear) and leaves an
 * AUDIT_CLEARED record. Tabs mount on first visit and then stay mounted.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  ArrowRight,
  Ban,
  ChevronDown,
  CircleCheck,
  CircleX,
  ClipboardCopy,
  Copy,
  Crosshair,
  Download,
  ExternalLink,
  Filter,
  Maximize2,
  Minimize2,
  RefreshCw,
  ScrollText,
  Search,
  Terminal,
  Trash2,
  WifiOff,
} from 'lucide-react'
import { create } from 'zustand'
import { cn } from '../../lib/utils'
import { useUIStore, type BottomTab } from '../../stores/uiStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { useTreeStore } from '../../stores/treeStore'
import { useSearchStore } from '../../stores/searchStore'
import { SearchResults, SearchResultsActions } from '../search/SearchResults'
import { ResultsStrip } from '../search/ResultsStrip'
import { openResultsSnapshot } from '../search/resultsSnapshots'
import * as wails from '../../lib/wails'
import type { LogEntry, AuditEntry } from '../../lib/wails'
import { GetAuditLogRange, SaveExportFile, savedMessage } from '../../lib/wails-export'
import { toCSV } from '../../lib/bulk'
import { Tabs, TabPanel, type TabItem } from '../ui/Tabs'
import { IconButton, Button } from '../ui/Button'
import { DataTable, type DataTableColumn } from '../ui/DataTable'
import { Input, SearchInput } from '../ui/Input'
import { SegmentedControl } from '../ui/SegmentedControl'
import { EmptyState } from '../ui/EmptyState'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { TruncatedText } from '../ui/TruncatedText'
import { Spinner } from '../ui/Spinner'
import { Tooltip } from '../ui/Tooltip'
import { ContextMenu, MenuHeader, MenuItem, MenuSeparator } from '../ui/Menu'
import { toast } from '../ui/Toast'
import { firstRDN, normalizeDN, parseRDN } from '../../lib/dn'
import { auditNewDN, forwardDN, historyDNs, logEntryDN, logResult, opTone, profileSlot, withProfileSlot } from './opTone'
import { entryForProfile, fileNamePart, mergeLogEntries } from './opLog'
import { clearLastOp, onWailsEvent, useShellState } from './shellState'

/** The results strip moved to components/search/ResultsStrip (it also heads results tabs). */
export { ResultsStrip }

const TABS_ID = 'bottom'

/** Operation name -> text-op-* token (operations and audit log). */
export { opTone }

function ResultCell({ result }: { result: 'ok' | 'error' | 'cancelled' }) {
  if (result === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-destructive">
        <CircleX size={12} strokeWidth={1.75} aria-hidden />
        Error
      </span>
    )
  }
  if (result === 'cancelled') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Ban size={12} strokeWidth={1.75} aria-hidden />
        Cancelled
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-success">
      <CircleCheck size={12} strokeWidth={1.75} aria-hidden />
      OK
    </span>
  )
}

function copy(text: string, what: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success(`${what} copied`))
    .catch((err) => toast.error(`Could not copy the ${what.toLowerCase()}`, err instanceof Error ? err.message : String(err)))
}

/** Opens a DN of the active connection (a pinned tab). */
function openDN(dn: string) {
  const id = useConnectionStore.getState().activeProfileId
  if (id && dn) useEditorStore.getState().openEntry(id, dn)
}

/** Show in Tree for a DN of the active connection. */
function showInTree(dn: string) {
  const id = useConnectionStore.getState().activeProfileId
  if (!id || !dn) return
  const ui = useUIStore.getState()
  ui.setActivity('explorer')
  if (!ui.sidebarVisible) ui.toggleSidebar()
  void useTreeStore.getState().locateInTree(id, dn)
}

/** Saves a log as CSV through the export save dialog. */
async function saveLogCSV(name: string, header: string[], rows: (string | number)[][]) {
  try {
    const path = await SaveExportFile(name, 'csv', toCSV(header, rows))
    if (path && path !== 'download') toast.success(savedMessage(rows.length, path))
    return path
  } catch (err) {
    toast.error('Export failed', err instanceof Error ? err.message : String(err))
    return ''
  }
}

// --- Results strip binding -----------------------------------------------------

/**
 * The run the results strip describes: the latest shell SearchRun that
 * produced results. A failed or cancelled search also updates lastSearch
 * (its timing), but the strip keeps the previous run, so filter and base
 * always belong to the rows below it.
 */
// --- Audit filter requests ("Show History", TRIAGE §0.1) ------------------------

/** A request to show the audit log filtered to a DN; the AuditLog applies it when mounted. */
const useAuditRequest = create<{ request: { profileId: string; dn: string; seq: number } | null }>(() => ({ request: null }))
let auditRequestSeq = 0
if (typeof window !== 'undefined') {
  window.addEventListener('ldapilot:audit-filter', (e) => {
    const detail = (e as CustomEvent).detail as { profileId?: string; dn?: string } | undefined
    if (!detail?.dn) return
    const cs = useConnectionStore.getState()
    const profileId = detail.profileId || cs.activeProfileId
    if (!profileId) return
    // The audit view shows the active connection's log.
    if (profileId !== cs.activeProfileId && cs.connectionStatuses[profileId] === true) cs.setActiveProfile(profileId)
    useAuditRequest.setState({ request: { profileId, dn: detail.dn, seq: ++auditRequestSeq } })
    useUIStore.getState().showBottomTab('audit')
  })
}

function useActiveConnection() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId)
  const connected = useConnectionStore((s) => (s.activeProfileId ? s.connectionStatuses[s.activeProfileId] === true : false))
  return { activeProfileId, connected }
}

// --- Panel ---------------------------------------------------------------------

export function BottomPanel() {
  const activeTab = useUIStore((s) => s.bottomPanelTab)
  const showBottomTab = useUIStore((s) => s.showBottomTab)
  const toggleBottomPanel = useUIStore((s) => s.toggleBottomPanel)
  const panelVisible = useUIStore((s) => s.bottomPanelVisible)
  const maximized = useShellState((s) => s.bottomMaximized)
  const toggleMaximized = useShellState((s) => s.toggleBottomMaximized)
  const results = useSearchStore((s) => s.results)
  const [visited, setVisited] = useState<BottomTab[]>(() => [activeTab])
  if (!visited.includes(activeTab)) setVisited([...visited, activeTab])

  const items: TabItem[] = [
    { id: 'search-results', label: 'Results', icon: Search, count: results ? results.totalCount || results.entries?.length || 0 : undefined },
    { id: 'output', label: 'Operations', icon: Terminal },
    { id: 'audit', label: 'Audit Log', icon: ScrollText },
  ]

  return (
    <div className="h-full flex flex-col bg-background border-t border-border min-w-0" role="region" aria-label="Panel">
      <Tabs
        variant="panel"
        idPrefix={TABS_ID}
        aria-label="Panel views"
        items={items}
        value={activeTab}
        onValueChange={(id) => showBottomTab(id as BottomTab)}
        className="shrink-0 border-b border-border"
        end={
          <>
            {activeTab === 'search-results' && (
              <>
                {/* Selection + bulk, Show in Tree, attribute columns, export (SPEC 7.6 panel actions). */}
                <SearchResultsActions />
                {/* A snapshot tab of these rows next to the panel (DEF-16): the next search changes only the panel. */}
                <IconButton label="Open Results as Tab" icon={ExternalLink} size="md" disabled={!results} onClick={() => void openResultsSnapshot()} />
              </>
            )}
            <IconButton label={maximized ? 'Restore Panel' : 'Maximize Panel'} icon={maximized ? Minimize2 : Maximize2} size="md" pressed={maximized} onClick={toggleMaximized} />
            <IconButton label="Hide Panel" icon={ChevronDown} size="md" shortcut="Mod+J" onClick={toggleBottomPanel} />
          </>
        }
      />
      {visited.map((t) => (
        <TabPanel key={t} idPrefix={TABS_ID} value={t} selected={activeTab} className="flex-1 min-h-0 overflow-hidden">
          <ErrorBoundary variant="region" name={t === 'search-results' ? 'Results' : t === 'output' ? 'Operations' : 'Audit Log'}>
            {t === 'search-results' ? <ResultsView /> : t === 'output' ? <OutputLog /> : <AuditLog active={panelVisible && activeTab === 'audit'} />}
          </ErrorBoundary>
        </TabPanel>
      ))}
    </div>
  )
}

// --- Results -------------------------------------------------------------------

function ResultsView() {
  const results = useSearchStore((s) => s.results)
  const loading = useSearchStore((s) => s.loading)
  const failure = useSearchStore((s) => s.lastFailure)
  return (
    <div className="h-full flex flex-col min-w-0">
      {(results || loading || failure) && <ResultsStrip />}
      <div className="flex-1 min-h-0">
        <SearchResults toolbar="none" />
      </div>
    </div>
  )
}

// --- Shared log toolbar --------------------------------------------------------

type ErrorFilter = 'all' | 'errors'

function LogToolbar({
  filter,
  onFilter,
  errorFilter,
  onErrorFilter,
  total,
  errors,
  shown,
  placeholder,
  filterRef,
  children,
}: {
  filterRef?: RefObject<HTMLInputElement | null>
  filter: string
  onFilter: (v: string) => void
  errorFilter: ErrorFilter
  onErrorFilter: (v: ErrorFilter) => void
  total: number
  errors: number
  shown: number
  placeholder: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-border shrink-0 min-w-0">
      <SearchInput ref={filterRef} value={filter} onValueChange={onFilter} placeholder={placeholder} aria-label={placeholder} size="sm" className="min-w-0" wrapperClassName="flex-1 min-w-[120px] max-w-[360px]" />
      <SegmentedControl<ErrorFilter>
        aria-label="Show"
        size="sm"
        value={errorFilter}
        onValueChange={onErrorFilter}
        options={[
          { value: 'all', label: 'All', count: total },
          { value: 'errors', label: 'Errors', count: errors },
        ]}
      />
      <span className="ml-auto text-xs text-muted-foreground tabular-nums whitespace-nowrap">
        {shown === total ? `${total} ${total === 1 ? 'entry' : 'entries'}` : `${shown} of ${total}`}
      </span>
      {children}
    </div>
  )
}

// --- Operations log ------------------------------------------------------------

type LogRow = LogEntry & { seq: number }

const opsColumns: DataTableColumn<LogRow>[] = [
  { id: 'timestamp', header: 'Time', width: 104, mono: true, sortable: true, value: (r) => r.timestamp },
  { id: 'result', header: 'Result', width: 88, sortable: true, value: (r) => logResult(r), cell: (r) => <ResultCell result={logResult(r)} /> },
  {
    id: 'operation',
    header: 'Operation',
    width: 112,
    sortable: true,
    value: (r) => r.operation,
    cell: (r) => <span className={cn('font-semibold', opTone(r.operation))}>{r.operation}</span>,
  },
  {
    id: 'details',
    header: 'Details',
    minWidth: 200,
    value: (r) => r.details,
    cell: (r) => (
      <span className="flex min-w-0 gap-2">
        <TruncatedText text={r.details} className="min-w-0 text-foreground" />
        {r.error && <TruncatedText text={r.error} className="min-w-0 text-destructive" />}
      </span>
    ),
  },
  { id: 'duration', header: 'Duration', width: 88, align: 'right', sortable: true, value: (r) => parseFloat(r.duration) || 0, cell: (r) => <span className="tabular-nums">{r.duration}</span> },
]

function logLine(r: LogEntry): string {
  return [r.timestamp, logResult(r).toUpperCase(), r.operation, r.details, r.error ?? '', r.duration].filter(Boolean).join('  ')
}

/**
 * State of a log view kept per connection (FIN-W-01): switching the
 * connection shows that connection's filter, never the one typed or set by
 * Show History for another connection.
 */
function usePerProfileState<T>(profileId: string | null, initial: T): [T, (value: T) => void] {
  const [slots, setSlots] = useState<Record<string, T>>({})
  const value = profileSlot(slots, profileId, initial)
  const set = (v: T) => setSlots((m) => withProfileSlot(m, profileId, v))
  return [value, set]
}

function OutputLog() {
  // The active profile's log; with none active, the profile of the last failed connect or
  // the last used one, so failed connects and re-dials stay visible (RW1-C-02).
  const activeProfileId = useConnectionStore((s) => {
    if (s.activeProfileId) return s.activeProfileId
    const lastUsed = useShellState.getState().lastUsedProfileId
    return [s.errorProfileId, lastUsed].find((id) => !!id && s.profiles.some((p) => p.id === id)) ?? null
  })
  const connected = useConnectionStore((s) => (activeProfileId ? s.connectionStatuses[activeProfileId] === true : false))
  const connecting = useShellState((s) => !!activeProfileId && s.connectingId === activeProfileId)
  const profileName = useConnectionStore((s) => s.profiles.find((p) => p.id === activeProfileId)?.name ?? 'connection')
  const [logs, setLogs] = useState<LogRow[]>([])
  const [filter, setFilter] = usePerProfileState(activeProfileId, '')
  const [errorFilter, setErrorFilter] = useState<ErrorFilter>('all')
  const [confirmClear, setConfirmClear] = useState(false)
  const [menu, setMenu] = useState<{ point: { clientX: number; clientY: number }; row: LogRow } | null>(null)
  // Clear disables its own button (empty log): focus goes to the filter instead.
  const filterRef = useRef<HTMLInputElement>(null)

  // The profile's log also while it is not connected (RW1-C-02: failed connects and
  // re-dials are history there); the shared stream is filtered on the entry's profile
  // and merged by sequence number, so nothing is listed twice (RW1-C-03).
  useEffect(() => {
    if (!activeProfileId) {
      setLogs([])
      return
    }
    const id = activeProfileId
    let alive = true
    let local = 0
    setLogs([])
    // An entry of an older backend without seq: after everything else, in arrival order.
    const toRow = (e: LogEntry): LogRow => (typeof e.seq === 'number' && e.seq > 0 ? (e as LogRow) : { ...e, seq: 1e12 + local++ })
    wails
      .GetLogs(id)
      .then((l) => {
        if (alive) setLogs((prev) => mergeLogEntries((l || []).map(toRow), prev))
      })
      .catch(() => {})
    wails.StartLogStream(id).catch(() => {})
    const off = onWailsEvent('operation:log', (...data: unknown[]) => {
      const entry = data[0] as LogEntry | undefined
      if (entry && typeof entry.operation === 'string' && entryForProfile(entry, id)) setLogs((prev) => mergeLogEntries(prev, [toRow(entry)]))
    })
    return () => {
      alive = false
      off()
    }
  }, [activeProfileId, connected])

  const errorCount = useMemo(() => logs.filter((l) => l.error).length, [logs])
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return logs
      .filter((l) => (errorFilter === 'errors' ? !!l.error : true))
      .filter((l) => !f || l.operation.toLowerCase().includes(f) || l.details.toLowerCase().includes(f) || (l.error ?? '').toLowerCase().includes(f))
      .slice()
      .reverse() // newest first
  }, [logs, filter, errorFilter])

  if (!activeProfileId) {
    return <EmptyState icon={Terminal} title="No connection" hint="Connect to a server to see its LDAP operations." />
  }

  // ISO date + time per row (RW1-R-09), a file-system friendly default name.
  const exportCSV = () =>
    void saveLogCSV(
      `operations-${fileNamePart(profileName) || 'connection'}`,
      ['time', 'result', 'operation', 'details', 'error', 'duration'],
      rows.map((r) => [r.at || r.timestamp, logResult(r), r.operation, r.details, r.error ?? '', r.duration]),
    )

  const menuDN = menu ? logEntryDN(menu.row.details) : ''

  return (
    <div className="h-full flex flex-col min-w-0">
      <LogToolbar
        filter={filter}
        onFilter={setFilter}
        errorFilter={errorFilter}
        onErrorFilter={setErrorFilter}
        total={logs.length}
        errors={errorCount}
        shown={rows.length}
        placeholder="Filter operations"
        filterRef={filterRef}
      >
        <IconButton label="Export Operations as CSV" icon={Download} size="md" disabled={!rows.length} onClick={exportCSV} />
        <IconButton label="Clear operations log" icon={Trash2} size="md" disabled={!logs.length} onClick={() => setConfirmClear(true)} />
      </LogToolbar>
      {!connected && (
        <div role="status" className="flex items-center gap-1.5 px-2 py-1 border-b border-border text-xs text-muted-foreground shrink-0 min-w-0">
          <WifiOff size={12} className="shrink-0" aria-hidden />
          <span className="truncate">
            {connecting ? `Connecting to ${profileName}…` : `${profileName} is not connected`} — operations logged so far, incl. failed connects
          </span>
        </div>
      )}
      <DataTable<LogRow>
        aria-label="Operations log, newest first"
        columns={opsColumns}
        rows={rows}
        rowKey={(r) => String(r.seq)}
        selection="single"
        virtualized
        persistKey="ops-log"
        className="flex-1"
        getRowDn={(r) => logEntryDN(r.details)}
        onOpen={(r) => openDN(logEntryDN(r.details))}
        onContextMenu={(point, sel) => sel[0] && setMenu({ point, row: sel[0] })}
        empty={<EmptyState variant="inline" icon={Terminal} title={logs.length ? 'No matching operations' : connected ? 'Waiting for operations…' : 'No operations logged for this connection yet'} />}
      />
      <ContextMenu point={menu?.point ?? null} onClose={() => setMenu(null)} label="Operation actions">
        {() =>
          menu && (
            <>
              {menuDN && <MenuHeader mono>{menuDN}</MenuHeader>}
              <MenuItem icon={ExternalLink} label="Open Entry" default disabled={!menuDN} onSelect={() => openDN(menuDN)} />
              <MenuItem icon={Crosshair} label="Show in Tree" disabled={!menuDN} onSelect={() => showInTree(menuDN)} />
              <MenuSeparator />
              <MenuItem icon={ClipboardCopy} label="Copy Line" onSelect={() => copy(logLine(menu.row), 'Line')} />
              <MenuItem icon={Copy} label="Copy DN" disabled={!menuDN} onSelect={() => copy(menuDN, 'DN')} />
              <MenuItem icon={Filter} label="Filter by This DN" disabled={!menuDN} onSelect={() => setFilter(menuDN)} />
            </>
          )
        }
      </ContextMenu>
      <ConfirmDialog
        open={confirmClear}
        tone="danger"
        title="Clear the operations log?"
        message="All logged operations of this connection are removed. The audit log is not affected."
        confirmLabel="Clear Log"
        returnFocus={filterRef}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false)
          if (activeProfileId) wails.ClearLogs(activeProfileId).catch(() => {})
          setLogs([])
          // The status bar's "last operation" was one of the cleared ones.
          if (activeProfileId) clearLastOp(activeProfileId)
        }}
      />
    </div>
  )
}

// --- Audit log -----------------------------------------------------------------

interface AuditRow extends AuditEntry {
  seq: number
}

/** Rows loaded at most (the date range narrows older ones). */
const AUDIT_LIMIT = 2000

function inRange(ts: string, from: string, to: string): boolean {
  return (!from || ts >= from) && (!to || ts <= to || ts.startsWith(to))
}

/**
 * The audit log stays mounted (keep-alive tabs, hidden panel): it reloads
 * every time it is shown (`active`) and adds new entries live (audit:entry)
 * while it is visible.
 */
function AuditLog({ active }: { active: boolean }) {
  const { activeProfileId, connected } = useActiveConnection()
  const profileName = useConnectionStore((s) => s.profiles.find((p) => p.id === s.activeProfileId)?.name ?? '')
  const openEntry = useEditorStore((s) => s.openEntry)
  const request = useAuditRequest((s) => s.request)
  const [entries, setEntries] = useState<AuditRow[]>([])
  const [filter, setFilter] = usePerProfileState(activeProfileId, '')
  const [historyDN, setHistoryDN] = usePerProfileState<string | null>(activeProfileId, null)
  const [errorFilter, setErrorFilter] = useState<ErrorFilter>('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [loading, setLoading] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const filterRef = useRef<HTMLInputElement>(null)
  const seqRef = useRef(0)

  const loadEntries = async () => {
    if (!activeProfileId) return
    setLoading(true)
    try {
      const result = await GetAuditLogRange(activeProfileId, from, to, AUDIT_LIMIT)
      setEntries(result.map((e) => ({ ...e, seq: seqRef.current++ })))
    } catch {
      setEntries([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!activeProfileId || !connected) {
      setEntries([])
      return
    }
    if (!active) return
    void loadEntries()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfileId, connected, active, from, to])

  // Live: entries written while the log is shown (this connection, within the range).
  useEffect(() => {
    if (!active || !activeProfileId || !connected) return
    return onWailsEvent('audit:entry', (...data: unknown[]) => {
      const [profileId, entry] = data as [string, AuditEntry | undefined]
      if (profileId !== activeProfileId || !entry || !inRange(entry.timestamp, from, to)) return
      // A clear (possibly from another view) leaves only its own record.
      setEntries((prev) => [{ ...entry, seq: seqRef.current++ }, ...(entry.operation === 'AUDIT_CLEARED' ? [] : prev)])
    })
  }, [active, activeProfileId, connected, from, to])

  // "Show History" of an entry: filter to its DN.
  useEffect(() => {
    if (!request || request.profileId !== activeProfileId) return
    setFilter(request.dn)
    setHistoryDN(request.dn)
    setErrorFilter('all')
    useAuditRequest.setState({ request: null })
  }, [request, activeProfileId])
  // While the filter is the Show History DN: also the rows logged under the entry's earlier names.
  const historyChain = useMemo(
    () => (historyDN && filter === historyDN ? historyDNs(entries, historyDN) : null),
    [historyDN, filter, entries],
  )

  const columns = useMemo<DataTableColumn<AuditRow>[]>(
    () => [
      { id: 'timestamp', header: 'Time', width: 176, minWidth: 160, mono: true, sortable: true, value: (r) => r.timestamp },
      { id: 'result', header: 'Result', width: 72, sortable: true, value: (r) => (r.error ? 'error' : 'ok'), cell: (r) => <ResultCell result={r.error ? 'error' : 'ok'} /> },
      {
        id: 'operation',
        header: 'Operation',
        width: 112,
        sortable: true,
        value: (r) => r.operation,
        cell: (r) => <span className={cn('font-semibold', opTone(r.operation))}>{r.operation}</span>,
      },
      { id: 'dn', header: 'DN', minWidth: 200, sortable: true, renderer: 'dn', value: (r) => r.dn },
      {
        id: 'details',
        header: 'Details',
        minWidth: 200,
        value: (r) => r.details ?? '',
        cell: (r) => {
          const newDN = auditNewDN(r)
          return (
            <span className="flex min-w-0 gap-2 items-center">
              {newDN && (
                <button type="button"
                  onClick={() => openDN(newDN)}
                  className="shrink-0 inline-flex items-center gap-0.5 text-primary hover:underline max-w-[45%] min-w-0 rounded-xs focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus"
                  title={`Open the entry under its new DN: ${newDN}`}
                >
                  <ArrowRight size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
                  <span className="truncate font-mono">{parseRDN(firstRDN(newDN)).value || newDN}</span>
                </button>
              )}
              <TruncatedText text={r.details ?? ''} className="min-w-0 text-muted-foreground" />
              {r.error && <TruncatedText text={r.error} className="min-w-0 text-destructive" />}
            </span>
          )
        },
      },
      {
        // Bind DN: show its RDN value (escape-aware: "CN=Schmidt\, Anna,..." -> "Schmidt, Anna"), full DN on hover.
        id: 'user',
        header: 'User',
        width: 140,
        sortable: true,
        value: (r) => r.user ?? '',
        cell: (r) =>
          r.user ? (
            <Tooltip content={<span className="font-mono">{r.user}</span>} placement="bottom-start">
              <span className="block min-w-0 truncate">{parseRDN(firstRDN(r.user)).value || r.user}</span>
            </Tooltip>
          ) : null,
      },
    ],
    [],
  )

  const errorCount = useMemo(() => entries.filter((e) => e.error).length, [entries])
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const chain = historyChain && historyChain.size > 1 ? [...historyChain] : null
    return entries
      .filter((e) => (errorFilter === 'errors' ? !!e.error : true))
      .filter(
        (e) =>
          !f ||
          (chain && ((n) => chain.some((d) => n === d || n.endsWith(`,${d}`)))(normalizeDN(e.dn))) ||
          e.operation.toLowerCase().includes(f) ||
          e.dn.toLowerCase().includes(f) ||
          (e.details ?? '').toLowerCase().includes(f) ||
          (e.error ?? '').toLowerCase().includes(f),
      )
  }, [entries, filter, errorFilter, historyChain])

  if (!connected) {
    return <EmptyState icon={ScrollText} title="No connection" hint="Connect to a server to see its audit log." />
  }

  /** CSV of the whole range (not only the loaded rows). Returns the saved path ('' when cancelled). */
  async function exportAudit(): Promise<string> {
    if (!activeProfileId) return ''
    let all: AuditEntry[]
    try {
      all = await GetAuditLogRange(activeProfileId, from, to, 0)
    } catch (err) {
      toast.error('Export failed', err instanceof Error ? err.message : String(err))
      return ''
    }
    return saveLogCSV(
      `audit ${profileName || 'connection'}`,
      ['time', 'result', 'operation', 'dn', 'details', 'error', 'user'],
      all.map((e) => [e.timestamp, e.error ? 'error' : 'ok', e.operation, e.dn, e.details ?? '', e.error ?? '', e.user ?? '']),
    )
  }

  async function clearLog(exportFirst: boolean) {
    if (!activeProfileId) return
    if (exportFirst) {
      const path = await exportAudit()
      // Cancelled or failed export: nothing is cleared.
      if (!path) return
    }
    setClearing(true)
    try {
      await wails.ClearAuditLog(activeProfileId)
      setConfirmClear(false)
      toast.success('Audit log cleared (an AUDIT_CLEARED entry records who and when)')
      await loadEntries()
    } catch (err) {
      toast.error('Could not clear the audit log', err instanceof Error ? err.message : String(err))
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="h-full flex flex-col min-w-0">
      <LogToolbar
        filter={filter}
        onFilter={setFilter}
        errorFilter={errorFilter}
        onErrorFilter={setErrorFilter}
        total={entries.length}
        errors={errorCount}
        shown={rows.length}
        placeholder="Filter audit entries"
        filterRef={filterRef}
      >
        {historyChain && historyChain.size > 1 && (
          <span className="text-xs text-muted-foreground whitespace-nowrap" title={[...historyChain].join('\n')}>
            incl. {historyChain.size - 1} earlier name{historyChain.size > 2 ? 's' : ''}
          </span>
        )}
        <span className="inline-flex items-center gap-1 shrink-0">
          <Input type="date" size="sm" aria-label="From date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="w-[128px]" />
          <span className="text-xs text-muted-foreground">–</span>
          <Input type="date" size="sm" aria-label="To date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="w-[128px]" />
          {(from || to) && (
            <Button size="sm" variant="ghost" onClick={() => { setFrom(''); setTo('') }}>
              All dates
            </Button>
          )}
        </span>
        <IconButton label="Refresh audit log" icon={loading ? <Spinner size="sm" decorative /> : RefreshCw} size="md" onClick={() => void loadEntries()} />
        <IconButton label="Export Audit Log as CSV" icon={Download} size="md" disabled={!entries.length} onClick={() => void exportAudit()} />
        <IconButton label="Clear audit log" icon={Trash2} size="md" disabled={!entries.length} onClick={() => setConfirmClear(true)} />
      </LogToolbar>
      <DataTable<AuditRow>
        aria-label="Audit log"
        columns={columns}
        rows={rows}
        rowKey={(r) => String(r.seq)}
        virtualized
        persistKey="audit-log"
        className="flex-1"
        loading={loading && !entries.length}
        getRowDn={(r) => r.dn}
        // An old DN opens the entry under its current name (RW1-R-04).
        onOpenDn={(dn) => activeProfileId && openEntry(activeProfileId, forwardDN(entries, dn))}
        onOpen={(r) => activeProfileId && r.dn && openEntry(activeProfileId, forwardDN(entries, auditNewDN(r) || r.dn, r.timestamp))}
        empty={
          <EmptyState
            variant="inline"
            icon={ScrollText}
            title={entries.length ? 'No matching entries' : from || to ? 'No audit entries in this period' : 'No audit entries yet'}
            hint={entries.length || from || to ? undefined : 'Changes made through LDAPilot are logged here.'}
          />
        }
      />
      <ConfirmDialog
        open={confirmClear}
        tone="danger"
        title="Clear the audit log?"
        message={
          <span className="space-y-2 block">
            <span className="block">
              The persistent audit log of “{profileName}” is deleted from disk; only an AUDIT_CLEARED entry (who, when) remains. This cannot be undone.
            </span>
            <Button size="sm" leftIcon={Download} disabled={clearing} onClick={() => void clearLog(true)}>
              Export, then Clear…
            </Button>
          </span>
        }
        requireTyping={profileName || undefined}
        confirmLabel="Clear Audit Log"
        busy={clearing}
        returnFocus={filterRef}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void clearLog(false)}
      />
    </div>
  )
}
