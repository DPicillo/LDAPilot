import { create } from 'zustand'
import { ConnectionProfile } from '../types/ldap'
import * as wails from '../lib/wails'
import { setToastConnectionProvider, toast } from '../components/ui/Toast'
import { isCertificateError } from '../lib/wails-auth'
import { useCertTrustStore } from './certTrustStore'
import { requestConnectPassword } from '../components/connection/passwordPromptStore'
import { editSectionForError } from '../lib/connectionAuth'

interface ConnectionState {
  profiles: ConnectionProfile[];
  activeProfileId: string | null;
  connectionStatuses: Record<string, boolean>;
  loading: boolean;
  /** Message of the last failed operation (connect, save, delete). */
  error: string | null;
  /** Profile the last connect error belongs to (the inline alert names it and offers Edit… / Retry). */
  errorProfileId: string | null;
  /** Last connect error per profile (error mark on the profile row); cleared by a successful connect. */
  connectErrors: Record<string, string>;

  loadProfiles: () => Promise<void>;
  /** Re-reads connections.json (Reload Profiles): picks up changes made outside LDAPilot. */
  reloadProfiles: () => Promise<void>;
  /** Saves a profile; `quiet`: no success toast (Create and Connect says it once, RW3-C-03). */
  saveProfile: (profile: ConnectionProfile, opts?: { quiet?: boolean }) => Promise<ConnectionProfile>;
  deleteProfile: (id: string) => Promise<void>;
  /**
   * Deletes several profiles (DEF-02), disconnecting open ones; one toast.
   * Resolves with the ids actually deleted.
   */
  deleteProfiles: (ids: string[]) => Promise<string[]>;
  /** Connects; `saved`: the profile was just saved (one toast "… saved and connected", RW3-C-03). */
  connect: (id: string, opts?: { saved?: boolean }) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
  testConnection: (profile: ConnectionProfile) => Promise<void>;
  /**
   * Reconnects. `keepStatus`: a failure leaves the profile marked connected
   * (the connection watch's lost state: tree, banners and status bar keep
   * saying "lost" until a reconnect works or the user disconnects, RW3-C-01).
   */
  reconnect: (id: string, opts?: { keepStatus?: boolean }) => Promise<void>;
  setActiveProfile: (id: string | null) => void;
  updateStatus: (id: string, connected: boolean) => void;
  clearError: () => void;
}

/** localStorage key of the last active profile (restored after a page reload, CONN-20). */
export const LAST_ACTIVE_PROFILE_KEY = 'ldapilot-active-profile';

/** The profile that was active last (localStorage), or null. */
export function loadLastActiveProfile(): string | null {
  try {
    const v = localStorage.getItem(LAST_ACTIVE_PROFILE_KEY);
    return v || null;
  } catch {
    return null;
  }
}

function rememberActiveProfile(id: string | null) {
  if (!id) return;
  try {
    localStorage.setItem(LAST_ACTIVE_PROFILE_KEY, id);
  } catch {
    /* blocked storage: only the restore after a reload is lost */
  }
}

const errMessage = (err: any, fallback: string) => err?.message || (typeof err === 'string' ? err : fallback);
const isBindFailure = (msg: string) => /LDAP bind failed|Invalid Credentials|result code 49\b/i.test(msg);

/** Passwords typed in the connection dialog for the next connect of a profile (consumed once). */
const primedPasswords = new Map<string, string>();

/**
 * Create and Connect of a profile that asks for the password on every
 * connect (DEF-07): the password typed in the dialog (not saved) answers the
 * first password request of the next connect instead of a second prompt.
 */
export function primeConnectPassword(profileId: string, password: string): void {
  if (password) primedPasswords.set(profileId, password);
  else primedPasswords.delete(profileId);
}

/**
 * Runs a connect call. When the profile needs a password none is stored for
 * (imported profiles), asks for it (with "Save password") and connects with
 * it; a wrong password asks again with the server's answer. Cancel rejects
 * like a cancelled connect (callers ignore it).
 */
async function withPasswordPrompt(profile: ConnectionProfile | undefined, call: () => Promise<void>, onPrompt: () => void, onAnswer: () => void): Promise<{ saved: boolean }> {
  let primed = profile ? primedPasswords.get(profile.id) : undefined;
  if (profile) primedPasswords.delete(profile.id);
  try {
    await call();
    return { saved: false };
  } catch (err) {
    if (!wails.isPasswordRequired(err) || !profile) throw err;
  }
  let error: string | undefined;
  for (;;) {
    let answer: { password: string; save: boolean } | null;
    if (primed) {
      answer = { password: primed, save: false };
      primed = undefined;
    } else {
      onPrompt();
      answer = await requestConnectPassword(profile, error);
    }
    if (!answer) throw new Error(wails.CONNECT_CANCELLED_MESSAGE);
    onAnswer();
    try {
      await wails.ConnectWithPassword(profile.id, answer.password, answer.save);
      return { saved: answer.save };
    } catch (err) {
      const msg = errMessage(err, 'Connection failed');
      if (!isBindFailure(msg)) throw err;
      error = msg;
    }
  }
}

let profilesRequested = false;

/**
 * Loads the saved profiles once at start-up, whichever panel is shown: the
 * side bar may open on another activity than Connections (restored after a
 * reload), and the welcome screen, the status bar and the palette list the
 * profiles too. Later changes reach the store through save / delete /
 * import / the connections:changed event, or Reload Profiles.
 */
export function ensureProfilesLoaded(): void {
  if (profilesRequested) return;
  profilesRequested = true;
  void useConnectionStore.getState().loadProfiles();
}

let editConnectionHandler: ((profileId: string, section?: 'credentials' | 'tls') => void) | null = null;

/**
 * Opens Edit Connection for a profile (ConnectionDialog registers it through
 * registerConnectionCommands; the store cannot import the dialog, which
 * imports the store). Used by the "Edit…" action of a failed connect toast.
 */
export function setConnectionEditor(fn: ((profileId: string, section?: 'credentials' | 'tls') => void) | null): void {
  editConnectionHandler = fn;
}

/** Toast options of a failed connect: "Edit…" opens the profile's settings. */
function editAction(id: string, detail?: string) {
  const edit = editConnectionHandler;
  // A refused bind opens at the password, a TLS problem at TLS trust (RW2-C-04).
  return edit ? { action: { label: 'Edit…', run: () => edit(id, editSectionForError(detail)) } } : undefined;
}

let changeListener = false;
/** Reloads the list when the backend re-read connections.json (changed outside LDAPilot). */
function ensureChangeListener(reload: () => void) {
  if (changeListener || typeof window === 'undefined') return;
  const rt = (window as unknown as { runtime?: { EventsOn?: (name: string, cb: () => void) => unknown } }).runtime;
  if (!rt?.EventsOn) return;
  changeListener = true;
  try {
    rt.EventsOn('connections:changed', reload);
  } catch {
    changeListener = false;
  }
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  profiles: [],
  activeProfileId: null,
  connectionStatuses: {},
  loading: false,
  error: null,
  errorProfileId: null,
  connectErrors: {},

  loadProfiles: async () => {
    ensureChangeListener(() => {
      void get().loadProfiles();
      toast.info('connections.json was changed outside LDAPilot; the profiles were reloaded');
    });
    set({ loading: true, error: null, errorProfileId: null });
    try {
      const profiles = await wails.GetConnections();
      set({ profiles, loading: false });
      // The Go pool outlives a page reload (wails dev browser clients, a
      // reload of the webview): adopt connections that are still open so
      // the UI (e.g. the AI panel's "No directory is connected") matches.
      // Only adds connected profiles; never marks one as disconnected.
      const open = await Promise.all(profiles.map((p) => wails.GetConnectionStatus(p.id).then((on) => (on ? p.id : null)).catch(() => null)));
      const add = open.filter((id): id is string => !!id && get().connectionStatuses[id] === undefined);
      if (add.length > 0) {
        set((state) => ({ connectionStatuses: { ...state.connectionStatuses, ...Object.fromEntries(add.map((id) => [id, true])) } }));
      }
    } catch (err: any) {
      set({ error: err?.message || 'Failed to load profiles', loading: false });
    }
  },

  reloadProfiles: async () => {
    set({ loading: true, error: null, errorProfileId: null });
    try {
      const profiles = await wails.ReloadConnections();
      set({ profiles, loading: false });
      // App-wide: not about the active connection (RW1-C-08).
      toast.info(`Profiles reloaded from connections.json (${profiles.length})`, { connection: '' });
    } catch (err: any) {
      const msg = errMessage(err, 'Could not reload the profiles');
      set({ error: msg, loading: false });
      toast.error('Could not reload connections.json', msg);
    }
  },

  saveProfile: async (profile: ConnectionProfile, opts?: { quiet?: boolean }) => {
    set({ loading: true, error: null, errorProfileId: null });
    try {
      const saved = await wails.SaveConnection(profile);
      set((state) => {
        const idx = state.profiles.findIndex((p) => p.id === saved.id);
        const profiles = idx >= 0
          ? state.profiles.map((p, i) => i === idx ? saved : p)
          : [...state.profiles, saved];
        const { [saved.id]: _old, ...connectErrors } = state.connectErrors;
        return { profiles, loading: false, connectErrors };
      });
      // Tagged with the profile the toast is about, not the active one (RW1-C-08).
      if (!opts?.quiet) toast.success(`Profile "${saved.name}" saved`, { connection: saved.name || undefined });
      return saved;
    } catch (err: any) {
      const msg = err?.message || 'Failed to save profile';
      set({ error: msg, loading: false });
      toast.error(msg);
      // connections.json changed outside LDAPilot: show what is there now.
      if (/changed outside LDAPilot/i.test(msg)) void get().loadProfiles();
      throw err;
    }
  },

  deleteProfile: async (id: string) => {
    set({ error: null, errorProfileId: null });
    try {
      const name = get().profiles.find((p) => p.id === id)?.name;
      await wails.DeleteConnection(id);
      set((state) => {
        const { [id]: _old, ...connectErrors } = state.connectErrors;
        return {
          profiles: state.profiles.filter((p) => p.id !== id),
          activeProfileId: state.activeProfileId === id ? null : state.activeProfileId,
          connectionStatuses: Object.fromEntries(
            Object.entries(state.connectionStatuses).filter(([k]) => k !== id)
          ),
          connectErrors,
        };
      });
      toast.info(name ? `Connection "${name}" deleted` : 'Connection deleted');
    } catch (err: any) {
      const msg = err?.message || 'Failed to delete profile';
      set({ error: msg });
      toast.error(msg);
    }
  },

  deleteProfiles: async (ids: string[]) => {
    set({ error: null, errorProfileId: null });
    const names = new Map(get().profiles.map((p) => [p.id, p.name || 'Unnamed']));
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      try {
        await wails.DeleteConnection(id);
        deleted.push(id);
      } catch (err: any) {
        failed.push(`${names.get(id) ?? id}: ${errMessage(err, 'not deleted')}`);
      }
    }
    if (deleted.length) {
      const gone = new Set(deleted);
      set((state) => ({
        profiles: state.profiles.filter((p) => !gone.has(p.id)),
        activeProfileId: state.activeProfileId && gone.has(state.activeProfileId) ? null : state.activeProfileId,
        connectionStatuses: Object.fromEntries(Object.entries(state.connectionStatuses).filter(([k]) => !gone.has(k))),
        connectErrors: Object.fromEntries(Object.entries(state.connectErrors).filter(([k]) => !gone.has(k))),
      }));
    }
    const label = (n: number) => `${n} connection${n === 1 ? '' : 's'}`;
    if (failed.length) {
      const msg = deleted.length ? `${label(deleted.length)} deleted, ${failed.length} not` : `${label(failed.length)} not deleted`;
      set({ error: failed.join('\n') });
      toast.error(msg, failed.join('\n'), { connection: '' });
      // connections.json changed outside LDAPilot: show what is there now.
      if (failed.some((f) => /changed outside LDAPilot/i.test(f))) void get().loadProfiles();
    } else if (deleted.length === 1) {
      toast.info(`Connection "${names.get(deleted[0])}" deleted`, { connection: '' });
    } else if (deleted.length > 1) {
      toast.info(`${label(deleted.length)} deleted`, { detail: deleted.map((id) => names.get(id)).join(', '), connection: '' });
    }
    return deleted;
  },

  connect: async (id: string, opts?: { saved?: boolean }) => {
    set({ loading: true, error: null, errorProfileId: null });
    const profile = get().profiles.find(p => p.id === id);
    const name = profile?.name || 'server';
    // Create and Connect: the save is confirmed with the connect's outcome (RW3-C-03).
    const savedToast = () => {
      if (opts?.saved) toast.success(`Profile "${name}" saved`, { connection: profile?.name || undefined });
    };
    try {
      const { saved } = await withPasswordPrompt(profile, () => wails.Connect(id), () => set({ loading: false }), () => set({ loading: true }));
      set((state) => {
        const { [id]: _old, ...connectErrors } = state.connectErrors;
        return {
          connectionStatuses: { ...state.connectionStatuses, [id]: true },
          activeProfileId: id,
          loading: false,
          connectErrors,
          profiles: saved ? state.profiles.map((p) => (p.id === id ? { ...p, hasPassword: true } : p)) : state.profiles,
        };
      });
      rememberActiveProfile(id);
      toast.success(opts?.saved ? `"${name}" saved and connected` : `Connected to ${name}`, { connection: profile?.name || undefined });
    } catch (err: any) {
      if (wails.isConnectCancelled(err)) {
        // Disconnected while connecting (disconnect() already updated the state), or the password prompt was cancelled.
        set({ loading: false });
        savedToast();
        throw err;
      }
      const detail = errMessage(err, 'Connection failed');
      const msg = opts?.saved ? `"${name}" saved, but the connection failed` : `Failed to connect to ${name}`;
      set((state) => ({ error: detail, errorProfileId: id, loading: false, connectErrors: { ...state.connectErrors, [id]: detail } }));
      // Untrusted certificate: the trust prompt shows it and offers to pin it.
      if (isCertificateError(err)) {
        savedToast();
        useCertTrustStore.getState().open({ profileId: id, action: 'connect' });
      } else toast.error(msg, detail, { ...editAction(id, detail), connection: profile?.name || undefined });
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
      toast.info(`Disconnected from ${profile?.name || 'server'}`, { connection: profile?.name || undefined });
    } catch (err: any) {
      const msg = err?.message || 'Disconnect failed';
      set({ error: msg });
      toast.error(msg);
    }
  },

  testConnection: async (profile: ConnectionProfile) => {
    await wails.TestConnection(profile);
  },

  reconnect: async (id: string, opts?: { keepStatus?: boolean }) => {
    set({ loading: true, error: null, errorProfileId: null });
    const profile = get().profiles.find(p => p.id === id);
    try {
      await withPasswordPrompt(profile, () => wails.Reconnect(id), () => set({ loading: false }), () => set({ loading: true }));
      set((state) => {
        const { [id]: _old, ...connectErrors } = state.connectErrors;
        return { connectionStatuses: { ...state.connectionStatuses, [id]: true }, loading: false, connectErrors };
      });
      toast.success(`Reconnected to ${profile?.name || 'server'}`);
    } catch (err: any) {
      if (wails.isConnectCancelled(err)) {
        // Disconnected while reconnecting: disconnect() already updated the state
        set({ loading: false });
        throw err;
      }
      const detail = errMessage(err, 'Reconnect failed');
      set({
        error: detail,
        errorProfileId: id,
        loading: false,
        connectionStatuses: opts?.keepStatus ? get().connectionStatuses : { ...get().connectionStatuses, [id]: false },
        connectErrors: { ...get().connectErrors, [id]: detail },
      });
      if (isCertificateError(err)) useCertTrustStore.getState().open({ profileId: id, action: 'reconnect' });
      else toast.error(`Failed to reconnect to ${profile?.name || 'server'}`, detail, editAction(id, detail));
      throw err;
    }
  },

  setActiveProfile: (id: string | null) => {
    set({ activeProfileId: id });
    rememberActiveProfile(id);
  },

  updateStatus: (id: string, connected: boolean) => {
    set((state) => ({
      connectionStatuses: { ...state.connectionStatuses, [id]: connected },
    }));
  },

  // The row keeps its error mark (connectErrors) until the next successful connect.
  clearError: () => set({ error: null, errorProfileId: null }),
}))

// Notifications name the connection that was active when they appeared (bell).
setToastConnectionProvider(() => {
  const s = useConnectionStore.getState();
  return s.activeProfileId ? s.profiles.find((p) => p.id === s.activeProfileId)?.name : undefined;
});
