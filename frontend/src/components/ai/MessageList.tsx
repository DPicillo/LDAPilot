import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, Info, RefreshCw, X } from 'lucide-react';
import type { Block, CompactionMarker, Message } from '../../types/ai';
import { runActive, type RunState } from '../../lib/aiReducer';
import { useAIStore, isUserTextMessage } from '../../stores/aiStore';
import { AssistantTurn } from './AssistantMessage';
import { CompactionDivider, ContinueDivider, UserMessage } from './UserMessage';
import { Markdown } from './Markdown';
import { iconButton, textButton } from './tone';
import { Button } from '../ui/Button';

/** `at` (unix ms) orders local notices between the items. */
type Item =
  | { kind: 'user'; m: Message; at: number }
  | { kind: 'continue'; id: string; at: number }
  | { kind: 'summary'; id: string; text: string; note?: string; at: number }
  | { kind: 'turn'; id: string; messages: Message[]; at: number };

function onlyToolResults(m: Message): boolean {
  const bs = m.blocks ?? [];
  return bs.length > 0 && bs.every((b) => b.type === 'tool_result' || (b.type === 'text' && b.meta?.kind === 'context'));
}

/** Groups the transcript into user bubbles, dividers and assistant turns. */
function buildItems(messages: Message[], compactions: CompactionMarker[]): { items: Item[]; results: Record<string, Block> } {
  const items: Item[] = [];
  const markers = new Map(compactions.map((c) => [c.upToMessageId, c]));
  const results: Record<string, Block> = {};
  let turn: Message[] | null = null;
  const flush = () => {
    if (turn && turn.length) items.push({ kind: 'turn', id: turn[0].id, messages: turn, at: turn[0].createdAt });
    turn = null;
  };
  const afterMessage = (m: Message) => {
    // Older messages stay visible; the divider marks where the model's view was summarized.
    const c = markers.get(m.id);
    if (!c) return;
    flush();
    items.push({ kind: 'summary', id: 'compaction-' + c.id, text: c.summary, note: `${c.tokensBefore} → ${c.tokensAfter} tokens`, at: c.at || m.createdAt });
  };
  for (const m of messages) {
    if (m.role === 'assistant') {
      (turn ??= []).push(m);
      afterMessage(m);
      continue;
    }
    for (const b of m.blocks ?? []) if (b.type === 'tool_result' && b.toolUseId) results[b.toolUseId] = b;
    if (onlyToolResults(m)) continue; // tool rounds stay inside the turn
    const blocks = m.blocks ?? [];
    const summary = blocks.find((b) => b.type === 'text' && b.meta?.kind === 'summary');
    if (summary) {
      flush();
      items.push({ kind: 'summary', id: m.id, text: summary.text ?? '', at: m.createdAt });
      if (!isUserTextMessage(m)) continue;
    }
    if (blocks.some((b) => b.meta?.kind === 'continue') && !isUserTextMessage(m)) {
      // "Continue." is a small divider between the two parts of the answer
      flush();
      items.push({ kind: 'continue', id: m.id, at: m.createdAt });
      continue;
    }
    if (!isUserTextMessage(m)) continue;
    flush();
    items.push({ kind: 'user', m, at: m.createdAt });
    afterMessage(m);
  }
  flush();
  return { items, results };
}

/**
 * Message list (§10.2): sticks to the bottom unless the user scrolled up
 * ("Jump to latest"); hides user messages that only carry tool results;
 * shows compaction dividers.
 */
export function MessageList({ chatId, messages, run, footer }: { chatId: string; messages: Message[]; run: RunState | null; footer?: ReactNode }) {
  const hideThinking = useAIStore((s) => !!s.config?.hideThinking);
  const scrollToApproval = useAIStore((s) => s.scrollToApproval);
  const notices = useAIStore((s) => s.notices[chatId]);
  const sendNonce = useAIStore((s) => s.sendNonce);
  const clearNotices = useAIStore((s) => s.clearNotices);
  const ref = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const userExpand = useRef(0);
  const [showJump, setShowJump] = useState(false);

  const compactions = useAIStore((s) => s.chatMeta[chatId]?.compactions);
  const { items, results } = useMemo(() => buildItems(messages, compactions ?? []), [messages, compactions]);
  const active = runActive(run);
  const idle = !active;

  // Which turn the run belongs to: the turn with its messages, else a new live turn.
  const liveMsgs = run && !run.settled ? run.liveMessages : [];
  let runTurnIndex = -1;
  if (run) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'turn' && it.messages.some((m) => m.runId === run.runId)) { runTurnIndex = i; break; }
      if (it.kind === 'user') break;
    }
  }
  const lastItem = items[items.length - 1];
  // A run stopped before any answer still gets a (small) turn: "Stopped" + Retry.
  const stoppedEmpty = !!run && run.done?.status === 'cancelled' && lastItem?.kind === 'user' && lastItem.m.id === run.userMessageId;
  const needLiveTurn = !!run && runTurnIndex < 0 && (active || liveMsgs.length > 0 || !!run.error || stoppedEmpty || (!run.settled && run.toolOrder.length > 0));
  const lastTurnIndex = (() => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'turn') return i;
    return -1;
  })();
  const lastIsTurn = items.length > 0 && items[items.length - 1].kind === 'turn';

  // Keep the view pinned to the bottom while content grows — except right
  // after the user expanded something (a card, thinking, details): that
  // content grows below the clicked header, which must stay in view.
  const keepPinned = () => {
    const el = ref.current;
    if (!el || !stick.current) return;
    if (Date.now() - userExpand.current < 800) {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      stick.current = atBottom;
      setShowJump(!atBottom);
      return;
    }
    el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(() => keepPinned());
  useEffect(() => {
    const el = ref.current;
    const content = inner.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => keepPinned());
    ro.observe(content);
    return () => ro.disconnect();
  }, []);
  const noteExpand = (e: { target: EventTarget | null }) => {
    if (e.target instanceof Element && e.target.closest('[aria-expanded]')) userExpand.current = Date.now();
  };
  useEffect(() => {
    stick.current = true;
    setShowJump(false);
  }, [chatId]);
  // Sending always follows the conversation again, also after the user
  // scrolled up or expanded a card (A-30).
  useLayoutEffect(() => {
    if (!sendNonce) return;
    stick.current = true;
    userExpand.current = 0;
    setShowJump(false);
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sendNonce]);
  useEffect(() => {
    if (!scrollToApproval) return;
    const t = setTimeout(() => {
      const el = ref.current?.querySelector(`[data-approval-id="${CSS.escape(scrollToApproval)}"]`);
      if (el) {
        stick.current = false;
        el.scrollIntoView({ block: 'center' });
        useAIStore.setState({ scrollToApproval: null });
      }
    }, 50);
    return () => clearTimeout(t);
  }, [scrollToApproval, items.length, run?.approvals]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stick.current = atBottom;
    setShowJump(!atBottom);
  };

  const lastUserIdx = (() => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user') return i;
    return -1;
  })();

  const renderItem = (it: Item, i: number): ReactNode => {
    switch (it.kind) {
      case 'user':
        return <UserMessage key={it.m.id} m={it.m} canEdit={idle && i === lastUserIdx && !it.m.id.startsWith('local-')} />;
      case 'continue':
        return <ContinueDivider key={it.id} />;
      case 'summary':
        return <CompactionDivider key={it.id} text={it.text} note={it.note} />;
      case 'turn': {
        const own = i === runTurnIndex;
        const isLast = i === lastTurnIndex && !needLiveTurn && lastIsTurn;
        return (
          <AssistantTurn
            key={it.id}
            messages={it.messages}
            results={results}
            run={own ? run : null}
            live={own ? liveMsgs : []}
            isLast={isLast}
            idle={idle}
            hideThinking={hideThinking}
            scrollToApproval={scrollToApproval}
          />
        );
      }
      default:
        return null;
    }
  };

  // Local notices (/help, /model) are shown where they were added, between
  // the messages, never sent to the assistant.
  const noticeList = notices ?? [];
  const shownNotices = new Set<string>();
  const noticesBefore = (at: number): ReactNode[] => {
    const out: ReactNode[] = [];
    for (const n of noticeList) {
      if (shownNotices.has(n.id) || n.at > at) continue;
      shownNotices.add(n.id);
      out.push(
        <div key={n.id} className="rounded border border-dashed border-border px-2 py-1.5 text-xs">
          <div className="mb-0.5 flex items-center gap-1 text-muted-foreground">
            <Info size={11} /> Shown only to you, not sent to the assistant
            <button type="button" className={iconButton + ' ml-auto'} aria-label="Dismiss" onClick={() => {
              clearNotices(chatId);
              // the button disappears: keep the focus in the chat (A-30)
              const st = useAIStore.getState();
              st.setComposerText(st.composerText, true);
            }}>
              <X size={11} />
            </button>
          </div>
          <Markdown text={n.text} />
        </div>,
      );
    }
    return out;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={ref} onScroll={onScroll} onPointerDownCapture={noteExpand} onKeyDownCapture={noteExpand} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 py-2" role="log" aria-label="Chat messages" aria-live="off">
        <div ref={inner} className="space-y-2.5">
          {items.map((it, i) => {
            const before = noticesBefore(it.at - 1);
            const el = renderItem(it, i);
            return before.length ? [...before, el] : el;
          })}

          {needLiveTurn && run && noticesBefore(run.startedAt - 1)}
          {needLiveTurn && run && (
            <AssistantTurn
              key={'live-' + run.runId}
              messages={[]}
              results={results}
              run={run}
              live={liveMsgs}
              isLast
              idle={idle}
              hideThinking={hideThinking}
              scrollToApproval={scrollToApproval}
            />
          )}
          {idle && !needLiveTurn && lastItem?.kind === 'user' && !lastItem.m.id.startsWith('local-') && (
            <div className="flex items-center gap-2 pl-5 text-xs text-muted-foreground">
              {/* A failed run of this session shows its error card instead (needLiveTurn); here the cause is not known (A-19). */}
              No answer was saved for this message.
              <Button size="sm" variant="secondary" leftIcon={RefreshCw} aria-label="Retry" onClick={() => void useAIStore.getState().regenerate()}>Retry</Button>
            </div>
          )}
          {noticesBefore(Number.MAX_SAFE_INTEGER)}
          {footer}
        </div>
      </div>
      {/* A strip under the list, not a floating button: floating, it covered the
          buttons of the card under it (S4). */}
      {showJump && (
        <div className="flex shrink-0 justify-center border-t border-border bg-sidebar py-0.5">
          <button type="button"
            className={textButton}
            aria-label="Jump to latest"
            onClick={() => {
              const el = ref.current;
              if (el) el.scrollTop = el.scrollHeight;
              stick.current = true;
              setShowJump(false);
            }}
          >
            <ArrowDown size={11} /> Jump to latest
          </button>
        </div>
      )}
    </div>
  );
}
