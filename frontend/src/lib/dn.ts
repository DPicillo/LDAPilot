/**
 * Escape-aware DN helpers (RFC 4514), shared by all features. RDNs are
 * separated by ',' (or the legacy ';') outside backslash escapes and quoted
 * values, so the first RDN of "CN=Schmidt\, Anna,OU=Users,DC=x" is
 * "CN=Schmidt\, Anna". Never split a DN with dn.split(',').
 */

/** Index of the first RDN separator (',' or ';' outside escapes/quotes), or -1. */
export function firstRDNSeparator(dn: string): number {
  let inQuotes = false;
  for (let i = 0; i < dn.length; i++) {
    const c = dn[i];
    if (c === '\\') { i++; continue; }
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if ((c === ',' || c === ';') && !inQuotes) return i;
  }
  return -1;
}

/** The RDNs of a DN, as written (not trimmed, escapes kept). */
export function splitDN(dn: string): string[] {
  const parts: string[] = [];
  let rest = dn;
  for (let i = firstRDNSeparator(rest); i >= 0; i = firstRDNSeparator(rest)) {
    parts.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  parts.push(rest);
  return parts;
}

/** The first RDN of `dn` ("CN=Schmidt\, Anna" for "CN=Schmidt\, Anna,OU=X"). */
export function firstRDN(dn: string): string {
  const i = firstRDNSeparator(dn);
  return (i < 0 ? dn : dn.slice(0, i)).trim();
}

/** `dn` without its first RDN ('' for a single-RDN DN); escapes are kept. */
export function getParentDN(dn: string): string {
  const i = firstRDNSeparator(dn);
  return i < 0 ? '' : dn.slice(i + 1).trim();
}

/** Comparison key: lower case, no blanks around the separators and the first '=' of each RDN. */
export function normalizeDN(dn: string): string {
  if (!dn.trim()) return '';
  return splitDN(dn)
    .map((rdn) => rdn.trim().replace(/\s*=\s*/, '=').toLowerCase())
    .join(',');
}

/** Number of RDNs of a DN (0 for ''). */
export function dnDepth(dn: string): number {
  return dn.trim() ? splitDN(dn).length : 0;
}

/** True if `dn` equals `base` or lies below it (case-insensitive). */
export function isDNAtOrBelow(dn: string, base: string): boolean {
  const d = normalizeDN(dn);
  const b = normalizeDN(base);
  if (!b) return false;
  return d === b || d.endsWith(',' + b);
}

/** True if `dn` lies strictly below `ancestor` (case-insensitive). */
export function isDNBelow(dn: string, ancestor: string): boolean {
  const d = normalizeDN(dn);
  const a = normalizeDN(ancestor);
  return !!a && d.length > a.length && d.endsWith(',' + a);
}

/** Index of the first unescaped occurrence of ch in s, or -1. */
function indexOfUnescaped(s: string, ch: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === ch) return i;
  }
  return -1;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Removes RFC 4514 escaping from an attribute value (`\,` and `\2c` forms; hex escapes decoded as UTF-8). */
export function unescapeDNValue(value: string): string {
  // Most names have no escape, and every row of a tree or list comes through here:
  // encoding each character cost 36 – 100 µs per name (seconds for 40,000 entries).
  if (!value.includes('\\')) return value;
  const bytes: number[] = [];
  let plain = ''; // characters since the last escape, encoded in one go
  const flush = () => {
    if (!plain) return;
    for (const b of utf8Encoder.encode(plain)) bytes.push(b);
    plain = '';
  };
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== '\\' || i + 1 >= value.length) {
      plain += ch;
      continue;
    }
    flush();
    const hex = value.slice(i + 1, i + 3);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      const s = String.fromCodePoint(value.codePointAt(i + 1)!);
      for (const b of utf8Encoder.encode(s)) bytes.push(b);
      i += s.length;
    }
  }
  flush();
  return utf8Decoder.decode(Uint8Array.from(bytes));
}

/** Attribute type and unescaped value of an RDN ("cn=Doe\, John" → cn, "Doe, John"). */
export function parseRDN(rdn: string): { attr: string; value: string } {
  const eq = indexOfUnescaped(rdn, '=');
  if (eq < 0) return { attr: '', value: rdn };
  return { attr: rdn.slice(0, eq).trim(), value: unescapeDNValue(rdn.slice(eq + 1)) };
}

/** RFC 4514 escaping of an attribute value for a DN (like go-ldap's EscapeDN). */
export function escapeDNValue(value: string): string {
  let out = '';
  const chars = Array.from(value);
  chars.forEach((c, i) => {
    if (c === '\0') out += '\\00';
    else if ('"+,;<>\\'.includes(c) || (i === 0 && (c === ' ' || c === '#')) || (i === chars.length - 1 && c === ' ')) out += '\\' + c;
    else out += c;
  });
  return out;
}
