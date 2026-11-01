/**
 * Passwords typed into the AI composer (A-13). Pure and import-free, so the
 * Node test runner loads it directly (tests/ai/password.test.mjs).
 *
 * The same scanner exists in Go (internal/ai/secrettext.go, used by the
 * facade before a message is stored and by the Markdown export); both are
 * checked against frontend/tests/ai/password-phrases.json. Keep them in
 * step.
 *
 * A *strong* match is a value next to a password word:
 *   "password: X", "pw=X", "Kennwort: X", "set the password of jdoe to X",
 *   "Kennwort von jdoe auf X setzen", "the password is X", "password 'X'",
 *   "use X as the new password", "X ist das neue Passwort".
 * A *weak* match is only a long random-looking token (no password word),
 * which may as well be an ID; the composer still lets the user send it.
 */

/** What replaces a detected password value. */
export const PASSWORD_PLACEHOLDER = '[password removed]';

export interface PasswordMatch {
  /** UTF-16 offsets of the value (quotes included) in the text */
  start: number;
  end: number;
  /** the password word that introduced it ("password", "Kennwort", "pw", …) */
  keyword: string;
  /** UTF-16 offsets of that word */
  keywordStart: number;
  keywordEnd: number;
  /** entry the password is for, when the text names one ("of jdoe", "von Anna Schmidt") */
  target: string;
  /** "de" when the password word is German */
  lang: 'en' | 'de';
  /**
   * false only for a plain word after a label ("PW: geheim", "Password for
   * jdoe: secret"): it may be a password or a word, so the composer lets the
   * user send it anyway and the Go facade does not mask it. Everything else
   * (password-shaped values, quoted values, "password … to X") is sure.
   */
  sure: boolean;
}

export interface PasswordScan {
  matches: PasswordMatch[];
  /** a long high-entropy token without a password word */
  weak: boolean;
  /**
   * The message already had a password removed ("[password removed]") and
   * still contains a password-shaped value (a second password without its
   * own password word: "…\nUser: anna Herbst#2026"). Warns like weak.
   */
  leftover: boolean;
}

const QUOTES: Record<string, string> = {
  '"': '"', "'": "'", '`': '`', '“': '”“', '„': '“”', '‚': '‘’', '‘': '’', '«': '»', '»': '«', '‹': '›',
};

/**
 * Password words: words ending in one of these (userPassword, Initialpasswort,
 * unicodePwd, olcRootPW, rootpw, bindpw, …). pwdLastSet, pwdPolicy or
 * badPwdCount do not end in one, so they are no password words.
 */
const KEYWORD_SUFFIXES = ['password', 'passwort', 'kennwort', 'passwd', 'passphrase', 'pwd', 'pw'];
/** plurals: "passwords: jdoe=X, anna=Y" lists name/value pairs */
const PLURAL_SUFFIXES = ['passwords', 'passwörter', 'passwoerter', 'kennwörter', 'kennwoerter', 'passworte', 'kennworte', 'passphrases'];
/** password words that only count with a label ("pass: X", "credentials=X") */
const LABEL_ONLY = new Set(['pass', 'credentials', 'credential']);

/** words that introduce the value ("to", "auf", "is", ":") */
const CONNECTORS = new Set([
  'to', 'is', 'be', 'will', 'should', 'shall', 'must', 'now', 'set', 'as', 'equals', 'becomes', 'become', '->', '→', '=>', ':', '=',
  'auf', 'ist', 'lautet', 'lauten', 'jetzt', 'nun', 'als', 'zu', 'wird', 'werden', 'soll', 'sollte', 'muss', 'sein',
]);
/** words that introduce the entry the password belongs to ("of jdoe") */
const TARGET_PREPS = new Set(['of', 'for', 'from', 'on', 'von', 'für', 'fuer', 'des', 'der', 'vom', 'beim', 'bei']);
/** connectors that end the target part ("for jdoe to …") */
const TARGET_END = new Set(['to', 'as', 'is', '=', ':', '->', '→', '=>', 'auf', 'als', 'ist', 'lautet', 'zu']);
/** modal and auxiliary verbs that also end it once it named someone ("for jdoe should be …") */
const MODALS = new Set([
  'should', 'shall', 'will', 'would', 'must', 'can', 'be', 'becomes', 'become', 'equals', 'lauten',
  'soll', 'sollte', 'wird', 'werden', 'muss', 'kann', 'sein',
]);
/** what ends a target that was not introduced by a preposition ("Password jdoe: X", "Kennwort jdoe -> X") */
const IMPLICIT_END = new Set([':', '=', '->', '→', '=>', 'to', 'auf']);
/** verbs right after the password word ("Passwort zurücksetzen auf X", "Passwort setzen: X") */
const VERBS_AFTER = new Set([
  'setzen', 'setze', 'ändern', 'ändere', 'aendern', 'zurücksetzen', 'zuruecksetzen', 'neu', 'vergeben', 'festlegen',
  'change', 'reset', 'update',
]);
const ARTICLES = new Set([
  'the', 'a', 'an', 'new', 'his', 'her', 'their', 'its', 'my', 'your', 'initial', 'temporary', 'default', 'start',
  'das', 'den', 'dem', 'die', 'der', 'ein', 'eine', 'einen', 'sein', 'seine', 'ihr', 'ihre', 'neue', 'neues', 'neuen', 'initiale', 'initiales', 'temporäre', 'temporäres', 'mein', 'dein',
]);
/** status words that follow "password:" without being a password */
const STATUS_WORDS = new Set([
  'none', 'null', 'empty', 'blank', 'n/a', 'unknown', 'set', 'unset', 'expired', 'never', 'required', 'locked', 'changed', 'reset',
  'ok', 'yes', 'no', 'true', 'false', 'leer', 'gesetzt', 'abgelaufen', 'nie', 'ja', 'nein', 'unbekannt', 'keins', 'keines',
  'hidden', 'masked', 'redacted', 'removed', 'hashed', 'encrypted', 'random', 'generated', 'optional', 'disabled', 'enabled',
  'expiring', 'expires', 'valid', 'invalid', 'wrong', 'weak', 'strong', 'missing', 'versteckt', 'verschlüsselt', 'zufällig',
  'generiert', 'gültig', 'ungültig', 'falsch', 'fehlt', 'erforderlich',
]);
/** what may follow a plain word that is the whole value after a label */
const VALUE_FOLLOW = new Set(['and', 'und', 'or', 'oder', 'then', 'dann', 'please', 'bitte', '|', '-', '–', '—']);
/** words that join a further "of anna to X" to a match */
const JOINERS = new Set([',', ';', '&', 'and', 'und', 'sowie', 'plus']);
/** "(old one was X)", "(alt: X)" after a match */
const PAREN_WORDS = new Set(['old', 'alt', 'alte', 'altes', 'previous', 'vorher', 'bisher', 'früher', 'current', 'aktuell', 'aktuelles', 'new', 'neu', 'neues', 'temp']);
const PAREN_CONNECTORS = new Set(['was', 'war', 'is', 'ist', 'lautet', 'lautete', ':', '=']);
/** words of a target that name no account ("for user Admin01!" ends with an exclamation, not a password) */
const GENERIC_TARGET = new Set(['user', 'users', 'account', 'accounts', 'benutzer', 'benutzerin', 'konto', 'nutzer', 'nutzerin', 'person', 'entry', 'eintrag', 'object', 'objekt']);
/** verbs before "X for the password" ("Use X for the password") */
const USE_VERBS = new Set(['use', 'take', 'try', 'verwende', 'nimm', 'benutze', 'nehme']);
/** OpenLDAP clients whose -w (ldappasswd: also -s/-a) takes a password */
const LDAP_CLIENT = /(^|[\s`$>|;&(])ldap(search|modify|add|delete|modrdn|passwd|whoami|compare|exop|url)\b/i;

const isLetter = (c: string) => /\p{L}/u.test(c);
const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\u00a0';

interface Tok {
  start: number;
  end: number;
  /** the value without quotes */
  text: string;
  quoted: boolean;
}

function closingQuote(text: string, i: number): number {
  const open = text[i];
  const closers = QUOTES[open];
  if (!closers) return -1;
  // "'" inside a word is an apostrophe, not a quote ("Anna's").
  if (open === "'" && i > 0 && /[\p{L}\p{N}]/u.test(text[i - 1])) return -1;
  if (i + 1 >= text.length || isSpace(text[i + 1]) || text[i + 1] === '\n') return -1;
  for (let j = i + 1; j < text.length && j - i <= 129; j++) {
    const c = text[j];
    if (c === '\n') return -1;
    if (closers.includes(c) && !isSpace(text[j - 1])) {
      if (open === "'" && j + 1 < text.length && /[\p{L}\p{N}]/u.test(text[j + 1])) continue;
      return j;
    }
  }
  return -1;
}

/** The token at i (spaces skipped, never across a line break), or null. */
function tokenAt(text: string, i: number): Tok | null {
  while (i < text.length && isSpace(text[i])) i++;
  if (i >= text.length || text[i] === '\n' || text[i] === '\r') return null;
  // An earlier removal stays one token.
  if (text.startsWith(PASSWORD_PLACEHOLDER, i)) return { start: i, end: i + PASSWORD_PLACEHOLDER.length, text: PASSWORD_PLACEHOLDER, quoted: false };
  const close = closingQuote(text, i);
  if (close > i) return { start: i, end: close + 1, text: text.slice(i + 1, close), quoted: true };
  let j = i;
  while (j < text.length && !isSpace(text[j]) && text[j] !== '\n' && text[j] !== '\r') {
    // "jdoe=[password removed]," stays one token
    j = text.startsWith(PASSWORD_PLACEHOLDER, j) ? j + PASSWORD_PLACEHOLDER.length : j + 1;
  }
  return { start: i, end: j, text: text.slice(i, j), quoted: false };
}

/** The first token of the next line when the rest of this line from i is empty ("Password:\n  X"). */
function nextLineToken(text: string, i: number): Tok | null {
  while (i < text.length && isSpace(text[i])) i++;
  if (text[i] === '\r') i++;
  if (text[i] !== '\n') return null;
  return tokenAt(text, i + 1);
}

/** a word after which a value is expected (a value on the next line still belongs to it) */
function expectsValue(w: string): boolean {
  return CONNECTORS.has(w) || TARGET_END.has(w) || MODALS.has(w);
}

/**
 * Tokens after i: words, quoted strings, and ":"/"=" split off words
 * ("jdoe:"). With crossLine, one line break after a connector is crossed
 * ("… to\nX").
 */
function tokensAfter(text: string, i: number, max: number, crossLine = false): Tok[] {
  const out: Tok[] = [];
  let pos = i;
  let crossed = false;
  while (out.length < max) {
    let t = tokenAt(text, pos);
    if (!t && crossLine && !crossed && out.length > 0 && !out[out.length - 1].quoted && expectsValue(bare(out[out.length - 1].text))) {
      crossed = true;
      t = nextLineToken(text, pos);
    }
    if (!t) break;
    pos = t.end;
    if (!t.quoted && t.text.length > 1 && (t.text[0] === ':' || t.text[0] === '=') && t.text[1] !== t.text[0]) {
      out.push({ start: t.start, end: t.start + 1, text: t.text[0], quoted: false });
      out.push({ start: t.start + 1, end: t.end, text: t.text.slice(1), quoted: false });
      continue;
    }
    if (!t.quoted && t.text.length > 1 && /[:=]$/.test(t.text) && !/[:=]{2}$/.test(t.text)) {
      out.push({ start: t.start, end: t.end - 1, text: t.text.slice(0, -1), quoted: false });
      out.push({ start: t.end - 1, end: t.end, text: t.text.slice(-1), quoted: false });
      continue;
    }
    out.push(t);
  }
  return out;
}

/** The whitespace-separated tokens that end before i (nearest first). */
function tokensBefore(text: string, i: number, max: number): Tok[] {
  const out: Tok[] = [];
  let pos = i;
  while (out.length < max) {
    let j = pos;
    while (j > 0 && isSpace(text[j - 1])) j--;
    if (j === 0 || text[j - 1] === '\n') break;
    const end = j;
    if (end >= PASSWORD_PLACEHOLDER.length && text.slice(end - PASSWORD_PLACEHOLDER.length, end) === PASSWORD_PLACEHOLDER) {
      out.push({ start: end - PASSWORD_PLACEHOLDER.length, end, text: PASSWORD_PLACEHOLDER, quoted: false });
      pos = end - PASSWORD_PLACEHOLDER.length;
      continue;
    }
    let k = end;
    // a quoted token ending here
    const last = text[end - 1];
    let quoted: Tok | null = null;
    for (let s = end - 2; s >= 0 && end - s <= 130; s--) {
      if (text[s] === '\n') break;
      if (QUOTES[text[s]] && closingQuote(text, s) === end - 1 && (s === 0 || isSpace(text[s - 1]) || text[s - 1] === '\n')) {
        quoted = { start: s, end, text: text.slice(s + 1, end - 1), quoted: true };
        break;
      }
    }
    if (quoted && Object.values(QUOTES).some((c) => c.includes(last))) {
      out.push(quoted);
      pos = quoted.start;
      continue;
    }
    while (k > 0 && !isSpace(text[k - 1]) && text[k - 1] !== '\n') k--;
    out.push({ start: k, end, text: text.slice(k, end), quoted: false });
    pos = k;
  }
  return out;
}

/** lower case, without the brackets, quotes and punctuation around a word */
function bare(word: string): string {
  return word.toLowerCase().replace(/^[(\[„“"'«‹]+/, '').replace(/[,;.!?)\]"'”“»›]+$/, '');
}

function endsSentence(t: Tok): boolean {
  return !t.quoted && /[.?!]$/.test(t.text);
}

function hasDigit(s: string) { return /\p{N}/u.test(s); }
function hasLetterCh(s: string) { return /\p{L}/u.test(s); }
function hasUpper(s: string) { return /\p{Lu}/u.test(s); }
function hasLower(s: string) { return /\p{Ll}/u.test(s); }
/** a character other than letters, digits and the name separators - . _ */
function hasSpecial(s: string) { return /[^\p{L}\p{N}\-._]/u.test(s); }

function isPlaceholder(v: string): boolean {
  const s = v.trim();
  if (!s) return true;
  if (/^[*xX•·.…?_\-]+$/.test(s)) return true;
  if (/^<[^<>]*>$/.test(s) || /^\[[^\[\]]*\]$/.test(s) || /^\{[^{}]*\}$/.test(s) || /^\([^()]*\)[,;.!?]?$/.test(s)) return true;
  return STATUS_WORDS.has(bare(s));
}

function looksLikeDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{1,2}\.\d{1,2}\.(\d{2}|\d{4})\.?$/.test(s) || /^\d{1,2}:\d{2}/.test(s) || /^\d{8,14}(\.\d+)?Z$/i.test(s);
}

/** "cn=x", "uid=jdoe" (but not base64 padding: "U29tbWVy=") */
function attrEq(s: string): boolean {
  const m = /^[A-Za-z][\w-]*=/.exec(s);
  return !!m && s.slice(m[0].length).replace(/=/g, '') !== '';
}

/** DNs, filters, URLs, e-mail addresses and host names are never passwords here. */
function looksLikeName(s: string): boolean {
  if (s.startsWith('(') || s.includes('://')) return true;
  if (attrEq(s)) return true;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return true;
  if (/^[A-Z]{1,15}\d{1,4}$/.test(s)) return true; // DC01, SRV2
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/.test(s) && /[a-z]/.test(s)) return true; // dc01.example.com
  return looksLikeDate(s);
}

function trimTrailing(s: string): string {
  return s.replace(/[,;]+$/, '');
}

/** Markdown emphasis around a word ("**generated**:") does not make it password-shaped. */
function stripEmphasis(s: string): string {
  return s.replace(/^[*_~]+/, '').replace(/[*_~]+$/, '');
}

/** Directly after the password word, without "to"/"is": only clearly password-shaped tokens. */
function strictLike(raw: string): boolean {
  // sentence punctuation at the end does not make a word password-shaped ("policy?")
  const s = stripEmphasis(trimTrailing(raw).replace(/[.?!]+$/, '')).replace(/[.?!]+$/, '');
  if (s.length < 6 || s.length > 64 || looksLikeName(s) || isPlaceholder(s)) return false;
  if (!hasLetterCh(s) || !(hasDigit(s) || hasSpecial(s))) return false;
  return (hasUpper(s) && hasLower(s)) || hasSpecial(s);
}

/** After "to", "is", "auf", …: a token with a digit or a special character. */
function looseLike(raw: string): boolean {
  const s = stripEmphasis(trimTrailing(unbalancedClose(raw)));
  if (s.length < 4 || s.length > 128 || looksLikeName(s) || isPlaceholder(s)) return false;
  if (hasDigit(s) && (hasLetterCh(s) || s.length >= 6)) return true;
  return hasSpecial(s.replace(/[.!?]$/, '')) && hasLetterCh(s);
}

/** "Winter2025!)" → "Winter2025!" (a closing bracket the token did not open) */
function unbalancedClose(s: string): string {
  let out = s.replace(/[,;]+$/, '');
  while (/[)\]]$/.test(out) && !out.includes(out.endsWith(')') ? '(' : '[')) out = out.slice(0, -1).replace(/[,;]+$/, '');
  return out;
}

function quotedValue(t: Tok): boolean {
  if (t.text.length < 1 || t.text.length > 128 || isPlaceholder(t.text)) return false;
  // a quoted phrase ("never expires", 'User must change') is a value only when it looks like one
  return !/\s/.test(t.text.trim()) || hasDigit(t.text) || hasSpecial(t.text.replace(/\s/g, ''));
}

interface Hit { start: number; end: number; sure: boolean }

/** The span of a value token: quotes kept, a trailing comma or unopened bracket left out ("Sommer2026!," → "Sommer2026!"). */
function valueHit(t: Tok, sure: boolean): Hit {
  if (t.quoted) return { start: t.start, end: t.end, sure };
  let v = unbalancedClose(t.text);
  // a plain word keeps its sentence punctuation outside ("PW: geheim." → "PW: [password removed].")
  if (!sure) v = v.replace(/[.!?]+$/, '');
  return { start: t.start, end: t.start + Math.max(1, v.length), sure };
}

/**
 * The value after a label (":"/"="): a password-shaped or quoted value is
 * sure; a plain word only counts as the whole value (end of the line, a
 * comma, "and …"), and is not sure ("Password: must change at next logon"
 * is a status, "PW: geheim" may be a password).
 */
function labelValue(t: Tok | null, next: Tok | null): Hit | null {
  if (!t || t.text === PASSWORD_PLACEHOLDER) return null;
  if (t.quoted) return quotedValue(t) ? valueHit(t, true) : null;
  const s = trimTrailing(t.text);
  if (!s || s.length > 128 || s.startsWith('*') || isPlaceholder(s) || looksLikeName(s.replace(/[.!?]+$/, ''))) return null;
  if (/^[^\p{L}\p{N}]+$/u.test(s)) return null; // punctuation only (LDIF ":: " leftovers, "->")
  if (looseLike(t.text)) return valueHit(t, true);
  const ends = !next || /[,;.!?)\]]$/.test(t.text) || VALUE_FOLLOW.has(bare(next.text)) || next.text === PASSWORD_PLACEHOLDER;
  return ends ? valueHit(t, false) : null;
}

interface Keyword { start: number; end: number; word: string; plural: boolean; labelOnly: boolean }

function keywords(text: string): Keyword[] {
  const out: Keyword[] = [];
  let i = 0;
  while (i < text.length) {
    if (!isLetter(text[i])) { i++; continue; }
    let j = i;
    while (j < text.length && isLetter(text[j])) j++;
    const word = text.slice(i, j);
    const lw = word.toLowerCase();
    const prev = i > 0 ? text[i - 1] : '';
    const next = j < text.length ? text[j] : '';
    const okNext = next === '' || isSpace(next) || next === '\n' || next === '\r' || ':=：,;.!?)"\'“”„«»`'.includes(next);
    const okPrev = !/\p{N}/u.test(prev);
    const inPlaceholder = i > 0 && text.startsWith(PASSWORD_PLACEHOLDER, i - 1);
    const plural = PLURAL_SUFFIXES.some((s) => lw.endsWith(s));
    const labelOnly = LABEL_ONLY.has(lw);
    if (okNext && okPrev && !inPlaceholder && (labelOnly || plural || KEYWORD_SUFFIXES.some((s) => lw.endsWith(s)))) {
      // "(userPassword=*)": a filter, not a password
      if (!(prev === '(' && (next === '=' || next === '~' || next === '>' || next === '<'))) out.push({ start: i, end: j, word, plural, labelOnly });
    }
    i = j;
  }
  return out;
}

function langOf(word: string): 'en' | 'de' {
  const l = word.toLowerCase();
  return /(passwort|kennwort|passworte|kennworte|passwörter|kennwörter|passwoerter|kennwoerter)$/.test(l) ? 'de' : 'en';
}

interface KeywordScan {
  hits: Hit[];
  target: string;
  /** where a continuation ("…, and of anna to Y") may start: after the value, also a removed one */
  anchor: number;
}

/** "jdoe=X" / "jdoe:X": the value part of a name/value pair (plural password words) */
function pairValue(t: Tok): Tok | null {
  if (t.quoted) return null;
  const m = /^([^\s=:]{1,64})[=:](?!\/\/)(.+)$/u.exec(trimTrailing(t.text));
  if (!m || /^[=:]/.test(m[2])) return null;
  const off = t.start + m[1].length + 1;
  return { start: off, end: t.end, text: t.text.slice(m[1].length + 1), quoted: false };
}

/** "passwords: jdoe=X, anna=Y", "Passwörter: X", "passwords: jdoe: X, anna: Y" */
function scanPairList(text: string, from: number): KeywordScan {
  const toks = tokensAfter(text, from, 24);
  const hits: Hit[] = [];
  let anchor = from;
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (!t.quoted && JOINERS.has(bare(t.text) || t.text)) { i++; continue; }
    const pv = pairValue(t);
    if (pv) {
      if (!pv.text.startsWith(PASSWORD_PLACEHOLDER) && (looseLike(pv.text) || labelValue(pv, toks[i + 1] ?? null))) hits.push(valueHit(pv, true));
      anchor = pv.end; i++; continue;
    }
    // "jdoe: X"
    if (!t.quoted && toks[i + 1] && (toks[i + 1].text === ':' || toks[i + 1].text === '=') && toks[i + 2]) {
      const v = labelValue(toks[i + 2], toks[i + 3] ?? null);
      if (v) { hits.push({ ...v, sure: true }); anchor = toks[i + 2].end; i += 3; continue; }
      break;
    }
    if (i === 0) {
      const v = labelValue(t, toks[1] ?? null);
      if (v) { hits.push(v); anchor = t.end; i++; continue; }
    }
    break;
  }
  return { hits, target: '', anchor };
}

function scanKeyword(text: string, k: Keyword): KeywordScan | null {
  const none = null;
  // 1. "password: X", "pw=X", LDIF "userPassword:: <base64>", "Password:\n  X"
  let j = k.end;
  while (j < text.length && isSpace(text[j])) j++;
  if (text[j] === ':' || text[j] === '=' || text[j] === '：') {
    let v = j + 1;
    if (text[j] === ':' && (text[v] === ':' || text[v] === '<')) v++; // LDIF base64 / URL value
    if (k.plural) return scanPairList(text, v);
    let t = tokenAt(text, v) ?? nextLineToken(text, v);
    // "**Password:** X": the emphasis right after the colon is not the value
    if (t && !t.quoted && t.start === v && /^[*_~]+$/.test(t.text)) t = tokenAt(text, t.end) ?? nextLineToken(text, t.end);
    if (!t) return none;
    const hit = labelValue(t, tokenAt(text, t.end));
    if (hit) return { hits: [hit], target: '', anchor: hit.end };
    return t.text === PASSWORD_PLACEHOLDER ? { hits: [], target: '', anchor: t.end } : none;
  }
  if (k.labelOnly) return none;
  // 2. "password 'X'", "password of jdoe to X", "Kennwort auf X", "password Sommer2026!"
  const toks = tokensAfter(text, k.end, 14, true);
  let phase: 'after' | 'target' | 'value' = 'after';
  let label = false;
  let implicit = false;
  let skipped = 0;
  let verbs = 0;
  const target: string[] = [];
  const done = (t: Tok, hit: Hit | null): KeywordScan | null => {
    const tg = implicit && target.length > 1 ? '' : target.join(' ').replace(/[,;:]+$/, '');
    if (hit) return { hits: [hit], target: tg, anchor: hit.end };
    return t.text === PASSWORD_PLACEHOLDER ? { hits: [], target: tg, anchor: t.end } : null;
  };
  for (let idx = 0; idx < toks.length; idx++) {
    const t = toks[idx];
    const w = bare(t.text);
    if (phase === 'after') {
      if (t.quoted) return done(t, quotedValue(t) ? valueHit(t, true) : null);
      if (TARGET_PREPS.has(w)) { phase = 'target'; continue; }
      if (CONNECTORS.has(w)) { phase = 'value'; label = w === ':' || w === '='; continue; }
      if (VERBS_AFTER.has(w) && verbs < 2) { verbs++; continue; }
      if (strictLike(t.text)) return done(t, valueHit(t, true));
      if (t.text === PASSWORD_PLACEHOLDER || endsSentence(t) || ARTICLES.has(w)) return null;
      // "Password jdoe: X", "Kennwort jdoe -> X"
      phase = 'target';
      implicit = true;
      target.push(t.text);
      continue;
    }
    if (phase === 'target') {
      if (!t.quoted && (implicit ? IMPLICIT_END.has(w) : TARGET_END.has(w))) { phase = 'value'; label = w === ':' || w === '='; continue; }
      if (!t.quoted && !implicit && target.length > 0 && MODALS.has(w)) { phase = 'value'; continue; }
      if (target.length === 0 && !t.quoted && ARTICLES.has(w)) continue;
      // "New password for jdoe Sommer2026!": a password-shaped value with a special character
      if (!implicit && target.some((x) => !GENERIC_TARGET.has(bare(x))) && !t.quoted && strictLike(t.text) && hasSpecial(trimTrailing(t.text))) return done(t, valueHit(t, true));
      target.push(t.text);
      if (target.length > (implicit ? 2 : 5) || endsSentence(t) || t.text === PASSWORD_PLACEHOLDER) return null;
      continue;
    }
    // value
    if (!t.quoted && (CONNECTORS.has(w) || ARTICLES.has(w)) && skipped < 3) {
      skipped++;
      if (w === ':' || w === '=') label = true;
      continue;
    }
    if (label) return done(t, labelValue(t, toks[idx + 1] ?? null));
    return done(t, (t.quoted ? quotedValue(t) : looseLike(t.text)) ? valueHit(t, true) : null);
  }
  return null;
}

/**
 * Further passwords in the same sentence after a match: "…, and of anna to
 * Y", "…, für anna: Y", "… (old one was Y)".
 */
function scanContinuation(text: string, from: number): Hit[] {
  const out: Hit[] = [];
  let pos = from;
  for (let round = 0; round < 5; round++) {
    const toks = tokensAfter(text, pos, 10);
    let i = 0;
    let joined = false;
    while (i < toks.length && !toks[i].quoted && (JOINERS.has(toks[i].text) || JOINERS.has(bare(toks[i].text)))) { i++; joined = true; }
    const first = toks[i];
    if (!first) break;
    let hit: Hit | null = null;
    let end = -1;
    const fw = bare(first.text);
    if (!first.quoted && first.text.startsWith('(') && PAREN_WORDS.has(fw)) {
      // "(old one was X)"
      for (let k = i + 1; k < toks.length && k <= i + 4; k++) {
        const w = bare(toks[k].text);
        if (!toks[k].quoted && PAREN_CONNECTORS.has(w)) {
          const v = toks[k + 1];
          if (!v) break;
          hit = w === ':' || w === '=' ? labelValue(v, toks[k + 2] ?? null) : (v.quoted ? quotedValue(v) : looseLike(v.text)) ? valueHit(v, true) : null;
          end = v.end;
          break;
        }
      }
    } else if (!first.quoted && TARGET_PREPS.has(fw) && (joined || round === 0)) {
      // "and of anna to X", "für anna: X"
      let k = i + 1;
      let n = 0;
      while (k < toks.length && n < 4) {
        const w = bare(toks[k].text);
        if (!toks[k].quoted && TARGET_END.has(w) && n > 0) {
          const v = toks[k + 1];
          if (v) {
            hit = w === ':' || w === '=' ? labelValue(v, toks[k + 2] ?? null) : (v.quoted ? quotedValue(v) : looseLike(v.text)) ? valueHit(v, true) : null;
            end = v.end;
          }
          break;
        }
        if (endsSentence(toks[k])) break;
        if (!(n === 0 && ARTICLES.has(w))) n++;
        k++;
      }
    }
    if (!hit) break;
    out.push(hit);
    pos = Math.max(hit.end, end);
  }
  return out;
}

/** "Sommer2026! as the new password", "„X“ ist das Kennwort", "Use X for the password". */
function scanBefore(text: string, k: Keyword): Hit | null {
  if (k.labelOnly || k.plural) return null;
  const toks = tokensBefore(text, k.start, 6);
  let i = 0;
  while (i < toks.length && !toks[i].quoted && ARTICLES.has(bare(toks[i].text))) i++;
  if (i >= toks.length || toks[i].quoted) return null;
  const conn = bare(toks[i].text);
  const v = toks[i + 1];
  if (!v) return null;
  if (conn === 'for' || conn === 'für' || conn === 'fuer') {
    const verb = toks[i + 2];
    if (!verb || verb.quoted || !USE_VERBS.has(bare(verb.text))) return null;
  } else if (!['as', 'als', 'is', 'ist'].includes(conn)) {
    return null;
  }
  return (v.quoted ? quotedValue(v) : looseLike(v.text)) ? valueHit(v, true) : null;
}

/** "ldapsearch … -w Secret123", "ldappasswd … -s NewPw1": the password options of the OpenLDAP clients. */
function scanClientFlags(text: string): Hit[] {
  const out: Hit[] = [];
  let lineStart = 0;
  for (const line of text.split('\n')) {
    const m = LDAP_CLIENT.exec(line);
    if (m) {
      const passwd = m[2].toLowerCase() === 'passwd';
      const re = passwd ? /(^|\s)-[wsa](?=\s)/g : /(^|\s)-w(?=\s)/g;
      re.lastIndex = m.index + m[0].length;
      for (let f = re.exec(line); f; f = re.exec(line)) {
        const t = tokenAt(text, lineStart + f.index + f[0].length);
        if (t && !t.text.startsWith('-') && t.text !== PASSWORD_PLACEHOLDER && (t.quoted || t.text.length > 0)) out.push(valueHit(t, true));
      }
    }
    lineStart += line.length + 1;
  }
  return out;
}

/** Long random-looking tokens (≥ 20 characters, three character classes and a digit). */
function weakToken(text: string): boolean {
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

/**
 * A password-shaped word with a special character, in a message a password
 * was already removed from (labels such as "credentials=" are no values).
 */
function leftoverToken(tok: string): boolean {
  const core = trimTrailing(tok);
  if (!core || /[:=]$/.test(core)) return false;
  return strictLike(core) && hasSpecial(core.replace(/[.?]+$/, ''));
}

/** Applies f to every whitespace-separated token outside "[password removed]". */
function mapTokens(text: string, f: (tok: string) => string): string {
  return text.split(PASSWORD_PLACEHOLDER).map((part) => part.split(/(\s+)/).map((t) => (t && !/^\s+$/.test(t) ? f(t) : t)).join('')).join(PASSWORD_PLACEHOLDER);
}

/** Finds password values in the text (strong) and random-looking tokens (weak). */
export function scanPasswords(text: string): PasswordScan {
  const matches: PasswordMatch[] = [];
  const add = (h: Hit, k: Keyword | null, target: string) => {
    if (matches.some((x) => x.start < h.end && h.start < x.end)) return;
    matches.push({
      start: h.start, end: h.end, sure: h.sure, target,
      keyword: k?.word ?? '', keywordStart: k?.start ?? h.start, keywordEnd: k?.end ?? h.start, lang: k ? langOf(k.word) : 'en',
    });
  };
  /** account names next to password words (never a leftover password) */
  const targets = new Set<string>();
  for (const k of keywords(text)) {
    const r = scanKeyword(text, k);
    if (r) {
      for (const w of r.target.split(/\s+/)) if (w) targets.add(trimTrailing(w).replace(/:$/, ''));
      for (const h of r.hits) add(h, k, r.target);
      for (const h of scanContinuation(text, r.anchor)) add(h, k, '');
      continue;
    }
    const b = scanBefore(text, k);
    if (b) add(b, k, '');
  }
  for (const h of scanClientFlags(text)) add(h, null, '');
  matches.sort((a, b) => a.start - b.start);
  const masked = maskSpans(text, matches);
  const rest = masked.replaceAll(PASSWORD_PLACEHOLDER, ' ');
  let leftover = false;
  if (masked.includes(PASSWORD_PLACEHOLDER)) mapTokens(masked, (t) => { leftover ||= leftoverToken(t) && !targets.has(trimTrailing(t)); return t; });
  return { matches, weak: weakToken(rest), leftover };
}

function maskSpans(text: string, matches: { start: number; end: number }[]): string {
  let out = '';
  let last = 0;
  for (const m of matches) {
    out += text.slice(last, m.start) + PASSWORD_PLACEHOLDER;
    last = m.end;
  }
  return out + text.slice(last);
}

/** The text with every strong match replaced by "[password removed]". */
export function maskPasswords(text: string): string {
  return maskSpans(text, scanPasswords(text).matches);
}

/** Only the sure matches (what the Go facade masks before a message is stored). */
export function maskSurePasswords(text: string): string {
  return maskSpans(text, scanPasswords(text).matches.filter((m) => m.sure));
}

/**
 * "Remove the password": every match, and in a message with a removed
 * password also the other password-shaped values ("…\nUser: anna
 * Herbst#2026"), except the account names the matches were for.
 */
export function removePasswords(text: string): string {
  const scan = scanPasswords(text);
  const masked = maskSpans(text, scan.matches);
  if (!masked.includes(PASSWORD_PLACEHOLDER)) return masked;
  const targets = new Set(scan.matches.flatMap((m) => m.target.split(/\s+/)).map((w) => w.replace(/[,;:]+$/, '')));
  return mapTokens(masked, (tok) => {
    const core = trimTrailing(tok);
    return leftoverToken(tok) && !targets.has(core) ? PASSWORD_PLACEHOLDER + tok.slice(core.length) : tok;
  });
}

/** Removes long random-looking tokens (the weak matches) as well. */
export function maskAllPasswords(text: string): string {
  return mapTokens(removePasswords(text), (tok) => (weakToken(tok) ? PASSWORD_PLACEHOLDER : tok));
}

const OTHER_VERBS = /(^|[^\p{L}])(create|add|enable|disable|delete|remove|move|rename|unlock|lock|anlegen|lege|erstelle|erstellen|hinzufügen|füge|aktiviere|aktivieren|deaktiviere|deaktivieren|lösche|löschen|entsperre|entsperren|sperre|sperren|verschiebe|verschieben|benenne)(?![\p{L}])/iu;
const RESET_VERBS = /(^|[^\p{L}])(set|reset|change|update|assign|give|use|make|setze|setzen|setz|ändere|ändern|änder|aendere|zurücksetzen|zurück|vergib|vergeben|gib|nimm|verwende|benutze)(?![\p{L}])/iu;

/**
 * The approval-card alternative for "set the password of X to Y": a
 * request the assistant answers with reset_password, which generates the
 * password locally. Null when the text is not a short reset request.
 */
export function resetRequest(text: string, scan: PasswordScan = scanPasswords(text)): string | null {
  if (scan.matches.length !== 1) return null;
  const rest = maskSpans(text, scan.matches).trim();
  if (!RESET_VERBS.test(rest)) return null;
  // "… and enable the account", "create jdoe; password: …": more than a
  // reset, which the reset request would drop (or apply to the selection)
  if (OTHER_VERBS.test(rest)) return null;
  // one short sentence (the password itself may contain "!" or ".")
  if (rest.split(/\s+/).length > 25 || /[.?!]\s+\S/.test(rest.replace(/[.?!]+$/, ''))) return null;
  const m = scan.matches[0];
  const target = (m.target || fallbackTarget(text, m)).replace(/[,:;]+$/, '').trim();
  if (m.lang === 'de') return target ? `Setze das Kennwort von ${target} zurück.` : 'Setze das Kennwort zurück.';
  return target ? `Reset the password of ${target}.` : 'Reset the password.';
}

/** words around a password phrase that are never the account ("please", "the user") */
const NOT_TARGET = new Set([
  'please', 'bitte', 'mal', 'user', 'users', 'account', 'benutzer', 'konto', 'nutzer', 'now', 'jetzt', 'also', 'auch', 'ad', 'ldap',
]);
/** words that end the account name after "for …" */
const TARGET_STOP = new Set([
  'and', 'und', 'then', 'dann', 'please', 'bitte', 'with', 'mit', 'to', 'zu', 'auf', 'now', 'jetzt', 'set', 'setzen', 'zurück', 'zurücksetzen',
  'ändern', 'aendern', 'sein', 'as', 'als', 'is', 'ist', 'in', 'im', 'at', 'an', 'so', 'that', 'dass', 'which', 'der', 'die', 'das',
]);
const PREPS_BEFORE = new Set(['for', 'of', 'on', 'für', 'fuer', 'von', 'bei', 'beim']);
const VERB_WORD = /^(set|reset|change|update|assign|give|make|setze|setzen|setz|ändere|ändern|änder|aendere|zurücksetzen|vergib|gib|nimm|verwende|benutze)$/i;

function wordOf(t: Tok): string {
  return t.quoted ? t.text : t.text.replace(/^[(\[„“"']+/, '').replace(/[,;.!?)\]“”"']+$/, '');
}

/**
 * The account a reset is for when the words right around the password word
 * name it in another way than "password of X to …" (A-13: "Set password X
 * for jdoe" must not become a reset of whatever entry is selected):
 * "… for jdoe" after the value, "jdoe's password", "bei jdoe das Passwort",
 * "reset jdoe password to …", "jdoe Passwort X setzen".
 */
function fallbackTarget(text: string, m: PasswordMatch): string {
  // 1. "Set password X for jdoe", "Use X as the new password for jdoe"
  const after = tokensAfter(text, Math.max(m.end, m.keywordEnd), 6);
  if (after.length >= 2 && !after[0].quoted && PREPS_BEFORE.has(bare(after[0].text))) {
    const out: string[] = [];
    for (const t of after.slice(1)) {
      const w = bare(t.text);
      if (t.text === PASSWORD_PLACEHOLDER) break;
      if (out.length === 0 && !t.quoted && (ARTICLES.has(w) || NOT_TARGET.has(w))) continue;
      if (!t.quoted && TARGET_STOP.has(w)) break;
      out.push(wordOf(t));
      if (out.length >= 3 || /[,;.!?]$/.test(t.text)) break;
    }
    if (out.length) return out.join(' ');
  }
  const before = tokensBefore(text, m.keywordStart, 5);
  let i = 0;
  while (i < before.length && !before[i].quoted && ARTICLES.has(bare(before[i].text))) i++;
  const first = before[i];
  if (!first) return '';
  // 2. "jdoe's password", "Anna Schmidt’s new password"
  const poss = /^(.+?)['’]s$/u.exec(wordOf(first));
  if (poss && !first.quoted) {
    const prev = before[i + 1];
    const name = poss[1];
    if (prev && !prev.quoted && /^\p{Lu}/u.test(name) && /^\p{Lu}[\p{L}-]*$/u.test(prev.text) && !VERB_WORD.test(prev.text)) return `${prev.text} ${name}`;
    return name;
  }
  // 3. "bei jdoe das Passwort", 4. "reset jdoe password"
  const collected: string[] = [];
  for (let k = i; k < before.length && collected.length < 3; k++) {
    const t = before[k];
    const w = bare(t.text);
    if (!t.quoted && (PREPS_BEFORE.has(w) || VERB_WORD.test(w))) {
      return collected.length ? collected.reverse().join(' ') : '';
    }
    if (!t.quoted && (ARTICLES.has(w) || NOT_TARGET.has(w) || TARGET_STOP.has(w) || /[,;.!?]$/.test(t.text))) return '';
    collected.push(wordOf(t));
  }
  // 5. "jdoe Passwort X setzen": a single word that starts the message
  if (collected.length === 1 && i + 1 === before.length && /^(setzen|ändern|aendern|zurücksetzen)[.!]?$/i.test(text.trim().split(/\s+/).pop() ?? '')) return collected[0];
  return '';
}

/** "Pa•••26" for the warning (never the whole value). */
export function hintOf(text: string, m: PasswordMatch): string {
  let v = text.slice(m.start, m.end);
  if (v.length >= 2 && QUOTES[v[0]]) v = v.slice(1, -1);
  if (v.length < 8) return '•'.repeat(Math.max(3, v.length));
  return v.slice(0, 2) + '•'.repeat(Math.min(8, v.length - 4)) + v.slice(-2);
}
