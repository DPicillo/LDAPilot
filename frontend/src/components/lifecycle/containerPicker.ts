/**
 * Pure helpers of the ContainerPicker (target containers of Move…, batch
 * move, Copy Entry, New Entry and Restore to…): which tree nodes are
 * containers, the type-ahead filter, recent targets per connection and the
 * checks of a typed target. Imports only `.ts` modules (node tests).
 */
import { getParentDN, isDNAtOrBelow, normalizeDN, parseRDN, firstRDN } from '../../lib/dn.ts'

/** Minimal tree node shape (types/ldap.ts TreeNode). */
export interface PickerNode {
  dn: string
  rdn?: string
  hasChildren: boolean
  objectClass: string[]
}

/** Object classes that hold other entries (OU, container, domain, organisation, …). */
const CONTAINER_CLASSES = new Set([
  'organizationalunit', 'organization', 'container', 'builtindomain', 'domain', 'domaindns', 'dcobject',
  'lostandfound', 'nscontainer', 'organizationalrole', 'country', 'locality', 'msexchsystemobjectscontainer',
])
/** Leaf-like object classes: never offered as a target even when they have children. */
const NON_CONTAINER_CLASSES = new Set([
  'user', 'person', 'inetorgperson', 'computer', 'group', 'groupofnames', 'groupofuniquenames', 'posixgroup',
  'contact', 'posixaccount', 'foreignsecurityprincipal', 'attributeschema', 'classschema',
])

/**
 * Whether a tree node is offered as a target container: container classes
 * (also empty ones: an empty OU is a fine target), or any other node with
 * children that is not a user/group/computer/contact.
 */
export function isContainerNode(node: PickerNode): boolean {
  const oc = node.objectClass.map((c) => c.toLowerCase())
  if (oc.some((c) => CONTAINER_CLASSES.has(c))) return !oc.some((c) => c === 'user' || c === 'computer' || c === 'group')
  if (oc.some((c) => NON_CONTAINER_CLASSES.has(c))) return false
  return node.hasChildren
}

/** Display name of a DN: its unescaped first RDN value ("OU=Sales\, EU,…" → "Sales, EU"). */
export function containerName(dn: string): string {
  const rdn = firstRDN(dn)
  return rdn ? parseRDN(rdn).value || rdn : dn
}

/** Case-insensitive type-ahead match on the name or the DN. */
export function matchesContainerFilter(dn: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return containerName(dn).toLowerCase().includes(q) || dn.toLowerCase().includes(q)
}

/**
 * Why `target` cannot take the entries `moving` (empty when it can): no
 * target, one of the entries, or below one of them. A target equal to every
 * entry's current parent is reported as `sameParent` (nothing would change).
 */
export function targetProblem(target: string, moving: readonly string[]): '' | 'empty' | 'self' | 'below' | 'sameParent' {
  const t = target.trim()
  if (!t) return 'empty'
  for (const dn of moving) {
    if (normalizeDN(dn) === normalizeDN(t)) return 'self'
    if (isDNAtOrBelow(t, dn)) return 'below'
  }
  if (moving.length > 0 && moving.every((dn) => normalizeDN(getParentDN(dn)) === normalizeDN(t))) return 'sameParent'
  return ''
}

export const TARGET_PROBLEM_TEXT: Record<Exclude<ReturnType<typeof targetProblem>, ''>, string> = {
  empty: 'Choose a target container.',
  self: 'The target is one of the entries to move.',
  below: 'The target lies below one of the entries to move.',
  sameParent: 'The entries are already in this container.',
}

/** The text of a target problem for `count` entries to move ("The entry is …" for one, M-13). */
export function targetProblemText(problem: Exclude<ReturnType<typeof targetProblem>, ''>, count: number): string {
  if (count !== 1) return TARGET_PROBLEM_TEXT[problem]
  switch (problem) {
    case 'self':
      return 'The target is the entry to move.'
    case 'below':
      return 'The target lies below the entry to move.'
    case 'sameParent':
      return 'The entry is already in this container.'
    default:
      return TARGET_PROBLEM_TEXT[problem]
  }
}

/** A DN typed by hand looks like a DN (attr=value[,…]); the server decides whether it exists. */
export function looksLikeDN(text: string): boolean {
  const t = text.trim()
  return /^[A-Za-z][\w.-]*\s*=\s*\S/.test(t)
}

// --- Recent targets (per connection, localStorage) ---

export const RECENT_TARGETS_MAX = 8
const RECENT_KEY = 'ldapilot.lifecycle.recentTargets.'

/** Minimal Storage shape (window.localStorage, or a test double). */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function storageOrNull(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Recent target containers of a connection, most recent first. */
export function loadRecentTargets(profileId: string, storage: KeyValueStorage | null = storageOrNull()): string[] {
  if (!storage) return []
  try {
    const raw = JSON.parse(storage.getItem(RECENT_KEY + profileId) ?? '[]')
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '').slice(0, RECENT_TARGETS_MAX) : []
  } catch {
    return []
  }
}

/** Puts dn first in the recent targets (case-insensitive DN match), at most 8. */
export function withRecentTarget(list: readonly string[], dn: string): string[] {
  const key = normalizeDN(dn)
  return [dn.trim(), ...list.filter((d) => normalizeDN(d) !== key)].slice(0, RECENT_TARGETS_MAX)
}

/** Records dn as the most recent target of the connection. */
export function rememberTarget(profileId: string, dn: string, storage: KeyValueStorage | null = storageOrNull()) {
  if (!storage || !dn.trim()) return
  try {
    storage.setItem(RECENT_KEY + profileId, JSON.stringify(withRecentTarget(loadRecentTargets(profileId, storage), dn)))
  } catch {
    /* private window / quota: recents are a convenience */
  }
}

/** Removes a recent target that no longer exists. */
export function forgetTarget(profileId: string, dn: string, storage: KeyValueStorage | null = storageOrNull()) {
  if (!storage) return
  try {
    const key = normalizeDN(dn)
    storage.setItem(RECENT_KEY + profileId, JSON.stringify(loadRecentTargets(profileId, storage).filter((d) => normalizeDN(d) !== key)))
  } catch {
    /* ignore */
  }
}

/**
 * The DNs from a tree root down to `dn` (root first, dn last) when dn lies at
 * or below one of the roots; [] otherwise. Used to expand the picker to the
 * current container.
 */
export function pathFromRoot(dn: string, roots: readonly string[]): string[] {
  const root = roots
    .filter((r) => isDNAtOrBelow(dn, r))
    .sort((a, b) => b.length - a.length)[0]
  if (!root) return []
  const chain: string[] = []
  let cur = dn
  for (let guard = 0; guard < 64 && cur; guard++) {
    chain.unshift(cur)
    if (normalizeDN(cur) === normalizeDN(root)) return chain
    cur = getParentDN(cur)
  }
  return []
}

/**
 * The recent targets worth offering as chips (M-12): not the current parent of
 * an entry being moved ("already there"), not a moved entry or anything below
 * it, and none that is known not to exist (a container deleted since).
 */
export function offeredRecentTargets(recent: readonly string[], moving: readonly string[] | undefined, missing: ReadonlySet<string>): string[] {
  const parents = new Set((moving ?? []).map((d) => normalizeDN(getParentDN(d))))
  return recent.filter((dn) => {
    const key = normalizeDN(dn)
    if (missing.has(key) || parents.has(key)) return false
    return !(moving ?? []).some((m) => isDNAtOrBelow(dn, m))
  })
}
