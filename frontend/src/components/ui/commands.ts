/**
 * Command registry (SPEC 6.2, 6.5). ONE source for the menubar, context
 * menus, the command palette and the shortcut list.
 *
 * Tracks extend the shell ONLY through this module:
 *
 *   // add or replace commands (same id = override; the disposer restores)
 *   useEffect(() => registerCommands([{ id: 'reports.run', title: 'Run Report…', group: 'view', run: … }]), [])
 *
 *   // give a placeholder verb of the per-type sets its handler
 *   useEffect(() => registerCommandHandlers({ 'account.unlock': (ctx) => unlock(ctx.selection[0].dn) }), [])
 *
 *   // tell the registry what a focused region has selected
 *   useEffect(() => registerSelectionProvider('tree', () => selectedNodes.map(…)), [])
 *
 * A command without a handler stays visible but disabled ("items are
 * disabled until a track registers their handler", SPEC 7.3).
 *
 * Profiles: handlers act on `ctx.profileId` (the active connection). The
 * registry guarantees that every `ctx.selection` item belongs to it: items
 * whose `profileId` names another profile are dropped (an editor tab of
 * connection A stays open while the user switches to B: the Entry menu then
 * offers no entry actions instead of running A's DN against B).
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ServerInfo, ServerType } from '../../types/ldap'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import * as wails from '../../lib/wails'
import type { IconType } from './Button'
import { isContainerKind, resolveObjectKind, type ObjectKind } from './objectKind'
import { deriveAccountStatus, type AccountStatusKind } from './accountStatus'
import { blocksInEditable, dispatcherSkips, formatShortcut, isEditableTarget, isPlainKey, isReloadKey, matchShortcut, parseShortcut, type ParsedShortcut } from './shortcuts'

export { formatShortcut } from './shortcuts'

export type CommandGroup = 'navigate' | 'entry' | 'account' | 'membership' | 'create' | 'view' | 'connection' | 'help'
export type CommandSource = 'tree' | 'list' | 'results' | 'tab' | 'editor' | 'palette' | 'menubar'

export const COMMAND_GROUPS: { id: CommandGroup; label: string }[] = [
  { id: 'navigate', label: 'Navigate' },
  { id: 'entry', label: 'Entry' },
  { id: 'account', label: 'Account' },
  { id: 'membership', label: 'Membership' },
  { id: 'create', label: 'New' },
  { id: 'view', label: 'View' },
  { id: 'connection', label: 'Connection' },
  { id: 'help', label: 'Help' },
]

/**
 * Menu section order (a separator is drawn between sections). Entry menus
 * follow SPEC 6.5: open · account/membership · create · manage · edit · danger.
 */
export const SECTION_ORDER = [
  'compare2',
  'open',
  'account',
  'membership',
  'bulk',
  'create',
  'manage',
  'edit',
  'danger',
  'palette',
  'navigate',
  'history',
  'panels',
  'layout',
  'logs',
  'theme',
  'density',
  'zoom',
  'tabs',
  'connection',
  'transfer',
  'help',
  'dev',
]

export interface SelectionItem {
  dn: string
  /** Profile the DN belongs to. Items of another profile than the active one are dropped from the context. */
  profileId?: string
  objectClass?: string[]
  kind?: ObjectKind
  /**
   * Account states. From the server (accountStatusCache) the list is
   * complete; from attributes (a search hit, a tree row) it is evidence of the
   * states it names only: a missing 'locked' does not mean "not locked".
   */
  status?: AccountStatusKind[]
  /** Display name, when known. */
  label?: string
  /** A naming-context head (domain root, Configuration, Schema, DNS zones, OpenLDAP suffix): a container that is never renamed, moved or copied. */
  ncHead?: boolean
  /**
   * Names of the attributes the entry is known to have (a loaded entry or a
   * presence read). Undefined = unknown. Used by the kind rules
   * (resolveObjectKind: an LDAP person without uid / userPassword is a contact).
   */
  presentAttributes?: string[]
}

export interface CommandContext {
  profileId: string | null
  serverType: ServerType | null
  connected: boolean
  readOnly: boolean
  selection: SelectionItem[]
  source: CommandSource
  /**
   * The container a surface shows when nothing in it is selected (the
   * Contents list): Ctrl+N / New ▸ create there, F5 reloads it.
   */
  containerDN?: string
  /**
   * The surface's entries belong to another connection than the active one
   * (they were dropped from `selection`): menus offer "Switch to <name>".
   */
  foreign?: { profileId: string; name: string; count: number; dns?: string[] }
  /** Title of the menu or palette item the command was chosen from (handlers compare it with the server state). */
  shownTitle?: string
  /**
   * The context's connection was lost (connection watch): write verbs are
   * hidden like on a read-only connection until it is back (RW2-C-02).
   */
  offline?: boolean
}

/** Tells whether a connected profile was lost (set by the connection watch; avoids an import cycle). */
let offlineProvider: ((profileId: string) => boolean) | null = null
export function setOfflineProvider(fn: (profileId: string) => boolean): void {
  offlineProvider = fn
}
/** Write verbs are hidden: a read-only or lost connection. */
const writesHidden = (ctx: CommandContext) => ctx.readOnly || !!ctx.offline

export interface Command {
  id: string
  title: string | ((ctx: CommandContext) => string)
  icon?: IconType
  group: CommandGroup
  /** One or more shortcut strings ('Mod+K'); the first is displayed. */
  shortcut?: string | string[]
  /** Shortcut is handled elsewhere (a focused widget: Enter in lists, Ctrl+F in the tree); only displayed. */
  displayOnly?: boolean
  /**
   * Plain-key shortcut (a function key such as F5) that is dispatched
   * everywhere, also outside a [data-command-scope] region and in text
   * fields. Other plain keys (F2, Del) only act inside a region.
   */
  global?: boolean
  /** Visibility. */
  when?: (ctx: CommandContext) => boolean
  /** Enabled state of a visible command (default: has a handler). */
  enabled?: (ctx: CommandContext) => boolean
  run?: (ctx: CommandContext) => void | Promise<void>
  danger?: boolean
  keywords?: string[]
  /** Write verb: hidden on read-only connections (menus show a "Read-only connection" header). */
  write?: boolean
  /** The bold default verb of a context menu. */
  isDefault?: boolean | ((ctx: CommandContext) => boolean)
  /** Menu section (separators between sections). Default: the group. */
  section?: string | ((ctx: CommandContext) => string)
  /** Order inside its section (default: registration order). */
  order?: number
  /** Id of the submenu command this one belongs to. */
  parent?: string
  /** This command is a submenu ("New ▸"): it has children and no run. */
  submenu?: boolean
  /** Radio/check state for menus and the palette ("Theme: Dark"). */
  checked?: (ctx: CommandContext) => boolean
  /** An on/off setting (checkbox): the palette shows "On" / "Off" instead of "Current". */
  toggle?: boolean
  /** Why a visible command is disabled ("Active Directory only"): menus and the palette show it. */
  disabledReason?: (ctx: CommandContext) => string | undefined
  /**
   * Shown on the disabled item an open menu keeps in place after the command
   * stopped applying ("Checking account status…" → "Unlock Account · Not
   * locked", RW3-P-04).
   */
  goneReason?: string
  /**
   * Keep the title an open menu showed first (the account verbs: a status
   * read that arrives while the menu is open must not rename the item under
   * the pointer). The handler gets that title as `ctx.shownTitle`.
   */
  stableTitle?: boolean
  /** Hide from the palette / from menus. */
  palette?: boolean
  menu?: boolean
}

export type CommandHandler = (ctx: CommandContext) => void | Promise<void>

// --- Store --------------------------------------------------------------------

const defs = new Map<string, Command[]>()
const handlers = new Map<string, CommandHandler[]>()
const regOrder = new Map<string, number>()
let regCounter = 0
let version = 0
const listeners = new Set<() => void>()

function emit() {
  version++
  listeners.forEach((l) => l())
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Registers commands; a command with an existing id overrides it. Returns a disposer. */
export function registerCommands(cmds: Command[]): () => void {
  for (const c of cmds) {
    const s = defs.get(c.id) ?? []
    s.push(c)
    defs.set(c.id, s)
    if (!regOrder.has(c.id)) regOrder.set(c.id, regCounter++)
  }
  emit()
  return () => {
    for (const c of cmds) {
      const s = defs.get(c.id)
      if (!s) continue
      const i = s.lastIndexOf(c)
      if (i >= 0) s.splice(i, 1)
      if (!s.length) defs.delete(c.id)
    }
    emit()
  }
}

/** Attaches handlers to registered (or later registered) command ids. Returns a disposer. */
export function registerCommandHandlers(map: Record<string, CommandHandler>): () => void {
  const entries = Object.entries(map)
  for (const [id, fn] of entries) {
    const s = handlers.get(id) ?? []
    s.push(fn)
    handlers.set(id, s)
  }
  emit()
  return () => {
    for (const [id, fn] of entries) {
      const s = handlers.get(id)
      if (!s) continue
      const i = s.lastIndexOf(fn)
      if (i >= 0) s.splice(i, 1)
      if (!s.length) handlers.delete(id)
    }
    emit()
  }
}

/** The effective command (latest definition + latest handler). */
export function getCommand(id: string): Command | undefined {
  const s = defs.get(id)
  if (!s || !s.length) return undefined
  const c = s[s.length - 1]
  const h = handlers.get(id)
  return h && h.length ? { ...c, run: h[h.length - 1] } : c
}

export function getCommands(): Command[] {
  return [...defs.keys()].map((id) => getCommand(id)!).filter(Boolean)
}

/** Re-resolves every surface (menubar, palette): a when()/title() input outside the stores changed (account status cache). */
export function notifyCommandsChanged() {
  emit()
}

/** Re-renders when commands, handlers or the server-type cache change. */
export function useCommandRegistryVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version)
}

// --- Context ------------------------------------------------------------------

const selectionProviders = new Map<CommandSource, (() => SelectionItem[])[]>()
const containerProviders = new Map<CommandSource, (() => string | undefined)[]>()
/** `single`: the item is the whole selection (server reads for the kind rules only then, never per row of a multi-selection). */
export type SelectionRefiner = (item: SelectionItem, profileId: string | null, opts?: { single?: boolean }) => SelectionItem
let selectionRefiner: SelectionRefiner | null = null

/** A region (tree, list, results) reports its selection for commands run from it. */
export function registerSelectionProvider(source: CommandSource, provider: () => SelectionItem[]): () => void {
  const s = selectionProviders.get(source) ?? []
  s.push(provider)
  selectionProviders.set(source, s)
  return () => {
    const cur = selectionProviders.get(source)
    if (!cur) return
    const i = cur.lastIndexOf(provider)
    if (i >= 0) cur.splice(i, 1)
  }
}

/**
 * The container a region shows (the Contents list) for create / refresh
 * commands run there with nothing selected (ctx.containerDN).
 */
export function registerContainerProvider(source: CommandSource, provider: () => string | undefined): () => void {
  const s = containerProviders.get(source) ?? []
  s.push(provider)
  containerProviders.set(source, s)
  return () => {
    const cur = containerProviders.get(source)
    if (!cur) return
    const i = cur.lastIndexOf(provider)
    if (i >= 0) cur.splice(i, 1)
  }
}

/**
 * Completes selection items from the app state the registry does not import
 * (tree nodes: objectClass, naming-context heads, row states; presence
 * reads). Registered once by commands/selectionContext.
 */
export function registerSelectionRefiner(fn: SelectionRefiner): () => void {
  selectionRefiner = fn
  return () => {
    if (selectionRefiner === fn) selectionRefiner = null
  }
}

const serverTypes = new Map<string, ServerType | null>()
const serverInfos = new Map<string, ServerInfo>()
const serverInfoPending = new Map<string, Promise<ServerInfo | null>>()

/** RootDSE summary of a profile (GetServerInfo), cached per profile. */
export function ensureServerInfo(profileId: string): Promise<ServerInfo | null> {
  const cached = serverInfos.get(profileId)
  if (cached) return Promise.resolve(cached)
  const pending = serverInfoPending.get(profileId)
  if (pending) return pending
  const p = wails
    .GetServerInfo(profileId)
    .catch(() => null)
    .then((info) => {
      serverInfoPending.delete(profileId)
      if (info) {
        serverInfos.set(profileId, info)
        serverTypes.set(profileId, info.serverType)
        emit()
      }
      return info
    })
  serverInfoPending.set(profileId, p)
  return p
}

/** Server type of a profile (RootDSE: AD when supportedCapabilities has LDAP_CAP_ACTIVE_DIRECTORY). */
export function ensureServerType(profileId: string): Promise<ServerType | null> {
  if (serverTypes.has(profileId)) return Promise.resolve(serverTypes.get(profileId) ?? null)
  return ensureServerInfo(profileId).then((i) => i?.serverType ?? null)
}

/** Forget the cached RootDSE data (after reconnecting to a different server). */
export function clearServerType(profileId: string) {
  serverTypes.delete(profileId)
  serverInfos.delete(profileId)
}

/** Cached RootDSE summary of a profile (undefined until ensureServerInfo resolved). */
export function cachedServerInfo(profileId: string | null | undefined): ServerInfo | undefined {
  return profileId ? serverInfos.get(profileId) : undefined
}

/**
 * Normalizes a selection item: the refiner completes it (objectClass, NC
 * head, states), then `kind` comes from objectClass (+ the attributes it is
 * known to have); a naming-context head is always a container kind.
 */
export function selectionItem(item: SelectionItem, profileId: string | null = null, opts: { single?: boolean } = { single: true }): SelectionItem {
  let it = item
  if (selectionRefiner) {
    try {
      it = selectionRefiner(item, item.profileId ?? profileId, opts)
    } catch {
      it = item
    }
  }
  let kind = item.kind ?? resolveObjectKind(it.objectClass, it.presentAttributes)
  if (it.ncHead && !isContainerKind(kind)) kind = 'container'
  return it.kind === kind ? it : { ...it, kind }
}

/**
 * The active editor tab as a selection item, unfiltered (it may belong to
 * another connection than the active one: getCommandContext then drops it
 * and sets `foreign`).
 */
export function activeTabSelection(): SelectionItem[] {
  const es = useEditorStore.getState()
  const tab = es.tabs.find((t) => t.id === es.activeTabId)
  if (!tab || !tab.dn) return []
  const entry = es.entries[tab.id]
  const ocAttr = entry?.attributes.find((a) => a.name.toLowerCase() === 'objectclass')
  const objectClass = ocAttr?.values
  const status = entry ? deriveAccountStatus(entry.attributes).map((s) => s.kind) : undefined
  const presentAttributes = entry ? entry.attributes.map((a) => a.name) : undefined
  return [selectionItem({ dn: tab.dn, profileId: tab.profileId || undefined, objectClass, status, label: tab.label, presentAttributes })]
}

/**
 * Builds the command context from the stores. Selection comes from the
 * provider registered for `source`, otherwise from the active editor tab.
 */
export function getCommandContext(source: CommandSource = 'palette', override: Partial<CommandContext> = {}): CommandContext {
  const cs = useConnectionStore.getState()
  const profileId = cs.activeProfileId
  const profile = profileId ? cs.profiles.find((p) => p.id === profileId) : undefined
  const connected = profileId ? cs.connectionStatuses[profileId] === true : false
  if (profileId && connected && !serverTypes.has(profileId)) void ensureServerType(profileId)
  const norm = (it: SelectionItem, _i: number, all: readonly SelectionItem[]) => selectionItem(it, profileId, { single: all.length === 1 })
  let selection: SelectionItem[] | undefined = override.selection?.map(norm)
  if (!selection) {
    const providers = selectionProviders.get(source)
    if (providers && providers.length) {
      try {
        selection = providers[providers.length - 1]().map(norm)
      } catch {
        selection = undefined
      }
    }
  }
  let containerDN = override.containerDN
  if (containerDN === undefined) {
    const cps = containerProviders.get(source)
    if (cps && cps.length) {
      try {
        containerDN = cps[cps.length - 1]() || undefined
      } catch {
        containerDN = undefined
      }
    }
  }
  const ctxProfile = override.profileId !== undefined ? override.profileId : profileId
  // Never hand a handler a DN of another connection than ctx.profileId.
  const all = selection ?? activeTabSelection()
  const own = all.filter((it) => !it.profileId || it.profileId === ctxProfile)
  let foreign = override.foreign
  if (!foreign && own.length < all.length) {
    const other = all.find((it) => it.profileId && it.profileId !== ctxProfile)!.profileId!
    const name = cs.profiles.find((p) => p.id === other)?.name ?? 'its connection'
    const dns = all.filter((it) => it.profileId === other).map((it) => it.dn)
    foreign = { profileId: other, name, count: all.length - own.length, dns }
  }
  const offline = !!ctxProfile && !!offlineProvider?.(ctxProfile)
  return {
    profileId,
    serverType: profileId ? serverTypes.get(profileId) ?? null : null,
    connected,
    readOnly: !!profile?.readOnly,
    source,
    offline,
    ...override,
    containerDN,
    foreign,
    selection: own,
  }
}

// --- Predicates for `when` ----------------------------------------------------

export const one = (ctx: CommandContext) => ctx.selection.length === 1
/**
 * The single entry of another connection a surface targets (its items were
 * dropped from `selection`, RW1-N-02): only read verbs that name their own
 * connection (Copy DN, Show in Tree) act on it. '' when there is none.
 */
export const foreignDn = (ctx: CommandContext): string => (!ctx.selection.length && ctx.foreign?.dns?.length === 1 ? ctx.foreign.dns[0] : '')
export const many = (ctx: CommandContext) => ctx.selection.length > 1
export const kindOf = (ctx: CommandContext): ObjectKind | undefined =>
  ctx.selection.length === 1 ? ctx.selection[0].kind ?? resolveObjectKind(ctx.selection[0].objectClass) : undefined
export const isKind = (ctx: CommandContext, ...kinds: ObjectKind[]) => {
  const k = kindOf(ctx)
  return !!k && kinds.includes(k)
}
export const allKinds = (ctx: CommandContext, ...kinds: ObjectKind[]) =>
  ctx.selection.length > 0 && ctx.selection.every((s) => kinds.includes(s.kind ?? resolveObjectKind(s.objectClass)))
export const hasStatus = (ctx: CommandContext, status: AccountStatusKind) =>
  ctx.selection.length === 1 && !!ctx.selection[0].status?.includes(status)

// --- Resolution ---------------------------------------------------------------

export interface ResolvedCommand {
  id: string
  command: Command
  title: string
  enabled: boolean
  isDefault: boolean
  checked?: boolean
  shortcut?: string
  section: string
  danger: boolean
  /** Why it is disabled (Command.disabledReason), when it is. */
  disabledReason?: string
}

export interface ResolveOptions {
  group?: CommandGroup | CommandGroup[]
  ids?: string[]
  /** Children of this submenu id; default: top-level commands only (null). Pass `undefined` explicitly via `allLevels`. */
  parent?: string | null
  allLevels?: boolean
  surface?: 'menu' | 'palette'
}

export function titleOf(c: Command, ctx: CommandContext): string {
  try {
    return typeof c.title === 'function' ? c.title(ctx) : c.title
  } catch {
    return typeof c.title === 'string' ? c.title : c.id
  }
}

function reasonOf(c: Command, ctx: CommandContext): string | undefined {
  try {
    return c.disabledReason?.(ctx)
  } catch {
    return undefined
  }
}

/** One command resolved for a context (title, enabled, checked …), regardless of its visibility. */
export function resolveOne(c: Command, ctx: CommandContext, section?: string): ResolvedCommand {
  const enabled = isCommandEnabled(c, ctx)
  let checked: boolean | undefined
  try {
    checked = c.checked ? c.checked(ctx) : undefined
  } catch {
    checked = false
  }
  return {
    id: c.id,
    command: c,
    title: titleOf(c, ctx),
    enabled,
    isDefault: typeof c.isDefault === 'function' ? c.isDefault(ctx) : !!c.isDefault,
    checked,
    shortcut: Array.isArray(c.shortcut) ? c.shortcut[0] : c.shortcut,
    section: section ?? (typeof c.section === 'function' ? c.section(ctx) : c.section ?? c.group),
    danger: !!c.danger,
    disabledReason: enabled ? undefined : reasonOf(c, ctx),
  }
}

/** True if the command is shown for the context (when()). */
export function isCommandVisible(c: Command, ctx: CommandContext): boolean {
  return visible(c, ctx)
}

function visible(c: Command, ctx: CommandContext) {
  try {
    return c.when ? c.when(ctx) : true
  } catch {
    return false
  }
}

export function isCommandEnabled(c: Command, ctx: CommandContext): boolean {
  if (c.submenu) return true
  if (!c.run) return false
  try {
    return c.enabled ? c.enabled(ctx) : true
  } catch {
    return false
  }
}

/** Filters, resolves titles and sorts commands for one surface. */
export function resolveCommands(ctx: CommandContext, opts: ResolveOptions = {}): { items: ResolvedCommand[]; hiddenWrites: number } {
  const groups = opts.group ? (Array.isArray(opts.group) ? opts.group : [opts.group]) : null
  const parent = opts.allLevels ? undefined : opts.parent ?? null
  let hiddenWrites = 0
  const items: ResolvedCommand[] = []
  const pool = opts.ids ? opts.ids.map(getCommand).filter((c): c is Command => !!c) : getCommands()
  for (const c of pool) {
    if (groups && !groups.includes(c.group)) continue
    if (parent !== undefined && (c.parent ?? null) !== parent) continue
    if (opts.surface === 'palette' && (c.palette === false || c.submenu)) continue
    if (opts.surface === 'menu' && c.menu === false) continue
    if (!visible(c, ctx)) continue
    if (c.write && writesHidden(ctx)) {
      hiddenWrites++
      continue
    }
    const section = typeof c.section === 'function' ? c.section(ctx) : c.section ?? c.group
    items.push(resolveOne(c, ctx, section))
  }
  if (!opts.ids) {
    const sIdx = (s: string) => {
      const i = SECTION_ORDER.indexOf(s)
      return i < 0 ? SECTION_ORDER.length : i
    }
    items.sort(
      (a, b) =>
        sIdx(a.section) - sIdx(b.section) ||
        (a.command.order ?? 1e6) - (b.command.order ?? 1e6) ||
        (regOrder.get(a.id) ?? 0) - (regOrder.get(b.id) ?? 0),
    )
  }
  return { items, hiddenWrites }
}

/** Resolved commands for a context; re-renders when the registry changes. */
export function useCommands(ctx: CommandContext, opts: ResolveOptions = {}): ResolvedCommand[] {
  const v = useCommandRegistryVersion()
  const key = JSON.stringify([opts.group, opts.ids, opts.parent, opts.allLevels, opts.surface])
  // ctx is usually rebuilt per render; resolution is cheap.
  return useMemo(() => resolveCommands(ctx, opts).items, [v, key, ctx])
}

/** Runs a command by id (no-op when hidden, disabled or unhandled). Returns true if it ran. */
export function runCommand(id: string, ctx: CommandContext = getCommandContext()): boolean {
  const c = getCommand(id)
  if (!c || !visible(c, ctx) || (c.write && writesHidden(ctx)) || !isCommandEnabled(c, ctx)) return false
  try {
    const r = c.run!(ctx)
    if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch((err) => console.error(`command ${id} failed`, err))
  } catch (err) {
    console.error(`command ${id} failed`, err)
  }
  return true
}

// --- Shortcuts ----------------------------------------------------------------

/** True while a modal (primitive Dialog or a legacy feature overlay) is open. */
export function isModalOpen(): boolean {
  if (typeof document === 'undefined') return false
  return !!document.querySelector('[aria-modal="true"]') || !!document.querySelector('.fixed.inset-0.bg-overlay')
}

const parsedCache = new Map<string, ParsedShortcut>()
function parsed(s: string) {
  let p = parsedCache.get(s)
  if (!p) {
    p = parseShortcut(s)
    parsedCache.set(s, p)
  }
  return p
}

/**
 * Global shortcut dispatcher. Mount ONCE (AppLayout); every global shortcut
 * of the app (Ctrl+B/J/W/G/K, Ctrl+Tab, Ctrl+1–9, Ctrl+Shift+C/E/F/R/B/S/L/A,
 * Alt+Left/Right, zoom, F5, Ctrl+/ ...) is a registry command dispatched here.
 * It skips everything while a modal is open, skips text-editing shortcuts and
 * Ctrl+D / Ctrl+N in editable targets (blocksInEditable), and skips plain-key shortcuts
 * (F2, Del, Enter, Backspace) outside a [data-command-scope] region (whose
 * value names the command source: data-command-scope="tree") unless the
 * command is `global` (F5). displayOnly commands are never dispatched here.
 * Outside a region, a target inside the editor area is source 'tab' (the
 * active tab), anything else source 'editor' (the most recent selection).
 * F5 never reloads the web view (also inside dialogs).
 */
export function useCommandShortcuts() {
  useEffect(() => {
    // Capture phase: dialogs stop keydown propagation at their root. The guard
    // remembers the events it prevented: F5 must still reach the dispatcher below.
    const reloadGuarded = new WeakSet<Event>()
    const blockReload = (e: KeyboardEvent) => {
      if (!isReloadKey(e)) return
      if (!e.defaultPrevented) reloadGuarded.add(e)
      e.preventDefault()
    }
    const onKey = (e: KeyboardEvent) => {
      if (dispatcherSkips(e, reloadGuarded.has(e))) return
      if (isModalOpen()) return
      const target = e.target instanceof Element ? e.target : null
      const scopeEl = target?.closest<HTMLElement>('[data-command-scope]') ?? null
      // Inside an editor tab (outside its Contents list) the shortcuts act on that tab (F5 reloads it).
      const inEditor = !scopeEl && !!target?.closest('[role="region"][aria-label="Editor"]')
      for (const c of getCommands()) {
        if (!c.shortcut || c.displayOnly || !c.run) continue
        const list = Array.isArray(c.shortcut) ? c.shortcut : [c.shortcut]
        for (const s of list) {
          const p = parsed(s)
          if (!matchShortcut(e, p)) continue
          const fnKey = /^f\d{1,2}$/.test(p.key)
          if (isEditableTarget(e.target) && blocksInEditable(p) && !(c.global && fnKey)) continue
          if (isPlainKey(p) && !scopeEl && !c.global) continue
          const source = (scopeEl?.dataset.commandScope as CommandSource | undefined) ?? (inEditor ? 'tab' : 'editor')
          const ctx = getCommandContext(source)
          if (!visible(c, ctx) || (c.write && writesHidden(ctx)) || !isCommandEnabled(c, ctx)) continue
          e.preventDefault()
          e.stopPropagation()
          runCommand(c.id, ctx)
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keydown', blockReload, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keydown', blockReload, true)
    }
  }, [])
}

/** All commands that have a shortcut, for the shortcut list (help). */
export function getShortcutList(ctx: CommandContext = getCommandContext()): { group: CommandGroup; title: string; shortcut: string; display: string }[] {
  return getCommands()
    .filter((c) => !!c.shortcut && c.menu !== false)
    .map((c) => {
      const s = Array.isArray(c.shortcut) ? c.shortcut[0] : c.shortcut!
      return { group: c.group, title: titleOf(c, ctx), shortcut: s, display: formatShortcut(s) }
    })
}
