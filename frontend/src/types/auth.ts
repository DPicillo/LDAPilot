/**
 * Authentication & TLS trust types - mirror Go internal/models/auth.go.
 */
import type { AuthMethod, TLSMode } from './ldap';

/** How the server certificate was verified (Go models.TLSVerify*). */
export type TLSVerification = 'system' | 'custom-ca' | 'pinned' | 'skipped';

/** Primary certificate problem (Go models.CertProblem*). */
export type CertProblemKind = 'unknown-authority' | 'hostname-mismatch' | 'expired' | 'not-yet-valid' | 'invalid';

/** One X.509 certificate presented by a server - mirrors Go CertificateInfo. */
export interface CertificateInfo {
  subject: string;
  issuer: string;
  serialNumber: string;
  dnsNames: string[] | null;
  ipAddresses: string[] | null;
  /** RFC 3339 (UTC). */
  notBefore: string;
  notAfter: string;
  isCA: boolean;
  selfSigned: boolean;
  keyAlgorithm: string;
  signatureAlgorithm: string;
  /** SHA-256 fingerprint, uppercase hex pairs separated by colons. */
  sha256: string;
  pem: string;
}

/** Why a server certificate was not trusted - mirrors Go CertificateProblem. */
export interface CertificateProblem {
  host: string;
  kind: CertProblemKind;
  reason: string;
  issues: string[] | null;
  /** Chain as sent by the server, leaf first. */
  chain: CertificateInfo[] | null;
  /** The profile trusts pinned certificates and the server presents another one (not a first contact). */
  pinnedChanged?: boolean;
  /** The pins trusted until now. */
  previousPins?: PinnedCertificate[];
}

/** A pinned server certificate - mirrors Go PinnedCertificate. */
export interface PinnedCertificate {
  fingerprint: string;
  /** RFC 3339 (UTC); missing for pins stored before the date was recorded. */
  pinnedAt?: string;
  /** What the pinned certificate is, when the profile recorded it (tlsPinnedInfo). */
  subject?: string;
  issuer?: string;
  notAfter?: string;
}

/** Subject, issuer and validity of a pinned certificate - mirrors Go PinnedCertificateInfo. */
export interface PinnedCertificateInfo {
  subject: string;
  issuer?: string;
  /** RFC 3339 (UTC). */
  notBefore?: string;
  notAfter?: string;
}

/** Result of ConnectionService.TestConnectionDetailed - mirrors Go ConnectionTestResult. */
export interface ConnectionTestResult {
  success: boolean;
  error?: string;
  stage?: 'config' | 'connect' | 'tls' | 'bind';
  authMethod: AuthMethod;
  authSummary?: string;
  boundAs?: string;
  tlsMode: TLSMode;
  tlsVersion?: string;
  tlsCipherSuite?: string;
  tlsVerification?: TLSVerification;
  serverCertificates?: CertificateInfo[];
  certProblem?: CertificateProblem;
  warnings?: string[];
  durationMs: number;
  /** RootDSE after the bind: detected server type (Go ServerType*), vendor and naming contexts. */
  serverType?: 'ad' | 'openldap' | '389ds' | 'other';
  vendorName?: string;
  vendorVersion?: string;
  namingContexts?: string[];
  defaultNamingContext?: string;
  /** The server's own DNS name (RootDSE dnsHostName, AD/Samba): after the bind, or read anonymously when a Kerberos bind failed. */
  dnsHostName?: string;
}

/** Local Kerberos environment - mirrors Go AuthEnvironment. */
export interface AuthEnvironment {
  os: string;
  sspiAvailable: boolean;
  krb5Config: string;
  krb5ConfigFound: boolean;
  /** Default credential cache: its file, or its name (e.g. "KCM:") when unsupported. */
  defaultCCache: string;
  /** Where the default comes from: "from KRB5CCNAME", "from /etc/krb5.conf", "system default", ... */
  defaultCCacheSource?: string;
  ccacheSupported: boolean;
}
