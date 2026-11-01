/**
 * Membership sub-tab (SPEC 10.2, UX-7): Members / Member Of, Direct/Effective
 * SegmentedControl, DataTable (virtualized) with primary group, nesting level,
 * cycle Badges and the path, a type SegmentedControl, SearchInput filter and
 * the add picker (Combobox popup with chips; DN, uid and multi-line paste).
 */
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTabView } from '../../stores/tabViewState'
import { ensureLoginAttributes, knownLoginAttributes } from '../commands/presence'
import {
  Users, User, UserPlus, Monitor, Contact, Globe, CircleHelp, Box, X, Trash2,
  RefreshCw, Repeat, ExternalLink, Layers, CornerDownRight, Copy, Crosshair, Download, Network, Table2,
} from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { refreshOpenTabsOf, useEditorStore } from '../../stores/editorStore'
import { firstRDN, parseRDN } from '../../lib/dn'
import { useTreeStore } from '../../stores/treeStore'
import { useUIStore } from '../../stores/uiStore'
import { openEntryWithIntent } from '../../stores/entryIntentStore'
import { SaveExportFile } from '../../lib/wails-export'
import { OBJECT_KIND_COLOR, OBJECT_KIND_ICON, resolveObjectKind } from '../ui/objectKind'
import { ContextMenu, MenuItem, MenuSeparator } from '../ui/Menu'
import { LDAPEntry, ScopeSub } from '../../types/ldap'
import type { MembershipDirection, MembershipItem, MembershipResult } from '../../types/membership'
import * as wails from '../../lib/wails'
import * as membershipApi from '../../lib/wails-membership'
import {
  MembershipMode, acceptsUidMembers, canRemoveItem, cycleCreatingValues, cycleText, describeMembershipChange, dnKey,
  filterMembershipItems, isCancelledMessage, isGroupEntry, isSelfReference, itemKey, listedDirectCount, membershipCSV,
  membershipExportName, membershipTable, membershipTooltip, objectTypeFromClasses, orderedTypeCounts, parseDNList,
  pickerEnterAction, pickerOptionCount, pickerSearchFilter, rankPickerHits, rawMembershipCounts, rawMembershipResult,
  rdnValue, removalValue, shownText, splitKnownMembers, typeLabel, uidOptionVisible, withSkippedUnchanged,
} from '../../lib/membership'
import { toast, useToastStore } from '../ui/Toast'
import { useEntryIntentStore } from '../../stores/entryIntentStore'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { cn } from '../../lib/utils'
import { Badge } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { Input, SearchInput } from '../ui/Input'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Tabs, TabPanel } from '../ui/Tabs'
import { DataTable, type DataTableColumn } from '../ui/DataTable'
import { InlineAlert } from '../ui/InlineAlert'
import { EmptyState } from '../ui/EmptyState'
import { Spinner } from '../ui/Spinner'
import { Tooltip } from '../ui/Tooltip'
import { ComboboxPopup, ListboxOptions } from '../ui/Listbox'

interface MembershipPanelProps {
  tabId: string;
}

/** Direct is the start of every tab's views; Effective is a choice of that tab (M-18). */
const DIRECT_MODES: Record<MembershipDirection, MembershipMode> = { members: 'direct', memberOf: 'direct' };

interface ResultCache {
  entry?: LDAPEntry;
  results: Record<string, MembershipResult>;
  errors: Record<string, string>;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}

export function MembershipPanel({ tabId }: MembershipPanelProps) {
  // EntryEditor stays mounted when the active tab changes: start with fresh
  // state (view, cache) for every tab.
  return <MembershipPanelContent key={tabId} tabId={tabId} />;
}

function MembershipPanelContent({ tabId }: MembershipPanelProps) {
  const tab = useEditorStore((s) => s.tabs.find(t => t.id === tabId));
  const entry = useEditorStore((s) => s.entries[tabId]);
  const refreshEntry = useEditorStore((s) => s.refreshEntry);
  const openEntry = useEditorStore((s) => s.openEntry);
  const profiles = useConnectionStore((s) => s.profiles);
  const isReadOnly = tab ? profiles.find(p => p.id === tab.profileId)?.readOnly ?? false : false;

  const isGroup = useMemo(() => isGroupEntry(entry), [entry]);
  // Kept per tab: switching tabs and back stays on Members / Member Of (M-18).
  const [view, setView] = useTabView<MembershipDirection>(tabId, 'membership.view', isGroup ? 'members' : 'memberOf');
  // Kept per tab too: "Show Effective Members" or the toggle on one tab no longer switch every
  // other tab and every later one to Effective (M-18 mode).
  const [modes, setModes] = useTabView<Record<MembershipDirection, MembershipMode>>(tabId, 'membership.modes', () => ({ ...DIRECT_MODES }));
  const [cache, setCache] = useState<ResultCache>({ results: {}, errors: {} });
  const [loading, setLoading] = useState(false);
  // Bumped by reload() so that the load effect runs again even when the
  // cleared cache yields the same dependency values as before.
  const [reloadToken, setReloadToken] = useState(0);
  // Request ID of the resolution in flight (for the Cancel button).
  const currentRequest = useRef<string | null>(null);

  useEffect(() => {
    if (!isGroup && view === 'members') setView('memberOf');
  }, [isGroup, view]);

  // A command asked for a view / mode / the add picker (openEntryWithIntent).
  const intent = useEntryIntentStore((s) => s.intents[tabId]);
  const [addRequest, setAddRequest] = useState(0);
  useEffect(() => {
    const m = intent?.membership;
    if (!intent || !m) return;
    const direction = m.direction === 'members' && !isGroup ? 'memberOf' : m.direction;
    setView(direction);
    if (m.mode) setModes((prev) => ({ ...prev, [direction]: m.mode! }));
    if (m.add) setAddRequest(intent.seq);
    useEntryIntentStore.getState().consume(tabId, intent.seq);
  }, [intent?.seq, tabId, isGroup]);

  const mode = modes[view];
  const key = `${view}:${mode}`;
  const valid = cache.entry === entry;
  const result = valid ? cache.results[key] : undefined;
  const error = valid ? cache.errors[key] : undefined;
  const cached = result !== undefined || error !== undefined;
  const profileId = tab?.profileId;
  const dn = tab?.dn;

  // Load the selected view when it is not cached for the current entry
  // version. A refresh of the entry (editor refresh button, after a change)
  // yields a new entry object and invalidates the cache. A load that is
  // superseded (view, mode or entry changed, reload) or whose panel goes
  // away is cancelled in the backend, so it does not keep searching.
  useEffect(() => {
    if (!profileId || !dn || !entry || cached) return;
    const requestId = membershipApi.newMembershipRequestId();
    const effective = mode === 'effective';
    let active = true;
    let settled = false;
    currentRequest.current = requestId;
    setLoading(true);
    const request = view === 'members'
      ? membershipApi.ResolveGroupMembers(profileId, dn, effective, requestId)
      : membershipApi.ResolveMemberOf(profileId, dn, effective, requestId);
    const store = (patch: Partial<Pick<ResultCache, 'results' | 'errors'>>) => setCache((c) => {
      const base = c.entry === entry ? c : { entry, results: {}, errors: {} };
      return {
        entry,
        results: { ...base.results, ...patch.results },
        errors: { ...base.errors, ...patch.errors },
      };
    });
    request.then(
      (res) => {
        settled = true;
        if (!active) return;
        store({ results: { [key]: res ?? rawMembershipResult(entry, view) } });
        setLoading(false);
      },
      (err) => {
        settled = true;
        if (!active) return;
        const msg = errorMessage(err);
        store({ errors: { [key]: isCancelledMessage(msg) ? 'Resolution cancelled.' : msg } });
        setLoading(false);
      },
    );
    return () => {
      active = false;
      if (currentRequest.current === requestId) currentRequest.current = null;
      if (!settled) {
        setLoading(false);
        membershipApi.CancelMembership(profileId, requestId).catch(() => {});
      }
    };
  }, [profileId, dn, entry, view, mode, key, cached, reloadToken]);

  const cancelLoad = useCallback(() => {
    const requestId = currentRequest.current;
    if (profileId && requestId) membershipApi.CancelMembership(profileId, requestId).catch(() => {});
  }, [profileId]);

  const setMode = useCallback((m: MembershipMode) => {
    setModes((prev) => ({ ...prev, [view]: m }));
  }, [view]);

  const reload = useCallback(() => {
    setCache((c) => ({ entry: c.entry, results: {}, errors: {} }));
    setReloadToken((n) => n + 1);
  }, []);

  // After a change: reload the entry (badge counts, attributes). The new
  // entry object invalidates the cached results, which loads the view once;
  // only when the entry could not be reloaded is the view reloaded directly.
  const afterChange = useCallback(async () => {
    if (!profileId || !dn) return;
    const before = useEditorStore.getState().entries[tabId];
    // Quiet: the panel stays mounted (no spinner remount) while the entry reloads.
    await refreshEntry(profileId, dn, { silent: true });
    if (useEditorStore.getState().entries[tabId] === before) reload();
  }, [tabId, profileId, dn, refreshEntry, reload]);

  if (!tab || !entry) {
    return <EmptyState variant="inline" title="No entry loaded" />;
  }

  const raw = rawMembershipCounts(entry);
  const tabCount = (dir: MembershipDirection) => {
    // Direct count from a loaded result (both modes report it), else the raw attribute count.
    const r = valid ? cache.results[`${dir}:direct`] ?? cache.results[`${dir}:effective`] : undefined;
    return r ? listedDirectCount(r) : dir === 'members' ? raw.members : raw.memberOf;
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <Tabs
        variant="sub"
        idPrefix="membership"
        aria-label="Membership views"
        items={[
          ...(isGroup ? [{ id: 'members', label: 'Members', icon: Users, count: tabCount('members') }] : []),
          { id: 'memberOf', label: 'Member Of', icon: Layers, count: tabCount('memberOf') },
        ]}
        value={view}
        onValueChange={(id) => setView(id as MembershipDirection)}
        className="shrink-0 bg-card"
      />
      <TabPanel idPrefix="membership" value={view} selected={view} className="flex-1 min-h-0 flex flex-col">
        <MembershipView
          key={`${tab.profileId}|${tab.dn}|${view}`}
          direction={view}
          mode={mode}
          onModeChange={setMode}
          result={result}
          error={error}
          loading={loading && !cached}
          profileId={tab.profileId}
          dn={tab.dn}
          entry={entry}
          readOnly={isReadOnly}
          onReload={reload}
          onCancel={cancelLoad}
          onChanged={afterChange}
          onNavigate={(target) => openEntry(tab.profileId, target)}
          addRequest={addRequest}
          onAddRequestHandled={() => setAddRequest(0)}
        />
      </TabPanel>
    </div>
  );
}

// --- One view (Members or Member Of) ---

interface MembershipViewProps {
  direction: MembershipDirection;
  mode: MembershipMode;
  onModeChange: (m: MembershipMode) => void;
  result?: MembershipResult;
  error?: string;
  loading: boolean;
  profileId: string;
  dn: string;
  entry: LDAPEntry;
  readOnly: boolean;
  onReload: () => void;
  onCancel: () => void;
  onChanged: () => Promise<void>;
  onNavigate: (dn: string) => void;
  /** Changes (non-zero) when a command asks to open the add picker. */
  addRequest?: number;
  /** The picker was opened for addRequest (it must not reopen when the view remounts). */
  onAddRequestHandled?: () => void;
}

function MembershipView({
  direction, mode, onModeChange, result, error, loading, profileId, dn, entry, readOnly, onReload, onCancel, onChanged, onNavigate, addRequest, onAddRequestHandled,
}: MembershipViewProps) {
  const [filter, setFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAdd, setShowAdd] = useState(false);
  useEffect(() => {
    if (!addRequest) return;
    if (!readOnly) setShowAdd(true);
    onAddRequestHandled?.();
  }, [addRequest]);
  // The picker unmounts with its focused input (Escape, Cancel, a successful
  // add): focus goes back to the Add button, not to <body>.
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const pickerWasOpen = useRef(false);
  useEffect(() => {
    if (pickerWasOpen.current && !showAdd) {
      const a = document.activeElement;
      if (!a || a === document.body) addBtnRef.current?.focus({ preventScroll: true });
    }
    pickerWasOpen.current = showAdd;
  }, [showAdd]);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<MembershipItem[] | null>(null);
  // Values that would create a circular nesting: added only after confirmation.
  const [confirmCycle, setConfirmCycle] = useState<{ values: string[]; cycles: string[] } | null>(null);
  const [menu, setMenu] = useState<{ point: { clientX: number; clientY: number }; rows: MembershipItem[] } | null>(null);
  const profile = useConnectionStore((s) => s.profiles.find(p => p.id === profileId));

  const isMembers = direction === 'members';
  const rootName = rdnValue(dn);
  const items = result?.items ?? [];
  const filtered = useMemo(() => filterMembershipItems(items, filter, typeFilter), [items, filter, typeFilter]);
  const byKey = useMemo(() => new Map(items.map((it) => [itemKey(it), it])), [items]);
  const existing = useMemo(() => new Set(items.filter((it) => it.direct && it.dn).map((it) => dnKey(it.dn))), [items]);

  // Drop selections that are no longer listed or removable.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((k) => {
        const it = byKey.get(k);
        return it !== undefined && canRemoveItem(it, readOnly);
      }));
      return next.size === prev.size ? prev : next;
    });
  }, [byKey, readOnly]);

  const showResult = useCallback((summary: ReturnType<typeof describeMembershipChange>) => {
    if (summary.level === 'error') toast.error(summary.message, summary.detail);
    else if (summary.level === 'warning') {
      useToastStore.getState().addToast('info', summary.message, { detail: summary.detail, duration: 10000 });
    } else if (summary.level === 'success') toast.success(summary.message);
    else toast.info(summary.message);
  }, []);

  /**
   * Adds the picked values: a group is never added to itself, values already
   * present are skipped (reported as unchanged, not sent), and values that
   * would close a circular nesting are added only after a confirmation.
   */
  async function handleAdd(picked: string[], cyclesConfirmed = false) {
    const self = picked.filter((v) => isSelfReference(v, dn));
    const values = picked.filter((v) => !isSelfReference(v, dn));
    if (self.length > 0) toast.error(`"${rootName}" cannot be a member of itself`, 'A group that contains itself only creates a circular nesting; it was not added.');
    if (values.length === 0) return;
    const { send, known } = splitKnownMembers(values, items);
    setBusy(true);
    try {
      if (!cyclesConfirmed && send.length > 0 && (isMembers || isGroupEntry(entry))) {
        // Members view: the entry's effective groups contain it already; Member Of
        // view (a group): its effective members are inside it already.
        const nesting = isMembers
          ? await membershipApi.ResolveMemberOf(profileId, dn, true, membershipApi.newMembershipRequestId())
          : await membershipApi.ResolveGroupMembers(profileId, dn, true, membershipApi.newMembershipRequestId());
        const cycles = cycleCreatingValues(send, (nesting?.items ?? []).map((it) => it.dn).filter(Boolean));
        if (cycles.length > 0) {
          setConfirmCycle({ values: picked, cycles });
          return;
        }
      }
      const res = send.length === 0
        ? null
        : isMembers
          ? await membershipApi.AddGroupMembers(profileId, dn, send)
          : await membershipApi.AddToGroups(profileId, dn, send);
      const summary = describeMembershipChange(withSkippedUnchanged(res, known), 'add', isMembers ? 'member' : 'group');
      showResult(summary);
      if (summary.level !== 'error') setShowAdd(false);
      if (res && res.changed.length > 0) {
        // The other side's open tabs ("Member of n groups", badge) follow (M-18).
        refreshOpenTabsOf(profileId, res.changed);
        await onChanged();
      }
    } catch (err) {
      toast.error(isMembers ? 'Failed to add members' : 'Failed to add to groups', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // --- Row actions (context menu), copy, export ---

  const openRow = (target: string, pin: boolean) => {
    if (pin) onNavigate(target);
    else useEditorStore.getState().openEntry(profileId, target, { preview: true });
  };

  async function showInTree(target: string) {
    const conn = useConnectionStore.getState();
    if (conn.activeProfileId !== profileId) conn.setActiveProfile(profileId);
    const ui = useUIStore.getState();
    ui.setActivity('explorer');
    if (!ui.sidebarVisible) ui.toggleSidebar();
    try {
      await useTreeStore.getState().locateInTree(profileId, target);
    } catch (err) {
      toast.error('Cannot show the entry in the tree', errorMessage(err));
    }
  }

  function showEffective(it: MembershipItem) {
    const group = it.objectType === 'group';
    openEntryWithIntent(profileId, it.dn, {
      subTab: 'members',
      membership: { direction: group ? 'members' : 'memberOf', mode: 'effective' },
    });
  }

  function copyText(text: string, message: string) {
    navigator.clipboard.writeText(text).then(() => toast.success(message), () => toast.error('Could not copy to the clipboard'));
  }

  const copyDNs = (rows: MembershipItem[]) => {
    const dns = rows.map((it) => it.dn || `memberUid: ${it.name}`);
    copyText(dns.join('\n'), dns.length === 1 ? 'DN copied' : `${dns.length} DNs copied`);
  };

  async function exportCSV() {
    try {
      // The export save dialog ("Export CSV", last export folder), not the report one.
      const path = await SaveExportFile(membershipExportName(dn, direction, mode === 'effective').replace(/\.csv$/i, ''), 'csv', membershipCSV(filtered));
      if (path && path !== 'download') toast.success(`${filtered.length} ${filtered.length === 1 ? 'row' : 'rows'} exported to ${path}`);
    } catch (err) {
      toast.error('Export failed', errorMessage(err));
    }
  }

  async function removeItems(list: MembershipItem[]) {
    if (list.length === 0) return;
    const values = list.map(removalValue);
    setRemoving(list.length === 1 ? itemKey(list[0]) : '*');
    try {
      const res = isMembers
        ? await membershipApi.RemoveGroupMembers(profileId, dn, values)
        : await membershipApi.RemoveFromGroups(profileId, dn, values);
      showResult(describeMembershipChange(res, 'remove', isMembers ? 'member' : 'group'));
      setSelected(new Set());
      if (res.changed.length > 0) {
        refreshOpenTabsOf(profileId, res.changed);
        await onChanged();
      }
    } catch (err) {
      toast.error(isMembers ? 'Failed to remove members' : 'Failed to remove from groups', errorMessage(err));
    } finally {
      setRemoving(null);
    }
  }

  const removableFiltered = useMemo(() => filtered.filter((it) => canRemoveItem(it, readOnly)), [filtered, readOnly]);
  const selectedItems = [...selected].map((k) => byKey.get(k)).filter((it): it is MembershipItem => !!it);

  const typeCounts = orderedTypeCounts(result?.typeCounts);
  const emptyText = filter || typeFilter
    ? 'No matching entries'
    : isMembers ? 'This group has no members' : 'Not a member of any group';

  const columns: DataTableColumn<MembershipItem>[] = [
    {
      id: 'name',
      header: isMembers ? 'Member' : 'Group',
      width: 260,
      minWidth: 140,
      sortable: true,
      hideable: false,
      value: (it) => it.name,
      cell: (it) => (
        <Tooltip content={<span className="whitespace-pre-line">{membershipTooltip(rootName, it, direction)}</span>}>
          <span className="flex items-center gap-1.5 min-w-0">
            <TypeIcon
              type={it.objectType}
              className={cn(it.unresolved ? 'text-destructive' : it.objectType === 'group' && !it.external ? 'text-oc-group' : 'text-muted-foreground')}
            />
            {it.dn ? (
              <button type="button"
                tabIndex={-1}
                onClick={(e) => { e.stopPropagation(); onNavigate(it.dn); }}
                className="truncate text-left text-primary hover:underline"
              >
                {it.name}
              </button>
            ) : (
              <span className="truncate">{it.name}</span>
            )}
            {it.self && <Badge tone="warning" className="shrink-0" title="The group is stored as a member of itself; remove it here">itself</Badge>}
            {it.primary && <Badge tone="primary" className="shrink-0">{it.primary === 'posix' ? 'primary (gid)' : 'primary'}</Badge>}
            {it.inCycle && <Badge tone="warning" icon={Repeat} className="shrink-0">cycle</Badge>}
            {it.unresolved && <Badge tone="danger" className="shrink-0">{it.dn ? 'not found' : 'no account'}</Badge>}
            {it.external && <Badge className="shrink-0">other server</Badge>}
          </span>
        </Tooltip>
      ),
    },
    {
      id: 'type',
      header: 'Type',
      width: 100,
      sortable: true,
      value: (it) => it.objectType,
      cell: (it) => <span className="text-muted-foreground">{typeLabel(it.objectType, 1).replace(/^1 /, '')}</span>,
    },
    {
      id: 'level',
      header: 'Level',
      width: 70,
      sortable: true,
      align: 'right',
      value: (it) => it.depth,
      defaultHidden: mode !== 'effective',
      cell: (it) => it.depth === 0
        ? <span className="text-muted-foreground">unknown</span>
        : <span className={cn('tabular-nums', it.depth === 1 && 'text-muted-foreground')}>{it.depth === 1 ? 'direct' : it.depth}</span>,
    },
    {
      id: 'via',
      header: 'Via / DN',
      minWidth: 120,
      value: (it) => (it.path.length ? it.path.map(rdnValue).join(' > ') : it.dn),
      cell: (it) => it.path.length > 0 ? (
        <span className="flex items-center gap-0.5 min-w-0 text-muted-foreground">
          <CornerDownRight size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
          via{' '}
          {it.path.map((p, i) => (
            <span key={p + i} className="contents">
              {i > 0 && <span className="shrink-0" aria-hidden>→</span>}
              <button type="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); onNavigate(p); }} className="truncate text-primary hover:underline">
                {rdnValue(p)}
              </button>
            </span>
          ))}
        </span>
      ) : (
        <span className="block truncate font-mono text-muted-foreground" title={it.dn || undefined}>{it.dn || `memberUid: ${it.name}`}</span>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      width: 64,
      hideable: false,
      cell: (it) => (
        <span className="flex items-center gap-0.5">
          {it.dn && <IconButton label={`Open ${it.name}`} icon={ExternalLink} revealOnRowHover onClick={(e) => { e.stopPropagation(); onNavigate(it.dn); }} />}
          {canRemoveItem(it, readOnly) && (
            <IconButton
              label={isMembers ? `Remove ${it.name} from the group` : `Remove from ${it.name}`}
              icon={removing === itemKey(it) ? <Spinner size="sm" decorative /> : Trash2}
              revealOnRowHover
              disabled={removing !== null}
              className="enabled:hover:text-destructive"
              onClick={(e) => { e.stopPropagation(); setConfirmRemove([it]); }}
            />
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card shrink-0 min-w-0">
        <SegmentedControl
          aria-label="Membership mode"
          value={mode}
          onValueChange={onModeChange}
          options={[
            { value: 'direct', label: 'Direct', ariaLabel: isMembers ? 'Direct members and accounts with this primary group' : 'Direct groups and the primary group' },
            { value: 'effective', label: 'Effective', ariaLabel: isMembers ? 'All members including those of nested groups' : 'All groups including those inherited through nesting' },
          ]}
        />
        <SummaryText result={result} loading={loading} shown={filtered.length} />
        <div className="flex-1" />
        <IconButton label="Copy as Table" icon={Table2} onClick={() => copyText(membershipTable(filtered), `${filtered.length} ${filtered.length === 1 ? 'row' : 'rows'} copied as a table`)} disabled={!result || filtered.length === 0} />
        <IconButton label="Export CSV…" icon={Download} onClick={() => void exportCSV()} disabled={!result || filtered.length === 0} />
        <IconButton label="Reload" icon={RefreshCw} onClick={onReload} disabled={loading} />
        {!readOnly && (
          <Button ref={addBtnRef} size="sm" variant="ghost" leftIcon={UserPlus} aria-expanded={showAdd} onClick={() => setShowAdd((v) => !v)}>
            {isMembers ? 'Add Members' : 'Add to Groups'}
          </Button>
        )}
      </div>

      {showAdd && !readOnly && (
        <MemberPicker
          profileId={profileId}
          baseDN={profile?.baseDN || ''}
          groupsOnly={!isMembers}
          acceptsUid={isMembers && acceptsUidMembers(entry)}
          exclude={existing}
          selfDN={dn}
          busy={busy}
          onSubmit={handleAdd}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {/* Filter + type counts */}
      <div className="flex items-center gap-2 px-3 py-1 border-b border-border shrink-0 min-w-0">
        <SearchInput
          size="sm"
          value={filter}
          onValueChange={setFilter}
          placeholder={isMembers ? 'Filter members' : 'Filter groups'}
          aria-label={isMembers ? 'Filter members' : 'Filter groups'}
          wrapperClassName="flex-1 min-w-[120px] max-w-[320px]"
        />
        {typeCounts.length > 1 && (
          <div className="overflow-x-auto min-w-0">
            <SegmentedControl
              aria-label="Show type"
              value={typeFilter ?? 'all'}
              onValueChange={(v) => setTypeFilter(v === 'all' ? null : v)}
              options={[
                { value: 'all', label: 'All' },
                ...typeCounts.map(({ type, count }) => ({ value: type, label: typeLabel(type, count).replace(/^\d+ /, ''), count, icon: TYPE_ICONS[type] ?? CircleHelp })),
              ]}
            />
          </div>
        )}
        {!readOnly && selected.size > 0 && (
          <Button
            size="sm"
            variant="danger-ghost"
            leftIcon={Trash2}
            loading={removing === '*'}
            disabled={removing !== null}
            onClick={() => setConfirmRemove(selectedItems)}
            className="ml-auto shrink-0"
          >
            {/* The row menu's wording (DEF-19: check several Member Of rows, remove them in one go; a confirmation follows). */}
            {isMembers
              ? (selected.size > 1 ? `Remove ${selected.size} from Group…` : 'Remove from Group…')
              : `Remove from ${selected.size} ${selected.size === 1 ? 'Group' : 'Groups'}…`}
          </Button>
        )}
      </div>

      {/* Notices: cycles, truncation, warnings, errors */}
      {result && result.cycles.length > 0 && (
        <InlineAlert
          tone="warning"
          className="mx-3 mt-2 shrink-0"
          title={`Circular group nesting detected (${result.cycles.length})`}
          body={
            <>
              {result.cycles.slice(0, 3).map((c, i) => (
                <div key={i} className="truncate" title={c.path.join('\n→ ')}>{cycleText(c)}</div>
              ))}
              {result.cycles.length > 3 && <div>and {result.cycles.length - 3} more</div>}
            </>
          }
        />
      )}
      {result && (result.truncated || result.warnings.length > 0) && (
        <InlineAlert
          tone="info"
          className="mx-3 mt-2 shrink-0"
          body={
            <>
              {result.warnings.map((w, i) => <div key={i}>{w}</div>)}
              {result.truncated && result.warnings.length === 0 && <div>The list is incomplete.</div>}
            </>
          }
        />
      )}
      {error && (
        <InlineAlert
          tone="danger"
          className="mx-3 mt-2 shrink-0"
          body={<span className="break-words">{error}</span>}
          actions={<Button size="sm" variant="secondary" onClick={onReload}>Retry</Button>}
        />
      )}

      {/* List */}
      <div
        className="flex-1 min-h-0 mt-1"
        onKeyDown={(e) => {
          // DataTable copies the selected (or focused) rows' DNs on Ctrl+C: confirm it.
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !e.shiftKey && !e.altKey && e.defaultPrevented) {
            const n = selected.size || 1;
            toast.success(n === 1 ? 'DN copied' : `${n} DNs copied`);
          }
        }}
      >
        {loading && !result ? (
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-6" role="status">
            <Spinner size="sm" decorative />
            {mode === 'effective' ? 'Resolving nested groups…' : 'Loading…'}
            <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
          </div>
        ) : !result ? null : (
          <DataTable
            aria-label={isMembers ? 'Members' : 'Groups'}
            columns={columns}
            rows={filtered}
            rowKey={itemKey}
            selection={readOnly || removableFiltered.length === 0 ? 'none' : 'multi'}
            // Only direct, removable rows have a usable checkbox (DEF-19): not the primary group or nested-only groups.
            rowSelectable={(it) => canRemoveItem(it, readOnly)}
            selectedKeys={selected}
            onSelectionChange={(keys) => setSelected(new Set([...keys].filter((k) => {
              const it = byKey.get(k);
              return !!it && canRemoveItem(it, readOnly);
            })))}
            onOpen={(it, { pin }) => it.dn && openRow(it.dn, pin)}
            onContextMenu={(point, rows) => rows.length && setMenu({ point, rows })}
            onDelete={readOnly ? undefined : (list) => {
              const removable = list.filter((it) => canRemoveItem(it, readOnly));
              if (removable.length) setConfirmRemove(removable);
            }}
            getRowDn={(it) => it.dn}
            virtualized
            columnChooser
            persistKey={`membership-${direction}`}
            defaultSort={{ id: 'name', dir: 'asc' }}
            empty={<EmptyState variant="inline" icon={Users} title={emptyText} />}
          />
        )}
      </div>

      <ContextMenu point={menu?.point ?? null} onClose={() => setMenu(null)} label={isMembers ? 'Member actions' : 'Group actions'}>
        {() => {
          const rows = menu?.rows ?? [];
          const one = rows.length === 1 ? rows[0] : null;
          const removable = rows.filter((it) => canRemoveItem(it, readOnly));
          return (
            <>
              <MenuItem icon={ExternalLink} label="Open" default disabled={!one?.dn} onSelect={() => one?.dn && openRow(one.dn, false)} />
              <MenuItem icon={Layers} label="Open in New Tab" disabled={!one?.dn} onSelect={() => one?.dn && openRow(one.dn, true)} />
              <MenuItem icon={Crosshair} label="Show in Tree" disabled={!one?.dn || !!one?.external} onSelect={() => one?.dn && void showInTree(one.dn)} />
              <MenuItem
                icon={Network}
                label={one?.objectType === 'group' ? 'Show Effective Members…' : 'Show Effective Membership…'}
                disabled={!one?.dn || !!one?.external}
                onSelect={() => one && showEffective(one)}
              />
              <MenuSeparator />
              <MenuItem icon={Copy} label={rows.length > 1 ? `Copy ${rows.length} DNs` : 'Copy DN'} shortcut="Mod+C" onSelect={() => copyDNs(rows)} />
              {!readOnly && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    icon={Trash2}
                    tone="danger"
                    label={isMembers
                      ? (removable.length > 1 ? `Remove ${removable.length} from Group…` : 'Remove from Group…')
                      : (removable.length > 1 ? `Remove from ${removable.length} Groups…` : 'Remove from Group…')}
                    shortcut="Del"
                    disabled={removable.length === 0 || removing !== null}
                    onSelect={() => setConfirmRemove(removable)}
                  />
                </>
              )}
            </>
          );
        }}
      </ContextMenu>

      {confirmCycle && (
        <ConfirmDialog
          title="Create a circular nesting?"
          tone="warning"
          // Both groups by name (M-23): "this group" read as the open group itself.
          message={(() => {
            const names = confirmCycle.cycles.map((c) => `"${parseRDN(firstRDN(c)).value || c}"`);
            const list = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
            return isMembers
              ? `${list} already ${names.length === 1 ? 'contains' : 'contain'} "${rootName}" (nested). Adding ${names.length === 1 ? 'it' : 'them'} as ${names.length === 1 ? 'a member' : 'members'} of "${rootName}" creates a cycle (A ∈ B ∈ A): effective memberships become ambiguous.`
              : `${list} ${names.length === 1 ? 'is' : 'are'} already (nested) inside "${rootName}". Adding "${rootName}" to ${names.length === 1 ? 'it' : 'them'} creates a cycle (A ∈ B ∈ A).`;
          })()}
          detail={confirmCycle.cycles}
          confirmLabel="Add Anyway"
          onConfirm={() => {
            const values = confirmCycle.values;
            setConfirmCycle(null);
            void handleAdd(values, true);
          }}
          onCancel={() => setConfirmCycle(null)}
        />
      )}

      {confirmRemove && (
        <ConfirmDialog
          title={isMembers ? 'Remove members' : 'Remove from groups'}
          message={isMembers
            ? `Remove ${confirmRemove.length} member${confirmRemove.length === 1 ? '' : 's'} from "${rootName}"?`
            : `Remove "${rootName}" from ${confirmRemove.length} group${confirmRemove.length === 1 ? '' : 's'}?`}
          detail={confirmRemove.map((it) => it.dn || `memberUid: ${it.name}`)}
          confirmLabel="Remove"
          tone="danger"
          onConfirm={() => {
            const list = confirmRemove;
            setConfirmRemove(null);
            removeItems(list);
          }}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </div>
  );
}

function SummaryText({ result, loading, shown }: { result?: MembershipResult; loading: boolean; shown: number }) {
  if (!result) {
    return loading ? <Spinner size="sm" label="Loading" /> : null;
  }
  const total = result.items.length;
  const parts: string[] = [];
  const filteredText = shownText(shown, total);
  if (result.effective) {
    parts.push(`${result.directCount} direct`, `${total} total`);
    if (result.maxDepth > 1) parts.push(`depth ${result.maxDepth}`);
  } else {
    parts.push(`${total}`);
  }
  const title = result.method === 'raw'
    ? 'From the entry attributes'
    : `${result.queries} LDAP request${result.queries === 1 ? '' : 's'}, ${result.durationMs} ms (${result.method})`;
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums truncate" title={title}>
      {loading && <Spinner size="sm" decorative />}
      {parts.join(' · ')}
      {filteredText && <span className="text-foreground">· {filteredText}</span>}
      {result.truncated && <span className="text-warning">· incomplete</span>}
    </span>
  );
}

const TYPE_ICONS: Record<string, typeof User> = {
  user: User,
  group: Users,
  computer: Monitor,
  contact: Contact,
  foreignSecurityPrincipal: Globe,
  other: Box,
};

/** Icon of a picker hit: the tree's object kind (OU, device, …), else the membership type. */
function KindIcon({ classes, type }: { classes: string[]; type: string }) {
  // The resolved type wins for persons: an LDAP person without a login is a contact (M-06).
  const kind = type === 'contact' ? 'contact' : resolveObjectKind(classes);
  if (kind === 'other') return <TypeIcon type={type} className="text-muted-foreground" />;
  const Icon = OBJECT_KIND_ICON[kind];
  return <Icon size={14} strokeWidth={1.75} aria-hidden className={cn('shrink-0', OBJECT_KIND_COLOR[kind])} />;
}

function TypeIcon({ type, size = 14, className }: { type: string; size?: number; className?: string }) {
  const Icon = TYPE_ICONS[type] ?? CircleHelp;
  return <Icon size={size} strokeWidth={1.75} aria-hidden className={cn('shrink-0', className)} />;
}

// --- Picker for adding members / groups ---

interface Suggestion {
  dn: string;
  name: string;
  type: string;
  /** objectClass values: the icon follows the tree's object kinds on every server. */
  classes: string[];
}

/**
 * Search-as-you-type picker that collects several DNs (chips) and submits
 * them together. Enter adds the highlighted suggestion (or the only one) or a
 * typed DN to the chips; with an empty input it submits. Pasting several
 * lines adds one chip per line. For posix groups a plain uid is added only
 * through the explicit "Add memberUid" option, never from a search term.
 * Ctrl+Enter submits the chips; leftover input is not submitted.
 */
function MemberPicker({ profileId, baseDN, groupsOnly, acceptsUid, exclude, selfDN, busy, onSubmit, onCancel }: {
  profileId: string;
  baseDN: string;
  groupsOnly: boolean;
  acceptsUid: boolean;
  exclude: Set<string>;
  selfDN: string;
  busy: boolean;
  onSubmit: (values: string[]) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [chips, setChips] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  // The (trimmed) text the suggestions belong to; differs from the input
  // while a search is pending.
  const [searchedFor, setSearchedFor] = useState('');
  const [searching, setSearching] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchSeq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // The popup anchors to the input element held in state (a ref read during
  // render can name an element the same commit replaces).
  const [inputEl, setInputEl] = useState<HTMLInputElement | null>(null);
  const setInput = useCallback((el: HTMLInputElement | null) => {
    inputRef.current = el;
    setInputEl(el);
  }, []);
  const wrapRef = useRef<HTMLDivElement>(null);

  const chipKeys = useMemo(() => new Set(chips.map(dnKey)), [chips]);

  useEffect(() => {
    clearTimeout(timerRef.current);
    const q = text.trim();
    const my = ++searchSeq.current;
    if (q.length < 2 || q.includes('=')) {
      setSuggestions([]);
      setSearchedFor(q);
      setSearching(false);
      return;
    }
    timerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await wails.SearchLDAP(profileId, {
          baseDN,
          scope: ScopeSub,
          filter: pickerSearchFilter(q, groupsOnly),
          attributes: ['cn', 'objectClass'],
          sizeLimit: 25,
          timeLimit: 5,
        });
        if (my !== searchSeq.current) return;
        const classesOf = (e: LDAPEntry) => e.attributes?.find((a) => a.name.toLowerCase() === 'objectclass')?.values ?? [];
        // LDAP persons without a login are contacts (M-06): one batched, unlogged read of the hits.
        await ensureLoginAttributes(profileId, (res?.entries || []).map((e) => ({ dn: e.dn, objectClass: classesOf(e) }))).catch(() => {});
        if (my !== searchSeq.current) return;
        const self = dnKey(selfDN);
        setSuggestions(rankPickerHits((res?.entries || [])
          .filter((e) => dnKey(e.dn) !== self)
          .map((e) => {
            const classes = classesOf(e);
            return { dn: e.dn, name: rdnValue(e.dn), type: objectTypeFromClasses(classes, knownLoginAttributes(profileId, e.dn)), classes };
          }), q));
        setSearchedFor(q);
        setSelectedIdx(-1);
        setOpen(true);
      } catch {
        if (my === searchSeq.current) {
          setSuggestions([]);
          setSearchedFor(q);
        }
      } finally {
        if (my === searchSeq.current) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timerRef.current);
  }, [text, profileId, baseDN, groupsOnly, selfDN]);

  const visible = suggestions.filter((s) => !chipKeys.has(dnKey(s.dn)));
  const pickerState = {
    text,
    acceptsUid,
    suggestionCount: visible.length,
    pending: searchedFor !== text.trim(),
    selectedIdx,
    chipCount: chips.length,
    uidTaken: chipKeys.has(dnKey(text.trim())),
  };
  const showUidOption = uidOptionVisible(pickerState);
  const optionCount = pickerOptionCount(pickerState);

  const [selfHint, setSelfHint] = useState(false);

  function addChips(input: string[]) {
    // A group is never its own member: the entry itself is refused here already.
    const values = input.filter((v) => !isSelfReference(v, selfDN));
    setSelfHint(values.length < input.length);
    setChips((prev) => {
      const keys = new Set(prev.map(dnKey));
      const next = [...prev];
      for (const v of values) {
        const k = dnKey(v);
        if (!keys.has(k)) {
          keys.add(k);
          next.push(v);
        }
      }
      return next;
    });
  }

  function addAndClear(value: string) {
    addChips([value]);
    setText('');
    setSelectedIdx(-1);
  }

  /** Adds option index: a suggestion, or (after them) the typed uid. */
  function pickOption(index: number) {
    if (index < visible.length) addAndClear(visible[index].dn);
    else if (showUidOption) addAndClear(text.trim());
  }

  function submit() {
    if (chips.length > 0) onSubmit(chips);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setSelectedIdx((i) => Math.min(i + 1, optionCount - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        submit();
        return;
      }
      // Options of a closed dropdown are not visible, so they are not picked.
      const action = pickerEnterAction(open ? pickerState : { ...pickerState, suggestionCount: 0, selectedIdx: -1 });
      if (action.kind === 'pick') pickOption(action.index);
      else if (action.kind === 'addDN') addAndClear(text.trim());
      else if (action.kind === 'submit') submit();
      else if (optionCount > 0) setOpen(true);
    } else if (e.key === 'Backspace' && !text && chips.length > 0) {
      setChips((prev) => prev.slice(0, -1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (open && optionCount > 0) setOpen(false);
      else onCancel();
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData('text');
    if (!/[\r\n]/.test(pasted)) return;
    e.preventDefault();
    const values = parseDNList(pasted).filter((v) => v.includes('=') || acceptsUid);
    addChips(values);
  }

  const hint = showUidOption && visible.length !== 1 && selectedIdx < 0
    ? 'Choose a suggestion, or "Add memberUid" to add the text as uid (arrow keys + Enter, or click).'
    : 'Enter adds the highlighted entry or a typed DN to the list, Ctrl+Enter adds all. Paste several DNs, one per line.';

  // Options of the popup: the suggestions, then the explicit memberUid option.
  type PickerOption = { key: string; index: number; suggestion?: Suggestion };
  const options: PickerOption[] = [
    ...visible.map((sug, i) => ({ key: sug.dn, index: i, suggestion: sug })),
    ...(showUidOption ? [{ key: '\u0000uid', index: visible.length }] : []),
  ];
  const activeKey = selectedIdx >= 0 ? options[selectedIdx]?.key ?? null : null;
  const listId = `picker-${dnKey(selfDN).replace(/[^a-z0-9]/g, '').slice(0, 24)}`;

  return (
    <div ref={wrapRef} className="relative border-b border-border bg-secondary shrink-0">
      <div className="px-3 py-1.5 space-y-1">
        {chips.length > 0 && (
          <ul className="flex flex-wrap gap-1 max-h-[64px] overflow-auto" aria-label="Entries to add">
            {chips.map((c) => (
              <li key={c}>
                <Badge tone="primary" className="pr-0.5 max-w-full" title={c.includes('=') ? c : `memberUid: ${c}`}>
                  <span className="truncate">{c.includes('=') ? rdnValue(c) : `uid ${c}`}</span>
                  {exclude.has(dnKey(c)) && <span>(member)</span>}
                  <button type="button"
                    onClick={() => setChips((prev) => prev.filter((x) => x !== c))}
                    aria-label={`Remove ${c.includes('=') ? rdnValue(c) : c} from the list`}
                    className="inline-flex items-center justify-center size-3.5 rounded-xs hover:bg-background"
                  >
                    <X size={12} strokeWidth={1.75} aria-hidden />
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-1">
          <Input
            ref={setInput}
            size="sm"
            mono
            role="combobox"
            aria-label={groupsOnly ? 'Search groups or enter a DN' : 'Search entries, enter a DN or a uid'}
            aria-expanded={open && optionCount > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && activeKey ? `${listId}-o-${activeKey.replace(/[^\w-]/g, '_')}` : undefined}
            value={text}
            onChange={(e) => { setText(e.target.value); setSelectedIdx(-1); setOpen(true); }}
            onFocus={() => optionCount > 0 && setOpen(true)}
            onBlur={() => setTimeout(() => {
              if (document.activeElement !== inputRef.current) setOpen(false);
            }, 150)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={groupsOnly
              ? 'Search groups or enter a DN…'
              : acceptsUid ? 'Search, enter a DN or a uid…' : 'Search by name or enter a DN…'}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            // Always a suffix slot: toggling it would swap Input's wrapper and remount the <input>.
            suffix={<span className="inline-flex size-3 items-center justify-center">{searching && <Spinner size="sm" label="Searching" />}</span>}
            wrapperClassName="flex-1"
            className="flex-1"
          />
          <Button
            size="sm"
            variant="primary"
            leftIcon={UserPlus}
            loading={busy}
            disabled={busy || chips.length === 0}
            onClick={submit}
            kbd={chips.length > 0 ? 'Mod+Enter' : undefined}
          >
            Add{chips.length > 1 ? ` ${chips.length}` : ''}
          </Button>
          <IconButton label="Cancel" icon={X} onClick={onCancel} />
        </div>
        <div className={cn('text-xs', selfHint ? 'text-destructive' : 'text-muted-foreground')} role={selfHint ? 'alert' : undefined}>
          {selfHint ? `"${rdnValue(selfDN)}" is this entry itself: a group cannot be a member of itself.` : hint}
        </div>
      </div>

      {open && optionCount > 0 && (
        <ComboboxPopup anchor={inputEl} onClose={() => setOpen(false)} inputRef={inputRef}>
          <ListboxOptions
            id={listId}
            items={options}
            getKey={(o) => o.key}
            getLabel={(o) => o.suggestion?.name ?? `memberUid ${text.trim()}`}
            activeKey={activeKey}
            onActiveChange={(k) => setSelectedIdx(options.findIndex((o) => o.key === k))}
            optionId={(k) => `${listId}-o-${k.replace(/[^\w-]/g, '_')}`}
            onChoose={(o) => pickOption(o.index)}
            aria-label={groupsOnly ? 'Groups' : 'Entries'}
            className="max-h-[240px]"
            renderItem={(o) => o.suggestion ? (
              <>
                <KindIcon classes={o.suggestion.classes} type={o.suggestion.type} />
                <span className="flex-1 min-w-0 py-0.5">
                  <span className="block truncate font-medium">
                    {o.suggestion.name}
                    {exclude.has(dnKey(o.suggestion.dn)) && <span className="ml-1 text-xs text-muted-foreground font-normal">(already {groupsOnly ? 'member of' : 'a member'})</span>}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground font-mono">{o.suggestion.dn}</span>
                </span>
              </>
            ) : (
              <>
                <UserPlus size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted-foreground" />
                <span className="truncate">Add memberUid <span className="font-mono">"{text.trim()}"</span></span>
              </>
            )}
          />
        </ComboboxPopup>
      )}
    </div>
  );
}
