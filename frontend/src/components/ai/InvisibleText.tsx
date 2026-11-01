import { codePointLabel, splitInvisible } from '../../lib/aiFormat';
import { tone } from './tone';
import { cn } from '../../lib/utils';

/** Renders text with invisible characters shown as visible ⟨U+200B⟩ chips (§10.4). */
export function InvisibleText({ text, className }: { text: string; className?: string }) {
  const parts = splitInvisible(text);
  if (parts.length === 1 && !parts[0].invisible) return <span className={className}>{text}</span>;
  return (
    <span className={className}>
      {parts.map((p, i) =>
        p.invisible ? (
          <span
            key={i}
            title="Invisible character"
            className={cn('mx-px rounded border px-0.5 font-mono text-xs', tone.warningText, tone.warningBorder)}
          >
            ⟨{codePointLabel(p.text)}⟩
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  );
}
