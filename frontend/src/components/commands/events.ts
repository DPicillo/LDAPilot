/**
 * Cross-batch window events (TRIAGE §0.1) the command layer emits or listens
 * to. Plain DOM CustomEvents with fixed names and detail shapes, so other
 * modules listen without importing this one.
 */

export const ACCOUNT_CHANGED = 'ldapilot:account-changed'
export const AUDIT_FILTER = 'ldapilot:audit-filter'
export const EXPORT_REQUEST = 'ldapilot:export-request'

export interface AccountChangedDetail {
  profileId: string
  dn: string
}
export interface AuditFilterDetail {
  profileId: string
  dn: string
}
export interface ExportRequestDetail {
  profileId: string
  dns: string[]
}

function emit<T>(name: string, detail: T) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<T>(name, { detail }))
}

// ldapilot:account-changed is emitted by lib/wails-account.ts emitAccountChanged
// (it also updates accountStatusCache and the command titles).

/** Show History: the Audit Log filtered to dn (BottomPanel). */
export function emitAuditFilter(profileId: string, dn: string) {
  emit<AuditFilterDetail>(AUDIT_FILTER, { profileId, dn })
}

/** Export of 2+ entries: the Export dialog with options (BulkDialogHost). */
export function emitExportRequest(profileId: string, dns: string[]) {
  emit<ExportRequestDetail>(EXPORT_REQUEST, { profileId, dns })
}

/** Listens to ldapilot:account-changed; returns the disposer. */
export function onAccountChanged(fn: (d: AccountChangedDetail) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const h = (e: Event) => {
    const d = (e as CustomEvent<AccountChangedDetail>).detail
    if (d && typeof d.profileId === 'string' && typeof d.dn === 'string') fn(d)
  }
  window.addEventListener(ACCOUNT_CHANGED, h)
  return () => window.removeEventListener(ACCOUNT_CHANGED, h)
}
