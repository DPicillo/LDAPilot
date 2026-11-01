/**
 * Pure helpers for the AI chat UI: DN and filter detection, invisible
 * characters, CSV, password-like text, tool-result parsing, locality and
 * formatting. No runtime imports (type-only), so Node's test runner can load
 * this file directly (tests/ai/*.test.mjs).
 */
import type { AIConfig, Block, PasswordPreview, ToolStatus } from '../types/ai';

// --- DNs and filters --------------------------------------------------------

const WORD_JOINER = /\u2060/g;

/** Removes U+2060 (the harness inserts it to neutralize DN-like text). */
export function stripWordJoiner(s: string): string {
  return s.replace(WORD_JOINER, '');
}

/** Splits a DN on commas that are not escaped with a backslash. */
export function splitRDNs(dn: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < dn.length; i++) {
    const c = dn[i];
    if (c === '\\' && i + 1 < dn.length) {
      cur += c + dn[i + 1];
      i++;
      continue;
    }
    if (c === ',') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

const ATTR_TYPE = /^\s*([A-Za-z][A-Za-z0-9-]*|[0-9]+(\.[0-9]+)+)\s*$/;

function isAVA(s: string): boolean {
  const eq = s.indexOf('=');
  if (eq <= 0) return false;
  return ATTR_TYPE.test(s.slice(0, eq)) && s.slice(eq + 1).trim() !== '';
}

/**
 * A DN is text that parses to at least two RDNs of the form attr=value
 * (multi-valued RDNs joined by '+' are accepted). U+2060 is ignored.
 */
export function isDN(raw: string): boolean {
  const s = stripWordJoiner(raw).trim();
  if (s.length < 5 || s.length > 4096 || s.includes('\n')) return false;
  if (s.startsWith('(') || s.includes('://')) return false;
  const rdns = splitRDNs(s);
  if (rdns.length < 2) return false;
  return rdns.every((r) => r.split(/(?<!\\)\+/).every(isAVA));
}

/** A filter starts with "(", ends with ")", has balanced parentheses and an "=". */
export function isFilter(raw: string): boolean {
  const s = stripWordJoiner(raw).trim();
  if (s.length < 3 || s[0] !== '(' || s[s.length - 1] !== ')' || !s.includes('=')) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth < 0) return false;
      if (depth === 0 && i !== s.length - 1) return false;
    }
  }
  return depth === 0;
}

/** The value of the first RDN ("Anna Schmidt" for CN=Anna Schmidt,OU=…). */
export function rdnValue(dn: string): string {
  const first = splitRDNs(stripWordJoiner(dn))[0] ?? dn;
  const eq = first.indexOf('=');
  return unescapeValue((eq >= 0 ? first.slice(eq + 1) : first).trim());
}

/**
 * RFC 4514 unescaping of a DN value: "\," and the hex form "\3B" (UTF-8
 * byte sequences such as "\C3\A4"); "Semi\3BColon" showed as
 * "Semi3BColon" in chips. Same as lib/dn.ts unescapeDNValue, which this
 * import-free module cannot import.
 */
function unescapeValue(value: string): string {
  if (!value.includes('\\')) return value;
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < value.length; i++) {
    const cp = value.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (ch === '\\' && i + 1 < value.length) {
      const hex = value.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
      const next = String.fromCodePoint(value.codePointAt(i + 1)!);
      bytes.push(...enc.encode(next));
      i += next.length;
      continue;
    }
    bytes.push(...enc.encode(ch));
    i += ch.length - 1;
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** The parent DN, or "" for a single RDN. */
export function parentDN(dn: string): string {
  const parts = splitRDNs(stripWordJoiner(dn));
  return parts.slice(1).join(',').trim();
}

/** Lower-cased, whitespace-normalized DN for map keys. */
export function dnKey(dn: string): string {
  return splitRDNs(stripWordJoiner(dn)).map((r) => r.trim().toLowerCase()).join(',');
}

/** Splits on `sep` where it is not escaped with a backslash (escape pairs are kept). */
function splitUnescaped(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[i + 1];
      i++;
      continue;
    }
    if (c === sep) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Trims the spaces around an RDN value that are not escaped ("a\ " keeps its space). */
function trimValue(v: string): string {
  const out = v.replace(/^\s+/, '');
  let end = out.length;
  while (end > 0 && /\s/.test(out[end - 1])) {
    let bs = 0;
    for (let i = end - 2; i >= 0 && out[i] === '\\'; i--) bs++;
    if (bs % 2 === 1) break; // escaped space
    end--;
  }
  return out.slice(0, end);
}

/**
 * Comparison key of a DN that ignores how its values are escaped: types and
 * values lower-cased, values decoded from RFC 4514 escapes ("\3B" = "\;" =
 * ";"), multi-valued RDNs sorted. Null when the text is no DN.
 */
export function dnCanonKey(dn: string): string | null {
  const s = stripWordJoiner(dn).trim();
  if (!s) return null;
  const rdns: string[] = [];
  for (const rdn of splitRDNs(s)) {
    const avas: string[] = [];
    for (const ava of splitUnescaped(rdn, '+')) {
      const eq = ava.indexOf('=');
      if (eq <= 0 || !ATTR_TYPE.test(ava.slice(0, eq))) return null;
      const type = ava.slice(0, eq).trim().toLowerCase();
      const raw = trimValue(ava.slice(eq + 1));
      // "#…" is the BER form of a value; it is compared as written.
      const value = raw.startsWith('#') ? raw.toLowerCase() : unescapeValue(raw).toLowerCase();
      avas.push(type + '=' + value);
    }
    avas.sort();
    rdns.push(avas.join('+'));
  }
  // JSON stands in for a separator no decoded value can contain.
  return JSON.stringify(rdns);
}

/** A backslash that starts a valid RFC 4514 escape: a special character or two hex digits. */
const DN_ESCAPE = /^\\(?:[\\ ,+"<>;=#]|[0-9a-fA-F]{2})/;

/**
 * True when the text is a DN in strict RFC 4514 form: at least two RDNs of
 * type=value, every backslash starts a valid escape and no value holds an
 * unescaped `"`, `<`, `>` or `;`.
 */
export function isStrictDN(raw: string): boolean {
  const s = stripWordJoiner(raw).trim();
  if (!isDN(s)) return false;
  for (const rdn of splitRDNs(s)) {
    for (const ava of splitUnescaped(rdn, '+')) {
      const eq = ava.indexOf('=');
      if (eq <= 0) return false;
      const v = ava.slice(eq + 1);
      for (let i = 0; i < v.length; i++) {
        const c = v[i];
        if (c === '\\') {
          if (!DN_ESCAPE.test(v.slice(i))) return false;
          i += /^\\[0-9a-fA-F]{2}/.test(v.slice(i)) ? 2 : 1;
          continue;
        }
        if (c === '"' || c === '<' || c === '>' || c === ';') return false;
      }
    }
  }
  return true;
}

/**
 * Undoes the JSON string escaping a model copied from a tool result:
 * "\\" → "\" and "\"" → '"' ("CN=Quote \\\"Q\\\" User" → "CN=Quote \"Q\" User",
 * "\\<" → "\<"); every other backslash stays. Only for text that has a
 * doubled backslash (a correct DN may escape a quote as "\"").
 */
export function undoubleEscapes(dn: string): string {
  if (!dn.includes('\\\\')) return dn;
  let out = '';
  for (let i = 0; i < dn.length; i++) {
    const c = dn[i];
    const n = dn[i + 1];
    if (c === '\\' && (n === '\\' || n === '"')) {
      out += n;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * A DN as a model writes it in an answer: a DN, or one after undoing the
 * JSON escaping ("CN=Schmidt\\, Anna,OU=…" splits at the escaped comma
 * otherwise and was no link at all).
 */
export function isAnswerDN(raw: string): boolean {
  const s = stripWordJoiner(raw).trim();
  return isDN(s) || (s.includes('\\\\') && isDN(undoubleEscapes(s)));
}

/**
 * The DN a link in an answer opens (P3, A-21). Models copy DNs out of the
 * JSON tool results with the JSON escaping kept ("CN=Semi\\3BColon
 * \\<Angle\\>" for "CN=Semi\3BColon \<Angle\>"), and the link failed with
 * "Invalid DN Syntax". In order: a DN seen in the tool results (`lookup`
 * by dnCanonKey, so other escapes and case match too), the same after
 * collapsing doubled backslashes, else the collapsed form when only it is
 * a strict DN, else the text as written.
 */
export function resolveAnswerDN(raw: string, lookup: (canonKey: string) => string | undefined): string {
  const dn = stripWordJoiner(raw).trim();
  const key = dnCanonKey(dn);
  const hit = key ? lookup(key) : undefined;
  if (hit) return hit;
  if (!dn.includes('\\\\')) return dn;
  const single = undoubleEscapes(dn);
  const k2 = dnCanonKey(single);
  const hit2 = k2 ? lookup(k2) : undefined;
  if (hit2) return hit2;
  // A model doubles escapes far more often than a value holds a backslash
  // before a special character, so a valid collapsed form wins.
  return isStrictDN(single) ? single : dn;
}

/** True when dn equals base or lies below it (case-insensitive). */
export function dnUnder(dn: string, base: string): boolean {
  const d = dnKey(dn);
  const b = dnKey(base);
  if (!b) return false;
  return d === b || d.endsWith(',' + b);
}

/** Extracts the first balanced LDAP filter from text such as find_accounts' method. */
export function extractFilter(text: string): string | null {
  const start = text.indexOf('(');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        const f = text.slice(start, i + 1);
        return isFilter(f) ? f : null;
      }
    }
  }
  return null;
}

// --- invisible characters ---------------------------------------------------

const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/;
const INVISIBLE_G = new RegExp(INVISIBLE.source, 'g');

export function hasInvisible(s: string): boolean {
  return INVISIBLE.test(s);
}

export type TextSegment = { text: string; invisible: boolean };

/** Splits text into normal runs and single invisible characters (rendered as ⟨U+200B⟩ chips). */
export function splitInvisible(s: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  for (const m of s.matchAll(INVISIBLE_G)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: s.slice(last, i), invisible: false });
    out.push({ text: m[0], invisible: true });
    last = i + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), invisible: false });
  return out;
}

/** "U+200B" for a character. */
export function codePointLabel(ch: string): string {
  return 'U+' + (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
}

/** Replaces invisible characters with ⟨U+XXXX⟩ (for plain-text display). */
export function showInvisible(s: string): string {
  return s.replace(INVISIBLE_G, (c) => `⟨${codePointLabel(c)}⟩`);
}

// --- CSV --------------------------------------------------------------------

export function csvCell(v: string): string {
  return /[",;\n\r]/.test(v) || /^\s|\s$/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

export function toCSV(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(cellText).join('; ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Builds CSV (DN plus the returned attributes) from the result JSON of
 * search_ldap, find_accounts or get_membership. Returns null when the result
 * has no rows.
 */
export function csvFromToolResult(tool: string, resultJSON: string | undefined): string | null {
  const r = parseJSONObject(resultJSON);
  if (!r) return null;
  const listKey = tool === 'search_ldap' ? 'entries' : tool === 'find_accounts' ? 'accounts' : tool === 'get_membership' ? 'items' : tool === 'find_by_name' ? 'matches' : '';
  const items = listKey ? r[listKey] : undefined;
  if (!Array.isArray(items) || items.length === 0) return null;
  const cols: string[] = [];
  const rows: Record<string, string>[] = [];
  const addCol = (c: string) => { if (!cols.includes(c)) cols.push(c); };
  addCol('dn');
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(it as Record<string, unknown>)) {
      if (k === 'attrs' && v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [ak, av] of Object.entries(v as Record<string, unknown>)) {
          addCol(ak);
          row[ak] = cellText(av);
        }
        continue;
      }
      addCol(k);
      row[k] = cellText(v);
    }
    rows.push(row);
  }
  return toCSV([cols, ...rows.map((row) => cols.map((c) => stripWordJoiner(row[c] ?? '')))]);
}

// --- tool results -----------------------------------------------------------

export function parseJSONObject(s: string | undefined | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Pretty JSON for display (the input is returned unchanged when it is not JSON). */
export function prettyJSON(s: string | undefined | null): string {
  if (!s) return '';
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

/** The error code of a tool result (meta first, then the JSON body). */
export function resultErrorCode(b: Block | undefined): string {
  if (!b) return '';
  if (b.meta?.errorCode) return b.meta.errorCode;
  const r = parseJSONObject(b.content);
  const e = r?.error as { code?: unknown } | undefined;
  return typeof e?.code === 'string' ? e.code : '';
}

export function resultErrorHint(content: string | undefined): { message: string; hint: string } {
  const r = parseJSONObject(content);
  const e = (r?.error ?? {}) as { message?: unknown; hint?: unknown };
  return { message: typeof e.message === 'string' ? e.message : '', hint: typeof e.hint === 'string' ? e.hint : '' };
}

const DENIED_CODES = new Set(['DECLINED_BY_USER', 'APPROVAL_TIMEOUT', 'WRITES_DISABLED', 'READ_ONLY_PROFILE']);

/** Status of a persisted tool call from its result block. */
export function statusFromResult(use: Block | undefined, result: Block | undefined): ToolStatus {
  if (!result) {
    return use?.meta?.executing ? 'outcome_unknown' : 'not_executed';
  }
  if (!result.isError) return 'ok';
  const code = resultErrorCode(result);
  if (code === 'OUTCOME_UNKNOWN') return 'outcome_unknown';
  if (code === 'CANCELLED') return 'cancelled';
  if (code === 'STEP_LIMIT' || code === 'CONTEXT_TRUNCATED') return 'not_executed';
  if (DENIED_CODES.has(code)) return 'denied';
  if (code === 'ACCESS_DENIED_BY_POLICY' && use?.meta?.approval) return 'denied';
  return 'error';
}

export const TERMINAL_TOOL_STATUS: ReadonlySet<string> = new Set(['ok', 'error', 'denied', 'cancelled', 'not_executed', 'outcome_unknown']);

// --- secrets in the composer (§6.9) ----------------------------------------

const PASSWORD_LABEL = /\b(pass(wort|word)?|pwd|kennwort|pw|initial(es)? ?passwort)\s*[:=]\s*\S+/i;

/** True when text looks like it contains a password (label pattern or a long high-entropy token). */
export function looksLikePassword(text: string): boolean {
  if (PASSWORD_LABEL.test(text)) return true;
  for (const tok of text.split(/\s+/)) {
    if (tok.length < 20 || tok.length > 200) continue;
    if (/[/\\,=():@]/.test(tok)) continue; // DNs, filters, URLs, paths, e-mail
    if (/^[0-9a-f-]+$/i.test(tok)) continue; // GUIDs, hashes
    let classes = 0;
    if (/[a-z]/.test(tok)) classes++;
    if (/[A-Z]/.test(tok)) classes++;
    if (/[0-9]/.test(tok)) classes++;
    if (/[^A-Za-z0-9]/.test(tok)) classes++;
    if (classes >= 3 && /[0-9]/.test(tok)) return true;
  }
  return false;
}

export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

export const MAX_MESSAGE_BYTES = 64 * 1024;

// --- locality (§6.8) --------------------------------------------------------

export function urlHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return '';
  }
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export const DEFAULT_URLS: Record<string, string> = {
  ollama: 'http://localhost:11434',
  anthropic: 'https://api.anthropic.com',
  'openai/openai': 'https://api.openai.com/v1',
  'openai/litellm': 'http://localhost:4000/v1',
  'openai/ollama': 'http://localhost:11434/v1',
  'openai/vllm': 'http://localhost:8000/v1',
  'openai/lmstudio': 'http://localhost:1234/v1',
};

/** Provider key as Go's provider.ProviderKey (models_updated.providerKey). */
export function providerKeyOf(cfg: Pick<AIConfig, 'engine' | 'provider' | 'flavor'>): string {
  if (cfg.engine === 'claudecode') return 'claudecode';
  if (cfg.provider === 'openai') return 'openai/' + (cfg.flavor || 'custom');
  return cfg.provider;
}

export interface Destination { host: string; local: boolean }

/** Mirrors permission.Classify: where chat data goes, and whether that is local. */
export function classifyDestination(
  cfg: Pick<AIConfig, 'engine' | 'provider' | 'flavor' | 'url' | 'endpointLocal'>,
  modelRemote = false,
): Destination {
  if (cfg.engine === 'claudecode') return { host: 'api.anthropic.com (Claude Code)', local: false };
  let host = urlHost(cfg.url);
  if (!host) host = urlHost(DEFAULT_URLS[providerKeyOf({ ...cfg, engine: 'builtin' })] ?? '');
  const loop = isLoopbackHost(host);
  let local = false;
  const flavor = cfg.flavor || 'custom';
  if (cfg.provider === 'ollama' || (cfg.provider === 'openai' && flavor === 'ollama')) {
    local = loop && !modelRemote;
  } else if (cfg.provider === 'openai' && ['litellm', 'custom', 'vllm', 'lmstudio'].includes(flavor)) {
    local = loop && !!cfg.endpointLocal && !modelRemote;
  }
  return { host, local };
}

// --- formatting -------------------------------------------------------------

/** Relative time from unix milliseconds (fixes audit 2.18: all timestamps are ms). */
export function formatRelativeTime(ms: number, now: number = Date.now()): string {
  if (!ms) return '';
  const diff = now - ms;
  if (diff < 45_000) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${Math.max(1, min)}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d ago`;
  if (d < 35) return `${Math.floor(d / 7)}w ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

/**
 * Token counts and context-window sizes: "1.5k", "128k", "1M". A value
 * that is a whole number of binary units (1024 / 1048576) but not of
 * decimal ones is a power-of-two style window size and is shown in binary
 * units, as model cards and Ollama's num_ctx name them: 16384 → "16k",
 * 24576 → "24k", 32768 → "32k" (not "33k"), 262144 → "256k". Decimal
 * sizes stay decimal (128000 → "128k", 200000 → "200k").
 */
export function formatTokens(n: number | undefined): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    if (n % 1000 !== 0 && n % 1024 === 0) return n / 1024 + 'k';
    if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return Math.round(n / 1000) + 'k';
  }
  if (n % 1_000_000 !== 0 && n % 1_048_576 === 0) return n / 1_048_576 + 'M';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

/**
 * The approval card's "Must change" row of a password reset. On 389 DS the
 * server's password policy (passwordMustChange) decides after a reset, not
 * the request: mustChange is then the policy's outcome when it is readable,
 * and the plan's note on the card names the policy and its value (2b
 * defect 2: the card said "no" while the server forced the change).
 */
export function mustChangeText(pw: Pick<PasswordPreview, 'mustChange'>, serverType?: string): string {
  if (serverType === '389ds') return pw.mustChange ? 'at next logon (server password policy)' : 'decided by the server password policy';
  return pw.mustChange ? 'at next logon' : 'no';
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return '';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')} min`;
}

/** "9:32" countdown. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatCost(usd: number | undefined): string {
  if (!usd) return '';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Parses "code: message" errors from the AI facade. */
export function parseFacadeError(err: unknown): { code: string; message: string } {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err ?? 'Unknown error');
  const m = /^([a-z][a-z_]*): ([\s\S]*)$/.exec(raw);
  if (m) return { code: m[1], message: m[2] };
  return { code: '', message: raw };
}

// --- status lines -------------------------------------------------------------

/**
 * Splits a Go duration in parentheses at the end of a status message
 * ("The model is reading the conversation… (1m3s)") into the message and
 * milliseconds, so the UI can count on live between the 15 s repeats.
 */
export function splitElapsed(message: string): { text: string; elapsedMs: number } | null {
  const m = /\s*\(((?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?)\)\s*$/.exec(message);
  if (!m || !m[1]) return null;
  const ms = ((Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 60 + Number(m[4] ?? 0)) * 1000;
  return { text: message.slice(0, m.index), elapsedMs: ms };
}
