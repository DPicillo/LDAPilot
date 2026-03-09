import { create } from 'zustand'
import { Activity } from '../types/ui'

export type BottomTab = 'search-results' | 'output' | 'audit';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;
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
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
}

function applyZoom(level: number) {
  document.documentElement.style.setProperty('--zoom-level', String(level));
  localStorage.setItem('ldapilot-zoom', String(level));
}

function loadZoom(): number {
  const saved = localStorage.getItem('ldapilot-zoom');
  const level = saved ? parseFloat(saved) : ZOOM_DEFAULT;
  applyZoom(level);
  return level;
}

export const useUIStore = create<UIState>((set) => ({
  activeActivity: 'connections',
  sidebarVisible: true,
  bottomPanelVisible: false,
  bottomPanelTab: 'search-results',
  zoomLevel: loadZoom(),
  setActivity: (activity) => set({ activeActivity: activity }),
  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  toggleBottomPanel: () => set((state) => ({ bottomPanelVisible: !state.bottomPanelVisible })),
  showBottomTab: (tab) => set({ bottomPanelVisible: true, bottomPanelTab: tab }),
  zoomIn: () => set((state) => {
    const next = Math.min(ZOOM_MAX, Math.round((state.zoomLevel + ZOOM_STEP) * 10) / 10);
    applyZoom(next);
    return { zoomLevel: next };
  }),
  zoomOut: () => set((state) => {
    const next = Math.max(ZOOM_MIN, Math.round((state.zoomLevel - ZOOM_STEP) * 10) / 10);
    applyZoom(next);
    return { zoomLevel: next };
  }),
  zoomReset: () => {
    applyZoom(ZOOM_DEFAULT);
    return set({ zoomLevel: ZOOM_DEFAULT });
  },
}))
