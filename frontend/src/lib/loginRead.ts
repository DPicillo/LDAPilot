/**
 * The login attribute names (uid, userPassword, …) of one entry, read again
 * after an account or password action (`ldapilot:account-changed`): a first
 * password makes an LDAP person without a login a user (Set Password…),
 * removing its last login attribute a contact again. The tree row
 * (stores/treeStore) and the caches behind result rows and menus
 * (components/commands/presence) share one types-only, unlogged read per
 * (profile, DN) within 1.5 s.
 *
 * A new `ldapilot:account-changed` of the DN drops the shared read (this
 * module's listener is registered before its users' ones), so a read never
 * carries the names from before a later action.
 */
import { normalizeDN } from './dn'
import { createSharedReader } from './sharedRead'
import { LoginAttributesOf } from './wails-binary'

const keyOf = (profileId: string, dn: string) => `${profileId}\n${normalizeDN(dn)}`
/** The DN as the caller spelled it (the key is normalized; the answer is keyed by the DN as given). */
const spelled = new Map<string, string>()
const reader = createSharedReader<string[] | undefined>(async (k) => {
  const i = k.indexOf('\n')
  const dn = spelled.get(k) ?? k.slice(i + 1)
  return (await LoginAttributesOf(k.slice(0, i), [dn]))[dn]
})

/** The login attribute names dn has now ([] = none: a contact); undefined when the entry cannot be read. */
export function readLoginAttributesShared(profileId: string, dn: string): Promise<string[] | undefined> {
  const k = keyOf(profileId, dn)
  spelled.set(k, dn)
  if (spelled.size > 200) spelled.delete(spelled.keys().next().value as string)
  return reader.read(k)
}

if (typeof window !== 'undefined') {
  window.addEventListener('ldapilot:account-changed', (e) => {
    const d = (e as CustomEvent<{ profileId?: string; dn?: string }>).detail
    if (d?.profileId && d.dn) reader.forget(keyOf(d.profileId, d.dn))
  })
}
