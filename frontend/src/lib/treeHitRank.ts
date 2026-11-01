/**
 * Ranking of tree-search hits (Find in Tree): entries whose NAME matches the
 * query come before entries that only matched on another attribute
 * (description). Pure; no imports, so it runs under `node --test`.
 */

export interface RankableHit {
  dn: string
  attributes?: { name: string; values: string[] }[] | null
}

/** Attributes that name an entry (besides its RDN value). */
const NAME_ATTRS = new Set(['cn', 'displayname', 'samaccountname', 'uid', 'ou', 'name', 'givenname', 'sn'])

/** Value of the first RDN (unescaped enough for ranking). */
function firstRdnValue(dn: string): string {
  let end = dn.length
  for (let i = 0; i < dn.length; i++) {
    if (dn[i] === '\\') {
      i++
      continue
    }
    if (dn[i] === ',') {
      end = i
      break
    }
  }
  const rdn = dn.slice(0, end)
  const eq = rdn.indexOf('=')
  return (eq >= 0 ? rdn.slice(eq + 1) : rdn).replace(/\\(.)/g, '$1').trim()
}

/**
 * 0 exact name, 1 name starts with the query, 2 a word of the name starts
 * with it, 3 the name contains it, 4 only another attribute matched.
 */
export function treeHitScore(hit: RankableHit, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const names = [firstRdnValue(hit.dn)]
  for (const a of hit.attributes ?? []) {
    if (NAME_ATTRS.has(a.name.toLowerCase())) names.push(...a.values)
  }
  let best = 4
  for (const raw of names) {
    const v = raw.toLowerCase()
    if (v === q) return 0
    if (v.startsWith(q)) best = Math.min(best, 1)
    else if (v.split(/[\s._,@-]+/).some((w) => w.startsWith(q))) best = Math.min(best, 2)
    else if (v.includes(q)) best = Math.min(best, 3)
  }
  return best
}

/** Stable sort by treeHitScore (the server order stays within a score). */
export function rankTreeHits<T extends RankableHit>(hits: T[], query: string): T[] {
  return hits
    .map((h, i) => ({ h, i, s: treeHitScore(h, query) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.h)
}
