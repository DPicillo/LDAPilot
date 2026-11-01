/**
 * Pure helpers for the authentication and TLS settings of connection
 * profiles: labels, defaults that mirror the Go backend
 * (internal/ldap/auth_*.go) and form validation.
 */
import type { AuthMethod, ConnectionProfile, TLSMode } from '../types/ldap';
import type { AuthEnvironment, CertProblemKind, CertificateInfo, ConnectionTestResult, PinnedCertificateInfo, TLSVerification } from '../types/auth';
import { splitDN } from './dn.ts';

export interface AuthMethodInfo {
  value: AuthMethod;
  label: string;
  /** Short badge text for cards and lists. */
  short: string;
  description: string;
}

export const AUTH_METHODS: AuthMethodInfo[] = [
  { value: 'simple', label: 'Simple bind', short: 'Simple', description: 'Bind DN and password. The password is sent as is, so use LDAPS or StartTLS.' },
  { value: 'ntlm', label: 'NTLM (Active Directory, Samba)', short: 'NTLM', description: 'Windows account as DOMAIN\\user, user@domain, or user plus domain.' },
  { value: 'kerberos', label: 'Kerberos (GSSAPI)', short: 'Kerberos', description: 'Kerberos ticket from a user name and password, or from your current logon / ticket cache.' },
  { value: 'external', label: 'SASL EXTERNAL (client certificate)', short: 'Cert', description: 'The server derives your identity from the TLS client certificate.' },
  { value: 'none', label: 'Anonymous', short: 'Anonymous', description: 'No credentials.' },
];

export function authMethodInfo(method: AuthMethod | string | undefined): AuthMethodInfo {
  return AUTH_METHODS.find((m) => m.value === method) ?? AUTH_METHODS[0];
}

/** True for IPv4/IPv6 literals (optionally in brackets). */
export function isIPAddress(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  return h.includes(':') && /^[0-9a-fA-F:.]+$/.test(h);
}

/** Host names a Kerberos SPN cannot be derived from. */
export function needsExplicitSPN(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || isIPAddress(h) || (h !== '' && !h.includes('.'));
}

/** Default service principal for host, like Go kerberosSPN. */
export function defaultSPN(host: string): string {
  return `ldap/${host.trim().toLowerCase().replace(/^\[|\]$/g, '')}`;
}

export function effectiveSPN(p: Pick<ConnectionProfile, 'host' | 'krbSPN'>): string {
  return p.krbSPN?.trim() || defaultSPN(p.host);
}

/** DNS domain formed by the trailing DC= components of dn (lowercase), like Go dnDomain. */
export function dnDomain(dn: string): string {
  const labels: string[] = [];
  const parts = splitDN(dn).map((s) => s.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = /^dc=(.+)$/i.exec(parts[i]);
    if (!m) break;
    labels.unshift(m[1].toLowerCase());
  }
  return labels.join('.');
}

/** User part and realm part of a Kerberos user name ("DOMAIN\user", "user@realm", "user"). */
export function splitKerberosUser(name: string): { user: string; realm: string } {
  let n = name.trim();
  const bs = n.lastIndexOf('\\');
  if (bs >= 0) n = n.slice(bs + 1);
  const at = n.lastIndexOf('@');
  if (at >= 0) return { user: n.slice(0, at), realm: n.slice(at + 1) };
  return { user: n, realm: '' };
}

/** Realm used when the realm field is empty, like Go kerberosRealm. */
export function derivedRealm(p: Pick<ConnectionProfile, 'bindDN' | 'baseDN'>): string {
  const { realm } = splitKerberosUser(p.bindDN);
  if (realm) return realm.toUpperCase();
  return dnDomain(p.baseDN).toUpperCase();
}

/**
 * Realm used for a password login, like Go kerberosRealm: always uppercase,
 * since realms are case-sensitive and AD/Samba realms are the DNS domain in
 * uppercase (a KDC rejects "ad.example.com" with "CRealm ... does not match").
 */
export function effectiveRealm(p: Pick<ConnectionProfile, 'bindDN' | 'baseDN' | 'krbRealm'>): string {
  return p.krbRealm?.trim().toUpperCase() || derivedRealm(p);
}

/**
 * Domain an NTLM user name carries itself ("DOMAIN\\user" → DOMAIN,
 * "user@ad.example.com" → ad.example.com), or '' for a bare user name; the
 * dialog's Domain field shows it (disabled) instead of a stale value.
 */
export function ntlmDomainFromUser(username: string): string {
  const u = username.trim();
  const bs = u.indexOf('\\');
  if (bs >= 0) return u.slice(0, bs);
  const at = u.lastIndexOf('@');
  if (at >= 0) return u.slice(at + 1);
  return '';
}

/** NTLM account as sent to the server, like Go ntlmCredentials. */
export function ntlmAccount(username: string, domain = ''): string {
  const u = username.trim();
  const d = domain.trim();
  if (!u || u.includes('\\') || u.includes('@') || !d) return u;
  return `${d}\\${u}`;
}

/** host or host:port (port 1-65535), [v6]:port, or a bare IPv6 address. */
export function isValidKDC(kdc: string): boolean {
  const k = kdc.trim();
  if (!k || /[\s/]/.test(k)) return false;
  const v6 = /^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(k);
  if (v6) return v6[2] === undefined || validPort(v6[2]);
  if (isIPAddress(k)) return true;
  const idx = k.lastIndexOf(':');
  if (idx < 0) return true;
  return idx > 0 && validPort(k.slice(idx + 1));
}

function validPort(s: string): boolean {
  if (!/^\d+$/.test(s)) return false;
  const n = Number(s);
  return n >= 1 && n <= 65535;
}

/**
 * Canonical SHA-256 fingerprint (uppercase hex pairs with colons) from any
 * common notation, or null - mirrors Go NormalizeFingerprint.
 */
export function normalizeFingerprint(input: string): string | null {
  let s = input.trim();
  const eq = s.lastIndexOf('=');
  if (eq >= 0) s = s.slice(eq + 1);
  s = s.replace(/^(sha-?256[: ])/i, '');
  s = s.replace(/[:\s-]/g, '');
  if (!/^[0-9a-fA-F]{64}$/.test(s)) return null;
  return s.toUpperCase().match(/../g)!.join(':');
}

/** First and last bytes of a fingerprint, for compact display. */
export function shortFingerprint(fp: string): string {
  const parts = fp.split(':');
  if (parts.length <= 8) return fp;
  return `${parts.slice(0, 4).join(':')}…${parts.slice(-2).join(':')}`;
}

export type TrustMode = 'plain' | 'skip' | 'pinned' | 'custom-ca' | 'system';

/** How the server certificate of a profile is trusted. */
export function tlsTrustMode(p: ConnectionProfile): TrustMode {
  if (p.tlsMode === 'none') return 'plain';
  if (p.tlsSkipVerify) return 'skip';
  if (p.tlsPinnedCerts && p.tlsPinnedCerts.length > 0) return 'pinned';
  if (p.tlsCACertFile?.trim() || p.tlsCACertPEM?.trim()) return 'custom-ca';
  return 'system';
}

export function tlsModeLabel(mode: TLSMode): string {
  switch (mode) {
    case 'ssl': return 'LDAPS';
    case 'starttls': return 'StartTLS';
    default: return 'Plain LDAP';
  }
}

export function verificationLabel(v: TLSVerification | undefined): string {
  switch (v) {
    case 'system': return 'verified by the system trust store';
    case 'custom-ca': return 'verified by the configured CA certificate';
    case 'pinned': return 'trusted by its pinned fingerprint';
    case 'skipped': return 'NOT verified (verification disabled)';
    default: return '';
  }
}

export function stageLabel(stage: ConnectionTestResult['stage']): string {
  switch (stage) {
    case 'config': return 'Invalid settings';
    case 'connect': return 'Connection failed';
    case 'tls': return 'TLS failed';
    case 'bind': return 'Authentication failed';
    default: return 'Connection failed';
  }
}

export function certProblemTitle(kind: CertProblemKind | undefined): string {
  switch (kind) {
    case 'unknown-authority': return 'The certificate is not issued by a trusted authority';
    case 'hostname-mismatch': return 'The certificate does not match the host name';
    case 'expired': return 'The certificate has expired';
    case 'not-yet-valid': return 'The certificate is not valid yet';
    default: return 'The certificate could not be verified';
  }
}

/** YYYY-MM-DD of an RFC 3339 timestamp. */
export function formatDate(iso: string): string {
  return iso ? iso.slice(0, 10) : '';
}

export function certValidityState(cert: CertificateInfo, now = new Date()): 'valid' | 'expired' | 'not-yet-valid' {
  if (new Date(cert.notAfter) < now) return 'expired';
  if (new Date(cert.notBefore) > now) return 'not-yet-valid';
  return 'valid';
}

/** CN of a distinguished name like "CN=host,O=Org", or the whole name. */
export function commonNameOf(subject: string): string {
  const m = /(?:^|,)\s*CN=([^,]+)/i.exec(subject);
  return m ? m[1] : subject;
}

/** Human-readable lines describing a successful connection test. */
export function describeTestSuccess(r: ConnectionTestResult): string[] {
  const lines: string[] = [];
  if (r.tlsMode === 'none') {
    lines.push('Transport: plain LDAP (unencrypted)');
  } else {
    const tls = [r.tlsVersion, r.tlsCipherSuite].filter(Boolean).join(', ');
    lines.push(`Transport: ${tlsModeLabel(r.tlsMode)}${tls ? ` (${tls})` : ''}`);
    const v = verificationLabel(r.tlsVerification);
    if (v) lines.push(`Server certificate: ${v}`);
  }
  if (r.authSummary) lines.push(`Authentication: ${r.authSummary}`);
  if (r.boundAs) lines.push(`Server identifies you as: ${r.boundAs}`);
  else if (r.authMethod !== 'none') lines.push('Server identity: not reported (no "Who am I?" support)');
  lines.push(`Took ${r.durationMs} ms`);
  return lines;
}

/** Valid ranges of page size and timeout, as in Go (ldap.MaxProfilePageSize etc.; SaveConnection clamps to them). */
export const PROFILE_LIMITS = {
  timeout: { min: 1, max: 600 },
  pageSize: { min: 1, max: 5000 },
} as const;

export interface FormValidation {
  /** Blocking errors keyed by field name. */
  errors: Record<string, string>;
  /** Non-blocking security notes. */
  warnings: string[];
}

/**
 * Validates the connection dialog form. env (may be null) describes the
 * local Kerberos environment.
 */
export function validateConnectionForm(form: ConnectionProfile, env: AuthEnvironment | null): FormValidation {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];
  // "Ask for the password on every connect": none is needed to save (Test asks for one).
  const hasPassword = !!form.password || form.hasPassword || !!form.askPassword;
  const tls = form.tlsMode !== 'none';

  if (!form.name.trim()) errors.name = 'Name is required';
  if (!form.host.trim()) errors.host = 'Host is required';
  if (!(form.port >= 1 && form.port <= 65535)) errors.port = 'Port must be 1-65535';
  const { pageSize, timeout } = PROFILE_LIMITS;
  if (!(Number.isInteger(form.pageSize) && form.pageSize >= pageSize.min && form.pageSize <= pageSize.max)) {
    errors.pageSize = `Page size must be ${pageSize.min}-${pageSize.max}`;
  }
  if (!(Number.isInteger(form.timeout) && form.timeout >= timeout.min && form.timeout <= timeout.max)) {
    errors.timeout = `Timeout must be ${timeout.min}-${timeout.max} seconds`;
  }

  switch (form.authMethod) {
    case 'simple':
      if (!form.bindDN.trim()) errors.bindDN = 'Bind DN is required for simple bind';
      if (!hasPassword) errors.password = 'Password is required';
      if (!tls) warnings.push('The password is sent unencrypted. Use LDAPS or StartTLS.');
      break;
    case 'ntlm': {
      const u = form.bindDN.trim();
      if (!u) errors.bindDN = 'User name is required';
      else if (u.includes('=')) errors.bindDN = 'Enter a Windows user name (DOMAIN\\user or user@domain), not a DN';
      if (!hasPassword) errors.password = 'Password is required';
      if (u && !u.includes('\\') && !u.includes('@') && !form.ntlmDomain?.trim()) {
        warnings.push('No domain given: the server decides which domain the user belongs to.');
      }
      if (!tls) warnings.push('NTLM without TLS: LDAPilot does not negotiate NTLM signing/sealing, so the session is unprotected.');
      break;
    }
    case 'kerberos': {
      const system = form.krbCredSource === 'system';
      if (!system) {
        const u = form.bindDN.trim();
        if (!u) errors.bindDN = 'User name is required';
        else if (u.includes('=')) errors.bindDN = 'Enter a Kerberos user name (user or user@REALM), not a DN';
        if (!hasPassword) errors.password = 'Password is required';
        if (!effectiveRealm(form)) errors.krbRealm = 'Realm is required (or enter the user as user@REALM)';
      } else if (env && !env.sspiAvailable && !env.ccacheSupported && !form.krbCCache?.trim()) {
        errors.krbCCache = `The default credential cache ${describeCCache(env)} cannot be read (only FILE: caches are supported). Run "kinit -c FILE:/tmp/krb5cc_<uid>" and enter that file here.`;
      }
      if (form.krbKDC?.trim() && !isValidKDC(form.krbKDC)) errors.krbKDC = 'Use host or host:port';
      const spn = form.krbSPN?.trim();
      if (spn && !/^[^/\s]+\/[^/\s]+/.test(spn)) errors.krbSPN = 'Use service/host, e.g. ldap/dc1.example.com';
      if (!tls) warnings.push('Kerberos here authenticates only and does not add LDAP signing/sealing: traffic is unencrypted, and domain controllers requiring signing reject the bind. Use LDAPS or StartTLS.');
      break;
    }
    case 'external':
      // The client certificate is configured under TLS trust, which is only
      // shown with TLS: without TLS, report both needs on the method itself.
      if (!tls) errors.authMethod = 'SASL EXTERNAL needs LDAPS or StartTLS and a client certificate';
      else if (!form.tlsClientCertFile?.trim() || !form.tlsClientKeyFile?.trim()) {
        errors.tlsClientCertFile = 'SASL EXTERNAL needs a client certificate and key';
      }
      break;
  }

  if (tls) {
    const cert = form.tlsClientCertFile?.trim();
    const key = form.tlsClientKeyFile?.trim();
    if (!!cert !== !!key && !errors.tlsClientCertFile) {
      errors.tlsClientCertFile = 'Client certificate and key file are both required';
    }
    const badPin = (form.tlsPinnedCerts ?? []).find((fp) => normalizeFingerprint(fp) === null);
    if (badPin !== undefined) errors.tlsPinnedCerts = `Not a SHA-256 fingerprint: ${badPin}`;
    if (form.tlsSkipVerify) {
      warnings.push('Certificate verification is disabled: anyone on the network path can impersonate the server. Prefer trusting the certificate or its CA.');
    }
  }
  return { errors, warnings };
}

/**
 * Prefixes for error messages that do not name their field (the other
 * messages of validateConnectionForm, e.g. "Host is required", do).
 */
const ERROR_PREFIXES: Record<string, string> = {
  krbKDC: 'KDC',
  krbSPN: 'Service principal (SPN)',
  tlsCACertFile: 'TLS trust: CA certificate',
  tlsClientCertFile: 'TLS trust',
  tlsPinnedCerts: 'TLS trust: pinned certificates',
};

/** Fields shown in the collapsible "Advanced settings" section. */
export const ADVANCED_ERROR_FIELDS = ['pageSize', 'timeout'] as const;

/** Fields shown in the (collapsible) TLS trust section. */
export const TLS_TRUST_ERROR_FIELDS = ['tlsCACertFile', 'tlsClientCertFile', 'tlsPinnedCerts'] as const;

export function hasTLSTrustError(errors: Record<string, string>): boolean {
  return TLS_TRUST_ERROR_FIELDS.some((k) => !!errors[k]);
}

/**
 * "Field: message" lines for all errors, for a summary next to the dialog
 * buttons (some fields may be scrolled away or in a collapsed section).
 */
export function formErrorSummary(errors: Record<string, string>): string[] {
  return Object.entries(errors).map(([key, msg]) => (ERROR_PREFIXES[key] ? `${ERROR_PREFIXES[key]}: ${msg}` : msg));
}

/** Default credential cache with its source, e.g. "KCM: (from /etc/krb5.conf.d/kcm_default_ccache)". */
export function describeCCache(env: Pick<AuthEnvironment, 'defaultCCache' | 'defaultCCacheSource'>): string {
  const name = env.defaultCCache || '(KRB5CCNAME)';
  return env.defaultCCacheSource ? `${name} (${env.defaultCCacheSource})` : name;
}

/**
 * Removes settings that do not apply to the selected method / TLS mode, so
 * stale values (e.g. a pinned fingerprint of a plain connection) are not
 * saved. Fields stay untouched otherwise.
 */
export function cleanProfileForSave(form: ConnectionProfile): ConnectionProfile {
  const p: ConnectionProfile = { ...form };
  if (p.authMethod !== 'ntlm') p.ntlmDomain = '';
  if (p.authMethod !== 'kerberos') {
    p.krbCredSource = undefined;
    p.krbRealm = '';
    p.krbKDC = '';
    p.krbSPN = '';
    p.krbCCache = '';
  } else {
    if (!p.krbCredSource) p.krbCredSource = 'password';
    p.krbRealm = p.krbRealm?.trim().toUpperCase() ?? '';
  }
  if (p.tlsPinnedCerts) {
    p.tlsPinnedCerts = p.tlsPinnedCerts.map((fp) => normalizeFingerprint(fp) ?? fp);
  }
  return p;
}

/**
 * True when connecting with the profile sends a password: simple bind with a
 * DN, NTLM, Kerberos with user name and password (like Go
 * profileNeedsPassword). Only then "Ask for the password on every connect"
 * applies.
 */
export function sendsPassword(p: Pick<ConnectionProfile, 'authMethod' | 'bindDN' | 'krbCredSource'>): boolean {
  switch (p.authMethod) {
    case 'simple':
      return !!p.bindDN.trim();
    case 'ntlm':
      return true;
    case 'kerberos':
      return p.krbCredSource !== 'system';
    default:
      return false;
  }
}

/**
 * The profile as saved by the dialog: cleanProfileForSave, plus never a
 * password for a profile that asks for it on every connect (the typed one is
 * only used by Test Connection / Create and Connect), the ask option only
 * where a password is sent, and pin details only for pins that remain.
 */
export function profileForSave(form: ConnectionProfile): ConnectionProfile {
  const p = cleanProfileForSave(form);
  if (p.askPassword && !sendsPassword(p)) p.askPassword = false;
  if (p.askPassword) {
    p.password = '';
    p.hasPassword = false;
  }
  p.tlsPinnedInfo = keepPinInfo(p.tlsPinnedInfo, p.tlsPinnedCerts ?? []);
  return p;
}

// --- Pinned certificate details (DEF-04) ----------------------------------------

/** What a pin records of a presented certificate. */
export function pinInfoFromCertificate(cert: CertificateInfo): PinnedCertificateInfo {
  return { subject: cert.subject, issuer: cert.issuer, notBefore: cert.notBefore, notAfter: cert.notAfter };
}

/** The pin details of `pins` only (keys canonical); undefined when none remain. */
export function keepPinInfo(info: Record<string, PinnedCertificateInfo> | undefined, pins: readonly string[]): Record<string, PinnedCertificateInfo> | undefined {
  if (!info) return undefined;
  const canon = new Set(pins.map((fp) => normalizeFingerprint(fp) ?? fp));
  const out: Record<string, PinnedCertificateInfo> = {};
  for (const [k, v] of Object.entries(info)) {
    const fp = normalizeFingerprint(k) ?? k;
    if (canon.has(fp) && v?.subject) out[fp] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Records the details of every pinned fingerprint found among `certs`
 * (certificates a server presented: a test result's chain): returns the new
 * details map and which pins were found.
 */
export function pinInfoFromChain(
  info: Record<string, PinnedCertificateInfo> | undefined,
  pins: readonly string[],
  certs: readonly CertificateInfo[],
): { info: Record<string, PinnedCertificateInfo> | undefined; found: string[] } {
  const next: Record<string, PinnedCertificateInfo> = { ...(info ?? {}) };
  const found: string[] = [];
  for (const fp of pins) {
    const canon = normalizeFingerprint(fp) ?? fp;
    const cert = certs.find((c) => (normalizeFingerprint(c.sha256) ?? c.sha256) === canon);
    if (!cert) continue;
    next[canon] = pinInfoFromCertificate(cert);
    found.push(canon);
  }
  return { info: keepPinInfo(next, pins), found };
}

/** One line for a pin with details: "dc1.lab · issued by Lab CA · expires 2028-10-29" (expired: "expired …"). */
export function pinDetailText(info: PinnedCertificateInfo | undefined, now = new Date()): string | null {
  if (!info?.subject) return null;
  const parts = [commonNameOf(info.subject)];
  if (info.issuer && info.issuer !== info.subject) parts.push(`issued by ${commonNameOf(info.issuer)}`);
  else if (info.issuer) parts.push('self-signed');
  if (info.notAfter) parts.push(`${new Date(info.notAfter) < now ? 'expired' : 'expires'} ${formatDate(info.notAfter)}`);
  return parts.join(' · ');
}

// --- Kerberos SPN from the RootDSE (DEF-05) --------------------------------------

/**
 * The SPN to suggest for a Kerberos profile when the server announced its
 * own DNS name (RootDSE dnsHostName): `ldap/<name>`, unless the profile
 * already uses exactly that SPN. null otherwise.
 */
export function spnSuggestion(p: Pick<ConnectionProfile, 'host' | 'krbSPN'>, dnsHostName: string | undefined | null): string | null {
  const name = dnsHostName?.trim().toLowerCase();
  if (!name) return null;
  const spn = defaultSPN(name);
  return effectiveSPN(p).toLowerCase() === spn ? null : spn;
}

// --- CA certificate check (DEF-03) ------------------------------------------------

/** One line per CA certificate of a check: name, validity and what is wrong with it. */
export function caCheckLines(certs: readonly CertificateInfo[], now = new Date()): { name: string; text: string; tone: 'ok' | 'warning' | 'danger' }[] {
  return certs.map((c) => {
    const state = certValidityState(c, now);
    const name = commonNameOf(c.subject);
    if (state === 'expired') return { name, text: `expired on ${formatDate(c.notAfter)}`, tone: 'danger' as const };
    if (state === 'not-yet-valid') return { name, text: `not valid before ${formatDate(c.notBefore)}`, tone: 'danger' as const };
    return { name, text: `valid ${formatDate(c.notBefore)} – ${formatDate(c.notAfter)}${c.isCA ? '' : ' · not a CA certificate'}`, tone: c.isCA ? ('ok' as const) : ('warning' as const) };
  });
}

/** Errors that block "Test connection" (a test needs no profile name). */
export function testBlockingErrors(errors: Record<string, string>): Record<string, string> {
  const { name: _name, ...rest } = errors;
  return rest;
}

/**
 * Port after switching the TLS mode: only the well-known defaults are
 * swapped (LDAP 389 <-> 636, Global Catalog 3268 <-> 3269), custom ports are
 * kept.
 */
export function portForTLSMode(port: number, mode: TLSMode): number {
  if (mode === 'ssl' && port === 389) return 636;
  if (mode !== 'ssl' && port === 636) return 389;
  if (mode === 'ssl' && port === 3268) return 3269;
  if (mode !== 'ssl' && port === 3269) return 3268;
  return port;
}

/** The PEM certificate blocks of a text (CA certificates pasted or added from a server), trimmed. */
export function splitPEMCertificates(text: string): string[] {
  return (text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []).map((b) => b.trim());
}

/** Appends a PEM certificate to existing PEM text unless it is already there. */
export function appendPEM(existing: string | undefined, pem: string): string {
  const cur = (existing ?? '').trim();
  const add = pem.trim();
  if (!add || cur.includes(add)) return cur;
  return cur ? `${cur}\n${add}` : add;
}

/** Who a profile authenticates as, without secrets (like Go AuthSummary, minus the SPN). */
export function profileAuthLabel(p: ConnectionProfile, env?: Pick<AuthEnvironment, 'sspiAvailable'> | null): string {
  switch (p.authMethod) {
    case 'simple':
      return p.bindDN.trim() ? `Simple bind as ${p.bindDN.trim()}` : 'Simple bind';
    case 'ntlm':
      return `NTLM as ${ntlmAccount(p.bindDN, p.ntlmDomain)}`;
    case 'kerberos': {
      if (p.krbCredSource === 'system') {
        if (!env) return 'Kerberos with your current logon / ticket cache';
        return env.sspiAvailable ? 'Kerberos as the logged-on Windows user' : 'Kerberos with the ticket cache (kinit)';
      }
      const { user } = splitKerberosUser(p.bindDN);
      const realm = effectiveRealm(p);
      return `Kerberos as ${user}${realm ? `@${realm}` : ''}`;
    }
    case 'external':
      return 'SASL EXTERNAL (client certificate)';
    default:
      return 'Anonymous';
  }
}

export type SecurityTone = 'secure' | 'warning' | 'neutral';

export interface ProfileSecurity {
  /** Short auth method label, e.g. "Kerberos". */
  auth: string;
  /** Transport, e.g. "LDAPS", "StartTLS", "Plain LDAP". */
  transport: string;
  /** How the server certificate is trusted ("" for plain LDAP). */
  trust: string;
  trustMode: TrustMode;
  /**
   * secure: TLS with a verified or pinned certificate; warning: credentials
   * or the session are exposed (plain LDAP with a bind, or verification
   * disabled); neutral: anonymous plain LDAP.
   */
  tone: SecurityTone;
  /** Tooltip text. */
  title: string;
}

const TRUST_LABELS: Record<TrustMode, string> = {
  plain: '',
  skip: 'not verified',
  pinned: 'pinned',
  'custom-ca': 'custom CA',
  system: 'system trust',
};

/**
 * Auth method and transport security of a profile, for cards and status
 * displays. env (useAuthEnvironment) names the "system" Kerberos
 * credentials correctly (Windows logon vs. ticket cache).
 */
export function profileSecurity(p: ConnectionProfile, env?: Pick<AuthEnvironment, 'sspiAvailable'> | null): ProfileSecurity {
  const trustMode = tlsTrustMode(p);
  const transport = tlsModeLabel(p.tlsMode);
  let tone: SecurityTone;
  if (trustMode === 'plain') tone = p.authMethod === 'none' ? 'neutral' : 'warning';
  else tone = trustMode === 'skip' ? 'warning' : 'secure';

  const lines = [profileAuthLabel(p, env)];
  if (trustMode === 'plain') {
    lines.push(p.authMethod === 'none' ? 'Plain LDAP (unencrypted)' : 'Plain LDAP: credentials or session unprotected');
  } else {
    const how: Record<Exclude<TrustMode, 'plain'>, string> = {
      skip: 'certificate NOT verified',
      pinned: `certificate pinned (${p.tlsPinnedCerts?.length ?? 0})`,
      'custom-ca': 'certificate verified with the configured CA',
      system: 'certificate verified with the system trust store',
    };
    lines.push(`${transport}, ${how[trustMode]}`);
  }
  if (p.tlsMode !== 'none' && p.tlsClientCertFile?.trim()) lines.push('Client certificate (mutual TLS)');
  if (p.askPassword && sendsPassword(p)) lines.push('Asks for the password on every connect');

  return {
    auth: authMethodInfo(p.authMethod).short,
    transport,
    trust: TRUST_LABELS[trustMode],
    trustMode,
    tone,
    title: lines.join('\n'),
  };
}

// "password required": no password is stored and none was typed for this
// session (imported profile, wrong password forgotten) - retrying cannot help.
const CREDENTIAL_ERROR =
  /invalid credentials|result code 49\b|account (?:is )?(?:locked|disabled|expired)|password (?:has )?expired|password required|data (?:52e|530|531|532|533|701|773|775)\b/i;
/** A bind the server answered with an error (any result code but a dropped connection). */
const BIND_FAILED = /LDAP bind failed/i;
/**
 * The connection itself failed during the bind: the server (or something in
 * between) accepted the TCP connection and closed it, reset it or timed out
 * before answering. No refusal: a server that restarts, or a proxy without a
 * backend, answers like this (DEF-26 recheck: the auto-retry stopped with
 * "the server rejected the credentials").
 */
const TRANSPORT_FAILURE =
  /unable to read LDAP response packet|\bEOF\b|connection reset|broken pipe|network error|i\/o timeout|connection (?:refused|closed)|use of closed network connection|no route to host|network is unreachable/i;

/** The server refused the bind (wrong/rotated password, locked or disabled account), or no password is available. */
export function isCredentialError(text: string | undefined | null): boolean {
  if (!text) return false;
  if (CREDENTIAL_ERROR.test(text)) return true;
  return BIND_FAILED.test(text) && !TRANSPORT_FAILURE.test(text);
}

/**
 * Where "Edit…" of a failed connect opens Edit Connection: a refused bind
 * at Authentication with the bind password focused ('credentials'; not
 * 'password', which is the Password storage section — typing a password
 * into its select changed the hashing policy, RW2-C-04), a TLS problem at
 * TLS trust, anything else at the top.
 */
export function editSectionForError(text: string | undefined | null): 'credentials' | 'tls' | undefined {
  if (isCredentialError(text)) return 'credentials';
  if (text && /certificate|x509|tls handshake|untrusted/i.test(text)) return 'tls';
  return undefined;
}
