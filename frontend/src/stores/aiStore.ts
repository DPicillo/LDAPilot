/**
 * AI chat store (§10.1). Holds the reducer state (lib/aiReducer.ts) plus UI
 * state, and performs the side effects: binding calls, toasts, editor and
 * tree refreshes after AI writes, re-sync with running runs.
 *
 * The store registers itself as the consumer of all `ai:*` events at module
 * load, so runs, approvals and secrets are tracked while the AI panel is
 * unmounted.
 */
import { create } from 'zustand';
import * as api from '../lib/ai';
import { AIError } from '../lib/ai';
import {
  type Action,
  type AIState,
  heldCount,
  initialState,
  reduceApplied,
  runActive,
  selectPendingApprovalCount as selectPendingFromState,
} from '../lib/aiReducer';
import { dnKey, parentDN, providerKeyOf, rdnValue } from '../lib/aiFormat';
import type { AIConfig, AIEvent, ContextInfo, Mention, Message, ModelDiscovery, RunKind, UIContext, WriteInfo } from '../types/ai';
import { urlHost } from '../lib/aiFormat';
import { useConnectionStore } from './connectionStore';
import { useEditorStore } from './editorStore';
import { hasUnsavedEdits } from './unsavedEdits';
import { useTreeStore } from './treeStore';
import { selectAIShown, useUIStore } from './uiStore';
import { toast, useToastStore } from '../components/ui/Toast';
import { notifyCommandsChanged } from '../components/ui/commands';
import { cachedAccountStatus, forgetAccountStatus, rememberAccountStatus } from './accountStatusCache';
import { GetAccountStatus } from '../lib/wails-account';
import { normalizeDN } from '../lib/dn';

export type AIView = 'chat' | 'settings';

/** The settings form while it is being edited; kept in the store so leaving the settings view never loses edits. */
export interface SettingsDraft {
  draft: AIConfig;
  /**
   * The saved config the draft was cloned from: the merge base of "Reload"
   * in the stale banner (P2/A-35). The store's `config` is no base: the
   * ai:config event has already replaced it with the config saved elsewhere.
   */
  base?: AIConfig;
  keyMode: 'keep' | 'replace' | 'clear';
  newKey: string;
}

export interface LocalNotice {
  id: string;
  at: number;
  /** markdown, rendered as a local message that is never sent */
  text: string;
}

export interface AIStore extends AIState {
  activeChatId: string | null;
  view: AIView;
  /** saved config (masked) */
  config: AIConfig | null;
  configError: string | null;
  builtinRedactions: string[];
  contextInfo: Record<string, ContextInfo>;
  /** chat store unavailable (key error, I/O) */
  storeError: string | null;
  loadingChats: boolean;
  /** ListChats answered at least once */
  chatsLoaded: boolean;
  loadingChat: string | null;
  composerText: string;
  /** @entry mentions of the next message (Composer chips; "Ask AI about this entry" adds to them) */
  composerMentions: Mention[];
  /** the chat the mentions were made for (a chat switch drops them, "Ask AI" in a new chat keeps them) */
  composerMentionsChat: string | null;
  /** focus/caret nonce: bump to move focus into the composer */
  composerFocus: number;
  /** edit-and-resend of the last user message */
  editing: { chatId: string; messageId: string } | null;
  notices: Record<string, LocalNotice[]>;
  /** approval to scroll into view once the panel shows it */
  scrollToApproval: string | null;
  modelPickerOpen: boolean;
  /** unsaved AI settings (null = the form shows the saved config) */
  settingsDraft: SettingsDraft | null;
  /** the selected entry the user removed from the next messages (selectionKey), until the selection changes */
  selectionDismissed: string | null;
  /** bumped when the user sends (the message list then follows the bottom again) */
  sendNonce: number;
  /** the provider check before a send failed (A-19): shown above the composer */
  preflight: PreflightError | null;
  /** host the provider check is running for (the composer says so; it can take the dial timeout) */
  preflightChecking: string | null;
  /** the chat whose send the user stopped during the provider check (the composer says the text was kept) */
  preflightStopped: string | null;
  /** endpointKey of the config whose provider answered the last check */
  validatedKey: string | null;
  /** "Ask AI about …" starts a new chat (per device, localStorage) */
  askNewChat: boolean;

  dispatch: (a: Action) => void;
  init: () => Promise<void>;
  loadConfig: () => Promise<AIConfig | null>;
  loadChats: () => Promise<void>;
  selectChat: (id: string | null) => Promise<void>;
  /**
   * Opens a new (or reuses an unused) chat. `fresh` (the user's New chat:
   * +, Ctrl+Shift+N, /clear) also empties the composer's @mentions, so
   * entries an "Ask AI about …" put there do not move into it (N4).
   */
  newChat: (opts?: { fresh?: boolean }) => Promise<string | null>;
  deleteChat: (id: string) => Promise<void>;
  renameChat: (id: string, title: string) => Promise<void>;
  send: (text: string, mentions?: Mention[], force?: boolean) => Promise<boolean>;
  editLast: (text: string, mentions?: Mention[], force?: boolean) => Promise<boolean>;
  continueRun: (force?: boolean) => Promise<void>;
  regenerate: (force?: boolean) => Promise<void>;
  compact: (force?: boolean) => Promise<void>;
  stop: (chatId?: string) => Promise<void>;
  respond: (approvalId: string, decision: string, note?: string) => Promise<void>;
  reveal: (toolCallId: string) => Promise<string | null>;
  /** true when the grant is gone (an error toast was shown otherwise) */
  revokeGrant: (chatId: string, grantId: string) => Promise<boolean>;
  setChatModel: (chatId: string, model: string) => Promise<void>;
  refreshContextInfo: (chatId: string) => Promise<void>;
  resync: (chatId: string) => Promise<void>;
  discover: (refresh: boolean, cfg?: AIConfig) => Promise<ModelDiscovery | null>;
  setView: (v: AIView) => void;
  setComposerText: (t: string, focus?: boolean) => void;
  setComposerMentions: (m: Mention[]) => void;
  /**
   * "Ask AI about this entry" (command registry): opens the panel on the
   * chat view and adds the entries as @mentions of the next message.
   */
  askAbout: (mentions: Mention[], opts?: { newChat?: boolean }) => Promise<void>;
  startEditLast: () => boolean;
  cancelEdit: () => void;
  addNotice: (chatId: string, text: string) => void;
  clearNotices: (chatId: string) => void;
  openPanel: (chatId?: string, approvalId?: string) => void;
  setModelPickerOpen: (open: boolean) => void;
  setSettingsDraft: (d: SettingsDraft | null) => void;
  /** removes (or restores, with null) the auto-attached selected entry */
  dismissSelection: (sel: SelectedEntry | null) => void;
  /** repeats the action the provider check stopped; force skips the check */
  retryPreflight: (force: boolean) => Promise<void>;
  clearPreflight: () => void;
  /** Stop / Esc during "Checking the AI provider … before sending" (P4): nothing is sent, the text stays. */
  cancelPreflight: () => void;
  refreshEgress: (chatId: string) => Promise<void>;
  setAskNewChat: (v: boolean) => void;
}

const ASK_NEW_CHAT_KEY = 'ldapilot-ai-ask-new-chat';

/** How long "Undo" is offered after a chat was deleted. */
const DELETE_UNDO_MS = 6000;

function readAskNewChat(): boolean {
  try {
    return localStorage.getItem(ASK_NEW_CHAT_KEY) !== 'false';
  } catch {
    return true;
  }
}

export interface PreflightError {
  chatId: string;
  /** the discovery error (host:port and cause) */
  message: string;
  host: string;
  /** the alert title, from the cause */
  title: string;
  /** what was stopped: a send or edit is repeated with the composer's current text (A-19 review) */
  kind: RunKind;
}

export interface SelectedEntry {
  profileId: string;
  dn: string;
}

/** Errors after which the provider is checked again before the next send. */
const REACHABILITY_CODES = new Set(['provider_unreachable', 'timeout', 'auth_failed', 'model_not_found']);
/**
 * CheckProvider failures that stop a send: the endpoint did not answer.
 * Any other listing error (a key without model-list permission, a gateway
 * without /models: 401/403/404) only adds a notice; the run itself may work.
 */
const BLOCKING_CODES = new Set(['provider_unreachable', 'timeout']);

/** What a provider check is valid for: endpoint, model and key state (A-19: a URL change re-validates). */
export function endpointKey(cfg: AIConfig): string {
  return JSON.stringify([cfg.engine, cfg.provider, cfg.flavor || '', (cfg.url || '').trim().replace(/\/+$/, ''), cfg.model, !!cfg.hasKey, cfg.revision]);
}

export function selectionKey(sel: SelectedEntry): string {
  return sel.profileId + '\n' + dnKey(sel.dn);
}

/** The entry LDAPilot attaches as "selected_entry": the active editor tab, else the single tree selection. */
export function selectedEntry(): SelectedEntry | null {
  const conn = useConnectionStore.getState();
  const ed = useEditorStore.getState();
  const tab = ed.tabs.find((t) => t.id === ed.activeTabId && t.dn && t.profileId);
  if (tab) return { profileId: tab.profileId, dn: tab.dn };
  const sel = useTreeStore.getState().selectedNodes;
  if (sel.size === 1 && conn.activeProfileId) {
    const dn = sel.values().next().value ?? '';
    if (dn) return { profileId: conn.activeProfileId, dn };
  }
  return null;
}

let tempSeq = 0;
const tempId = () => `local-${Date.now().toString(36)}-${(tempSeq++).toString(36)}`;

function errMsg(err: unknown): string {
  if (err instanceof AIError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** The text of a user message as typed (hidden context/continue blocks excluded). */
export function userText(m: Message): string {
  return (m.blocks ?? [])
    .filter((b) => b.type === 'text' && !b.meta?.kind)
    .map((b) => b.text ?? '')
    .join('\n');
}

export function isUserTextMessage(m: Message): boolean {
  return m.role === 'user' && (m.blocks ?? []).some((b) => b.type === 'text' && !b.meta?.kind && (b.text ?? '').trim() !== '');
}

/**
 * UIContext for a send: active profile, selected entry (editor tab, else
 * single tree selection) unless the user removed its chip, mentions.
 */
export function buildUIContext(mentions: Mention[] = []): UIContext {
  const conn = useConnectionStore.getState();
  let selectedDn = '';
  let selectedProfileId = '';
  const sel = selectedEntry();
  if (sel && useAIStore.getState().selectionDismissed !== selectionKey(sel)) {
    selectedDn = sel.dn;
    selectedProfileId = sel.profileId;
  }
  let timeZone = '';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch { /* ignore */ }
  return {
    activeProfileId: conn.activeProfileId ?? '',
    selectedDn,
    selectedProfileId,
    mentions,
    locale: navigator.language || 'en',
    timeZone,
  };
}

/**
 * Toast for an AI side effect (ui/Toast.tsx). One with an action button
 * ("Review", "Reload entry", "Open new DN") stays until the user acts on it
 * or dismisses it, like errors here; other infos use the default duration.
 */
function notify(type: 'success' | 'error' | 'info' | 'warning', message: string, action?: { label: string; onClick: () => void }, detail?: string): string {
  return useToastStore.getState().addToast(type, message, {
    detail,
    persistent: action != null || type === 'error' || type === 'warning',
    action: action ? { label: action.label, run: action.onClick } : undefined,
  });
}

function panelVisible(): boolean {
  return selectAIShown(useUIStore.getState());
}

const secretTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** runId → "Earlier messages were summarized (…)" of /compact runs */
const compactNotes = new Map<string, string>();
/**
 * approvalId → id of its toast, so exactly that toast disappears once the
 * request is resolved (two chats can wait on the same tool and connection,
 * i.e. on toasts with the same text).
 */
const approvalToasts = new Map<string, string>();

function dismissApprovalToast(approvalId: string) {
  const toastId = approvalToasts.get(approvalId);
  if (!toastId) return;
  approvalToasts.delete(approvalId);
  useToastStore.getState().removeToast(toastId);
}

/**
 * An AI write may have changed an account's state (unlock, enable/disable,
 * must change, password reset): drop the cached server status like the
 * account commands do (featureCommands afterAccountChange), so the tree,
 * search results and container list overlays and the account verbs do not
 * keep the old state; a status that was cached is read again right away.
 */
function invalidateAccountStatus(profileId: string, dn: string) {
  const had = cachedAccountStatus(profileId, dn) != null;
  forgetAccountStatus(profileId, dn);
  if (!had) {
    notifyCommandsChanged();
    return;
  }
  GetAccountStatus(profileId, dn)
    .then((st) => {
      if (!st) return;
      rememberAccountStatus(profileId, st);
      if (normalizeDN(st.dn) !== normalizeDN(dn)) rememberAccountStatus(profileId, { ...st, dn });
    })
    .catch(() => { /* the next surface that needs it reads it */ })
    .finally(notifyCommandsChanged);
}

export const useAIStore = create<AIStore>((set, get) => {
  /** Applies an action; returns the run events it applied (held ones included). */
  const apply = (a: Action): AIEvent[] => {
    let applied: AIEvent[] = [];
    set((s) => {
      const r = reduceApplied(s, a);
      applied = r.applied;
      return r.state as Partial<AIStore>;
    });
    return applied;
  };
  const dispatch = (a: Action) => {
    for (const ev of apply(a)) sideEffects(ev);
    watchHeld(a);
  };

  const heldTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastEventAt = new Map<string, number>();

  /** Early events whose predecessor does not arrive: re-sync with the run. */
  function watchHeld(a: Action) {
    const chatId = (a.payload as { chatId?: string } | undefined)?.chatId;
    if (!chatId || !a.name.startsWith('ai:')) return;
    lastEventAt.set(chatId, Date.now());
    if (!heldCount(get(), chatId) || heldTimers.has(chatId)) return;
    heldTimers.set(chatId, setTimeout(() => {
      heldTimers.delete(chatId);
      if (heldCount(get(), chatId)) void recover(chatId);
    }, 600));
  }

  /** Re-sync a chat whose events are incomplete (gap, lost ai:done). */
  async function recover(chatId: string) {
    let snap = null;
    try {
      snap = await api.GetRunState(chatId);
    } catch { /* ignore */ }
    if (snap) {
      dispatch({ name: 'local/snapshot', payload: { snapshot: snap, now: Date.now() } });
      if (heldCount(get(), chatId)) dispatch({ name: 'local/flush_held', payload: { chatId } });
      return;
    }
    // The run is over: apply what is held, end the run locally and load the
    // persisted transcript.
    dispatch({ name: 'local/flush_held', payload: { chatId } });
    const r = get().runs[chatId];
    if (runActive(r)) {
      dispatch({ name: 'local/run_gone', payload: { chatId, now: Date.now() } });
      void settle(chatId, r!.runId);
    } else if (get().transcripts[chatId] !== undefined) {
      try {
        const v = await api.GetChat(chatId);
        dispatch({ name: 'local/chat_loaded', payload: { view: v } });
      } catch { /* ignore */ }
    }
    void get().loadChats();
  }

  // A run that has been silent for a while is checked against Go (a lost
  // ai:done must never leave a chat "running" for good).
  setInterval(() => {
    const now = Date.now();
    for (const [chatId, r] of Object.entries(get().runs)) {
      if (!runActive(r) || r.status === 'awaiting_approval') continue;
      if (now - (lastEventAt.get(chatId) ?? r.startedAt) < 45_000) continue;
      lastEventAt.set(chatId, now);
      void (async () => {
        let snap = null;
        try {
          snap = await api.GetRunState(chatId);
        } catch {
          return;
        }
        const cur = get().runs[chatId];
        if (!cur || cur.runId !== r.runId || !runActive(cur)) return;
        if (!snap) void recover(chatId);
        else if (snap.runId !== cur.runId || snap.lastSeq > cur.lastSeq) dispatch({ name: 'local/snapshot', payload: { snapshot: snap, now: Date.now() } });
      })();
    }
  }, 15_000);

  /** After ai:done: replace the live messages with the persisted transcript. */
  async function settle(chatId: string, runId: string) {
    const r = get().runs[chatId];
    if (!r || r.runId !== runId) return;
    const loaded = get().transcripts[chatId] !== undefined;
    try {
      if (!loaded) {
        dispatch({ name: 'local/tail', payload: { chatId, runId, baseMessageId: null, messages: [] } });
        return;
      }
      if (r.done?.contextEdited || r.baseMessageId === null) {
        const v = await api.GetChat(chatId);
        dispatch({ name: 'local/chat_loaded', payload: { view: v } });
        dispatch({ name: 'local/tail', payload: { chatId, runId, baseMessageId: null, messages: v.messages ?? [] } });
      } else {
        const msgs = await api.GetMessages(chatId, r.baseMessageId);
        dispatch({ name: 'local/tail', payload: { chatId, runId, baseMessageId: r.baseMessageId, messages: msgs ?? [] } });
      }
    } catch (err) {
      const e = err as AIError;
      if (e.code === 'not_found' || e.code === 'invalid_chat_id') {
        dispatch({ name: 'local/chat_deleted', payload: { chatId } });
        return;
      }
      console.warn('[ai] could not load the finished run', err);
    }
    void get().refreshContextInfo(chatId);
    void get().refreshEgress(chatId);
    void get().loadChats();
  }

  function afterWrite(w: WriteInfo) {
    const ed = useEditorStore.getState();
    const tree = useTreeStore.getState();
    const target = dnKey(w.dn);
    // `dirty` only says that the tab saved an attribute at some point (the
    // editor saves immediately and never clears it); unsaved edits are the
    // forms registered in stores/unsavedEdits (EditEntryDialog, an inline
    // edit or the add row of the attribute table).
    const unsaved = w.op !== 'delete' && w.op !== 'rename' && w.op !== 'move' && hasUnsavedEdits(w.profileId, w.dn);
    const rdn = rdnValue(w.dn);
    let tabOpen = false;
    for (const tab of ed.tabs) {
      if (tab.profileId !== w.profileId || !tab.dn || dnKey(tab.dn) !== target) continue;
      tabOpen = true;
      if (w.op === 'delete') {
        notify('info', `The assistant deleted ${rdn}, which is open in a tab.`);
      } else if ((w.op === 'rename' || w.op === 'move') && w.newDn) {
        const newDn = w.newDn;
        notify('info', `The assistant renamed or moved ${rdn}.`, {
          label: 'Open new DN',
          onClick: () => useEditorStore.getState().openEntry(w.profileId, newDn),
        });
      } else if (!unsaved) {
        void ed.refreshEntry(tab.profileId, tab.dn);
      }
    }
    if (unsaved) {
      notify(
        'warning',
        `The assistant changed ${rdn} while you have unsaved edits of it`,
        tabOpen ? { label: 'Reload entry', onClick: () => void useEditorStore.getState().refreshEntry(w.profileId, w.dn) } : undefined,
        'Saving your edits now could overwrite the assistant\'s change. Discard or finish them, then reload the entry.',
      );
    }
    if (w.newDn) {
      for (const tab of ed.tabs) {
        if (tab.profileId === w.profileId && tab.dn && dnKey(tab.dn) === dnKey(w.newDn) && !hasUnsavedEdits(tab.profileId, tab.dn)) void ed.refreshEntry(tab.profileId, tab.dn);
      }
    }
    if (w.op === 'modify') invalidateAccountStatus(w.profileId, w.dn);
    else {
      forgetAccountStatus(w.profileId, w.dn);
      notifyCommandsChanged();
    }
    const parents = new Set<string>();
    if (w.op === 'create' || w.op === 'delete') parents.add(w.parentDn || parentDN(w.dn));
    if (w.op === 'rename' || w.op === 'move') {
      parents.add(w.parentDn || parentDN(w.dn));
      if (w.newDn) parents.add(parentDN(w.newDn));
    }
    for (const p of parents) if (p) void tree.refreshNode(w.profileId, p);
  }

  function scheduleSecretExpiry(toolCallId: string, expiresAt: number) {
    const prev = secretTimers.get(toolCallId);
    if (prev) clearTimeout(prev);
    const delay = Math.max(0, expiresAt - Date.now()) + 50;
    secretTimers.set(toolCallId, setTimeout(() => {
      secretTimers.delete(toolCallId);
      dispatch({ name: 'local/expire_secrets', payload: { now: Date.now() } });
    }, Math.min(delay, 2_147_000_000)));
  }

  function onEvent(ev: AIEvent) {
    dispatch(ev);
  }

  /** Side effects of an applied run event (in seq order, also for events that were held). */
  function sideEffects(ev: AIEvent) {
    switch (ev.name) {
      case 'ai:approval_request': {
        const e = ev.payload;
        const r = get().runs[e.chatId];
        if (!r || r.runId !== e.runId || !r.approvals[e.approvalId]) return;
        if (!panelVisible() || get().activeChatId !== e.chatId || get().view !== 'chat') {
          const what = e.kind === 'access' ? `access to ${e.connection.label}` : `${e.toolDisplayName || e.tool} on ${e.connection.label}`;
          const msg = `The AI assistant needs your approval (${what})`;
          approvalToasts.set(e.approvalId, notify('info', msg, { label: 'Review', onClick: () => get().openPanel(e.chatId, e.approvalId) }));
        }
        return;
      }
      case 'ai:approval_resolved':
        dismissApprovalToast(ev.payload.approvalId);
        return;
      case 'ai:tool_end': {
        const e = ev.payload;
        if (e.status === 'ok' && e.write) afterWrite(e.write);
        scheduleEgress(e.chatId);
        return;
      }
      case 'ai:secret_available':
        scheduleSecretExpiry(ev.payload.toolCallId, ev.payload.expiresAt);
        return;
      case 'ai:done': {
        const e = ev.payload;
        const r = get().runs[e.chatId];
        if (!r || r.runId !== e.runId) return;
        for (const id of Object.keys(r.approvals)) dismissApprovalToast(id);
        void settle(e.chatId, e.runId);
        if (r.kind === 'compact') {
          // A /compact run has no answer of its own: say when it failed or
          // warned (a success shows the "Earlier messages summarized"
          // divider; a second notice repeated it, A-03).
          const text = r.error ? `/compact failed: ${r.error.message}` : r.warnings.join(' ');
          if (text) get().addNotice(e.chatId, text);
        }
        compactNotes.delete(r.runId);
        if (!panelVisible() && e.status === 'error' && r.error) {
          notify('error', `AI assistant: ${r.error.message}`);
        }
        // The endpoint failed: check it again before the next send; a run
        // that got an answer proves it (also after "Send anyway").
        if (r.error && REACHABILITY_CODES.has(r.error.code)) set({ validatedKey: null });
        else if (e.status === 'completed' && get().config) set({ validatedKey: endpointKey(get().config!) });
        return;
      }
      case 'ai:status': {
        const e = ev.payload;
        if (e.kind === 'compacted' && e.message) compactNotes.set(e.runId, e.message);
        return;
      }
      case 'ai:config_updated': {
        const cfg = get().config;
        if (!cfg || ev.payload.revision > cfg.revision) void get().loadConfig();
        return;
      }
      case 'ai:chat_updated':
        if (!get().chats.some((c) => c.id === ev.payload.chatId)) void get().loadChats();
        return;
      default:
        return;
    }
  }

  const egressTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Re-reads the chat's egress ledger shortly after a tool result (A-08). */
  function scheduleEgress(chatId: string) {
    if (!get().chatMeta[chatId] || egressTimers.has(chatId)) return;
    egressTimers.set(chatId, setTimeout(() => {
      egressTimers.delete(chatId);
      void get().refreshEgress(chatId);
    }, 250));
  }

  /**
   * Chats deleted in the list (A-07): Go hides them (DeleteChatLater) and
   * deletes them when LDAPilot quits; here they are deleted for good once
   * their Undo toast is gone (it pauses while pointed at, so no timer of
   * our own decides). The value is the delayed final delete.
   */
  const pendingDeletes = new Map<string, ReturnType<typeof setTimeout> | null>();

  function finalizeAfterToast(id: string, toastId: string) {
    const unsub = useToastStore.subscribe((st) => {
      if (st.toasts.some((t) => t.id === toastId) || !pendingDeletes.has(id)) {
        if (!pendingDeletes.has(id)) unsub();
        return;
      }
      unsub();
      // The Undo button removes the toast before it runs: give it a moment.
      pendingDeletes.set(id, setTimeout(() => {
        if (!pendingDeletes.has(id)) return;
        pendingDeletes.delete(id);
        void deleteNow(id);
      }, 300));
    });
  }

  async function undoDelete(id: string) {
    const t = pendingDeletes.get(id);
    if (t) clearTimeout(t);
    pendingDeletes.delete(id);
    try {
      await api.RestoreChat(id);
    } catch (err) {
      if ((err as AIError).code === 'not_found') toast.info('The chat was already deleted.');
      else toast.error('The chat could not be restored', errMsg(err));
      return;
    }
    await get().loadChats();
  }

  async function deleteNow(id: string) {
    try {
      await api.DeleteChat(id);
      dispatch({ name: 'local/chat_deleted', payload: { chatId: id } });
      if (get().activeChatId === id) set({ activeChatId: null, editing: null });
      for (const [k, t] of secretTimers) {
        if (!get().secrets[k]) { clearTimeout(t); secretTimers.delete(k); }
      }
    } catch (err) {
      toast.error('The chat could not be deleted', errMsg(err));
      void get().loadChats();
    }
  }

  /** The action a failed provider check stopped (repeated by retryPreflight). */
  let preflightRetry: ((force: boolean) => Promise<unknown>) | null = null;
  /** Number of the newest provider check, and the newest one the user stopped. */
  let preflightSeq = 0;
  let preflightCancelled = 0;
  /** ends the running check's wait at once (the Go call ends when its cancel arrives) */
  let stopCheck: (() => void) | null = null;

  /**
   * Checks the provider before a run when the endpoint or model changed
   * since the last successful check, or after a run failed to reach it
   * (A-19). A failure is shown above the composer and stops the run.
   */
  async function preflight(chatId: string, kind: RunKind, retry: (force: boolean) => Promise<unknown>): Promise<boolean> {
    const cfg = get().config;
    if (!cfg || cfg.engine === 'claudecode' || !cfg.provider) return true; // Go reports config_missing / Claude Code checks itself
    const key = endpointKey(cfg);
    if (get().validatedKey === key) return true;
    let d: ModelDiscovery;
    let where = urlHost(cfg.url);
    try {
      where = new URL(cfg.url).host || where;
    } catch { /* keep the host */ }
    const seq = ++preflightSeq;
    set({ preflightChecking: where || 'the AI provider', preflightStopped: null });
    const stopped = new Promise<null>((res) => { stopCheck = () => res(null); });
    try {
      const r = await Promise.race([api.CheckProvider(cfg), stopped]);
      if (!r) return false;
      d = r;
    } catch (err) {
      const e = err as AIError;
      // Stopped by the user (P4): no alert, nothing sent.
      if (preflightCancelled >= seq || e.code === 'cancelled') return false;
      if (!BLOCKING_CODES.has(e.code)) return true; // an invalid config: the run reports it
      preflightRetry = retry;
      const title = e.code === 'timeout' ? 'The AI provider did not answer in time' : 'The AI provider did not answer';
      set({ preflight: { chatId, message: e.message, host: urlHost(cfg.url), title, kind } });
      return false;
    } finally {
      if (seq === preflightSeq) {
        stopCheck = null;
        set({ preflightChecking: null });
      }
    }
    if (preflightCancelled >= seq) return false;
    dispatch({ name: 'local/models', payload: { providerKey: d.provider || providerKeyOf(cfg), discovery: d } });
    if (d.error) {
      // It answered (e.g. 401/403/404 on the model list): the run reports
      // its own error if the chat endpoint refuses too.
      get().addNotice(chatId, `The model list of the AI provider could not be read (${d.error}); the message was sent anyway.`);
    }
    preflightRetry = null;
    set({ validatedKey: key, preflight: null });
    return true;
  }

  api.setAIEventHandler(onEvent);

  async function startRun(
    chatId: string,
    kind: RunKind,
    text: string,
    baseMessageId: string | null,
    run: () => Promise<{ runId: string; userMessageId: string }>,
    truncateAfter?: string | null,
    retry?: (force: boolean) => Promise<unknown>,
    force = false,
  ): Promise<boolean> {
    if (!force && retry && !(await preflight(chatId, kind, retry))) return false;
    if (get().preflight?.chatId === chatId) set({ preflight: null });
    const id = tempId();
    set((s) => ({ sendNonce: s.sendNonce + 1 }));
    dispatch({ name: 'local/pending_send', payload: { chatId, tempId: id, kind, text, now: Date.now(), baseMessageId, truncateAfter } });
    try {
      const res = await run();
      dispatch({ name: 'local/send_result', payload: { chatId, tempId: id, runId: res.runId, userMessageId: res.userMessageId } });
      return true;
    } catch (err) {
      dispatch({ name: 'local/send_failed', payload: { chatId, tempId: id } });
      const e = err as AIError;
      if (e.code === 'run_active') {
        void get().resync(chatId);
        toast.info('A response is still running in this chat.');
      } else {
        toast.error('The message could not be sent', errMsg(err));
      }
      if (truncateAfter !== undefined) {
        // the local truncation was optimistic: reload the chat
        try {
          const v = await api.GetChat(chatId);
          dispatch({ name: 'local/chat_loaded', payload: { view: v } });
        } catch { /* ignore */ }
      }
      return false;
    }
  }

  /**
   * A new chat the user asked for starts without the previous @mentions
   * (N4: "+" right after "Ask AI about …" sent 5 leftover mentions with an
   * unrelated question) and offers the selected entry again; typed text stays.
   */
  function freshComposer(): Partial<AIStore> {
    return { composerMentions: [], composerMentionsChat: null, selectionDismissed: null, preflightStopped: null };
  }

  /** Empties the composer unless the user changed it while the message was being sent. */
  function clearComposer(typed: string, typedMentions: Mention[]) {
    const st = get();
    set({
      ...(st.composerText === typed ? { composerText: '' } : {}),
      ...(st.composerMentions === typedMentions ? { composerMentions: [] } : {}),
    });
  }

  function lastMessageId(chatId: string): string | null {
    const msgs = get().transcripts[chatId];
    if (!msgs) return null;
    return msgs.length ? msgs[msgs.length - 1].id : '';
  }

  /** Index of the last user message with typed text. */
  function lastUserIndex(msgs: Message[]): number {
    for (let i = msgs.length - 1; i >= 0; i--) if (isUserTextMessage(msgs[i])) return i;
    return -1;
  }

  return {
    ...initialState(),
    activeChatId: null,
    view: 'chat',
    config: null,
    configError: null,
    builtinRedactions: [],
    contextInfo: {},
    storeError: null,
    loadingChats: false,
    chatsLoaded: false,
    loadingChat: null,
    composerText: '',
    composerMentions: [],
    composerMentionsChat: null,
    composerFocus: 0,
    editing: null,
    notices: {},
    scrollToApproval: null,
    modelPickerOpen: false,
    settingsDraft: null,
    selectionDismissed: null,
    sendNonce: 0,
    preflight: null,
    preflightChecking: null,
    preflightStopped: null,
    validatedKey: null,
    askNewChat: readAskNewChat(),

    dispatch,

    init: async () => {
      await Promise.all([get().loadConfig(), get().loadChats()]);
      try {
        const b = await api.GetBuiltinRedactions();
        set({ builtinRedactions: b ?? [] });
      } catch { /* ignore */ }
    },

    loadConfig: async () => {
      try {
        const cfg = await api.GetAIConfig();
        const prev = get().config;
        // A changed endpoint is checked again before the next send; the old
        // check's error no longer applies.
        const changed = !prev || endpointKey(prev) !== endpointKey(cfg);
        set({ config: cfg, configError: null, ...(changed ? { preflight: null } : {}) });
        return cfg;
      } catch (err) {
        set({ configError: errMsg(err) });
        return null;
      }
    },

    loadChats: async () => {
      set({ loadingChats: get().chats.length === 0 });
      try {
        // chats waiting for their Undo time stay hidden
        const chats = (await api.ListChats())?.filter((c) => !pendingDeletes.has(c.id));
        dispatch({ name: 'local/chats', payload: { chats: chats ?? [] } });
        set({ storeError: null, loadingChats: false, chatsLoaded: true });
        const active = get().activeChatId;
        if (active && !(chats ?? []).some((c) => c.id === active)) set({ activeChatId: null });
      } catch (err) {
        set({ storeError: errMsg(err), loadingChats: false, chatsLoaded: true });
      }
    },

    selectChat: async (id) => {
      set({ activeChatId: id, editing: null, modelPickerOpen: false });
      if (!id) return;
      set({ loadingChat: id });
      try {
        const [v, grants] = await Promise.all([api.GetChat(id), api.GetGrants(id).catch(() => null)]);
        dispatch({ name: 'local/chat_loaded', payload: { view: v } });
        if (grants) dispatch({ name: 'local/grants', payload: { chatId: id, grants } });
        if (!runActive(get().runs[id]) && (v.running || v.pendingWrite)) await get().resync(id);
      } catch (err) {
        toast.error('The chat could not be opened', errMsg(err));
      } finally {
        if (get().loadingChat === id) set({ loadingChat: null });
      }
      void get().refreshContextInfo(id);
    },

    newChat: async (opts) => {
      // An unused chat (no messages, no run, no model pinned) is reused
      // instead of persisting another identical "New chat" (+, Ctrl+Shift+N
      // and /clear on a fresh chat): the active one first, else the newest.
      const st = get();
      const unused = (id: string | null) => {
        if (!id) return false;
        const c = st.chats.find((x) => x.id === id);
        return !!c && c.messageCount === 0 && !c.running && !c.model && !runActive(st.runs[id]) && !st.pending[id] && (st.transcripts[id]?.length ?? 0) === 0;
      };
      const reuse = unused(st.activeChatId) ? st.activeChatId : st.chats.find((c) => c.title === 'New chat' && unused(c.id))?.id;
      if (reuse) {
        if (reuse !== st.activeChatId) await get().selectChat(reuse);
        // A fresh start: local notices (/help, /model output) go too.
        set((s) => {
          const notices = { ...s.notices };
          delete notices[reuse];
          return { notices, activeChatId: reuse, editing: null, view: 'chat', composerFocus: s.composerFocus + 1, ...(opts?.fresh ? freshComposer() : {}) };
        });
        return reuse;
      }
      try {
        const c = await api.CreateChat('');
        dispatch({ name: 'local/chats', payload: { chats: [c, ...get().chats.filter((x) => x.id !== c.id)] } });
        dispatch({
          name: 'local/chat_loaded',
          payload: { view: { ...c, modelOverride: '', messages: [], compactions: [], egress: [], readOnly: false } },
        });
        set({ activeChatId: c.id, editing: null, view: 'chat', composerFocus: get().composerFocus + 1, ...(opts?.fresh ? freshComposer() : {}) });
        return c.id;
      } catch (err) {
        toast.error('Could not create a chat', errMsg(err));
        return null;
      }
    },

    deleteChat: async (id) => {
      // A running chat is deleted right away (the run stops with it);
      // others disappear at once and are deleted after the Undo time (A-07).
      if (runActive(get().runs[id])) {
        await deleteNow(id);
        return;
      }
      const title = get().chats.find((c) => c.id === id)?.title || 'New chat';
      try {
        await api.DeleteChatLater(id);
      } catch (err) {
        toast.error('The chat could not be deleted', errMsg(err));
        return;
      }
      dispatch({ name: 'local/chats', payload: { chats: get().chats.filter((c) => c.id !== id) } });
      if (get().activeChatId === id) set({ activeChatId: null, editing: null });
      const prev = pendingDeletes.get(id);
      if (prev) clearTimeout(prev);
      pendingDeletes.set(id, null);
      const toastId = toast.success(`Chat “${title}” deleted`, {
        duration: DELETE_UNDO_MS,
        action: { label: 'Undo', run: () => void undoDelete(id) },
      });
      finalizeAfterToast(id, toastId);
    },

    renameChat: async (id, title) => {
      try {
        await api.RenameChat(id, title);
        await get().loadChats();
      } catch (err) {
        toast.error('The chat could not be renamed', errMsg(err));
      }
    },

    send: async (text, mentions = [], force = false) => {
      let chatId = get().activeChatId;
      if (!chatId) {
        chatId = await get().newChat();
        if (!chatId) return false;
      }
      if (get().transcripts[chatId] === undefined) await get().selectChat(chatId);
      const id = chatId;
      // what the composer showed when this was sent: text typed during the
      // provider check is kept (A-19 review)
      const typed = get().composerText;
      const typedMentions = get().composerMentions;
      const retry = (f: boolean) => get().send(text, mentions, f);
      const ok = await startRun(id, 'send', text, lastMessageId(id), () => api.SendMessage({ chatId: id, text, ui: buildUIContext(mentions) }), undefined, retry, force);
      if (ok) clearComposer(typed, typedMentions);
      return ok;
    },

    editLast: async (text, mentions = [], force = false) => {
      const ed = get().editing;
      const chatId = ed?.chatId ?? get().activeChatId;
      if (!chatId) return false;
      const msgs = get().transcripts[chatId] ?? [];
      const idx = lastUserIndex(msgs);
      if (idx < 0) return false;
      const base = idx > 0 ? msgs[idx - 1].id : '';
      const typed = get().composerText;
      const typedMentions = get().composerMentions;
      const retry = (f: boolean) => get().editLast(text, mentions, f);
      const ok = await startRun(chatId, 'edit', text, base, () => api.EditLastUserMessage(chatId, text, buildUIContext(mentions)), idx > 0 ? base : null, retry, force);
      if (ok) {
        set({ editing: null });
        clearComposer(typed, typedMentions);
      }
      return ok;
    },

    continueRun: async (force = false) => {
      const chatId = get().activeChatId;
      if (!chatId) return;
      await startRun(chatId, 'continue', 'Continue.', lastMessageId(chatId), () => api.ContinueRun(chatId, buildUIContext()), undefined, (f) => get().continueRun(f), force);
    },

    regenerate: async (force = false) => {
      const chatId = get().activeChatId;
      if (!chatId) return;
      const msgs = get().transcripts[chatId] ?? [];
      const idx = lastUserIndex(msgs);
      if (idx < 0) return;
      const base = idx > 0 ? msgs[idx - 1].id : '';
      await startRun(chatId, 'regenerate', userText(msgs[idx]), base, () => api.RegenerateLast(chatId, buildUIContext()), idx > 0 ? base : null, (f) => get().regenerate(f), force);
    },

    compact: async (force = false) => {
      const chatId = get().activeChatId;
      if (!chatId) return;
      if (get().config?.engine === 'claudecode') {
        toast.info('Claude Code manages its own context; /compact is not available with this engine.');
        return;
      }
      await startRun(chatId, 'compact', '', null, () => api.CompactChat(chatId), undefined, (f) => get().compact(f), force);
    },

    stop: async (chatId) => {
      const id = chatId ?? get().activeChatId;
      if (!id) return;
      try {
        await api.StopRun(id);
      } catch (err) {
        toast.error('Could not stop the response', errMsg(err));
      }
    },

    respond: async (approvalId, decision, note = '') => {
      try {
        const res = await api.RespondApproval(approvalId, decision, note);
        dispatch({ name: 'local/approval_answered', payload: { approvalId, status: res.status, decision: res.decision, by: res.by, now: Date.now() } });
      } catch (err) {
        toast.error('The decision could not be applied', errMsg(err));
      }
    },

    reveal: async (toolCallId) => {
      const s = get().secrets[toolCallId];
      if (!s) return null;
      if (s.value !== undefined) return s.value;
      if (s.revealed || s.expiresAt <= Date.now()) return null;
      try {
        const v = await api.RevealSecret(toolCallId);
        dispatch({ name: 'local/secret_revealed', payload: { toolCallId, value: v.value, expiresAt: v.expiresAt } });
        scheduleSecretExpiry(toolCallId, Math.min(s.expiresAt, v.expiresAt || s.expiresAt));
        return v.value;
      } catch (err) {
        dispatch({ name: 'local/secret_gone', payload: { toolCallId } });
        toast.error('The password is no longer available', errMsg(err));
        return null;
      }
    },

    revokeGrant: async (chatId, grantId) => {
      let failure: unknown = null;
      try {
        await api.RevokeGrant(chatId, grantId);
      } catch (err) {
        failure = err;
      }
      // re-read either way: a grant used up or removed meanwhile is gone too
      let gone = failure === null;
      try {
        const g = (await api.GetGrants(chatId)) ?? [];
        dispatch({ name: 'local/grants', payload: { chatId, grants: g } });
        gone = !g.some((x) => x.id === grantId);
      } catch { /* the list stays as it was */ }
      if (!gone) toast.error('The approval could not be revoked', errMsg(failure ?? new Error('It is still active.')));
      return gone;
    },

    setChatModel: async (chatId, model) => {
      try {
        await api.SetChatModel(chatId, model);
        dispatch({ name: 'local/chat_model', payload: { chatId, model } });
        void get().refreshContextInfo(chatId);
      } catch (err) {
        toast.error('The model could not be set for this chat', errMsg(err));
      }
    },

    refreshContextInfo: async (chatId) => {
      try {
        const ci = await api.GetContextInfo(chatId);
        set({ contextInfo: { ...get().contextInfo, [chatId]: ci } });
      } catch { /* the meter stays as it was */ }
    },

    resync: async (chatId) => {
      try {
        const snap = await api.GetRunState(chatId);
        if (snap) dispatch({ name: 'local/snapshot', payload: { snapshot: snap, now: Date.now() } });
      } catch { /* ignore */ }
    },

    discover: async (refresh, cfgArg) => {
      const cfg = cfgArg ?? get().config;
      if (!cfg || (cfg.engine !== 'claudecode' && !cfg.provider)) return null;
      try {
        const d = await api.DiscoverModels(cfg, refresh);
        dispatch({ name: 'local/models', payload: { providerKey: d.provider || providerKeyOf(cfg), discovery: d } });
        return d;
      } catch (err) {
        const d: ModelDiscovery = { provider: providerKeyOf(cfg), baseUrl: cfg.url, models: get().models[providerKeyOf(cfg)]?.models ?? [], fetchedAt: 0, fromCache: true, error: errMsg(err) };
        dispatch({ name: 'local/models', payload: { providerKey: providerKeyOf(cfg), discovery: d } });
        return d;
      }
    },

    setView: (v) => set({ view: v }),
    setComposerText: (t, focus) => set((s) => ({ composerText: t, composerFocus: focus ? s.composerFocus + 1 : s.composerFocus })),
    setComposerMentions: (m) => set((s) => ({ composerMentions: m, composerMentionsChat: s.activeChatId })),
    askAbout: async (mentions, opts) => {
      get().openPanel();
      // "Ask AI about …" starts its own chat unless the user turned that off
      // (A-05: it was appended to whatever chat was open); newChat reuses an
      // empty one.
      const cur = get().activeChatId;
      const used = !!cur && ((get().transcripts[cur]?.length ?? 0) > 0 || (get().chats.find((c) => c.id === cur)?.messageCount ?? 0) > 0);
      if (opts?.newChat && (used || !cur)) await get().newChat();
      set((s) => {
        // mentions made for another chat do not move into this one
        const next = s.composerMentionsChat === s.activeChatId || s.composerMentionsChat === null ? [...s.composerMentions] : [];
        for (const m of mentions) {
          if (!next.some((x) => x.dn === m.dn && x.profileId === m.profileId)) next.push(m);
        }
        // "Ask AI about X" is about X: the open tab / tree selection is not attached next to the
        // mention (area A P1: the model answered about the tab). Its chip can be restored.
        const sel = selectedEntry();
        const mentioned = !!sel && next.some((m) => m.profileId === sel.profileId && normalizeDN(m.dn) === normalizeDN(sel.dn));
        return {
          composerMentions: next,
          composerMentionsChat: s.activeChatId,
          composerFocus: s.composerFocus + 1,
          ...(sel && !mentioned && mentions.length ? { selectionDismissed: selectionKey(sel) } : {}),
        };
      });
    },

    startEditLast: () => {
      const chatId = get().activeChatId;
      if (!chatId || runActive(get().runs[chatId])) return false;
      const msgs = get().transcripts[chatId] ?? [];
      const idx = lastUserIndex(msgs);
      if (idx < 0) return false;
      set((s) => ({ editing: { chatId, messageId: msgs[idx].id }, composerText: userText(msgs[idx]), composerFocus: s.composerFocus + 1 }));
      return true;
    },
    cancelEdit: () => set({ editing: null, composerText: '' }),

    addNotice: (chatId, text) =>
      set((s) => ({ notices: { ...s.notices, [chatId]: [...(s.notices[chatId] ?? []), { id: tempId(), at: Date.now(), text }] } })),
    clearNotices: (chatId) => set((s) => {
      const n = { ...s.notices };
      delete n[chatId];
      return { notices: n };
    }),

    openPanel: (chatId, approvalId) => {
      const ui = useUIStore.getState();
      if (ui.aiDock === 'right') {
        if (!ui.aiPaneVisible) ui.toggleAIPane();
      } else {
        ui.setActivity('ai');
        if (!useUIStore.getState().sidebarVisible) useUIStore.getState().toggleSidebar();
      }
      set({ view: 'chat', scrollToApproval: approvalId ?? null });
      if (chatId && chatId !== get().activeChatId) void get().selectChat(chatId);
    },

    setModelPickerOpen: (open) => set({ modelPickerOpen: open }),
    setSettingsDraft: (d) => set({ settingsDraft: d }),
    dismissSelection: (sel) => set({ selectionDismissed: sel ? selectionKey(sel) : null }),
    retryPreflight: async (force) => {
      const r = preflightRetry;
      set({ preflight: null });
      if (!r) return;
      preflightRetry = null;
      await r(force);
    },
    clearPreflight: () => {
      preflightRetry = null;
      set({ preflight: null });
    },
    cancelPreflight: () => {
      if (!get().preflightChecking) return;
      preflightCancelled = preflightSeq;
      stopCheck?.();
      stopCheck = null;
      set({ preflightChecking: null, preflightStopped: get().activeChatId, composerFocus: get().composerFocus + 1 });
      api.CancelProviderCheck().catch(() => { /* the check ends by its own timeout */ });
    },
    setAskNewChat: (v) => {
      try {
        localStorage.setItem(ASK_NEW_CHAT_KEY, String(v));
      } catch { /* per session only */ }
      set({ askNewChat: v });
    },
    refreshEgress: async (chatId) => {
      try {
        const eg = await api.GetChatEgress(chatId);
        dispatch({ name: 'local/egress', payload: { chatId, egress: eg ?? [] } });
      } catch { /* the popover keeps what it has */ }
    },
  };
});

/** Number of approvals waiting for the user (ActivityBar badge, §2.2). */
export function selectPendingApprovalCount(s: AIStore): number {
  return selectPendingFromState(s);
}

/**
 * Starts the store (config, chat list) once; safe to call repeatedly. The
 * promise settles when the first load is done (commands that act on chats
 * await it, so the initial chat list cannot overwrite their result).
 */
let started: Promise<void> | null = null;
export function startAIStore(): Promise<void> {
  if (!started) started = useAIStore.getState().init();
  return started;
}
