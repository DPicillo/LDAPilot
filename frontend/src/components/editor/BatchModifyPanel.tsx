import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, Download, Eye, EyeOff, HelpCircle, ListChecks, Play, Plus, Trash2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import * as bulkApi from '../../lib/wails-bulk'
import {
  CHANGE_ROW_OPS, TEMPLATE_HELP, batchPreviewReport, applyResultReport, newChangeRow, reportFilename,
  rowsToChanges, splitDNForDisplay, templateAttributes, validateChangeRows, visibleRowProblems, type ChangeRow, type ChangeRowOp,
} from '../../lib/bulk'
import type { BulkApplyResult, BulkOptions, BulkPreview, BulkPreviewStatus, BulkProgress } from '../../types/bulk'
import { toast } from '../ui/Toast'
import { isPasswordWriteAttribute, isUserPasswordAttribute } from '../../lib/passwordPolicy'
import { PasswordPolicyHint } from '../password/PasswordPolicyHint'
import { usePasswordWriteGuard } from '../password/PasswordWriteGuard'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { BulkDryRunTable, BulkProgressView, BulkResultView, ConnectionTag, notifyBulkRun, retryItems, useProfileInfo } from '../bulk/BulkViews'
import { Badge } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { Select, Textarea } from '../ui/Input'
import { Combobox } from '../ui/Listbox'
import { useDialogContext } from '../ui/Dialog'
import { Checkbox } from '../ui/Checkbox'
import { Disclosure } from '../ui/Disclosure'
import { InlineAlert } from '../ui/InlineAlert'
import { SegmentedControl } from '../ui/SegmentedControl'
import { suggestNames } from '../search/searchModel'
import { attributeNames, useSchema } from '../schema/schemaCache'

type Step = 'edit' | 'previewing' | 'preview' | 'applying' | 'done';
type PreviewFilter = 'all' | BulkPreviewStatus;

/** Entries listed in the "affected entries" disclosure at most (the count is always exact). */
const MAX_LISTED = 500;

interface BatchModifyPanelProps {
  profileID: string;
  dns: string[];
  onClose: () => void;
  /** Set to the first attribute field (the dialog's initial focus, RW1-S-01). */
  firstFieldRef?: { current: HTMLElement | null };
  /** Called after an apply that changed at least one entry. */
  onApplied?: (result: BulkApplyResult) => void;
  /** Reports whether a run is in progress (the dialog must not close then). */
  onBusyChange?: (busy: boolean) => void;
  /** Reports unsaved input (change rows typed, a dry run shown): the dialog's discard guard. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Rendered at the start of the footer (the batch dialog's "Delete n Entries…"). */
  footerStart?: ReactNode;
}

/**
 * Batch modify: change rows with value templates (attribute names suggested
 * from the connection's schema, templates checked while typing), the list of
 * affected entries, a dry run shown as one table (entry · attribute · before
 * · after), apply with progress / stop / continue-on-error (off by default,
 * as in the LDIF import) and a result report with "Retry failed / not
 * processed" (a dry run of those entries first).
 */
export function BatchModifyPanel({ profileID, dns, onClose, onApplied, onBusyChange, onDirtyChange, footerStart, firstFieldRef }: BatchModifyPanelProps) {
  // Cancel asks "Discard changes?" like Escape when rows were typed (RW1-S-05).
  const dialog = useDialogContext();
  const { name: connectionName, readOnly } = useProfileInfo(profileID);

  const [rows, setRows] = useState<ChangeRow[]>(() => [newChangeRow('replace')]);
  // The row whose attribute field takes the focus (the first one, then each added one).
  const [focusRow, setFocusRow] = useState<string | null>(() => rows[0]?.id ?? null);
  // rows whose password values are shown in cleartext
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const [skipEmpty, setSkipEmpty] = useState(false);
  const [ignoreNoOps, setIgnoreNoOps] = useState(false);
  // Same default as the LDIF import: stop at the first failure.
  const [continueOnError, setContinueOnError] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [touched, setTouched] = useState(false);
  // Entries of a retry (the failed / not processed ones of the last run); null = all selected entries.
  const [retryDNs, setRetryDNs] = useState<string[] | null>(null);
  const targets = retryDNs ?? dns;
  const retrying = retryDNs !== null;

  const [step, setStep] = useState<Step>('edit');
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [result, setResult] = useState<BulkApplyResult | null>(null);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const [stopping, setStopping] = useState(false);
  const [filter, setFilter] = useState<PreviewFilter>('all');
  const [confirmDirect, setConfirmDirect] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [applyTotal, setApplyTotal] = useState(0);
  const runIdRef = useRef<string>('');
  // userPassword values (incl. templates): password storage policy (ask, unencrypted confirmation)
  const passwordGuard = usePasswordWriteGuard();

  const schema = useSchema(profileID);
  const attrNames = useMemo(() => attributeNames(schema), [schema]);
  const knownAttrs = useMemo(() => new Set(attrNames.map((n) => n.toLowerCase())), [attrNames]);
  /** Name not in the loaded schema (a typo, or an attribute of another server). */
  const notInSchema = (name: string) => {
    const base = name.trim().split(';')[0].toLowerCase();
    return !!base && knownAttrs.size > 0 && !/^\d+(\.\d+)*$/.test(base) && !knownAttrs.has(base);
  };

  const busy = step === 'previewing' || step === 'applying';
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  // An untouched panel (one empty "Replace with" row) closes without asking; a finished run too.
  const dirty = !result && (preview !== null || rows.length > 1 || rows.some((r) => r.op !== 'replace' || r.attribute.trim() !== '' || r.values.trim() !== ''));
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  // Safety net: a run must not continue unseen if the panel goes away
  const busyRef = useRef(false);
  busyRef.current = busy;
  useEffect(() => () => {
    if (busyRef.current && runIdRef.current) bulkApi.StopBulkRun(runIdRef.current).catch(() => {});
  }, []);

  // progress events of the current run
  useEffect(() => {
    if (!busy || !runIdRef.current) return;
    return bulkApi.onBulkProgress(runIdRef.current, setProgress);
  }, [busy]);

  const problems = useMemo(() => validateChangeRows(rows), [rows]);
  // Typing errors (unknown modifier, unclosed %, bad name) show at once; missing input after the first Dry run click.
  const shownProblems = useMemo(() => visibleRowProblems(problems, touched), [problems, touched]);
  const problemsByRow = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of shownProblems) m.set(p.rowId, [...(m.get(p.rowId) || []), p.message]);
    return m;
  }, [shownProblems]);
  const invalidNow = shownProblems.length > 0;

  const options = useCallback((runId: string): BulkOptions => ({
    runId, continueOnError, skipEmptyPlaceholders: skipEmpty, ignoreNoOps,
  }), [continueOnError, skipEmpty, ignoreNoOps]);

  const updateRow = (id: string, patch: Partial<ChangeRow>) => {
    setRows(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
  };

  const addRow = () => {
    const row = newChangeRow('add');
    setFocusRow(row.id);
    setRows(rs => [...rs, row]);
  };

  const runPreview = async (targetDNs = targets) => {
    setTouched(true);
    if (problems.length > 0) return;
    const runId = bulkApi.newRunId();
    runIdRef.current = runId;
    setRequestError(null);
    setProgress(null);
    setStopping(false);
    setStep('previewing');
    try {
      const res = await bulkApi.BatchPreview(profileID, targetDNs, rowsToChanges(rows), options(runId));
      setPreview(res);
      setFilter(res.errors > 0 ? 'error' : 'all');
      setStep('preview');
    } catch (err: any) {
      setRequestError(errorMessage(err));
      setStep('edit');
    }
  };

  const runApply = async (targetDNs: string[], fromPreview: boolean) => {
    let passwords;
    try {
      passwords = await passwordGuard.check(profileID, { changes: rowsToChanges(rows) }, {}, { entries: targetDNs.length });
    } catch (err: any) {
      setRequestError(errorMessage(err));
      return;
    }
    if (!passwords) return; // cancelled: nothing was sent
    const runId = bulkApi.newRunId();
    runIdRef.current = runId;
    setApplyTotal(targetDNs.length);
    setRequestError(null);
    setProgress(null);
    setStopping(false);
    setStep('applying');
    try {
      const res = await bulkApi.BatchApply(profileID, targetDNs, rowsToChanges(rows), { ...options(runId), passwords });
      setResult(res);
      setStep('done');
      // A run the user stopped (nothing failed) is a warning with "Retry …", not an error.
      notifyBulkRun(res, {
        success: `Bulk modify on ${connectionName}: ${res.succeeded} entr${res.succeeded === 1 ? 'y' : 'ies'} changed`,
        partial: `Bulk modify on ${connectionName}: ${res.succeeded} changed, ${res.failed} failed${res.notProcessed ? `, ${res.notProcessed} not processed` : ''}`,
      });
      if (res.succeeded > 0) onApplied?.(res);
    } catch (err: any) {
      const msg = errorMessage(err);
      setRequestError(msg);
      toast.error('Bulk modify failed', msg);
      setStep(fromPreview ? 'preview' : 'edit');
    }
  };

  /** "Retry failed / not processed": those entries only, checked in a dry run first. */
  const retry = () => {
    if (!result) return;
    const again = retryItems(result).map((it) => it.dn).filter(Boolean);
    if (!again.length) return;
    setRetryDNs(again);
    setResult(null);
    setPreview(null);
    void runPreview(again);
  };

  const stopRun = async () => {
    setStopping(true);
    await bulkApi.StopBulkRun(runIdRef.current);
  };

  const changeDNs = useMemo(
    () => (preview?.entries || []).filter(e => e.status === 'change').map(e => e.dn),
    [preview],
  );

  const filtered = useMemo(
    () => (preview?.entries || []).filter(e => filter === 'all' || e.status === filter),
    [preview, filter],
  );

  const saveReport = async (kind: 'preview' | 'result') => {
    try {
      const content = kind === 'preview' && preview ? batchPreviewReport(preview, connectionName) : result ? applyResultReport(result, connectionName) : '';
      const path = await bulkApi.SaveReportFile(reportFilename(kind === 'preview' ? 'bulk-modify-dry-run' : 'bulk-modify-result'), content);
      if (path && path !== 'download') toast.success(`Report saved to ${path}`);
    } catch (err: any) {
      toast.error('Saving the report failed', errorMessage(err));
    }
  };

  // --- render -------------------------------------------------------------

  const changeSummary = (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-xs text-muted-foreground">On</span>
      <ConnectionTag profileId={profileID} className="mr-1" />
      {rowsToChanges(rows).map((c, i) => (
        <Badge key={i} className="font-mono font-normal">
          {c.operation} {c.attribute}{c.values.length ? `: ${isPasswordWriteAttribute(c.attribute) ? '***' : c.values.join(' | ')}` : c.operation === 'delete' ? ' (all values)' : ''}
        </Badge>
      ))}
    </div>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
        {readOnly && <InlineAlert tone="warning" body="The connection is read-only: dry runs work, applying is disabled." />}
        {requestError && <InlineAlert tone="danger" body={<span className="break-words min-w-0">{requestError}</span>} />}
        {retrying && step !== 'done' && (
          <InlineAlert
            tone="info"
            body={`Retry: ${targets.length} of ${dns.length} entries (the failed and not processed ones of the last run).`}
            actions={step === 'edit' ? <Button size="sm" variant="ghost" onClick={() => setRetryDNs(null)}>Use all {dns.length}</Button> : undefined}
          />
        )}

        {step === 'edit' && (
          <>
            <div className="text-sm text-muted-foreground">
              Changes for {targets.length} {targets.length === 1 ? 'entry' : 'entries'} on <span className="text-foreground font-medium">{connectionName}</span>. All changes of one entry are applied together (atomically).
              Values may contain placeholders such as <code className="font-mono text-foreground">%givenName%.%sn:lower%@example.org</code>.
            </div>

            <AffectedEntries dns={targets} />

            <div className="space-y-2">
              {rows.map((row, idx) => {
                const rowProblems = problemsByRow.get(row.id);
                const attr = row.attribute.trim();
                const unknownAttr = !rowProblems && notInSchema(attr);
                const unknownPlaceholders = knownAttrs.size ? templateAttributes(row).filter(notInSchema) : [];
                return (
                  <div key={row.id} className={cn('border rounded p-2 space-y-1.5 bg-background', rowProblems ? 'border-destructive' : 'border-border')}>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-4 text-right tabular-nums" aria-hidden>{idx + 1}</span>
                      <Select
                        aria-label={`Change ${idx + 1}: operation`}
                        value={row.op}
                        onChange={e => updateRow(row.id, { op: e.target.value as ChangeRowOp })}
                        options={CHANGE_ROW_OPS.map(o => ({ value: o.value, label: o.label }))}
                        className="w-40"
                      />
                      <div
                        className="flex-1 min-w-0"
                        ref={idx === 0 && firstFieldRef ? (el) => { firstFieldRef.current = el?.querySelector('input') ?? null; } : undefined}
                      >
                        <Combobox
                          openOnFocus={false}
                          items={suggestNames(attrNames, row.attribute, 60)}
                          getKey={(a) => a}
                          getLabel={(a) => a}
                          filter={() => true}
                          inputValue={row.attribute}
                          onInputChange={(v) => updateRow(row.id, { attribute: v })}
                          onSelect={(a) => updateRow(row.id, { attribute: a })}
                          // Tab takes the highlighted suggestion ("descr" → description), as Add attribute does (RW2-S-07).
                          acceptOnTab
                          placeholder="attribute, e.g. description"
                          aria-label={`Change ${idx + 1}: attribute`}
                          mono
                          autoFocus={focusRow === row.id}
                          className={cn(rowProblems && '[&_input]:border-destructive')}
                        />
                      </div>
                      <IconButton
                        label="Remove this change"
                        icon={Trash2}
                        disabled={rows.length <= 1}
                        className="enabled:hover:text-destructive"
                        onClick={() => setRows(rs => rs.length > 1 ? rs.filter(r => r.id !== row.id) : rs)}
                      />
                    </div>
                    {row.op !== 'removeAttribute' ? (
                      <div className="ml-6 flex items-start gap-1" style={{ width: 'calc(100% - 1.5rem)' }}>
                        {/* Password values (literal passwords or templates) are masked unless revealed */}
                        <Textarea
                          mono
                          aria-label={`Change ${idx + 1}: values`}
                          value={row.values}
                          onChange={e => updateRow(row.id, { values: e.target.value })}
                          placeholder={isPasswordWriteAttribute(attr)
                            ? 'Password or template, one per line'
                            : row.op === 'replace' ? 'New values, one per line (empty = remove the attribute)' : 'Values, one per line'}
                          rows={Math.min(5, Math.max(1, row.values.split('\n').length))}
                          spellCheck={false}
                          autoComplete="off"
                          invalid={!!rowProblems}
                          className={cn(
                            'flex-1',
                            isPasswordWriteAttribute(attr) && !revealed.has(row.id) && '[-webkit-text-security:disc]',
                          )}
                        />
                        {isPasswordWriteAttribute(attr) && (
                          <IconButton
                            label={revealed.has(row.id) ? 'Hide the values' : 'Show the values'}
                            icon={revealed.has(row.id) ? EyeOff : Eye}
                            pressed={revealed.has(row.id)}
                            onClick={() => setRevealed(r => { const n = new Set(r); if (n.has(row.id)) n.delete(row.id); else n.add(row.id); return n; })}
                          />
                        )}
                      </div>
                    ) : (
                      <div className="ml-6 text-sm text-muted-foreground">Removes all values; entries without the attribute stay unchanged.</div>
                    )}
                    {rowProblems && (
                      <div className="ml-6 text-xs text-destructive" role="alert">{rowProblems.join('; ')}</div>
                    )}
                    {(unknownAttr || unknownPlaceholders.length > 0) && (
                      <div className="ml-6 text-xs text-warning">
                        {unknownAttr && <>“{attr}” is not in the schema of {connectionName}. </>}
                        {unknownPlaceholders.length > 0 && <>Placeholder attribute{unknownPlaceholders.length > 1 ? 's' : ''} not in the schema: {unknownPlaceholders.join(', ')}.</>}
                      </div>
                    )}
                  </div>
                );
              })}
              {rows.some(r => isUserPasswordAttribute(r.attribute.trim()) && r.op !== 'removeAttribute') && (
                <PasswordPolicyHint profileId={profileID} className="ml-6" />
              )}
              <Button size="sm" variant="ghost" leftIcon={Plus} onClick={addRow}>
                Add change
              </Button>
            </div>

            <div>
              <Button size="sm" variant="ghost" leftIcon={showHelp ? ChevronDown : ChevronRight} rightIcon={HelpCircle} aria-expanded={showHelp} onClick={() => setShowHelp(v => !v)}>
                Placeholders
              </Button>
              {showHelp && (
                <div className="mt-1 border border-border rounded bg-background p-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  {TEMPLATE_HELP.map(h => (
                    <div key={h.syntax} className="contents">
                      <code className="font-mono text-foreground">{h.syntax}</code>
                      <span className="text-muted-foreground">{h.meaning}</span>
                    </div>
                  ))}
                  <span className="col-span-2 text-muted-foreground mt-1">
                    An empty placeholder (attribute missing or empty) fails the entry unless “Skip entries where a placeholder is empty” is set.
                  </span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
              <Checkbox checked={skipEmpty} onCheckedChange={setSkipEmpty} label="Skip entries where a placeholder is empty" />
              <Checkbox checked={ignoreNoOps} onCheckedChange={setIgnoreNoOps} label="Ignore values that are already present / not present (instead of failing)" />
              <Checkbox checked={continueOnError} onCheckedChange={setContinueOnError} label="Continue on error (otherwise stop at the first failed entry)" />
              <Checkbox checked={dryRun} onCheckedChange={setDryRun} label="Dry run first (recommended)" />
            </div>
          </>
        )}

        {step === 'previewing' && (
          <BulkProgressView label="Dry run: reading entries…" progress={progress} total={targets.length} stopping={stopping} onStop={stopRun} />
        )}

        {step === 'preview' && preview && (
          <>
            {changeSummary}
            {preview.stopped && (
              <InlineAlert tone="warning" body={`Dry run stopped after ${preview.total} of ${targets.length} entries. Only these entries can be applied.`} />
            )}
            <SegmentedControl
              aria-label="Show entries"
              value={filter}
              onValueChange={setFilter}
              options={[
                { value: 'all' as PreviewFilter, label: 'All', count: preview.total },
                { value: 'change' as PreviewFilter, label: 'Will change', count: preview.changed },
                { value: 'error' as PreviewFilter, label: preview.errors === 1 ? 'Error' : 'Errors', count: preview.errors },
                { value: 'skipped' as PreviewFilter, label: 'Skipped', count: preview.skipped },
                { value: 'unchanged' as PreviewFilter, label: 'Unchanged', count: preview.unchanged },
              ]}
            />
            <BulkDryRunTable entries={filtered} />
          </>
        )}

        {step === 'applying' && (
          <>
            {changeSummary}
            <BulkProgressView label="Applying changes…" progress={progress} total={applyTotal} stopping={stopping} onStop={stopRun} />
          </>
        )}

        {step === 'done' && result && (
          <>
            {changeSummary}
            <BulkResultView result={result} onDownload={() => saveReport('result')} onRetry={readOnly ? undefined : retry} />
          </>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-border">
        {footerStart}
        {step === 'preview' && (
          <>
            <Button variant="secondary" leftIcon={ArrowLeft} onClick={() => setStep('edit')}>Edit changes</Button>
            <Button variant="ghost" leftIcon={Download} onClick={() => saveReport('preview')}>Download report</Button>
          </>
        )}
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => (step === 'done' || !dialog ? onClose() : dialog.requestClose())} disabled={busy}>
          {step === 'done' ? 'Close' : 'Cancel'}
        </Button>
        {step === 'edit' && (dryRun ? (
          <Button
            variant="primary"
            leftIcon={Eye}
            onClick={() => void runPreview()}
            disabled={targets.length === 0 || invalidNow}
            title={invalidNow ? 'Fix the marked changes first' : undefined}
          >
            Dry run
          </Button>
        ) : (
          <Button
            variant="danger"
            leftIcon={Play}
            onClick={() => { setTouched(true); if (problems.length === 0) setConfirmDirect(true); }}
            disabled={targets.length === 0 || readOnly || invalidNow}
          >
            Apply without dry run
          </Button>
        ))}
        {step === 'preview' && (
          <Button
            variant="primary"
            leftIcon={Play}
            onClick={() => runApply(changeDNs, true)}
            disabled={readOnly || changeDNs.length === 0}
            title={readOnly ? 'The connection is read-only' : changeDNs.length === 0 ? 'No entry would change' : undefined}
          >
            Apply to {changeDNs.length} {changeDNs.length === 1 ? 'entry' : 'entries'}
          </Button>
        )}
      </div>

      {confirmDirect && (
        <ConfirmDialog
          title="Apply without dry run"
          message={`Apply the changes to ${targets.length} ${targets.length === 1 ? 'entry' : 'entries'} on "${connectionName}" without reviewing a dry run first?`}
          detail={`${rowsToChanges(rows).map(c => `${c.operation} ${c.attribute}`).join(', ')} · Continue on error: ${continueOnError ? 'on' : 'off (the run stops at the first failure)'}`}
          confirmLabel="Apply"
          variant="warning"
          onConfirm={() => { setConfirmDirect(false); runApply(targets, false); }}
          onCancel={() => setConfirmDirect(false)}
        />
      )}
      {passwordGuard.element}
    </div>
  );
}

/** The entries the changes go to, listed before the dry run (RDN, then the container). */
function AffectedEntries({ dns }: { dns: string[] }) {
  const listed = dns.slice(0, MAX_LISTED);
  return (
    <Disclosure title={`${dns.length} ${dns.length === 1 ? 'entry' : 'entries'} affected`} icon={ListChecks} summary="the dry run reads each of them first">
      <ul className="max-h-[160px] overflow-auto text-xs font-mono space-y-0.5 px-1" aria-label="Affected entries">
        {listed.map((dn) => {
          const { rdn, parent } = splitDNForDisplay(dn);
          return (
            <li key={dn} className="truncate" title={dn}>
              <span className="text-foreground">{rdn}</span>
              <span className="text-muted-foreground">{parent ? `,${parent}` : ''}</span>
            </li>
          );
        })}
        {dns.length > listed.length && <li className="text-muted-foreground font-sans">and {dns.length - listed.length} more</li>}
      </ul>
    </Disclosure>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}
