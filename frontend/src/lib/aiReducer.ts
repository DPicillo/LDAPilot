/**
 * Pure reducer for the AI chat state (§3.5, §10.1).
 *
 * reduce(state, action) → state, where action is an `ai:*` event as emitted
 * by Go ({name, payload}) or a local action dispatched by stores/aiStore.ts
 * ({name: 'local/…'}). No side effects, no runtime imports (type-only), only
 * erasable TypeScript syntax: tests/ai/reducer.test.mjs runs this file with
 * Node's built-in type stripping.
 *
 * Run rules (§3.5): ai:run_started sets the chat's current run and resets
 * lastSeq; a run event whose seq is ≤ lastSeq, or that belongs to a run this
 * chat has already left behind, is dropped. Events that arrive early — for a
 * run whose ai:run_started has not arrived yet, or after a gap in seq — are
 * held per chat and applied in seq order once the missing event arrives
 * (`wails dev` browser clients can receive events out of order); the store
 * re-syncs with GetRunState when a gap does not close. Events without a run
 * (chat_updated, models_updated, config_updated, grants_updated) bypass
 * these checks.
 */
import type {
  AIEvent,
  ApprovalRequest,
  ChatSummary,
  ChatView,
  CompactionMarker,
  DoneEvent,
  EgressRecord,
  ErrorEvent,
  Grant,
  Message,
  ModelDiscovery,
  RunKind,
  RunSnapshot,
  RunStatus,
  StatusEvent,
  ToolStatus,
  UsageEvent,
  WriteInfo,
} from '../types/ai';

// --- state ------------------------------------------------------------------

export interface LiveBlock {
  type: 'text' | 'thinking';
  text: string;
  startedAt: number;
  /** last delta (thinking duration = updatedAt - startedAt) */
  updatedAt: number;
}

/** An assistant message being streamed (one per step). */
export interface LiveMessage {
  id: string;
  step: number;
  model?: string;
  startedAt: number;
  /** sparse by blockIndex */
  blocks: (LiveBlock | null)[];
}

export interface ToolCardState {
  toolCallId: string;
  messageId: string;
  name: string;
  displayName: string;
  kind: string;
  args: string;
  connectionId: string;
  connectionLabel: string;
  status: ToolStatus;
  warnings: string[];
  startedAt: number;
  durationMs?: number;
  summary?: string;
  result?: string;
  isError?: boolean;
  errorCode?: string;
  dns?: string[];
  write?: WriteInfo;
}

export interface ApprovalState {
  request: ApprovalRequest;
  resolved: { decision: string; by: string; at: number } | null;
  /** RespondApproval answered "already_resolved" */
  lateAnswer?: boolean;
}

export interface RunState {
  chatId: string;
  runId: string;
  kind: RunKind;
  engine: string;
  provider: string;
  model: string;
  startedAt: number;
  userMessageId: string;
  /** last persisted message before the run; null = unknown (reload the whole chat) */
  baseMessageId: string | null;
  lastSeq: number;
  status: RunStatus;
  liveMessages: LiveMessage[];
  toolCards: Record<string, ToolCardState>;
  toolOrder: string[];
  approvals: Record<string, ApprovalState>;
  usage: UsageEvent | null;
  /** last informational status (retrying, model loading, …); cleared by new content */
  status_: StatusEvent | null;
  warnings: string[];
  error: ErrorEvent | null;
  done: DoneEvent | null;
  canContinue: boolean;
  /** the persisted transcript replaced the live messages after ai:done */
  settled: boolean;
}

export interface SecretState {
  chatId: string;
  kind: string;
  dn: string;
  expiresAt: number;
  /** set only after RevealSecret; memory only */
  value?: string;
  revealed: boolean;
}

export interface ChatMeta {
  modelOverride: string;
  compactions: CompactionMarker[];
  egress: EgressRecord[];
  readOnly: boolean;
}

export interface PendingSend {
  tempId: string;
  baseMessageId: string | null;
  kind: RunKind;
}

export interface AIState {
  chats: ChatSummary[];
  transcripts: Record<string, Message[]>;
  chatMeta: Record<string, ChatMeta>;
  runs: Record<string, RunState>;
  pending: Record<string, PendingSend>;
  secrets: Record<string, SecretState>;
  grants: Record<string, Grant[]>;
  /** by providerKey */
  models: Record<string, ModelDiscovery>;
  /** newest revision announced by ai:config_updated */
  remoteConfigRevision: number;
  /** lower-cased DN → where it was seen (dn = as the tool result wrote it) */
  dnRegistry: Record<string, { profileId: string; messageId: string; dn: string }>;
  /** run events that arrived before their predecessor, per chat */
  held: Record<string, AIEvent[]>;
  /** runs a chat has left behind (late events of them are dropped), per chat */
  retired: Record<string, string[]>;
}

export function initialState(): AIState {
  return {
    chats: [],
    transcripts: {},
    chatMeta: {},
    runs: {},
    pending: {},
    secrets: {},
    grants: {},
    models: {},
    remoteConfigRevision: 0,
    dnRegistry: {},
    held: {},
    retired: {},
  };
}

// --- local actions ------------------------------------------------------------

export type LocalAction =
  | { name: 'local/chats'; payload: { chats: ChatSummary[] } }
  | { name: 'local/chat_loaded'; payload: { view: ChatView } }
  | { name: 'local/chat_deleted'; payload: { chatId: string } }
  /** optimistic user message before SendMessage/EditLast/Continue returns */
  | { name: 'local/pending_send'; payload: { chatId: string; tempId: string; kind: RunKind; text: string; now: number; baseMessageId: string | null; truncateAfter?: string | null } }
  | { name: 'local/send_result'; payload: { chatId: string; tempId: string; runId: string; userMessageId: string } }
  | { name: 'local/send_failed'; payload: { chatId: string; tempId: string } }
  /** messages persisted after baseMessageId, fetched after ai:done */
  | { name: 'local/tail'; payload: { chatId: string; runId: string; baseMessageId: string | null; messages: Message[] } }
  | { name: 'local/snapshot'; payload: { snapshot: RunSnapshot; now: number } }
  | { name: 'local/approval_answered'; payload: { approvalId: string; status: string; decision: string; by: string; now: number } }
  | { name: 'local/secret_revealed'; payload: { toolCallId: string; value: string; expiresAt: number } }
  | { name: 'local/secret_gone'; payload: { toolCallId: string } }
  | { name: 'local/expire_secrets'; payload: { now: number } }
  | { name: 'local/grants'; payload: { chatId: string; grants: Grant[] } }
  | { name: 'local/models'; payload: { providerKey: string; discovery: ModelDiscovery } }
  | { name: 'local/chat_model'; payload: { chatId: string; model: string } }
  /** the chat's "directory data sent" ledger (GetChatEgress, live during a run) */
  | { name: 'local/egress'; payload: { chatId: string; egress: EgressRecord[] } }
  /** the gap did not close: apply what can be applied, drop the rest */
  | { name: 'local/flush_held'; payload: { chatId: string } }
  /** GetRunState found no run although the chat still shows one */
  | { name: 'local/run_gone'; payload: { chatId: string; now: number } };

export type Action = AIEvent | LocalAction;

// --- helpers --------------------------------------------------------------------

/** Lower-cased DN key (kept local: this file has no runtime imports). */
export function regKey(dn: string): string {
  return dn.replace(/\u2060/g, '').split(/(?<!\\),/).map((r) => r.trim().toLowerCase()).join(',');
}

function patchRun(state: AIState, chatId: string, fn: (r: RunState) => RunState): AIState {
  const r = state.runs[chatId];
  if (!r) return state;
  return { ...state, runs: { ...state.runs, [chatId]: fn(r) } };
}

function setChatSummary(chats: ChatSummary[], id: string, patch: Partial<ChatSummary>): ChatSummary[] {
  let found = false;
  const out = chats.map((c) => {
    if (c.id !== id) return c;
    found = true;
    return { ...c, ...patch };
  });
  return found ? out : chats;
}

function sortChats(chats: ChatSummary[]): ChatSummary[] {
  return [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Registers the DNs of persisted tool results (connection from the tool_result meta, else the tool_use meta). */
function registerDNs(reg: AIState['dnRegistry'], messages: Message[]): AIState['dnRegistry'] {
  const conn: Record<string, string> = {};
  let out = reg;
  for (const m of messages) {
    for (const b of m.blocks ?? []) {
      if (b.type === 'tool_use' && b.id && b.meta?.connectionId) conn[b.id] = b.meta.connectionId;
      if (b.type === 'tool_result' && b.toolUseId && b.meta?.dns?.length) {
        const pid = b.meta.connectionId || conn[b.toolUseId];
        if (!pid) continue;
        if (out === reg) out = { ...reg };
        for (const dn of b.meta.dns) out[regKey(dn)] = { profileId: pid, messageId: m.id, dn };
      }
    }
  }
  return out;
}

/**
 * Replaces the transcript after baseMessageId with tail. When the base is
 * unknown or the server answered with the whole chat (base not found), tail
 * replaces everything.
 */
export function mergeTail(old: Message[], baseMessageId: string | null, tail: Message[]): Message[] {
  if (baseMessageId === null || baseMessageId === '') return tail;
  const idx = old.findIndex((m) => m.id === baseMessageId);
  if (idx < 0) return tail;
  const prefix = old.slice(0, idx + 1);
  const ids = new Set(prefix.map((m) => m.id));
  if (tail.some((m) => ids.has(m.id))) return tail;
  return [...prefix, ...tail];
}

const RUN_EVENTS = new Set([
  'ai:run_started', 'ai:message_started', 'ai:text_delta', 'ai:thinking_delta', 'ai:text_replaced',
  'ai:step_discarded', 'ai:tool_start', 'ai:tool_update', 'ai:tool_end', 'ai:approval_request',
  'ai:approval_resolved', 'ai:secret_available', 'ai:usage', 'ai:status', 'ai:error', 'ai:done',
]);

export function isRunEvent(name: string): boolean {
  return RUN_EVENTS.has(name);
}

/** True while the run has not sent ai:done. */
export function runActive(r: RunState | undefined | null): boolean {
  return !!r && !r.done;
}

/** Pending (unresolved) approvals of active runs, oldest first. */
export function pendingApprovals(state: AIState, chatId?: string): ApprovalState[] {
  const out: ApprovalState[] = [];
  for (const r of Object.values(state.runs)) {
    if (chatId && r.chatId !== chatId) continue;
    if (!runActive(r)) continue;
    for (const a of Object.values(r.approvals)) if (!a.resolved) out.push(a);
  }
  return out.sort((a, b) => a.request.seq - b.request.seq);
}

export function selectPendingApprovalCount(state: AIState): number {
  return pendingApprovals(state).length;
}

function newRun(p: { chatId: string; runId: string; kind: RunKind; engine: string; provider: string; model: string; startedAt: number; userMessageId: string; baseMessageId: string | null; lastSeq: number; status: RunStatus }): RunState {
  return {
    ...p,
    liveMessages: [],
    toolCards: {},
    toolOrder: [],
    approvals: {},
    usage: null,
    status_: null,
    warnings: [],
    error: null,
    done: null,
    canContinue: false,
    settled: false,
  };
}

function withDelta(r: RunState, messageId: string, blockIndex: number, type: 'text' | 'thinking', text: string, ts: number, replace: boolean): RunState {
  let msgs = r.liveMessages;
  let idx = msgs.findIndex((m) => m.id === messageId);
  if (idx < 0) {
    // A delta for a message we have not seen (e.g. after a re-sync): start it.
    msgs = [...msgs, { id: messageId, step: msgs.length + 1, startedAt: ts, blocks: [] }];
    idx = msgs.length - 1;
  }
  const m = msgs[idx];
  const blocks = m.blocks.slice();
  while (blocks.length <= blockIndex) blocks.push(null);
  const prev = blocks[blockIndex];
  if (prev && prev.type === type) {
    blocks[blockIndex] = { ...prev, text: replace ? text : prev.text + text, updatedAt: ts };
  } else {
    blocks[blockIndex] = { type, text, startedAt: ts, updatedAt: ts };
  }
  const next = msgs.slice();
  next[idx] = { ...m, blocks };
  return { ...r, liveMessages: next, status_: r.status_ && r.status_.kind === 'finishing_write' ? r.status_ : null };
}

// --- reducer --------------------------------------------------------------------

const MAX_HELD = 500;

/** reduce plus the events it applied, in order (for side effects): run events plus ai:chat_updated and ai:config_updated. */
export function reduceApplied(state: AIState, action: Action): { state: AIState; applied: AIEvent[] } {
  const applied: AIEvent[] = [];
  const next = reduceOne(state, action, applied);
  if (next === state) return { state: next, applied };
  let chatId: string | undefined;
  if (action.name.startsWith('ai:')) chatId = (action.payload as { chatId?: string }).chatId;
  else if (action.name === 'local/snapshot') chatId = action.payload.snapshot.chatId;
  return { state: chatId ? drain(next, chatId, applied) : next, applied };
}

export function reduce(state: AIState, action: Action): AIState {
  const r = reduceApplied(state, action);
  return r.state;
}

/** Number of held (early) events of a chat. */
export function heldCount(state: AIState, chatId: string): number {
  return state.held[chatId]?.length ?? 0;
}

function hold(state: AIState, chatId: string, ev: AIEvent): AIState {
  const list = [...(state.held[chatId] ?? []), ev];
  return { ...state, held: { ...state.held, [chatId]: list.length > MAX_HELD ? list.slice(list.length - MAX_HELD) : list } };
}

/** Applies held events of the chat's current run that are next in seq. */
function drain(state: AIState, chatId: string, applied: AIEvent[]): AIState {
  let s = state;
  for (;;) {
    const list = s.held[chatId];
    const r = s.runs[chatId];
    if (!list?.length || !r) return s;
    const seqOf = (e: AIEvent) => (e.payload as { seq: number }).seq;
    const runOf = (e: AIEvent) => (e.payload as { runId: string }).runId;
    const retired = s.retired[chatId] ?? [];
    // Drop what can never apply: stale seqs of this run, events of left runs.
    const keep = list.filter((e) => !(runOf(e) === r.runId && seqOf(e) <= r.lastSeq) && !retired.includes(runOf(e)));
    const nextIdx = keep.findIndex((e) => runOf(e) === r.runId && seqOf(e) === r.lastSeq + 1);
    if (nextIdx < 0) {
      return keep.length === list.length ? s : { ...s, held: { ...s.held, [chatId]: keep } };
    }
    const ev = keep[nextIdx];
    s = { ...s, held: { ...s.held, [chatId]: keep.filter((_, i) => i !== nextIdx) } };
    s = reduceOne(s, ev, applied);
  }
}

function reduceOne(state: AIState, action: Action, applied: AIEvent[]): AIState {
  switch (action.name) {
    // ---- events without a run ----
    case 'ai:chat_updated': {
      const e = action.payload;
      // Side effect: an unknown chat (created elsewhere) reloads the list.
      applied.push(action);
      const patch: Partial<ChatSummary> = { updatedAt: e.updatedAt };
      if (e.title) patch.title = e.title;
      if (e.pendingWrite !== undefined) patch.pendingWrite = e.pendingWrite;
      return { ...state, chats: sortChats(setChatSummary(state.chats, e.chatId, patch)) };
    }
    case 'ai:models_updated': {
      const e = action.payload;
      return { ...state, models: { ...state.models, [e.providerKey]: e.discovery } };
    }
    case 'ai:config_updated':
      // Side effect: the store reloads a config older than this revision
      // (test-1 D3: without it the config stayed stale until Reload).
      applied.push(action);
      return action.payload.revision > state.remoteConfigRevision ? { ...state, remoteConfigRevision: action.payload.revision } : state;
    case 'ai:grants_updated':
      return { ...state, grants: { ...state.grants, [action.payload.chatId]: action.payload.grants ?? [] } };

    // ---- run events ----
    case 'ai:run_started': {
      const e = action.payload;
      const cur = state.runs[e.chatId];
      if (cur && cur.runId === e.runId && e.seq <= cur.lastSeq) return state;
      if ((state.retired[e.chatId] ?? []).includes(e.runId)) return state;
      applied.push(action);
      const pend = state.pending[e.chatId];
      const run = newRun({
        chatId: e.chatId, runId: e.runId, kind: e.kind, engine: e.engine, provider: e.provider, model: e.model,
        startedAt: e.startedAt, userMessageId: e.userMessageId,
        baseMessageId: pend ? pend.baseMessageId : null, lastSeq: e.seq, status: 'running',
      });
      const chats = setChatSummary(state.chats, e.chatId, { running: true });
      const retired = cur && cur.runId !== e.runId ? { ...state.retired, [e.chatId]: [...(state.retired[e.chatId] ?? []), cur.runId].slice(-20) } : state.retired;
      return { ...state, chats, retired, runs: { ...state.runs, [e.chatId]: run } };
    }
    default:
      break;
  }

  if (action.name.startsWith('ai:')) {
    const ev = action as AIEvent;
    const p = ev.payload as { chatId: string; runId: string; seq: number; ts: number };
    const r = state.runs[p.chatId];
    if ((state.retired[p.chatId] ?? []).includes(p.runId)) return state;
    // Early: the run's ai:run_started (or an earlier event) is still on its way.
    if (!r || r.runId !== p.runId) return hold(state, p.chatId, ev);
    if (p.seq <= r.lastSeq) return state;
    if (p.seq > r.lastSeq + 1) return hold(state, p.chatId, ev);
    applied.push(ev);
    const s = patchRun(state, p.chatId, (run) => ({ ...run, lastSeq: p.seq }));
    return reduceRunEvent(s, ev, p.ts);
  }
  return reduceLocal(state, action as LocalAction);
}

function reduceRunEvent(state: AIState, ev: AIEvent, ts: number): AIState {
  switch (ev.name) {
    case 'ai:message_started': {
      const e = ev.payload;
      return patchRun(state, e.chatId, (r) => (r.liveMessages.some((m) => m.id === e.messageId)
        ? r
        : { ...r, liveMessages: [...r.liveMessages, { id: e.messageId, step: e.step, model: e.model, startedAt: e.ts, blocks: [] }] }));
    }
    case 'ai:text_delta':
    case 'ai:thinking_delta':
    case 'ai:text_replaced': {
      const e = ev.payload;
      const type = ev.name === 'ai:thinking_delta' ? 'thinking' : 'text';
      return patchRun(state, e.chatId, (r) => withDelta(r, e.messageId, e.blockIndex, type, e.text, ts, ev.name === 'ai:text_replaced'));
    }
    case 'ai:step_discarded': {
      const e = ev.payload;
      return patchRun(state, e.chatId, (r) => ({ ...r, liveMessages: r.liveMessages.filter((m) => m.id !== e.messageId) }));
    }
    case 'ai:tool_start': {
      const e = ev.payload;
      return patchRun(state, e.chatId, (r) => {
        const prev = r.toolCards[e.toolCallId];
        const card: ToolCardState = {
          toolCallId: e.toolCallId, messageId: e.messageId, name: e.name, displayName: e.displayName, kind: e.kind,
          args: e.args, connectionId: e.connectionId, connectionLabel: e.connectionLabel, status: e.status,
          warnings: e.warnings ?? [], startedAt: prev?.startedAt ?? ts,
        };
        return {
          ...r,
          toolCards: { ...r.toolCards, [e.toolCallId]: card },
          toolOrder: r.toolOrder.includes(e.toolCallId) ? r.toolOrder : [...r.toolOrder, e.toolCallId],
          status: r.status === 'queued' ? 'running' : r.status,
        };
      });
    }
    case 'ai:tool_update': {
      const e = ev.payload;
      return patchRun(state, e.chatId, (r) => {
        const c = r.toolCards[e.toolCallId];
        if (!c) return r;
        const status: RunStatus = e.status === 'awaiting_approval' ? 'awaiting_approval' : r.status === 'awaiting_approval' ? 'running' : r.status;
        return { ...r, status, toolCards: { ...r.toolCards, [e.toolCallId]: { ...c, status: e.status } } };
      });
    }
    case 'ai:tool_end': {
      const e = ev.payload;
      let next = patchRun(state, e.chatId, (r) => {
        const c = r.toolCards[e.toolCallId];
        if (!c) return r;
        const card: ToolCardState = {
          ...c, status: e.status, durationMs: e.durationMs, summary: e.summary, result: e.result, isError: e.isError,
          errorCode: e.errorCode, warnings: e.warnings ?? c.warnings, dns: e.dns ?? [], write: e.write,
        };
        const stillWaiting = Object.values(r.approvals).some((a) => !a.resolved && a.request.toolCallId !== e.toolCallId);
        return {
          ...r,
          status: r.status === 'awaiting_approval' && !stillWaiting ? 'running' : r.status,
          toolCards: { ...r.toolCards, [e.toolCallId]: card },
        };
      });
      const card = next.runs[e.chatId]?.toolCards[e.toolCallId];
      if (card && card.connectionId && e.dns && e.dns.length) {
        const reg = { ...next.dnRegistry };
        for (const dn of e.dns) reg[regKey(dn)] = { profileId: card.connectionId, messageId: card.messageId, dn };
        next = { ...next, dnRegistry: reg };
      }
      return next;
    }
    case 'ai:approval_request': {
      const e = ev.payload;
      return patchRun(state, e.chatId, (r) => ({
        ...r,
        status: 'awaiting_approval',
        approvals: { ...r.approvals, [e.approvalId]: { request: e, resolved: r.approvals[e.approvalId]?.resolved ?? null } },
      }));
    }
    case 'ai:approval_resolved': {
      const e = ev.payload;
      return patchRun(state, e.chatId, (r) => {
        const a = r.approvals[e.approvalId];
        if (!a) return r;
        const approvals = { ...r.approvals, [e.approvalId]: { ...a, resolved: { decision: e.decision, by: e.by, at: ts } } };
        const waiting = Object.values(approvals).some((x) => !x.resolved);
        return { ...r, approvals, status: !waiting && r.status === 'awaiting_approval' ? 'running' : r.status };
      });
    }
    case 'ai:secret_available': {
      const e = ev.payload;
      return {
        ...state,
        secrets: { ...state.secrets, [e.toolCallId]: { chatId: e.chatId, kind: e.kind, dn: e.dn, expiresAt: e.expiresAt, revealed: false } },
      };
    }
    case 'ai:usage': {
      const e = ev.payload;
      return patchRun(state, e.chatId, (r) => ({ ...r, usage: e }));
    }
    case 'ai:status': {
      const e = ev.payload;
      return patchRun(state, e.chatId, (r) => ({
        ...r,
        status_: e.kind === 'warning' ? r.status_ : e,
        warnings: e.kind === 'warning' && e.message && !r.warnings.includes(e.message) ? [...r.warnings, e.message] : r.warnings,
      }));
    }
    case 'ai:error': {
      const e = ev.payload;
      return patchRun(state, e.chatId, (r) => ({ ...r, error: e }));
    }
    case 'ai:done': {
      const e = ev.payload;
      const next = patchRun(state, e.chatId, (r) => {
        const approvals: Record<string, ApprovalState> = {};
        for (const [k, a] of Object.entries(r.approvals)) {
          approvals[k] = a.resolved ? a : { ...a, resolved: { decision: 'cancelled', by: 'run', at: ts } };
        }
        return { ...r, done: e, status: e.status, canContinue: e.canContinue, approvals, status_: null };
      });
      const pending = { ...next.pending };
      delete pending[e.chatId];
      return { ...next, pending, chats: setChatSummary(next.chats, e.chatId, { running: false }) };
    }
    default:
      return state;
  }
}

function reduceLocal(state: AIState, a: LocalAction): AIState {
  switch (a.name) {
    case 'local/chats': {
      // Keep the live "running" flag of chats with an active run.
      const chats = a.payload.chats.map((c) => (runActive(state.runs[c.id]) ? { ...c, running: true } : c));
      return { ...state, chats: sortChats(chats) };
    }
    case 'local/chat_loaded': {
      const v = a.payload.view;
      const { messages, modelOverride, compactions, egress, readOnly, ...summary } = v;
      const exists = state.chats.some((c) => c.id === v.id);
      const live = runActive(state.runs[v.id]);
      const sum: ChatSummary = { ...summary, running: summary.running || live };
      return {
        ...state,
        chats: sortChats(exists ? setChatSummary(state.chats, v.id, sum) : [...state.chats, sum]),
        transcripts: { ...state.transcripts, [v.id]: messages ?? [] },
        chatMeta: { ...state.chatMeta, [v.id]: { modelOverride, compactions: compactions ?? [], egress: egress ?? [], readOnly } },
        dnRegistry: registerDNs(state.dnRegistry, messages ?? []),
      };
    }
    case 'local/chat_deleted': {
      const id = a.payload.chatId;
      const transcripts = { ...state.transcripts };
      delete transcripts[id];
      const chatMeta = { ...state.chatMeta };
      delete chatMeta[id];
      const runs = { ...state.runs };
      delete runs[id];
      const pending = { ...state.pending };
      delete pending[id];
      const grants = { ...state.grants };
      delete grants[id];
      const secrets: Record<string, SecretState> = {};
      for (const [k, s] of Object.entries(state.secrets)) if (s.chatId !== id) secrets[k] = s;
      return { ...state, chats: state.chats.filter((c) => c.id !== id), transcripts, chatMeta, runs, pending, grants, secrets };
    }
    case 'local/pending_send': {
      const p = a.payload;
      let msgs = state.transcripts[p.chatId] ?? [];
      if (p.truncateAfter !== undefined) {
        // regenerate / edit: drop the last turn locally (the server does the same)
        const idx = p.truncateAfter === null ? -1 : msgs.findIndex((m) => m.id === p.truncateAfter);
        msgs = idx < 0 && p.truncateAfter !== null ? msgs : msgs.slice(0, idx + 1);
      }
      if (p.text) {
        const temp: Message = {
          id: p.tempId, role: 'user', createdAt: p.now,
          blocks: [p.kind === 'continue' ? { type: 'text', text: p.text, meta: { kind: 'continue' } } : { type: 'text', text: p.text }],
        };
        msgs = [...msgs, temp];
      }
      return {
        ...state,
        transcripts: { ...state.transcripts, [p.chatId]: msgs },
        pending: { ...state.pending, [p.chatId]: { tempId: p.tempId, baseMessageId: p.baseMessageId, kind: p.kind } },
      };
    }
    case 'local/send_result': {
      const p = a.payload;
      const msgs = (state.transcripts[p.chatId] ?? []).map((m) => (m.id === p.tempId ? { ...m, id: p.userMessageId, runId: p.runId } : m));
      let runs = state.runs;
      const r = runs[p.chatId];
      // ai:run_started may have arrived before the binding returned.
      if (r && r.runId === p.runId && r.baseMessageId === null && state.pending[p.chatId]) {
        runs = { ...runs, [p.chatId]: { ...r, baseMessageId: state.pending[p.chatId].baseMessageId } };
      }
      return { ...state, runs, transcripts: { ...state.transcripts, [p.chatId]: msgs } };
    }
    case 'local/send_failed': {
      const p = a.payload;
      const pending = { ...state.pending };
      delete pending[p.chatId];
      return {
        ...state,
        pending,
        transcripts: { ...state.transcripts, [p.chatId]: (state.transcripts[p.chatId] ?? []).filter((m) => m.id !== p.tempId) },
      };
    }
    case 'local/tail': {
      const p = a.payload;
      const merged = mergeTail(state.transcripts[p.chatId] ?? [], p.baseMessageId, p.messages);
      const next: AIState = {
        ...state,
        transcripts: { ...state.transcripts, [p.chatId]: merged },
        dnRegistry: registerDNs(state.dnRegistry, p.messages),
      };
      return patchRun(next, p.chatId, (r) => (r.runId === p.runId && r.done ? { ...r, liveMessages: [], settled: true } : r));
    }
    case 'local/snapshot': {
      const s = a.payload.snapshot;
      const cur = state.runs[s.chatId];
      if (cur && cur.runId === s.runId && cur.lastSeq >= s.lastSeq) return state;
      const run = newRun({
        chatId: s.chatId, runId: s.runId, kind: s.kind, engine: '', provider: '', model: '', startedAt: s.startedAt,
        userMessageId: s.messages?.[0]?.id ?? '', baseMessageId: s.baseMessageId, lastSeq: s.lastSeq, status: s.status,
      });
      // Tool cards for calls whose message is persisted come from the
      // transcript; their live status comes from toolStatus.
      const resultMeta: Record<string, { connectionId?: string; connectionLabel?: string }> = {};
      for (const m of s.messages ?? []) for (const b of m.blocks ?? []) if (b.type === 'tool_result' && b.toolUseId && b.meta) resultMeta[b.toolUseId] = b.meta;
      for (const m of s.messages ?? []) {
        for (const b of m.blocks ?? []) {
          if (b.type !== 'tool_use' || !b.id) continue;
          const st = s.toolStatus?.[b.id];
          if (!st) continue;
          run.toolCards[b.id] = {
            toolCallId: b.id, messageId: m.id, name: b.name ?? '', displayName: b.name ?? '', kind: b.meta?.kind ?? 'read',
            args: JSON.stringify(b.input ?? {}), connectionId: b.meta?.connectionId || resultMeta[b.id]?.connectionId || '',
            connectionLabel: b.meta?.connectionLabel || resultMeta[b.id]?.connectionLabel || '',
            status: st, warnings: b.meta?.warnings ?? [], startedAt: a.payload.now,
          };
          run.toolOrder.push(b.id);
        }
      }
      if (s.partial) {
        const blocks: (LiveBlock | null)[] = (s.partial.blocks ?? []).map((b) => {
          if (b.type === 'text') return { type: 'text', text: b.text ?? '', startedAt: a.payload.now, updatedAt: a.payload.now };
          if (b.type === 'thinking') return { type: 'thinking', text: b.thinking ?? '', startedAt: a.payload.now, updatedAt: a.payload.now };
          return null;
        });
        run.liveMessages = [{ id: s.partial.id, step: 0, model: s.partial.model, startedAt: s.partial.createdAt || a.payload.now, blocks }];
      }
      for (const req of s.pendingApprovals ?? []) run.approvals[req.approvalId] = { request: req, resolved: null };
      run.usage = s.usage;
      const merged = mergeTail(state.transcripts[s.chatId] ?? [], s.baseMessageId, s.messages ?? []);
      const retired = cur && cur.runId !== s.runId ? { ...state.retired, [s.chatId]: [...(state.retired[s.chatId] ?? []), cur.runId].slice(-20) } : state.retired;
      return {
        ...state,
        retired,
        runs: { ...state.runs, [s.chatId]: run },
        transcripts: { ...state.transcripts, [s.chatId]: merged },
        chats: setChatSummary(state.chats, s.chatId, { running: true }),
        dnRegistry: registerDNs(state.dnRegistry, s.messages ?? []),
      };
    }
    case 'local/flush_held': {
      // Apply the held events of the current run in seq order, skipping the
      // gap; everything else is dropped.
      const id = a.payload.chatId;
      const list = state.held[id] ?? [];
      const r = state.runs[id];
      let s: AIState = { ...state, held: { ...state.held, [id]: [] } };
      if (!r) return s;
      const own = list.filter((e) => (e.payload as { runId: string }).runId === r.runId).sort((x, y) => (x.payload as { seq: number }).seq - (y.payload as { seq: number }).seq);
      for (const ev of own) {
        const p = ev.payload as { chatId: string; seq: number; ts: number };
        const cur = s.runs[id];
        if (!cur || p.seq <= cur.lastSeq) continue;
        s = patchRun(s, id, (run) => ({ ...run, lastSeq: p.seq }));
        s = reduceRunEvent(s, ev, p.ts);
      }
      return s;
    }
    case 'local/run_gone': {
      const id = a.payload.chatId;
      const r = state.runs[id];
      if (!r || r.done) return { ...state, held: { ...state.held, [id]: [] } };
      const done: DoneEvent = {
        chatId: id, runId: r.runId, seq: r.lastSeq + 1, ts: a.payload.now, status: 'completed', finalMessageId: '', durationMs: 0,
        totals: r.usage?.totals ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, canContinue: false, contextEdited: true,
      } as DoneEvent;
      const next = reduceRunEvent({ ...state, held: { ...state.held, [id]: [] } }, { name: 'ai:done', payload: done } as AIEvent, a.payload.now);
      return patchRun(next, id, (run) => ({ ...run, baseMessageId: null }));
    }
    case 'local/approval_answered': {
      const p = a.payload;
      for (const r of Object.values(state.runs)) {
        const ap = r.approvals[p.approvalId];
        if (!ap) continue;
        return patchRun(state, r.chatId, (run) => ({
          ...run,
          approvals: {
            ...run.approvals,
            [p.approvalId]: {
              ...ap,
              resolved: ap.resolved ?? { decision: p.decision, by: p.by || 'user', at: p.now },
              lateAnswer: p.status === 'already_resolved',
            },
          },
        }));
      }
      return state;
    }
    case 'local/secret_revealed': {
      const s = state.secrets[a.payload.toolCallId];
      if (!s) return state;
      return { ...state, secrets: { ...state.secrets, [a.payload.toolCallId]: { ...s, value: a.payload.value, revealed: true, expiresAt: Math.min(s.expiresAt, a.payload.expiresAt || s.expiresAt) } } };
    }
    case 'local/secret_gone': {
      const s = state.secrets[a.payload.toolCallId];
      if (!s) return state;
      return { ...state, secrets: { ...state.secrets, [a.payload.toolCallId]: { ...s, value: undefined, revealed: true, expiresAt: 0 } } };
    }
    case 'local/expire_secrets': {
      let changed = false;
      const secrets: Record<string, SecretState> = {};
      for (const [k, s] of Object.entries(state.secrets)) {
        if (s.value !== undefined && s.expiresAt <= a.payload.now) {
          secrets[k] = { ...s, value: undefined };
          changed = true;
        } else {
          secrets[k] = s;
        }
      }
      return changed ? { ...state, secrets } : state;
    }
    case 'local/grants':
      return { ...state, grants: { ...state.grants, [a.payload.chatId]: a.payload.grants } };
    case 'local/models':
      return { ...state, models: { ...state.models, [a.payload.providerKey]: a.payload.discovery } };
    case 'local/egress': {
      const meta = state.chatMeta[a.payload.chatId];
      if (!meta) return state;
      return { ...state, chatMeta: { ...state.chatMeta, [a.payload.chatId]: { ...meta, egress: a.payload.egress ?? [] } } };
    }
    case 'local/chat_model': {
      const m = state.chatMeta[a.payload.chatId];
      if (!m) return state;
      return { ...state, chatMeta: { ...state.chatMeta, [a.payload.chatId]: { ...m, modelOverride: a.payload.model } } };
    }
    default:
      return state;
  }
}
