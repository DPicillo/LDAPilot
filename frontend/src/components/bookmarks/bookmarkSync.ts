/**
 * Stable bookmark ids (RW3-R-01). A bookmark keeps the id the server gives
 * its entry for life — objectGUID (AD), nsUniqueId (389DS), entryUUID
 * (OpenLDAP) — and is found again by it after a rename or move made outside
 * LDAPilot (or while it was closed):
 *
 * - the id is taken from the loaded entry (`entry-loaded`: GetEntry reads
 *   "*" and "+"), else read quietly (`BrowserService.StableIDsOf`, unlogged
 *   base reads) for bookmarks that have none — new ones and the ones stored
 *   before ids existed (migration on the next connect);
 * - on connect every bookmark of the connection is checked once: a missing
 *   DN with an id is looked up (`FindByStableID`) and followed, one without
 *   is marked stale;
 * - a load that fails with noSuchObject (`entry-missing`, e.g. a click on
 *   the bookmark) follows the id at once.
 *
 * Following emits `entry-moved` (old → new DN): the bookmark re-keys itself,
 * open tabs re-key and reload, recent entries and the tree follow as after a
 * move made in the app.
 */
import { getBinding } from '../../lib/wails'
import { emitEntryEvent, sameDN } from '../../lib/entryEvents'
import { firstRDN, normalizeDN, parseRDN } from '../../lib/dn'
import { useBookmarkStore, stableIdFromAttributes, type Bookmark } from '../../stores/bookmarkStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { toast } from '../ui/Toast'

/** services.StableIDInfo */
export interface StableIDInfo {
  dn: string
  id?: string
  missing?: boolean
  error?: string
}

async function stableIDsOf(profileId: string, dns: string[]): Promise<StableIDInfo[] | null> {
  const svc = getBinding('BrowserService')
  if (!svc?.StableIDsOf) return null
  return svc.StableIDsOf(profileId, dns)
}

async function findByStableID(profileId: string, id: string): Promise<string> {
  const svc = getBinding('BrowserService')
  if (!svc?.FindByStableID) return ''
  return svc.FindByStableID(profileId, id)
}

const connected = (profileId: string) => useConnectionStore.getState().connectionStatuses[profileId] === true
const key = (profileId: string, dn: string) => `${profileId}\n${normalizeDN(dn)}`

/** Bookmarks whose id was already asked for in this session (one read each). */
const asked = new Set<string>()
/** Ids being followed right now (one lookup at a time per id). */
const following = new Map<string, Promise<string | null>>()

/**
 * Looks the bookmark's entry up by its stable id and follows it: emits
 * `entry-moved` when it is somewhere else now, clears the stale mark when it
 * is still there. Resolves to the current DN, or null when no entry has the
 * id (or the bookmark has none). `notify`: an info toast names the new place.
 */
export function followBookmark(bm: Pick<Bookmark, 'profileId' | 'dn' | 'stableId'>, opts: { notify?: boolean } = {}): Promise<string | null> {
  const id = bm.stableId
  if (!id || !connected(bm.profileId)) return Promise.resolve(null)
  const k = `${bm.profileId}\n${id}`
  const running = following.get(k)
  if (running) return running
  const p = (async () => {
    try {
      const dn = await findByStableID(bm.profileId, id)
      if (!dn) return null
      // The bookmark may have followed by another path meanwhile.
      const cur = useBookmarkStore.getState().bookmarks.find((b) => b.profileId === bm.profileId && b.stableId === id)
      const oldDN = cur?.dn ?? bm.dn
      if (sameDN(oldDN, dn)) {
        useBookmarkStore.getState().markStale(bm.profileId, [oldDN], false)
        return dn
      }
      emitEntryEvent('ldapilot:entry-moved', { profileId: bm.profileId, oldDN, newDN: dn })
      if (opts.notify) {
        const was = parseRDN(firstRDN(oldDN)).value || oldDN
        const now = parseRDN(firstRDN(dn)).value || dn
        toast.info(was === now ? `Bookmark followed: ${now} was moved` : `Bookmark followed: ${was} is now ${now}`, { detail: dn })
      }
      return dn
    } catch {
      return null
    } finally {
      following.delete(k)
    }
  })()
  following.set(k, p)
  return p
}

/** The stable id of an entry an open tab has loaded (no server read). */
function loadedStableId(profileId: string, dn: string): string | undefined {
  const es = useEditorStore.getState()
  const tab = es.tabs.find((t) => t.profileId === profileId && !!t.dn && sameDN(t.dn, dn))
  const entry = tab ? es.entries[tab.id] : undefined
  return stableIdFromAttributes(entry?.attributes)
}

/**
 * Checks bookmarks of a connected profile: stores the ids of the existing
 * ones and handles missing ones (follow by id, else stale). `all`: every
 * bookmark (connect); otherwise only those without an id that were not
 * asked for yet.
 */
async function checkBookmarks(profileId: string, all: boolean): Promise<void> {
  if (!connected(profileId)) return
  const list = useBookmarkStore.getState().bookmarks.filter((b) => b.profileId === profileId)
  const fromTabs: Record<string, string> = {}
  const toRead: Bookmark[] = []
  for (const b of list) {
    if (!all && (b.stableId || b.stale || asked.has(key(profileId, b.dn)))) continue
    const loaded = !b.stableId ? loadedStableId(profileId, b.dn) : undefined
    if (loaded && !all) fromTabs[b.dn] = loaded
    else toRead.push(b)
  }
  if (Object.keys(fromTabs).length) useBookmarkStore.getState().setStableIds(profileId, fromTabs)
  if (!toRead.length) return
  for (const b of toRead) asked.add(key(profileId, b.dn))
  let infos: StableIDInfo[] | null = null
  try {
    infos = await stableIDsOf(profileId, toRead.slice(0, 200).map((b) => b.dn))
  } catch {
    return
  }
  if (!infos) return
  const ids: Record<string, string> = {}
  const missing: Bookmark[] = []
  infos.forEach((info, i) => {
    const b = toRead[i]
    if (!b) return
    if (info.id) ids[b.dn] = info.id
    else if (info.missing) missing.push(b)
  })
  const store = useBookmarkStore.getState()
  if (Object.keys(ids).length) store.setStableIds(profileId, ids)
  // Existing entries are not stale (a mark from an earlier run that the entry outlived).
  const live = infos.filter((info) => !info.missing && !info.error).map((info) => info.dn)
  if (live.length) store.markStale(profileId, live, false)
  for (const b of missing) {
    const current = useBookmarkStore.getState().bookmarks.find((x) => x.profileId === profileId && sameDN(x.dn, b.dn))
    if (!current) continue
    const dn = current.stableId ? await followBookmark(current) : null
    if (!dn) useBookmarkStore.getState().markStale(profileId, [current.dn], true)
  }
}

let pending: ReturnType<typeof setTimeout> | null = null
const pendingProfiles = new Set<string>()
/** Coalesces id reads for new bookmarks (several adds in a row, Undo). */
function scheduleCheck(profileId: string) {
  pendingProfiles.add(profileId)
  if (pending) return
  pending = setTimeout(() => {
    pending = null
    const ids = [...pendingProfiles]
    pendingProfiles.clear()
    for (const id of ids) void checkBookmarks(id, false)
  }, 400)
}

let started = false

/** Starts the listeners once (imported for its side effect by the bookmark surfaces). */
export function startBookmarkSync(): void {
  if (started || typeof window === 'undefined') return
  started = true

  // The id of a loaded entry, free (the editor reads "*" and "+").
  window.addEventListener('ldapilot:entry-loaded', (e) => {
    const d = (e as CustomEvent<{ profileId?: string; dn?: string }>).detail
    if (!d?.profileId || !d.dn) return
    const bm = useBookmarkStore.getState().bookmarks.find((b) => b.profileId === d.profileId && sameDN(b.dn, d.dn!))
    if (!bm) return
    const id = loadedStableId(d.profileId, d.dn)
    if (id && id !== bm.stableId) useBookmarkStore.getState().setStableIds(d.profileId, { [bm.dn]: id })
  })

  // A bookmarked entry is gone from its DN: follow it by its id.
  window.addEventListener('ldapilot:entry-missing', (e) => {
    const d = (e as CustomEvent<{ profileId?: string; dn?: string }>).detail
    if (!d?.profileId || !d.dn) return
    const bm = useBookmarkStore.getState().bookmarks.find((b) => b.profileId === d.profileId && sameDN(b.dn, d.dn!))
    if (bm?.stableId) void followBookmark(bm, { notify: true })
  })

  // New bookmarks (any surface) get their id.
  useBookmarkStore.subscribe((s, prev) => {
    if (s.bookmarks === prev.bookmarks) return
    const before = new Set(prev.bookmarks.map((b) => key(b.profileId, b.dn)))
    for (const b of s.bookmarks) {
      if (!b.stableId && !b.stale && !before.has(key(b.profileId, b.dn)) && connected(b.profileId)) scheduleCheck(b.profileId)
    }
  })

  // Every connect checks the connection's bookmarks once (migration of old ones, outside renames).
  let statuses = { ...useConnectionStore.getState().connectionStatuses }
  const onStatuses = (next: Record<string, boolean>) => {
    for (const [id, on] of Object.entries(next)) {
      if (on && statuses[id] !== true && useBookmarkStore.getState().bookmarks.some((b) => b.profileId === id)) {
        // After the tree's first reads.
        setTimeout(() => void checkBookmarks(id, true), 1500)
      }
    }
    statuses = { ...next }
  }
  onStatuses(useConnectionStore.getState().connectionStatuses)
  useConnectionStore.subscribe((s, prev) => {
    if (s.connectionStatuses !== prev.connectionStatuses) onStatuses(s.connectionStatuses)
  })
}

startBookmarkSync()
