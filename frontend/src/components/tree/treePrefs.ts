/**
 * Tree view preferences shared by DirectoryTree, TreeNodeRow, the
 * ContainerListView and the tree commands (View ▸ Show RDN Type, Edit ▸ Find
 * in Tree): sort mode, RDN type prefix, the filter focus request, plus the
 * one name comparator and type order, so the tree and the list sort the same
 * way (SPEC 10.2: "Tree and list sort consistently").
 *
 * Per-viewer conveniences in localStorage (every access in try/catch).
 */
import { create } from 'zustand'
import type { TreeNode } from '../../types/ldap'
import { firstRDN, parseRDN } from '../../lib/dn'
import { contextHeadLabel } from '../../lib/treesearch'
import { nodeKind, type ObjectKind } from '../ui/objectKind'

export type TreeSortMode = 'default' | 'alpha' | 'type'

/**
 * Default: by name, as ADUC / LDAP browsers do, so a new child lands in its
 * place instead of at the end (OpenLDAP's server order is creation order).
 * A stored choice (also "Server order") is kept.
 */
export const DEFAULT_SORT_MODE: TreeSortMode = 'alpha'

export const SORT_MODE_LABELS: Record<TreeSortMode, string> = {
  default: 'Server order',
  alpha: 'Name (A–Z)',
  type: 'Type, then name',
}

const SORT_KEY = 'ldapilot-tree-sort'
const RDN_TYPE_KEY = 'ldapilot-tree-rdn-type'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* blocked storage: the setting lasts for this session */
  }
}

function loadSortMode(): TreeSortMode {
  const v = read(SORT_KEY)
  return v === 'alpha' || v === 'type' || v === 'default' ? v : DEFAULT_SORT_MODE
}

interface TreePrefsState {
  sortMode: TreeSortMode
  /** Show "CN=" / "OU=" before the names (View ▸ Show RDN Type, default off). */
  showRdnType: boolean
  /** Incremented by "Find in Tree" (Ctrl+F): the tree opens and focuses its filter. */
  filterRequest: number
  setSortMode: (mode: TreeSortMode) => void
  toggleRdnType: () => void
  requestFilterFocus: () => void
}

export const useTreePrefs = create<TreePrefsState>((set, get) => ({
  sortMode: loadSortMode(),
  showRdnType: read(RDN_TYPE_KEY) === '1',
  filterRequest: 0,
  setSortMode: (mode) => {
    write(SORT_KEY, mode)
    set({ sortMode: mode })
  },
  toggleRdnType: () => {
    const next = !get().showRdnType
    write(RDN_TYPE_KEY, next ? '1' : '0')
    set({ showRdnType: next })
  },
  requestFilterFocus: () => set((s) => ({ filterRequest: s.filterRequest + 1 })),
}))

// One collator (localeCompare with options builds one per call).
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Same options as DataTable's comparator, so the tree and the list agree. */
export function compareNames(a: string, b: string): number {
  return nameCollator.compare(a, b)
}

/** "By type" order: containers first, then groups, accounts, contacts, the rest. */
const KIND_ORDER: Record<ObjectKind, number> = {
  domain: 0,
  ou: 1,
  container: 2,
  group: 3,
  user: 4,
  computer: 5,
  service: 6,
  contact: 7,
  other: 8,
}

export function kindOrder(kind: ObjectKind): number {
  return KIND_ORDER[kind] ?? 9
}

/** Is the node a naming-context root / injected NC head (its RDN is the whole DN)? */
export function isContextHead(node: TreeNode): boolean {
  return !node.rdn || node.rdn === node.dn
}

/**
 * Display name of a node: the RDN value ("Test Locked"), or with the type
 * prefix ("CN=Test Locked"). Naming-context heads and roots get a short name
 * ("ad.ldapilot.lab", "Configuration", "Schema", TREE-08; the row's tooltip
 * shows the DN); with the RDN type shown they keep the full DN.
 */
export function nodeLabel(node: TreeNode, showRdnType: boolean): string {
  if (isContextHead(node)) return showRdnType ? node.dn : contextHeadLabel(node.dn)
  if (showRdnType) return node.rdn
  return parseRDN(firstRDN(node.dn)).value || node.rdn
}

/** Sort key for the name. */
function nameKey(node: TreeNode): string {
  return isContextHead(node) ? contextHeadLabel(node.dn) : parseRDN(firstRDN(node.dn)).value || node.rdn || node.dn
}

// Sorted copies per list and mode: flattening re-runs on every expand/select,
// and big containers (Schema: 1,769 entries) should not be re-sorted each time.
const sortCache: Record<Exclude<TreeSortMode, 'default'>, WeakMap<TreeNode[], TreeNode[]>> = {
  alpha: new WeakMap(),
  type: new WeakMap(),
}

/** Sorts a sibling list by the mode; 'default' keeps the server order (same array). */
export function sortTreeNodes(nodes: TreeNode[], mode: TreeSortMode): TreeNode[] {
  if (mode === 'default' || nodes.length <= 1) return nodes
  const cached = sortCache[mode].get(nodes)
  if (cached) return cached
  // Keys once per node (unescaping per comparison made big lists slow).
  const keyed = nodes.map((node) => ({ node, name: nameKey(node), kind: mode === 'type' ? kindOrder(nodeKind(node)) : 0 }))
  keyed.sort((a, b) => a.kind - b.kind || compareNames(a.name, b.name))
  const sorted = keyed.map((k) => k.node)
  sortCache[mode].set(nodes, sorted)
  return sorted
}

/** Sortable value "NN name" for a Type column (numeric-aware compare keeps the type order, then the name). */
export function typeSortValue(node: TreeNode): string {
  return `${String(kindOrder(nodeKind(node))).padStart(2, '0')} ${nameKey(node)}`
}

/** The list's name value (same key as the tree's name sort). */
export function nameSortValue(node: TreeNode): string {
  return nameKey(node)
}
