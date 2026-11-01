/**
 * Wails wrappers for the authentication / TLS trust methods of
 * ConnectionService (Go services/auth_connection.go) and its newer profile
 * methods (selective export, the full import report).
 */
import { getBinding } from './wails';
import type { ConnectionExportResult, ConnectionImportReport, ConnectionProfile } from '../types/ldap';
import type { AuthEnvironment, CertificateInfo, CertificateProblem, ConnectionTestResult } from '../types/auth';

const svc = () => getBinding('ConnectionService');

/** Connects with the profile, binds, disconnects and reports details. Never rejects for connection failures. */
export async function TestConnectionDetailed(profile: ConnectionProfile): Promise<ConnectionTestResult> {
  const s = svc();
  if (s?.TestConnectionDetailed) return s.TestConnectionDetailed(profile);
  return {
    success: false,
    error: 'Not running under Wails - cannot test connection',
    authMethod: profile.authMethod,
    tlsMode: profile.tlsMode,
    durationMs: 0,
  };
}

/** Untrusted certificate that made the last Connect/Reconnect of the profile fail, or null. */
export async function GetCertificateProblem(profileID: string): Promise<CertificateProblem | null> {
  const s = svc();
  if (s?.GetCertificateProblem) return (await s.GetCertificateProblem(profileID)) ?? null;
  return null;
}

/** Pins the certificate fingerprint in the saved profile; returns the updated (masked) profile. */
export async function TrustCertificate(profileID: string, fingerprint: string): Promise<ConnectionProfile> {
  const s = svc();
  if (s?.TrustCertificate) return s.TrustCertificate(profileID, fingerprint);
  throw new Error('Not running under Wails');
}

/** Pins the certificate and removes the profile's other pins (the pinned certificate changed). */
export async function ReplacePinnedCertificates(profileID: string, fingerprint: string): Promise<ConnectionProfile> {
  const s = svc();
  if (s?.ReplacePinnedCertificates) return s.ReplacePinnedCertificates(profileID, fingerprint);
  return TrustCertificate(profileID, fingerprint);
}

export async function GetAuthEnvironment(): Promise<AuthEnvironment | null> {
  const s = svc();
  if (s?.GetAuthEnvironment) return s.GetAuthEnvironment();
  return null;
}

/** Parses CA certificates from a file path and/or pasted PEM. Rejects with a readable message. */
export async function DescribeCACertificates(file: string, pem: string): Promise<CertificateInfo[]> {
  const s = svc();
  if (s?.DescribeCACertificates) return (await s.DescribeCACertificates(file, pem)) ?? [];
  return [];
}

/** Opens a native file dialog; kind: 'ca' | 'cert' | 'key' | 'ccache'. Resolves '' when cancelled. */
export async function BrowseCertificateFile(kind: 'ca' | 'cert' | 'key' | 'ccache'): Promise<string> {
  const s = svc();
  if (s?.BrowseCertificateFile) return s.BrowseCertificateFile(kind);
  return '';
}

/**
 * The server's own DNS name (RootDSE dnsHostName, read anonymously over the
 * profile's host, port and TLS mode) for the Kerberos SPN suggestion.
 * Rejects with a readable message (no dnsHostName, unreachable, ...).
 */
export async function DetectServerHostName(profile: ConnectionProfile): Promise<string> {
  const s = svc();
  if (s?.DetectServerHostName) return s.DetectServerHostName(profile);
  throw new Error('Not running under Wails');
}

/** The certificate chain the server presents over the profile's TLS mode (leaf first), read without a bind; rejects with a readable message. */
export async function GetServerCertificates(profile: ConnectionProfile): Promise<CertificateInfo[]> {
  const s = svc();
  if (s?.GetServerCertificates) return (await s.GetServerCertificates(profile)) ?? [];
  throw new Error('Not running under Wails');
}

/** Exports the chosen profiles (no secrets) through the save dialog; `path` '' = cancelled. */
export async function ExportSelectedConnections(ids: string[]): Promise<ConnectionExportResult> {
  const s = svc();
  if (s?.ExportSelectedConnections) return (await s.ExportSelectedConnections(ids)) ?? { path: '', count: 0 };
  throw new Error('Not running under Wails');
}

/** ImportConnections with every list of the report (incl. askPassword); lists never null. */
export async function ImportConnectionsDetailed(): Promise<ConnectionImportReport> {
  const s = svc();
  if (!s?.ImportConnections) return { cancelled: true, path: '', total: 0, imported: [], duplicates: [], skipped: [], needPassword: [], askPassword: [] };
  const r = ((await s.ImportConnections()) ?? {}) as Partial<ConnectionImportReport>;
  return {
    cancelled: !!r.cancelled,
    path: r.path ?? '',
    total: r.total ?? 0,
    imported: r.imported ?? [],
    duplicates: r.duplicates ?? [],
    skipped: r.skipped ?? [],
    needPassword: r.needPassword ?? [],
    askPassword: r.askPassword ?? [],
  };
}

/** Error text prefix of Go ldap.CertificateError. */
export const CERTIFICATE_ERROR_MARKER = 'untrusted TLS certificate';

/** True if a rejected Connect/Reconnect failed because the server certificate is not trusted. */
export function isCertificateError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return msg.includes(CERTIFICATE_ERROR_MARKER);
}
