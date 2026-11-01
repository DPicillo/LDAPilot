import { useEffect, useRef, type KeyboardEvent } from 'react';
import { AlertTriangle, Info, Loader2, Settings } from 'lucide-react';
import { runActive } from '../../lib/aiReducer';
import { startAIStore, useAIStore } from '../../stores/aiStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { selectAIShown, useUIStore } from '../../stores/uiStore';
import { ChatHeader } from './ChatHeader';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { EmptyState } from './EmptyState';
import { SettingsPanel } from './SettingsPanel';
import { textButton, tone } from './tone';
import { cn } from '../../lib/utils';

function Banner({ kind, children }: { kind: 'info' | 'warning' | 'error'; children: React.ReactNode }) {
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex shrink-0 items-start gap-1.5 border-b px-2 py-1 text-xs',
        kind === 'error' ? cn(tone.dangerBorder, tone.dangerBg) : kind === 'warning' ? cn(tone.warningBorder, tone.warningBg) : 'border-border bg-secondary',
      )}
    >
      {kind === 'info' ? <Info size={12} className="mt-px shrink-0 text-muted-foreground" /> : <AlertTriangle size={12} className={cn('mt-px shrink-0', kind === 'error' ? tone.dangerText : tone.warningText)} />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * AI assistant panel (§10.2). Works without any connection: chats and
 * settings are always available. The exported name stays AIChatPanel so the
 * layout (Sidebar.tsx) needs no change.
 */
export function AIChatPanel() {
  const view = useAIStore((s) => s.view);
  const config = useAIStore((s) => s.config);
  const configError = useAIStore((s) => s.configError);
  const storeError = useAIStore((s) => s.storeError);
  const activeChatId = useAIStore((s) => s.activeChatId);
  const chats = useAIStore((s) => s.chats);
  const chatsLoaded = useAIStore((s) => s.chatsLoaded);
  const loadingChat = useAIStore((s) => s.loadingChat);
  const transcript = useAIStore((s) => (s.activeChatId ? s.transcripts[s.activeChatId] : undefined));
  const meta = useAIStore((s) => (s.activeChatId ? s.chatMeta[s.activeChatId] : undefined));
  const run = useAIStore((s) => (s.activeChatId ? s.runs[s.activeChatId] : undefined)) ?? null;
  const hasNotices = useAIStore((s) => !!(s.activeChatId && s.notices[s.activeChatId]?.length));
  const profiles = useConnectionStore((s) => s.profiles);
  const statuses = useConnectionStore((s) => s.connectionStatuses);
  const autoSelected = useRef(false);

  useEffect(() => {
    startAIStore();
    const s = useAIStore.getState();
    void s.loadChats();
    if (s.activeChatId) {
      if (!runActive(s.runs[s.activeChatId])) void s.resync(s.activeChatId);
      void s.refreshContextInfo(s.activeChatId);
    }
  }, []);

  // Model discovery when the panel opens (remote endpoints only now, §4.5).
  const endpoint = config ? `${config.engine}|${config.provider}|${config.flavor}|${config.url}|${config.hasKey}` : '';
  useEffect(() => {
    if (endpoint) void useAIStore.getState().discover(false);
  }, [endpoint]);

  // Open the most recent chat the first time the panel shows.
  useEffect(() => {
    if (autoSelected.current || !chatsLoaded) return;
    autoSelected.current = true;
    if (activeChatId) return;
    const first = chats.find((c) => !c.corrupt);
    if (first) void useAIStore.getState().selectChat(first.id);
  }, [chats, activeChatId, chatsLoaded]);

  // Opening the panel (Ctrl+Shift+A, the activity bar, Ask AI) puts the
  // focus into the composer (A-01); the panel stays mounted while hidden.
  const shown = useUIStore(selectAIShown);
  useEffect(() => {
    if (shown && useAIStore.getState().view === 'chat') useAIStore.getState().setComposerText(useAIStore.getState().composerText, true);
  }, [shown]);

  // Load a chat selected elsewhere (e.g. from an approval toast).
  useEffect(() => {
    if (activeChatId && transcript === undefined && loadingChat !== activeChatId) void useAIStore.getState().selectChat(activeChatId);
  }, [activeChatId, transcript, loadingChat]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (document.querySelector('[data-ai-popup]')) return;
    // Esc stops the run from the composer or the message list only; in a
    // card's note field or in the settings it just leaves that field.
    const t = e.target instanceof Element ? e.target : null;
    if (useAIStore.getState().view !== 'chat' || !t || !t.closest('[data-ai-composer], [role="log"]')) return;
    if (t.closest('input, select, textarea') && !t.closest('[data-ai-composer]')) return;
    const id = useAIStore.getState().activeChatId;
    if (useAIStore.getState().preflightChecking) {
      // the check of the provider before a send (P4)
      e.preventDefault();
      useAIStore.getState().cancelPreflight();
      return;
    }
    if (id && runActive(useAIStore.getState().runs[id])) {
      e.preventDefault();
      void useAIStore.getState().stop(id);
    }
  };

  const configured = !!config && (config.engine === 'claudecode' || !!config.provider);
  const readOnly = !!meta?.readOnly;
  const access = (id: string) => config?.connectionAccess?.[id]?.level || config?.defaultAccess || 'ask';
  const connected = profiles.filter((p) => statuses[p.id]);
  const accessible = connected.filter((p) => access(p.id) !== 'none');
  const corrupt = activeChatId ? chats.find((c) => c.id === activeChatId)?.corrupt : false;

  let disabledReason: string | undefined;
  if (storeError) disabledReason = 'Chats are unavailable';
  else if (readOnly) disabledReason = 'Read-only: another LDAPilot window is using the chats';
  else if (corrupt) disabledReason = 'This chat is damaged; start a new chat';
  else if (config && !configured) disabledReason = 'Set up an AI provider in the settings first';

  const showEmpty = !activeChatId || (transcript !== undefined && transcript.length === 0 && !run && !hasNotices);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-sidebar" onKeyDown={onKeyDown}>
      <ChatHeader />
      {view === 'settings' ? (
        <SettingsPanel />
      ) : (
        <>
          {configError && <Banner kind="error">The AI settings could not be read: {configError}</Banner>}
          {storeError && <Banner kind="error">Chats are unavailable: {storeError}</Banner>}
          {readOnly && <Banner kind="warning">Another LDAPilot window is using the chats. They are read-only here.</Banner>}
          {config && !configured && (
            <Banner kind="info">
              <span>The assistant needs an AI provider (for example a local Ollama) or Claude Code.</span>
              <button type="button" className={textButton + ' ml-1'} aria-label="Open AI settings" onClick={() => useAIStore.getState().setView('settings')}>
                <Settings size={11} /> Settings
              </button>
            </Banner>
          )}
          {config?.keyError && <Banner kind="warning">{config.keyError}</Banner>}
          {configured && accessible.length === 0 && (
            <Banner kind="info">
              {connected.length === 0
                ? 'No directory is connected. You can still read past chats; connect a directory to let the assistant look things up.'
                : 'No connected directory is available to the assistant (access level "None"). Change it in the settings.'}
            </Banner>
          )}
          {activeChatId && corrupt && <Banner kind="error">{chats.find((c) => c.id === activeChatId)?.note || 'This chat could not be read.'}</Banner>}

          {loadingChat && loadingChat === activeChatId && transcript === undefined ? (
            <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground"><Loader2 size={14} className="mr-1 animate-spin" /> Loading chat…</div>
          ) : showEmpty ? (
            <div className="min-h-0 flex-1 overflow-y-auto"><EmptyState configured={!config || configured} /></div>
          ) : (
            <MessageList chatId={activeChatId!} messages={transcript ?? []} run={run} />
          )}
          <Composer chatId={activeChatId} disabledReason={disabledReason} />
        </>
      )}
    </div>
  );
}
