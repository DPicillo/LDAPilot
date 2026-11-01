/**
 * Persistent password-write toasts per entry ("stored in cleartext", "will
 * not work"): a later successful password write of the same entry
 * dismisses them (ACCT-10), so a fixed problem does not stay on screen.
 */
import { normalizeDN } from '../../lib/dn.ts'
import { toast } from '../ui/Toast'

const open = new Map<string, Set<string>>()

const key = (profileId: string, dn: string) => `${profileId}\n${normalizeDN(dn)}`

/** Remembers a persistent password toast of the entry. */
export function rememberPasswordWarning(profileId: string, dn: string, toastId: string): void {
  const k = key(profileId, dn)
  const ids = open.get(k) ?? new Set<string>()
  ids.add(toastId)
  open.set(k, ids)
}

/** Dismisses the entry's password warning toasts (after a successful password write or removal). */
export function dismissPasswordWarnings(profileId: string, dn: string): void {
  const k = key(profileId, dn)
  const ids = open.get(k)
  if (!ids) return
  for (const id of ids) toast.dismiss(id)
  open.delete(k)
}
