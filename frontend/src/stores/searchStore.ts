import { create } from 'zustand'
import { SearchParams, SearchResult, ScopeSub, LDAPEntry, type ServerType } from '../types/ldap'
import * as wails from '../lib/wails'
import { useConnectionStore } from './connectionStore'
import { forgetAccountStatuses } from './accountStatusCache'
import { ensureServerType } from '../components/ui/commands'
import { ACCOUNT_STATUS_ATTRIBUTES } from '../components/ui/accountStatus'
import {
  DEFAULT_QUICK, addToHistory, baseForProfile, defaultResultColumns, readJSON, withStatusAttributes, writeJSON,
  type QuickSearchSnapshot, type SavedSearch, type SearchHistoryItem, type SearchPanelMode,
} from '../components/search/searchModel'
import type { SortState } from '../components/ui/DataTable'
import type { CountedResult } from '../components/search/snapshotModel'
import { SearchRun } from '../components/search/searchApi'

export type { SearchHistoryItem, SavedSearch, SearchPanelMode, QuickSearchSnapshot }

const DEFAULT_DISPLAY_COLUMNS = defaultResultColumns(null);

/** localStorage keys (per-viewer conveniences; every access is guarded). */
const SAVED_KEY = 'ldapilot-saved-searches';
const HISTORY_KEY = 'ldapilot-search-history';
const MODE_KEY = 'ldapilot-search-mode';
const BASES_KEY = 'ldapilot-search-bases';
const COLUMNS_KEY = 'ldapilot-search-columns';

/**
 * Status attributes the server returns only on request (`*` leaves them
 * out); always asked for, hidden unless the user requested them.
 */
export const OPERATIONAL_STATUS_ATTRIBUTES = [
  'msDS-User-Account-Control-Computed', 'pwdAccountLockedTime', 'pwdReset', 'nsAccountLock',
  // 389DS lockout and "must change" (operational there): RW3-P-01 / RW3-P-02.
  'accountUnlockTime', 'passwordExpirationTime',
];

/** The search that produced the current results (results carry their own parameters). */
export interface ResultsSearch {
  /** Identifies the results object of this search (see currentResultsSearch). */
  id: number;
  profileId: string;
  /** Parameters as entered (return attributes without the added status attributes). */
  params: SearchParams;
  /** Attributes added for type / status (lower case): not shown in columns or exports unless requested. */
  hidden: string[];
  mode: SearchPanelMode;
  /** The quick search (text, options) when it came from the quick mode. */
  quick?: QuickSearchSnapshot;
  serverType?: ServerType | null;
  startedAt: number;
  finishedAt: number;
}

/**
 * Results written by a search of this store carry the id of their search.
 * Rows replaced later (entry moved, bulk refresh, deleted entries) keep it,
 * because they are copies (`{ ...prev, entries }`); results written by others
 * (account reports) have none. `found` is the row count the search found
 * (deletions remove rows later: snapshotModel.deletedCount).
 */
type TaggedResult = CountedResult;

/**
 * The search of the current results, or null when the results were written
 * by others (account reports) after it: strip, "Load all", exports and the
 * name-resolution hint use it, never a stale one.
 */
export function currentResultsSearch(s: { results: SearchResult | null; resultsSearch: ResultsSearch | null }): ResultsSearch | null {
  const rs = s.resultsSearch;
  return rs && s.results && (s.results as TaggedResult).searchId === rs.id ? rs : null;
}

/** The last search failed or was cancelled; the previous results stay. */
export interface SearchFailure {
  kind: 'error' | 'cancelled';
  message: string;
  profileId: string;
  params: SearchParams;
  at: number;
}

/** Context of a search started from the panel (mode and quick options for history, results and saved searches). */
export interface SearchOrigin {
  mode?: SearchPanelMode;
  quick?: QuickSearchSnapshot;
  serverType?: ServerType | null;
  /** Parameters of this run only (the quick mode searches the subtree with all attributes and no controls). */
  overrides?: Partial<SearchParams>;
}

interface SearchState {
  params: SearchParams;
  results: SearchResult | null;
  /** Profile the current results were searched on (null without results). */
  resultsProfileId: string | null;
  /** The search of the current results (null for results written by others, e.g. account reports). */
  resultsSearch: ResultsSearch | null;
  /** The last search failed / was cancelled (the results and their strip are the previous ones). */
  lastFailure: SearchFailure | null;
  /** Sort of the results table, kept across searches. */
  resultsSort: SortState | null;
  loading: boolean;
  /** True between cancelSearch() and the end of the running search. */
  cancelling: boolean;
  /** Profile the running search was started on; null when no search runs. */
  runningProfileId: string | null;
  /** Parameters of the running search (the results strip shows them while it runs); null when none runs. */
  runningParams: SearchParams | null;
  /** Message of the last failed search (kept for older readers; the results strip shows it). */
  error: string | null;
  /** Search history of all connections (persisted; the panel shows the active connection's). */
  history: SearchHistoryItem[];
  displayColumns: string[];
  savedSearches: SavedSearch[];
  /** Mode of the search panel (persisted; Reports' "Edit as Search" switches it to advanced). */
  panelMode: SearchPanelMode;
  /** Text and options of the quick mode. */
  quick: QuickSearchSnapshot;
  /** Remembered base DN per connection (persisted). */
  baseDNs: Record<string, string>;
  /** Connection whose base DN params.baseDN is (switching connections restores the other one's). */
  baseProfileId: string | null;

  setPanelMode: (mode: SearchPanelMode) => void;
  setParams: (params: Partial<SearchParams>) => void;
  setQuick: (quick: Partial<QuickSearchSnapshot>) => void;
  /** Sets the base DN of the active connection's searches and remembers it for that connection. */
  setBaseDN: (profileId: string | null, baseDN: string) => void;
  /** Runs a search; a search still running is cancelled and replaced. */
  executeSearch: (profileId: string, filterOverride?: string, origin?: SearchOrigin) => Promise<void>;
  /** Runs the current results' search again with changes (e.g. sizeLimit 0 = "Load all"). */
  rerunResults: (changes: Partial<SearchParams>) => Promise<void>;
  /** Cancels the running search on the profile it was started on. */
  cancelSearch: () => Promise<void>;
  clearResults: () => void;
  setResultsSort: (sort: SortState | null) => void;
  restoreSearch: (item: SearchHistoryItem) => void;
  togglePin: (id: string) => void;
  removeHistory: (id: string) => void;
  /** Removes the unpinned entries (of one connection when profileId is given). */
  clearHistory: (profileId?: string | null) => void;
  /**
   * Sets the attribute columns; `profileId` = the connection the next search
   * runs on (they are kept per connection, RW2-S-03).
   */
  setDisplayColumns: (columns: string[], profileId?: string | null) => void;
  addDisplayColumn: (column: string) => void;
  removeDisplayColumn: (column: string) => void;
  getEntryAttrValue: (entry: LDAPEntry, attrName: string) => string;
  /** Saves the visible search (quick text + options, or the advanced filter) with its connection and base. */
  saveSearch: (name: string, origin?: SearchOrigin & { profileId?: string | null; profileName?: string }) => void;
  removeSavedSearch: (id: string) => void;
  /**
   * Loads a saved search into the panel; on another connection than the one
   * it was saved on, the base DN is kept only when it lies in this
   * connection's base. Returns a warning for the panel, or null.
   */
  restoreSavedSearch: (saved: SavedSearch, profileId?: string | null) => string | null;
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

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : 'Search failed';
}

/** Base DN of a profile: the remembered one, else the profile's base DN. */
function rememberedBase(profileId: string | null, bases: Record<string, string>): string {
  if (!profileId) return '';
  if (bases[profileId] !== undefined) return bases[profileId];
  return useConnectionStore.getState().profiles.find((p) => p.id === profileId)?.baseDN || '';
}

/** Server's default naming context (searches without any base DN). */
async function defaultNamingContext(profileId: string): Promise<string> {
  try {
    const info = await wails.GetServerInfo(profileId);
    return info?.defaultNamingContext || info?.namingContexts?.[0] || '';
  } catch {
    return '';
  }
}

/**
 * A search outside the panel's results: a results tab's re-run, a report
 * that runs into its tab (DEF-16 / DEF-22). Same rules as the panel's
 * search (empty base = profile base, else the default naming context;
 * objectClass and the account status attributes always read, hidden
 * unless requested; cached statuses of the rows forgotten), but no
 * history, no failure state and nothing written to this store. With
 * `runId` it runs as SearchService.SearchRun (CancelSearchRun stops it).
 */
export async function searchDetached(
  profileId: string,
  params: SearchParams,
  origin: SearchOrigin & { runId?: string } = {},
): Promise<{ result: CountedResult; search: ResultsSearch }> {
  const startedAt = Date.now();
  const sent: SearchParams = { ...params, ...origin.overrides };
  if (!sent.baseDN) {
    sent.baseDN = useConnectionStore.getState().profiles.find((p) => p.id === profileId)?.baseDN || (await defaultNamingContext(profileId));
  }
  const attrs = withStatusAttributes(sent.attributes || [], ACCOUNT_STATUS_ATTRIBUTES, OPERATIONAL_STATUS_ATTRIBUTES);
  const request = { ...sent, attributes: attrs.request };
  const answer = origin.runId ? await SearchRun(profileId, origin.runId, request) : await wails.SearchLDAP(profileId, request);
  const entries = answer?.entries ?? [];
  const result: CountedResult = { ...answer, entries, totalCount: answer?.totalCount ?? 0, truncated: !!answer?.truncated, found: entries.length };
  forgetAccountStatuses(profileId, result.entries.map((e) => e.dn));
  return {
    result,
    search: {
      id: 0, profileId, params: sent, hidden: attrs.hidden, mode: origin.mode ?? 'advanced', quick: origin.mode === 'quick' ? origin.quick : undefined,
      serverType: origin.serverType ?? null, startedAt, finishedAt: Date.now(),
    },
  };
}

// Identifies the newest search; results and errors of an older (replaced) search are dropped.
let searchSeq = 0;

/**
 * Attribute columns per connection (RW2-S-03: sAMAccountName / department
 * from an AD report stayed as empty columns on OpenLDAP). `displayColumns`
 * belongs to `columnsProfileId`; a search on another connection parks them
 * and takes that connection's own, else the defaults of its server type
 * (RW3-S-03: LDAP cn, uid, mail, description). Kept in localStorage, so a
 * reload keeps each connection's columns.
 */
const columnsByProfile: Record<string, string[]> = (() => {
  const raw = readJSON<Record<string, unknown>>(COLUMNS_KEY, {});
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (Array.isArray(v)) out[k] = v.filter((c): c is string => typeof c === 'string');
  }
  return out;
})();
let columnsProfileId: string | null = null;

function rememberColumns(profileId: string | null, columns: string[]) {
  if (!profileId) return;
  columnsByProfile[profileId] = [...columns];
  writeJSON(COLUMNS_KEY, columnsByProfile);
}

/** The columns for a search on profileId (parks the current ones of their connection); null = keep them. */
function columnsFor(profileId: string, current: string[], serverType: ServerType | null | undefined): string[] | null {
  if (columnsProfileId === profileId) return null;
  if (columnsProfileId !== null) rememberColumns(columnsProfileId, current);
  columnsProfileId = profileId;
  return [...(columnsByProfile[profileId] ?? defaultResultColumns(serverType))];
}

export const useSearchStore = create<SearchState>((set, get) => {
  /** Runs `params` on `profileId`: the one place that sets results, failures and history. */
  async function run(profileId: string, params: SearchParams, origin: SearchOrigin, addHistory: boolean): Promise<void> {
    // One search at a time: a new one (e.g. a report started while a search runs) replaces the running one.
    if (get().loading) await get().cancelSearch();
    const token = ++searchSeq;
    const startedAt = Date.now();
    const sent = { ...params };
    // The server type picks the default columns of a connection without its own (cached read).
    const serverType = origin.serverType !== undefined ? origin.serverType : columnsProfileId === profileId ? null : await ensureServerType(profileId).catch(() => null);
    if (token !== searchSeq) return;
    const columns = columnsFor(profileId, get().displayColumns, serverType);
    set({ loading: true, cancelling: false, error: null, runningProfileId: profileId, runningParams: { ...sent }, ...(columns ? { displayColumns: columns } : {}) });
    try {
      if (!sent.baseDN) {
        sent.baseDN = useConnectionStore.getState().profiles.find((p) => p.id === profileId)?.baseDN || (await defaultNamingContext(profileId));
        if (token === searchSeq) set({ runningParams: { ...sent } });
      }
      // objectClass and the account status attributes are always read (type,
      // status and verbs of the rows); they stay out of columns and exports.
      const attrs = withStatusAttributes(sent.attributes || [], ACCOUNT_STATUS_ATTRIBUTES, OPERATIONAL_STATUS_ATTRIBUTES);
      const answer = await wails.SearchLDAP(profileId, { ...sent, attributes: attrs.request });
      if (token !== searchSeq) return;
      const entries = answer?.entries ?? [];
      const result: TaggedResult = { ...answer, entries, totalCount: answer?.totalCount ?? 0, truncated: !!answer?.truncated, searchId: token, found: entries.length };
      // A search (re-)read these entries: their attributes decide the row states, not an older
      // remembered status (an outside lockout hidden by a cached "not locked", RW2-P-01).
      forgetAccountStatuses(profileId, result.entries.map((e) => e.dn));
      const count = result.entries.length;
      const historyItem: SearchHistoryItem = {
        id: newId(),
        params: { ...sent },
        resultCount: count,
        timestamp: Date.now(),
        pinned: false,
        profileId,
        mode: origin.mode ?? 'advanced',
        quick: origin.mode === 'quick' ? origin.quick : undefined,
      };
      set((state) => {
        const history = addHistory ? addToHistory(state.history, historyItem) : state.history;
        if (addHistory) writeJSON(HISTORY_KEY, history);
        // Remembered as asked (empty = the profile base / default naming context, resolved per run).
        const bases = { ...state.baseDNs, [profileId]: params.baseDN };
        writeJSON(BASES_KEY, bases);
        return {
          results: result,
          resultsProfileId: profileId,
          resultsSearch: {
            id: token, profileId, params: { ...sent }, hidden: attrs.hidden, mode: historyItem.mode!, quick: historyItem.quick,
            serverType: origin.serverType ?? null, startedAt, finishedAt: Date.now(),
          },
          lastFailure: null,
          loading: false,
          cancelling: false,
          runningProfileId: null,
          runningParams: null,
          history,
          baseDNs: bases,
        };
      });
      // No toast for a read (UX-9): the results strip and the status bar show the count.
    } catch (err) {
      if (token !== searchSeq) return;
      const cancelled = wails.isSearchCancelled(err);
      // One error surface: the results strip (no toast). The previous results stay.
      const failure: SearchFailure = {
        kind: cancelled ? 'cancelled' : 'error',
        message: cancelled ? 'cancelled' : errorText(err),
        profileId,
        params: sent,
        at: Date.now(),
      };
      set({ error: cancelled ? null : failure.message, lastFailure: failure, loading: false, cancelling: false, runningProfileId: null, runningParams: null });
    }
  }

  return {
    params: { ...defaultParams },
    results: null,
    resultsProfileId: null,
    resultsSearch: null,
    lastFailure: null,
    resultsSort: null,
    loading: false,
    cancelling: false,
    runningProfileId: null,
    runningParams: null,
    error: null,
    history: readJSON<SearchHistoryItem[]>(HISTORY_KEY, []).filter((h) => h && h.params && typeof h.params.filter === 'string'),
    displayColumns: [...DEFAULT_DISPLAY_COLUMNS],
    savedSearches: readJSON<SavedSearch[]>(SAVED_KEY, []),
    panelMode: readJSON<SearchPanelMode>(MODE_KEY, 'quick') === 'advanced' ? 'advanced' : 'quick',
    quick: { ...DEFAULT_QUICK },
    baseDNs: readJSON<Record<string, string>>(BASES_KEY, {}),
    baseProfileId: null,

    setPanelMode: (mode) => {
      writeJSON(MODE_KEY, mode);
      set({ panelMode: mode });
    },

    setParams: (params: Partial<SearchParams>) => {
      set((state) => ({
        params: { ...state.params, ...params },
      }));
    },

    setQuick: (quick) => set((state) => ({ quick: { ...state.quick, ...quick } })),

    setBaseDN: (profileId, baseDN) => {
      set((state) => {
        if (!profileId) return { params: { ...state.params, baseDN } };
        const bases = { ...state.baseDNs, [profileId]: baseDN };
        writeJSON(BASES_KEY, bases);
        return { params: { ...state.params, baseDN }, baseDNs: bases, baseProfileId: profileId };
      });
    },

    executeSearch: async (profileId: string, filterOverride?: string, origin?: SearchOrigin) => {
      const params = { ...get().params, ...origin?.overrides };
      if (filterOverride) {
        params.filter = filterOverride;
        set((state) => ({ params: { ...state.params, filter: filterOverride } }));
      }
      // Without an origin (reports, AI filter links) the search is an advanced one.
      await run(profileId, params, origin ?? { mode: 'advanced' }, true);
    },

    rerunResults: async (changes) => {
      const rs = currentResultsSearch(get());
      if (!rs) return;
      await run(rs.profileId, { ...rs.params, ...changes }, { mode: rs.mode, quick: rs.quick, serverType: rs.serverType }, false);
    },

    cancelSearch: async () => {
      const { loading, runningProfileId } = get();
      if (!loading || !runningProfileId) return;
      const token = searchSeq;
      set({ cancelling: true });
      try {
        // 0: the search already finished (or has not reached the backend yet)
        const cancelled = await wails.CancelSearch(runningProfileId);
        if (cancelled === 0 && token === searchSeq) set({ cancelling: false });
      } catch {
        if (token === searchSeq) set({ cancelling: false });
      }
    },

    clearResults: () => {
      set({ results: null, resultsProfileId: null, resultsSearch: null, lastFailure: null, error: null });
    },

    setResultsSort: (sort) => set({ resultsSort: sort }),

    restoreSearch: (item: SearchHistoryItem) => {
      set((state) => ({
        params: { ...item.params },
        quick: item.quick ? { ...item.quick } : state.quick,
      }));
      if (item.mode) get().setPanelMode(item.mode);
    },

    togglePin: (id: string) => {
      set((state) => {
        const history = state.history.map((h) => (h.id === id ? { ...h, pinned: !h.pinned } : h));
        writeJSON(HISTORY_KEY, history);
        return { history };
      });
    },

    removeHistory: (id: string) => {
      set((state) => {
        const history = state.history.filter((h) => h.id !== id);
        writeJSON(HISTORY_KEY, history);
        return { history };
      });
    },

    clearHistory: (profileId?: string | null) => {
      set((state) => {
        const history = state.history.filter((h) => h.pinned || (profileId != null && h.profileId !== undefined && h.profileId !== profileId));
        writeJSON(HISTORY_KEY, history);
        return { history };
      });
    },

    setDisplayColumns: (columns: string[], profileId?: string | null) => {
      if (profileId) columnsFor(profileId, get().displayColumns, null);
      set({ displayColumns: columns });
      rememberColumns(columnsProfileId, columns);
    },

    addDisplayColumn: (column: string) => {
      set((state) => {
        if (state.displayColumns.some((c) => c.toLowerCase() === column.toLowerCase())) return state;
        return { displayColumns: [...state.displayColumns, column] };
      });
      rememberColumns(columnsProfileId, get().displayColumns);
    },

    removeDisplayColumn: (column: string) => {
      set((state) => ({
        displayColumns: state.displayColumns.filter((c) => c !== column),
      }));
      rememberColumns(columnsProfileId, get().displayColumns);
    },

    getEntryAttrValue: (_entry: LDAPEntry, attrName: string) => {
      const entry = _entry;
      if (!entry?.attributes) return '';
      const attr = entry.attributes.find(
        (a) => a.name.toLowerCase() === attrName.toLowerCase()
      );
      if (!attr || !attr.values || attr.values.length === 0) return '';
      if (attr.values.length === 1) return attr.values[0];
      return attr.values.join('; ');
    },

    saveSearch: (name: string, origin) => {
      const state = get();
      const mode = origin?.mode ?? state.panelMode;
      const saved: SavedSearch = {
        id: newId(),
        name,
        params: { ...state.params },
        displayColumns: [...state.displayColumns],
        createdAt: Date.now(),
        profileId: origin?.profileId ?? undefined,
        profileName: origin?.profileName,
        serverType: origin?.serverType ?? null,
        mode,
        quick: mode === 'quick' ? { ...(origin?.quick ?? state.quick) } : undefined,
      };
      const updated = [...state.savedSearches, saved];
      set({ savedSearches: updated });
      writeJSON(SAVED_KEY, updated);
    },

    removeSavedSearch: (id: string) => {
      const updated = get().savedSearches.filter(s => s.id !== id);
      set({ savedSearches: updated });
      writeJSON(SAVED_KEY, updated);
    },

    restoreSavedSearch: (saved: SavedSearch, profileId?: string | null) => {
      let warning: string | null = null;
      let baseDN = saved.params.baseDN;
      if (profileId && saved.profileId && saved.profileId !== profileId) {
        const profiles = useConnectionStore.getState().profiles;
        const here = profiles.find((p) => p.id === profileId);
        const there = profiles.find((p) => p.id === saved.profileId)?.name || saved.profileName || 'another connection';
        const b = baseForProfile(saved.params.baseDN, rememberedBase(profileId, get().baseDNs) || here?.baseDN || '');
        baseDN = b.baseDN;
        warning = b.replaced
          ? `Saved on "${there}". Its base DN does not belong to "${here?.name ?? 'this connection'}", so this connection's base DN is used.`
          : `Saved on "${there}"; it runs on "${here?.name ?? 'this connection'}" now.`;
      }
      const target = profileId ?? useConnectionStore.getState().activeProfileId;
      const own = target ? columnsFor(target, get().displayColumns, null) : null;
      // Saved on another connection: that connection's columns (sAMAccountName on OpenLDAP,
      // RW3-S-01) stay out; this connection keeps its own.
      const foreign = !!target && !!saved.profileId && saved.profileId !== target;
      const columns = foreign ? (own ?? get().displayColumns) : [...saved.displayColumns];
      set((state) => ({
        params: { ...saved.params, baseDN },
        displayColumns: columns,
        quick: saved.quick ? { ...saved.quick } : state.quick,
      }));
      if (!foreign) rememberColumns(columnsProfileId, columns);
      get().setPanelMode(saved.mode ?? 'advanced');
      return warning;
    },

    loadSavedSearches: () => {
      set({ savedSearches: readJSON<SavedSearch[]>(SAVED_KEY, []) });
    },
  };
})

// --- Connection switch: each connection searches its own base --------------

/**
 * The base DN belongs to a connection: switching the active connection puts
 * that connection's remembered base DN (else its profile base DN, else
 * empty = the server's default naming context) into the search parameters.
 */
function applyProfileBase(profileId: string | null) {
  const s = useSearchStore.getState();
  if (profileId === s.baseProfileId) return;
  useSearchStore.setState({
    params: { ...s.params, baseDN: rememberedBase(profileId, s.baseDNs) },
    baseProfileId: profileId,
  });
}
applyProfileBase(useConnectionStore.getState().activeProfileId);
useConnectionStore.subscribe((s, prev) => {
  if (s.activeProfileId !== prev.activeProfileId || (s.profiles !== prev.profiles && useSearchStore.getState().baseProfileId !== s.activeProfileId)) {
    applyProfileBase(s.activeProfileId);
  }
});
