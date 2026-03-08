import { create } from 'zustand'
import { Activity } from '../types/ui'

export type BottomTab = 'search-results' | 'output' | 'audit';

interface UIState {
  activeActivity: Activity;
  sidebarVisible: boolean;
  bottomPanelVisible: boolean;
  bottomPanelTab: BottomTab;
  setActivity: (activity: Activity) => void;
  toggleSidebar: () => void;
  toggleBottomPanel: () => void;
  showBottomTab: (tab: BottomTab) => void;
}

export const useUIStore = create<UIState>((set) => ({
  activeActivity: 'connections',
  sidebarVisible: true,
  bottomPanelVisible: false,
  bottomPanelTab: 'search-results',
  setActivity: (activity) => set({ activeActivity: activity }),
  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  toggleBottomPanel: () => set((state) => ({ bottomPanelVisible: !state.bottomPanelVisible })),
  showBottomTab: (tab) => set({ bottomPanelVisible: true, bottomPanelTab: tab }),
}))
