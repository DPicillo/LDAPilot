/**
 * DN and LDAP URL helpers (RFC 4514 / RFC 4516): the one LDAP URL parser of
 * the app (palette incl. its DN mode on Ctrl+G, DnBreadcrumb). Splitting and unescaping delegate to lib/dn.ts, the one escape-aware DN
 * parser of the app.
 */
import { splitDN, unescapeDNValue } from '../../lib/dn.ts'

/** Splits a DN into RDN strings on unescaped commas (keeps escapes, handles quoted values; lib/dn's parser), trimmed, empty RDNs dropped. */
export function splitDn(dn: string): string[] {
  return splitDN(dn)
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
}

/** Unescapes an RDN value: "\," -> ",", "\2C" -> ",", strips surrounding quotes (lib/dn's unescaping). */
export function unescapeDnValue(v: string): string {
  let s = v.trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1)
  return unescapeDNValue(s)
}

export interface Rdn {
  type: string
  value: string
  raw: string
}

export function parseRdn(rdn: string): Rdn {
  const eq = rdn.indexOf('=')
  if (eq < 0) return { type: '', value: unescapeDnValue(rdn), raw: rdn }
  return { type: rdn.slice(0, eq).trim(), value: unescapeDnValue(rdn.slice(eq + 1)), raw: rdn }
}

/** Value of the first RDN ("Test Locked" for "CN=Test Locked,OU=..."). */
export function rdnValue(dn: string): string {
  const r = splitDn(dn)[0]
  return r ? parseRdn(r).value : dn
}

/** Parent DN, or '' at the top. */
export function parentDn(dn: string): string {
  const parts = splitDn(dn)
  return parts.slice(1).join(',')
}

/** Every ancestor DN from the leaf's parent up to the top. */
export function ancestorDns(dn: string): string[] {
  const parts = splitDn(dn)
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(i).join(','))
  return out
}

/** "dc=lab,dc=local" -> "lab.local" when every RDN is a DC, else null. */
export function dcDomainName(dn: string): string | null {
  const parts = splitDn(dn).map(parseRdn)
  if (!parts.length || !parts.every((p) => p.type.toLowerCase() === 'dc')) return null
  return parts.map((p) => p.value).join('.')
}

/** Heuristic: "attr=value[,...]" (attribute name or OID before the first '='). */
export function isLikelyDn(s: string): boolean {
  const t = s.trim()
  if (!/^([A-Za-z][\w-]*|\d+(\.\d+)+)\s*=\s*\S/.test(t)) return false
  return splitDn(t).every((r) => /^([A-Za-z][\w-]*|\d+(\.\d+)+)\s*=/.test(r))
}

export interface LdapUrl {
  scheme: 'ldap' | 'ldaps'
  host: string
  port?: number
  dn: string
  attributes?: string[]
  scope?: 'base' | 'one' | 'sub'
  filter?: string
}

/** ldap[s]://host[:port]/dn[?attrs[?scope[?filter]]] (DN percent-decoded). */
export function parseLdapUrl(input: string): LdapUrl | null {
  const m = input.trim().match(/^(ldaps?):\/\/([^/?]*)(?:\/([^?]*))?(?:\?(.*))?$/i)
  if (!m) return null
  const [, scheme, hostPort, rawDn = '', query] = m
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }
  let host = hostPort
  let port: number | undefined
  const pm = hostPort.match(/^(.*):(\d+)$/)
  if (pm) {
    host = pm[1]
    port = Number(pm[2])
  }
  const url: LdapUrl = { scheme: scheme.toLowerCase() as 'ldap' | 'ldaps', host: dec(host), port, dn: dec(rawDn) }
  if (query !== undefined) {
    const [attrs, scope, filter] = query.split('?')
    if (attrs) url.attributes = attrs.split(',').map(dec).filter(Boolean)
    if (scope === 'base' || scope === 'one' || scope === 'sub') url.scope = scope
    if (filter) url.filter = dec(filter)
  }
  return url
}

export type DnInput =
  | { kind: 'url'; dn: string; url: LdapUrl }
  | { kind: 'dn'; dn: string }
  | { kind: 'text'; text: string }

/** Classifies palette / breadcrumb input: an LDAP URL, a DN, or free text (a name). */
export function parseDnOrUrl(input: string): DnInput {
  const t = input.trim()
  const url = /^ldaps?:\/\//i.test(t) ? parseLdapUrl(t) : null
  if (url) return { kind: 'url', dn: url.dn, url }
  if (isLikelyDn(t)) return { kind: 'dn', dn: t }
  return { kind: 'text', text: t }
}

/** A string usable inside id / aria-* id references (DNs contain spaces and commas). */
export function domId(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return `${s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}-${(h >>> 0).toString(36)}`
}
