import { useEffect } from 'react';
import { Check, Eye, Globe, Brain, RefreshCw, TriangleAlert, Wrench, X } from 'lucide-react';
import type { ModelInfo } from '../../types/ai';
import { formatTokens, providerKeyOf } from '../../lib/aiFormat';
import { useAIStore } from '../../stores/aiStore';
import { Badge } from '../ui/Badge';
import { IconButton } from '../ui/Button';
import { Popover } from '../ui/Popover';

/** Capability chips (Tools / Vision / Thinking / context / remote). */
export function CapabilityChips({ m, showRemote = true }: { m: ModelInfo; showRemote?: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-0.5">
      {m.tools === 'yes' && <Badge appearance="outline" icon={Wrench} title={m.toolsVerified ? 'Tool calling (reported by the provider)' : 'Tool calling'}>tools</Badge>}
      {m.tools === 'unknown' && <Badge appearance="outline" icon={Wrench} title="The provider does not report tool support; assumed yes">tools?</Badge>}
      {m.tools === 'no' && <Badge tone="warning" icon={TriangleAlert} title="LDAP tools will not work with this model">no tools</Badge>}
      {m.vision === 'yes' && <Badge appearance="outline" icon={Eye}>vision</Badge>}
      {m.thinking === 'yes' && <Badge appearance="outline" icon={Brain}>thinking</Badge>}
      {m.contextWindow > 0 && <Badge appearance="outline" title={m.contextSource ? `Context window (${m.contextSource})` : 'Context window'}>{formatTokens(m.contextWindow)}</Badge>}
      {m.paramSize && <Badge appearance="outline">{m.paramSize}</Badge>}
      {m.remote && showRemote && <Badge tone="warning" icon={Globe} title="Runs on a remote service although the endpoint is local">remote</Badge>}
    </span>
  );
}

/**
 * /model: picks the model of the current chat (a per-chat override of the
 * configured model). A ui Popover above the composer.
 */
export function ModelPicker({ chatId, open, anchor, onClose }: { chatId: string; open: boolean; anchor: HTMLElement | null; onClose: () => void }) {
  const config = useAIStore((s) => s.config);
  const models = useAIStore((s) => (s.config ? s.models[providerKeyOf(s.config)] : undefined));
  const override = useAIStore((s) => s.chatMeta[chatId]?.modelOverride ?? '');
  const setChatModel = useAIStore((s) => s.setChatModel);
  const discover = useAIStore((s) => s.discover);
  useEffect(() => {
    if (open && !models) void discover(false);
  }, [open, models, discover]);

  const configured = config?.engine === 'claudecode' ? config.claudeCode.model || 'default' : config?.model || '(provider default)';
  const pick = async (id: string) => {
    await setChatModel(chatId, id);
    onClose();
  };

  return (
    <Popover open={open} onOpenChange={(o) => !o && onClose()} anchor={anchor} placement="top-start" matchWidth aria-label="Model for this chat" className="max-h-72 text-xs">
     <div data-ai-popup>
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <span className="font-semibold">Model for this chat</span>
        <IconButton size="sm" icon={RefreshCw} label="Refresh models" className="ml-auto" onClick={() => void discover(true)} />
        <IconButton size="sm" icon={X} label="Close" onClick={onClose} />
      </div>
      <button type="button" className="flex w-full items-center gap-1 px-2 py-1 text-left hover:bg-accent" aria-label="Use the configured model" onClick={() => void pick('')}>
        <span className="w-3">{!override && <Check size={11} />}</span>
        Configured model <span className="text-muted-foreground">({configured})</span>
      </button>
      {models?.error && <div className="px-2 py-0.5 text-warning">{models.error}</div>}
      {(models?.models ?? []).map((m) => (
        <button type="button"
          key={m.id}
          className="flex w-full flex-wrap items-center gap-1 px-2 py-1 text-left hover:bg-accent"
          aria-label={`Use model ${m.displayName || m.id}`}
          title={m.tools === 'no' ? 'LDAP tools will not work with this model' : m.description}
          onClick={() => void pick(m.id)}
        >
          <span className="w-3">{override === m.id && <Check size={11} />}</span>
          <span className="font-mono">{m.id}</span>
          {m.displayName && m.displayName !== m.id && <span className="text-muted-foreground">{m.displayName}</span>}
          <CapabilityChips m={m} showRemote={config?.engine !== 'claudecode' && (config?.provider === 'ollama' || config?.flavor === 'ollama')} />
        </button>
      ))}
      {!models && <div className="px-2 py-1 text-muted-foreground">Loading models…</div>}
     </div>
    </Popover>
  );
}
