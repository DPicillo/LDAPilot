import { create } from 'zustand'
import { Activity } from '../types/ui'
import {
  type Density,
  type ResolvedTheme,
  type ThemePref,
  DENSITY_STORAGE_KEY,
  THEME_STORAGE_KEY,
  applyAppearance,
  loadDensity,
  loadThemePref,
  resolveTheme,
  watchSystemTheme,
  write,
} from '../components/ui/theme'
import { SHELL_VIEW_KEY, parseShellView, serializeShellView, stepZoom } from '../components/connection/chromeLogic'

export type BottomTab = 'search-results' | 'output' | 'audit';

/** Where the AI chat lives: the side bar (default) or its own pane right of the editor (A-01/A-21/A-22). */
export type AIDock = 'sidebar' | 'right';
const AI_DOCK_KEY = 'ldapilot-ai-dock';

function loadAIDock(): AIDock {
  try {
    return localStorage.getItem(AI_DOCK_KEY) === 'right' ? 'right' : 'sidebar';
  } catch {
    return 'sidebar';
  }
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_DEFAULT = 1.0;

interface UIState {
  activeActivity: Activity;
  sidebarVisible: boolean;
  bottomPanelVisible: boolean;
  bottomPanelTab: BottomTab;
  zoomLevel: number;
  setActivity: (activity: Activity) => void;
  toggleSidebar: () => void;
  toggleBottomPanel: () => void;
  showBottomTab: (tab: BottomTab) => void;
  /** Next zoom preset (ZOOM_PRESETS: 80/90/100/110/125/150 %). */
  zoomIn: () => void;
  /** Previous zoom preset. */
  zoomOut: () => void;
  zoomReset: () => void;
  /** Absolute zoom level (0.5–2), persisted. */
  setZoom: (level: number) => void;
  // Appearance (SPEC section 5): preference, what it resolves to, and density.
  themePref: ThemePref;
  resolvedTheme: ResolvedTheme;
  density: Density;
  setThemePref: (pref: ThemePref) => void;
  setDensity: (density: Density) => void;
  /** A plain click in the tree opens the preview tab (SPEC 12 #10, default on); off: a click only selects. */
  singleClickPreview: boolean;
  setSingleClickPreview: (on: boolean) => void;
  /** AI chat docked in the side bar or right of the editor (per device) */
  aiDock: AIDock;
  /** the right AI pane is shown (only while aiDock is 'right') */
  aiPaneVisible: boolean;
  /** moves the chat; it is shown at its new place */
  setAIDock: (dock: AIDock) => void;
  toggleAIPane: () => void;
}

/** The AI chat is on screen (side bar activity or the right pane). */
export function selectAIShown(s: Pick<UIState, 'aiDock' | 'aiPaneVisible' | 'activeActivity' | 'sidebarVisible'>): boolean {
  return s.aiDock === 'right' ? s.aiPaneVisible : s.activeActivity === 'ai' && s.sidebarVisible;
}

const SINGLE_CLICK_PREVIEW_KEY = 'ldapilot-single-click-preview';

function loadSingleClickPreview(): boolean {
  try {
    return localStorage.getItem(SINGLE_CLICK_PREVIEW_KEY) !== 'false';
  } catch {
    return true;
  }
}

function applyZoom(level: number) {
  document.documentElement.style.setProperty('--zoom-level', String(level));
  write('ldapilot-zoom', String(level));
}

function clampZoom(level: number): number {
  if (!Number.isFinite(level)) return ZOOM_DEFAULT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(level * 100) / 100));
}

function loadZoom(): number {
  let saved: string | null = null;
  try { saved = localStorage.getItem('ldapilot-zoom'); } catch { /* blocked storage */ }
  const level = clampZoom(saved ? parseFloat(saved) : ZOOM_DEFAULT);
  applyZoom(level);
  return level;
}

// Applied at module load (like loadZoom) so <html data-theme> is set before
// the first render; :root without the attribute renders dark anyway.
const initialThemePref = loadThemePref();
const initialDensity = loadDensity();
const initialResolvedTheme = resolveTheme(initialThemePref);
applyAppearance(initialResolvedTheme, initialDensity);
const initialAIDock = loadAIDock();

/**
 * The side bar activity and bottom panel state of the last session, so a
 * WebView reload (or a restart) does not fall back to Connections with the
 * panel hidden. Written on every change (below); blocked storage = defaults.
 */
function loadShellView() {
  let raw: string | null = null;
  try { raw = localStorage.getItem(SHELL_VIEW_KEY); } catch { /* blocked storage */ }
  return parseShellView(raw, initialAIDock);
}
const initialShellView = loadShellView();

export const useUIStore = create<UIState>((set) => ({
  activeActivity: initialShellView.activity,
  sidebarVisible: true,
  bottomPanelVisible: initialShellView.bottomVisible,
  bottomPanelTab: initialShellView.bottomTab,
  zoomLevel: loadZoom(),
  setActivity: (activity) => set({ activeActivity: activity }),
  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  toggleBottomPanel: () => set((state) => ({ bottomPanelVisible: !state.bottomPanelVisible })),
  showBottomTab: (tab) => set({ bottomPanelVisible: true, bottomPanelTab: tab }),
  zoomIn: () => set((state) => {
    const next = stepZoom(state.zoomLevel, 1);
    applyZoom(next);
    return { zoomLevel: next };
  }),
  zoomOut: () => set((state) => {
    const next = stepZoom(state.zoomLevel, -1);
    applyZoom(next);
    return { zoomLevel: next };
  }),
  zoomReset: () => {
    applyZoom(ZOOM_DEFAULT);
    return set({ zoomLevel: ZOOM_DEFAULT });
  },
  setZoom: (level) => {
    const next = clampZoom(level);
    applyZoom(next);
    set({ zoomLevel: next });
  },
  themePref: initialThemePref,
  resolvedTheme: initialResolvedTheme,
  density: initialDensity,
  setThemePref: (pref) => set((state) => {
    const resolvedTheme = resolveTheme(pref);
    applyAppearance(resolvedTheme, state.density);
    write(THEME_STORAGE_KEY, pref);
    return { themePref: pref, resolvedTheme };
  }),
  setDensity: (density) => set((state) => {
    applyAppearance(state.resolvedTheme, density);
    write(DENSITY_STORAGE_KEY, density);
    return { density };
  }),
  singleClickPreview: loadSingleClickPreview(),
  setSingleClickPreview: (on) => {
    write(SINGLE_CLICK_PREVIEW_KEY, String(on));
    set({ singleClickPreview: on });
  },
  aiDock: initialAIDock,
  aiPaneVisible: initialAIDock === 'right',
  setAIDock: (dock) => {
    write(AI_DOCK_KEY, dock);
    set((state) =>
      dock === 'right'
        // the side bar falls back to the Explorer instead of an empty AI slot
        ? { aiDock: dock, aiPaneVisible: true, ...(state.activeActivity === 'ai' ? { activeActivity: 'explorer' as Activity } : {}) }
        : { aiDock: dock, aiPaneVisible: false, activeActivity: 'ai', sidebarVisible: true },
    );
  },
  toggleAIPane: () => set((state) => ({ aiPaneVisible: !state.aiPaneVisible })),
}))

// Remember the shell view for the next reload / start (see loadShellView).
useUIStore.subscribe((s, prev) => {
  if (s.activeActivity === prev.activeActivity && s.bottomPanelVisible === prev.bottomPanelVisible && s.bottomPanelTab === prev.bottomPanelTab) return;
  write(SHELL_VIEW_KEY, serializeShellView({ activity: s.activeActivity, bottomVisible: s.bottomPanelVisible, bottomTab: s.bottomPanelTab }));
});

// Follow the OS appearance while the preference is 'system'; an explicit
// Dark/Light choice ignores it.
const stopWatchingSystemTheme = watchSystemTheme((systemTheme) => {
  const { themePref, density, resolvedTheme } = useUIStore.getState();
  if (themePref !== 'system' || systemTheme === resolvedTheme) return;
  applyAppearance(systemTheme, density);
  useUIStore.setState({ resolvedTheme: systemTheme });
});
if (import.meta.hot) import.meta.hot.dispose(stopWatchingSystemTheme);
