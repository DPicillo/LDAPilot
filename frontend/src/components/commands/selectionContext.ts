/**
 * Selections the command registry acts on (ui/commands.ts providers).
 *
 * - 'tree': the tree's (multi-)selection of the active connection.
 * - 'results': the checked search results, else the highlighted row, on the
 *   results' own connection (rows of another connection are dropped by the
 *   registry).
 * - 'list': the selected rows of the Contents list the user last worked in
 *   (the standalone list and the embedded Contents sub-tabs); with nothing
 *   selected, its container is ctx.containerDN (Ctrl+N / New ▸, F5).
 * - 'menubar' / 'palette' / 'editor': the most recent selection wins.
 *   Selecting nodes in the tree, rows in the results or in a Contents list
 *   (or clicking or focusing those regions) makes the Entry menu, the
 *   palette's actions and the global shortcuts outside a region (Ctrl+N,
 *   Ctrl+D, Shift+Alt+C; source 'editor') follow that selection; activating
 *   an editor tab, or clicking or focusing the editor, makes them follow the
 *   tab again. Without a tree/results/list selection they act on the active
 *   tab (the design default).
 * - Focus that an overlay hands back when it closes (ui/layer restoreFocus:
 *   the palette, a menu) never changes the source: Ctrl+K from the tree that
 *   opens an entry leaves the opened tab current.
 * - Items carry the account status when the server status is cached
 *   (accountStatusCache); a tree row adds the states its one-level read
 *   proved (disabled / expired) as evidence. The refiner completes every
 *   item the registry sees (objectClass of loaded tree nodes, naming-context
 *   heads, the attributes an LDAP person has for the contact rule).
 *
 * The tree, the results and the Contents list mark their root with
 * data-command-scope, so the registry dispatches plain-key shortcuts (F2,
 * Del) there with these selections.
 */
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { useSearchStore } from '../../stores/searchStore'
import { useSearchSelectionStore } from '../../stores/searchSelectionStore'
import { useTreeStore } from '../../stores/treeStore'
import { cachedAccountStatusKinds } from '../../stores/accountStatusCache'
import { normalizeDN } from '../../lib/dn'
import type { TreeNode } from '../../types/ldap'
import { activeTabSelection, registerContainerProvider, registerSelectionProvider, registerSelectionRefiner, type SelectionItem } from '../ui/commands'
import { isFocusRestore } from '../ui/layer'
import { kindNeedsAttributes } from '../ui/objectKind'
import { deriveRowStatus } from '../ui/accountStatus'
import { createListRegistry, createSourceTracker, type SelectionSource as Source } from './selectionSource'
import { isNamingContextHead } from './namingContexts'
import { prefetchPresence, presentAttributes } from './presence'

const source = createSourceTracker('tab')
/** Highlighted row of the search results (SearchResults reports it). */
let resultsFocus: string | null = null

/** The search results' highlighted row (keyboard / click), for 'results' commands. */
export function setResultsFocus(dn: string | null) {
  if (dn === resultsFocus) return
  resultsFocus = dn
  if (dn) source.set('results')
}

// --- Contents lists ---------------------------------------------------------------------

export interface ListView {
  profileId: string
  containerDN: string
  /** The selected rows (none: nothing selected). */
  selection: () => SelectionItem[]
}

const lists = createListRegistry<ListView>()

/**
 * A Contents list registers itself while mounted. `activate` (focus or click
 * inside it) makes it the list the 'list' source means; `selected` (a
 * non-empty selection change) also makes it the most recent selection.
 */
export function registerListView(id: string, view: ListView): { dispose: () => void; activate: () => void; selected: () => void } {
  const dispose = lists.add(id, view)
  return {
    dispose,
    activate: () => lists.activate(id),
    selected: () => {
      lists.activate(id)
      source.set('list')
    },
  }
}

function listSelection(): SelectionItem[] {
  try {
    return lists.active()?.selection() ?? []
  } catch {
    return []
  }
}

function listContainer(): string | undefined {
  const v = lists.active()
  return v && v.profileId === useConnectionStore.getState().activeProfileId ? v.containerDN : undefined
}

// --- Tree index -------------------------------------------------------------------------

let index: { profileId: string; roots: unknown; children: unknown; map: Map<string, TreeNode> } | null = null

/** The loaded tree nodes of a profile by normalized DN (rebuilt when the tree changes). */
function treeIndex(profileId: string): Map<string, TreeNode> {
  const ts = useTreeStore.getState()
  const roots = ts.rootNodes[profileId]
  if (index && index.profileId === profileId && index.roots === roots && index.children === ts.childNodes) return index.map
  const map = new Map<string, TreeNode>()
  const visit = (nodes: TreeNode[] | undefined) => {
    for (const n of nodes ?? []) {
      map.set(normalizeDN(n.dn), n)
      if (n.children) visit(n.children)
    }
  }
  visit(roots)
  // childNodes is keyed by DN only: the active profile's lists.
  if (profileId === useConnectionStore.getState().activeProfileId) for (const list of Object.values(ts.childNodes)) visit(list)
  index = { profileId, roots, children: ts.childNodes, map }
  return map
}

/**
 * Completes an item from the tree, the RootDSE, open tabs and presence reads.
 * The presence read (one per entry) only runs when the item is the whole
 * selection: a multi-selection of hundreds of rows never fans out reads.
 */
function refine(item: SelectionItem, profileId: string | null, opts: { single?: boolean } = {}): SelectionItem {
  if (!profileId) return item
  let out = item
  const node =
    !item.objectClass || item.status === undefined || (item.presentAttributes === undefined && kindNeedsAttributes(item.objectClass))
      ? treeIndex(profileId).get(normalizeDN(item.dn))
      : undefined
  if (!out.objectClass?.length && node?.objectClass?.length) out = { ...out, objectClass: node.objectClass }
  // The one-level read proves 'disabled' / 'expired' (evidence; the server status wins when cached).
  if (out.status === undefined && node?.status?.length) out = { ...out, status: [...node.status] }
  if (out.ncHead === undefined && isNamingContextHead(profileId, out.dn)) out = { ...out, ncHead: true }
  // The listing's login attributes (M-06): a contact's first menu already shows contact verbs.
  if (out.presentAttributes === undefined && Array.isArray(node?.loginAttributes) && kindNeedsAttributes(out.objectClass)) {
    out = { ...out, presentAttributes: [...node!.loginAttributes!] }
  }
  if (out.presentAttributes === undefined && kindNeedsAttributes(out.objectClass)) {
    const entry = useEditorStore.getState().entries[`${profileId}:${out.dn}`]
    if (entry) out = { ...out, presentAttributes: entry.attributes.map((a) => a.name) }
    else {
      const p = presentAttributes(profileId, out.dn)
      if (Array.isArray(p)) out = { ...out, presentAttributes: p }
      else if (p === undefined && opts.single !== false && useConnectionStore.getState().connectionStatuses[profileId] === true) prefetchPresence(profileId, out.dn)
    }
  }
  return out
}

// --- Providers --------------------------------------------------------------------------

export function treeSelection(): SelectionItem[] {
  const profileId = useConnectionStore.getState().activeProfileId
  const selected = useTreeStore.getState().selectedNodes
  if (!profileId || selected.size === 0) return []
  return [...selected].map((dn) => ({ dn, profileId, status: cachedAccountStatusKinds(profileId, dn) }))
}

export function resultsSelection(): SelectionItem[] {
  const ss = useSearchStore.getState()
  const results = ss.results
  if (!results) return []
  const profileId = ss.resultsProfileId ?? useConnectionStore.getState().activeProfileId ?? undefined
  const sel = useSearchSelectionStore.getState()
  const checked = sel.results === results ? sel.checked : null
  const dns = checked && checked.size > 0 ? [...checked] : resultsFocus ? [resultsFocus] : []
  if (!dns.length) return []
  const byDn = new Map(results.entries.map((e) => [e.dn.toLowerCase(), e]))
  return dns.map((dn) => {
    const e = byDn.get(dn.toLowerCase())
    const oc = e?.attributes.find((a) => a.name.toLowerCase() === 'objectclass')?.values
    // The server status when cached; else the states the row's attributes
    // prove (a Locked-Out report row: "locked" at once). A missing state is
    // no evidence: the search returned only the attributes it asked for.
    const server = cachedAccountStatusKinds(profileId, dn)
    const evidence = e ? deriveRowStatus(e.attributes).map((s) => s.kind) : undefined
    return { dn, profileId: profileId ?? undefined, objectClass: oc, status: server ?? (evidence?.length ? evidence : undefined) }
  })
}

/** Menubar / palette / global shortcuts: the most recent selection, else the active tab. */
function currentSelection(): SelectionItem[] {
  const last = source.current()
  if (last === 'tree') {
    const items = treeSelection()
    if (items.length) return items
  } else if (last === 'results') {
    const items = resultsSelection()
    if (items.length) return items
  } else if (last === 'list') {
    const items = listSelection()
    if (items.length) return items
  }
  // The active tab, unfiltered: a tab of another connection must reach the
  // registry so it can set ctx.foreign ("Switch to <profile>", Copy DN) instead
  // of looking like "no entry open" (RW1-N-02, RW1-E-07).
  return activeTabSelection()
}

/** The Contents list's container when it is the most recent source. */
function currentContainer(): string | undefined {
  return source.current() === 'list' ? listContainer() : undefined
}

/** Registers the providers and the "most recent selection" tracking. Returns a disposer. */
export function registerSelectionContext(): () => void {
  const offs = [
    registerSelectionRefiner(refine),
    registerSelectionProvider('tree', treeSelection),
    registerSelectionProvider('results', resultsSelection),
    registerSelectionProvider('list', listSelection),
    registerContainerProvider('list', listContainer),
    registerSelectionProvider('menubar', currentSelection),
    registerSelectionProvider('palette', currentSelection),
    // The shortcut dispatcher's source outside any [data-command-scope]: the
    // same target as the menubar that displays those shortcuts.
    registerSelectionProvider('editor', currentSelection),
    registerContainerProvider('menubar', currentContainer),
    registerContainerProvider('palette', currentContainer),
    registerContainerProvider('editor', currentContainer),
    useTreeStore.subscribe((s, prev) => {
      if (s.selectedNodes !== prev.selectedNodes && s.selectedNodes.size > 0) source.set('tree')
    }),
    useEditorStore.subscribe((s, prev) => {
      if (s.activeTabId !== prev.activeTabId && s.activeTabId) source.set('tab')
    }),
    useSearchSelectionStore.subscribe((s, prev) => {
      if (s.checked !== prev.checked && s.checked.size > 0) source.set('results')
    }),
  ]
  // Clicking or focusing a region (mouse or Tab) makes its selection current;
  // the editor area (MainPanel, role=region "Editor") makes the active tab
  // current. Focus restored by a closing overlay is not the user's choice.
  const sourceOf = (t: EventTarget | null): Source | null => {
    if (!(t instanceof Element)) return null
    const scope = t.closest<HTMLElement>('[data-command-scope]')?.dataset.commandScope
    if (scope === 'tree' || scope === 'results' || scope === 'list') return scope
    if (t.closest('[role="region"][aria-label="Editor"]')) return 'tab'
    return null
  }
  const onFocusIn = (e: FocusEvent) => source.focus(sourceOf(e.target), isFocusRestore())
  // A click on a non-focusable part (editor body) or on the already focused
  // row fires no focusin.
  const onPointerDown = (e: PointerEvent) => source.focus(sourceOf(e.target))
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('pointerdown', onPointerDown, true)
  return () => {
    offs.forEach((off) => off())
    document.removeEventListener('focusin', onFocusIn)
    document.removeEventListener('pointerdown', onPointerDown, true)
    source.reset()
  }
}
