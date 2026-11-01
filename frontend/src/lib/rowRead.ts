/**
 * One GetEntry per (profile, DN) for the result views that re-read a row
 * after an account action or a rename: the bottom panel's results
 * (searchSelectionStore) and every results tab holding the row
 * (components/search/resultsSnapshots) share it within 1.5 s, so "Open
 * Results as Tab" next to the panel does not read the entry twice.
 *
 * A new `ldapilot:account-changed` / `ldapilot:entry-moved` of the DN drops
 * the shared read (this module's listener is registered before the views'
 * ones, which read 300 ms later), so a read never carries the state from
 * before a later action.
 */
import type { LDAPEntry } from '../types/ldap'
import * as wails from './wails'
import { normalizeDN } from './dn'
import { createSharedReader } from './sharedRead'

const keyOf = (profileId: string, dn: string) => `${profileId}\n${normalizeDN(dn)}`
/** The DN as the caller spelled it (the key is normalized). */
const spelled = new Map<string, string>()
const reader = createSharedReader<LDAPEntry | null>((k) => {
  const i = k.indexOf('\n')
  return wails.GetEntry(k.slice(0, i), spelled.get(k) ?? k.slice(i + 1))
})

/** GetEntry shared by the result views re-reading the same row. */
export function readRowEntryShared(profileId: string, dn: string): Promise<LDAPEntry | null> {
  const k = keyOf(profileId, dn)
  spelled.set(k, dn)
  if (spelled.size > 200) spelled.delete(spelled.keys().next().value as string)
  return reader.read(k)
}

if (typeof window !== 'undefined') {
  const forget = (profileId?: string, dn?: string) => {
    if (profileId && dn) reader.forget(keyOf(profileId, dn))
  }
  window.addEventListener('ldapilot:account-changed', (e) => {
    const d = (e as CustomEvent<{ profileId?: string; dn?: string }>).detail
    forget(d?.profileId, d?.dn)
  })
  window.addEventListener('ldapilot:entry-moved', (e) => {
    const d = (e as CustomEvent<{ profileId?: string; oldDN?: string; newDN?: string }>).detail
    forget(d?.profileId, d?.oldDN)
    forget(d?.profileId, d?.newDN)
  })
}
