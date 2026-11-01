/**
 * Menu family (SPEC 6.3): Menu popup, MenuItem, MenuCheckboxItem,
 * MenuRadioGroup/MenuRadioItem, MenuSeparator, MenuHeader, SubMenu,
 * DropdownMenu, ContextMenu, MenuBar, plus CommandMenuItems (items
 * generated from the command registry).
 *
 * Keyboard: opening focuses the first item; Up/Down/Home/End; type-ahead;
 * Enter/Space activate; Right opens a submenu, Left closes it; Escape closes
 * and returns focus to the trigger; Tab closes. MenuBar: Alt (tap) or F10
 * focuses it, Left/Right move between menus, mnemonics underline while Alt
 * is held, Alt+letter opens a menu (not on macOS, where Option+letter types
 * characters; F10 still works there). Zoom-aware and clamped (useAnchoredPosition).
 *
 * Keyboard focus on items is the inset 2px `focus` outline (focus-ring-inset,
 * SPEC 4.6); the accent fill marks the pointer/active item.
 */
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { ArrowRightLeft, Check, ChevronRight, Circle, Lock } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Portal, focusScopeOf, focusWhenReady, restoreFocus, toLayerPoint, useAnchoredPosition, useOverlayZ, type Placement } from './layer'
import { useDismiss } from './useDismiss'
import { renderIcon, type IconType } from './Button'
import { Kbd } from './Kbd'
import { IS_MAC } from './shortcuts'
import { isTypeaheadKey, typeaheadMatch } from './menuTypeahead'
import {
  getCommand,
  isModalOpen,
  resolveCommands,
  resolveOne,
  runCommand,
  useCommandRegistryVersion,
  type CommandContext,
  type CommandGroup,
  type ResolvedCommand,
} from './commands'
import { stabilizeItems } from '../commands/menuStability'

// --- Context ------------------------------------------------------------------

interface MenuContextValue {
  /** Close the whole menu tree; focus returns to the trigger when `restore`. */
  closeAll: (restore?: boolean) => void
  /** Close this (sub)menu only (focus goes back to its parent item). */
  closeSelf: () => void
  isSubmenu: boolean
  openSub: string | null
  setOpenSub: (id: string | null) => void
  /** Root dropdown of a MenuBar: Left/Right switch to the adjacent menu. */
  navigateSibling?: (dir: 1 | -1) => void
  /** z-index class of the root popup; submenus stack at the same level. */
  zClass: string
}
const MenuContext = createContext<MenuContextValue | null>(null)

const ITEM_SELECTOR = '[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]'

function itemsOf(el: HTMLElement | null): HTMLElement[] {
  if (!el) return []
  return [...el.querySelectorAll<HTMLElement>(ITEM_SELECTOR)].filter((i) => i.closest('[role="menu"]') === el)
}

function itemText(el: HTMLElement) {
  return (el.dataset.label ?? el.textContent ?? '').trim().toLowerCase()
}

// --- Popup --------------------------------------------------------------------

export interface MenuPopupProps {
  anchor?: HTMLElement | null
  /** Layer coordinates (toLayerPoint). */
  point?: { x: number; y: number } | null
  placement?: Placement
  /** 'first' | 'last' item, or 'none' (keep focus on the menu itself). */
  autoFocus?: 'first' | 'last' | 'none'
  onClose: (restore: boolean) => void
  isSubmenu?: boolean
  navigateSibling?: (dir: 1 | -1) => void
  /** Ignore outside clicks on these elements (the trigger). */
  ignore?: () => (HTMLElement | null)[]
  label?: string
  labelledBy?: string
  className?: string
  minWidth?: number
  /** z-index class override (MenuBar dropdowns use z-(--z-menubar)); submenus inherit it. */
  zIndexClass?: string
  children: ReactNode
}

/** The positioned role=menu list. Used by every menu surface. */
export function MenuPopup({
  anchor,
  point,
  placement = 'bottom-start',
  autoFocus = 'first',
  onClose,
  isSubmenu = false,
  navigateSibling,
  ignore,
  label,
  labelledBy,
  className,
  minWidth = 200,
  zIndexClass,
  children,
}: MenuPopupProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const parent = useContext(MenuContext)
  const overlayZ = useOverlayZ()
  const z = zIndexClass ?? parent?.zClass ?? overlayZ
  const pos = useAnchoredPosition({ anchor, point, placement, offset: isSubmenu ? -2 : 2 })
  const [openSub, setOpenSub] = useState<string | null>(null)
  const typeahead = useRef({ buf: '', t: 0 })

  const closeAll = useCallback(
    (restore = true) => {
      if (parent) parent.closeAll(restore)
      else onClose(restore)
    },
    [parent, onClose],
  )
  const closeSelf = useCallback(() => onClose(true), [onClose])

  useDismiss(ref, () => closeAll(false), { escape: false, outside: !isSubmenu, ignore })

  // Focus the first/last item once positioned.
  useLayoutEffect(() => {
    if (!pos.ready) return
    const items = itemsOf(ref.current)
    const target = autoFocus === 'none' || !items.length ? ref.current : autoFocus === 'last' ? items[items.length - 1] : items[0]
    // Retry only while focus has not moved somewhere else in the meantime.
    const before = document.activeElement
    focusWhenReady(target, () => document.activeElement === before || document.activeElement === document.body)
    // Only on first ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos.ready])

  const focusItem = (items: HTMLElement[], i: number) => {
    const n = items.length
    if (!n) return
    items[((i % n) + n) % n].focus()
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = itemsOf(ref.current)
    const cur = items.indexOf(document.activeElement as HTMLElement)
    const target = document.activeElement as HTMLElement | null
    const hasSub = target?.getAttribute('aria-haspopup') === 'menu'
    let handled = true
    switch (e.key) {
      case 'ArrowDown':
        focusItem(items, cur + 1)
        break
      case 'ArrowUp':
        focusItem(items, cur < 0 ? items.length - 1 : cur - 1)
        break
      case 'Home':
      case 'PageUp':
        focusItem(items, 0)
        break
      case 'End':
      case 'PageDown':
        focusItem(items, items.length - 1)
        break
      case 'ArrowRight':
        if (hasSub && cur >= 0) target!.click()
        else if (!isSubmenu && navigateSibling) navigateSibling(1)
        break
      case 'ArrowLeft':
        if (isSubmenu) closeSelf()
        else if (navigateSibling) navigateSibling(-1)
        break
      case 'Escape':
        if (isSubmenu) closeSelf()
        else onClose(true)
        break
      case 'Tab':
        closeAll(true)
        break
      case 'Enter':
      case ' ':
        if (cur >= 0) target!.click()
        break
      default:
        handled = false
        // Type-ahead (DEF-10): the next item starting with the typed text; the same letter cycles.
        if (isTypeaheadKey(e)) {
          const labels = items.map((it) => ({ label: itemText(it), disabled: it.getAttribute('aria-disabled') === 'true' }))
          const m = typeaheadMatch(labels, cur, typeahead.current, e.key, Date.now())
          typeahead.current = m.state
          if (m.index >= 0) items[m.index].focus()
          handled = true
        }
    }
    if (handled) {
      e.preventDefault()
      // Navigation ends a type-ahead run.
      if (e.key.length !== 1) typeahead.current.buf = ''
    }
    // Menus are leaf UIs: never let keys reach the tree/editor (or a parent menu) behind them.
    e.stopPropagation()
  }

  return (
    <MenuContext.Provider value={{ closeAll, closeSelf, isSubmenu, openSub, setOpenSub, navigateSibling: isSubmenu ? undefined : navigateSibling, zClass: z }}>
      <Portal>
        <div
          ref={(el) => {
            ref.current = el
            pos.ref(el)
          }}
          role="menu"
          aria-label={label}
          aria-labelledby={labelledBy}
          aria-orientation="vertical"
          tabIndex={-1}
          style={{ ...pos.style, minWidth }}
          onKeyDown={onKeyDown}
          onContextMenu={(e) => e.preventDefault()}
          className={cn(
            z,
            'py-1 overflow-y-auto overscroll-contain outline-hidden select-none',
            'bg-popover text-popover-foreground border border-border-strong/60 rounded-md shadow-popover text-sm',
            pos.ready && 'animate-in fade-in',
            className,
          )}
        >
          {children}
        </div>
      </Portal>
    </MenuContext.Provider>
  )
}

// --- Items --------------------------------------------------------------------

const itemBase = [
  'relative flex items-center gap-2 h-6 mx-1 px-2 rounded-sm cursor-default whitespace-nowrap focus-ring-inset',
  'focus:bg-accent focus:text-accent-foreground',
]

function useItemHover(disabledSub = true) {
  const ctx = useContext(MenuContext)
  return {
    ctx,
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType === 'touch') return
      if (document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true })
      if (disabledSub && ctx?.openSub) ctx.setOpenSub(null)
    },
  }
}

export interface MenuItemProps {
  icon?: IconType | ReactNode
  label: ReactNode
  /** Plain text for type-ahead when `label` is not a string. */
  textValue?: string
  shortcut?: string
  tone?: 'default' | 'danger'
  disabled?: boolean
  /** Bold default verb (Open). */
  default?: boolean
  /** Muted text after the label. */
  hint?: ReactNode
  onSelect?: () => void
  /** Keep the menu open after selecting. */
  keepOpen?: boolean
  className?: string
}

export function MenuItem({ icon, label, textValue, shortcut, tone = 'default', disabled, default: isDefault, hint, onSelect, keepOpen, className }: MenuItemProps) {
  const { ctx, onPointerMove } = useItemHover()
  const select = () => {
    if (disabled) return
    if (!keepOpen) ctx?.closeAll(true)
    onSelect?.()
  }
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      data-label={textValue ?? (typeof label === 'string' ? label : undefined)}
      onClick={select}
      onPointerMove={onPointerMove}
      className={cn(
        itemBase,
        tone === 'danger' && !disabled && 'text-destructive focus:text-destructive',
        disabled && 'text-disabled-foreground focus:text-disabled-foreground',
        className,
      )}
    >
      <span className={cn('w-3.5 flex justify-center shrink-0', !disabled && tone !== 'danger' && 'text-muted-foreground')}>{renderIcon(icon, 14)}</span>
      <span className={cn('flex-1 min-w-0 truncate', isDefault && 'font-semibold')}>{label}</span>
      {hint && <span className="text-xs text-muted-foreground truncate max-w-[180px]">{hint}</span>}
      {shortcut && <Kbd shortcut={shortcut} bare className={cn('ml-6', disabled && 'text-disabled-foreground')} />}
    </div>
  )
}

export interface MenuCheckboxItemProps extends Omit<MenuItemProps, 'icon' | 'onSelect' | 'default'> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

export function MenuCheckboxItem({ checked, onCheckedChange, label, textValue, shortcut, disabled, hint, keepOpen, className }: MenuCheckboxItemProps) {
  const { ctx, onPointerMove } = useItemHover()
  return (
    <div
      role="menuitemcheckbox"
      aria-checked={checked}
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      data-label={textValue ?? (typeof label === 'string' ? label : undefined)}
      onClick={() => {
        if (disabled) return
        if (!keepOpen) ctx?.closeAll(true)
        onCheckedChange(!checked)
      }}
      onPointerMove={onPointerMove}
      className={cn(itemBase, disabled && 'text-disabled-foreground', className)}
    >
      <span className="w-3.5 flex justify-center shrink-0">{checked && <Check size={14} strokeWidth={2} aria-hidden />}</span>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      {shortcut && <Kbd shortcut={shortcut} bare className="ml-6" />}
    </div>
  )
}

interface RadioCtx {
  value: string
  onValueChange: (v: string) => void
}
const MenuRadioContext = createContext<RadioCtx | null>(null)

export function MenuRadioGroup({ value, onValueChange, label, children }: { value: string; onValueChange: (v: string) => void; label?: string; children: ReactNode }) {
  return (
    <MenuRadioContext.Provider value={{ value, onValueChange }}>
      <div role="group" aria-label={label}>
        {children}
      </div>
    </MenuRadioContext.Provider>
  )
}

export function MenuRadioItem({ value, label, textValue, shortcut, disabled, hint, keepOpen, className }: Omit<MenuItemProps, 'icon' | 'onSelect' | 'default'> & { value: string }) {
  const r = useContext(MenuRadioContext)
  const { ctx, onPointerMove } = useItemHover()
  const checked = r?.value === value
  return (
    <div
      role="menuitemradio"
      aria-checked={checked}
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      data-label={textValue ?? (typeof label === 'string' ? label : undefined)}
      onClick={() => {
        if (disabled) return
        if (!keepOpen) ctx?.closeAll(true)
        r?.onValueChange(value)
      }}
      onPointerMove={onPointerMove}
      className={cn(itemBase, disabled && 'text-disabled-foreground', className)}
    >
      <span className="w-3.5 flex justify-center shrink-0">{checked && <Circle size={7} fill="currentColor" strokeWidth={0} aria-hidden />}</span>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      {shortcut && <Kbd shortcut={shortcut} bare className="ml-6" />}
    </div>
  )
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-border" />
}

/** Non-interactive heading (a DN, "Read-only connection"). */
export function MenuHeader({ children, mono, icon, className }: { children: ReactNode; mono?: boolean; icon?: IconType | ReactNode; className?: string }) {
  return (
    <div
      role="presentation"
      className={cn(
        'flex items-center gap-2 px-3 pt-1 pb-1 text-xs text-muted-foreground max-w-[360px]',
        mono ? 'font-mono' : 'font-semibold uppercase tracking-wide',
        className,
      )}
    >
      {renderIcon(icon, 12)}
      <span className="truncate">{children}</span>
    </div>
  )
}

export interface SubMenuProps {
  label: ReactNode
  textValue?: string
  icon?: IconType | ReactNode
  disabled?: boolean
  children: ReactNode
}

/** Item that opens a nested menu (hover, Right, Enter, Space, click). */
export function SubMenu({ label, textValue, icon, disabled, children }: SubMenuProps) {
  const id = useId()
  const ctx = useContext(MenuContext)
  const itemRef = useRef<HTMLDivElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [focusMode, setFocusMode] = useState<'first' | 'none'>('first')
  const open = ctx?.openSub === id
  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  const openSub = (viaKeyboard: boolean) => {
    if (disabled) return
    setFocusMode(viaKeyboard ? 'first' : 'none')
    ctx?.setOpenSub(id)
  }
  return (
    <>
      <div
        ref={itemRef}
        role="menuitem"
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={disabled || undefined}
        data-label={textValue ?? (typeof label === 'string' ? label : undefined)}
        onClick={(e) => openSub(e.detail === 0)}
        onPointerMove={(e) => {
          if (e.pointerType === 'touch') return
          if (document.activeElement !== e.currentTarget && !open) e.currentTarget.focus({ preventScroll: true })
          if (!open) {
            clearTimeout(hoverTimer.current)
            hoverTimer.current = setTimeout(() => openSub(false), 120)
          }
        }}
        onPointerLeave={() => clearTimeout(hoverTimer.current)}
        className={cn(itemBase, open && 'bg-accent', disabled && 'text-disabled-foreground')}
      >
        <span className="w-3.5 flex justify-center shrink-0 text-muted-foreground">{renderIcon(icon, 14)}</span>
        <span className="flex-1 min-w-0 truncate">{label}</span>
        <ChevronRight size={12} strokeWidth={1.75} aria-hidden className="ml-4 text-muted-foreground" />
      </div>
      {open && (
        <MenuPopup
          anchor={itemRef.current}
          placement="right-start"
          isSubmenu
          autoFocus={focusMode}
          onClose={() => {
            ctx?.setOpenSub(null)
            itemRef.current?.focus()
          }}
        >
          {children}
        </MenuPopup>
      )}
    </>
  )
}

// --- DropdownMenu ---------------------------------------------------------------

export interface DropdownMenuProps {
  /** One element (Button / IconButton); receives onClick, aria-haspopup, aria-expanded, onKeyDown. */
  trigger: ReactElement
  children: ReactNode | (() => ReactNode)
  placement?: Placement
  label?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  minWidth?: number
  className?: string
}

export function DropdownMenu({ trigger, children, placement = 'bottom-start', label, open: openProp, onOpenChange, minWidth, className }: DropdownMenuProps) {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const anchorRef = useRef<HTMLElement | null>(null)
  const [focusMode, setFocusMode] = useState<'first' | 'last' | 'none'>('first')
  const setOpen = (o: boolean) => {
    if (openProp === undefined) setOpenState(o)
    onOpenChange?.(o)
  }
  const tp = (isValidElement(trigger) ? trigger.props : {}) as {
    onClick?: (e: ReactMouseEvent<HTMLElement>) => void
    onKeyDown?: (e: ReactKeyboardEvent<HTMLElement>) => void
  }
  const t = cloneElement(trigger as ReactElement<Record<string, unknown>>, {
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    onClick: (e: ReactMouseEvent<HTMLElement>) => {
      tp.onClick?.(e)
      anchorRef.current = e.currentTarget
      setFocusMode(e.detail === 0 ? 'first' : 'none')
      setOpen(!open)
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      tp.onKeyDown?.(e)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        anchorRef.current = e.currentTarget
        setFocusMode(e.key === 'ArrowUp' ? 'last' : 'first')
        setOpen(true)
      }
    },
  })
  return (
    <>
      {t}
      {open && (
        <MenuPopup
          anchor={anchorRef.current}
          placement={placement}
          autoFocus={focusMode}
          label={label}
          minWidth={minWidth}
          className={className}
          ignore={() => [anchorRef.current]}
          onClose={(restore) => {
            setOpen(false)
            if (restore) anchorRef.current?.focus()
          }}
        >
          {typeof children === 'function' ? children() : children}
        </MenuPopup>
      )}
    </>
  )
}

// --- ContextMenu ----------------------------------------------------------------

/** Client point for a context menu: the mouse position, or below the focused element for Shift+F10 / the Menu key. */
export function contextMenuPoint(e: { clientX?: number; clientY?: number; currentTarget?: EventTarget | null; target?: EventTarget | null }): { clientX: number; clientY: number } {
  if (typeof e.clientX === 'number' && typeof e.clientY === 'number' && (e.clientX !== 0 || e.clientY !== 0)) {
    return { clientX: e.clientX, clientY: e.clientY }
  }
  const el = (document.activeElement as HTMLElement | null) ?? (e.target as HTMLElement | null)
  const r = el?.getBoundingClientRect()
  return r ? { clientX: r.left + Math.min(24, r.width / 2), clientY: r.bottom } : { clientX: 0, clientY: 0 }
}

/** True for Shift+F10 and the ContextMenu key. */
export function isContextMenuKey(e: { key: string; shiftKey: boolean }) {
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)
}

export interface ContextMenuProps {
  /** Client coordinates (MouseEvent clientX/Y or contextMenuPoint()); null = closed. */
  point: { clientX: number; clientY: number } | null
  onClose: () => void
  label?: string
  children: ReactNode | (() => ReactNode)
  minWidth?: number
}

/**
 * Opened at a pointer position (divided by zoom via toLayerPoint) and clamped
 * inside the wrapper. Focus returns to the element focused before opening,
 * or to its region's current tab stop when an action removed it (Close Tab).
 */
export function ContextMenu({ point, onClose, label, children, minWidth }: ContextMenuProps) {
  const returnTo = useRef<HTMLElement | null>(null)
  const returnScope = useRef<HTMLElement | null>(null)
  const open = !!point
  const layerPoint = point ? toLayerPoint(point.clientX, point.clientY) : null
  useLayoutEffect(() => {
    if (open) {
      returnTo.current = document.activeElement as HTMLElement | null
      returnScope.current = focusScopeOf(returnTo.current)
    }
  }, [open])
  if (!open) return null
  return (
    <MenuPopup
      point={layerPoint}
      placement="bottom-start"
      label={label}
      minWidth={minWidth}
      onClose={(restore) => {
        onClose()
        if (restore) restoreFocus(returnTo.current, returnScope.current)
      }}
    >
      {typeof children === 'function' ? children() : children}
    </MenuPopup>
  )
}

/** State helper: spread `triggerProps` on the target region and render <ContextMenu {...menuProps}>. */
export function useContextMenu<T = undefined>() {
  const [state, setState] = useState<{ point: { clientX: number; clientY: number }; data: T } | null>(null)
  const open = useCallback((e: { clientX?: number; clientY?: number; target?: EventTarget | null; preventDefault?: () => void }, data: T) => {
    e.preventDefault?.()
    setState({ point: contextMenuPoint(e), data })
  }, [])
  const close = useCallback(() => setState(null), [])
  return { point: state?.point ?? null, data: state?.data, open, close }
}

// --- MenuBar --------------------------------------------------------------------

export interface MenuBarMenu {
  id: string
  label: string
  /** Letter for Alt+letter and the Alt underline (default: first letter). */
  mnemonic?: string
  content: () => ReactNode
}

export interface MenuBarProps {
  menus: MenuBarMenu[]
  'aria-label'?: string
  className?: string
  itemClassName?: string
}

const menubarStack: string[] = []

// Registered at module load, i.e. before any capture listener that might stop
// propagation, so an "Alt tap" is reliably told apart from
// Alt+Left, Alt+F etc.
let altDownAt = 0
let otherKeyAt = 0
if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Alt') {
        if (!e.repeat) altDownAt = performance.now()
      } else otherKeyAt = performance.now()
    },
    true,
  )
  window.addEventListener('pointerdown', () => (otherKeyAt = performance.now()), true)
}

/** Application menubar (role=menubar, one tab stop, roving focus). */
export function MenuBar({ menus, className, itemClassName, ...aria }: MenuBarProps) {
  const id = useId()
  const [openId, setOpenId] = useState<string | null>(null)
  const [focusIdx, setFocusIdx] = useState(0)
  const [altHeld, setAltHeld] = useState(false)
  const [focusMode, setFocusMode] = useState<'first' | 'last' | 'none'>('first')
  const barRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const prevFocus = useRef<HTMLElement | null>(null)

  const focusItem = (i: number) => {
    const n = menus.length
    const idx = ((i % n) + n) % n
    setFocusIdx(idx)
    itemRefs.current[idx]?.focus()
    return idx
  }
  /** Leaves the menubar: back to the element focused before, else focus is simply released. */
  const restorePrev = () => {
    const p = prevFocus.current
    prevFocus.current = null
    if (p && p.isConnected && !barRef.current?.contains(p)) {
      p.focus()
      if (document.activeElement === p) return
    }
    const a = document.activeElement as HTMLElement | null
    if (a && barRef.current?.contains(a)) a.blur()
  }
  /** Remembers where focus was (nothing, if it was on <body>: body.focus() is a no-op). */
  const rememberPrev = () => {
    const a = document.activeElement as HTMLElement | null
    if (barRef.current?.contains(a)) return
    prevFocus.current = a && a !== document.body && a !== document.documentElement ? a : null
  }
  /** Alt tap / F10: the first menu ("File") gets focus. */
  const enterBar = () => {
    rememberPrev()
    focusItem(0)
  }

  // Alt tap / F10 / Alt+mnemonic. Only the most recently mounted menubar responds.
  useEffect(() => {
    menubarStack.push(id)
    const top = () => menubarStack[menubarStack.length - 1] === id
    const onDown = (e: KeyboardEvent) => {
      if (!top()) return
      if (e.key === 'Alt') {
        // macOS: Option is a typing modifier, no Alt-menubar convention.
        if (!IS_MAC && !e.ctrlKey && !e.shiftKey && !e.metaKey) setAltHeld(true)
        return
      }
      if (isModalOpen()) return
      if (e.key === 'F10' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault()
        if (barRef.current?.contains(document.activeElement)) {
          setOpenId(null)
          restorePrev()
        } else enterBar()
        return
      }
      // Alt+letter mnemonics: Windows/Linux only (macOS Option+E types €, Option+N ~).
      if (!IS_MAC && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^Key[A-Z]$/.test(e.code)) {
        const letter = e.code.slice(3).toLowerCase()
        const i = menus.findIndex((m) => (m.mnemonic ?? m.label[0]).toLowerCase() === letter)
        if (i >= 0) {
          e.preventDefault()
          rememberPrev()
          setFocusIdx(i)
          setFocusMode('first')
          setOpenId(menus[i].id)
        }
      }
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return
      setAltHeld(false)
      if (IS_MAC) return
      const altAlone = otherKeyAt < altDownAt && !e.ctrlKey && !e.shiftKey && !e.metaKey
      if (!top() || !altAlone) return
      if (isModalOpen()) return
      e.preventDefault()
      if (barRef.current?.contains(document.activeElement)) {
        setOpenId(null)
        restorePrev()
      } else enterBar()
    }
    const onBlur = () => {
      otherKeyAt = performance.now()
      setAltHeld(false)
    }
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      const i = menubarStack.lastIndexOf(id)
      if (i >= 0) menubarStack.splice(i, 1)
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('blur', onBlur)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, menus.map((m) => m.id + (m.mnemonic ?? m.label)).join('|'), focusIdx])

  const openMenu = (i: number, mode: 'first' | 'last' | 'none') => {
    setFocusIdx(i)
    setFocusMode(mode)
    setOpenId(menus[i].id)
  }

  const onItemKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number) => {
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault()
        focusItem(i + 1)
        break
      case 'ArrowLeft':
        e.preventDefault()
        focusItem(i - 1)
        break
      case 'Home':
        e.preventDefault()
        focusItem(0)
        break
      case 'End':
        e.preventDefault()
        focusItem(menus.length - 1)
        break
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        e.preventDefault()
        openMenu(i, 'first')
        break
      case 'ArrowUp':
        e.preventDefault()
        openMenu(i, 'last')
        break
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        restorePrev()
        break
      default: {
        // A letter on the focused menubar (after Alt / F10) opens the menu it underlines (DEF-10).
        if (!isTypeaheadKey(e)) return
        const letter = e.key.toLowerCase()
        const j = menus.findIndex((m) => (m.mnemonic ?? m.label[0]).toLowerCase() === letter)
        if (j < 0) return
        e.preventDefault()
        openMenu(j, 'first')
        itemRefs.current[j]?.focus()
      }
    }
    e.stopPropagation()
  }

  const openIdx = menus.findIndex((m) => m.id === openId)

  return (
    <div
      ref={barRef}
      role="menubar"
      aria-label={aria['aria-label'] ?? 'Application menu'}
      className={cn('flex items-stretch h-full', className)}
      onFocus={(e) => {
        const r = e.relatedTarget
        if (r instanceof HTMLElement && r !== document.body && !barRef.current?.contains(r) && !prevFocus.current) {
          prevFocus.current = r
        }
      }}
    >
      {menus.map((m, i) => {
        const mn = (m.mnemonic ?? m.label[0]).toLowerCase()
        const mi = m.label.toLowerCase().indexOf(mn)
        return (
          <button type="button"
            key={m.id}
            ref={(el) => {
              itemRefs.current[i] = el
            }}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openId === m.id}
            tabIndex={i === focusIdx ? 0 : -1}
            onClick={(e) => {
              if (openId === m.id) setOpenId(null)
              else openMenu(i, e.detail === 0 ? 'first' : 'none')
            }}
            onPointerEnter={() => {
              if (openId && openId !== m.id) openMenu(i, 'none')
            }}
            onKeyDown={(e) => onItemKeyDown(e, i)}
            className={cn(
              'px-2 text-xs rounded-none focus-ring-inset',
              // Open menu: fill + a 2px primary bar (>= 3:1 on every bar colour, SPEC 4.6).
              openId === m.id ? 'bg-accent text-foreground shadow-[inset_0_-2px_0_0_var(--color-primary)]' : 'hover:bg-accent hover:text-foreground',
              itemClassName,
            )}
          >
            {altHeld && mi >= 0 ? (
              <>
                {m.label.slice(0, mi)}
                <span className="underline underline-offset-2">{m.label[mi]}</span>
                {m.label.slice(mi + 1)}
              </>
            ) : (
              m.label
            )}
          </button>
        )
      })}
      {openIdx >= 0 && (
        <MenuPopup
          key={menus[openIdx].id}
          anchor={itemRefs.current[openIdx]}
          placement="bottom-start"
          autoFocus={focusMode}
          label={menus[openIdx].label}
          minWidth={220}
          zIndexClass="z-(--z-menubar)"
          ignore={() => [barRef.current]}
          navigateSibling={(dir) => {
            const next = (openIdx + dir + menus.length) % menus.length
            openMenu(next, 'first')
            itemRefs.current[next]?.focus()
          }}
          onClose={(restore) => {
            setOpenId(null)
            // Escape from the dropdown: back to its menubar item. Choosing an
            // item goes through MenuBarItemsBridge (back to where the user was).
            if (restore) itemRefs.current[openIdx]?.focus()
          }}
        >
          <MenuBarItemsBridge onChosen={restorePrev}>{menus[openIdx].content()}</MenuBarItemsBridge>
        </MenuPopup>
      )}
    </div>
  )
}

/**
 * Inside a menubar dropdown, choosing an item returns focus to where the
 * user was before entering the menubar (not to the menubar item).
 */
function MenuBarItemsBridge({ onChosen, children }: { onChosen: () => void; children: ReactNode }) {
  const ctx = useContext(MenuContext)
  if (!ctx) return <>{children}</>
  const value: MenuContextValue = {
    ...ctx,
    closeAll: (restore = true) => {
      ctx.closeAll(false)
      if (restore) onChosen()
    },
  }
  return <MenuContext.Provider value={value}>{children}</MenuContext.Provider>
}

// --- Commands -------------------------------------------------------------------

export interface CommandMenuItemsProps {
  ctx: CommandContext
  /** Default: the entry groups (ENTRY_COMMAND_GROUPS). */
  group?: CommandGroup | CommandGroup[]
  ids?: string[]
  /** Show the DN of a single selection as a header. */
  showDnHeader?: boolean
  /** No shortcut hints: the verbs are appended to a menu whose keys mean something else (bookmarks: Del removes the bookmark; RW1-R-06). */
  hideShortcuts?: boolean
}

function CommandItem({ rc, ctx }: { rc: ResolvedCommand; ctx: CommandContext }) {
  if (rc.command.submenu) {
    const children = resolveCommands(ctx, { parent: rc.id, surface: 'menu' }).items
    return (
      <SubMenu label={rc.title} icon={rc.command.icon} disabled={!children.length}>
        {children.map((c) => (
          <CommandItem key={c.id} rc={c} ctx={ctx} />
        ))}
      </SubMenu>
    )
  }
  // The handler learns what the item said (stable titles: the server state may differ by now).
  const run = () => runCommand(rc.id, { ...ctx, shownTitle: rc.title })
  if (rc.checked !== undefined) {
    return <MenuCheckboxItem label={rc.title} checked={rc.checked} shortcut={rc.shortcut} disabled={!rc.enabled} onCheckedChange={run} />
  }
  return (
    <MenuItem
      icon={rc.command.icon}
      label={rc.title}
      shortcut={rc.shortcut}
      tone={rc.danger ? 'danger' : 'default'}
      default={rc.isDefault}
      disabled={!rc.enabled}
      hint={!rc.enabled ? rc.disabledReason : undefined}
      onSelect={run}
    />
  )
}

/**
 * Keeps an open command menu from shifting under the pointer while state
 * that arrives after it opened (account status, presence reads) re-resolves
 * it (commands/menuStability.ts); `seen` is the menu instance's memory.
 */
export function stabilizeMenuItems(items: ResolvedCommand[], seen: Map<string, ResolvedCommand>, ctx: CommandContext): ResolvedCommand[] {
  return stabilizeItems(items, seen, (id, section) => {
    const c = getCommand(id)
    return c ? resolveOne(c, ctx, section) : undefined
  })
}

/**
 * Menu items generated from the registry for a context: same verbs, icons
 * and shortcuts on every surface. Write verbs on a read-only connection are
 * replaced by one disabled "Read-only connection" header.
 */
/** Groups of an entry context menu (tree, list, results, tab, Entry menu). */
export const ENTRY_COMMAND_GROUPS: CommandGroup[] = ['entry', 'account', 'membership', 'create']
/** Verbs a menu of an entry of another connection offers next to "Switch to <profile>". */
const FOREIGN_READ_VERBS = ['entry.showInTree', 'entry.copyDn']

export function CommandMenuItems({ ctx, group, ids, showDnHeader, hideShortcuts }: CommandMenuItemsProps) {
  useCommandRegistryVersion()
  const seen = useRef(new Map<string, ResolvedCommand>())
  // A new target (another entry) starts a fresh layout.
  const targetKey = `${ctx.profileId}|${ctx.selection.map((s) => s.dn).join('\n')}`
  const lastTarget = useRef(targetKey)
  if (lastTarget.current !== targetKey) {
    lastTarget.current = targetKey
    seen.current = new Map()
  }
  const resolved = resolveCommands(ctx, { group: group ?? (ids ? undefined : ENTRY_COMMAND_GROUPS), ids, surface: 'menu' })
  const hiddenWrites = resolved.hiddenWrites
  const stable = stabilizeMenuItems(resolved.items, seen.current, ctx)
  const items = hideShortcuts ? stable.map((rc) => ({ ...rc, shortcut: undefined })) : stable
  const out: ReactNode[] = []
  if (!ctx.selection.length && ctx.foreign) {
    // Entries of another connection than the active one: their verbs would run against the
    // wrong directory, so the menu offers the switch (same labels once switched) plus the
    // read verbs that name their own connection (Copy DN, Show in Tree; RW1-C-07).
    const f = ctx.foreign
    const reads = items.filter((rc) => FOREIGN_READ_VERBS.includes(rc.id))
    return (
      <>
        <MenuHeader>{f.count === 1 ? 'Entry of another connection' : `${f.count} entries of another connection`}</MenuHeader>
        {f.count === 1 && f.dns?.[0] && <MenuHeader mono>{f.dns[0]}</MenuHeader>}
        <MenuItem icon={ArrowRightLeft} label={`Switch to ${f.name}`} default onSelect={() => runCommand('connection.switchTo', ctx)} />
        {reads.length > 0 && <MenuSeparator />}
        {reads.map((rc) => (
          <CommandItem key={rc.id} rc={rc} ctx={ctx} />
        ))}
      </>
    )
  }
  if (showDnHeader && ctx.selection.length === 1) {
    out.push(
      <MenuHeader key="dn" mono>
        {ctx.selection[0].dn}
      </MenuHeader>,
    )
  } else if (showDnHeader && ctx.selection.length > 1) {
    out.push(<MenuHeader key="n">{ctx.selection.length} entries selected</MenuHeader>)
  }
  if (hiddenWrites > 0) {
    out.push(
      <MenuHeader key="ro" icon={Lock}>
        {ctx.offline && !ctx.readOnly ? 'Connection lost: reconnect to edit' : 'Read-only connection'}
      </MenuHeader>,
    )
  }
  if (out.length && items.length) out.push(<MenuSeparator key="hsep" />)
  let prev: string | null = null
  for (const rc of items) {
    if (prev !== null && rc.section !== prev) out.push(<MenuSeparator key={`sep-${rc.id}`} />)
    prev = rc.section
    out.push(<CommandItem key={rc.id} rc={rc} ctx={ctx} />)
  }
  if (!items.length) out.push(<MenuItem key="none" label="No actions available" disabled />)
  return <>{Children.toArray(out)}</>
}
