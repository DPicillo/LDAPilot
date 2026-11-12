/**
 * Directory tree state.
 *
 * - Per profile (TREE-03): `childNodes` / `expandedNodes` / the DN keys of
 *   `loading` hold the view of `viewProfileId` (the active connection), so
 *   every existing `s.childNodes[dn]` reader keeps working; the views of the
 *   other profiles are parked in `profileViews` and swapped back in when the
 *   active connection changes. Loads of a non-active profile go to its parked
 *   view, never into the shown one. `rootNodes` is keyed by profile as before.
 *   `selectChildNodes(profileId, dn)` reads either view.
 * - Refresh (TREE-01): `refreshTree` reloads the roots and every visible
 *   expanded container (expansion and selection stay; other loaded lists are
 *   reloaded when expanded again); every children load updates the node's own
 *   `hasChildren` in its parent's list, so a former leaf gets its chevron.
 * - Entry events (TRIAGE §0.1): created / moved / deleted refresh the affected
 *   parents (coalesced within 300 ms; skipped when someone reloaded the list
 *   after the event), re-key the expansion and selection after a move, select
 *   and reveal a created entry when asked; account-changed re-reads the
 *   account status of a shown row (TREE-11).
 * - `locateInTree` (Show in Tree, TREE-07) switches to the entry's connection,
 *   expands the path (reloading a stale level once), selects the entry and
 *   posts a `revealRequest` that DirectoryTree scrolls to and focuses.
 */
import { create } from 'zustand'
import type { TreeNode } from '../types/ldap'
import * as wails from '../lib/wails'
import { readAccountStatusShared } from '../lib/wails-account'
import { readLoginAttributesShared } from '../lib/loginRead'
import type { AccountStatus } from '../types/account'
import {
  ACCOUNT_CHANGED,
  ENTRY_CREATED,
  ENTRY_DELETED,
  ENTRY_MOVED,
  ENTRY_RESTORED,
  createCoalescer,
  findDNKey,
  findOwningRoot,
  isNodeKnown,
  onEntryEvent,
  patchNodeInList,
  rebaseDN,
  rebaseSet,
  visibleExpandedContainers,
  subtreeRefreshPlan,
  withoutKeysBelow,
  withoutSetBelow,
  type EntryCreatedDetail,
  type EntryDeletedDetail,
  type EntryMovedDetail,
  type EntryRefDetail,
} from '../lib/treesearch'
import { firstRDN, getParentDN, isDNAtOrBelow, normalizeDN, splitDN } from '../lib/dn'
import { classifyLoadError } from '../lib/entryEvents'
import { toast } from '../components/ui/Toast'
import { accountStatusKinds, forgetAccountStatusesUnder, rememberAccountStatus } from './accountStatusCache'
import { useConnectionStore } from './connectionStore'

/** Expansion, children and their loading flags of one profile's tree. */
export interface ProfileTreeView {
  childNodes: Record<string, TreeNode[]>;
  expandedNodes: Set<string>;
  loading: Record<string, boolean>;
}

/** Show in Tree request for DirectoryTree: scroll the row into view and (focus) focus it. */
export interface RevealRequest {
  profileId: string;
  dn: string;
  focus: boolean;
  seq: number;
  at: number;
}

export interface LocateOptions {
  /** Move keyboard focus to the revealed row (default true: Show in Tree). */
  focus?: boolean;
  /** No toast when the entry is not found (background reveals). */
  quiet?: boolean;
  /** Keep the current selection when it holds the entry (focus the first of several moved rows, RW3-N-02). */
  keepSelection?: boolean;
}

interface TreeState {
  rootNodes: Record<string, TreeNode[]>;
  /** Children by parent DN, of the shown profile (`viewProfileId`). */
  childNodes: Record<string, TreeNode[]>;
  /** Expanded DNs of the shown profile. */
  expandedNodes: Set<string>;
  selectedNodes: Set<string>;
  /** The last node that was clicked (anchor for shift-select). */
  selectionAnchor: string | null;
  /** `root:<profileId>` for every profile, DN keys of the shown profile. */
  loading: Record<string, boolean>;
  /** Profile whose view `childNodes` / `expandedNodes` hold (follows the active connection). */
  viewProfileId: string | null;
  /** Parked views of the other profiles. */
  profileViews: Record<string, ProfileTreeView>;
  /** Last failed root load per profile (the empty tree explains it, TREE-10). */
  rootErrors: Record<string, string>;
  revealRequest: RevealRequest | null;
  /** Bumped when account statuses of rows were re-read (overlays re-render). */
  statusVersion: number;

  loadRootNodes: (profileId: string) => Promise<void>;
  loadChildren: (profileId: string, parentDN: string, silent?: boolean) => Promise<void>;
  toggleExpand: (profileId: string, dn: string) => void;
  /** Expands dn (never collapses); loads its children when needed. */
  expandNode: (profileId: string, dn: string) => void;
  /** @deprecated Use toggleSelectNode instead. Kept for backwards compatibility. */
  selectNode: (dn: string | null) => void;
  toggleSelectNode: (dn: string, addToSelection: boolean) => void;
  selectRange: (dn: string, flatDNs: string[]) => void;
  clearSelection: () => void;
  /** Reloads dn's children and updates its own chevron (hasChildren) in its parent's list. */
  refreshNode: (profileId: string, dn: string) => Promise<void>;
  /**
   * F5 / Refresh on a container: its list, then the visible expanded
   * containers below it; hidden loaded lists below it become stale.
   * Expansion and selection stay.
   */
  refreshSubtree: (profileId: string, dn: string) => Promise<void>;
  /** Refresh Tree: the roots and every visible expanded container; expansion and selection stay. */
  refreshTree: (profileId: string) => Promise<void>;
  /** Forgets the profile's tree (roots, expansion, children); it reloads when shown. */
  clearTree: (profileId: string) => void;
  locateInTree: (profileId: string, dn: string, opts?: LocateOptions) => Promise<void>;
  /** Shows another profile's tree (called when the active connection changes). */
  setViewProfile: (profileId: string | null) => void;
}

const EMPTY_VIEW: ProfileTreeView = { childNodes: {}, expandedNodes: new Set(), loading: {} };
const ROOT_PREFIX = 'root:';

function rootKeysOnly(loading: Record<string, boolean>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(loading)) if (k.startsWith(ROOT_PREFIX)) out[k] = v;
  return out;
}
function dnKeysOnly(loading: Record<string, boolean>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(loading)) if (!k.startsWith(ROOT_PREFIX) && v) out[k] = v;
  return out;
}

function viewOf(s: TreeState, profileId: string): ProfileTreeView {
  if (profileId === s.viewProfileId) return { childNodes: s.childNodes, expandedNodes: s.expandedNodes, loading: s.loading };
  return s.profileViews[profileId] ?? EMPTY_VIEW;
}

/** State patch writing (part of) a profile's view: the shown one or the parked one. */
function patchView(s: TreeState, profileId: string, patch: Partial<ProfileTreeView>): Partial<TreeState> {
  if (profileId === s.viewProfileId) {
    const out: Partial<TreeState> = {};
    if (patch.childNodes) out.childNodes = patch.childNodes;
    if (patch.expandedNodes) out.expandedNodes = patch.expandedNodes;
    if (patch.loading) out.loading = patch.loading;
    return out;
  }
  return { profileViews: { ...s.profileViews, [profileId]: { ...viewOf(s, profileId), ...patch } } };
}

function loadingPatch(s: TreeState, profileId: string, dn: string, on: boolean): Partial<TreeState> {
  const cur = viewOf(s, profileId).loading;
  if (!!cur[dn] === on) return {};
  const next = { ...cur };
  if (on) next[dn] = true;
  else delete next[dn];
  return patchView(s, profileId, { loading: next });
}

/** Reads children of dn for a profile (shown or parked view): use as a zustand selector. */
export function selectChildNodes(profileId: string | null | undefined, dn: string) {
  return (s: TreeState): TreeNode[] | undefined => (profileId ? viewOf(s, profileId).childNodes[dn] : undefined);
}
/** Is dn's children list of the profile loading? Zustand selector. */
export function selectNodeLoading(profileId: string | null | undefined, dn: string) {
  return (s: TreeState): boolean => (profileId ? !!viewOf(s, profileId).loading[dn] : false);
}

// --- Load bookkeeping (module level: not render state) ------------------------------------

/** Key of one children list as the tree stores it (exact DN spelling, like the childNodes keys). */
const loadKey = (profileId: string, dn: string) => `${profileId}\n${dn}`;
/** Coalescing key of an event job (DN spellings of one entry meet). */
const jobKey = (profileId: string, dn: string) => `${profileId}\n${normalizeDN(dn)}`;
/** Sequence of the newest load per list: an older answer never overwrites a newer one. */
const latestLoad = new Map<string, number>();
const loadStartedAt = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();
/** Lists not reloaded by the last Refresh Tree (hidden): reloaded when expanded. */
const staleLists = new Set<string>();
/** Bumped by clearTree: answers of loads started before are dropped. */
const epochs = new Map<string, number>();
let loadSeq = 0;
let revealSeq = 0;
const epochOf = (profileId: string) => epochs.get(profileId) ?? 0;

/** Patch dn's own `hasChildren` wherever the tree shows it (parent's list, roots). */
function hasChildrenPatch(s: TreeState, profileId: string, childNodes: Record<string, TreeNode[]>, dn: string, hasChildren: boolean) {
  let nextChildNodes = childNodes;
  const parentKey = findDNKey(childNodes, getParentDN(dn));
  if (parentKey) {
    const list = patchNodeInList(childNodes[parentKey], dn, { hasChildren });
    if (list !== childNodes[parentKey]) nextChildNodes = { ...childNodes, [parentKey]: list };
  }
  const roots = s.rootNodes[profileId];
  let rootNodes: Record<string, TreeNode[]> | undefined;
  if (roots) {
    const patched = patchNodeInList(roots, dn, { hasChildren });
    if (patched !== roots) rootNodes = { ...s.rootNodes, [profileId]: patched };
  }
  return { childNodes: nextChildNodes, rootNodes };
}

async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export const useTreeStore = create<TreeState>((set, get) => {
  /** Loads the roots; keepExpansion leaves lists the user collapsed collapsed (Refresh Tree). */
  async function loadRoots(profileId: string, keepExpansion: boolean) {
    const epoch = epochOf(profileId);
    set((state) => ({ loading: { ...state.loading, [`${ROOT_PREFIX}${profileId}`]: true } }));
    try {
      const nodes = (await wails.GetRootEntries(profileId)) || [];
      if (epoch !== epochOf(profileId)) return;

      // Extract pre-loaded children into childNodes and auto-expand their nodes
      const newChildNodes: Record<string, TreeNode[]> = {};
      const autoExpand: string[] = [];
      const extractChildren = (nodeList: TreeNode[]) => {
        for (const node of nodeList) {
          if (node.children && node.children.length > 0) {
            newChildNodes[node.dn] = node.children;
            autoExpand.push(node.dn);
            extractChildren(node.children);
          }
        }
      };
      extractChildren(nodes);
      for (const dn of Object.keys(newChildNodes)) staleLists.delete(loadKey(profileId, dn));

      set((state) => {
        const view = viewOf(state, profileId);
        const expanded = new Set(view.expandedNodes);
        for (const dn of autoExpand) if (!keepExpansion || !(dn in view.childNodes)) expanded.add(dn);
        const rootErrors = { ...state.rootErrors };
        delete rootErrors[profileId];
        return {
          rootNodes: { ...state.rootNodes, [profileId]: nodes },
          rootErrors,
          ...patchView(state, profileId, { childNodes: { ...view.childNodes, ...newChildNodes }, expandedNodes: expanded }),
          loading: { ...state.loading, [`${ROOT_PREFIX}${profileId}`]: false },
        };
      });
    } catch (err) {
      if (epoch !== epochOf(profileId)) return;
      const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Failed to load root nodes';
      const anonymous = useConnectionStore.getState().profiles.find((p) => p.id === profileId)?.authMethod === 'none';
      // The empty tree shows the error (and the anonymous-bind hint, TREE-10).
      if (!anonymous) toast.error('Failed to load directory tree', msg);
      set((state) => ({
        rootErrors: { ...state.rootErrors, [profileId]: msg },
        loading: { ...state.loading, [`${ROOT_PREFIX}${profileId}`]: false },
      }));
    }
  }

  return {
    rootNodes: {},
    childNodes: {},
    expandedNodes: new Set<string>(),
    selectedNodes: new Set<string>(),
    selectionAnchor: null,
    loading: {},
    viewProfileId: useConnectionStore.getState().activeProfileId,
    profileViews: {},
    rootErrors: {},
    revealRequest: null,
    statusVersion: 0,

    loadRootNodes: (profileId: string) => loadRoots(profileId, false),

    loadChildren: (profileId: string, parentDN: string, silent?: boolean) => {
      const key = loadKey(profileId, parentDN);
      const seq = ++loadSeq;
      const epoch = epochOf(profileId);
      latestLoad.set(key, seq);
      loadStartedAt.set(key, Date.now());
      set((state) => loadingPatch(state, profileId, parentDN, true));
      const run = async () => {
        try {
          const children = (await wails.GetChildren(profileId, parentDN)) || [];
          if (epoch !== epochOf(profileId)) return;
          if (latestLoad.get(key) !== seq) {
            // A newer load of this list replaced this one: resolve with it.
            await inflight.get(key)?.catch(() => {});
            return;
          }
          staleLists.delete(key);
          set((state) => {
            const view = viewOf(state, profileId);
            const childNodes = { ...view.childNodes, [parentDN]: children };
            const patched = hasChildrenPatch(state, profileId, childNodes, parentDN, children.length > 0);
            const loading = { ...view.loading };
            delete loading[parentDN];
            return {
              ...(patched.rootNodes ? { rootNodes: patched.rootNodes } : {}),
              ...patchView(state, profileId, { childNodes: patched.childNodes, loading }),
            };
          });
        } catch (err) {
          if (epoch === epochOf(profileId) && latestLoad.get(key) === seq) set((state) => loadingPatch(state, profileId, parentDN, false));
          // A lost connection is already reported by the connection banner and
          // the status bar (F5 / expand while lost must not add an error toast).
          if (!silent && classifyLoadError(err).kind !== 'offline') {
            const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Failed to load children';
            toast.error(`Failed to expand "${firstRDN(parentDN) || parentDN}"`, msg);
          }
          throw err; // Re-throw so callers can handle it
        }
      };
      const p = run();
      inflight.set(key, p);
      p.then(
        () => inflight.get(key) === p && inflight.delete(key),
        () => inflight.get(key) === p && inflight.delete(key),
      );
      return p;
    },

    toggleExpand: (profileId: string, dn: string) => {
      const view = viewOf(get(), profileId);
      const next = new Set(view.expandedNodes);
      if (next.has(dn)) {
        next.delete(dn);
      } else {
        next.add(dn);
        // Load children if not loaded yet (or hidden during the last Refresh Tree)
        if (!view.childNodes[dn] || staleLists.has(loadKey(profileId, dn))) {
          get().loadChildren(profileId, dn).catch(() => { /* handled via toast */ });
        }
      }
      set((state) => patchView(state, profileId, { expandedNodes: next }));
    },

    expandNode: (profileId: string, dn: string) => {
      if (!viewOf(get(), profileId).expandedNodes.has(dn)) get().toggleExpand(profileId, dn);
    },

    selectNode: (dn: string | null) => {
      set({
        selectedNodes: dn ? new Set<string>([dn]) : new Set<string>(),
        selectionAnchor: dn,
      });
    },

    toggleSelectNode: (dn: string, addToSelection: boolean) => {
      if (addToSelection) {
        const next = new Set(get().selectedNodes);
        if (next.has(dn)) {
          next.delete(dn);
        } else {
          next.add(dn);
        }
        set({ selectedNodes: next, selectionAnchor: dn });
      } else {
        set({
          selectedNodes: new Set<string>([dn]),
          selectionAnchor: dn,
        });
      }
    },

    selectRange: (dn: string, flatDNs: string[]) => {
      const { selectionAnchor, selectedNodes } = get();
      if (!selectionAnchor) {
        set({ selectedNodes: new Set<string>([dn]), selectionAnchor: dn });
        return;
      }
      const anchorIdx = flatDNs.indexOf(selectionAnchor);
      const targetIdx = flatDNs.indexOf(dn);
      if (anchorIdx === -1 || targetIdx === -1) {
        set({ selectedNodes: new Set<string>([dn]), selectionAnchor: dn });
        return;
      }
      const start = Math.min(anchorIdx, targetIdx);
      const end = Math.max(anchorIdx, targetIdx);
      const next = new Set(selectedNodes);
      for (let i = start; i <= end; i++) {
        next.add(flatDNs[i]);
      }
      set({ selectedNodes: next });
      // Keep selectionAnchor unchanged so further shift-clicks extend from the original anchor
    },

    clearSelection: () => {
      set({ selectedNodes: new Set<string>(), selectionAnchor: null });
    },

    refreshNode: async (profileId: string, dn: string) => {
      await get().loadChildren(profileId, dn);
    },

    refreshSubtree: async (profileId: string, dn: string) => {
      // A re-read: remembered account states of the rows are read again (RW2-P-01).
      forgetAccountStatusesUnder(profileId, dn);
      await get().loadChildren(profileId, dn);
      const view = viewOf(get(), profileId);
      const { reload, stale } = subtreeRefreshPlan(dn, view.childNodes, view.expandedNodes);
      forgetAccountStatusesUnder(profileId, ...reload);
      for (const d of stale) staleLists.add(loadKey(profileId, d));
      await runLimited(reload, 6, (d) => get().loadChildren(profileId, d, true).catch(() => { /* gone or unreadable: its parent's list tells */ }));
    },

    refreshTree: async (profileId: string) => {
      await loadRoots(profileId, true);
      const s = get();
      const roots = s.rootNodes[profileId];
      if (!roots) return;
      const view = viewOf(s, profileId);
      // Lists the root load just delivered are fresh.
      const fresh = new Set<string>();
      const collect = (list: TreeNode[]) => {
        for (const n of list) {
          if (n.children?.length) {
            fresh.add(n.dn);
            collect(n.children);
          }
        }
      };
      collect(roots);
      const targets = visibleExpandedContainers(roots, view.childNodes, view.expandedNodes).filter((dn) => !fresh.has(dn));
      // The selected containers' lists are shown in the main panel.
      if (profileId === s.viewProfileId) {
        for (const dn of s.selectedNodes) if (view.childNodes[dn] && !fresh.has(dn) && !targets.includes(dn)) targets.push(dn);
      }
      for (const dn of Object.keys(view.childNodes)) {
        if (!fresh.has(dn) && !targets.includes(dn)) staleLists.add(loadKey(profileId, dn));
      }
      // The re-read lists show their rows' current states, not remembered ones (RW2-P-01).
      forgetAccountStatusesUnder(profileId, ...fresh, ...targets);
      await runLimited(targets, 6, (dn) => get().loadChildren(profileId, dn, true).catch(() => { /* gone or unreadable: its parent's list tells */ }));
    },

    clearTree: (profileId: string) => {
      epochs.set(profileId, epochOf(profileId) + 1);
      for (const key of [...staleLists]) if (key.startsWith(`${profileId}\n`)) staleLists.delete(key);
      set((state) => {
        const rootNodes = { ...state.rootNodes };
        delete rootNodes[profileId];
        const rootErrors = { ...state.rootErrors };
        delete rootErrors[profileId];
        const loading = { ...state.loading };
        delete loading[`${ROOT_PREFIX}${profileId}`];
        if (profileId === state.viewProfileId) {
          return {
            rootNodes,
            rootErrors,
            childNodes: {},
            expandedNodes: new Set<string>(),
            selectedNodes: new Set<string>(),
            selectionAnchor: null,
            loading: rootKeysOnly(loading),
          };
        }
        const profileViews = { ...state.profileViews };
        delete profileViews[profileId];
        return { rootNodes, rootErrors, profileViews, loading };
      });
    },

    setViewProfile: (profileId: string | null) => {
      set((state) => {
        if (state.viewProfileId === profileId) return {};
        const profileViews = { ...state.profileViews };
        if (state.viewProfileId) {
          profileViews[state.viewProfileId] = { childNodes: state.childNodes, expandedNodes: state.expandedNodes, loading: dnKeysOnly(state.loading) };
        }
        const restored = profileId ? profileViews[profileId] : undefined;
        if (profileId) delete profileViews[profileId];
        return {
          viewProfileId: profileId,
          profileViews,
          childNodes: restored?.childNodes ?? {},
          expandedNodes: restored?.expandedNodes ?? new Set<string>(),
          loading: { ...rootKeysOnly(state.loading), ...(restored?.loading ?? {}) },
          // The selection is keyed by DN, not by profile: a switch drops it, so the
          // main panel's container list and the registry never pair one server's DN
          // with another connection.
          selectedNodes: new Set<string>(),
          selectionAnchor: null,
        };
      });
    },

    locateInTree: async (profileId: string, dn: string, opts: LocateOptions = {}) => {
      const focus = opts.focus ?? true;
      if (!profileId || !dn) return;
      // The tree shows the active connection: switch to the entry's own one first.
      const cs = useConnectionStore.getState();
      if (cs.activeProfileId !== profileId) {
        if (cs.connectionStatuses[profileId] !== true) {
          const name = cs.profiles.find((p) => p.id === profileId)?.name ?? 'its connection';
          if (!opts.quiet) toast.info(`Connect to ${name} to show the entry in the tree`);
          return;
        }
        cs.setActiveProfile(profileId);
      }

      if (!get().rootNodes[profileId]) await loadRoots(profileId, false);
      const roots = get().rootNodes[profileId] || [];
      // The root that contains the DN; the deepest one wins (AD: Schema root inside Configuration).
      const rootNode = findOwningRoot(roots, dn);
      if (!rootNode) {
        if (!opts.quiet) toast.error('Could not show the entry in the tree', 'It is outside the tree roots of this connection');
        return;
      }

      // Expected path from the root's child level down to the target.
      const rdns = splitDN(dn).map((p) => p.trim());
      const below = rdns.length - splitDN(rootNode.dn).length;
      const path: string[] = [];
      for (let i = below - 1; i >= 0; i--) path.push(rdns.slice(i).join(','));

      const toExpand: string[] = [];
      let current = rootNode.dn; // exact server spelling of the current level
      let target = rootNode.dn;
      let found = path.length === 0;
      for (let i = 0; i < path.length; i++) {
        const want = normalizeDN(path[i]);
        const listOf = () => viewOf(get(), profileId).childNodes[current];
        let reloaded = false;
        if (!listOf() || staleLists.has(loadKey(profileId, current))) {
          try {
            await get().loadChildren(profileId, current, true);
            reloaded = true;
          } catch {
            break;
          }
        }
        let match = (listOf() ?? []).find((c) => normalizeDN(c.dn) === want);
        if (!match && !reloaded) {
          // The list predates the entry (created / moved since): read it again once.
          try {
            await get().loadChildren(profileId, current, true);
          } catch {
            break;
          }
          match = (listOf() ?? []).find((c) => normalizeDN(c.dn) === want);
        }
        toExpand.push(current);
        if (!match) break;
        target = match.dn;
        current = match.dn;
        if (i === path.length - 1) found = true;
      }
      if (!found && !opts.quiet) toast.info(`"${firstRDN(dn) || dn}" was not found in the tree; showing the nearest container that exists`);

      set((state) => {
        const keep = !!opts.keepSelection && [...state.selectedNodes].some((d) => normalizeDN(d) === normalizeDN(target));
        return {
          ...patchView(state, profileId, { expandedNodes: new Set([...viewOf(state, profileId).expandedNodes, ...toExpand]) }),
          selectedNodes: keep ? state.selectedNodes : new Set<string>([target]),
          selectionAnchor: target,
          revealRequest: { profileId, dn: target, focus, seq: ++revealSeq, at: Date.now() },
        };
      });
    },
  };
});

/** The loaded tree node of dn (roots, their preloaded children, every loaded list; exact DN as the tree keys it). */
export function findLoadedTreeNode(roots: readonly TreeNode[] | undefined, childNodes: Record<string, TreeNode[]>, dn: string): TreeNode | undefined {
  const inRoots = (list: readonly TreeNode[]): TreeNode | undefined => {
    for (const n of list) {
      if (n.dn === dn) return n;
      const hit = n.children?.length ? inRoots(n.children) : undefined;
      if (hit) return hit;
    }
    return undefined;
  };
  const hit = roots ? inRoots(roots) : undefined;
  if (hit) return hit;
  for (const list of Object.values(childNodes)) {
    const n = list.find((x) => x.dn === dn);
    if (n) return n;
  }
  return undefined;
}

/** Returns the last-selected (anchor) node, or the sole selected node. */
export function getPrimarySelectedNode(): string | null {
  const state = useTreeStore.getState();
  if (state.selectionAnchor && state.selectedNodes.has(state.selectionAnchor)) {
    return state.selectionAnchor;
  }
  // Fall back to the first entry in the set
  const first = state.selectedNodes.values().next();
  return first.done ? null : first.value;
}

// --- Connection changes ------------------------------------------------------------------

// The tree shows the active connection only (TREE-03); a changed base DN (or a
// deleted profile) drops that profile's tree, which reloads when shown
// (TREE-05); a connection that comes back refreshes its tree (keeps expansion).
useConnectionStore.subscribe((state, prev) => {
  const tree = useTreeStore.getState();
  if (state.activeProfileId !== prev.activeProfileId) tree.setViewProfile(state.activeProfileId);
  if (state.profiles !== prev.profiles) {
    for (const old of prev.profiles) {
      const cur = state.profiles.find((p) => p.id === old.id);
      const known = !!useTreeStore.getState().rootNodes[old.id] || !!useTreeStore.getState().rootErrors[old.id];
      if (!known) continue;
      if (!cur || (cur.baseDN ?? '').trim() !== (old.baseDN ?? '').trim()) useTreeStore.getState().clearTree(old.id);
    }
  }
  if (state.connectionStatuses !== prev.connectionStatuses) {
    for (const [id, on] of Object.entries(state.connectionStatuses)) {
      if (on !== true || prev.connectionStatuses[id] !== false) continue;
      const t = useTreeStore.getState();
      if (t.rootNodes[id]) void t.refreshTree(id).catch(() => {});
      else if (t.rootErrors[id]) t.clearTree(id); // the failed load is tried again when shown
    }
  }
});

// --- Entry events (TRIAGE §0.1) -----------------------------------------------------------

interface RefreshJob {
  profileId: string;
  dn: string;
  /** Time of the first event: a load started later already shows the change. */
  since: number;
  expand: boolean;
  /** Select and reveal this entry afterwards. */
  reveal?: string;
}

const refreshJobs = createCoalescer<RefreshJob>(
  300,
  (batch) => {
    for (const job of batch.values()) void runRefreshJob(job);
  },
  (a, b) => ({ ...a, since: Math.min(a.since, b.since), expand: a.expand || b.expand, reveal: b.reveal ?? a.reveal }),
);

/** Focus is in the tree or nowhere: a revealed new entry may take it. */
function focusFollowsReveal(): boolean {
  if (typeof document === 'undefined') return false;
  const a = document.activeElement;
  return !a || a === document.body || !!a.closest?.('[role="tree"]');
}

/** Refresh dn's children list soon (coalesced); expand / reveal afterwards. */
function scheduleRefresh(profileId: string, dn: string, opts: { expand?: boolean; reveal?: string } = {}) {
  if (!profileId || !dn) return;
  refreshJobs.add(jobKey(profileId, dn), { profileId, dn, since: Date.now(), expand: !!opts.expand, reveal: opts.reveal });
}

async function runRefreshJob(job: RefreshJob) {
  const store = useTreeStore.getState();
  const roots = store.rootNodes[job.profileId];
  if (!roots) return; // this profile's tree was never shown
  const view = viewOf(store, job.profileId);
  const key = findDNKey(view.childNodes, job.dn);
  const known = !!key || isNodeKnown(roots, view.childNodes, job.dn);
  if (known) {
    // The tree's own spelling of the DN (its row / list key).
    const dn = key ?? roots.find((r) => normalizeDN(r.dn) === normalizeDN(job.dn))?.dn ?? job.dn;
    const lk = loadKey(job.profileId, dn);
    if ((loadStartedAt.get(lk) ?? 0) >= job.since) await inflight.get(lk)?.catch(() => {});
    else await store.loadChildren(job.profileId, dn, true).catch(() => {});
    if (job.expand) {
      const s = useTreeStore.getState();
      const actual = findDNKey(viewOf(s, job.profileId).childNodes, job.dn) ?? job.dn;
      const expanded = viewOf(s, job.profileId).expandedNodes;
      if (!expanded.has(actual)) useTreeStore.setState((st) => patchView(st, job.profileId, { expandedNodes: new Set(expanded).add(actual) }));
    }
  }
  if (job.reveal) {
    const s = useTreeStore.getState();
    // Reveal only on the shown tree; focus stays where it is (a dialog just closed).
    // The keyboard follows the new entry when it was in the tree (the dialog handed it back
    // to the parent row) or fell to <body>; never away from the editor or a field (RW1-N-09).
    if (s.viewProfileId === job.profileId) void s.locateInTree(job.profileId, job.reveal, { focus: focusFollowsReveal(), quiet: true });
  }
}

/** A move (or rename): re-key expansion and selection, drop the moved subtree's stale lists. */
function applyMove(profileId: string, oldDN: string, newDN: string) {
  useTreeStore.setState((s) => {
    const view = viewOf(s, profileId);
    const childNodes = withoutKeysBelow(view.childNodes, oldDN);
    // The entry leaves its old parent's list at once; the refresh brings the new one.
    const oldParentKey = findDNKey(childNodes, getParentDN(oldDN));
    let lists = childNodes;
    if (oldParentKey) {
      const filtered = childNodes[oldParentKey].filter((n) => normalizeDN(n.dn) !== normalizeDN(oldDN));
      if (filtered.length !== childNodes[oldParentKey].length) lists = { ...childNodes, [oldParentKey]: filtered };
    }
    const patch: Partial<TreeState> = patchView(s, profileId, { childNodes: lists, expandedNodes: rebaseSet(view.expandedNodes, oldDN, newDN) });
    if (profileId === s.viewProfileId) {
      patch.selectedNodes = rebaseSet(s.selectedNodes, oldDN, newDN);
      patch.selectionAnchor = s.selectionAnchor ? rebaseDN(s.selectionAnchor, oldDN, newDN) ?? s.selectionAnchor : null;
    }
    return patch;
  });
}

/** A delete: drop the subtree's rows, lists, expansion and selection. */
function applyDelete(profileId: string, dn: string) {
  useTreeStore.setState((s) => {
    const view = viewOf(s, profileId);
    let childNodes = withoutKeysBelow(view.childNodes, dn);
    const parentKey = findDNKey(childNodes, getParentDN(dn));
    if (parentKey) {
      const filtered = childNodes[parentKey].filter((n) => !isDNAtOrBelow(n.dn, dn));
      if (filtered.length !== childNodes[parentKey].length) childNodes = { ...childNodes, [parentKey]: filtered };
    }
    const patch: Partial<TreeState> = patchView(s, profileId, { childNodes, expandedNodes: withoutSetBelow(view.expandedNodes, dn) });
    if (profileId === s.viewProfileId) {
      const selected = withoutSetBelow(s.selectedNodes, dn);
      if (selected !== s.selectedNodes) {
        patch.selectedNodes = selected;
        if (s.selectionAnchor && isDNAtOrBelow(s.selectionAnchor, dn)) patch.selectionAnchor = null;
      }
    }
    return patch;
  });
}

// Account statuses of shown rows, re-read after an account action (TREE-11).
const statusJobs = createCoalescer<EntryRefDetail & { status?: AccountStatus }>(300, (batch) => {
  void runLimited([...batch.values()], 4, refreshAccountStatus);
});

async function refreshAccountStatus({ profileId, dn, status: given }: EntryRefDetail & { status?: AccountStatus }) {
  const s = useTreeStore.getState();
  const roots = s.rootNodes[profileId];
  if (!roots || !isNodeKnown(roots, viewOf(s, profileId).childNodes, dn)) return; // not shown in the tree
  try {
    // The status the emitter read, else the read the other views share (RW1-P-06).
    const st = given ?? (await readAccountStatusShared(profileId, dn));
    if (!st) throw new Error('no status');
    if (!st.applicable) return;
    rememberAccountStatus(profileId, st);
    if (normalizeDN(st.dn) !== normalizeDN(dn)) rememberAccountStatus(profileId, { ...st, dn });
    // The row's own one-level status (used when the cache has evicted the entry).
    const status = accountStatusKinds(st).filter((k): k is 'disabled' | 'expired' | 'locked' => k === 'disabled' || k === 'expired' || k === 'locked');
    useTreeStore.setState((state) => {
      const view = viewOf(state, profileId);
      const key = findDNKey(view.childNodes, getParentDN(dn));
      const patch: Partial<TreeState> = { statusVersion: state.statusVersion + 1 };
      if (key) {
        const list = patchNodeInList(view.childNodes[key], dn, { status });
        if (list !== view.childNodes[key]) Object.assign(patch, patchView(state, profileId, { childNodes: { ...view.childNodes, [key]: list } }));
      }
      return patch;
    });
  } catch {
    // The status could not be read: the parent's listing brings the row's state.
    scheduleRefresh(profileId, getParentDN(dn));
  }
}

onEntryEvent<EntryCreatedDetail>(ENTRY_CREATED, (d) => {
  if (!d.profileId || !d.dn) return;
  const parent = d.parentDN || getParentDN(d.dn);
  if (parent) scheduleRefresh(d.profileId, parent, { expand: true, reveal: d.select ? d.dn : undefined });
});

onEntryEvent<EntryMovedDetail>(ENTRY_MOVED, (d) => {
  if (!d.profileId || !d.oldDN || !d.newDN || normalizeDN(d.oldDN) === normalizeDN(d.newDN)) return;
  if (!useTreeStore.getState().rootNodes[d.profileId]) return;
  applyMove(d.profileId, d.oldDN, d.newDN);
  scheduleRefresh(d.profileId, getParentDN(d.oldDN));
  scheduleRefresh(d.profileId, getParentDN(d.newDN));
});

onEntryEvent<EntryDeletedDetail>(ENTRY_DELETED, (d) => {
  if (!d.profileId || !d.dn || !useTreeStore.getState().rootNodes[d.profileId]) return;
  applyDelete(d.profileId, d.dn);
  scheduleRefresh(d.profileId, getParentDN(d.dn));
});

// A restored entry reappears in its container's listing (M-30: Deleted Objects footer, Restore to…).
onEntryEvent<EntryRefDetail>(ENTRY_RESTORED, (d) => {
  if (!d.profileId || !d.dn || !useTreeStore.getState().rootNodes[d.profileId]) return;
  const parent = getParentDN(d.dn);
  if (parent) scheduleRefresh(d.profileId, parent);
});

onEntryEvent<EntryRefDetail & { status?: AccountStatus }>(ACCOUNT_CHANGED, (d) => {
  if (d.profileId && d.dn) statusJobs.add(jobKey(d.profileId, d.dn), d);
});

// A first password makes an LDAP person without a login a user (Set Password…), removing its
// last login attribute a contact again: the row's kind (icon, verbs, the Contents list's Type)
// follows the account action. Only rows the listing read these names for carry them.
const loginJobs = createCoalescer<EntryRefDetail>(300, (batch) => {
  void runLimited([...batch.values()], 4, refreshLoginAttributes);
});

async function refreshLoginAttributes({ profileId, dn }: EntryRefDetail) {
  const listOf = (state: TreeState) => {
    const lists = viewOf(state, profileId).childNodes;
    return { lists, key: findDNKey(lists, getParentDN(dn)) };
  };
  const shown = listOf(useTreeStore.getState());
  const node = shown.key ? shown.lists[shown.key].find((n) => normalizeDN(n.dn) === normalizeDN(dn)) : undefined;
  if (!node || !Array.isArray(node.loginAttributes)) return;
  const loginAttributes = await readLoginAttributesShared(profileId, node.dn).catch(() => undefined);
  if (!loginAttributes) return; // not readable: the next listing brings them
  useTreeStore.setState((state) => {
    const { lists, key } = listOf(state);
    const list = key ? patchNodeInList(lists[key], dn, { loginAttributes }) : undefined;
    return key && list && list !== lists[key] ? patchView(state, profileId, { childNodes: { ...lists, [key]: list } }) : state;
  });
}

onEntryEvent<EntryRefDetail>(ACCOUNT_CHANGED, (d) => {
  if (d.profileId && d.dn) loginJobs.add(jobKey(d.profileId, d.dn), d);
});
