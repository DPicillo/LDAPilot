/**
 * Wails wrappers of the export and audit features of the search batch:
 * ExportService.Export / SaveExportFile (Export dialog, results, logs) and
 * AuditService.GetAuditLogRange. Go: services/export_service.go,
 * services/audit_service.go.
 */
import { getBinding } from './wails'
import type { AuditEntry } from './wails'
import type { SearchScope } from '../types/ldap'

/** Go models.ExportRequest. */
export interface ExportRequest {
  format: 'ldif' | 'csv'
  /** Explicit entries (multi-selection); baseDN/scope/filter are then ignored. */
  dns?: string[]
  baseDN: string
  scope: SearchScope
  filter?: string
  /** LDIF: only these attributes (objectClass added when importable); CSV: the columns. */
  attributes?: string[]
  /** LDIF without server-maintained attributes, so it can be imported again. */
  importable?: boolean
}

/** Go models.ExportResult. */
export interface ExportResult {
  content: string
  count: number
  truncated?: boolean
}

function service(name: string, method: string): (...args: unknown[]) => Promise<any> {
  const svc = getBinding(name)
  const fn = svc?.[method]
  if (typeof fn !== 'function') throw new Error(`Not running under Wails (${name}.${method} is not available)`)
  return fn
}

/** Runs an export and returns its text (ExportService.Export). */
export function Export(profileID: string, req: ExportRequest): Promise<ExportResult> {
  return service('ExportService', 'Export')(profileID, req)
}

/** Audit entries between from and to (dates or timestamps; '' = open), newest first; limit <= 0 = all. */
export async function GetAuditLogRange(profileID: string, from: string, to: string, limit: number): Promise<AuditEntry[]> {
  return (await service('AuditService', 'GetAuditLogRange')(profileID, from, to, limit)) || []
}

const LAST_DIR_KEY = 'ldapilot-export-dir'

function lastExportDir(): string {
  try {
    return localStorage.getItem(LAST_DIR_KEY) || ''
  } catch {
    return ''
  }
}

function rememberExportDir(path: string) {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (i <= 0) return
  try {
    localStorage.setItem(LAST_DIR_KEY, path.slice(0, i))
  } catch {
    /* blocked storage */
  }
}

/**
 * Saves export text through the native "Export LDIF" / "Export CSV" dialog
 * in the last export folder (ExportService.SaveExportFile); `name` is the
 * suggested file name without extension (e.g. the RDN value). Returns the
 * path, '' when cancelled. Outside Wails the text is offered as a browser
 * download ('download').
 */
export async function SaveExportFile(name: string, format: 'ldif' | 'csv', content: string): Promise<string> {
  const svc = getBinding('ExportService')
  if (typeof svc?.SaveExportFile === 'function') {
    const path: string = (await svc.SaveExportFile(name, format, content, lastExportDir())) || ''
    if (path) rememberExportDir(path)
    return path
  }
  const blob = new Blob([content], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${name || 'export'}.${format}`
  link.click()
  URL.revokeObjectURL(url)
  return 'download'
}

/** "24 entries saved to /home/me/x.ldif" (the success toast of an export). */
export function savedMessage(count: number, path: string): string {
  return `${count} ${count === 1 ? 'entry' : 'entries'} saved to ${path}`
}
