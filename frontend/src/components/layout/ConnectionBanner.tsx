/**
 * Connection-lost banner (SPEC 7.7), the top slot of the main area:
 * "Connection to {name} lost — retrying in 4 s (attempt 2/5) · Reconnect now · Dismiss".
 *
 * Screen readers: the banner and the status bar are NOT live regions (their
 * countdown changes every second). ConnectionAnnouncer, one always-mounted
 * polite region, announces each state change once: lost, attempt n started,
 * stopped, restored. "Details" is a disclosure button that shows the error
 * inline (readable, selectable), not a tooltip-only text.
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw, ShieldX } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { Banner } from '../ui/InlineAlert'
import { Button } from '../ui/Button'
import { focusWorkAreaSoon } from '../editor/editorFocus'
import {
  AUTO_RETRY,
  MAX_RETRY_ATTEMPTS,
  dismissConnectionBanner,
  reconnectNow,
  reviewCertificate,
  useConnectionHealth,
  type ConnectionHealth,
} from './useConnectionWatch'

/** Seconds until `at`, re-rendered every second while counting down. */
function useCountdown(at: number | null): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!at) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [at])
  return at ? Math.max(0, Math.ceil((at - now) / 1000)) : null
}

/** Status text shared by the banner and the status bar. */
export function connectionRetryText(
  h: Pick<ConnectionHealth, 'retrying' | 'attempt' | 'gaveUp' | 'nextRetryAt'> & { stopReason?: ConnectionHealth['stopReason'] },
  seconds: number | null,
): string {
  if (h.retrying) return `reconnecting… (attempt ${Math.max(1, h.attempt)}/${MAX_RETRY_ATTEMPTS})`
  if (h.gaveUp && h.stopReason === 'credentials') return 'the server rejected the credentials, automatic reconnect stopped'
  if (h.gaveUp && h.stopReason === 'certificate') return 'the server certificate is not trusted, automatic reconnect stopped'
  if (h.gaveUp) return `automatic reconnect stopped after ${MAX_RETRY_ATTEMPTS} attempts`
  if (AUTO_RETRY && seconds !== null) return `retrying in ${seconds} s (attempt ${h.attempt + 1}/${MAX_RETRY_ATTEMPTS})`
  return 'reconnect to continue'
}

export function ConnectionBanner() {
  const h = useConnectionHealth()
  const name = useConnectionStore((s) => s.profiles.find((p) => p.id === h.profileId)?.name ?? 'the server')
  const loading = useConnectionStore((s) => s.loading)
  const seconds = useCountdown(h.status === 'lost' ? h.nextRetryAt : null)
  const [showDetails, setShowDetails] = useState(false)

  if (h.status !== 'lost' || h.dismissed) return null

  return (
    <Banner
      tone="warning"
      live={false}
      className="shrink-0"
      title={`Connection to ${name} lost`}
      body={
        <>
          <span className="flex items-center gap-x-2 min-w-0">
            <span aria-hidden className="text-muted-foreground">—</span>
            <span className="truncate">{connectionRetryText(h, seconds)}. Open tabs are kept.</span>
            {h.error && (
              <button type="button"
                aria-expanded={showDetails}
                onClick={() => setShowDetails((v) => !v)}
                className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground underline decoration-dotted underline-offset-2 shrink-0 rounded-xs focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-1"
              >
                {showDetails ? <ChevronDown size={12} strokeWidth={1.75} aria-hidden /> : <ChevronRight size={12} strokeWidth={1.75} aria-hidden />}
                Details
              </button>
            )}
          </span>
          {h.error && showDetails && (
            <p className="mt-0.5 text-xs font-mono break-all select-text text-foreground">{h.error}</p>
          )}
        </>
      }
      actions={
        <>
          {h.stopReason === 'certificate' && (
            <Button size="sm" variant="secondary" leftIcon={ShieldX} onClick={reviewCertificate}>
              Review certificate…
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            leftIcon={RefreshCw}
            loading={h.retrying || loading}
            data-reconnect-now=""
            // Busy, the button is disabled and focus falls to <body>; afterwards it goes back
            // to the button (still lost) or to the work area (restored, RW2-C-03).
            onClick={() => void reconnectNow().finally(() => focusWorkAreaSoon(() => document.querySelector<HTMLElement>('[data-reconnect-now]')))}
          >
            Reconnect now
          </Button>
        </>
      }
      onDismiss={dismissConnectionBanner}
    />
  )
}

/**
 * One always-mounted, visually hidden polite live region for connection
 * health. Mount once (AppLayout). It is never re-created with its content
 * (a region inserted together with its text is often not announced), and it
 * only changes on state transitions, never per countdown second.
 */
export function ConnectionAnnouncer() {
  const [message, setMessage] = useState('')
  const prev = useRef<ConnectionHealth>(useConnectionHealth.getState())

  useEffect(
    () =>
      useConnectionHealth.subscribe((h) => {
        const p = prev.current
        prev.current = h
        const name = useConnectionStore.getState().profiles.find((x) => x.id === h.profileId)?.name ?? 'the server'
        let next: string | null = null
        if (h.status === 'lost' && p.status !== 'lost') {
          next = `Connection to ${name} lost.${h.stopReason === 'credentials' ? ' The server rejected the credentials.' : h.stopReason === 'certificate' ? ' The server certificate is not trusted.' : AUTO_RETRY ? ' Reconnecting automatically.' : ''}`
        } else if (h.status === 'ok' && p.status === 'lost' && p.profileId === h.profileId && h.profileId) {
          next = `Connection to ${name} restored.`
        } else if (h.status === 'lost' && h.retrying && !p.retrying) {
          next = `Reconnecting to ${name}, attempt ${Math.max(1, h.attempt)} of ${MAX_RETRY_ATTEMPTS}.`
        } else if (h.status === 'lost' && h.gaveUp && !p.gaveUp) {
          next =
            h.stopReason === 'credentials'
              ? 'The server rejected the credentials. Automatic reconnect stopped.'
              : h.stopReason === 'certificate'
                ? 'The server certificate is not trusted. Automatic reconnect stopped; review the certificate.'
                : `Automatic reconnect stopped after ${MAX_RETRY_ATTEMPTS} attempts.`
        }
        if (next) setMessage(next)
      }),
    [],
  )

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  )
}
