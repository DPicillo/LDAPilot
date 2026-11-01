import { useAIStore } from '../../stores/aiStore';
import { checkModelId } from '../../lib/aiComposer';
import { providerKeyOf } from '../../lib/aiFormat';

export interface SlashCommand {
  name: string;
  args?: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/clear', description: 'Start a new chat (this one stays in the history)' },
  { name: '/compact', description: 'Summarize older messages to free context' },
  { name: '/model', args: '[model id]', description: 'Choose the model for this chat' },
  { name: '/help', description: 'Show commands and shortcuts' },
];

export const HELP_TEXT = [
  '**Commands**',
  '',
  '| Command | What it does |',
  '|---|---|',
  '| `/clear` | Start a new chat; this one stays in the history |',
  '| `/compact` | Summarize older messages to free context (built-in engine) |',
  '| `/model` | Pick the model for this chat; `/model <id>` sets it directly, `/model default` resets it |',
  '| `/help` | This help |',
  '',
  '**Keys**',
  '',
  '| Key | Action |',
  '|---|---|',
  '| Enter | Send |',
  '| Shift+Enter | New line |',
  '| Esc | Stop the running answer (or close a popup) |',
  '| ↑ in an empty input | Edit the last message |',
  '| `@` | Mention the selected entry or a recent one |',
  '',
  'DNs and LDAP filters in answers are links: click a DN to open the entry (right-click for more), click a filter to run it in the search panel.',
].join('\n');

/** Matching commands for the popup while the input starts with "/". */
export function matchCommands(input: string): SlashCommand[] {
  if (!input.startsWith('/') || input.includes('\n')) return [];
  const word = input.split(/\s/)[0].toLowerCase();
  if (input.includes(' ')) return SLASH_COMMANDS.filter((c) => c.name === word && c.args);
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(word));
}

/**
 * Runs a slash command. Returns true when the input was a command (it is
 * then not sent to the assistant).
 */
export async function runSlashCommand(input: string): Promise<boolean> {
  const text = input.trim();
  if (!text.startsWith('/')) return false;
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim();
  const s = useAIStore.getState();
  switch (cmd.toLowerCase()) {
    case '/clear':
      await s.newChat({ fresh: true });
      s.setComposerText('', true);
      return true;
    case '/compact':
      s.setComposerText('');
      await s.compact();
      return true;
    case '/model': {
      const chatId = s.activeChatId;
      if (!arg) {
        s.setComposerText('');
        s.setModelPickerOpen(true);
        return true;
      }
      if (!chatId) {
        const id = await s.newChat();
        if (!id) return true;
      }
      const id = useAIStore.getState().activeChatId!;
      if (arg === 'default') {
        await s.setChatModel(id, '');
        s.setComposerText('');
        s.addNotice(id, 'This chat now uses the configured model.');
        return true;
      }
      // Check the name against the provider's models (A-15).
      const cfg = useAIStore.getState().config;
      let models = cfg ? useAIStore.getState().models[providerKeyOf(cfg)] : undefined;
      if (!models?.models?.length) models = (await s.discover(false)) ?? undefined;
      const check = checkModelId(arg, models?.models ?? [], cfg?.engine ?? '');
      if (check.ok === false) {
        s.addNotice(id, `\`${arg}\` is not one of the models ${models?.baseUrl ? `at ${models.baseUrl}` : 'of the provider'}${check.suggestions.length ? `; available: ${check.suggestions.map((m) => `\`${m}\``).join(', ')}` : ''}. The chat keeps its model; pick one in the list.`);
        s.setComposerText('');
        s.setModelPickerOpen(true);
        return true;
      }
      await s.setChatModel(id, check.id);
      s.setComposerText('');
      s.addNotice(id, check.ok === 'unknown'
        ? `This chat now uses the model \`${check.id}\`. LDAPilot could not check the provider's model list${models?.error ? ` (${models.error})` : ''}.`
        : `This chat now uses the model \`${check.id}\`.`);
      return true;
    }
    case '/help': {
      let id = s.activeChatId;
      if (!id) id = await s.newChat();
      if (id) useAIStore.getState().addNotice(id, HELP_TEXT);
      s.setComposerText('');
      return true;
    }
    default:
      return false;
  }
}
