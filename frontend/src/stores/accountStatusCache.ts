import type { AccountStatus } from '../types/account'
import type { AccountStatusKind } from '../components/ui/accountStatus'
import { getParentDN, normalizeDN } from '../lib/dn.ts'

/**
 * Last account status read from the server per entry (GetAccountStatus:
 * EntryEditor, the tree's account quick actions, account commands). The
 * command registry's when()/title() run synchronously; they use this
 * authoritative status when it is known and fall back to the status derived
 * from the entry's attributes (ui/accountStatus.ts) otherwise. Handlers
 * always read the status again before they write.
 */
const cache = new Map<string, AccountStatus>()
const MAX = 200
const listeners = new Set<() => void>()
let version = 0

function changed() {
  version++
  listeners.forEach((l) => l())
}

/** Re-render when a status is remembered or forgotten (views showing cached states: Contents list chips). Returns the disposer. */
export function subscribeAccountStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Changes with every remember / forget (useSyncExternalStore snapshot). */
export function accountStatusVersion(): number {
  return version
}

// Normalized (case, blanks around ',' and '='): the AI and the server may
// spell a DN differently from the tree.
const key = (profileId: string, dn: string) => `${profileId}\n${normalizeDN(dn)}`

export function rememberAccountStatus(profileId: string, status: AccountStatus | null | undefined): void {
  if (!status?.dn) return
  const k = key(profileId, status.dn)
  cache.delete(k)
  cache.set(k, status)
  if (cache.size > MAX) cache.delete(cache.keys().next().value!)
  changed()
}

export function cachedAccountStatus(profileId: string | null | undefined, dn: string | undefined): AccountStatus | undefined {
  // Lists ask for every row: no DN normalization while nothing is remembered.
  if (!profileId || !dn || cache.size === 0) return undefined
  const st = cache.get(key(profileId, dn))
  return st?.applicable ? st : undefined
}

export function forgetAccountStatus(profileId: string, dn: string): void {
  if (cache.delete(key(profileId, dn))) changed()
}

/**
 * The rows of a fresh search: their remembered states go, so the attributes
 * the search just returned decide (a lockout made outside the app while an
 * older "not locked" was cached, RW2-P-01).
 */
export function forgetAccountStatuses(profileId: string, dns: readonly string[]): void {
  let dropped = false
  for (const dn of dns) if (cache.delete(key(profileId, dn))) dropped = true
  if (dropped) changed()
}

/**
 * An explicit re-read of listings (F5 on a container, Contents ↻, Refresh
 * Tree): the remembered states of their rows go, so the fresh listing's
 * states (a lockout made outside the app) show instead of an older "not
 * locked" (RW2-P-01). `parents` are the reloaded containers.
 */
export function forgetAccountStatusesUnder(profileId: string, ...parents: string[]): void {
  if (!parents.length) return
  const keys = new Set(parents.map((p) => normalizeDN(p)))
  const prefix = `${profileId}\n`
  let dropped = false
  for (const k of [...cache.keys()]) {
    if (!k.startsWith(prefix)) continue
    const dn = cache.get(k)?.dn
    if (dn && keys.has(normalizeDN(getParentDN(dn)))) {
      cache.delete(k)
      dropped = true
    }
  }
  if (dropped) changed()
}

/** The status kinds (StatusChip / command predicates) of a server status. */
export function accountStatusKinds(st: AccountStatus): AccountStatusKind[] {
  const out: AccountStatusKind[] = []
  if (st.locked) out.push('locked')
  if (!st.enabled) out.push('disabled')
  if (st.accountExpired) out.push('expired')
  if (st.passwordExpired) out.push('pwdExpired')
  if (st.mustChangePassword) out.push('mustChange')
  if (st.passwordNeverExpires) out.push('pwdNeverExpires')
  return out
}

/** Status kinds of the cached server status, undefined when it is not known. */
export function cachedAccountStatusKinds(profileId: string | null | undefined, dn: string | undefined): AccountStatusKind[] | undefined {
  const st = cachedAccountStatus(profileId, dn)
  return st ? accountStatusKinds(st) : undefined
}
