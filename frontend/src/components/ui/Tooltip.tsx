/**
 * Tooltip (SPEC 6.4): ONE portal instance (<TooltipHost/>, mounted next to
 * LayerHost). 500 ms delay, instant between triggers, hidden on pointerdown
 * and keydown, shown on keyboard focus. A click suppresses the tooltip of
 * that trigger until the pointer leaves it (rail tooltips must not cover the
 * panel that just opened). Content = label + optional Kbd shortcut.
 *
 * Accessibility: while shown, the trigger gets aria-describedby="ui-tooltip"
 * when the tip says more than the trigger's own name (a DN, an error, dates),
 * so the text is not visual-only. The tip is hoverable (WCAG 1.4.13): moving
 * the pointer from the trigger onto it keeps it open; Escape (any key) hides it.
 */
import {
  cloneElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { cn } from '../../lib/utils'
import { Portal, useAnchoredPosition, type Placement } from './layer'
import { Kbd } from './Kbd'

interface TipState {
  anchor: HTMLElement | null
  content: ReactNode
  shortcut?: string
  placement: Placement
}

const SHOW_DELAY = 500
const SKIP_DELAY = 300
/** Grace period to move the pointer from the trigger onto the tip. */
const HIDE_DELAY = 150
const TIP_ID = 'ui-tooltip'

let tip: TipState = { anchor: null, content: null, placement: 'bottom' }
const listeners = new Set<() => void>()
let showTimer: ReturnType<typeof setTimeout> | undefined
let hideTimer: ReturnType<typeof setTimeout> | undefined
let lastHiddenAt = 0
let suppressed: HTMLElement | null = null
let globalsInstalled = false

function setTip(next: TipState) {
  tip = next
  listeners.forEach((l) => l())
}

/**
 * Whether the latest key moves focus (Tab, arrows, Home/End): a focus tooltip is for
 * someone walking the UI with the keyboard, not for focus a command put there (Enter in
 * the palette focusing the new tab: its tooltip covered the editor toolbar, RW1-E-05).
 */
let lastKeyMovesFocus = false
const NAV_KEYS = new Set(['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'F6'])

function installGlobals() {
  if (globalsInstalled || typeof document === 'undefined') return
  globalsInstalled = true
  document.addEventListener(
    'keydown',
    (e) => {
      lastKeyMovesFocus = NAV_KEYS.has(e.key)
      hideTooltip()
    },
    true,
  )
  document.addEventListener(
    'pointerdown',
    (e) => {
      // Pressing inside the tip (selecting its text) keeps it.
      if (e.target instanceof Element && e.target.closest(`#${TIP_ID}`)) return
      if (tip.anchor && e.target instanceof Node && tip.anchor.contains(e.target)) suppressed = tip.anchor
      lastKeyMovesFocus = false
      hideTooltip()
    },
    true,
  )
  window.addEventListener('blur', () => hideTooltip())
}

export interface TooltipOptions {
  shortcut?: string
  placement?: Placement
  disabled?: boolean
  /** Show only when this returns true at trigger time (TruncatedText: only if truncated). */
  condition?: (el: HTMLElement) => boolean
}

export function showTooltip(anchor: HTMLElement, content: ReactNode, opts: TooltipOptions = {}, immediate = false) {
  installGlobals()
  if (opts.disabled || content == null || content === '' || suppressed === anchor) return
  if (opts.condition && !opts.condition(anchor)) return
  clearTimeout(showTimer)
  clearTimeout(hideTimer)
  const next: TipState = { anchor, content, shortcut: opts.shortcut, placement: opts.placement ?? 'bottom' }
  const instant = immediate || !!tip.anchor || Date.now() - lastHiddenAt < SKIP_DELAY
  if (instant) setTip(next)
  else showTimer = setTimeout(() => setTip(next), SHOW_DELAY)
}

export function hideTooltip(anchor?: HTMLElement) {
  clearTimeout(showTimer)
  clearTimeout(hideTimer)
  if (anchor && tip.anchor && tip.anchor !== anchor) return
  if (tip.anchor) {
    lastHiddenAt = Date.now()
    setTip({ ...tip, anchor: null })
  }
}

/** Hide after a short grace period, unless the pointer reaches the tip (or the trigger) again. */
function hideTooltipSoon(anchor: HTMLElement) {
  clearTimeout(showTimer)
  if (tip.anchor !== anchor) return
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => hideTooltip(anchor), HIDE_DELAY)
}

export interface TooltipTriggerProps {
  onPointerEnter: (e: PointerEvent<HTMLElement>) => void
  onPointerLeave: (e: PointerEvent<HTMLElement>) => void
  onFocus: (e: FocusEvent<HTMLElement>) => void
  onBlur: (e: FocusEvent<HTMLElement>) => void
}

/** Event props for a trigger element. */
export function tooltipTriggerProps(content: ReactNode, opts: TooltipOptions = {}): TooltipTriggerProps {
  return {
    onPointerEnter: (e) => {
      if (e.pointerType === 'touch') return
      showTooltip(e.currentTarget, content, opts)
    },
    onPointerLeave: (e) => {
      if (suppressed === e.currentTarget) suppressed = null
      if (tip.anchor === e.currentTarget) hideTooltipSoon(e.currentTarget)
      else hideTooltip(e.currentTarget)
    },
    onFocus: (e) => {
      let kb = true
      try { kb = e.currentTarget.matches(':focus-visible') } catch { /* old engines */ }
      if (kb && lastKeyMovesFocus) showTooltip(e.currentTarget, content, opts, true)
    },
    onBlur: (e) => hideTooltip(e.currentTarget),
  }
}

function chain<E>(a: ((e: E) => void) | undefined, b: (e: E) => void) {
  return (e: E) => {
    a?.(e)
    b(e)
  }
}

export interface TooltipProps extends TooltipOptions {
  content: ReactNode
  children: ReactElement
}

/** Wraps ONE element child and adds the tooltip event handlers to it. */
export function Tooltip({ content, children, ...opts }: TooltipProps) {
  if (!isValidElement(children)) return children
  const p = children.props as Partial<TooltipTriggerProps>
  const t = tooltipTriggerProps(content, opts)
  return cloneElement(children as ReactElement<Partial<TooltipTriggerProps>>, {
    onPointerEnter: chain(p.onPointerEnter, t.onPointerEnter),
    onPointerLeave: chain(p.onPointerLeave, t.onPointerLeave),
    onFocus: chain(p.onFocus, t.onFocus),
    onBlur: chain(p.onBlur, t.onBlur),
  })
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

function accessibleName(el: HTMLElement): string {
  const label = el.getAttribute('aria-label')
  if (label) return label
  const by = el.getAttribute('aria-labelledby')
  if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
  return el.textContent ?? ''
}
const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase()

/** The single tooltip surface. Mount once (AppLayout), next to <LayerHost/>. */
export function TooltipHost() {
  const s = useSyncExternalStore(subscribe, () => tip, () => tip)
  const open = !!s.anchor
  const pos = useAnchoredPosition({ anchor: s.anchor, placement: s.placement, offset: 6, open })
  const tipRef = useRef<HTMLDivElement | null>(null)

  // Expose the tip as the trigger's description while it is shown, when it adds information.
  useLayoutEffect(() => {
    const anchor = s.anchor
    const el = tipRef.current
    if (!anchor || !el) return
    const text = norm(el.querySelector('[data-tip-content]')?.textContent ?? '')
    if (!text || norm(accessibleName(anchor)).includes(text)) return
    const ids = (anchor.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    if (ids.includes(TIP_ID)) return
    // Already described by the same text (editor tabs carry their DN as a static description).
    if (ids.some((id) => norm(document.getElementById(id)?.textContent ?? '') === text)) return
    anchor.setAttribute('aria-describedby', [...ids, TIP_ID].join(' '))
    return () => {
      const cur = (anchor.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id && id !== TIP_ID)
      if (cur.length) anchor.setAttribute('aria-describedby', cur.join(' '))
      else anchor.removeAttribute('aria-describedby')
    }
  }, [s.anchor, s.content])

  useEffect(() => {
    installGlobals()
    if (!open) return
    const t = setInterval(() => {
      if (tip.anchor && !tip.anchor.isConnected) hideTooltip()
    }, 400)
    return () => clearInterval(t)
  }, [open])

  if (!open) return null
  return (
    <Portal>
      <div
        ref={(el) => {
          tipRef.current = el
          pos.ref(el)
        }}
        role="tooltip"
        id={TIP_ID}
        style={{ ...pos.style, maxHeight: undefined }}
        // Hoverable: the pointer may move onto the tip (to read or select it) without it closing.
        onPointerEnter={() => clearTimeout(hideTimer)}
        onPointerLeave={() => {
          if (tip.anchor) hideTooltipSoon(tip.anchor)
        }}
        className={cn(
          'z-(--z-tooltip) max-w-[360px] px-2 py-1 rounded-md select-text',
          'bg-popover text-popover-foreground border border-border-strong shadow-popover',
          'text-xs leading-4 break-words flex items-center gap-2',
          pos.ready && 'animate-in fade-in',
        )}
      >
        <span className="min-w-0" data-tip-content="">
          {s.content}
        </span>
        {s.shortcut && <Kbd shortcut={s.shortcut} />}
      </div>
    </Portal>
  )
}
