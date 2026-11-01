/**
 * Showing a sidebar panel moves focus into it (Ctrl+Shift+C/E/F/R/B/S/L/A,
 * the View menu, the palette, the activity bar): the tree row, the search
 * field, the connection list, the report list, … A panel may mark its main
 * control with `data-panel-autofocus`; otherwise a per-panel rule picks it.
 */
import { useUIStore } from '../../stores/uiStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useTreeStore } from '../../stores/treeStore'
import type { Activity } from '../../types/ui'
import { focusScopeTarget } from '../ui/layer'

function visible(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && el.getClientRects().length > 0 && !el.closest('[hidden],[inert]')
}

function first(panel: HTMLElement, selectors: string[]): HTMLElement | null {
  for (const s of selectors) {
    for (const el of panel.querySelectorAll<HTMLElement>(s)) {
      if (visible(el) && !(el as HTMLButtonElement).disabled) return el
    }
  }
  return null
}

/** The quick search field (label "Search for"), the advanced filter, else the first text field. */
function searchField(panel: HTMLElement): HTMLElement | null {
  const fields = [...panel.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),textarea')].filter(visible)
  const labelled = fields.find((f) => /^(search for|filter)/i.test((f.labels?.[0]?.textContent ?? '').trim()))
  return labelled ?? fields.find((f) => f.tagName === 'TEXTAREA') ?? fields[1] ?? fields[0] ?? null
}

const RULES: Record<Activity, (panel: HTMLElement) => HTMLElement | null> = {
  explorer: (p) => first(p, ['[role="tree"] [role="treeitem"][tabindex="0"]', '[role="tree"] [role="treeitem"]', '[role="tree"]']),
  connections: (p) => first(p, ['[role="listbox"] [role="option"][tabindex="0"]', '[role="listbox"]']),
  search: searchField,
  reports: (p) => first(p, ['ul[aria-label="Reports"] [tabindex="0"]', 'ul[aria-label="Reports"] button']),
  bookmarks: (p) => first(p, ['ul[aria-label="Bookmarks"] [tabindex="0"]', 'ul[aria-label="Bookmarks"] button', 'input']),
  schema: (p) => first(p, ['input[type="search"]', 'input']),
  export: (p) => first(p, ['button:not([aria-label^="Refresh"])']),
  ai: (p) => first(p, ['textarea']),
}

/**
 * The Explorer's tree is on its way: the active connection is connecting or
 * its roots are loading (after a WebView reload the panel mounts before the
 * tree, RW3-N-05). Then the panel waits for the row instead of focusing its
 * header ("Sort: Name").
 */
function treeComing(): boolean {
  const cs = useConnectionStore.getState()
  const id = cs.activeProfileId
  if (!id) return false
  if (cs.loading && cs.connectionStatuses[id] !== true) return true
  if (cs.connectionStatuses[id] !== true) return false
  const ts = useTreeStore.getState()
  return !ts.rootNodes[id] || !!ts.loading[`root:${id}`]
}

/** Frames focusPanel waits for the tree while it is coming (~3 s). */
const TREE_WAIT_FRAMES = 180

/**
 * Focuses the main control of a shown panel once it is rendered (a panel
 * visited for the first time mounts on the next frame; a closing menu or the
 * palette hands focus back first). Focus already inside the panel stays.
 * Gives up after ~20 frames (the Explorer waits longer while its tree loads).
 */
export function focusPanel(activity: Activity, then?: () => void) {
  if (typeof document === 'undefined') return
  let frames = 0
  const tick = () => {
    const panel = document.querySelector<HTMLElement>(`[data-panel="${activity}"]:not([hidden])`)
    const rule = panel ? (first(panel, ['[data-panel-autofocus]']) ?? RULES[activity]?.(panel)) : null
    // No tree row yet but the tree is loading: wait for it, not the panel's first button.
    if (panel && !rule && activity === 'explorer' && frames < TREE_WAIT_FRAMES && treeComing()) {
      frames++
      requestAnimationFrame(tick)
      return
    }
    const target = panel ? (rule ?? focusScopeTarget(panel)) : null
    if (panel && target && visible(target)) {
      if (!panel.contains(document.activeElement)) target.focus({ preventScroll: false })
      then?.()
      return
    }
    if (++frames < 20) requestAnimationFrame(tick)
    else then?.()
  }
  requestAnimationFrame(tick)
}

/** Shows a sidebar panel (opens the sidebar when hidden) and focuses its main control. */
export function showPanel(activity: Activity, opts: { focus?: boolean } = {}) {
  const ui = useUIStore.getState()
  ui.setActivity(activity)
  if (!ui.sidebarVisible) ui.toggleSidebar()
  if (opts.focus !== false) focusPanel(activity)
}

/** Waits until a panel is shown and rendered, then runs fn (Find in Tree after switching to the Explorer). */
export function whenPanelShown(activity: Activity, ready: (panel: HTMLElement) => boolean, fn: () => void) {
  if (typeof document === 'undefined') return
  let frames = 0
  const tick = () => {
    const panel = document.querySelector<HTMLElement>(`[data-panel="${activity}"]:not([hidden])`)
    if (panel && ready(panel)) return fn()
    if (++frames < 30) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
