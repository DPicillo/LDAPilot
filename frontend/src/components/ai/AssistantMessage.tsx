import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, Bot, Check, ChevronDown, ChevronRight, Copy, Loader2, Play, RefreshCw, Scissors, TriangleAlert } from 'lucide-react';
import type { Block, Message, RunError } from '../../types/ai';
import type { ApprovalState, LiveMessage, RunState } from '../../lib/aiReducer';
import { regKey, runActive } from '../../lib/aiReducer';
import { copyText } from '../../lib/ai';
import { formatCost, formatDuration, formatTokens, resultErrorCode, splitElapsed } from '../../lib/aiFormat';
import { useAIStore } from '../../stores/aiStore';
import { Markdown } from './Markdown';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallCard } from './ToolCallCard';
import { ApprovalCard } from './ApprovalCard';
import { MessageLinkContext, dnIndex, type FilterUse, type MessageLinks } from './DnLink';
import { buildCard, cardLinks, type CardView } from './cardModel';
import { iconButton, textButton, tone } from './tone';
import { cn } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';

export interface AssistantTurnProps {
  /** persisted assistant messages of this turn, in order */
  messages: Message[];
  /** tool_result blocks of the whole chat, by toolCallId */
  results: Record<string, Block>;
  /** the chat's run when it belongs to this turn */
  run: RunState | null;
  /** streamed messages not persisted yet */
  live: LiveMessage[];
  isLast: boolean;
  /** the chat has no active run */
  idle: boolean;
  hideThinking: boolean;
  scrollToApproval: string | null;
}

const ERROR_TITLES: Record<string, string> = {
  config_missing: 'The AI assistant is not configured',
  provider_unreachable: 'The AI provider could not be reached',
  auth_failed: 'The AI provider rejected the credentials',
  model_not_found: 'The model was not found',
  rate_limited: 'The AI provider is rate limiting requests',
  overloaded: 'The AI provider is overloaded',
  context_exceeded: 'The conversation is too long for the model',
  context_too_small: 'The model\'s context window is too small',
  context_truncated: 'The server truncated the conversation',
  timeout: 'The AI provider did not answer in time',
  stream_interrupted: 'The answer was interrupted',
  budget_exceeded: 'The per-message budget was reached',
};

function ErrorCard({ err, canRetry }: { err: RunError; canRetry: boolean }) {
  const [details, setDetails] = useState(false);
  const regenerate = useAIStore((s) => s.regenerate);
  const compact = useAIStore((s) => s.compact);
  const continueRun = useAIStore((s) => s.continueRun);
  const engine = useAIStore((s) => s.config?.engine);
  return (
    <div className={cn('my-1 rounded border px-2 py-1.5 text-xs', tone.dangerBorder, tone.dangerBg)} role="alert">
      <div className={cn('flex items-center gap-1 font-semibold', tone.dangerText)}>
        <AlertCircle size={12} /> {ERROR_TITLES[err.code] ?? 'The answer failed'}
      </div>
      <div className="mt-0.5 whitespace-pre-wrap">{err.message}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {canRetry && (
          <Button size="sm" variant="secondary" leftIcon={RefreshCw} aria-label="Retry" onClick={() => void regenerate()}>Retry</Button>
        )}
        {canRetry && err.code === 'context_exceeded' && engine !== 'claudecode' && (
          <button type="button"
            className={textButton}
            aria-label="Compact and continue"
            onClick={async () => {
              await compact();
              const wait = () => new Promise<void>((res) => {
                const unsub = useAIStore.subscribe((s) => {
                  const id = s.activeChatId;
                  if (id && !runActive(s.runs[id])) { unsub(); res(); }
                });
              });
              await wait();
              await continueRun();
            }}
          >
            <Scissors size={11} /> /compact and continue
          </button>
        )}
        {(err.status || err.requestId) && (
          <button type="button" className="flex items-center gap-0.5 text-muted-foreground hover:text-foreground" aria-expanded={details} aria-label="Error details" onClick={() => setDetails(!details)}>
            {details ? <ChevronDown size={11} /> : <ChevronRight size={11} />} details
          </button>
        )}
      </div>
      {details && (
        <div className="mt-1 font-mono text-muted-foreground">
          code {err.code}{err.status ? ` · HTTP ${err.status}` : ''}{err.requestId ? ` · request ${err.requestId}` : ''}
        </div>
      )}
    </div>
  );
}

/** A live seconds counter for statuses that Go repeats only every 15 s (model loading, reading the prompt). */
function useTicking(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function StatusLine({ run }: { run: RunState }) {
  const s = run.status_;
  const live = !!s && (s.kind === 'processing_prompt' || s.kind === 'model_loading') && runActive(run);
  const now = useTicking(live);
  if (!runActive(run)) return null;
  let text = '';
  if (s) {
    text = s.message || s.kind.replace(/_/g, ' ');
    if (s.kind === 'retrying' && s.delayMs) text += ` (retry ${s.attempt ?? ''} in ${Math.ceil(s.delayMs / 1000)} s)`;
    const el = live ? splitElapsed(text) : null;
    if (el) text = `${el.text} ${Math.max(0, Math.round((Math.max(now, s.ts) - s.ts + el.elapsedMs) / 1000))} s`;
  } else if (run.status === 'awaiting_approval') {
    text = 'Waiting for your decision…';
  } else {
    const anyText = run.liveMessages.some((m) => m.blocks.some((b) => b && b.text));
    const busyTool = Object.values(run.toolCards).some((c) => c.status === 'running' || c.status === 'queued' || c.status === 'finishing_write');
    // Before the first step the run is still asking the provider for the
    // model and its window (P4: that can take the dial timeout; Esc stops).
    const setup = run.liveMessages.length === 0 && run.toolOrder.length === 0;
    text = busyTool ? 'Working…' : anyText ? '' : setup ? (run.engine === 'claudecode' ? 'Starting Claude Code…' : 'Contacting the AI provider…') : 'Thinking…';
  }
  if (!text) return null;
  return (
    <div className="flex items-center gap-1 py-0.5 text-xs text-muted-foreground" aria-live="polite">
      <Loader2 size={11} className="animate-spin" /> {text}
    </div>
  );
}

function sumUsage(messages: Message[]) {
  let input = 0, output = 0, cost = 0, cacheRead = 0, cacheWrite = 0;
  for (const m of messages) {
    input += m.usage?.inputTokens ?? 0;
    output += m.usage?.outputTokens ?? 0;
    cost += m.usage?.costUsd ?? 0;
    cacheRead += m.usage?.cacheReadTokens ?? 0;
    cacheWrite += m.usage?.cacheWriteTokens ?? 0;
  }
  return { input, output, cost, cacheRead, cacheWrite };
}

/** Text of LDAPilot's synthetic notice blocks of a message (empty answer, output budget used up). */
function syntheticText(m: Message | undefined): string {
  return (m?.blocks ?? []).filter((b) => b.type === 'text' && !b.meta?.kind && b.meta?.synthetic).map((b) => (b.text ?? '').trim()).filter(Boolean).join(' ');
}

/** A marker answer: the run ended before the model wrote anything (Go stores a hidden text block). */
function markerOnly(m: Message): boolean {
  const bs = m.blocks ?? [];
  return bs.length > 0 && bs.every((b) => b.type === 'text' && !!b.meta?.kind);
}

/** One assistant turn: the messages of all steps, tool cards, approvals and a footer (§10.2). */
export function AssistantTurn({ messages, results, run, live, isLast, idle, hideThinking, scrollToApproval }: AssistantTurnProps) {
  const regenerate = useAIStore((s) => s.regenerate);
  const continueRun = useAIStore((s) => s.continueRun);
  const [copied, setCopied] = useState(false);
  const active = runActive(run);

  const approvalsByTool = useMemo(() => {
    const out: Record<string, ApprovalState> = {};
    for (const a of Object.values(run?.approvals ?? {})) out[a.request.toolCallId] = a;
    return out;
  }, [run?.approvals]);

  // Cards: persisted tool_use blocks, then live cards per live message.
  const persistedIds = new Set(messages.map((m) => m.id));
  const shownCards = new Set<string>();
  const cards: Record<string, CardView> = {};
  for (const m of messages) {
    for (const b of m.blocks ?? []) {
      if (b.type !== 'tool_use' || !b.id) continue;
      const c = buildCard(b, results[b.id], run?.toolCards[b.id], active);
      if (c) cards[b.id] = c;
    }
  }
  for (const id of run?.toolOrder ?? []) {
    if (cards[id]) continue;
    const c = buildCard(undefined, undefined, run!.toolCards[id], active);
    if (c) cards[id] = c;
  }

  const links: MessageLinks = useMemo(() => {
    const dnProfiles: Record<string, string> = {};
    const filters: Record<string, FilterUse> = {};
    const dns: string[] = [];
    for (const c of Object.values(cards)) cardLinks(c, dnProfiles, filters, regKey, dns);
    return { dnProfiles, filters, dns: dnIndex(dns) };
  }, [JSON.stringify(Object.values(cards).map((c) => [c.toolCallId, c.status, c.dns.length]))]);

  const renderCard = (id: string) => {
    const c = cards[id];
    if (!c || shownCards.has(id)) return null;
    shownCards.add(id);
    return <ToolCallCard key={id} card={c} approval={approvalsByTool[id]} highlight={!!approvalsByTool[id] && approvalsByTool[id].request.approvalId === scrollToApproval} />;
  };

  const lastMsg = messages[messages.length - 1];
  const stepLimitHit = messages.some((m) => (m.blocks ?? []).some((b) => b.type === 'tool_use' && b.id && resultErrorCode(results[b.id]) === 'STEP_LIMIT'));
  const canContinue = isLast && idle && (run?.done ? run.done.canContinue : !!lastMsg?.truncated || stepLimitHit);
  const limitReached = run?.done?.status === 'truncated' || !!lastMsg?.truncated;
  // The output limit is announced once: next to Continue when it is
  // offered (with Go's notice when the step had no text), else under the
  // cut-off message.
  const limitInRow = canContinue && limitReached;
  const limitNotice = limitInRow ? syntheticText(lastMsg) : '';

  const body: ReactNode[] = [];
  for (const m of messages) {
    const inRow = limitInRow && m === lastMsg;
    (m.blocks ?? []).forEach((b, i) => {
      const key = `${m.id}:${i}`;
      if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        if (!hideThinking) body.push(<ThinkingBlock key={key} text={b.thinking ?? ''} streaming={false} />);
      } else if (b.type === 'text' && !b.meta?.kind && b.meta?.synthetic) {
        // LDAPilot's own notice (empty answer, output budget used up): a status line, not answer text.
        if (!inRow && (b.text ?? '').trim()) body.push(<div key={key} className={cn('text-xs', tone.warningText)}>{b.text}</div>);
      } else if (b.type === 'text' && !b.meta?.kind && (b.text ?? '').trim()) {
        body.push(<Markdown key={key} text={b.text ?? ''} />);
      } else if (b.type === 'tool_use' && b.id) {
        body.push(renderCard(b.id));
      }
    });
    // cards the engine attached to this message without a tool_use block
    for (const id of run?.toolOrder ?? []) if (run!.toolCards[id].messageId === m.id) body.push(renderCard(id));
    if (m.truncated && !inRow && !syntheticText(m)) body.push(<div key={m.id + ':trunc'} className={cn('text-xs', tone.warningText)}>Answer cut off at the output limit.</div>);
    if (m.stopReason === 'refusal') body.push(<div key={m.id + ':refusal'} className="text-xs text-muted-foreground">The model declined to answer.</div>);
    if (m.partial && m.stopReason === 'cancelled') {
      body.push(markerOnly(m)
        ? (
          <div key={m.id + ':stopped'} className="flex items-center gap-2 text-xs text-muted-foreground">
            Stopped before an answer.
            {isLast && idle && (
              <Button size="sm" variant="secondary" leftIcon={RefreshCw} aria-label="Retry" onClick={() => void regenerate()}>Retry</Button>
            )}
          </div>
        )
        : <div key={m.id + ':stopped'} className="text-xs text-muted-foreground">Stopped.</div>);
    }
    if (m.error && !(active && isLast)) body.push(<ErrorCard key={m.id + ':err'} err={m.error} canRetry={isLast && idle} />);
  }
  const lastLive = live[live.length - 1];
  for (const lm of live) {
    if (persistedIds.has(lm.id)) continue;
    lm.blocks.forEach((b, i) => {
      if (!b) return;
      const key = `${lm.id}:live:${i}`;
      if (b.type === 'thinking') {
        // Still thinking: the newest block of the newest step, before any tool call of that step.
        const streaming = active && lm === lastLive && i === lm.blocks.length - 1 && !(run?.toolOrder ?? []).some((id) => run!.toolCards[id].messageId === lm.id);
        if (!hideThinking) body.push(<ThinkingBlock key={key} text={b.text} streaming={streaming} startedAt={b.startedAt} endedAt={b.updatedAt} />);
      } else if (b.text.trim()) {
        body.push(<Markdown key={key} text={b.text} />);
      }
    });
    for (const id of run?.toolOrder ?? []) if (run!.toolCards[id].messageId === lm.id) body.push(renderCard(id));
  }
  // remaining live cards (message not shown)
  for (const id of run?.toolOrder ?? []) body.push(renderCard(id));
  // approvals without a card
  const orphanApprovals = Object.values(run?.approvals ?? {}).filter((a) => !shownCards.has(a.request.toolCallId) && (!a.resolved || active));

  const turnText = [
    ...messages.flatMap((m) => (m.blocks ?? []).filter((b) => b.type === 'text' && !b.meta?.kind && !b.meta?.synthetic).map((b) => b.text ?? '')),
    ...live.filter((l) => !persistedIds.has(l.id)).flatMap((l) => l.blocks.filter((b) => b?.type === 'text').map((b) => b!.text)),
  ].filter((t) => t.trim()).join('\n\n');

  const usage = sumUsage(messages);
  const runUsage = run?.usage;
  // Anthropic and Claude Code report cached input separately from
  // input_tokens; OpenAI-compatible servers and Ollama include it.
  const separateCache = messages.some((m) => m.provider === 'anthropic' || m.provider === 'claudecode') || run?.provider === 'anthropic' || run?.engine === 'claudecode';
  const cacheRead = runUsage && isLast ? runUsage.totals.cacheReadTokens : usage.cacheRead;
  const cacheWrite = runUsage && isLast ? runUsage.totals.cacheWriteTokens : usage.cacheWrite;
  const rawIn = runUsage && isLast ? runUsage.totals.inputTokens : usage.input;
  const tokensIn = separateCache ? rawIn + cacheRead + cacheWrite : rawIn;
  const inTitle = separateCache && cacheRead + cacheWrite > 0
    ? `Input tokens: ${formatTokens(rawIn)} new + ${formatTokens(cacheRead)} read from cache + ${formatTokens(cacheWrite)} written to cache`
    : 'Input / output tokens';
  const tokensOut = runUsage && isLast ? runUsage.totals.outputTokens : usage.output;
  const cost = (runUsage && isLast ? runUsage.costUsd ?? runUsage.totals.costUsd : undefined) || usage.cost;
  const real = (m?: string) => (m && !m.startsWith('<') ? m : '');
  const model = real([...messages].reverse().find((m) => real(m.model))?.model) || real(lastLive?.model) || real(run?.model) || '';
  const runError = run && isLast && run.error && !messages.some((m) => m.error) ? run.error : null;

  return (
    <MessageLinkContext.Provider value={links}>
      <div className="group flex gap-1.5">
        <Bot size={14} className="mt-1 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          {body}
          {orphanApprovals.map((a) => <ApprovalCard key={a.request.approvalId} state={a} highlight={a.request.approvalId === scrollToApproval} />)}
          {run && isLast && run.warnings.map((w, i) => (
            <div key={i} className={cn('flex items-start gap-1 text-xs', tone.warningText)}><TriangleAlert size={11} className="mt-px shrink-0" /> {w}</div>
          ))}
          {run && isLast && <StatusLine run={run} />}
          {runError && <ErrorCard err={runError} canRetry={idle} />}
          {isLast && run?.done?.status === 'cancelled' && !turnText && !messages.some((m) => m.partial && m.stopReason === 'cancelled') && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              Stopped before an answer.
              {idle && (
                <Button size="sm" variant="secondary" leftIcon={RefreshCw} aria-label="Retry" onClick={() => void regenerate()}>Retry</Button>
              )}
            </div>
          )}
          {canContinue && (
            <div className="my-1 flex items-center gap-2 text-xs">
              <span className={limitReached ? tone.warningText : 'text-muted-foreground'}>
                {limitReached ? limitNotice || 'The answer reached the output limit.' : 'The assistant reached the step limit.'}
              </span>
              <Button size="sm" variant="secondary" leftIcon={Play} aria-label="Continue" onClick={() => void continueRun()}>Continue</Button>
            </div>
          )}
          {!(active && isLast) && (turnText || tokensIn > 0) && (
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {model && <span title="Model that answered">{model}</span>}
              {(tokensIn > 0 || tokensOut > 0) && <span title={inTitle}>{formatTokens(tokensIn)} in · {formatTokens(tokensOut)} out</span>}
              {cost ? <span title="Cost reported by the provider">{formatCost(cost)}</span> : null}
              {run?.done && isLast && run.done.durationMs > 0 && <span>{formatDuration(run.done.durationMs)}</span>}
              {runUsage?.turns && isLast ? <span>{runUsage.turns} {runUsage.turns === 1 ? 'turn' : 'turns'}</span> : null}
              {turnText && (
                <button type="button"
                  className={iconButton}
                  aria-label="Copy answer (markdown)"
                  title="Copy (markdown)"
                  onClick={async () => {
                    if (await copyText(turnText, 'Answer')) {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1200);
                    }
                  }}
                >
                  {copied ? <Check size={11} /> : <Copy size={11} />}
                </button>
              )}
              {isLast && idle && (
                <IconButton size="sm" icon={RefreshCw} label="Regenerate answer" onClick={() => void regenerate()} />
              )}
            </div>
          )}
        </div>
      </div>
    </MessageLinkContext.Provider>
  );
}
