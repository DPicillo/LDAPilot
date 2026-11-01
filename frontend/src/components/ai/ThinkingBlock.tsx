import { useEffect, useState } from 'react';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';

/**
 * Model reasoning, collapsed by default: "Thinking… 12 s" while streaming,
 * "Thought for 12 s" when done (§10.2).
 */
export function ThinkingBlock({ text, streaming, startedAt, endedAt }: { text: string; streaming: boolean; startedAt?: number; endedAt?: number }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [streaming]);

  const secs = startedAt ? Math.max(1, Math.round(((streaming ? now : endedAt ?? now) - startedAt) / 1000)) : 0;
  const label = streaming ? `Thinking…${secs ? ` ${secs} s` : ''}` : secs ? `Thought for ${secs} s` : 'Thoughts';

  return (
    <div className="my-1 rounded border border-border">
      <button type="button"
        className="flex w-full items-center gap-1 px-2 py-0.5 text-left text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        aria-label={open ? 'Hide reasoning' : 'Show reasoning'}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Brain size={12} className={streaming ? 'animate-pulse' : ''} />
        <span>{label}</span>
      </button>
      {open && (
        <div className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-border px-2 py-1 text-xs leading-relaxed text-muted-foreground">
          {text.trim() ? text : 'Reasoning hidden by provider'}
        </div>
      )}
    </div>
  );
}
