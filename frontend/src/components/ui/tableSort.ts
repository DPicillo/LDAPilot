/**
 * Sorting of DataTable rows (pure; node-tested in tests/perf.test.ts).
 *
 * Every row's sort value is derived once per sort and the strings are compared
 * with one shared Intl.Collator: deriving both values and calling
 * localeCompare with options (a new collator per call) in each of the ≈ 520,000
 * comparisons of 40,000 rows blocked the Contents list for over a minute.
 */
import { fileTimeToDate, generalizedTimeToDate, type AccountStatus, type AccountStatusKind } from './accountStatus.ts'

export type CellValue = string | number | Date | null | undefined | string[] | (AccountStatus | AccountStatusKind)[]

/** Same options as the tree's name comparator (treePrefs.compareNames). */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function toDate(v: CellValue): Date | null {
  if (v instanceof Date) return v
  if (typeof v === 'number') return new Date(v)
  if (typeof v !== 'string' || !v) return null
  // Pure digits are a Windows FILETIME (0 / max = never), never a year.
  if (/^-?\d{1,19}$/.test(v.trim())) return fileTimeToDate(v)
  return generalizedTimeToDate(v) ?? (Number.isNaN(Date.parse(v)) ? null : new Date(v))
}

/** Arrays compare as their values joined with ", ". */
type SortKey = string | number | Date | null | undefined

function sortKey(v: CellValue): SortKey {
  return Array.isArray(v) ? v.map(String).join(', ') : v
}

/** Ascending order of two cell values: empty last, dates by time, numbers numerically, text naturally ("a2" < "a10"). */
export function compareCells(a: CellValue, b: CellValue): number {
  return compareKeys(sortKey(a), sortKey(b))
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  if (a instanceof Date || b instanceof Date) return (toDate(a)?.getTime() ?? 0) - (toDate(b)?.getTime() ?? 0)
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return collator.compare(String(a), String(b))
}

/** rows sorted by value (a new array; stable; 'desc' is the ascending order reversed). */
export function sortRowsBy<T>(rows: readonly T[], value: (row: T) => CellValue, dir: 'asc' | 'desc'): T[] {
  const keyed = rows.map((row) => ({ row, key: sortKey(value(row)) }))
  keyed.sort((x, y) => compareKeys(x.key, y.key))
  const out = keyed.map((k) => k.row)
  return dir === 'desc' ? out.reverse() : out
}
