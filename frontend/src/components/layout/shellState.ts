/**
 * Shell-local state and helpers (SPEC 7). Lives in layout/ so the shell never
 * edits the feature stores: pane sizes, bottom-panel maximize, the profile
 * the shell is connecting, last used profile, search timing for the results
 * strip, and the last LDAP operation for the status bar.
 */
import { create } from 'zustand'
import type { Activity } from '../../types/ui'
import { useUIStore } from '../../stores/uiStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useSearchStore } from '../../stores/searchStore'
import { useEditorStore } from '../../stores/editorStore'
import { getPrimarySelectedNode } from '../../stores/treeStore'
import { write } from '../ui/theme'
import { toast } from '../ui/Toast'

// --- Pane sizes (px, persisted under ldapilot-layout) --------------------------

export const SIDEBAR_MIN = 220
export const SIDEBAR_MAX = 520
export const SIDEBAR_DEFAULT = 280
export const BOTTOM_MIN = 120
export const BOTTOM_DEFAULT = 240
/** the AI chat pane right of the editor (uiStore.aiDock 'right') */
export const AI_PANE_MIN = 300
export const AI_PANE_MAX = 720
export const AI_PANE_DEFAULT = 380
const LAYOUT_KEY = 'ldapilot-layout'

export interface PersistedLayout {
  sidebarWidth: number
  bottomHeight: number
  aiWidth: number
}

const clamp = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback

export function loadLayout(): PersistedLayout {
  let raw: Partial<PersistedLayout> = {}
  try {
    raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') as Partial<PersistedLayout>
  } catch {
    /* blocked storage or bad JSON */
  }
  return {
    sidebarWidth: clamp(raw.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT),
    bottomHeight: clamp(raw.bottomHeight, BOTTOM_MIN, 2000, BOTTOM_DEFAULT),
    aiWidth: clamp(raw.aiWidth, AI_PANE_MIN, AI_PANE_MAX, AI_PANE_DEFAULT),
  }
}

export function saveLayout(patch: Partial<PersistedLayout>) {
  const next = { ...loadLayout(), ...patch }
  write(LAYOUT_KEY, JSON.stringify(next))
}

// --- Last used profile ---------------------------------------------------------

const LAST_PROFILE_KEY = 'ldapilot-last-profile'

export function loadLastUsedProfile(): { id: string; at: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_PROFILE_KEY) || 'null') as { id?: unknown; at?: unknown } | null
    return v && typeof v.id === 'string' && typeof v.at === 'number' ? { id: v.id, at: v.at } : null
  } catch {
    return null
  }
}

export function saveLastUsedProfile(id: string) {
  write(LAST_PROFILE_KEY, JSON.stringify({ id, at: Date.now() }))
  useShellState.setState({ lastUsedProfileId: id })
}

// --- Store ---------------------------------------------------------------------

export interface LastOperation {
  operation: string
  duration: string
  error?: string
  details?: string
  at: number
}

export interface SearchRun {
  /** What produced the results: a report name, else "Search" (results strip title). */
  source?: string
  /** Shown instead of the filter when the source has none (backend account reports). */
  description?: string
  /** Positive text when the run found nothing (reports: "No locked-out accounts"); the results' empty state. */
  empty?: string
  /** The empty state when nothing was found and that is no good news (a stale bookmark's name search). */
  notFound?: { title: string; hint?: string }
  filter: string
  baseDN: string
  startedAt: number
  durationMs: number | null
}

interface ShellState {
  /** Bottom panel fills the editor column (main pane hidden, still mounted). */
  bottomMaximized: boolean
  /** Profile the shell started a connect for (welcome rows, switcher). */
  connectingId: string | null
  lastUsedProfileId: string | null
  /** Last operation per profile (status bar; RW1-C-03: never another connection's). */
  lastOps: Record<string, LastOperation>
  /** Parameters and duration of the latest search (results strip). */
  lastSearch: SearchRun | null
  setBottomMaximized: (v: boolean) => void
  toggleBottomMaximized: () => void
}

export const useShellState = create<ShellState>((set) => ({
  bottomMaximized: false,
  connectingId: null,
  lastUsedProfileId: loadLastUsedProfile()?.id ?? null,
  lastOps: {},
  lastSearch: null,
  setBottomMaximized: (v) => set({ bottomMaximized: v }),
  toggleBottomMaximized: () => set((s) => ({ bottomMaximized: !s.bottomMaximized })),
}))

// An entry tab that opens or becomes active must be visible: leave the maximized panel,
// whoever maximized it (RW1-R-02: results row, Operations / Audit Log DN links).
useEditorStore.subscribe((s, prev) => {
  if (!useShellState.getState().bottomMaximized) return
  const opened = s.tabs.length > prev.tabs.length
  const switched = !!s.activeTabId && s.activeTabId !== prev.activeTabId
  // Opening the entry that is already the active tab changes neither (RW2-R-01).
  const revealed = s.revealSeq !== prev.revealSeq
  if (opened || switched || revealed) useShellState.getState().setBottomMaximized(false)
})

/** Records the last operation of a profile (status bar). */
export function setLastOp(profileId: string, op: LastOperation) {
  useShellState.setState((s) => ({ lastOps: { ...s.lastOps, [profileId]: op } }))
}

/** Forgets a profile's last operation (its log was cleared). */
export function clearLastOp(profileId: string) {
  useShellState.setState((s) => {
    if (!s.lastOps[profileId]) return s
    const next = { ...s.lastOps }
    delete next[profileId]
    return { lastOps: next }
  })
}

// Search timing: the store has no duration, so measure loading true -> false.
// A search starting while the panel shows Operations / Audit Log brings the
// Results tab forward (ReportsPanel only switches when the panel is hidden).
let searchStart: SearchRun | null = null
let nextSource: string | null = null
let nextEmpty: string | null = null
let nextNotFound: SearchRun['notFound'] | null = null
/**
 * Names the next search for the results strip (a filter report runs
 * executeSearch), optionally with its positive empty text or its not-found
 * text; pass null afterwards so a search that never started does not leave
 * the name for the next one.
 */
export function setNextSearchSource(source: string | null, empty?: string, notFound?: SearchRun['notFound']) {
  nextSource = source
  nextEmpty = source ? (empty ?? null) : null
  nextNotFound = source ? (notFound ?? null) : null
}
useSearchStore.subscribe((s, prev) => {
  if (s.loading && !prev.loading) {
    const ui = useUIStore.getState()
    // The panel's search shows its run in the panel's Results (results tabs run their own searches).
    if (ui.bottomPanelVisible && ui.bottomPanelTab !== 'search-results') ui.showBottomTab('search-results')
    const profileId = s.runningProfileId
    const profile = profileId ? useConnectionStore.getState().profiles.find((p) => p.id === profileId) : undefined
    searchStart = { source: nextSource ?? undefined, empty: nextEmpty ?? undefined, notFound: nextNotFound ?? undefined, filter: s.params.filter, baseDN: s.params.baseDN || profile?.baseDN || '', startedAt: Date.now(), durationMs: null }
    nextSource = null
    nextEmpty = null
    nextNotFound = null
  } else if (!s.loading && prev.loading && searchStart) {
    // executeSearch writes the overridden filter into params; take the final value.
    const run: SearchRun = { ...searchStart, filter: s.params.filter || searchStart.filter, durationMs: Date.now() - searchStart.startedAt }
    searchStart = null
    useShellState.setState({ lastSearch: run })
  }
})

// --- Actions -------------------------------------------------------------------

/** Shows a sidebar activity (opens the sidebar when hidden). */
export function showActivity(activity: Activity) {
  const ui = useUIStore.getState()
  ui.setActivity(activity)
  if (!ui.sidebarVisible) ui.toggleSidebar()
}

/**
 * Connects a saved profile (or switches to it when already connected).
 * `reveal` shows the Explorer afterwards, like ConnectionManager does.
 */
export async function connectProfile(id: string, { reveal = true, saved = false }: { reveal?: boolean; saved?: boolean } = {}) {
  const cs = useConnectionStore.getState()
  if (cs.connectionStatuses[id] === true) {
    cs.setActiveProfile(id)
    if (reveal) showActivity('explorer')
    return
  }
  if (useShellState.getState().connectingId) {
    // Another connect runs: the just saved profile is not connected now, but the save is confirmed.
    if (saved) toast.success(`Profile "${cs.profiles.find((p) => p.id === id)?.name ?? ''}" saved`)
    return
  }
  useShellState.setState({ connectingId: id })
  try {
    await cs.connect(id, { saved })
    if (reveal) showActivity('explorer')
  } catch {
    /* the store shows the error toast */
  } finally {
    useShellState.setState({ connectingId: null })
  }
}

/**
 * DN the Export dialog is prefilled with (File ▸ Export…, TransferPanel):
 * the tree selection, else the active tab's entry (only if that tab belongs to
 * the active connection, which the dialog exports from), else the base DN.
 */
export function getExportTarget(): { dn: string; source: 'tree' | 'tab' | 'base' } {
  const sel = getPrimarySelectedNode()
  if (sel) return { dn: sel, source: 'tree' }
  const cs = useConnectionStore.getState()
  const es = useEditorStore.getState()
  const tab = es.tabs.find((t) => t.id === es.activeTabId)
  if (tab?.dn && tab.profileId === cs.activeProfileId) return { dn: tab.dn, source: 'tab' }
  return { dn: cs.profiles.find((p) => p.id === cs.activeProfileId)?.baseDN ?? '', source: 'base' }
}

/**
 * Shows the panel's search results (the bottom panel's Results tab). Every
 * search entry point of the panel uses it; results tabs (DEF-16) are
 * snapshots with their own runs and are not activated by a panel search.
 */
export function showSearchResults() {
  useUIStore.getState().showBottomTab('search-results')
}
export const SERVER_INFO_TAB = '__server-info__'

export function openServerInfoTab() {
  const es = useEditorStore.getState()
  if (!es.tabs.some((t) => t.id === SERVER_INFO_TAB)) es.addSpecialTab(SERVER_INFO_TAB, 'Server Info')
  es.setActiveTab(SERVER_INFO_TAB)
}

// --- Zoom presets ----------------------------------------------------------------

/** Zoom presets (Ctrl+= / Ctrl+- step through them, uiStore.zoomIn/zoomOut). */
export { ZOOM_PRESETS } from '../connection/chromeLogic'

/** Sets an absolute zoom level (uiStore.setZoom). */
export function setZoomLevel(level: number) {
  useUIStore.getState().setZoom(level)
}

// --- Misc ----------------------------------------------------------------------

type WailsRuntime = {
  BrowserOpenURL?: (url: string) => void
  Quit?: () => void
  WindowMinimise?: () => void
  WindowToggleMaximise?: () => void
  WindowIsMaximised?: () => Promise<boolean>
  EventsOn?: (name: string, cb: (...data: unknown[]) => void) => (() => void) | void
}

/** window.runtime of Wails, or undefined in a plain browser. */
export function wailsRuntime(): WailsRuntime | undefined {
  return (window as unknown as { runtime?: WailsRuntime }).runtime
}

/** Subscribes to a Wails event; returns a disposer (no-op outside Wails, never throws). */
export function onWailsEvent(name: string, cb: (...data: unknown[]) => void): () => void {
  try {
    const off = wailsRuntime()?.EventsOn?.(name, cb)
    return () => {
      try {
        if (typeof off === 'function') off()
      } catch {
        /* ignore */
      }
    }
  } catch {
    return () => {}
  }
}

export function openExternal(url: string) {
  const rt = wailsRuntime()
  if (rt?.BrowserOpenURL) rt.BrowserOpenURL(url)
  else window.open(url, '_blank', 'noopener')
}
