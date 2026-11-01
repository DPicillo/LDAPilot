/**
 * Server-aware choices of the password dialog: which methods and options are
 * offered, the defaults, the per-profile memory of the last choice and the
 * warnings. Pure functions over PasswordContext (except the localStorage
 * helpers at the end).
 */
import type { ServerType } from '../types/ldap'
import type { PasswordChangeResult, PasswordContext, PasswordMethod, PasswordScheme, PasswordSchemeSupport } from '../types/password'

export interface PasswordSelection {
  method: PasswordMethod;
  /** Scheme id for method 'userPassword' */
  scheme: string;
  verifyBind: boolean;
}

export interface MethodOption {
  method: PasswordMethod;
  label: string;
  description: string;
}

export const SERVER_LABELS: Record<ServerType, string> = {
  ad: 'Active Directory',
  openldap: 'OpenLDAP',
  '389ds': '389 Directory Server',
  other: 'LDAP server',
};

const METHOD_OPTIONS: Record<PasswordMethod, MethodOption> = {
  unicodePwd: {
    method: 'unicodePwd',
    label: 'unicodePwd (Active Directory)',
    description: 'Administrative reset of the AD account password; the domain controller hashes it.',
  },
  exop: {
    method: 'exop',
    label: 'Server-side hashing (Password Modify, RFC 3062)',
    description: 'The server hashes the password according to its own policy (e.g. olcPasswordHash, passwordStorageScheme).',
  },
  userPassword: {
    method: 'userPassword',
    label: 'userPassword attribute (client-side hash or cleartext)',
    description: 'LDAPilot hashes the password with the selected scheme and writes userPassword.',
  },
};

/**
 * Whether sel sends a cleartext userPassword value that the server hashes
 * itself (server-side hashing without Password Modify, e.g. 389DS over an
 * unencrypted connection, where it refuses the extended operation).
 */
export function serverHashesCleartext(ctx: PasswordContext, sel: PasswordSelection): boolean {
  return sel.method === 'userPassword' && sel.scheme.toUpperCase() === 'CLEARTEXT' && !!ctx.policy?.serverHashes &&
    ctx.serverType !== 'ad';
}

/** Description of the selected method below the methods list. */
export function methodDescription(ctx: PasswordContext, sel: PasswordSelection): string {
  if (sel.method === 'userPassword' && sel.scheme.toUpperCase() === 'CLEARTEXT') {
    return serverHashesCleartext(ctx, sel)
      ? `LDAPilot writes the password as a cleartext userPassword value and the server hashes it${serverHashingScheme(ctx.policy!.serverHashing)}: server-side hashing without the Password Modify operation.`
      : 'LDAPilot writes the password as a cleartext userPassword value (no hashing on the client).';
  }
  return METHOD_OPTIONS[sel.method]?.description ?? '';
}

/**
 * Whether the entry is an AD-style account (objectClass user or computer) on
 * a server that is not detected as Active Directory, e.g. AD LDS, which also
 * takes passwords through unicodePwd.
 */
export function isADStyleEntry(ctx: PasswordContext): boolean {
  return ctx.serverType === 'other' && ctx.objectClasses.some((oc) => {
    const l = oc.toLowerCase();
    return l === 'user' || l === 'computer';
  });
}

/**
 * The methods offered for ctx. AD offers only unicodePwd unless advanced is
 * set; other servers offer Password Modify (when announced) and client-side
 * hashing. On unknown server types unicodePwd comes first for AD-style
 * entries (AD LDS) and is otherwise only offered in advanced mode.
 */
export function availableMethods(ctx: PasswordContext, advanced: boolean): MethodOption[] {
  const methods: PasswordMethod[] = [];
  if (ctx.serverType === 'ad') {
    methods.push('unicodePwd');
    if (advanced) {
      if (ctx.passwordModifyExop) methods.push('exop');
      methods.push('userPassword');
    }
  } else {
    const adStyle = isADStyleEntry(ctx);
    if (adStyle) methods.push('unicodePwd');
    if (ctx.passwordModifyExop) methods.push('exop');
    methods.push('userPassword');
    if (advanced && ctx.serverType === 'other' && !adStyle) methods.push('unicodePwd');
  }
  return methods.map((m) => METHOD_OPTIONS[m]);
}

/** Whether the methods list has entries hidden behind the "Advanced" toggle. */
export function hasAdvancedMethods(ctx: PasswordContext): boolean {
  return availableMethods(ctx, true).length > availableMethods(ctx, false).length;
}

/** Whether sel needs the advanced methods list to be shown. */
export function isAdvancedSelection(ctx: PasswordContext, sel: PasswordSelection): boolean {
  return !availableMethods(ctx, false).some((m) => m.method === sel.method);
}

/** Whether ctx is AD or an AD-style entry, where unicodePwd is the password. */
function isADLike(ctx: PasswordContext): boolean {
  return ctx.serverType === 'ad' || isADStyleEntry(ctx);
}

/**
 * The preselected client-side scheme: Cleartext on AD (a hashed userPassword
 * is never usable there - with fUserPwdSupport the hash string itself would
 * become the password), otherwise the backend's default (SSHA).
 */
export function defaultSchemeFor(ctx: PasswordContext): string {
  const known = (id: string) => ctx.schemes.some((s) => s.id === id);
  if (isADLike(ctx) && known('CLEARTEXT')) return 'CLEARTEXT';
  return known(ctx.defaultScheme) ? ctx.defaultScheme : ctx.schemes[0]?.id ?? 'SSHA';
}

/** Whether scheme is built into ctx's server type (catalog level 'native'). */
export function schemeIsNative(ctx: PasswordContext, schemeId: string): boolean {
  return schemeSupportFor(ctx.schemes.find((s) => s.id === schemeId), ctx.serverType)?.level === 'native';
}

/**
 * Whether "Verify" should start enabled for a selection. Never on an
 * unencrypted connection: the verification bind sends the new password in
 * cleartext. Over TLS it is on for client-side hashing (the server may not
 * understand the scheme) and kept as is otherwise.
 */
export function verifyDefault(ctx: PasswordContext, method: PasswordMethod, current: boolean): boolean {
  if (!ctx.tls) return false;
  return method === 'userPassword' ? true : current;
}

/**
 * The selection the connection's password storage policy asks for (null for
 * "ask", AD and unknown policies): "client" = userPassword with the policy's
 * scheme; "server" = Password Modify when announced, except on an
 * unencrypted connection to a server known to hash cleartext values (389DS
 * refuses Password Modify without TLS but hashes a cleartext userPassword),
 * else cleartext userPassword that the server hashes.
 */
export function policySelection(ctx: PasswordContext): PasswordSelection | null {
  const policy = ctx.policy;
  if (!policy || isADLike(ctx)) return null;
  const known = (id: string) => ctx.schemes.some((s) => s.id === id);
  if (policy.policy === 'client' && known(policy.scheme)) {
    return { method: 'userPassword', scheme: policy.scheme, verifyBind: verifyDefault(ctx, 'userPassword', false) };
  }
  if (policy.policy === 'server') {
    if (ctx.passwordModifyExop && (ctx.tls || !policy.serverHashes)) return { method: 'exop', scheme: defaultSchemeFor(ctx), verifyBind: false };
    if (known('CLEARTEXT')) return { method: 'userPassword', scheme: 'CLEARTEXT', verifyBind: false };
  }
  return null;
}

/** Whether sel differs from what the connection's policy asks for. */
export function deviatesFromPolicy(ctx: PasswordContext, sel: PasswordSelection): boolean {
  const p = policySelection(ctx);
  if (!p) return false;
  return p.method !== sel.method || (sel.method === 'userPassword' && p.scheme !== sel.scheme);
}

/**
 * Whether a reset with sel sends the cleartext password to the server
 * (unicodePwd, Password Modify, cleartext userPassword, verification bind);
 * on an unencrypted connection the dialog then asks for a confirmation
 * (mirrors Go passwordChangeSendsCleartext).
 */
export function sendsCleartext(sel: PasswordSelection): boolean {
  return sel.verifyBind || sel.method === 'unicodePwd' || sel.method === 'exop' ||
    (sel.method === 'userPassword' && sel.scheme.toUpperCase() === 'CLEARTEXT');
}

/** Why the reset cannot be sent at all, and how to fix it. */
export interface SubmitBlock {
  reason: string;
  fix: string;
}

/**
 * Resets the server would refuse anyway are not sent (Go
 * passwordTransportError refuses them too): Active Directory takes
 * passwords only over LDAPS/StartTLS (unicodePwd; userPassword with
 * fUserPwdSupport as well), and unicodePwd is refused without TLS on every
 * server. Confirming an unencrypted send would only put the password on the
 * wire for nothing.
 */
export function passwordSubmitBlock(ctx: PasswordContext, sel: PasswordSelection): SubmitBlock | null {
  if (ctx.tls) return null;
  if (ctx.serverType === 'ad') {
    return {
      reason: 'Active Directory accepts password resets only over an encrypted connection: over plain LDAP the domain controller refuses them (WILL_NOT_PERFORM).',
      fix: 'Reconnect with StartTLS or LDAPS: edit the connection, choose LDAPS (port 636) or StartTLS, save and reconnect.',
    };
  }
  if (sel.method === 'unicodePwd') {
    return {
      reason: 'unicodePwd is only accepted over an encrypted connection (LDAPS or StartTLS).',
      fix: 'Reconnect with StartTLS or LDAPS, or choose another method under Details.',
    };
  }
  return null;
}

/** The one summary line of the dialog: how the password is stored and how it travels. */
export interface PasswordSummaryLine {
  /** "{CRYPT} SHA-512-crypt ($6$), hashed by LDAPilot (policy)" */
  storage: string;
  /** "encrypted (StartTLS)" / "sent in clear over this connection" */
  transport: string;
  /** The transport puts the cleartext password on an unencrypted connection. */
  transportWarning: boolean;
}

/**
 * " with PBKDF2-SHA512" from the server's hashing note ("389 Directory Server
 * stores passwords with PBKDF2-SHA512 (passwordStorageScheme)"), else the
 * note in parentheses: never nested parentheses in the summary (RW1-P-05).
 */
export function serverHashingScheme(note: string | undefined): string {
  const n = (note ?? '').trim();
  if (!n) return '';
  const m = n.match(/stores passwords with\s+(.+?)(?:\s*\([^)]*\))?\s*$/i);
  if (m) return ` with ${m[1]}`;
  // A bare scheme name ("PBKDF2-SHA512").
  if (!/\s/.test(n)) return ` with ${n}`;
  return ` (${n.replace(/\s*\([^)]*\)\s*$/, '')})`;
}

export function passwordSummaryLine(ctx: PasswordContext, sel: PasswordSelection): PasswordSummaryLine {
  const scheme = ctx.schemes.find((s) => s.id === sel.scheme);
  let storage: string;
  switch (sel.method) {
    case 'unicodePwd':
      storage = 'unicodePwd, hashed by the domain controller';
      break;
    case 'exop':
      storage = 'Password Modify (RFC 3062), hashed by the server';
      break;
    default:
      if (sel.scheme.toUpperCase() === 'CLEARTEXT') {
        storage = serverHashesCleartext(ctx, sel)
          ? `Cleartext – the server hashes it${serverHashingScheme(ctx.policy!.serverHashing)}`
          : 'Cleartext userPassword, stored as sent unless the server hashes it';
      } else {
        storage = `${scheme?.label ?? `{${sel.scheme}}`}, hashed by LDAPilot`;
      }
  }
  if (policySelection(ctx) && !deviatesFromPolicy(ctx, sel)) storage += ' (policy)';
  const tlsLabel = ctx.tlsMode === 'ssl' ? 'LDAPS' : ctx.tlsMode === 'starttls' ? 'StartTLS' : 'TLS';
  if (ctx.tls) return { storage, transport: `encrypted (${tlsLabel})`, transportWarning: false };
  if (sendsCleartext(sel)) return { storage, transport: 'sent in clear over this unencrypted connection', transportWarning: true };
  return { storage, transport: 'only the hash crosses this unencrypted connection', transportWarning: false };
}

/** Option text of a method: its label, "(policy)" on the method the connection's policy chose. */
export function methodOptionLabel(ctx: PasswordContext, option: MethodOption): string {
  return policySelection(ctx)?.method === option.method ? `${option.label} (policy)` : option.label;
}

/** One line about the connection's password storage policy for the dialog. */
export function policyLine(ctx: PasswordContext): string {
  const p = ctx.policy;
  if (!p) return '';
  const source = p.source === 'profile' ? 'connection setting' : `default for ${SERVER_LABELS[ctx.serverType] ?? 'this server'}`;
  switch (p.policy) {
    case 'client':
      return `Password storage policy: hash on the client with ${p.schemeLabel || p.scheme} (${source}).`;
    case 'server': {
      const sel = policySelection(ctx);
      if (sel && serverHashesCleartext(ctx, sel)) {
        const how = `the password is sent as a cleartext userPassword value, which the server hashes${serverHashingScheme(p.serverHashing)}.`;
        return `Password storage policy: server-side hashing (${source}). ${ctx.tls || !ctx.passwordModifyExop
          ? how.charAt(0).toUpperCase() + how.slice(1)
          : `Over this unencrypted connection the Password Modify operation is not used (389DS refuses it without TLS), so ${how}`}`;
      }
      return `Password storage policy: server-side hashing (${source}).`;
    }
    case 'ask':
      return `Password storage policy: ask on every write (${source}); choose the method below.`;
    default:
      return '';
  }
}

/**
 * The initial selection: AD (and AD-style entries on unknown servers) always
 * starts with unicodePwd. Elsewhere the connection's password storage policy
 * decides (policySelection); with "ask" the remembered choice of the profile
 * wins if it is still offered, then server-side hashing when the server
 * announces Password Modify, then the default client-side scheme (SSHA).
 * "Verify" never starts enabled on an unencrypted connection, and starts
 * enabled over TLS for a scheme that is not built into the server.
 */
export function defaultSelection(ctx: PasswordContext, remembered: PasswordSelection | null): PasswordSelection {
  const fallbackScheme = defaultSchemeFor(ctx);
  if (isADLike(ctx)) {
    return {
      method: 'unicodePwd',
      scheme: fallbackScheme,
      verifyBind: ctx.tls && remembered?.method === 'unicodePwd' && remembered.verifyBind,
    };
  }
  const fromPolicy = policySelection(ctx);
  if (fromPolicy && availableMethods(ctx, false).some((m) => m.method === fromPolicy.method)) return fromPolicy;
  if (remembered && availableMethods(ctx, false).some((m) => m.method === remembered.method)) {
    const scheme = ctx.schemes.some((s) => s.id === remembered.scheme) ? remembered.scheme : fallbackScheme;
    const unproven = remembered.method === 'userPassword' && !schemeIsNative(ctx, scheme);
    return { method: remembered.method, scheme, verifyBind: ctx.tls && (remembered.verifyBind || unproven) };
  }
  if (ctx.passwordModifyExop) return { method: 'exop', scheme: fallbackScheme, verifyBind: false };
  return { method: 'userPassword', scheme: fallbackScheme, verifyBind: verifyDefault(ctx, 'userPassword', false) };
}

/** sel after the admin picked method in the dialog (see verifyDefault). */
export function selectMethod(ctx: PasswordContext, sel: PasswordSelection, method: PasswordMethod): PasswordSelection {
  return { ...sel, method, verifyBind: method === 'userPassword' && ctx.tls ? true : sel.verifyBind };
}

/**
 * sel after the admin picked a scheme: over TLS a scheme that is not built
 * into the server turns "Verify" on, since only a bind proves it works.
 */
export function selectScheme(ctx: PasswordContext, sel: PasswordSelection, schemeId: string): PasswordSelection {
  return { ...sel, scheme: schemeId, verifyBind: sel.verifyBind || (ctx.tls && !schemeIsNative(ctx, schemeId)) };
}

/** Hint below the "Verify" checkbox. */
export function verifyHint(ctx: PasswordContext): string {
  const base = 'Binds with the new password on a separate connection. A failed bind counts as a failed logon attempt.';
  return ctx.tls
    ? base
    : `${base} This connection is not encrypted, so the bind sends the new password in cleartext.`;
}

/** The support entry of scheme for serverType, if documented. */
export function schemeSupportFor(scheme: PasswordScheme | undefined, serverType: ServerType): PasswordSchemeSupport | undefined {
  return scheme?.support.find((s) => s.server === serverType);
}

/**
 * Option text of a scheme in the select: label, marker and support on
 * serverType. The marker is "(policy)" on the scheme the connection's
 * password storage policy chose (opts.policyScheme; '' when it chose no
 * userPassword scheme, e.g. Password Modify), "(default)" on defaultScheme
 * only when there is no policy choice. With opts.serverHashes the cleartext
 * option reads "Cleartext – the server hashes it".
 */
/**
 * A scheme option label with its strength: weak (unsalted / MD5 / SHA-1)
 * and cleartext schemes say so, in every scheme list (connection dialog,
 * the per-write "How should the password be stored?" dialog: RW3-P-03).
 */
export function schemeWithStrength(label: string, security: string | undefined): string {
  if (security === 'weak') return `${label} - weak`;
  if (security === 'none') return `${label} - not hashed`;
  return label;
}

export function schemeOptionLabel(
  scheme: PasswordScheme,
  serverType: ServerType,
  defaultScheme: string,
  opts: { policyScheme?: string; serverHashes?: boolean } = {},
): string {
  let text = scheme.id === 'CLEARTEXT' && opts.serverHashes ? 'Cleartext – the server hashes it' : scheme.label;
  if (opts.policyScheme !== undefined) {
    if (opts.policyScheme && scheme.id === opts.policyScheme) text += ' (policy)';
  } else if (scheme.id === defaultScheme) {
    text += ' (default)';
  }
  const level = schemeSupportFor(scheme, serverType)?.level;
  if (level === 'module') text += ' - needs server module';
  else if (level === 'system') text += ' - depends on the server\'s crypt(3)';
  else if (level === 'no') text += ' - not supported here';
  return text;
}

export interface SchemeGroup {
  label: string;
  schemes: PasswordScheme[];
}

/** Groups the schemes for the select: recommended, legacy, no hashing. */
/** The schemeOptionLabel options of ctx: the policy's scheme and whether the server hashes cleartext. */
export function schemeLabelOptions(ctx: PasswordContext): { policyScheme?: string; serverHashes: boolean } {
  const p = policySelection(ctx);
  return {
    policyScheme: p ? (p.method === 'userPassword' ? p.scheme : '') : undefined,
    serverHashes: !!ctx.policy?.serverHashes && ctx.serverType !== 'ad',
  };
}

export function groupSchemes(schemes: PasswordScheme[]): SchemeGroup[] {
  const groups: SchemeGroup[] = [
    { label: 'Recommended', schemes: schemes.filter((s) => s.security === 'strong' || s.security === 'good') },
    { label: 'Legacy (weak)', schemes: schemes.filter((s) => s.security === 'weak') },
    { label: 'No hashing', schemes: schemes.filter((s) => s.security === 'none') },
  ];
  return groups.filter((g) => g.schemes.length > 0);
}

export interface AccountOption {
  available: boolean;
  label: string;
  hint: string;
}

export interface AccountOptions {
  mustChange: AccountOption;
  unlock: AccountOption;
  /** Enable a disabled account with the reset (AD, 389DS; on OpenLDAP the unlock option re-enables) */
  enable: AccountOption;
  /** Explanation shown when the options are not available or work differently */
  info: string;
}

const unavailable: AccountOption = { available: false, label: '', hint: '' };

/** The account options (must change at next logon, unlock, enable) for ctx. */
export function accountOptions(ctx: PasswordContext): AccountOptions {
  const enable: AccountOption = ctx.disabled && (ctx.serverType === 'ad' || ctx.serverType === '389ds')
    ? {
      available: true,
      label: 'Enable the account',
      hint: ctx.serverType === 'ad'
        ? 'The account is disabled. Ticked, the reset also clears ACCOUNTDISABLE (same request as the password).'
        : 'The account is disabled (nsAccountLock). Ticked, the reset also enables it.',
    }
    : unavailable;
  const pol = ctx.accountPolicy;
  switch (ctx.serverType) {
    case 'ad':
      return {
        enable,
        mustChange: {
          available: true,
          label: 'User must change password at next logon',
          hint: ctx.passwordNeverExpires
            ? '"Password never expires" is set on this account: AD ignores pwdLastSet=0 and will not ask the user to change the password.'
            : 'Sets pwdLastSet=0 in the same modify request as the password.',
        },
        unlock: {
          available: true,
          label: 'Unlock the account',
          hint: ctx.locked ? 'The account is currently locked out. Sets lockoutTime=0.' : 'Sets lockoutTime=0 (the account is not locked out).',
        },
        info: '',
      };
    case 'openldap':
      if (!ctx.ppolicyControl) {
        return {
          mustChange: unavailable,
          unlock: unavailable,
          enable: unavailable,
          info: 'The server does not announce the password policy control (ppolicy overlay), so "must change" and "unlock" are not available.',
        };
      }
      return {
        mustChange: {
          available: true,
          label: 'User must change password at next logon (pwdReset: TRUE)',
          hint: pol?.readable && pol.source !== 'none'
            ? pol.mustChangeEnforced
              ? `The password policy ${pol.name} enforces it (pwdMustChange: TRUE).`
              : `The password policy ${pol.name} has pwdMustChange FALSE, so OpenLDAP does not ask for a new password.`
            : 'Takes effect when the user\'s password policy has pwdMustChange: TRUE.',
        },
        unlock: ctx.disabled
          ? {
            available: true,
            label: 'Unlock / re-enable the account',
            hint: 'The account is disabled (permanent ppolicy lock). Ticked, the reset enables it; unticked, the lock is set again after the reset and the account stays disabled.',
          }
          : {
            available: true,
            label: 'Unlock the account',
            hint: (ctx.locked ? 'The account is currently locked (pwdAccountLockedTime). ' : '') +
              'ppolicy clears the lockout on every password reset; a remaining pwdAccountLockedTime is removed.',
          },
        enable: unavailable,
        info: '',
      };
    case '389ds':
      return {
        mustChange: unavailable,
        unlock: unavailable,
        enable,
        info: '389 Directory Server: its password policy decides whether the user must change the password after a reset (passwordMustChange). An administrator reset also clears an account lockout.',
      };
    default:
      return { mustChange: unavailable, unlock: unavailable, enable: unavailable, info: '' };
  }
}

/**
 * Initial state of the account options: like ADUC, AD user resets default to
 * "must change" (not for computer accounts, and not when the password never
 * expires, where AD ignores it); OpenLDAP follows the effective password
 * policy (pwdMustChange: TRUE ticks it); unlock is preselected when the
 * account is locked (not for a disabled OpenLDAP account: re-enabling is a
 * decision); enable is never preselected.
 */
export function defaultAccountFlags(ctx: PasswordContext): { mustChange: boolean; unlock: boolean; enable: boolean } {
  const opts = accountOptions(ctx);
  const isComputer = ctx.objectClasses.some((oc) => oc.toLowerCase() === 'computer');
  const pol = ctx.accountPolicy;
  const mustChange = ctx.serverType === 'ad'
    ? ctx.isADAccount && !isComputer && !ctx.passwordNeverExpires
    : ctx.serverType === 'openldap' && !!pol?.readable && pol.source !== 'none' && pol.mustChangeEnforced;
  return {
    mustChange: opts.mustChange.available && mustChange,
    unlock: opts.unlock.available && ctx.locked,
    enable: false,
  };
}

export interface DialogNotice {
  level: 'warning' | 'info';
  text: string;
}

/** Warnings and hints for the current selection. */
export function selectionNotices(ctx: PasswordContext, sel: PasswordSelection, mustChange = false): DialogNotice[] {
  const notices: DialogNotice[] = [];
  const scheme = ctx.schemes.find((s) => s.id === sel.scheme);
  const server = SERVER_LABELS[ctx.serverType] ?? 'the server';

  if (ctx.readOnly) {
    notices.push({ level: 'warning', text: 'This connection profile is read-only; the password cannot be changed.' });
  }
  if (ctx.serverType === 'ad') {
    // Without TLS the reset is blocked with its reason (passwordSubmitBlock).
    if (!ctx.isADAccount) {
      notices.push({ level: 'warning', text: 'This entry is not a user, computer or inetOrgPerson account and has no password.' });
    }
    if (sel.method === 'userPassword') {
      notices.push({
        level: 'warning',
        text: 'On Active Directory, userPassword only sets the account password when dSHeuristics enables fUserPwdSupport; otherwise it is stored as an ordinary attribute and the real password does not change. Use cleartext if you rely on fUserPwdSupport.',
      });
    }
    if (sel.method === 'userPassword' && scheme && scheme.security !== 'none') {
      notices.push({
        level: 'warning',
        text: `A hashed value is never usable as an AD password: with fUserPwdSupport the ${scheme.label.split(' ')[0]} string itself would become the password. Choose Cleartext.`,
      });
    }
    if (mustChange && ctx.passwordNeverExpires) {
      notices.push({
        level: 'warning',
        text: '"Password never expires" is set on this account, so AD does not enforce "must change at next logon" (pwdLastSet=0) until that flag is cleared.',
      });
    }
  } else if (!ctx.tls) {
    const hashedOnClient = sel.method === 'userPassword' && scheme?.security !== 'none';
    notices.push({
      level: hashedOnClient ? 'info' : 'warning',
      text: hashedOnClient
        ? sel.verifyBind
          ? 'This connection is not encrypted: the password hash is sent in the clear.'
          : 'This connection is not encrypted: the password hash is sent in the clear (the password itself is not, as long as "Verify" is off).'
        : sel.method === 'unicodePwd'
          ? 'This connection is not encrypted: the password is sent in the clear, and AD-style servers (AD LDS) usually reject unicodePwd changes without LDAPS or StartTLS.'
          : sel.method === 'exop'
            ? 'This connection is not encrypted: the password is sent in the clear. Some servers (e.g. 389DS) refuse the Password Modify operation without TLS.'
            : 'This connection is not encrypted: the password is sent in the clear (the server hashes it when it is stored).',
    });
  }
  if (!ctx.tls && sel.verifyBind) {
    notices.push({
      level: 'warning',
      text: '"Verify" binds with the new password over this unencrypted connection, so the password itself is sent in cleartext. Turn "Verify" off or connect with LDAPS/StartTLS.',
    });
  }

  if (sel.method === 'userPassword' && scheme) {
    if (scheme.security === 'none' && serverHashesCleartext(ctx, sel)) {
      notices.push({
        level: 'info',
        text: `No hashing on the client: ${server} hashes cleartext userPassword values itself${serverHashingScheme(ctx.policy!.serverHashing)}.`,
      });
    } else if (scheme.security === 'none') {
      notices.push({
        level: 'warning',
        text: 'Cleartext: the server stores the password as is unless it hashes cleartext values itself (OpenLDAP ppolicy olcPPolicyHashCleartext, 389DS always). Anyone allowed to read userPassword can read it.',
      });
    } else if (scheme.security === 'weak') {
      notices.push({ level: 'warning', text: `${scheme.label} is a weak legacy scheme; use it only for compatibility with old clients.` });
    }
    const support = schemeSupportFor(scheme, ctx.serverType);
    const prove = ctx.tls ? 'keep "Verify" enabled' : 'only a bind with the new password proves it works';
    if (support?.level === 'no' && ctx.serverType !== 'ad') {
      notices.push({ level: 'warning', text: `${server} does not support ${scheme.label}: the new password will not work.` });
    } else if (support?.level === 'module' || support?.level === 'system') {
      notices.push({
        level: 'warning',
        text: `${server} ${support.note}. Without it the server cannot verify the hash and the password will not work; the server may still store the value as sent (or re-hash it as cleartext), so ${prove}.`,
      });
    } else if (!support && scheme.security !== 'none') {
      notices.push({ level: 'info', text: `Whether ${server} supports ${scheme.label} is unknown; ${prove}.` });
    }
  }
  if (ctx.mustChange) {
    if (ctx.serverType === '389ds') {
      notices.push({
        level: 'info',
        text: 'A password change is currently pending for this account (pwdReset). The password policy decides whether it is still required after this reset: with passwordMustChange on, an administrator reset requires a change again.',
      });
    } else if (!mustChange && accountOptions(ctx).mustChange.available) {
      notices.push({ level: 'info', text: 'A password change is currently pending for this account; this reset clears it unless "must change" is selected again.' });
    }
  }
  return notices;
}

/**
 * How the dialog reports a result: 'failed' when the new password most
 * likely does not work (error toast, the choice is not remembered),
 * 'warning' when it was written but something needs attention (support not
 * confirmed, cleartext storage, ignored must-change), else 'success'.
 */
export type ResultOutcome = 'success' | 'warning' | 'failed';

export function resultOutcome(res: PasswordChangeResult): ResultOutcome {
  if (res.verifyError || res.ineffective) return 'failed';
  if (res.unconfirmed || res.mustChangeIgnored || res.warnings.length > 0) return 'warning';
  return 'success';
}

/**
 * Display text of a stored userPassword scheme: the server's label
 * ('{SSHA}', '{CRYPT} SHA-512-crypt ($6$)', 'cleartext'), else '{<scheme>}'.
 * Never wraps the internal ids CRYPT-SHA512/CRYPT-SHA256 in braces: those
 * values are stored as {CRYPT}$6$…/$5$….
 */
export function storedSchemeText(scheme: string, label?: string): string {
  if (label) return label;
  if (scheme === 'CLEARTEXT') return 'cleartext';
  if (scheme === 'CRYPT-SHA512') return '{CRYPT} SHA-512-crypt ($6$)';
  if (scheme === 'CRYPT-SHA256') return '{CRYPT} SHA-256-crypt ($5$)';
  return `{${scheme}}`;
}

/**
 * One-line summary of a password change result; with name it says whose
 * password ("Password reset for ux-p-user1 (stored as …, account stays
 * disabled)").
 */
export function resultSummary(res: PasswordChangeResult, name?: string): string {
  const parts: string[] = [];
  if (res.storedScheme) parts.push(res.storedScheme === 'CLEARTEXT' ? 'stored in cleartext' : `stored as ${storedSchemeText(res.storedScheme, res.storedSchemeLabel)}`);
  if (res.operations.some((op) => /pwdLastSet=0|pwdReset=TRUE/.test(op))) {
    parts.push(res.mustChangeIgnored ? 'pwdLastSet=0 not enforced: password never expires' : 'must change at next logon');
  }
  const keptDisabled = res.operations.some((op) => op.startsWith('account kept disabled'));
  const enabled = res.operations.some((op) => op.startsWith('account enabled'));
  if (!keptDisabled && !enabled && res.operations.some((op) => /lockoutTime=0|delete pwdAccountLockedTime|lockout cleared/.test(op))) parts.push('account unlocked');
  if (enabled) parts.push('account enabled');
  if (keptDisabled) parts.push('account stays disabled');
  if (res.verified) parts.push('verified by bind');
  else if (res.unconfirmed) parts.push('scheme support not confirmed');
  const head = name ? `Password reset for ${name}` : 'Password reset';
  return parts.length > 0 ? `${head} (${parts.join(', ')})` : head;
}

// --- Remembered choice per connection profile (localStorage) ---

const STORAGE_PREFIX = 'ldapilot.password.method.';
const METHODS: PasswordMethod[] = ['unicodePwd', 'exop', 'userPassword'];

/** Parses a stored selection; null when absent or malformed. */
export function parseSelection(raw: string | null): PasswordSelection | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!METHODS.includes(v?.method) || typeof v?.scheme !== 'string') return null;
    return { method: v.method, scheme: v.scheme, verifyBind: v.verifyBind === true };
  } catch {
    return null;
  }
}

export function loadRememberedSelection(profileId: string): PasswordSelection | null {
  try {
    return parseSelection(localStorage.getItem(STORAGE_PREFIX + profileId));
  } catch {
    return null;
  }
}

export function saveRememberedSelection(profileId: string, sel: PasswordSelection): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + profileId, JSON.stringify(sel));
  } catch {
    // storage unavailable: the choice is simply not remembered
  }
}
