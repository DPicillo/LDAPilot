/**
 * Status chips (StatusChip / EntrySummaryHeader) from the server's account
 * status (EditorService.GetAccountStatus), which knows the effective lockout
 * duration and the computed flags; deriveAccountStatus (ui/accountStatus.ts)
 * is only the fallback for surfaces without it. Pure (node --test).
 */
import type { AccountStatus as ServerAccountStatus } from '../types/account'
import type { AccountStatus as ChipStatus } from '../components/ui/accountStatus'
import { DAY_MS, wholeDaysUntil } from './accountTime.ts'

function date(iso: string | undefined): Date | undefined {
  if (!iso) return undefined
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? undefined : d
}

const hex = (n: number) => `0x${(n >>> 0).toString(16).toUpperCase()}`

/** Chips in priority order (locked, disabled, expired, password states). */
export function serverStatusChips(st: ServerAccountStatus | null | undefined, now: Date = new Date(), expiresSoonDays = 14): ChipStatus[] {
  if (!st || !st.applicable) return []
  const ad = st.serverType === 'ad'
  const out: ChipStatus[] = []
  if (st.locked) {
    out.push({
      kind: 'locked',
      label: 'Locked out',
      since: date(st.lockedAt),
      until: date(st.lockedUntil),
      source: ad
        ? { attribute: 'msDS-User-Account-Control-Computed', raw: `${hex(st.userAccountControlComputed)} (LOCKOUT)` }
        : st.serverType === 'openldap'
          ? { attribute: 'pwdAccountLockedTime', raw: st.lockedPermanently ? '000001010000Z' : st.lockedAt ?? 'set' }
          : { attribute: 'account status', raw: st.lockedUntil ? `locked until ${st.lockedUntil}` : 'locked' },
    })
  }
  if (!st.enabled) {
    out.push({
      kind: 'disabled',
      label: 'Disabled',
      source: ad
        ? { attribute: 'userAccountControl', raw: `${st.userAccountControl} (ACCOUNTDISABLE)` }
        : { attribute: st.disabledBy || 'account status', raw: 'disabled' },
    })
  }
  const expires = date(st.accountExpires)
  if (st.accountExpired) {
    out.push({ kind: 'expired', label: 'Account expired', since: expires, source: { attribute: 'accountExpires', raw: st.accountExpires ?? '' } })
  } else if (expires && !st.accountNeverExpires) {
    // Same window and rounding as deriveAccountStatus (ui/accountStatus).
    const left = expires.getTime() - now.getTime()
    if (left >= 0 && left <= expiresSoonDays * DAY_MS) {
      const days = wholeDaysUntil(expires, now)
      out.push({
        kind: 'expiresSoon',
        label: days <= 0 ? 'Expires in < 1 day' : `Expires in ${days} day${days === 1 ? '' : 's'}`,
        until: expires,
        source: { attribute: 'accountExpires', raw: st.accountExpires ?? '' },
      })
    }
  }
  if (st.passwordExpired) {
    out.push({
      kind: 'pwdExpired',
      label: 'Password expired',
      since: date(st.passwordExpires),
      source: ad
        ? { attribute: 'msDS-User-Account-Control-Computed', raw: `${hex(st.userAccountControlComputed)} (PASSWORD_EXPIRED)` }
        : { attribute: 'pwdChangedTime', raw: st.passwordLastSet ?? '' },
    })
  }
  if (st.mustChangePassword) {
    out.push({
      kind: 'mustChange',
      label: 'Must change password',
      source: ad ? { attribute: 'pwdLastSet', raw: '0' } : { attribute: 'pwdReset', raw: 'TRUE' },
    })
  }
  if (st.passwordNeverExpires && ad) {
    out.push({ kind: 'pwdNeverExpires', label: 'Password never expires', source: { attribute: 'userAccountControl', raw: `${st.userAccountControl} (DONT_EXPIRE_PASSWORD)` } })
  }
  return out
}
