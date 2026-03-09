import { create } from 'zustand'
import { SearchParams, SearchResult, ScopeSub, LDAPEntry } from '../types/ldap'
import * as wails from '../lib/wails'
import { toast } from '../components/ui/Toast'
import { useConnectionStore } from './connectionStore'

export interface SearchHistoryItem {
  id: string;
  params: SearchParams;
  resultCount: number;
  timestamp: number;
  pinned: boolean;
}

export interface SavedSearch {
  id: string;
  name: string;
  params: SearchParams;
  displayColumns: string[];
  createdAt: number;
}

const DEFAULT_DISPLAY_COLUMNS = ['cn', 'description', 'mail', 'sAMAccountName'];

interface SearchState {
  params: SearchParams;
  results: SearchResult | null;
  loading: boolean;
  error: string | null;
  history: SearchHistoryItem[];
  displayColumns: string[];
  savedSearches: SavedSearch[];

  setParams: (params: Partial<SearchParams>) => void;
  executeSearch: (profileId: string, filterOverride?: string) => Promise<void>;
  clearResults: () => void;
  restoreSearch: (item: SearchHistoryItem) => void;
  togglePin: (id: string) => void;
  removeHistory: (id: string) => void;
  clearHistory: () => void;
  setDisplayColumns: (columns: string[]) => void;
  addDisplayColumn: (column: string) => void;
  removeDisplayColumn: (column: string) => void;
  getEntryAttrValue: (entry: LDAPEntry, attrName: string) => string;
  saveSearch: (name: string) => void;
  removeSavedSearch: (id: string) => void;
  restoreSavedSearch: (saved: SavedSearch) => void;
  loadSavedSearches: () => void;
}

const defaultParams: SearchParams = {
  baseDN: '',
  scope: ScopeSub,
  filter: '(objectClass=*)',
  attributes: [],
  sizeLimit: 1000,
  timeLimit: 30,
};

// Load saved searches from localStorage at init
const initialSavedSearches: SavedSearch[] = (() => {
  try {
    return JSON.parse(localStorage.getItem('ldapilot-saved-searches') || '[]');
  } catch { return []; }
})();

export const useSearchStore = create<SearchState>((set, get) => ({
  params: { ...defaultParams },
  results: null,
  loading: false,
  error: null,
  history: [],
  displayColumns: [...DEFAULT_DISPLAY_COLUMNS],
  savedSearches: initialSavedSearches,

  setParams: (params: Partial<SearchParams>) => {
    set((state) => ({
      params: { ...state.params, ...params },
    }));
  },

  executeSearch: async (profileId: string, filterOverride?: string) => {
    set({ loading: true, error: null });
    try {
      const params = { ...get().params };
      if (filterOverride) {
        params.filter = filterOverride;
        set((state) => ({ params: { ...state.params, filter: filterOverride } }));
      }
      // Fallback: if baseDN is empty, try to use the connection profile's baseDN
      if (!params.baseDN) {
        const profiles = useConnectionStore.getState().profiles;
        const profile = profiles.find(p => p.id === profileId);
        if (profile?.baseDN) {
          params.baseDN = profile.baseDN;
        }
      }
      const result = await wails.SearchLDAP(profileId, params);
      const count = result?.entries?.length || 0;

      // Add to history
      const historyItem: SearchHistoryItem = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        params: { ...params },
        resultCount: count,
        timestamp: Date.now(),
        pinned: false,
      };

      set((state) => ({
        results: result,
        loading: false,
        history: [historyItem, ...state.history].slice(0, 50), // Keep last 50
      }));

      toast.info(`Search completed: ${count} result${count !== 1 ? 's' : ''}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Search failed';
      set({ error: msg, loading: false });
      toast.error(msg);
    }
  },

  clearResults: () => {
    set({ results: null, error: null });
  },

  restoreSearch: (item: SearchHistoryItem) => {
    set({ params: { ...item.params } });
  },

  togglePin: (id: string) => {
    set((state) => ({
      history: state.history.map((h) =>
        h.id === id ? { ...h, pinned: !h.pinned } : h
      ),
    }));
  },

  removeHistory: (id: string) => {
    set((state) => ({
      history: state.history.filter((h) => h.id !== id),
    }));
  },

  clearHistory: () => {
    set((state) => ({
      history: state.history.filter((h) => h.pinned),
    }));
  },

  setDisplayColumns: (columns: string[]) => {
    set({ displayColumns: columns });
  },

  addDisplayColumn: (column: string) => {
    set((state) => {
      if (state.displayColumns.includes(column)) return state;
      return { displayColumns: [...state.displayColumns, column] };
    });
  },

  removeDisplayColumn: (column: string) => {
    set((state) => ({
      displayColumns: state.displayColumns.filter((c) => c !== column),
    }));
  },

  getEntryAttrValue: (_entry: LDAPEntry, attrName: string) => {
    // Utility function to extract attribute value from an entry
    const entry = _entry;
    if (!entry?.attributes) return '';
    const attr = entry.attributes.find(
      (a) => a.name.toLowerCase() === attrName.toLowerCase()
    );
    if (!attr || !attr.values || attr.values.length === 0) return '';
    if (attr.values.length === 1) return attr.values[0];
    return attr.values.join('; ');
  },

  saveSearch: (name: string) => {
    const state = get();
    const saved: SavedSearch = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      params: { ...state.params },
      displayColumns: [...state.displayColumns],
      createdAt: Date.now(),
    };
    const updated = [...state.savedSearches, saved];
    set({ savedSearches: updated });
    try {
      localStorage.setItem('ldapilot-saved-searches', JSON.stringify(updated));
    } catch { /* ignore */ }
    toast.success(`Search saved: ${name}`);
  },

  removeSavedSearch: (id: string) => {
    const updated = get().savedSearches.filter(s => s.id !== id);
    set({ savedSearches: updated });
    try {
      localStorage.setItem('ldapilot-saved-searches', JSON.stringify(updated));
    } catch { /* ignore */ }
  },

  restoreSavedSearch: (saved: SavedSearch) => {
    set({
      params: { ...saved.params },
      displayColumns: [...saved.displayColumns],
    });
  },

  loadSavedSearches: () => {
    try {
      const saved = JSON.parse(localStorage.getItem('ldapilot-saved-searches') || '[]');
      set({ savedSearches: saved });
    } catch { /* ignore */ }
  },
}))
