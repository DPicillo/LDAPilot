/**
 * useDismiss: one implementation of "close on Escape / click outside / focus
 * leaving" for every overlay (replaces the 11 hand-written click-outside
 * listeners).
 *
 * Overlays register on a stack in the order they open. Only the top-most one
 * reacts to Escape, and a pointer-down closes an overlay only when it lands
 * outside it AND outside every overlay opened after it (a submenu, a combobox
 * popup inside a popover), so nested layers close one at a time.
 *
 * Escape reaches an overlay in two ways:
 *  - focus inside it: spread the returned `onKeyDown` on the overlay element
 *    (React tree, so an inner control that handled Escape and called
 *    preventDefault() wins, and it works inside a Dialog which stops keydown
 *    propagation at its root);
 *  - focus elsewhere (hover popovers): a document listener, top-most only.
 */
import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'

interface Layer {
  id: number
  el: () => HTMLElement | null
}
const stack: Layer[] = []
let nextId = 1

/** Element of every open overlay registered after `id` (children of it). */
function laterLayers(id: number): HTMLElement[] {
  const i = stack.findIndex((l) => l.id === id)
  if (i < 0) return []
  return stack.slice(i + 1).map((l) => l.el()).filter((e): e is HTMLElement => !!e)
}

function isTop(id: number) {
  return stack.length > 0 && stack[stack.length - 1].id === id
}

/** True while any registered overlay is open (menus, popovers, dialogs). */
export function hasOpenLayer() {
  return stack.length > 0
}

/** True if `node` is inside any registered overlay. */
export function isInsideLayer(node: Node | null) {
  if (!node) return false
  return stack.some((l) => l.el()?.contains(node))
}

export interface DismissOptions {
  enabled?: boolean
  escape?: boolean
  outside?: boolean
  focusOut?: boolean
  /** Elements that do not count as "outside" (the trigger button). */
  ignore?: RefObject<HTMLElement | null>[] | (() => (HTMLElement | null)[])
}

export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  onDismiss: (reason: 'escape' | 'outside' | 'focusout') => void,
  { enabled = true, escape = true, outside = true, focusOut = false, ignore }: DismissOptions = {},
) {
  const idRef = useRef(0)
  const cb = useRef(onDismiss)
  cb.current = onDismiss
  const ignoreRef = useRef(ignore)
  ignoreRef.current = ignore

  useEffect(() => {
    if (!enabled) return
    const id = nextId++
    idRef.current = id
    stack.push({ id, el: () => ref.current })

    const ignored = (t: Node) => {
      const ig = ignoreRef.current
      const els = typeof ig === 'function' ? ig() : (ig ?? []).map((r) => r.current)
      return els.some((e) => e?.contains(t))
    }
    const inside = (t: Node) =>
      !!ref.current?.contains(t) || laterLayers(id).some((e) => e.contains(t)) || ignored(t)

    const onPointerDown = (e: PointerEvent) => {
      if (!outside) return
      const t = e.target as Node
      if (!t || inside(t)) return
      cb.current('outside')
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (!escape || e.key !== 'Escape' || e.defaultPrevented || !isTop(id)) return
      e.preventDefault()
      cb.current('escape')
    }
    const onFocusIn = (e: FocusEvent) => {
      if (!focusOut) return
      const t = e.target as Node
      if (t && !inside(t)) cb.current('focusout')
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      const i = stack.findIndex((l) => l.id === id)
      if (i >= 0) stack.splice(i, 1)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [enabled, escape, outside, focusOut, ref])

  /** Spread on the overlay element so Escape works when focus is inside it. */
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (!enabled || !escape || e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      e.stopPropagation()
      cb.current('escape')
    },
    [enabled, escape],
  )

  return { onKeyDown }
}
