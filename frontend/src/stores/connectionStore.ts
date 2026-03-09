import { create } from 'zustand'
import { ConnectionProfile } from '../types/ldap'
import * as wails from '../lib/wails'
import { toast } from '../components/ui/Toast'

interface ConnectionState {
  profiles: ConnectionProfile[];
  activeProfileId: string | null;
  connectionStatuses: Record<string, boolean>;
  loading: boolean;
  error: string | null;

  loadProfiles: () => Promise<void>;
  saveProfile: (profile: ConnectionProfile) => Promise<ConnectionProfile>;
  deleteProfile: (id: string) => Promise<void>;
  connect: (id: string) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
  testConnection: (profile: ConnectionProfile) => Promise<void>;
  reconnect: (id: string) => Promise<void>;
  setActiveProfile: (id: string | null) => void;
  updateStatus: (id: string, connected: boolean) => void;
  clearError: () => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  profiles: [],
  activeProfileId: null,
  connectionStatuses: {},
  loading: false,
  error: null,

  loadProfiles: async () => {
    set({ loading: true, error: null });
    try {
      const profiles = await wails.GetConnections();
      set({ profiles, loading: false });
    } catch (err: any) {
      set({ error: err?.message || 'Failed to load profiles', loading: false });
    }
  },

  saveProfile: async (profile: ConnectionProfile) => {
    set({ loading: true, error: null });
    try {
      const saved = await wails.SaveConnection(profile);
      set((state) => {
        const idx = state.profiles.findIndex((p) => p.id === saved.id);
        const profiles = idx >= 0
          ? state.profiles.map((p, i) => i === idx ? saved : p)
          : [...state.profiles, saved];
        return { profiles, loading: false };
      });
      toast.success(`Profile "${saved.name}" saved`);
      return saved;
    } catch (err: any) {
      const msg = err?.message || 'Failed to save profile';
      set({ error: msg, loading: false });
      toast.error(msg);
      throw err;
    }
  },

  deleteProfile: async (id: string) => {
    set({ error: null });
    try {
      await wails.DeleteConnection(id);
      set((state) => ({
        profiles: state.profiles.filter((p) => p.id !== id),
        activeProfileId: state.activeProfileId === id ? null : state.activeProfileId,
        connectionStatuses: Object.fromEntries(
          Object.entries(state.connectionStatuses).filter(([k]) => k !== id)
        ),
      }));
      toast.info('Connection deleted');
    } catch (err: any) {
      const msg = err?.message || 'Failed to delete profile';
      set({ error: msg });
      toast.error(msg);
    }
  },

  connect: async (id: string) => {
    set({ loading: true, error: null });
    try {
      await wails.Connect(id);
      set((state) => ({
        connectionStatuses: { ...state.connectionStatuses, [id]: true },
        activeProfileId: id,
        loading: false,
      }));
      const profile = get().profiles.find(p => p.id === id);
      toast.success(`Connected to ${profile?.name || 'server'}`);
    } catch (err: any) {
      const profile = get().profiles.find(p => p.id === id);
      const detail = err?.message || 'Connection failed';
      const msg = `Failed to connect to ${profile?.name || 'server'}`;
      set({ error: detail, loading: false });
      toast.error(msg, detail);
      throw err;
    }
  },

  disconnect: async (id: string) => {
    try {
      await wails.Disconnect(id);
      const profile = get().profiles.find(p => p.id === id);
      set((state) => ({
        connectionStatuses: { ...state.connectionStatuses, [id]: false },
        activeProfileId: state.activeProfileId === id ? null : state.activeProfileId,
      }));
      toast.info(`Disconnected from ${profile?.name || 'server'}`);
    } catch (err: any) {
      const msg = err?.message || 'Disconnect failed';
      set({ error: msg });
      toast.error(msg);
    }
  },

  testConnection: async (profile: ConnectionProfile) => {
    await wails.TestConnection(profile);
  },

  reconnect: async (id: string) => {
    set({ loading: true, error: null });
    try {
      await wails.Reconnect(id);
      set((state) => ({
        connectionStatuses: { ...state.connectionStatuses, [id]: true },
        loading: false,
      }));
      const profile = get().profiles.find(p => p.id === id);
      toast.success(`Reconnected to ${profile?.name || 'server'}`);
    } catch (err: any) {
      const profile = get().profiles.find(p => p.id === id);
      const detail = err?.message || 'Reconnect failed';
      set({
        error: detail,
        loading: false,
        connectionStatuses: { ...get().connectionStatuses, [id]: false },
      });
      toast.error(`Failed to reconnect to ${profile?.name || 'server'}`, detail);
      throw err;
    }
  },

  setActiveProfile: (id: string | null) => {
    set({ activeProfileId: id });
  },

  updateStatus: (id: string, connected: boolean) => {
    set((state) => ({
      connectionStatuses: { ...state.connectionStatuses, [id]: connected },
    }));
  },

  clearError: () => set({ error: null }),
}))
