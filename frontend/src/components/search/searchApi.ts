/**
 * SearchService bindings of the results tabs (lib/wails.ts keeps the
 * panel's search): SearchRun / CancelSearchRun (a tab's re-run, cancelled
 * without touching the panel's search on the same connection) and
 * ReadEntries (a list of DNs as rows: "Open in List").
 */
import { getBinding } from '../../lib/wails'
import type { LDAPEntry, SearchParams, SearchResult } from '../../types/ldap'

function notAvailable(): never {
  throw new Error('Not available outside the LDAPilot app')
}

/** SearchService.SearchRun: a search CancelSearchRun(runId) stops. */
export async function SearchRun(profileID: string, runId: string, params: SearchParams): Promise<SearchResult> {
  const svc = getBinding('SearchService')
  if (svc?.SearchRun) return svc.SearchRun(profileID, runId, params)
  if (svc?.Search) return svc.Search(profileID, params)
  return notAvailable()
}

/** SearchService.CancelSearchRun; false when that run is not running. */
export async function CancelSearchRun(runId: string): Promise<boolean> {
  const svc = getBinding('SearchService')
  if (svc?.CancelSearchRun) return svc.CancelSearchRun(runId)
  return false
}

export interface ReadEntriesResult {
  entries: LDAPEntry[]
  /** DNs that do not exist (any more). */
  missing: string[]
  errors: { dn: string; message: string }[]
  truncated: boolean
}

/** SearchService.ReadEntries: one unlogged base read per DN (at most 5000). */
export async function ReadEntries(profileID: string, dns: string[], attributes: string[]): Promise<ReadEntriesResult> {
  const svc = getBinding('SearchService')
  if (!svc?.ReadEntries) return notAvailable()
  const r = (await svc.ReadEntries(profileID, dns, attributes)) as Partial<ReadEntriesResult> | null
  return { entries: r?.entries ?? [], missing: r?.missing ?? [], errors: r?.errors ?? [], truncated: !!r?.truncated }
}
