/**
 * Export (SPEC 10.2): an lg Dialog with Field-labelled controls, prefilled
 * with the selected / active DN (File ▸ Export…, Export Subtree…, the
 * Import / Export panel) or a list of DNs (multi-selection Export…, the
 * "ldapilot:export-request" event via BulkDialogHost).
 *
 * LDIF or CSV of this entry, one level or the subtree, optionally narrowed by
 * a filter and an attribute list. LDIF is written parents first with AD values
 * (objectGUID, objectSid, …) as raw bytes; "Importable" (default on,
 * remembered) leaves out server-maintained attributes, so the file can be
 * imported again (ExportService.Export). Preview shows the generated text;
 * Save to File… writes exactly that text through the "Export LDIF" / "Export
 * CSV" save dialog (named after the entry, in the last export folder) and
 * reports "n entries saved to <path>".
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardCopy, Download, Eye, ListChecks, Plus, X } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { Export, SaveExportFile, savedMessage, type ExportRequest } from '../../lib/wails-export'
import { firstRDN, parseRDN } from '../../lib/dn'
import { ScopeBase, ScopeOne, ScopeSub, type SearchScope } from '../../types/ldap'
import { toast } from '../ui/Toast'
import { Badge } from '../ui/Badge'
import { Dialog } from '../ui/Dialog'
import { Field } from '../ui/Field'
import { Input } from '../ui/Input'
import { Button, IconButton } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Combobox } from '../ui/Listbox'
import { InlineAlert } from '../ui/InlineAlert'
import { Disclosure } from '../ui/Disclosure'
import { ConnectionTag } from '../bulk/BulkViews'
import { useFilterCheck } from '../search/useFilterCheck'
import { suggestNames } from '../search/searchModel'
import { attributeNames, useSchema } from '../schema/schemaCache'

type ExportFormat = 'ldif' | 'csv';

const COMMON_CSV_COLUMNS = [
  'cn', 'sn', 'givenName', 'displayName', 'mail', 'telephoneNumber',
  'sAMAccountName', 'userPrincipalName', 'description', 'title',
  'department', 'company', 'physicalDeliveryOfficeName', 'l', 'st',
  'memberOf', 'member', 'ou', 'uid', 'objectClass',
  'whenCreated', 'whenChanged', 'userAccountControl',
];

const FORMATS = [
  { value: 'ldif' as const, label: 'LDIF' },
  { value: 'csv' as const, label: 'CSV' },
];
const SCOPES = [
  { value: String(ScopeBase), label: 'This entry' },
  { value: String(ScopeOne), label: 'One level' },
  { value: String(ScopeSub), label: 'Entry and subtree' },
];

const IMPORTABLE_KEY = 'ldapilot-export-importable';

function readImportable(): boolean {
  try {
    return localStorage.getItem(IMPORTABLE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writeImportable(v: boolean) {
  try {
    localStorage.setItem(IMPORTABLE_KEY, String(v));
  } catch {
    /* blocked storage */
  }
}

export interface ExportDialogProps {
  /** Entry or container to export (prefilled base DN). */
  dn?: string;
  /** Several entries (multi-selection); exported as they are, parents first. */
  dns?: string[];
  /** Connection to export from (default: the active one). */
  profileId?: string;
  /** Initial scope: Export Entry… of a leaf starts with "This entry" (RW3-R-06); default the subtree. */
  scope?: SearchScope;
  onClose: () => void;
}

export function ExportDialog({ dn, dns, profileId: profileProp, scope: initialScope, onClose }: ExportDialogProps) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const profileId = profileProp ?? activeProfileId;
  const profile = useConnectionStore((s) => s.profiles.find((p) => p.id === profileId) ?? null);
  const list = dns && dns.length > 0 ? dns : null;

  const [baseDN, setBaseDN] = useState(dn || profile?.baseDN || '');
  // A single entry chosen from a menu exports itself (Export Entry…), a container its subtree.
  const [scope, setScope] = useState<SearchScope>(initialScope ?? ScopeSub);
  const [format, setFormat] = useState<ExportFormat>('ldif');
  const formatBox = useRef<HTMLDivElement>(null);
  /** The checked Format radio (a ref object for Dialog's initialFocus). */
  const formatFocus = useMemo(() => ({
    get current() {
      return formatBox.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? null;
    },
  }), []);
  const [filter, setFilter] = useState('');
  const [importable, setImportable] = useState(readImportable);
  const [ldifAttrs, setLdifAttrs] = useState<string[]>([]);
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null);
  const [result, setResult] = useState<{ key: string; content: string; count: number; truncated?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [csvColumns, setCsvColumns] = useState<string[]>(['cn', 'mail', 'description', 'objectClass']);
  const [columnText, setColumnText] = useState('');
  const filterCheck = useFilterCheck(!list && filter.trim() ? filter.trim() : null);
  const schema = useSchema(profileId);
  const allAttrNames = useMemo(() => {
    const names = attributeNames(schema);
    const seen = new Set(names.map((n) => n.toLowerCase()));
    return [...COMMON_CSV_COLUMNS.filter((c) => !seen.has(c.toLowerCase())), ...names];
  }, [schema]);

  useEffect(() => writeImportable(importable), [importable]);

  const columns = format === 'csv' ? csvColumns : ldifAttrs;
  const setColumns = format === 'csv' ? setCsvColumns : setLdifAttrs;
  const request: ExportRequest = {
    format,
    dns: list ?? undefined,
    baseDN: baseDN.trim(),
    scope,
    filter: filter.trim() || undefined,
    attributes: columns.length ? columns : undefined,
    importable: format === 'ldif' ? importable : undefined,
  };
  const key = JSON.stringify([profileId, request]);
  const current = result && result.key === key ? result : null;
  const columnOptions = useMemo(
    () => suggestNames(allAttrNames, columnText, 60).filter((c) => !columns.some((s) => s.toLowerCase() === c.toLowerCase())),
    [allAttrNames, columnText, columns],
  );

  function addColumn(col: string) {
    const c = col.trim();
    if (c && !columns.some((s) => s.toLowerCase() === c.toLowerCase())) setColumns([...columns, c]);
    setColumnText('');
  }

  /** Generates the export text for the current settings (cached until they change). */
  async function generate() {
    if (!profileId || (!list && !baseDN.trim())) return null;
    if (current) return current;
    setError(null);
    try {
      const res = await Export(profileId, request);
      const r = { key, content: res.content, count: res.count, truncated: res.truncated };
      setResult(r);
      return r;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err) || 'Export failed');
      return null;
    }
  }

  async function handlePreview() {
    setBusy('preview');
    await generate();
    setBusy(null);
  }

  async function handleSave() {
    setBusy('save');
    try {
      const r = await generate();
      if (!r) return;
      const name = list ? `${list.length} entries` : parseRDN(firstRDN(baseDN.trim())).value || 'export';
      const path = await SaveExportFile(name, format, r.content);
      // '' = the save dialog was cancelled: nothing written, nothing to report.
      if (path && path !== 'download') {
        toast.success(savedMessage(r.count, path));
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err) || 'Save failed');
    } finally {
      setBusy(null);
    }
  }

  async function handleCopy() {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.content);
      toast.success(`${format.toUpperCase()} copied`);
    } catch (err) {
      toast.error('Could not copy', err instanceof Error ? err.message : String(err));
    }
  }

  const filterInvalid = filterCheck.status === 'invalid';
  const canRun = !!profileId && (!!list || !!baseDN.trim()) && !busy && (format === 'ldif' || csvColumns.length > 0) && !filterInvalid;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={list ? `Export ${list.length} Entries` : 'Export'}
      description={profileId ? <span className="inline-flex items-center gap-1">from <ConnectionTag profileId={profileId} /></span> : undefined}
      icon={Download}
      size="lg"
      dismissible={busy ? 'never' : 'always'}
      // A DN list starts on the Format choice: the attribute field opened its suggestions on
      // focus and swallowed the first Escape (RW2-N-09).
      initialFocus={list ? formatFocus : undefined}
      onSubmit={() => void handleSave()}
      footer={
        <>
          <Button onClick={onClose} disabled={!!busy}>
            Cancel
          </Button>
          {current && (
            <Button leftIcon={ClipboardCopy} onClick={() => void handleCopy()}>
              Copy
            </Button>
          )}
          <Button leftIcon={Eye} loading={busy === 'preview'} disabled={!canRun} onClick={() => void handlePreview()}>
            Preview
          </Button>
          <Button type="submit" variant="primary" leftIcon={Download} loading={busy === 'save'} disabled={!canRun}>
            Save to File…
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {!profileId && <InlineAlert tone="danger" body="Connect to a directory first." />}
        {list ? (
          <Disclosure title={`${list.length} selected entries`} icon={ListChecks} summary="exported as they are, parents first">
            <ul className="max-h-[140px] overflow-auto text-xs font-mono text-foreground space-y-0.5 px-1">
              {list.map((d) => (
                <li key={d} className="truncate" title={d}>
                  {d}
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : (
          <Field label="Base DN" required>
            <Input value={baseDN} onChange={(e) => setBaseDN(e.target.value)} mono spellCheck={false} placeholder="ou=People,dc=example,dc=com" />
          </Field>
        )}
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <div className="space-y-1" ref={formatBox}>
            <span id="export-format" className="block text-sm font-medium text-muted-foreground">
              Format
            </span>
            <SegmentedControl aria-labelledby="export-format" options={FORMATS} value={format} onValueChange={setFormat} size="md" />
          </div>
          {!list && (
            <div className="space-y-1">
              <span id="export-scope" className="block text-sm font-medium text-muted-foreground">
                Scope
              </span>
              <SegmentedControl aria-labelledby="export-scope" options={SCOPES} value={String(scope)} onValueChange={(v) => setScope(Number(v) as SearchScope)} size="md" />
            </div>
          )}
        </div>

        {format === 'ldif' && (
          <Checkbox
            checked={importable}
            onCheckedChange={setImportable}
            label="Importable (exclude operational attributes)"
            description="Leaves out what the server maintains (objectGUID, objectSid, whenCreated, uSNChanged, memberOf, entryUUID, modifyTimestamp, …) so the file can be imported again; objectClass is always kept."
          />
        )}

        {!list && (
          <Field label="Filter" hint="Optional: only entries matching it, e.g. (objectClass=user). Parents left out by a filter are not in the file.">
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} mono spellCheck={false} placeholder="(objectClass=*)" invalid={filterInvalid} />
          </Field>
        )}
        {filterInvalid && filterCheck.status === 'invalid' && <p className="-mt-2 text-xs text-destructive">{filterCheck.error}</p>}

        <div className="space-y-1.5">
          <span id="export-columns" className="block text-sm font-medium text-muted-foreground">
            {format === 'csv' ? 'Columns' : 'Attributes'}
          </span>
          <ul aria-labelledby="export-columns" className="flex flex-wrap gap-1">
            {columns.map((col) => (
              <li key={col}>
                <Badge tone="neutral" className="gap-0.5 font-mono pr-0.5">
                  {col}
                  <IconButton label={`Remove ${col}`} icon={X} size="sm" noTooltip className="size-4" onClick={() => setColumns(columns.filter((c) => c !== col))} />
                </Badge>
              </li>
            ))}
            {columns.length === 0 &&
              (format === 'csv' ? <li className="text-xs text-destructive">Add at least one column.</li> : <li className="text-xs text-muted-foreground">All attributes.</li>)}
          </ul>
          <div
            className="flex gap-1 max-w-[360px]"
            onKeyDown={(e) => {
              // Enter on typed text adds it (the Combobox handles Enter on a listed option itself).
              if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && columnText.trim()) {
                e.preventDefault();
                addColumn(columnText);
              }
            }}
          >
            <Combobox
              items={columnOptions}
              getKey={(c) => c}
              getLabel={(c) => c}
              filter={() => true}
              inputValue={columnText}
              onInputChange={setColumnText}
              onSelect={addColumn}
              clearOnSelect
              placeholder={format === 'csv' ? 'Add a column (any attribute)' : 'Only these attributes (optional)'}
              aria-label={format === 'csv' ? 'Add a column' : 'Add an attribute'}
              mono
              size="sm"
            />
            <IconButton label={format === 'csv' ? 'Add column' : 'Add attribute'} icon={Plus} size="md" disabled={!columnText.trim()} onClick={() => addColumn(columnText)} />
          </div>
        </div>

        {error && <InlineAlert tone="danger" body={error} />}

        <div className="space-y-1">
          <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            Preview
            {current && (
              <span className="text-xs font-normal tabular-nums">
                {current.count} {current.count === 1 ? 'entry' : 'entries'}
              </span>
            )}
          </span>
          {current?.truncated && <InlineAlert tone="warning" body="The search stopped at the server's size limit: the export is incomplete." />}
          {current ? (
            <pre className="text-xs font-mono whitespace-pre-wrap break-all text-foreground bg-background p-2 rounded border border-border max-h-[260px] overflow-auto">
              {current.content || '(empty)'}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground rounded border border-dashed border-border px-3 py-4 text-center">
              Preview shows the {format.toUpperCase()} before you save it.
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
