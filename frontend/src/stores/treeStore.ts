import { create } from 'zustand'
import { TreeNode } from '../types/ldap'
import * as wails from '../lib/wails'
import { toast } from '../components/ui/Toast'

interface TreeState {
  rootNodes: Record<string, TreeNode[]>;
  childNodes: Record<string, TreeNode[]>;
  expandedNodes: Set<string>;
  selectedNodes: Set<string>;
  /** The last node that was clicked (anchor for shift-select). */
  selectionAnchor: string | null;
  loading: Record<string, boolean>;

  loadRootNodes: (profileId: string) => Promise<void>;
  loadChildren: (profileId: string, parentDN: string, silent?: boolean) => Promise<void>;
  toggleExpand: (profileId: string, dn: string) => void;
  /** @deprecated Use toggleSelectNode instead. Kept for backwards compatibility. */
  selectNode: (dn: string | null) => void;
  toggleSelectNode: (dn: string, addToSelection: boolean) => void;
  selectRange: (dn: string, flatDNs: string[]) => void;
  clearSelection: () => void;
  refreshNode: (profileId: string, dn: string) => Promise<void>;
  clearTree: (profileId: string) => void;
  locateInTree: (profileId: string, dn: string) => Promise<void>;
}

export const useTreeStore = create<TreeState>((set, get) => ({
  rootNodes: {},
  childNodes: {},
  expandedNodes: new Set<string>(),
  selectedNodes: new Set<string>(),
  selectionAnchor: null,
  loading: {},

  loadRootNodes: async (profileId: string) => {
    set((state) => ({
      loading: { ...state.loading, [`root:${profileId}`]: true },
    }));
    try {
      const nodes = await wails.GetRootEntries(profileId);

      // Extract pre-loaded children into childNodes and auto-expand root nodes
      const newChildNodes: Record<string, TreeNode[]> = {};
      const newExpanded = new Set<string>();

      function extractChildren(nodeList: TreeNode[]) {
        for (const node of nodeList) {
          if (node.children && node.children.length > 0) {
            newChildNodes[node.dn] = node.children;
            newExpanded.add(node.dn);
            // Recursively extract from pre-loaded children
            extractChildren(node.children);
          }
        }
      }
      extractChildren(nodes || []);

      set((state) => ({
        rootNodes: { ...state.rootNodes, [profileId]: nodes || [] },
        childNodes: { ...state.childNodes, ...newChildNodes },
        expandedNodes: new Set([...state.expandedNodes, ...newExpanded]),
        loading: { ...state.loading, [`root:${profileId}`]: false },
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load root nodes';
      toast.error('Failed to load directory tree', msg);
      set((state) => ({
        loading: { ...state.loading, [`root:${profileId}`]: false },
      }));
    }
  },

  loadChildren: async (profileId: string, parentDN: string, silent?: boolean) => {
    set((state) => ({
      loading: { ...state.loading, [parentDN]: true },
    }));
    try {
      const children = await wails.GetChildren(profileId, parentDN);
      set((state) => ({
        childNodes: { ...state.childNodes, [parentDN]: children || [] },
        loading: { ...state.loading, [parentDN]: false },
      }));
    } catch (err) {
      if (!silent) {
        const msg = err instanceof Error ? err.message : 'Failed to load children';
        toast.error(`Failed to expand "${parentDN.split(',')[0]}"`, msg);
      }
      set((state) => ({
        loading: { ...state.loading, [parentDN]: false },
      }));
      throw err; // Re-throw so callers can handle it
    }
  },

  toggleExpand: (profileId: string, dn: string) => {
    const state = get();
    const next = new Set(state.expandedNodes);
    if (next.has(dn)) {
      next.delete(dn);
    } else {
      next.add(dn);
      // Load children if not already loaded
      if (!state.childNodes[dn]) {
        get().loadChildren(profileId, dn).catch(() => { /* handled via toast */ });
      }
    }
    set({ expandedNodes: next });
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

  clearTree: (profileId: string) => {
    set((state) => {
      const rootNodes = { ...state.rootNodes };
      delete rootNodes[profileId];

      // Only remove childNodes and expandedNodes belonging to this profile's tree
      const profileRoots = state.rootNodes[profileId] || [];
      const profileBaseDNs = new Set(profileRoots.map(n => n.dn));

      const childNodes = { ...state.childNodes };
      const expandedNodes = new Set(state.expandedNodes);
      for (const key of Object.keys(childNodes)) {
        // Remove child nodes that belong to this profile's base DNs
        if (profileBaseDNs.has(key) || profileRoots.some(r => key.endsWith(r.dn))) {
          delete childNodes[key];
          expandedNodes.delete(key);
        }
      }

      // Clear selectedNodes only if they belonged to this profile's tree
      const selectedNodes = new Set(state.selectedNodes);
      for (const dn of selectedNodes) {
        if (profileRoots.some(r => dn.endsWith(r.dn))) {
          selectedNodes.delete(dn);
        }
      }
      const selectionAnchor = state.selectionAnchor && profileRoots.some(r => state.selectionAnchor!.endsWith(r.dn))
        ? null
        : state.selectionAnchor;

      return { rootNodes, expandedNodes, selectedNodes, selectionAnchor, childNodes };
    });
  },

  locateInTree: async (profileId: string, dn: string) => {
    console.log('[locateInTree] Target DN:', dn);
    const state = get();

    // Ensure root nodes are loaded
    if (!state.rootNodes[profileId]) {
      await get().loadRootNodes(profileId);
    }

    const roots = get().rootNodes[profileId] || [];
    const dnLower = dn.toLowerCase();
    console.log('[locateInTree] Root nodes:', roots.map(r => r.dn));

    // Find the root DN that is an ancestor (suffix) of the target DN
    let rootNode: TreeNode | null = null;
    for (const root of roots) {
      if (dnLower === root.dn.toLowerCase() || dnLower.endsWith(',' + root.dn.toLowerCase())) {
        rootNode = root;
        break;
      }
    }

    if (!rootNode) {
      console.error('[locateInTree] No matching root found for:', dn);
      toast.error('Could not locate entry in tree', 'Entry is outside the current tree root');
      return;
    }
    console.log('[locateInTree] Matched root:', rootNode.dn);

    // If the target IS the root, just select it
    if (dnLower === rootNode.dn.toLowerCase()) {
      set({
        expandedNodes: new Set(get().expandedNodes),
        selectedNodes: new Set<string>([rootNode.dn]),
        selectionAnchor: rootNode.dn,
      });
      return;
    }

    // Build the expected path by splitting the prefix (part between root and target)
    // For DN "CN=John,OU=Users,DC=example,DC=com" with root "DC=example,DC=com":
    //   prefix = "CN=John,OU=Users"
    //   rdnParts = ["CN=John", "OU=Users"]
    //   expectedPath (from root to target) = [
    //     "OU=Users,DC=example,DC=com",
    //     "CN=John,OU=Users,DC=example,DC=com"
    //   ]
    const rootDNLen = rootNode.dn.length;
    const prefix = dn.substring(0, dn.length - rootDNLen - 1); // strip ",rootDN"
    const rdnParts = prefix.split(/(?<!\\),/);
    console.log('[locateInTree] Prefix:', prefix, 'RDN parts:', rdnParts);

    const expectedAncestors: string[] = [];
    for (let i = rdnParts.length - 1; i >= 0; i--) {
      // Build expected DN for this level (may have wrong case)
      expectedAncestors.push(rdnParts.slice(i).join(',') + ',' + rootNode.dn);
    }
    console.log('[locateInTree] Expected path:', expectedAncestors);

    const expandedNodes = new Set(get().expandedNodes);
    expandedNodes.add(rootNode.dn);

    // Ensure root children are loaded
    const rootChildren = get().childNodes[rootNode.dn];
    console.log('[locateInTree] Root children loaded:', !!rootChildren, 'count:', rootChildren?.length);
    if (!rootChildren) {
      try {
        await get().loadChildren(profileId, rootNode.dn, true);
        console.log('[locateInTree] Root children loaded after fetch:', get().childNodes[rootNode.dn]?.length);
      } catch (e) {
        console.error('[locateInTree] Failed to load root children:', e);
      }
    }

    // Walk down from root toward the target, using actual node DNs from the tree
    let actualDN = rootNode.dn; // current position (uses exact server DN)
    let targetActualDN = dn;    // actual DN of the target (may be corrected)

    for (let i = 0; i < expectedAncestors.length; i++) {
      const expectedDN = expectedAncestors[i];
      const expectedLower = expectedDN.toLowerCase();
      const isLastStep = i === expectedAncestors.length - 1;

      // Look through children of current node to find the matching child
      const children = get().childNodes[actualDN] || [];
      console.log(`[locateInTree] Step ${i}: looking for "${expectedDN}" in ${children.length} children of "${actualDN}"`);

      const matchingChild = children.find(c => c.dn.toLowerCase() === expectedLower);

      if (!matchingChild) {
        // Child not found - the node may not exist at this level
        // Still select using the original DN
        console.warn(`[locateInTree] Child NOT FOUND! Available children:`, children.map(c => c.dn));
        break;
      }

      console.log(`[locateInTree] Step ${i}: found "${matchingChild.dn}"`);

      if (isLastStep) {
        // This is the target - use exact DN from tree
        targetActualDN = matchingChild.dn;
      } else {
        // This is an intermediate node - expand it
        expandedNodes.add(matchingChild.dn);
        actualDN = matchingChild.dn;

        // Load its children if needed
        if (!get().childNodes[matchingChild.dn]) {
          try {
            await get().loadChildren(profileId, matchingChild.dn, true);
          } catch (e) {
            console.error(`[locateInTree] Failed to load children of "${matchingChild.dn}":`, e);
            break;
          }
        }
      }
    }

    console.log('[locateInTree] Final selection:', targetActualDN);
    // Update state: expand all ancestors and select the target node
    set({
      expandedNodes,
      selectedNodes: new Set<string>([targetActualDN]),
      selectionAnchor: targetActualDN,
    });
  },
}))

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
