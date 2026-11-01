/**
 * Editor session per connection profile (SPEC 10.2 MainPanel): the open
 * entry tabs and the active one are saved in localStorage
 * (`ldapilot-session-<profileId>`) and restored the first time the profile
 * connects in an app run when none of its tabs is open. Restored tabs load
 * when they are activated (MainPanel), not all at once.
 *
 * A profile's session is only written after it was restored (or a tab of it
 * was opened) in this run, so starting the app never overwrites a saved
 * session with "no tabs".
 *
 * Also marks tabs stale while the connection health watch reports the
 * profile `lost` or after it was disconnected (File ▸ Disconnect, ED-16), and
 * refreshes them when it is restored or the profile connects again; tabs
 * whose last load failed are retried then too.
 */
import type { EditorTab } from '../types/ui'
import { useConnectionStore } from './connectionStore'
import { isTabDirty, useEditorStore } from './editorStore'

export interface SavedSession {
  tabs: { dn: string; preview?: boolean }[]
  active?: string
}

/** At most this many tabs are saved / restored per profile. */
export const MAX_SESSION_TABS = 12
const keyOf = (profileId: string) => `ldapilot-session-${profileId}`

/** The session of one profile from the editor state (entry tabs only; pure). */
export function sessionOf(tabs: EditorTab[], activeTabId: string | null, profileId: string): SavedSession {
  const own = tabs.filter((t) => t.profileId === profileId && !!t.dn)
  const kept = own.slice(-MAX_SESSION_TABS)
  const active = own.find((t) => t.id === activeTabId)
  return {
    tabs: kept.map((t) => (t.preview ? { dn: t.dn, preview: true } : { dn: t.dn })),
    active: active && kept.includes(active) ? active.dn : undefined,
  }
}

/** Saved session, or null (nothing saved, bad JSON, blocked storage). */
export function loadSession(profileId: string): SavedSession | null {
  try {
    const raw = JSON.parse(localStorage.getItem(keyOf(profileId)) || 'null') as SavedSession | null
    if (!raw || !Array.isArray(raw.tabs)) return null
    const tabs = raw.tabs.filter((t) => t && typeof t.dn === 'string' && t.dn).slice(0, MAX_SESSION_TABS)
    return { tabs, active: typeof raw.active === 'string' ? raw.active : undefined }
  } catch {
    return null
  }
}

function saveSession(profileId: string, s: SavedSession) {
  try {
    if (s.tabs.length) localStorage.setItem(keyOf(profileId), JSON.stringify(s))
    else localStorage.removeItem(keyOf(profileId))
  } catch {
    /* blocked storage: the session is just not remembered */
  }
}

/**
 * Installs the session save / restore and the stale-tab tracking. Returns
 * the disposer (MainPanel effect). `onHealth` subscribes to the connection
 * health (layout/useConnectionWatch) without importing the layout here.
 */
export function installEditorSession(
  subscribeHealth: (cb: (h: { status: 'ok' | 'lost'; profileId: string | null }, prev: { status: 'ok' | 'lost'; profileId: string | null }) => void) => () => void,
): () => void {
  const live = new Set<string>()
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  const restore = (profileId: string) => {
    live.add(profileId)
    const es = useEditorStore.getState()
    if (es.tabs.some((t) => t.profileId === profileId && t.dn)) return
    const s = loadSession(profileId)
    if (s?.tabs.length) es.restoreTabs(profileId, s.tabs, s.active)
  }

  /**
   * Reloads the stale tabs of a profile and retries its failed loads (dirty
   * ones keep the mark: their unsaved input must not be replaced). Tabs that
   * were never loaded load when they are shown (MainPanel).
   */
  const refreshStale = (profileId: string) => {
    const es = useEditorStore.getState()
    const due = es.tabs.filter((t) => t.profileId === profileId && t.dn && (t.stale || (t.state && t.state.kind !== 'deleted')))
    if (!due.length) return
    for (const t of due) {
      if (isTabDirty(t)) continue
      if (es.entries[t.id] || t.state) void es.refreshEntry(t.profileId, t.dn, { silent: !!es.entries[t.id] })
    }
    useEditorStore.setState((st) => ({
      tabs: st.tabs.map((t) => (t.profileId === profileId && t.stale && !isTabDirty(t) ? { ...t, stale: undefined } : t)),
    }))
  }

  const offs: (() => void)[] = []
  {
    const cs = useConnectionStore.getState()
    for (const [id, on] of Object.entries(cs.connectionStatuses)) if (on) restore(id)
  }
  offs.push(
    useConnectionStore.subscribe((s, prev) => {
      for (const [id, on] of Object.entries(s.connectionStatuses)) {
        if (!on) {
          // Disconnected (or the connect failed): the open tabs show "Disconnected" (ED-16).
          if (prev.connectionStatuses[id] === true) useEditorStore.getState().setTabsStale(id, true)
          continue
        }
        if (prev.connectionStatuses[id] === true) continue
        if (!live.has(id)) restore(id)
        else refreshStale(id)
      }
    }),
  )
  offs.push(
    useEditorStore.subscribe((s, prev) => {
      if (s.tabs === prev.tabs && s.activeTabId === prev.activeTabId) return
      for (const t of s.tabs) if (t.dn && t.profileId) live.add(t.profileId)
      clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        const st = useEditorStore.getState()
        for (const id of live) saveSession(id, sessionOf(st.tabs, st.activeTabId, id))
      }, 300)
    }),
  )
  offs.push(
    subscribeHealth((h, prev) => {
      if (h.status === 'lost' && h.profileId) useEditorStore.getState().setTabsStale(h.profileId, true)
      // Restored. A reset after a manual disconnect is no restore: the tabs stay
      // stale until the profile connects again (connectionStore subscription).
      else if (h.status === 'ok' && prev.status === 'lost' && prev.profileId && useConnectionStore.getState().connectionStatuses[prev.profileId] === true) {
        refreshStale(prev.profileId)
      }
    }),
  )
  return () => {
    clearTimeout(saveTimer)
    offs.forEach((off) => off())
  }
}
