import { useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle, Ban, Check, ChevronDown, ChevronRight, CircleHelp, Copy, EyeOff, ExternalLink, Loader2,
  PencilLine, Search, ShieldAlert, Sparkles, Table2, Wrench, X,
} from 'lucide-react';
import type { ApprovalState } from '../../lib/aiReducer';
import { copyText } from '../../lib/ai';
import { csvFromToolResult, formatDuration, hasInvisible, prettyJSON, resultErrorHint, stripWordJoiner } from '../../lib/aiFormat';
import { useEditorStore } from '../../stores/editorStore';
import { ApprovalCard } from './ApprovalCard';
import { resolvedText } from '../../lib/aiApproval';
import { SecretReveal } from './SecretReveal';
import { openInSearch } from './FilterLink';
import { InvisibleText } from './InvisibleText';
import { searchOf, type CardView } from './cardModel';
import { chip, textButton, tone } from './tone';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';

const STATUS: Record<string, { label: string; cls: string; icon: ReactNode }> = {
  queued: { label: 'queued', cls: 'text-muted-foreground', icon: <Loader2 size={11} className="opacity-60" /> },
  running: { label: 'running', cls: 'text-muted-foreground', icon: <Loader2 size={11} className="animate-spin" /> },
  awaiting_approval: { label: 'awaiting approval', cls: tone.warningText, icon: <ShieldAlert size={11} /> },
  finishing_write: { label: 'finishing write…', cls: tone.warningText, icon: <Loader2 size={11} className="animate-spin" /> },
  ok: { label: 'ok', cls: tone.successText, icon: <Check size={11} /> },
  error: { label: 'error', cls: tone.dangerText, icon: <X size={11} /> },
  denied: { label: 'denied', cls: tone.dangerText, icon: <Ban size={11} /> },
  cancelled: { label: 'cancelled', cls: 'text-muted-foreground', icon: <Ban size={11} /> },
  not_executed: { label: 'not executed', cls: 'text-muted-foreground', icon: <Ban size={11} /> },
  outcome_unknown: { label: 'outcome unknown', cls: tone.warningText, icon: <CircleHelp size={11} /> },
};

interface BadgeDef { key: string; label: string; title: string; icon: ReactNode; warn: boolean }

/** The safety/info badges of a card (also read out in the header's aria-label). */
function badgesOf(warnings: string[], args: string): BadgeDef[] {
  const has = (p: string) => warnings.some((w) => w.startsWith(p));
  const out: BadgeDef[] = [];
  if (has('possible_prompt_injection')) out.push({ key: 'inj', label: 'injection?', title: 'The result contained text that looks like instructions to the AI; it was framed as data', icon: <ShieldAlert size={10} />, warn: true });
  if (has('value_masked')) out.push({ key: 'mask', label: 'value hidden', title: 'A password-like value was hidden', icon: <EyeOff size={10} />, warn: false });
  if (has('value_sanitized')) out.push({ key: 'san', label: 'sanitized', title: 'Control or formatting characters were neutralized', icon: <EyeOff size={10} />, warn: false });
  if (has('salvaged_text_tool_call')) out.push({ key: 'salv', label: 'salvaged from text', title: 'The model wrote this call as text; LDAPilot recovered it', icon: <Sparkles size={10} />, warn: false });
  if (has('hidden_unicode') || hasInvisible(args)) out.push({ key: 'uni', label: 'invisible characters', title: 'Invisible characters are shown as ⟨U+…⟩', icon: <AlertTriangle size={10} />, warn: true });
  return out;
}

function JsonBlock({ text, label }: { text: string; label: string }) {
  const pretty = useMemo(() => prettyJSON(text), [text]);
  const lines = pretty.split('\n').length;
  const [expanded, setExpanded] = useState(lines <= 40);
  return (
    <div>
      <div className="flex items-center gap-1 text-muted-foreground">
        <span>{label}</span>
        <button type="button" className="rounded p-0.5 hover:text-foreground" aria-label={`Copy ${label.toLowerCase()}`} title="Copy" onClick={() => void copyText(pretty, label)}>
          <Copy size={11} />
        </button>
        {lines > 40 && (
          <button type="button" className="text-xs underline-offset-2 hover:underline" aria-label={expanded ? 'Collapse' : `Show all ${lines} lines`} onClick={() => setExpanded(!expanded)}>
            {expanded ? 'collapse' : `show all ${lines} lines`}
          </button>
        )}
      </div>
      <pre className={cn('overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-background p-1.5 font-mono text-xs', !expanded && 'max-h-60')}>
        <InvisibleText text={pretty} />
      </pre>
    </div>
  );
}

/**
 * One tool call (§10.2): collapsible card with status, duration, summary,
 * badges; arguments and the exact model-facing result in the body; the
 * approval card inline while a decision is needed.
 */
export function ToolCallCard({ card, approval, highlight }: { card: CardView; approval?: ApprovalState; highlight?: boolean }) {
  const [open, setOpen] = useState(false);
  const st = STATUS[card.status] ?? STATUS.queued;
  const write = card.kind === 'write';
  const search = searchOf(card);
  const csv = ['search_ldap', 'find_accounts', 'get_membership', 'find_by_name'].includes(card.name) ? card.result : undefined;
  const csvText = csv ? csvFromToolResult(card.name, csv) : null;
  const csvRows = csvText ? csvText.replace(/\r\n$/, '').split('\r\n').length - 1 : 0;
  const err = card.isError ? resultErrorHint(card.result) : null;
  const target = (() => {
    try {
      const a = JSON.parse(card.args) as Record<string, unknown>;
      return typeof a.dn === 'string' ? stripWordJoiner(a.dn) : '';
    } catch {
      return '';
    }
  })();

  const badges = badgesOf(card.warnings, card.args);
  // Read cards about one entry open it (A-22); writes have their own link.
  const canOpen = card.status === 'ok' && !!target && !!card.connectionId && ['get_entry', 'get_account_status', 'get_membership'].includes(card.name);

  return (
    <div className="my-1 min-w-0 rounded border border-border bg-card text-xs" data-tool-call-id={card.toolCallId}>
      {/* Wraps instead of overflowing: name, status and the safety badges stay inside the card at any panel width; the connection and the summary move to the next line when space is short. */}
      <button type="button"
        className="flex w-full min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 px-2 py-1 text-left hover:bg-accent"
        aria-expanded={open}
        aria-label={`${card.displayName} — ${st.label}${card.connectionLabel ? ` on ${card.connectionLabel}` : ''}${badges.length ? ` (${badges.map((b) => b.label).join(', ')})` : ''}. ${open ? 'Collapse' : 'Expand'} details`}
        onClick={() => setOpen(!open)}
      >
        <span className="flex min-w-0 max-w-full items-center gap-1.5">
          {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
          {write ? <PencilLine size={12} className={cn('shrink-0', tone.warningText)} /> : <Wrench size={12} className="shrink-0 text-muted-foreground" />}
          <span className="min-w-0 truncate font-medium" title={card.displayName}>{card.displayName}</span>
        </span>
        <span className={cn('flex shrink-0 items-center gap-0.5 whitespace-nowrap', st.cls)}>{st.icon}{st.label}</span>
        {card.durationMs !== undefined && card.durationMs > 0 && <span className="shrink-0 whitespace-nowrap text-muted-foreground">{formatDuration(card.durationMs)}</span>}
        {badges.map((b) => (
          <span key={b.key} className={cn(chip, 'shrink-0', b.warn && tone.warningText)} title={b.title}>{b.icon} {b.label}</span>
        ))}
        {card.connectionLabel && <span className="min-w-0 max-w-full truncate text-muted-foreground" title={card.connectionLabel}>· {card.connectionLabel}</span>}
        {card.summary && <span className="min-w-[6rem] flex-1 truncate text-muted-foreground" title={card.summary}>{card.summary}</span>}
      </button>

      {card.approval && !approval && (
        <div className="border-t border-border px-2 py-0.5 text-muted-foreground">
          {card.kind === 'write' ? 'Change: ' : 'Access: '}
          {resolvedText(card.approval.decision, card.approval.by, card.kind === 'write' ? 'write' : 'access')}
        </div>
      )}

      {open && (
        <div className="space-y-1.5 border-t border-border px-2 py-1.5">
          {card.rawArgs && (
            <div className={tone.warningText}>The model's arguments were unusable or normalized; original text: <code className="break-all font-mono">{card.rawArgs}</code></div>
          )}
          <JsonBlock text={card.args} label="Arguments" />
          {card.result !== undefined && card.result !== '' && <JsonBlock text={card.result} label="Result (as the model saw it)" />}
          {(card.cleared || card.shrunk) && (
            <div className="text-muted-foreground">
              {card.cleared ? 'This result was later removed from the model\'s context to save space.' : 'The model now sees a shortened version of this result.'}
            </div>
          )}
          {err && (card.errorCode || err.message) && (
            <div className={tone.dangerText}>
              {card.errorCode && <code className="mr-1 font-mono">{card.errorCode}</code>}
              {err.message}
              {err.hint && <div className="text-muted-foreground">{err.hint}</div>}
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            {canOpen && (
              <Button size="sm" variant="secondary" leftIcon={ExternalLink} aria-label="Open entry" title={target} onClick={() => useEditorStore.getState().openEntry(card.connectionId, target)}>Open entry</Button>
            )}
            {csvText && (
              <Button size="sm" variant="secondary" leftIcon={Table2} aria-label="Copy as CSV" title="Only the rows the assistant saw; Open in Search runs the full search" onClick={() => void copyText(csvText, 'Rows')}>
                {csvRows === 1 ? 'Copy this row as CSV' : `Copy these ${csvRows} rows as CSV`}
              </Button>
            )}
            {search && (
              <Button size="sm" variant="secondary" leftIcon={Search} aria-label="Open in Search" title={search.filter} onClick={() => openInSearch(search.filter, search.use)}>Open in Search</Button>
            )}
          </div>
        </div>
      )}

      {card.status === 'outcome_unknown' && target && card.connectionId && (
        <div className={cn('flex items-center gap-1 border-t border-border px-2 py-1', tone.warningText)}>
          <CircleHelp size={12} /> LDAPilot could not confirm whether this change was applied.
          <Button size="sm" variant="secondary" leftIcon={ExternalLink} aria-label="Open entry" onClick={() => useEditorStore.getState().openEntry(card.connectionId, target)}>Open entry</Button>
        </div>
      )}

      {card.name === 'reset_password' && <div className="px-2 pb-1"><SecretReveal toolCallId={card.toolCallId} /></div>}

      {approval && <div className="px-1.5 pb-1"><ApprovalCard state={approval} highlight={highlight} /></div>}
    </div>
  );
}
