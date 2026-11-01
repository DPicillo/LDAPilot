/**
 * What the results grid shows, as text: the visible columns in the visible
 * order (DataTable's persisted layout), rows in the visible sort, dates
 * readable ("2026-10-31 14:36:22", raw values in LDIF only), status labels.
 * Used by CSV export and Copy Table / Copy Selected Rows (formula-safe via
 * lib/bulk.ts csvField). Pure: runs under `node --test`.
 */
import { fileTimeToDate, generalizedTimeToDate, type AccountStatus, type AccountStatusKind } from '../ui/accountStatus.ts'
import { csvField, neutralizeFormula } from '../../lib/bulk.ts'
import { formatAccountAttributeValue } from '../../lib/accountTime.ts'

/** A column of the results grid as exported. */
export interface ExportColumn<R> {
  id: string
  header: string
  /** Text of the cell (dates already formatted). */
  text: (row: R) => string
  /** Sort value (as the grid sorts). */
  sortValue?: (row: R) => string | number | null
  defaultHidden?: boolean
}

/** DataTable's persisted layout of a table (localStorage `ldapilot-table-<key>`). */
export interface TableLayout {
  hidden?: string[]
  order?: string[]
}

/** Reads a DataTable's persisted layout; {} when there is none or storage is blocked. */
export function readTableLayout(key: string): TableLayout {
  try {
    if (typeof localStorage === 'undefined') return {}
    return JSON.parse(localStorage.getItem(`ldapilot-table-${key}`) || '{}') as TableLayout
  } catch {
    return {}
  }
}

/** The visible columns in display order (same rules as DataTable: persisted order first, then declared order; hidden = persisted or defaultHidden). */
export function visibleColumns<R>(columns: ExportColumn<R>[], layout: TableLayout): ExportColumn<R>[] {
  const hidden = new Set(layout.hidden ?? columns.filter((c) => c.defaultHidden).map((c) => c.id))
  const byId = new Map(columns.map((c) => [c.id, c]))
  const ordered: ExportColumn<R>[] = []
  for (const id of layout.order ?? []) {
    const c = byId.get(id)
    if (c) {
      ordered.push(c)
      byId.delete(id)
    }
  }
  return [...ordered, ...columns.filter((c) => byId.has(c.id))].filter((c) => !hidden.has(c.id))
}

/** Rows sorted like the grid (strings natural and case-insensitive, numbers numeric, empty last). */
export function sortRows<R>(rows: R[], column: ExportColumn<R> | undefined, dir: 'asc' | 'desc' | undefined): R[] {
  if (!column || !dir) return rows
  const value = column.sortValue ?? column.text
  const out = [...rows].sort((a, b) => {
    const x = value(a)
    const y = value(b)
    if ((x === null || x === '') && (y === null || y === '')) return 0
    if (x === null || x === '') return 1
    if (y === null || y === '') return -1
    if (typeof x === 'number' && typeof y === 'number') return x - y
    return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' })
  })
  return dir === 'desc' ? out.reverse() : out
}

/** Local "2026-10-31 14:36:22". */
export function formatLocalDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const FILETIME_NEVER = new Set(['0', '9223372036854775807', '-1'])

/**
 * Sentinel values of account time attributes that are no date (ACCT-03):
 * OpenLDAP's permanent lock, 389DS's administrator-only unlock and
 * must-change markers, AD's "must change" / "never" / "not locked" zeros.
 */
const ACCOUNT_TIME_SENTINELS: Record<string, readonly string[]> = {
  pwdaccountlockedtime: ['000001010000Z'],
  accountunlocktime: ['19700101000000Z'],
  passwordexpirationtime: ['19700101000000Z'],
  pwdlastset: ['0'],
  accountexpires: ['0', '9223372036854775807'],
  'msds-userpasswordexpirytimecomputed': ['0', '9223372036854775807'],
  lockouttime: ['0'],
  lastlogon: ['0'],
  lastlogontimestamp: ['0'],
  lastlogoff: ['0'],
  badpasswordtime: ['0'],
}

/**
 * The label of a sentinel account time value ("Permanent (disabled)",
 * "Must change at next logon", "Never", …) or null for a real date / other
 * attribute (shown as a date).
 */
export function accountTimeLabel(attr: string, raw: string): string | null {
  const v = raw.trim()
  if (!ACCOUNT_TIME_SENTINELS[attr.toLowerCase()]?.includes(v)) return null
  return formatAccountAttributeValue(attr, v)
}

/** A date attribute value of `attr` as text: its sentinel label, else readableDate. */
export function readableAttrDate(attr: string, raw: string): string {
  return accountTimeLabel(attr, raw) ?? readableDate(raw)
}

/**
 * A date attribute value as readable text: LDAP generalized time or Windows
 * FILETIME (accountExpires, pwdLastSet, lastLogonTimestamp: 0 / max =
 * "never") in local time; other text unchanged.
 */
export function readableDate(raw: string): string {
  const v = raw.trim()
  if (!v) return ''
  if (/^-?\d{1,19}$/.test(v)) {
    if (FILETIME_NEVER.has(v)) return 'never'
    // Plain small integers (e.g. shadowLastChange days) are not FILETIMEs.
    if (v.length < 12) return v
    const d = fileTimeToDate(v)
    return d ? formatLocalDateTime(d) : v
  }
  const d = generalizedTimeToDate(v)
  return d ? formatLocalDateTime(d) : v
}

const STATUS_TEXT: Record<AccountStatusKind, string> = {
  disabled: 'Disabled',
  locked: 'Locked out',
  expired: 'Account expired',
  expiresSoon: 'Expires soon',
  pwdExpired: 'Password expired',
  mustChange: 'Must change password',
  pwdNeverExpires: 'Password never expires',
  stale: 'Inactive 90+ days',
  readOnly: 'Read-only',
}

/** Status column text ("Disabled; Password never expires"). */
export function statusText(list: readonly (AccountStatus | AccountStatusKind)[]): string {
  return (list as (AccountStatus | AccountStatusKind)[]).map((s) => (typeof s === 'string' ? STATUS_TEXT[s] ?? s : s.label || STATUS_TEXT[s.kind] || s.kind)).join('; ')
}

/**
 * The CSV columns: the visible ones plus DN at the end when it is hidden,
 * so an exported report can be acted on (RW1-S-10; Copy keeps the grid).
 */
export function withDnColumn<R>(visible: ExportColumn<R>[], all: ExportColumn<R>[]): ExportColumn<R>[] {
  if (visible.some((c) => c.id === 'dn')) return visible
  const dn = all.find((c) => c.id === 'dn')
  return dn ? [...visible, dn] : visible
}

/**
 * Default file name of a results export: the report's name ("Disabled
 * Accounts" → "disabled-accounts"), else "<base> results", else
 * "search-results" (RW1-S-10).
 */
export function resultsFileName(source: string | undefined, baseValue: string | undefined): string {
  const slug = (source ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug && slug !== 'search') return slug
  return baseValue ? `${baseValue} results` : 'search-results'
}

/** Header + rows of the visible table. */
export function tableRows<R>(rows: R[], columns: ExportColumn<R>[]): { header: string[]; rows: string[][] } {
  return { header: columns.map((c) => c.header), rows: rows.map((r) => columns.map((c) => c.text(r))) }
}

/** CSV of the table (formula-safe, RFC 4180 quoting, CRLF). */
export function tableCSV(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n'
}

/** Tab-separated text for the clipboard (tabs and line breaks in values become blanks; formula-safe like csvField). */
export function tableTSV(header: string[], rows: string[][]): string {
  const clean = (s: string) => neutralizeFormula(s.replace(/[\t\r\n]+/g, ' '))
  return [header, ...rows].map((r) => r.map(clean).join('\t')).join('\n')
}
