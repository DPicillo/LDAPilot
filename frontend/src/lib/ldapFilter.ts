/**
 * LDAP search filter helpers.
 */

/**
 * Escapes a value for use inside an LDAP search filter assertion (RFC 4515):
 * backslash, `*`, `(`, `)` and NUL become `\5c`, `\2a`, `\28`, `\29` and
 * `\00`. All other characters, including non-ASCII ones, are kept as they are.
 *
 * Example: `(cn=${escapeFilterValue(input)})`
 */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\u0000]/g, (ch) => {
    switch (ch) {
      case '\\': return '\\5c';
      case '*': return '\\2a';
      case '(': return '\\28';
      case ')': return '\\29';
      default: return '\\00';
    }
  });
}

/**
 * Inverse of escapeFilterValue: RFC 4515 `\XX` hex escapes back to the
 * characters (the bytes are UTF-8). A backslash not followed by two hex
 * digits keeps the next character (RFC 2254 style `\*`), a trailing one is
 * kept as is.
 */
export function unescapeFilterValue(value: string): string {
  if (!value.includes('\\')) return value;
  const bytes: number[] = [];
  const pushText = (t: string) => {
    for (const b of new TextEncoder().encode(t)) bytes.push(b);
  };
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== '\\') {
      pushText(ch);
      continue;
    }
    const hex = value.slice(i + 1, i + 3);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (i + 1 < value.length) {
      pushText(value[i + 1]);
      i += 1;
    } else {
      pushText('\\');
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** A parsed search filter (RFC 4515). Assertion values are unescaped. */
export type FilterNode =
  | { type: 'and' | 'or'; children: FilterNode[] }
  | { type: 'not'; child: FilterNode }
  | { type: 'present'; attr: string }
  | { type: 'equality' | 'approx' | 'greaterOrEqual' | 'lessOrEqual'; attr: string; value: string }
  | { type: 'substring'; attr: string; initial?: string; any: string[]; final?: string }
  /** `attr[:dn][:rule]:=value`; `attr` is everything before "=" (it ends with ":"). */
  | { type: 'extensible'; attr: string; value: string };

export class FilterParseError extends Error {
  /** 0-based offset in the trimmed filter. */
  readonly position: number;
  /** The message without the position. */
  readonly reason: string;
  constructor(message: string, position: number) {
    super(`${message} at position ${position + 1}`);
    this.position = position;
    this.reason = message;
  }
}

/**
 * Parses an LDAP search filter string (RFC 4515). Whitespace between the
 * parenthesised parts is tolerated, and a single item without the outer
 * parentheses ("cn=Jo*") is accepted. Throws FilterParseError.
 */
export function parseFilter(input: string): FilterNode {
  const src = input.trim();
  if (!src) throw new FilterParseError('Empty filter', 0);
  if (!src.startsWith('(')) {
    // "cn=foo" -> "(cn=foo)"
    const node = parseItem(src, 0, src.length);
    return node;
  }
  let pos = 0;
  const skipWs = () => {
    while (pos < src.length && /\s/.test(src[pos])) pos++;
  };
  const parse = (): FilterNode => {
    skipWs();
    if (src[pos] !== '(') throw new FilterParseError(pos >= src.length ? 'Missing ")"' : 'Expected "("', pos);
    pos++;
    skipWs();
    const op = src[pos];
    if (op === '&' || op === '|') {
      pos++;
      const children: FilterNode[] = [];
      skipWs();
      while (src[pos] === '(') {
        children.push(parse());
        skipWs();
      }
      if (src[pos] !== ')') throw new FilterParseError(pos >= src.length ? 'Missing ")"' : 'Expected "(" or ")"', pos);
      pos++;
      if (children.length === 0) throw new FilterParseError(`Empty ${op === '&' ? 'AND' : 'OR'}`, pos - 1);
      return { type: op === '&' ? 'and' : 'or', children };
    }
    if (op === '!') {
      pos++;
      const child = parse();
      skipWs();
      if (src[pos] !== ')') throw new FilterParseError(pos >= src.length ? 'Missing ")"' : 'NOT takes exactly one filter', pos);
      pos++;
      return { type: 'not', child };
    }
    // Simple item: up to the matching ")" (values cannot contain an unescaped parenthesis).
    const start = pos;
    while (pos < src.length && src[pos] !== ')' && src[pos] !== '(') pos++;
    if (src[pos] !== ')') throw new FilterParseError(src[pos] === '(' ? 'Unescaped "(" in a value' : 'Missing ")"', pos);
    const node = parseItem(src, start, pos);
    pos++;
    return node;
  };
  const node = parse();
  skipWs();
  if (pos < src.length) throw new FilterParseError('Unexpected text after the filter', pos);
  return node;
}

const ATTR_RE = /^(?:[A-Za-z][\w-]*|\d+(?:\.\d+)+)(?:;[\w-]+)*$/;

function parseItem(src: string, start: number, end: number): FilterNode {
  const item = src.slice(start, end);
  const eq = item.indexOf('=');
  if (eq <= 0) throw new FilterParseError(eq === 0 ? 'Attribute missing' : 'Expected "="', start);
  let attr = item.slice(0, eq);
  const raw = item.slice(eq + 1);
  const last = attr[attr.length - 1];
  if (last === ':') {
    if (!/^(?:[A-Za-z][\w-]*|\d+(?:\.\d+)+)?(?:;[\w-]+)*(?::dn)?(?::(?:[A-Za-z][\w-]*|\d+(?:\.\d+)+))?:$/i.test(attr) || attr === ':') {
      throw new FilterParseError(`Invalid extensible match "${attr}"`, start);
    }
    return { type: 'extensible', attr, value: unescapeFilterValue(raw) };
  }
  let type: 'equality' | 'approx' | 'greaterOrEqual' | 'lessOrEqual' = 'equality';
  if (last === '~' || last === '>' || last === '<') {
    attr = attr.slice(0, -1);
    type = last === '~' ? 'approx' : last === '>' ? 'greaterOrEqual' : 'lessOrEqual';
  }
  attr = attr.trim();
  if (!ATTR_RE.test(attr)) throw new FilterParseError(`Invalid attribute "${attr}"`, start);
  if (type !== 'equality') return { type, attr, value: unescapeFilterValue(raw) };
  if (raw === '*') return { type: 'present', attr };
  if (raw.includes('*')) {
    const parts = raw.split('*');
    const initial = parts[0] ? unescapeFilterValue(parts[0]) : undefined;
    const finalPart = parts[parts.length - 1];
    const final = finalPart ? unescapeFilterValue(finalPart) : undefined;
    const any = parts.slice(1, -1).filter((p) => p !== '').map(unescapeFilterValue);
    return { type: 'substring', attr, initial, any, final };
  }
  return { type: 'equality', attr, value: unescapeFilterValue(raw) };
}

/** Serializes a parsed filter (values escaped with escapeFilterValue). */
export function formatFilter(node: FilterNode): string {
  switch (node.type) {
    case 'and':
      return `(&${node.children.map(formatFilter).join('')})`;
    case 'or':
      return `(|${node.children.map(formatFilter).join('')})`;
    case 'not':
      return `(!${formatFilter(node.child)})`;
    case 'present':
      return `(${node.attr}=*)`;
    case 'equality':
      return `(${node.attr}=${escapeFilterValue(node.value)})`;
    case 'approx':
      return `(${node.attr}~=${escapeFilterValue(node.value)})`;
    case 'greaterOrEqual':
      return `(${node.attr}>=${escapeFilterValue(node.value)})`;
    case 'lessOrEqual':
      return `(${node.attr}<=${escapeFilterValue(node.value)})`;
    case 'extensible':
      return `(${node.attr}=${escapeFilterValue(node.value)})`;
    case 'substring': {
      const mid = node.any.map(escapeFilterValue);
      return `(${node.attr}=${escapeFilterValue(node.initial ?? '')}*${mid.length ? mid.join('*') + '*' : ''}${escapeFilterValue(node.final ?? '')})`;
    }
  }
}

/**
 * Readable message for a filter the server rejected: the local parser's
 * reason with the position ("Missing ")" at position 18") when it finds the
 * problem too, else the server text without the go-ldap prefixes
 * ('LDAP Result Code 201 "Filter Compile Error": ldap: …').
 */
export function describeFilterError(filter: string, serverMessage: string): string {
  try {
    parseFilter(filter);
  } catch (err) {
    if (err instanceof FilterParseError) return err.message;
  }
  const cleaned = serverMessage
    .replace(/^invalid LDAP filter:\s*/i, '')
    .replace(/^LDAP Result Code \d+ "[^"]*":\s*/i, '')
    .replace(/^ldap:\s*/i, '')
    .trim();
  if (!cleaned) return 'Invalid LDAP filter';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
