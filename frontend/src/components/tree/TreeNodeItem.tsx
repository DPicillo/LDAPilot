/**
 * One row of the DirectoryTree (SPEC 10.2 S2, 4.5, 4.6): fixed 22px (h-row,
 * never a density-dependent height), indent 6 + 12 × depth, selection
 * states row-selected / row-selected-inactive, inset focus ring, ObjectIcon
 * with the account status overlay, persistent child count, truncated label
 * with a tooltip only when cut off. A click selects; only the chevron (or
 * Right/Left) expands and collapses, so clicking an expanded row never
 * collapses it.
 *
 * The treeitem ARIA (level, setsize, posinset, expanded, selected) and the
 * roving tabindex come from useTreeKeyboard via `itemProps`.
 *
 * Roots / naming-context heads show a short label ("ad.ldapilot.lab",
 * "Configuration") with the DN as tooltip; the account overlay has a tooltip
 * (TREE-08). Drag and drop (TREE-02): DirectoryTree decides what is dragged
 * (the selection when the row is selected) and which rows accept a drop
 * (containers, also empty ones); hovering a collapsed container while
 * dragging expands it.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from 'react'
import { ChevronDown, ChevronRight, ChevronsDown, List } from 'lucide-react'
import type { TreeNode } from '../../types/ldap'
import { getIconForHint, getIconForObjectClass } from '../../lib/ldap-icons'
import { unescapedDN } from '../../lib/treesearch'
import { cn } from '../../lib/utils'
import { OBJECT_KIND_COLOR, nodeKind, type ObjectKind } from '../ui/objectKind'
import { ObjectIcon } from '../ui/ObjectIcon'
import { Spinner } from '../ui/Spinner'
import { TruncatedText } from '../ui/TruncatedText'
import { Tooltip, tooltipTriggerProps } from '../ui/Tooltip'
import type { AccountStatusKind } from '../ui/accountStatus'
import { isContextHead } from './treePrefs'

/** Row props from useTreeKeyboard().getItemProps (ref, role, tabIndex, aria-*, onFocus). */
export type TreeItemProps = Record<string, unknown> & { ref?: (el: HTMLElement | null) => void }

/** Kinds with their own ObjectIcon glyph (and account overlays); the rest keep their specific icon. */
const KIND_ICON: ObjectKind[] = ['user', 'group', 'computer', 'contact', 'service', 'ou', 'domain']

const STATUS_TEXT: Partial<Record<AccountStatusKind, string>> = {
  disabled: 'disabled',
  locked: 'locked out',
  expired: 'expired',
}

/** Tooltip of the account overlay on the icon. */
const STATUS_TOOLTIP: Partial<Record<AccountStatusKind, string>> = {
  disabled: 'Account disabled',
  locked: 'Account locked out',
  expired: 'Account expired',
}

/** Drag data type of tree rows (the DNs travel in DirectoryTree's drag session). */
export const TREE_DRAG_TYPE = 'application/x-ldapilot-dns'

/** Hovering a collapsed container this long while dragging expands it. */
const DRAG_EXPAND_MS = 700

export const ROW_INDENT = (depth: number) => 6 + 12 * depth

function rowBg(selected: boolean, treeFocused: boolean): string {
  if (!selected) return 'var(--color-sidebar)'
  return treeFocused ? 'var(--color-selection)' : 'var(--color-selection-inactive)'
}

/** Object icon of a node: ObjectIcon for account and container kinds, else the specific glyph (schema, GPO, site, NC head...). */
export function TreeNodeIcon({ node, status }: { node: TreeNode; status?: AccountStatusKind }) {
  const kind = nodeKind(node)
  if (KIND_ICON.includes(kind)) return <ObjectIcon kind={kind} status={status} />
  const Icon = node.objectClass?.length ? getIconForObjectClass(node.objectClass) : getIconForHint(node.icon)
  return <Icon size={14} strokeWidth={1.75} aria-hidden className={cn('shrink-0', OBJECT_KIND_COLOR[kind])} />
}

interface TreeNodeRowProps {
  node: TreeNode
  label: string
  depth: number
  isExpanded: boolean
  /** In the selection (single or multi: same look, SPEC 4.6). */
  isSelected: boolean
  /** The tree owns focus: row-selected, else row-selected-inactive. */
  treeFocused: boolean
  isLoading: boolean
  /** Number of loaded children (null: not loaded yet). */
  childCount: number | null
  status?: AccountStatusKind
  itemProps: TreeItemProps
  style?: CSSProperties
  onToggle: () => void
  onSelect: (e: MouseEvent) => void
  onOpen: (pin: boolean) => void
  onContextMenu: (e: MouseEvent) => void
  /** Drag start: the DNs to move (empty = not draggable, e.g. a naming-context head). */
  onDragStartRow?: () => string[]
  onDragEndRow?: () => void
  /** Can the entries being dragged be dropped here? */
  canDrop?: () => boolean
  /** Drop: `text` is the drag's text/plain data (DirectoryTree checks it against its drag session). */
  onDropRow?: (text: string) => void
}

export function TreeNodeRow({
  node,
  label,
  depth,
  isExpanded,
  isSelected,
  treeFocused,
  isLoading,
  childCount,
  status,
  itemProps,
  style,
  onToggle,
  onSelect,
  onOpen,
  onContextMenu,
  onDragStartRow,
  onDragEndRow,
  canDrop,
  onDropRow,
}: TreeNodeRowProps) {
  const [dragOver, setDragOver] = useState(false)
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const statusText = status ? STATUS_TEXT[status] : undefined
  const statusTip = status ? STATUS_TOOLTIP[status] : undefined
  const contextHead = isContextHead(node)
  const draggable = !!onDragStartRow && !contextHead

  const stopExpandTimer = () => {
    if (expandTimer.current) clearTimeout(expandTimer.current)
    expandTimer.current = null
  }
  useEffect(() => stopExpandTimer, [])

  const handleDragStart = useCallback(
    (e: DragEvent) => {
      const dns = onDragStartRow?.() ?? []
      if (dns.length === 0) {
        e.preventDefault()
        return
      }
      e.dataTransfer.setData('text/plain', dns.join('\n'))
      try {
        e.dataTransfer.setData(TREE_DRAG_TYPE, String(dns.length))
      } catch {
        /* engines without custom drag types: text/plain is enough */
      }
      e.dataTransfer.effectAllowed = 'move'
    },
    [onDragStartRow],
  )
  const handleDragOver = useCallback(
    (e: DragEvent) => {
      // The drag session decides (WebKit does not always list custom types during dragover).
      if (!onDropRow || !canDrop?.()) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (!dragOver) setDragOver(true)
      if (node.hasChildren && !isExpanded && !expandTimer.current) {
        expandTimer.current = setTimeout(() => {
          expandTimer.current = null
          onToggle()
        }, DRAG_EXPAND_MS)
      }
    },
    [onDropRow, canDrop, dragOver, node.hasChildren, isExpanded, onToggle],
  )
  const handleDropEvent = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDragOver(false)
      stopExpandTimer()
      if (onDropRow && canDrop?.()) onDropRow(e.dataTransfer.getData('text/plain'))
    },
    [onDropRow, canDrop],
  )

  // Roots and naming-context heads show a short name: their DN is always the tooltip.
  const dnTip = tooltipTriggerProps(unescapedDN(node.dn), { placement: 'bottom-start' })

  return (
    <div
      {...itemProps}
      aria-label={statusText ? `${label}, ${statusText}` : label}
      className={cn(
        'flex items-center h-row pr-2 text-sm cursor-default select-none outline-hidden focus-ring-inset',
        isSelected ? (treeFocused ? 'row-selected' : 'row-selected-inactive') : 'hover:bg-accent hover:[--row-bg:var(--color-accent)]',
        dragOver && 'bg-primary-subtle outline-solid outline-1 -outline-offset-1 outline-primary',
      )}
      style={{ ...style, paddingLeft: ROW_INDENT(depth), ['--row-bg' as string]: rowBg(isSelected, treeFocused) }}
      draggable={draggable}
      onDragStart={draggable ? handleDragStart : undefined}
      onDragEnd={draggable ? onDragEndRow : undefined}
      onDragOver={onDropRow ? handleDragOver : undefined}
      onDragLeave={() => {
        setDragOver(false)
        stopExpandTimer()
      }}
      onDrop={onDropRow ? handleDropEvent : undefined}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(e)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onOpen(true)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onContextMenu(e)
      }}
    >
      <span
        aria-hidden
        className={cn('size-4 flex items-center justify-center shrink-0 rounded-xs text-muted-foreground', node.hasChildren && 'hover:bg-accent hover:text-foreground')}
        onClick={(e) => {
          if (!node.hasChildren) return
          e.stopPropagation()
          onToggle()
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {node.hasChildren &&
          (isLoading ? (
            <Spinner size="sm" decorative />
          ) : isExpanded ? (
            <ChevronDown size={12} strokeWidth={1.75} />
          ) : (
            <ChevronRight size={12} strokeWidth={1.75} />
          ))}
      </span>
      {statusTip ? (
        <Tooltip content={statusTip} placement="bottom-start">
          <span className="ml-0.5 mr-1.5 inline-flex shrink-0">
            <TreeNodeIcon node={node} status={status} />
          </span>
        </Tooltip>
      ) : (
        <span className="ml-0.5 mr-1.5 inline-flex shrink-0">
          <TreeNodeIcon node={node} status={status} />
        </span>
      )}
      {contextHead ? (
        <span
          aria-hidden
          className="block min-w-0 flex-1 truncate"
          onPointerEnter={dnTip.onPointerEnter}
          onPointerLeave={dnTip.onPointerLeave}
        >
          {label}
        </span>
      ) : (
        <TruncatedText text={label} tooltip={unescapedDN(node.dn)} className="flex-1" aria-hidden />
      )}
      {childCount !== null && (
        <span aria-hidden className="ml-1.5 shrink-0 text-xs tabular-nums text-muted-foreground">
          {childCount.toLocaleString()}
        </span>
      )}
    </div>
  )
}

/**
 * Placeholder of an expanded container with more children than the tree
 * shows (SPEC UX-16): "1,500 entries · Open list" and a "Show all in tree"
 * icon for the rare case the user wants them all here. Short enough not to
 * truncate at the default sidebar width (TREE-08).
 */
export function LargeContainerRow({
  count,
  depth,
  itemProps,
  style,
  onOpenList,
  onShowAll,
}: {
  count: number
  depth: number
  itemProps: TreeItemProps
  style?: CSSProperties
  onOpenList: () => void
  onShowAll: () => void
}) {
  const n = count.toLocaleString()
  const showAllTip = tooltipTriggerProps(`Show all ${n} entries in the tree`)
  const countTip = tooltipTriggerProps(`${n} entries are not shown in the tree (more than 500): open them in a list, or show all of them here.`)
  return (
    <div
      {...itemProps}
      aria-label={`${n} entries, not shown in the tree. Enter opens them in a list.`}
      className="flex items-center gap-1.5 h-row pr-1 text-sm cursor-default select-none outline-hidden focus-ring-inset hover:bg-accent text-muted-foreground"
      style={{ ...style, paddingLeft: ROW_INDENT(depth) + 18 }}
      onDoubleClick={onOpenList}
    >
      <List size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
      <span className="shrink-0 tabular-nums" onPointerEnter={countTip.onPointerEnter} onPointerLeave={countTip.onPointerLeave}>
        {n} entries
      </span>
      <span aria-hidden className="shrink-0">·</span>
      <button type="button" tabIndex={-1} onClick={onOpenList} className="min-w-0 truncate text-primary hover:underline">
        Open list
      </button>
      <button type="button"
        tabIndex={-1}
        aria-label={`Show all ${n} entries in the tree`}
        onClick={onShowAll}
        onPointerEnter={showAllTip.onPointerEnter}
        onPointerLeave={showAllTip.onPointerLeave}
        className="ml-auto shrink-0 size-5 inline-flex items-center justify-center rounded-xs hover:bg-accent hover:text-foreground"
      >
        <ChevronsDown size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  )
}
