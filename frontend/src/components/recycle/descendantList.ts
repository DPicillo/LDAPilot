/**
 * The descendants the delete dialog lists (DEF-20; pure, node --test:
 * tests/nav.delete.test.ts): `BrowserService.ListDescendants` returns the
 * first entries below a root breadth first; the dialog shows them as a tree
 * (each entry under its parent, siblings by name) with the descendant count.
 */
import { firstRDN, getParentDN, normalizeDN, parseRDN, splitDN, unescapeDNValue } from '../../lib/dn.ts'

export interface DescendantRow {
  dn: string
  /** The RDN as attribute=value, unescaped ("ou=Sales", "CN=Schmidt, Anna"). */
  label: string
  /** 1 = a direct child of the root. */
  depth: number
}

/** First entries listed per root: one root gets more room than several. */
export function descendantListLimit(roots: number): number {
  return roots <= 1 ? 50 : roots <= 3 ? 20 : 10
}

function rdnLabel(dn: string): string {
  const rdn = firstRDN(dn)
  const { attr, value } = parseRDN(rdn)
  return attr ? `${attr}=${value}` : unescapeDNValue(rdn)
}

/** The RDN value, for sorting siblings by name. */
function rdnSortKey(dn: string): string {
  return parseRDN(firstRDN(dn)).value || dn
}

/** The listed DNs below `root` in tree order (pre-order; siblings by name, numbers natural). */
export function descendantRows(root: string, dns: readonly string[]): DescendantRow[] {
  const rootKey = normalizeDN(root)
  const rootDepth = splitDN(root).length
  const children = new Map<string, string[]>()
  const listed = new Set<string>()
  for (const dn of dns) {
    const k = normalizeDN(dn)
    if (k === rootKey || listed.has(k)) continue
    listed.add(k)
    const p = normalizeDN(getParentDN(dn))
    children.set(p, [...(children.get(p) ?? []), dn])
  }
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
  const out: DescendantRow[] = []
  const placed = new Set<string>()
  const walk = (key: string) => {
    const kids = [...(children.get(key) ?? [])].sort((a, b) => collator.compare(rdnSortKey(a), rdnSortKey(b)))
    for (const dn of kids) {
      const k = normalizeDN(dn)
      if (placed.has(k)) continue
      placed.add(k)
      out.push({ dn, label: rdnLabel(dn), depth: Math.max(1, splitDN(dn).length - rootDepth) })
      walk(k)
    }
  }
  walk(rootKey)
  // Entries whose parent was not listed (should not happen breadth first) still show.
  for (const dn of dns) {
    const k = normalizeDN(dn)
    if (k === rootKey || placed.has(k)) continue
    placed.add(k)
    out.push({ dn, label: rdnLabel(dn), depth: Math.max(1, splitDN(dn).length - rootDepth) })
  }
  return out
}

/** "first 50 of 132" / "all 12" for the list header. */
export function descendantListSummary(listed: number, count: number, capped: boolean): string {
  if (!capped && listed >= count) return listed === 1 ? 'the 1 entry' : `all ${listed.toLocaleString()}`
  return `first ${listed.toLocaleString()} of ${capped ? 'more than ' : ''}${count.toLocaleString()}`
}
