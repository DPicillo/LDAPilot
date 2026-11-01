/**
 * Cryptographically secure password generator and strength estimate.
 * Pure functions; randomness comes from crypto.getRandomValues (never
 * Math.random) and is injectable for tests.
 */

export interface GeneratorOptions {
  length: number;
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
  /** Leave out look-alike characters (I l 1 O 0 o | `) */
  avoidAmbiguous: boolean;
}

export const DEFAULT_GENERATOR_OPTIONS: GeneratorOptions = {
  length: 16,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: false,
};

export const MIN_GENERATED_LENGTH = 4;
export const MAX_GENERATED_LENGTH = 128;

export const CHARSETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{}|;:,.<>?~`',
} as const;

const AMBIGUOUS = new Set(['I', 'l', '1', 'O', '0', 'o', '|', '`']);

/** Fills buf with random 32-bit values, like crypto.getRandomValues. */
export type RandomSource = (buf: Uint32Array<ArrayBuffer>) => void;

const cryptoSource: RandomSource = (buf) => {
  crypto.getRandomValues(buf);
};

/**
 * Returns a uniformly distributed integer in [0, maxExclusive) using
 * rejection sampling: 32-bit values at or above the largest multiple of
 * maxExclusive are drawn again, so the modulo introduces no bias.
 */
export function secureRandomInt(maxExclusive: number, rng: RandomSource = cryptoSource): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 2 ** 32) {
    throw new RangeError(`secureRandomInt: invalid bound ${maxExclusive}`);
  }
  if (maxExclusive === 1) return 0;
  const range = 2 ** 32;
  const limit = range - (range % maxExclusive);
  const buf = new Uint32Array(1);
  for (;;) {
    rng(buf);
    if (buf[0] < limit) return buf[0] % maxExclusive;
  }
}

/** The character classes enabled by opts, ambiguous characters removed if requested. */
export function charClasses(opts: GeneratorOptions): string[] {
  const classes: string[] = [];
  for (const key of ['upper', 'lower', 'digits', 'symbols'] as const) {
    if (!opts[key]) continue;
    let chars: string = CHARSETS[key];
    if (opts.avoidAmbiguous) chars = [...chars].filter((c) => !AMBIGUOUS.has(c)).join('');
    if (chars) classes.push(chars);
  }
  return classes;
}

/** Clamps a requested length to what the generator accepts. */
export function clampLength(length: number, classCount = 1): number {
  const n = Number.isFinite(length) ? Math.round(length) : DEFAULT_GENERATOR_OPTIONS.length;
  return Math.min(MAX_GENERATED_LENGTH, Math.max(MIN_GENERATED_LENGTH, classCount, n));
}

const LENGTH_CHOICES = [8, 10, 12, 14, 16, 20, 24, 32, 48, 64, 128];

/** Lengths offered in the generator options, always including current. */
export function lengthChoices(current: number): number[] {
  const c = clampLength(current);
  return LENGTH_CHOICES.includes(c) ? LENGTH_CHOICES : [...LENGTH_CHOICES, c].sort((a, b) => a - b);
}

/**
 * Generates a password with at least one character of every enabled class;
 * the remaining characters are drawn from all enabled classes and the result
 * is shuffled (Fisher-Yates). Throws if no class is enabled.
 */
export function generatePassword(opts: GeneratorOptions, rng: RandomSource = cryptoSource): string {
  const classes = charClasses(opts);
  if (classes.length === 0) throw new Error('Select at least one character class');
  const length = clampLength(opts.length, classes.length);
  const all = classes.join('');
  const pick = (chars: string) => chars[secureRandomInt(chars.length, rng)];

  const out = classes.map(pick);
  while (out.length < length) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1, rng);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

export interface PasswordStrength {
  /** 0 (empty) to 4 */
  level: number;
  label: string;
}

/** Heuristic strength meter: length and character variety. */
export function getPasswordStrength(password: string): PasswordStrength {
  if (!password) return { level: 0, label: '' };
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  if (password.length >= 20) score++;

  if (score <= 1) return { level: 1, label: 'Weak' };
  if (score <= 2) return { level: 2, label: 'Fair' };
  if (score <= 3) return { level: 3, label: 'Good' };
  return { level: 4, label: 'Strong' };
}

// --- Weak patterns and policy requirements ---------------------------------

/**
 * Small list of the passwords (and base words) attackers try first: the top
 * of the public breach lists plus common German/English admin words. Kept
 * short on purpose; anything matching it, or one of these with digits and
 * symbols appended ("Password1!"), is weak whatever its character classes.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'passwort', 'pass', 'passwd', 'kennwort', 'secret', 'geheim', 'admin', 'administrator', 'root', 'toor',
  'login', 'logon', 'welcome', 'willkommen', 'letmein', 'changeme', 'default', 'test', 'tester', 'guest', 'user', 'master',
  'qwerty', 'qwertz', 'qwertyuiop', 'asdf', 'asdfgh', 'asdfghjkl', 'yxcvbn', 'zxcvbn', 'abc', 'abcd', 'abcdef',
  'iloveyou', 'monkey', 'dragon', 'football', 'fussball', 'baseball', 'sunshine', 'princess', 'superman', 'batman',
  'trustno', 'hello', 'hallo', 'freedom', 'whatever', 'shadow', 'starwars', 'computer', 'company', 'firma', 'office',
  'service', 'support', 'server', 'ldap', 'domain', 'start', 'schatz', 'killer', 'hunter', 'michael', 'jennifer',
]);
/** Seasons and months (EN/DE): "Summer2026!" and "Oktober24" are the classic reset passwords. */
const SEASONS_MONTHS = new Set([
  'spring', 'summer', 'autumn', 'fall', 'winter', 'sommer', 'fruehling', 'frühling', 'herbst',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'januar', 'februar', 'maerz', 'märz', 'mai', 'juni', 'juli', 'oktober', 'dezember',
]);
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i', '€': 'e' };

/** Lower case with leetspeak undone ("P@ssw0rd" -> "password"). */
function unleet(s: string): string {
  return [...s.toLowerCase()].map((c) => LEET[c] ?? c).join('');
}

/** The word part of a password: digits and symbols around it removed ("!Summer2026!" -> "summer"). */
function baseWord(password: string): string {
  return password.toLowerCase().replace(/^[^\p{L}]+/u, '').replace(/[^\p{L}]+$/u, '');
}

/** Four or more ascending/descending neighbours ("1234", "dcba") or repeated characters ("aaaa"). */
function hasSequence(password: string): boolean {
  if (/(.)\1{3,}/u.test(password)) return true;
  const codes = [...password.toLowerCase()].map((c) => c.codePointAt(0)!);
  for (let i = 0; i + 3 < codes.length; i++) {
    const d = codes[i + 1] - codes[i];
    if ((d === 1 || d === -1) && codes[i + 2] - codes[i + 1] === d && codes[i + 3] - codes[i + 2] === d) return true;
  }
  return /qwert|asdfg|yxcvb|zxcvb|qwertz/i.test(password);
}

/**
 * Parts of the account names an AD complexity check rejects: tokens of at
 * least 3 characters of the names split at blanks and , . - _ # and tabs
 * (Microsoft's rule for sAMAccountName and displayName).
 */
export function accountNameTokens(names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    for (const t of n.split(/[\s,.\-_#@]+/)) {
      if (t.length >= 3) out.add(t.toLowerCase());
    }
  }
  return [...out];
}

/** Policy values the strength meter checks (from the account's effective policy). */
export interface PasswordRequirementsPolicy {
  minPasswordLength?: number;
  passwordHistory?: number;
  complexityKnown?: boolean;
  complexityEnabled?: boolean;
  /** 'domain' / 'pso' = Active Directory rules for complexity. */
  source?: string;
}

export interface PasswordRequirement {
  label: string;
  /** null: checked by the server only (history), shown as information. */
  met: boolean | null;
}

export interface PasswordAssessment extends PasswordStrength {
  /** Weak patterns found ("Based on a common password"); never echoes the password. */
  problems: string[];
  /** The policy's requirements and whether the password meets them. */
  requirements: PasswordRequirement[];
}

function charClassCount(password: string): number {
  return [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
}

/**
 * Strength meter with pattern checks: a common password or base word (also
 * with leetspeak and digits/symbols around it), season or month + year,
 * keyboard/number sequences, parts of the account's names. Any of these caps
 * the meter at "Weak", whatever the character classes say. requirements
 * lists the effective policy (minimum length, AD complexity, history).
 */
export function assessPassword(password: string, opts: { names?: string[]; policy?: PasswordRequirementsPolicy | null } = {}): PasswordAssessment {
  const base = getPasswordStrength(password);
  const problems: string[] = [];
  const nameTokens = accountNameTokens(opts.names ?? []);
  const lower = password.toLowerCase();
  const nameHit = nameTokens.find((t) => lower.includes(t) || unleet(password).includes(unleet(t)));
  if (password) {
    const word = baseWord(password);
    const plain = unleet(password).replace(/[^\p{L}]+/gu, '');
    if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(word) || COMMON_PASSWORDS.has(unleet(word)) || COMMON_PASSWORDS.has(plain)) {
      problems.push('Based on a common password');
    } else if ((SEASONS_MONTHS.has(word) || SEASONS_MONTHS.has(plain)) && /\d{2}/.test(password)) {
      problems.push('Season or month plus a year');
    }
    if (hasSequence(password)) problems.push('Contains a keyboard or number sequence');
    if (nameHit) problems.push('Contains part of the account name');
  }

  const requirements: PasswordRequirement[] = [];
  const pol = opts.policy;
  if (pol?.minPasswordLength && pol.minPasswordLength > 0) {
    requirements.push({ label: `At least ${pol.minPasswordLength} characters`, met: password.length >= pol.minPasswordLength });
  }
  if (pol?.complexityKnown && pol.complexityEnabled) {
    if (pol.source === 'domain' || pol.source === 'pso') {
      requirements.push({ label: '3 of 4 character classes (A-Z, a-z, 0-9, symbols)', met: charClassCount(password) >= 3 });
      requirements.push({ label: 'No part of the account name', met: !nameHit });
    } else {
      requirements.push({ label: 'Password syntax check of the server (passwordCheckSyntax)', met: null });
    }
  }
  if (pol?.passwordHistory && pol.passwordHistory > 0) {
    requirements.push({ label: `Not one of the last ${pol.passwordHistory} passwords (checked by the server)`, met: null });
  }

  let { level, label } = base;
  if (problems.length > 0 && level > 1) {
    level = 1;
    label = 'Weak';
  }
  if (requirements.some((r) => r.met === false) && level > 1) {
    level = 1;
    label = 'Too weak for the policy';
  }
  return { level, label, problems, requirements };
}

/** Parses stored generator options, falling back to the defaults field by field. */
export function parseGeneratorOptions(raw: string | null): GeneratorOptions {
  if (!raw) return { ...DEFAULT_GENERATOR_OPTIONS };
  try {
    const v = JSON.parse(raw);
    const bool = (x: unknown, d: boolean) => (typeof x === 'boolean' ? x : d);
    const d = DEFAULT_GENERATOR_OPTIONS;
    const opts: GeneratorOptions = {
      length: typeof v?.length === 'number' ? clampLength(v.length) : d.length,
      upper: bool(v?.upper, d.upper),
      lower: bool(v?.lower, d.lower),
      digits: bool(v?.digits, d.digits),
      symbols: bool(v?.symbols, d.symbols),
      avoidAmbiguous: bool(v?.avoidAmbiguous, d.avoidAmbiguous),
    };
    return charClasses(opts).length > 0 ? opts : { ...DEFAULT_GENERATOR_OPTIONS };
  } catch {
    return { ...DEFAULT_GENERATOR_OPTIONS };
  }
}
