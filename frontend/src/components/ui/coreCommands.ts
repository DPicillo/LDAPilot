/**
 * The core command set: the per-type action sets of SPEC 6.5 plus the
 * shell commands (navigate / view / connection / help). Registered once by
 * AppLayout (registerCoreCommands()).
 *
 * Verbs whose implementation belongs to a feature track are registered here
 * WITHOUT a handler (visible, disabled) — the track attaches it with
 * registerCommandHandlers({ 'account.unlock': … }). Handler-less ids:
 *   account.unlock, account.resetPassword, account.toggleEnabled,
 *   membership.addToGroup, membership.addMembers, membership.showEffective,
 *   create.user/group/ou/computer/contact/entry, entry.statistics,
 *   entry.rename, entry.move, entry.compareWith, entry.compare2,
 *   entry.exportSelection, entry.delete
 *
 * Wording (TRIAGE §0.2): "Show in Tree", "Reset Password…", "Delete n
 * Entries…", "Add Bookmark" / "Remove Bookmark"; one name per view (View
 * menu = activity bar tooltip = panel header, commands/panelTable.ts).
 */
import {
  ArrowDownUp,
  BarChart3,
  Bot,
  BookOpen,
  Copy,
  Download,
  FileText,
  FolderInput,
  FolderPlus,
  FolderTree,
  GitCompareArrows,
  Globe,
  KeyRound,
  Keyboard,
  LayoutPanelLeft,
  LockOpen,
  Monitor,
  Moon,
  PanelBottom,
  PencilLine,
  Plug,
  Plus,
  Power,
  RefreshCw,
  Search,
  Star,
  Sun,
  SunMoon,
  Trash2,
  Unplug,
  Upload,
  User,
  UserPlus,
  Users,
  Contact,
  Palette as PaletteIcon,
  ZoomIn,
  ZoomOut,
  Navigation,
  ArrowLeft,
  ArrowRight,
  Server,
  ScrollText,
  History,
  TableProperties,
  LayoutGrid,
  Rows3,
  ArrowRightLeft,
  ListTree,
  Undo2,
} from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { useEditorStore } from '../../stores/editorStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { isSameBookmark, useBookmarkStore } from '../../stores/bookmarkStore'
// Stable bookmark ids: listeners start with the core commands (RW3-R-01).
import '../bookmarks/bookmarkSync'
import { useTreeStore } from '../../stores/treeStore'
import * as wails from '../../lib/wails'
import { formatEntryAsLDIF } from '../../lib/ldif'
import type { Activity } from '../../types/ui'
import { openImportLDIF } from '../../stores/bulkDialogStore'
import { ExportDialog } from '../export/ExportDialog'
import { ConnectionDialog } from '../connection/ConnectionDialog'
import { connectProfile } from '../layout/shellState'
import { PANELS } from '../commands/panelTable'
import { createParent, createsSibling, refreshTarget } from '../commands/targets'
import { focusActiveEditorSoon, requestEditorFocus } from '../editor/editorFocus'
import { showPanel } from '../commands/panels'
import { KeyboardShortcutsDialog } from './KeyboardShortcuts'
import { toast } from './Toast'
import { useDialogStore } from './Dialog'
import { usePaletteStore } from './paletteStore'
import { panelDomId, tabDomId } from './Tabs'
import { THEME_OPTIONS, DENSITY_OPTIONS } from './theme'
import { isContainerKind, type ObjectKind } from './objectKind'
import { parentDn, rdnValue } from './dnParse'
import { allKinds, foreignDn, hasStatus, isKind, kindOf, many, notifyCommandsChanged, one, registerCommands, type Command, type CommandContext } from './commands'
import { latestUndo, registerUndo, runUndo, subscribeUndo, undoButton } from './undo'

const LEAF_OPENABLE: ObjectKind[] = ['user', 'group', 'computer', 'contact', 'service', 'other']
const CONTAINERS: ObjectKind[] = ['ou', 'container', 'domain']

const single = one
const container = (ctx: CommandContext) => one(ctx) && isContainerKind(kindOf(ctx))
const connected = (ctx: CommandContext) => ctx.connected && !!ctx.profileId
const dnOf = (ctx: CommandContext) => ctx.selection[0]?.dn ?? ''
const bulkSection = (normal: string) => (ctx: CommandContext) => (many(ctx) ? 'bulk' : normal)
/** A naming-context head is selected (never renamed, moved or copied). */
export const ncHeadSelected = (ctx: CommandContext) => ctx.selection.some((s) => !!s.ncHead)

export { createParent, refreshTarget }

/**
 * View ▸ Results / Operations / Audit Log: shows the tab and focuses its
 * filter field (else the tab itself), never the tab that was selected before
 * (RW1-N-06: Enter / Space there switched back).
 */
function showLogTab(tab: 'search-results' | 'output' | 'audit') {
  useUIStore.getState().showBottomTab(tab)
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const panel = document.getElementById(panelDomId('bottom', tab))
      const target = panel?.querySelector<HTMLElement>('input[aria-label^="Filter"]:not([disabled])') ?? document.getElementById(tabDomId('bottom', tab))
      target?.focus({ preventScroll: true })
    }),
  )
}

/** F5 / Refresh: refreshTarget, knowing whether the editor area shows a tab (no tab = the welcome screen: Refresh Tree). */
const f5Target = (ctx: CommandContext) => refreshTarget(ctx, { tabOpen: !!useEditorStore.getState().activeTabId })

/** Reloads the tree: the roots and every expanded container (the tree store's own refresh when it has one). */
export async function refreshTree(profileId: string) {
  const ts = useTreeStore.getState() as ReturnType<typeof useTreeStore.getState> & { refreshTree?: (id: string) => Promise<void> }
  if (typeof ts.refreshTree === 'function') return ts.refreshTree(profileId)
  await ts.loadRootNodes(profileId)
  const after = useTreeStore.getState()
  await Promise.all([...after.expandedNodes].filter((dn) => after.childNodes[dn]).map((dn) => after.refreshNode(profileId, dn).catch(() => {})))
}

/**
 * Bookmarks dn (or removes it) with an Undo toast — the one bookmark toggle of every surface (Ctrl+D, menus, palette, editor).
 * The Undo also runs from the bell and with Ctrl+Z (ui/undo.ts, RW3-N-04).
 */
export function toggleBookmark(profileId: string, dn: string, objectClass?: string[]) {
  const bs = useBookmarkStore.getState()
  const name = rdnValue(dn) || dn
  if (bs.isBookmarked(profileId, dn)) {
    const removed = bs.bookmarks.filter((b) => isSameBookmark(b, profileId, dn))
    bs.removeBookmark(profileId, dn)
    const undo = registerUndo({ label: 'Remove Bookmark', profileId, run: () => useBookmarkStore.getState().restoreBookmarks(removed) })
    toast.success(`Bookmark removed: ${name}`, { action: undoButton(undo) })
  } else {
    bs.addBookmark(profileId, dn, objectClass)
    const undo = registerUndo({ label: 'Add Bookmark', profileId, run: () => useBookmarkStore.getState().removeBookmark(profileId, dn) })
    toast.success(`Bookmarked ${name}`, { action: undoButton(undo) })
  }
}

/** Edit ▸ Undo / Ctrl+Z: the newest undo of the active connection (a move, a bookmark change). */
function runLatestUndo(ctx: CommandContext) {
  const u = latestUndo(ctx.profileId)
  if (u) void runUndo(u.id)
}

function isBookmarked(ctx: CommandContext): boolean {
  return !!ctx.profileId && useBookmarkStore.getState().isBookmarked(ctx.profileId, dnOf(ctx))
}

/** Activates the editor tab `delta` places from the active one (Ctrl+Tab / Ctrl+Shift+Tab, wraps around). */
function cycleTab(delta: number) {
  const es = useEditorStore.getState()
  if (es.tabs.length < 2) return
  const i = es.tabs.findIndex((t) => t.id === es.activeTabId)
  const next = es.tabs[(((i < 0 ? 0 : i) + delta) % es.tabs.length + es.tabs.length) % es.tabs.length]
  es.setActiveTab(next.id)
}

/** Ctrl+1–8: the n-th editor tab; Ctrl+9: the last tab (as in browsers). Hidden from menus and the palette. */
function tabByIndexCommands(): Command[] {
  return Array.from({ length: 9 }, (_, i): Command => ({
    id: `view.tab${i + 1}`,
    title: i === 8 ? 'Go to Last Tab' : `Go to Tab ${i + 1}`,
    group: 'view',
    section: 'tabs',
    shortcut: `Mod+${i + 1}`,
    menu: false,
    palette: false,
    run: () => {
      const es = useEditorStore.getState()
      if (!es.tabs.length) return
      if (i === 8) es.setActiveTab(es.tabs[es.tabs.length - 1].id)
      else if (i < es.tabs.length) es.setActiveTab(es.tabs[i].id)
    },
  }))
}

/** Copies text; `connection` names the entry's connection in the bell (an entry of another one, RW1-C-08). */
async function copyText(text: string, what: string, connection?: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`, connection ? { connection } : undefined)
  } catch (err) {
    toast.error(`Could not copy ${what}`, err instanceof Error ? err.message : String(err))
  }
}

function entryCommands(): Command[] {
  return [
    // --- open ---------------------------------------------------------------
    {
      id: 'entry.compare2',
      // Opens a dialog, like the single-entry "Compare With…".
      title: 'Compare…',
      icon: GitCompareArrows,
      group: 'entry',
      section: 'compare2',
      when: (ctx) => ctx.selection.length === 2,
      keywords: ['diff'],
    },
    {
      id: 'entry.open',
      title: (ctx) => (container(ctx) ? 'Open Contents' : 'Open'),
      group: 'entry',
      section: 'open',
      order: 1,
      shortcut: 'Enter',
      displayOnly: true,
      isDefault: true,
      // Context menus of lists (tree, Contents, results): the Entry menu and the editor's
      // More actions act on the open tab, where "Open" would do nothing.
      when: (ctx) => single(ctx) && ctx.source !== 'menubar' && ctx.source !== 'tab',
      // The preview tab (Enter); "Open in New Tab" pins (Ctrl+Enter).
      run: (ctx) => {
        if (ctx.profileId) useEditorStore.getState().openEntry(ctx.profileId, dnOf(ctx), { preview: true })
      },
      palette: false,
    },
    {
      id: 'entry.openNewTab',
      title: 'Open in New Tab',
      group: 'entry',
      section: 'open',
      order: 2,
      shortcut: 'Mod+Enter',
      displayOnly: true,
      when: (ctx) => single(ctx) && ctx.source !== 'menubar' && ctx.source !== 'tab',
      run: (ctx) => {
        if (ctx.profileId) useEditorStore.getState().openEntry(ctx.profileId, dnOf(ctx))
      },
      palette: false,
    },
    // --- account (users, computers, service accounts) -------------------------
    {
      id: 'account.unlock',
      title: 'Unlock Account',
      icon: LockOpen,
      group: 'account',
      section: 'account',
      order: 1,
      write: true,
      when: (ctx) => isKind(ctx, 'user') && hasStatus(ctx, 'locked'),
      // A menu that showed "Checking account status…" keeps the slot, saying why (RW3-P-04).
      goneReason: 'Not locked',
      keywords: ['lockout', 'locked'],
    },
    {
      id: 'account.resetPassword',
      title: 'Reset Password…',
      icon: KeyRound,
      group: 'account',
      section: 'account',
      order: 2,
      write: true,
      when: (ctx) => isKind(ctx, 'user'),
      keywords: ['password', 'change'],
    },
    {
      id: 'account.toggleEnabled',
      title: (ctx) => (many(ctx) ? 'Enable/Disable…' : ctx.selection[0]?.status?.includes('disabled') ? 'Enable Account' : 'Disable Account'),
      icon: Power,
      group: 'account',
      section: bulkSection('account'),
      order: 3,
      write: true,
      when: (ctx) => allKinds(ctx, 'user', 'computer', 'service'),
      keywords: ['enable', 'disable', 'userAccountControl'],
    },
    {
      id: 'membership.addToGroup',
      title: 'Add to Group…',
      icon: UserPlus,
      group: 'membership',
      section: bulkSection('account'),
      order: 4,
      write: true,
      when: (ctx) => allKinds(ctx, 'user', 'computer', 'service', 'contact', 'group'),
      keywords: ['member', 'group', 'nesting'],
    },
    // --- membership (groups) ------------------------------------------------
    {
      id: 'membership.addMembers',
      title: 'Add Members…',
      icon: UserPlus,
      group: 'membership',
      section: 'membership',
      order: 1,
      write: true,
      when: (ctx) => isKind(ctx, 'group'),
    },
    {
      id: 'membership.showEffective',
      title: 'Show Effective Members',
      icon: Users,
      group: 'membership',
      section: 'membership',
      order: 2,
      when: (ctx) => isKind(ctx, 'group'),
      keywords: ['nested', 'recursive', 'transitive'],
    },
    // --- create (containers; a leaf creates a sibling, Contents its container) --
    {
      id: 'create.new',
      title: (ctx) => (createsSibling(ctx) ? `New in ${rdnValue(createParent(ctx) ?? '') || 'Parent'}` : 'New'),
      icon: Plus,
      group: 'create',
      section: 'create',
      submenu: true,
      write: true,
      when: (ctx) => createParent(ctx) !== null,
    },
    { id: 'create.user', title: 'User…', icon: User, group: 'create', parent: 'create.new', order: 1, write: true, when: (ctx) => createParent(ctx) !== null, keywords: ['new user'] },
    { id: 'create.group', title: 'Group…', icon: Users, group: 'create', parent: 'create.new', order: 2, write: true, when: (ctx) => createParent(ctx) !== null, keywords: ['new group'] },
    { id: 'create.ou', title: 'Organizational Unit…', icon: FolderPlus, group: 'create', parent: 'create.new', order: 3, write: true, when: (ctx) => createParent(ctx) !== null, keywords: ['new ou'] },
    { id: 'create.computer', title: 'Computer…', icon: Monitor, group: 'create', parent: 'create.new', order: 4, write: true, when: (ctx) => createParent(ctx) !== null, keywords: ['new computer'] },
    { id: 'create.contact', title: 'Contact…', icon: Contact, group: 'create', parent: 'create.new', order: 5, write: true, when: (ctx) => createParent(ctx) !== null, keywords: ['new contact'] },
    {
      id: 'create.entry',
      title: 'Other Entry…',
      icon: FileText,
      group: 'create',
      parent: 'create.new',
      order: 6,
      shortcut: 'Mod+N',
      write: true,
      when: (ctx) => createParent(ctx) !== null,
      keywords: ['new entry', 'child', 'custom'],
    },
    // --- manage (containers) ------------------------------------------------
    { id: 'entry.statistics', title: 'Statistics…', icon: BarChart3, group: 'entry', section: 'manage', order: 1, when: container },
    {
      id: 'entry.exportSubtree',
      title: 'Export Subtree…',
      icon: Download,
      group: 'entry',
      section: 'manage',
      order: 2,
      when: container,
      run: (ctx) => {
        useDialogStore.getState().open(ExportDialog, { dn: dnOf(ctx), profileId: ctx.profileId ?? undefined })
      },
      keywords: ['ldif', 'csv'],
    },
    {
      id: 'entry.refresh',
      title: (ctx) => (f5Target(ctx).kind === 'tree' ? 'Refresh Tree' : 'Refresh'),
      icon: RefreshCw,
      group: 'entry',
      section: 'manage',
      order: 3,
      shortcut: 'F5',
      global: true,
      // One entry (SPEC 7.3 Entry menu): containers reload their children, open tabs their
      // attributes. F5 inside an editor tab acts on that tab (dispatcher source 'tab'), in a
      // Contents list on its rows or, with none selected, the list; with nothing selected and
      // no tab, F5 reloads the tree.
      when: (ctx) => {
        const target = f5Target(ctx)
        // A tab of another connection reloads on its own connection (RW2-C-01).
        if (target.kind === 'foreign') return useConnectionStore.getState().connectionStatuses[target.profileId] === true
        return connected(ctx) && target.kind !== 'none'
      },
      run: (ctx) => {
        const target = f5Target(ctx)
        if (target.kind === 'foreign') {
          void useEditorStore.getState().refreshEntry(target.profileId, target.dn, { silent: true })
          return
        }
        if (!ctx.profileId) return
        const profileId = ctx.profileId
        if (target.kind === 'none') return
        if (target.kind === 'tree') {
          void refreshTree(profileId).catch(() => {})
          return
        }
        const ts = useTreeStore.getState()
        const dn = target.dn
        // A container: its list and the expanded containers below it (RW1-N-04).
        if (target.kind === 'container' || container(ctx)) void ts.refreshSubtree(profileId, dn).catch(() => {})
        else {
          // A leaf: reload the listing it is shown in (name, icon), when that is loaded.
          const parent = parentDn(dn)
          if (parent && ts.childNodes[parent]) void ts.refreshNode(profileId, parent).catch(() => {})
        }
        const es = useEditorStore.getState()
        if (es.tabs.some((t) => t.id === `${profileId}:${dn}`)) void es.refreshEntry(profileId, dn, { silent: true })
      },
    },
    {
      id: 'tree.refresh',
      title: 'Refresh Tree',
      icon: ListTree,
      group: 'navigate',
      section: 'navigate',
      order: 6,
      menu: false,
      // Not twice in the palette: with nothing selected entry.refresh is "Refresh Tree" (F5) already.
      when: (ctx) => connected(ctx) && f5Target(ctx).kind !== 'tree',
      run: (ctx) => {
        if (ctx.profileId) void refreshTree(ctx.profileId).catch(() => {})
      },
      keywords: ['reload', 'tree'],
    },
    // --- edit ---------------------------------------------------------------
    // Naming-context heads (domain root, Configuration, Schema, suffixes) are never renamed or moved.
    { id: 'entry.rename', title: 'Rename…', icon: PencilLine, group: 'entry', section: 'edit', order: 1, shortcut: 'F2', write: true, when: (ctx) => single(ctx) && !ncHeadSelected(ctx) },
    {
      id: 'entry.move',
      title: (ctx) => (many(ctx) ? `Move ${ctx.selection.length} Entries…` : 'Move…'),
      icon: FolderInput,
      group: 'entry',
      section: bulkSection('edit'),
      order: 5,
      write: true,
      when: (ctx) => ctx.selection.length >= 1 && !ncHeadSelected(ctx),
    },
    {
      id: 'entry.exportSelection',
      title: (ctx) => `Export ${ctx.selection.length} Entries…`,
      icon: Download,
      group: 'entry',
      section: 'bulk',
      order: 6,
      when: many,
      keywords: ['ldif'],
    },
    {
      id: 'entry.copyDn',
      title: 'Copy DN',
      icon: Copy,
      group: 'entry',
      section: 'edit',
      order: 10,
      shortcut: 'Shift+Alt+C',
      // Also for a tab of another connection: copying its DN reads nothing.
      when: (ctx) => single(ctx) || !!foreignDn(ctx),
      run: (ctx) => copyText(dnOf(ctx) || foreignDn(ctx), 'DN', dnOf(ctx) ? undefined : ctx.foreign?.name),
      keywords: ['distinguished name', 'clipboard'],
    },
    {
      id: 'entry.copyLdif',
      title: 'Copy as LDIF',
      icon: FileText,
      group: 'entry',
      section: 'edit',
      order: 11,
      // Read-only clipboard output: every kind.
      when: (ctx) => single(ctx) && connected(ctx),
      run: async (ctx) => {
        if (!ctx.profileId) return
        try {
          const entry = await wails.GetEntry(ctx.profileId, dnOf(ctx))
          if (!entry) throw new Error('Entry not found')
          await copyText(formatEntryAsLDIF(entry.dn || dnOf(ctx), entry), 'LDIF')
        } catch (err) {
          toast.error('Could not read the entry', err instanceof Error ? err.message : String(err))
        }
      },
    },
    {
      id: 'entry.bookmark',
      title: (ctx) => (isBookmarked(ctx) ? 'Remove Bookmark' : 'Add Bookmark'),
      icon: Star,
      group: 'entry',
      section: 'edit',
      order: 12,
      shortcut: 'Mod+D',
      when: (ctx) => single(ctx) && !!ctx.profileId,
      run: (ctx) => {
        if (ctx.profileId) toggleBookmark(ctx.profileId, dnOf(ctx), ctx.selection[0]?.objectClass)
      },
      keywords: ['favorite', 'star', 'bookmark'],
    },
    { id: 'entry.compareWith', title: 'Compare With…', icon: GitCompareArrows, group: 'entry', section: 'edit', order: 13, when: single, keywords: ['diff'] },
    // --- danger -------------------------------------------------------------
    {
      id: 'entry.delete',
      title: (ctx) => (many(ctx) ? `Delete ${ctx.selection.length} Entries…` : 'Delete…'),
      icon: Trash2,
      group: 'entry',
      section: 'danger',
      shortcut: 'Delete',
      danger: true,
      write: true,
      when: (ctx) => ctx.selection.length >= 1,
      keywords: ['remove'],
    },
  ]
}

function shellCommands(): Command[] {
  const ui = () => useUIStore.getState()
  const PANEL_ICONS: Record<Activity, Command['icon']> = {
    connections: Plug,
    explorer: FolderTree,
    search: Search,
    reports: BarChart3,
    bookmarks: Star,
    schema: BookOpen,
    export: ArrowDownUp,
    ai: Bot,
  }
  // One name and shortcut per panel (panelTable.ts); showing a panel focuses its main control.
  const views = PANELS.map(
    (p, i): Command => ({
      id: p.command,
      title: p.label,
      icon: PANEL_ICONS[p.activity],
      group: 'view',
      section: 'panels',
      order: i + 1,
      shortcut: p.shortcut,
      run: () => showPanel(p.activity),
      keywords: p.keywords,
    }),
  )
  const isConnected = (ctx: CommandContext) => connected(ctx)
  return [
    // --- edit ---------------------------------------------------------------
    {
      // RW3-N-04: the last move (or bookmark change) of this connection, from anywhere but a
      // text field (Ctrl+Z there stays the field's own undo: blocksInEditable).
      id: 'edit.undo',
      title: (ctx) => {
        const u = latestUndo(ctx.profileId)
        return u ? `Undo ${u.label}` : 'Undo'
      },
      icon: Undo2,
      // Not an entry verb: never in the entry context menus (Edit menu, palette, Ctrl+Z).
      group: 'navigate',
      section: 'history',
      order: -1,
      shortcut: 'Mod+Z',
      enabled: (ctx) => !!latestUndo(ctx.profileId),
      disabledReason: () => 'Nothing to undo',
      run: runLatestUndo,
      keywords: ['undo', 'revert', 'move back', 'restore bookmark'],
    },
    // --- navigate -----------------------------------------------------------
    {
      id: 'palette.open',
      title: 'Go to Anything…',
      icon: Navigation,
      group: 'navigate',
      section: 'palette',
      shortcut: 'Mod+K',
      run: () => usePaletteStore.getState().openPalette(),
      palette: false,
      keywords: ['find', 'dn', 'search'],
    },
    {
      id: 'palette.commands',
      title: 'Show All Commands',
      icon: PaletteIcon,
      group: 'navigate',
      section: 'palette',
      shortcut: 'Mod+Shift+P',
      run: () => usePaletteStore.getState().openPalette({ scope: 'actions' }),
      palette: false,
    },
    {
      // The palette in DN mode: a DN or an ldap:// URL (RFC 4516, parsed by ui/dn.ts) jumps directly.
      id: 'navigate.gotoDn',
      title: 'Go to DN…',
      icon: Navigation,
      group: 'navigate',
      section: 'navigate',
      shortcut: 'Mod+G',
      run: () => usePaletteStore.getState().openPalette({ scope: 'dn' }),
      keywords: ['dn', 'ldap url', 'distinguished name'],
    },
    {
      id: 'navigate.back',
      title: 'Back',
      icon: ArrowLeft,
      group: 'navigate',
      section: 'history',
      shortcut: 'Alt+Left',
      enabled: () => useEditorStore.getState().canGoBack(),
      run: () => {
        // The keyboard stays in the editor, as with the Go Back button (RW1-E-04).
        requestEditorFocus('crumb')
        useEditorStore.getState().goBack()
      },
    },
    {
      id: 'navigate.forward',
      title: 'Forward',
      icon: ArrowRight,
      group: 'navigate',
      section: 'history',
      shortcut: 'Alt+Right',
      enabled: () => useEditorStore.getState().canGoForward(),
      run: () => {
        requestEditorFocus('crumb')
        useEditorStore.getState().goForward()
      },
    },
    // --- view: panels --------------------------------------------------------
    ...views,
    {
      id: 'view.serverInfo',
      title: 'Server Info (RootDSE)',
      icon: Server,
      group: 'view',
      section: 'panels',
      order: 9,
      when: isConnected,
      run: () => {
        const es = useEditorStore.getState()
        es.addSpecialTab('__server-info__', 'Server Info')
        es.setActiveTab('__server-info__')
      },
    },
    // --- view: layout -------------------------------------------------------
    { id: 'view.sidebar', title: 'Toggle Sidebar', icon: LayoutPanelLeft, group: 'view', section: 'layout', shortcut: 'Mod+B', run: () => ui().toggleSidebar() },
    { id: 'view.panel', title: 'Toggle Panel', icon: PanelBottom, group: 'view', section: 'layout', shortcut: 'Mod+J', run: () => ui().toggleBottomPanel() },
    // Same names as the bottom panel's tabs (Results / Operations / Audit Log).
    { id: 'view.results', title: 'Results', icon: TableProperties, group: 'view', section: 'logs', run: () => showLogTab('search-results'), keywords: ['search results', 'panel'] },
    { id: 'view.operations', title: 'Operations', icon: ScrollText, group: 'view', section: 'logs', run: () => showLogTab('output'), keywords: ['operations log', 'ldap log', 'panel'] },
    { id: 'view.audit', title: 'Audit Log', icon: History, group: 'view', section: 'logs', run: () => showLogTab('audit'), keywords: ['history', 'changes', 'panel'] },
    // --- view: theme / density / zoom ---------------------------------------
    ...THEME_OPTIONS.map(
      (o, i): Command => ({
        id: `view.theme.${o.value}`,
        title: `Theme: ${o.label}`,
        icon: o.value === 'system' ? SunMoon : o.value === 'dark' ? Moon : Sun,
        group: 'view',
        section: 'theme',
        order: i,
        checked: () => ui().themePref === o.value,
        run: () => ui().setThemePref(o.value),
        keywords: ['appearance', 'color', 'colour'],
      }),
    ),
    ...DENSITY_OPTIONS.map(
      (o, i): Command => ({
        id: `view.density.${o.value}`,
        title: `Density: ${o.label}`,
        icon: o.value === 'compact' ? Rows3 : LayoutGrid,
        group: 'view',
        section: 'density',
        order: i,
        checked: () => ui().density === o.value,
        run: () => ui().setDensity(o.value),
        keywords: ['row height', 'spacing'],
      }),
    ),
    { id: 'view.zoomIn', title: 'Zoom In', icon: ZoomIn, group: 'view', section: 'zoom', shortcut: 'Mod+=', run: () => ui().zoomIn() },
    { id: 'view.zoomOut', title: 'Zoom Out', icon: ZoomOut, group: 'view', section: 'zoom', shortcut: 'Mod+-', run: () => ui().zoomOut() },
    { id: 'view.zoomReset', title: 'Reset Zoom', group: 'view', section: 'zoom', shortcut: 'Mod+0', run: () => ui().zoomReset() },
    // --- tabs ---------------------------------------------------------------
    {
      id: 'view.closeTab',
      title: 'Close Tab',
      group: 'view',
      section: 'tabs',
      shortcut: 'Mod+W',
      enabled: () => !!useEditorStore.getState().activeTabId,
      run: () => {
        const es = useEditorStore.getState()
        if (es.activeTabId) es.closeTab(es.activeTabId)
      },
    },
    {
      id: 'view.closeAllTabs',
      title: 'Close All Tabs',
      group: 'view',
      section: 'tabs',
      enabled: () => useEditorStore.getState().tabs.length > 0,
      run: () => {
        // One "Discard unsaved changes?" question for all dirty tabs (ED-03).
        const es = useEditorStore.getState()
        es.closeTabs(es.tabs.map((t) => t.id))
      },
    },
    {
      id: 'view.singleClickPreview',
      title: 'Single-Click Opens Preview',
      group: 'view',
      section: 'tabs',
      toggle: true,
      checked: () => ui().singleClickPreview,
      run: () => ui().setSingleClickPreview(!ui().singleClickPreview),
      keywords: ['preview tab', 'tree click', 'italic'],
    },
    { id: 'view.nextTab', title: 'Next Tab', group: 'view', section: 'tabs', shortcut: 'Ctrl+Tab', menu: false, palette: false, run: () => cycleTab(1) },
    { id: 'view.prevTab', title: 'Previous Tab', group: 'view', section: 'tabs', shortcut: 'Ctrl+Shift+Tab', menu: false, palette: false, run: () => cycleTab(-1) },
    ...tabByIndexCommands(),
    // --- connection -----------------------------------------------------------
    {
      // Every "New Connection…" (File, palette, welcome screen, Explorer empty state via runCommand) opens the dialog.
      id: 'connection.new',
      title: 'New Connection…',
      icon: Plus,
      group: 'connection',
      section: 'connection',
      run: () => {
        useDialogStore.getState().open(ConnectionDialog, { onSave: useConnectionStore.getState().saveProfile })
      },
      keywords: ['add connection', 'profile', 'server'],
    },
    {
      // Menus of entries of another connection ("Switch to <profile>"): ctx.foreign names it.
      id: 'connection.switchTo',
      title: (ctx) => (ctx.foreign ? `Switch to ${ctx.foreign.name}` : 'Switch Connection'),
      icon: ArrowRightLeft,
      group: 'connection',
      section: 'connection',
      menu: false,
      // Also in the palette: "switch" on a tab of another connection (RW2-N-05).
      when: (ctx) => !!ctx.foreign,
      keywords: ['switch', 'connection', 'connect'],
      run: (ctx) => {
        // Focus stays in the editor (the menu item and the banner button are gone, RW2-N-06).
        if (ctx.foreign) void connectProfile(ctx.foreign.profileId, { reveal: false }).then(focusActiveEditorSoon)
      },
    },
    {
      id: 'connection.reconnect',
      title: 'Reconnect',
      icon: RefreshCw,
      group: 'connection',
      section: 'connection',
      when: (ctx) => !!ctx.profileId,
      enabled: () => !useConnectionStore.getState().loading,
      run: (ctx) => {
        if (ctx.profileId) useConnectionStore.getState().reconnect(ctx.profileId).catch(() => {})
      },
    },
    {
      id: 'connection.disconnect',
      title: 'Disconnect',
      icon: Unplug,
      group: 'connection',
      section: 'connection',
      when: isConnected,
      run: (ctx) => {
        if (ctx.profileId) void useConnectionStore.getState().disconnect(ctx.profileId)
      },
    },
    {
      id: 'file.importLdif',
      // Read-only connections open it for dry runs (Apply disabled with the reason: SRCH-17).
      title: (ctx) => (ctx.readOnly ? 'Check LDIF (Dry Run)…' : 'Import LDIF…'),
      icon: Upload,
      group: 'connection',
      section: 'transfer',
      when: isConnected,
      // LDIF content and change records (add/modify/delete/modrdn) with dry run,
      // hosted by BulkDialogHost so a running import survives layout changes.
      run: () => openImportLDIF(),
      keywords: ['ldif', 'change file', 'changetype', 'restore'],
    },
    {
      id: 'file.export',
      title: 'Export…',
      icon: Download,
      group: 'connection',
      section: 'transfer',
      when: isConnected,
      run: (ctx) => {
        useDialogStore.getState().open(ExportDialog, { dn: ctx.selection[0]?.dn })
      },
      keywords: ['ldif', 'csv'],
    },
    // --- help ---------------------------------------------------------------
    {
      id: 'help.shortcuts',
      title: 'Keyboard Shortcuts',
      icon: Keyboard,
      group: 'help',
      section: 'help',
      // Ctrl+? (Shift+/) kept from the old shortcut hook.
      shortcut: ['Mod+/', 'Mod+Shift+?'],
      run: () => {
        useDialogStore.getState().open(KeyboardShortcutsDialog)
      },
      keywords: ['keys', 'hotkeys', 'keyboard'],
    },
    {
      id: 'help.github',
      title: 'GitHub Repository',
      icon: Globe,
      group: 'help',
      section: 'help',
      run: () => (window as unknown as { runtime?: { BrowserOpenURL?: (u: string) => void } }).runtime?.BrowserOpenURL?.('https://github.com/DPicillo/LDAPilot'),
    },
    ...(import.meta.env.DEV
      ? [
          {
            id: 'help.uiGallery',
            title: 'Developer: UI Gallery',
            icon: LayoutGrid,
            group: 'help',
            section: 'dev',
            run: () => {
              const url = new URL(window.location.href)
              url.searchParams.set('ui-gallery', '')
              window.location.href = url.toString()
            },
          } satisfies Command,
        ]
      : []),
  ]
}

/** Registers the core commands; returns the disposer (AppLayout effect). */
export function registerCoreCommands(): () => void {
  const off = registerCommands([...entryCommands(), ...shellCommands()])
  // "Undo …" titles and their enabled state follow the undo registry.
  const offUndo = subscribeUndo(notifyCommandsChanged)
  return () => {
    offUndo()
    off()
  }
}

export { LEAF_OPENABLE, CONTAINERS }
