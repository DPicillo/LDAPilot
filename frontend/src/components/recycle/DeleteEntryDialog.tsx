import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, FolderTree, Square, Trash2, XCircle } from 'lucide-react'
import { cn } from '../../lib/utils'
import * as wails from '../../lib/wails'
import * as recycle from '../../lib/wails-recycle'
import {
  deepestFirst, deleteConfirmation, deletedEvents, deleteReportText, deleteToastText, deletionRoots, describeCount,
  entryName, firstRDN, isNamingContextDN, TYPED_DELETE_THRESHOLD, isNamingContextNode, planDeletion, progressPercent, typedConfirmationMatches,
  type DeleteOutcomeSummary, type DeleteReportOutcome,
} from '../../lib/recycle'
import type { DescendantCount, SubtreeDeleteMethod, SubtreeDeleteProgress } from '../../types/recycle'
import { toast } from '../ui/Toast'
import { refreshAfterDelete } from './refreshTree'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Checkbox, RadioGroup } from '../ui/Checkbox'
import { Field } from '../ui/Field'
import { Input } from '../ui/Input'
import { Spinner } from '../ui/Spinner'
import { ensureServerInfo } from '../ui/commands'
import { useTreeStore } from '../../stores/treeStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useRecycleStore } from '../../stores/recycleStore'
import { emitEntryDeleted } from '../lifecycle/events'
import { getBinding } from '../../lib/wails'
import { descendantListLimit, descendantListSummary, descendantRows } from './descendantList'

/** services.DescendantList: the first entries below a DN, breadth first (DEF-20). */
interface DescendantList { dn: string; dns: string[]; truncated: boolean }

async function listDescendants(profileId: string, dn: string, limit: number): Promise<DescendantList | null> {
  const svc = getBinding('BrowserService');
  if (!svc?.ListDescendants) return null;
  return svc.ListDescendants(profileId, dn, limit);
}

interface DeleteEntryDialogProps {
  profileId: string;
  /** Entries to delete (one or many; DNs below another selected DN are covered by it). */
  dns: string[];
  onClose: () => void;
  /**
   * Called after the run with the outcome of every root. The directory tree
   * and the search results are refreshed by the dialog itself (also after a
   * stopped or partly failed run).
   */
  onDeleted?: (outcomes: DeleteOutcomeSummary[]) => void;
}

type Phase = 'counting' | 'confirm' | 'running' | 'done';

interface RootOutcome extends DeleteReportOutcome {
  /** deleted is a lower bound (tree delete of more entries than counted) */
  deletedCapped?: boolean;
}

let opCounter = 0;
const newOperationId = () => `del-${Date.now().toString(36)}-${++opCounter}`;

/**
 * Delete confirmation with descendant check: counts the children of every
 * entry first; entries with children are only deleted recursively after an
 * explicit confirmation ("delete including all N children"), via the tree
 * delete control or client-side with progress, stop and a final report.
 * The confirmation lists the first descendants of every root as a tree
 * (DEF-20), next to the count and the typed confirmation.
 */
export function DeleteEntryDialog({ profileId, dns, onClose, onDeleted }: DeleteEntryDialogProps) {
  // Fixed for the lifetime of the dialog: the parent re-renders (and passes a
  // new array) e.g. when the tree refreshes after the delete; recounting then
  // would throw the report away.
  const [roots] = useState(() => deletionRoots(dns));
  const [phase, setPhase] = useState<Phase>('counting');
  const [counts, setCounts] = useState<Record<string, DescendantCount | undefined>>({});
  const [countErrors, setCountErrors] = useState<Record<string, string>>({});
  const [method, setMethod] = useState<SubtreeDeleteMethod>('auto');
  const [stopOnError, setStopOnError] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [typed, setTyped] = useState('');
  const [namingContexts, setNamingContexts] = useState<string[]>([]);
  const [progress, setProgress] = useState<SubtreeDeleteProgress | null>(null);
  const [currentRoot, setCurrentRoot] = useState<{ index: number; dn: string } | null>(null);
  const [outcomes, setOutcomes] = useState<RootOutcome[]>([]);
  const [stopping, setStopping] = useState(false);
  const opIdRef = useRef<string | null>(null);
  const stopRef = useRef(false);
  /** First descendants per root (undefined = still listing, null = could not be listed). */
  const [listed, setListed] = useState<Record<string, DescendantList | null | undefined>>({});

  // 1. Count descendants of every root.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result: Record<string, DescendantCount | undefined> = {};
      const errors: Record<string, string> = {};
      const queue = [...roots];
      const worker = async () => {
        for (let dn = queue.shift(); dn !== undefined; dn = queue.shift()) {
          try {
            result[dn] = await recycle.CountDescendants(profileId, dn);
          } catch (err: any) {
            errors[dn] = err?.message || String(err);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, roots.length) }, worker));
      if (cancelled) return;
      setCounts(result);
      setCountErrors(errors);
      setPhase('confirm');
    })();
    return () => { cancelled = true; };
  }, [profileId, roots]);

  // 1b. List the first descendants of the roots that have children (unlogged one-level reads).
  useEffect(() => {
    if (phase !== 'confirm') return;
    const withKids = roots.filter((dn) => (counts[dn]?.count ?? 0) > 0);
    if (!withKids.length) return;
    let cancelled = false;
    const limit = descendantListLimit(withKids.length);
    const queue = [...withKids];
    const worker = async () => {
      for (let dn = queue.shift(); dn !== undefined; dn = queue.shift()) {
        let res: DescendantList | null = null;
        try {
          res = await listDescendants(profileId, dn, limit);
        } catch {
          res = null;
        }
        if (cancelled) return;
        const root = dn;
        setListed((prev) => ({ ...prev, [root]: res }));
      }
    };
    void Promise.all(Array.from({ length: Math.min(2, withKids.length) }, worker));
    return () => { cancelled = true; };
  }, [phase, profileId, roots, counts]);

  // Naming contexts of the server: deleting one of them deletes a whole directory partition.
  useEffect(() => {
    let cancelled = false;
    ensureServerInfo(profileId).then((info) => { if (!cancelled && info) setNamingContexts(info.namingContexts ?? []); });
    return () => { cancelled = true; };
  }, [profileId]);

  // Progress events of the running subtree delete.
  useEffect(() => recycle.onSubtreeDeleteProgress((p) => {
    if (p.operationId === opIdRef.current) setProgress(p);
  }), []);

  const plan = useMemo(() => planDeletion(roots, counts), [roots, counts]);
  const recursive = plan.withChildren.length > 0;
  const isAD = Object.values(counts).some((c) => c?.serverType === 'ad');
  const effectiveMethod: 'treeDelete' | 'clientSide' =
    method === 'clientSide' || !plan.treeDeleteSupported ? 'clientSide' : 'treeDelete';
  const totalEntries = roots.length + plan.totalDescendants;
  const totalText = describeCount(totalEntries, plan.anyCapped);
  const childText = describeCount(plan.totalDescendants, plan.anyCapped);
  const treeRoots = useTreeStore((s) => s.rootNodes[profileId]);
  const confirmation = useMemo(() => deleteConfirmation(
    roots,
    (dn) => isNamingContextDN(dn, namingContexts) || isNamingContextNode(dn, treeRoots ?? []),
    totalEntries,
    recursive,
  ), [roots, namingContexts, treeRoots, totalEntries, recursive]);
  const typedOK = typedConfirmationMatches(confirmation, typed);
  const confirmed = confirmation.kind === 'checkbox' ? acknowledged : confirmation.kind === 'none' ? true : typedOK;
  const profileName = useConnectionStore((s) => s.profiles.find((p) => p.id === profileId)?.name ?? '');

  const running = phase === 'running';
  const handleClose = useCallback(() => {
    if (!running) onClose();
  }, [running, onClose]);


  // 2. Run: plain deletes for leaves (deepest first), recursive deletes for the rest.
  async function execute() {
    setPhase('running');
    stopRef.current = false;
    const results: RootOutcome[] = [];
    const ordered: { dn: string; recursive: boolean }[] = [
      ...deepestFirst(plan.leaves).map((dn) => ({ dn, recursive: false })),
      ...plan.withChildren.map((r) => ({ dn: r.dn, recursive: true })),
    ];

    for (let i = 0; i < ordered.length; i++) {
      if (stopRef.current) break;
      const { dn, recursive: rec } = ordered[i];
      setCurrentRoot({ index: i, dn });
      setProgress(null);
      if (!rec) {
        try {
          await wails.DeleteEntry(profileId, dn);
          results.push({ dn, ok: true, deleted: 1, failed: 0, skipped: 0, cancelled: false, method: 'plain', errors: [], deletedDNs: [dn] });
        } catch (err: any) {
          const message = err?.message || String(err);
          results.push({ dn, ok: false, deleted: 0, failed: 1, skipped: 0, cancelled: false, method: 'plain', errors: [{ dn, message }] });
          if (stopOnError) break;
        }
        continue;
      }
      const operationId = newOperationId();
      opIdRef.current = operationId;
      try {
        const res = await recycle.DeleteSubtree(profileId, dn, {
          operationId, method: effectiveMethod, stopOnError, confirmed: true,
        });
        const ok = res.failed === 0 && res.skipped === 0 && !res.cancelled;
        results.push({
          dn, ok, deleted: res.deleted, deletedCapped: !!res.totalCapped, deletedUnknown: !!res.deletedUnknown,
          failed: res.failed, skipped: res.skipped, cancelled: res.cancelled, method: res.method, errors: res.errors ?? [],
          deletedDNs: res.deletedDNs ?? [], deletedDNsTruncated: !!res.deletedDNsTruncated,
        });
        if (res.cancelled) stopRef.current = true;
        if (!ok && stopOnError) break;
      } catch (err: any) {
        const message = err?.message || String(err);
        results.push({ dn, ok: false, deleted: 0, failed: 1, skipped: 0, cancelled: false, method: effectiveMethod, errors: [{ dn, message }] });
        if (stopOnError) break;
      } finally {
        opIdRef.current = null;
      }
    }

    // Refresh the tree for every root where something was deleted, also
    // when the run was stopped or partly failed; tell the other views.
    refreshAfterDelete(profileId, results);
    for (const ev of deletedEvents(results)) emitEntryDeleted(profileId, ev.dn, ev.subtree);
    onDeleted?.(results);
    const goneRoots = results.filter((r) => r.ok).map((r) => r.dn);
    // AD: the toast offers the Deleted Objects view (restore).
    const restoreAction = isAD && goneRoots.length > 0
      ? { action: { label: 'Restore…', run: () => useRecycleStore.getState().openDeletedObjects(profileId, '', { focusDN: goneRoots.length === 1 ? goneRoots[0] : undefined }) } }
      : undefined;

    const deleted = results.reduce((n, r) => n + r.deleted, 0);
    const failed = results.reduce((n, r) => n + r.failed, 0);
    const deletedText = describeCount(deleted, results.some((r) => r.deletedCapped));
    const stopped = stopRef.current || results.some((r) => r.cancelled);
    const complete = failed === 0 && !stopped && results.length === ordered.length;

    // A plain delete of entries without children needs no report: toast and close.
    if (complete && results.every((r) => r.ok && r.method === 'plain')) {
      toast.success(deleteToastText(goneRoots), restoreAction);
      onClose();
      return;
    }

    setOutcomes(results);
    setCurrentRoot(null);
    setPhase('done');
    setStopping(false);

    const unknown = results.some((r) => r.deletedUnknown);
    if (complete) {
      toast.success(goneRoots.length === 1 && deleted > 1
        ? `${entryName(goneRoots[0])} and ${describeCount(deleted - 1, results.some((r) => r.deletedCapped))} ${deleted - 1 === 1 && !results.some((r) => r.deletedCapped) ? 'entry' : 'entries'} below it deleted`
        : `${deletedText} ${deleted === 1 ? 'entry' : 'entries'} deleted`, restoreAction);
    } else if (failed === 0 && stopped) {
      toast.info(`Stopped: ${deletedText} ${deleted === 1 ? 'entry' : 'entries'} deleted`, restoreAction);
    } else if (deleted > 0 || unknown) {
      toast.error(
        unknown ? 'Tree delete failed; some entries may already be deleted' : `Deleted ${deleted.toLocaleString()} entries, ${failed} failed`,
        'See the delete report for details.',
      );
    } else {
      toast.error('Delete failed', results.flatMap((r) => r.errors).map((e) => `${e.dn}: ${e.message}`).join('\n') || undefined);
    }
  }

  async function stop() {
    stopRef.current = true;
    setStopping(true);
    if (opIdRef.current) await recycle.CancelSubtreeDelete(opIdRef.current);
  }

  function copyReport() {
    navigator.clipboard.writeText(deleteReportText(outcomes, profileName)).then(
      () => toast.info('Report copied'),
      () => toast.error('Could not copy the report'),
    );
  }

  const single = roots.length === 1;
  const title = phase === 'done' ? 'Delete Report'
    : recursive ? (single ? 'Delete Entry and Children' : `Delete ${roots.length} Entries and Children`)
    : (single ? 'Delete Entry' : `Delete ${roots.length} Entries`);
  const pct = progressPercent(progress);
  const allDeleted = outcomes.reduce((n, o) => n + o.deleted, 0);
  const allDeletedCapped = outcomes.some((o) => o.deletedCapped);
  const anyDeletedUnknown = outcomes.some((o) => o.deletedUnknown);
  const allFailed = outcomes.reduce((n, o) => n + o.failed, 0);
  const allSkipped = outcomes.reduce((n, o) => n + o.skipped, 0);
  const wasCancelled = outcomes.some((o) => o.cancelled) || (stopRef.current && phase === 'done');

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && handleClose()}
      role="alertdialog"
      size="md"
      icon={phase === 'done'
              ? (allFailed === 0 && !wasCancelled ? <CheckCircle2 size={16} strokeWidth={1.75} aria-hidden className="text-success" /> : <AlertTriangle size={16} strokeWidth={1.75} aria-hidden className="text-destructive" />)
              : <Trash2 size={16} strokeWidth={1.75} aria-hidden className="text-destructive" />}
      title={title}
      dismissible={running ? 'never' : 'when-clean'}
      footer={<>
          {phase === 'confirm' && (
            <>
              <Button variant="secondary" onClick={onClose} autoFocus>Cancel</Button>
              <Button variant="danger" onClick={execute} disabled={!confirmed}>
                {recursive
                  ? (single
                    ? plan.totalDescendants === 1 && !plan.anyCapped ? 'Delete including its 1 child' : `Delete including all ${childText} children`
                    : `Delete ${roots.length} Entries including ${childText} ${plan.totalDescendants === 1 && !plan.anyCapped ? 'child' : 'children'}`)
                  : (single ? 'Delete' : `Delete ${roots.length} Entries`)}
              </Button>
            </>
          )}
          {phase === 'running' && (
            <Button
              variant="secondary"
              leftIcon={Square}
              loading={stopping}
              onClick={stop}
              disabled={stopping || (progress?.method === 'treeDelete' && roots.length === 1)}
              title={progress?.method === 'treeDelete' ? 'A server-side tree delete is one request and cannot be stopped' : 'Stop after the current entry'}
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </Button>
          )}
          {phase === 'done' && (
            <>
              <Button variant="ghost" leftIcon={Copy} onClick={copyReport} className="mr-auto">Copy report</Button>
              <Button variant="primary" onClick={onClose} autoFocus>Close</Button>
            </>
          )}
        </>}
    >
      <div className="space-y-3">
          {phase === 'counting' && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-6 justify-center">
              <Spinner size="sm" decorative />
              Checking for child entries…
            </div>
          )}

          {phase === 'confirm' && (
            <>
              {confirmation.ncHeads.length > 0 && (
                <div className="rounded border border-destructive bg-destructive-subtle p-3 text-sm leading-relaxed" role="alert">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={14} className="text-destructive shrink-0 mt-0.5" aria-hidden />
                    <div>
                      {confirmation.ncHeads.every((dn) => isNamingContextDN(dn, namingContexts) || /^dc=/i.test(dn.trim())) ? (
                        <><strong>This deletes the whole naming context</strong>{confirmation.ncHeads.length === 1 ? <> <span className="font-mono break-all">{confirmation.ncHeads[0]}</span></> : ` (${confirmation.ncHeads.length})`}: the root of a directory partition and every entry in it ({totalText} entries){isAD ? '' : ' — the whole directory below this suffix'}.</>
                      ) : (
                        <><strong>This deletes the root of this connection's tree</strong> (its base DN) and every entry below it ({totalText} entries).</>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {!recursive ? (
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {single ? 'Are you sure you want to delete this entry?' : `Are you sure you want to delete ${roots.length} entries?`}{' '}
                  {isAD
                    ? 'Deleted AD objects can be restored from Deleted Objects while their lifetime lasts — without the AD Recycle Bin only as tombstones: most attributes and all group memberships are lost.'
                    : 'This action cannot be undone.'}
                </p>
              ) : (
                <div className="rounded border border-destructive bg-destructive-subtle p-3 text-sm leading-relaxed">
                  <div className="flex items-start gap-2">
                    <FolderTree size={14} className="text-destructive shrink-0 mt-0.5" />
                    <div>
                      {single ? (
                        <>This entry has <strong>{childText}</strong> {plan.totalDescendants === 1 ? 'child entry' : 'child entries'} below it.</>
                      ) : (
                        <>{plan.withChildren.length} of the {roots.length} selected entries {plan.withChildren.length === 1 ? 'has' : 'have'} children: <strong>{childText}</strong> descendants in total.</>
                      )}{' '}
                      Deleting {single ? 'it' : 'them'} removes <strong>{totalText}</strong> entries in total.
                      {isAD
                        ? ' Deleted AD objects can be restored from Deleted Objects while their lifetime lasts (without the Recycle Bin only as tombstones without most attributes and memberships).'
                        : ' This action cannot be undone.'}
                    </div>
                  </div>
                </div>
              )}

              <RootList roots={roots} counts={counts} countErrors={countErrors} />
              {recursive && <DescendantLists roots={roots} counts={counts} listed={listed} />}

              {Object.keys(countErrors).length > 0 && (
                <p className="text-xs text-destructive">
                  Children could not be counted for {Object.keys(countErrors).length} {Object.keys(countErrors).length === 1 ? 'entry' : 'entries'}; {Object.keys(countErrors).length === 1 ? 'it is' : 'they are'} deleted without children (fails if children exist).
                </p>
              )}

              {recursive && (
                <div className="space-y-2 text-xs">
                  {plan.treeDeleteSupported && (
                    <fieldset className="space-y-1">
                      <legend className="text-sm font-medium text-muted-foreground mb-1">Method</legend>
                      <RadioGroup
                        aria-label="Delete method"
                        value={effectiveMethod}
                        onValueChange={(v) => setMethod(v as 'treeDelete' | 'clientSide')}
                        options={[
                          { value: 'treeDelete', label: 'Server-side tree delete', description: 'One request with control 1.2.840.113556.1.4.805; fast, cannot be stopped, audited as one TREE_DELETE.' },
                          { value: 'clientSide', label: 'Client-side, entry by entry', description: 'Deepest first, with progress and stop; each entry audited.' },
                        ]}
                      />
                    </fieldset>
                  )}
                  {!plan.treeDeleteSupported && (
                    <p className="text-xs text-muted-foreground">
                      The server does not support the tree delete control: entries are deleted one by one, deepest first, with progress.
                    </p>
                  )}
                  {effectiveMethod === 'clientSide' && (
                    <Checkbox checked={stopOnError} onCheckedChange={setStopOnError} label="Stop at the first error" description="Otherwise continue; parents of failed entries are skipped." />
                  )}
                  {confirmation.kind === 'checkbox' && (
                    <Checkbox checked={acknowledged} onCheckedChange={setAcknowledged} label={<span className="font-medium">I understand that {totalText} entries will be deleted.</span>} />
                  )}
                </div>
              )}
              {(confirmation.kind === 'typeDN' || confirmation.kind === 'typeCount') && (
                <Field
                  label={confirmation.kind === 'typeDN'
                    ? <>Type the DN <span className="font-mono">{confirmation.phrase}</span> to confirm</>
                    : <>Type <span className="font-mono">{confirmation.phrase}</span> to confirm</>}
                  hint={confirmation.kind === 'typeCount' && confirmation.ncHeads.length === 0 ? `More than ${TYPED_DELETE_THRESHOLD} entries are deleted.` : undefined}
                >
                  <Input mono value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={typed !== '' && !typedOK} />
                </Field>
              )}
            </>
          )}

          {phase === 'running' && (
            <div className="space-y-2 text-xs">
              {roots.length > 1 && currentRoot && (
                <div className="text-muted-foreground">Entry {currentRoot.index + 1} of {roots.length}</div>
              )}
              <div className="font-mono text-xs truncate" title={currentRoot?.dn}>{currentRoot?.dn}</div>
              <div className="h-2 rounded bg-background overflow-hidden border border-border">
                {pct === null
                  ? <div className="h-full w-1/3 bg-primary animate-pulse" />
                  : <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />}
              </div>
              <div className="flex items-center justify-between text-muted-foreground">
                <span>
                  {progress?.phase === 'enumerating' && 'Listing entries…'}
                  {progress?.phase === 'deleting' && progress.method === 'treeDelete' && 'Server is deleting the tree…'}
                  {progress?.phase === 'deleting' && progress.method !== 'treeDelete' && `${progress.current.toLocaleString()} / ${progress.total.toLocaleString()}`}
                  {!progress && 'Deleting…'}
                </span>
                {progress && progress.method !== 'treeDelete' && (
                  <span>deleted {progress.deleted.toLocaleString()} · failed {progress.failed.toLocaleString()}</span>
                )}
              </div>
              {progress?.currentDN && progress.method !== 'treeDelete' && (
                <div className="font-mono text-xs text-muted-foreground truncate" title={progress.currentDN}>{progress.currentDN}</div>
              )}
            </div>
          )}

          {phase === 'done' && (
            <div className="space-y-2 text-xs">
              <div className="flex gap-4">
                <span><strong>{describeCount(allDeleted, allDeletedCapped)}</strong> deleted{anyDeletedUnknown && ' (+ unknown)'}</span>
                <span className={cn(allFailed > 0 && 'text-destructive')}><strong>{allFailed.toLocaleString()}</strong> failed</span>
                <span className="text-muted-foreground"><strong>{allSkipped.toLocaleString()}</strong> skipped</span>
                {wasCancelled && <span className="text-destructive">stopped</span>}
              </div>
              <div className="border border-border rounded divide-y divide-border max-h-[260px] overflow-y-auto">
                {outcomes.map((o) => (
                  <div key={o.dn} className="px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      {o.ok ? <CheckCircle2 size={12} className="text-primary shrink-0" /> : <XCircle size={12} className="text-destructive shrink-0" />}
                      <span className="font-mono text-xs truncate flex-1" title={o.dn}>{o.dn}</span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {o.method === 'treeDelete' ? 'tree delete' : o.method === 'clientSide' ? 'client-side' : 'delete'}
                        {o.method !== 'plain' && (o.deletedUnknown ? ' · deleted: unknown' : ` · ${describeCount(o.deleted, !!o.deletedCapped)} deleted`)}
                      </span>
                    </div>
                    {o.errors.slice(0, 50).map((e, i) => (
                      <div key={i} className={cn('pl-5 text-xs break-all', e.skipped ? 'text-muted-foreground' : 'text-destructive')}>
                        <span className="font-mono">{firstRDN(e.dn)}</span>: {e.message}
                      </div>
                    ))}
                    {o.errors.length > 50 && <div className="pl-5 text-xs text-muted-foreground">… {o.errors.length - 50} more (copy the report)</div>}
                  </div>
                ))}
                {outcomes.length === 0 && <div className="px-2 py-1.5 text-muted-foreground">Nothing was deleted.</div>}
              </div>
            </div>
          )}
        </div>
    </Dialog>
  );
}

function RootList({ roots, counts, countErrors }: {
  roots: string[];
  counts: Record<string, DescendantCount | undefined>;
  countErrors: Record<string, string>;
}) {
  return (
    <div className="border border-border rounded max-h-[160px] overflow-y-auto divide-y divide-border">
      {roots.map((dn) => {
        const c = counts[dn];
        return (
          <div key={dn} className="flex items-center gap-2 px-2 py-1 text-xs">
            <span className="font-mono truncate flex-1" title={dn}>{dn}</span>
            <span className={cn('shrink-0', countErrors[dn] ? 'text-destructive' : 'text-muted-foreground')} title={countErrors[dn]}>
              {countErrors[dn] ? 'count failed' : c && c.count > 0 ? `+${describeCount(c.count, c.capped)} ${c.count === 1 && !c.capped ? 'child' : 'children'}` : 'no children'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The first descendants of every root with children, as a tree (DEF-20). */
function DescendantLists({ roots, counts, listed }: {
  roots: string[];
  counts: Record<string, DescendantCount | undefined>;
  listed: Record<string, DescendantList | null | undefined>;
}) {
  const withKids = roots.filter((dn) => (counts[dn]?.count ?? 0) > 0);
  if (!withKids.length) return null;
  return (
    <div className="space-y-2">
      {withKids.map((root) => {
        const c = counts[root]!;
        const list = listed[root];
        const rows = list ? descendantRows(root, list.dns) : [];
        const headId = `del-desc-${root}`;
        return (
          <section key={root} aria-labelledby={headId} className="border border-border rounded">
            <h3 id={headId} className="flex items-center gap-1.5 px-2 py-1 border-b border-border text-xs font-medium text-muted-foreground">
              <FolderTree size={12} aria-hidden className="shrink-0" />
              <span className="truncate">
                Below {entryName(root)}
                {list ? ` · ${descendantListSummary(rows.length, c.count, c.capped)}` : ''}
              </span>
              {list === undefined && <Spinner size="sm" label="Listing entries" className="ml-auto" />}
            </h3>
            {list === null ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">The entries below could not be listed.</p>
            ) : list ? (
              <ul className="max-h-[180px] overflow-y-auto py-0.5" aria-label={`Entries below ${entryName(root)}`}>
                {rows.map((r) => (
                  <li key={r.dn} className="truncate pr-2 py-px font-mono text-xs" style={{ paddingLeft: 8 + 12 * (r.depth - 1) }} title={r.dn}>
                    {r.label}
                  </li>
                ))}
                {(c.capped || rows.length < c.count) && (
                  <li className="px-2 py-px text-xs text-muted-foreground">
                    … and {c.capped ? 'more than ' : ''}{(c.count - rows.length).toLocaleString()} more
                  </li>
                )}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
