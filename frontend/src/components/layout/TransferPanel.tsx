/**
 * Import / Export activity (SPEC 7.4, UX-17). Replaces the old "Export"
 * placeholder: the LDIF import / change-file flow of the bulk feature
 * (openImportLDIF, hosted by BulkDialogHost so a running import survives
 * layout changes), the ExportDialog (hosted by DialogHost),
 * connection-profile import/export, and the recent LDIF changes from the
 * audit log.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDownUp, Download, FileInput, FileOutput, Lock, Plug, RefreshCw, Upload } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { useTreeStore } from '../../stores/treeStore'
import { useUIStore } from '../../stores/uiStore'
import { openImportLDIF, useBulkDialogStore } from '../../stores/bulkDialogStore'
import * as wails from '../../lib/wails'
import type { AuditEntry } from '../../lib/wails'
import { ExportDialog } from '../export/ExportDialog'
import { exportConnectionProfiles, importConnectionProfiles } from '../connection/connectionTransfer'
import { useDialogStore } from '../ui/Dialog'
import { PanelHeader } from '../ui/PanelHeader'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { InlineAlert } from '../ui/InlineAlert'
import { TruncatedText } from '../ui/TruncatedText'
import { Spinner } from '../ui/Spinner'
import { rdnValue } from '../ui/dnParse'
import { getExportTarget, showActivity } from './shellState'
import { deletedForGood, forwardDN } from './opTone'
import { RecentLDIFChanges } from '../export/RecentLDIFChanges'
import { useRecycleStore } from '../../stores/recycleStore'
import { ensureServerType } from '../ui/commands'
import { toast } from '../ui/Toast'

const TARGET_LABEL = { tree: 'Selected in the tree', tab: 'Active tab', base: 'Base DN of the connection' } as const

/** DN the Export dialog is prefilled with (getExportTarget), re-evaluated on store changes. */
function useExportTarget(): { dn: string; source: string } {
  const selected = useTreeStore((s) => s.selectedNodes)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const profileId = useConnectionStore((s) => s.activeProfileId)
  return useMemo(() => {
    const t = getExportTarget()
    return { dn: t.dn, source: TARGET_LABEL[t.source] }
  }, [selected, activeTabId, profileId])
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="px-3 py-3 border-b border-border">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{title}</h3>
      {children}
    </section>
  )
}

export function TransferPanel() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId)
  const connected = useConnectionStore((s) => (s.activeProfileId ? s.connectionStatuses[s.activeProfileId] === true : false))
  const profile = useConnectionStore((s) => s.profiles.find((p) => p.id === s.activeProfileId))
  const isVisible = useUIStore((s) => s.activeActivity === 'export' && s.sidebarVisible)
  const openDialogs = useDialogStore((s) => s.dialogs.length)
  const importOpen = useBulkDialogStore((s) => s.importLDIF !== null)
  const openDialog = useDialogStore((s) => s.open)
  const target = useExportTarget()

  // The audit rows: the recent LDIF changes grouped by run (DEF-18); a later RENAME / MOVE
  // leads to the entry's current DN (RW1-S-12).
  const [auditRows, setAuditRows] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(false)
  // Deleted rows say where they lead (AD: Deleted Objects).
  const [serverType, setServerType] = useState<string | null>(null)
  useEffect(() => {
    if (!activeProfileId || !connected) return
    let alive = true
    void ensureServerType(activeProfileId).then((t) => alive && setServerType(t))
    return () => {
      alive = false
    }
  }, [activeProfileId, connected])

  const loadImports = useCallback(async () => {
    if (!activeProfileId || !connected) {
      setAuditRows([])
      return
    }
    setLoading(true)
    try {
      setAuditRows((await wails.GetAuditLog(activeProfileId, 500)) || [])
    } catch {
      setAuditRows([])
    } finally {
      setLoading(false)
    }
  }, [activeProfileId, connected])

  // Refresh when the panel becomes visible and after a dialog (or the LDIF import) closes.
  useEffect(() => {
    if (isVisible && openDialogs === 0 && !importOpen) void loadImports()
  }, [isVisible, openDialogs, importOpen, loadImports])

  const openEntry = (dn: string, at = '') => {
    if (activeProfileId) useEditorStore.getState().openEntry(activeProfileId, forwardDN(auditRows, dn, at))
  }

  /** A row: its entry; a deleted one Deleted Objects (AD) or a note, never a dead tab (RW3-S-08). */
  const openRow = async (e: AuditEntry) => {
    if (!activeProfileId) return
    if (!deletedForGood(auditRows, e)) return openEntry(e.dn, e.timestamp)
    const profileId = activeProfileId
    if ((await ensureServerType(profileId)) === 'ad') useRecycleStore.getState().openDeletedObjects(profileId, '', { focusDN: e.dn })
    else toast.info(`${rdnValue(e.dn) || e.dn} was deleted by this change (${e.timestamp})`)
  }

  return (
    <div className="h-full flex flex-col bg-sidebar text-sidebar-foreground overflow-hidden">
      <PanelHeader
        title="Import / Export"
        icon={ArrowDownUp}
        actions={connected ? [{ id: 'refresh', label: 'Refresh recent imports', icon: RefreshCw, onClick: () => void loadImports() }] : []}
      />
      <div className="flex-1 min-h-0 overflow-auto">
        {!connected ? (
          <EmptyState
            icon={Plug}
            title="Not connected"
            hint="Connect to a directory to import LDIF or export entries. Connection profiles can be moved without a connection."
            action={
              <Button size="sm" leftIcon={Plug} onClick={() => showActivity('connections')}>
                Open Connections
              </Button>
            }
            className="h-auto py-8"
          />
        ) : (
          <>
            <Section title="Import">
              <p className="text-sm text-muted-foreground mb-2">
                Apply an LDIF file or pasted LDIF text to <span className="text-foreground font-medium">{profile?.name}</span>: new
                entries and change records (add, modify, delete, modrdn), checked in a dry run first.
              </p>
              {profile?.readOnly && (
                <InlineAlert tone="warning" title="Read-only connection" body="Dry runs only: a file can be checked against this directory, applying it is disabled." className="mb-2" />
              )}
              <Button variant="primary" size="sm" leftIcon={Upload} onClick={() => openImportLDIF()}>
                {profile?.readOnly ? 'Check LDIF (Dry Run)…' : 'Import LDIF…'}
              </Button>
            </Section>

            <Section title="Export">
              <p className="text-sm text-muted-foreground mb-1">{target.source}:</p>
              {target.dn ? (
                <TruncatedText text={target.dn} className="block font-mono text-sm text-foreground mb-2" />
              ) : (
                <p className="text-sm text-muted-foreground mb-2">No entry selected.</p>
              )}
              <Button size="sm" leftIcon={Download} onClick={() => openDialog(ExportDialog, { dn: target.dn || undefined })}>
                Export Selection…
              </Button>
              <p className="text-xs text-muted-foreground mt-2">LDIF (entry or subtree) or CSV with chosen columns.</p>
            </Section>

            <section className="px-3 py-3 border-b border-border">
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent LDIF changes</h3>
                {loading && <Spinner size="sm" label="Loading recent imports" />}
              </div>
              <RecentLDIFChanges profileId={activeProfileId} auditRows={auditRows} loading={loading} serverType={serverType} onOpenRow={(e) => void openRow(e)} />
              <p className="text-xs text-muted-foreground mt-2">Exports are not recorded in the audit log.</p>
            </section>
          </>
        )}

        <Section title="Connection profiles">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" leftIcon={FileInput} onClick={() => void importConnectionProfiles()}>
              Import Connections…
            </Button>
            <Button size="sm" leftIcon={FileOutput} onClick={() => void exportConnectionProfiles()}>
              Export Connections…
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2 flex items-start gap-1">
            <Lock size={12} strokeWidth={1.75} aria-hidden className="mt-px shrink-0" />
            Exported files contain no passwords or other secrets; enter them again after an import.
          </p>
        </Section>
      </div>
    </div>
  )
}
