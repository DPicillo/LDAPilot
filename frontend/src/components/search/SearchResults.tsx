/**
 * Search results (SPEC 10.2, UX-10): a DataTable with single-line rows
 * (--table-row-h), Name (object icon + status overlay), Type, Status,
 * Container and the chosen attribute columns (dates formatted, raw value in
 * the tooltip), checkbox multi-select with the bulk actions of the bulk track,
 * and a ContextMenu built from the command registry.
 *
 * Rows belong to the connection the search ran on (searchStore.resultsProfileId):
 * open, bookmark, Show in Tree and bulk use it. Registry verbs only act on the
 * active connection, so results of another connection get a short local menu
 * (open, Show in Tree, Copy DN, bookmark, bulk modify) instead.
 *
 * A plain click opens the entry in the preview tab, Enter too; double-click
 * and Ctrl+Enter open a pinned tab. F2 / Del / Ctrl+N / Ctrl+D run the
 * registry commands on the selection (data-command-scope="results").
 *
 * The same component shows a results tab (DEF-16) inside
 * <ResultsSnapshotContext value={tabId}>: rows, selection, sort, columns
 * and re-run are the tab's own (resultsView.ts); the tab is a 'list'
 * command source (registerListView), so menus, F2 / Del and the Entry menu
 * act on its checked rows. One column chooser (toolbar "Columns", DEF-15)
 * hides, shows and orders every column and adds / removes attribute columns.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ArrowRightLeft, CheckCircle2, ChevronDown, ChevronUp, ClipboardCopy, Columns3, Copy, Crosshair, Download, Eraser, ExternalLink, FileDown, ListChecks, Plus, RefreshCw, Search, Sparkles, Star, Trash2, X } from 'lucide-react'
import { useEditorStore } from '../../stores/editorStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useBookmarkStore } from '../../stores/bookmarkStore'
import { useTreeStore } from '../../stores/treeStore'
import { useUIStore } from '../../stores/uiStore'
import { accountStatusVersion, cachedAccountStatusKinds, subscribeAccountStatus } from '../../stores/accountStatusCache'
import type { LDAPEntry } from '../../types/ldap'
import { formatEntriesAsLDIF, sortParentFirst } from '../../lib/ldif'
import { firstRDN, getParentDN, parseRDN } from '../../lib/dn'
import { selectedInOrder } from '../../lib/bulk'
import { isComputedReportColumn } from '../../lib/accountReports'
import { SaveExportFile, savedMessage } from '../../lib/wails-export'
import { accountTimeLabel, readTableLayout, readableAttrDate, resultsFileName, sortRows, statusText, tableCSV, tableRows, tableTSV, visibleColumns, withDnColumn, type ExportColumn } from './resultsExport'
import { buildNameContainsFilter, quickObjectTypeFilter } from '../../lib/searchFilter'
import { openBatchDialog } from '../../stores/bulkDialogStore'
import { useSearchSelectionStore } from '../../stores/searchSelectionStore'
import { registerListView, setResultsFocus } from '../commands/selectionContext'
import { askAIAbout, askAIAboutTitle } from '../ai/aiCommands'
import { knownLoginAttributes, loginAttributesVersion, prefetchLoginAttributes, subscribeLoginAttributes } from '../commands/presence'
import { toast } from '../ui/Toast'
import { ConnectionTag, useProfileInfo } from '../bulk/BulkViews'
import { DataTable, type DataTableColumn } from '../ui/DataTable'
import { ObjectIcon } from '../ui/ObjectIcon'
import { KIND_ATTRIBUTES, OBJECT_KIND_LABEL, resolveObjectKind, type ObjectKind } from '../ui/objectKind'
import { deriveRowStatus, mergeRowStatus, type AccountStatus, type AccountStatusKind } from '../ui/accountStatus'
import { Button, IconButton } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { TruncatedText } from '../ui/TruncatedText'
import { Popover } from '../ui/Popover'
import { Combobox } from '../ui/Listbox'
import { Checkbox } from '../ui/Checkbox'
import { cn } from '../../lib/utils'
import { ContextMenu, CommandMenuItems, DropdownMenu, MenuHeader, MenuItem, MenuSeparator } from '../ui/Menu'
import { getCommandContext, type SelectionItem } from '../ui/commands'
import { toggleBookmark } from '../ui/coreCommands'
import { connectProfile, useShellState } from '../layout/shellState'
import { attributeNames, useSchema } from '../schema/schemaCache'
import { resultsActions, useResultsView } from './resultsView'
import { getSnapshot, setSnapshotFocus } from './resultsSnapshots'
import { RESULTS_LAYOUT_KEY, setResultsLayout, useResultsLayout } from './resultsLayout'
import { deletedEmptyState, moveColumnId, orderedColumnIds, setColumnShown } from './snapshotModel'
import { cachedAccountStatusKinds as cachedStatusOf } from '../../stores/accountStatusCache'

const COMMON_COLUMNS = [
  'cn', 'sn', 'givenName', 'displayName', 'mail', 'telephoneNumber',
  'sAMAccountName', 'userPrincipalName', 'description', 'title',
  'department', 'company', 'physicalDeliveryOfficeName', 'l', 'st', 'co',
  'memberOf', 'member', 'ou', 'uid', 'uidNumber', 'gidNumber',
  'homeDirectory', 'loginShell', 'whenCreated', 'whenChanged',
  'userAccountControl', 'objectCategory', 'distinguishedName',
  'lastLogonTimestamp', 'pwdLastSet', 'accountExpires',
];

/** Attributes shown as local date/time (raw value in the tooltip). */
const DATE_ATTRS = new Set([
  'whencreated', 'whenchanged', 'createtimestamp', 'modifytimestamp', 'lastlogontimestamp', 'lastlogon', 'lastlogoff',
  'pwdlastset', 'accountexpires', 'lockouttime', 'badpasswordtime', 'pwdchangedtime', 'pwdaccountlockedtime', 'pwdfailuretime',
  'shadowlastchange', 'msds-userpasswordexpirytimecomputed', 'dscorepropagationdata',
  // 389DS / OpenLDAP account times (sentinel values get their label: accountTimeLabel)
  'accountunlocktime', 'passwordexpirationtime', 'pwdlastsuccess', 'authtimestamp', 'lastlogintime', 'pwdupdatetime', 'retrycountresettime',
]);
/** Single DN-valued attributes shown as links (multi-valued ones stay text). */
const DN_ATTRS = new Set(['distinguishedname', 'manager', 'managedby', 'secretary']);

interface ResultRow {
  dn: string;
  entry: LDAPEntry;
  kind: ObjectKind;
  objectClass: string[];
  name: string;
  parent: string;
  statuses: (AccountStatus | AccountStatusKind)[];
}

/** The row's own attribute names when it returned a login attribute (then it is no contact), else undefined. */
function rowLoginAttributes(entry: LDAPEntry): string[] | undefined {
  const names = (entry.attributes ?? []).map((a) => a.name);
  return names.some((n) => KIND_ATTRIBUTES.some((k) => k.toLowerCase() === n.toLowerCase().split(';')[0])) ? names : undefined;
}

function objectClassOf(entry: LDAPEntry): string[] {
  return entry.attributes?.find((a) => a.name.toLowerCase() === 'objectclass')?.values || [];
}

/**
 * Status of a result row: the server's account status when it was read,
 * else what the returned attributes prove. A lock that rests on lockoutTime
 * alone and "never logged on" without a lastLogonTimestamp in the result are
 * dropped: a search returns only the attributes it asked for, and a wrong
 * status is worse than none.
 */
function rowStatus(profileId: string | null, entry: LDAPEntry): (AccountStatus | AccountStatusKind)[] {
  // The server decides the states it knows; "Expires in n days" / inactivity stay from the attributes.
  return mergeRowStatus(cachedAccountStatusKinds(profileId, entry.dn), deriveRowStatus(entry.attributes));
}

function attrValue(entry: LDAPEntry, name: string): string {
  const a = entry.attributes?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!a || !a.values?.length) return '';
  return a.values.length === 1 ? a.values[0] : a.values.join('; ');
}

export interface SearchResultsProps {
  /**
   * 'inline' (default): the result actions (selection + bulk, Show in Tree,
   * attribute columns, export) above the table (a results tab, below its
   * strip); 'none': the host shows <SearchResultsActions/> itself (the bottom
   * panel puts them in its tab bar next to its results strip).
   */
  toolbar?: 'inline' | 'none';
}

/** State and actions shared by the table and its toolbar (bottom panel tab bar or inline). */
function useResultActions() {
  const view = useResultsView();
  const results = view.results;
  // Bulk operations go to the connection the results were searched on,
  // which is not necessarily the active one.
  const resultsProfileId = view.profileId;
  const resultsConnection = useProfileInfo(resultsProfileId);
  const actions = useMemo(() => resultsActions(view.snapshotId), [view.snapshotId]);
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  // Row actions (open, show in tree, bookmark) also go to the results'
  // connection; results without a recorded connection use the active one.
  const rowProfileId = resultsProfileId ?? activeProfileId;
  const foreign = !!resultsProfileId && resultsProfileId !== activeProfileId;
  const checked = view.checked;
  const orderedDNs = useMemo(() => (results?.entries ?? []).map((e) => e.dn), [results]);
  const selected = useMemo(() => selectedInOrder(orderedDNs, checked), [orderedDNs, checked]);
  // LDAP persons without uid / a password are contacts (M-06): their login attribute
  // names come from one batched, unlogged read, then the rows re-render.
  const loginVersion = useSyncExternalStore(subscribeLoginAttributes, loginAttributesVersion, loginAttributesVersion);
  // A server status that lands in the cache (a menu read, an account action) updates the
  // row chips at once, as in the Contents list (RW2-P-01).
  const statusVersion = useSyncExternalStore(subscribeAccountStatus, accountStatusVersion, accountStatusVersion);
  useEffect(() => {
    if (!rowProfileId || !results?.entries?.length) return;
    // A row that returned uid / userPassword is a user already: only the others are read.
    prefetchLoginAttributes(rowProfileId, results.entries.filter((e) => !rowLoginAttributes(e)).map((e) => ({ dn: e.dn, objectClass: objectClassOf(e) })));
  }, [results, rowProfileId]);
  const rows = useMemo<ResultRow[]>(
    () =>
      (results?.entries ?? []).map((entry) => {
        const objectClass = objectClassOf(entry);
        const parent = getParentDN(entry.dn);
        return {
          dn: entry.dn,
          entry,
          kind: resolveObjectKind(objectClass, rowLoginAttributes(entry) ?? (rowProfileId ? knownLoginAttributes(rowProfileId, entry.dn) : undefined)),
          objectClass,
          name: parseRDN(firstRDN(entry.dn)).value || entry.dn,
          parent,
          statuses: rowStatus(rowProfileId, entry),
        };
      }),
    // loginVersion: login attribute names arrived (contact vs user); statusVersion: a cached
    // server status changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, rowProfileId, loginVersion, statusVersion],
  );

  const snapshotId = view.snapshotId;
  /** The highlighted row: the registry's 'results' source, or the tab's own (its 'list' source). */
  const focusRow = useCallback(
    (dn: string) => {
      if (snapshotId) setSnapshotFocus(snapshotId, dn);
      else setResultsFocus(dn);
    },
    [snapshotId],
  );
  const openEntry = useCallback(
    (dn: string, pin: boolean) => {
      if (!rowProfileId) return;
      focusRow(dn);
      useEditorStore.getState().openEntry(rowProfileId, dn, { preview: !pin });
    },
    [rowProfileId, focusRow],
  );

  // Show in Tree: the tree only shows the active connection, so results of
  // another connection switch to it first.
  const locateInTree = useCallback(
    async (dn: string) => {
      if (!rowProfileId) return;
      if (rowProfileId !== useConnectionStore.getState().activeProfileId) {
        if (!resultsConnection.connected) {
          toast.error('Cannot show the entry in the tree', `Connect to "${resultsConnection.name}" (the connection these results come from) first`);
          return;
        }
        useConnectionStore.getState().setActiveProfile(rowProfileId);
        toast.info(`Switched to "${resultsConnection.name}"`);
      }
      const ui = useUIStore.getState();
      ui.setActivity('explorer');
      if (!ui.sidebarVisible) ui.toggleSidebar();
      await useTreeStore.getState().locateInTree(rowProfileId, dn);
    },
    [rowProfileId, resultsConnection.connected, resultsConnection.name],
  );

  // Opens the batch dialog (global host) on the results' connection; the
  // changed rows, open editor tabs and the tree are refreshed afterwards.
  const canBulk = !!resultsProfileId && resultsConnection.connected;
  const bulkBlockedReason = !resultsProfileId
    ? 'The connection of these results is unknown'
    : !resultsConnection.connected
      ? `Connect to "${resultsConnection.name}" (the connection these results come from) first`
      : '';
  const openBulk = useCallback(
    (dns: string[]) => {
      if (!resultsProfileId || !canBulk) {
        toast.error('Bulk modify not possible', bulkBlockedReason);
        return;
      }
      const profileId = resultsProfileId;
      openBatchDialog({
        profileId,
        dns,
        initialMode: 'modify',
        // The rows of this view (panel or tab) follow the changes; module functions only.
        onApplied: (result) => actions.refreshAfterBulk(profileId, result),
      });
    },
    [resultsProfileId, canBulk, bulkBlockedReason, actions],
  );

  return { view, actions, results, resultsProfileId, resultsConnection, rowProfileId, foreign, checked, orderedDNs, selected, rows, openEntry, focusRow, locateInTree, canBulk, bulkBlockedReason, openBulk };
}

/** The grid's columns as text (CSV export, Copy Table): same ids as the DataTable columns below. */
function exportColumns(displayColumns: string[]): ExportColumn<ResultRow>[] {
  const fixed: ExportColumn<ResultRow>[] = [
    { id: 'name', header: 'Name', text: (r) => r.name },
    { id: 'type', header: 'Type', text: (r) => OBJECT_KIND_LABEL[r.kind] },
    { id: 'status', header: 'Status', text: (r) => statusText(r.statuses) },
    // The full container DN: the cell shows its name, the file needs the place.
    { id: 'container', header: 'Container', text: (r) => r.parent, sortValue: (r) => r.parent },
  ];
  const attrs = displayColumns.map((col): ExportColumn<ResultRow> => {
    const date = DATE_ATTRS.has(col.toLowerCase());
    return {
      id: `attr:${col}`,
      header: col,
      text: (r) => (date ? attrValues(r.entry, col).map((v) => readableAttrDate(col, v)).join('; ') : attrValue(r.entry, col)),
      sortValue: (r) => attrValue(r.entry, col),
    };
  });
  return [...fixed, ...attrs, { id: 'dn', header: 'DN', text: (r) => r.dn, defaultHidden: true }];
}

function attrValues(entry: LDAPEntry, name: string): string[] {
  return entry.attributes?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.values ?? [];
}

/** A sentinel account time value as its label (raw value in the tooltip); undefined = a date (DataTable's date renderer). */
function sentinelTimeCell(attr: string, raw: string): ReactNode {
  const label = raw ? accountTimeLabel(attr, raw) : null;
  if (!label) return undefined;
  return <TruncatedText text={label} tooltip={`raw: ${raw}`} className="text-muted-foreground" />;
}

/** Entries without the attributes a search added for type and status (they stay hidden unless requested). */
function withoutHidden(entries: LDAPEntry[], hidden: string[] | undefined, keep: string[]): LDAPEntry[] {
  if (!hidden?.length) return entries;
  const drop = new Set(hidden);
  for (const k of keep) drop.delete(k.toLowerCase());
  return entries.map((e) => ({ ...e, attributes: (e.attributes || []).filter((a) => !drop.has(a.name.toLowerCase())) }));
}

/** Entries without the computed columns of account reports (isComputedReportColumn), so the LDIF stays valid. */
function withoutComputed(entries: LDAPEntry[]): LDAPEntry[] {
  return entries.map((e) => (e.attributes?.some((a) => isComputedReportColumn(a.name)) ? { ...e, attributes: e.attributes.filter((a) => !isComputedReportColumn(a.name)) } : e));
}

/** File name of a results export: a report's name, else the base DN's name, else "search-results". */
function exportName(source: string | undefined, baseDN: string | undefined): string {
  // A report names the file ("disabled-accounts.csv"), a search its base (RW1-S-10).
  return resultsFileName(source, baseDN ? parseRDN(firstRDN(baseDN)).value : '');
}

/** The columns of the one column chooser (same ids as the grid and the exports). */
interface ChooserColumn {
  id: string;
  label: string;
  /** Attribute column (removable). */
  attr?: string;
  hideable?: boolean;
  defaultHidden?: boolean;
}

function chooserColumns(displayColumns: string[]): ChooserColumn[] {
  return [
    { id: 'name', label: 'Name', hideable: false },
    { id: 'type', label: 'Type' },
    { id: 'status', label: 'Status' },
    { id: 'container', label: 'Container' },
    ...displayColumns.map((c) => ({ id: `attr:${c}`, label: c, attr: c })),
    { id: 'dn', label: 'DN', defaultHidden: true },
  ];
}

/**
 * The result actions: selection count + bulk Modify / Clear, Show in Tree,
 * columns, export. The bottom panel renders it in its tab bar (SPEC 7.6),
 * a results tab above the table.
 */
export function SearchResultsActions({ className }: { className?: string }) {
  const { view, actions, results, resultsProfileId, resultsConnection, foreign, selected, rows, locateInTree, canBulk, bulkBlockedReason, openBulk } = useResultActions();
  const { displayColumns, sort: resultsSort, search: resultsSearch } = view;
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsBtn = useRef<HTMLButtonElement>(null);
  if (!results) return null;

  /** The rows as the grid shows them: visible columns in their order, sorted like the grid. */
  function visibleTable(onlySelected: boolean, withDn = false) {
    const all = exportColumns(displayColumns);
    const shown = visibleColumns(all, readTableLayout(RESULTS_LAYOUT_KEY));
    const cols = withDn ? withDnColumn(shown, all) : shown;
    const set = onlySelected ? new Set(selected) : null;
    const picked = set ? rows.filter((r) => set.has(r.dn)) : rows;
    const sorted = sortRows(picked, all.find((c) => c.id === resultsSort?.id), resultsSort?.dir);
    return tableRows(sorted, cols);
  }

  async function saveExport(kind: 'csv' | 'ldif', onlySelected: boolean) {
    if (!results) return;
    let content: string;
    let count: number;
    if (kind === 'csv') {
      const t = visibleTable(onlySelected, true);
      content = tableCSV(t.header, t.rows);
      count = t.rows.length;
    } else {
      const set = onlySelected ? new Set(selected) : null;
      const entries = set ? results.entries.filter((e) => set.has(e.dn)) : results.entries;
      // Parents first (importable), without the attributes added for type / status.
      // Computed report columns ("Locked since", "Days left": names with a blank) are no LDAP attributes.
      content = formatEntriesAsLDIF(sortParentFirst(withoutComputed(withoutHidden(entries, resultsSearch?.hidden, displayColumns))));
      count = entries.length;
    }
    if (!count) return;
    try {
      const path = await SaveExportFile(exportName(view.run?.source, resultsSearch?.params.baseDN ?? view.run?.baseDN), kind, content);
      // '' = cancelled; 'download' = browser download outside Wails
      if (path && path !== 'download') toast.success(savedMessage(count, path));
    } catch (err) {
      toast.error('Export failed', err instanceof Error ? err.message : String(err));
    }
  }

  function copyTable(onlySelected: boolean) {
    if (!results?.entries.length) return;
    const t = visibleTable(onlySelected);
    if (!t.rows.length) return;
    navigator.clipboard
      .writeText(tableTSV(t.header, t.rows))
      .then(() => toast.success(onlySelected ? `${t.rows.length} ${t.rows.length === 1 ? 'row' : 'rows'} copied` : 'Table copied'))
      .catch((err) => toast.error('Could not copy the table', err instanceof Error ? err.message : String(err)));
  }

  const tab = !!view.snapshotId;
  return (
    <div className={cn('flex items-center gap-1.5 min-w-0', className)} role="toolbar" aria-label="Result actions">
      {foreign && (
        <span
          className="inline-flex items-center gap-1 min-w-0 text-xs text-muted-foreground"
          title="These results come from another connection than the active one. Open, Show in Tree, bookmarks and bulk modify use that connection."
        >
          from <ConnectionTag profileId={resultsProfileId} />
        </span>
      )}
      {selected.length > 0 && (
        <>
          <span className="text-xs text-foreground tabular-nums shrink-0" aria-live="polite">
            {selected.length} selected
          </span>
          <Button
            size="sm"
            leftIcon={ListChecks}
            disabled={!canBulk}
            onClick={() => openBulk(selected)}
            title={canBulk ? `Bulk modify the selected entries on "${resultsConnection.name}" (dry run first)` : bulkBlockedReason}
          >
            Modify…
          </Button>
          <Button size="sm" variant="ghost" onClick={() => actions.clearSelection()} title="Uncheck all rows (the results stay)">
            Clear selection
          </Button>
        </>
      )}
      <span className="flex-1" />
      <IconButton label="Show in Tree" icon={Crosshair} size="md" disabled={selected.length !== 1} onClick={() => selected[0] && void locateInTree(selected[0])} />
      <IconButton
        ref={columnsBtn}
        label="Columns"
        icon={Columns3}
        size="md"
        aria-expanded={columnsOpen}
        aria-haspopup="dialog"
        onClick={() => setColumnsOpen((o) => !o)}
      />
      <DropdownMenu label="Export results" placement="bottom-end" trigger={<IconButton label="Export results" icon={FileDown} size="md" disabled={!results.entries.length} />}>
        <MenuItem icon={Download} label={`Export ${results.entries.length} as CSV…`} onSelect={() => void saveExport('csv', false)} />
        <MenuItem icon={Download} label={`Export ${results.entries.length} as LDIF…`} onSelect={() => void saveExport('ldif', false)} />
        {selected.length > 0 && (
          <>
            <MenuSeparator />
            <MenuItem icon={Download} label={`Export ${selected.length} selected as CSV…`} onSelect={() => void saveExport('csv', true)} />
            <MenuItem icon={Download} label={`Export ${selected.length} selected as LDIF…`} onSelect={() => void saveExport('ldif', true)} />
          </>
        )}
        <MenuSeparator />
        <MenuItem icon={ClipboardCopy} label="Copy Table" hint="visible columns" onSelect={() => copyTable(false)} />
        {selected.length > 0 && <MenuItem icon={ClipboardCopy} label={`Copy ${selected.length} Selected ${selected.length === 1 ? 'Row' : 'Rows'}`} onSelect={() => copyTable(true)} />}
      </DropdownMenu>
      {/* A results tab is closed with its tab (×); the panel's results can be cleared. */}
      {!tab && (
        <Button size="sm" variant="ghost" leftIcon={Eraser} onClick={() => actions.clear()} title="Clear the results">
          Clear
        </Button>
      )}
      <Popover open={columnsOpen} onOpenChange={setColumnsOpen} anchor={columnsBtn.current} placement="bottom-end" aria-label="Columns" className="p-2 w-80">
        <ResultsColumnChooser entries={results.entries} profileId={resultsProfileId} displayColumns={displayColumns} onAdd={actions.addColumn} onRemove={actions.removeColumn} />
      </Popover>
    </div>
  );
}

/** Command items of the tab's selection: checked rows, else the highlighted row (as the panel's 'results' source). */
function snapshotSelection(snapshotId: string): SelectionItem[] {
  const s = getSnapshot(snapshotId);
  if (!s) return [];
  const dns = s.checked.size > 0 ? [...s.checked] : s.focus ? [s.focus] : [];
  const byDn = new Map(s.results.entries.map((e) => [e.dn.toLowerCase(), e]));
  return dns.map((dn) => {
    const e = byDn.get(dn.toLowerCase());
    const oc = e?.attributes.find((a) => a.name.toLowerCase() === 'objectclass')?.values;
    const server = cachedStatusOf(s.profileId, dn);
    const evidence = e ? deriveRowStatus(e.attributes).map((x) => x.kind) : undefined;
    return { dn, profileId: s.profileId, objectClass: oc, status: server ?? (evidence?.length ? evidence : undefined) };
  });
}

export function SearchResults({ toolbar = 'inline' }: SearchResultsProps = {}) {
  const { view, actions, results, resultsProfileId, resultsConnection, foreign, checked, orderedDNs, rows, openEntry, focusRow, locateInTree, canBulk, openBulk } =
    useResultActions();
  const { displayColumns, sort: resultsSort, snapshotId } = view;
  const [menuPoint, setMenuPoint] = useState<{ clientX: number; clientY: number } | null>(null);
  // One column chooser (the toolbar's): the grid remounts with a changed layout and keeps its scroll position.
  const layoutVersion = useResultsLayout((s) => s.version);
  const scrollTop = useRef(0);

  // A results tab is a 'list' command source: its checked rows (else the highlighted one).
  const listHandle = useRef<ReturnType<typeof registerListView> | null>(null);
  useEffect(() => {
    if (!snapshotId || !resultsProfileId) return;
    const h = registerListView(snapshotId, { profileId: resultsProfileId, containerDN: '', selection: () => snapshotSelection(snapshotId) });
    listHandle.current = h;
    return () => {
      h.dispose();
      if (listHandle.current === h) listHandle.current = null;
    };
  }, [snapshotId, resultsProfileId]);

  const setSelection = useCallback(
    (keys: Set<string>) => {
      if (!results) return;
      actions.select(results, keys, null);
      if (keys.size > 0) listHandle.current?.selected();
    },
    [results, actions],
  );

  const columns = useMemo<DataTableColumn<ResultRow>[]>(() => {
    const fixed: DataTableColumn<ResultRow>[] = [
      {
        id: 'name',
        header: 'Name',
        width: 220,
        minWidth: 120,
        sortable: true,
        hideable: false,
        value: (r) => r.name,
        cell: (r) => (
          <span className="flex items-center gap-1.5 min-w-0">
            <ObjectIcon kind={r.kind} status={r.statuses} />
            <TruncatedText text={r.name} tooltip={<span className="font-mono">{r.dn}</span>} className="text-foreground" />
          </span>
        ),
      },
      {
        id: 'type',
        header: 'Type',
        width: 120,
        sortable: true,
        value: (r) => OBJECT_KIND_LABEL[r.kind],
        cell: (r) => <TruncatedText text={OBJECT_KIND_LABEL[r.kind]} tooltip={r.objectClass.filter((o) => o !== 'top').join(', ')} />,
      },
      { id: 'status', header: 'Status', width: 170, sortable: true, renderer: 'status', value: (r) => r.statuses },
      {
        id: 'container',
        header: 'Container',
        width: 170,
        sortable: true,
        value: (r) => r.parent,
        cell: (r) =>
          r.parent ? (
            <TruncatedText text={parseRDN(firstRDN(r.parent)).value || r.parent} tooltip={<span className="font-mono">{r.parent}</span>} />
          ) : (
            <span className="text-muted-foreground">(root)</span>
          ),
      },
    ];
    const attrs = displayColumns.map((col): DataTableColumn<ResultRow> => {
      const lower = col.toLowerCase();
      return {
        id: `attr:${col}`,
        header: col,
        width: DATE_ATTRS.has(lower) ? 140 : 160,
        sortable: true,
        value: (r) => attrValue(r.entry, col),
        renderer: DATE_ATTRS.has(lower) ? 'date' : lower === 'useraccountcontrol' ? 'uac' : DN_ATTRS.has(lower) ? 'dn' : 'text',
        // Sentinel account times ("Permanent (disabled)", "Must change at next logon") instead of a 1970 / invalid date.
        cell: DATE_ATTRS.has(lower) ? (r) => sentinelTimeCell(col, attrValue(r.entry, col)) : undefined,
      };
    });
    const dn: DataTableColumn<ResultRow> = { id: 'dn', header: 'DN', width: 320, sortable: true, renderer: 'dn', mono: true, defaultHidden: true, value: (r) => r.dn };
    return [...fixed, ...attrs, dn];
  }, [displayColumns]);

  if (!results) {
    return <EmptyState icon={Search} title="No search yet" hint="Run a search or a report to see results here." />;
  }

  return (
    <div
      className="h-full flex flex-col min-w-0"
      onFocusCapture={() => listHandle.current?.activate()}
      onPointerDownCapture={() => listHandle.current?.activate()}
    >
      {toolbar === 'inline' && (
        <div className="flex items-center h-8 px-2 border-b border-border shrink-0 min-w-0">
          <SearchResultsActions className="flex-1" />
        </div>
      )}

      <div className="flex-1 min-h-0">
        <DataTable<ResultRow>
          key={layoutVersion}
          aria-label={snapshotId ? 'Results' : 'Search results'}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.dn}
          selection="multi"
          selectedKeys={checked as Set<string>}
          onSelectionChange={setSelection}
          onRowClick={(r, e) => {
            focusRow(r.dn);
            if (e.ctrlKey || e.metaKey || e.shiftKey || e.detail > 1) return;
            // In the maximized bottom panel a click only selects: opening restores the panel, and
            // the second click of a double-click then landed in the entry view (RW3-R-03).
            // Enter / double-click open (and restore it).
            if (useShellState.getState().bottomMaximized && (e.currentTarget as HTMLElement).closest('[data-pane="panel"]')) return;
            openEntry(r.dn, false);
          }}
          onOpen={(r, { pin }) => openEntry(r.dn, pin)}
          onOpenDn={(dn) => openEntry(dn, false)}
          getRowDn={(r) => r.dn}
          onContextMenu={(point) => setMenuPoint(point)}
          virtualized
          // The toolbar's Columns chooser is the only one (DEF-15).
          columnChooser={false}
          persistKey={RESULTS_LAYOUT_KEY}
          initialScrollTop={scrollTop.current || undefined}
          onScrollTopChange={(top) => {
            scrollTop.current = top;
          }}
          // A results tab is a 'list' source (its own selection); the panel is 'results'.
          commandScope={snapshotId ? 'list' : 'results'}
          // The sort is kept across searches (searchStore.resultsSort) / per results tab.
          sort={resultsSort}
          onSortChange={(sort) => actions.setSort(sort)}
          // New results start at the Name column (the empty state's action may have scrolled right).
          resetScrollKey={view.runKey}
          empty={<NoResults />}
        />
      </div>

      <ContextMenu point={menuPoint} onClose={() => setMenuPoint(null)} label="Result actions">
        {() =>
          foreign ? (
            <ForeignResultMenu
              dns={selectedInOrder(orderedDNs, snapshotId ? (getSnapshot(snapshotId)?.checked ?? new Set()) : useSearchSelectionStore.getState().results === results ? useSearchSelectionStore.getState().checked : new Set())}
              connectionName={resultsConnection.name}
              connected={resultsConnection.connected}
              profileId={resultsProfileId!}
              canBulk={canBulk}
              onOpen={(dn) => openEntry(dn, true)}
              onLocate={(dn) => void locateInTree(dn)}
              onBulk={openBulk}
            />
          ) : (
            // The registry's entry.showInTree covers "Show in Tree" (same verbs as the tree menu).
            <CommandMenuItems ctx={snapshotId ? getCommandContext('list', { selection: snapshotSelection(snapshotId) }) : getCommandContext('results')} showDnHeader />
          )
        }
      </ContextMenu>
    </div>
  );
}

/** Local menu for results of another connection than the active one (registry verbs act on the active one only). */
function ForeignResultMenu({ dns, connectionName, connected, profileId, canBulk, onOpen, onLocate, onBulk }: {
  dns: string[];
  connectionName: string;
  connected: boolean;
  profileId: string;
  canBulk: boolean;
  onOpen: (dn: string) => void;
  onLocate: (dn: string) => void;
  onBulk: (dns: string[]) => void;
}) {
  const one = dns.length === 1 ? dns[0] : null;
  const bookmarked = useBookmarkStore((s) => (one ? s.isBookmarked(profileId, one) : false));
  return (
    <>
      <MenuHeader mono={!!one}>{one ?? `${dns.length} entries selected`}</MenuHeader>
      <MenuSeparator />
      {/* The registry verbs act on the active connection: one click switches (CMD-17). */}
      <MenuItem icon={ArrowRightLeft} label={`Switch to ${connectionName}`} onSelect={() => void connectProfile(profileId, { reveal: false })} />
      <MenuSeparator />
      {/* Single-entry verbs only for one row, as in the own multi-selection menu (RW1-S-13). */}
      {one && (
        <>
          <MenuItem icon={ExternalLink} label="Open" default onSelect={() => onOpen(one)} />
          <MenuItem icon={Crosshair} label="Show in Tree" hint="switches the connection" onSelect={() => onLocate(one)} />
        </>
      )}
      {/* The assistant works on every connected directory: Ask AI needs no switch (UX A-05, aiux R1). */}
      <MenuItem
        icon={Sparkles}
        label={askAIAboutTitle(profileId, dns.length)}
        hint={connected ? undefined : 'not connected'}
        disabled={!dns.length || !connected}
        onSelect={() => void askAIAbout(profileId, dns.map((dn) => ({ dn })))}
      />
      <MenuSeparator />
      <MenuItem
        icon={Copy}
        label={dns.length > 1 ? `Copy ${dns.length} DNs` : 'Copy DN'}
        disabled={!dns.length}
        onSelect={() => {
          navigator.clipboard
            .writeText(dns.join('\n'))
            .then(() => toast.success(dns.length === 1 ? 'DN copied' : `${dns.length} DNs copied`))
            .catch(() => {});
        }}
      />
      {one && (
        <MenuItem
          icon={Star}
          label={bookmarked ? 'Remove Bookmark' : 'Add Bookmark'}
          onSelect={() => {
            // Same toggle (and "Bookmarked X · Undo" toast) as every registry path (CMD-04).
            toggleBookmark(profileId, one);
          }}
        />
      )}
      <MenuSeparator />
      <MenuItem icon={ListChecks} label={dns.length > 1 ? `Modify ${dns.length} Entries…` : 'Modify…'} disabled={!dns.length || !canBulk} onSelect={() => onBulk(dns)} />
    </>
  );
}

/**
 * The one column chooser of the results (DEF-15): add an attribute column
 * (from the returned attributes or by name), show / hide every column,
 * reorder them, remove attribute columns. The add field comes first and
 * takes the focus, so typing adds and Enter never removes a column
 * (RW2-S-01); removing a column hands the focus on (RW3-S-06).
 */
function ResultsColumnChooser({ entries, profileId, displayColumns, onAdd, onRemove }: {
  entries: LDAPEntry[];
  profileId: string | null;
  displayColumns: string[];
  onAdd: (column: string) => void;
  onRemove: (column: string) => void;
}) {
  const [text, setText] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const layoutHidden = useResultsLayout((s) => s.hidden);
  const layoutOrder = useResultsLayout((s) => s.order);
  // Names this server's schema does not know are marked (an always empty column, RW3-S-03).
  const schema = useSchema(profileId);
  const known = useMemo(() => {
    const names = attributeNames(schema);
    return names.length ? new Set(names.map((n) => n.toLowerCase())) : null;
  }, [schema]);
  const unknown = (col: string) => !!known && !known.has(col.toLowerCase().split(';')[0]);

  const declared = useMemo(() => chooserColumns(displayColumns), [displayColumns]);
  const declaredIds = useMemo(() => declared.map((c) => c.id), [declared]);
  const hidden = useMemo(() => layoutHidden ?? declared.filter((c) => c.defaultHidden).map((c) => c.id), [layoutHidden, declared]);
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const ordered = useMemo(() => {
    const byId = new Map(declared.map((c) => [c.id, c]));
    return orderedColumnIds(declaredIds, layoutOrder).map((id) => byId.get(id)!);
  }, [declared, declaredIds, layoutOrder]);
  const visibleCount = ordered.filter((c) => !hiddenSet.has(c.id)).length;

  /** Focus after a change re-rendered the list: the same control of the row `id` (or the field). */
  const refocus = (selector: string) =>
    requestAnimationFrame(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(selector);
      (el ?? rootRef.current?.querySelector<HTMLElement>('input'))?.focus();
    });
  const removeColumn = (c: ChooserColumn, index: number) => {
    onRemove(c.attr!);
    requestAnimationFrame(() => {
      const buttons = rootRef.current?.querySelectorAll<HTMLElement>('button[data-remove-column]');
      const next = buttons?.[Math.min(index, (buttons?.length ?? 1) - 1)];
      (next ?? rootRef.current?.querySelector<HTMLElement>('input'))?.focus();
    });
  };
  const move = (id: string, dir: -1 | 1) => {
    setResultsLayout({ order: moveColumnId(declaredIds, layoutOrder, id, dir) });
    refocus(`[data-move-column="${CSS.escape(id)}:${dir}"]:not(:disabled)`);
  };
  const toggle = (id: string, on: boolean) => {
    setResultsLayout({ hidden: setColumnShown(declaredIds, hidden, id, on) });
    refocus(`[data-show-column="${CSS.escape(id)}"]`);
  };

  const options = useMemo(() => {
    const names = new Set(COMMON_COLUMNS);
    for (const e of entries) for (const a of e.attributes || []) names.add(a.name);
    const active = new Set(displayColumns.map((c) => c.toLowerCase()));
    return [...names].filter((n) => !active.has(n.toLowerCase())).sort((a, b) => a.localeCompare(b));
  }, [entries, displayColumns]);
  const add = (name: string) => {
    const n = name.trim();
    if (!n) return;
    onAdd(n);
    setText('');
  };
  const attrIndex = (c: ChooserColumn) => ordered.filter((o) => o.attr).indexOf(c);
  return (
    <div ref={rootRef} className="flex flex-col gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Columns</span>
      {/* The field first: the popover focuses it, so typing adds and Enter never removes a column (RW2-S-01). */}
      <div
        className="flex gap-1"
        onKeyDown={(e) => {
          // Enter on typed text adds it (the Combobox handles Enter on a listed option itself).
          if (e.key === 'Enter' && text.trim()) {
            e.preventDefault();
            add(text);
          }
        }}
      >
        <Combobox
          items={options}
          getKey={(a) => a}
          getLabel={(a) => a}
          inputValue={text}
          onInputChange={setText}
          onSelect={add}
          clearOnSelect
          placeholder="Add an attribute column"
          aria-label="Add an attribute column"
          mono
          size="sm"
          autoFocus
          // The suggestions open on typing / Down, not on the initial focus: they would cover the column list.
          openOnFocus={false}
        />
        <IconButton label="Add column" icon={Plus} size="md" disabled={!text.trim()} onClick={() => add(text)} />
      </div>
      <ul className="flex flex-col gap-0.5 max-h-72 overflow-auto -mx-1 px-1" aria-label="Columns in display order">
        {ordered.map((c, i) => {
          const shown = !hiddenSet.has(c.id);
          const odd = !!c.attr && unknown(c.attr);
          return (
            <li key={c.id} className="flex items-center gap-1 min-w-0" title={odd ? `${c.label} is not an attribute of this server's schema: the column stays empty` : undefined}>
              <Checkbox
                label={
                  <span className={cn('min-w-0 truncate', c.attr && 'font-mono', odd && 'text-warning')}>
                    {c.label}
                    {odd && <span className="sr-only"> (not in the schema)</span>}
                  </span>
                }
                checked={shown}
                disabled={c.hideable === false || (shown && visibleCount <= 1)}
                onCheckedChange={(on) => toggle(c.id, on)}
                data-show-column={c.id}
                className="flex-1 min-w-0"
              />
              {c.attr && (
                <IconButton label={`Remove column ${c.label}`} icon={Trash2} size="sm" noTooltip data-remove-column="" onClick={() => removeColumn(c, attrIndex(c))} />
              )}
              <IconButton label={`Move ${c.label} up`} icon={ChevronUp} size="sm" noTooltip disabled={i === 0} data-move-column={`${c.id}:-1`} onClick={() => move(c.id, -1)} />
              <IconButton label={`Move ${c.label} down`} icon={ChevronDown} size="sm" noTooltip disabled={i === ordered.length - 1} data-move-column={`${c.id}:1`} onClick={() => move(c.id, 1)} />
            </li>
          );
        })}
      </ul>
      {!displayColumns.length && <p className="text-xs text-muted-foreground">No attribute columns.</p>}
    </div>
  );
}

/**
 * Empty results; after an AD name resolution search (prefixes only):
 * "Search names containing …"; results deletions emptied say so (and
 * offer Search Again) instead of "No entries found · Check the filter".
 */
function NoResults() {
  const view = useResultsView();
  const rs = view.search;
  const loading = view.loading;
  const actions = resultsActions(view.snapshotId);
  // A report that found nothing is good news: its own positive text (ACCT-06).
  const reportEmpty = view.run?.empty;
  const notFound = view.run?.notFound;
  const deleted = deletedEmptyState(view.results);
  const anr = rs?.mode === 'quick' && rs.serverType === 'ad' && rs.quick?.attr === '*any' && !!rs.quick.text.trim();
  if (deleted) {
    return (
      <EmptyState
        variant="inline"
        icon={Trash2}
        title={deleted.title}
        hint={deleted.hint}
        action={
          view.rerunnable ? (
            <Button size="sm" leftIcon={RefreshCw} disabled={loading} onClick={() => void actions.rerun()}>
              Search Again
            </Button>
          ) : undefined
        }
      />
    );
  }
  if (reportEmpty && !anr) {
    return <EmptyState variant="inline" icon={CheckCircle2} title={`${reportEmpty}.`} />;
  }
  // A search with its own "not found" text (a stale bookmark's name search, RW3-R-01).
  if (notFound && !anr) {
    return <EmptyState variant="inline" icon={Search} title={notFound.title} hint={notFound.hint} />;
  }
  if (!anr || !rs?.quick) {
    return <EmptyState variant="inline" icon={Search} title="No entries found" hint={view.snapshot?.kind === 'list' ? 'None of these entries exists any more.' : 'Check the filter and the base DN.'} />;
  }
  const q = rs.quick;
  return (
    <EmptyState
      variant="inline"
      icon={Search}
      title={`No name starts with “${q.text.trim()}”`}
      hint="Name resolution matches the start of names, logins and e-mail addresses."
      action={
        <Button
          size="sm"
          leftIcon={Search}
          disabled={loading}
          onClick={() => {
            const filter = buildNameContainsFilter(q.text, 'ad', quickObjectTypeFilter(q.objectType, 'ad'));
            actions.searchWith(rs.profileId, filter, {
              mode: 'advanced',
              serverType: 'ad',
              overrides: { baseDN: rs.params.baseDN, scope: rs.params.scope, attributes: [], showDeleted: false, showRecycled: false, manageDsaIT: false },
            });
          }}
        >
          Search names containing “{q.text.trim()}”
        </Button>
      }
    />
  );
}

/** "Size limit reached · Load all": runs the results' search again without a limit. */
export function SizeLimitBadge() {
  const view = useResultsView();
  const rs = view.search;
  const loading = view.loading;
  const limit = rs?.params.sizeLimit ?? 0;
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      <Badge tone="warning" size="sm" title={limit ? `The search stopped after ${limit} entries` : 'The server returned only part of the result'}>
        Size limit reached
      </Badge>
      {rs && (
        <Button size="sm" variant="link" disabled={loading} onClick={() => void resultsActions(view.snapshotId).rerun({ sizeLimit: 0 })} title="Search again without a size limit">
          Load all
        </Button>
      )}
    </span>
  );
}

/** "Showing previous results — the last search failed / was cancelled: …" (one error surface, no toast). */
export function SearchFailureNote({ className }: { className?: string }) {
  const view = useResultsView();
  const failure = view.failure;
  const hasResults = !!view.results;
  if (!failure) return null;
  const cancelled = failure.kind === 'cancelled';
  // The reason first, without the backend's "LDAP search failed:" prefix ("failed" once; RW1-S-09).
  const reason = failure.message.replace(/^\s*(LDAP )?search failed:\s*/i, '');
  // The server's own diagnostic ("(No Such Object: acl_read: … acl_read.c:975)") goes to the
  // tooltip; "Previous results" comes first so the two lines always say the rows are old (RW2-S-04).
  const short = reason.replace(/\s*\(([^()]*:[^()]*)\)\s*$/, '');
  const text = hasResults
    ? cancelled
      ? 'Showing previous results — the last search was cancelled'
      : `Previous results — the last search failed: ${short}`
    : cancelled
      ? 'The search was cancelled'
      : `The search failed: ${short}`;
  const full = hasResults && !cancelled ? `Previous results — the last search failed: ${reason}` : cancelled ? text : `The search failed: ${reason}`;
  return (
    <span
      className={cn('min-w-0 line-clamp-2 break-words text-xs', cancelled ? 'text-muted-foreground' : 'text-destructive', className)}
      role={cancelled ? 'status' : 'alert'}
      title={`${full}\nFilter: ${failure.params.filter}\nBase DN: ${failure.params.baseDN}`}
    >
      {text}
    </span>
  );
}
