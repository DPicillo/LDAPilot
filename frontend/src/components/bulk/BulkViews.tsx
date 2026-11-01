/**
 * Shared views of the bulk features: attribute diffs, the compact dry-run
 * table, run progress and apply results with "Retry …" (batch modify dialog
 * and LDIF import dialog), and the run toast (notifyBulkRun: a run the user
 * stopped without failures is a warning, not an error).
 *
 * "Open in List" (DEF-17): the result view of a run offers the entries it
 * created or changed as a results tab (resultsSnapshots.openEntriesInList),
 * with the run's connection from `onOpenInList` or the surrounding
 * <BulkRunContext> (BulkDialogHost provides it for the batch dialog).
 */
import { createContext, useContext, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, CircleSlash, Download, Info, ListChecks, Lock, MinusCircle, RotateCcw, Server, ShieldAlert, Square, Unplug, XCircle } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useConnectionStore } from '../../stores/connectionStore'
import type { BulkApplyResult, BulkAttrDiff, BulkPasswordWarning, BulkPreviewEntry, BulkPreviewStatus, BulkProgress, BulkResultStatus } from '../../types/bulk'
import { dryRunRows, type DryRunRow } from '../../lib/bulk'
import { bulkPasswordOutcome } from '../../lib/passwordPolicy'
import { notifyBulkResult } from '../password/PasswordWriteGuard'
import { toast } from '../ui/Toast'
import { Badge, type BadgeTone } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { InlineAlert } from '../ui/InlineAlert'
import { ProgressBar, Spinner } from '../ui/Spinner'
import { DataTable, type DataTableColumn } from '../ui/DataTable'
import { touchedEntryDNs } from '../search/snapshotModel'
import { openEntriesInList } from '../search/resultsSnapshots'

/** The run a result view belongs to: connection, tab title, and how to close the dialog afterwards. */
export interface BulkRunInfo {
  profileId: string | null;
  /** Title of the "Open in List" tab ("Bulk modify"). */
  title: string;
  /** Closes the dialog once the list is open. */
  close?: () => void;
}

export const BulkRunContext = createContext<BulkRunInfo | null>(null);

/**
 * Opens the entries a run created or changed in a results tab; false when
 * there are none. The tab names the run and the count.
 */
export async function openRunInList(profileId: string, result: BulkApplyResult, title: string): Promise<boolean> {
  const dns = touchedEntryDNs(result.items || []);
  if (!dns.length) return false;
  try {
    await openEntriesInList(profileId, dns, `${title} (${dns.length})`, `${dns.length} ${dns.length === 1 ? 'entry' : 'entries'} created or changed by this run`);
    return true;
  } catch (err) {
    toast.error('Could not open the entries', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Name, read-only flag and connection state of a profile. */
export function useProfileInfo(profileId: string | null | undefined): { name: string; readOnly: boolean; connected: boolean } {
  const name = useConnectionStore((s) => s.profiles.find(p => p.id === profileId)?.name ?? '');
  const readOnly = useConnectionStore((s) => s.profiles.find(p => p.id === profileId)?.readOnly ?? false);
  const connected = useConnectionStore((s) => (profileId ? s.connectionStatuses[profileId] === true : false));
  return { name: name || (profileId ? 'unknown connection' : 'no connection'), readOnly, connected };
}

/**
 * The connection a bulk dialog reads from and writes to, with read-only and
 * disconnected badges. Shown in dialog headers and run summaries so that the
 * target directory is never ambiguous.
 */
export function ConnectionTag({ profileId, className }: { profileId: string | null | undefined; className?: string }) {
  const { name, readOnly, connected } = useProfileInfo(profileId);
  return (
    <span className={cn('inline-flex items-center gap-1 min-w-0 text-xs font-normal', className)} title={`Connection: ${name}`}>
      <Server size={12} className="shrink-0 text-muted-foreground" />
      <span className="truncate text-foreground">{name}</span>
      {readOnly && (
        <Badge tone="warning" icon={Lock} className="shrink-0">read-only</Badge>
      )}
      {profileId && !connected && (
        <Badge tone="danger" icon={Unplug} className="shrink-0">not connected</Badge>
      )}
    </span>
  );
}

/** Values of `after` that were already there (after minus added, multiset). */
function keptValues(diff: BulkAttrDiff): string[] {
  const added = new Map<string, number>();
  for (const v of diff.added || []) added.set(v, (added.get(v) || 0) + 1);
  const kept: string[] = [];
  for (const v of diff.after || []) {
    const n = added.get(v) || 0;
    if (n > 0) { added.set(v, n - 1); continue; }
    kept.push(v);
  }
  return kept;
}

const KEPT_SHOWN = 3;

/** Table of predicted attribute changes: removed values struck through, added values marked with "+". */
export function BulkDiffView({ diffs }: { diffs: BulkAttrDiff[] }) {
  if (!diffs || diffs.length === 0) return null;
  return (
    <div className="border border-border rounded overflow-hidden">
      {diffs.map((d, i) => {
        const kept = keptValues(d);
        const hiddenKept = Math.max(0, kept.length - KEPT_SHOWN) + Math.max(0, d.afterCount - (d.after || []).length);
        return (
          <div key={`${d.attribute}-${i}`} className={cn('flex gap-2 px-2 py-1 text-xs border-b border-border last:border-b-0', !d.changed && 'text-muted-foreground')}>
            <div className={cn('w-40 shrink-0 font-mono truncate', d.changed ? 'text-foreground' : 'text-muted-foreground')} title={d.attribute}>
              {d.attribute}
              <div className="text-xs text-muted-foreground">{(d.operations || []).join(' + ')}</div>
            </div>
            <div className="flex-1 min-w-0 space-y-0.5 font-mono">
              {(d.removed || []).map((v, j) => (
                <div key={`r${j}`} className="text-destructive break-all" title="removed">− <span className="line-through">{v === '' ? '(empty)' : v}</span></div>
              ))}
              {(d.added || []).map((v, j) => (
                <div key={`a${j}`} className="text-success break-all" title="added">+ {v === '' ? '(empty)' : v}</div>
              ))}
              {kept.slice(0, KEPT_SHOWN).map((v, j) => (
                <div key={`k${j}`} className="text-muted-foreground break-all" title="unchanged">  {v}</div>
              ))}
              {hiddenKept > 0 && (
                <div className="text-muted-foreground text-xs">… {hiddenKept} more unchanged value{hiddenKept !== 1 ? 's' : ''}</div>
              )}
              {!d.changed && (d.removed || []).length === 0 && (d.added || []).length === 0 && (
                <div className="text-muted-foreground text-xs">no change{d.beforeCount === 0 ? ' (attribute not present)' : ''}</div>
              )}
            </div>
            <div className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums" title="values before → after">
              {d.beforeCount} → {d.afterCount}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Error, warning and note lines of an entry or record. */
export function BulkMessages({ errors, warnings, notes }: { errors?: string[]; warnings?: string[]; notes?: string[] }) {
  if (!errors?.length && !warnings?.length && !notes?.length) return null;
  return (
    <div className="space-y-0.5 text-xs">
      {(errors || []).map((m, i) => (
        <div key={`e${i}`} className="flex items-start gap-1 text-destructive"><XCircle size={12} className="shrink-0 mt-0.5" /><span className="break-words min-w-0">{m}</span></div>
      ))}
      {(warnings || []).map((m, i) => (
        <div key={`w${i}`} className="flex items-start gap-1 text-warning"><AlertTriangle size={12} className="shrink-0 mt-0.5" /><span className="break-words min-w-0">{m}</span></div>
      ))}
      {(notes || []).map((m, i) => (
        <div key={`n${i}`} className="flex items-start gap-1 text-muted-foreground"><Info size={12} className="shrink-0 mt-0.5" /><span className="break-words min-w-0">{m}</span></div>
      ))}
    </div>
  );
}

/** Progress bar of a preview / apply run with a Stop button. */
export function BulkProgressView({ label, progress, total, stopping, onStop }: {
  label: string;
  progress: BulkProgress | null;
  total: number;
  stopping: boolean;
  onStop: () => void;
}) {
  const current = progress?.current ?? 0;
  const max = progress?.total || total || 1;
  return (
    <div className="space-y-2 p-3 border border-border rounded bg-background" aria-busy="true">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-foreground" role="status">
          <Spinner size="sm" decorative />
          {stopping ? 'Stopping…' : label}
        </span>
        <span className="flex items-center gap-3 text-muted-foreground tabular-nums">
          {progress && progress.phase === 'apply' && (
            <>
              <span className="text-success">{progress.succeeded} ok</span>
              {progress.failed > 0 && <span className="text-destructive">{progress.failed} failed</span>}
            </>
          )}
          <span>{current} / {max}</span>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={Square}
            onClick={onStop}
            disabled={stopping}
            title="Stop after the current entry; finished entries stay changed"
          >
            Stop
          </Button>
        </span>
      </div>
      <ProgressBar value={Math.min(current, max)} max={max} label={label} />
      <div className="text-xs text-muted-foreground truncate font-mono" title={progress?.dn}>{progress?.dn || '…'}</div>
    </div>
  );
}

const RESULT_STYLE: Record<BulkResultStatus, { label: string; className: string; icon: React.ElementType }> = {
  success: { label: 'succeeded', className: 'text-success', icon: CheckCircle2 },
  failed: { label: 'failed', className: 'text-destructive', icon: XCircle },
  skipped: { label: 'skipped', className: 'text-muted-foreground', icon: CircleSlash },
  unchanged: { label: 'unchanged', className: 'text-muted-foreground', icon: MinusCircle },
  notProcessed: { label: 'not processed', className: 'text-warning', icon: AlertTriangle },
};

export function ResultStatusIcon({ status }: { status: BulkResultStatus }) {
  const s = RESULT_STYLE[status] || RESULT_STYLE.failed;
  const Icon = s.icon;
  return <span title={s.label}><Icon size={12} className={cn('shrink-0', s.className)} /></span>;
}

const PASSWORD_WARNING_TITLE: Record<BulkPasswordWarning, string> = {
  ineffective: 'The new password will not work',
  cleartext: 'The password is stored in cleartext',
  unconfirmed: 'The server may not verify the password scheme',
  warning: 'Password storage warning',
};

function PasswordWarningIcon({ warning }: { warning: BulkPasswordWarning }) {
  const severe = warning === 'ineffective' || warning === 'cleartext';
  return (
    <span title={PASSWORD_WARNING_TITLE[warning] ?? 'Password warning'}>
      <ShieldAlert size={12} className={cn('shrink-0', severe ? 'text-destructive' : 'text-warning')} />
    </span>
  );
}

/** Items a retry runs again: failed and not processed (stopped run). */
export function retryItems(result: BulkApplyResult) {
  return (result.items || []).filter((it) => it.status === 'failed' || it.status === 'notProcessed');
}

/** "Retry 4 not processed" / "Retry 2 failed, 4 not processed". */
export function retryLabel(result: BulkApplyResult): string {
  const parts = [result.failed ? `${result.failed} failed` : '', result.notProcessed ? `${result.notProcessed} not processed` : ''].filter(Boolean);
  return `Retry ${parts.join(', ')}`;
}

/**
 * The toast of a bulk run: notifyBulkResult, except that a run the user
 * stopped without failures and password problems is a warning ("4 not
 * processed"), not an error; the result view offers "Retry …".
 */
export function notifyBulkRun(
  res: BulkApplyResult,
  texts: { success: string; partial: string },
): void {
  const pw = bulkPasswordOutcome(res);
  if (res.stopped && res.failed === 0 && !pw) {
    toast.warning(texts.partial, `${res.stopReason ? `Run stopped: ${res.stopReason}. ` : ''}The result offers "${retryLabel(res)}".`);
    return;
  }
  notifyBulkResult(res, texts);
}

/** Summary and item list of an apply run with a report download, "Retry …" and "Open in List". */
export function BulkResultView({ result, onDownload, showLines, onRetry, run: runProp }: {
  result: BulkApplyResult;
  onDownload: () => void;
  showLines?: boolean;
  /** Runs the failed and not processed items again (a dry run first). */
  onRetry?: () => void;
  /** The run's connection and tab title for "Open in List" (default: the surrounding BulkRunContext). */
  run?: BulkRunInfo;
}) {
  const [showAll, setShowAll] = useState(false);
  const ctxRun = useContext(BulkRunContext);
  const run = runProp ?? ctxRun;
  const touched = useMemo(() => touchedEntryDNs(result.items || []), [result.items]);
  const [opening, setOpening] = useState(false);
  const openInList = async () => {
    if (!run?.profileId || opening) return;
    setOpening(true);
    const ok = await openRunInList(run.profileId, result, run.title);
    setOpening(false);
    if (ok) run.close?.();
  };
  // A success whose written password needs attention (stored in cleartext,
  // will not work, …) is listed with the problems.
  const items = useMemo(
    () => (result.items || []).filter(it => showAll || it.status !== 'success' || !!it.passwordWarning),
    [result.items, showAll],
  );
  const passwordProblems = (result.passwordIneffective || 0) + (result.passwordCleartext || 0);
  const passwordWarnings = result.passwordWarnings || 0;
  const counts: [BulkResultStatus, number][] = [
    ['success', result.succeeded],
    ['failed', result.failed],
    ['skipped', result.skipped],
    ['unchanged', result.unchanged],
    ['notProcessed', result.notProcessed],
  ];
  return (
    <div className="space-y-2">
      <div className="flex items-center flex-wrap gap-x-4 gap-y-1">
        {counts.filter(([, n]) => n > 0).map(([status, n]) => {
          const s = RESULT_STYLE[status];
          const Icon = s.icon;
          return (
            <span key={status} className={cn('flex items-center gap-1 text-xs', s.className)}>
              <Icon size={12} /> {n} {s.label}
            </span>
          );
        })}
        {passwordProblems > 0 && (
          <span className="flex items-center gap-1 text-xs text-destructive" title="userPassword read back after the write">
            <ShieldAlert size={12} />
            {[
              result.passwordIneffective ? `${result.passwordIneffective} password${result.passwordIneffective === 1 ? '' : 's'} will not work` : '',
              result.passwordCleartext ? `${result.passwordCleartext} stored in cleartext` : '',
            ].filter(Boolean).join(', ')}
          </span>
        )}
        {passwordWarnings > 0 && (
          <span className="flex items-center gap-1 text-xs text-warning">
            <AlertTriangle size={12} /> {passwordWarnings} with password warnings
          </span>
        )}
        {result.total === 0 && <span className="text-xs text-muted-foreground">Nothing to do</span>}
        <span className="ml-auto flex items-center gap-1.5">
          {run?.profileId && touched.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              leftIcon={ListChecks}
              loading={opening}
              onClick={() => void openInList()}
              title="Show the entries this run created or changed as a list in a tab (select, export, bulk actions)"
            >
              Open {touched.length} in List
            </Button>
          )}
          {onRetry && retryItems(result).length > 0 && (
            <Button size="sm" variant="secondary" leftIcon={RotateCcw} onClick={onRetry} title="Check these items in a dry run again, then apply them">
              {retryLabel(result)}
            </Button>
          )}
          <Button size="sm" variant="secondary" leftIcon={Download} onClick={onDownload}>
            Download report
          </Button>
        </span>
      </div>
      {result.stopped && (
        <InlineAlert tone="warning" body={`Run stopped: ${result.stopReason || 'stopped'}. Entries already written stay changed.`} />
      )}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{showAll ? 'All items' : 'Items that need attention'} ({items.length})</span>
        <Checkbox checked={showAll} onCheckedChange={setShowAll} label={<span className="text-xs">Show successful items too</span>} />
      </div>
      {items.length === 0 && result.total > 0 && (
        <div className="text-xs text-muted-foreground px-2 py-3 border border-dashed border-border rounded text-center">
          Nothing needs attention.
        </div>
      )}
      {items.length > 0 && (
        <div className="border border-border rounded bg-background max-h-[260px] overflow-auto">
          {items.slice(0, 1000).map((it, i) => (
            <div key={i} className="flex items-start gap-1.5 px-2 py-1 border-b border-border last:border-b-0 text-xs">
              <ResultStatusIcon status={it.status} />
              {it.passwordWarning && <PasswordWarningIcon warning={it.passwordWarning} />}
              <div className="min-w-0 flex-1">
                <div className="font-mono text-foreground break-all">
                  {showLines && it.line ? <span className="text-muted-foreground mr-1.5">L{it.line}</span> : null}
                  {it.operation && <span className="text-muted-foreground mr-1.5">{it.operation}</span>}
                  {it.dn}
                  {it.newDn && <span className="text-muted-foreground"> → {it.newDn}</span>}
                </div>
                {it.message && (
                  <div className={cn(
                    'break-words',
                    it.status === 'failed' || it.passwordWarning === 'ineffective' || it.passwordWarning === 'cleartext'
                      ? 'text-destructive'
                      : it.passwordWarning ? 'text-warning' : 'text-muted-foreground',
                  )}
                  >
                    {it.message}
                  </div>
                )}
              </div>
            </div>
          ))}
          {items.length > 1000 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">… {items.length - 1000} more in the report</div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Compact dry-run table (batch modify) ---------------------------------------

const PREVIEW_STATUS: Record<BulkPreviewStatus, { label: string; tone: BadgeTone }> = {
  change: { label: 'will change', tone: 'primary' },
  unchanged: { label: 'unchanged', tone: 'neutral' },
  skipped: { label: 'skipped', tone: 'neutral' },
  error: { label: 'error', tone: 'danger' },
};

const dryRunColumns: DataTableColumn<DryRunRow>[] = [
  {
    id: 'status',
    header: 'Status',
    width: 104,
    sortable: true,
    value: (r) => r.entry.status,
    cell: (r) => <Badge tone={PREVIEW_STATUS[r.entry.status]?.tone ?? 'danger'}>{PREVIEW_STATUS[r.entry.status]?.label ?? r.entry.status}</Badge>,
  },
  {
    id: 'entry',
    header: 'Entry',
    width: 200,
    sortable: true,
    value: (r) => r.entry.dn,
    cell: (r) => (
      <span className="block min-w-0 truncate font-mono" title={r.entry.dn}>
        {r.rdn}
        <span className="text-muted-foreground">{r.parent ? `,${r.parent}` : ''}</span>
      </span>
    ),
  },
  { id: 'attribute', header: 'Attribute', width: 130, sortable: true, mono: true, value: (r) => r.attribute },
  {
    id: 'before',
    header: 'Before',
    width: 180,
    value: (r) => r.before,
    cell: (r) => <span className="block truncate font-mono text-destructive" title={r.before}>{r.before && r.before !== r.after ? r.before : <span className="text-muted-foreground">{r.before}</span>}</span>,
  },
  {
    id: 'after',
    header: 'After',
    width: 180,
    value: (r) => r.after,
    cell: (r) => <span className="block truncate font-mono text-success" title={r.after}>{r.after || (r.attribute ? <span className="text-muted-foreground">(removed)</span> : '')}</span>,
  },
  {
    id: 'messages',
    header: 'Messages',
    minWidth: 160,
    value: (r) => r.messages,
    cell: (r) => <span className={cn('block truncate', r.entry.status === 'error' ? 'text-destructive' : 'text-muted-foreground')} title={r.messages}>{r.messages}</span>,
  },
];

/** Dry run of a batch modify as one table (DN · attribute · before · after): thousands of entries stay checkable. */
export function BulkDryRunTable({ entries, className }: { entries: BulkPreviewEntry[]; className?: string }) {
  const rows = useMemo(() => dryRunRows(entries), [entries]);
  return (
    <div className={cn('border border-border rounded overflow-hidden min-h-[160px] h-[340px]', className)}>
      <DataTable<DryRunRow>
        aria-label="Dry run"
        columns={dryRunColumns}
        rows={rows}
        rowKey={(r) => r.key}
        virtualized
        persistKey="bulk-dry-run"
        getRowDn={(r) => r.entry.dn}
        empty={<div className="text-sm text-muted-foreground py-4 text-center">No entries in this view</div>}
      />
    </div>
  );
}
