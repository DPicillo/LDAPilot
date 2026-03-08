import { create } from 'zustand'
import { SearchParams, SearchResult, ScopeSub } from '../types/ldap'
import * as wails from '../lib/wails'
import { toast } from '../components/ui/Toast'

export interface SearchHistoryItem {
  id: string;
  params: SearchParams;
  resultCount: number;
  timestamp: number;
  pinned: boolean;
}

interface SearchState {
  params: SearchParams;
  results: SearchResult | null;
  loading: boolean;
  error: string | null;
  history: SearchHistoryItem[];

  setParams: (params: Partial<SearchParams>) => void;
  executeSearch: (profileId: string, filterOverride?: string) => Promise<void>;
  clearResults: () => void;
  restoreSearch: (item: SearchHistoryItem) => void;
  togglePin: (id: string) => void;
  removeHistory: (id: string) => void;
  clearHistory: () => void;
}

const defaultParams: SearchParams = {
  baseDN: '',
  scope: ScopeSub,
  filter: '(objectClass=*)',
  attributes: [],
  sizeLimit: 1000,
  timeLimit: 30,
};

export const useSearchStore = create<SearchState>((set, get) => ({
  params: { ...defaultParams },
  results: null,
  loading: false,
  error: null,
  history: [],

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
}))
