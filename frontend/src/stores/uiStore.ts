import { create } from 'zustand'
import { Activity } from '../types/ui'

interface UIState {
  activeActivity: Activity;
  sidebarVisible: boolean;
  bottomPanelVisible: boolean;
  setActivity: (activity: Activity) => void;
  toggleSidebar: () => void;
  toggleBottomPanel: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  activeActivity: 'connections',
  sidebarVisible: true,
  bottomPanelVisible: false,
  setActivity: (activity) => set({ activeActivity: activity }),
  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  toggleBottomPanel: () => set((state) => ({ bottomPanelVisible: !state.bottomPanelVisible })),
}))
