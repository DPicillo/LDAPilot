import { create } from 'zustand'
import { EditorTab } from '../types/ui'
import { LDAPEntry } from '../types/ldap'
import * as wails from '../lib/wails'

interface NavigationEntry {
  profileId: string;
  dn: string;
}

interface EditorState {
  tabs: EditorTab[];
  activeTabId: string | null;
  entries: Record<string, LDAPEntry>;
  loadingEntries: Record<string, boolean>;

  // Navigation history
  navHistory: NavigationEntry[];
  navIndex: number;

  openEntry: (profileId: string, dn: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  refreshEntry: (profileId: string, dn: string) => Promise<void>;
  markDirty: (tabId: string) => void;
  markClean: (tabId: string) => void;
  updateEntry: (dn: string, entry: LDAPEntry) => void;

  goBack: () => void;
  goForward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
}

function extractRDN(dn: string): string {
  // Split on commas that are not preceded by a backslash
  const parts = dn.split(/(?<!\\),/);
  if (parts.length === 0) return dn;
  const rdn = parts[0].replace(/\\,/g, ','); // unescape commas
  const eqIdx = rdn.indexOf('=');
  return eqIdx >= 0 ? rdn.substring(eqIdx + 1) : rdn;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  entries: {},
  loadingEntries: {},
  navHistory: [],
  navIndex: -1,

  openEntry: (profileId: string, dn: string) => {
    const tabId = `${profileId}:${dn}`;
    const existingTab = get().tabs.find((t) => t.id === tabId);

    if (existingTab) {
      // Push to navigation history
      const state = get();
      const newHistory = state.navHistory.slice(0, state.navIndex + 1);
      newHistory.push({ profileId, dn });

      set({
        activeTabId: tabId,
        navHistory: newHistory,
        navIndex: newHistory.length - 1,
      });
      return;
    }

    const newTab: EditorTab = {
      id: tabId,
      profileId,
      label: extractRDN(dn),
      dn,
      dirty: false,
    };

    set((state) => {
      const newHistory = state.navHistory.slice(0, state.navIndex + 1);
      newHistory.push({ profileId, dn });

      return {
        tabs: [...state.tabs, newTab],
        activeTabId: tabId,
        navHistory: newHistory,
        navIndex: newHistory.length - 1,
      };
    });

    // Load entry data
    get().refreshEntry(profileId, dn);
  },

  closeTab: (tabId: string) => {
    set((state) => {
      const tabIndex = state.tabs.findIndex((t) => t.id === tabId);
      const newTabs = state.tabs.filter((t) => t.id !== tabId);

      let newActiveId = state.activeTabId;
      if (state.activeTabId === tabId) {
        if (newTabs.length === 0) {
          newActiveId = null;
        } else if (tabIndex >= newTabs.length) {
          newActiveId = newTabs[newTabs.length - 1].id;
        } else {
          newActiveId = newTabs[tabIndex].id;
        }
      }

      return { tabs: newTabs, activeTabId: newActiveId };
    });
  },

  setActiveTab: (tabId: string) => {
    set({ activeTabId: tabId });
  },

  refreshEntry: async (profileId: string, dn: string) => {
    const tabId = `${profileId}:${dn}`;
    set((state) => ({
      loadingEntries: { ...state.loadingEntries, [tabId]: true },
    }));
    try {
      const entry = await wails.GetEntry(profileId, dn);
      if (entry) {
        set((state) => ({
          entries: { ...state.entries, [tabId]: entry },
          loadingEntries: { ...state.loadingEntries, [tabId]: false },
        }));
      }
    } catch (err) {
      console.error('Failed to load entry:', err);
      set((state) => ({
        loadingEntries: { ...state.loadingEntries, [tabId]: false },
      }));
    }
  },

  markDirty: (tabId: string) => {
    set((state) => ({
      tabs: state.tabs.map((t) => t.id === tabId ? { ...t, dirty: true } : t),
    }));
  },

  markClean: (tabId: string) => {
    set((state) => ({
      tabs: state.tabs.map((t) => t.id === tabId ? { ...t, dirty: false } : t),
    }));
  },

  updateEntry: (tabId: string, entry: LDAPEntry) => {
    set((state) => ({
      entries: { ...state.entries, [tabId]: entry },
    }));
  },

  goBack: () => {
    const state = get();
    if (state.navIndex <= 0) return;
    const newIndex = state.navIndex - 1;
    const nav = state.navHistory[newIndex];
    const tabId = `${nav.profileId}:${nav.dn}`;

    // Check if tab still exists, if not open it
    const existingTab = state.tabs.find(t => t.id === tabId);
    if (existingTab) {
      set({ activeTabId: tabId, navIndex: newIndex });
    } else {
      const newTab: EditorTab = {
        id: tabId,
        profileId: nav.profileId,
        label: extractRDN(nav.dn),
        dn: nav.dn,
        dirty: false,
      };
      set((s) => ({
        tabs: [...s.tabs, newTab],
        activeTabId: tabId,
        navIndex: newIndex,
      }));
      get().refreshEntry(nav.profileId, nav.dn);
    }
  },

  goForward: () => {
    const state = get();
    if (state.navIndex >= state.navHistory.length - 1) return;
    const newIndex = state.navIndex + 1;
    const nav = state.navHistory[newIndex];
    const tabId = `${nav.profileId}:${nav.dn}`;

    const existingTab = state.tabs.find(t => t.id === tabId);
    if (existingTab) {
      set({ activeTabId: tabId, navIndex: newIndex });
    } else {
      const newTab: EditorTab = {
        id: tabId,
        profileId: nav.profileId,
        label: extractRDN(nav.dn),
        dn: nav.dn,
        dirty: false,
      };
      set((s) => ({
        tabs: [...s.tabs, newTab],
        activeTabId: tabId,
        navIndex: newIndex,
      }));
      get().refreshEntry(nav.profileId, nav.dn);
    }
  },

  canGoBack: () => {
    return get().navIndex > 0;
  },

  canGoForward: () => {
    const state = get();
    return state.navIndex < state.navHistory.length - 1;
  },
}))
