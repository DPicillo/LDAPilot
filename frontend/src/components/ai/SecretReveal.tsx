import { useEffect, useState } from 'react';
import { Copy, Eye, EyeOff, KeyRound } from 'lucide-react';
import { useAIStore } from '../../stores/aiStore';
import { copyText } from '../../lib/ai';
import { formatCountdown } from '../../lib/aiFormat';
import { textButton } from './tone';

/**
 * Tool calls whose password the user chose to show. Kept outside the
 * component because the card remounts when the finished run's transcript
 * replaces the live messages; memory only, like the value itself.
 */
const shownIds = new Set<string>();

/**
 * The generated password of a reset_password call (§6.7). The first Show or
 * Copy pulls it once with RevealSecret; it stays in memory only until it
 * expires (10 min), the chat is deleted or the app reloads.
 */
export function SecretReveal({ toolCallId }: { toolCallId: string }) {
  const secret = useAIStore((s) => s.secrets[toolCallId]);
  const reveal = useAIStore((s) => s.reveal);
  const [shown, setShownState] = useState(() => shownIds.has(toolCallId));
  const setShown = (v: boolean) => {
    if (v) shownIds.add(toolCallId);
    else shownIds.delete(toolCallId);
    setShownState(v);
  };
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!secret) return null;
  const left = secret.expiresAt - now;
  const gone = left <= 0 || (secret.revealed && secret.value === undefined);

  if (gone) {
    return (
      <div className="mt-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground">
        No longer available. Reset the password again if you did not save it.
      </div>
    );
  }

  const value = secret.value;
  return (
    <div className="mt-1 space-y-1 rounded border border-border px-2 py-1 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <KeyRound size={12} />
        <span>New password:</span>
        <code className="rounded bg-secondary px-1 font-mono" aria-live="polite">{shown && value !== undefined ? value : '••••••••'}</code>
        <button type="button"
          className={textButton}
          aria-label={shown ? 'Hide password' : 'Show password'}
          onClick={async () => {
            if (shown) { setShown(false); return; }
            const v = value ?? (await reveal(toolCallId));
            if (v !== null && v !== undefined) setShown(true);
          }}
        >
          {shown ? <EyeOff size={11} /> : <Eye size={11} />} {shown ? 'Hide' : 'Show'}
        </button>
        <button type="button"
          className={textButton}
          aria-label="Copy password"
          onClick={async () => {
            const v = value ?? (await reveal(toolCallId));
            if (v && (await copyText(v, 'Password'))) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }
          }}
        >
          <Copy size={11} /> {copied ? 'Copied' : 'Copy'}
        </button>
        <span className="text-muted-foreground">available for {formatCountdown(left)}</span>
      </div>
      <div className="text-muted-foreground">Shown only on this device for 10 minutes. It was not sent to the AI.</div>
    </div>
  );
}
