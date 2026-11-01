/**
 * deriveAccountStatus (SPEC 6.4): a pure function from raw attributes to the
 * account states shown by StatusChip, the ObjectIcon overlay and the
 * per-type commands. A wrong status is worse than none (SPEC 12.8): prefer
 * computed attributes, and say "Locked (lockoutTime set)" when the domain
 * lockout duration is unknown.
 */
import { wholeDaysUntil } from '../../lib/accountTime.ts'

export type AccountStatusKind =
  | 'disabled'
  | 'locked'
  | 'expired'
  | 'expiresSoon'
  | 'pwdExpired'
  | 'mustChange'
  | 'pwdNeverExpires'
  | 'stale'
  | 'readOnly'

export interface AccountStatus {
  kind: AccountStatusKind
  /** Text shown in the chip ("Locked out", "Expires in 6 days"). */
  label: string
  since?: Date
  until?: Date
  /** The attribute that decided it and its raw value (tooltip). */
  source: { attribute: string; raw: string }
}

export type AttributeInput =
  | Record<string, string[] | string | undefined>
  | { name: string; values: string[] }[]

export interface DeriveOptions {
  serverType?: 'ad' | 'openldap' | '389ds' | 'other' | null
  now?: Date
  /** Domain lockout duration; Infinity = until an admin unlocks. Unknown = undefined. */
  lockoutDurationMs?: number
  /** Inactivity threshold for 'stale' (default 90 days). */
  staleDays?: number
  /** Window for 'expiresSoon' (default 14 days). */
  expiresSoonDays?: number
}

const DAY = 86_400_000
const UF_ACCOUNTDISABLE = 0x2
const UF_LOCKOUT = 0x10
const UF_DONT_EXPIRE_PASSWD = 0x10000
const UF_PASSWORD_EXPIRED = 0x800000
const NEVER = 9223372036854775807n
/** AD object classes with account semantics (managed service accounts derive from computer). */
const AD_ACCOUNT_CLASSES = new Set(['user', 'computer', 'msds-managedserviceaccount', 'msds-groupmanagedserviceaccount', 'msds-delegatedmanagedserviceaccount'])
/** AD accounts whose password AD changes itself (no "must change", never expires). */
const AD_MACHINE_CLASSES = new Set(['computer', 'msds-managedserviceaccount', 'msds-groupmanagedserviceaccount', 'msds-delegatedmanagedserviceaccount'])

function normalize(attrs: AttributeInput): Map<string, string[]> {
  const m = new Map<string, string[]>()
  if (Array.isArray(attrs)) {
    for (const a of attrs) m.set(a.name.toLowerCase(), a.values ?? [])
  } else {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined) continue
      m.set(k.toLowerCase(), Array.isArray(v) ? v : [v])
    }
  }
  return m
}

/** Windows FILETIME (100 ns since 1601) -> Date; null for 0 / never / garbage. */
export function fileTimeToDate(raw: string | undefined): Date | null {
  if (!raw || !/^-?\d+$/.test(raw.trim())) return null
  const v = BigInt(raw.trim())
  if (v <= 0n || v >= NEVER) return null
  const ms = Number(v / 10000n) - 11_644_473_600_000
  return Number.isFinite(ms) ? new Date(ms) : null
}

/** LDAP GeneralizedTime (20261029205900Z, 20261029205900.0Z, +0100 offsets) -> Date. */
export function generalizedTimeToDate(raw: string | undefined): Date | null {
  if (!raw) return null
  const m = raw.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(?:[.,](\d+))?(Z|[+-]\d{2}(?:\d{2})?)?$/)
  if (!m) return null
  const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '0', tz = 'Z'] = m
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, Math.round(Number('0.' + frac) * 1000))
  if (tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1
    const oh = +tz.slice(1, 3)
    const om = tz.length > 3 ? +tz.slice(3, 5) : 0
    ms -= sign * (oh * 60 + om) * 60_000
  }
  return new Date(ms)
}

/** Local "2026-10-29 20:59". */
export function formatDateTime(d: Date, opts: { seconds?: boolean } = {}): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${opts.seconds ? `:${p(d.getSeconds())}` : ''}`
}

/**
 * Two lists of times that look equal to the minute but are not: Compare
 * shows them with seconds ("12:12" vs "12:12" listed as different, RW3-E-04).
 */
export function timesNeedSeconds(a: readonly (Date | null)[], b: readonly (Date | null)[]): boolean {
  const fmt = (l: readonly (Date | null)[], seconds: boolean) => l.map((d) => (d ? formatDateTime(d, { seconds }) : '')).join('\n')
  return fmt(a, false) === fmt(b, false) && fmt(a, true) !== fmt(b, true)
}

/** "2 h ago", "in 6 days", "just now". */
export function formatRelative(d: Date, now: Date = new Date()): string {
  const diff = d.getTime() - now.getTime()
  const abs = Math.abs(diff)
  const fmt = (n: number, unit: string) => (diff < 0 ? `${n} ${unit} ago` : `in ${n} ${unit}`)
  if (abs < 60_000) return 'just now'
  if (abs < 3_600_000) return fmt(Math.round(abs / 60_000), 'min')
  if (abs < DAY) return fmt(Math.round(abs / 3_600_000), 'h')
  const days = Math.round(abs / DAY)
  if (days < 60) return fmt(days, days === 1 ? 'day' : 'days')
  const months = Math.round(days / 30)
  if (months < 24) return fmt(months, months === 1 ? 'month' : 'months')
  return fmt(Math.round(days / 365), 'years')
}

function int(v: string | undefined): number | null {
  if (v === undefined || !/^-?\d+$/.test(v.trim())) return null
  return Number(v.trim())
}

/**
 * AD: userAccountControl, msDS-User-Account-Control-Computed, lockoutTime,
 * accountExpires, pwdLastSet, lastLogonTimestamp/whenCreated.
 * OpenLDAP ppolicy: pwdAccountLockedTime, pwdReset. 389-DS: nsAccountLock.
 * The server type is inferred from the attributes when not given.
 *
 * The AD states only apply to accounts (objectClass user / computer, as the
 * account track's adAccountKind): Samba and AD return
 * msDS-User-Account-Control-Computed = UF_PASSWORD_EXPIRED for groups,
 * contacts and OUs too, and whenCreated would make every old container
 * "Never logged on". Without objectClass the attributes are taken as given.
 */
export function deriveAccountStatus(attrs: AttributeInput, opts: DeriveOptions = {}): AccountStatus[] {
  const a = normalize(attrs)
  const now = opts.now ?? new Date()
  const first = (n: string) => a.get(n)?.[0]
  const out: AccountStatus[] = []
  const add = (s: AccountStatus) => out.push(s)

  const uacRaw = first('useraccountcontrol')
  const uac = int(uacRaw)
  const computedRaw = first('msds-user-account-control-computed')
  const computed = int(computedRaw)
  const ocs = a.get('objectclass')
  const adAccount = !ocs || ocs.length === 0 || ocs.some((o) => AD_ACCOUNT_CLASSES.has(o.toLowerCase()))
  const isAD = adAccount && (opts.serverType === 'ad' || uac !== null || computed !== null)

  if (isAD) {
    if (uac !== null && uac & UF_ACCOUNTDISABLE) {
      add({ kind: 'disabled', label: 'Disabled', source: { attribute: 'userAccountControl', raw: uacRaw! } })
    }

    const lockRaw = first('lockouttime')
    const lockedAt = fileTimeToDate(lockRaw)
    if (computed !== null) {
      // Authoritative: the DC already applied the lockout duration.
      if (computed & UF_LOCKOUT) {
        add({ kind: 'locked', label: 'Locked out', since: lockedAt ?? undefined, source: { attribute: 'msDS-User-Account-Control-Computed', raw: computedRaw! } })
      }
    } else if (lockedAt) {
      const d = opts.lockoutDurationMs
      if (d === undefined) {
        add({ kind: 'locked', label: 'Locked (lockoutTime set)', since: lockedAt, source: { attribute: 'lockoutTime', raw: lockRaw! } })
      } else if (d === Infinity || d <= 0 || now.getTime() < lockedAt.getTime() + d) {
        add({
          kind: 'locked',
          label: 'Locked out',
          since: lockedAt,
          until: d === Infinity || d <= 0 ? undefined : new Date(lockedAt.getTime() + d),
          source: { attribute: 'lockoutTime', raw: lockRaw! },
        })
      }
    }

    const expRaw = first('accountexpires')
    const expires = fileTimeToDate(expRaw)
    if (expires) {
      const soon = (opts.expiresSoonDays ?? 14) * DAY
      if (expires.getTime() <= now.getTime()) {
        add({ kind: 'expired', label: 'Account expired', since: expires, source: { attribute: 'accountExpires', raw: expRaw! } })
      } else if (expires.getTime() - now.getTime() <= soon) {
        add({ kind: 'expiresSoon', label: expiresInLabel(expires, now), until: expires, source: { attribute: 'accountExpires', raw: expRaw! } })
      }
    }

    // Like the server (computeADStatus): pwdLastSet = 0 means "must change",
    // not "expired" (the DC also sets PASSWORD_EXPIRED then); AD ignores it
    // with DONT_EXPIRE_PASSWORD, and machine accounts change their own
    // password, so neither applies to them.
    const pwdLastSet = first('pwdlastset')
    const machine = !!ocs?.some((o) => AD_MACHINE_CLASSES.has(o.toLowerCase()))
    const dontExpire = uac !== null && (uac & UF_DONT_EXPIRE_PASSWD) !== 0
    const resetPending = pwdLastSet !== undefined && pwdLastSet.trim() === '0'
    const mustChange = resetPending && !dontExpire && !machine
    if (computed !== null && computed & UF_PASSWORD_EXPIRED && !resetPending && !dontExpire && !machine) {
      add({ kind: 'pwdExpired', label: 'Password expired', source: { attribute: 'msDS-User-Account-Control-Computed', raw: computedRaw! } })
    }
    if (mustChange) {
      add({ kind: 'mustChange', label: 'Must change password', source: { attribute: 'pwdLastSet', raw: pwdLastSet! } })
    }
    if (uac !== null && uac & UF_DONT_EXPIRE_PASSWD) {
      add({ kind: 'pwdNeverExpires', label: 'Password never expires', source: { attribute: 'userAccountControl', raw: uacRaw! } })
    }

    // Stale: last logon (replicated) older than the threshold; never logged on
    // only counts once the account itself is older than the threshold.
    const staleMs = (opts.staleDays ?? 90) * DAY
    const llRaw = first('lastlogontimestamp')
    const lastLogon = fileTimeToDate(llRaw)
    if (lastLogon) {
      if (now.getTime() - lastLogon.getTime() > staleMs) {
        add({ kind: 'stale', label: `Inactive ${opts.staleDays ?? 90}+ days`, since: lastLogon, source: { attribute: 'lastLogonTimestamp', raw: llRaw! } })
      }
    } else {
      const created = generalizedTimeToDate(first('whencreated'))
      if (created && now.getTime() - created.getTime() > staleMs && (uac === null || !(uac & UF_ACCOUNTDISABLE))) {
        add({ kind: 'stale', label: 'Never logged on', since: created, source: { attribute: 'lastLogonTimestamp', raw: llRaw ?? '(not set)' } })
      }
    }
  }

  // OpenLDAP ppolicy. The permanent lock 000001010000Z is how LDAPilot (and
  // ppolicy admins) disable an account: "disabled", not "locked", so the
  // commands offer Enable instead of Unlock (account track, ldap.PPolicyPermanentLock).
  const pwdLocked = first('pwdaccountlockedtime')
  if (pwdLocked) {
    const permanent = pwdLocked.trim().startsWith('000001010000')
    if (permanent) {
      add({ kind: 'disabled', label: 'Disabled', source: { attribute: 'pwdAccountLockedTime', raw: pwdLocked } })
    } else {
      add({
        kind: 'locked',
        label: 'Locked out',
        since: generalizedTimeToDate(pwdLocked) ?? undefined,
        source: { attribute: 'pwdAccountLockedTime', raw: pwdLocked },
      })
    }
  }
  const pwdReset = first('pwdreset')
  if (pwdReset && pwdReset.trim().toUpperCase() === 'TRUE') {
    add({ kind: 'mustChange', label: 'Must change password', source: { attribute: 'pwdReset', raw: pwdReset } })
  }

  // 389-DS lockout: accountUnlockTime is the end of the lockout, or
  // 19700101000000Z ("until an administrator unlocks", passwordUnlock off).
  // An end in the past is an expired lockout the server has not cleared yet.
  const unlockRaw = first('accountunlocktime')
  if (unlockRaw && !out.some((s) => s.kind === 'locked')) {
    const end = generalizedTimeToDate(unlockRaw)
    if (end && (end.getTime() === 0 || end.getTime() > now.getTime())) {
      add({
        kind: 'locked',
        label: 'Locked out',
        until: end.getTime() === 0 ? undefined : end,
        source: { attribute: 'accountUnlockTime', raw: unlockRaw },
      })
    }
  }

  // 389-DS "must change": a reset sets passwordExpirationTime to 19700101000000Z
  // (passwordMustChange). The server status (cached) decides when the policy
  // ignores the marker; a past expiry is left to it (passwordExp may be off).
  // RW3-P-02: the chip appeared only for rows whose status had been read.
  const petRaw = first('passwordexpirationtime')
  if (petRaw && generalizedTimeToDate(petRaw)?.getTime() === 0 && !out.some((s) => s.kind === 'mustChange')) {
    add({ kind: 'mustChange', label: 'Must change password', source: { attribute: 'passwordExpirationTime', raw: petRaw } })
  }

  // 389-DS
  const nsLock = first('nsaccountlock')
  if (nsLock && nsLock.trim().toUpperCase() === 'TRUE' && !out.some((s) => s.kind === 'disabled')) {
    add({ kind: 'disabled', label: 'Disabled', source: { attribute: 'nsAccountLock', raw: nsLock } })
  }

  return out
}

/** "Expires in 3 days" with the shared rounding rule (lib/accountTime wholeDaysUntil); "< 1 day" below half a day. */
export function expiresInLabel(until: Date, now: Date): string {
  const days = wholeDaysUntil(until, now)
  if (days <= 0) return 'Expires in < 1 day'
  return `Expires in ${days} day${days === 1 ? '' : 's'}`
}

/**
 * Status of a list or search row from the attributes a search returned. A
 * lock that rests on lockoutTime alone and "never logged on" without a
 * lastLogonTimestamp in the result are dropped: a search returns only the
 * attributes it asked for, and a wrong status is worse than none. The search
 * results and the Contents list use it, so both show the same states.
 */
export function deriveRowStatus(attrs: AttributeInput): AccountStatus[] {
  return deriveAccountStatus(attrs).filter(
    (s) => !(s.kind === 'locked' && s.source.attribute === 'lockoutTime') && !(s.kind === 'stale' && s.source.raw === '(not set)'),
  )
}

/** States a server account status (GetAccountStatus) decides; the others come only from attributes. */
const SERVER_KINDS: ReadonlySet<AccountStatusKind> = new Set(['locked', 'disabled', 'expired', 'pwdExpired', 'mustChange', 'pwdNeverExpires'])

/**
 * Status of a list / results row: the cached server status (when known) wins
 * for the states it decides, and the states only attributes tell ("Expires in
 * n days", "Never logged on", "Inactive 90+ days") are kept from the row's
 * attributes, with their labels and dates (RW1-P-01: opening an entry used
 * to remove its "Expires in 5 days" chip from the Contents list). A server
 * kind also seen in the attributes keeps the attribute's label and dates.
 */
export function mergeRowStatus(
  server: readonly AccountStatusKind[] | undefined,
  derived: readonly (AccountStatus | AccountStatusKind)[],
): (AccountStatus | AccountStatusKind)[] {
  if (!server) return [...derived]
  const byKind = new Map<AccountStatusKind, AccountStatus>()
  for (const d of derived) if (typeof d === 'object' && !byKind.has(d.kind)) byKind.set(d.kind, d)
  const out: (AccountStatus | AccountStatusKind)[] = server.map((k) => byKind.get(k) ?? k)
  const have = new Set(server)
  for (const d of derived) {
    const k = typeof d === 'string' ? d : d.kind
    if (!SERVER_KINDS.has(k) && !have.has(k)) {
      out.push(d)
      have.add(k)
    }
  }
  return out
}

/** Attributes to request so deriveAccountStatus can work (operational ones must be asked for). */
export const ACCOUNT_STATUS_ATTRIBUTES = [
  'objectClass',
  'userAccountControl',
  'msDS-User-Account-Control-Computed',
  'lockoutTime',
  'accountExpires',
  'pwdLastSet',
  'lastLogonTimestamp',
  'whenCreated',
  'pwdAccountLockedTime',
  'pwdReset',
  'nsAccountLock',
  'accountUnlockTime',
  'passwordExpirationTime',
]

/** Severity order for picking the one status to show in tight spots (tab dot, icon overlay). */
const RANK: Record<AccountStatusKind, number> = {
  locked: 0,
  disabled: 1,
  expired: 2,
  pwdExpired: 3,
  expiresSoon: 4,
  mustChange: 5,
  stale: 6,
  pwdNeverExpires: 7,
  readOnly: 8,
}
export function primaryStatus(list: readonly (AccountStatus | AccountStatusKind)[] | undefined): AccountStatusKind | undefined {
  if (!list || list.length === 0) return undefined
  const kinds = list.map((s) => (typeof s === 'string' ? s : s.kind))
  return kinds.sort((x, y) => RANK[x] - RANK[y])[0]
}
