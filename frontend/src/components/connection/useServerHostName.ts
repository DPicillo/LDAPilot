/**
 * The server's own DNS name for the Kerberos SPN suggestion (DEF-05): read
 * from the RootDSE (dnsHostName, anonymous, no credentials) when the dialog's
 * Kerberos profile dials an IP address or alias (debounced while the host is
 * typed), or on request ("Look up").
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionProfile } from '../../types/ldap'
import { DetectServerHostName } from '../../lib/wails-auth'
import { cleanProfileForSave, needsExplicitSPN } from '../../lib/connectionAuth'

export interface ServerHostNameState {
  /** The server's dnsHostName (lowercase), once read. */
  name?: string
  loading?: boolean
  error?: string
  /** The host / port / TLS mode it was read for. */
  key?: string
}

const DEBOUNCE_MS = 700

/** What the lookup depends on: a changed host, port or transport reads again. */
export function hostNameKey(p: Pick<ConnectionProfile, 'host' | 'port' | 'tlsMode'>): string {
  return `${p.host.trim().toLowerCase()}|${p.port}|${p.tlsMode}`
}

export function useServerHostName(form: ConnectionProfile): { state: ServerHostNameState; lookup: () => void } {
  const [state, setState] = useState<ServerHostNameState>({})
  const seq = useRef(0)
  // Host the last lookup ran for: switching the method back and forth does not read again.
  const lookedUp = useRef<string | null>(null)
  const formRef = useRef(form)
  formRef.current = form
  const key = hostNameKey(form)
  const auto = form.authMethod === 'kerberos' && !!form.host.trim() && needsExplicitSPN(form.host) && form.port >= 1 && form.port <= 65535

  const run = useCallback(() => {
    const p = formRef.current
    const k = hostNameKey(p)
    const n = ++seq.current
    lookedUp.current = k
    setState({ loading: true, key: k })
    DetectServerHostName(cleanProfileForSave({ ...p, password: '' }))
      .then((name) => n === seq.current && setState({ name, key: k }))
      .catch((err: unknown) => n === seq.current && setState({ error: err instanceof Error ? err.message : String(err), key: k }))
  }, [])

  // Another host: the old answer no longer applies.
  useEffect(() => {
    setState((s) => (s.key && s.key !== key ? {} : s))
    if (!auto || lookedUp.current === key) return
    const t = setTimeout(run, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [key, auto, run])

  return { state: state.key === key ? state : {}, lookup: run }
}
