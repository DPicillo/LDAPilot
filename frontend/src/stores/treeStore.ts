import { create } from 'zustand'
import { TreeNode } from '../types/ldap'
import * as wails from '../lib/wails'

interface TreeState {
  rootNodes: Record<string, TreeNode[]>;
  childNodes: Record<string, TreeNode[]>;
  expandedNodes: Set<string>;
  selectedNode: string | null;
  loading: Record<string, boolean>;

  loadRootNodes: (profileId: string) => Promise<void>;
  loadChildren: (profileId: string, parentDN: string) => Promise<void>;
  toggleExpand: (profileId: string, dn: string) => void;
  selectNode: (dn: string | null) => void;
  refreshNode: (profileId: string, dn: string) => Promise<void>;
  clearTree: (profileId: string) => void;
}

export const useTreeStore = create<TreeState>((set, get) => ({
  rootNodes: {},
  childNodes: {},
  expandedNodes: new Set<string>(),
  selectedNode: null,
  loading: {},

  loadRootNodes: async (profileId: string) => {
    set((state) => ({
      loading: { ...state.loading, [`root:${profileId}`]: true },
    }));
    try {
      const nodes = await wails.GetRootEntries(profileId);
      set((state) => ({
        rootNodes: { ...state.rootNodes, [profileId]: nodes || [] },
        loading: { ...state.loading, [`root:${profileId}`]: false },
      }));
    } catch (err) {
      console.error('Failed to load root nodes:', err);
      set((state) => ({
        loading: { ...state.loading, [`root:${profileId}`]: false },
      }));
    }
  },

  loadChildren: async (profileId: string, parentDN: string) => {
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
      console.error('Failed to load children:', err);
      set((state) => ({
        loading: { ...state.loading, [parentDN]: false },
      }));
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
        get().loadChildren(profileId, dn);
      }
    }
    set({ expandedNodes: next });
  },

  selectNode: (dn: string | null) => {
    set({ selectedNode: dn });
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

      // Clear selectedNode only if it belonged to this profile's tree
      let selectedNode = state.selectedNode;
      if (selectedNode && profileRoots.some(r => selectedNode!.endsWith(r.dn))) {
        selectedNode = null;
      }

      return { rootNodes, expandedNodes, selectedNode, childNodes };
    });
  },
}))
