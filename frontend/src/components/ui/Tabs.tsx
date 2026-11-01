/**
 * Tabs (SPEC 6.3): role=tablist/tab/tabpanel, roving tabindex, arrows move
 * and activate, Home/End; editor variant: Ctrl+PgUp/PgDn, Delete closes (focus
 * moves to the tab that becomes active), middle-click closes, preview
 * (italic), dirty dot = unsaved input only (also on the active tab; it turns
 * into the close X on hover), account status (dot; a disabled account is a
 * UserX glyph, ED-07), deleted / missing / failed glyph, connection marker
 * when tabs of several connections are open (ED-06), tooltip with DN,
 * connection and status (+ aria-describedby), overflow = horizontal scroll +
 * filterable "All tabs" list (dirty mark, active tab marked).
 * Variants: editor (32px, top bar), panel (bottom bar + count), sub (entry sub-tabs).
 */
import { useEffect, useRef, useState, type HTMLAttributes, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { Check, ChevronDown, CircleSlash, CloudOff, Trash2, TriangleAlert, UserX, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { domId } from './dn'
import { renderIcon, type IconType } from './Button'
import { CountBadge } from './Badge'
import { ObjectIcon } from './ObjectIcon'
import { Tooltip } from './Tooltip'
import { Popover } from './Popover'
import { Combobox } from './Listbox'
import type { AccountStatusKind } from './accountStatus'
import type { ObjectKind } from './objectKind'

export interface TabItem {
  id: string
  label: string
  /** Tooltip (the DN on editor tabs). */
  title?: string
  icon?: IconType | ReactNode
  /** Editor tabs: object icon from objectClass/kind. */
  objectClass?: string[]
  kind?: ObjectKind
  /** Small status dot on editor tabs (locked/disabled...). */
  status?: AccountStatusKind
  dirty?: boolean
  preview?: boolean
  /** Editor tabs: the values may be out of date (connection lost or closed); a muted glyph + sr text. */
  stale?: boolean
  /** Editor tabs: the entry is deleted / missing / failed to load (glyph + sr text). */
  state?: 'deleted' | 'missing' | 'error'
  /** Editor tabs: the tab's connection, shown when tabs of several connections are open. */
  connection?: { marker: string; name: string }
  /** Tooltip of a (disabled) tab, e.g. why it is not available. */
  hint?: string
  closable?: boolean
  count?: number
  disabled?: boolean
}

export interface TabsProps {
  items: TabItem[]
  value: string | null
  onValueChange: (id: string) => void
  variant?: 'editor' | 'panel' | 'sub'
  /** Prefix for tab/panel ids; pair with <TabPanel idPrefix>. */
  idPrefix: string
  onClose?: (id: string) => void
  onTabContextMenu?: (e: ReactMouseEvent<HTMLElement>, id: string) => void
  /** Double-click on a tab (editor tabs: pin a preview tab). */
  onTabDoubleClick?: (id: string) => void
  /** Editor variant: show the "All tabs" overflow list. Default true for editor. */
  overflowMenu?: boolean
  'aria-label'?: string
  className?: string
  /** Content at the end of the bar (panel actions). */
  end?: ReactNode
}

export const tabDomId = (prefix: string, id: string) => `${prefix}-tab-${domId(id)}`
export const panelDomId = (prefix: string, id: string) => `${prefix}-panel-${domId(id)}`

/** Account status dots; a disabled account is a UserX glyph instead (the dot is the unsaved-input mark). */
const STATUS_DOT: Partial<Record<AccountStatusKind, { cls: string; text: string }>> = {
  locked: { cls: 'bg-warning', text: 'locked out' },
  expired: { cls: 'bg-destructive', text: 'expired' },
  pwdExpired: { cls: 'bg-destructive', text: 'password expired' },
}
const STATUS_TEXT: Partial<Record<AccountStatusKind, string>> = {
  locked: 'Account locked out',
  disabled: 'Account disabled',
  expired: 'Account expired',
  pwdExpired: 'Password expired',
}
const STATE_GLYPH = {
  deleted: { Icon: Trash2, text: 'deleted', tip: 'The entry was deleted' },
  missing: { Icon: CircleSlash, text: 'no such object', tip: 'The entry does not exist (any more)' },
  error: { Icon: TriangleAlert, text: 'could not be loaded', tip: 'The entry could not be loaded' },
} as const

/** Tooltip lines of an editor tab: DN, connection, state, account status. */
function tabTip(t: TabItem): string[] {
  return [
    t.title ?? '',
    t.connection ? `Connection: ${t.connection.name}` : '',
    t.state ? STATE_GLYPH[t.state].tip : '',
    t.status ? STATUS_TEXT[t.status] ?? '' : '',
    t.dirty ? 'Unsaved changes' : '',
  ].filter(Boolean)
}

export function Tabs({ items, value, onValueChange, variant = 'sub', idPrefix, onClose, onTabContextMenu, onTabDoubleClick, overflowMenu, className, end, ...aria }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const [allOpen, setAllOpen] = useState(false)
  const allBtn = useRef<HTMLButtonElement>(null)
  const enabled = items.filter((t) => !t.disabled)
  const showOverflow = (overflowMenu ?? variant === 'editor') && items.length > 1

  // Keep the active editor tab scrolled into view.
  useEffect(() => {
    if (!value) return
    document.getElementById(tabDomId(idPrefix, value))?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [value, idPrefix])

  const focusTab = (id: string) => {
    onValueChange(id)
    requestAnimationFrame(() => document.getElementById(tabDomId(idPrefix, id))?.focus())
  }

  /**
   * After a close from the keyboard: focus the tab that became active (the
   * owner picks it; usually the right neighbour), else the neighbour we expected.
   * If the owner kept the tab (e.g. it asked to discard changes), focus stays.
   */
  const focusAfterClose = (closedId: string, neighbour: string | undefined) => {
    requestAnimationFrame(() => {
      if (document.getElementById(tabDomId(idPrefix, closedId))) return
      const a = document.activeElement
      if (a && a !== document.body && a.isConnected) return
      const list = listRef.current
      const next =
        (list?.isConnected ? list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') : null) ??
        (neighbour ? document.getElementById(tabDomId(idPrefix, neighbour)) : null)
      next?.focus()
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = enabled.findIndex((t) => t.id === value)
    const go = (n: number) => {
      e.preventDefault()
      if (!enabled.length) return
      focusTab(enabled[(n + enabled.length) % enabled.length].id)
    }
    const ctrl = e.ctrlKey || e.metaKey
    if (ctrl && e.key === 'PageDown') return go(i + 1)
    if (ctrl && e.key === 'PageUp') return go(i - 1)
    if (ctrl || e.altKey) return
    switch (e.key) {
      case 'ArrowRight':
        return go(i + 1)
      case 'ArrowLeft':
        return go(i - 1)
      case 'Home':
        return go(0)
      case 'End':
        return go(enabled.length - 1)
      case 'Delete':
        if (variant === 'editor' && value && onClose) {
          const t = items.find((x) => x.id === value)
          if (t && t.closable !== false) {
            e.preventDefault()
            const neighbour = i >= 0 ? (enabled[i + 1] ?? enabled[i - 1])?.id : undefined
            onClose(value)
            focusAfterClose(value, neighbour)
          }
        }
    }
  }

  const bar =
    variant === 'editor'
      ? 'h-tabbar bg-secondary border-b border-border'
      : variant === 'panel'
        ? 'h-panel-header'
        : 'h-8 border-b border-border'

  return (
    <div className={cn('flex items-stretch min-w-0', bar, className)}>
      <div
        ref={listRef}
        role="tablist"
        aria-orientation="horizontal"
        {...aria}
        onKeyDown={onKeyDown}
        className={cn(
          'flex items-stretch min-w-0 flex-1 overflow-x-auto overflow-y-hidden',
          '[scrollbar-width:thin] [&::-webkit-scrollbar]:h-1',
          variant === 'panel' && 'gap-1 px-2',
          variant === 'sub' && 'gap-1 px-2',
        )}
      >
        {items.map((t) => (
          <TabButton
            key={t.id}
            t={t}
            active={t.id === value}
            variant={variant}
            idPrefix={idPrefix}
            onSelect={() => onValueChange(t.id)}
            onClose={onClose}
            onContextMenu={onTabContextMenu}
            onDoubleClick={onTabDoubleClick}
          />
        ))}
      </div>
      {showOverflow && (
        <>
          <button type="button"
            ref={allBtn}
            aria-label="All tabs"
            aria-haspopup="dialog"
            aria-expanded={allOpen}
            onClick={() => setAllOpen((o) => !o)}
            className="shrink-0 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent border-l border-border"
          >
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
          </button>
          <Popover open={allOpen} onOpenChange={setAllOpen} anchor={allBtn.current} placement="bottom-end" aria-label="All tabs" className="w-[320px] p-1">
            {/* One Escape closes the whole popover (the Combobox would only collapse its list). */}
            <div
              className="contents"
              onKeyDownCapture={(e) => {
                if (e.key !== 'Escape' || e.nativeEvent.isComposing) return
                e.preventDefault()
                e.stopPropagation()
                setAllOpen(false)
                allBtn.current?.focus()
              }}
            >
            <Combobox
              items={items}
              getKey={(t) => t.id}
              getLabel={(t) => t.label}
              filter={(t, q) => (t.label + ' ' + (t.title ?? '') + ' ' + (t.connection?.name ?? '')).toLowerCase().includes(q.trim().toLowerCase())}
              renderItem={(t) => (
                <>
                  <span className="w-3 shrink-0 inline-flex justify-center text-primary">
                    {t.id === value && <Check size={12} strokeWidth={2} aria-hidden />}
                  </span>
                  {t.objectClass || t.kind ? <ObjectIcon objectClass={t.objectClass} kind={t.kind} status={t.status} /> : renderIcon(t.icon, 14)}
                  <span className={cn('truncate', t.preview && 'italic', t.id === value && 'font-medium')}>{t.label}</span>
                  {t.id === value && <span className="sr-only">(active tab)</span>}
                  {t.connection && <span className="shrink-0 text-xs text-muted-foreground">{t.connection.marker}</span>}
                  {t.dirty && (
                    <span className="size-2 rounded-full bg-foreground shrink-0">
                      <span className="sr-only">(unsaved changes)</span>
                    </span>
                  )}
                  {t.title && <span className="ml-auto pl-2 truncate text-xs text-muted-foreground font-mono max-w-[50%]">{t.title}</span>}
                </>
              )}
              onSelect={(t) => {
                setAllOpen(false)
                focusTab(t.id)
              }}
              clearOnSelect
              autoFocus
              placeholder="Filter open tabs"
              aria-label="Filter open tabs"
            />
            </div>
          </Popover>
        </>
      )}
      {end && <div className="flex items-center gap-0.5 px-1 shrink-0">{end}</div>}
    </div>
  )
}

function TabButton({
  t,
  active,
  variant,
  idPrefix,
  onSelect,
  onClose,
  onContextMenu,
  onDoubleClick,
}: {
  t: TabItem
  active: boolean
  variant: 'editor' | 'panel' | 'sub'
  idPrefix: string
  onSelect: () => void
  onClose?: (id: string) => void
  onContextMenu?: (e: ReactMouseEvent<HTMLElement>, id: string) => void
  onDoubleClick?: (id: string) => void
}) {
  const closable = !!onClose && t.closable !== false && variant === 'editor'
  const dot = t.status ? STATUS_DOT[t.status] : undefined
  const glyph = t.state ? STATE_GLYPH[t.state] : undefined
  const tip = variant === 'editor' ? tabTip(t) : []
  // The tooltip (DN, connection, status) is also the tab's accessible description (tooltips are not exposed on their own).
  const descId = variant === 'editor' && tip.length ? `${tabDomId(idPrefix, t.id)}-desc` : undefined
  const tab = (
    <button type="button"
      role="tab"
      id={tabDomId(idPrefix, t.id)}
      aria-selected={active}
      aria-controls={panelDomId(idPrefix, t.id)}
      aria-describedby={descId}
      tabIndex={active && !t.disabled ? 0 : -1}
      // aria-disabled (not disabled): the tab keeps its tooltip (`hint`) on hover.
      aria-disabled={t.disabled || undefined}
      onClick={t.disabled ? undefined : onSelect}
      onAuxClick={(e) => {
        if (e.button === 1 && closable) {
          e.preventDefault()
          onClose!(t.id)
        }
      }}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault()
      }}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, t.id) : undefined}
      onDoubleClick={onDoubleClick ? () => onDoubleClick(t.id) : undefined}
      className={cn(
        'flex items-center gap-1.5 min-w-0 h-full whitespace-nowrap focus-ring-inset',
        'aria-disabled:text-disabled-foreground aria-disabled:cursor-not-allowed',
        variant === 'editor' && ['pl-3 text-sm', closable ? 'pr-1' : 'pr-3'],
        variant === 'panel' && 'px-2 text-xs uppercase tracking-wide font-semibold',
        variant === 'sub' && 'px-2 text-sm',
        variant !== 'editor' && [
          'relative',
          active ? 'text-foreground font-medium after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:bg-primary' : !t.disabled && 'text-muted-foreground hover:text-foreground',
        ],
      )}
    >
      {variant === 'editor' && (t.objectClass || t.kind) ? (
        <ObjectIcon objectClass={t.objectClass} kind={t.kind} />
      ) : (
        renderIcon(t.icon, 14)
      )}
      <span className={cn('truncate', variant === 'editor' && 'max-w-[160px]', t.preview && 'italic', (t.state === 'deleted' || t.state === 'missing') && 'line-through decoration-muted-foreground')}>{t.label}</span>
      {t.preview && <span className="sr-only">(preview)</span>}
      {t.connection && (
        <span className="shrink-0 max-w-[96px] truncate text-xs text-muted-foreground font-normal">
          <span className="sr-only">(connection </span>
          {t.connection.marker}
          <span className="sr-only">)</span>
        </span>
      )}
      {glyph && (
        <span className={cn('inline-flex shrink-0', t.state === 'deleted' ? 'text-destructive' : 'text-warning')}>
          <glyph.Icon size={12} strokeWidth={1.75} aria-hidden />
          <span className="sr-only">({glyph.text})</span>
        </span>
      )}
      {t.stale && !glyph && (
        <span className="inline-flex shrink-0 text-muted-foreground">
          <CloudOff size={12} strokeWidth={1.75} aria-hidden />
          <span className="sr-only">(not connected, values may be out of date)</span>
        </span>
      )}
      {t.status === 'disabled' && (
        <span className="inline-flex shrink-0 text-muted-foreground">
          <UserX size={12} strokeWidth={1.75} aria-hidden />
          <span className="sr-only">(account disabled)</span>
        </span>
      )}
      {dot && (
        <span className={cn('size-1.5 rounded-full shrink-0', dot.cls)}>
          <span className="sr-only">({dot.text})</span>
        </span>
      )}
      {t.count !== undefined && <CountBadge count={t.count} />}
      {t.dirty && !closable && (
        <span className="size-2 rounded-full bg-foreground shrink-0">
          <span className="sr-only">(unsaved changes)</span>
        </span>
      )}
      {t.dirty && closable && <span className="sr-only">(unsaved changes)</span>}
    </button>
  )
  if (variant !== 'editor') {
    return t.hint ? <Tooltip content={t.hint}>{tab}</Tooltip> : tab
  }
  return (
    <div
      role="presentation"
      className={cn(
        'group relative flex items-center min-w-0 max-w-[240px] h-full border-r border-border shrink-0',
        active
          ? 'bg-background text-foreground font-medium shadow-[inset_0_2px_0_0_var(--color-primary)]'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {tip.length ? (
        <Tooltip
          content={
            <span className="block">
              {tip.map((line, i) => (
                <span key={i} className={cn('block', i === 0 && t.title ? 'font-mono' : 'text-muted-foreground')}>{line}</span>
              ))}
            </span>
          }
          placement="bottom-start"
        >
          {tab}
        </Tooltip>
      ) : (
        tab
      )}
      {descId && (
        <span id={descId} hidden>
          {tip.join('. ')}
        </span>
      )}
      {closable && (
        <span className="relative size-5 mr-1 shrink-0">
          {/* Dirty: a dot in the close slot on every tab (also the active one, VS Code
              style); it turns into the X while the pointer is over the tab. */}
          {t.dirty && <span aria-hidden className="absolute inset-0 m-auto size-2 rounded-full bg-foreground group-hover:hidden" />}
          <button type="button"
            tabIndex={-1}
            aria-label={`Close ${t.label}${t.dirty ? ' (unsaved changes)' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              onClose!(t.id)
            }}
            className={cn(
              'absolute inset-0 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent',
              // visibility, not opacity: the transitional T3 rule reveals group-hover:opacity-100 on focus-within.
              t.dirty
                ? 'invisible group-hover:visible'
                : active
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
            )}
          >
            <X size={12} strokeWidth={1.75} aria-hidden />
          </button>
        </span>
      )}
    </div>
  )
}

export interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  idPrefix: string
  value: string
  /** Currently selected tab id (panel is hidden otherwise, but stays mounted). */
  selected: string | null
  /** Unmount instead of hiding when not selected. */
  lazy?: boolean
}

export function TabPanel({ idPrefix, value, selected, lazy, className, children, ...rest }: TabPanelProps) {
  const hidden = selected !== value
  if (hidden && lazy) return null
  return (
    <div
      role="tabpanel"
      id={panelDomId(idPrefix, value)}
      aria-labelledby={tabDomId(idPrefix, value)}
      hidden={hidden}
      tabIndex={-1}
      className={cn('focus-ring-inset', className)}
      {...rest}
    >
      {children}
    </div>
  )
}
