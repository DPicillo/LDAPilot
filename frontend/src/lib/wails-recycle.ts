/**
 * Wails wrappers for deleted objects (AD tombstones / Recycle Bin), restore
 * and subtree delete. Reads live on BrowserService, writes on EditorService
 * (read-only enforced and audited in Go).
 */
import { getBinding } from './wails';
import type { LDAPEntry } from '../types/ldap';
import type {
  RecycleBinInfo, DeletedObjectsList, RestoreRequest, RestoreResult,
  DescendantCount, SubtreeDeleteOptions, SubtreeDeleteResult, SubtreeDeleteProgress,
  BatchMoveResult, EntryCheck, PosixIDs,
} from '../types/recycle';

/** Wails event carrying SubtreeDeleteProgress (services.SubtreeDeleteProgressEvent). */
export const SUBTREE_DELETE_PROGRESS_EVENT = 'recycle:delete-progress';

function notAvailable(): never {
  throw new Error('Not available outside the LDAPilot app');
}

// --- BrowserService (reads) ---

export async function GetRecycleBinInfo(profileID: string): Promise<RecycleBinInfo> {
  const svc = getBinding('BrowserService');
  if (svc?.GetRecycleBinInfo) return svc.GetRecycleBinInfo(profileID);
  return notAvailable();
}

/** namingContext '' = default naming context; sizeLimit <= 0 = server default (5000). */
export async function ListDeletedObjects(profileID: string, namingContext: string, filter: string, sizeLimit = 0): Promise<DeletedObjectsList> {
  const svc = getBinding('BrowserService');
  if (svc?.ListDeletedObjects) return svc.ListDeletedObjects(profileID, namingContext, filter, sizeLimit);
  return notAvailable();
}

export async function GetDeletedObjectEntry(profileID: string, dn: string): Promise<LDAPEntry> {
  const svc = getBinding('BrowserService');
  if (svc?.GetDeletedObjectEntry) return svc.GetDeletedObjectEntry(profileID, dn);
  return notAvailable();
}

export async function CountDescendants(profileID: string, dn: string): Promise<DescendantCount> {
  const svc = getBinding('BrowserService');
  if (svc?.CountDescendants) return svc.CountDescendants(profileID, dn);
  return notAvailable();
}

// --- Lifecycle helpers (create / copy / move / restore targets) ---
// Background reads of the lifecycle dialogs: not written to the operation log.

/** Existence of every DN (at most 200); [] outside the app. */
export async function EntriesExist(profileID: string, dns: string[]): Promise<EntryCheck[]> {
  const svc = getBinding('BrowserService');
  if (svc?.EntriesExist) return svc.EntriesExist(profileID, dns);
  return [];
}

/**
 * Up to 5 DNs of entries whose `attr` (uid, sAMAccountName,
 * userPrincipalName, mail, cn, uidNumber, gidNumber) equals `value`
 * (duplicate check); [] outside the app.
 */
export async function LoginNameHolders(profileID: string, attr: string, value: string): Promise<string[]> {
  const svc = getBinding('BrowserService');
  if (svc?.LoginNameHolders) return (await svc.LoginNameHolders(profileID, attr, value)) ?? [];
  return [];
}

/** Next free uidNumber / gidNumber and the most used primary gidNumber; null outside the app. */
export async function NextPosixIDs(profileID: string): Promise<PosixIDs | null> {
  const svc = getBinding('BrowserService');
  if (svc?.NextPosixIDs) return svc.NextPosixIDs(profileID);
  return null;
}

/** UPN suffixes of an AD forest (connection's domain first); [] for other servers. */
export async function UPNSuffixes(profileID: string): Promise<string[]> {
  const svc = getBinding('BrowserService');
  if (svc?.UPNSuffixes) return (await svc.UPNSuffixes(profileID)) ?? [];
  return [];
}

/**
 * Moves the entries below newParentDN (BatchService.BatchMove, audited).
 * Refused before anything runs when the target does not exist or is one of
 * the entries (or below one): `refused` with the reason in `errors`.
 */
export async function BatchMove(profileID: string, dns: string[], newParentDN: string): Promise<BatchMoveResult> {
  const svc = getBinding('BatchService');
  if (svc?.BatchMove) return svc.BatchMove(profileID, dns, newParentDN);
  return notAvailable();
}

// --- EditorService (writes) ---

export async function RestoreDeletedObjects(profileID: string, requests: RestoreRequest[]): Promise<RestoreResult[]> {
  const svc = getBinding('EditorService');
  if (svc?.RestoreDeletedObjects) return svc.RestoreDeletedObjects(profileID, requests);
  return notAvailable();
}

export async function DeleteSubtree(profileID: string, dn: string, options: SubtreeDeleteOptions): Promise<SubtreeDeleteResult> {
  const svc = getBinding('EditorService');
  if (svc?.DeleteSubtree) return svc.DeleteSubtree(profileID, dn, options);
  return notAvailable();
}

export async function CancelSubtreeDelete(operationID: string): Promise<boolean> {
  const svc = getBinding('EditorService');
  if (svc?.CancelSubtreeDelete) return svc.CancelSubtreeDelete(operationID);
  return false;
}

/** Subscribes to subtree delete progress; returns the unsubscribe function. */
export function onSubtreeDeleteProgress(callback: (p: SubtreeDeleteProgress) => void): () => void {
  const runtime = (window as any)['runtime'];
  if (!runtime?.EventsOn) return () => {};
  const cancel = runtime.EventsOn(SUBTREE_DELETE_PROGRESS_EVENT, callback);
  return typeof cancel === 'function' ? cancel : () => runtime.EventsOff?.(SUBTREE_DELETE_PROGRESS_EVENT);
}
