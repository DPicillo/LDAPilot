import { create } from 'zustand'
import { EditorTab } from '../types/ui'
import { LDAPEntry } from '../types/ldap'
import * as wails from '../lib/wails'
import { normalizeDN } from '../lib/dn'
import {
  MAX_RECENTS, RECENTS_KEY, adoptServerDN, classifyLoadError, emitEntryEvent, entryLabel, historyAfterMove, onEntryEvent, parseRecents,
  recentsAfterDelete, recentsAfterMove, recentsSetObjectClass, recentsTouch, sameDN, tabIdOf, tabNeedsReload,
  movedTabCarries, tabsAfterDelete, tabsAfterMove, tabsOfDN, type NavEntry, type RecentEntry,
} from '../lib/entryEvents'
import { useConnectionStore } from './connectionStore'
import { dropScopedUnsavedEdits, hasUnsavedEdits, moveScopedUnsavedEdits, subscribeUnsavedEdits } from './unsavedEdits'
import { dropTabViews, moveTabView } from './tabViewState'

/** Results tabs (special tabs with their own rows; data in components/search/resultsSnapshots). */
export { RESULTS_TAB_PREFIX, isResultsTabId } from '../components/search/snapshotModel'

/**
 * Editor tabs (SPEC 10.2, UX-3): entry tabs keyed `${profileId}:${dn}`,
 * special tabs (Server Info, Search Results, schema details, results tabs
 * `__results__:<n>` = snapshots of rows: components/search/resultsSnapshots,
 * DEF-16), THE preview tab, the navigation history, the loaded entries and
 * the recent entries (localStorage `ldapilot-recent-entries`).
 *
 * - `dirty` = unsaved local input only, mirrored from stores/unsavedEdits
 *   (ED-02). `closeTab` / `closeTabs` ask before they discard it (ED-03): the
 *   question is `pendingDiscard`, rendered by MainPanel.
 * - Tabs follow the §0.1 entry events (ED-04, ED-05, ED-22): moved tabs are
 *   re-keyed and reloaded, deleted ones switch to a Deleted state, restored
 *   ones reload, `account-changed` reloads the entry quietly.
 * - A failed load never shows cached values (ED-04): noSuchObject -> state
 *   `missing` (+ `ldapilot:entry-missing`), other errors -> state `error`.
 *   A load that fails while the connection is lost or closed keeps the values,
 *   marked stale, and never toasts (ED-16).
 * - Back / Forward navigate inside the preview tab (ED-17).
 */

/** A question before unsaved input is discarded (MainPanel renders it). */
export type PendingDiscard =
  | { action: 'close'; tabIds: string[] }
  | { action: 'navigate'; tabIds: string[]; run: () => void }

interface EditorState {
  tabs: EditorTab[];
  activeTabId: string | null;
  entries: Record<string, LDAPEntry>;
  loadingEntries: Record<string, boolean>;

  // Navigation history
  navHistory: NavEntry[];
  navIndex: number;

  /** Tabs with unsaved input waiting for "Discard changes?" (null = no question). */
  pendingDiscard: PendingDiscard | null;
  /**
   * Bumped by every openEntry, also of the tab that is already active: the
   * shell leaves a maximized bottom panel on it (RW2-R-01).
   */
  revealSeq: number;

  /**
   * Opens an entry tab (or activates its existing tab). `preview: true`
   * opens it as THE preview tab, replacing the current clean preview tab
   * (single click, Enter); without it the tab is pinned (double-click,
   * Ctrl+Enter, every older caller) and an existing preview tab of the entry
   * becomes pinned. An existing tab that is deleted / missing / failed or
   * older than a move or restore of its DN is reloaded.
   */
  openEntry: (profileId: string, dn: string, opts?: { preview?: boolean }) => void;
  /** Keeps a preview tab open (pins it). */
  pinTab: (tabId: string) => void;
  /** Marks the open tabs of a profile stale (connection lost or closed) or fresh again. */
  setTabsStale: (profileId: string, stale: boolean) => void;
  /** Re-opens saved tabs of a profile (session restore) without loading them or touching history and recent entries. */
  restoreTabs: (profileId: string, tabs: { dn: string; preview?: boolean }[], activeDn?: string) => void;
  /** Closes a tab; a tab with unsaved input asks first ("Discard unsaved changes to …?"). */
  closeTab: (tabId: string) => void;
  /** Closes several tabs (Close Others / All / to the Right); asks once for those with unsaved input. */
  closeTabs: (tabIds: string[]) => void;
  /** Answers pendingDiscard: discard (true) runs the close / navigation, false keeps everything. */
  resolveDiscard: (discard: boolean) => void;
  setActiveTab: (tabId: string) => void;
  /**
   * (Re)loads an entry. `silent` keeps the current values on screen while it
   * loads (no spinner: open sub-tabs stay mounted).
   */
  refreshEntry: (profileId: string, dn: string, opts?: { silent?: boolean }) => Promise<void>;
  /** Marks unsaved input (pins a preview tab). Prefer useUnsavedEdits, which the tab mirrors. */
  markDirty: (tabId: string) => void;
  markClean: (tabId: string) => void;
  updateEntry: (tabId: string, entry: LDAPEntry) => void;

  goBack: () => void;
  goForward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;

  addSpecialTab: (id: string, label: string) => void;
  /** Renames a special tab (a results tab whose report ran again). */
  setSpecialTabLabel: (id: string, label: string) => void;
}

/** Most history entries kept. */
const MAX_HISTORY = 100;

/** A tab holds unsaved input (the dot, the close guard). */
export function isTabDirty(tab: EditorTab): boolean {
  return tab.dirty || (!!tab.dn && hasUnsavedEdits(tab.profileId, tab.dn));
}

// --- Recent entries ----------------------------------------------------------------------

function updateRecents(fn: (list: RecentEntry[]) => RecentEntry[] | null) {
  try {
    const next = fn(parseRecents(localStorage.getItem(RECENTS_KEY)));
    if (next) localStorage.setItem(RECENTS_KEY, JSON.stringify(next.slice(0, MAX_RECENTS)));
  } catch {
    /* blocked storage: recents are a convenience */
  }
}

// --- Change times (ED-22) and load sequence ---------------------------------------------------

const changeKey = (profileId: string, dn: string) => `${profileId}\n${normalizeDN(dn)}`;
/** When the app last learned that an entry moved here or was restored. */
const changedAt = new Map<string, number>();
const noteChange = (profileId: string, dn: string) => changedAt.set(changeKey(profileId, dn), Date.now());

/** Latest load per tab id: an older response never overwrites a newer one. */
const loadSeq = new Map<string, number>();

function pushHistory(state: Pick<EditorState, 'navHistory' | 'navIndex'>, nav: NavEntry): Pick<EditorState, 'navHistory' | 'navIndex'> {
  const kept = state.navHistory.slice(0, state.navIndex + 1);
  const last = kept[kept.length - 1];
  if (!last || last.profileId !== nav.profileId || !sameDN(last.dn, nav.dn)) kept.push(nav);
  const navHistory = kept.slice(-MAX_HISTORY);
  return { navHistory, navIndex: navHistory.length - 1 };
}

const findEntryTab = (tabs: EditorTab[], profileId: string, dn: string) =>
  tabs.find((t) => t.profileId === profileId && !!t.dn && sameDN(t.dn, dn));

function withoutKeys<T>(rec: Record<string, T>, ids: Iterable<string>): Record<string, T> {
  let out = rec;
  for (const id of ids) {
    if (id in out) {
      if (out === rec) out = { ...rec };
      delete out[id];
    }
  }
  return out;
}

export const useEditorStore = create<EditorState>((set, get) => {
  /** Removes tabs without asking; the active tab moves to the neighbour. */
  const removeTabs = (ids: string[]) => {
    const drop = new Set(ids);
    set((state) => {
      if (!state.tabs.some((t) => drop.has(t.id))) return state;
      const tabIndex = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const newTabs = state.tabs.filter((t) => !drop.has(t.id));
      let newActiveId = state.activeTabId;
      if (newActiveId && drop.has(newActiveId)) {
        if (newTabs.length === 0) newActiveId = null;
        else {
          // The first remaining tab at or after the closed one, else the last.
          const after = state.tabs.slice(tabIndex + 1).find((t) => !drop.has(t.id));
          newActiveId = (after ?? newTabs[newTabs.length - 1]).id;
        }
      }
      return {
        tabs: newTabs,
        activeTabId: newActiveId,
        entries: withoutKeys(state.entries, drop),
        loadingEntries: withoutKeys(state.loadingEntries, drop),
      };
    });
    for (const id of drop) loadSeq.delete(id);
  };

  /**
   * Re-keys tab `tabId` to the server's spelling of its DN after a load
   * (adoptServerDN); returns the new DN, or null when nothing changed. The
   * loaded values stay; view state and drafts move with the tab.
   */
  const adoptServer = (profileId: string, tabId: string, tabDN: string, serverDN: string | undefined): string | null => {
    const next = adoptServerDN(tabDN, serverDN);
    if (!next) return null;
    const newId = tabIdOf(profileId, next);
    if (newId === tabId || get().tabs.some((t) => t.id === newId) || !get().tabs.some((t) => t.id === tabId)) return null;
    // View state and drafts move with the tab; the closed-tab clean-up waits (rekeyTabs).
    rekeyTabs(() => {
      moveTabView(tabId, newId);
      moveScopedUnsavedEdits(tabId, newId, next);
    }, () => set((state) => {
      if (!state.tabs.some((t) => t.id === tabId)) return state;
      const entries = { ...state.entries };
      const loadingEntries = { ...state.loadingEntries };
      if (tabId in entries) entries[newId] = entries[tabId];
      delete entries[tabId];
      delete loadingEntries[tabId];
      return {
        tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, id: newId, dn: next, label: entryLabel(next) } : t)),
        entries,
        loadingEntries,
        activeTabId: state.activeTabId === tabId ? newId : state.activeTabId,
        navHistory: historyAfterMove(state.navHistory, profileId, tabDN, next),
        pendingDiscard: state.pendingDiscard ? { ...state.pendingDiscard, tabIds: state.pendingDiscard.tabIds.map((id) => (id === tabId ? newId : id)) } : null,
      };
    }));
    const seq = loadSeq.get(tabId);
    loadSeq.delete(tabId);
    if (seq !== undefined) loadSeq.set(newId, seq);
    updateRecents((list) => recentsAfterMove(list, profileId, tabDN, next));
    return next;
  };

  /** Puts a new entry tab into the bar: as THE preview tab (replacing `replaceId` or the clean preview tab) or pinned at the end. */
  const placeTab = (profileId: string, dn: string, preview: boolean, replaceId?: string): string => {
    const tabId = tabIdOf(profileId, dn);
    const newTab: EditorTab = { id: tabId, profileId, label: entryLabel(dn), dn, dirty: false, preview: preview || undefined };
    set((state) => {
      const replace = replaceId
        ? state.tabs.findIndex((t) => t.id === replaceId)
        : preview ? state.tabs.findIndex((t) => t.preview && !isTabDirty(t)) : -1;
      let tabs: EditorTab[];
      let entries = state.entries;
      let loadingEntries = state.loadingEntries;
      if (replace >= 0) {
        const old = state.tabs[replace];
        tabs = [...state.tabs];
        tabs[replace] = newTab;
        entries = withoutKeys(entries, [old.id]);
        loadingEntries = withoutKeys(loadingEntries, [old.id]);
      } else {
        tabs = [...state.tabs, newTab];
      }
      return { tabs, entries, loadingEntries, activeTabId: tabId };
    });
    return tabId;
  };

  /** Shows history entry `index`: its open tab, else inside the preview tab (ED-17). */
  const navigateHistory = (index: number) => {
    const state = get();
    const nav = state.navHistory[index];
    if (!nav) return;
    const existing = findEntryTab(state.tabs, nav.profileId, nav.dn);
    if (existing) {
      set({ activeTabId: existing.id, navIndex: index });
      if (tabNeedsReload(existing, changedAt.get(changeKey(existing.profileId, existing.dn)))) void get().refreshEntry(existing.profileId, existing.dn);
      return;
    }
    const active = state.tabs.find((t) => t.id === state.activeTabId);
    const go = () => {
      const cur = get().tabs.find((t) => t.id === get().activeTabId);
      // Inside the current preview tab (browser-like); from a pinned tab the
      // history entry opens as the preview tab instead of a new pinned tab.
      placeTab(nav.profileId, nav.dn, true, cur?.preview ? cur.id : undefined);
      set({ navIndex: index });
      void get().refreshEntry(nav.profileId, nav.dn);
    };
    if (active?.preview && isTabDirty(active)) {
      set({ pendingDiscard: { action: 'navigate', tabIds: [active.id], run: go } });
      return;
    }
    go();
  };

  return {
    tabs: [],
    activeTabId: null,
    entries: {},
    loadingEntries: {},
    navHistory: [],
    navIndex: -1,
    pendingDiscard: null,
    revealSeq: 0,

    openEntry: (profileId: string, dn: string, opts?: { preview?: boolean }) => {
      const preview = !!opts?.preview;
      updateRecents((list) => recentsTouch(list, profileId, dn, Date.now()));
      set((state) => ({ revealSeq: state.revealSeq + 1 }));

      const existingTab = findEntryTab(get().tabs, profileId, dn);
      if (existingTab) {
        set((state) => ({
          // A pinned open of the preview tab keeps it.
          tabs: !preview && existingTab.preview ? state.tabs.map((t) => (t.id === existingTab.id ? { ...t, preview: undefined } : t)) : state.tabs,
          activeTabId: existingTab.id,
          ...pushHistory(state, { profileId, dn: existingTab.dn }),
        }));
        if (tabNeedsReload(existingTab, changedAt.get(changeKey(profileId, dn)))) void get().refreshEntry(profileId, existingTab.dn);
        return;
      }

      placeTab(profileId, dn, preview);
      set((state) => pushHistory(state, { profileId, dn }));
      void get().refreshEntry(profileId, dn);
    },

    pinTab: (tabId: string) => {
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === tabId && t.preview ? { ...t, preview: undefined } : t)),
      }));
    },

    setTabsStale: (profileId: string, stale: boolean) => {
      set((state) => {
        if (!state.tabs.some((t) => t.profileId === profileId && !!t.stale !== stale && t.dn)) return state;
        return { tabs: state.tabs.map((t) => (t.profileId === profileId && t.dn ? { ...t, stale: stale || undefined } : t)) };
      });
    },

    restoreTabs: (profileId: string, saved: { dn: string; preview?: boolean }[], activeDn?: string) => {
      set((state) => {
        const have = new Set(state.tabs.map((t) => t.id));
        const added: EditorTab[] = [];
        for (const s of saved) {
          const id = tabIdOf(profileId, s.dn);
          if (!s.dn || have.has(id)) continue;
          have.add(id);
          added.push({ id, profileId, label: entryLabel(s.dn), dn: s.dn, dirty: false, preview: s.preview || undefined });
        }
        if (!added.length) return state;
        const active = activeDn ? added.find((t) => t.dn === activeDn) : undefined;
        return { tabs: [...state.tabs, ...added], activeTabId: (active ?? added[added.length - 1]).id };
      });
    },

    closeTab: (tabId: string) => get().closeTabs([tabId]),

    closeTabs: (tabIds: string[]) => {
      const state = get();
      const list = tabIds.map((id) => state.tabs.find((t) => t.id === id)).filter((t): t is EditorTab => !!t);
      const dirty = list.filter(isTabDirty).map((t) => t.id);
      const clean = list.filter((t) => !dirty.includes(t.id)).map((t) => t.id);
      if (clean.length) removeTabs(clean);
      if (!dirty.length) return;
      // Callers that close tab by tab (loops) end up in ONE question.
      const pending = get().pendingDiscard;
      const ids = pending?.action === 'close' ? [...new Set([...pending.tabIds, ...dirty])] : dirty;
      set({ pendingDiscard: { action: 'close', tabIds: ids } });
    },

    resolveDiscard: (discard: boolean) => {
      const pending = get().pendingDiscard;
      set({ pendingDiscard: null });
      if (!pending || !discard) return;
      if (pending.action === 'close') removeTabs(pending.tabIds);
      else pending.run();
    },

    setActiveTab: (tabId: string) => {
      set({ activeTabId: tabId });
    },

    refreshEntry: async (profileId: string, dn: string, opts?: { silent?: boolean }) => {
      // The open tab of the entry, whatever the caller's spelling of the DN (case, blanks).
      const own = findEntryTab(get().tabs, profileId, dn);
      const tabId = own?.id ?? tabIdOf(profileId, dn);
      const seq = (loadSeq.get(tabId) ?? 0) + 1;
      loadSeq.set(tabId, seq);
      if (!opts?.silent) set((state) => ({ loadingEntries: { ...state.loadingEntries, [tabId]: true } }));
      const patchTab = (patch: (t: EditorTab) => EditorTab) => (tabs: EditorTab[]) => tabs.map((t) => (t.id === tabId ? patch(t) : t));
      try {
        const entry = await wails.GetEntry(profileId, dn);
        if (loadSeq.get(tabId) !== seq) return;
        if (!entry) {
          // No binding (browser preview): nothing to show, nothing to blame.
          set((state) => ({ loadingEntries: { ...state.loadingEntries, [tabId]: false } }));
          return;
        }
        const connected = useConnectionStore.getState().connectionStatuses[profileId] === true;
        set((state) => ({
          entries: { ...state.entries, [tabId]: entry },
          loadingEntries: { ...state.loadingEntries, [tabId]: false },
          tabs: patchTab((t) => ({ ...t, state: undefined, loadedAt: Date.now(), stale: connected ? undefined : t.stale }))(state.tabs),
        }));
        // The tab takes the server's spelling of its DN (RW2-N-01), so its Contents
        // list, the tree's lists, LDIF and the recent entries use one key.
        const tabDN = get().tabs.find((t) => t.id === tabId)?.dn ?? dn;
        const loadedDN = adoptServer(profileId, tabId, tabDN, entry.dn) ?? tabDN;
        const objectClass = entry.attributes?.find((a) => a.name.toLowerCase() === 'objectclass')?.values ?? [];
        updateRecents((list) => recentsSetObjectClass(list, profileId, loadedDN, objectClass));
        emitEntryEvent('ldapilot:entry-loaded', { profileId, dn: loadedDN, objectClass });
      } catch (err) {
        if (loadSeq.get(tabId) !== seq) return;
        const failure = classifyLoadError(err);
        const connected = useConnectionStore.getState().connectionStatuses[profileId] === true;
        if (failure.kind === 'offline' || !connected) {
          // The server is unreachable, the entry did not change: keep the values,
          // marked out of date; the connection banner / tab state explain it (no toast).
          set((state) => ({
            loadingEntries: { ...state.loadingEntries, [tabId]: false },
            tabs: patchTab((t) => (t.state ? t : { ...t, stale: true }))(state.tabs),
          }));
          return;
        }
        // A failed reload never shows the old values (ED-04).
        set((state) => ({
          entries: withoutKeys(state.entries, [tabId]),
          loadingEntries: { ...state.loadingEntries, [tabId]: false },
          tabs: patchTab((t) => ({
            ...t,
            loadedAt: undefined,
            state:
              t.state?.kind === 'deleted'
                ? t.state
                : failure.kind === 'missing'
                  ? { kind: 'missing', message: failure.message, code: 32 }
                  : { kind: 'error', message: failure.message, code: failure.code },
          }))(state.tabs),
        }));
        if (failure.kind === 'missing') emitEntryEvent('ldapilot:entry-missing', { profileId, dn });
      }
    },

    markDirty: (tabId: string) => {
      // The first edit pins a preview tab (UX-3).
      set((state) => ({
        tabs: state.tabs.map((t) => t.id === tabId ? { ...t, dirty: true, preview: undefined } : t),
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
        tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, state: undefined, loadedAt: Date.now() } : t)),
      }));
    },

    goBack: () => {
      const state = get();
      if (state.navIndex <= 0) return;
      navigateHistory(state.navIndex - 1);
    },

    goForward: () => {
      const state = get();
      if (state.navIndex >= state.navHistory.length - 1) return;
      navigateHistory(state.navIndex + 1);
    },

    canGoBack: () => {
      return get().navIndex > 0;
    },

    canGoForward: () => {
      const state = get();
      return state.navIndex < state.navHistory.length - 1;
    },

    addSpecialTab: (id: string, label: string) => {
      set((state) => {
        if (state.tabs.find(t => t.id === id)) return state;
        return {
          tabs: [...state.tabs, { id, profileId: '', label, dn: '', dirty: false }],
          activeTabId: id,
        };
      });
    },

    setSpecialTabLabel: (id: string, label: string) => {
      set((state) => {
        const tab = state.tabs.find(t => t.id === id);
        if (!tab || tab.dn || tab.label === label) return state;
        return { tabs: state.tabs.map(t => (t.id === id ? { ...t, label } : t)) };
      });
    },
  };
});

// --- Closed tabs drop their view state and kept drafts (UX loop 3) ---------------------------

/** >0 while tabs are re-keyed (rename / move / server spelling): the clean-up below waits. */
let rekeying = 0;

/**
 * Re-keys tabs with their view state and kept drafts: `move` carries them
 * (moveTabView / moveScopedUnsavedEdits), `apply` changes the tabs. The
 * closed-tab clean-up is suspended meanwhile — the dirty-flag update of the
 * carried draft changes `tabs` before the re-key, which dropped the view just
 * moved to the not yet existing tab id (RW3-E-01) — and runs once afterwards.
 */
function rekeyTabs(move: () => void, apply: () => void): void {
  const before = useEditorStore.getState().tabs;
  rekeying++;
  try {
    move();
    apply();
  } finally {
    rekeying--;
  }
  if (rekeying) return;
  const ids = new Set(useEditorStore.getState().tabs.map((t) => t.id));
  for (const t of before) if (!ids.has(t.id)) dropScopedUnsavedEdits(t.id);
  dropTabViews(ids);
}

useEditorStore.subscribe((s, prev) => {
  if (s.tabs === prev.tabs || rekeying) return;
  const ids = new Set(s.tabs.map((t) => t.id));
  for (const t of prev.tabs) if (!ids.has(t.id)) dropScopedUnsavedEdits(t.id);
  dropTabViews(ids);
});

// --- Unsaved input -> tab dirty (ED-02) ----------------------------------------------------

subscribeUnsavedEdits((profileId, dn) => {
  const on = hasUnsavedEdits(profileId, dn);
  useEditorStore.setState((state) => {
    if (!state.tabs.some((t) => t.profileId === profileId && !!t.dn && sameDN(t.dn, dn) && t.dirty !== on)) return state;
    return {
      tabs: state.tabs.map((t) =>
        t.profileId === profileId && t.dn && sameDN(t.dn, dn) ? { ...t, dirty: on, preview: on ? undefined : t.preview } : t,
      ),
    };
  });
});

// --- Entry events (§0.1) ------------------------------------------------------------------

/** Reloads of one DN within ~300 ms are coalesced (events come in bursts). */
const reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleReload(profileId: string, dn: string) {
  const key = changeKey(profileId, dn);
  if (reloadTimers.has(key)) return;
  reloadTimers.set(
    key,
    setTimeout(() => {
      reloadTimers.delete(key);
      const es = useEditorStore.getState();
      for (const t of tabsOfDN(es.tabs, profileId, dn)) {
        // Unsaved input is never replaced under the user's hands.
        if (isTabDirty(t)) continue;
        void es.refreshEntry(t.profileId, t.dn, { silent: !!es.entries[t.id] });
      }
    }, 300),
  );
}

onEntryEvent('ldapilot:entry-moved', ({ profileId, oldDN, newDN }) => {
  noteChange(profileId, newDN);
  // View state and kept drafts (an inline edit, the add row, Contents filter / selection)
  // move with the re-keyed tabs before the tabs change: the closed-tab clean-up must not
  // drop them (RW3-E-01, as adoptServer does). The tab stays dirty with its draft.
  const before = useEditorStore.getState().tabs;
  let moved: string[] = [];
  rekeyTabs(() => {
    for (const c of movedTabCarries(before, tabsAfterMove(before, profileId, oldDN, newDN))) {
      moveTabView(c.from, c.to);
      moveScopedUnsavedEdits(c.from, c.to, c.dn);
    }
  }, () => useEditorStore.setState((state) => {
    const navHistory = historyAfterMove(state.navHistory, profileId, oldDN, newDN);
    const { tabs, renamed } = tabsAfterMove(state.tabs, profileId, oldDN, newDN);
    const pairs = Object.entries(renamed);
    if (!pairs.length) return navHistory === state.navHistory ? state : { navHistory };
    moved = [...new Set(pairs.map(([, to]) => to))];
    const movedSet = new Set(moved);
    const entries = { ...state.entries };
    const loadingEntries = { ...state.loadingEntries };
    for (const [from] of pairs) {
      // The old values carry the old DN (distinguishedName, the RDN attribute):
      // they are not shown again, the tab reloads (no stale data, ED-04).
      delete entries[from];
      delete loadingEntries[from];
      loadSeq.delete(from);
    }
    // The dirty flag follows the registry of the new DN (the kept drafts moved above).
    const next = tabs.map((t) => (movedSet.has(t.id) ? { ...t, dirty: hasUnsavedEdits(t.profileId, t.dn) } : t));
    const activeTabId = state.activeTabId && renamed[state.activeTabId] ? renamed[state.activeTabId] : state.activeTabId;
    return { tabs: next, entries, loadingEntries, activeTabId, navHistory };
  }));
  const es = useEditorStore.getState();
  for (const id of moved) {
    const t = es.tabs.find((x) => x.id === id);
    // An open tab of the new DN that holds unsaved input keeps it (its values are current).
    if (t && !(isTabDirty(t) && es.entries[t.id])) void es.refreshEntry(t.profileId, t.dn);
  }
  updateRecents((list) => recentsAfterMove(list, profileId, oldDN, newDN));
});

onEntryEvent('ldapilot:entry-deleted', ({ profileId, dn, subtree }) => {
  noteChange(profileId, dn);
  useEditorStore.setState((state) => {
    const { tabs, hit } = tabsAfterDelete(state.tabs, profileId, dn, !!subtree, Date.now());
    if (!hit.length) return state;
    for (const id of hit) loadSeq.set(id, (loadSeq.get(id) ?? 0) + 1); // a load in flight must not resurrect it
    return {
      tabs,
      entries: withoutKeys(state.entries, hit),
      loadingEntries: withoutKeys(state.loadingEntries, hit),
    };
  });
  updateRecents((list) => recentsAfterDelete(list, profileId, dn, !!subtree));
});

// An entry that turned out not to exist (noSuchObject on load) leaves the recent
// entries, as after a delete (RW1-R-05: recents kept renamed or deleted DNs).
onEntryEvent('ldapilot:entry-missing', ({ profileId, dn }) => {
  updateRecents((list) => recentsAfterDelete(list, profileId, dn, false));
});

onEntryEvent('ldapilot:entry-restored', ({ profileId, dn }) => {
  noteChange(profileId, dn);
  scheduleReload(profileId, dn);
});

onEntryEvent('ldapilot:account-changed', ({ profileId, dn }) => {
  scheduleReload(profileId, dn);
});

/**
 * Reloads the open tabs of entries a change touched from another entry
 * (M-18: adding grp2 to grp1 in grp1's Membership panel changes grp2's
 * "Member of" header and badge). DNs match case- and blank-insensitively;
 * tabs with unsaved input are left alone.
 */
export function refreshOpenTabsOf(profileId: string, dns: readonly string[]): void {
  if (!dns.length) return;
  const keys = new Set(dns.map((d) => normalizeDN(d)));
  const es = useEditorStore.getState();
  for (const t of es.tabs) {
    if (t.profileId !== profileId || !t.dn || !keys.has(normalizeDN(t.dn)) || isTabDirty(t)) continue;
    void es.refreshEntry(t.profileId, t.dn, { silent: true });
  }
}
