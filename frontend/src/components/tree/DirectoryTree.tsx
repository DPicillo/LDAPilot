/**
 * Explorer tree (SPEC 10.2 S2, 6.4, UX-3/4/16/21).
 *
 * - Mounted only while the active profile is connected (Sidebar); roots come
 *   from a stable EMPTY_NODES fallback and every effect guards its setState,
 *   so nothing re-renders in a loop (V1).
 * - No dialog state lives here: every action is a registry command whose
 *   dialog opens through useDialogStore / the feature hosts, so a global
 *   shortcut that hides or remounts the sidebar never destroys a dialog.
 * - Keyboard: useTreeKeyboard (role=tree, roving tabindex, ARIA level /
 *   setsize / posinset, focus recovery under virtualization, type-ahead).
 * - Ctrl+F (Edit ▸ Find in Tree) opens and focuses the filter (SearchInput):
 *   literal text filters the loaded rows and searches the directory, "(" starts
 *   a raw LDAP filter. Enter opens the first hit, Ctrl+Enter pins it; the hits
 *   are a listbox labelled like the editor tabs, with their location (TREE-07).
 * - Expanded containers with more than LARGE_CONTAINER children show one
 *   "n entries · Open list" row instead of the children (UX-16); selected
 *   children (Show in Tree) stay visible below it.
 * - Refresh Tree reloads every visible expanded container (TREE-01); Show in
 *   Tree requests (treeStore.revealRequest) scroll to and focus the row.
 * - Drag and drop (TREE-02): the selection (or the dragged row) onto a
 *   container, also an empty one; confirmation with "Don't ask again this
 *   session"; Undo in the toast; one `ldapilot:entry-moved` per entry.
 * - Context menu and the selection toolbar come from the command registry.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowUpDown,
  ChevronsDownUp,
  Copy,
  Crosshair,
  Download,
  FolderInput,
  FolderTree,
  ListChecks,
  Power,
  RefreshCw,
  Search,
  ServerCog,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react'
import { useTreeStore } from '../../stores/treeStore'
import { useSearchStore } from '../../stores/searchStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { useUIStore } from '../../stores/uiStore'
import { openEntryWithIntent } from '../../stores/entryIntentStore'
import { accountStatusVersion, cachedAccountStatusKinds, subscribeAccountStatus } from '../../stores/accountStatusCache'
import type { LDAPEntry, TreeNode } from '../../types/ldap'
import { ScopeSub } from '../../types/ldap'
import * as wails from '../../lib/wails'
import { buildAnyAttributeFilter, parseQuickSearchInput } from '../../lib/searchFilter'
import {
  ENTRY_MOVED,
  contextHeadLabel,
  dedupeByDN,
  emitEntryEvent,
  firstRDN,
  movedDN,
  normalizeDN,
  parentPathLabel,
  perBaseSizeLimit,
  planTreeMove,
  resolveTreeSearchBases,
  unescapedDN,
  type EntryMovedDetail,
} from '../../lib/treesearch'
import { parseRDN } from '../../lib/dn'
import { GetTreeSearchBases, checkFilter } from '../../lib/wails-treesearch'
import { cn } from '../../lib/utils'
import { rankTreeHits } from '../../lib/treeHitRank'
import { RawFilterHint, TextOverrideHint } from '../search/RawFilterHint'
import { useFilterCheck } from '../search/useFilterCheck'
import { ConnectionDialog } from '../connection/ConnectionDialog'
import { PanelHeader, type PanelAction } from '../ui/PanelHeader'
import { SearchInput } from '../ui/Input'
import { Toolbar, type ToolbarItem } from '../ui/Toolbar'
import { Spinner, Skeleton, useDelayedFlag } from '../ui/Spinner'
import { EmptyState } from '../ui/EmptyState'
import { InlineAlert } from '../ui/InlineAlert'
import { Button, IconButton, type IconType } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Dialog, useDialogStore } from '../ui/Dialog'
import { Dn } from '../ui/Dn'
import { DropdownMenu, MenuRadioGroup, MenuRadioItem, contextMenuPoint } from '../ui/Menu'
import { ObjectIcon } from '../ui/ObjectIcon'
import { TruncatedText } from '../ui/TruncatedText'
import { isContainerKind, nodeKind } from '../ui/objectKind'
import { entryHitLabel } from '../ui/hitLabel'
import { useTreeKeyboard, type TreeKeyboardItem } from '../ui/useTreeKeyboard'
import { primaryStatus, type AccountStatusKind } from '../ui/accountStatus'
import { getCommandContext, resolveCommands, runCommand, useCommandRegistryVersion, type CommandSource, type SelectionItem } from '../ui/commands'
import { toast } from '../ui/Toast'
import { LargeContainerRow, TreeNodeRow } from './TreeNodeItem'
import { TreeContextMenu, type EntryMenuState } from './TreeContextMenu'
import { DEFAULT_SORT_MODE, SORT_MODE_LABELS, isContextHead, nodeLabel, sortTreeNodes, useTreePrefs, type TreeSortMode } from './treePrefs'
import { showInTree } from './treeCommands'
import { moveErrorText, moveUndoButton, movedOf } from './moveUndo'
import { showSearchResults } from '../layout/shellState'

/** Stable fallback: a new [] per render made every effect depending on the roots re-run (V1). */
const EMPTY_NODES: TreeNode[] = []

/** Expanded containers with more children are shown as one "open in list" row (UX-16). */
export const LARGE_CONTAINER = 500

/** Attributes the tree search matches the typed text against (literally, "contains"). */
const TREE_SEARCH_ATTRS = ['cn', 'displayName', 'sAMAccountName', 'uid', 'description']
const TREE_NAME_ATTRS = ['cn', 'displayName', 'sAMAccountName', 'uid']

const ROW_H = 22

type FlatRow =
  | { kind: 'node'; id: string; node: TreeNode; depth: number; parentId: string | null }
  | { kind: 'large'; id: string; containerDn: string; depth: number; parentId: string; count: number }

const largeRowId = (dn: string) => `${dn}\u0000large`

/** Selection toolbar (n ≥ 2): registry commands, shown when the registry offers them for the selection (TREE-09). */
const TOOLBAR_COMMANDS: { id: string; label: (n: number) => string; icon: IconType; danger?: boolean; separator?: boolean }[] = [
  { id: 'entry.copyDns', label: () => 'Copy DNs', icon: Copy },
  { id: 'entry.exportSelection', label: (n) => `Export ${n} Entries…`, icon: Download },
  { id: 'entry.move', label: (n) => `Move ${n} Entries…`, icon: FolderInput },
  { id: 'membership.addToGroup', label: (n) => `Add ${n} Entries to Group…`, icon: UserPlus },
  { id: 'account.toggleEnabled', label: () => 'Enable/Disable…', icon: Power },
  { id: 'bulk.modifySelected', label: (n) => `Modify ${n} Entries…`, icon: ListChecks },
  { id: 'entry.delete', label: (n) => `Delete ${n} Entries…`, icon: Trash2, danger: true, separator: true },
]

/** Opens a container's entry on its Contents sub-tab (the list view of its children). */
export function openContainerContents(profileId: string, dn: string) {
  // 'contents' is the container list sub-tab of the entry editor (SPEC 10.2 EntryEditor).
  openEntryWithIntent(profileId, dn, { subTab: 'contents' })
}

/** Display name of a DN in toasts and dialogs: the root label or the RDN value. */
function entryName(dn: string, roots: TreeNode[] = []): string {
  if (roots.some((r) => normalizeDN(r.dn) === normalizeDN(dn))) return contextHeadLabel(dn)
  return parseRDN(firstRDN(dn)).value || dn
}

// --- Drag and drop moves (TREE-02) ------------------------------------------------------------

/** "Don't ask again this session" of the move confirmation (this app run). */
let skipMoveConfirm = false

function emitMoved(profileId: string, oldDN: string, newDN: string) {
  emitEntryEvent<EntryMovedDetail>(ENTRY_MOVED, { profileId, oldDN, newDN })
}

/** Moves `dns` into targetDN (one BatchMove, audited), emits entry-moved, toasts with Undo. */
async function performTreeMove(profileId: string, dns: string[], targetDN: string, roots: TreeNode[]): Promise<void> {
  const target = entryName(targetDN, roots)
  try {
    const result = await wails.BatchMove(profileId, dns, targetDN)
    const { moved, errors } = movedOf(dns, result)
    for (const dn of moved) emitMoved(profileId, dn, movedDN(dn, targetDN))
    if (moved.length > 0) {
      const ts = useTreeStore.getState()
      ts.expandNode(profileId, targetDN)
      // The keyboard follows the (first) moved row into its new parent, the moved rows stay
      // selected (RW3-N-02: focus was left on the root row or the tree container).
      void ts.locateInTree(profileId, movedDN(moved[0], targetDN), { quiet: true, keepSelection: true })
      // One wording with Move… ("<name> moved to <target>", M-12 / M-13).
      // Undo also from the bell and with Ctrl+Z while the entries stay there (RW3-N-04).
      toast.success(moved.length === 1 ? `${entryName(moved[0])} moved to ${target}` : `${moved.length} entries moved to ${target}`, {
        action: moveUndoButton(profileId, moved, targetDN),
      })
    }
    if (errors.length > 0) {
      toast.error(moved.length === 0 ? (dns.length === 1 ? `Could not move ${entryName(dns[0])}` : 'Move failed') : `${errors.length} of ${dns.length} entries could not be moved`, moveErrorText(errors))
    }
  } catch (err) {
    toast.error('Move failed', err instanceof Error ? err.message : String(err))
  }
}

/** "Move n entries to <target>?" with the list, the target DN and "Don't ask again this session". */
function MoveEntriesDialog({ profileId, dns, targetDN, roots, onClose }: { profileId: string; dns: string[]; targetDN: string; roots: TreeNode[]; onClose: () => void }) {
  const [dontAsk, setDontAsk] = useState(false)
  const [busy, setBusy] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const n = dns.length
  const target = entryName(targetDN, roots)
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      role="alertdialog"
      size={n > 1 ? 'md' : 'sm'}
      icon={FolderInput}
      title={n === 1 ? 'Move entry' : `Move ${n} entries`}
      description={n === 1 ? `Move ${entryName(dns[0])} to ${target}?` : `Move ${n} entries to ${target}?`}
      dismissible={busy ? 'never' : 'always'}
      initialFocus={cancelRef}
      onSubmit={() => {
        if (busy) return
        setBusy(true)
        if (dontAsk) skipMoveConfirm = true
        void performTreeMove(profileId, dns, targetDN, roots).finally(onClose)
      }}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Move
          </Button>
        </>
      }
    >
      <ul className="max-h-40 overflow-auto rounded border border-border bg-background px-2 py-1 text-sm" aria-label="Entries to move">
        {dns.map((d) => (
          <li key={d} className="py-0.5">
            <Dn dn={d} />
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-muted-foreground">
        Into <Dn dn={targetDN} className="text-foreground" />
      </p>
      <div className="mt-3">
        <Checkbox label="Don't ask again this session" checked={dontAsk} onCheckedChange={setDontAsk} disabled={busy} />
      </div>
    </Dialog>
  )
}

/** A row can take dropped entries: containers (also empty ones), NC heads, other entries with children. */
function isDropContainer(node: TreeNode): boolean {
  const kind = nodeKind(node)
  return isContainerKind(kind) || isContextHead(node) || (kind === 'other' && node.hasChildren)
}

export function DirectoryTree() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId)
  const isConnected = useConnectionStore((s) => (s.activeProfileId ? s.connectionStatuses[s.activeProfileId] === true : false))
  const activeProfile = useConnectionStore((s) => (s.activeProfileId ? s.profiles.find((p) => p.id === s.activeProfileId) : undefined))
  const rootNodes = useTreeStore((s) => s.rootNodes)
  const childNodes = useTreeStore((s) => s.childNodes)
  const expandedNodes = useTreeStore((s) => s.expandedNodes)
  const selectedNodes = useTreeStore((s) => s.selectedNodes)
  const loading = useTreeStore((s) => s.loading)
  const selectionAnchor = useTreeStore((s) => s.selectionAnchor)
  const rootError = useTreeStore((s) => (activeProfileId ? s.rootErrors[activeProfileId] : undefined))
  const revealRequest = useTreeStore((s) => s.revealRequest)
  // Account statuses re-read after an account action (TREE-11) re-render the overlays.
  useTreeStore((s) => s.statusVersion)
  // Every server status that lands in the cache (editor, reports, palette, menus) updates
  // the row overlays too, e.g. a lock made outside the app (RW1-P-02).
  useSyncExternalStore(subscribeAccountStatus, accountStatusVersion, accountStatusVersion)
  const { loadRootNodes, refreshTree, toggleExpand, toggleSelectNode, clearSelection } = useTreeStore.getState()
  const openEntry = useEditorStore((s) => s.openEntry)
  const sortMode = useTreePrefs((s) => s.sortMode)
  const showRdnType = useTreePrefs((s) => s.showRdnType)
  const filterRequest = useTreePrefs((s) => s.filterRequest)
  // Account statuses read on demand (accountStatusCache) re-resolve the registry; re-render the overlays with it.
  const registryVersion = useCommandRegistryVersion()

  const [menu, setMenu] = useState<EntryMenuState | null>(null)
  const [treeFilter, setTreeFilter] = useState('')
  const [showTreeFilter, setShowTreeFilter] = useState(false)
  const [focusFilter, setFocusFilter] = useState(0)
  const [showAllIn, setShowAllIn] = useState<Set<string>>(() => new Set())
  const [treeFocused, setTreeFocused] = useState(false)
  const [searchResults, setSearchResults] = useState<LDAPEntry[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchDone, setSearchDone] = useState(false)
  // The size limit cut the hits (RW1-N-05): the filter that would list them all, per base.
  const [searchMore, setSearchMore] = useState<{ filter: string } | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [serverSearchBases, setServerSearchBases] = useState<{ profileId: string; bases: string[] } | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeqRef = useRef(0)
  const filterInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Input the user chose to search as text although it starts with "(" (cleared by any edit)
  const [treeTextOverride, setTreeTextOverride] = useState<string | null>(null)
  const treeQuery = parseQuickSearchInput(treeFilter, treeTextOverride === treeFilter)
  const isRawTreeQuery = treeQuery.kind === 'raw'
  const rawTreeCheck = useFilterCheck(showTreeFilter && isRawTreeQuery ? treeQuery.text : null)

  const isReadOnly = activeProfile?.readOnly ?? false
  const anonymous = activeProfile?.authMethod === 'none'
  const nodes = (activeProfileId && rootNodes[activeProfileId]) || EMPTY_NODES
  const isRootLoading = activeProfileId ? !!loading[`root:${activeProfileId}`] : false
  const showRootSkeleton = useDelayedFlag(isRootLoading && nodes.length === 0)
  const selectionCount = selectedNodes.size

  // Roots load once per connection; a failed load is not retried in a loop (Refresh retries).
  useEffect(() => {
    if (activeProfileId && isConnected && !rootNodes[activeProfileId] && !useTreeStore.getState().loading[`root:${activeProfileId}`] && !useTreeStore.getState().rootErrors[activeProfileId]) {
      void loadRootNodes(activeProfileId)
    }
  }, [activeProfileId, isConnected, loadRootNodes, rootNodes])

  // Bases of the tree search: the server knows which naming contexts the tree
  // shows (AD: base DN root + every domain, a subtree search does not cross
  // into another naming context). Refreshed whenever the roots are reloaded.
  useEffect(() => {
    if (!activeProfileId || !isConnected || nodes.length === 0) return
    let cancelled = false
    GetTreeSearchBases(activeProfileId)
      .then((bases) => {
        if (cancelled) return
        setServerSearchBases((prev) =>
          prev && prev.profileId === activeProfileId && prev.bases.join('\n') === bases.join('\n') ? prev : { profileId: activeProfileId, bases },
        )
      })
      .catch(() => {
        if (!cancelled) setServerSearchBases((prev) => (prev === null ? prev : null))
      })
    return () => {
      cancelled = true
    }
  }, [activeProfileId, isConnected, nodes])

  const treeSearchBases = useMemo(
    () => resolveTreeSearchBases(serverSearchBases?.profileId === activeProfileId ? serverSearchBases.bases : null, nodes, activeProfile?.baseDN || ''),
    [serverSearchBases, activeProfileId, nodes, activeProfile?.baseDN],
  )
  const treeSearchBasesKey = treeSearchBases.join('\n')

  // Debounced server-side LDAP search across all search bases (referrals are followed)
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    const seq = ++searchSeqRef.current

    if (treeQuery.kind === 'empty' || treeQuery.text.length < 2 || !activeProfileId || !isConnected) {
      setSearchResults((r) => (r.length ? [] : r))
      setSearchLoading(false)
      setSearchDone(false)
      setSearchError(null)
      setSearchMore(null)
      return
    }

    setSearchLoading(true)
    setSearchMore(null)
    setSearchDone(false)
    setSearchError(null)

    searchTimerRef.current = setTimeout(async () => {
      let filter: string
      // Text queries also run a name-only query first, so entries named like the
      // query are never crowded out by description matches at the size limit.
      let nameFilter: string | null = null
      if (treeQuery.kind === 'raw') {
        const invalid = await checkFilter(treeQuery.text)
        if (seq !== searchSeqRef.current) return
        if (invalid) {
          // The raw-filter hint (useFilterCheck) shows the validation error.
          setSearchResults([])
          setSearchLoading(false)
          setSearchDone(false)
          return
        }
        filter = treeQuery.text
      } else {
        filter = buildAnyAttributeFilter(TREE_SEARCH_ATTRS, treeQuery.text)
        nameFilter = buildAnyAttributeFilter(TREE_NAME_ATTRS, treeQuery.text)
      }
      const bases = treeSearchBasesKey.split('\n')
      const sizeLimit = perBaseSizeLimit(bases.length)

      const failures: string[] = []
      let truncated = false
      const searchBase = async (baseDN: string, f: string) => {
        try {
          const result = await wails.SearchLDAP(activeProfileId, {
            baseDN,
            filter: f,
            scope: ScopeSub,
            attributes: ['cn', 'objectClass', 'displayName', 'sAMAccountName', 'uid'],
            sizeLimit,
            timeLimit: 10,
          })
          if (f === filter && (result?.truncated || (result?.entries?.length ?? 0) >= sizeLimit)) truncated = true
          return result?.entries || []
        } catch (err) {
          failures.push(err instanceof Error ? err.message : String(err))
          return []
        }
      }
      const filters = nameFilter ? [nameFilter, filter] : [filter]
      const results = await Promise.all(filters.flatMap((f) => bases.map((baseDN) => searchBase(baseDN, f))))
      if (seq !== searchSeqRef.current) return // a newer search replaced this one

      // Name matches first (exact, prefix, word prefix, contains), then description-only hits (SPEC 11.2 #73).
      const deduped = dedupeByDN(results.flat())
      const merged = treeQuery.kind === 'text' ? rankTreeHits(deduped, treeQuery.text) : deduped
      setSearchResults(merged)
      setSearchError(merged.length === 0 && failures.length > 0 ? failures[0] : null)
      setSearchMore(truncated ? { filter } : null)
      setSearchLoading(false)
      setSearchDone(true)
    }, 400)

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
  }, [treeQuery.kind, treeQuery.text, activeProfileId, isConnected, treeSearchBasesKey])

  // --- Flattened rows ---------------------------------------------------------------

  // Local row filter on the loaded nodes (not for raw LDAP filters)
  const filterLower = treeQuery.kind === 'text' ? treeQuery.text.toLowerCase() : ''

  const flatRows = useMemo(() => {
    const rows: FlatRow[] = []
    // With a filter, a row stays when it matches or a loaded, expanded descendant does (its path stays visible).
    const keep = new Map<string, boolean>()
    const keepNode = (node: TreeNode): boolean => {
      if (!filterLower) return true
      const known = keep.get(node.dn)
      if (known !== undefined) return known
      keep.set(node.dn, false) // guards against cycles in injected naming contexts
      const hit =
        !!node.rdn?.toLowerCase().includes(filterLower) ||
        node.dn.toLowerCase().includes(filterLower) ||
        (expandedNodes.has(node.dn) && (childNodes[node.dn] ?? []).some(keepNode))
      keep.set(node.dn, hit)
      return hit
    }
    const flatten = (list: TreeNode[], depth: number, parentId: string | null) => {
      // The roots keep the planned order (domain, other domains, DNS zones, Configuration, Schema).
      for (const node of depth === 0 ? list : sortTreeNodes(list, sortMode)) {
        if (!keepNode(node)) continue
        rows.push({ kind: 'node', id: node.dn, node, depth, parentId })
        if (!expandedNodes.has(node.dn)) continue
        const all = childNodes[node.dn]
        const children = filterLower && all ? all.filter(keepNode) : all
        if (!children || children.length === 0) continue
        if (children.length > LARGE_CONTAINER && !showAllIn.has(node.dn)) {
          rows.push({ kind: 'large', id: largeRowId(node.dn), containerDn: node.dn, depth: depth + 1, parentId: node.dn, count: children.length })
          // Selected children (Show in Tree, keyboard) stay visible below the placeholder.
          const pinned = children.filter((c) => selectedNodes.has(c.dn))
          if (pinned.length) flatten(pinned, depth + 1, node.dn)
        } else flatten(children, depth + 1, node.dn)
      }
    }
    flatten(nodes, 0, null)
    return rows
  }, [nodes, expandedNodes, childNodes, filterLower, sortMode, showAllIn, selectedNodes])

  const rowById = useMemo(() => new Map(flatRows.map((r) => [r.id, r])), [flatRows])
  const flatDNs = useMemo(() => flatRows.filter((r) => r.kind === 'node').map((r) => r.id), [flatRows])
  /** Naming-context heads among the shown rows (never moved). */
  const headDNs = useMemo(() => new Set(flatRows.filter((r) => r.kind === 'node' && isContextHead(r.node)).map((r) => normalizeDN(r.id))), [flatRows])

  const keyboardItems = useMemo<TreeKeyboardItem[]>(
    () =>
      flatRows.map((r) =>
        r.kind === 'node'
          ? {
              id: r.id,
              label: nodeLabel(r.node, showRdnType),
              level: r.depth + 1,
              parentId: r.parentId,
              expandable: r.node.hasChildren,
              expanded: expandedNodes.has(r.id),
            }
          : { id: r.id, label: '', level: r.depth + 1, parentId: r.parentId, expandable: false, expanded: false },
      ),
    [flatRows, showRdnType, expandedNodes],
  )

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 20,
  })

  // Expanded rows whose children are not loaded (a moved container, a parked
  // view): load them once, quietly.
  const autoLoadTried = useRef(new Set<string>())
  useEffect(() => {
    if (!activeProfileId) return
    for (const r of flatRows) {
      if (r.kind !== 'node' || !r.node.hasChildren || !expandedNodes.has(r.id) || childNodes[r.id] || loading[r.id]) continue
      const key = `${activeProfileId}\n${r.id}`
      if (autoLoadTried.current.has(key)) continue
      autoLoadTried.current.add(key)
      useTreeStore
        .getState()
        .loadChildren(activeProfileId, r.id, true)
        .then(() => autoLoadTried.current.delete(key))
        .catch(() => {})
    }
  }, [flatRows, expandedNodes, childNodes, loading, activeProfileId])

  // --- Selection and commands ------------------------------------------------------------

  const selectionItemFor = useCallback(
    (dn: string): SelectionItem => {
      const row = rowById.get(dn)
      return {
        dn,
        profileId: activeProfileId ?? undefined,
        objectClass: row?.kind === 'node' ? row.node.objectClass : undefined,
        status: cachedAccountStatusKinds(activeProfileId, dn),
      }
    },
    [rowById, activeProfileId],
  )

  /** Command context for explicit DNs (keyboard) or, without, the tree selection. */
  const ctxFor = useCallback(
    (dns?: string[], source: CommandSource = 'tree') =>
      getCommandContext(source, dns ? { selection: dns.map(selectionItemFor) } : {}),
    [selectionItemFor],
  )

  const run = useCallback(
    (id: string, dns?: string[]) => {
      if (runCommand(id, ctxFor(dns))) return true
      if (isReadOnly && ['entry.rename', 'entry.delete', 'create.entry', 'bulk.modifySelected', 'entry.move'].includes(id)) {
        toast.info('The connection is read-only')
      }
      return false
    },
    [ctxFor, isReadOnly],
  )

  /** Selects dn..anchor (Shift), optionally added to the current selection (Ctrl+Shift). */
  const selectRangeTo = useCallback(
    (dn: string, anchor: string | null, additive: boolean) => {
      const ts = useTreeStore.getState()
      const from = anchor ?? ts.selectionAnchor ?? dn
      const a = flatDNs.indexOf(from)
      const b = flatDNs.indexOf(dn)
      if (a < 0 || b < 0) {
        toggleSelectNode(dn, false)
        return
      }
      const next = new Set(additive ? ts.selectedNodes : [])
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(flatDNs[i])
      // The anchor stays (further Shift moves extend from it).
      useTreeStore.setState({ selectedNodes: next, selectionAnchor: from })
    },
    [flatDNs, toggleSelectNode],
  )

  // Selection changes the tree makes itself never scroll it; external ones (Show in Tree) do.
  // The tree remembers the selection set it produced last.
  const internalSelection = useRef<Set<string> | null>(null)
  const markInternal = () => {
    internalSelection.current = useTreeStore.getState().selectedNodes
  }

  const largeContainer = (id: string) => {
    const r = rowById.get(id)
    return r?.kind === 'large' ? r : null
  }

  const openList = useCallback(
    (dn: string) => {
      if (!activeProfileId) return
      openContainerContents(activeProfileId, dn)
    },
    [activeProfileId],
  )

  const expandIfCollapsed = (dn: string) => {
    if (activeProfileId && !useTreeStore.getState().expandedNodes.has(dn)) toggleExpand(activeProfileId, dn)
  }

  const tree = useTreeKeyboard({
    items: keyboardItems,
    label: 'Directory tree',
    multiSelect: true,
    selectedIds: selectedNodes,
    pageSize: Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? ROW_H * 12) / ROW_H) - 1),
    onSelect: (id, mode, anchor) => {
      if (largeContainer(id)) return
      if (mode === 'range') selectRangeTo(id, anchor, false)
      else toggleSelectNode(id, mode === 'toggle')
      markInternal()
    },
    onExpand: (id) => expandIfCollapsed(id),
    onCollapse: (id) => {
      if (activeProfileId && useTreeStore.getState().expandedNodes.has(id)) toggleExpand(activeProfileId, id)
    },
    // Enter opens the preview tab, Ctrl+Enter a pinned one (SPEC 9, UX-3); containers open on Contents.
    onOpen: (id, { pin }) => {
      const large = largeContainer(id)
      if (large) openList(large.containerDn)
      else if (activeProfileId) openEntry(activeProfileId, id, { preview: !pin })
    },
    onRename: (id) => {
      if (!largeContainer(id)) run('entry.rename', [id])
    },
    onDelete: (ids) => {
      const dns = ids.filter((id) => !largeContainer(id))
      if (dns.length) run('entry.delete', dns)
    },
    onNewChild: (id) => {
      if (!largeContainer(id)) run('create.entry', [id])
    },
    onCopyDn: (ids) => {
      const dns = ids.filter((id) => !largeContainer(id))
      if (dns.length === 1) run('entry.copyDn', dns)
      else if (dns.length > 1) run('entry.copyDns', dns)
    },
    onContextMenu: (id, el) => {
      if (largeContainer(id)) return
      openMenuAt(id, el ? contextMenuPoint({ target: el }) : null)
    },
    onExpandSiblings: (ids) => ids.forEach(expandIfCollapsed),
    scrollToIndex: (i) => virtualizer.scrollToIndex(i, { align: 'auto' }),
  })

  function openMenuAt(dn: string, point: { clientX: number; clientY: number } | null) {
    if (!activeProfileId) return
    if (!useTreeStore.getState().selectedNodes.has(dn)) {
      toggleSelectNode(dn, false)
      markInternal()
    }
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(dn)}"]`)
    const p = point ?? (el ? contextMenuPoint({ target: el }) : { clientX: 0, clientY: 0 })
    setMenu({ point: p, ctx: getCommandContext('tree') })
  }

  // External selection changes (Show in Tree, locateInTree, the palette): scroll
  // the row into view and move the roving tab stop to it; a Show in Tree
  // request (revealRequest.focus) also focuses the row (TREE-07).
  const pendingScroll = useRef<{ dn: string; focus: boolean } | null>(null)
  useEffect(() => {
    if (selectedNodes === internalSelection.current) return
    if (selectionAnchor && selectedNodes.has(selectionAnchor) && pendingScroll.current?.dn !== selectionAnchor) {
      pendingScroll.current = { dn: selectionAnchor, focus: false }
    }
  }, [selectedNodes, selectionAnchor])
  const handledReveal = useRef(0)
  useEffect(() => {
    const r = revealRequest
    if (!r || r.seq === handledReveal.current || r.profileId !== activeProfileId) return
    handledReveal.current = r.seq
    // A request from before this tree was mounted (remount later) is not replayed.
    if (Date.now() - r.at > 5000) return
    pendingScroll.current = { dn: r.dn, focus: r.focus }
  }, [revealRequest, activeProfileId])
  useEffect(() => {
    const target = pendingScroll.current
    if (!target) return
    const idx = flatRows.findIndex((r) => r.id === target.dn)
    if (idx < 0) return
    pendingScroll.current = null
    tree.setRovingId(target.dn)
    // Double rAF: the virtualizer has processed the new row count.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(idx, { align: 'center' })
        if (!target.focus) return
        requestAnimationFrame(() => {
          const el = scrollRef.current?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(target.dn)}"]`)
          if (el) el.focus({ preventScroll: true })
          else {
            // Not rendered yet: park focus on the tree; the row takes it when it mounts.
            tree.setFocusedId(target.dn)
            scrollRef.current?.querySelector<HTMLElement>('[role="tree"]')?.focus({ preventScroll: true })
          }
        })
      }),
    )
  }, [flatRows, selectedNodes, selectionAnchor, revealRequest])

  // --- Drag and drop (TREE-02) -------------------------------------------------------------

  /** The running drag: its DNs, start time and the drop verdict per target row (dragover fires constantly). */
  const dragSession = useRef<{ profileId: string; dns: string[]; at: number; verdicts: Map<string, boolean> } | null>(null)

  const dragStart = useCallback(
    (dn: string): string[] => {
      if (!activeProfileId) return []
      const sel = useTreeStore.getState().selectedNodes
      // A selected row drags the whole selection, another row only itself.
      const dns = (sel.has(dn) ? [...sel] : [dn]).filter((d) => !headDNs.has(normalizeDN(d)))
      dragSession.current = dns.length ? { profileId: activeProfileId, dns, at: Date.now(), verdicts: new Map() } : null
      return dns
    },
    [activeProfileId, headDNs],
  )

  const canDropOn = useCallback(
    (node: TreeNode): boolean => {
      const s = dragSession.current
      if (!s || s.profileId !== activeProfileId || !isDropContainer(node)) return false
      const known = s.verdicts.get(node.dn)
      if (known !== undefined) return known
      const ok = planTreeMove(s.dns, node.dn, nodes, (dn) => headDNs.has(normalizeDN(dn))).move.length > 0
      s.verdicts.set(node.dn, ok)
      return ok
    },
    [activeProfileId, nodes, headDNs],
  )

  const dropOn = useCallback(
    (node: TreeNode, text: string) => {
      const s = dragSession.current
      dragSession.current = null
      if (!s || !activeProfileId || s.profileId !== activeProfileId || isReadOnly) return
      // Only this tree's own drag: the drop carries the session's DNs (an engine that hides the
      // data on drop is accepted only right after the drag started).
      const data = text.replace(/\r\n/g, '\n')
      if (data ? data !== s.dns.join('\n') : Date.now() - s.at > 60_000) return
      const plan = planTreeMove(s.dns, node.dn, nodes, (dn) => headDNs.has(normalizeDN(dn)))
      if (plan.move.length === 0) return
      if (skipMoveConfirm) void performTreeMove(activeProfileId, plan.move, node.dn, nodes)
      else useDialogStore.getState().open(MoveEntriesDialog, { profileId: activeProfileId, dns: plan.move, targetDN: node.dn, roots: nodes })
    },
    [activeProfileId, isReadOnly, nodes, headDNs],
  )

  // --- Filter ------------------------------------------------------------------------------

  const closeTreeFilter = useCallback(() => {
    setShowTreeFilter(false)
    setTreeFilter('')
    setTreeTextOverride(null)
  }, [])

  const openTreeFilter = useCallback(() => {
    setShowTreeFilter(true)
    setFocusFilter((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!focusFilter) return
    const el = filterInputRef.current
    if (el) {
      el.focus()
      el.select()
    }
  }, [focusFilter, showTreeFilter])

  // Edit ▸ Find in Tree (command) asks through the prefs store.
  const seenFilterRequest = useRef(filterRequest)
  useEffect(() => {
    if (filterRequest === seenFilterRequest.current) return
    seenFilterRequest.current = filterRequest
    openTreeFilter()
  }, [filterRequest, openTreeFilter])

  // Ctrl+F itself is the registry command edit.findInTree (treeCommands.tsx): it
  // opens this filter through the prefs store request above.

  const focusTree = () => {
    if (tree.focusedId) tree.setFocusedId(tree.focusedId)
    else scrollRef.current?.querySelector<HTMLElement>('[role="tree"]')?.focus()
  }

  const openHit = useCallback(
    (dn: string, pin: boolean) => {
      if (activeProfileId) openEntry(activeProfileId, dn, { preview: !pin })
    },
    [activeProfileId, openEntry],
  )

  // --- Header and selection toolbar ----------------------------------------------------------

  const headerActions = useMemo<PanelAction[]>(
    () => [
      { id: 'filter', label: 'Find in Tree', icon: Search, shortcut: 'Mod+F', pressed: showTreeFilter, onClick: () => (showTreeFilter ? closeTreeFilter() : openTreeFilter()) },
      { id: 'collapse', label: 'Collapse All', icon: ChevronsDownUp, onClick: () => useTreeStore.setState({ expandedNodes: new Set<string>() }) },
      // Every visible expanded container is read again; expansion and selection stay (TREE-01).
      { id: 'refresh', label: 'Refresh Tree', icon: RefreshCw, onClick: () => activeProfileId && void refreshTree(activeProfileId) },
    ],
    [showTreeFilter, closeTreeFilter, openTreeFilter, activeProfileId, refreshTree],
  )

  const sortMenu = (
    <DropdownMenu
      label="Sort"
      placement="bottom-end"
      trigger={<IconButton label={`Sort: ${SORT_MODE_LABELS[sortMode]}`} icon={ArrowUpDown} size="md" pressed={sortMode !== DEFAULT_SORT_MODE} />}
    >
      <MenuRadioGroup label="Sort" value={sortMode} onValueChange={(v) => useTreePrefs.getState().setSortMode(v as TreeSortMode)}>
        {(Object.keys(SORT_MODE_LABELS) as TreeSortMode[]).map((m) => (
          <MenuRadioItem key={m} value={m} label={SORT_MODE_LABELS[m]} />
        ))}
      </MenuRadioGroup>
    </DropdownMenu>
  )

  // Registry-driven: an item shows when its command is offered for the selection
  // (write verbs hidden on read-only connections, Enable/Disable only for accounts).
  const toolbarItems = useMemo<ToolbarItem[]>(() => {
    if (selectionCount < 2) return []
    const ctx = ctxFor()
    // The registry's titles, so bar and context menu say the same ("Copy 2 DNs",
    // "Enable/Disable 2 Accounts…"; RW1-N-10 / RW1-E-15).
    const offered = new Map(resolveCommands(ctx, { ids: TOOLBAR_COMMANDS.map((c) => c.id), surface: 'menu' }).items.filter((i) => i.enabled).map((i) => [i.id, i.title]))
    return TOOLBAR_COMMANDS.filter((c) => offered.has(c.id)).map((c) => ({
      id: c.id,
      label: offered.get(c.id) || c.label(selectionCount),
      icon: c.icon,
      danger: c.danger,
      separator: c.separator,
      onClick: () => run(c.id),
    }))
    // registryVersion: account statuses and server types arrive later and change what is offered.
  }, [ctxFor, run, selectionCount, selectedNodes, registryVersion, isReadOnly])

  const editConnection = () => {
    if (!activeProfile) return
    useDialogStore.getState().open(ConnectionDialog, { profile: activeProfile, onSave: useConnectionStore.getState().saveProfile })
  }
  const retryRoots = () => {
    if (!activeProfileId) return
    useTreeStore.setState((s) => {
      const rootErrors = { ...s.rootErrors }
      delete rootErrors[activeProfileId]
      return { rootErrors }
    })
    void loadRootNodes(activeProfileId)
  }
  // Anonymous bind and no root with a readable child (TREE-10): OpenLDAP lists an
  // empty base, AD's root reads fail (placeholders without a children list).
  const anonymousEmpty = anonymous && nodes.length > 0 && nodes.every((n) => !childNodes[n.dn]?.length)
  const ANON_HINT = 'Anonymous access may not be allowed to read this base — use a bind DN.'

  // --- Render ----------------------------------------------------------------------------------

  if (!isConnected) {
    // Normally not mounted while disconnected (Sidebar shows the saved profiles).
    return (
      <div className="h-full flex flex-col bg-sidebar">
        <PanelHeader title="Explorer" icon={FolderTree} />
        <EmptyState icon={FolderTree} title="Not connected" hint="Connect to a server to browse." />
      </div>
    )
  }

  const treeProps = tree.getTreeProps()

  return (
    <div className="h-full flex flex-col bg-sidebar min-w-0">
      <PanelHeader
        title="Explorer"
        subtitle={activeProfile?.name}
        icon={FolderTree}
        extra={sortMenu}
        actions={headerActions}
        filter={
          showTreeFilter ? (
            <SearchInput
              ref={filterInputRef}
              value={treeFilter}
              onValueChange={(v) => {
                setTreeFilter(v)
                setTreeTextOverride(null)
              }}
              onEscape={() => {
                closeTreeFilter()
                focusTree()
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  // Down moves into the hits (or the tree).
                  e.preventDefault()
                  const first = document.querySelector<HTMLElement>('[data-tree-hit]')
                  if (first) first.focus()
                  else focusTree()
                } else if (e.key === 'Enter' && !e.altKey && !e.shiftKey) {
                  // Enter opens the first hit (preview), Ctrl+Enter pins it.
                  const first = searchResults[0]
                  if (!first) return
                  e.preventDefault()
                  openHit(first.dn, e.ctrlKey || e.metaKey)
                }
              }}
              placeholder="Find entries… or (raw=filter)"
              aria-label="Find in tree"
              title="Text is matched literally in cn, displayName, sAMAccountName, uid and description, and filters the loaded rows. Start with ( for a raw LDAP filter. Enter opens the first hit, Ctrl+Enter pins it. Escape clears, a second Escape closes."
              shortcut="Mod+F"
              size="sm"
              mono={isRawTreeQuery}
              spellCheck={false}
            />
          ) : undefined
        }
      />

      {showTreeFilter && isRawTreeQuery && (
        <div className="px-2 py-1 border-b border-border">
          <RawFilterHint check={rawTreeCheck} onSearchAsText={() => setTreeTextOverride(treeFilter)} />
        </div>
      )}
      {showTreeFilter && treeTextOverride === treeFilter && parseQuickSearchInput(treeFilter).kind === 'raw' && (
        <div className="px-2 py-1 border-b border-border">
          <TextOverrideHint onUseAsFilter={() => setTreeTextOverride(null)} />
        </div>
      )}

      {showTreeFilter && treeQuery.text.length >= 2 && (searchLoading || searchDone) && (
        <TreeSearchHits
          results={searchResults}
          loading={searchLoading}
          done={searchDone}
          error={searchError}
          bases={treeSearchBases}
          truncated={!!searchMore}
          onOpenAll={
            searchMore && activeProfileId
              ? () => {
                  // The same filter on every search base of the tree, without the size limit.
                  const base = treeSearchBases.length === 1 ? treeSearchBases[0] : ''
                  showSearchResults()
                  void useSearchStore.getState().executeSearch(activeProfileId, searchMore.filter, {
                    mode: 'advanced',
                    overrides: { baseDN: base, scope: ScopeSub, attributes: [], showDeleted: false, showRecycled: false, manageDsaIT: false },
                  })
                }
              : undefined
          }
          onOpen={openHit}
          onShowInTree={(dn) => {
            if (!activeProfileId) return
            closeTreeFilter()
            showInTree(activeProfileId, dn)
          }}
          onEscape={() => filterInputRef.current?.focus()}
          onContextMenu={(entry, point) => {
            const objectClass = entry.attributes?.find((a) => a.name.toLowerCase() === 'objectclass')?.values
            setMenu({
              point,
              // Hits may not be loaded in the tree: their own object classes decide the verbs ("Show in Tree" included).
              ctx: getCommandContext('results', {
                selection: [{ dn: entry.dn, profileId: activeProfileId ?? undefined, objectClass, status: cachedAccountStatusKinds(activeProfileId, entry.dn) }],
              }),
            })
          }}
        />
      )}

      {anonymousEmpty && (
        <InlineAlert
          variant="banner"
          tone="warning"
          body={ANON_HINT}
          actions={
            <Button size="sm" variant="secondary" onClick={editConnection}>
              Edit Connection…
            </Button>
          }
        />
      )}

      {/* Focusable command scope: F2 / Del / Ctrl+N of the registry act on the tree selection. */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-auto"
        data-command-scope="tree"
        onFocus={() => setTreeFocused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setTreeFocused(false)
        }}
      >
        {nodes.length === 0 ? (
          isRootLoading ? (
            showRootSkeleton ? (
              <Skeleton variant="tree" rows={8} className="pt-1" />
            ) : null
          ) : anonymous ? (
            <EmptyState
              icon={ServerCog}
              title="Nothing to show"
              hint={rootError ? `${ANON_HINT} (${rootError})` : ANON_HINT}
              action={
                <>
                  <Button size="sm" variant="primary" onClick={editConnection}>
                    Edit Connection…
                  </Button>
                  <Button size="sm" variant="secondary" onClick={retryRoots}>
                    Retry
                  </Button>
                </>
              }
            />
          ) : rootError ? (
            <EmptyState
              icon={FolderTree}
              title="Could not load the tree"
              hint={rootError}
              action={
                <>
                  <Button size="sm" variant="secondary" onClick={retryRoots}>
                    Retry
                  </Button>
                  <Button size="sm" variant="ghost" onClick={editConnection}>
                    Edit Connection…
                  </Button>
                </>
              }
            />
          ) : (
            <EmptyState variant="inline" icon={FolderTree} title="No entries found" />
          )
        ) : (
          <div
            {...treeProps}
            className="relative outline-hidden focus-ring-inset"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const row = flatRows[vi.index]
              const item = keyboardItems[vi.index]
              const style = { position: 'absolute' as const, top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }
              if (row.kind === 'large') {
                return (
                  <LargeContainerRow
                    key={row.id}
                    count={row.count}
                    depth={row.depth}
                    itemProps={tree.getItemProps(item)}
                    style={style}
                    onOpenList={() => openList(row.containerDn)}
                    onShowAll={() => setShowAllIn((s) => new Set(s).add(row.containerDn))}
                  />
                )
              }
              const { node, depth } = row
              const loaded = childNodes[node.dn]
              const kinds: AccountStatusKind[] = [...(cachedAccountStatusKinds(activeProfileId, node.dn) ?? node.status ?? [])]
              const dropTarget = !isReadOnly && isDropContainer(node)
              return (
                <TreeNodeRow
                  key={row.id}
                  node={node}
                  label={item.label}
                  depth={depth}
                  isExpanded={expandedNodes.has(node.dn)}
                  isSelected={selectedNodes.has(node.dn)}
                  treeFocused={treeFocused}
                  isLoading={!!loading[node.dn]}
                  childCount={loaded ? loaded.length : null}
                  status={primaryStatus(kinds)}
                  itemProps={tree.getItemProps(item)}
                  style={style}
                  onToggle={() => activeProfileId && toggleExpand(activeProfileId, node.dn)}
                  onSelect={(e) => {
                    const ctrl = e.ctrlKey || e.metaKey
                    if (e.shiftKey) {
                      selectRangeTo(node.dn, null, ctrl)
                      markInternal()
                    } else {
                      tree.select(node.dn, ctrl ? 'toggle' : 'replace')
                      // A plain click opens the one preview tab (UX-3; View ▸ Single-Click Opens Preview).
                      if (!ctrl && activeProfileId && useUIStore.getState().singleClickPreview) openEntry(activeProfileId, node.dn, { preview: true })
                    }
                  }}
                  // Double-click pins (the click before it opened the preview).
                  onOpen={() => activeProfileId && openEntry(activeProfileId, node.dn)}
                  onContextMenu={(e) => openMenuAt(node.dn, { clientX: e.clientX, clientY: e.clientY })}
                  onDragStartRow={isReadOnly ? undefined : () => dragStart(node.dn)}
                  onDragEndRow={() => {
                    dragSession.current = null
                  }}
                  canDrop={dropTarget ? () => canDropOn(node) : undefined}
                  onDropRow={dropTarget ? (text) => dropOn(node, text) : undefined}
                />
              )
            })}
          </div>
        )}
      </div>

      {selectionCount > 1 && (
        <div className="flex items-center gap-2 pl-3 pr-1 h-panel-header border-t border-border bg-card shrink-0 min-w-0">
          <span className="text-xs text-muted-foreground tabular-nums shrink-0" role="status">
            {selectionCount} selected
          </span>
          <Toolbar
            aria-label="Selection actions"
            items={toolbarItems}
            className="flex-1"
            end={<IconButton label="Clear selection" icon={X} size="md" onClick={clearSelection} />}
          />
        </div>
      )}

      <TreeContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  )
}

/**
 * Directory search hits below the filter (TREE-07): a listbox; each option
 * shows the entry's name as its tab will (the RDN value, plus the display
 * name when it differs) and where it lives ("in Special Cases, LDAPilot,
 * ad.ldapilot.lab"; the unescaped DN as tooltip). Click / Enter opens the
 * preview, double-click / Ctrl+Enter pins, Shift+F10 opens the menu.
 */
function TreeSearchHits({
  results,
  loading,
  done,
  error,
  bases,
  truncated,
  onOpenAll,
  onOpen,
  onShowInTree,
  onContextMenu,
  onEscape,
}: {
  results: LDAPEntry[]
  loading: boolean
  done: boolean
  error: string | null
  bases: string[]
  /** The size limit cut the hits: say so, offer the full list in Search Results. */
  truncated?: boolean
  onOpenAll?: () => void
  onOpen: (dn: string, pin: boolean) => void
  onShowInTree: (dn: string) => void
  onContextMenu: (entry: LDAPEntry, point: { clientX: number; clientY: number }) => void
  /** Escape in the hits: back to the filter field. */
  onEscape: () => void
}) {
  const [active, setActive] = useState(0)
  const activeIndex = Math.min(active, Math.max(0, results.length - 1))
  const listRef = useRef<HTMLUListElement>(null)
  const focusAt = (i: number) => {
    const el = listRef.current?.querySelectorAll<HTMLElement>('[data-tree-hit]')[i]
    if (!el) return
    setActive(i)
    el.focus()
  }
  const onKey = (e: ReactKeyboardEvent<HTMLElement>, i: number, entry: LDAPEntry) => {
    const ctrl = e.ctrlKey || e.metaKey
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusAt(Math.min(results.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (i === 0) onEscape() // above the first hit: back to the filter
      else focusAt(i - 1)
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      focusAt(e.key === 'Home' ? 0 : results.length - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onOpen(entry.dn, ctrl)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onEscape()
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault()
      onContextMenu(entry, contextMenuPoint({ target: e.currentTarget }))
    }
  }
  return (
    <div className="border-b border-border max-h-[50%] overflow-auto shrink-0">
      {loading && results.length === 0 ? (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground" role="status">
          <Spinner size="sm" decorative />
          Searching the directory…
        </div>
      ) : done && results.length === 0 ? (
        <div className={cn('px-3 py-2 text-xs break-all', error ? 'text-destructive' : 'text-muted-foreground')} role="status">
          {error || 'No results found'}
        </div>
      ) : (
        <>
          {/* Wraps instead of clipping at the default sidebar width (RW1-N-05): grows with its text. */}
          <div className="flex flex-wrap items-center gap-x-1.5 px-3 py-0.5 min-h-6 text-xs text-muted-foreground tabular-nums" title={`Searched below:\n${bases.join('\n')}`} role="status">
            {loading && <Spinner size="sm" decorative />}
            <span>
              {truncated ? `First ${results.length} — more exist` : `${results.length} result${results.length !== 1 ? 's' : ''}`}
              {bases.length > 1 ? ` in ${bases.length} search bases` : ''}
            </span>
            {truncated && onOpenAll && (
              <Button size="sm" variant="link" className="ml-auto h-5" onClick={onOpenAll}>
                Open all in Search Results
              </Button>
            )}
          </div>
          <ul ref={listRef} role="listbox" aria-label="Directory search results">
            {results.map((entry, i) => {
              const objectClass = entry.attributes?.find((a) => a.name.toLowerCase() === 'objectclass')?.values || []
              // The RDN value plus the display name (else cn) when it differs — as the palette (hitLabel.ts).
              const { name, detail: displayName } = entryHitLabel(entry.dn, {
                displayName: entry.attributes?.find((a) => a.name.toLowerCase() === 'displayname')?.values?.[0],
                cn: entry.attributes?.find((a) => a.name.toLowerCase() === 'cn')?.values?.[0],
              })
              const where = parentPathLabel(entry.dn)
              return (
                <li
                  key={entry.dn}
                  role="option"
                  aria-selected={i === activeIndex}
                  tabIndex={i === activeIndex ? 0 : -1}
                  data-tree-hit=""
                  onFocus={() => setActive(i)}
                  onClick={() => {
                    setActive(i)
                    onOpen(entry.dn, false)
                  }}
                  onDoubleClick={() => onOpen(entry.dn, true)}
                  onKeyDown={(e) => onKey(e, i, entry)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setActive(i)
                    onContextMenu(entry, { clientX: e.clientX, clientY: e.clientY })
                  }}
                  className="group flex items-center gap-1.5 pl-3 pr-1 py-1 cursor-default select-none hover:bg-accent focus:bg-accent outline-hidden focus-ring-inset"
                >
                  <ObjectIcon objectClass={objectClass} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5 min-w-0">
                      <TruncatedText text={name} className="text-sm shrink-0 max-w-full" />
                      {displayName && <TruncatedText text={displayName} className="text-xs text-muted-foreground" />}
                    </span>
                    {where && <TruncatedText text={`in ${where}`} tooltip={unescapedDN(entry.dn)} className="text-xs text-muted-foreground" />}
                  </span>
                  <IconButton
                    label="Show in Tree"
                    icon={Crosshair}
                    size="sm"
                    revealOnRowHover
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation()
                      onShowInTree(entry.dn)
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                  />
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
