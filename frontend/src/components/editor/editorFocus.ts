/**
 * Focus hand-over to the next entry editor (ED-15): a breadcrumb, history
 * or palette navigation mounts a new EntryEditor (one per tab), which takes
 * focus back so F4, Ctrl+L, Ctrl+F and Alt+Up keep working. Set by the
 * navigation (Go Back / Forward buttons, Alt+Left / Alt+Right commands —
 * RW1-E-04 — breadcrumbs), consumed by EntryEditor within 2 s.
 */
import { focusScopeTarget, workAreaFocusTarget } from '../ui/layer'

/**
 * 'list': a tab was activated by a click; its Contents list focuses the row
 * it kept selected (RW3-E-02), else focus stays on the tab.
 */
export type EditorFocusTarget = 'crumb' | 'back' | 'forward' | 'list'

let pending: { target: EditorFocusTarget; at: number } | null = null

/** The pending hand-over without taking it (the Contents list checks for 'list' before the editor takes it). */
export function peekEditorFocus(): EditorFocusTarget | null {
  return pending && Date.now() - pending.at <= 2000 ? pending.target : null
}

export function requestEditorFocus(target: EditorFocusTarget): void {
  pending = { target, at: Date.now() }
}

/** The pending hand-over (and clears it), or null when none is younger than 2 s. */
export function takeEditorFocus(): EditorFocusTarget | null {
  const p = pending
  pending = null
  return p && Date.now() - p.at <= 2000 ? p.target : null
}

/**
 * After an action whose control went away (the foreign banner's "Switch to …",
 * Entry ▸ Switch to): the active editor's current breadcrumb takes focus when
 * focus fell to <body> (RW2-N-06, RW2-E-04).
 */
export function focusActiveEditorSoon(): void {
  if (typeof window === 'undefined') return
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const a = document.activeElement
      if (a && a !== document.body) return
      document.querySelector<HTMLElement>('[role="region"][aria-label="Editor"] nav[aria-label="Breadcrumb"] [aria-current="page"]')?.focus({ preventScroll: true })
    }),
  )
}

/** A modal dialog is open (focus belongs to it). */
function modalOpen(): boolean {
  return !!document.querySelector('[aria-modal="true"]')
}

/**
 * After an action whose control may be gone or was disabled while it ran
 * (Reconnect now, the status bar's Reconnect, Retry of a failed connect,
 * the tab banner's Reconnect: RW2-C-03): when focus fell to <body>, it goes
 * to `prefer` (the control itself, when it is still there and enabled),
 * else to the work area (the current breadcrumb, else the tree's row).
 * Nothing happens while a modal dialog is open (the trust or password
 * prompt that the action opened owns focus; it restores on close).
 */
export function focusWorkAreaSoon(prefer?: HTMLElement | null | (() => HTMLElement | null | undefined)): void {
  if (typeof window === 'undefined') return
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const a = document.activeElement
      if (a && a !== document.body && a.isConnected) return
      if (modalOpen()) return
      const p = typeof prefer === 'function' ? prefer() : prefer
      if (p && p.isConnected && !(p as HTMLButtonElement).disabled && p.getClientRects().length > 0) {
        p.focus({ preventScroll: true })
        return
      }
      const scope = workAreaFocusTarget()
      const t = scope && (scope.getAttribute('aria-current') === 'page' ? scope : focusScopeTarget(scope))
      t?.focus({ preventScroll: true })
    }),
  )
}

/**
 * After a dialog that re-keyed the active tab (Rename… of the active entry):
 * the new editor's current crumb takes focus once the dialog has handed
 * focus back (its trigger, a menu item, is gone; RW2-E-04 a). Three frames:
 * after the dialog's own restore attempts.
 */
export function focusActiveEditorAfterDialog(): void {
  if (typeof window === 'undefined') return
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (modalOpen()) return
        document.querySelector<HTMLElement>('[role="region"][aria-label="Editor"] nav[aria-label="Breadcrumb"] [aria-current="page"]')?.focus({ preventScroll: true })
      }),
    ),
  )
}
