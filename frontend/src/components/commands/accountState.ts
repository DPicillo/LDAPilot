/**
 * Account status for the command registry: the server reads behind the
 * account verbs' when()/title() and the refresh after an account action.
 *
 * when()/title() are synchronous: they use accountStatusCache (server
 * status), else the selection item's evidence, and start ONE server read per
 * entry (prefetchAccountStatus); the registry re-resolves every open surface
 * when it arrives (notifyCommandsChanged). 'na' (no account status for this
 * entry) and 'failed' are kept for a minute so a surface that re-resolves
 * never loops on reads. Handlers always read the status again before writing.
 */
import { cachedAccountStatus, forgetAccountStatus, rememberAccountStatus } from '../../stores/accountStatusCache'
import { normalizeDN } from '../../lib/dn'
import { emitAccountChanged, readAccountStatusShared } from '../../lib/wails-account'
import type { AccountStatus } from '../../types/account'
import { notifyCommandsChanged, type CommandContext } from '../ui/commands'
import { accountDisplayState, type AccountDisplayState, type StatusReadState } from './accountDisplay'

type StatusRead = { state: 'pending' | 'failed' | 'na'; at: number }
const statusReads = new Map<string, StatusRead>()
const STATUS_RETRY_MS = 60_000

export const readKey = (profileId: string, dn: string) => `${profileId}\n${normalizeDN(dn)}`

export function statusReadState(profileId: string, dn: string): StatusReadState {
  const k = readKey(profileId, dn)
  const r = statusReads.get(k)
  if (r && r.state !== 'pending' && Date.now() - r.at > STATUS_RETRY_MS) {
    statusReads.delete(k)
    return undefined
  }
  return r?.state
}

/**
 * Reads the server account status of one entry for the menus (once; `force`
 * reads again even when a status is cached: the palette pivot, whose search
 * hit is fresher than an older cached status). Never from inside a render:
 * the read starts in a timeout.
 */
export function prefetchAccountStatus(profileId: string, dn: string, force = false) {
  const k = readKey(profileId, dn)
  if (force) {
    if (statusReads.get(k)?.state === 'pending') return
    forgetAccountStatus(profileId, dn)
    statusReads.delete(k)
  } else if (statusReadState(profileId, dn) || cachedAccountStatus(profileId, dn)) {
    return
  }
  statusReads.set(k, { state: 'pending', at: Date.now() })
  setTimeout(() => {
    // Shared: right after an account change the menus re-resolve while afterAccountChange's
    // read runs; they take that read instead of a second one (RW1-P-06).
    readAccountStatusShared(profileId, dn, force ? 0 : undefined)
      .then((st) => {
        if (!st) throw new Error('not available')
        rememberAccountStatus(profileId, st)
        // Also under the DN as selected (the server may spell it differently), so the next lookup hits.
        if (normalizeDN(st.dn) !== normalizeDN(dn)) rememberAccountStatus(profileId, { ...st, dn })
        if (st.applicable) statusReads.delete(k)
        else statusReads.set(k, { state: 'na', at: Date.now() })
      })
      .catch(() => statusReads.set(k, { state: 'failed', at: Date.now() }))
      .finally(notifyCommandsChanged)
  }, 0)
}

/**
 * Display state of the single selected entry. Starts the server read when
 * nothing authoritative is known (connected only).
 */
export function accountDisplay(ctx: CommandContext): AccountDisplayState & { canRead: boolean } {
  const item = ctx.selection.length === 1 ? ctx.selection[0] : undefined
  const st = cachedAccountStatus(ctx.profileId, item?.dn)
  const canRead = !!(ctx.profileId && item && ctx.connected)
  if (!st && canRead) prefetchAccountStatus(ctx.profileId!, item!.dn)
  const read = ctx.profileId && item ? statusReadState(ctx.profileId, item.dn) : undefined
  return { ...accountDisplayState(st, item?.status, read), canRead }
}

/**
 * After a successful account or password action: read the status again
 * (cache), re-resolve the menus and tell the views (tree overlay, results,
 * reports, Contents list, open tabs) with ldapilot:account-changed.
 */
export function afterAccountChange(profileId: string, dn: string): Promise<void> {
  // Two callers after the same write (a dialog and the command that opened it)
  // share one read and one event (RW1-P-06).
  const k = readKey(profileId, dn)
  const running = afterRuns.get(k)
  if (running && Date.now() - running.at < AFTER_SHARE_MS) return running.promise
  const promise = runAfterAccountChange(profileId, dn).finally(() => {
    if (afterRuns.get(k)?.promise === promise) afterRuns.delete(k)
  })
  afterRuns.set(k, { at: Date.now(), promise })
  return promise
}

const afterRuns = new Map<string, { at: number; promise: Promise<void> }>()
const AFTER_SHARE_MS = 500

async function runAfterAccountChange(profileId: string, dn: string): Promise<void> {
  const k = readKey(profileId, dn)
  statusReads.delete(k)
  forgetAccountStatus(profileId, dn)
  let fresh: AccountStatus | null = null
  try {
    // A new read the views reacting to the event share (RW1-P-06).
    const st = await readAccountStatusShared(profileId, dn, 0)
    if (st) {
      fresh = normalizeDN(st.dn) !== normalizeDN(dn) ? { ...st, dn } : st
      rememberAccountStatus(profileId, st)
      if (!st.applicable) statusReads.set(k, { state: 'na', at: Date.now() })
    }
  } catch {
    /* the next surface reads it again */
  }
  // The one §0.1 emitter (lib/wails-account): caches the fresh status (or drops
  // the old one), recomputes command titles, dispatches ldapilot:account-changed.
  emitAccountChanged(profileId, dn, fresh)
}
