/**
 * Wails wrappers of the bulk operations (batch modify with templates and
 * LDIF change files). Go: services/bulk_batch.go, services/bulk_ldif.go,
 * services/bulk_runs.go.
 */
import { getBinding } from './wails'
import type { AttributeChange } from '../types/ldap'
import type { BulkApplyResult, BulkOptions, BulkPreview, BulkProgress, LDIFFile, LDIFPreview } from '../types/bulk'
import { BULK_PROGRESS_EVENT } from '../types/bulk'

function notAvailable(): never {
  throw new Error('Not running under Wails - bulk operations are not available')
}

/** Dry run of a batch modify (BatchService.BatchPreview). */
export async function BatchPreview(profileID: string, dns: string[], changes: AttributeChange[], options: BulkOptions): Promise<BulkPreview> {
  const svc = getBinding('BatchService');
  if (svc?.BatchPreview) return svc.BatchPreview(profileID, dns, changes, options);
  notAvailable();
}

/** Applies a batch modify (BatchService.BatchApply). */
export async function BatchApply(profileID: string, dns: string[], changes: AttributeChange[], options: BulkOptions): Promise<BulkApplyResult> {
  const svc = getBinding('BatchService');
  if (svc?.BatchApply) return svc.BatchApply(profileID, dns, changes, options);
  notAvailable();
}

/** Stops a running bulk preview or apply (BatchService.StopBulkRun). */
export async function StopBulkRun(runID: string): Promise<boolean> {
  const svc = getBinding('BatchService');
  if (svc?.StopBulkRun) return svc.StopBulkRun(runID);
  return false;
}

/** Dry run of an LDIF change file (ExportService.PreviewLDIFChanges). */
export async function PreviewLDIFChanges(profileID: string, content: string, options: BulkOptions): Promise<LDIFPreview> {
  const svc = getBinding('ExportService');
  if (svc?.PreviewLDIFChanges) return svc.PreviewLDIFChanges(profileID, content, options);
  notAvailable();
}

/** Applies an LDIF change file (ExportService.ApplyLDIFChanges). */
export async function ApplyLDIFChanges(profileID: string, content: string, options: BulkOptions): Promise<BulkApplyResult> {
  const svc = getBinding('ExportService');
  if (svc?.ApplyLDIFChanges) return svc.ApplyLDIFChanges(profileID, content, options);
  notAvailable();
}

/** Opens an LDIF file through the native dialog; null when cancelled (ExportService.OpenLDIFFile). */
export async function OpenLDIFFile(): Promise<LDIFFile | null> {
  const svc = getBinding('ExportService');
  if (svc?.OpenLDIFFile) return svc.OpenLDIFFile();
  return null;
}

/**
 * Saves a report through the native save dialog (ExportService.SaveReportFile).
 * Returns the written path, '' when cancelled. Outside Wails the content is
 * offered as a browser download and 'download' is returned.
 */
export async function SaveReportFile(defaultFilename: string, content: string): Promise<string> {
  const svc = getBinding('ExportService');
  if (svc?.SaveReportFile) return svc.SaveReportFile(defaultFilename, content);
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = defaultFilename;
  link.click();
  URL.revokeObjectURL(url);
  return 'download';
}

/**
 * Subscribes to "bulk:progress" events of one run. Returns the unsubscribe
 * function (a no-op outside Wails).
 */
export function onBulkProgress(runId: string, handler: (p: BulkProgress) => void): () => void {
  const runtime = (window as any)['runtime'];
  if (!runtime?.EventsOn) return () => {};
  const cancel = runtime.EventsOn(BULK_PROGRESS_EVENT, (p: BulkProgress) => {
    if (p && p.runId === runId) handler(p);
  });
  return typeof cancel === 'function' ? cancel : () => {};
}

/** A fresh run ID for BulkOptions.runId. */
export function newRunId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}
