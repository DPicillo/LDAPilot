import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, Download, Eye, FileText, FileUp, FolderInput, Play, Undo2, Wand2 } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import * as bulkApi from '../../lib/wails-bulk'
import { applyResultReport, fileLevelSyntaxErrors, ldifPreviewReport, recordJumpLine, reportFilename } from '../../lib/bulk'
import { refreshAfterBulkApply, refreshSearchRowsOf } from '../../lib/bulkRefresh'
import { cn } from '../../lib/utils'
import { getParentDN } from '../../lib/dn'
import type { BulkApplyResult, BulkProgress, LDIFPreview, LDIFRecordPreview, LDIFRecordStatus } from '../../types/bulk'
import { toast } from '../ui/Toast'
import { targetHasPasswordValues } from '../../lib/passwordPolicy'
import { PasswordPolicyHint } from '../password/PasswordPolicyHint'
import { usePasswordWriteGuard } from '../password/PasswordWriteGuard'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { BulkDiffView, BulkMessages, BulkProgressView, BulkResultView, ConnectionTag, notifyBulkRun, retryItems, useProfileInfo } from '../bulk/BulkViews'
import { Badge, type BadgeTone } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Dialog, useDialogContext } from '../ui/Dialog'
import { Input, Textarea } from '../ui/Input'
import { Checkbox } from '../ui/Checkbox'
import { SegmentedControl } from '../ui/SegmentedControl'
import { InlineAlert } from '../ui/InlineAlert'
import { ldifRecordDNs, ldifRecordsAt, ldifSkeleton, rebaseLDIF } from './ldifRebase'

interface ImportDialogProps {
  onClose: () => void;
  /** Optional LDIF to start with. */
  initialContent?: string;
  /** Connection to import into (default: the active one). */
  profileId?: string;
  /** Container the import was opened on: "into <container>", skeleton and rebase. */
  containerDN?: string;
}

/** Largest file accepted by drag and drop (same as the open dialog). */
const MAX_DROP_BYTES = 64 << 20;

/** Applied records reported as entry events at most (tree / tabs / bookmarks listen; refreshAfterBulkApply covers bigger runs). */
const MAX_ENTRY_EVENTS = 200;

/** Footer Cancel that asks "Discard changes?" like Escape / × when the dialog is dirty. */
function GuardedCancel({ children = 'Cancel', disabled }: { children?: React.ReactNode; disabled?: boolean }) {
  const dialog = useDialogContext();
  return (
    <Button disabled={disabled} onClick={() => dialog?.requestClose()}>
      {children}
    </Button>
  );
}

/** Tells the tree, tabs and bookmarks about applied records (TRIAGE §0.1 entry events). */
function emitEntryEvents(profileId: string, result: BulkApplyResult) {
  if (typeof window === 'undefined') return;
  const done = (result.items || []).filter((it) => it.status === 'success' && it.operation !== 'modify');
  if (done.length > MAX_ENTRY_EVENTS) return;
  for (const it of done) {
    const emit = (name: string, detail: object) => window.dispatchEvent(new CustomEvent(name, { detail }));
    if (it.operation === 'add') emit('ldapilot:entry-created', { profileId, dn: it.dn, parentDN: getParentDN(it.dn), select: false });
    else if (it.operation === 'delete') emit('ldapilot:entry-deleted', { profileId, dn: it.dn, subtree: false });
    else if (it.operation === 'modrdn' && it.newDn) emit('ldapilot:entry-moved', { profileId, oldDN: it.dn, newDN: it.newDn });
  }
}

type Step = 'edit' | 'previewing' | 'preview' | 'applying' | 'done';
type RecordFilter = 'all' | LDIFRecordStatus;

/** Content larger than this is not shown in the editable text area. */
const MAX_EDITABLE = 1 << 20;
const PAGE = 100;

const STATUS_STYLE: Record<LDIFRecordStatus, { label: string; tone: BadgeTone }> = {
  ok: { label: 'ok', tone: 'primary' },
  warning: { label: 'warning', tone: 'warning' },
  error: { label: 'will fail', tone: 'danger' },
  invalid: { label: 'syntax error', tone: 'danger' },
};

const CHANGE_TYPES = ['add', 'modify', 'delete', 'modrdn'] as const;

/**
 * LDIF import: content records and change records (add, modify, delete,
 * modrdn/moddn). Dry run validates the whole file against the directory,
 * apply runs the records in order with progress, stop and a result report.
 */
export function ImportDialog({ onClose, initialContent = '', profileId: profileProp, containerDN }: ImportDialogProps) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const profileId = useRef(profileProp ?? activeProfileId).current; // stay on the profile the dialog was opened for
  const { name: connectionName, readOnly } = useProfileInfo(profileId);
  // Target container of a rebase (prefilled when opened on a container).
  const [target, setTarget] = useState(containerDN ?? '');
  // Content before the last rebase / skeleton (Undo).
  const [undoContent, setUndoContent] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [content, setContent] = useState(initialContent);
  const [fileName, setFileName] = useState<string | null>(null);
  const [continueOnError, setContinueOnError] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [step, setStep] = useState<Step>('edit');
  const [preview, setPreview] = useState<LDIFPreview | null>(null);
  const [result, setResult] = useState<BulkApplyResult | null>(null);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RecordFilter>('all');
  const [visible, setVisible] = useState(PAGE);
  const [confirmApply, setConfirmApply] = useState<'direct' | 'preview' | null>(null);
  // "Store passwords exactly as in the file": opt-out of the connection's
  // password storage policy for userPassword values of this file
  const [passwordsAsIs, setPasswordsAsIs] = useState(false);
  const passwordGuard = usePasswordWriteGuard();
  const runIdRef = useRef('');
  const textRef = useRef<HTMLTextAreaElement>(null);
  const pendingLine = useRef<number | null>(null);

  const busy = step === 'previewing' || step === 'applying';
  // Read-only connections: dry runs only (Apply is disabled with the reason).
  const dryRunOnly = dryRun || readOnly;
  const tooLarge = content.length > MAX_EDITABLE;
  const hasPasswords = useMemo(() => targetHasPasswordValues({ ldif: content }), [content]);
  const lineCount = useMemo(() => (content ? content.split('\n').length : 0), [content]);

  useEffect(() => {
    if (!busy || !runIdRef.current) return;
    return bulkApi.onBulkProgress(runIdRef.current, setProgress);
  }, [busy]);

  // Jump to a line after going back to the editor from a syntax error
  useEffect(() => {
    if (step !== 'edit' || pendingLine.current === null || !textRef.current) return;
    const line = pendingLine.current;
    pendingLine.current = null;
    const lines = content.split('\n');
    let start = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) start += lines[i].length + 1;
    const end = start + (lines[line - 1]?.length ?? 0);
    const ta = textRef.current;
    ta.focus();
    ta.setSelectionRange(start, end);
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 16;
    ta.scrollTop = Math.max(0, (line - 3) * lineHeight);
  }, [step, content]);

  async function openFile() {
    setError(null);
    try {
      const file = await bulkApi.OpenLDIFFile();
      if (!file) return;
      setContent(file.content);
      setFileName(`${file.name} (${formatSize(file.size)})`);
      setPreview(null);
      setStep('edit');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function runPreview(text = content) {
    if (!profileId || !text.trim()) return;
    const runId = bulkApi.newRunId();
    runIdRef.current = runId;
    setError(null);
    setProgress(null);
    setStopping(false);
    setStep('previewing');
    try {
      const res = await bulkApi.PreviewLDIFChanges(profileId, text, {
        runId, continueOnError, skipEmptyPlaceholders: false, ignoreNoOps: false, passwords: { asIs: passwordsAsIs },
      });
      setPreview(res);
      const problems = (res.byStatus.error || 0) + (res.byStatus.invalid || 0);
      setFilter(problems > 0 ? (res.byStatus.invalid ? 'invalid' : 'error') : 'all');
      setVisible(PAGE);
      setStep('preview');
    } catch (err) {
      setError(errorMessage(err));
      setStep('edit');
    }
  }

  async function runApply(fromPreview: boolean) {
    if (!profileId) return;
    let passwords;
    try {
      passwords = await passwordGuard.check(profileId, { ldif: content }, { asIs: passwordsAsIs });
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    if (!passwords) return; // cancelled: nothing was sent
    const runId = bulkApi.newRunId();
    runIdRef.current = runId;
    setError(null);
    setProgress(null);
    setStopping(false);
    setStep('applying');
    try {
      const res = await bulkApi.ApplyLDIFChanges(profileId, content, { runId, continueOnError, skipEmptyPlaceholders: false, ignoreNoOps: false, passwords });
      setResult(res);
      setStep('done');
      notifyBulkRun(res, {
        success: `LDIF applied on ${connectionName}: ${res.succeeded} record${res.succeeded !== 1 ? 's' : ''}`,
        partial: `LDIF on ${connectionName}: ${res.succeeded} applied, ${res.failed} failed${res.notProcessed ? `, ${res.notProcessed} not processed` : ''}`,
      });
      if (res.succeeded > 0) {
        refreshAfterBulkApply(profileId, res);
        emitEntryEvents(profileId, res);
        // Result rows follow modify records too, as after Batch Modify (RW2-S-02).
        const modified = (res.items || []).filter((it) => it.status === 'success' && it.operation === 'modify').map((it) => it.dn);
        if (modified.length) void refreshSearchRowsOf(profileId, modified).catch(() => {});
      }
    } catch (err) {
      const msg = errorMessage(err);
      setError(msg);
      toast.error('LDIF apply failed', msg);
      setStep(fromPreview ? 'preview' : 'edit');
    }
  }

  async function saveReport() {
    try {
      const text = step === 'done' && result ? applyResultReport(result, connectionName) : preview ? ldifPreviewReport(preview, connectionName) : '';
      const path = await bulkApi.SaveReportFile(reportFilename(step === 'done' ? 'ldif-apply-result' : 'ldif-dry-run'), text);
      if (path && path !== 'download') toast.success(`Report saved to ${path}`);
    } catch (err) {
      toast.error('Saving the report failed', errorMessage(err));
    }
  }

  /** "Retry failed": the failed and not processed records of the run, checked in a dry run first. */
  function retryFailed() {
    if (!result) return;
    const lines = retryItems(result).map((it) => it.line ?? 0).filter((n) => n > 0);
    const subset = ldifRecordsAt(content, lines);
    if (!subset) {
      toast.error('Nothing to retry', 'The records could not be found in the file.');
      return;
    }
    setUndoContent(content);
    setContent(subset);
    setFileName(null);
    setResult(null);
    setPreview(null);
    void runPreview(subset);
  }

  /** Moves the file's entries below the target container (rebase). */
  function rebase() {
    const r = rebaseLDIF(content, target);
    if (!r.changed) {
      toast.info(r.oldBase ? `The entries are below ${target} already` : 'No DNs to rebase');
      return;
    }
    setUndoContent(content);
    setContent(r.content);
    setPreview(null);
    toast.success(r.oldBase ? `${r.changed} DNs moved from ${r.oldBase} to ${target}` : `${r.changed} relative DNs completed with ${target}`);
  }

  function insertSkeleton() {
    if (!target.trim()) return;
    setUndoContent(content);
    const skel = ldifSkeleton(target.trim());
    setContent(content.trim() ? `${content.replace(/\s*$/, '')}\n\n${skel}` : `version: 1\n\n${skel}`);
    setPreview(null);
  }

  /** A .ldif file dropped onto the text area. */
  async function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    setError(null);
    if (file.size > MAX_DROP_BYTES) {
      setError(`${file.name} is too large (limit ${MAX_DROP_BYTES >> 20} MiB)`);
      return;
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      setContent(text);
      setFileName(`${file.name} (${formatSize(file.size)})`);
      setPreview(null);
      setUndoContent(null);
    } catch {
      setError(`${file.name} is not UTF-8 text; LDIF values that are not UTF-8 must be base64 encoded (attr:: value)`);
    }
  }

  function goToLine(line: number) {
    if (tooLarge) return;
    pendingLine.current = line;
    setStep('edit');
  }

  const records = useMemo(
    () => (preview?.records || []).filter(r => filter === 'all' || r.status === filter),
    [preview, filter],
  );
  const fileErrors = useMemo(() => (preview ? fileLevelSyntaxErrors(preview) : []), [preview]);
  const predictedFailures = preview ? (preview.byStatus.error || 0) : 0;

  // Typed or opened LDIF that was not applied yet: Escape / Cancel ask before discarding it.
  const dirty = (step === 'edit' || step === 'preview') && !!content.trim() && content !== initialContent;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title="Import LDIF / Apply change file"
      description={
        profileId ? (
          <span className="inline-flex items-center gap-1 min-w-0">
            on <ConnectionTag profileId={profileId} />
            {containerDN && (
              <>
                {' '}into <span className="font-mono text-foreground truncate" title={containerDN}>{containerDN}</span>
              </>
            )}
          </span>
        ) : undefined
      }
      icon={FileUp}
      size="xl"
      dismissible={busy ? 'never' : 'when-clean'}
      dirty={dirty}
      className="h-[88%]"
      bodyClassName="space-y-3"
      footer={
        <>
          {step === 'preview' && (
            <>
              <Button leftIcon={ArrowLeft} onClick={() => setStep('edit')}>
                Edit
              </Button>
              <Button leftIcon={Download} onClick={() => void saveReport()}>
                Download report
              </Button>
            </>
          )}
          {step === 'done' && (
            <Button
              leftIcon={ArrowLeft}
              onClick={() => {
                setResult(null);
                setPreview(null);
                setStep('edit');
              }}
            >
              Back to the file
            </Button>
          )}
          <span className="flex-1" />
          {step === 'done' ? (
            <Button onClick={onClose}>Close</Button>
          ) : (
            <GuardedCancel disabled={busy} />
          )}
          {step === 'edit' &&
            (dryRunOnly ? (
              <Button variant="primary" leftIcon={Eye} onClick={() => void runPreview()} disabled={!profileId || !content.trim()}>
                Dry run
              </Button>
            ) : (
              <Button variant="danger" leftIcon={Play} onClick={() => setConfirmApply('direct')} disabled={!profileId || !content.trim()}>
                Apply without dry run
              </Button>
            ))}
          {step === 'preview' && preview && (
            <Button
              variant="primary"
              leftIcon={Play}
              onClick={() => (predictedFailures > 0 ? setConfirmApply('preview') : void runApply(true))}
              disabled={!preview.applicable || readOnly || preview.stopped}
              title={!preview.applicable ? 'Fix the syntax errors first' : readOnly ? 'The connection is read-only' : preview.stopped ? 'Run the complete dry run first' : undefined}
            >
              Apply {preview.total} record{preview.total !== 1 ? 's' : ''}
            </Button>
          )}
        </>
      }
    >
      {!profileId && <InlineAlert tone="danger" body="Connect to a directory first." />}
      {readOnly && <InlineAlert tone="warning" body="The connection is read-only: dry runs work, applying is disabled. Change the profile's read-only setting to apply changes." />}
      {error && <InlineAlert tone="danger" body={<span className="break-words">{error}</span>} />}

      {step === 'edit' && (
        <>
          <div className="flex items-center gap-2 min-w-0">
            <Button leftIcon={FileText} onClick={() => void openFile()}>
              Open file…
            </Button>
            {fileName && (
              <span className="text-sm text-muted-foreground truncate" title={fileName}>
                {fileName}
              </span>
            )}
            <span className="ml-auto text-xs text-muted-foreground tabular-nums shrink-0">
              {lineCount} line{lineCount !== 1 ? 's' : ''}
            </span>
            {content && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setContent('');
                  setFileName(null);
                  setPreview(null);
                }}
              >
                Clear
              </Button>
            )}
          </div>
          <div
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('Files')) {
                e.preventDefault();
                setDragOver(true);
              }
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => void onDrop(e)}
            className={cn('rounded', dragOver && 'outline-dashed outline-2 outline-primary')}
          >
            {tooLarge ? (
              <div className="text-sm text-muted-foreground border border-border rounded bg-background px-3 py-6 text-center">
                The file is too large to edit here ({formatSize(content.length)}). Run the dry run to validate it.
              </div>
            ) : (
              <Textarea
                ref={textRef}
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  setUndoContent(null);
                }}
                spellCheck={false}
                aria-label="LDIF content"
                placeholder={'Paste LDIF or drop an .ldif file here.\n\nversion: 1\n\ndn: cn=example,dc=test\nchangetype: modify\nreplace: description\ndescription: new value\n-'}
                mono
                className="text-xs h-64 whitespace-pre"
              />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <FolderInput size={14} strokeWidth={1.75} aria-hidden className="text-muted-foreground shrink-0" />
            <label htmlFor="ldif-target" className="text-sm text-muted-foreground shrink-0">
              Into container
            </label>
            <Input
              id="ldif-target"
              size="sm"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="optional: OU=Sandbox,DC=example,DC=com"
              mono
              spellCheck={false}
              wrapperClassName="flex-1 min-w-[200px]"
            />
            <Button
              size="sm"
              disabled={!target.trim() || !content.trim() || tooLarge}
              onClick={rebase}
              title={`Move the file's entries below this container (${ldifRecordDNs(tooLarge ? '' : content).length} records); relative DNs get it appended`}
            >
              Rebase DNs
            </Button>
            <Button size="sm" variant="ghost" leftIcon={Wand2} disabled={!target.trim() || tooLarge} onClick={insertSkeleton} title="Insert a record that creates an OU below this container">
              Prefill skeleton
            </Button>
            {undoContent !== null && (
              <Button
                size="sm"
                variant="ghost"
                leftIcon={Undo2}
                onClick={() => {
                  setContent(undoContent);
                  setUndoContent(null);
                  setPreview(null);
                }}
              >
                Undo
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Content records and change records (add, modify, delete, modrdn/moddn) per RFC 2849. Values: <code className="font-mono">attr: text</code>,{' '}
            <code className="font-mono">attr:: base64</code>, <code className="font-mono">attr:&lt; file:///path</code> (local files up to 10 MiB). Control lines are not supported.
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-1.5">
            <Checkbox checked={continueOnError} onCheckedChange={setContinueOnError} label="Continue on error (otherwise stop at the first failed record)" />
            <Checkbox
              checked={dryRunOnly}
              disabled={readOnly}
              onCheckedChange={setDryRun}
              label="Dry run first (recommended)"
              description={readOnly ? 'Read-only connection: only dry runs.' : undefined}
            />
          </div>
          {hasPasswords && (
            <div className={cn('space-y-1.5 border rounded bg-background px-2.5 py-2', passwordsAsIs ? 'border-warning' : 'border-border')}>
              <PasswordPolicyHint profileId={profileId} asIs={passwordsAsIs} />
              <Checkbox
                checked={passwordsAsIs}
                onCheckedChange={(v) => {
                  setPasswordsAsIs(v);
                  setPreview(null);
                }}
                label={<span className={cn(passwordsAsIs && 'text-warning')}>Store passwords exactly as in the file (no hashing)</span>}
                description={
                  <span className={cn(passwordsAsIs && 'text-warning')}>
                    userPassword values are sent as written; values without a known {'{SCHEME}'} prefix are stored in cleartext unless the server hashes them. Values that already carry a known scheme are never re-hashed.
                  </span>
                }
              />
            </div>
          )}
        </>
      )}

      {step === 'previewing' && (
        <BulkProgressView
          label="Dry run: checking records…"
          progress={progress}
          total={0}
          stopping={stopping}
          onStop={() => {
            setStopping(true);
            bulkApi.StopBulkRun(runIdRef.current);
          }}
        />
      )}

      {step === 'preview' && preview && (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="text-foreground font-medium tabular-nums">
              {preview.total} record{preview.total !== 1 ? 's' : ''}
            </span>
            {CHANGE_TYPES.map((ct) => (
              <span key={ct} className={cn('text-muted-foreground', (preview.byChangeType[ct] || 0) > 0 && 'text-foreground')}>
                {ct}: <span className="tabular-nums">{preview.byChangeType[ct] || 0}</span>
              </span>
            ))}
            {preview.version ? <span className="text-muted-foreground">version {preview.version}</span> : null}
          </div>
          {preview.stopped && <InlineAlert tone="warning" body={`Dry run stopped after ${preview.records.length} of ${preview.total} records.`} />}
          {preview.syntaxErrors.length > 0 && (
            <InlineAlert
              tone="danger"
              title={`${preview.syntaxErrors.length} syntax error${preview.syntaxErrors.length !== 1 ? 's' : ''}: fix ${preview.syntaxErrors.length !== 1 ? 'them' : 'it'} before applying.`}
              body={
                <ul className="space-y-0.5">
                  {fileErrors.map((e, i) => (
                    <li key={i}>
                      <button type="button" onClick={() => goToLine(e.line)} className="text-left font-mono text-xs hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus">
                        line {e.line}: {e.message}
                      </button>
                    </li>
                  ))}
                </ul>
              }
            />
          )}
          {preview.applicable && predictedFailures > 0 && (
            <InlineAlert
              tone="warning"
              body={`${predictedFailures} record${predictedFailures !== 1 ? 's are' : ' is'} predicted to fail. ${
                continueOnError ? 'They will be attempted and reported; the other records are applied.' : 'Without “continue on error” the run stops at the first failure.'
              }`}
            />
          )}
          <SegmentedControl
            aria-label="Show records"
            options={[
              { value: 'all' as RecordFilter, label: 'All', count: preview.records.length },
              { value: 'ok' as RecordFilter, label: 'ok', count: preview.byStatus.ok || 0 },
              { value: 'warning' as RecordFilter, label: 'Warnings', count: preview.byStatus.warning || 0 },
              { value: 'error' as RecordFilter, label: 'Will fail', count: preview.byStatus.error || 0 },
              { value: 'invalid' as RecordFilter, label: 'Syntax errors', count: preview.byStatus.invalid || 0 },
            ]}
            value={filter}
            onValueChange={(v) => {
              setFilter(v);
              setVisible(PAGE);
            }}
          />
          <div className="space-y-1.5">
            {records.slice(0, visible).map((r) => (
              <RecordView key={r.index} record={r} onGoToLine={tooLarge ? undefined : goToLine} />
            ))}
            {records.length === 0 && <div className="text-sm text-muted-foreground py-4 text-center">No records in this view</div>}
            {records.length > visible && (
              <Button size="sm" className="w-full" onClick={() => setVisible((v) => v + PAGE)}>
                Show {Math.min(PAGE, records.length - visible)} more of {records.length - visible}
              </Button>
            )}
          </div>
        </>
      )}

      {step === 'applying' && (
        <BulkProgressView
          label="Applying records…"
          progress={progress}
          total={preview?.total || 0}
          stopping={stopping}
          onStop={() => {
            setStopping(true);
            bulkApi.StopBulkRun(runIdRef.current);
          }}
        />
      )}

      {step === 'done' && result && (
        <BulkResultView
          result={result}
          onDownload={() => void saveReport()}
          showLines
          onRetry={readOnly || tooLarge ? undefined : retryFailed}
          // "Open in List": the created / changed entries as a results tab (DEF-17); the dialog closes.
          run={{ profileId, title: fileName ? `LDIF import: ${fileName}` : 'LDIF import', close: onClose }}
        />
      )}

      {confirmApply && (
        <ConfirmDialog
          title={confirmApply === 'direct' ? 'Apply without dry run' : 'Apply with predicted failures'}
          message={
            confirmApply === 'direct'
              ? `Apply the LDIF to "${connectionName}" without reviewing a dry run first?`
              : `${predictedFailures} record${predictedFailures !== 1 ? 's are' : ' is'} predicted to fail. Apply the file to "${connectionName}" anyway?`
          }
          detail={continueOnError ? 'Continue on error: on' : 'Continue on error: off (the run stops at the first failure)'}
          confirmLabel="Apply"
          tone="warning"
          onConfirm={() => {
            const fromPreview = confirmApply === 'preview';
            setConfirmApply(null);
            void runApply(fromPreview);
          }}
          onCancel={() => setConfirmApply(null)}
        />
      )}
      {passwordGuard.element}
    </Dialog>
  );
}

function RecordView({ record, onGoToLine }: { record: LDIFRecordPreview; onGoToLine?: (line: number) => void }) {
  const [showAttrs, setShowAttrs] = useState(false);
  const style = STATUS_STYLE[record.status] || STATUS_STYLE.error;
  return (
    <div className="border border-border rounded p-2 space-y-1.5 bg-background">
      <div className="flex items-center gap-2 min-w-0">
        <Badge tone={style.tone} className="shrink-0">{style.label}</Badge>
        <button type="button" onClick={() => onGoToLine?.(recordJumpLine(record))} disabled={!onGoToLine}
          className="text-xs text-muted-foreground font-mono shrink-0 rounded-xs enabled:hover:text-foreground enabled:hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus"
          title="Show in the editor"
          aria-label={`Line ${record.line}: show in the editor`}
        >
          L{record.line}
        </button>
        {record.changeType && <Badge tone="neutral" className="shrink-0">{record.changeType}</Badge>}
        <span className="font-mono text-xs text-foreground truncate" title={record.dn}>{record.dn || '(no DN)'}</span>
      </div>
      {record.summary && (
        <div className="text-xs text-muted-foreground break-words">
          {record.summary}
          {record.newDn && <span className="font-mono"> → {record.newDn}</span>}
        </div>
      )}
      <BulkMessages errors={record.errors} warnings={record.warnings} notes={record.notes} />
      {record.diffs && record.diffs.length > 0 && <BulkDiffView diffs={record.diffs} />}
      {record.attributes && record.attributes.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowAttrs(v => !v)} aria-expanded={showAttrs}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground rounded-xs focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus"
          >
            {showAttrs ? <ChevronDown size={12} strokeWidth={1.75} aria-hidden /> : <ChevronRight size={12} strokeWidth={1.75} aria-hidden />} {record.attributes.length} attribute{record.attributes.length !== 1 ? 's' : ''}
          </button>
          {showAttrs && (
            <div className="mt-1 border border-border rounded px-2 py-1 font-mono text-xs space-y-0.5">
              {record.attributes.map((a, i) => (
                <div key={i} className="break-all">
                  <span className="text-foreground">{a.name}</span>
                  <span className="text-muted-foreground">: {a.values.join(' | ')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1 << 20) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1 << 20)).toFixed(1)} MiB`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}
