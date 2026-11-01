import type { ContextInfo, UsageEvent } from '../../types/ai';
import { formatTokens } from '../../lib/aiFormat';
import { useAIStore } from '../../stores/aiStore';
import { runActive } from '../../lib/aiReducer';
import { tone } from './tone';
import { cn } from '../../lib/utils';
import { Tooltip } from '../ui/Tooltip';

const BREAKDOWN_LABEL: Record<string, string> = {
  system: 'System prompt',
  tools: 'Tool definitions',
  context: 'Context block',
  messages: 'Messages',
  tool_results: 'Tool results',
  history: 'History',
  summary: 'Summary',
};

/**
 * Context usage ring (§7.7): amber from 70 %, red from 90 %. The tooltip
 * (ui Tooltip, zoom-safe) shows the breakdown, the window source and the
 * auto-compaction threshold; clicking runs /compact.
 */
export function ContextMeter({ chatId }: { chatId: string }) {
  const info: ContextInfo | undefined = useAIStore((s) => s.contextInfo[chatId]);
  const run = useAIStore((s) => s.runs[chatId]);
  const engine = useAIStore((s) => s.config?.engine);
  const cfgWindow = useAIStore((s) => (s.config?.engine === 'builtin' ? s.config.contextWindow : 0));
  const compact = useAIStore((s) => s.compact);

  const usage: UsageEvent | null = run?.usage ?? null;
  // While a run streams, ai:usage is newest; afterwards GetContextInfo is.
  const fromRun = !!usage && (runActive(run) || !info || !info.contextWindow);
  // Without a run in this session the estimate has no window: use the configured one.
  const ctxWindow = (fromRun ? usage!.contextWindow : 0) || info?.contextWindow || cfgWindow || 0;
  const tokens = fromRun ? usage!.contextTokens : info?.lastActualTokens || info?.estimatedTokens || 0;
  const pct = fromRun ? usage!.contextPercent : info?.percent || (ctxWindow ? (tokens / ctxWindow) * 100 : 0);
  if (!ctxWindow || !tokens) return null;

  const p = Math.max(0, Math.min(100, pct || 0));
  const color = p >= 90 ? tone.dangerStroke : p >= 70 ? tone.warningStroke : tone.successStroke;
  const r = 7;
  const c = 2 * Math.PI * r;
  const canCompact = engine !== 'claudecode' && !runActive(run);
  const auto = info?.autoCompactAt ? Math.round(info.autoCompactAt * (info.autoCompactAt <= 1 ? 100 : 1)) : 70;

  const details = (
    <div className="w-56 text-left">
      <div className="mb-1 font-semibold">Context: {formatTokens(tokens)} of {formatTokens(ctxWindow)} tokens</div>
      {info?.breakdown && Object.keys(info.breakdown).length > 0 && (
        <table className="mb-1 w-full">
          <tbody>
            {Object.entries(info.breakdown).map(([k, v]) => (
              <tr key={k}><td className="text-muted-foreground">{BREAKDOWN_LABEL[k] ?? k}</td><td className="text-right">{formatTokens(v)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {info?.windowSource && <div className="text-muted-foreground">Window: {info.windowSource}</div>}
      <div className="text-muted-foreground">Auto-compaction at {auto} %{info?.compactions ? ` · compacted ${info.compactions}×` : ''}</div>
      {info?.suspect && <div className={cn('mt-1', tone.warningText)}>The server may have truncated the conversation (its token count is lower than expected).</div>}
      <div className="mt-1 text-muted-foreground">{engine === 'claudecode' ? 'Claude Code manages its own context.' : canCompact ? 'Click to summarize older messages (/compact).' : ''}</div>
    </div>
  );

  return (
    <Tooltip content={details} placement="bottom-end">
      <button type="button"
        className="flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground aria-disabled:cursor-default"
        aria-label={`Context ${Math.round(p)} % used${canCompact ? '. Click to compact the conversation' : ''}`}
        aria-disabled={!canCompact || undefined}
        onClick={() => canCompact && void compact()}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
          <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" className="stroke-border" />
          <circle
            cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" strokeLinecap="round"
            className={color}
            strokeDasharray={`${(p / 100) * c} ${c}`}
            transform="rotate(-90 9 9)"
          />
        </svg>
        <span>{Math.round(p)}%</span>
      </button>
    </Tooltip>
  );
}
