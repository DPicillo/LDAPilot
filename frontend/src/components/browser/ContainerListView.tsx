/**
 * ContainerListView: the children of a container as a table (SPEC 10.2,
 * UX-10/16): virtualized DataTable (sticky header, sortable, column chooser
 * with persisted widths/order), Name / Type / Status columns plus attribute
 * columns, a quick filter, multi-selection and the registry context menu
 * (same verbs as the tree).
 *
 * Shown by the main panel for the container selected in the tree (no tab
 * open), and the entry editor's Contents sub-tab of a container:
 * `<ContainerListView profileId containerDN embedded />`.
 *
 * Selection is a command source ('list', commands/selectionContext): the
 * Entry menu, the palette and Del / F2 / Shift+Alt+C / Ctrl+D act on the
 * selected rows; with none selected, Ctrl+N / New ▸ and F5 act on the shown
 * container. A plain click opens the preview (View ▸ Single-Click Opens
 * Preview) in the standalone list; inside an entry tab (Contents sub-tab) a
 * click only selects, as in ADUC, so browsing an OU never leaves it
 * (RW2-E-03). Enter opens the preview, Ctrl+Enter / double-click pin.
 * Embedded in a tab (`viewKey`), filter, sort, selection and scroll position
 * are kept per tab and come back after a tab switch.
 *
 * Children come from the tree store (loaded when missing); the attribute
 * columns from ONE one-level search (not one read per entry), repeated when
 * the children are reloaded. Sorted like the tree: by type, then name by
 * default; the tree's Name and Server order modes sort by name.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react'
import { Columns3, FolderOpen, RefreshCw } from 'lucide-react'
import { useTreeStore, selectChildNodes, selectNodeLoading } from '../../stores/treeStore'
import { useEditorStore } from '../../stores/editorStore'
import { getTabView, setTabView, useTabView } from '../../stores/tabViewState'
import { useUIStore } from '../../stores/uiStore'
import { accountStatusVersion, cachedAccountStatusKinds, forgetAccountStatusesUnder, subscribeAccountStatus } from '../../stores/accountStatusCache'
import type { LDAPEntry, TreeNode } from '../../types/ldap'
import { ScopeOne } from '../../types/ldap'
import * as wails from '../../lib/wails'
import { firstRDN, normalizeDN, parseRDN, getParentDN } from '../../lib/dn'
import { DataTable, type DataTableColumn, type SortState } from '../ui/DataTable'
import { SearchInput, Input } from '../ui/Input'
import { Button, IconButton } from '../ui/Button'
import { Popover } from '../ui/Popover'
import { Spinner } from '../ui/Spinner'
import { EmptyState } from '../ui/EmptyState'
import { TruncatedText } from '../ui/TruncatedText'
import { OBJECT_KIND_LABEL, isContainerKind, nodeKind } from '../ui/objectKind'
import { ACCOUNT_STATUS_ATTRIBUTES, deriveRowStatus, mergeRowStatus, primaryStatus, type AccountStatus, type AccountStatusKind } from '../ui/accountStatus'
import { getCommandContext, runCommand, selectionItem as normalizeItem, type SelectionItem } from '../ui/commands'
import { CommandMenuItems, ContextMenu, contextMenuPoint } from '../ui/Menu'
import { TreeNodeIcon } from '../tree/TreeNodeItem'
import { TreeContextMenu, type EntryMenuState } from '../tree/TreeContextMenu'
import { nameSortValue, nodeLabel, typeSortValue, useTreePrefs, type TreeSortMode } from '../tree/treePrefs'
import { registerListView } from '../commands/selectionContext'
import { onAccountChanged } from '../commands/events'
import { columnInputResult, hiddenAfterShow } from './listColumns'
import { peekEditorFocus, requestEditorFocus, takeEditorFocus } from '../editor/editorFocus'

/** Attribute columns offered in the column chooser (shown: description). */
const ATTRIBUTE_COLUMNS = [
  'description', 'objectClass', 'cn', 'sn', 'givenName', 'displayName',
  'mail', 'telephoneNumber', 'sAMAccountName', 'userPrincipalName',
  'title', 'department', 'company', 'ou', 'uid', 'whenCreated', 'whenChanged',
]
const DATE_COLUMNS = new Set(['whencreated', 'whenchanged'])
const EXTRA_KEY = 'ldapilot-list-extra-columns'
const PERSIST_KEY = 'container-list'

/** Commands of the list's background menu (right-click on empty space): verbs of the shown container. */
const BACKGROUND_COMMANDS = ['create.new', 'entry.refresh', 'entry.searchHere', 'entry.importLdif', 'entry.exportSubtree', 'entry.statistics', 'entry.history', 'entry.copyDn']

interface Row {
  node: TreeNode
  entry?: LDAPEntry
  status: (AccountStatus | AccountStatusKind)[]
}

function loadExtra(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(EXTRA_KEY) || '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
function saveExtra(cols: string[]) {
  try {
    localStorage.setItem(EXTRA_KEY, JSON.stringify(cols))
  } catch {
    /* blocked storage */
  }
}

/** The DataTable's persisted hidden columns (its own storage; the table reads it when it mounts). */
function readHidden(): string[] | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(`ldapilot-table-${PERSIST_KEY}`) || '{}') as { hidden?: unknown }
    return Array.isArray(v.hidden) ? v.hidden.filter((x): x is string => typeof x === 'string') : undefined
  } catch {
    return undefined
  }
}
function writeHidden(hidden: string[]) {
  try {
    const k = `ldapilot-table-${PERSIST_KEY}`
    const v = JSON.parse(localStorage.getItem(k) || '{}') as Record<string, unknown>
    localStorage.setItem(k, JSON.stringify({ ...v, hidden }))
  } catch {
    /* blocked storage */
  }
}

function attrValues(entry: LDAPEntry | undefined, name: string): string[] {
  const a = entry?.attributes?.find((x) => x.name.toLowerCase() === name.toLowerCase())
  if (!a || a.binary) return []
  return name.toLowerCase() === 'objectclass' ? a.values.filter((v) => v.toLowerCase() !== 'top') : a.values
}

/** The tree's sort mode: Type (the default) sorts by type, then name; Name and "Server order" by name. */
const SORT_FOR_MODE: Record<TreeSortMode, SortState> = {
  default: { id: 'name', dir: 'asc' },
  alpha: { id: 'name', dir: 'asc' },
  type: { id: 'type', dir: 'asc' },
}

interface ContainerListViewProps {
  profileId: string
  containerDN: string
  /** Inside the entry editor (Contents sub-tab): no own title header. */
  embedded?: boolean
  /** Editor tab id: filter, sort, selection and scroll position are kept per tab (stores/tabViewState). */
  viewKey?: string
}

export function ContainerListView({ profileId, containerDN, embedded, viewKey }: ContainerListViewProps) {
  // The profile's own tree view (TREE-03): a list of another connection's tab reads its parked view.
  const children = useTreeStore(selectChildNodes(profileId, containerDN))
  const loading = useTreeStore(selectNodeLoading(profileId, containerDN))
  const openEntry = useEditorStore((s) => s.openEntry)
  const showRdnType = useTreePrefs((s) => s.showRdnType)
  const treeSort = useTreePrefs((s) => s.sortMode)
  // Cached server states (status chips) re-render the rows when they change.
  const statusVersion = useSyncExternalStore(subscribeAccountStatus, accountStatusVersion, accountStatusVersion)

  const [details, setDetails] = useState<Map<string, LDAPEntry>>(() => new Map())
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsSeq, setDetailsSeq] = useState(0)
  // Kept per editor tab: a tab switch remounts the list (RW2-E-03).
  const [filter, setFilter] = useTabView(viewKey, 'list.filter', '')
  const [selected, setSelected] = useTabView<Set<string>>(viewKey, 'list.selected', () => new Set())
  const [sort, setSort] = useTabView<SortState | null>(viewKey, 'list.sort', SORT_FOR_MODE[treeSort])
  const initialScrollTop = useRef(getTabView<number>(viewKey, 'list.scroll') ?? 0).current
  const [menu, setMenu] = useState<EntryMenuState | null>(null)
  const [bgMenu, setBgMenu] = useState<EntryMenuState | null>(null)
  const [extraCols, setExtraCols] = useState<string[]>(loadExtra)
  const [addOpen, setAddOpen] = useState(false)
  const [newCol, setNewCol] = useState('')
  const [colNote, setColNote] = useState<string | null>(null)
  const [tableKey, setTableKey] = useState(0)
  const addBtn = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const tableWrap = useRef<HTMLDivElement>(null)

  // A click on this container's tab: the row kept selected takes focus, so ↓ / Enter keep
  // browsing where the user left (RW3-E-02). Runs before the editor's own hand-over. The
  // request is kept in a ref: StrictMode runs the effect twice (the first run's frame is
  // cancelled, the second one finds the hand-over already taken).
  const rowFocus = useRef<string | null>(null)
  useEffect(() => {
    if (rowFocus.current === null && embedded && peekEditorFocus() === 'list' && selected.size) {
      takeEditorFocus()
      rowFocus.current = [...selected][0]
    }
    const key = rowFocus.current
    if (!key) return
    let frames = 0
    let raf = 0
    const tick = () => {
      const row = tableWrap.current?.querySelector<HTMLElement>(`tr[data-key="${CSS.escape(key)}"]`)
      if (row) {
        rowFocus.current = ''
        row.focus({ preventScroll: true })
        return
      }
      // The listing may still be loading: up to ~2 s.
      if (++frames < 120) raf = requestAnimationFrame(tick)
      else rowFocus.current = ''
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The tree's sort mode is the default order (consistent sort, SPEC 10.2); a change
  // of it applies, a remount keeps the tab's own order.
  const lastTreeSort = useRef(treeSort)
  useEffect(() => {
    if (lastTreeSort.current === treeSort) return
    lastTreeSort.current = treeSort
    setSort(SORT_FOR_MODE[treeSort])
  }, [treeSort, setSort])

  // Children: from the tree store, loaded here when the tree has not read them.
  useEffect(() => {
    if (children === undefined && !selectNodeLoading(profileId, containerDN)(useTreeStore.getState())) {
      useTreeStore.getState().loadChildren(profileId, containerDN).catch(() => {})
    }
  }, [children, profileId, containerDN])

  // Attribute columns: one one-level search for all of them, again whenever the children are reloaded (F5, refresh).
  const childCount = children?.length ?? 0
  // Plus the account status attributes: the Status column shows the same states as the search results.
  const columnAttrs = useMemo(() => [...new Set(['objectClass', ...ATTRIBUTE_COLUMNS, ...ACCOUNT_STATUS_ATTRIBUTES, ...extraCols])], [extraCols])
  useEffect(() => {
    if (!childCount) {
      setDetails((d) => (d.size ? new Map() : d))
      return
    }
    let cancelled = false
    setDetailsLoading(true)
    wails
      .SearchLDAP(profileId, { baseDN: containerDN, filter: '(objectClass=*)', scope: ScopeOne, attributes: columnAttrs, sizeLimit: 0, timeLimit: 30 })
      .then((res) => {
        if (cancelled) return
        const m = new Map<string, LDAPEntry>()
        for (const e of res?.entries ?? []) m.set(e.dn.toLowerCase(), e)
        setDetails(m)
      })
      .catch(() => {
        /* the columns stay empty; Name, Type and Status come from the tree data */
      })
      .finally(() => {
        if (!cancelled) setDetailsLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `children` (identity): a reload of the listing reads the columns again.
  }, [profileId, containerDN, childCount, children, columnAttrs, detailsSeq])

  // An account action on one of the rows: its chip follows (the cache is updated by the emitter; read the row again when it is not).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = onAccountChanged(({ profileId: p, dn }) => {
      if (p !== profileId || normalizeDN(getParentDN(dn)) !== normalizeDN(containerDN)) return
      if (cachedAccountStatusKinds(profileId, dn)) return
      clearTimeout(timer)
      timer = setTimeout(() => setDetailsSeq((n) => n + 1), 300)
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [profileId, containerDN])

  const rows = useMemo<Row[]>(
    () =>
      (children ?? []).map((node) => {
        const entry = details.get(node.dn.toLowerCase())
        // The server's status when read, else what the one-level search returned, else the tree's (disabled / expired).
        // The server's status decides its states; "Expires in n days" / inactivity stay from the attributes (RW1-P-01).
        const status = mergeRowStatus(cachedAccountStatusKinds(profileId, node.dn), entry ? deriveRowStatus(entry.attributes) : [...(node.status ?? [])])
        return { node, entry, status }
      }),
    // statusVersion: a remembered / forgotten server status.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [children, details, profileId, statusVersion],
  )

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return rows
    // objectClass and the column attributes, as before (not the status attributes read for the Status column).
    const cols = new Set(['objectClass', ...ATTRIBUTE_COLUMNS, ...extraCols].map((c) => c.toLowerCase()))
    return rows.filter((r) => {
      if (nodeLabel(r.node, true).toLowerCase().includes(q) || r.node.dn.toLowerCase().includes(q)) return true
      return !!r.entry?.attributes?.some((a) => !a.binary && cols.has(a.name.toLowerCase()) && a.values.some((v) => v.toLowerCase().includes(q)))
    })
  }, [rows, filter, extraCols])

  const columns = useMemo<DataTableColumn<Row>[]>(() => {
    const attrCol = (name: string, hidden: boolean): DataTableColumn<Row> => ({
      id: `attr:${name}`,
      header: name,
      value: (r) => attrValues(r.entry, name).join('; '),
      renderer: DATE_COLUMNS.has(name.toLowerCase()) ? 'date' : 'text',
      sortable: true,
      width: 160,
      minWidth: 60,
      mono: name.toLowerCase() === 'objectclass',
      defaultHidden: hidden,
    })
    return [
      {
        id: 'name',
        header: 'Name',
        value: (r) => nameSortValue(r.node),
        cell: (r) => (
          <span className="flex items-center gap-1.5 min-w-0">
            <TreeNodeIcon node={r.node} status={primaryStatus(r.status)} />
            <TruncatedText text={nodeLabel(r.node, showRdnType)} tooltip={r.node.dn} />
          </span>
        ),
        sortable: true,
        width: 260,
        minWidth: 120,
        hideable: false,
      },
      {
        id: 'type',
        header: 'Type',
        value: (r) => typeSortValue(r.node),
        cell: (r) => <TruncatedText text={OBJECT_KIND_LABEL[nodeKind(r.node)]} className="text-muted-foreground" />,
        sortable: true,
        width: 130,
        minWidth: 70,
      },
      { id: 'status', header: 'Status', value: (r) => r.status, renderer: 'status', sortable: true, width: 170, minWidth: 70 },
      ...ATTRIBUTE_COLUMNS.map((name) => attrCol(name, name !== 'description')),
      ...extraCols.map((name) => attrCol(name, false)),
      { id: 'dn', header: 'DN', value: (r) => r.node.dn, renderer: 'dn', width: 320, minWidth: 120, defaultHidden: true },
    ]
  }, [showRdnType, extraCols])

  const selectionItem = useCallback(
    (node: TreeNode): SelectionItem => ({
      dn: node.dn,
      profileId,
      objectClass: node.objectClass,
      status: cachedAccountStatusKinds(profileId, node.dn),
      ...(Array.isArray(node.loginAttributes) ? { presentAttributes: node.loginAttributes } : {}),
    }),
    [profileId],
  )

  // The list is a command source ('list'): selected rows, else its container (ctx.containerDN).
  const selRef = useRef<() => SelectionItem[]>(() => [])
  selRef.current = () => (children ?? []).filter((n) => selected.has(n.dn)).map(selectionItem)
  const handle = useRef<ReturnType<typeof registerListView> | null>(null)
  useEffect(() => {
    const h = registerListView(listId, { profileId, containerDN, selection: () => selRef.current() })
    handle.current = h
    return () => {
      h.dispose()
      if (handle.current === h) handle.current = null
    }
  }, [listId, profileId, containerDN])

  const onSelectionChange = (keys: Set<string>) => {
    setSelected(keys)
    if (keys.size > 0) handle.current?.selected()
  }

  const ctxFor = (rs: Row[]) => getCommandContext('list', { selection: rs.map((r) => selectionItem(r.node)), containerDN })

  // objectClass, NC head: completed by the registry from the tree (commands/selectionContext).
  // The list shows children, so the entry is a container even when the tree has not loaded it
  // (else New ▸ would create next to it, and Search in This Container… / Statistics… would be missing).
  const containerItem = (): SelectionItem => {
    const it = normalizeItem({ dn: containerDN, profileId }, profileId)
    return isContainerKind(it.kind) ? it : { ...it, kind: 'container' }
  }

  /**
   * A plain click opens the preview in the standalone list (as in the tree and
   * the results). Inside an entry tab it only selects: opening the preview
   * would hide the list behind another tab on every click (RW2-E-03).
   */
  const onRowClick = (r: Row, e: ReactMouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.detail > 1) return
    if (embedded || !useUIStore.getState().singleClickPreview) return
    openEntry(profileId, r.node.dn, { preview: true })
  }

  const refresh = () => {
    // A re-read: the rows' remembered account states are read again too (RW2-P-01).
    forgetAccountStatusesUnder(profileId, containerDN)
    useTreeStore.getState().loadChildren(profileId, containerDN).catch(() => {})
  }

  const addColumn = () => {
    const res = columnInputResult(newCol, ATTRIBUTE_COLUMNS, extraCols)
    if (res.kind === 'invalid') {
      setColNote('Not an attribute name')
      return
    }
    if (res.kind === 'predefined') {
      // A built-in column: make it visible (the table keeps its own hidden list; re-read it).
      const id = `attr:${res.name}`
      const hidden = readHidden() ?? columns.filter((c) => c.defaultHidden).map((c) => c.id)
      const next = hiddenAfterShow(hidden, id)
      if (next.length !== hidden.length) {
        writeHidden(next)
        setTableKey((k) => k + 1)
      }
    } else if (res.kind === 'new') {
      const next = [...extraCols, res.name]
      setExtraCols(next)
      saveExtra(next)
    }
    setNewCol('')
    setColNote(null)
    setAddOpen(false)
  }

  const label = (showRdnType ? firstRDN(containerDN) : parseRDN(firstRDN(containerDN)).value) || containerDN
  const total = children?.length ?? 0
  const countText = filter ? `${filtered.length.toLocaleString()} of ${total.toLocaleString()}` : `${total.toLocaleString()} ${total === 1 ? 'entry' : 'entries'}`

  return (
    <div
      className="h-full flex flex-col bg-background min-w-0"
      onFocusCapture={() => handle.current?.activate()}
      onPointerDownCapture={() => handle.current?.activate()}
    >
      {!embedded && (
        <div className="@container flex items-center gap-2 px-3 h-panel-header border-b border-border bg-card shrink-0 min-w-0">
          <FolderOpen size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-oc-ou" />
          <div className="min-w-0 flex-1">
            <TruncatedText as="h2" text={label} className="text-sm font-semibold" />
          </div>
          <TruncatedText text={containerDN} className="hidden @lg:block max-w-[40%] text-xs text-muted-foreground font-mono" />
        </div>
      )}
      <div className="@container flex items-center gap-2 px-2 py-1.5 border-b border-border shrink-0 min-w-0">
        <SearchInput
          value={filter}
          onValueChange={setFilter}
          placeholder="Filter entries"
          aria-label={`Filter the entries of ${label}`}
          size="sm"
          wrapperClassName="flex-1 min-w-[120px] max-w-[320px]"
        />
        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap" role="status">
          {countText}
        </span>
        {(detailsLoading || loading) && <Spinner size="sm" label="Loading entries" />}
        {/* In a tab a click only selects (RW2-E-03); say how a row opens (RW3-N-06). */}
        {embedded && total > 0 && (
          <span className="hidden @[560px]:inline text-xs text-muted-foreground whitespace-nowrap">Enter or double-click opens</span>
        )}
        <span className="flex-1" />
        <Button ref={addBtn} variant="ghost" size="sm" leftIcon={Columns3} aria-expanded={addOpen} aria-haspopup="dialog" onClick={() => setAddOpen((o) => !o)}>
          Add column…
        </Button>
        <IconButton label="Refresh" shortcut="F5" icon={RefreshCw} size="md" disabled={loading} onClick={refresh} />
      </div>
      <Popover open={addOpen} onOpenChange={setAddOpen} anchor={addBtn.current} placement="bottom-end" aria-label="Add column" className="p-2 w-64">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            addColumn()
          }}
          className="flex flex-col gap-1.5"
        >
          <label htmlFor={`${listId}-add-col`} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Attribute
          </label>
          <Input
            id={`${listId}-add-col`}
            value={newCol}
            onChange={(e) => {
              setNewCol(e.target.value)
              setColNote(null)
            }}
            placeholder="e.g. employeeID or mail"
            mono
            size="sm"
            spellCheck={false}
            list={`${listId}-col-names`}
            invalid={!!colNote}
            autoFocus
          />
          <datalist id={`${listId}-col-names`}>
            {ATTRIBUTE_COLUMNS.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <p className={colNote ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
            {colNote ?? 'Enter shows the column (built-in ones too); hide columns with the column chooser in the table header.'}
          </p>
        </form>
      </Popover>
      <div
        ref={tableWrap}
        className="flex-1 min-h-0"
        onContextMenu={(e) => {
          // Empty space below the rows (or an empty list): the shown container's menu.
          if ((e.target as Element).closest('tr[role="row"], thead, button, input')) return
          e.preventDefault()
          setBgMenu({ point: contextMenuPoint(e), ctx: getCommandContext('list', { selection: [containerItem()], containerDN }) })
        }}
      >
        <DataTable<Row>
          key={tableKey}
          aria-label={`Entries in ${label}`}
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.node.dn}
          getRowDn={(r) => r.node.dn}
          selection="multi"
          selectedKeys={selected}
          onSelectionChange={onSelectionChange}
          sort={sort}
          onSortChange={setSort}
          onRowClick={onRowClick}
          initialScrollTop={initialScrollTop}
          onScrollTopChange={viewKey ? (top) => setTabView(viewKey, 'list.scroll', top) : undefined}
          onOpen={(r, { pin }) => {
            // The container's own preview tab stays open behind the opened entry.
            const ownTab = useEditorStore.getState().tabs.find((t) => t.id === `${profileId}:${containerDN}`)
            if (embedded && ownTab?.preview) useEditorStore.getState().pinTab(ownTab.id)
            // The opened entry's editor takes focus (its crumb: Ctrl+F filters its attributes,
            // not the tree; RW3-E-02), as after the palette and Go to DN.
            requestEditorFocus('crumb')
            openEntry(profileId, r.node.dn, { preview: !pin })
          }}
          onEdit={(r) => runCommand('entry.rename', ctxFor([r]))}
          onDelete={(rs) => runCommand('entry.delete', ctxFor(rs))}
          onContextMenu={(point, rs) => setMenu({ point, ctx: ctxFor(rs) })}
          virtualized
          columnChooser
          persistKey={PERSIST_KEY}
          commandScope="list"
          loading={loading && !total}
          empty={
            <EmptyState
              variant="inline"
              icon={FolderOpen}
              title={filter ? 'No entries match the filter' : children === undefined ? 'Loading…' : 'This container is empty'}
            />
          }
        />
      </div>
      <TreeContextMenu menu={menu} onClose={() => setMenu(null)} />
      <ContextMenu point={bgMenu?.point ?? null} onClose={() => setBgMenu(null)} label={`Actions for ${label}`} minWidth={220}>
        {() => (bgMenu ? <CommandMenuItems ctx={bgMenu.ctx} ids={BACKGROUND_COMMANDS} showDnHeader /> : null)}
      </ContextMenu>
    </div>
  )
}
