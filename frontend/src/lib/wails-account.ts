/**
 * Wails wrappers for the account feature (BrowserService / EditorService
 * account methods, see services/account_service.go).
 */
import { getBinding } from './wails';
import type { AccountReportParams, AccountReportResult, AccountStatus, ReportAvailability } from '../types/account';
import { forgetAccountStatus, rememberAccountStatus } from '../stores/accountStatusCache';
import { notifyCommandsChanged } from '../components/ui/commands';
import { normalizeDN } from './dn';
import { createSharedReader } from './sharedRead';

/** Window event after every successful account or password action (TRIAGE §0.1). */
export const ACCOUNT_CHANGED_EVENT = 'ldapilot:account-changed';

export interface AccountChangedDetail {
  profileId: string;
  dn: string;
  /** The status read after the action, when the emitter has it: listeners use it instead of reading again (RW1-P-06). */
  status?: AccountStatus;
}

/**
 * Announces a successful account/password action on dn: the cached server
 * status is replaced (status given) or dropped, command titles are
 * recomputed, and every view listening to `ldapilot:account-changed` (tree
 * overlay, result and report rows, open editor tabs) refreshes — with the
 * fresh status in the detail, or through one shared read
 * (`readAccountStatusShared`).
 */
export function emitAccountChanged(profileId: string, dn: string, status?: AccountStatus | null): void {
  const k = sharedKey(profileId, dn);
  if (status?.dn) {
    rememberAccountStatus(profileId, status);
    sharedReads.seed(k, status);
  } else {
    forgetAccountStatus(profileId, dn);
    // A read that started before the action would bring the old state.
    sharedReads.forget(k);
  }
  notifyCommandsChanged();
  if (typeof window !== 'undefined') {
    const detail: AccountChangedDetail = status?.dn ? { profileId, dn, status } : { profileId, dn };
    window.dispatchEvent(new CustomEvent<AccountChangedDetail>(ACCOUNT_CHANGED_EVENT, { detail }));
  }
}

// --- One read per account change (RW1-P-06) ----------------------------------------

const sharedKey = (profileId: string, dn: string) => `${profileId}\n${normalizeDN(dn)}`;
const sharedReads = createSharedReader<AccountStatus | null>((k) => {
  const i = k.indexOf('\n');
  return GetAccountStatus(k.slice(0, i), sharedDNs.get(k) ?? k.slice(i + 1));
});
/** The DN as the caller spelled it (the key is normalized). */
const sharedDNs = new Map<string, string>();

/**
 * GetAccountStatus coalesced per (profile, DN): a read started (or answered)
 * less than `maxAgeMs` (default 1.5 s) ago is shared, so the editor tab, its
 * Account tab, the tree overlay and the menus that react to one account
 * action read the entry (and its policy) once instead of four times.
 * `maxAgeMs: 0` always starts a new read (after a write) that the others
 * then share. Failed reads are not shared.
 */
export function readAccountStatusShared(profileId: string, dn: string, maxAgeMs?: number): Promise<AccountStatus | null> {
  const k = sharedKey(profileId, dn);
  sharedDNs.set(k, dn);
  if (sharedDNs.size > 200) sharedDNs.delete(sharedDNs.keys().next().value!);
  return sharedReads.read(k, maxAgeMs);
}

/**
 * A status the app just received some other way (an account report row):
 * shared like a finished read, so an action started from that row does not
 * read it again (RW1-P-06).
 */
export function seedAccountStatus(profileId: string, status: AccountStatus | null | undefined): void {
  if (!status?.dn) return;
  const k = sharedKey(profileId, status.dn);
  sharedDNs.set(k, status.dn);
  sharedReads.seed(k, status);
}

/** Subscribes to `ldapilot:account-changed`; returns the unsubscribe function. */
export function onAccountChanged(handler: (detail: AccountChangedDetail) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: Event) => {
    const d = (e as CustomEvent<AccountChangedDetail>).detail;
    if (d?.profileId && d.dn) handler(d);
  };
  window.addEventListener(ACCOUNT_CHANGED_EVENT, listener);
  return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, listener);
}

function requireMethod(service: string, method: string): (...args: any[]) => Promise<any> {
  const svc = getBinding(service);
  if (svc?.[method]) return svc[method];
  throw new Error('Not running under Wails - account actions are unavailable');
}

/** Normalized account status of dn; applicable=false for non-accounts. Null outside Wails. */
export async function GetAccountStatus(profileID: string, dn: string): Promise<AccountStatus | null> {
  const svc = getBinding('BrowserService');
  if (svc?.GetAccountStatus) return svc.GetAccountStatus(profileID, dn);
  return null;
}

/** Runs a backend report (locked / disabled / passwordExpiring / passwordExpired / neverLoggedOn / emptyGroups / privilegedMembers). */
export async function RunAccountReport(profileID: string, params: AccountReportParams): Promise<AccountReportResult> {
  return requireMethod('BrowserService', 'RunAccountReport')(profileID, params);
}

/** Server type and the backend reports that cannot run on this server (with the reason). Null outside Wails. */
export async function GetReportAvailability(profileID: string, baseDN: string): Promise<ReportAvailability | null> {
  const svc = getBinding('BrowserService');
  if (svc?.GetReportAvailability) return svc.GetReportAvailability(profileID, baseDN);
  return null;
}

export async function UnlockAccount(profileID: string, dn: string): Promise<void> {
  return requireMethod('EditorService', 'UnlockAccount')(profileID, dn);
}

export async function SetAccountEnabled(profileID: string, dn: string, enabled: boolean): Promise<void> {
  return requireMethod('EditorService', 'SetAccountEnabled')(profileID, dn, enabled);
}

export async function SetMustChangePassword(profileID: string, dn: string, mustChange: boolean): Promise<void> {
  return requireMethod('EditorService', 'SetMustChangePassword')(profileID, dn, mustChange);
}

export async function SetPasswordNeverExpires(profileID: string, dn: string, neverExpires: boolean): Promise<void> {
  return requireMethod('EditorService', 'SetPasswordNeverExpires')(profileID, dn, neverExpires);
}

/** expires: RFC 3339 time, or '' to remove the expiration. */
export async function SetAccountExpiration(profileID: string, dn: string, expires: string): Promise<void> {
  return requireMethod('EditorService', 'SetAccountExpiration')(profileID, dn, expires);
}

/** Replaces userAccountControl; fails when the server value differs from expected. */
export async function SetUserAccountControl(profileID: string, dn: string, expected: number, value: number): Promise<void> {
  return requireMethod('EditorService', 'SetUserAccountControl')(profileID, dn, expected, value);
}

/** Message of an error thrown by a Wails call (Go errors arrive as strings). */
export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

/**
 * Whether err is the backend's ErrAccountConflict: the account changed on
 * the server since its status was read (e.g. userAccountControl).
 */
export function isAccountConflict(err: unknown): boolean {
  return errorMessage(err, '').includes('changed on the server in the meantime');
}
