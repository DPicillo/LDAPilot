/**
 * "Create and Connect" / connect-and-browse flow (CONN-01, CONN-07): connect
 * a profile like the Connections list does (connectProfile: connecting
 * state, error handling), show the Explorer, and put the keyboard focus on
 * the first tree row once the roots have loaded.
 */
import { useTreeStore } from '../../stores/treeStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { connectProfile } from '../layout/shellState'

const TREE_FOCUS_TIMEOUT_MS = 15_000

/** Focuses the tree's tab stop (or its first row); false while the tree is not rendered. */
function focusTreeRow(): boolean {
  const tree = document.querySelector<HTMLElement>('[data-pane="sidebar"] [role="tree"]')
  if (!tree) return false
  const row = tree.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ?? tree.querySelector<HTMLElement>('[role="treeitem"]')
  ;(row ?? tree).focus({ preventScroll: false })
  return true
}

/** Resolves when the tree roots of the profile are loaded (or after the timeout). */
function rootsLoaded(profileId: string): Promise<void> {
  const ready = () => {
    const s = useTreeStore.getState()
    return !!s.rootNodes[profileId] && !s.loading[`root:${profileId}`]
  }
  if (ready()) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, TREE_FOCUS_TIMEOUT_MS)
    const unsub = useTreeStore.subscribe(() => {
      if (ready()) done()
    })
    function done() {
      clearTimeout(timer)
      unsub()
      resolve()
    }
  })
}

/**
 * Connects (or switches to) the profile, shows the Explorer and focuses the
 * first tree row. Failures are reported by the connection store (toast,
 * inline alert, row mark, trust or password prompt).
 */
export async function connectAndBrowse(profileId: string, opts: { saved?: boolean } = {}): Promise<void> {
  // `saved`: Create and Connect (one toast for the save and the connect, RW3-C-03).
  await connectProfile(profileId, { reveal: true, saved: opts.saved })
  const cs = useConnectionStore.getState()
  if (cs.activeProfileId !== profileId || cs.connectionStatuses[profileId] !== true) return
  await rootsLoaded(profileId)
  if (useConnectionStore.getState().activeProfileId !== profileId) return
  // Two frames: the Explorer panel mounts the tree, then its rows render.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!focusTreeRow()) setTimeout(focusTreeRow, 150)
  }))
}
