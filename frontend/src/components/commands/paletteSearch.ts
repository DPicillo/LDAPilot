/**
 * Go to anything (CommandPalette) — pure parts, tests/cmd.palette.test.ts:
 * the name search filters, connection matches, LDAP error kinds and LDAP URL
 * host checks.
 */
import { escapeFilterValue } from '../../lib/ldapFilter.ts'

/**
 * Name search: a prefix OR over the naming attributes, then — when that
 * finds nothing — a substring pass, so a surname ("Meier", "Weber") or a
 * word inside a name ("日本") is found too.
 * - Active Directory: (anr=v) (Ambiguous Name Resolution: prefix matches on
 *   name, displayName, givenName, sn, sAMAccountName, mail, …), then
 *   (|(cn=*v*)(displayName=*v*)).
 * - Other servers: (|(cn=v*)(displayName=v*)(sn=v*)(givenName=v*)(uid=v*)
 *   (mail=v*)(ou=v*)), then (|(cn=*v*)(displayName=*v*)(sn=*v*)).
 * Values are always escaped (RFC 4515), so * ( ) \ match literally.
 */
export function paletteNameFilters(query: string, ad: boolean): { first: string; fallback: string } {
  const v = escapeFilterValue(query.trim())
  if (ad) return { first: `(anr=${v})`, fallback: `(|(cn=*${v}*)(displayName=*${v}*))` }
  const prefix = ['cn', 'displayName', 'sn', 'givenName', 'uid', 'mail', 'ou'].map((a) => `(${a}=${v}*)`).join('')
  const contains = ['cn', 'displayName', 'sn'].map((a) => `(${a}=*${v}*)`).join('')
  return { first: `(|${prefix})`, fallback: `(|${contains})` }
}

/** Attributes the palette reads for a hit (names for ranking and the label). */
export const PALETTE_NAME_ATTRS = ['displayName', 'cn', 'name', 'ou', 'sn', 'givenName', 'sAMAccountName', 'uid', 'mail', 'userPrincipalName']

export interface PaletteProfile {
  id: string
  name: string
  host: string
  port: number
}

/** What the palette knows about the connections for ranking them. */
export interface ProfileRanking {
  /** The profile is connected. */
  connected?: (id: string) => boolean
  /** The active profile ("switch" never offers it). */
  activeId?: string | null
  /** Ranked first: the connection of the active tab when it is another one ("Switch to <tab's profile>"). */
  preferId?: string | null
}

/**
 * Connections for the typed text. Plain words match name or host (every
 * word, at most `max`). The verbs decide the order (RW3-N-01: a bare
 * "switch" listed the first five profiles of the file and preselected
 * "Connect to" a public server):
 * - "switch …": connected profiles other than the active one, the active
 *   tab's connection first; never a Connect (nothing when none matches).
 * - "connect …": not connected ones first, then the connected others.
 * - a bare verb lists all of them (no cap), a verb with words the matches.
 * Without a verb the connected ones come first, in file order otherwise.
 */
export function matchingProfiles<T extends PaletteProfile>(profiles: readonly T[], query: string, max = 5, rank: ProfileRanking = {}): T[] {
  const all = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!all.length) return []
  const words = all.filter((w) => !PROFILE_VERBS.has(w))
  const verb = all.includes('switch') ? 'switch' : all.includes('connect') ? 'connect' : null
  // "to" alone is no request.
  if (!words.length && !verb) return []
  const on = (p: T) => !!rank.connected?.(p.id)
  let list = words.length
    ? profiles.filter((p) => {
        const hay = `${p.name} ${p.host}`.toLowerCase()
        return words.every((w) => hay.includes(w))
      })
    : [...profiles]
  if (verb === 'switch' && rank.connected) list = list.filter((p) => on(p) && p.id !== rank.activeId)
  const score = (p: T) => {
    if (rank.preferId && p.id === rank.preferId && p.id !== rank.activeId) return 0
    if (verb === 'connect') return on(p) ? (p.id === rank.activeId ? 3 : 2) : 1
    return on(p) ? (p.id === rank.activeId ? 2 : 1) : 3
  }
  list = list.map((p, i) => ({ p, i, s: score(p) })).sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.p)
  return words.length ? list.slice(0, max) : list
}

const PROFILE_VERBS = new Set(['switch', 'connect', 'to'])

/** Title of a connection item: switching to a connected one, connecting otherwise. */
export function profileActionTitle(name: string, connected: boolean): string {
  return connected ? `Switch to ${name}` : `Connect to ${name}`
}

export type LdapErrorKind = 'noSuchObject' | 'invalidDN' | 'other'

/** Classifies a read error by its LDAP result (go-ldap text or code). */
export function ldapErrorKind(message: string): LdapErrorKind {
  const m = message.toLowerCase()
  if (/no such object|nosuchobject|code 32\b|result code 32\b|ldap result code 32/.test(m)) return 'noSuchObject'
  if (/invalid dn syntax|invaliddnsyntax|code 34\b|result code 34\b|ldap result code 34/.test(m)) return 'invalidDN'
  return 'other'
}

export interface UrlTarget {
  scheme: 'ldap' | 'ldaps'
  host: string
  port?: number
}

/**
 * True if an LDAP URL addresses this connection: same host (case-insensitive)
 * and, when the URL names a port, the same port (without one, ldap:// to an
 * LDAPS profile of that host is the same server). An empty host means "this
 * connection".
 */
export function urlMatchesProfile(url: UrlTarget, profile: Pick<PaletteProfile, 'host' | 'port'>): boolean {
  const norm = (h: string) => h.trim().toLowerCase().replace(/\.$/, '')
  if (!url.host) return true
  if (norm(url.host) !== norm(profile.host)) return false
  return url.port === undefined || url.port === profile.port
}
