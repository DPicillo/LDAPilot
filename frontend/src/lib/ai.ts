/**
 * AI bindings (Go: services.AIService) and the `ai:*` event subscription.
 *
 * Events are subscribed once, at module load, through window.runtime.EventsOn
 * and forwarded to the handler the AI store registers. Components never
 * subscribe: runs must survive panel unmounts (audit 2.20). Events that arrive
 * before a handler is registered are queued.
 */
import { getBinding } from './wails';
import { parseFacadeError } from './aiFormat';
import { toast } from '../components/ui/Toast';
import type {
  AIConfig,
  AIEvent,
  AIEventName,
  ApprovalResult,
  ChatSummary,
  ChatView,
  ContextInfo,
  EgressRecord,
  Grant,
  Message,
  ModelDiscovery,
  ProviderTestResult,
  RunSnapshot,
  SecretValue,
  SendRequest,
  SendResult,
  UIContext,
} from '../types/ai';

/** Error from the AI facade ("<code>: <message>" on the Go side). */
export class AIError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AIError';
    this.code = code;
  }
}

function svc(): any {
  return getBinding('AIService');
}

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const s = svc();
  if (!s || typeof s[method] !== 'function') {
    throw new AIError('unavailable', 'The AI service is not available (LDAPilot backend not running).');
  }
  try {
    return (await s[method](...args)) as T;
  } catch (err) {
    const e = parseFacadeError(err);
    throw new AIError(e.code, e.message);
  }
}

export function aiAvailable(): boolean {
  return !!svc();
}

// --- configuration ----------------------------------------------------------

export const GetAIConfig = () => call<AIConfig>('GetAIConfig');
export const SaveAIConfig = (cfg: AIConfig) => call<void>('SaveAIConfig', cfg);
export const SetConnectionAccess = (profileId: string, level: string) => call<void>('SetConnectionAccess', profileId, level);
export const TestProvider = (cfg: AIConfig) => call<ProviderTestResult>('TestProvider', cfg);
export const DiscoverModels = (cfg: AIConfig, refresh: boolean) => call<ModelDiscovery>('DiscoverModels', cfg, refresh);
/** the check before a run: rejects (code provider_unreachable / timeout) only when the endpoint did not answer */
export const CheckProvider = (cfg: AIConfig) => call<ModelDiscovery>('CheckProvider', cfg);
/** stops a running CheckProvider (Stop / Esc in the composer); it then rejects with code cancelled (UX P4) */
export const CancelProviderCheck = () => call<void>('CancelProviderCheck');
export const GetBuiltinRedactions = () => call<string[] | null>('GetBuiltinRedactions');

// --- chats ------------------------------------------------------------------

export const ListChats = () => call<ChatSummary[] | null>('ListChats');
export const GetChat = (id: string) => call<ChatView>('GetChat', id);
export const GetMessages = (chatId: string, sinceMessageId: string) => call<Message[] | null>('GetMessages', chatId, sinceMessageId);
export const CreateChat = (title: string) => call<ChatSummary>('CreateChat', title);
export const DeleteChat = (id: string) => call<void>('DeleteChat', id);
/** hides the chat for the Undo time; LDAPilot deletes it if it quits first (A-07) */
export const DeleteChatLater = (id: string) => call<void>('DeleteChatLater', id);
/** undoes DeleteChatLater; code not_found = already deleted */
export const RestoreChat = (id: string) => call<void>('RestoreChat', id);
export const RenameChat = (id: string, title: string) => call<void>('RenameChat', id, title);
export const SetChatModel = (id: string, model: string) => call<void>('SetChatModel', id, model);
export const ExportChatMarkdown = (id: string) => call<string>('ExportChatMarkdown', id);
export const GetGrants = (chatId: string) => call<Grant[] | null>('GetGrants', chatId);
/** "Directory data sent in this chat", live while a response runs. */
export const GetChatEgress = (chatId: string) => call<EgressRecord[] | null>('GetChatEgress', chatId);
export const RevokeGrant = (chatId: string, grantId: string) => call<void>('RevokeGrant', chatId, grantId);

// --- runs -------------------------------------------------------------------

export const SendMessage = (req: SendRequest) => call<SendResult>('SendMessage', req);
export const ContinueRun = (chatId: string, ui: UIContext) => call<SendResult>('ContinueRun', chatId, ui);
export const RegenerateLast = (chatId: string, ui: UIContext) => call<SendResult>('RegenerateLast', chatId, ui);
export const EditLastUserMessage = (chatId: string, text: string, ui: UIContext) => call<SendResult>('EditLastUserMessage', chatId, text, ui);
export const CompactChat = (chatId: string) => call<SendResult>('CompactChat', chatId);
export const StopRun = (chatId: string) => call<void>('StopRun', chatId);
export const RespondApproval = (approvalId: string, decision: string, note: string) => call<ApprovalResult>('RespondApproval', approvalId, decision, note);
export const RevealSecret = (toolCallId: string) => call<SecretValue>('RevealSecret', toolCallId);
export const GetRunState = (chatId: string) => call<RunSnapshot | null>('GetRunState', chatId);
export const GetContextInfo = (chatId: string) => call<ContextInfo>('GetContextInfo', chatId);

// --- runtime helpers --------------------------------------------------------

/** Opens an http(s) URL in the system browser (never inside the app). */
export function openExternal(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  const rt = (window as any).runtime;
  if (rt?.BrowserOpenURL) {
    rt.BrowserOpenURL(url);
    return true;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

/**
 * Copies text to the clipboard (the Wails runtime when the web clipboard is
 * refused). With `what` ("Message", "DN", …) the result is confirmed by a
 * short toast, a failure always by an error toast: a check mark alone on a
 * hover-only button went unnoticed ("Copy message gives no feedback", UX
 * area A, S4).
 */
export async function copyText(text: string, what?: string): Promise<boolean> {
  let ok = false;
  let reason = '';
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
    const rt = (window as any).runtime;
    if (typeof rt?.ClipboardSetText === 'function') {
      try {
        ok = (await rt.ClipboardSetText(text)) !== false;
      } catch { /* keep the first reason */ }
    }
  }
  if (ok && what) toast.success(`${what} copied`, { connection: '', history: false });
  if (!ok) toast.error(what ? `Could not copy the ${what.toLowerCase()}` : 'Could not copy to the clipboard', reason || undefined, { connection: '' });
  return ok;
}

// --- events -----------------------------------------------------------------

export const AI_EVENT_NAMES = [
  'ai:run_started', 'ai:message_started', 'ai:text_delta', 'ai:thinking_delta', 'ai:text_replaced',
  'ai:step_discarded', 'ai:tool_start', 'ai:tool_update', 'ai:tool_end', 'ai:approval_request',
  'ai:approval_resolved', 'ai:secret_available', 'ai:usage', 'ai:status', 'ai:error', 'ai:done',
  'ai:chat_updated', 'ai:models_updated', 'ai:config_updated', 'ai:grants_updated',
] as const satisfies readonly AIEventName[];

// Compile-time check: every event of the contract is subscribed.
type MissingSubscriptions = Exclude<AIEventName, (typeof AI_EVENT_NAMES)[number]>;
export const _allEventsSubscribed: [MissingSubscriptions] extends [never] ? true : MissingSubscriptions = true;

type Handler = (ev: AIEvent) => void;

let handler: Handler | null = null;
const queue: AIEvent[] = [];
let installed = false;
let attempts = 0;

/** Registers the single event consumer (the AI store) and flushes queued events. */
export function setAIEventHandler(h: Handler): void {
  handler = h;
  while (queue.length) {
    const ev = queue.shift()!;
    try {
      h(ev);
    } catch (err) {
      console.error('[ai] event handler failed', ev.name, err);
    }
  }
}

function dispatch(ev: AIEvent) {
  if (!handler) {
    if (queue.length < 5000) queue.push(ev);
    return;
  }
  try {
    handler(ev);
  } catch (err) {
    console.error('[ai] event handler failed', ev.name, err);
  }
}

/** Installs the Wails listeners once (retries briefly until window.runtime exists). */
export function initAIEvents(): void {
  if (installed) return;
  const rt = (window as any).runtime;
  if (!rt?.EventsOn) {
    if (attempts++ < 100) setTimeout(initAIEvents, 100);
    return;
  }
  installed = true;
  for (const name of AI_EVENT_NAMES) {
    rt.EventsOn(name, (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      dispatch({ name, payload } as AIEvent);
    });
  }
}

initAIEvents();
