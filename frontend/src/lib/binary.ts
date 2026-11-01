/**
 * Pure helpers for binary attribute values. Binary values arrive as standard
 * base64 of the raw bytes (LDAPAttribute.binary, see CLAUDE.md "Binary
 * attribute contract"). No imports, so the module runs under `node --test`.
 */

/** Attribute type without options, lower-cased ("userCertificate;binary" → "usercertificate"). */
export function attrBaseName(name: string): string {
  const i = name.indexOf(';');
  return (i >= 0 ? name.slice(0, i) : name).toLowerCase();
}

export type BinaryKind = 'image' | 'certificate' | 'security-descriptor' | 'other';

const IMAGE_ATTRS = new Set(['jpegphoto', 'thumbnailphoto', 'thumbnaillogo', 'photo']);
const CERTIFICATE_ATTRS = new Set(['usercertificate', 'cacertificate', 'usersmimecertificate']);
const SECURITY_DESCRIPTOR_ATTRS = new Set([
  'ntsecuritydescriptor',
  'msexchmailboxsecuritydescriptor',
  'msds-allowedtoactonbehalfofotheridentity',
  'msds-groupmsamembership',
]);

/**
 * How values of a binary attribute are presented. 'certificate' covers
 * userSMIMECertificate too, whose values are usually PKCS #7 SignedData
 * (see isPKCS7SignedData) and sometimes a plain X.509 certificate.
 */
export function binaryKind(attrName: string): BinaryKind {
  const base = attrBaseName(attrName);
  if (IMAGE_ATTRS.has(base)) return 'image';
  if (CERTIFICATE_ATTRS.has(base)) return 'certificate';
  if (SECURITY_DESCRIPTOR_ATTRS.has(base)) return 'security-descriptor';
  return 'other';
}

/** Mirrors knownBinaryAttributes in internal/ldap/binary.go. */
const KNOWN_BINARY_ATTRS = new Set([
  'jpegphoto', 'thumbnailphoto', 'thumbnaillogo', 'photo', 'audio',
  'usercertificate', 'cacertificate', 'usersmimecertificate', 'crosscertificatepair',
  'certificaterevocationlist', 'authorityrevocationlist', 'deltarevocationlist',
  'userpkcs12', 'supportedalgorithms',
  'ntsecuritydescriptor', 'msexchmailboxsecuritydescriptor',
  'msds-allowedtoactonbehalfofotheridentity', 'msds-groupmsamembership',
  'objectsid', 'objectguid', 'sidhistory', 'securityidentifier', 'tokengroups',
  'tokengroupsglobalanduniversal', 'tokengroupsnogcacceptable', 'msexchmasteraccountsid',
  'msexchmailboxguid', 'ms-ds-consistencyguid', 'msds-generationid', 'schemaidguid',
  'attributesecurityguid', 'invocationid',
  'logonhours', 'msds-managedpassword', 'terminalserver',
  'replpropertymetadata', 'repluptodatevector', 'repsfrom', 'repsto', 'dsasignature',
  'partialattributeset',
]);

/**
 * LDAP syntaxes that are always binary: Binary, Certificate, Certificate
 * List, Certificate Pair, JPEG, Supported Algorithm and AD's NT security
 * descriptor. Octet String is left out on purpose: OpenLDAP uses it for
 * userPassword, which is edited as text.
 */
const BINARY_SYNTAXES = new Set([
  '1.3.6.1.4.1.1466.115.121.1.5',
  '1.3.6.1.4.1.1466.115.121.1.8',
  '1.3.6.1.4.1.1466.115.121.1.9',
  '1.3.6.1.4.1.1466.115.121.1.10',
  '1.3.6.1.4.1.1466.115.121.1.28',
  '1.3.6.1.4.1.1466.115.121.1.49',
  '1.2.840.113556.1.4.907',
]);

/**
 * True if values of the attribute must be handled as binary (file upload,
 * base64) even before the entry has a value: known binary names, the
 * ;binary option or a binary schema syntax.
 */
export function isBinaryAttributeName(attrName: string, syntax?: string): boolean {
  if (KNOWN_BINARY_ATTRS.has(attrBaseName(attrName))) return true;
  if (attrName.toLowerCase().split(';').slice(1).includes('binary')) return true;
  const oid = (syntax || '').replace(/\{\d+\}$/, '');
  return BINARY_SYNTAXES.has(oid);
}

/**
 * Syntaxes that RFC 4522/4523 servers (OpenLDAP) only accept with the
 * ";binary" transfer option: Certificate, Certificate List, Certificate Pair,
 * Supported Algorithm.
 */
const BINARY_TRANSFER_SYNTAXES = new Set([
  '1.3.6.1.4.1.1466.115.121.1.8',
  '1.3.6.1.4.1.1466.115.121.1.9',
  '1.3.6.1.4.1.1466.115.121.1.10',
  '1.3.6.1.4.1.1466.115.121.1.49',
]);

/**
 * Name to write a new binary attribute under: "userCertificate" becomes
 * "userCertificate;binary" when the schema syntax requires the transfer
 * option (OpenLDAP); AD and 389DS (Octet String) keep the plain name.
 */
export function binaryTransferName(attrName: string, syntax?: string): string {
  if (attrName.toLowerCase().split(';').slice(1).includes('binary')) return attrName;
  const oid = (syntax || '').replace(/\{\d+\}$/, '');
  return BINARY_TRANSFER_SYNTAXES.has(oid) ? `${attrName};binary` : attrName;
}

/** Number of bytes encoded by a padded base64 string. */
export function base64ByteLength(b64: string): number {
  if (!b64) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/** Decodes base64 (optionally only the first maxBytes bytes) to bytes; invalid input gives an empty array. */
export function base64ToBytes(b64: string, maxBytes?: number): Uint8Array {
  let src = b64;
  if (maxBytes !== undefined && maxBytes >= 0) {
    src = b64.slice(0, Math.ceil(maxBytes / 3) * 4);
  }
  let bin: string;
  try {
    bin = atob(src);
  } catch {
    return new Uint8Array(0);
  }
  const n = maxBytes !== undefined ? Math.min(bin.length, maxBytes) : bin.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Standard base64 of bytes. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif';

/** Image type from magic bytes (JPEG, PNG, GIF), or null. */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  return null;
}

/** DER of the signedData OID 1.2.840.113549.1.7.2, including its 06 09 header. */
const PKCS7_SIGNED_DATA_OID = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];

/**
 * True if the bytes start like PKCS #7 (CMS) SignedData: a SEQUENCE (definite
 * or indefinite length) whose first element is the signedData OID. The first
 * 16 bytes are enough.
 */
export function isPKCS7SignedData(bytes: Uint8Array): boolean {
  if (bytes.length < 2 || bytes[0] !== 0x30) return false;
  let off = 2;
  if (bytes[1] > 0x80) off += bytes[1] & 0x7f; // long form length; 0x80 = indefinite
  return PKCS7_SIGNED_DATA_OID.every((b, i) => bytes[off + i] === b);
}

/** True for userSMIMECertificate (any options), which holds PKCS #7 SignedData. */
export function isSMIMEAttribute(attrName: string): boolean {
  return attrBaseName(attrName) === 'usersmimecertificate';
}

/** data: URL for a base64 image value, or null if it is not a JPEG/PNG/GIF. */
export function imageDataUrl(b64: string): string | null {
  const mime = sniffImageMime(base64ToBytes(b64, 16));
  return mime ? `data:${mime};base64,${b64}` : null;
}

/** Short format name for a sniffed image type. */
export function imageFormatName(mime: ImageMime | null): string {
  switch (mime) {
    case 'image/jpeg': return 'JPEG';
    case 'image/png': return 'PNG';
    case 'image/gif': return 'GIF';
    default: return 'unknown format';
  }
}

/** Human-readable size: "812 bytes", "12.3 KiB", "1.5 MiB". */
export function formatByteSize(n: number): string {
  if (n === 1) return '1 byte';
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function hex2(b: number): string {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

/** Space-separated hex bytes of the first max bytes, with "…" if truncated. */
export function hexPreview(bytes: Uint8Array, max = 16, total = bytes.length): string {
  const shown = Array.from(bytes.subarray(0, max), hex2).join(' ');
  return total > Math.min(max, bytes.length) ? `${shown} …` : shown;
}

/** Printable ASCII of the first max bytes ("." for everything else), with "…" if truncated. */
export function asciiPreview(bytes: Uint8Array, max = 16, total = bytes.length): string {
  const shown = Array.from(bytes.subarray(0, max), (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
  return total > Math.min(max, bytes.length) ? `${shown}…` : shown;
}

/**
 * Classic hex dump: offset, 16 hex bytes (gap after 8) and the printable
 * ASCII column, e.g.
 * "00000000  01 00 04 8C 14 00 00 00  30 00 00 00 00 00 00 00  |........0.......|".
 */
export function hexDump(bytes: Uint8Array, bytesPerLine = 16): string {
  const lines: string[] = [];
  for (let off = 0; off < bytes.length; off += bytesPerLine) {
    const row = bytes.subarray(off, off + bytesPerLine);
    const hex: string[] = [];
    let ascii = '';
    for (let i = 0; i < bytesPerLine; i++) {
      if (i === bytesPerLine / 2) hex.push('');
      if (i < row.length) {
        hex.push(hex2(row[i]));
        ascii += row[i] >= 0x20 && row[i] < 0x7f ? String.fromCharCode(row[i]) : '.';
      } else {
        hex.push('  ');
      }
    }
    lines.push(`${off.toString(16).toUpperCase().padStart(8, '0')}  ${hex.join(' ')}  |${ascii}|`);
  }
  return lines.join('\n');
}

/** PEM text ("-----BEGIN CERTIFICATE-----", 64-column body) of a base64 DER value. */
export function toPEM(b64: string, label = 'CERTIFICATE'): string {
  const body = b64.match(/.{1,64}/g) || [];
  return [`-----BEGIN ${label}-----`, ...body, `-----END ${label}-----`, ''].join('\n');
}

export type CertValidityStatus = 'valid' | 'expiring' | 'expired' | 'not-yet-valid';

/**
 * Validity of a certificate at `now`: 'expired' after notAfter, 'expiring'
 * within warnDays before it, 'not-yet-valid' before notBefore. days is the
 * number of whole days until expiry (valid/expiring), since expiry (expired)
 * or until the start (not-yet-valid).
 */
export function certValidity(
  notBefore: string,
  notAfter: string,
  now: Date | number = Date.now(),
  warnDays = 30,
): { status: CertValidityStatus; days: number } {
  const t = typeof now === 'number' ? now : now.getTime();
  const start = Date.parse(notBefore);
  const end = Date.parse(notAfter);
  const day = 24 * 60 * 60 * 1000;
  if (!isNaN(start) && t < start) return { status: 'not-yet-valid', days: Math.ceil((start - t) / day) };
  if (isNaN(end)) return { status: 'valid', days: 0 };
  if (t > end) return { status: 'expired', days: Math.floor((t - end) / day) };
  const left = Math.floor((end - t) / day);
  return { status: left < warnDays ? 'expiring' : 'valid', days: left };
}

/** The CN of a DN-like string ("CN=John Doe,O=Example" → "John Doe"), or the whole string. */
export function commonName(dn: string): string {
  const m = dn.match(/(?:^|,)\s*CN=((?:\\.|[^,\\])*)/i);
  return m ? m[1].replace(/\\(.)/g, '$1') : dn;
}

/**
 * One-line summary of a binary value for side-by-side views (Compare
 * Entries, RW1-E-08): "JPEG image · 52 KiB · #1a2b3c4d" instead of 71,000
 * base64 characters. The fingerprint (FNV-1a of the base64 text) tells equal
 * and different values apart at a glance.
 */
export function binaryValueSummary(attrName: string, b64: string): string {
  const kind = binaryKind(attrName);
  let label = kind === 'certificate' ? 'Certificate' : kind === 'security-descriptor' ? 'Security descriptor' : 'Binary';
  if (kind === 'image' || kind === 'other') {
    try {
      // The first 24 bytes (32 base64 characters) are enough for the magic numbers.
      const head = atob(b64.length <= 32 ? b64 : b64.slice(0, 32));
      const bytes = Uint8Array.from(head, (c) => c.charCodeAt(0));
      const mime = sniffImageMime(bytes);
      if (mime) label = `${mime.replace('image/', '').toUpperCase()} image`;
      else if (kind === 'image') label = 'Image';
    } catch {
      if (kind === 'image') label = 'Image';
    }
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < b64.length; i++) {
    h ^= b64.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${label} · ${formatByteSize(base64ByteLength(b64))} · #${h.toString(16).padStart(8, '0')}`;
}
