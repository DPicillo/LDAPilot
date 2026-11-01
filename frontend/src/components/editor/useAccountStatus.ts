import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountStatus } from '../../types/account'
import { errorMessage, onAccountChanged, readAccountStatusShared } from '../../lib/wails-account'
import { looksLikeAccount, nextAccountStatusRefresh } from '../../lib/accountActions'
import { normalizeDN } from '../../lib/dn'
import { rememberAccountStatus } from '../../stores/accountStatusCache'

export interface AccountStatusState {
  status: AccountStatus | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Loads the account status of dn when objectClasses look like an account.
 * It is loaded again whenever reloadKey changes (e.g. the entry object after
 * a refresh), reload() is called, or a time the status depends on passes
 * (end of a timed lockout, password or account expiry), so "Locked" badges
 * do not outlive the lockout, or an account action on the entry is announced
 * anywhere (`ldapilot:account-changed`: menus, reports, other tabs; repeated
 * announcements within 300 ms are read once). Results of an older request
 * are dropped; every result goes to the account status cache.
 */
export function useAccountStatus(
  profileId: string | undefined,
  dn: string | undefined,
  objectClasses: string[] | undefined,
  reloadKey?: unknown,
): AccountStatusState {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  // reload() and the expiry timer read anew; an entry reload after an account change
  // shares the read the change already made (RW1-P-06).
  const force = useRef(false);
  const candidate = !!profileId && !!dn && looksLikeAccount(objectClasses);

  useEffect(() => {
    const id = ++seq.current;
    if (!candidate) {
      setStatus(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const maxAge = force.current ? 0 : undefined;
    force.current = false;
    readAccountStatusShared(profileId!, dn!, maxAge)
      .then(st => {
        if (id !== seq.current) return;
        setStatus(st);
        setError(null);
        if (st) rememberAccountStatus(profileId!, st);
      })
      .catch(err => {
        if (id !== seq.current) return;
        setStatus(null);
        setError(errorMessage(err, 'Failed to read the account status'));
      })
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
  }, [candidate, profileId, dn, reloadKey, tick]);

  // An account action on this entry elsewhere (menus, reports, dialogs).
  useEffect(() => {
    if (!candidate) return;
    const key = normalizeDN(dn!);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onAccountChanged((d) => {
      if (d.profileId !== profileId || normalizeDN(d.dn) !== key) return;
      if (d.status) {
        // The emitter read it already: no second read.
        seq.current++;
        setStatus(d.status);
        setError(null);
        setLoading(false);
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setTick(t => t + 1);
      }, 300);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [candidate, profileId, dn]);

  // A status of another entry must never be shown while the new one loads.
  const current = status && dn && status.dn.toLowerCase() === dn.toLowerCase() ? status : null;
  const reload = useCallback(() => {
    force.current = true;
    setTick(t => t + 1);
  }, []);

  // Read the status again when a lockout ends or a password/account expires.
  useEffect(() => {
    const delay = nextAccountStatusRefresh(current, Date.now());
    if (delay === null) return;
    const timer = setTimeout(() => {
      force.current = true;
      setTick(t => t + 1);
    }, delay);
    return () => clearTimeout(timer);
  }, [current]);
  return { status: current, loading, error, reload };
}
