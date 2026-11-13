/**
 * Connection health (SPEC 7.7). Mounted once (AppLayout).
 *
 * - Pings the active profile every 30 s while connected (healthy only), and
 *   soon after an operation fails with a network-class error (toast history
 *   or the Go operation log stream), at most once per CHECK_MIN_INTERVAL_MS.
 * - A failed ping, or a failed RECONNECT entry of the Go client, marks the
 *   profile `lost`. A store flip to disconnected without either is
 *   user-initiated: no banner.
 * - Cooperates with the Go client's auto-reconnect (foundation F1): a ping IS
 *   an operation, so the backend re-dials a dropped connection during it (and
 *   logs RECONNECT). While `lost`, ONLY the backoff schedule pings: no health
 *   ping, no ping per failed operation or RECONNECT entry (each ping is a
 *   re-dial + bind; reacting to the RECONNECT it logs would loop and flood the
 *   DC). A successful RECONNECT / CONNECT of the profile's server restores.
 * - Auto-retry with backoff 2/4/8/16/30 s, 5 attempts, then manual only.
 *   Production builds only; `wails dev` is manual only while lost.
 * - A credential failure (Invalid Credentials, account locked/disabled) stops
 *   automatic attempts at once: repeated binds would lock the account out.
 * - An untrusted server certificate (it changed since the profile trusted
 *   it; the re-dial of a ping, an automatic attempt or the client's own
 *   RECONNECT fails with "untrusted TLS certificate") also stops them and
 *   opens the auth track's CertificateTrustPrompt (action 'reconnect')
 *   once: retrying cannot succeed until the user trusts or fixes it, and
 *   the prompt's retry restores the connection (CONNECT entry / store).
 * - "Reconnect now" calls connectionStore.reconnect(id); every Reconnect entry
 *   point (status bar, File menu, palette) goes through reconnectProfile().
 * - Every loss and restore goes into the notification history (no toast:
 *   the banner and the status bar already say it).
 * - Connections open but none active (after a page reload the pool still
 *   has them; or the active one was disconnected): the profile of the active
 *   editor tab becomes active, else the last active one (localStorage), else
 *   the first connected one (profileToActivate).
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { loadLastActiveProfile, useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { profileToActivate } from '../connection/profileLogic'
import { useToastStore } from '../ui/Toast'
import { notifyCommandsChanged, setOfflineProvider } from '../ui/commands'
import { isCredentialError } from '../../lib/connectionAuth'
import * as wails from '../../lib/wails'
import { CERTIFICATE_ERROR_MARKER, GetCertificateProblem, isCertificateError } from '../../lib/wails-auth'
import { useCertTrustStore } from '../../stores/certTrustStore'
import { onWailsEvent, saveLastUsedProfile, setLastOp } from './shellState'

export const PING_INTERVAL_MS = 30_000
export const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const
export const MAX_RETRY_ATTEMPTS = RETRY_DELAYS_MS.length
/** Minimum gap between pings caused by failing operations (checkConnectionSoon). */
export const CHECK_MIN_INTERVAL_MS = 5_000
/** Auto-retry only in production builds (the dev server restarts constantly). */
export const AUTO_RETRY = import.meta.env.PROD
/** Operation-log entries that are notes of the client itself, not a user's operation (status bar "last operation"). */
const INTERNAL_OPS = new Set(['PWPOLICY'])

export interface ConnectionHealth {
  /** Profile the state refers to (the active profile when it was lost). */
  profileId: string | null
  status: 'ok' | 'lost'
  /** Automatic attempts made so far. */
  attempt: number
  /** An attempt (automatic or manual) is running. */
  retrying: boolean
  /** When the next automatic attempt runs (ms epoch), null when none is scheduled. */
  nextRetryAt: number | null
  /** Auto-retry stopped (after MAX_RETRY_ATTEMPTS, or at once on a credential failure). */
  gaveUp: boolean
  /** Why auto-retry stopped. */
  stopReason: 'attempts' | 'credentials' | 'certificate' | null
  error: string | null
  lostAt: number | null
  /** Banner hidden by the user (status bar keeps the warning). */
  dismissed: boolean
}

const INITIAL: ConnectionHealth = {
  profileId: null,
  status: 'ok',
  attempt: 0,
  retrying: false,
  nextRetryAt: null,
  gaveUp: false,
  stopReason: null,
  error: null,
  lostAt: null,
  dismissed: false,
}

export const useConnectionHealth = create<ConnectionHealth>(() => ({ ...INITIAL }))

// While a connection is lost its write verbs hide in every menu and the palette
// (RW2-C-02: Reset Password… opened and failed with a raw dial error).
setOfflineProvider((profileId) => {
  const h = useConnectionHealth.getState()
  return h.status === 'lost' && h.profileId === profileId
})
useConnectionHealth.subscribe((h, prev) => {
  if (h.status !== prev.status || h.profileId !== prev.profileId) notifyCommandsChanged()
})

// --- Helpers -------------------------------------------------------------------

const NETWORK_ERROR =
  /network|connection (?:closed|reset|refused|lost|timed out)|closed network connection|broken pipe|\bEOF\b|i\/o timeout|no route to host|host is unreachable|not connected|server down|LDAP Result Code 200|deadline exceeded|reconnect failed/i

export function isNetworkError(text: string | undefined | null): boolean {
  return !!text && NETWORK_ERROR.test(text)
}

// The credential rule lives in lib/connectionAuth (the connection store's "Edit…" uses it too).
export { isCredentialError }

const GENERIC_PING_ERROR = 'The server did not answer a RootDSE read (health check).'

/**
 * Operation-log events carry no profile id (every started stream emits
 * "operation:log"). CONNECT / BIND / RECONNECT details name the server
 * ("Connection to host:port lost, ..."): only those of the active profile's
 * server count.
 */
function entryNamesProfileServer(details: string | undefined, profileId: string): boolean {
  const p = useConnectionStore.getState().profiles.find((x) => x.id === profileId)
  if (!p?.host || !details) return true
  const port = String(p.port ?? '')
  return details.includes(`${p.host}:${port}`) || details.includes(`[${p.host}]:${port}`)
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return 'Unknown error'
}

function profileName(id: string | null): string {
  if (!id) return 'server'
  return useConnectionStore.getState().profiles.find((p) => p.id === id)?.name || 'server'
}

const HISTORY_PREFIX = 'conn-watch-'

/** Adds an entry to the notification history without showing a toast. */
function addHistory(type: 'success' | 'error' | 'info', message: string, detail?: string, connection?: string) {
  const entry = {
    id: `${HISTORY_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    type,
    message,
    detail,
    duration: 0,
    timestamp: Date.now(),
    // The bell names the connection the entry is about (RW1-C-08).
    connection,
  }
  useToastStore.setState((s) => ({ history: [entry, ...s.history].slice(0, 200) }))
}

// --- Health transitions ----------------------------------------------------------

let retryTimer: ReturnType<typeof setTimeout> | undefined
let pingInFlight = false
let lastPingAt = 0

const isLost = (profileId: string) => {
  const h = useConnectionHealth.getState()
  return h.status === 'lost' && h.profileId === profileId
}

function clearRetry() {
  clearTimeout(retryTimer)
  retryTimer = undefined
}

/** Stops automatic attempts (credential failure): binding again would only count towards a lockout. */
function stopForCredentials(profileId: string) {
  if (!isLost(profileId)) return
  clearRetry()
  useConnectionHealth.setState({ gaveUp: true, stopReason: 'credentials', nextRetryAt: null })
}

/** Text of a recorded certificate problem, in the backend's error format. */
function certificateErrorText(p: { host?: string; reason?: string; pinnedChanged?: boolean } | null): string {
  // Like the backend's connect error: a changed pin says so (RW2-C-05).
  return `${CERTIFICATE_ERROR_MARKER} for ${p?.host || 'the server'}: ${p?.reason || 'the certificate is not trusted'}${p?.pinnedChanged ? ' (pinned certificate changed)' : ''}`
}

/**
 * Untrusted server certificate: no automatic attempt can succeed. Stops them
 * and shows the trust prompt once per loss. `recorded`: the failing call
 * recorded the problem for GetCertificateProblem (Ping, Reconnect); a
 * failure seen only in the client's RECONNECT entry is recorded first by one
 * ping (one more TLS handshake), so the prompt can show the chain.
 */
function stopForCertificate(profileId: string, recorded: boolean) {
  if (!isLost(profileId)) return
  clearRetry()
  const first = useConnectionHealth.getState().stopReason !== 'certificate'
  useConnectionHealth.setState({ gaveUp: true, stopReason: 'certificate', nextRetryAt: null })
  if (!first) return
  const open = () => {
    if (!isLost(profileId)) return
    const trust = useCertTrustStore.getState()
    if (trust.request?.profileId !== profileId) trust.open({ profileId, action: 'reconnect' })
  }
  if (recorded) open()
  else void wails.PingConnection(profileId).catch(() => false).finally(open)
}

/** Opens the certificate trust prompt again (banner action after Cancel). */
export function reviewCertificate() {
  const id = useConnectionHealth.getState().profileId ?? useConnectionStore.getState().activeProfileId
  if (id) useCertTrustStore.getState().open({ profileId: id, action: 'reconnect' })
}

function scheduleRetry(profileId: string) {
  clearRetry()
  const h = useConnectionHealth.getState()
  if (!AUTO_RETRY || h.status !== 'lost' || h.profileId !== profileId || h.stopReason === 'credentials' || h.stopReason === 'certificate') return
  if (h.attempt >= MAX_RETRY_ATTEMPTS) {
    useConnectionHealth.setState({ gaveUp: true, stopReason: 'attempts', nextRetryAt: null })
    return
  }
  const delay = RETRY_DELAYS_MS[h.attempt]
  useConnectionHealth.setState({ nextRetryAt: Date.now() + delay })
  retryTimer = setTimeout(() => void autoAttempt(profileId), delay)
}

/** `recorded`: the error comes from a call that recorded a certificate problem (see stopForCertificate). */
export function reportLost(profileId: string, error: string, recorded = false) {
  const h = useConnectionHealth.getState()
  if (h.status === 'lost' && h.profileId === profileId) {
    // Keep a specific cause (connection refused, Invalid Credentials) over the generic ping text.
    if (error !== GENERIC_PING_ERROR || !h.error) useConnectionHealth.setState({ error })
    if (isCredentialError(error)) stopForCredentials(profileId)
    else if (isCertificateError(error)) stopForCertificate(profileId, recorded)
    return
  }
  clearRetry()
  useConnectionHealth.setState({ ...INITIAL, profileId, status: 'lost', error, lostAt: Date.now() })
  addHistory('error', `Connection to ${profileName(profileId)} lost`, error, profileName(profileId))
  if (isCredentialError(error)) stopForCredentials(profileId)
  else if (isCertificateError(error)) stopForCertificate(profileId, recorded)
  else scheduleRetry(profileId)
}

/**
 * The lost profile works again. `toasted`: the caller's reconnect already
 * said so ("Reconnected to …" toast and bell entry): no second bell entry
 * (RW3-C-02).
 */
export function reportRestored(profileId: string, opts: { toasted?: boolean } = {}) {
  const h = useConnectionHealth.getState()
  if (h.status !== 'lost' || h.profileId !== profileId) return
  clearRetry()
  useConnectionHealth.setState({ ...INITIAL, profileId })
  if (!opts.toasted) addHistory('success', `Connection to ${profileName(profileId)} restored`, undefined, profileName(profileId))
}

function resetHealth() {
  clearRetry()
  useConnectionHealth.setState({ ...INITIAL })
}

/** Pings the profile; a failure marks it lost, a success restores it. */
async function ping(profileId: string): Promise<boolean | null> {
  if (pingInFlight) return null
  pingInFlight = true
  lastPingAt = Date.now()
  try {
    const ok = await wails.PingConnection(profileId)
    if (useConnectionStore.getState().activeProfileId !== profileId) return null
    if (ok) reportRestored(profileId)
    else {
      // The ping's re-dial records an untrusted certificate (ConnectionService.PingConnection).
      const problem = await GetCertificateProblem(profileId).catch(() => null)
      reportLost(profileId, problem ? certificateErrorText(problem) : GENERIC_PING_ERROR, !!problem)
    }
    return ok
  } catch (err) {
    if (useConnectionStore.getState().activeProfileId === profileId) reportLost(profileId, errText(err))
    return false
  } finally {
    pingInFlight = false
  }
}

/** One automatic attempt: ping (the backend re-dials), Reconnect only when the pool lost the client. */
async function autoAttempt(profileId: string) {
  const h = useConnectionHealth.getState()
  if (h.status !== 'lost' || h.profileId !== profileId || h.retrying) return
  useConnectionHealth.setState({ retrying: true, attempt: h.attempt + 1, nextRetryAt: null })
  let ok = false
  let error: string | null = null
  try {
    const inPool = await wails.GetConnectionStatus(profileId).catch(() => false)
    if (inPool) {
      lastPingAt = Date.now()
      ok = await wails.PingConnection(profileId)
      // The client's failed RECONNECT entry (operation log) usually carries the real cause;
      // an untrusted certificate is recorded by the ping itself.
      if (!ok) {
        const problem = await GetCertificateProblem(profileId).catch(() => null)
        error = problem ? certificateErrorText(problem) : null
      }
    } else {
      await wails.Reconnect(profileId)
      ok = true
    }
  } catch (err) {
    error = errText(err)
  }
  const cur = useConnectionHealth.getState()
  if (cur.status !== 'lost' || cur.profileId !== profileId) return
  useConnectionHealth.setState({ retrying: false })
  if (ok) {
    const cs = useConnectionStore.getState()
    if (cs.connectionStatuses[profileId] !== true) cs.updateStatus(profileId, true)
    reportRestored(profileId)
  } else {
    if (error) useConnectionHealth.setState({ error })
    const cause = error ?? useConnectionHealth.getState().error
    if (isCredentialError(cause)) stopForCredentials(profileId)
    // Ping and Reconnect both record the certificate problem.
    else if (isCertificateError(cause)) stopForCertificate(profileId, true)
    else scheduleRetry(profileId)
  }
}

/** "Reconnect now": the existing store action (toasts its result). */
export async function reconnectNow() {
  const id = useConnectionHealth.getState().profileId ?? useConnectionStore.getState().activeProfileId
  if (!id) return
  clearRetry()
  useConnectionHealth.setState({ retrying: true, nextRetryAt: null })
  try {
    // A failed attempt keeps the lost state (tree, banners, status bar agree; RW3-C-01).
    await useConnectionStore.getState().reconnect(id, { keepStatus: true })
    reportRestored(id, { toasted: true })
  } catch (err) {
    const h = useConnectionHealth.getState()
    if (h.status === 'lost' && h.profileId === id) {
      const error = errText(err)
      // The password prompt was cancelled: no automatic attempts without a password.
      if (wails.isConnectCancelled(err) && useConnectionStore.getState().connectionStatuses[id] !== true) {
        useConnectionHealth.setState({ retrying: false })
        stopForCredentials(id)
        return
      }
      if (isCredentialError(error)) {
        useConnectionHealth.setState({ retrying: false, error })
        stopForCredentials(id)
        return
      }
      if (isCertificateError(error)) {
        // connectionStore.reconnect already opened the trust prompt.
        useConnectionHealth.setState({ retrying: false, error, gaveUp: true, stopReason: 'certificate', nextRetryAt: null })
        return
      }
      // Manual attempts don't count towards the automatic budget; restart it.
      useConnectionHealth.setState({ retrying: false, error, attempt: 0, gaveUp: false, stopReason: null })
      scheduleRetry(id)
    } else {
      useConnectionHealth.setState({ retrying: false })
    }
  }
}

/**
 * Every Reconnect entry point (status bar, File ▸ Reconnect, palette, banner):
 * a lost profile goes through reconnectNow (health, banner, retry budget);
 * otherwise the store action, then the health state is confirmed.
 */
export async function reconnectProfile(profileId?: string | null) {
  const id = profileId ?? useConnectionStore.getState().activeProfileId
  if (!id) return
  if (isLost(id)) return reconnectNow()
  try {
    await useConnectionStore.getState().reconnect(id)
    reportRestored(id, { toasted: true })
  } catch {
    /* the store toasts the cause */
  }
}

export function dismissConnectionBanner() {
  useConnectionHealth.setState({ dismissed: true })
}

let checkTimer: ReturnType<typeof setTimeout> | undefined
/**
 * Ping the active profile soon (debounced) after a network-class failure.
 * Never while it is already lost (the retry schedule owns pings then) and at
 * most once per CHECK_MIN_INTERVAL_MS, so a stream of failing operations
 * cannot turn into a ping (= re-dial + bind) storm.
 */
export function checkConnectionSoon(delay = 400) {
  clearTimeout(checkTimer)
  checkTimer = setTimeout(() => {
    const cs = useConnectionStore.getState()
    const id = cs.activeProfileId
    if (!id || cs.connectionStatuses[id] !== true || isLost(id)) return
    const wait = lastPingAt + CHECK_MIN_INTERVAL_MS - Date.now()
    if (wait > 0) {
      checkConnectionSoon(wait)
      return
    }
    void ping(id)
  }, delay)
}

// --- Active profile -------------------------------------------------------------

/** Activates a connected profile when none is active (see the header). */
export function ensureActiveProfile() {
  const cs = useConnectionStore.getState()
  if (cs.activeProfileId) return
  const es = useEditorStore.getState()
  const tab = es.tabs.find((t) => t.id === es.activeTabId)
  const id = profileToActivate({
    activeProfileId: cs.activeProfileId,
    profiles: cs.profiles,
    statuses: cs.connectionStatuses,
    activeTabProfileId: tab?.profileId,
    lastActiveId: loadLastActiveProfile(),
  })
  if (id) cs.setActiveProfile(id)
}

// --- Hook ----------------------------------------------------------------------

export function useConnectionWatch() {
  useEffect(() => {
    // Health ping every 30 s while the active profile is connected and healthy
    // (lost: the retry schedule, or the user, decides; SPEC 7.7 "then manual only").
    const interval = setInterval(() => {
      const cs = useConnectionStore.getState()
      const id = cs.activeProfileId
      if (id && cs.connectionStatuses[id] === true && !isLost(id)) void ping(id)
    }, PING_INTERVAL_MS)

    const startStream = (id: string) => {
      wails.StartLogStream(id).catch(() => {})
    }

    // Store transitions: active profile changes, connects, user disconnects.
    ensureActiveProfile()
    const unsubConn = useConnectionStore.subscribe((s, prev) => {
      if (!s.activeProfileId && Object.values(s.connectionStatuses).some(Boolean)) {
        ensureActiveProfile()
        // An activation ran this listener again with the new state.
        if (useConnectionStore.getState().activeProfileId) return
      }
      const h = useConnectionHealth.getState()
      if (h.profileId && h.profileId !== s.activeProfileId) resetHealth()
      const id = s.activeProfileId
      if (!id) return
      const now = s.connectionStatuses[id] === true
      const before = prev.activeProfileId === id && prev.connectionStatuses[id] === true
      if (now && !before) {
        saveLastUsedProfile(id)
        startStream(id)
        reportRestored(id)
      }
    })
    {
      const cs = useConnectionStore.getState()
      if (cs.activeProfileId && cs.connectionStatuses[cs.activeProfileId]) startStream(cs.activeProfileId)
    }

    // Network-class failures reported by any feature (they all toast errors).
    let seen = new Set(useToastStore.getState().history.map((h) => h.id))
    const unsubToast = useToastStore.subscribe((s) => {
      let hit = false
      for (const e of s.history) {
        if (seen.has(e.id)) break
        if (e.type === 'error' && !e.id.startsWith(HISTORY_PREFIX) && (isNetworkError(e.message) || isNetworkError(e.detail))) hit = true
      }
      seen = new Set(s.history.map((h) => h.id))
      if (hit) checkConnectionSoon()
    })

    // The Go operation log: last operation for the status bar, network errors
    // and the client's own RECONNECT entries. Never ping in reaction to a
    // RECONNECT entry: the ping would re-dial and log the next one.
    // One event carries every entry logged within 50 ms (a bulk run logs thousands):
    // the status bar gets the last operation per profile once per event.
    const off = onWailsEvent('operation:log', (...data: unknown[]) => {
      const lastOps = new Map<string, wails.LogEntry>()
      const cs = useConnectionStore.getState()
      const id = cs.activeProfileId
      for (const entry of data as (wails.LogEntry | undefined)[]) {
        if (!entry || typeof entry.operation !== 'string') continue
        // Internal notes (password storage probe and policy notes) never become
        // the status bar's "last operation": it shows what the user did.
        // Per profile: every connected profile streams its log (RW1-C-03).
        const owner = entry.profileId || id
        if (owner && !INTERNAL_OPS.has(entry.operation.toUpperCase())) lastOps.set(owner, entry)
        if (!id || cs.connectionStatuses[id] !== true) continue
        // Connection health follows the active profile's own operations only.
        if (entry.profileId && entry.profileId !== id) continue
        const op = entry.operation.toUpperCase()
        if (op === 'RECONNECT' || op === 'CONNECT') {
          if (!entryNamesProfileServer(entry.details, id)) continue
          // The client (re-)dialed: success restores, a failed re-dial means lost (with the real cause).
          if (!entry.error) reportRestored(id)
          else if (op === 'RECONNECT') reportLost(id, entry.error)
          continue
        }
        if (entry.error && isNetworkError(entry.error)) checkConnectionSoon()
      }
      for (const [owner, e] of lastOps) {
        setLastOp(owner, { operation: e.operation, duration: e.duration, error: e.error, details: e.details, at: Date.now() })
      }
    })

    return () => {
      clearInterval(interval)
      clearTimeout(checkTimer)
      unsubConn()
      unsubToast()
      off()
    }
  }, [])
}
