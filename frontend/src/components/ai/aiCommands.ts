/**
 * AI chat verbs of the command registry, registered by
 * `registerFeatureCommands` (components/commands):
 * - AI: New Chat (Ctrl+Shift+N; View menu and palette), AI: Compact Chat and
 *   AI: Settings (palette); the panel itself is the shell's `view.ai`
 *   (Ctrl+Shift+A), whose handler this file replaces so that it also puts
 *   the focus into the composer when the chat is already shown (A-01);
 * - entry menus (tree, results, Entry menu, palette): "Ask AI about This
 *   User/Group/…" opens the chat with the selection as @mentions.
 */
import { MessageSquarePlus, Minimize2, PanelRight, Settings, Sparkles } from 'lucide-react';
import { registerCommandHandlers, registerCommands, type Command, type CommandContext } from '../ui/commands';
import { OBJECT_KIND_LABEL } from '../ui/objectKind';
import { startAIStore, useAIStore } from '../../stores/aiStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { useUIStore } from '../../stores/uiStore';
import { runActive } from '../../lib/aiReducer';
import { askAITitleText, droppedNames } from '../../lib/aiComposer';
import { rdnValue } from '../../lib/aiFormat';
import { useToastStore } from '../ui/Toast';
import type { Mention } from '../../types/ai';

/** At most this many entries are mentioned at once. */
export const ASK_AI_MAX = 5;

/** The selection as @mentions (items of other connections are already dropped). */
export function askAIMentions(ctx: CommandContext): Mention[] {
  const out: Mention[] = [];
  for (const it of ctx.selection) {
    const profileId = it.profileId ?? ctx.profileId;
    if (profileId && it.dn) out.push({ profileId, dn: it.dn });
  }
  return out.slice(0, ASK_AI_MAX);
}

/** "Ask AI about This User" / "… These 3 Entries" / "… the First 5 of 7 Entries". */
export function askAITitle(ctx: CommandContext): string {
  const kind = ctx.selection[0]?.kind ?? 'other';
  return askAITitleText(ctx.selection.length, OBJECT_KIND_LABEL[kind] ?? 'Entry', ASK_AI_MAX, accessOf(ctx.profileId) === 'none');
}

/**
 * The open "no access" toast per connection. It is dismissed as soon as
 * the connection's access is no longer None (N1: it stayed 25+ minutes
 * after access was granted and covered an approval card's buttons).
 */
const accessToasts = new Map<string, string>();
let accessWatch: (() => void) | null = null;

function watchAccessToasts() {
  if (accessWatch) return;
  accessWatch = useAIStore.subscribe((s, prev) => {
    if (s.config === prev.config || accessToasts.size === 0) return;
    for (const [pid, id] of [...accessToasts]) {
      if (accessOf(pid) === 'none') continue;
      useToastStore.getState().removeToast(id);
      accessToasts.delete(pid);
    }
  });
}

/** Runs "Ask AI about …": explains a connection the assistant may not see, names entries beyond the limit. */
async function askAbout(ctx: CommandContext) {
  await startAIStore();
  const store = useAIStore.getState();
  if (accessOf(ctx.profileId) === 'none') {
    const pid = ctx.profileId ?? '';
    const name = useConnectionStore.getState().profiles.find((p) => p.id === ctx.profileId)?.name ?? 'this connection';
    // one toast per connection, also when asked again
    const old = accessToasts.get(pid);
    if (old) useToastStore.getState().removeToast(old);
    const id = useToastStore.getState().addToast('info', `The AI assistant has no access to "${name}"`, {
      detail: 'Its access level is None. Change it in AI Settings ▸ Directory access to ask about its entries.',
      persistent: true,
      action: { label: 'AI settings', run: () => { store.openPanel(); useAIStore.getState().setView('settings'); } },
    });
    accessToasts.set(pid, id);
    watchAccessToasts();
    return;
  }
  await store.askAbout(askAIMentions(ctx), { newChat: store.askNewChat });
  if (ctx.selection.length > ASK_AI_MAX) {
    const labels = ctx.selection.map((it) => it.label || rdnValue(it.dn));
    useToastStore.getState().addToast('info', `Only the first ${ASK_AI_MAX} of ${ctx.selection.length} entries were added`, {
      detail: `Not added: ${droppedNames(labels, ASK_AI_MAX)}. Ask about them separately.`,
    });
  }
}

/**
 * "Ask AI about …" for entries outside the registry's context, such as the
 * search results of another connection than the active one (the AI is
 * multi-connection, A-05): the same checks, new chat and dropped-entry
 * notice as the registry command.
 */
export async function askAIAbout(profileId: string, items: { dn: string; label?: string }[]): Promise<void> {
  const ctx: CommandContext = {
    profileId,
    serverType: null,
    connected: true,
    readOnly: false,
    source: 'results',
    selection: items.map((it) => ({ dn: it.dn, profileId, label: it.label })),
  };
  await askAbout(ctx);
}

/** The title for askAIAbout's menu item ("Ask AI about These 3 Entries"). */
export function askAIAboutTitle(profileId: string, count: number): string {
  return askAITitle({ profileId, serverType: null, connected: true, readOnly: false, source: 'results', selection: Array.from({ length: count }, () => ({ dn: '', kind: 'other' })) });
}

function accessOf(profileId: string | null): string {
  const cfg = useAIStore.getState().config;
  if (!cfg || !profileId) return 'ask';
  return cfg.connectionAccess?.[profileId]?.level || cfg.defaultAccess || 'ask';
}

function aiCommands(): Command[] {
  return [
    {
      id: 'ai.askAbout',
      title: askAITitle,
      icon: Sparkles,
      group: 'entry',
      section: 'open',
      order: 50,
      keywords: ['assistant', 'chat', 'explain', 'ai'],
      when: (ctx) => ctx.connected && ctx.selection.length > 0 && askAIMentions(ctx).length > 0,
      // A connection the assistant may not see ("none") stays enabled: the
      // title says so and running it explains how to allow access (A-05).
      run: askAbout,
    },
    {
      id: 'ai.newChat',
      title: 'AI: New Chat',
      icon: MessageSquarePlus,
      group: 'view',
      // View menu, right after "AI Chat" (view.ai, order 8).
      section: 'panels',
      order: 8.5,
      shortcut: 'Mod+Shift+N',
      keywords: ['assistant', 'chat'],
      run: async () => {
        // The first chat list load must be done, or it could replace the new chat.
        await startAIStore();
        useAIStore.getState().openPanel();
        await useAIStore.getState().newChat({ fresh: true });
      },
    },
    {
      id: 'view.aiDock',
      title: () => (useUIStore.getState().aiDock === 'right' ? 'Move AI Chat to the Side Bar' : 'Move AI Chat to the Right'),
      icon: PanelRight,
      group: 'view',
      section: 'panels',
      order: 8.6,
      keywords: ['assistant', 'chat', 'dock', 'pane', 'side'],
      run: () => {
        const ui = useUIStore.getState();
        ui.setAIDock(ui.aiDock === 'right' ? 'sidebar' : 'right');
        showAIChat();
      },
    },
    {
      id: 'ai.compact',
      title: 'AI: Compact Chat',
      icon: Minimize2,
      group: 'view',
      section: 'ai',
      menu: false,
      keywords: ['assistant', 'summarize', 'context'],
      enabled: () => {
        const s = useAIStore.getState();
        return !!s.activeChatId && s.config?.engine !== 'claudecode' && !runActive(s.runs[s.activeChatId]);
      },
      run: async () => {
        useAIStore.getState().openPanel();
        await useAIStore.getState().compact();
      },
    },
    {
      id: 'ai.settings',
      title: 'AI: Settings',
      icon: Settings,
      group: 'view',
      section: 'ai',
      menu: false,
      keywords: ['assistant', 'provider', 'model', 'claude code', 'ollama'],
      run: async () => {
        await startAIStore();
        useAIStore.getState().openPanel();
        useAIStore.getState().setView('settings');
      },
    },
  ];
}

/**
 * Ctrl+Shift+A / View ▸ AI Chat: shows the chat and focuses the composer,
 * also when the panel is already visible (the panel's own effect only runs
 * when it goes from hidden to shown).
 */
export function showAIChat() {
  const ui = useUIStore.getState();
  if (ui.aiDock === 'right') {
    if (!ui.aiPaneVisible) ui.toggleAIPane();
  } else {
    ui.setActivity('ai');
    if (!useUIStore.getState().sidebarVisible) useUIStore.getState().toggleSidebar();
  }
  const s = useAIStore.getState();
  // the settings view stays open (a draft may be in it)
  if (s.view === 'chat') s.setComposerText(s.composerText, true);
}

export function registerAICommands(): () => void {
  const off = registerCommands(aiCommands());
  const offView = registerCommandHandlers({ 'view.ai': () => showAIChat() });
  return () => {
    offView();
    off();
  };
}
