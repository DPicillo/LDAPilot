/**
 * DataTable (SPEC 6.4) basics: role=grid, sticky header, sort buttons with
 * aria-sort, roving row focus (focus-ring-inset), selection none/single/multi
 * (multi adds a checkbox column), optional virtualization at the fixed
 * --table-row-h (24/28 by density), resizable columns, ColumnChooser,
 * persisted widths/visibility, empty/loading/error states and cell renderers
 * (text, dn, date, uac, image, badge, status).
 *
 * Keys: Up/Down/Home/End/PgUp/PgDn move (and select); Ctrl+arrows move focus
 * only; Shift+arrows extend; Space toggles; Enter opens (Ctrl+Enter pinned);
 * F2 edits; Del deletes; Ctrl+C copies the DN(s); Ctrl+A selects all;
 * Shift+F10 / Menu key open the context menu.
 *
 * Focus recovery (same model as useTreeKeyboard, SPEC 11.4 #7/#8): when the
 * focused row is virtualized away, focus parks on the scroll container, which
 * handles the keys (Down continues from the stored row) and becomes the tab
 * stop; the first rendered row also stays reachable with Tab from the header.
 *
 * persistKey stores widths, hidden columns and the column order (the
 * ColumnChooser moves columns up/down).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ChevronUp, Columns3 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { UAC_FLAGS } from '../../lib/ad-constants'
import { useUIStore } from '../../stores/uiStore'
import { Checkbox } from './Checkbox'
import { IconButton } from './Button'
import { Badge, type BadgeTone } from './Badge'
import { StatusChip } from './StatusChip'
import { TruncatedText } from './TruncatedText'
import { Skeleton } from './Spinner'
import { EmptyState } from './EmptyState'
import { InlineAlert } from './InlineAlert'
import { Popover } from './Popover'
import { getZoom } from './layer'
import { contextMenuPoint, isContextMenuKey } from './Menu'
import { fileTimeToDate, formatDateTime, formatRelative, generalizedTimeToDate, primaryStatus, type AccountStatus, type AccountStatusKind } from './accountStatus'
import type { CommandSource } from './commands'
import { isEditableTarget } from './shortcuts'

export type CellRenderer = 'text' | 'dn' | 'date' | 'uac' | 'image' | 'badge' | 'status'
type CellValue = string | number | Date | null | undefined | string[] | (AccountStatus | AccountStatusKind)[]

export interface DataTableColumn<T> {
  id: string
  header: string
  /** Raw value (sorting, built-in renderers, copy). Defaults to row[id]. */
  value?: (row: T) => CellValue
  /** Custom cell content (wins over `renderer`; `undefined` = use the renderer for this row). */
  cell?: (row: T) => ReactNode
  renderer?: CellRenderer
  width?: number
  minWidth?: number
  sortable?: boolean
  align?: 'left' | 'right' | 'center'
  mono?: boolean
  /** Can be hidden in the ColumnChooser (default true). */
  hideable?: boolean
  defaultHidden?: boolean
  badgeTone?: (row: T) => BadgeTone
}

/** A row group (section header row, collapsible). */
export interface DataTableGroup {
  id: string
  label: ReactNode
  defaultCollapsed?: boolean
}

type GridItem<T> = { type: 'group'; id: string; label: ReactNode; count: number; collapsed: boolean } | { type: 'row'; row: T; index: number }

export interface SortState {
  id: string
  dir: 'asc' | 'desc'
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  'aria-label': string
  selection?: 'none' | 'single' | 'multi'
  selectedKeys?: Set<string>
  onSelectionChange?: (keys: Set<string>) => void
  onOpen?: (row: T, opts: { pin: boolean }) => void
  onEdit?: (row: T) => void
  onDelete?: (rows: T[]) => void
  onContextMenu?: (point: { clientX: number; clientY: number }, rows: T[]) => void
  /** Any click on a row, after the selection was updated (e.g. open a preview on a plain click). */
  onRowClick?: (row: T, e: ReactMouseEvent) => void
  /** Click on a `dn` cell. */
  onOpenDn?: (dn: string) => void
  /** DN of a row for Ctrl+C. */
  getRowDn?: (row: T) => string
  virtualized?: boolean
  stickyHeader?: boolean
  /** A new value scrolls the grid back to its left edge (new results: RW1-S-03). */
  resetScrollKey?: unknown
  /** Vertical scroll position to restore once rows are shown (a remounted view, RW2-E-03). */
  initialScrollTop?: number
  /** Reports the vertical scroll position (to restore it later with initialScrollTop). */
  onScrollTopChange?: (top: number) => void
  empty?: ReactNode
  loading?: boolean
  error?: ReactNode
  sort?: SortState | null
  onSortChange?: (sort: SortState | null) => void
  defaultSort?: SortState | null
  columnChooser?: boolean
  /** localStorage key suffix for widths, hidden columns and column order. */
  persistKey?: string
  /** Sets data-command-scope so plain-key commands (F2, Del) apply here. */
  commandScope?: CommandSource
  /**
   * Row groups: a collapsible header row per group, in the order of `groups`
   * (groups not listed follow in first-seen order). Sorting applies inside
   * each group; rows of a collapsed group are skipped by the keyboard.
   */
  groupBy?: (row: T) => string
  groups?: DataTableGroup[]
  /** Controlled collapsed groups (default: each group's defaultCollapsed, persisted with persistKey). */
  collapsedGroups?: Set<string>
  onCollapsedGroupsChange?: (collapsed: Set<string>) => void
  /** Variable row heights (multi-line cells): virtualized rows are measured instead of assuming --table-row-h. */
  measureRows?: boolean
  /**
   * Multi selection: rows that can be checked (default all). Others show a
   * disabled checkbox and "select all" skips them (Member Of: the primary
   * group and nested-only groups cannot be removed, DEF-19).
   */
  rowSelectable?: (row: T) => boolean
  className?: string
}

interface Persisted {
  widths?: Record<string, number>
  hidden?: string[]
  /** Column ids in display order (ids missing here keep their declared position at the end). */
  order?: string[]
  /** Collapsed row groups (uncontrolled groupBy tables). */
  collapsed?: string[]
}

/** Columns in the persisted order; columns not in `order` follow in their declared order. */
function orderColumns<C extends { id: string }>(columns: C[], order: string[]): C[] {
  if (!order.length) return columns
  const byId = new Map(columns.map((c) => [c.id, c]))
  const out: C[] = []
  for (const id of order) {
    const c = byId.get(id)
    if (c) {
      out.push(c)
      byId.delete(id)
    }
  }
  return [...out, ...columns.filter((c) => byId.has(c.id))]
}
function loadPersisted(key?: string): Persisted {
  if (!key) return {}
  try {
    return JSON.parse(localStorage.getItem(`ldapilot-table-${key}`) || '{}') as Persisted
  } catch {
    return {}
  }
}
function savePersisted(key: string | undefined, p: Persisted) {
  if (!key) return
  try {
    localStorage.setItem(`ldapilot-table-${key}`, JSON.stringify(p))
  } catch {
    /* blocked storage */
  }
}

function rowHeightPx(): number {
  try {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--table-row-h'))
    return Number.isFinite(v) && v > 0 ? v : 24
  } catch {
    return 24
  }
}

function toDate(v: CellValue): Date | null {
  if (v instanceof Date) return v
  if (typeof v === 'number') return new Date(v)
  if (typeof v !== 'string' || !v) return null
  // Pure digits are a Windows FILETIME (0 / max = never), never a year.
  if (/^-?\d{1,19}$/.test(v.trim())) return fileTimeToDate(v)
  return generalizedTimeToDate(v) ?? (Number.isNaN(Date.parse(v)) ? null : new Date(v))
}

function compare(a: CellValue, b: CellValue): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  if (a instanceof Date || b instanceof Date) return (toDate(a)?.getTime() ?? 0) - (toDate(b)?.getTime() ?? 0)
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const sa = Array.isArray(a) ? a.map(String).join(', ') : String(a)
  const sb = Array.isArray(b) ? b.map(String).join(', ') : String(b)
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' })
}

function uacText(v: CellValue): string {
  const n = typeof v === 'number' ? v : Number(Array.isArray(v) ? v[0] : v)
  if (!Number.isFinite(n)) return ''
  const names = UAC_FLAGS.filter((f) => n & f.bit && f.bit !== 0x200).map((f) => f.description)
  const base = n & 0x1000 ? 'Workstation account' : n & 0x2000 ? 'Server trust account' : n & 0x200 ? 'Normal account' : ''
  return [base, ...names].filter(Boolean).join(' · ')
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  selection = 'none',
  selectedKeys,
  onSelectionChange,
  onOpen,
  onEdit,
  onDelete,
  onContextMenu,
  onRowClick: onRowClickProp,
  onOpenDn,
  getRowDn,
  virtualized = false,
  stickyHeader = true,
  resetScrollKey,
  initialScrollTop,
  onScrollTopChange,
  empty,
  loading,
  error,
  sort: sortProp,
  onSortChange,
  defaultSort = null,
  columnChooser,
  persistKey,
  commandScope,
  groupBy,
  groups,
  collapsedGroups,
  onCollapsedGroupsChange,
  measureRows,
  rowSelectable,
  className,
  ...aria
}: DataTableProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // The visible width: the empty state stays inside it however wide the columns are (RW1-S-03).
  const [viewW, setViewW] = useState(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setViewW(el.clientWidth))
    ro.observe(el)
    setViewW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (resetScrollKey !== undefined && scrollRef.current) scrollRef.current.scrollLeft = 0
  }, [resetScrollKey])
  const theadRef = useRef<HTMLTableSectionElement>(null)
  const tbodyRef = useRef<HTMLTableSectionElement>(null)
  const [persisted] = useState(() => loadPersisted(persistKey))
  const [widths, setWidths] = useState<Record<string, number>>(() => persisted.widths ?? {})
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(persisted.hidden ?? columns.filter((c) => c.defaultHidden).map((c) => c.id)))
  const [order, setOrder] = useState<string[]>(() => persisted.order ?? [])
  const [sortState, setSortState] = useState<SortState | null>(defaultSort)
  const sort = sortProp !== undefined ? sortProp : sortState
  const [internalSel, setInternalSel] = useState<Set<string>>(new Set())
  const sel = selectedKeys ?? internalSel
  const setSel = (s: Set<string>) => {
    if (!selectedKeys) setInternalSel(s)
    onSelectionChange?.(s)
  }
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const anchorKey = useRef<string | null>(null)
  const pendingFocus = useRef<string | null>(null)
  // True while focus is handed to the scroll container because the focused row unmounted.
  const parking = useRef(false)
  const [hasFocus, setHasFocus] = useState(false)
  const [chooserOpen, setChooserOpen] = useState(false)
  const chooserBtn = useRef<HTMLButtonElement>(null)
  const density = useUIStore((s) => s.density)
  const rowH = useMemo(() => rowHeightPx(), [density])

  const [collapsedState, setCollapsedState] = useState<Set<string>>(
    () => new Set(persisted.collapsed ?? (groups ?? []).filter((g) => g.defaultCollapsed).map((g) => g.id)),
  )
  const collapsed = collapsedGroups ?? collapsedState
  const toggleGroup = (id: string) => {
    const next = new Set(collapsed)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    if (!collapsedGroups) setCollapsedState(next)
    onCollapsedGroupsChange?.(next)
  }

  useEffect(
    () =>
      savePersisted(persistKey, {
        widths,
        hidden: [...hidden],
        order: order.length ? order : undefined,
        collapsed: groupBy && !collapsedGroups ? [...collapsedState] : undefined,
      }),
    [persistKey, widths, hidden, order, groupBy, collapsedGroups, collapsedState],
  )

  const orderedCols = useMemo(() => orderColumns(columns, order), [columns, order])
  const visibleCols = orderedCols.filter((c) => !hidden.has(c.id))
  const moveColumn = (id: string, dir: -1 | 1) => {
    const ids = orderedCols.map((c) => c.id)
    const i = ids.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    setOrder(ids)
  }
  const valueOf = useCallback((c: DataTableColumn<T>, r: T): CellValue => (c.value ? c.value(r) : ((r as Record<string, unknown>)[c.id] as CellValue)), [])

  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.id === sort.id)
    if (!col) return rows
    const out = [...rows].sort((a, b) => compare(valueOf(col, a), valueOf(col, b)))
    return sort.dir === 'desc' ? out.reverse() : out
  }, [rows, sort, columns, valueOf])

  // Grouped tables: header items + the rows of expanded groups (displayRows = what the keyboard walks).
  const { items, displayRows } = useMemo(() => {
    if (!groupBy) return { items: null, displayRows: sorted }
    const buckets = new Map<string, T[]>()
    for (const r of sorted) {
      const g = groupBy(r)
      const list = buckets.get(g)
      if (list) list.push(r)
      else buckets.set(g, [r])
    }
    const listed = (groups ?? []).map((g) => g.id)
    const order = [...listed, ...[...buckets.keys()].filter((id) => !listed.includes(id))]
    const out: GridItem<T>[] = []
    const rowsOut: T[] = []
    for (const id of order) {
      const list = buckets.get(id)
      if (!list?.length) continue
      const isCollapsed = collapsed.has(id)
      out.push({ type: 'group', id, label: groups?.find((g) => g.id === id)?.label ?? id, count: list.length, collapsed: isCollapsed })
      if (isCollapsed) continue
      for (const r of list) {
        out.push({ type: 'row', row: r, index: rowsOut.length })
        rowsOut.push(r)
      }
    }
    return { items: out, displayRows: rowsOut }
  }, [groupBy, groups, sorted, collapsed])

  const keys = useMemo(() => displayRows.map(rowKey), [displayRows, rowKey])
  const selectableKeys = useMemo(() => (rowSelectable ? displayRows.filter(rowSelectable).map(rowKey) : keys), [displayRows, rowKey, rowSelectable, keys])
  // A remembered scroll position comes back once the rows are there (RW2-E-03). The
  // virtualizer renders its full height only after it measured the scroll element, so
  // the position is applied frame by frame until it holds (scroll events of the
  // restore are not reported: a clamped first try must not overwrite the memory).
  const pendingScrollTop = useRef(initialScrollTop ?? 0)
  useLayoutEffect(() => {
    if (pendingScrollTop.current <= 0 || !displayRows.length) return
    let tries = 0
    let raf = 0
    const apply = () => {
      const el = scrollRef.current
      const want = pendingScrollTop.current
      if (!el || want <= 0) return
      el.scrollTop = want
      if (Math.abs(el.scrollTop - want) < 2 || ++tries > 30) {
        pendingScrollTop.current = 0
        return
      }
      raf = requestAnimationFrame(apply)
    }
    apply()
    return () => cancelAnimationFrame(raf)
  }, [displayRows.length])
  const indexOfKey = useCallback((k: string | null) => (k == null ? -1 : keys.indexOf(k)), [keys])

  const itemKeyAt = (i: number): string => {
    if (!items) return keys[i] ?? String(i)
    const it = items[i]
    return !it ? String(i) : it.type === 'group' ? `group:${it.id}` : keys[it.index]
  }
  const virt = useVirtualizer({
    count: virtualized ? (items ? items.length : displayRows.length) : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 12,
    // The <thead> sits in the scroll container above the rows, so a row's real
    // bottom is one header height below the virtualizer's item.end: scrolling a
    // row into view at the bottom ('auto' -> 'end') must add it, or the focused
    // row stays below the viewport (WCAG 2.4.11). Going up needs nothing: the
    // virtual start lands just under the sticky header. offsetHeight: unscaled px.
    scrollPaddingEnd: theadRef.current?.offsetHeight ?? rowH,
    // Measured rows keep their size by row key (re-sorting / collapsing moves indexes).
    ...(measureRows
      ? {
          getItemKey: itemKeyAt,
          // offsetHeight: unscaled layout px (getBoundingClientRect would include the zoom transform).
          measureElement: (el: Element) => (el as HTMLElement).offsetHeight || rowH,
        }
      : {}),
  })
  const virtRef = useRef(virt)
  virtRef.current = virt
  useEffect(() => {
    if (virtualized) virt.measure()
  }, [rowH, virtualized, virt])

  // Row element registry (stable callbacks: no focus loss on re-render).
  const rowEls = useRef(new Map<string, HTMLTableRowElement>())
  const refCbs = useRef(new Map<string, (el: HTMLTableRowElement | null) => void>())
  const rowRef = (k: string) => {
    let cb = refCbs.current.get(k)
    if (!cb) {
      cb = (el) => {
        if (el) {
          rowEls.current.set(k, el)
          const a = document.activeElement
          // Also another row of this table: PageDown to a row that was not rendered
          // yet must move focus there (the old row stays mounted in the overscan).
          const ownsFocus =
            !a || a === document.body || a === scrollRef.current || (a.getAttribute('role') === 'row' && !!scrollRef.current?.contains(a))
          if (pendingFocus.current === k && ownsFocus) {
            pendingFocus.current = null
            el.focus({ preventScroll: true })
          }
        } else {
          const prev = rowEls.current.get(k)
          if (prev && document.activeElement === prev && scrollRef.current) {
            // Park on the container: it handles the keys and continues from the stored row.
            // Remember the row, so it takes focus back when it is rendered again (scrolled
            // back, or React StrictMode re-attaching refs) while focus is still parked.
            if (pendingFocus.current == null) pendingFocus.current = k
            parking.current = true
            scrollRef.current.focus({ preventScroll: true })
            parking.current = false
          }
          rowEls.current.delete(k)
        }
      }
      refCbs.current.set(k, cb)
    }
    return cb
  }

  // Measured rows: a stable ref per key that also reports the row to the virtualizer.
  const measureCbs = useRef(new Map<string, (el: HTMLTableRowElement | null) => void>())
  const measuring = measureRows && virtualized
  const rowRefFor = (k: string) => {
    if (!measuring) return rowRef(k)
    let cb = measureCbs.current.get(k)
    if (!cb) {
      const base = rowRef(k)
      cb = (el) => {
        base(el)
        if (el) virtRef.current.measureElement(el)
      }
      measureCbs.current.set(k, cb)
    }
    return cb
  }

  const focusRow = (k: string) => {
    setFocusKey(k)
    const i = indexOfKey(k)
    const vi = items ? items.findIndex((it) => it.type === 'row' && it.index === i) : i
    if (virtualized && i >= 0 && vi >= 0) virt.scrollToIndex(vi, { align: 'auto' })
    const el = rowEls.current.get(k)
    if (el) {
      el.focus({ preventScroll: virtualized })
      if (!virtualized) el.scrollIntoView({ block: 'nearest' })
    } else pendingFocus.current = k
  }

  const selectRange = (from: string | null, to: string, additive: boolean) => {
    const a = indexOfKey(from ?? to)
    const b = indexOfKey(to)
    const [lo, hi] = a <= b ? [a, b] : [b, a]
    const next = new Set(additive ? sel : [])
    for (let i = lo; i <= hi; i++) if (i >= 0) next.add(keys[i])
    setSel(next)
  }

  const onRowClick = (e: ReactMouseEvent, k: string) => {
    setFocusKey(k)
    if (selection === 'none') return
    if (selection === 'multi' && (e.ctrlKey || e.metaKey)) {
      const next = new Set(sel)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      anchorKey.current = k
      setSel(next)
    } else if (selection === 'multi' && e.shiftKey) {
      selectRange(anchorKey.current, k, false)
    } else {
      anchorKey.current = k
      setSel(new Set([k]))
    }
  }

  const rowsFor = (ks: Iterable<string>) => {
    const set = new Set(ks)
    return displayRows.filter((r) => set.has(rowKey(r)))
  }
  const targetRows = () => {
    if (focusKey && sel.has(focusKey)) return rowsFor(sel)
    if (focusKey) return rowsFor([focusKey])
    return rowsFor(sel)
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!keys.length) return
    // Rows (tbody) and the parked scroll container; never the header controls.
    const fromRows = e.target === scrollRef.current || (!!tbodyRef.current && tbodyRef.current.contains(e.target as Node))
    if (!fromRows) return
    // Controls inside a cell (inline editors, row buttons) keep their own keys.
    const t = e.target as HTMLElement
    if (t !== scrollRef.current && t.getAttribute('role') !== 'row') {
      if (isEditableTarget(t)) return
      if ((e.key === 'Enter' || e.key === ' ') && t.closest('button,a,input,[role="button"]')) return
    }
    const ctrl = e.ctrlKey || e.metaKey
    const cur = Math.max(0, indexOfKey(focusKey))
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? rowH * 10) / rowH) - 1)
    let n: number | null = null
    switch (e.key) {
      case 'ArrowDown': n = focusKey == null ? 0 : Math.min(keys.length - 1, cur + 1); break
      case 'ArrowUp': n = Math.max(0, cur - 1); break
      case 'Home': n = 0; break
      case 'End': n = keys.length - 1; break
      case 'PageDown': n = Math.min(keys.length - 1, cur + page); break
      case 'PageUp': n = Math.max(0, cur - page); break
    }
    if (n !== null) {
      e.preventDefault()
      const k = keys[n]
      focusRow(k)
      if (selection === 'none' || ctrl) return
      if (e.shiftKey && selection === 'multi') selectRange(anchorKey.current ?? focusKey, k, false)
      else {
        anchorKey.current = k
        setSel(new Set([k]))
      }
      return
    }
    const fk = focusKey ?? keys[0]
    const row = displayRows[indexOfKey(fk)]
    if (e.key === ' ' && selection !== 'none') {
      e.preventDefault()
      const next = new Set(selection === 'multi' ? sel : [])
      if (sel.has(fk) && selection === 'multi') next.delete(fk)
      else next.add(fk)
      anchorKey.current = fk
      setSel(next)
    } else if (e.key === 'Enter' && row && onOpen) {
      e.preventDefault()
      onOpen(row, { pin: ctrl })
    } else if (e.key === 'F2' && row && onEdit) {
      e.preventDefault()
      onEdit(row)
    } else if (e.key === 'Delete' && onDelete) {
      const t = targetRows()
      if (t.length) {
        e.preventDefault()
        onDelete(t)
      }
    } else if (ctrl && e.key.toLowerCase() === 'c' && !e.shiftKey && !e.altKey && getRowDn) {
      const t = targetRows()
      if (t.length && !window.getSelection()?.toString()) {
        e.preventDefault()
        navigator.clipboard?.writeText(t.map(getRowDn).join('\n')).catch(() => {})
      }
    } else if (ctrl && e.key.toLowerCase() === 'a' && !e.shiftKey && !e.altKey && selection === 'multi') {
      // Plain Ctrl+A only: Ctrl+Shift+A is the AI Chat registry shortcut.
      e.preventDefault()
      setSel(new Set(selectableKeys))
    } else if (isContextMenuKey(e) && onContextMenu) {
      e.preventDefault()
      onContextMenu(contextMenuPoint(e), targetRows())
    }
  }

  const toggleSort = (c: DataTableColumn<T>) => {
    const next: SortState | null = !sort || sort.id !== c.id ? { id: c.id, dir: 'asc' } : sort.dir === 'asc' ? { id: c.id, dir: 'desc' } : null
    if (sortProp === undefined) setSortState(next)
    onSortChange?.(next)
  }

  // Column resize (pointer delta divided by the zoom).
  const startResize = (e: React.PointerEvent, c: DataTableColumn<T>) => {
    e.preventDefault()
    e.stopPropagation()
    const th = (e.currentTarget as HTMLElement).closest('th')
    const startW = th?.offsetWidth ?? c.width ?? 120
    const startX = e.clientX
    const z = getZoom()
    const min = c.minWidth ?? 48
    const move = (ev: PointerEvent) => setWidths((w) => ({ ...w, [c.id]: Math.max(min, Math.round(startW + (ev.clientX - startX) / z)) }))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  useLayoutEffect(() => {
    if (focusKey && indexOfKey(focusKey) < 0) setFocusKey(null)
  }, [keys, focusKey, indexOfKey])

  const renderCell = (c: DataTableColumn<T>, r: T): ReactNode => {
    if (c.cell) {
      const custom = c.cell(r)
      if (custom !== undefined) return custom
    }
    const v = valueOf(c, r)
    switch (c.renderer) {
      case 'dn': {
        const dn = typeof v === 'string' ? v : ''
        if (!dn) return null
        return onOpenDn ? (
          <button type="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation()
              onOpenDn(dn)
            }}
            className="block max-w-full text-left text-primary hover:underline font-mono"
          >
            <TruncatedText text={dn} />
          </button>
        ) : (
          <TruncatedText text={dn} className="font-mono" />
        )
      }
      case 'date': {
        const d = toDate(v)
        if (!d) return v === '0' || v === '9223372036854775807' ? <span className="text-muted-foreground">Never</span> : <span className="text-muted-foreground">{v ? String(v) : ''}</span>
        return (
          <TruncatedText tooltip={`${formatRelative(d)} · raw: ${String(v instanceof Date ? v.toISOString() : v)}`} className="tabular-nums">
            {formatDateTime(d)}
          </TruncatedText>
        )
      }
      case 'uac':
        return <TruncatedText text={uacText(v)} />
      case 'image': {
        const s = typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] ?? '') : ''
        if (!s) return null
        const src = s.startsWith('data:') ? s : `data:image/jpeg;base64,${s}`
        return <img src={src} alt="" className="size-5 rounded-xs object-cover" />
      }
      case 'badge':
        return v == null || v === '' ? null : <Badge tone={c.badgeTone?.(r) ?? 'neutral'}>{String(v)}</Badge>
      case 'status': {
        const list = (Array.isArray(v) ? v : []) as (AccountStatus | AccountStatusKind)[]
        if (!list.length) return null
        const objs = list.filter((x): x is AccountStatus => typeof x === 'object')
        const k = primaryStatus(list as AccountStatusKind[] | AccountStatus[])
        const st = objs.find((o) => o.kind === k)
        return (
          <span className="flex items-center gap-1 min-w-0">
            <StatusChip kind={k} status={st} compact />
            {list.length > 1 && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">+{list.length - 1}</span>}
          </span>
        )
      }
      default: {
        const s = v == null ? '' : Array.isArray(v) ? v.map(String).join(', ') : v instanceof Date ? formatDateTime(v) : String(v)
        return <TruncatedText text={s} />
      }
    }
  }

  const multi = selection === 'multi'
  const allSelected = multi && selectableKeys.length > 0 && selectableKeys.every((k) => sel.has(k))
  const someSelected = multi && !allSelected && selectableKeys.some((k) => sel.has(k))
  const colCount = visibleCols.length + (multi ? 1 : 0) + (columnChooser ? 1 : 0)

  const vItemsForStop = virtualized ? virt.getVirtualItems() : []
  const storedFocus = focusKey ?? keys[0]
  const storedIndex = indexOfKey(storedFocus ?? null)
  // Is the stored focus row rendered? (Always, unless virtualized and scrolled away.)
  const rowIndexOfItem = (vi: number): number => (items ? (items[vi]?.type === 'row' ? (items[vi] as { index: number }).index : -1) : vi)
  const renderedRowIdx = vItemsForStop.map((v) => rowIndexOfItem(v.index)).filter((i) => i >= 0)
  const storedMounted =
    !virtualized || (renderedRowIdx.length > 0 && storedIndex >= renderedRowIdx[0] && storedIndex <= renderedRowIdx[renderedRowIdx.length - 1])
  // Tab stop inside the body when the stored row is not rendered: the first rendered row.
  const proxyKey = !storedMounted && renderedRowIdx.length ? keys[renderedRowIdx[0]] : null

  const renderRow = (r: T, i: number, style?: React.CSSProperties, itemIndex?: number) => {
    const k = keys[i]
    const selected = sel.has(k)
    const focused = k === storedFocus || k === proxyKey
    return (
      <tr
        key={k}
        ref={rowRefFor(k)}
        data-index={measuring ? (itemIndex ?? i) : undefined}
        role="row"
        aria-rowindex={(itemIndex ?? i) + 2}
        aria-selected={selection === 'none' ? undefined : selected}
        tabIndex={focused ? 0 : -1}
        data-key={k}
        style={style}
        onFocus={(e) => {
          // Tab onto the proxy row while the stored row is scrolled away: continue from the stored row.
          if (k === proxyKey && focusKey && focusKey !== k && e.currentTarget.matches(':focus-visible')) {
            focusRow(focusKey)
            return
          }
          // A row the user focused (click) cancels an older pending focus target.
          if (pendingFocus.current !== null && pendingFocus.current !== k) pendingFocus.current = null
          if (focusKey !== k) setFocusKey(k)
        }}
        onClick={(e) => {
          onRowClick(e, k)
          onRowClickProp?.(r, e)
        }}
        onDoubleClick={() => onOpen?.(r, { pin: true })}
        onContextMenu={
          onContextMenu
            ? (e) => {
                e.preventDefault()
                if (!sel.has(k) && selection !== 'none') {
                  anchorKey.current = k
                  setSel(new Set([k]))
                }
                setFocusKey(k)
                onContextMenu({ clientX: e.clientX, clientY: e.clientY }, sel.has(k) ? rowsFor(sel) : [r])
              }
            : undefined
        }
        className={cn(
          'h-table-row group outline-hidden focus-ring-inset cursor-default',
          measureRows && '[&>td]:align-top',
          selected ? (hasFocus ? 'row-selected' : 'row-selected-inactive') : 'hover:bg-accent',
        )}
      >
        {multi && (
          <td role="gridcell" className="px-2 border-b border-border w-8" onClick={(e) => e.stopPropagation()}>
            <Checkbox
              tabIndex={-1}
              aria-label={`Select row ${i + 1}`}
              checked={selected}
              disabled={rowSelectable ? !rowSelectable(r) : undefined}
              onCheckedChange={(c) => {
                const next = new Set(sel)
                if (c) next.add(k)
                else next.delete(k)
                anchorKey.current = k
                setSel(next)
              }}
            />
          </td>
        )}
        {visibleCols.map((c) => (
          <td
            key={c.id}
            role="gridcell"
            className={cn(
              'px-2 border-b border-border whitespace-nowrap overflow-hidden max-w-0',
              c.align === 'right' && 'text-right',
              c.align === 'center' && 'text-center',
              c.mono && 'font-mono',
            )}
          >
            {renderCell(c, r)}
          </td>
        ))}
        {columnChooser && <td role="presentation" className="border-b border-border" />}
      </tr>
    )
  }

  const renderGroup = (g: Extract<GridItem<T>, { type: 'group' }>, itemIndex: number) => (
    <tr
      key={`group:${g.id}`}
      ref={
        measuring
          ? (el) => {
              if (el) virtRef.current.measureElement(el)
            }
          : undefined
      }
      data-index={measuring ? itemIndex : undefined}
      role="row"
      aria-rowindex={itemIndex + 2}
      className="h-table-row"
    >
      <th role="rowheader" scope="colgroup" colSpan={colCount} className="p-0 bg-secondary border-b border-border text-left">
        <button type="button"
          aria-expanded={!g.collapsed}
          onClick={() => toggleGroup(g.id)}
          className="flex items-center gap-1.5 w-full h-table-row px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground focus-ring-inset"
        >
          {g.collapsed ? <ChevronRight size={12} strokeWidth={1.75} aria-hidden /> : <ChevronDown size={12} strokeWidth={1.75} aria-hidden />}
          <span>{g.label}</span>
          <span className="font-normal normal-case tracking-normal tabular-nums">{g.count}</span>
        </button>
      </th>
    </tr>
  )
  const renderItem = (it: GridItem<T>, itemIndex: number) =>
    it.type === 'group' ? renderGroup(it, itemIndex) : renderRow(it.row, it.index, undefined, itemIndex)

  const vItems = virtualized ? virt.getVirtualItems() : []
  const padTop = virtualized && vItems.length ? vItems[0].start : 0
  const padBottom = virtualized && vItems.length ? virt.getTotalSize() - vItems[vItems.length - 1].end : 0

  return (
    <div
      className={cn('relative flex flex-col min-h-0 min-w-0 h-full', className)}
      data-command-scope={commandScope}
      onFocus={() => setHasFocus(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setHasFocus(false)
      }}
    >
      {error && (
        <div className="p-2 shrink-0">
          <InlineAlert tone="danger" body={error} />
        </div>
      )}
      <div
        ref={scrollRef}
        // A tab stop only while the stored focus row is not rendered (like the tree container).
        tabIndex={keys.length && !storedMounted ? 0 : -1}
        className="flex-1 min-h-0 overflow-auto outline-hidden"
        onKeyDown={onKeyDown}
        onScroll={onScrollTopChange ? (e) => pendingScrollTop.current <= 0 && onScrollTopChange(e.currentTarget.scrollTop) : undefined}
        onFocus={(e) => {
          if (e.target !== e.currentTarget || parking.current || !keys.length) return
          // Keyboard focus on the container (Tab): go to the stored row. A click on empty space does not scroll.
          if (e.currentTarget.matches(':focus-visible')) focusRow(focusKey ?? keys[0])
        }}
      >
        <table
          role="grid"
          aria-label={aria['aria-label']}
          aria-rowcount={(items ? items.length : displayRows.length) + 1}
          aria-colcount={colCount}
          aria-multiselectable={multi || undefined}
          aria-busy={loading || undefined}
          className="w-full table-fixed border-separate border-spacing-0 text-sm"
        >
          <colgroup>
            {multi && <col style={{ width: 32 }} />}
            {visibleCols.map((c) => (
              <col key={c.id} style={{ width: widths[c.id] ?? c.width, minWidth: c.minWidth }} />
            ))}
            {columnChooser && <col style={{ width: 32 }} />}
          </colgroup>
          <thead ref={theadRef} className={cn(stickyHeader && 'sticky top-0 z-(--z-sticky)')}>
            <tr role="row" aria-rowindex={1}>
              {multi && (
                <th role="columnheader" className="h-table-row px-2 bg-card border-b border-border text-left">
                  <Checkbox
                    aria-label={allSelected ? 'Deselect all rows' : 'Select all rows'}
                    checked={allSelected}
                    indeterminate={someSelected}
                    disabled={selectableKeys.length === 0}
                    onCheckedChange={(c) => setSel(c ? new Set(selectableKeys) : new Set())}
                  />
                </th>
              )}
              {visibleCols.map((c) => {
                const active = sort?.id === c.id
                return (
                  <th
                    key={c.id}
                    role="columnheader"
                    scope="col"
                    aria-sort={c.sortable ? (active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                    // The whole header cell sorts, not only its label (RW3-E-05); the resize
                    // handle and the label button handle their own clicks.
                    onClick={c.sortable ? (e) => { if (e.target === e.currentTarget) toggleSort(c) } : undefined}
                    className={cn(
                      'relative h-table-row px-2 bg-card border-b border-border text-xs font-semibold text-muted-foreground whitespace-nowrap select-none',
                      c.sortable && 'cursor-pointer hover:text-foreground',
                      c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                    )}
                  >
                    {c.sortable ? (
                      <button type="button"
                        onClick={() => toggleSort(c)}
                        className={cn('inline-flex items-center gap-1 max-w-full rounded-xs hover:text-foreground', active && 'text-foreground')}
                      >
                        <span className="truncate">{c.header}</span>
                        {active &&
                          (sort!.dir === 'asc' ? <ArrowUp size={12} strokeWidth={1.75} aria-hidden /> : <ArrowDown size={12} strokeWidth={1.75} aria-hidden />)}
                      </button>
                    ) : (
                      <span className="block truncate">{c.header}</span>
                    )}
                    <span
                      aria-hidden
                      onPointerDown={(e) => startResize(e, c)}
                      onDoubleClick={() => setWidths((w) => {
                        const n = { ...w }
                        delete n[c.id]
                        return n
                      })}
                      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-primary"
                    />
                  </th>
                )
              })}
              {columnChooser && (
                <th role="columnheader" className="h-table-row bg-card border-b border-border text-right pr-0.5">
                  <IconButton ref={chooserBtn} label="Choose columns" icon={Columns3} size="sm" aria-expanded={chooserOpen} aria-haspopup="dialog" onClick={() => setChooserOpen((o) => !o)} />
                </th>
              )}
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {loading && !sorted.length ? (
              <tr>
                <td colSpan={colCount} className="p-0">
                  <Skeleton variant="table" rows={6} />
                </td>
              </tr>
            ) : !sorted.length ? (
              <tr>
                <td colSpan={colCount} className="p-0">
                  <div className="sticky left-0" style={viewW ? { width: viewW } : undefined}>
                    {empty ?? <EmptyState variant="inline" title="No entries" />}
                  </div>
                </td>
              </tr>
            ) : virtualized ? (
              <>
                {padTop > 0 && (
                  <tr aria-hidden style={{ height: padTop }}>
                    <td colSpan={colCount} />
                  </tr>
                )}
                {vItems.map((vi) => (items ? renderItem(items[vi.index], vi.index) : renderRow(displayRows[vi.index], vi.index)))}
                {padBottom > 0 && (
                  <tr aria-hidden style={{ height: padBottom }}>
                    <td colSpan={colCount} />
                  </tr>
                )}
              </>
            ) : items ? (
              items.map((it, i) => renderItem(it, i))
            ) : (
              displayRows.map((r, i) => renderRow(r, i))
            )}
          </tbody>
        </table>
      </div>
      {columnChooser && (
        <Popover open={chooserOpen} onOpenChange={setChooserOpen} anchor={chooserBtn.current} placement="bottom-end" aria-label="Columns" className="p-2 w-56">
          <ColumnChooserList
            columns={orderedCols.map((c) => ({ id: c.id, label: c.header, hideable: c.hideable !== false }))}
            hidden={hidden}
            onChange={setHidden}
            onMove={moveColumn}
          />
        </Popover>
      )}
    </div>
  )
}

export interface ColumnChooserListProps {
  /** Columns in display order. */
  columns: { id: string; label: string; hideable?: boolean }[]
  hidden: Set<string>
  onChange: (hidden: Set<string>) => void
  /** Reorder: move a column one place up (-1) or down (1). Shows the move buttons when set. */
  onMove?: (id: string, dir: -1 | 1) => void
}

/** The shared column chooser body (replaces 3 copies). Keeps at least one column visible. */
export function ColumnChooserList({ columns, hidden, onChange, onMove }: ColumnChooserListProps) {
  const visibleCount = columns.filter((c) => !hidden.has(c.id)).length
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Columns</legend>
      {columns.map((c, i) => {
        const checked = !hidden.has(c.id)
        return (
          <div key={c.id} className="flex items-center gap-1 min-w-0">
            <Checkbox
              label={c.label}
              checked={checked}
              disabled={c.hideable === false || (checked && visibleCount <= 1)}
              onCheckedChange={(on) => {
                const next = new Set(hidden)
                if (on) next.delete(c.id)
                else next.add(c.id)
                onChange(next)
              }}
              className="flex-1 min-w-0"
            />
            {onMove && (
              <>
                <IconButton label={`Move ${c.label} up`} icon={ChevronUp} size="sm" noTooltip disabled={i === 0} onClick={() => onMove(c.id, -1)} />
                <IconButton label={`Move ${c.label} down`} icon={ChevronDown} size="sm" noTooltip disabled={i === columns.length - 1} onClick={() => onMove(c.id, 1)} />
              </>
            )}
          </div>
        )
      })}
    </fieldset>
  )
}
