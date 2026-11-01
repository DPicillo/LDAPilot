/**
 * Report rows after an account action (RW1-P-06 c): the action's
 * `ldapilot:account-changed` event carries the status read right after the
 * write, so an account report's row is patched from it instead of running
 * the report again for that DN. Pure, node-tested
 * (tests/accounts.reportpatch.test.ts).
 *
 * Not patchable from a status (the report is re-read for the row, as before):
 * - group reports (empty groups, privileged members): their computed columns
 *   ("Privileged groups", "Nested via") come from the whole report;
 * - reports that show an attribute every write changes on the server
 *   (AD Disabled Accounts: whenChanged) — no status field tells its new value.
 */
import { accountReportColumns, isComputedReportColumn, isGroupReport } from '../../lib/accountReports.ts'
import { normalizeDN } from '../../lib/dn.ts'
import type { AccountReportKind, AccountStatus } from '../../types/account'
import type { LDAPAttribute, LDAPEntry } from '../../types/ldap'

/** Attributes the server stamps on every write (lower case). */
const WRITE_STAMPED = new Set(['whenchanged', 'modifytimestamp', 'usnchanged', 'entrycsn', 'modifiersname'])

/**
 * Account state attributes an account action changes (lower case). A patched
 * row drops them: their values are from before the action, and a row status
 * derived from them (once the cached server status is gone) would show the
 * old state, e.g. "Locked out" after Unlock.
 */
const ACTION_STATE = new Set([
  'useraccountcontrol', 'msds-user-account-control-computed', 'lockouttime', 'badpwdcount', 'accountexpires', 'pwdlastset',
  'pwdaccountlockedtime', 'pwdfailuretime', 'pwdreset', 'pwdchangedtime', 'pwdgraceusetime',
  'nsaccountlock', 'accountunlocktime', 'passwordretrycount', 'retrycountresettime', 'passwordexpirationtime',
])

/** Whether the rows of a report with these display columns can be patched from a status alone. */
export function canPatchFromStatus(kind: AccountReportKind, displayColumns: readonly string[]): boolean {
  if (isGroupReport(kind)) return false
  return !displayColumns.some((c) => !isComputedReportColumn(c) && WRITE_STAMPED.has(c.toLowerCase()))
}

/**
 * The rows with the row of `dn` patched from its fresh `status`: the
 * computed columns are recomputed (an unlocked row loses "Locked until"),
 * the account state attributes from before the action are dropped, the
 * other LDAP attributes stay. null when no row has that DN or the status is
 * not an account's (nothing to patch: the caller re-reads).
 */
export function patchReportRowFromStatus(rows: LDAPEntry[], dn: string, kind: AccountReportKind, status: AccountStatus, now: Date): LDAPEntry[] | null {
  if (!status.applicable) return null
  const key = normalizeDN(dn)
  const i = rows.findIndex((e) => normalizeDN(e.dn) === key)
  if (i < 0) return null
  const row = rows[i]
  const cols = accountReportColumns(kind, status, now)
  const computed: LDAPAttribute[] = Object.entries(cols)
    .filter(([, v]) => v !== '')
    .map(([name, v]) => ({ name, values: [v], binary: false }))
  const kept = (row.attributes ?? []).filter((a) => !isComputedReportColumn(a.name) && !ACTION_STATE.has(a.name.split(';')[0].toLowerCase()))
  const next: LDAPEntry = { ...row, attributes: [...kept, ...computed] }
  const out = [...rows]
  out[i] = next
  return out
}
