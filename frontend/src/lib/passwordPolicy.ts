/**
 * Password storage policy (issue #1): pure helpers for the scheme badges of
 * stored userPassword values, the pre-write check and the texts of the
 * policy UI. Mirrors the decisions of internal/ldap/password_policy.go.
 * Type-only imports, so the module runs under `node --test`.
 */
import type { AttributeChange, LDAPAttribute, ServerType } from '../types/ldap'
import type { PasswordScheme } from '../types/password'
import type {
  EffectivePasswordPolicy, PasswordPolicyDefault, PasswordPolicySetting, PasswordWritePlan, PasswordWriteReport,
  PasswordWriteTarget,
} from '../types/passwordPolicy'

/** Attribute name without options, lower-cased. */
function baseName(name: string): string {
  const i = name.indexOf(';');
  return (i >= 0 ? name.slice(0, i) : name).toLowerCase();
}

/** OIDs of userPassword and unicodePwd (an attribute may be written by its OID). */
export const OID_USER_PASSWORD = '2.5.4.35';
export const OID_UNICODE_PWD = '1.2.840.113556.1.4.90';

/** userPassword, by name or OID 2.5.4.35 (case and options ignored). */
export function isUserPasswordAttribute(name: string): boolean {
  const b = baseName(name);
  return b === 'userpassword' || b === OID_USER_PASSWORD;
}

/** Attributes whose values are passwords the policy hook looks at: userPassword, unicodePwd (names or OIDs). */
export function isPasswordWriteAttribute(name: string): boolean {
  const b = baseName(name);
  return isUserPasswordAttribute(name) || b === 'unicodepwd' || b === OID_UNICODE_PWD;
}

/**
 * The syntactic storage scheme tag of a userPassword value ("{SSHA}…" →
 * SSHA), as in Go's passwordTag: 1-32 letters, digits, '-', '_', '.', '+'
 * between the braces and at least one character after them. Null without
 * one. A tag alone does not make a value a hash: see classifyPasswordValue.
 */
export function passwordTag(value: string): { tag: string; rest: string } | null {
  if (!value.startsWith('{')) return null;
  const end = value.indexOf('}');
  if (end < 2 || end > 33 || end === value.length - 1) return null;
  const tag = value.slice(1, end);
  if (!/^[A-Za-z0-9._+-]+$/.test(tag)) return null;
  return { tag, rest: value.slice(end + 1) };
}

/** Kinds of userPassword values (Go classifyPasswordValue). */
export type PasswordValueKind = 'empty' | 'cleartext' | 'hashed' | 'cleartextTag' | 'unknownTag' | 'malformed';

/** Tags that store the password in cleartext (Go cleartextPasswordTags). */
const CLEARTEXT_TAGS = new Set(['CLEAR', 'CLEARTEXT', 'PLAIN']);

/** {SHA}-family value: base64 of at least `size` bytes. */
function digestValue(size: number): (rest: string) => boolean {
  return (rest) => {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(rest) || rest.length % 4 === 1) return false;
    try {
      return atob(rest).length >= size;
    } catch {
      return false;
    }
  };
}

/** {CRYPT} value: "$id$...", DES (13), BSDi ("_" + 19) or a lock marker (Go cryptValue). */
function cryptValue(rest: string): boolean {
  const s = rest.replace(/^[!*]+/, '');
  if (s === '') return true;
  if (s[0] === '$') {
    const end = s.indexOf('$', 1);
    return end >= 2 && end <= 17 && s.length > end + 1 && /^[A-Za-z0-9_-]+$/.test(s.slice(1, end));
  }
  if (s[0] === '_') return s.length === 20 && /^[./0-9A-Za-z]+$/.test(s.slice(1));
  return s.length === 13 && /^[./0-9A-Za-z]+$/.test(s);
}

/** Known storage schemes (Go knownPasswordSchemes): tag → format check, null = any value. */
const KNOWN_SCHEMES: Record<string, ((rest: string) => boolean) | null> = {
  SHA: digestValue(20), SSHA: digestValue(20), SHA256: digestValue(32), SSHA256: digestValue(32),
  SHA384: digestValue(48), SSHA384: digestValue(48), SHA512: digestValue(64), SSHA512: digestValue(64),
  MD5: digestValue(16), SMD5: digestValue(16),
  CRYPT: cryptValue, 'CRYPT-MD5': cryptValue, 'CRYPT-SHA256': cryptValue, 'CRYPT-SHA512': cryptValue,
  'CRYPT-YESCRYPT': cryptValue, GOST_YESCRYPT: cryptValue,
  ARGON2: (rest) => rest.startsWith('$argon2'),
  PBKDF2: null, 'PBKDF2-SHA1': null, 'PBKDF2-SHA256': null, 'PBKDF2-SHA512': null, PBKDF2_SHA256: null,
  'PBKDF2-HMAC-SHA256': null, 'PBKDF2-HMAC-SHA512': null, PKCS5S2: null,
  BCRYPT: null, SCRYPT: null, 'NS-MTA-MD5': null, APR1: null, BSDMD5: null, LANMAN: null,
  SASL: null, KERBEROS: null, K5KEY: null, UNIX: null, RADIUS: null,
  TOTP1: null, TOTP256: null, TOTP512: null, TOTP1ANDPW: null, TOTP256ANDPW: null, TOTP512ANDPW: null,
  AES: null, '3DES': null, BLOWFISH: null, RC4: null,
};

/**
 * Classifies a userPassword value like Go's classifyPasswordValue: only a
 * known scheme with a plausible value is 'hashed'; explicit cleartext tags
 * ({CLEAR}, {CLEARTEXT}, {PLAIN}), unknown tags ("{Summer}2026!") and
 * malformed values ("{SSHA}garbage") are cleartext passwords.
 */
export function classifyPasswordValue(value: string): { kind: PasswordValueKind; tag: string } {
  if (!value) return { kind: 'empty', tag: '' };
  const t = passwordTag(value);
  if (!t) return { kind: 'cleartext', tag: '' };
  const tag = t.tag.toUpperCase();
  if (CLEARTEXT_TAGS.has(tag)) return { kind: 'cleartextTag', tag };
  if (!Object.prototype.hasOwnProperty.call(KNOWN_SCHEMES, tag)) return { kind: 'unknownTag', tag };
  const check = KNOWN_SCHEMES[tag];
  if (check && !check(t.rest)) return { kind: 'malformed', tag };
  return { kind: 'hashed', tag };
}

/** Whether a userPassword value already carries a known storage scheme (kept as is by every write). */
export function isHashedPasswordValue(value: string): boolean {
  return classifyPasswordValue(value).kind === 'hashed';
}

/** Raw text of a value; binary values are base64 (LDAPAttribute contract). */
function rawValue(value: string, binary: boolean): string {
  if (!binary) return value;
  try {
    return atob(value);
  } catch {
    return '';
  }
}

/** Fixed-width mask of a secret value: never reveals its length. */
export const PASSWORD_MASK = '\u2022'.repeat(8);

export interface SchemeBadge {
  /** Short badge text: '{SSHA}', '{CRYPT}$6$', 'cleartext' */
  text: string;
  /** No storage scheme: shown red */
  cleartext: boolean;
  /** Tooltip */
  title: string;
}

const CRYPT_VARIANTS: { prefix: string; name: string }[] = [
  { prefix: '$6$', name: 'SHA-512-crypt' },
  { prefix: '$5$', name: 'SHA-256-crypt' },
  { prefix: '$2b$', name: 'bcrypt' },
  { prefix: '$2a$', name: 'bcrypt' },
  { prefix: '$2y$', name: 'bcrypt' },
  { prefix: '$y$', name: 'yescrypt' },
  { prefix: '$1$', name: 'MD5-crypt' },
];

/**
 * Badge for a stored userPassword value: its scheme ('{SSHA}', '{CRYPT}$6$',
 * '{PBKDF2-SHA512}') or a red badge when it is not a hash of a known scheme:
 * 'cleartext' (no tag, {CLEAR}, {CLEARTEXT}, {PLAIN}), 'unknown scheme'
 * (never the tag itself: it may be part of the password), 'invalid {SSHA}'.
 * Never contains the value itself. Null for an empty value.
 */
export function passwordSchemeBadge(value: string, binary = false): SchemeBadge | null {
  const raw = rawValue(value, binary);
  if (!raw) return null;
  const { kind, tag } = classifyPasswordValue(raw);
  switch (kind) {
    case 'empty':
      return null;
    case 'cleartext':
    case 'cleartextTag':
      return {
        text: 'cleartext',
        cleartext: true,
        title: kind === 'cleartextTag'
          ? `Cleartext tag {${tag}}: this password is stored in cleartext and readable by everyone allowed to read userPassword`
          : 'No storage scheme: this password is stored in cleartext and readable by everyone allowed to read userPassword',
      };
    case 'unknownTag':
      return {
        text: 'unknown scheme',
        cleartext: true,
        title: 'The value starts with a {...} prefix that is no known password storage scheme: it is most likely a cleartext password, readable by everyone allowed to read userPassword',
      };
    case 'malformed':
      return {
        text: `invalid {${tag}}`,
        cleartext: true,
        title: `The value has a {${tag}} prefix but is not a valid {${tag}} hash: it is stored as given (readable like a cleartext password) and probably does not work for logons`,
      };
  }
  const t = passwordTag(raw)!;
  if (tag === 'CRYPT') {
    const v = CRYPT_VARIANTS.find((c) => t.rest.startsWith(c.prefix));
    if (v) return { text: `{CRYPT}${v.prefix}`, cleartext: false, title: `{CRYPT} ${v.name}` };
    return { text: '{CRYPT}', cleartext: false, title: '{CRYPT} (system crypt(3), e.g. DES)' };
  }
  return { text: `{${tag}}`, cleartext: false, title: `Stored with the {${tag}} scheme` };
}

/** Whether a write carries userPassword or unicodePwd values (else no policy check is needed). */
export function targetHasPasswordValues(target: PasswordWriteTarget): boolean {
  if ('attributes' in target) {
    return target.attributes.some((a: LDAPAttribute) => isPasswordWriteAttribute(a.name) && a.values.length > 0);
  }
  if ('changes' in target) {
    return target.changes.some((c: AttributeChange) => isPasswordWriteAttribute(c.attribute) && c.values.length > 0);
  }
  return /^(userPassword|2\.5\.4\.35|unicodePwd|1\.2\.840\.113556\.1\.4\.90)(;[^:\n]*)?::?/im.test(target.ldif);
}

/** Whether a plan needs the confirmation dialog before the write. */
export function planNeedsPrompt(plan: PasswordWritePlan | null | undefined): boolean {
  return !!plan && plan.hasPasswords && (plan.needsConfirm || plan.needsDecision);
}

// --- Connection dialog -----------------------------------------------------

export const POLICY_SETTINGS: { value: Exclude<PasswordPolicySetting, ''>; label: string; description: string }[] = [
  {
    value: 'auto',
    label: 'Automatic (by server type)',
    description: 'OpenLDAP: hash on the client; 389 Directory Server: the server hashes; Active Directory: unchanged; other servers: ask.',
  },
  {
    value: 'client',
    label: 'Hash on the client',
    description: 'LDAPilot hashes cleartext userPassword values with the selected scheme before they are sent.',
  },
  {
    value: 'server',
    label: 'Server-side hashing',
    description: 'Cleartext is sent and the server hashes it: as is to servers known to hash (389DS, OpenLDAP ppolicy olcPPolicyHashCleartext), else with the Password Modify extended operation (RFC 3062) where possible, else with a warning.',
  },
  {
    value: 'ask',
    label: 'Ask on every write',
    description: 'Every write with a cleartext userPassword value asks how to store it.',
  },
];

export const SERVER_TYPE_LABELS: Record<ServerType, string> = {
  openldap: 'OpenLDAP',
  '389ds': '389 Directory Server',
  ad: 'Active Directory',
  other: 'Other servers',
};

/** One line per server type for the "Automatic" setting. */
export function describePolicyDefault(d: PasswordPolicyDefault, schemeLabel: (id: string) => string): string {
  const server = SERVER_TYPE_LABELS[d.serverType] ?? d.serverType;
  switch (d.policy) {
    case 'client':
      return `${server}: hash on the client with ${schemeLabel(d.scheme) || d.scheme}`;
    case 'server':
      return `${server}: server-side hashing`;
    case 'ad':
      return `${server}: userPassword left to the server (passwords via unicodePwd)`;
    default:
      return `${server}: ask`;
  }
}

/**
 * Compact server support of a scheme for option labels when the server
 * type is not known (profile not connected): " - OpenLDAP: needs module,
 * 389DS: not supported"; '' when every server type has it built in.
 */
export function schemeSupportSummary(scheme: PasswordScheme): string {
  const parts = scheme.support
    .filter((s) => s.server !== 'ad' && s.level !== 'native')
    .map((s) => `${SERVER_TYPE_LABELS[s.server] ?? s.server}: ${s.level === 'module' ? 'needs module' : s.level === 'system' ? 'depends on crypt(3)' : 'not supported'}`);
  return parts.length ? ` - ${parts.join(', ')}` : '';
}

/**
 * Client-side scheme used when "client" has no scheme, as Go's
 * DefaultClientScheme: OpenLDAP SHA-512-crypt (stock crypt(3)), 389DS
 * PBKDF2-SHA512 (its own default), else {SSHA}.
 */
export function defaultClientScheme(serverType: ServerType | string): string {
  if (serverType === 'openldap') return 'CRYPT-SHA512';
  if (serverType === '389ds') return 'PBKDF2-SHA512';
  return 'SSHA';
}

/** Stored form of the setting ('' for automatic). */
export function normalizePolicySetting(value: string | undefined): '' | 'client' | 'server' | 'ask' {
  return value === 'client' || value === 'server' || value === 'ask' ? value : '';
}

// --- Hints and results -----------------------------------------------------

export interface PolicyNotice {
  level: 'info' | 'warning';
  text: string;
}

/** Text for writes that store userPassword exactly as given (LDIF "store passwords exactly as in the file"). */
export const AS_IS_NOTICE = 'Passwords are stored exactly as in the file: values without a known {SCHEME} prefix are sent and stored as written (no hashing), so the server keeps them in cleartext unless it hashes cleartext values itself. The connection\'s password storage policy does not apply.';

/**
 * Notices shown next to a password field: the policy in one sentence and
 * what an unencrypted connection means for it. With asIs (LDIF opt-out) the
 * policy does not apply: the notices say that values are stored as written.
 */
export function policyNotices(eff: EffectivePasswordPolicy, opts: { asIs?: boolean } = {}): PolicyNotice[] {
  if (opts.asIs) {
    const out: PolicyNotice[] = [{ level: 'warning', text: AS_IS_NOTICE }];
    if (!eff.tls) out.push({ level: 'warning', text: 'The connection is not encrypted: cleartext passwords are sent over the network; you will be asked to confirm.' });
    return out;
  }
  const out: PolicyNotice[] = [{ level: eff.policy === 'ad' ? 'warning' : 'info', text: eff.summary }];
  for (const w of eff.warnings ?? []) out.push({ level: 'warning', text: w });
  if (!eff.tls) {
    out.push(eff.policy === 'client'
      ? { level: 'info', text: 'The connection is not encrypted: the password hash is visible on the network.' }
      : { level: 'warning', text: 'The connection is not encrypted: the password would be sent in cleartext; you will be asked to confirm.' });
  }
  return out;
}

/** Short text of the effective policy for badges: 'client {CRYPT} SHA-512-crypt ($6$)', 'server-side', … */
export function policyShortLabel(eff: EffectivePasswordPolicy): string {
  switch (eff.policy) {
    case 'client':
      return `hashed on the client: ${eff.schemeLabel || eff.scheme}`;
    case 'server':
      return 'server-side hashing';
    case 'ask':
      return 'ask on every write';
    default:
      return 'left to Active Directory';
  }
}

export type ReportOutcome = 'none' | 'ok' | 'warning' | 'error';

/**
 * How a write report is shown: 'error' when the password is stored in
 * cleartext or will not work, 'warning' for other warnings, 'ok' when
 * passwords were written without problems, 'none' without passwords.
 */
export function reportOutcome(report: PasswordWriteReport | null | undefined): ReportOutcome {
  if (!report) return 'none';
  if (report.cleartext || report.ineffective) return 'error';
  if (report.unconfirmed || report.warnings.length > 0) return 'warning';
  return report.actions.length > 0 ? 'ok' : 'none';
}

/** Title of the toast for a report with outcome 'error' or 'warning'. */
export function reportTitle(report: PasswordWriteReport): string {
  if (report.ineffective) return 'The new password will not work';
  if (report.cleartext) {
    return report.storedSchemes.some((s) => s === 'unknown scheme' || s.startsWith('invalid '))
      ? 'Password stored without a known scheme'
      : 'Password stored in cleartext';
  }
  if (report.unconfirmed) return 'The new password may not work';
  return 'Password storage warning';
}

/**
 * Headline of the toast for a report with outcome 'error' or 'warning': the
 * reason itself ("Unknown {…} prefix treated as cleartext → stored as
 * {SSHA}"), so it is readable without "Show details". An unknown {TAG} is
 * never echoed (it may be the start of a typed password).
 */
export function reportHeadline(report: PasswordWriteReport): string {
  const stored = report.storedSchemes.join(', ');
  const tagged = report.warnings.some((w) => w.includes('treated as a cleartext password'));
  if (report.ineffective) {
    for (const w of report.warnings) {
      const m = /stored (.+?) instead of the (?:already hashed )?(.+?) value/.exec(w);
      if (m) return `The new password will not work: ${m[2]} was sent, the server stored ${m[1]}`;
    }
    return 'The new password will not work';
  }
  if (tagged) {
    return `Unknown {…} prefix treated as cleartext → ${report.cleartext ? 'stored in cleartext' : stored ? `stored as ${stored}` : 'hashed as a password'}`;
  }
  if (report.cleartext) {
    if (report.warnings.some((w) => w.startsWith('Active Directory stored userPassword in cleartext'))) {
      return 'Active Directory stored userPassword in cleartext (readable ordinary attribute)';
    }
    if (report.storedSchemes.some((x) => x === 'unknown scheme' || x.startsWith('invalid '))) return 'Password stored without a known scheme (readable like cleartext)';
    if (report.warnings.some((w) => w.startsWith('The entry still has'))) return 'An older userPassword value is still stored in cleartext';
    return 'Password stored in cleartext (readable by anyone allowed to read userPassword)';
  }
  if (report.unconfirmed) {
    const m = report.warnings.map((w) => /Support of (\{[^}]+\}) is not confirmed/.exec(w)).find(Boolean);
    return m ? `The new password may not work: ${m[1]} is not confirmed on this server` : 'The new password may not work: scheme support not confirmed';
  }
  return report.warnings[0] && report.warnings[0].length <= 90 ? report.warnings[0] : 'Password storage warning';
}

/** Follow-up actions of a password write toast, most useful first. */
export type PasswordToastAction = 'remove' | 'reset' | 'open';

/**
 * The actions a password write toast offers: a readable (cleartext) value
 * first wants "Remove Value", a password that will not work "Reset
 * Password…", other warnings "Open Entry". Empty when nothing needs action.
 */
export function passwordToastActions(report: PasswordWriteReport | null | undefined): PasswordToastAction[] {
  switch (reportOutcome(report)) {
    case 'error':
      return report!.ineffective ? ['reset', 'remove', 'open'] : ['remove', 'reset', 'open'];
    case 'warning':
      return report!.unconfirmed ? ['reset', 'open'] : ['open', 'reset'];
    default:
      return [];
  }
}

export const PASSWORD_TOAST_ACTION_LABELS: Record<PasswordToastAction, string> = {
  remove: 'Remove Value',
  reset: 'Reset Password…',
  open: 'Open Entry',
};

/** Password counters of a bulk apply run (Go models.BulkApplyResult). */
export interface BulkPasswordCounts {
  passwordIneffective?: number;
  passwordCleartext?: number;
  passwordWarnings?: number;
}

/**
 * What a bulk modify / LDIF run says about the passwords it wrote: 'error'
 * when passwords will not work or are stored in cleartext, 'warning' for
 * other password warnings (scheme not confirmed, …), null when there is
 * nothing to say. text: "2 new passwords will not work, 1 stored in cleartext".
 */
export function bulkPasswordOutcome(res: BulkPasswordCounts): { level: 'error' | 'warning'; text: string } | null {
  const ineffective = res.passwordIneffective ?? 0;
  const cleartext = res.passwordCleartext ?? 0;
  const other = res.passwordWarnings ?? 0;
  const parts: string[] = [];
  if (ineffective) parts.push(`${ineffective} new password${ineffective === 1 ? '' : 's'} will not work`);
  if (cleartext) parts.push(`${cleartext} password${cleartext === 1 ? '' : 's'} stored in cleartext`);
  if (other) parts.push(`${other} with password warnings`);
  if (parts.length === 0) return null;
  return { level: ineffective || cleartext ? 'error' : 'warning', text: parts.join(', ') };
}

/** The re-lock note of a disabled OpenLDAP account (Go lockKeptNote, services/account_lockguard.go). */
function isLockKeptNote(action: string): boolean {
  return action.startsWith('account kept disabled');
}

/**
 * Whether the write kept a disabled OpenLDAP account disabled: ppolicy
 * cleared the permanent lock with the password change and LDAPilot set it
 * again (the toast says "account stays disabled").
 */
export function reportKeptDisabled(report: PasswordWriteReport | null | undefined): boolean {
  return !!report?.actions?.some(isLockKeptNote);
}

/** One line: 'userPassword stored as {CRYPT} SHA-512-crypt ($6$)'. */
export function reportSummary(report: PasswordWriteReport): string {
  if (report.storedSchemes.length > 0) return `userPassword stored as ${report.storedSchemes.join(', ')}`;
  if (report.exop) return 'Password set with the Password Modify extended operation';
  return report.actions.find((a) => !isLockKeptNote(a)) ?? '';
}

/** The text in brackets of a successful password write toast: the storage summary, "account stays disabled". */
export function reportSuccessDetail(report: PasswordWriteReport | null | undefined): string {
  if (!report) return '';
  return [reportSummary(report), reportKeptDisabled(report) ? 'account stays disabled' : ''].filter(Boolean).join(', ');
}
