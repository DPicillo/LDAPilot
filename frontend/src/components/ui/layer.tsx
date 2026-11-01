/**
 * Overlay infrastructure (SPEC 6.2).
 *
 * Every overlay (menu, popover, tooltip, dialog) renders through <Portal> into
 * <LayerHost/>, which AppLayout mounts INSIDE `.zoom-wrapper`. The wrapper is
 * transformed (`transform: scale(zoom)`), so it is the containing block of
 * `position: fixed` descendants: fixed coordinates and % sizes are in the
 * wrapper's own, unscaled CSS px. Pointer coordinates (clientX/Y) are scaled
 * viewport px and must go through toLayerPoint() first. Sizes are measured,
 * never estimated.
 */
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

// --- Host registry ---------------------------------------------------------

let hostEl: HTMLElement | null = null
const hostListeners = new Set<() => void>()
function setHost(el: HTMLElement | null) {
  hostEl = el
  hostListeners.forEach((l) => l())
}
function subscribeHost(l: () => void) {
  hostListeners.add(l)
  return () => hostListeners.delete(l)
}

/** The transformed zoom wrapper, or null outside the app shell (tests, gallery without App). */
export function getWrapper(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.zoom-wrapper')
}

/** Current scale of the wrapper, measured (rendered width / layout width). */
export function getZoom(): number {
  const w = getWrapper()
  if (!w || !w.offsetWidth) return 1
  const z = w.getBoundingClientRect().width / w.offsetWidth
  return z > 0 && Number.isFinite(z) ? z : 1
}

/** Converts viewport coordinates (MouseEvent clientX/Y) into layer (unscaled wrapper) coordinates. */
export function toLayerPoint(clientX: number, clientY: number): { x: number; y: number } {
  const w = getWrapper()
  if (!w) return { x: clientX, y: clientY }
  const r = w.getBoundingClientRect()
  const z = getZoom()
  return { x: (clientX - r.left) / z, y: (clientY - r.top) / z }
}

export interface LayerRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

/** A viewport DOMRect (getBoundingClientRect) in layer coordinates. */
export function toLayerRect(rect: DOMRect | LayerRect): LayerRect {
  const a = toLayerPoint(rect.left, rect.top)
  const b = toLayerPoint(rect.right, rect.bottom)
  return { left: a.x, top: a.y, right: b.x, bottom: b.y, width: b.x - a.x, height: b.y - a.y }
}

/** Layer (wrapper) size in unscaled CSS px. */
export function getLayerSize(): { width: number; height: number } {
  const w = getWrapper()
  if (w) return { width: w.clientWidth || w.offsetWidth, height: w.clientHeight || w.offsetHeight }
  return { width: window.innerWidth, height: window.innerHeight }
}

// --- Layer context (modal nesting decides the z-index of nested overlays) ---

interface LayerContextValue {
  /** True inside a modal dialog: overlays use z-(--z-popover) so they sit above it. */
  inModal: boolean
}
const LayerContext = createContext<LayerContextValue>({ inModal: false })
export const LayerProvider = LayerContext.Provider
export function useLayerContext() {
  return useContext(LayerContext)
}
/** z-index class for dropdown-type overlays: above a modal when opened from one. */
export function useOverlayZ(): string {
  return useLayerContext().inModal ? 'z-(--z-popover)' : 'z-(--z-dropdown)'
}

// --- Focus ------------------------------------------------------------------

/**
 * Focus `el`; if it could not take focus yet (e.g. a stylesheet transitions
 * `visibility` while the overlay is being shown), retry on the next frames.
 */
export function focusWhenReady(el: HTMLElement | null | undefined, isStillWanted: () => boolean = () => true) {
  if (!el) return
  el.focus({ preventScroll: true })
  if (document.activeElement === el) return
  let tries = 0
  const retry = () => {
    if (!el.isConnected || !isStillWanted() || document.activeElement === el) return
    el.focus({ preventScroll: true })
    if (document.activeElement !== el && ++tries < 10) requestAnimationFrame(retry)
  }
  requestAnimationFrame(retry)
}

/** Regions whose current tab stop takes focus when the element focus should return to is gone. */
const FOCUS_SCOPE_SEL = '[role="tablist"],[role="tree"],[role="grid"],[role="listbox"],[role="toolbar"],[role="tabpanel"],[role="region"],[data-focus-scope]'

const NATIVE_FOCUSABLE = 'a[href],button,input:not([type="hidden"]),select,textarea'

/**
 * The element to focus for `scope`: a control itself (an input passed as
 * returnFocus), else the current tab stop of a composite region (roving
 * tabindex), else its first focusable, else the region.
 */
export function focusScopeTarget(scope: HTMLElement): HTMLElement | null {
  if (scope.matches(NATIVE_FOCUSABLE)) return (scope as HTMLButtonElement).disabled ? null : scope
  const cand =
    scope.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]:not([disabled])') ??
    scope.querySelector<HTMLElement>('[tabindex="0"]:not([disabled])') ??
    scope.querySelector<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled])')
  if (cand && cand.getClientRects().length > 0 && !cand.closest('[inert],[hidden]')) return cand
  return scope.hasAttribute('tabindex') ? scope : null
}

/**
 * Where focus goes when the control that had it is gone and nothing else
 * claims it (a Reconnect button that unmounted with its banner, a prompt
 * that opened by itself while focus was on <body>, RW2-C-03): the active
 * editor's current breadcrumb, else the tree's tab stop, else the editor
 * region (its active tab). Null outside the app shell.
 */
export function workAreaFocusTarget(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  const shown = (el: HTMLElement | null): el is HTMLElement => !!el && el.getClientRects().length > 0 && !el.closest('[inert],[hidden]')
  const crumb = document.querySelector<HTMLElement>('[role="region"][aria-label="Editor"] nav[aria-label="Breadcrumb"] [aria-current="page"]')
  if (shown(crumb)) return crumb
  const tree = document.querySelector<HTMLElement>('[data-pane="sidebar"] [role="tree"]')
  if (shown(tree)) return tree
  const editor = document.querySelector<HTMLElement>('[role="region"][aria-label="Editor"]')
  return shown(editor) ? editor : null
}

let restoringFocus = 0

/**
 * True while restoreFocus moves focus back (focusin listeners run inside the
 * .focus() call). Selection tracking (commands/selectionContext) ignores
 * these: closing the palette or a menu must not make the region it returns
 * focus to the "most recent selection".
 */
export function isFocusRestore(): boolean {
  return restoringFocus > 0
}

function focusRestored(el: HTMLElement) {
  restoringFocus++
  try {
    el.focus({ preventScroll: true })
  } finally {
    restoringFocus--
  }
}

/**
 * Restores focus to `el`, or, when it was removed or cannot take focus (the
 * menu's action closed a tab, disabled the trigger...), to `fallback`: a
 * control, or a region whose current tab stop takes focus (captured while
 * `el` was connected). `fallback` may be a function: it is resolved when used,
 * after the DOM update (a ref may be re-attached in the same commit).
 * Runs again on the next frames. Does nothing if focus already moved on.
 */
export function restoreFocus(
  el: HTMLElement | null | undefined,
  fallback: HTMLElement | null | undefined | (() => HTMLElement | null | undefined),
) {
  const usable = (x: HTMLElement | null | undefined): x is HTMLElement =>
    !!x && x.isConnected && !(x as HTMLButtonElement).disabled && !x.closest('[inert],[hidden]')
  const resolve = () => (typeof fallback === 'function' ? fallback() : fallback)
  const attempt = () => {
    const a = document.activeElement
    if (a && a !== document.body && a !== el && a.isConnected) return true
    if (usable(el)) {
      focusRestored(el)
      if (document.activeElement === el) return true
    }
    const scope = resolve()
    if (scope && scope.isConnected) {
      const t = focusScopeTarget(scope)
      if (t) {
        focusRestored(t)
        return document.activeElement === t
      }
    }
    return false
  }
  if (usable(el)) focusRestored(el)
  requestAnimationFrame(() => {
    if (el && document.activeElement === el && el.isConnected) return
    if (!attempt()) requestAnimationFrame(() => void attempt())
  })
}

/** The focus-restore scope of an element (its tablist, tree, grid, region...). */
export function focusScopeOf(el: HTMLElement | null | undefined): HTMLElement | null {
  return el?.parentElement?.closest<HTMLElement>(FOCUS_SCOPE_SEL) ?? null
}

// --- LayerHost / Portal -----------------------------------------------------

/**
 * Mount once inside `.zoom-wrapper` (AppLayout). `display: contents`, so it
 * adds no box; fixed children resolve against the transformed wrapper.
 * Also keeps `data-compact-h` on the wrapper up to date (useWrapperSize).
 */
export function LayerHost() {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    setHost(ref.current)
    return () => setHost(null)
  }, [])
  useWrapperSize()
  return <div ref={ref} data-layer-host="" className="contents" />
}

/** Renders children into the LayerHost (falls back to the zoom wrapper, then body). */
export function Portal({ children }: { children: ReactNode }) {
  const host = useSyncExternalStore(subscribeHost, () => hostEl, () => null)
  const target = host ?? getWrapper() ?? (typeof document !== 'undefined' ? document.body : null)
  if (!target) return null
  return createPortal(children, target)
}

// --- Wrapper size -----------------------------------------------------------

export interface WrapperSize {
  width: number
  height: number
}
const COMPACT_H = 700
let wrapperSize: WrapperSize = { width: 0, height: 0 }
const sizeListeners = new Set<() => void>()
let ro: ResizeObserver | null = null
let observed: HTMLElement | null = null

function measureWrapper() {
  const w = getWrapper()
  if (!w) return
  const next = { width: w.offsetWidth, height: w.offsetHeight }
  if (next.height <= COMPACT_H) w.setAttribute('data-compact-h', '')
  else w.removeAttribute('data-compact-h')
  if (next.width !== wrapperSize.width || next.height !== wrapperSize.height) {
    wrapperSize = next
    sizeListeners.forEach((l) => l())
  }
}

function subscribeSize(l: () => void) {
  sizeListeners.add(l)
  const w = getWrapper()
  if (w && observed !== w && typeof ResizeObserver !== 'undefined') {
    ro?.disconnect()
    ro = new ResizeObserver(measureWrapper)
    ro.observe(w)
    observed = w
  }
  measureWrapper()
  return () => {
    sizeListeners.delete(l)
    if (sizeListeners.size === 0) {
      ro?.disconnect()
      ro = null
      observed = null
    }
  }
}

/**
 * Unscaled size of the zoom wrapper (ResizeObserver). Sets `data-compact-h`
 * on the wrapper while its height is <= 700 CSS px (zoom-correct), which
 * EntrySummaryHeader uses to collapse to one 32px line.
 */
export function useWrapperSize(): WrapperSize {
  return useSyncExternalStore(subscribeSize, () => wrapperSize, () => wrapperSize)
}

// --- Anchored positioning ---------------------------------------------------

export type Side = 'top' | 'bottom' | 'left' | 'right'
export type Align = 'start' | 'center' | 'end'
export type Placement = Side | `${Side}-start` | `${Side}-end`

export interface AnchoredPositionOptions {
  /** Element the overlay is attached to (menus, tooltips, popovers). */
  anchor?: HTMLElement | null
  /** Or a point in LAYER coordinates (context menus: toLayerPoint(e.clientX, e.clientY)). */
  point?: { x: number; y: number } | null
  placement?: Placement
  /** Gap between anchor and overlay, px. */
  offset?: number
  /** Distance kept from the wrapper edges, px. */
  margin?: number
  /** Overlay at least as wide as the anchor (comboboxes). */
  matchWidth?: boolean
  open?: boolean
}

export interface AnchoredPosition {
  ref: (el: HTMLElement | null) => void
  style: CSSProperties
  placement: Placement
  ready: boolean
  update: () => void
}

function parsePlacement(p: Placement): [Side, Align] {
  const [side, align] = p.split('-') as [Side, Align | undefined]
  return [side, align ?? 'center']
}

/**
 * Measures the overlay with a ref, then flips and clamps it inside the
 * wrapper. Replaces the item-count estimates and unclamped menus.
 */
export function useAnchoredPosition({
  anchor,
  point,
  placement = 'bottom-start',
  offset = 4,
  margin = 4,
  matchWidth = false,
  open = true,
}: AnchoredPositionOptions): AnchoredPosition {
  const elRef = useRef<HTMLElement | null>(null)
  const [state, setState] = useState<{ left: number; top: number; placement: Placement; ready: boolean; minWidth?: number; maxHeight?: number }>(
    { left: -9999, top: -9999, placement, ready: false },
  )

  const compute = useCallback(() => {
    const el = elRef.current
    if (!el || !open) return
    let a: LayerRect
    if (point) a = { left: point.x, top: point.y, right: point.x, bottom: point.y, width: 0, height: 0 }
    else if (anchor && anchor.isConnected) a = toLayerRect(anchor.getBoundingClientRect())
    else return
    const { width: W, height: H } = getLayerSize()
    const minWidth = matchWidth ? a.width : undefined
    const w = Math.max(el.offsetWidth, minWidth ?? 0)
    const h = el.offsetHeight
    const [side0, align] = parsePlacement(placement)
    let side = side0

    const fitsSide = (s: Side) => {
      switch (s) {
        case 'bottom': return a.bottom + offset + h <= H - margin
        case 'top': return a.top - offset - h >= margin
        case 'right': return a.right + offset + w <= W - margin
        case 'left': return a.left - offset - w >= margin
      }
    }
    const opposite: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
    if (!fitsSide(side) && fitsSide(opposite[side])) side = opposite[side]
    else if (!fitsSide(side) && !fitsSide(opposite[side])) {
      // Neither fits: take the side with more room.
      const room: Record<Side, number> = { bottom: H - a.bottom, top: a.top, right: W - a.right, left: a.left }
      if (room[opposite[side]] > room[side]) side = opposite[side]
    }

    let left = 0
    let top = 0
    if (side === 'bottom' || side === 'top') {
      top = side === 'bottom' ? a.bottom + offset : a.top - offset - h
      left = align === 'start' ? a.left : align === 'end' ? a.right - w : a.left + a.width / 2 - w / 2
      // Cross-axis flip (context menu near the right edge opens to the left).
      if (align === 'start' && left + w > W - margin && a.right - w >= margin) left = a.right - w
      if (align === 'end' && left < margin && a.left + w <= W - margin) left = a.left
    } else {
      left = side === 'right' ? a.right + offset : a.left - offset - w
      top = align === 'start' ? a.top : align === 'end' ? a.bottom - h : a.top + a.height / 2 - h / 2
      if (align === 'start' && top + h > H - margin && a.bottom - h >= margin) top = a.bottom - h
      if (align === 'end' && top < margin && a.top + h <= H - margin) top = a.top
    }
    left = Math.max(margin, Math.min(left, W - w - margin))
    top = Math.max(margin, Math.min(top, H - h - margin))
    const next = {
      left: Math.round(left),
      top: Math.round(top),
      placement: (align === 'center' ? side : `${side}-${align}`) as Placement,
      ready: true,
      minWidth,
      maxHeight: H - 2 * margin,
    }
    setState((prev) =>
      prev.left === next.left && prev.top === next.top && prev.placement === next.placement && prev.ready &&
      prev.minWidth === next.minWidth && prev.maxHeight === next.maxHeight
        ? prev
        : next,
    )
  }, [anchor, point?.x, point?.y, placement, offset, margin, matchWidth, open])

  useLayoutEffect(() => {
    if (!open) {
      setState((s) => (s.ready ? { ...s, ready: false } : s))
      return
    }
    compute()
    const el = elRef.current
    const ro2 = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => compute()) : null
    if (el && ro2) ro2.observe(el)
    const w = getWrapper()
    if (w && ro2) ro2.observe(w)
    const onScroll = (e: Event) => {
      // Ignore scrolling inside the overlay itself (long menus/listboxes).
      if (elRef.current && e.target instanceof Node && elRef.current.contains(e.target)) return
      compute()
    }
    window.addEventListener('resize', compute)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      ro2?.disconnect()
      window.removeEventListener('resize', compute)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [compute, open])

  const ref = useCallback(
    (el: HTMLElement | null) => {
      elRef.current = el
      if (el) compute()
    },
    [compute],
  )

  return {
    ref,
    placement: state.placement,
    ready: state.ready,
    update: compute,
    style: {
      position: 'fixed',
      left: state.left,
      top: state.top,
      minWidth: state.minWidth,
      maxHeight: state.maxHeight,
      visibility: state.ready ? undefined : 'hidden',
    },
  }
}
