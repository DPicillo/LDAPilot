/**
 * What the account verbs show for one entry (pure, tests/cmd.account.test.ts).
 *
 * Sources, strongest first:
 * - the server status (accountStatusCache, GetAccountStatus): complete;
 * - "no account status" from a server read ('na');
 * - evidence from attributes (a search hit, a report row, a tree row): only
 *   the states it names are known ("locked out" is shown at once); a state it
 *   does not name is unknown until the server status arrives;
 * - a server read in progress ('pending') or failed ('failed').
 *
 * Menus never shift while a read runs: the Unlock slot holds a disabled
 * "Checking account status…" placeholder and the Enable/Disable title stays.
 */
import type { AccountStatusKind } from '../ui/accountStatus'
import type { PasswordVerb } from '../ui/objectKind'

export type StatusReadState = 'pending' | 'failed' | 'na' | undefined

export interface ServerAccountFacts {
  locked: boolean
  enabled: boolean
  mustChangePassword: boolean
}

export interface AccountDisplayState {
  locked: boolean
  disabled: boolean
  mustChange: boolean
  /** The lock state is known (server, 'na', or evidence "locked"). */
  lockKnown: boolean
  /** Enabled / disabled is known. */
  enabledKnown: boolean
  /** "Must change password" is known. */
  mustChangeKnown: boolean
  /** A server read runs (or will start now). */
  reading: boolean
  /** The server read failed: verbs stay offered, the handler reads again and decides. */
  failed: boolean
  /** The entry has no account status (server said so). */
  noAccount: boolean
}

export function accountDisplayState(
  server: ServerAccountFacts | undefined,
  evidence: readonly AccountStatusKind[] | undefined,
  read: StatusReadState,
): AccountDisplayState {
  if (server) {
    return {
      locked: server.locked,
      disabled: !server.enabled,
      mustChange: server.mustChangePassword,
      lockKnown: true,
      enabledKnown: true,
      mustChangeKnown: true,
      reading: false,
      failed: false,
      noAccount: false,
    }
  }
  if (read === 'na') {
    return { locked: false, disabled: false, mustChange: false, lockKnown: true, enabledKnown: true, mustChangeKnown: true, reading: false, failed: false, noAccount: true }
  }
  const ev = evidence ?? []
  const locked = ev.includes('locked')
  const disabled = ev.includes('disabled')
  const mustChange = ev.includes('mustChange')
  return {
    locked,
    disabled,
    mustChange,
    lockKnown: locked,
    enabledKnown: disabled,
    mustChangeKnown: mustChange,
    reading: read === 'pending',
    failed: read === 'failed',
    noAccount: false,
  }
}

/**
 * The Unlock slot: 'offer' (locked, or unknown after a failed read: the
 * handler decides), 'checking' (disabled placeholder while the status is
 * read), 'hidden' (known not locked, or no account).
 * `canRead`: a read is running or can start (connected); else unknown = offer.
 */
export function unlockSlot(s: AccountDisplayState, canRead: boolean): 'offer' | 'checking' | 'hidden' {
  if (s.locked) return 'offer'
  if (s.lockKnown) return 'hidden'
  if (s.reading || (canRead && !s.failed)) return 'checking'
  return 'offer'
}

export const CHECKING_STATUS = 'Checking account status…'

/** Title of the single-entry Enable/Disable verb. */
export function toggleEnabledTitle(s: AccountDisplayState): string {
  if (!s.enabledKnown) return 'Enable/Disable Account'
  return s.disabled ? 'Enable Account' : 'Disable Account'
}

/** What a toggle title promised: 'enable' / 'disable', or null for the neutral title. */
export function promisedToggle(title: string | undefined): 'enable' | 'disable' | null {
  if (title === 'Enable Account') return 'enable'
  if (title === 'Disable Account') return 'disable'
  return null
}

/** Title of the must-change verb. */
export function mustChangeTitle(s: AccountDisplayState): string {
  return s.mustChangeKnown && s.mustChange ? 'Clear "Must Change Password"' : 'Require Password Change at Next Logon'
}

/** Title of the password verb (ui/objectKind passwordVerb): an LDAP person without a login gets its first password set. */
export function passwordVerbTitle(verb: PasswordVerb | null): string {
  return verb === 'set' ? 'Set Password…' : 'Reset Password…'
}

// --- Multi-entry Enable / Disable (BulkEnableDialog) ---------------------------------

export type BulkEnableCurrent = 'enabled' | 'disabled' | 'noAccount' | 'unknown' | 'reading'

export interface BulkEnableRow {
  dn: string
  name: string
  current: BulkEnableCurrent
  /** Why the state is unknown (status read failed). */
  error?: string
}

export type BulkEnablePlan = 'change' | 'same' | 'noAccount' | 'unknown'

/** Planned change for one row when `enable` is chosen. */
export function planBulkEnableRow(row: BulkEnableRow, enable: boolean): BulkEnablePlan {
  if (row.current === 'noAccount') return 'noAccount'
  if (row.current === 'unknown' || row.current === 'reading') return 'unknown'
  return (row.current === 'enabled') === enable ? 'same' : 'change'
}

/** Default action: enable when every account is disabled, else disable. */
export function defaultBulkEnable(rows: readonly BulkEnableRow[]): boolean {
  const accounts = rows.filter((r) => r.current === 'enabled' || r.current === 'disabled')
  return accounts.length > 0 && accounts.every((r) => r.current === 'disabled')
}

export function bulkEnableCounts(rows: readonly BulkEnableRow[], enable: boolean): { change: number; same: number; noAccount: number; unknown: number } {
  const out = { change: 0, same: 0, noAccount: 0, unknown: 0 }
  for (const r of rows) out[planBulkEnableRow(r, enable)]++
  return out
}
