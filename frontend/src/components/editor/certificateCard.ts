/**
 * Certificate card texts (DEF-12) and the value list of the binary value
 * picker (DEF-13). Pure: tests/editor.binary.test.ts.
 *
 * The card shows what the certificate is for (extended key usages, else the
 * key usages), its main alternative names (UPN / email / DNS first) and an
 * expiry warning with the date; the picker lists every photo or certificate
 * value of an entry so Download / Replace never silently take the first one.
 */
import type { CertificateAltName, CertificateSummary } from '../../types/binary'
import type { LDAPAttribute } from '../../types/ldap'
import { base64ByteLength, base64ToBytes, binaryKind, certValidity, commonName, formatByteSize, imageFormatName, sniffImageMime, type BinaryKind } from '../../lib/binary.ts'

/** Alternative names in certificate order (older backends: rebuilt from the flat lists). */
export function certAltNames(info: CertificateSummary): CertificateAltName[] {
  if (info.altNames) return info.altNames
  return [
    ...info.upns.map((value) => ({ type: 'UPN', value })),
    ...info.emailAddresses.map((value) => ({ type: 'Email', value })),
    ...info.dnsNames.map((value) => ({ type: 'DNS', value })),
    ...info.ipAddresses.map((value) => ({ type: 'IP', value })),
    ...info.uris.map((value) => ({ type: 'URI', value })),
  ]
}

/** Types shown first on the card: the names an admin looks for (a logon, a mailbox, a host). */
const ALT_RANK: Record<string, number> = { UPN: 0, Email: 1, DNS: 2, IP: 3, URI: 4 }

/** "UPN anna@ad.lab · Email anna@x.org" (at most `max`) and how many more there are. */
export function certAltNameLine(info: CertificateSummary, max = 2): { text: string; more: number; all: string } {
  const names = certAltNames(info)
  const ranked = [...names].sort((a, b) => (ALT_RANK[a.type] ?? 9) - (ALT_RANK[b.type] ?? 9))
  const shown = ranked.slice(0, max)
  return {
    text: shown.map((n) => `${n.type} ${n.value}`).join(' · '),
    more: names.length - shown.length,
    all: names.map((n) => `${n.type}: ${n.value}`).join('\n'),
  }
}

/** What the certificate is for: its extended key usages, else its key usages ('' when unrestricted). */
export function certPurpose(info: CertificateSummary): string {
  if (info.extKeyUsage.length) return info.extKeyUsage.join(' · ')
  return info.keyUsage.join(' · ')
}

/** "2027-01-02" of an RFC 3339 time. */
export function certDay(iso: string): string {
  return iso.slice(0, 10)
}

export interface CertExpiryNote {
  tone: 'warning' | 'danger'
  text: string
}

/**
 * The expiry warning of the card: expired, expiring within `warnDays`, or
 * not valid yet; null for a valid certificate.
 */
export function certExpiryNote(info: Pick<CertificateSummary, 'notBefore' | 'notAfter'>, now: Date | number = Date.now(), warnDays = 30): CertExpiryNote | null {
  const v = certValidity(info.notBefore, info.notAfter, now, warnDays)
  const until = certDay(info.notAfter)
  switch (v.status) {
    case 'expired':
      return { tone: 'danger', text: v.days === 0 ? `Expired today (${until})` : `Expired ${v.days} day${v.days === 1 ? '' : 's'} ago (${until})` }
    case 'expiring':
      return { tone: 'warning', text: v.days === 0 ? `Expires today (${until})` : `Expires in ${v.days} day${v.days === 1 ? '' : 's'} (${until})` }
    case 'not-yet-valid':
      return { tone: 'warning', text: `Not valid before ${certDay(info.notBefore)} (in ${v.days} day${v.days === 1 ? '' : 's'})` }
  }
  return null
}

/** "expires 2027-01-02" / "expired 2026-09-22" / "valid from 2027-01-01". */
export function certWhen(info: Pick<CertificateSummary, 'notBefore' | 'notAfter'>, now: Date | number = Date.now()): string {
  const v = certValidity(info.notBefore, info.notAfter, now)
  return v.status === 'expired' ? `expired ${certDay(info.notAfter)}` : v.status === 'not-yet-valid' ? `valid from ${certDay(info.notBefore)}` : `expires ${certDay(info.notAfter)}`
}

/** One line for a certificate in LDIF comments and change lists: "Anna Schmidt · Client Authentication · expires 2027-01-02". */
export function certChoiceLine(info: CertificateSummary, now: Date | number = Date.now()): string {
  const purpose = info.extKeyUsage.slice(0, 2).join(', ')
  return [commonName(info.subject), purpose, certWhen(info, now)].filter(Boolean).join(' · ')
}

// --- Value picker (DEF-13) -----------------------------------------------------------

export interface BinaryChoice {
  /** Attribute as stored ("userCertificate;binary"). */
  attribute: string
  /** Index of the value in the attribute. */
  index: number
  /** Number of values of the attribute. */
  of: number
  /** Base64 value. */
  value: string
  kind: BinaryKind
  bytes: number
}

/**
 * Every value of the named attributes (case-insensitive, in the order of
 * `names`, then stored order) that the entry has: what Download / Replace
 * choose from.
 */
export function binaryChoices(attributes: readonly LDAPAttribute[] | undefined | null, names: readonly string[]): BinaryChoice[] {
  const out: BinaryChoice[] = []
  const seen = new Set<string>()
  for (const n of names) {
    const lower = n.toLowerCase()
    for (const a of attributes ?? []) {
      if (a.name.toLowerCase() !== lower || seen.has(a.name.toLowerCase())) continue
      seen.add(a.name.toLowerCase())
      a.values.forEach((value, index) => {
        out.push({ attribute: a.name, index, of: a.values.length, value, kind: binaryKind(a.name), bytes: base64ByteLength(value) })
      })
    }
  }
  return out
}

/** "thumbnailPhoto" / "jpegPhoto 2 of 3". */
export function choiceTitle(c: BinaryChoice): string {
  return c.of > 1 ? `${c.attribute} ${c.index + 1} of ${c.of}` : c.attribute
}

/** Format and size of a value without decoding it: "JPEG · 12.3 KiB" / "Certificate · 1.2 KiB". */
export function choiceMeta(c: BinaryChoice): string {
  if (c.kind === 'image') {
    const mime = sniffImageMime(base64ToBytes(c.value, 16))
    return `${mime ? imageFormatName(mime) : 'Not an image'} · ${formatByteSize(c.bytes)}`
  }
  if (c.kind === 'certificate') return `Certificate data · ${formatByteSize(c.bytes)}`
  return formatByteSize(c.bytes)
}

/**
 * A short name of a binary value for LDIF comments and change lists: the
 * certificate line when the summary is known, the image format for photos,
 * undefined otherwise (callers fall back to format, size and hash).
 */
export function binaryValueLabel(attribute: string, base64: string, cert?: CertificateSummary | null, now: Date | number = Date.now()): string | undefined {
  const kind = binaryKind(attribute)
  if (kind === 'certificate' && cert) return certChoiceLine(cert, now)
  if (kind === 'image') {
    const mime = sniffImageMime(base64ToBytes(base64, 16))
    return mime ? `${imageFormatName(mime)} image` : 'not an image'
  }
  return undefined
}

// --- Attribute table layout at narrow widths (RW1-E-13) -------------------------------

/** Width of the Attribute column: 220 px, down to 140 px (28 % of the table) below 760 px so values keep room. */
export function nameColumnWidth(tableWidth: number): number {
  if (!tableWidth || tableWidth >= 760) return 220
  return Math.min(220, Math.max(140, Math.round(tableWidth * 0.28)))
}
