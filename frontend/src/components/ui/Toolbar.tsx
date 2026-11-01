/**
 * Toolbar (SPEC 6.3): role=toolbar, one tab stop, Left/Right/Home/End
 * roving focus, items that do not fit go into an overflow "…" menu
 * (measured with a ResizeObserver, never estimated).
 *
 * Fitting (ED-01): every item's natural width is measured while it is shown
 * and kept, so the toolbar's own size never depends on how many items are
 * currently folded. It asks its flex parent for exactly its natural width
 * (`flex: 0 1 <natural>px`, shrinkable), so a flex-1 sibling with a minimum
 * width (the breadcrumb) gives up its space first; only when the toolbar
 * itself is squeezed below its natural width do items fold, and only then is
 * room reserved for the "…" button.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Button, IconButton, type IconType } from './Button'
import { DropdownMenu, MenuItem, MenuSeparator } from './Menu'
import { fitToolbarItems } from './fit'

export { fitToolbarItems }

export interface ToolbarItem {
  id: string
  label: string
  /** A lucide icon, or a ready element (e.g. a filled star for a pressed state). */
  icon?: IconType | ReactNode
  onClick?: () => void
  disabled?: boolean
  pressed?: boolean
  shortcut?: string
  /** icon: IconButton (label = tooltip); button: text button with optional icon. */
  display?: 'icon' | 'button'
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger-ghost'
  danger?: boolean
  /** Separator before this item. */
  separator?: boolean
}

export interface ToolbarProps {
  items?: ToolbarItem[]
  /** Free-form children instead of items (roving focus still applies). */
  children?: ReactNode
  'aria-label': string
  size?: 'sm' | 'md'
  className?: string
  /** Content after the items that never overflows (a search field). */
  end?: ReactNode
  /** Name of the overflow "…" button (default "More actions"; give it another name next to a "More actions" menu). */
  overflowLabel?: string
}

const ITEM_SEL = '[data-toolbar-item]:not([disabled])'

/**
 * Roving targets: enabled items that are rendered. Overflowed items sit in a
 * `hidden` wrapper span (the attribute is not on the button), so they are
 * excluded by their wrapper, not by ITEM_SEL alone.
 */
function rovingItems(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return [...root.querySelectorAll<HTMLElement>(ITEM_SEL)].filter((el) => {
    const hiddenAncestor = el.closest('[hidden]')
    return !hiddenAncestor || !root.contains(hiddenAncestor)
  })
}

export function Toolbar({ items, children, size = 'sm', className, end, overflowLabel = 'More actions', ...aria }: ToolbarProps) {
  const ref = useRef<HTMLDivElement>(null)
  /** Natural width per item id, kept while the item is folded. */
  const widths = useRef(new Map<string, number>())
  const [visibleCount, setVisibleCount] = useState(items?.length ?? 0)
  /** Natural width of all items + end content: the flex basis the toolbar asks for. */
  const [natural, setNatural] = useState<number | null>(null)
  // A changed item set is measured again with every item shown (before paint).
  const itemsKey = items ? items.map((it) => `${it.id}|${it.display === 'button' ? it.label : ''}|${it.separator ? 1 : 0}`).join('\n') : ''
  const [measuredKey, setMeasuredKey] = useState(itemsKey)
  if (measuredKey !== itemsKey) {
    setMeasuredKey(itemsKey)
    setVisibleCount(items?.length ?? 0)
  }
  const [active, setActive] = useState(0)
  const itemsRef = useRef(items)
  itemsRef.current = items

  // Measure and fit.
  useLayoutEffect(() => {
    const el = ref.current
    if (!itemsRef.current || !el) return
    const fit = () => {
      const list = itemsRef.current
      if (!list) return
      el.querySelectorAll<HTMLElement>('[data-toolbar-id]').forEach((n) => {
        if (!n.hidden && n.offsetWidth) widths.current.set(n.dataset.toolbarId!, n.offsetWidth)
      })
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0
      const endEl = el.querySelector<HTMLElement>('[data-toolbar-end]')
      const endW = endEl ? endEl.offsetWidth + gap : 0
      const known = [...widths.current.values()]
      const fallback = known.length ? Math.max(...known) : 26
      const ws = list.map((it) => widths.current.get(it.id) ?? fallback)
      const moreEl = el.querySelector<HTMLElement>('[data-toolbar-more]')
      const moreW = moreEl?.offsetWidth || Math.min(...ws.filter((w) => w > 0), fallback)
      const full = Math.ceil(ws.reduce((a, b) => a + b, 0) + gap * Math.max(0, ws.length - 1) + endW)
      setNatural((prev) => (prev === full ? prev : full))
      setVisibleCount(fitToolbarItems(ws, gap, el.clientWidth - endW, moreW))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [itemsKey])

  // Roving tabindex: one tab stop.
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const els = rovingItems(root)
    const stop = els[Math.min(active, els.length - 1)]
    // Every item (incl. overflowed ones) leaves the tab order except the one stop.
    root.querySelectorAll<HTMLElement>('[data-toolbar-item]').forEach((n) => (n.tabIndex = n === stop ? 0 : -1))
  })

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    const els = rovingItems(ref.current)
    const cur = els.indexOf(document.activeElement as HTMLElement)
    if (cur < 0) return
    e.preventDefault()
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : (cur + (e.key === 'ArrowRight' ? 1 : -1) + els.length) % els.length
    setActive(n)
    els[n].focus()
  }

  const overflow = items ? items.slice(visibleCount) : []

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-orientation="horizontal"
      {...aria}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        const els = rovingItems(ref.current)
        const i = els.indexOf(e.target as HTMLElement)
        if (i >= 0 && i !== active) setActive(i)
      }}
      style={natural !== null ? { flexBasis: natural } : undefined}
      className={cn('flex items-center gap-0.5 min-w-0 overflow-hidden', className)}
    >
      {children}
      {items?.map((it, i) => {
        const hidden = i >= visibleCount
        return (
          <span key={it.id} data-toolbar-id={it.id} data-sep={it.separator ? '1' : undefined} hidden={hidden} className={cn('shrink-0', hidden ? 'hidden' : 'flex items-center')}>
            {it.separator && <span aria-hidden className="w-px h-4 mx-1 bg-border" />}
            {it.display === 'button' ? (
              <Button
                data-toolbar-item=""
                size={size}
                variant={it.variant ?? 'ghost'}
                leftIcon={it.icon}
                disabled={it.disabled}
                aria-pressed={it.pressed}
                onClick={it.onClick}
                className={cn(it.danger && 'text-destructive')}
              >
                {it.label}
              </Button>
            ) : (
              <IconButton
                data-toolbar-item=""
                label={it.label}
                icon={it.icon}
                size={size === 'sm' ? 'md' : 'lg'}
                pressed={it.pressed}
                shortcut={it.shortcut}
                disabled={it.disabled}
                onClick={it.onClick}
                className={cn(it.danger && 'text-destructive enabled:hover:text-destructive')}
              />
            )}
          </span>
        )
      })}
      {overflow.length > 0 && (
        <DropdownMenu
          label={overflowLabel}
          placement="bottom-end"
          trigger={<IconButton data-toolbar-item="" data-toolbar-more="" label={overflowLabel} icon={MoreHorizontal} size={size === 'sm' ? 'md' : 'lg'} />}
        >
          {overflow.map((it) => (
            <span key={it.id} className="contents">
              {it.separator && <MenuSeparator />}
              <MenuItem icon={it.icon} label={it.label} shortcut={it.shortcut} disabled={it.disabled} tone={it.danger ? 'danger' : 'default'} onSelect={it.onClick} />
            </span>
          ))}
        </DropdownMenu>
      )}
      {end && (
        <div data-toolbar-end="" className="ml-auto flex items-center gap-1 shrink-0 pl-1">
          {end}
        </div>
      )}
    </div>
  )
}
