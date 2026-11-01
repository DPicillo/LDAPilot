/**
 * Pure layout helpers of the toolbar and the DN breadcrumb (ED-01, ED-15):
 * how many items fit a measured width, which crumbs a DN has and which of
 * them are shown, and why a typed DN cannot be navigated to. No DOM, no
 * React — node-tested in tests/editor.fit.test.ts, so imports carry the
 * `.ts` extension (CLAUDE.md, frontend pure-function tests).
 */
import { isDNAtOrBelow } from '../../lib/dn.ts'
import { dcDomainName, parseDnOrUrl, parseRdn, rdnValue, splitDn } from './dn.ts'

/**
 * How many items fit into `avail` px: all of them when their natural widths
 * (plus gaps) fit, else as many as fit next to the "…" button (`moreWidth`).
 */
export function fitToolbarItems(widths: readonly number[], gap: number, avail: number, moreWidth: number): number {
  const total = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, widths.length - 1)
  if (total <= avail + 0.5) return widths.length
  let used = moreWidth
  let n = 0
  for (const w of widths) {
    if (used + gap + w > avail + 0.5) break
    used += gap + w
    n++
  }
  return n
}

export interface Crumb {
  dn: string
  label: string
}

/** Label of a naming-context / tree root crumb: "lab.local" for DC-only DNs (DNS zones by their own name), else the RDN value. */
function rootLabel(dn: string): string {
  const first = rdnValue(dn)
  if (/^(DomainDnsZones|ForestDnsZones)$/i.test(first)) return first
  return dcDomainName(dn) ?? first
}

/**
 * Crumbs from the top. With `rootDn` (the tree root / naming context the
 * entry belongs to) the first crumb is that root; otherwise trailing DC
 * components form one root crumb ("lab.local").
 */
export function dnCrumbs(dn: string, rootDn?: string): Crumb[] {
  const parts = splitDn(dn)
  if (!parts.length) return []
  let start = parts.length
  if (rootDn && isDNAtOrBelow(dn, rootDn)) {
    start = Math.max(0, parts.length - splitDn(rootDn).length)
  } else {
    while (start > 0 && parseRdn(parts[start - 1]).type.toLowerCase() === 'dc') start--
  }
  const crumbs: Crumb[] = []
  if (start < parts.length) {
    const rootPart = parts.slice(start).join(',')
    crumbs.push({ dn: rootPart, label: rootLabel(rootPart) })
  }
  for (let i = start - 1; i >= 0; i--) {
    const d = parts.slice(i).join(',')
    crumbs.push({ dn: d, label: rdnValue(d) })
  }
  return crumbs
}

/**
 * Which crumbs are shown in `avail` px: all (plus a trailing "…" menu when
 * `trailingMore`), or the first one + "…" + as many trailing ones as fit (at
 * least the last, which may truncate). Returns the index of the first
 * trailing crumb (crumbs.length = all shown).
 */
export function crumbWindow(widths: readonly number[], sepWidth: number, moreWidth: number, gap: number, avail: number, trailingMore = false): number {
  const n = widths.length
  if (n <= 2) return n
  const all = widths.reduce((a, b) => a + b, 0) + (n - 1) * sepWidth + (2 * n - 2) * gap + (trailingMore ? gap + moreWidth : 0)
  if (all <= avail + 0.5) return n
  // head, sep, more = 3 items; every tail crumb adds a separator and itself.
  let used = widths[0] + sepWidth + moreWidth + 2 * gap
  let start = n
  for (let i = n - 1; i >= 1; i--) {
    const add = 2 * gap + sepWidth + widths[i]
    if (i < n - 1 && used + add > avail + 0.5) break
    used += add
    start = i
  }
  return start
}

/** Why `text` cannot be navigated to, or null when it is a DN / an LDAP URL with a DN. */
export function dnInputProblem(text: string): string | null {
  const t = text.trim()
  if (!t) return 'Enter a DN or an LDAP URL'
  const parsed = parseDnOrUrl(t)
  if (parsed.kind === 'url') return parsed.dn.trim() ? null : 'The LDAP URL has no DN'
  if (parsed.kind === 'dn') return null
  return 'Not a DN: use attribute=value pairs, e.g. CN=Name,OU=Unit,DC=example,DC=com'
}
