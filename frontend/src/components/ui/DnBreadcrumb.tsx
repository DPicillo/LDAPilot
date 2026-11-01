/**
 * DnBreadcrumb (SPEC 6.3): segments are buttons, separators aria-hidden,
 * middle segments collapse into an "…" menu (which also lists siblings and
 * "Show in Tree"), flex-1 min-w-0 so it never overlaps the toolbar. Ctrl+L /
 * F4 (or a click on empty space) turns it into a mono input that accepts a
 * DN or an ldap:// URL; Enter navigates, Escape reverts.
 *
 * ED-15: segments collapse by the width the row offers (measured, with a
 * ResizeObserver), not by a fixed count; the crumbs start at the naming
 * context (tree root) the entry belongs to (`rootDn`), so Configuration is
 * not shown as a child of the domain; input that is no DN is refused inline
 * (aria-invalid) instead of opening a tab. Right-click on a segment: Open,
 * Show in Tree, Copy DN.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronRight, Copy, Crosshair, ExternalLink, MoreHorizontal } from 'lucide-react'
import { cn } from '../../lib/utils'
import { ContextMenu, DropdownMenu, MenuHeader, MenuItem, MenuSeparator, useContextMenu } from './Menu'
import { Input } from './Input'
import { Tooltip } from './Tooltip'
import { toast } from './Toast'
import { parseDnOrUrl, rdnValue } from './dn'
import { matchShortcut } from './shortcuts'
import { crumbWindow, dnCrumbs, dnInputProblem, type Crumb } from './fit'

export { crumbWindow, dnCrumbs, dnInputProblem }


export interface DnBreadcrumbProps {
  dn: string
  onNavigate: (dn: string) => void
  /** Enter in edit mode: a DN or ldap:// URL (already parsed to a DN). Defaults to onNavigate. */
  onSubmitDn?: (dn: string, raw: string) => void
  /** Siblings of the current entry for the "…" menu. */
  loadSiblings?: (dn: string) => Promise<string[]>
  /** The tree root / naming context the entry belongs to: the first crumb. */
  rootDn?: string
  /** "Show in Tree" in the "…" menu and the segment menus. */
  onShowInTree?: (dn: string) => void
  /** @deprecated Segments collapse by the available width. */
  maxVisible?: number
  /** Controlled edit mode (optional). */
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
  className?: string
}

export function DnBreadcrumb({ dn, onNavigate, onSubmitDn, loadSiblings, rootDn, onShowInTree, editing: editingProp, onEditingChange, className }: DnBreadcrumbProps) {
  const [editingState, setEditingState] = useState(false)
  const editing = editingProp ?? editingState
  const setEditing = (v: boolean) => {
    if (editingProp === undefined) setEditingState(v)
    onEditingChange?.(v)
  }
  const [text, setText] = useState(dn)
  const [problem, setProblem] = useState<string | null>(null)
  const [siblings, setSiblings] = useState<string[] | null>(null)
  const navRef = useRef<HTMLElement>(null)
  const measureRef = useRef<HTMLOListElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const crumbMenu = useContextMenu<string>()

  useEffect(() => {
    if (editing) {
      setText(dn)
      setProblem(null)
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [editing, dn])
  // Siblings belong to one entry.
  useEffect(() => setSiblings(null), [dn])

  const crumbs = dnCrumbs(dn, rootDn)
  const crumbKey = crumbs.map((c) => c.label).join('\n')
  const hasMenu = !!loadSiblings || !!onShowInTree
  const [tailStart, setTailStart] = useState(crumbs.length)

  // Fit by width: measure every crumb once (hidden copy), then window them into the space the row offers.
  useLayoutEffect(() => {
    const nav = navRef.current
    const m = measureRef.current
    if (!nav || !m) return
    const fit = () => {
      const kids = [...m.children] as HTMLElement[]
      const crumbEls = kids.filter((k) => k.dataset.crumb !== undefined)
      const sep = kids.find((k) => k.dataset.sep !== undefined)?.offsetWidth ?? 12
      const more = kids.find((k) => k.dataset.more !== undefined)?.offsetWidth ?? 22
      const gap = parseFloat(getComputedStyle(m).columnGap) || 0
      setTailStart(crumbWindow(crumbEls.map((k) => k.offsetWidth), sep, more, gap, nav.clientWidth, hasMenu))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(nav)
    return () => ro.disconnect()
  }, [crumbKey, editing, hasMenu])

  const startEdit = (e: KeyboardEvent) => {
    if (matchShortcut(e.nativeEvent, 'Mod+L') || (e.key === 'F4' && !e.ctrlKey && !e.altKey && !e.shiftKey)) {
      e.preventDefault()
      e.stopPropagation()
      setEditing(true)
    }
  }

  if (editing) {
    const problemId = 'dn-crumb-problem'
    return (
      <div className={cn('flex-1 min-w-0 flex items-center gap-2', className)}>
        <Input
          ref={inputRef}
          mono
          size="sm"
          aria-label="Distinguished name or LDAP URL"
          invalid={!!problem}
          aria-describedby={problem ? problemId : undefined}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setProblem(null)
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setEditing(false)
              requestAnimationFrame(() => navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus())
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const why = dnInputProblem(text)
              if (why) {
                // Stay in the field: nothing is opened for input that is no DN.
                setProblem(why)
                return
              }
              const parsed = parseDnOrUrl(text)
              const target = parsed.kind === 'text' ? parsed.text : parsed.dn
              setEditing(false)
              if (target) (onSubmitDn ?? ((d: string) => onNavigate(d)))(target, text)
            }
          }}
        />
        {problem && (
          <span id={problemId} role="alert" className="shrink min-w-0 truncate text-xs text-destructive" title={problem}>
            {problem}
          </span>
        )}
      </div>
    )
  }

  const collapse = tailStart < crumbs.length
  const head = collapse ? crumbs.slice(0, 1) : crumbs
  const middle = collapse ? crumbs.slice(1, tailStart) : []
  const tail = collapse ? crumbs.slice(tailStart) : []

  const crumbClass = (last: boolean) =>
    cn(
      'min-w-0 truncate px-1 h-5 rounded-xs text-sm hover:bg-accent',
      last ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground',
    )

  const crumbBtn = (c: Crumb, last: boolean) => (
    <li key={c.dn} className={cn('flex items-center min-w-0', last ? 'shrink' : 'shrink-[2]')}>
      <Tooltip content={<span className="font-mono">{c.dn}</span>} placement="bottom-start">
        <button type="button"
          aria-current={last ? 'page' : undefined}
          onClick={() => onNavigate(c.dn)}
          onContextMenu={(e) => crumbMenu.open(e, c.dn)}
          className={crumbClass(last)}
        >
          {c.label}
        </button>
      </Tooltip>
    </li>
  )
  const sep = (k: string) => (
    <li key={k} aria-hidden className="shrink-0 text-muted-foreground">
      <ChevronRight size={12} strokeWidth={1.75} />
    </li>
  )

  const items: React.ReactNode[] = []
  head.forEach((c, i) => {
    if (i > 0) items.push(sep(`s-${c.dn}`))
    items.push(crumbBtn(c, !collapse && i === head.length - 1))
  })
  if (collapse || hasMenu) {
    const moreMenu = (
      <li key="more" className="shrink-0">
        <DropdownMenu
          label={collapse ? 'Hidden path segments' : 'Path'}
          onOpenChange={(o) => {
            if (o && loadSiblings && siblings === null) {
              loadSiblings(dn)
                .then((s) => setSiblings(s.filter((x) => x.toLowerCase() !== dn.toLowerCase()).slice(0, 30)))
                .catch(() => setSiblings([]))
            }
          }}
          trigger={
            <button type="button" aria-label={collapse ? 'Show hidden path segments' : 'Path menu: siblings, Show in Tree'} className="inline-flex items-center justify-center h-5 px-1 rounded-xs text-muted-foreground hover:text-foreground hover:bg-accent">
              <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden />
            </button>
          }
        >
          {() => (
            <>
              {middle.map((c) => (
                <MenuItem key={c.dn} label={c.label} onSelect={() => onNavigate(c.dn)} />
              ))}
              {loadSiblings && (
                <>
                  {middle.length > 0 && <MenuSeparator />}
                  <MenuHeader>Siblings</MenuHeader>
                  {siblings === null ? (
                    <MenuItem label="Loading…" disabled />
                  ) : siblings.length === 0 ? (
                    <MenuItem label="No siblings" disabled />
                  ) : (
                    siblings.map((s) => <MenuItem key={s} label={rdnValue(s)} onSelect={() => onNavigate(s)} />)
                  )}
                </>
              )}
              {onShowInTree && (
                <>
                  <MenuSeparator />
                  <MenuItem icon={Crosshair} label="Show in Tree" onSelect={() => onShowInTree(dn)} />
                </>
              )}
            </>
          )}
        </DropdownMenu>
      </li>
    )
    if (collapse) {
      items.push(sep('s-more'))
      items.push(moreMenu)
      tail.forEach((c, i) => {
        items.push(sep(`s-${c.dn}`))
        items.push(crumbBtn(c, i === tail.length - 1))
      })
    } else {
      items.push(moreMenu)
    }
  }

  const menuDn = crumbMenu.data
  return (
    <nav
      ref={navRef}
      aria-label="Breadcrumb"
      onKeyDown={startEdit}
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).tagName === 'OL') setEditing(true)
      }}
      className={cn('relative flex-1 min-w-0 flex items-center h-6 cursor-text overflow-hidden', className)}
    >
      <ol className="flex items-center min-w-0 flex-1 gap-0.5 overflow-hidden">{items}</ol>
      {/* Natural widths of every segment, for the fit (never shown, never read aloud). */}
      <ol ref={measureRef} aria-hidden className="absolute left-0 top-0 invisible pointer-events-none flex items-center gap-0.5 whitespace-nowrap">
        {crumbs.map((c, i) => (
          <li key={c.dn} data-crumb="" className="flex items-center">
            <span className={crumbClass(i === crumbs.length - 1)}>{c.label}</span>
          </li>
        ))}
        <li data-sep="" className="shrink-0">
          <ChevronRight size={12} strokeWidth={1.75} />
        </li>
        <li data-more="" className="shrink-0 inline-flex items-center justify-center h-5 px-1">
          <MoreHorizontal size={14} strokeWidth={1.75} />
        </li>
      </ol>
      <ContextMenu point={crumbMenu.point} onClose={crumbMenu.close} label="Path segment actions">
        {menuDn && (
          <>
            <MenuHeader mono>{menuDn}</MenuHeader>
            <MenuItem icon={ExternalLink} label="Open" onSelect={() => onNavigate(menuDn)} />
            {onShowInTree && <MenuItem icon={Crosshair} label="Show in Tree" onSelect={() => onShowInTree(menuDn)} />}
            <MenuItem
              icon={Copy}
              label="Copy DN"
              onSelect={() => {
                navigator.clipboard.writeText(menuDn).then(
                  () => toast.success('DN copied'),
                  () => toast.error('Could not copy the DN'),
                )
              }}
            />
          </>
        )}
      </ContextMenu>
    </nav>
  )
}
