/**
 * CommandPalette — "Go to anything" (SPEC 6.4, UX-2). Ctrl+K; Ctrl+Shift+P
 * opens it in command mode. Built on Dialog (bare, top-aligned) and the
 * listbox pattern (aria-activedescendant).
 *
 * - Scope chips: All / Entries / Actions / DN. A ">" prefix means Actions.
 * - A DN or ldap:// URL is a direct jump (one base read to verify it; never a
 *   name search).
 * - A name runs a debounced (250 ms) search through lib/wails SearchLDAP:
 *   (anr=q) on AD, an OR of prefix matches over cn, displayName, sn,
 *   givenName, uid, mail and ou elsewhere, then a substring pass when that
 *   finds nothing (commands/paletteSearch.ts); sizeLimit 20; stale responses
 *   are ignored (CancelSearch is NOT used: it would cancel the user's other
 *   searches on the profile).
 * - Connections whose name or host matches appear as "Connect to <p>" /
 *   "Switch to <p>" (also under Actions).
 * - Bookmarks and recent entries first, then results ranked exact > prefix >
 *   contains, with ObjectIcon, StatusChip and the parent container.
 * - Enter opens; Ctrl+Enter opens pinned; Tab on an entry lists its actions
 *   (Shift+Tab / Escape go back): a recent / bookmark without objectClass is
 *   read first (kind + account status); account verbs use the hit's known
 *   status at once and read the server status again. The entry's primary
 *   account verb is preselected (Unlock when locked, Enable when disabled,
 *   else Reset Password…; primaryAction.ts, as the editor header), and
 *   Shift+Enter on a hit runs it at once (FIN-W-02). Escape closes and focus
 *   returns to the opener.
 * - A hit is named by its RDN value, as its tab and tree row, followed by
 *   the display name (else cn) when that differs ("eva.weber  Eva Weber";
 *   hitLabel.ts, shared with Find in Tree).
 * - DN mode: an entry that does not exist says so and offers its nearest
 *   existing parent; an LDAP URL of another host warns and offers the
 *   matching connection.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { ArrowLeft, ArrowRightLeft, ChevronRight, CornerDownLeft, Navigation, Plug, Search, Star, History, TriangleAlert } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { connectAndBrowse } from '../connection/connectFlow'
import { requestEditorFocus } from '../editor/editorFocus'
import { cn } from '../../lib/utils'
import * as wails from '../../lib/wails'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { bookmarkName, bookmarkRdnName, useBookmarkStore } from '../../stores/bookmarkStore'
import { cachedAccountStatusKinds } from '../../stores/accountStatusCache'
import { primaryAccountVerb } from './primaryAction'
import { entryHitLabel } from './hitLabel'
import type { LDAPEntry } from '../../types/ldap'
import { Dialog } from './Dialog'
import { focusScopeTarget } from './layer'
import { usePaletteStore, type PaletteScope } from './paletteStore'
import { SegmentedControl } from './SegmentedControl'
import { ObjectIcon } from './ObjectIcon'
import { StatusChip } from './StatusChip'
import { Kbd } from './Kbd'
import { Spinner } from './Spinner'
import { InlineAlert } from './InlineAlert'
import { Button, renderIcon } from './Button'
import { moveActive, optionDomId } from './Listbox'
import { ancestorDns, parentDn, parseDnOrUrl, rdnValue, type DnInput } from './dnParse'
import { ACCOUNT_STATUS_ATTRIBUTES, deriveAccountStatus, primaryStatus, type AccountStatus } from './accountStatus'
import { hasAccountSemantics, resolveObjectKind } from './objectKind'
import { stabilizeMenuItems } from './Menu'
import {
  COMMAND_GROUPS,
  ensureServerInfo,
  getCommand,
  getCommandContext,
  resolveCommands,
  runCommand,
  useCommandRegistryVersion,
  type CommandContext,
  type ResolvedCommand,
} from './commands'
import { ScopeBase, ScopeSub } from '../../types/ldap'
import { connectProfile } from '../layout/shellState'
import { prefetchAccountStatus } from '../commands/accountState'
import { PALETTE_NAME_ATTRS, ldapErrorKind, matchingProfiles, paletteNameFilters, profileActionTitle, urlMatchesProfile } from '../commands/paletteSearch'
import { parseRecents, type RecentEntry } from '../../lib/entryEvents'

interface EntryItem {
  type: 'entry'
  key: string
  dn: string
  name: string
  /** Second name after `name` (the display name of a search hit, the RDN value of a renamed bookmark). */
  detail?: string
  objectClass?: string[]
  statuses?: AccountStatus[]
  source: 'bookmark' | 'recent' | 'search'
  /** A bookmark whose entry was deleted or not found (shown struck through, RW2-R-02). */
  stale?: boolean
}
interface DnItem {
  type: 'dn'
  key: string
  dn: string
}
interface CommandItem {
  type: 'command'
  key: string
  rc: ResolvedCommand
  title: string
  ctx: CommandContext
}
interface ProfileItem {
  type: 'profile'
  key: string
  profileId: string
  title: string
  connected: boolean
  detail: string
}
type Item = EntryItem | DnItem | CommandItem | ProfileItem

/** DN mode errors: never the raw server text for a missing entry. */
type DnError = { kind: 'notFound'; profileId: string; dn: string; parent: string | null; searching: boolean } | { kind: 'message'; text: string }
interface Group {
  id: string
  label: string
  items: Item[]
}

const NAME_ATTRS = PALETTE_NAME_ATTRS

function attr(e: LDAPEntry, name: string): string | undefined {
  const a = e.attributes.find((x) => x.name.toLowerCase() === name.toLowerCase())
  return a?.values[0]
}

function rank(e: LDAPEntry, q: string): number {
  const ql = q.toLowerCase()
  let best = 3
  for (const n of NAME_ATTRS) {
    const v = attr(e, n)?.toLowerCase()
    if (!v) continue
    const at = n === 'userPrincipalName' || n === 'mail' ? v.split('@')[0] : v
    if (v === ql || at === ql) return 0
    if (v.startsWith(ql)) best = Math.min(best, 1)
    else if (v.includes(ql)) best = Math.min(best, 2)
  }
  return best
}


/** Focuses the editor's active tab (after the palette handed focus back to its opener). */
function focusEditorTab() {
  const region = document.querySelector<HTMLElement>('[role="region"][aria-label="Editor"]')
  // Into the editor (its current breadcrumb), so Ctrl+L, F4, Ctrl+F and the arrows work at
  // once (RW1-E-05); the tab button only when no editor is shown.
  const crumb = region?.querySelector<HTMLElement>('nav[aria-label="Breadcrumb"] [aria-current="page"]')
  const target = crumb ?? (region ? focusScopeTarget(region) : null)
  target?.focus({ preventScroll: true })
}

/** Recent entries of the connection, with the objectClass of their last load (account verbs on Tab). */
function loadRecent(profileId: string | null): RecentEntry[] {
  if (!profileId) return []
  try {
    return parseRecents(localStorage.getItem('ldapilot-recent-entries')).filter((r) => r.profileId === profileId)
  } catch {
    return []
  }
}

function matchesText(q: string, ...hay: (string | undefined)[]) {
  if (!q) return true
  const h = hay.filter(Boolean).join(' ').toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => h.includes(w))
}

const SCOPES: { value: PaletteScope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'entries', label: 'Entries' },
  { value: 'actions', label: 'Actions' },
  { value: 'dn', label: 'DN' },
]

/** Mount once (AppLayout). Opened through usePaletteStore / the palette.open command. */
export function CommandPalette() {
  const open = usePaletteStore((s) => s.open)
  const close = usePaletteStore((s) => s.closePalette)
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} bare placement="top" size="md" dismissible="always" title="Go to anything" description="Type a name, a DN, an LDAP URL, or > for actions">
      <PaletteBody />
    </Dialog>
  )
}

function PaletteBody() {
  const initial = usePaletteStore.getState()
  const closePalette = usePaletteStore((s) => s.closePalette)
  const [query, setQuery] = useState(initial.query)
  const [scope, setScope] = useState<PaletteScope>(initial.scope)
  const [activeKeyState, setActiveKey] = useState<string | null>(null)
  const [pivot, setPivot] = useState<EntryItem | null>(null)
  // The pivot (Tab) has its own filter text; the search query and its results stay intact.
  const [pivotFilter, setPivotFilter] = useState('')
  const [results, setResults] = useState<EntryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [dnError, setDnError] = useState<DnError | null>(null)
  const [dnBusy, setDnBusy] = useState(false)
  const [truncated, setTruncated] = useState(false)
  /** The pivot entry is being read (objectClass + account status of a recent / bookmark). */
  const [pivotReading, setPivotReading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)
  const pivotSeen = useRef(new Map<string, ResolvedCommand>())
  const listId = 'palette-list'
  const v = useCommandRegistryVersion()

  const profileId = useConnectionStore((s) => s.activeProfileId)
  const profile = useConnectionStore((s) => s.profiles.find((p) => p.id === s.activeProfileId))
  const profiles = useConnectionStore((s) => s.profiles)
  const statuses = useConnectionStore((s) => s.connectionStatuses)
  // The active tab's connection (a tab of another connection: "switch" offers it first).
  const tabProfileId = useEditorStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.profileId || null)
  const connected = useConnectionStore((s) => (s.activeProfileId ? s.connectionStatuses[s.activeProfileId] === true : false))
  const bookmarks = useBookmarkStore(useShallow((s) => s.bookmarks.filter((b) => b.profileId === profileId)))

  const actionsMode = scope === 'actions' || query.trimStart().startsWith('>')
  const q = (query.trimStart().startsWith('>') ? query.trimStart().slice(1) : query).trim()
  const parsedRaw = parseDnOrUrl(q)
  // DN scope: whatever is typed is a DN (or a URL), never a name.
  const parsed: DnInput = scope === 'dn' && q && parsedRaw.kind === 'text' ? { kind: 'dn', dn: q } : parsedRaw
  const nameQuery = !actionsMode && parsed.kind === 'text' ? q : ''
  const searchEnabled = connected && !!profileId && (scope === 'all' || scope === 'entries') && nameQuery.length >= 2

  // Debounced name search.
  useEffect(() => {
    setSearchError(null)
    if (!searchEnabled) {
      setResults([])
      setLoading(false)
      setTruncated(false)
      return
    }
    const my = ++seq.current
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const info = await ensureServerInfo(profileId!)
        const ad = info?.serverType === 'ad'
        const base = profile?.baseDN || info?.defaultNamingContext || ''
        const filters = paletteNameFilters(nameQuery, ad)
        const search = async (filter: string) => {
          const params = { baseDN: base, filter, scope: ScopeSub, attributes: [...NAME_ATTRS, ...ACCOUNT_STATUS_ATTRIBUTES], sizeLimit: 20, timeLimit: 10 }
          try {
            return await wails.SearchLDAP(profileId!, params)
          } catch {
            // Some servers refuse constructed attributes in subtree searches: retry without them.
            if (my !== seq.current) return null
            return await wails.SearchLDAP(profileId!, { ...params, attributes: [...NAME_ATTRS, 'objectClass', 'userAccountControl', 'lockoutTime', 'accountExpires', 'pwdLastSet', 'pwdAccountLockedTime', 'pwdReset', 'nsAccountLock'] })
          }
        }
        let res = await search(filters.first)
        // Nothing with a prefix: a word inside the name (surname first, "日本" in "Zoë Ångström 日本").
        if (res && !(res.entries ?? []).length && my === seq.current) res = await search(filters.fallback)
        if (my !== seq.current || !res) return
        const items = (res.entries ?? [])
          .map((e) => ({ e, r: rank(e, nameQuery) }))
          .sort((a, b) => a.r - b.r || (attr(a.e, 'displayName') ?? attr(a.e, 'cn') ?? a.e.dn).localeCompare(attr(b.e, 'displayName') ?? attr(b.e, 'cn') ?? b.e.dn))
          .map(({ e }): EntryItem => {
            const oc = e.attributes.find((a) => a.name.toLowerCase() === 'objectclass')?.values
            // The RDN value, as the tab and the tree say, plus the display name (else cn) when it differs.
            const label = entryHitLabel(e.dn, { displayName: attr(e, 'displayName'), cn: attr(e, 'cn') })
            return {
              type: 'entry',
              key: `s:${e.dn}`,
              dn: e.dn,
              name: label.name,
              detail: label.detail,
              objectClass: oc,
              statuses: deriveAccountStatus(e.attributes, { serverType: info?.serverType ?? null }),
              source: 'search',
            }
          })
        setResults(items)
        setTruncated(!!res.truncated || items.length >= 20)
      } catch (err) {
        if (my !== seq.current) return
        if (wails.isSearchCancelled(err)) return
        setResults([])
        setSearchError(err instanceof Error ? err.message : String(err))
      } finally {
        if (my === seq.current) setLoading(false)
      }
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameQuery, searchEnabled, profileId])


  // Connections matching the typed text: switch to / connect from the palette.
  const profileItems: ProfileItem[] = useMemo(() => {
    if (pivot || scope === 'dn' || scope === 'entries' || parsed.kind !== 'text' || q.length < 2) return []
    // "switch" offers the connected others (the active tab's connection first), "connect" the
    // unconnected ones (RW3-N-01).
    return matchingProfiles(profiles, q, 5, { connected: (id) => statuses[id] === true, activeId: profileId, preferId: tabProfileId }).map((p) => {
      const on = statuses[p.id] === true
      return {
        type: 'profile',
        key: `p:${p.id}`,
        profileId: p.id,
        title: p.id === profileId && on ? `${p.name} (active)` : profileActionTitle(p.name, on),
        connected: on,
        detail: `${p.host}:${p.port}`,
      }
    })
  }, [pivot, scope, parsed.kind, q, profiles, statuses, profileId, tabProfileId])

  // DN mode: an LDAP URL of another host than the active connection.
  const urlMismatch = useMemo(() => {
    if (parsed.kind !== 'url' || !profile) return null
    if (urlMatchesProfile(parsed.url, profile)) return null
    // A connected match first: switching to it opens the DN without a new bind (RW1-N-08).
    const matches = profiles
      .filter((p) => p.id !== profile.id && urlMatchesProfile(parsed.url, p))
      .sort((a, b) => Number(statuses[b.id] === true) - Number(statuses[a.id] === true))
      .slice(0, 2)
    return { host: parsed.url.port ? `${parsed.url.host}:${parsed.url.port}` : parsed.url.host, matches }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed.kind, parsed.kind === 'url' ? `${parsed.url.host}:${parsed.url.port ?? ''}` : '', profile, profiles, statuses])
  /** Enter on the DN of such a URL: the connected matching profile, else the active connection. */
  const urlTarget = urlMismatch?.matches.find((p) => statuses[p.id] === true) ?? null

  const groups: Group[] = useMemo(() => {
    const out: Group[] = []
    if (pivot) {
      if (pivotReading) {
        out.push({ id: 'pivot', label: `Actions for ${pivot.name}`, items: [] })
        return out
      }
      const ctx = getCommandContext('palette', {
        selection: [{ dn: pivot.dn, objectClass: pivot.objectClass, status: pivot.statuses?.map((s) => s.kind), label: pivot.name }],
      })
      // Items stay in place while the account status arrives (the Unlock placeholder becomes Unlock).
      const resolved = resolveCommands(ctx, { allLevels: true, surface: 'palette', group: ['entry', 'account', 'membership', 'create'] }).items
      // Except the Unlock placeholder: once the read says "not locked" it goes, as in the
      // menus, instead of staying as a dead "Not available" row (RW1-P-03).
      const live = new Set(resolved.map((rc) => rc.id))
      const items = stabilizeMenuItems(resolved, pivotSeen.current, ctx)
        .filter((rc) => rc.id !== 'account.unlock' || live.has(rc.id))
        .filter((rc) => matchesText(pivotFilter.trim(), rc.title, ...(rc.command.keywords ?? [])))
        .map((rc): CommandItem => {
          const parent = rc.command.parent ? getCommand(rc.command.parent) : undefined
          const title = parent ? `${typeof parent.title === 'string' ? parent.title : parent.title(ctx)} › ${rc.title}` : rc.title
          return { type: 'command', key: `pc:${rc.id}`, rc, title, ctx }
        })
      out.push({ id: 'pivot', label: `Actions for ${pivot.name}`, items })
      return out
    }
    if (actionsMode) {
      const ctx = getCommandContext('palette')
      const items: Item[] = resolveCommands(ctx, { allLevels: true, surface: 'palette' })
        .items.filter((rc) => {
          const g = COMMAND_GROUPS.find((x) => x.id === rc.command.group)?.label
          return matchesText(q, rc.title, g, ...(rc.command.keywords ?? []))
        })
        .sort((a, b) => Number(b.enabled) - Number(a.enabled) || Number(b.title.toLowerCase().startsWith(q.toLowerCase())) - Number(a.title.toLowerCase().startsWith(q.toLowerCase())))
        .map((rc): CommandItem => {
          const parent = rc.command.parent ? getCommand(rc.command.parent) : undefined
          const title = parent ? `${typeof parent.title === 'string' ? parent.title : parent.title(ctx)} › ${rc.title}` : rc.title
          return { type: 'command', key: `c:${rc.id}`, rc, title, ctx }
        })
      out.push({ id: 'actions', label: 'Actions', items: [...profileItems, ...items] })
      return out
    }
    if (parsed.kind !== 'text' && parsed.dn) {
      out.push({ id: 'dn', label: profile ? `Go to DN on ${profile.name}` : 'Go to DN', items: [{ type: 'dn', key: `dn:${parsed.dn}`, dn: parsed.dn }] })
    }
    if (scope === 'dn') return out
    const textQ = parsed.kind === 'text' ? q : ''
    const seen = new Set<string>()
    const bm = bookmarks
      .filter((b) => matchesText(textQ || (parsed.kind !== 'text' ? parsed.dn : ''), b.label, b.name, b.dn))
      .slice(0, textQ ? 8 : 5)
      .map((b): EntryItem => {
        seen.add(b.dn.toLowerCase())
        // A bookmark's own name (DEF-24) comes first, its RDN value after it.
        const shown = bookmarkName(b)
        const rdn = bookmarkRdnName(b)
        return { type: 'entry', key: `b:${b.dn}`, dn: b.dn, name: shown, detail: shown !== rdn ? rdn : undefined, objectClass: b.objectClass, source: 'bookmark', stale: b.stale || undefined }
      })
    const recent = loadRecent(profileId)
      .filter((r) => !seen.has(r.dn.toLowerCase()) && matchesText(textQ || (parsed.kind !== 'text' ? parsed.dn : ''), r.label, r.dn))
      .slice(0, textQ ? 8 : 6)
      .map((r): EntryItem => {
        seen.add(r.dn.toLowerCase())
        return { type: 'entry', key: `r:${r.dn}`, dn: r.dn, name: r.label || rdnValue(r.dn), objectClass: r.objectClass, source: 'recent' }
      })
    if (bm.length) out.push({ id: 'bookmarks', label: 'Bookmarks', items: bm })
    if (recent.length) out.push({ id: 'recent', label: 'Recent', items: recent })
    if (results.length) out.push({ id: 'results', label: 'Entries', items: results.filter((r) => !seen.has(r.dn.toLowerCase())) })
    if (scope === 'all' && profileItems.length) out.push({ id: 'connections', label: 'Connections', items: profileItems })
    if (scope === 'all' && textQ) {
      const ctx = getCommandContext('palette')
      const cmds = resolveCommands(ctx, { allLevels: true, surface: 'palette' })
        .items.filter((rc) => rc.enabled && matchesText(textQ, rc.title, ...(rc.command.keywords ?? [])))
        .slice(0, 6)
        .map((rc): CommandItem => ({ type: 'command', key: `c:${rc.id}`, rc, title: rc.title, ctx }))
      if (cmds.length) out.push({ id: 'actions', label: 'Actions', items: cmds })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pivot, pivotFilter, pivotReading, actionsMode, q, scope, parsed.kind, parsed.kind === 'text' ? '' : parsed.dn, bookmarks, profileId, results, v, profileItems])

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])

  // The active item is derived, not synced through an effect: a stale key falls back to the first item.
  // (An effect-driven setState per keystroke chains sync updates and trips React's nested-update limit
  // when input arrives fast, e.g. a typed or pasted LDAP URL.)
  // In an entry's actions, the entry's primary account verb is the one the user came for:
  // Unlock when locked (WF-1b: Ctrl+K, name, Tab, Enter), Enable when disabled, else Reset
  // Password… (FIN-W-02: WF-2), as the editor header's primary button.
  const pivotPrimaryKey = useMemo(() => {
    if (!pivot) return undefined
    const cmds = flat.filter((i): i is CommandItem => i.type === 'command')
    const unlock = cmds.find((i) => i.rc.id === 'account.unlock' && i.rc.enabled)
    if (unlock) return unlock.key
    const kinds = cachedAccountStatusKinds(profileId, pivot.dn) ?? pivot.statuses?.map((st) => st.kind)
    return primaryAccountVerb(cmds.map((i) => ({ id: i.rc.id, enabled: i.rc.enabled, key: i.key })), kinds)?.key
  }, [pivot, flat, profileId])
  const defaultKey = pivotPrimaryKey || (flat[0]?.key ?? null)
  const activeKey = activeKeyState && flat.some((i) => i.key === activeKeyState) ? activeKeyState : defaultKey

  useEffect(() => {
    if (activeKey) document.getElementById(optionDomId(listId, activeKey))?.scrollIntoView({ block: 'nearest' })
  }, [activeKey])

  const active = flat.find((i) => i.key === activeKey)

  /** Enter opens the preview tab, Ctrl+Enter a pinned tab (UX-3). */
  // onProfile: the connection the DN was read from (an LDAP URL can switch connections first).
  const openEntry = (dn: string, pin: boolean, onProfile: string | null = profileId) => {
    if (!onProfile) return
    closePalette()
    // A new editor takes focus itself when it mounts (editorFocus); an open one gets it below.
    requestEditorFocus('crumb')
    useEditorStore.getState().openEntry(onProfile, dn, { preview: !pin })
    // The opened entry is what the user looks at now: its tab takes focus
    // instead of the opener (e.g. the tree row), so the Entry menu, Ctrl+D,
    // Shift+Alt+C and Del act on it, not on the tree selection.
    setTimeout(focusEditorTab, 0)
  }

  const runItem = async (item: Item | undefined, pin: boolean) => {
    if (!item) return
    if (item.type === 'entry') return openEntry(item.dn, pin)
    if (item.type === 'command') {
      if (!item.rc.enabled) return
      closePalette()
      // After the palette unmounts (focus restored, no aria-modal left).
      setTimeout(() => runCommand(item.rc.id, { ...item.ctx, shownTitle: item.rc.title }), 0)
      return
    }
    if (item.type === 'profile') {
      closePalette()
      // Like the switcher: the Explorer and the first tree row get focus (RW2-N-06).
      void connectAndBrowse(item.profileId)
      return
    }
    if (urlTarget) {
      await connectProfile(urlTarget.id, { reveal: false })
      if (useConnectionStore.getState().activeProfileId === urlTarget.id) await goToDn(item.dn, pin, urlTarget.id)
      return
    }
    await goToDn(item.dn, pin)
  }

  /** Opens a DN (one base read); a missing entry names its nearest existing parent. */
  const goToDn = async (dn: string, pin: boolean, onProfile: string | null = profileId) => {
    if (!onProfile || useConnectionStore.getState().connectionStatuses[onProfile] !== true) {
      setDnError({ kind: 'message', text: 'Connect to a directory first.' })
      return
    }
    setDnBusy(true)
    try {
      const e = await wails.GetEntry(onProfile, dn)
      if (!e) throw new Error('No Such Object')
      openEntry(e.dn || dn, pin, onProfile)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const kind = ldapErrorKind(msg)
      if (kind === 'noSuchObject') {
        setDnError({ kind: 'notFound', profileId: onProfile, dn, parent: null, searching: true })
        let parent: string | null = null
        for (const a of ancestorDns(dn)) {
          try {
            if (await wails.GetEntry(onProfile, a)) {
              parent = a
              break
            }
          } catch {
            /* keep walking up */
          }
        }
        setDnError({ kind: 'notFound', profileId: onProfile, dn, parent, searching: false })
      } else if (kind === 'invalidDN') {
        setDnError({ kind: 'message', text: 'This is not a valid DN. Check the attribute names and escape commas in values (\\,).' })
      } else {
        setDnError({ kind: 'message', text: `Could not read the entry: ${msg}` })
      }
    } finally {
      setDnBusy(false)
    }
  }

  /** The primary account verb of a hit (Shift+Enter, footer hint); undefined for non-accounts or an unknown kind. */
  const hitPrimary = (item: EntryItem | undefined): { rc: ResolvedCommand; ctx: CommandContext } | undefined => {
    if (!item || item.stale || !item.objectClass?.length || !connected) return undefined
    const kinds = cachedAccountStatusKinds(profileId, item.dn) ?? item.statuses?.map((st) => st.kind)
    const ctx = getCommandContext('palette', { selection: [{ dn: item.dn, objectClass: item.objectClass, status: kinds, label: item.name }] })
    const rc = primaryAccountVerb(resolveCommands(ctx, { allLevels: true, surface: 'palette', group: ['account'] }).items, kinds)
    return rc ? { rc, ctx } : undefined
  }

  /** Shift+Enter on a hit: its primary account verb at once (else its actions, as Tab). */
  const runPrimary = (item: EntryItem) => {
    const p = hitPrimary(item)
    if (!p) return void startPivot(item)
    closePalette()
    setTimeout(() => runCommand(p.rc.id, { ...p.ctx, shownTitle: p.rc.title }), 0)
  }

  // The footer names the active hit's Shift+Enter verb.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const activePrimary = useMemo(() => (!pivot && active?.type === 'entry' ? hitPrimary(active) : undefined), [pivot, active, v, connected, profileId])

  /** Tab on an entry: its actions. A recent / bookmark without objectClass is read first (kind + account status). */
  const startPivot = async (item: EntryItem) => {
    pivotSeen.current = new Map()
    setPivot(item)
    setPivotFilter('')
    setActiveKey(null)
    if (!profileId || !connected) return
    let target = item
    if (!item.objectClass) {
      setPivotReading(true)
      try {
        const info = await ensureServerInfo(profileId)
        const res = await wails.SearchLDAP(profileId, { baseDN: item.dn, filter: '(objectClass=*)', scope: ScopeBase, attributes: [...NAME_ATTRS, ...ACCOUNT_STATUS_ATTRIBUTES], sizeLimit: 1, timeLimit: 10 })
        const e = res.entries?.[0]
        if (e) {
          target = {
            ...item,
            objectClass: e.attributes.find((a) => a.name.toLowerCase() === 'objectclass')?.values,
            statuses: deriveAccountStatus(e.attributes, { serverType: info?.serverType ?? null }),
          }
          setPivot((cur) => (cur && cur.key === item.key ? target : cur))
        }
      } catch {
        /* generic verbs only */
      } finally {
        setPivotReading(false)
      }
    }
    // The server account status, fresh (a cached one may be older than this hit).
    if (hasAccountSemantics(resolveObjectKind(target.objectClass), target.objectClass)) prefetchAccountStatus(profileId, target.dn, true)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const next = moveActive(e.key, flat, (i) => i.key, activeKey)
    if (next !== undefined && !(e.key === 'Home' || e.key === 'End')) {
      e.preventDefault()
      setActiveKey(next)
      return
    }
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !pivot && active?.type === 'entry') {
      e.preventDefault()
      runPrimary(active)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      void runItem(active, e.ctrlKey || e.metaKey)
      return
    }
    if (e.key === 'Tab' && !e.shiftKey && !pivot && active?.type === 'entry') {
      e.preventDefault()
      void startPivot(active)
      return
    }
    if (pivot && ((e.key === 'Tab' && e.shiftKey) || e.key === 'Escape' || (e.key === 'Backspace' && !pivotFilter))) {
      e.preventDefault()
      e.stopPropagation()
      const back = pivot
      setPivot(null)
      setPivotFilter('')
      setActiveKey(back.key)
      return
    }
  }

  const placeholder = pivot
    ? `Filter actions for ${pivot.name}`
    : actionsMode
      ? 'Type an action…'
      : scope === 'dn'
        ? 'Distinguished name or ldap:// URL'
        : 'Name, DN, LDAP URL — or > for actions'

  const renderItem = (item: Item, isActive: boolean): ReactNode => {
    if (item.type === 'dn') {
      return (
        <>
          <Navigation size={16} strokeWidth={1.75} aria-hidden className="text-primary shrink-0" />
          <span className="flex-1 min-w-0 truncate font-mono text-sm">{item.dn}</span>
          {dnBusy && isActive && <Spinner size="sm" label="Checking DN" />}
        </>
      )
    }
    if (item.type === 'command') {
      const c = item.rc
      return (
        <>
          <span className={cn('w-4 flex justify-center shrink-0', c.danger ? 'text-destructive' : 'text-muted-foreground')}>{renderIcon(c.command.icon, 16)}</span>
          <span className={cn('flex-1 min-w-0 truncate', !c.enabled && 'text-disabled-foreground', c.danger && c.enabled && 'text-destructive')}>
            {item.title}
            {/* A toggle's visible On / Off is read already; only "current" needs words (RW2-N-08). */}
            {c.checked && !c.command.toggle && <span className="sr-only"> (current)</span>}
          </span>
          {c.command.toggle ? (
            <span className="text-xs text-muted-foreground">{c.checked ? 'On' : 'Off'}</span>
          ) : (
            c.checked && <span className="text-xs text-muted-foreground">Current</span>
          )}
          {!c.enabled && <span className="text-xs text-disabled-foreground">{c.disabledReason ?? 'Not available'}</span>}
          {c.shortcut && <Kbd shortcut={c.shortcut} bare />}
        </>
      )
    }
    if (item.type === 'profile') {
      return (
        <>
          <span className="w-4 flex justify-center shrink-0 text-muted-foreground">
            {item.connected ? <ArrowRightLeft size={16} strokeWidth={1.75} aria-hidden /> : <Plug size={16} strokeWidth={1.75} aria-hidden />}
          </span>
          <span className="flex-1 min-w-0 truncate text-sm">{item.title}</span>
          <span className="truncate text-xs text-muted-foreground font-mono max-w-[40%]">{item.detail}</span>
        </>
      )
    }
    const kind = resolveObjectKind(item.objectClass)
    const status = item.statuses && item.statuses.length ? item.statuses.find((s) => s.kind === primaryStatus(item.statuses)) : undefined
    const parent = parentDn(item.dn)
    return (
      <>
        {item.stale ? (
          <TriangleAlert size={16} strokeWidth={1.75} aria-hidden className="text-warning shrink-0" />
        ) : item.objectClass ? (
          <ObjectIcon kind={kind} status={item.statuses} size={16} />
        ) : item.source === 'bookmark' ? (
          <Star size={16} strokeWidth={1.75} aria-hidden className="text-warning shrink-0" />
        ) : (
          <History size={16} strokeWidth={1.75} aria-hidden className="text-muted-foreground shrink-0" />
        )}
        <span className="flex-1 min-w-0 flex items-baseline gap-2">
          <span className={cn('truncate text-sm min-w-[8ch]', item.stale ? 'text-muted-foreground line-through' : 'text-foreground')}>{item.name}</span>
          {item.detail && <span className="truncate text-xs text-muted-foreground min-w-[4ch]">{item.detail}</span>}
          {item.stale && <span className="sr-only">, not found</span>}
          <span className="truncate text-xs text-muted-foreground font-mono">{item.stale ? 'not found' : parent ? rdnValue(parent) : ''}</span>
        </span>
        {status && <StatusChip status={status} compact className="shrink-0" />}
        {isActive && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
            <Kbd>Tab</Kbd> actions
          </span>
        )}
      </>
    )
  }

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* The input has no border of its own: the row draws the text-field focus edge (SPEC 4.6). */}
      <div className="flex items-center gap-2 px-3 h-10 border-b border-border shrink-0 rounded-t-lg focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring">
        {pivot ? (
          <button type="button"
            aria-label="Back to results"
            tabIndex={-1}
            onClick={() => {
              setPivot(null)
              inputRef.current?.focus()
            }}
            className="inline-flex items-center justify-center size-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
          >
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
          </button>
        ) : (
          <Search size={16} strokeWidth={1.75} aria-hidden className="text-muted-foreground shrink-0" />
        )}
        {pivot && (
          <span className="flex items-center gap-1 text-sm text-foreground shrink-0 max-w-[40%]">
            <span className="truncate font-medium">{pivot.name}</span>
            <ChevronRight size={12} strokeWidth={1.75} aria-hidden className="text-muted-foreground" />
          </span>
        )}
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeKey ? optionDomId(listId, activeKey) : undefined}
          aria-label={pivot ? `Actions for ${pivot.name}` : 'Go to anything'}
          spellCheck={false}
          autoComplete="off"
          value={pivot ? pivotFilter : query}
          placeholder={placeholder}
          onChange={(e) => {
            setDnError(null)
            if (pivot) setPivotFilter(e.target.value)
            else setQuery(e.target.value)
          }}
          onKeyDown={onKeyDown}
          className={cn('flex-1 min-w-0 h-full bg-transparent outline-hidden text-base placeholder:text-muted-foreground', (scope === 'dn' || parsed.kind !== 'text') && !actionsMode && 'font-mono text-sm')}
        />
        {loading && <Spinner size="sm" label="Searching" />}
      </div>
      {!pivot && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0">
          <SegmentedControl
            aria-label="Search scope"
            options={SCOPES}
            value={actionsMode && scope !== 'actions' ? 'actions' : scope}
            onValueChange={(s) => {
              setDnError(null)
              setScope(s)
              if (s !== 'actions' && query.trimStart().startsWith('>')) setQuery(query.trimStart().slice(1))
              inputRef.current?.focus()
            }}
          />
          {!connected && !actionsMode && <span className="text-xs text-muted-foreground truncate">Not connected — actions only</span>}
          {connected && profile && !actionsMode && <span className="text-xs text-muted-foreground truncate ml-auto">{profile.name}</span>}
        </div>
      )}
      {urlMismatch && !pivot && (
        <div className="px-3 pt-2 shrink-0">
          <InlineAlert
            tone="warning"
            title={`This URL points to ${urlMismatch.host}`}
            body={
              urlTarget
                ? `The active connection is ${profile?.name} (${profile?.host}:${profile?.port}). Enter switches to ${urlTarget.name} and opens the DN there.`
                : `The active connection is ${profile?.name} (${profile?.host}:${profile?.port}). Enter opens the DN there.`
            }
            actionsBelow
            actions={urlMismatch.matches.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={p.id === urlTarget?.id ? 'primary' : 'secondary'}
                onClick={async () => {
                  const dn = parsed.kind === 'url' ? parsed.dn : ''
                  await connectProfile(p.id, { reveal: false })
                  if (useConnectionStore.getState().activeProfileId === p.id && dn) await goToDn(dn, false, p.id)
                }}
              >
                {profileActionTitle(p.name, statuses[p.id] === true)} and Open
              </Button>
            ))}
          />
        </div>
      )}
      {dnError && (
        <div className="px-3 pt-2 shrink-0">
          {dnError.kind === 'notFound' ? (
            <InlineAlert
              tone="danger"
              title="Entry not found"
              body={
                dnError.searching
                  ? 'Looking for the nearest existing parent…'
                  : dnError.parent
                    ? `Nearest existing parent: ${dnError.parent}`
                    : 'No parent of this DN exists on this connection.'
              }
              actions={
                dnError.parent ? (
                  <Button size="sm" variant="secondary" onClick={() => openEntry(dnError.parent!, false, dnError.profileId)}>
                    Open parent
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <InlineAlert tone="danger" body={dnError.text} />
          )}
        </div>
      )}
      {!dnError && searchError && (
        <div className="px-3 pt-2 shrink-0">
          <InlineAlert tone="danger" body={`Search failed: ${searchError}`} />
        </div>
      )}
      <div id={listId} role="listbox" aria-label="Results" className="flex-1 min-h-0 overflow-y-auto py-1">
        {groups.map((g) =>
          g.items.length ? (
            <div key={g.id} role="group" aria-labelledby={`${listId}-g-${g.id}`}>
              <div id={`${listId}-g-${g.id}`} role="presentation" className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground truncate">
                {g.label}
              </div>
              {g.items.map((item) => {
                const isActive = item.key === activeKey
                return (
                  <div
                    key={item.key}
                    id={optionDomId(listId, item.key)}
                    role="option"
                    aria-selected={isActive}
                    aria-disabled={item.type === 'command' && !item.rc.enabled ? true : undefined}
                    onPointerMove={() => !isActive && setActiveKey(item.key)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => void runItem(item, e.ctrlKey || e.metaKey)}
                    className={cn('flex items-center gap-2 h-8 mx-1 px-2 rounded-sm cursor-default select-none', isActive && 'bg-accent text-accent-foreground')}
                  >
                    {renderItem(item, isActive)}
                  </div>
                )
              })}
            </div>
          ) : null,
        )}
        {!flat.length && (
          <div className="px-3 py-3 text-sm text-muted-foreground" role="status">
            {loading
              ? 'Searching…'
              : pivotReading
                ? 'Reading the entry…'
                : actionsMode || pivot
                ? 'No matching actions'
                : !connected
                  ? 'Connect to a directory to search entries, or type > for actions.'
                  : nameQuery.length === 1
                    ? 'Type at least 2 characters'
                    : q
                      ? 'No matching entries'
                      : 'Type a name, a DN or an LDAP URL'}
          </div>
        )}
        {truncated && !pivot && !actionsMode && (
          <div className="px-3 py-1.5 text-xs text-muted-foreground">Showing the first 20 matches — refine the name to narrow down.</div>
        )}
      </div>
      <div className="flex items-center gap-3 px-3 h-8 border-t border-border text-xs text-muted-foreground shrink-0 overflow-hidden whitespace-nowrap">
        <span className="flex items-center gap-1">
          <Kbd>
            <CornerDownLeft size={11} strokeWidth={1.75} aria-hidden />
            <span className="sr-only">Enter</span>
          </Kbd>
          open
        </span>
        <span className="flex items-center gap-1">
          <Kbd shortcut="Mod+Enter" /> pin
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Tab</Kbd> actions
        </span>
        {activePrimary ? (
          // The hit's primary account verb (FIN-W-02) takes the place of the "> commands" hint.
          <span className="flex items-center gap-1 min-w-0">
            <Kbd shortcut="Shift+Enter" className="shrink-0" />
            <span className="truncate">{activePrimary.rc.title}</span>
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <Kbd>&gt;</Kbd> commands
          </span>
        )}
        <span className="flex items-center gap-1 ml-auto">
          <Kbd>Esc</Kbd> {pivot ? 'back' : 'close'}
        </span>
      </div>
    </div>
  )
}
