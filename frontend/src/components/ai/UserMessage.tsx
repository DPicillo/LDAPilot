import { useState } from 'react';
import { AtSign, Check, ChevronDown, ChevronRight, Copy, CornerDownRight, EyeOff, FileText, Pencil, Scissors } from 'lucide-react';
import type { Message } from '../../types/ai';
import { copyText } from '../../lib/ai';
import { formatRelativeTime, rdnValue } from '../../lib/aiFormat';
import { useAIStore, userText } from '../../stores/aiStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { chip, iconButton } from './tone';
import { Markdown } from './Markdown';
import { cn } from '../../lib/utils';
import { IconButton } from '../ui/Button';

function levelOf(profileId: string): string {
  const cfg = useAIStore.getState().config;
  const e = cfg?.connectionAccess?.[profileId];
  return e?.level || cfg?.defaultAccess || 'ask';
}

/** "Selected entry" and @mentions sent with the message; items of none-level connections were withheld. */
function ContextChip({ m }: { m: Message }) {
  const profiles = useConnectionStore((s) => s.profiles);
  const ui = m.uiContext;
  if (!ui) return null;
  const items: { label: string; dn: string; profile: string; withheld: boolean; mention: boolean }[] = [];
  const name = (id: string) => profiles.find((p) => p.id === id)?.name ?? 'unknown connection';
  if (ui.selectedDn) items.push({ label: rdnValue(ui.selectedDn), dn: ui.selectedDn, profile: name(ui.selectedProfileId), withheld: levelOf(ui.selectedProfileId) === 'none', mention: false });
  for (const mn of ui.mentions ?? []) if (!(mn.dn === ui.selectedDn && mn.profileId === ui.selectedProfileId)) items.push({ label: rdnValue(mn.dn), dn: mn.dn, profile: name(mn.profileId), withheld: levelOf(mn.profileId) === 'none', mention: true });
  if (items.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {items.map((it, i) => (
        <span
          key={i}
          className={cn(chip, 'max-w-full')}
          title={`${it.mention ? 'Mentioned' : 'Selected'} entry on ${it.profile}: ${it.dn}${it.withheld ? '\nNot shared with the assistant (access level "none").' : ''}`}
        >
          {it.mention ? <AtSign size={10} /> : <FileText size={10} />}
          <span className="truncate">{it.label}</span>
          {it.withheld && <><EyeOff size={10} /> not shared</>}
        </span>
      ))}
    </div>
  );
}

export function UserMessage({ m, canEdit }: { m: Message; canEdit: boolean }) {
  const startEditLast = useAIStore((s) => s.startEditLast);
  const [copied, setCopied] = useState(false);
  const text = userText(m);
  return (
    <div className="group flex justify-end">
      <div className="max-w-[92%] rounded border border-border bg-secondary px-2.5 py-1.5 text-sm">
        <div className="whitespace-pre-wrap break-words">{text}</div>
        <ContextChip m={m} />
        <div className="mt-0.5 flex items-center justify-end gap-0.5 text-xs text-muted-foreground opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <span className="mr-1">{formatRelativeTime(m.createdAt)}</span>
          <button type="button"
            className={iconButton}
            aria-label="Copy message"
            title="Copy"
            onClick={async () => {
              if (await copyText(text, 'Message')) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }
            }}
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
          </button>
          {canEdit && (
            <IconButton size="sm" icon={Pencil} label="Edit and resend" onClick={() => startEditLast()} />
          )}
        </div>
      </div>
    </div>
  );
}

/** "Continue." messages appear as a small divider, not as a bubble. */
export function ContinueDivider() {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <div className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1"><CornerDownRight size={11} /> continued</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

/** Compaction summary: "Earlier messages summarized", expandable. */
export function CompactionDivider({ text, note }: { text: string; note?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs text-muted-foreground">
      <button type="button" className="flex w-full items-center gap-2" aria-expanded={open} aria-label="Show the summary of earlier messages" onClick={() => setOpen(!open)}>
        <div className="h-px flex-1 bg-border" />
        <span className="flex items-center gap-1">
          <Scissors size={11} /> Earlier messages summarized{note ? ` (${note})` : ''} {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <div className="h-px flex-1 bg-border" />
      </button>
      {open && <div className="mt-1 rounded border border-border px-2 py-1"><Markdown text={text} /></div>}
    </div>
  );
}
