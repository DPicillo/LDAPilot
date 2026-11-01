import { useEffect } from 'react'
import { create } from 'zustand'
import type { AuthEnvironment } from '../types/auth'
import * as wailsAuth from '../lib/wails-auth'

interface AuthEnvState {
  /** Local Kerberos environment (SSPI, krb5.conf, ticket cache); null until loaded or outside Wails. */
  env: AuthEnvironment | null;
  /** Fetches the environment; without force only if it was not fetched yet. */
  load: (force?: boolean) => Promise<void>;
}

let pending: Promise<void> | null = null;

export const useAuthEnvStore = create<AuthEnvState>((set, get) => ({
  env: null,
  load: (force = false) => {
    if (!force && (get().env || pending)) return pending ?? Promise.resolve();
    const p = wailsAuth.GetAuthEnvironment()
      .then((env) => { if (env) set({ env }); })
      .catch(() => { /* not running under Wails */ })
      .finally(() => { if (pending === p) pending = null; });
    pending = p;
    return p;
  },
}));

/**
 * The local authentication environment, fetched once per session (refresh:
 * fetch again on mount, e.g. when the connection dialog opens, since
 * krb5.conf or the ticket cache may have changed).
 */
export function useAuthEnvironment(refresh = false): AuthEnvironment | null {
  const env = useAuthEnvStore((s) => s.env);
  useEffect(() => {
    void useAuthEnvStore.getState().load(refresh);
  }, [refresh]);
  return env;
}
