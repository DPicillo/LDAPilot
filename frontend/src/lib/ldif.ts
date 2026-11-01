/**
 * LDIF (RFC 2849) formatting of entries as delivered by the backend: text
 * values are plain strings, binary values (attr.binary) are already base64.
 * Values that are not SAFE-STRINGs (line breaks, leading space, ':' or '<',
 * trailing space, NUL and other control characters, non-ASCII) are written
 * base64-encoded ("attr:: ..."), and lines longer than 76 columns are folded
 * (continuation lines start with one space), so the backend importer
 * (internal/ldif) and other LDIF tools read back exactly the same data.
 *
 * AD values the backend renders as text (objectGUID, objectSid,
 * msExchMailboxGuid, msDS-GenerationId; internal/ldap/ad_format.go) are
 * written as their raw bytes ("objectGUID:: …"), like the Go exporter, so an
 * LDIF re-imports the same values (rawADValue).
 *
 * Used for the entry LDIF tab, "Copy as LDIF" and the search result export.
 * No imports, so the module runs under `node --test` (frontend/tests).
 */

interface LDIFEntry {
  attributes?: { name: string; values: string[]; binary?: boolean }[];
}

/** Maximum line length; longer lines are folded. */
export const LDIF_FOLD_WIDTH = 76;

/** True if value must be base64-encoded in LDIF. */
export function needsBase64(value: string): boolean {
  if (!value) return false;
  if (value.startsWith(' ') || value.startsWith(':') || value.startsWith('<')) return true;
  if (value.endsWith(' ')) return true;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    // NUL, CR, LF and all other control characters, DEL and everything outside ASCII
    if (c < 0x20 || c > 0x7e) return true;
  }
  return false;
}

/** Base64 of the UTF-8 encoding of s. */
export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * Folds a line to at most `width` columns: the first chunk has width
 * characters, every continuation line one space plus width-1 characters.
 * width <= 1 disables folding. Code points are never split.
 */
export function foldLDIFLine(line: string, width = LDIF_FOLD_WIDTH): string {
  if (width <= 1 || line.length <= width) return line;
  const chars = Array.from(line);
  if (chars.length <= width) return line;
  const parts = [chars.slice(0, width).join('')];
  for (let i = width; i < chars.length; i += width - 1) {
    parts.push(' ' + chars.slice(i, i + width - 1).join(''));
  }
  return parts.join('\n');
}

/**
 * One unfolded "name: value" / "name:: base64" line. Binary values are
 * already base64 and are written as is.
 */
export function ldifAttrLine(name: string, value: string, binary = false): string {
  if (binary) return `${name}:: ${value}`;
  return needsBase64(value) ? `${name}:: ${utf8ToBase64(value)}` : `${name}: ${value}`;
}

/** Base64 of raw bytes. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" (AD byte order: first three groups little-endian) -> 16 bytes. */
function guidBytes(s: string): Uint8Array | null {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(s.trim());
  if (!m) return null;
  const hex = (h: string) => h.match(/../g)!.map((b) => parseInt(b, 16));
  return new Uint8Array([...hex(m[1]).reverse(), ...hex(m[2]).reverse(), ...hex(m[3]).reverse(), ...hex(m[4]), ...hex(m[5])]);
}

/** "S-1-5-21-…" -> the binary SID (revision, count, 48-bit authority big-endian, sub-authorities little-endian). */
function sidBytes(s: string): Uint8Array | null {
  const parts = s.trim().split('-');
  if (parts.length < 3 || parts[0].toUpperCase() !== 'S' || parts.length - 3 > 15 || !parts.slice(1).every((p) => /^\d+$/.test(p))) return null;
  const rev = Number(parts[1]);
  const auth = BigInt(parts[2]);
  if (rev > 255 || auth >= 1n << 48n) return null;
  const subs = parts.slice(3).map(Number);
  if (subs.some((v) => v > 0xffffffff)) return null;
  const out = new Uint8Array(8 + 4 * subs.length);
  out[0] = rev;
  out[1] = subs.length;
  for (let i = 0; i < 6; i++) out[7 - i] = Number((auth >> BigInt(8 * i)) & 0xffn);
  subs.forEach((v, i) => {
    out[8 + 4 * i] = v & 0xff;
    out[9 + 4 * i] = (v >>> 8) & 0xff;
    out[10 + 4 * i] = (v >>> 16) & 0xff;
    out[11 + 4 * i] = (v >>> 24) & 0xff;
  });
  return out;
}

const AD_TEXT_BINARY: Record<string, (s: string) => Uint8Array | null> = {
  objectguid: guidBytes,
  objectsid: sidBytes,
  msexchmailboxguid: guidBytes,
  'msds-generationid': guidBytes,
};

/**
 * Base64 of the raw value of an AD attribute shown as text (objectGUID,
 * objectSid, msExchMailboxGuid, msDS-GenerationId), or null for other
 * attributes and values that do not parse (mirror of Go ldap.RawADValues).
 */
export function rawADValue(name: string, value: string): string | null {
  const parse = AD_TEXT_BINARY[name.split(';')[0].toLowerCase()];
  if (!parse) return null;
  const bytes = parse(value);
  return bytes ? bytesToBase64(bytes) : null;
}

/** One LDIF entry record, terminated by a newline (no blank separator line). */
export function formatEntryAsLDIF(dn: string, entry: LDIFEntry, width = LDIF_FOLD_WIDTH): string {
  const lines: string[] = [ldifAttrLine('dn', dn)];
  for (const attr of entry.attributes || []) {
    // All values of an AD attribute shown as text go back to raw bytes, or none does.
    const raw = attr.binary ? null : attr.values.map((v) => rawADValue(attr.name, v));
    const asRaw = !!raw && raw.length > 0 && raw.every((v) => v !== null);
    attr.values.forEach((val, i) => {
      lines.push(asRaw ? `${attr.name}:: ${raw![i]}` : ldifAttrLine(attr.name, val, !!attr.binary));
    });
  }
  return lines.map((l) => foldLDIFLine(l, width)).join('\n') + '\n';
}

/** Number of RDNs of a DN (escape-aware: "\," is not a separator). */
function ldifDNDepth(dn: string): number {
  if (!dn.trim()) return 0;
  let n = 1;
  for (let i = 0; i < dn.length; i++) {
    if (dn[i] === '\\') i++;
    else if (dn[i] === ',' || dn[i] === ';') n++;
  }
  return n;
}

/** Comparison key of a DN: lower case, blanks around unescaped "," "=" "+" removed (enough to match references). */
function ldifDNKey(dn: string): string {
  let out = '';
  let pending = '';
  const s = dn.trim().toLowerCase();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      out += pending + c + (s[i + 1] ?? '');
      pending = '';
      i++;
    } else if (c === ',' || c === '=' || c === '+' || c === ';') {
      out += c === ';' ? ',' : c;
      pending = '';
      while (s[i + 1] === ' ') i++;
    } else if (c === ' ') {
      pending += c;
    } else {
      out += pending + c;
      pending = '';
    }
  }
  return out;
}

/** The key of the parent of a DN ('' for a single RDN). */
function ldifParentKey(dn: string): string {
  for (let i = 0; i < dn.length; i++) {
    if (dn[i] === '\\') i++;
    else if (dn[i] === ',' || dn[i] === ';') return ldifDNKey(dn.slice(i + 1));
  }
  return '';
}

/**
 * Entries in the order an LDIF import of add records needs (mirror of Go
 * ldif.SortParentFirst): every entry after its parent and after the entries
 * of the list its values refer to (member, manager, …: AD refuses DN values
 * of entries that do not exist yet); otherwise fewer RDNs first, the order
 * kept. Reference cycles are broken by that order.
 */
export function sortParentFirst<T extends { dn: string; attributes?: LDIFEntry['attributes'] }>(entries: T[]): T[] {
  const n = entries.length;
  const depth = entries.map((e) => ldifDNDepth(e.dn));
  const keys = new Map<string, number>();
  entries.forEach((e, i) => {
    const k = ldifDNKey(e.dn);
    if (k && !keys.has(k)) keys.set(k, i);
  });
  const indeg = new Array<number>(n).fill(0);
  const users: number[][] = entries.map(() => []);
  entries.forEach((e, i) => {
    const seen = new Set([i]);
    const add = (j: number | undefined) => {
      if (j === undefined || seen.has(j)) return;
      seen.add(j);
      indeg[i]++;
      users[j].push(i);
    };
    add(keys.get(ldifParentKey(e.dn)));
    for (const a of e.attributes || []) {
      if (a.binary || a.name.toLowerCase() === 'objectclass') continue;
      for (const v of a.values) if (v.includes('=')) add(keys.get(ldifDNKey(v)));
    }
  });
  const less = (a: number, b: number) => depth[a] - depth[b] || a - b;
  const done = new Array<boolean>(n).fill(false);
  // Min-heap of the entries whose parent and references are written.
  const ready: number[] = [];
  const push = (x: number) => {
    let k = ready.push(x) - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (less(ready[k], ready[p]) >= 0) break;
      [ready[k], ready[p]] = [ready[p], ready[k]];
      k = p;
    }
  };
  const pop = (): number => {
    const top = ready[0];
    const last = ready.pop()!;
    if (ready.length) {
      ready[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < ready.length && less(ready[l], ready[m]) < 0) m = l;
        if (r < ready.length && less(ready[r], ready[m]) < 0) m = r;
        if (m === k) break;
        [ready[k], ready[m]] = [ready[m], ready[k]];
        k = m;
      }
    }
    return top;
  };
  for (let i = 0; i < n; i++) if (indeg[i] === 0) push(i);
  const out: T[] = [];
  while (out.length < n) {
    let i: number;
    if (ready.length) {
      i = pop();
    } else {
      // A reference cycle: the first remaining entry in depth order.
      i = -1;
      for (let j = 0; j < n; j++) if (!done[j] && (i < 0 || less(j, i) < 0)) i = j;
    }
    if (done[i]) continue;
    done[i] = true;
    out.push(entries[i]);
    for (const u of users[i]) if (--indeg[u] === 0 && !done[u]) push(u);
  }
  return out;
}

/** A complete LDIF file ("version: 1") with the entries separated by blank lines. */
export function formatEntriesAsLDIF(entries: (LDIFEntry & { dn: string })[], width = LDIF_FOLD_WIDTH): string {
  return ['version: 1\n', ...entries.map((e) => formatEntryAsLDIF(e.dn, e, width))].join('\n');
}

// --- Edit as LDIF (DEF-14): an editable form of one entry and its parser --------------

/**
 * True if a value cannot be written as a plain UTF-8 line in the editor
 * (formatEntryForEdit): leading space / ':' / '<', trailing space, line
 * breaks, NUL and other control characters. Non-ASCII text (Jürgen) stays
 * readable; internal/ldif and ldapmodify read UTF-8 value lines as they are.
 */
export function needsBase64ForEdit(value: string): boolean {
  if (!value) return false;
  if (value.startsWith(' ') || value.startsWith(':') || value.startsWith('<')) return true;
  if (value.endsWith(' ')) return true;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * The entry as an editable LDIF content record: text values as typed
 * (UTF-8, never folded, so a value is one line), base64 only where a plain
 * line cannot hold the value, binary values ("attr:: …") folded at 76
 * columns. Attributes are written as given: the caller leaves out what is
 * not editable. `comment` may name a binary value in a "# …" line above it
 * (which certificate / photo a base64 block is); comments are ignored when
 * the text is read back (parseLDIFRecord, internal/ldif, ldapmodify).
 */
export function formatEntryForEdit(
  dn: string,
  attributes: readonly { name: string; values: readonly string[]; binary?: boolean }[],
  opts: { comment?: (name: string, value: string, index: number, count: number) => string | undefined } = {},
): string {
  const lines: string[] = [];
  const plain = (name: string, value: string) => (needsBase64ForEdit(value) ? foldLDIFLine(`${name}:: ${utf8ToBase64(value)}`) : `${name}: ${value}`);
  lines.push(plain('dn', dn));
  for (const attr of attributes) {
    attr.values.forEach((v, i) => {
      if (attr.binary) {
        const note = opts.comment?.(attr.name, v, i, attr.values.length);
        if (note) lines.push(`# ${note.replace(/[\r\n]+/g, ' ')}`);
        lines.push(foldLDIFLine(`${attr.name}:: ${v}`));
      } else {
        lines.push(plain(attr.name, v));
      }
    });
  }
  return lines.join('\n') + '\n';
}

/** One value of a parsed record: plain text, or the base64 text of "attr:: …" (whitespace removed, not decoded). */
export interface LDIFParsedValue {
  value: string;
  base64: boolean;
  /** 1-based line of the value. */
  line: number;
}

export interface LDIFParsedAttribute {
  /** As first written (spelling of the first line). */
  name: string;
  values: LDIFParsedValue[];
}

export interface LDIFParseProblem {
  /** 1-based line (0 = the whole text). */
  line: number;
  message: string;
}

export interface LDIFParsedRecord {
  dn: string;
  dnLine: number;
  /** In input order; lines of one attribute (case-insensitive name) merged. */
  attributes: LDIFParsedAttribute[];
  errors: LDIFParseProblem[];
}

/** Attribute description: a name or numeric OID with options (mirror of Go ldif.ValidAttributeDescription). */
const ATTR_DESC_RE = /^(?:[A-Za-z][A-Za-z0-9-]*|[0-9]+(?:\.[0-9]+)*)(?:;[A-Za-z0-9=._-]+)*$/;

export function validAttributeDescription(name: string): boolean {
  return ATTR_DESC_RE.test(name);
}

/** Decodes standard base64 (padding optional, as Go's decoder after TrimSpace); null when invalid. */
export function decodeBase64Strict(b64: string): Uint8Array | null {
  const s = b64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  if (s.length % 4 === 1) return null;
  if (s.includes('=') && s.length % 4 !== 0) return null;
  let bin: string;
  try {
    bin = atob(s);
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Text of UTF-8 bytes, or null when they are not valid UTF-8. */
export function utf8Text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Parses the text of the Edit as LDIF editor: ONE content record (RFC 2849:
 * optional "version: 1", comments, folded lines, "attr:: base64"; blank
 * lines inside it are ignored, a second "dn:" record is an error). Change
 * records, control lines, URL values ("attr:< file://…"), "-" lines and
 * further records are reported as errors with their line, like the Go
 * importer's messages (internal/ldif/changes.go). Plain values keep trailing
 * blanks (as Go: only the blanks after the colon are skipped).
 */
export function parseLDIFRecord(text: string): LDIFParsedRecord {
  const errors: LDIFParseProblem[] = [];
  const physical = text.replace(/^﻿/, '').split('\n');
  // Unfold into logical lines; blank lines split records.
  const blocks: { text: string; line: number; comment: boolean }[][] = [];
  let cur: { text: string; line: number; comment: boolean }[] = [];
  const flush = () => {
    const kept = cur.filter((l) => !l.comment);
    if (kept.length) blocks.push(kept);
    cur = [];
  };
  physical.forEach((raw, i) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') {
      flush();
    } else if (line[0] === ' ') {
      if (!cur.length) errors.push({ line: i + 1, message: 'continuation line (starting with a space) without a preceding line' });
      else cur[cur.length - 1].text += line.slice(1);
    } else {
      cur.push({ text: line, line: i + 1, comment: line[0] === '#' });
    }
  });
  flush();

  const rec: LDIFParsedRecord = { dn: '', dnLine: 0, attributes: [], errors };
  if (blocks[0] && /^version\s*:/i.test(blocks[0][0].text)) {
    const first = blocks[0][0];
    const v = first.text.slice(first.text.indexOf(':') + 1).trim();
    if (v !== '1') errors.push({ line: first.line, message: `unsupported LDIF version "${v}" (only version 1)` });
    blocks[0] = blocks[0].slice(1);
    if (!blocks[0].length) blocks.shift();
  }
  if (!blocks[0]) {
    errors.push({ line: 0, message: 'the text holds no entry (it must start with a "dn:" line)' });
    return rec;
  }
  // One entry: a blank line followed by more attribute lines is part of it; a further
  // "dn:" record is not.
  const block = [...blocks[0]];
  for (const more of blocks.slice(1)) {
    if (/^dn\s*::?/i.test(more[0].text)) {
      errors.push({ line: more[0].line, message: 'only one entry can be edited here: remove the second record (from this dn: line on)' });
      break;
    }
    block.push(...more);
  }

  const byKey = new Map<string, LDIFParsedAttribute>();
  block.forEach((l, idx) => {
    if (l.text.trim() === '-') {
      errors.push({ line: l.line, message: 'unexpected "-" line: write the entry as it should be, not a change record' });
      return;
    }
    const colon = l.text.indexOf(':');
    if (colon <= 0) {
      errors.push({ line: l.line, message: `expected "attribute: value", found "${shortLDIF(l.text)}"` });
      return;
    }
    const name = l.text.slice(0, colon);
    const rest = l.text.slice(colon + 1);
    if (!validAttributeDescription(name)) {
      errors.push({ line: l.line, message: `invalid attribute name "${shortLDIF(name)}"` });
      return;
    }
    let value: string;
    let base64 = false;
    if (rest.startsWith(':')) {
      value = rest.slice(1).replace(/\s+/g, '');
      if (!decodeBase64Strict(value)) {
        errors.push({ line: l.line, message: `invalid base64 value of "${name}"` });
        return;
      }
      base64 = true;
    } else if (rest.startsWith('<')) {
      errors.push({ line: l.line, message: `URL values (${name}:< …) are not supported here: paste the value or use the attribute table's file actions` });
      return;
    } else {
      value = rest.replace(/^ +/, '');
    }
    const lower = name.toLowerCase();
    if (idx === 0) {
      if (lower !== 'dn') {
        errors.push({ line: l.line, message: `the record must start with a "dn:" line, found "${shortLDIF(name)}"` });
        return;
      }
      const dn = base64 ? utf8Text(decodeBase64Strict(value)!) : value;
      if (dn === null) errors.push({ line: l.line, message: 'the DN is not valid UTF-8' });
      rec.dn = dn ?? '';
      rec.dnLine = l.line;
      return;
    }
    if (lower === 'dn') {
      errors.push({ line: l.line, message: 'unexpected second "dn:" line: only one entry can be edited here' });
      return;
    }
    if (lower === 'changetype') {
      errors.push({ line: l.line, message: 'change records (changetype) are not edited here: write the entry as it should be, or use Import LDIF… for change records' });
      return;
    }
    if (lower === 'control') {
      errors.push({ line: l.line, message: 'control lines are not supported' });
      return;
    }
    const key = lower;
    let attr = byKey.get(key);
    if (!attr) {
      attr = { name, values: [] };
      byKey.set(key, attr);
      rec.attributes.push(attr);
    }
    attr.values.push({ value, base64, line: l.line });
  });
  return rec;
}

function shortLDIF(s: string): string {
  const chars = Array.from(s);
  return chars.length > 60 ? chars.slice(0, 60).join('') + '…' : s;
}
