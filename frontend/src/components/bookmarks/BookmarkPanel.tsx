/**
 * Bookmarks (SPEC 10.2): PanelHeader with filter and "Clear all" (asks
 * first), EmptyState, ObjectIcon rows (objectClass saved with the bookmark
 * and refreshed whenever the entry loads, else the open tab's entry, else
 * the RDN type), row ContextMenu.
 * A click opens the entry in the preview tab, a double-click keeps it open.
 * Removing a bookmark offers Undo; focus stays in the list (next row, or the
 * restored one after Undo). Bookmarks live in localStorage.
 *
 * Lifecycle (TREE-12, bookmarkStore): renamed / moved entries keep their
 * bookmark; deleted or missing ones are marked stale (warning icon) and offer
 * Remove and Search by Name. The context menu appends the registry's entry
 * verbs (CommandMenuItems), like the tree's menu.
 *
 * Stable ids (RW3-R-01, bookmarkSync): an entry renamed or moved outside the
 * app is found again by its objectGUID / nsUniqueId / entryUUID — on
 * connect, when opening it fails, and first thing for a stale bookmark.
 *
 * Own names and order (DEF-24): Rename Bookmark… / F2 edits the shown name in place
 * (blank = the RDN value again); Move Up / Move Down (Alt+↑ / Alt+↓) or
 * dragging a row reorders the connection's bookmarks; "Sort by Name" goes
 * back to the alphabetical order.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import { ArrowDown, ArrowDownAZ, ArrowUp, Copy, Crosshair, ExternalLink, PencilLine, Pin, Search, Star, StarOff, Trash2, TriangleAlert } from 'lucide-react'
import { bookmarkName, bookmarkRdnName, compareBookmarks, hasManualOrder, useBookmarkStore, type Bookmark } from '../../stores/bookmarkStore'
import { followBookmark } from './bookmarkSync'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { useTreeStore } from '../../stores/treeStore'
import { useSearchStore } from '../../stores/searchStore'
import { useUIStore } from '../../stores/uiStore'
import { firstRDN, getParentDN, parseRDN } from '../../lib/dn'
import { isValidAttributeDescription } from '../../lib/searchFilter'
import { staleBookmarkFilter, unescapedDN } from '../../lib/treesearch'
import { ScopeSub } from '../../types/ldap'
import { setNextSearchSource, showSearchResults } from '../layout/shellState'
import { PanelHeader } from '../ui/PanelHeader'
import { EmptyState } from '../ui/EmptyState'
import { Input, SearchInput } from '../ui/Input'
import { IconButton } from '../ui/Button'
import { ObjectIcon } from '../ui/ObjectIcon'
import { resolveObjectKind, type ObjectKind } from '../ui/objectKind'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { CommandMenuItems, ContextMenu, ENTRY_COMMAND_GROUPS, MenuHeader, MenuItem, MenuSeparator, useContextMenu } from '../ui/Menu'
import { ensureServerType, getCommandContext, resolveCommands, type CommandContext } from '../ui/commands'
import { toast } from '../ui/Toast'
import { registerUndo, undoButton } from '../ui/undo'
import { cn } from '../../lib/utils'

/** Drag type of a bookmark row (reorder only; never a DN the tree would take). */
const BOOKMARK_DRAG_TYPE = 'application/x-ldapilot-bookmark'

function kindOf(b: Bookmark, entryOC: string[] | undefined): ObjectKind {
  if (b.objectClass?.length) return resolveObjectKind(b.objectClass)
  if (entryOC?.length) return resolveObjectKind(entryOC)
  const type = parseRDN(firstRDN(b.dn)).attr.toLowerCase()
  return type === 'ou' ? 'ou' : type === 'dc' ? 'domain' : type === 'uid' ? 'user' : 'other'
}

const bookmarkKey = (b: Pick<Bookmark, 'profileId' | 'dn'>) => `${b.profileId}\n${b.dn}`

/** Registry entry verbs the bookmark menu already lists itself. */
const OWN_VERBS = new Set(['entry.open', 'entry.openNewTab', 'entry.showInTree', 'entry.copyDn', 'entry.bookmark'])

/** Ids of the registry's entry verbs for ctx, in menu order, without OWN_VERBS (write verbs included: the menu hides them on read-only connections with a header). */
function registryVerbIds(ctx: CommandContext): string[] {
  return resolveCommands({ ...ctx, readOnly: false }, { group: ENTRY_COMMAND_GROUPS, surface: 'menu' })
    .items.map((i) => i.id)
    .filter((id) => !OWN_VERBS.has(id))
}

export function BookmarkPanel() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const isConnected = useConnectionStore((s) => (s.activeProfileId ? s.connectionStatuses[s.activeProfileId] === true : false));
  const allBookmarks = useBookmarkStore((s) => s.bookmarks);
  const entries = useEditorStore((s) => s.entries);
  const [filter, setFilter] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const menu = useContextMenu<Bookmark>();
  const itemEls = useRef(new Map<string, HTMLButtonElement>());
  const listRef = useRef<HTMLDivElement>(null);
  /** Row to focus after the next render (after Delete / Undo); '' = the list. */
  const pendingFocus = useRef<string | null>(null);
  /** Row whose name is being edited (Rename… / F2). */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  // The edit ends once (Enter / Escape / blur): a blur after Escape must not save.
  const renamingRef = useRef<string | null>(null);
  /** Drag reorder: the row being dragged and where it would land. */
  const dragKey = useRef<string | null>(null);
  const [dropHint, setDropHint] = useState<{ key: string; after: boolean } | null>(null);

  const bookmarks = useMemo(() => {
    if (!activeProfileId) return [];
    const q = filter.trim().toLowerCase();
    return allBookmarks
      .filter((b) => b.profileId === activeProfileId && (!q || b.dn.toLowerCase().includes(q) || unescapedDN(b.dn).toLowerCase().includes(q)))
      // By the shown name, stale ones last (as the welcome screen, RW3-R-02).
      .sort(compareBookmarks);
  }, [allBookmarks, activeProfileId, filter]);
  const total = useMemo(() => (activeProfileId ? allBookmarks.filter((b) => b.profileId === activeProfileId).length : 0), [allBookmarks, activeProfileId]);
  const manual = useMemo(() => (activeProfileId ? hasManualOrder(allBookmarks, activeProfileId) : false), [allBookmarks, activeProfileId]);

  // Focus requests (Delete, Undo) apply once the list has re-rendered.
  useEffect(() => {
    const key = pendingFocus.current;
    if (key === null) return;
    pendingFocus.current = null;
    const el = key ? itemEls.current.get(key) : undefined;
    if (el) el.focus();
    else listRef.current?.focus();
  });

  if (!isConnected || !activeProfileId) {
    return (
      <div className="h-full flex flex-col bg-sidebar">
        <PanelHeader title="Bookmarks" />
        <EmptyState icon={Star} title="Not connected" hint="Connect to a directory to see its bookmarks." />
      </div>
    );
  }
  const profileId = activeProfileId;

  const open = (dn: string, pin: boolean) => useEditorStore.getState().openEntry(profileId, dn, { preview: !pin });

  /**
   * Opens the bookmark. A stale one with a stable id is looked up by it first
   * (renamed / moved outside the app, RW3-R-01); a live one whose load finds
   * no entry is followed by bookmarkSync (entry-missing).
   */
  const activate = async (bm: Bookmark, pin: boolean) => {
    if (bm.stale && bm.stableId) {
      const dn = await followBookmark(bm, { notify: true });
      if (dn) {
        pendingFocus.current = bookmarkKey({ profileId, dn });
        return open(dn, pin);
      }
    }
    open(bm.dn, pin);
  };

  /** Moves the bookmark by `delta` places in the shown order (switches to manual order). */
  const moveBy = (bm: Bookmark, delta: number) => {
    const i = bookmarks.findIndex((b) => bookmarkKey(b) === bookmarkKey(bm));
    const to = i + delta;
    if (i < 0 || to < 0 || to >= bookmarks.length) return;
    pendingFocus.current = bookmarkKey(bm);
    useBookmarkStore.getState().moveBookmark(profileId, bm.dn, to);
  };

  const startRename = (bm: Bookmark) => {
    setRenameText(bookmarkName(bm));
    renamingRef.current = bookmarkKey(bm);
    setRenaming(bookmarkKey(bm));
  };
  const finishRename = (bm: Bookmark, save: boolean) => {
    if (renamingRef.current !== bookmarkKey(bm)) return;
    renamingRef.current = null;
    setRenaming(null);
    pendingFocus.current = bookmarkKey(bm);
    if (save) useBookmarkStore.getState().renameBookmark(profileId, bm.dn, renameText);
  };

  // Drag reorder (DEF-24): only without a filter (the shown list is the whole order).
  const canDrag = !filter.trim() && bookmarks.length > 1 && renaming === null;
  const onDragOverRow = (e: ReactDragEvent<HTMLLIElement>, bm: Bookmark) => {
    if (!dragKey.current || !e.dataTransfer.types.includes(BOOKMARK_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    const k = bookmarkKey(bm);
    if (dropHint?.key !== k || dropHint.after !== after) setDropHint({ key: k, after });
  };
  const onDropRow = (e: ReactDragEvent<HTMLLIElement>, bm: Bookmark) => {
    const src = dragKey.current;
    dragKey.current = null;
    setDropHint(null);
    if (!src || !e.dataTransfer.types.includes(BOOKMARK_DRAG_TYPE)) return;
    e.preventDefault();
    const from = bookmarks.findIndex((b) => bookmarkKey(b) === src);
    const target = bookmarks.findIndex((b) => bookmarkKey(b) === bookmarkKey(bm));
    if (from < 0 || target < 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    // Index in the list without the dragged row.
    let to = target + (after ? 1 : 0);
    if (from < to) to -= 1;
    pendingFocus.current = src;
    if (to !== from) useBookmarkStore.getState().moveBookmark(profileId, bookmarks[from].dn, to);
  };

  const remove = (removed: Bookmark[]) => {
    if (removed.length === 0) return;
    // Focus moves to the next row (or the previous one, or the list).
    const keys = new Set(removed.map(bookmarkKey));
    const idx = bookmarks.findIndex((b) => keys.has(bookmarkKey(b)));
    const rest = bookmarks.filter((b) => !keys.has(bookmarkKey(b)));
    const neighbour = rest[Math.min(Math.max(idx, 0), rest.length - 1)];
    pendingFocus.current = neighbour ? bookmarkKey(neighbour) : '';
    const bs = useBookmarkStore.getState();
    for (const b of removed) bs.removeBookmark(b.profileId, b.dn);
    const name = bookmarkName(removed[0]);
    // The registry's wording ("Bookmark removed: X · Undo", RW1-R-06).
    // Undo also from the bell and with Ctrl+Z (ui/undo.ts, RW3-N-04).
    const undo = registerUndo({
      label: removed.length === 1 ? 'Remove Bookmark' : `Remove ${removed.length} Bookmarks`,
      profileId,
      run: () => {
        pendingFocus.current = bookmarkKey(removed[0]);
        useBookmarkStore.getState().restoreBookmarks(removed);
      },
    });
    toast.success(removed.length === 1 ? `Bookmark removed: ${name}` : `${removed.length} bookmarks removed`, { action: undoButton(undo) });
  };

  const locate = (dn: string) => {
    const ui = useUIStore.getState();
    ui.setActivity('explorer');
    if (!ui.sidebarVisible) ui.toggleSidebar();
    void useTreeStore.getState().locateInTree(profileId, dn);
  };

  /**
   * A stale bookmark: look for the entry by its old name below the tree's base
   * (Search Results). Renames are the usual reason a bookmark goes stale, so the
   * old RDN value is matched as a substring (AD also by name resolution), not
   * exactly (RW3-R-01: a renamed "…-contact2" → "…-contact2-ext" was not found).
   */
  const searchByName = async (bm: Bookmark) => {
    // The entry's stable id finds it under any name (RW3-R-01).
    if (bm.stableId) {
      const dn = await followBookmark(bm, { notify: true });
      if (dn) {
        pendingFocus.current = bookmarkKey({ profileId, dn });
        return open(dn, false);
      }
    }
    const { attr, value } = parseRDN(firstRDN(bm.dn));
    if (!value) return;
    const type = attr && isValidAttributeDescription(attr) ? attr : 'cn';
    const ad = (await ensureServerType(profileId)) === 'ad';
    const filter = staleBookmarkFilter(type, value, ad);
    const profile = useConnectionStore.getState().profiles.find((p) => p.id === profileId);
    const baseDN = profile?.baseDN?.trim() || useTreeStore.getState().rootNodes[profileId]?.[0]?.dn || '';
    const ss = useSearchStore.getState();
    ss.setParams({ baseDN, filter, scope: ScopeSub, attributes: [] });
    showSearchResults();
    setNextSearchSource(`Bookmark: ${value}`, undefined, { title: `No entry named like “${value}”`, hint: 'It may have been deleted, or renamed to another name.' });
    void ss.executeSearch(profileId, filter).finally(() => setNextSearchSource(null));
  };

  const copyDn = (dn: string) => {
    navigator.clipboard
      .writeText(dn)
      .then(() => toast.success('DN copied'))
      .catch(() => {});
  };

  /** Rename… and Move Up / Move Down of the row menu (DEF-24; moving needs the unfiltered list). */
  const orderItems = (bm: Bookmark) => {
    const i = bookmarks.findIndex((b) => bookmarkKey(b) === bookmarkKey(bm));
    const filtered = !!filter.trim();
    return (
      <>
        <MenuSeparator />
        <MenuItem icon={PencilLine} label="Rename Bookmark…" shortcut="F2" onSelect={() => startRename(bm)} />
        <MenuItem icon={ArrowUp} label="Move Up" shortcut="Alt+ArrowUp" disabled={filtered || i <= 0} hint={filtered ? 'Clear the filter first' : undefined} onSelect={() => moveBy(bm, -1)} />
        <MenuItem icon={ArrowDown} label="Move Down" shortcut="Alt+ArrowDown" disabled={filtered || i < 0 || i >= bookmarks.length - 1} onSelect={() => moveBy(bm, 1)} />
        {manual && <MenuItem icon={ArrowDownAZ} label="Sort by Name" onSelect={() => useBookmarkStore.getState().sortBookmarksByName(profileId)} />}
      </>
    );
  };

  const menuCtx = (bm: Bookmark): CommandContext => {
    const oc = bm.objectClass ?? entries[`${profileId}:${bm.dn}`]?.attributes.find((a) => a.name.toLowerCase() === 'objectclass')?.values;
    return getCommandContext('results', { selection: [{ dn: bm.dn, profileId, objectClass: oc, label: bookmarkRdnName(bm) }] });
  };

  return (
    <div className="h-full flex flex-col bg-sidebar">
      <PanelHeader
        title="Bookmarks"
        subtitle={total ? String(total) : undefined}
        actions={total ? [
          ...(manual ? [{ id: 'sortByName', label: 'Sort by Name', icon: ArrowDownAZ, onClick: () => useBookmarkStore.getState().sortBookmarksByName(profileId) }] : []),
          { id: 'clear', label: 'Remove All Bookmarks', icon: Trash2, onClick: () => setConfirmClear(true) },
        ] : []}
        filter={total > 5 ? <SearchInput size="sm" value={filter} onValueChange={setFilter} placeholder="Filter bookmarks" aria-label="Filter bookmarks" /> : undefined}
      />

      {/* Empty: the list region takes the focus, not <body> (RW1-N-07). */}
      <div ref={listRef} tabIndex={-1} className="flex-1 overflow-auto py-0.5 outline-hidden" data-panel-autofocus={total === 0 ? '' : undefined}>
        {total === 0 ? (
          <EmptyState
            icon={Star}
            title="No bookmarks for this connection"
            // Bookmarks are kept per connection: say so when others have some (RW3 cross-area note).
            hint={
              allBookmarks.length > 0
                ? `Bookmarks are kept per connection (${allBookmarks.length} on other connections). Bookmark an entry with Ctrl+D or from its context menu.`
                : 'Bookmark an entry with Ctrl+D or from its context menu.'
            }
          />
        ) : bookmarks.length === 0 ? (
          <EmptyState variant="inline" title="No bookmark matches the filter" />
        ) : (
          <ul aria-label="Bookmarks">
            {bookmarks.map((bm, index) => {
              const kind = kindOf(bm, entries[`${profileId}:${bm.dn}`]?.attributes.find((a) => a.name.toLowerCase() === 'objectclass')?.values);
              const name = bookmarkName(bm);
              const custom = !!bm.name && bm.name !== bookmarkRdnName(bm);
              const parent = getParentDN(bm.dn);
              const key = bookmarkKey(bm);
              const tooltip = [custom ? `${bookmarkRdnName(bm)} — ${unescapedDN(bm.dn)}` : unescapedDN(bm.dn), bm.stale ? 'This entry was deleted or could not be found.' : ''].filter(Boolean).join('\n');
              if (renaming === key) {
                return (
                  <li key={bm.dn} className="flex items-center gap-2 h-row px-3 bg-accent">
                    {bm.stale ? <TriangleAlert size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-warning" /> : <ObjectIcon kind={kind} />}
                    <Input
                      size="sm"
                      autoFocus
                      aria-label={`Name of the bookmark ${bookmarkRdnName(bm)}`}
                      placeholder={bookmarkRdnName(bm)}
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                      onFocus={(e) => e.currentTarget.select()}
                      onBlur={() => finishRename(bm, true)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          finishRename(bm, true);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          e.stopPropagation();
                          finishRename(bm, false);
                        }
                      }}
                      wrapperClassName="flex-1 min-w-0"
                      className="flex-1 min-w-0"
                    />
                  </li>
                );
              }
              return (
                <li
                  key={bm.dn}
                  className={cn(
                    'group relative flex items-center hover:bg-accent focus-within:bg-accent',
                    dropHint?.key === key && (dropHint.after ? 'shadow-[inset_0_-2px_0_0_var(--color-primary)]' : 'shadow-[inset_0_2px_0_0_var(--color-primary)]'),
                  )}
                  onContextMenu={(e) => menu.open(e, bm)}
                  draggable={canDrag}
                  onDragStart={(e) => {
                    if (!canDrag) return;
                    dragKey.current = key;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData(BOOKMARK_DRAG_TYPE, key);
                  }}
                  onDragOver={(e) => onDragOverRow(e, bm)}
                  onDragLeave={(e) => {
                    if (dropHint?.key === key && !e.currentTarget.contains(e.relatedTarget as Node | null)) setDropHint(null);
                  }}
                  onDrop={(e) => onDropRow(e, bm)}
                  onDragEnd={() => {
                    dragKey.current = null;
                    setDropHint(null);
                  }}
                >
                  <button type="button"
                    ref={(el) => {
                      if (el) itemEls.current.set(key, el);
                      else itemEls.current.delete(key);
                    }}
                    onClick={() => void activate(bm, false)}
                    onDoubleClick={() => void activate(bm, true)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        void activate(bm, true);
                      } else if (e.key === 'Delete') {
                        e.preventDefault();
                        remove([bm]);
                      } else if (e.key === 'F2' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                        e.preventDefault();
                        e.stopPropagation();
                        startRename(bm);
                      } else if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !filter.trim()) {
                        e.preventDefault();
                        e.stopPropagation();
                        moveBy(bm, e.key === 'ArrowUp' ? -1 : 1);
                      } else if (!e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                        // Arrows move between the rows.
                        const next = bookmarks[index + (e.key === 'ArrowUp' ? -1 : 1)];
                        const el = next ? itemEls.current.get(bookmarkKey(next)) : undefined;
                        if (el) {
                          e.preventDefault();
                          el.focus();
                        }
                      } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
                        e.preventDefault();
                        menu.open(e, bm);
                      }
                    }}
                    title={tooltip}
                    aria-label={bm.stale ? `${name}, not found` : custom ? `${name} (${bookmarkRdnName(bm)})` : undefined}
                    aria-keyshortcuts={!filter.trim() ? 'F2 Alt+ArrowUp Alt+ArrowDown' : 'F2'}
                    className="flex-1 min-w-0 flex items-center gap-2 h-row px-3 text-left text-sm focus-ring-inset"
                  >
                    {bm.stale ? (
                      <TriangleAlert size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-warning" />
                    ) : (
                      <ObjectIcon kind={kind} />
                    )}
                    <span className={bm.stale ? 'truncate text-muted-foreground line-through' : 'truncate text-foreground'}>{name}</span>
                    {parent && <span className="ml-auto pl-2 min-w-0 truncate text-xs text-muted-foreground">{parseRDN(firstRDN(parent)).value}</span>}
                  </button>
                  {bm.stale && <IconButton label={`Search for ${bookmarkRdnName(bm)}`} icon={Search} size="sm" className="shrink-0" onClick={() => searchByName(bm)} />}
                  <IconButton label={`Remove bookmark ${name}`} icon={StarOff} size="sm" revealOnRowHover={!bm.stale} className="mr-1 shrink-0" onClick={() => remove([bm])} />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ContextMenu point={menu.point} onClose={menu.close} label="Bookmark actions" minWidth={220}>
        {() => {
          const bm = menu.data;
          if (!bm) return null;
          if (bm.stale) {
            return (
              <>
                <MenuHeader mono>{bm.dn}</MenuHeader>
                <MenuHeader icon={TriangleAlert}>Deleted or not found</MenuHeader>
                <MenuSeparator />
                <MenuItem icon={Search} label="Search by Name" default onSelect={() => searchByName(bm)} />
                <MenuItem icon={ExternalLink} label="Open Anyway" onSelect={() => open(bm.dn, false)} />
                <MenuItem icon={Copy} label="Copy DN" onSelect={() => copyDn(bm.dn)} />
                {orderItems(bm)}
                <MenuSeparator />
                <MenuItem icon={StarOff} label="Remove Bookmark" shortcut="Delete" tone="danger" onSelect={() => remove([bm])} />
              </>
            );
          }
          const ctx = menuCtx(bm);
          const ids = registryVerbIds(ctx);
          return (
            <>
              <MenuHeader mono>{bm.dn}</MenuHeader>
              <MenuSeparator />
              <MenuItem icon={ExternalLink} label="Open" default onSelect={() => open(bm.dn, false)} />
              <MenuItem icon={Pin} label="Open in New Tab" shortcut="Mod+Enter" onSelect={() => open(bm.dn, true)} />
              <MenuItem icon={Crosshair} label="Show in Tree" onSelect={() => locate(bm.dn)} />
              <MenuItem icon={Copy} label="Copy DN" onSelect={() => copyDn(bm.dn)} />
              {orderItems(bm)}
              <MenuItem icon={StarOff} label="Remove Bookmark" shortcut="Delete" tone="danger" onSelect={() => remove([bm])} />
              {ids.length > 0 && (
                <>
                  <MenuSeparator />
                  <CommandMenuItems ctx={ctx} ids={ids} hideShortcuts />
                </>
              )}
            </>
          );
        }}
      </ContextMenu>

      {confirmClear && (
        <ConfirmDialog
          title="Remove all bookmarks"
          message={total === 1 ? 'Remove the bookmark of this connection?' : `Remove all ${total} bookmarks of this connection?`}
          confirmLabel="Remove All"
          tone="danger"
          onConfirm={() => {
            setConfirmClear(false);
            remove(useBookmarkStore.getState().bookmarks.filter((b) => b.profileId === profileId));
          }}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </div>
  );
}
