import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  ArchiveRestore, ChevronDown, ChevronRight, Copy, ExternalLink, FolderInput, FolderTree, Info,
  RefreshCw, RotateCcw, Search, X,
} from 'lucide-react'
import { Dialog } from '../ui/Dialog'
import { Button, IconButton } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Input, Select } from '../ui/Input'
import { Spinner } from '../ui/Spinner'
import { cn } from '../../lib/utils'
import { getIconForObjectClass } from '../../lib/ldap-icons'
import { OBJECT_KIND_COLOR, resolveObjectKind } from '../ui/objectKind'
import * as recycle from '../../lib/wails-recycle'
import {
  DELETED_TYPE_LABELS, RESTORE_ERROR_LABELS, base64ByteLength, blockedByDeletedParent, deletedParentHint, STATE_DESCRIPTIONS, STATE_LABELS,
  describeRestoreLoss, displayDN, entryName, filterDeletedObjects, formatTimestamp, friendlyTypeName, normalizeDN, originalDNOf, parentDN,
  rangeBetween, recycleBinExplanation, suggestsRestoreTo, summarizeRestore, withDeletedChildren,
  type DeletedTypeFilter,
} from '../../lib/recycle'
import type { LDAPEntry } from '../../types/ldap'
import type {
  DeletedObject, DeletedObjectsList, DeletedObjectState, RecycleBinInfo, RestoreRequest, RestoreResult,
} from '../../types/recycle'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { useTreeStore } from '../../stores/treeStore'
import { toast } from '../ui/Toast'
import { ContextMenu, MenuItem, MenuSeparator, contextMenuPoint, isContextMenuKey } from '../ui/Menu'
import { RestoreToDialog } from './RestoreToDialog'
import { Badge, type BadgeTone } from '../ui/Badge'
import { emitEntryMoved, emitEntryRestored } from '../lifecycle/events'

interface DeletedObjectsDialogProps {
  profileId: string;
  /** Preselected naming context ('' = default). */
  namingContext?: string;
  /**
   * The object to find, by its DN before the delete (Restore… of a Deleted
   * tab, RW2-E-07 / M-38): the filter starts with its name and it is
   * selected once the list is read.
   */
  focusDN?: string;
  onClose: () => void;
}

const STATE_BADGE: Record<DeletedObjectState, BadgeTone> = {
  deleted: 'primary',
  tombstone: 'neutral',
  recycled: 'danger',
};

/**
 * Deleted Objects view (AD): lists the Deleted Objects container of a naming
 * context with filter and details, restores selected objects to their
 * original location or to a chosen container. Non-AD servers get an
 * explanation instead.
 */
export function DeletedObjectsDialog({ profileId, namingContext, focusDN, onClose }: DeletedObjectsDialogProps) {
  const profile = useConnectionStore((s) => s.profiles.find((p) => p.id === profileId));
  const readOnly = profile?.readOnly ?? false;

  const [info, setInfo] = useState<RecycleBinInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [nc, setNc] = useState('');
  const [list, setList] = useState<DeletedObjectsList | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [text, setText] = useState(() => (focusDN ? entryName(focusDN) : ''));
  const [serverFilter, setServerFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<DeletedTypeFilter>('all');
  const [hideRecycled, setHideRecycled] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RestoreResult>>({});
  const [restored, setRestored] = useState<RestoreResult[]>([]);
  const [restoring, setRestoring] = useState(false);
  const [restoreTo, setRestoreTo] = useState<{ objects: DeletedObject[]; container?: string } | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [menu, setMenu] = useState<{ clientX: number; clientY: number } | null>(null);
  // Range selection anchor (Shift+click / Shift+arrows).
  const anchor = useRef<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLTableSectionElement>(null);

  // Server capabilities + containers
  useEffect(() => {
    let cancelled = false;
    recycle.GetRecycleBinInfo(profileId).then((i) => {
      if (cancelled) return;
      setInfo(i);
      const wanted = (namingContext ?? '').toLowerCase();
      const usable = i.containers.filter((c) => !c.error);
      const pick = usable.find((c) => c.namingContext.toLowerCase() === wanted)
        ?? usable.find((c) => c.namingContext.toLowerCase() === i.defaultNamingContext.toLowerCase())
        ?? usable[0];
      setNc(pick?.namingContext ?? i.defaultNamingContext);
    }).catch((err) => !cancelled && setInfoError(err?.message || String(err)));
    return () => { cancelled = true; };
  }, [profileId, namingContext]);

  const load = useCallback(async () => {
    if (!info?.supported || !nc) return;
    setLoading(true);
    setListError(null);
    try {
      const l = await recycle.ListDeletedObjects(profileId, nc, serverFilter);
      setList(l);
      // keep the selection/focus only for objects that are still there
      const present = new Set(l.objects.map((o) => o.dn));
      setSelected((prev) => new Set([...prev].filter((dn) => present.has(dn))));
      setFocused((f) => (f && present.has(f) ? f : null));
    } catch (err: any) {
      setListError(err?.message || String(err));
      setList(null);
    } finally {
      setLoading(false);
    }
  }, [profileId, nc, serverFilter, info?.supported]);

  useEffect(() => { load(); }, [load]);

  // The filter mounts once the capabilities are read: the dialog's initialFocus found no
  // field then, so focus it now unless the user already moved on (M-26).
  useEffect(() => {
    if (!info?.supported) return;
    const id = requestAnimationFrame(() => {
      const el = filterRef.current;
      if (!el) return;
      const a = document.activeElement;
      if (!a || a === document.body || a === el.closest('[role="dialog"]')) el.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [info?.supported]);


  const objects = list?.objects ?? [];

  // Restore… of a Deleted tab: select its object (matched by its DN before the delete).
  const focusDone = useRef(false);
  useEffect(() => {
    if (!focusDN || focusDone.current || !list) return;
    focusDone.current = true;
    const key = normalizeDN(focusDN);
    const hit = list.objects.find((o) => normalizeDN(originalDNOf(o, list.objects) || o.originalDN) === key);
    if (!hit) return;
    setSelected(new Set([hit.dn]));
    setFocused(hit.dn);
    anchor.current = hit.dn;
  }, [focusDN, list]);
  const visible = useMemo(
    () => filterDeletedObjects(objects, { text, type: typeFilter, hideRecycled }),
    [objects, text, typeFilter, hideRecycled],
  );
  const byDN = useMemo(() => new Map(objects.map((o) => [o.dn, o])), [objects]);
  const selectedObjects = useMemo(() => [...selected].map((dn) => byDN.get(dn)).filter((o): o is DeletedObject => !!o), [selected, byDN]);
  const restorableSelected = selectedObjects.filter((o) => o.restorable);
  // A child whose container is deleted too goes back only with it (M-32).
  const blockedSelected = blockedByDeletedParent(restorableSelected);
  const focusedObj = focused ? byDN.get(focused) ?? null : null;
  const visibleRestorable = visible.filter((o) => o.restorable);
  const allVisibleSelected = visibleRestorable.length > 0 && visibleRestorable.every((o) => selected.has(o.dn));
  const order = useMemo(() => visible.map((o) => o.dn), [visible]);

  function toggle(dn: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(dn)) next.delete(dn); else next.add(dn);
      return next;
    });
    anchor.current = dn;
  }

  /**
   * One selection model: a click (or arrow key) selects the row and shows
   * its details; Ctrl toggles, Shift selects the range from the anchor,
   * Ctrl+Shift adds the range. The footer acts on the selection.
   */
  function selectRow(dn: string, mods: { ctrl?: boolean; shift?: boolean }) {
    setFocused(dn);
    if (mods.shift) {
      const range = rangeBetween(order, anchor.current, dn);
      setSelected((prev) => new Set(mods.ctrl ? [...prev, ...range] : range));
      return;
    }
    if (mods.ctrl) {
      toggle(dn);
      return;
    }
    anchor.current = dn;
    setSelected(new Set([dn]));
  }

  function focusRow(dn: string) {
    requestAnimationFrame(() => {
      tableRef.current?.querySelector<HTMLElement>(`tr[data-dn="${CSS.escape(dn)}"]`)?.focus();
    });
  }

  function onRowsKeyDown(e: KeyboardEvent<HTMLTableSectionElement>) {
    // Keys on a row checkbox belong to the checkbox (Space would toggle twice).
    if (order.length === 0 || (e.target as HTMLElement).tagName === 'INPUT') return;
    const ctrl = e.ctrlKey || e.metaKey;
    const i = focused ? order.indexOf(focused) : -1;
    const go = (to: number) => {
      e.preventDefault();
      const dn = order[Math.max(0, Math.min(order.length - 1, to))];
      if (ctrl && !e.shiftKey) setFocused(dn);
      else selectRow(dn, { shift: e.shiftKey, ctrl: ctrl && e.shiftKey });
      focusRow(dn);
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(order.length - 1);
    else if (e.key === ' ' && focused) {
      e.preventDefault();
      toggle(focused);
    } else if (ctrl && e.key.toLowerCase() === 'a' && !e.shiftKey) {
      e.preventDefault();
      setSelected(new Set(order));
    } else if (isContextMenuKey(e) && focused) {
      e.preventDefault();
      if (!selected.has(focused)) selectRow(focused, {});
      setMenu(contextMenuPoint(e));
    }
  }

  function onRowContextMenu(e: MouseEvent, dn: string) {
    e.preventDefault();
    if (!selected.has(dn)) selectRow(dn, {});
    else setFocused(dn);
    setMenu({ clientX: e.clientX, clientY: e.clientY });
  }

  function selectWithChildren(dn: string) {
    const dns = withDeletedChildren(objects, dn);
    setSelected((prev) => new Set([...prev, ...dns]));
    setFocused(dn);
    anchor.current = dn;
  }

  function copyDNs(dns: string[]) {
    navigator.clipboard.writeText(dns.join('\n')).then(
      () => toast.info(dns.length === 1 ? 'DN copied' : `${dns.length} DNs copied`),
      () => toast.error('Could not copy to the clipboard'),
    );
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleRestorable.forEach((o) => next.delete(o.dn));
      else visibleRestorable.forEach((o) => next.add(o.dn));
      return next;
    });
  }

  async function runRestore(requests: RestoreRequest[]) {
    if (requests.length === 0) return;
    setRestoring(true);
    try {
      const res = await recycle.RestoreDeletedObjects(profileId, requests);
      const summary = summarizeRestore(res);
      setResults((prev) => {
        const next = { ...prev };
        res.forEach((r) => { next[r.dn] = r; });
        return next;
      });
      const ok = res.filter((r) => r.success);
      setRestored((prev) => [...ok, ...prev].slice(0, 20));
      // Open tabs, bookmarks and lists of these DNs reload (they may show pre-delete data).
      // Restored somewhere else ("Restore to…"): tabs, bookmarks and recents of the old DN
      // follow like after a move (M-31), and the tree reloads both containers.
      for (const r of ok) {
        // A child of a deleted container: its DN before the delete runs through the container's (M-31).
        const obj = byDN.get(r.dn);
        const before = obj ? originalDNOf(obj, objects) : '';
        if (before && r.targetDN && normalizeDN(before) !== normalizeDN(r.targetDN)) emitEntryMoved(profileId, before, r.targetDN);
        emitEntryRestored(profileId, r.targetDN);
      }
      const losses = ok.map((r) => ({ r, loss: describeRestoreLoss(r) })).filter((x) => x.loss);
      const lossDetail = losses.length
        ? losses.map(({ r, loss }) => `${r.name} restored without: ${loss}`).join('\n') + '\nRe-add memberships, reset the password and enable the account where needed.'
        : undefined;
      if (summary.failed === 0) {
        const msg = summary.ok === 1 ? `${ok[0].name} restored` : `${summary.ok} objects restored`;
        if (lossDetail) toast.warning(msg + (losses.length === 1 && summary.ok === 1 ? ' without some attributes' : ' — some without attributes'), lossDetail);
        else toast.success(msg);
      } else {
        const detail = res.filter((r) => !r.success).map((r) => `${r.name || r.dn}: ${r.error}`).join('\n');
        toast.error(summary.ok > 0 ? `${summary.ok} restored, ${summary.failed} failed` : `Restore failed`, detail);
      }
      // refresh loaded tree containers that got objects back
      const tree = useTreeStore.getState();
      const parents = new Set(ok.map((r) => parentDN(r.targetDN)));
      for (const p of parents) {
        const key = Object.keys(tree.childNodes).find((k) => normalizeDN(k) === normalizeDN(p));
        if (key) tree.refreshNode(profileId, key);
      }
      if (ok.length > 0) await load();
    } catch (err: any) {
      toast.error('Restore failed', err?.message || String(err));
    } finally {
      setRestoring(false);
    }
  }

  function restoreOriginal(objs: DeletedObject[]) {
    runRestore(objs.filter((o) => o.restorable).map((o) => ({ dn: o.dn })));
  }

  // Opens a restored entry in the editor: the view closes so the editor tab
  // is visible, and the entry is selected in the tree.
  function openEntry(dn: string) {
    onClose();
    useEditorStore.getState().openEntry(profileId, dn);
    if (useConnectionStore.getState().activeProfileId === profileId) {
      // Reveal only: focus stays with the opened tab (TREE-07).
      useTreeStore.getState().locateInTree(profileId, dn, { focus: false }).catch(() => { /* the editor tab is open anyway */ });
    }
  }

  const containers = info?.containers ?? [];
  const explanation = info ? recycleBinExplanation(info) : [];

  const menuTargets = selectedObjects.length ? selectedObjects : focusedObj ? [focusedObj] : [];
  const menuRestorable = menuTargets.filter((o) => o.restorable);
  const menuBlocked = blockedByDeletedParent(menuRestorable);
  const focusedChildren = focusedObj ? withDeletedChildren(objects, focusedObj.dn).length - 1 : 0;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !restoring && onClose()}
      size="xl"
      icon={<ArchiveRestore size={16} strokeWidth={1.75} aria-hidden className="text-primary" />}
      title="Deleted Objects"
      description={profile?.name}
      initialFocus={filterRef}
      dismissible={restoring ? 'never' : 'always'}
      className="w-[94%]! h-[88%]"
      bodyClassName="p-0 flex flex-col overflow-hidden border-t border-border"
    >
        {info?.supported && (
          <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border shrink-0">
            {containers.length > 0 && (
              <Select
                size="sm"
                aria-label="Naming context"
                value={nc}
                onChange={(e) => { setNc(e.target.value); setSelected(new Set()); setFocused(null); setResults({}); }}
                className="max-w-[60%] w-auto"
                title="Naming context"
              >
                {containers.map((c) => (
                  <option key={c.namingContext} value={c.namingContext} disabled={!!c.error}>
                    {c.namingContext} {c.kind !== 'domain' ? `(${c.kind})` : ''}{c.error ? ' — unavailable' : ''}
                  </option>
                ))}
              </Select>
            )}
            <IconButton label="Reload" icon={loading ? <Spinner size="sm" decorative /> : RefreshCw} disabled={loading} onClick={load} />
          </div>
        )}

        {/* Not loaded / not supported */}
        {!info && !infoError && (
          <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground gap-2">
            <Spinner size="sm" decorative /> Reading server capabilities…
          </div>
        )}
        {infoError && <div className="flex-1 flex items-center justify-center text-xs text-destructive p-6 text-center">{infoError}</div>}
        {info && !info.supported && (
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="max-w-[560px] text-xs leading-relaxed space-y-2 text-center">
              <Info size={24} className="mx-auto text-muted-foreground" />
              <p className="font-medium">Deleted objects are not available on this server ({info.serverType}).</p>
              {explanation.map((l, i) => <p key={i} className="text-muted-foreground">{l}</p>)}
            </div>
          </div>
        )}

        {info?.supported && (
          <>
            {/* Recycle bin state */}
            <div className="px-4 py-1.5 border-b border-border text-xs shrink-0">
              <button type="button" aria-expanded={showAbout} onClick={() => setShowAbout((v) => !v)} className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground rounded-xs">
                {showAbout ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <Badge appearance="outline" tone={info.recycleBinEnabled ? 'primary' : 'neutral'}>
                  Recycle Bin: {!info.recycleBinKnown ? 'unknown' : info.recycleBinEnabled ? 'enabled' : 'not enabled'}
                </Badge>
                <span>
                  {info.recycleBinEnabled ? 'deleted objects keep attributes and memberships' : 'deleted objects are tombstones (attributes and memberships stripped)'}
                </span>
              </button>
              {showAbout && (
                <div className="mt-1.5 pl-4 space-y-1 text-muted-foreground leading-relaxed">
                  {explanation.map((l, i) => <p key={i}>{l}</p>)}
                  <p>Restoring reanimates the object with its original SID and GUID (one modify request with the Show Deleted control). Restore containers before their children — selecting both does that automatically.</p>
                </div>
              )}
            </div>

            {/* Toolbar */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0 flex-wrap">
              <Input
                ref={filterRef}
                size="sm"
                aria-label="Filter deleted objects"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setServerFilter(text.trim()); } }}
                placeholder="Filter (Enter = search server)"
                prefix={<Search size={12} strokeWidth={1.75} aria-hidden />}
                wrapperClassName="w-[240px]"
              />
              {serverFilter && (
                <Button size="sm" variant="secondary" rightIcon={X} onClick={() => { setServerFilter(''); }} title="Clear server filter">
                  server: "{serverFilter}"
                </Button>
              )}
              <Select
                size="sm"
                aria-label="Object type"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as DeletedTypeFilter)}
                options={(Object.keys(DELETED_TYPE_LABELS) as DeletedTypeFilter[]).map((k) => ({ value: k, label: DELETED_TYPE_LABELS[k] }))}
                className="w-auto"
              />
              <Checkbox checked={hideRecycled} onCheckedChange={setHideRecycled} label="Only restorable" />
              <div className="flex-1" />
              <span className="text-xs text-muted-foreground">
                {list ? `${visible.length.toLocaleString()} of ${objects.length.toLocaleString()} objects` : ''}
                {list?.truncated && (
                  <span className="text-destructive" title="The server returned more deleted objects than the limit. Where the server can sort, the most recently deleted objects are shown.">
                    {' '}· only the {list.limit.toLocaleString()} most recently deleted — search the server (Enter) to find older ones
                  </span>
                )}
              </span>
            </div>

            {/* Restored banner */}
            {restored.length > 0 && (
              <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border bg-primary-subtle text-xs shrink-0 overflow-x-auto">
                <RotateCcw size={12} className="text-primary shrink-0" />
                <span className="shrink-0">Restored:</span>
                {restored.slice(0, 6).map((r) => {
                  const loss = describeRestoreLoss(r);
                  return (
                    <Button key={r.targetDN} size="sm" variant="secondary" rightIcon={ExternalLink} onClick={() => openEntry(r.targetDN)} className="shrink-0" title={`Close this view and open ${r.targetDN}${loss ? `\nRestored without: ${loss}` : ''}`}>
                      {r.name}{loss ? ' *' : ''}
                    </Button>
                  );
                })}
                {restored.some((r) => describeRestoreLoss(r)) && <span className="text-muted-foreground shrink-0">* restored without some attributes (details in the notification)</span>}
                {restored.length > 6 && <span className="text-muted-foreground shrink-0">+{restored.length - 6}</span>}
                <div className="flex-1" />
                <IconButton size="sm" label="Dismiss" icon={X} onClick={() => setRestored([])} />
              </div>
            )}

            {/* Body */}
            <div className="flex flex-1 min-h-0">
              <div className="flex-1 min-w-0 overflow-auto">
                {loading && !list && (
                  <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground py-10">
                    <Spinner size="sm" decorative /> Loading deleted objects…
                  </div>
                )}
                {listError && <div className="text-xs text-destructive p-4">{listError}</div>}
                {list && (
                  <table className="w-full text-xs border-collapse" role="grid" aria-multiselectable="true" aria-label="Deleted objects">
                    <thead className="sticky top-0 bg-card z-(--z-sticky)">
                      <tr className="text-left text-muted-foreground border-b border-border">
                        <th className="w-7 px-2 py-1.5"><Checkbox aria-label="Select all restorable" checked={allVisibleSelected} onChange={toggleAllVisible} /></th>
                        <th className="px-2 py-1.5 font-medium">Name</th>
                        <th className="px-2 py-1.5 font-medium">Type</th>
                        <th className="px-2 py-1.5 font-medium">Last known location</th>
                        <th className="px-2 py-1.5 font-medium whitespace-nowrap">Deleted</th>
                        <th className="px-2 py-1.5 font-medium">State</th>
                      </tr>
                    </thead>
                    <tbody ref={tableRef} onKeyDown={onRowsKeyDown}>
                      {visible.map((o, idx) => {
                        const Icon = getIconForObjectClass(o.objectClass);
                        const r = results[o.dn];
                        const isSel = selected.has(o.dn);
                        const tabStop = focused ? focused === o.dn : idx === 0;
                        return (
                          <tr
                            key={o.dn}
                            data-dn={o.dn}
                            tabIndex={tabStop ? 0 : -1}
                            aria-selected={isSel}
                            onClick={(e) => selectRow(o.dn, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
                            onContextMenu={(e) => onRowContextMenu(e, o.dn)}
                            onFocus={() => { if (!focused) setFocused(o.dn); }}
                            className={cn(
                              'border-b border-border cursor-default outline-hidden focus-ring-inset',
                              isSel ? 'row-selected' : focused === o.dn ? 'bg-accent' : 'hover:bg-accent',
                              !o.restorable && 'text-muted-foreground',
                            )}
                          >
                            <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                              <Checkbox aria-label={`Select ${o.name}`} checked={selected.has(o.dn)} disabled={!o.restorable} onChange={() => toggle(o.dn)} />
                            </td>
                            <td className="px-2 py-1">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <Icon size={12} className={cn('shrink-0', OBJECT_KIND_COLOR[resolveObjectKind(o.objectClass)])} />
                                <span className="whitespace-nowrap" title={o.name}>{o.name}</span>
                                {r && !r.success && (
                                  <Badge appearance="outline" tone="danger" className="shrink-0" title={r.error}>
                                    {RESTORE_ERROR_LABELS[r.errorKind ?? 'other']}
                                  </Badge>
                                )}
                              </div>
                            </td>
                            <td className="px-2 py-1 text-muted-foreground whitespace-nowrap" title={o.structuralClass}>{friendlyTypeName(o)}</td>
                            <td className="px-2 py-1 text-muted-foreground max-w-[320px] truncate" title={o.lastKnownParent}>
                              {o.lastKnownParent ? displayDN(o.lastKnownParent) : '—'}
                            </td>
                            <td className="px-2 py-1 text-muted-foreground whitespace-nowrap">{formatTimestamp(o.deletedAt)}</td>
                            <td className="px-2 py-1">
                              <Badge appearance="outline" tone={STATE_BADGE[o.state]} title={STATE_DESCRIPTIONS[o.state]}>
                                {STATE_LABELS[o.state]}
                              </Badge>
                            </td>
                          </tr>
                        );
                      })}
                      {visible.length === 0 && (
                        <tr><td colSpan={6} className="text-center text-muted-foreground py-8">
                          {objects.length === 0
                            ? (serverFilter
                              ? `No deleted objects match "${serverFilter}".`
                              : 'No deleted objects in this naming context. (Accounts without the right to list CN=Deleted Objects — by default everyone except administrators — always see an empty list.)')
                            : 'No objects match the filter.'}
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Details */}
              <div className="w-[36%] max-w-[460px] border-l border-border overflow-y-auto shrink-0">
                {focusedObj ? (
                  <DeletedObjectDetails
                    key={focusedObj.dn}
                    profileId={profileId}
                    obj={focusedObj}
                    result={results[focusedObj.dn]}
                    childCount={focusedChildren}
                    onSelectWithChildren={() => selectWithChildren(focusedObj.dn)}
                    onCopyDN={() => copyDNs([focusedObj.dn])}
                    onOpen={openEntry}
                  />
                ) : (
                  <div className="p-4 text-xs text-muted-foreground">Click an object to select it and see its details. Ctrl+Click, Shift+Click, the arrow keys with Shift or the checkboxes select several; right-click for Restore, Restore to… and Copy DN.</div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border shrink-0">
              <span className="text-xs text-muted-foreground">
                {selected.size > 0 ? `${selected.size} selected` : 'Nothing selected'}
                {readOnly && <span className="text-destructive"> · connection is read-only</span>}
              </span>
              {selected.size > 0 && (
                <Button size="sm" variant="link" onClick={() => setSelected(new Set())}>clear</Button>
              )}
              <div className="flex-1" />
              <Button
                variant="secondary"
                leftIcon={FolderInput}
                onClick={() => setRestoreTo({ objects: restorableSelected })}
                disabled={readOnly || restoring || restorableSelected.length === 0}
              >
                Restore to…
              </Button>
              <Button
                variant="primary"
                leftIcon={RotateCcw}
                loading={restoring}
                onClick={() => restoreOriginal(restorableSelected)}
                disabled={readOnly || restoring || restorableSelected.length === 0 || blockedSelected.length > 0}
                title={blockedSelected.length ? deletedParentHint(blockedSelected.length) : 'Restore the selected objects to their last known location'}
              >
                Restore{restorableSelected.length > 0 ? ` ${restorableSelected.length}` : ''}
              </Button>
            </div>
          </>
        )}

      <ContextMenu point={menu} onClose={() => setMenu(null)} label="Deleted object actions">
        <MenuItem
          icon={RotateCcw}
          label={menuRestorable.length > 1 ? `Restore ${menuRestorable.length}` : 'Restore'}
          default={menuBlocked.length === 0}
          hint={menuBlocked.length ? 'container deleted' : undefined}
          disabled={readOnly || restoring || menuRestorable.length === 0 || menuBlocked.length > 0}
          onSelect={() => restoreOriginal(menuRestorable)}
        />
        <MenuItem
          icon={FolderInput}
          label="Restore to…"
          disabled={readOnly || restoring || menuRestorable.length === 0}
          onSelect={() => setRestoreTo({ objects: menuRestorable })}
        />
        <MenuSeparator />
        <MenuItem
          icon={FolderTree}
          label="Select with Children"
          disabled={!focusedObj || focusedChildren === 0}
          onSelect={() => focusedObj && selectWithChildren(focusedObj.dn)}
        />
        <MenuItem
          icon={Copy}
          label={menuTargets.length > 1 ? `Copy ${menuTargets.length} DNs` : 'Copy DN'}
          disabled={menuTargets.length === 0}
          onSelect={() => copyDNs(menuTargets.map((o) => o.dn))}
        />
      </ContextMenu>

      {restoreTo && info && (
        <RestoreToDialog
          profileId={profileId}
          objects={restoreTo.objects}
          allObjects={objects}
          defaultNamingContext={info.defaultNamingContext}
          initialContainer={restoreTo.container}
          onCancel={() => setRestoreTo(null)}
          onRestore={(target, newName) => {
            const objs = restoreTo.objects;
            setRestoreTo(null);
            runRestore(objs.map((o) => ({ dn: o.dn, targetParentDN: target, newName: objs.length === 1 ? newName : '' })));
          }}
        />
      )}
    </Dialog>
  );
}

function Field({ label, value, mono, title }: { label: string; value?: string; mono?: boolean; title?: string }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('break-all', mono && 'font-mono text-xs')} title={title}>{value}</span>
    </div>
  );
}

function DeletedObjectDetails({ profileId, obj, result, childCount, onSelectWithChildren, onCopyDN, onOpen }: {
  profileId: string;
  obj: DeletedObject;
  result?: RestoreResult;
  /** Deleted objects listed below it (Select with children). */
  childCount: number;
  onSelectWithChildren: () => void;
  onCopyDN: () => void;
  onOpen: (dn: string) => void;
}) {
  const [entry, setEntry] = useState<LDAPEntry | null>(null);
  const [loadingAttrs, setLoadingAttrs] = useState(false);
  const [attrError, setAttrError] = useState<string | null>(null);

  async function loadAttributes() {
    setLoadingAttrs(true);
    setAttrError(null);
    try {
      setEntry(await recycle.GetDeletedObjectEntry(profileId, obj.dn));
    } catch (err: any) {
      setAttrError(err?.message || String(err));
    } finally {
      setLoadingAttrs(false);
    }
  }

  const loss = result?.success ? describeRestoreLoss(result) : '';

  return (
    <div className="p-3 text-xs space-y-3">
      <div>
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm break-all">{obj.name}</span>
          <Badge appearance="outline" tone={STATE_BADGE[obj.state]} className="shrink-0">{STATE_LABELS[obj.state]}</Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{STATE_DESCRIPTIONS[obj.state]}</p>
      </div>

      {result && !result.success && (
        <div className="rounded border border-destructive bg-destructive-subtle p-2 space-y-1.5">
          <div className="font-medium text-destructive">{RESTORE_ERROR_LABELS[result.errorKind ?? 'other']}</div>
          <div className="text-xs leading-relaxed break-words">{result.error}</div>
          {suggestsRestoreTo(result.errorKind) && (
            <div className="text-xs text-muted-foreground">Use "Restore to…" below to choose another container or name.</div>
          )}
        </div>
      )}
      {result?.success && (
        <div className="rounded border border-border bg-primary-subtle p-2 space-y-1">
          <div className="font-medium">Restored as <span className="font-mono break-all">{result.targetDN}</span></div>
          {loss && <div className="leading-relaxed">Restored without: {loss}. Re-add memberships, reset the password and enable the account where needed.</div>}
        </div>
      )}

      <div>
        <Field label="Type" value={`${friendlyTypeName(obj)} (${obj.structuralClass})`} />
        <Field label="objectClass" value={obj.objectClass.join(', ')} />
        <Field label="sAMAccountName" value={obj.sAMAccountName} />
        <Field label="Deleted" value={formatTimestamp(obj.deletedAt)} title="whenChanged" />
        <Field label="Created" value={formatTimestamp(obj.whenCreated)} />
        <Field label="Last known parent" value={obj.lastKnownParent ? displayDN(obj.lastKnownParent) : '(unknown)'} mono title={obj.lastKnownParent} />
        {obj.parentDeleted && (
          <div className="text-xs text-destructive pl-[118px]">The parent container is deleted too — restore it first (select it too, or "Select with children" on it) or use "Restore to…".</div>
        )}
        <Field label="Restores to" value={obj.parentDeleted ? '' : obj.originalDN} mono />
        <Field label="objectSid" value={obj.objectSid} mono />
        <Field label="objectGUID" value={obj.objectGuid} mono />
        <Field label="Current DN" value={obj.dn} mono />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {childCount > 0 && (
          <Button size="sm" variant="secondary" leftIcon={FolderTree} onClick={onSelectWithChildren}>
            Select with Children ({childCount})
          </Button>
        )}
        <Button size="sm" variant="secondary" leftIcon={Copy} onClick={onCopyDN}>
          Copy DN
        </Button>
        {result?.success && (
          <Button size="sm" variant="secondary" leftIcon={ExternalLink} onClick={() => onOpen(result.targetDN)}>
            Open restored
          </Button>
        )}
      </div>

      <div className="border-t border-border pt-2">
        {!entry ? (
          <Button size="sm" variant="ghost" leftIcon={ChevronRight} loading={loadingAttrs} onClick={loadAttributes}>
            Show all remaining attributes
          </Button>
        ) : (
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground mb-1">{entry.attributes.length} attributes kept on the deleted object</div>
            {entry.attributes.map((a) => (
              <div key={a.name} className="grid grid-cols-[130px_1fr] gap-2 text-xs">
                <span className="text-muted-foreground truncate" title={a.name}>{a.name}</span>
                <span className="font-mono break-all">
                  {a.binary ? a.values.map((v) => `<binary ${base64ByteLength(v)} bytes>`).join(', ') : a.values.join(' | ').replace(/\n/g, '\\n')}
                </span>
              </div>
            ))}
          </div>
        )}
        {attrError && <div className="text-xs text-destructive mt-1">{attrError}</div>}
      </div>
    </div>
  );
}
