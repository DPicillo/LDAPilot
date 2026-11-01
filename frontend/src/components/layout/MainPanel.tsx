/**
 * Main area (SPEC 7.5, 10.2): ConnectionBanner slot, editor Tabs (ObjectIcon,
 * status dot, DN tooltip, dirty, middle-click close, "All tabs" overflow),
 * tab ContextMenu (clamped, zoom-aware), and the welcome screen (scrolls;
 * saved profiles as rows; recent entries; Ctrl+K hint).
 *
 * - Preview tabs (UX-3, editorStore): italic; the next preview open replaces
 *   it; double-click on the tab, "Keep Open" or the first edit pins it.
 * - Stale tabs: while the connection watch reports the profile lost, or
 *   after it was disconnected, its tabs carry a "not connected" glyph; they
 *   reload on restore / reconnect.
 * - Closing a tab with unsaved input asks first (editorStore.pendingDiscard,
 *   rendered here, ED-03); Close Others / All / to the Right ask once.
 * - Tabs of several connections carry a connection marker (ED-06); the tab
 *   menu has Refresh, Add/Remove Bookmark, Copy DN, Copy as LDIF and Show in
 *   Tree (switches to the tab's connection first) for entry tabs only.
 * - Session restore per profile (stores/editorSession.ts): restored tabs
 *   load when they are activated.
 * - The tab status dot uses the server's account status when it is known
 *   (accountStatusCache), else the attributes, but never a lock derived
 *   from lockoutTime alone (the DC's lockout duration decides; design
 *   test round 2, defect 3).
 * - Schema details open as tabs (schema/SchemaDetailView).
 * - Results tabs (`__results__:<n>`, components/search/resultsSnapshots,
 *   DEF-16 / DEF-22 / DEF-17): a snapshot of rows with their query and
 *   connection (Open Results as Tab, every report run, Open in List),
 *   headed by the results strip with Run Again; the panel's live results
 *   stay next to them.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { requestEditorFocus } from '../editor/editorFocus'
import {
  BarChart3,
  BookOpen,
  Clock,
  Copy,
  Crosshair,
  FileText,
  FolderTree,
  ListChecks,
  Navigation,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Server,
  Star,
  TableProperties,
  TriangleAlert,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import logoImg from '../../assets/logo.png'
import { cn } from '../../lib/utils'
import { isTabDirty, useEditorStore } from '../../stores/editorStore'
import { installEditorSession } from '../../stores/editorSession'
import { cachedAccountStatusKinds } from '../../stores/accountStatusCache'
import { useConnectionStore } from '../../stores/connectionStore'
import { bookmarkName, compareBookmarks, useBookmarkStore } from '../../stores/bookmarkStore'
import { useTreeStore, getPrimarySelectedNode, findLoadedTreeNode } from '../../stores/treeStore'
import type { LDAPEntry, TreeNode } from '../../types/ldap'
import type { EditorTab } from '../../types/ui'
import { findOwningRoot } from '../../lib/treesearch'
import { formatEntryAsLDIF } from '../../lib/ldif'
import { RECENTS_KEY, connectionMarkers, parseRecents } from '../../lib/entryEvents'
import * as wails from '../../lib/wails'
import { EntryEditor } from '../editor/EntryEditor'
import { ServerInfo } from '../connection/ServerInfo'
import { ContainerListView } from '../browser/ContainerListView'
import { SearchResults } from '../search/SearchResults'
import { ResultsStrip } from '../search/ResultsStrip'
import { ResultsSnapshotContext } from '../search/resultsView'
import { useResultsSnapshots } from '../search/resultsSnapshots'
import { isResultsTabId } from '../search/snapshotModel'
import { SchemaDetailView, parseSchemaTabId } from '../schema/SchemaDetailView'
import { Tabs, TabPanel, type TabItem } from '../ui/Tabs'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { ContextMenu, MenuItem, MenuSeparator, MenuHeader, useContextMenu } from '../ui/Menu'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { IconButton, Button } from '../ui/Button'
import { Kbd } from '../ui/Kbd'
import { ObjectIcon } from '../ui/ObjectIcon'
import { toast } from '../ui/Toast'
import { usePaletteStore } from '../ui/paletteStore'
import { deriveAccountStatus, primaryStatus, type AccountStatusKind } from '../ui/accountStatus'
import { getCommandContext, runCommand, useCommandRegistryVersion } from '../ui/commands'
import { isContainerKind, nodeKind, resolveObjectKind, OBJECT_KIND_LABEL, type ObjectKind } from '../ui/objectKind'
import { dcDomainName, parentDn, parseRdn, rdnValue, splitDn } from '../ui/dn'
import { ConnectionBanner } from './ConnectionBanner'
import { useConnectionHealth } from './useConnectionWatch'
import { ProfileList } from './ProfileList'
import { SERVER_INFO_TAB, connectProfile, openServerInfoTab, showActivity } from './shellState'

const TABS_ID = 'editor'

function objectClassOf(entry: LDAPEntry | undefined): string[] | undefined {
  return entry?.attributes.find((a) => a.name.toLowerCase() === 'objectclass')?.values
}

/**
 * Status dot of an entry tab: the server's account status when it was read
 * (EntryEditor, account commands), else the status derived from the
 * attributes, minus a lock that only rests on lockoutTime (expired lockouts
 * keep that attribute; GetEntry does not return the computed
 * msDS-User-Account-Control-Computed that would tell).
 */
function tabStatus(profileId: string, dn: string, entry: LDAPEntry | undefined): AccountStatusKind | undefined {
  const server = cachedAccountStatusKinds(profileId, dn)
  if (server) return primaryStatus(server)
  if (!entry) return undefined
  return primaryStatus(deriveAccountStatus(entry.attributes).filter((st) => !(st.kind === 'locked' && st.source.attribute === 'lockoutTime')))
}

/** Object kind of a DN without its objectClass: entry cache first, then the RDN type. */
function kindForDn(dn: string, entry: LDAPEntry | undefined): ObjectKind | undefined {
  const oc = objectClassOf(entry)
  if (oc?.length) return resolveObjectKind(oc)
  const type = parseRdn(splitDn(dn)[0] ?? '').type.toLowerCase()
  if (type === 'ou') return 'ou'
  if (type === 'dc') return 'domain'
  if (type === 'uid') return 'user'
  return undefined
}

/**
 * Show in Tree for a tab: the tree only shows the active connection, so a
 * tab of another connection switches to it first (ED-06, N-28).
 */
async function showTabInTree(tab: EditorTab) {
  const cs = useConnectionStore.getState()
  if (tab.profileId !== cs.activeProfileId) {
    await connectProfile(tab.profileId, { reveal: false })
    if (useConnectionStore.getState().activeProfileId !== tab.profileId) return
  }
  showActivity('explorer')
  await useTreeStore.getState().locateInTree(tab.profileId, tab.dn)
}

async function copyTabLdif(tab: EditorTab) {
  try {
    const entry = useEditorStore.getState().entries[tab.id] ?? (await wails.GetEntry(tab.profileId, tab.dn))
    if (!entry) throw new Error('The entry is not loaded')
    await navigator.clipboard.writeText(formatEntryAsLDIF(tab.dn, entry))
    toast.success('LDIF copied')
  } catch (err) {
    toast.error('Could not copy the LDIF', err instanceof Error ? err.message : String(err))
  }
}

/** Command context of an entry tab (its own connection, also for a tab of another one). */
function tabCommandContext(tab: EditorTab, entry: LDAPEntry | undefined) {
  return getCommandContext('tab', {
    profileId: tab.profileId,
    selection: [{ dn: tab.dn, profileId: tab.profileId, objectClass: objectClassOf(entry), label: tab.label }],
  })
}

export function MainPanel() {
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const entries = useEditorStore((s) => s.entries)
  const setActiveTab = useEditorStore((s) => s.setActiveTab)
  /** Last pointer press on the tab bar (a click activation, not the keyboard). */
  const tabPointerAt = useRef(0)
  const closeTab = useEditorStore((s) => s.closeTab)
  const closeTabs = useEditorStore((s) => s.closeTabs)
  const pinTab = useEditorStore((s) => s.pinTab)
  const pendingDiscard = useEditorStore((s) => s.pendingDiscard)
  const resolveDiscard = useEditorStore((s) => s.resolveDiscard)
  const profiles = useConnectionStore((s) => s.profiles)
  const connectionStatuses = useConnectionStore((s) => s.connectionStatuses)
  const isBookmarked = useBookmarkStore((s) => s.isBookmarked)
  useBookmarkStore((s) => s.bookmarks)
  const menu = useContextMenu<string>()
  const rootRef = useRef<HTMLDivElement>(null)
  // Account status reads (accountStatusCache) re-resolve the commands: re-render the dots too.
  const registryVersion = useCommandRegistryVersion()
  const snapshots = useResultsSnapshots((s) => s.snapshots)

  // Session save/restore per profile and stale-tab marking (connection health).
  useEffect(
    () =>
      installEditorSession((cb) =>
        useConnectionHealth.subscribe((h, prev) => cb({ status: h.status, profileId: h.profileId }, { status: prev.status, profileId: prev.profileId })),
      ),
    [],
  )

  // Restored (and other not yet loaded) entry tabs load when they are shown. A
  // tab whose load failed shows its state ("Try again") instead of failing again,
  // and nothing loads while its connection is down (ED-16).
  useEffect(() => {
    const es = useEditorStore.getState()
    const tab = es.tabs.find((t) => t.id === activeTabId)
    if (!tab?.dn || !tab.profileId || tab.state || es.entries[tab.id] || es.loadingEntries[tab.id]) return
    if (useConnectionStore.getState().connectionStatuses[tab.profileId] !== true) return
    void es.refreshEntry(tab.profileId, tab.dn)
  }, [activeTabId])

  // The last tab was closed from the keyboard (Delete, Close All): focus fell to
  // <body> with the tab bar; keep it in the main area instead.
  const hadTabs = useRef(tabs.length > 0)
  useEffect(() => {
    const had = hadTabs.current
    hadTabs.current = tabs.length > 0
    if (!had || tabs.length > 0) return
    requestAnimationFrame(() => {
      const a = document.activeElement
      const el = rootRef.current
      if ((a && a !== document.body) || !el) return
      // Focusable only for this hand-over, so clicks on empty space keep their old behaviour.
      el.tabIndex = -1
      el.addEventListener('blur', () => el.removeAttribute('tabindex'), { once: true })
      el.focus({ preventScroll: true })
    })
  }, [tabs.length])

  // Connection markers once entry tabs of more than one connection are open (ED-06).
  const markers = useMemo(() => {
    const ids = [...new Set(tabs.filter((t) => t.dn && t.profileId).map((t) => t.profileId))]
    if (ids.length < 2) return null
    return connectionMarkers(Object.fromEntries(ids.map((id) => [id, profiles.find((p) => p.id === id)?.name ?? id])))
  }, [tabs, profiles])

  const items = useMemo<TabItem[]>(
    () =>
      tabs.map((t) => {
        const preview = t.preview
        if (t.id === SERVER_INFO_TAB) return { id: t.id, label: t.label, icon: Server, title: 'Server Info (RootDSE)', preview }
        if (isResultsTabId(t.id)) {
          const snap = snapshots[t.id]
          const n = snap ? snap.results.totalCount || snap.results.entries.length : 0
          const what = snap?.kind === 'report' ? 'Report' : snap?.kind === 'list' ? 'Entries' : 'Search results'
          const profileName = snap ? (profiles.find((p) => p.id === snap.profileId)?.name ?? '') : ''
          return {
            id: t.id,
            label: t.label,
            icon: snap?.kind === 'report' ? BarChart3 : snap?.kind === 'list' ? ListChecks : TableProperties,
            title: snap ? `${what}: ${t.label} · ${n} ${n === 1 ? 'entry' : 'entries'}${profileName ? ` · ${profileName}` : ''} · as of ${new Date(snap.takenAt).toLocaleTimeString()}` : t.label,
            preview,
          }
        }
        const schema = parseSchemaTabId(t.id)
        if (schema) return { id: t.id, label: t.label, icon: BookOpen, title: `${schema.kind === 'oc' ? 'Object class' : 'Attribute type'} ${schema.name}`, preview }
        // A special tab of a kind this version no longer has: no entry marks (connection, status).
        if (!t.dn) return { id: t.id, label: t.label, title: 'No longer available', preview }
        const entry = entries[t.id]
        const objectClass = objectClassOf(entry)
        const offline = connectionStatuses[t.profileId] !== true
        const profileName = profiles.find((p) => p.id === t.profileId)?.name ?? t.profileId
        return {
          id: t.id,
          label: t.label,
          title: t.stale || offline ? `${t.dn} (not connected: the values may be out of date)` : t.dn,
          objectClass: objectClass ?? [],
          status: t.state ? undefined : tabStatus(t.profileId, t.dn, entry),
          dirty: isTabDirty(t),
          preview,
          stale: t.stale || offline,
          state: t.state?.kind,
          connection: markers?.[t.profileId] ? { marker: markers[t.profileId], name: profileName } : undefined,
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabs, entries, registryVersion, markers, profiles, connectionStatuses, snapshots],
  )

  const closeOthers = (keep: string) => closeTabs(tabs.filter((t) => t.id !== keep).map((t) => t.id))
  const closeAll = () => closeTabs(tabs.map((t) => t.id))
  const closeToRight = (id: string) => {
    const idx = tabs.findIndex((t) => t.id === id)
    if (idx >= 0) closeTabs(tabs.slice(idx + 1).map((t) => t.id))
  }

  const menuTab = menu.data ? tabs.find((t) => t.id === menu.data) : undefined
  const menuTabIdx = menuTab ? tabs.indexOf(menuTab) : -1
  const menuIsEntry = !!menuTab?.dn && !!menuTab.profileId
  const menuBookmarked = menuIsEntry && isBookmarked(menuTab!.profileId, menuTab!.dn)
  const discardTabs = pendingDiscard ? pendingDiscard.tabIds.map((id) => tabs.find((t) => t.id === id)).filter((t): t is EditorTab => !!t) : []

  return (
    <div ref={rootRef} aria-label="Editor" role="region" className="h-full flex flex-col bg-background min-w-0 focus-ring-inset">
      <ConnectionBanner />
      {tabs.length === 0 ? (
        <div className="flex-1 min-h-0">
          <TreeListViewOrWelcome />
        </div>
      ) : (
        <>
          {/* A click on a tab of a container whose Contents list kept a selection continues
              there: the row takes focus (↓ / Enter keep browsing, RW3-E-02). */}
          <div className="contents" onPointerDownCapture={() => { tabPointerAt.current = Date.now(); }}>
          <Tabs
            variant="editor"
            idPrefix={TABS_ID}
            aria-label="Open entries"
            items={items}
            value={activeTabId}
            onValueChange={(id) => {
              if (id !== activeTabId && Date.now() - tabPointerAt.current < 1000) requestEditorFocus('list');
              setActiveTab(id);
            }}
            onClose={closeTab}
            onTabContextMenu={(e, id) => menu.open(e, id)}
            onTabDoubleClick={pinTab}
            className="shrink-0"
            end={tabs.length > 1 ? <IconButton label="Close All Tabs" icon={XCircle} size="md" onClick={closeAll} /> : undefined}
          />
          </div>
          {activeTabId && (
            <TabPanel idPrefix={TABS_ID} value={activeTabId} selected={activeTabId} className="flex-1 min-h-0 overflow-hidden">
              {/* Per-tab boundary: a crashing view keeps the tab bar usable; switching tabs resets it. */}
              <ErrorBoundary key={activeTabId} variant="region" name={tabs.find((t) => t.id === activeTabId)?.label ?? 'Tab'}>
                {activeTabId === SERVER_INFO_TAB ? (
                  <ServerInfo />
                ) : isResultsTabId(activeTabId) ? (
                  <ResultsSnapshotView id={activeTabId} />
                ) : parseSchemaTabId(activeTabId) ? (
                  <SchemaDetailView tabId={activeTabId} />
                ) : tabs.some((t) => t.id === activeTabId && !t.dn) ? (
                  // A special tab of a kind this version no longer has (e.g. the old live
                  // "Search Results" mirror): a note, never an entry editor without a DN.
                  <EmptyResultsTab text="This tab is no longer available. Close it." />
                ) : (
                  <EntryEditor tabId={activeTabId} />
                )}
              </ErrorBoundary>
            </TabPanel>
          )}
        </>
      )}

      <ContextMenu point={menu.point} onClose={menu.close} label="Tab actions">
        {menuTab && (
          <>
            {menuTab.dn && <MenuHeader mono>{menuTab.dn}</MenuHeader>}
            {menuTab.dn && <MenuSeparator />}
            {menuTab.preview && <MenuItem icon={Pin} label="Keep Open" hint="Pins the preview tab" onSelect={() => pinTab(menuTab.id)} />}
            <MenuItem icon={X} label="Close" shortcut={menuTab.id === activeTabId ? 'Mod+W' : undefined} onSelect={() => closeTab(menuTab.id)} />
            <MenuItem label="Close Others" disabled={tabs.length < 2} onSelect={() => closeOthers(menuTab.id)} />
            <MenuItem label="Close to the Right" disabled={menuTabIdx < 0 || menuTabIdx >= tabs.length - 1} onSelect={() => closeToRight(menuTab.id)} />
            <MenuItem icon={XCircle} label="Close All" onSelect={closeAll} />
            {/* Entry verbs only on entry tabs (not on Server Info, schema or results tabs). */}
            {menuIsEntry && (
              <>
                <MenuSeparator />
                <MenuItem
                  icon={RefreshCw}
                  label="Refresh"
                  disabled={connectionStatuses[menuTab.profileId] !== true}
                  onSelect={() => void useEditorStore.getState().refreshEntry(menuTab.profileId, menuTab.dn)}
                />
                <MenuItem
                  icon={Star}
                  label={menuBookmarked ? 'Remove Bookmark' : 'Add Bookmark'}
                  onSelect={() => runCommand('entry.bookmark', tabCommandContext(menuTab, entries[menuTab.id]))}
                />
                <MenuItem
                  icon={Copy}
                  label="Copy DN"
                  onSelect={() => {
                    navigator.clipboard
                      .writeText(menuTab.dn)
                      .then(() => toast.success('DN copied', { connection: profiles.find((p) => p.id === menuTab.profileId)?.name }))
                      .catch((err) => toast.error('Could not copy DN', err instanceof Error ? err.message : String(err)))
                  }}
                />
                <MenuItem icon={FileText} label="Copy as LDIF" disabled={!!menuTab.state} onSelect={() => void copyTabLdif(menuTab)} />
                <MenuItem
                  icon={Crosshair}
                  label="Show in Tree"
                  hint={menuTab.profileId !== useConnectionStore.getState().activeProfileId ? 'switches the connection' : undefined}
                  disabled={menuTab.state?.kind === 'deleted' || menuTab.state?.kind === 'missing'}
                  onSelect={() => void showTabInTree(menuTab)}
                />
              </>
            )}
          </>
        )}
      </ContextMenu>
      {pendingDiscard && (
        <ConfirmDialog
          title={discardTabs.length > 1 ? 'Discard unsaved changes?' : 'Discard unsaved changes'}
          message={
            discardTabs.length > 1
              ? `Discard the unsaved changes to these ${discardTabs.length} entries?`
              : `Discard unsaved changes to ${discardTabs[0]?.label ?? 'this entry'}?`
          }
          detail={discardTabs.map((t) => t.dn || t.label)}
          confirmLabel={pendingDiscard.action === 'close' ? 'Discard and Close' : 'Discard'}
          cancelLabel="Keep Editing"
          tone="warning"
          onConfirm={() => resolveDiscard(true)}
          onCancel={() => resolveDiscard(false)}
        />
      )}
    </div>
  )
}

/** A node whose children are worth listing: a container kind, a naming-context head, or anything with children. */
function isContainerNode(node: TreeNode | undefined): boolean {
  return !!node && (node.hasChildren || isContainerKind(nodeKind(node)))
}

function TreeListViewOrWelcome() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId)
  const connected = useConnectionStore((s) => (s.activeProfileId ? s.connectionStatuses[s.activeProfileId] === true : false))
  // Subscribe to the selection and loaded children (getPrimarySelectedNode reads the store).
  useTreeStore((s) => s.selectedNodes)
  const childNodes = useTreeStore((s) => s.childNodes)
  const roots = useTreeStore((s) => (activeProfileId ? s.rootNodes[activeProfileId] : undefined))
  const selectedDN = getPrimarySelectedNode()
  // Only a container of the active connection's tree (childNodes is keyed by DN, not by profile),
  // decided by the node itself: its children need not be loaded yet (ContainerListView loads
  // them; RW2-N-03: a never-expanded Users showed the welcome screen).
  const isContainer =
    !!selectedDN && !!roots && !!findOwningRoot(roots, selectedDN) && (childNodes[selectedDN] !== undefined || isContainerNode(findLoadedTreeNode(roots, childNodes, selectedDN)))

  if (activeProfileId && connected && selectedDN && isContainer) {
    return <ContainerListView profileId={activeProfileId} containerDN={selectedDN} />
  }
  return <WelcomeScreen />
}

function QuickAction({ icon: Icon, iconClass, title, hint, onClick, kbd }: { icon: LucideIcon; iconClass: string; title: string; hint: string; onClick: () => void; kbd?: string }) {
  return (
    <button type="button" onClick={onClick}
      className="flex items-center gap-2.5 px-3 py-2.5 rounded-md bg-card border border-border text-left hover:bg-accent focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-1"
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden className={cn('shrink-0', iconClass)} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      {kbd && <Kbd shortcut={kbd} className="shrink-0" />}
    </button>
  )
}

function SectionTitle({ icon: Icon, children, id, end }: { icon: LucideIcon; children: ReactNode; id: string; end?: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 mb-1.5 min-h-6">
      <Icon size={12} strokeWidth={1.75} aria-hidden className="text-muted-foreground" />
      <h2 id={id} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {children}
      </h2>
      {end && <span className="ml-auto">{end}</span>}
    </div>
  )
}

interface EntryRow {
  dn: string
  label: string
  objectClass?: string[]
  /** A bookmark whose entry was deleted or not found (RW2-R-02). */
  stale?: boolean
}

function EntryList({ rows, labelledBy, profileId }: { rows: EntryRow[]; labelledBy: string; profileId: string }) {
  const entries = useEditorStore((s) => s.entries)
  const openEntry = useEditorStore((s) => s.openEntry)
  return (
    <ul aria-labelledby={labelledBy} className="rounded border border-border bg-card py-1">
      {rows.map((r) => {
        const kind = r.objectClass?.length ? resolveObjectKind(r.objectClass) : kindForDn(r.dn, entries[`${profileId}:${r.dn}`])
        const parent = parentDn(r.dn)
        return (
          <li key={r.dn}>
            <button type="button" title={r.stale ? `${r.dn}\nThis entry was deleted or could not be found.` : r.dn}
              aria-label={r.stale ? `${r.label}, not found` : undefined}
              onClick={() => openEntry(profileId, r.dn)}
              className="w-full flex items-center gap-2 h-7 px-3 text-left text-sm hover:bg-accent focus-ring-inset"
            >
              {r.stale ? <TriangleAlert size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-warning" /> : <ObjectIcon kind={kind ?? 'other'} />}
              <span className={cn('min-w-0 truncate', r.stale ? 'text-muted-foreground line-through' : 'text-foreground')}>{r.label}</span>
              {r.stale ? (
                <span className="text-xs text-muted-foreground shrink-0">not found</span>
              ) : (
                kind && kind !== 'other' && <span className="text-xs text-muted-foreground shrink-0">{OBJECT_KIND_LABEL[kind]}</span>
              )}
              {/* A DC-only parent by its domain, as the breadcrumb and the tree root ("in ad.ldapilot.lab", RW3-R-05). */}
              {parent && <span className="ml-auto pl-3 min-w-0 truncate text-xs text-muted-foreground">in {dcDomainName(parent) ?? rdnValue(parent)}</span>}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function readRecent(profileId: string): EntryRow[] {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(RECENTS_KEY)
  } catch {
    /* blocked storage */
  }
  return parseRecents(raw)
    .filter((r) => r.profileId === profileId)
    .slice(0, 6)
    .map((r) => ({ dn: r.dn, label: r.label || rdnValue(r.dn), objectClass: r.objectClass }))
}

/**
 * After a welcome tile showed a panel: focus its main control (the tree's tab
 * stop / the search field) unless the panel command already moved focus.
 */
function focusPanelControl(kind: 'tree' | 'search') {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const a = document.activeElement
      if (a && a !== document.body && !a.closest('[data-region="welcome"]')) return
      const sidebar = document.querySelector<HTMLElement>('[role="region"][aria-label^="Sidebar"]')
      if (!sidebar) return
      const target =
        kind === 'tree'
          ? sidebar.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ?? sidebar.querySelector<HTMLElement>('[role="tree"]')
          : (sidebar.querySelector<HTMLElement>('[data-panel="search"]:not([hidden])') ?? sidebar).querySelector<HTMLElement>('[data-panel-autofocus]')
      target?.focus()
    }),
  )
}

/** A results tab (DEF-16): its strip (source, filter, base, as of, Run Again) above its own rows. */
function ResultsSnapshotView({ id }: { id: string }) {
  const exists = useResultsSnapshots((s) => !!s.snapshots[id])
  if (!exists) return <EmptyResultsTab />
  return (
    <ResultsSnapshotContext.Provider value={id}>
      <div className="h-full flex flex-col min-w-0" data-results-tab={id}>
        <ResultsStrip />
        <div className="flex-1 min-h-0">
          <SearchResults />
        </div>
      </div>
    </ResultsSnapshotContext.Provider>
  )
}

function EmptyResultsTab({ text = 'These results are no longer available.' }: { text?: string }) {
  return (
    <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
      {text}
    </div>
  )
}

function WelcomeScreen() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId)
  const connected = useConnectionStore((s) => (s.activeProfileId ? s.connectionStatuses[s.activeProfileId] === true : false))
  const profile = useConnectionStore((s) => s.profiles.find((p) => p.id === s.activeProfileId))
  const hasProfiles = useConnectionStore((s) => s.profiles.length > 0)
  const allBookmarks = useBookmarkStore((s) => s.bookmarks)
  // Re-read the recent list whenever the tabs change (openEntry writes it).
  const tabCount = useEditorStore((s) => s.tabs.length)

  const bookmarks = useMemo(
    () =>
      activeProfileId
        ? allBookmarks
            .filter((b) => b.profileId === activeProfileId)
            // The shown name of the Bookmarks panel: the bookmark's own name, else the RDN value (DEF-24;
            // the stored label keeps "CN="); name and position keep the panel's (manual) order.
            .map((b) => ({ dn: b.dn, label: bookmarkName(b), name: b.name, order: b.order, objectClass: b.objectClass, stale: b.stale }))
            // Missing / deleted ones last, marked (RW2-R-02); one order with the panel (RW3-R-02).
            .sort(compareBookmarks)
        : [],
    [allBookmarks, activeProfileId],
  )
  const recent = useMemo(() => (activeProfileId && connected ? readRecent(activeProfileId) : []), [activeProfileId, connected, tabCount])

  return (
    <div className="h-full overflow-auto bg-background" data-region="welcome">
      <div className="min-h-full flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full max-w-[560px] flex flex-col gap-6">
          <header className="flex items-center gap-3">
            <img src={logoImg} alt="" className="size-12 rounded-xl shrink-0" />
            <div className="min-w-0">
              <h1 className="text-2xl font-light tracking-wide text-foreground">LDAPilot</h1>
              <p className="text-sm text-muted-foreground">
                {connected && profile ? (
                  <>
                    Connected to <span className="text-foreground font-medium">{profile.name}</span>
                  </>
                ) : (
                  'LDAP and Active Directory browser and editor'
                )}
              </p>
            </div>
          </header>

          {!connected ? (
            <section aria-labelledby="welcome-connections">
              <SectionTitle
                icon={Server}
                id="welcome-connections"
                end={
                  <Button size="sm" variant="ghost" leftIcon={Plus} onClick={() => runCommand('connection.new')}>
                    New Connection…
                  </Button>
                }
              >
                Connections
              </SectionTitle>
              {hasProfiles ? (
                <>
                  <ProfileList maxRows={8} aria-label="Saved connections" />
                  <p className="text-xs text-muted-foreground mt-1.5">Double-click a connection, or select it and press Enter.</p>
                </>
              ) : (
                <div className="rounded border border-border bg-card px-3 py-3 text-sm text-muted-foreground">
                  No saved connections yet. Create one to browse a directory.
                </div>
              )}
            </section>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <QuickAction
                  icon={FolderTree}
                  iconClass="text-oc-ou"
                  title="Browse Tree"
                  hint="Explore the directory"
                  onClick={() => {
                    if (!runCommand('view.explorer')) showActivity('explorer')
                    focusPanelControl('tree')
                  }}
                />
                <QuickAction
                  icon={Search}
                  iconClass="text-primary"
                  title="Search"
                  hint="Find entries by filter"
                  onClick={() => {
                    if (!runCommand('view.search')) showActivity('search')
                    focusPanelControl('search')
                  }}
                />
                <QuickAction
                  icon={Navigation}
                  iconClass="text-info"
                  title="Go to Anything"
                  hint="Name, DN or LDAP URL"
                  kbd="Mod+K"
                  onClick={() => usePaletteStore.getState().openPalette()}
                />
                <QuickAction icon={Server} iconClass="text-oc-contact" title="Server Info" hint="RootDSE and capabilities" onClick={openServerInfoTab} />
              </div>

              {bookmarks.length > 0 && activeProfileId && (
                <section>
                  <SectionTitle
                    icon={Star}
                    id="welcome-bookmarks"
                    end={
                      bookmarks.length > 5 ? (
                        <Button size="sm" variant="link" onClick={() => showActivity('bookmarks')}>
                          Show all {bookmarks.length}
                        </Button>
                      ) : undefined
                    }
                  >
                    Bookmarks
                  </SectionTitle>
                  <EntryList rows={bookmarks.slice(0, 5)} labelledBy="welcome-bookmarks" profileId={activeProfileId} />
                </section>
              )}

              {recent.length > 0 && activeProfileId && (
                <section>
                  <SectionTitle icon={Clock} id="welcome-recent">
                    Recent
                  </SectionTitle>
                  <EntryList rows={recent} labelledBy="welcome-recent" profileId={activeProfileId} />
                </section>
              )}
            </>
          )}

          <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Kbd shortcut="Mod+K" /> Go to anything
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd shortcut="Mod+G" /> Go to DN
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd shortcut="Mod+/" /> Shortcuts
            </span>
            {/* F5 refreshes the tree of a connection; without one it does nothing (RW2-C-06). */}
            {connected && (
              <span className="inline-flex items-center gap-1.5">
                <Kbd shortcut="F5" /> Refresh
              </span>
            )}
          </p>
        </div>
      </div>
    </div>
  )
}
