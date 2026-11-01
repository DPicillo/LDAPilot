/**
 * LDIF text helpers of the import dialog (pure; `node --test`):
 * - rebaseLDIF: moves the entries of a file below another container (an
 *   export of OU=Special Cases imported into a sandbox OU); relative DNs
 *   (single RDNs) get the container appended.
 * - ldifSkeleton: a starting record below a container.
 * - ldifRecordsAt: the records starting at given lines ("Retry failed").
 */
import { firstRDN, getParentDN, isDNAtOrBelow, normalizeDN, splitDN } from '../../lib/dn.ts'
import { foldLDIFLine, needsBase64, utf8ToBase64 } from '../../lib/ldif.ts'

interface LogicalLine {
  /** Unfolded text ('' for a blank line). */
  text: string
}

/** Unfolds an LDIF text into logical lines (RFC 2849: a line starting with one space continues the previous one). */
function unfold(content: string): LogicalLine[] {
  const out: LogicalLine[] = []
  for (const raw of content.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.startsWith(' ') && out.length > 0 && out[out.length - 1].text !== '' && !out[out.length - 1].text.startsWith('#')) {
      out[out.length - 1].text += raw.slice(1)
    } else {
      out.push({ text: raw })
    }
  }
  return out
}

function base64ToUtf8(b64: string): string | null {
  try {
    const bin = atob(b64.trim())
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** Splits "attr: value" / "attr:: base64" into its parts (null for comments, blanks, "-" and URL values). */
function splitLine(text: string): { attr: string; value: string; b64: boolean } | null {
  if (!text || text.startsWith('#') || text === '-') return null
  const m = /^([A-Za-z0-9][\w;.-]*):(:?)\s?(.*)$/.exec(text)
  if (!m || m[3].startsWith('<')) return null
  if (m[2] === ':') {
    const v = base64ToUtf8(m[3])
    return v === null ? null : { attr: m[1], value: v, b64: true }
  }
  return { attr: m[1], value: m[3], b64: false }
}

function joinLine(attr: string, value: string, b64: boolean): string {
  return b64 || needsBase64(value) ? `${attr}:: ${utf8ToBase64(value)}` : `${attr}: ${value}`
}

/** The record DNs of an LDIF text, in file order. */
export function ldifRecordDNs(content: string): string[] {
  const dns: string[] = []
  for (const l of unfold(content)) {
    const p = splitLine(l.text)
    if (p && p.attr.toLowerCase() === 'dn') dns.push(p.value.trim())
  }
  return dns
}

/** Deepest DN that every DN of `dns` is at or below ('' when they share none). */
function commonAncestor(dns: string[]): string {
  if (!dns.length) return ''
  const split = dns.map((d) => splitDN(d).map((r) => r.trim()))
  const n = Math.min(...split.map((s) => s.length))
  const common: string[] = []
  for (let i = 1; i <= n; i++) {
    const rdn = split[0][split[0].length - i]
    if (split.every((s) => s[s.length - i].toLowerCase().replace(/\s*=\s*/, '=') === rdn.toLowerCase().replace(/\s*=\s*/, '='))) common.unshift(rdn)
    else break
  }
  return common.join(',')
}

export interface RebaseResult {
  content: string
  /** The container the entries were below ('' for relative DNs). */
  oldBase: string
  /** Number of DNs changed (record DNs and DN values). */
  changed: number
}

/**
 * Moves the entries of an LDIF file below `target`: the topmost records'
 * common parent (oldBase) is replaced by `target` in every record DN, in
 * newsuperior lines and in DN values that point into the moved entries
 * (member, manager, …; values pointing elsewhere stay). A file whose topmost
 * DNs are single RDNs ("relative DNs") gets `target` appended instead.
 * Lines are re-folded at 76 columns.
 */
export function rebaseLDIF(content: string, target: string): RebaseResult {
  const t = target.trim()
  const dns = ldifRecordDNs(content)
  if (!t || dns.length === 0) return { content, oldBase: '', changed: 0 }
  const keys = new Set(dns.map(normalizeDN))
  // Topmost records: their parent is not a record of the file.
  const tops = dns.filter((d) => !keys.has(normalizeDN(getParentDN(d))))
  const relative = tops.every((d) => splitDN(d).length === 1)
  const oldBase = relative ? '' : commonAncestor(tops.map(getParentDN).filter(Boolean))
  if (!relative && !oldBase) return { content, oldBase: '', changed: 0 }
  if (!relative && normalizeDN(oldBase) === normalizeDN(t)) return { content, oldBase, changed: 0 }
  const topKeys = tops.map((d) => d)
  const inMoved = (dn: string) => topKeys.some((top) => isDNAtOrBelow(dn, top))
  const rebase = (dn: string): string => {
    const d = dn.trim()
    if (relative) return `${d},${t}`
    const keep = splitDN(d).length - splitDN(oldBase).length
    return [...splitDN(d).slice(0, keep).map((r) => r.trim()), t].join(',')
  }

  let changed = 0
  const out: string[] = []
  for (const l of unfold(content)) {
    const p = splitLine(l.text)
    if (!p) {
      out.push(l.text)
      continue
    }
    const a = p.attr.toLowerCase()
    let value = p.value
    if (a === 'dn' || (a !== 'changetype' && a !== 'newrdn' && a !== 'deleteoldrdn' && looksLikeDN(value) && inMoved(value))) {
      value = rebase(value)
    } else if (a === 'newsuperior' && !relative && (normalizeDN(value) === normalizeDN(oldBase) || inMoved(value))) {
      value = normalizeDN(value) === normalizeDN(oldBase) ? t : rebase(value)
    }
    if (value !== p.value) {
      changed++
      out.push(foldLDIFLine(joinLine(p.attr, value, p.b64)))
    } else {
      out.push(foldLDIFLine(l.text))
    }
  }
  return { content: out.join('\n'), oldBase, changed }
}

/** A value that parses as a DN with at least one attr=value RDN. */
function looksLikeDN(v: string): boolean {
  const s = v.trim()
  return /^[A-Za-z][\w-]*\s*=/.test(s) || /^\d+(\.\d+)+\s*=/.test(s)
}

/**
 * A starting record below `containerDN` (shown in the dialog's text area):
 * a new OU in the container's naming style.
 */
export function ldifSkeleton(containerDN: string): string {
  const upper = /^[A-Z]+=/.test(firstRDN(containerDN))
  const ou = upper ? 'OU' : 'ou'
  return [
    `# New entries below ${containerDN}`,
    `dn: ${ou}=New OU,${containerDN}`,
    'changetype: add',
    'objectClass: top',
    'objectClass: organizationalUnit',
    'ou: New OU',
    '',
  ].join('\n')
}

/**
 * The records of `content` that start at `lines` (1-based line of their dn:
 * line, as the dry run and the result report them), as a new LDIF text
 * ("Retry failed"). A record ends at the next blank line.
 */
export function ldifRecordsAt(content: string, lines: number[]): string {
  const phys = content.replace(/\r\n?/g, '\n').split('\n')
  const want = [...new Set(lines)].filter((n) => n >= 1 && n <= phys.length).sort((a, b) => a - b)
  const records: string[] = []
  for (const start of want) {
    const rec: string[] = []
    for (let i = start - 1; i < phys.length && phys[i].trim() !== ''; i++) rec.push(phys[i])
    if (rec.length) records.push(rec.join('\n'))
  }
  return records.length ? `version: 1\n\n${records.join('\n\n')}\n` : ''
}
