/**
 * Which attributes an entry has, for the menus (key: profile + DN): one
 * base-scope, types-only read (BrowserService.AttributesPresent: no values
 * are transferred, not written to the operation log, never the status bar's
 * last operation) of the photo, certificate and login attribute names. Used
 * by Download Photo / Certificate and by the kind rule "an LDAP person
 * without uid or password is a contact". Failures are kept for a minute so a
 * surface that re-resolves never loops on reads.
 */
import { AttributesPresent, LoginAttributesOf } from '../../lib/wails-binary'
import { onAccountChanged } from '../../lib/wails-account'
import { readLoginAttributesShared } from '../../lib/loginRead'
import { notifyCommandsChanged } from '../ui/commands'
import { KIND_ATTRIBUTES, kindNeedsAttributes } from '../ui/objectKind'
import { readKey } from './accountState'

export const PHOTO_ATTRS = ['thumbnailPhoto', 'jpegPhoto', 'photo']
export const CERT_ATTRS = ['userCertificate', 'userCertificate;binary', 'userSMIMECertificate']
const PRESENCE_ATTRS = [...PHOTO_ATTRS, ...CERT_ATTRS, ...KIND_ATTRIBUTES]

type Presence = { state: 'pending' } | { state: 'done'; present: string[] } | { state: 'failed'; at: number }
const presence = new Map<string, Presence>()
const PRESENCE_MAX = 300
const RETRY_MS = 60_000

/** Present attribute names (the read asked for PRESENCE_ATTRS), 'pending', or undefined (not read / failed). */
export function presentAttributes(profileId: string, dn: string): string[] | 'pending' | undefined {
  const p = presence.get(readKey(profileId, dn))
  if (!p || p.state === 'failed') return undefined
  return p.state === 'pending' ? 'pending' : p.present
}

export function prefetchPresence(profileId: string, dn: string) {
  const key = readKey(profileId, dn)
  const cur = presence.get(key)
  if (cur && !(cur.state === 'failed' && Date.now() - cur.at > RETRY_MS)) return
  presence.set(key, { state: 'pending' })
  if (presence.size > PRESENCE_MAX) presence.delete(presence.keys().next().value!)
  // Not from inside a render (when() runs while menus render).
  setTimeout(() => {
    AttributesPresent(profileId, dn, PRESENCE_ATTRS)
      .then((present) => presence.set(key, { state: 'done', present: present ?? [] }))
      .catch(() => presence.set(key, { state: 'failed', at: Date.now() }))
      .finally(notifyCommandsChanged)
  }, 0)
}

/** A value changed (upload): read the presence again next time. */
export function forgetPresence(profileId: string, dn: string) {
  presence.delete(readKey(profileId, dn))
}

export function hasAnyAttribute(present: readonly string[], names: readonly string[]): boolean {
  const have = new Set(present.map((n) => n.toLowerCase().split(';')[0]))
  return names.some((n) => have.has(n.toLowerCase().split(';')[0]))
}

// --- Login attributes of many rows (M-06) --------------------------------------------------

/**
 * Search results, group members pickers: an LDAP person without an account
 * class is a contact when it has none of the login attributes. One batched
 * Go call (types-only base reads, not logged) for the rows that need it;
 * views re-render via subscribeLoginAttributes.
 */
const logins = new Map<string, string[] | 'pending' | { failedAt: number }>()
const LOGINS_MAX = 2000
const loginListeners = new Set<() => void>()
let loginVersion = 0

/** Known login attribute names of dn (also from the menus' presence read), else undefined. */
export function knownLoginAttributes(profileId: string, dn: string): string[] | undefined {
  const v = logins.get(readKey(profileId, dn))
  if (Array.isArray(v)) return v
  const p = presentAttributes(profileId, dn)
  return Array.isArray(p) ? p : undefined
}

export function subscribeLoginAttributes(fn: () => void): () => void {
  loginListeners.add(fn)
  return () => {
    loginListeners.delete(fn)
  }
}
export const loginAttributesVersion = () => loginVersion

/**
 * Reads the login attributes of the person-like rows whose kind is not known
 * yet; resolves when they are known (or failed). Rows that do not need it
 * (no person class, an account class) are skipped.
 */
export function ensureLoginAttributes(profileId: string, rows: readonly { dn: string; objectClass?: readonly string[] | null }[]): Promise<void> {
  const now = Date.now()
  const dns: string[] = []
  for (const r of rows) {
    if (!kindNeedsAttributes(r.objectClass)) continue
    const k = readKey(profileId, r.dn)
    const v = logins.get(k)
    if (v === 'pending' || Array.isArray(v) || (v && now - v.failedAt < RETRY_MS)) continue
    if (Array.isArray(presentAttributes(profileId, r.dn))) continue
    logins.set(k, 'pending')
    dns.push(r.dn)
  }
  if (!dns.length) return Promise.resolve()
  while (logins.size > LOGINS_MAX) logins.delete(logins.keys().next().value!)
  return (async () => {
    for (let i = 0; i < dns.length; i += 500) {
      const chunk = dns.slice(i, i + 500)
      try {
        const res = await LoginAttributesOf(profileId, chunk)
        for (const dn of chunk) logins.set(readKey(profileId, dn), res[dn] ?? { failedAt: Date.now() })
      } catch {
        for (const dn of chunk) logins.set(readKey(profileId, dn), { failedAt: Date.now() })
      }
      loginVersion++
      loginListeners.forEach((l) => l())
    }
    notifyCommandsChanged()
  })()
}

/** ensureLoginAttributes outside a render (views re-render via subscribeLoginAttributes). */
export function prefetchLoginAttributes(profileId: string, rows: readonly { dn: string; objectClass?: readonly string[] | null }[]): void {
  setTimeout(() => void ensureLoginAttributes(profileId, rows).catch(() => {}), 0)
}

// --- A first password, a removed one (ldapilot:account-changed) -----------------------------

/**
 * An account or password action can give an LDAP person its first login
 * attribute (Set Password… makes a contact a user) or take its last one
 * (Remove Value): what the menus and the rows remembered about the entry is
 * read again, so they show the new kind without a refresh. The tree row
 * follows in stores/treeStore (the same shared read), an open tab with its
 * reload.
 */
onAccountChanged(({ profileId, dn }) => {
  const key = readKey(profileId, dn)
  const known = Array.isArray(logins.get(key)) || presence.get(key)?.state === 'done'
  // The menus' own read (photo, certificate, login names) is repeated by the next menu.
  presence.delete(key)
  if (!known) return
  readLoginAttributesShared(profileId, dn)
    .then((names) => {
      if (names) logins.set(key, names)
      else logins.delete(key)
    })
    .catch(() => logins.delete(key))
    .finally(() => {
      loginVersion++
      loginListeners.forEach((l) => l())
      notifyCommandsChanged()
    })
})
