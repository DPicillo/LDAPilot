/**
 * How a search hit is named in the palette and in Find in Tree (pure; node
 * --test: tests/nav.palette.test.ts). The name is the unescaped RDN value —
 * what the editor tab and the tree call the entry ("eva.weber") — and the
 * display name (else cn) follows when it says something else ("Eva Weber"),
 * so the hit, the tab and the tree row read the same.
 */
import { rdnValue } from './dn.ts'

export interface HitLabel {
  /** The unescaped RDN value (tab / tree label). */
  name: string
  /** displayName, else cn, when it differs from `name`. */
  detail?: string
}

export function entryHitLabel(dn: string, names: { displayName?: string | null; cn?: string | null } = {}): HitLabel {
  const name = rdnValue(dn) || dn
  for (const v of [names.displayName, names.cn]) {
    const t = v?.trim()
    if (t && t !== name) return { name, detail: t }
  }
  return { name }
}
