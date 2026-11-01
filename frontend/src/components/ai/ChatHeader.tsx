import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Copy, Globe, HardDrive, KeyRound, PanelLeft, PanelRight, Plus, Settings, ShieldCheck, Trash2 } from 'lucide-react';
import { classifyDestination, formatCountdown, formatRelativeTime } from '../../lib/aiFormat';
import { copyText, ExportChatMarkdown } from '../../lib/ai';
import { useAIStore } from '../../stores/aiStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { useUIStore } from '../../stores/uiStore';
import { showAIChat } from './aiCommands';
import { ChatList } from './ChatList';
import { ContextMeter } from './ContextMeter';
import { chip, tone } from './tone';
import { Popover } from '../ui/Popover';
import { Button, IconButton } from '../ui/Button';
import { runActive } from '../../lib/aiReducer';
import { cn } from '../../lib/utils';
import { toast } from '../ui/Toast';

const PROVIDER_LABEL: Record<string, string> = {
  ollama: 'Ollama',
  'openai/ollama': 'Ollama /v1',
  'openai/openai': 'OpenAI',
  'openai/litellm': 'LiteLLM',
  'openai/vllm': 'vLLM',
  'openai/lmstudio': 'LM Studio',
  'openai/custom': 'OpenAI-compatible',
  anthropic: 'Anthropic',
};

function GrantsChip({ chatId }: { chatId: string }) {
  const grants = useAIStore((s) => s.grants[chatId]);
  const revoke = useAIStore((s) => s.revokeGrant);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!open) return;
    // the countdown starts from the time the popover opens, not from mount (A-09)
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);
  const active = (grants ?? []).filter((g) => g.expiresAt > now && g.usesLeft > 0);
  if (active.length === 0) return null;
  return (
    <>
      <button type="button" ref={setAnchor} className={cn(chip, tone.warningText, 'hover:bg-accent')} aria-label={`${active.length} active ${active.length === 1 ? 'approval' : 'approvals'} for this chat`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <ShieldCheck size={10} /> {active.length}
      </button>
      <Popover open={open} onOpenChange={setOpen} anchor={anchor} placement="bottom-end" aria-label="Approved for this chat" className="w-64 p-2 text-xs">
        <div data-ai-popup ref={listRef}>
          <div className="mb-1 font-semibold">Approved for this chat</div>
          <ul className="space-y-1.5">
            {active.map((g) => (
              <li key={g.id} className="rounded border border-border p-1.5">
                <div>{g.scope}</div>
                <div className="mt-0.5 flex items-center gap-1 text-muted-foreground">
                  {g.usesLeft} {g.usesLeft === 1 ? 'use' : 'uses'} left · expires in {formatCountdown(g.expiresAt - now)}
                  <Button size="sm" variant="secondary" className="ml-auto" leftIcon={Trash2} aria-label="Revoke this approval" onClick={async () => {
                    // the store shows the error when it could not be revoked
                    if (!(await revoke(chatId, g.id))) return;
                    toast.success('Approval revoked');
                    // The row (or the whole chip) is gone: the focus moves to the
                    // next approval, else into the composer, never to <body> (S4).
                    if (active.length <= 1) {
                      setOpen(false);
                      const st = useAIStore.getState();
                      st.setComposerText(st.composerText, true);
                    } else {
                      requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>('button[aria-label="Revoke this approval"]')?.focus());
                    }
                  }}>
                    Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Popover>
    </>
  );
}

/** Provider/model chip with local/remote badge; opens the chat info (egress) popover. */
function ProviderChip({ chatId }: { chatId: string | null }) {
  const config = useAIStore((s) => s.config);
  const meta = useAIStore((s) => (chatId ? s.chatMeta[chatId] : undefined));
  const run = useAIStore((s) => (chatId ? s.runs[chatId] : undefined));
  const profiles = useConnectionStore((s) => s.profiles);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  // The ledger as of now, also while a response runs (A-08).
  useEffect(() => {
    if (open && chatId) void useAIStore.getState().refreshEgress(chatId);
  }, [open, chatId]);
  if (!config) return null;
  const cc = config.engine === 'claudecode';
  if (!cc && !config.provider) return null;
  const dest = classifyDestination(config);
  const pkey = cc ? 'claudecode' : config.provider === 'openai' ? 'openai/' + (config.flavor || 'custom') : config.provider;
  const label = cc ? 'Claude Code' : PROVIDER_LABEL[pkey] ?? config.provider;
  // A finished run's model is history (e.g. Claude Code's haiku after a
  // switch to the built-in engine, defect D3): only a running run wins over
  // the configuration.
  // A step names its model when discovery replaced the one ai:run_started
  // announced (the run is announced before the provider is asked, P4).
  const stepModel = run ? [...run.liveMessages].reverse().find((m) => m.model)?.model : '';
  const liveModel = runActive(run) ? stepModel || run?.model : '';
  const model = meta?.modelOverride || liveModel || (cc ? config.claudeCode.model || 'default' : config.model) || '';
  const name = (id: string) => profiles.find((p) => p.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className="min-w-0 shrink">
      <button type="button"
        ref={setAnchor}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={`${label}, model ${model || 'default'}, ${dest.local ? 'local' : 'remote'}. Show chat info`}
        title={`${label} · ${model}${meta?.modelOverride ? ' (this chat)' : ''}`}
        onClick={() => setOpen(!open)}
      >
        {dest.local ? <HardDrive size={11} className={tone.successText} /> : <Globe size={11} className={tone.warningText} />}
        <span className="truncate">{model || label}</span>
      </button>
      <Popover open={open} onOpenChange={setOpen} anchor={anchor} placement="bottom-start" aria-label="Chat info" className="w-64 p-2 text-xs">
        <div data-ai-popup>
          <div className="mb-1 font-semibold">{label}</div>
          <div className="space-y-0.5 text-muted-foreground">
            <div>Model: <span className="text-foreground">{model || 'provider default'}</span>{meta?.modelOverride ? ' (set for this chat, /model to change)' : ''}</div>
            <div className="flex items-center gap-1">
              Data goes to <span className="text-foreground">{dest.host || 'unknown'}</span>
              <span className={cn(chip, dest.local ? tone.successText : tone.warningText)}>{dest.local ? 'local' : 'remote'}</span>
            </div>
          </div>
          {chatId && (
            <>
              <div className="mb-0.5 mt-2 font-semibold">Directory data sent in this chat</div>
              {(meta?.egress ?? []).length === 0 ? (
                <div className="text-muted-foreground">No directory data was sent yet.</div>
              ) : (
                <table className="w-full">
                  <tbody>
                    {(meta?.egress ?? []).map((e, i) => (
                      <tr key={i} className="align-top">
                        <td className="pr-1">{name(e.profileId)}</td>
                        <td className="pr-1 text-muted-foreground">→ {e.providerHost}{e.remote ? ' (remote)' : ''}</td>
                        <td className="text-right text-muted-foreground" title={`last ${formatRelativeTime(e.lastAt)}`}>{e.toolResults} {e.toolResults === 1 ? 'result' : 'results'}, {Math.max(1, Math.round(e.bytes / 1024))} KB</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                leftIcon={Copy}
                aria-label="Copy chat as Markdown"
                onClick={async () => {
                  try {
                    const md = await ExportChatMarkdown(chatId);
                    if (await copyText(md)) toast.success('Chat copied as Markdown');
                  } catch (err) {
                    toast.error('Export failed', err instanceof Error ? err.message : String(err));
                  }
                }}
              >
                Copy chat as Markdown
              </Button>
            </>
          )}
          {cc && <div className="mt-2 text-muted-foreground"><KeyRound size={10} className="mr-0.5 inline" />Runs the local Claude Code CLI with your Claude login.</div>}
        </div>
      </Popover>
    </div>
  );
}

export function ChatHeader() {
  const activeChatId = useAIStore((s) => s.activeChatId);
  const title = useAIStore((s) => s.chats.find((c) => c.id === s.activeChatId)?.title);
  const running = useAIStore((s) => s.chats.find((c) => c.id === s.activeChatId)?.running);
  const view = useAIStore((s) => s.view);
  const setView = useAIStore((s) => s.setView);
  const newChat = useAIStore((s) => s.newChat);
  const unsavedSettings = useAIStore((s) => s.settingsDraft !== null);
  const readOnly = useAIStore((s) => (s.activeChatId ? !!s.chatMeta[s.activeChatId]?.readOnly : false));
  const [listOpen, setListOpen] = useState(false);
  const [listAnchor, setListAnchor] = useState<HTMLDivElement | null>(null);
  // Docked right, the chat stays visible next to the tree and the editor
  // (Show in Tree, filter links and Open in Search no longer replace it).
  const dock = useUIStore((s) => s.aiDock);

  return (
    <div className="shrink-0 border-b border-border">
      <div ref={setListAnchor} className="flex h-9 items-center gap-1 px-2">
        <button type="button"
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left text-xs font-semibold hover:bg-accent"
          aria-label="Choose a chat"
          aria-expanded={listOpen}
          data-ai-chatlist-toggle
          onClick={() => setListOpen(!listOpen)}
        >
          <span className="truncate">{view === 'settings' ? 'AI settings' : activeChatId ? title || 'New chat' : 'AI assistant'}</span>
          {running && <span className={cn('h-1.5 w-1.5 shrink-0 animate-pulse rounded-full', tone.successDot)} aria-label="running" />}
          <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
        </button>
        <IconButton
          icon={Plus}
          label={readOnly ? 'New chat — not available: another LDAPilot window is using the chats' : 'New chat'}
          shortcut={readOnly ? undefined : 'Mod+Shift+N'}
          disabled={readOnly}
          onClick={() => void newChat({ fresh: true })}
        />
        <IconButton
          icon={
            <span className="relative">
              <Settings size={14} strokeWidth={1.75} aria-hidden />
              {unsavedSettings && view !== 'settings' && <span className={cn('absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full', tone.warningDot)} aria-hidden />}
            </span>
          }
          label={view === 'settings' ? 'Back to the chat' : unsavedSettings ? 'AI settings (unsaved changes)' : 'AI settings'}
          pressed={view === 'settings'}
          onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}
        />
        <IconButton
          icon={dock === 'right' ? PanelLeft : PanelRight}
          label={dock === 'right' ? 'Move the chat to the side bar' : 'Move the chat to the right of the editor'}
          onClick={() => {
            useUIStore.getState().setAIDock(dock === 'right' ? 'sidebar' : 'right');
            showAIChat();
          }}
        />
      </div>
      {view === 'chat' && (
        <div className="flex h-6 items-center gap-1 px-2 pb-1">
          <ProviderChip chatId={activeChatId} />
          <span className="flex-1" />
          {activeChatId && <GrantsChip chatId={activeChatId} />}
          {activeChatId && <ContextMeter chatId={activeChatId} />}
        </div>
      )}
      <ChatList open={listOpen} anchor={listAnchor} onClose={() => setListOpen(false)} />
    </div>
  );
}
