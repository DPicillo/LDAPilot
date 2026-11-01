/**
 * Wails wrappers of the cancellable object statistics (DEF-23, Go
 * services/browser_service.go GetStatisticsRun / CancelStatistics).
 */
import { getBinding, type ObjectStats } from './wails';

/**
 * Counts the objects below baseDN by type; `requestId` names the call for
 * CancelStatistics. Rejects with "search cancelled" when stopped. Falls back
 * to the non-cancellable GetStatistics of an older backend.
 */
export async function GetStatisticsRun(profileID: string, baseDN: string, requestId: string): Promise<ObjectStats | null> {
  const svc = getBinding('BrowserService');
  if (svc?.GetStatisticsRun) return (await svc.GetStatisticsRun(profileID, baseDN, requestId)) ?? null;
  if (svc?.GetStatistics) return (await svc.GetStatistics(profileID, baseDN)) ?? null;
  return null;
}

/** Stops the count with this request ID (also one that has not started yet); number stopped. */
export async function CancelStatistics(profileID: string, requestId: string): Promise<number> {
  const svc = getBinding('BrowserService');
  if (svc?.CancelStatistics) return (await svc.CancelStatistics(profileID, requestId)) ?? 0;
  return 0;
}
