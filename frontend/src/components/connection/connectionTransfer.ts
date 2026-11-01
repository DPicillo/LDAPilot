/**
 * Import / export of connection profiles with their messages (CONN-04/05).
 * Every entry point (File menu, palette, Import/Export panel, Connections
 * panel) calls these, so Cancel stays silent and every outcome is reported
 * the same way. Export asks which profiles to write (DEF-06).
 */
import { ExportSelectedConnections, ImportConnectionsDetailed } from '../../lib/wails-auth'
import { useConnectionStore } from '../../stores/connectionStore'
import { toast } from '../ui/Toast'
import { useDialogStore } from '../ui/Dialog'
import { ExportConnectionsDialog } from './ExportConnectionsDialog'
import { exportSummary, importSummary } from './profileLogic'

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Imports profiles from a JSON export file; reports imported, duplicate and skipped profiles (also an empty file). */
export async function importConnectionProfiles(): Promise<void> {
  try {
    const report = await ImportConnectionsDetailed()
    if (report.cancelled) return
    if (report.imported.length > 0) await useConnectionStore.getState().loadProfiles()
    const s = importSummary(report)
    // Details (duplicates, skipped profiles, password needed) behind "Show details".
    // App-wide: no connection tag in the bell (RW1-C-08).
    if (s.tone === 'success') toast.success(s.message, { detail: s.detail, duration: s.detail ? 8000 : undefined, connection: '' })
    else if (s.tone === 'warning') toast.warning(s.message, s.detail, { connection: '' })
    else toast.info(s.message, { detail: s.detail, connection: '' })
  } catch (err) {
    toast.error('Import failed', errText(err), { connection: '' })
  }
}

/** Writes the chosen profiles (no passwords); silent when the save dialog is cancelled. */
export async function exportConnectionIds(ids: string[]): Promise<void> {
  try {
    const result = await ExportSelectedConnections(ids)
    const msg = exportSummary(result)
    if (msg) toast.success(msg, { connection: '' })
  } catch (err) {
    toast.error('Export failed', errText(err), { connection: '' })
  }
}

/**
 * Export Connections…: with several profiles a checklist asks which to
 * export (all checked, or `preselected` when it names more than one); a
 * single profile goes straight to the save dialog.
 */
export async function exportConnectionProfiles(preselected?: string[]): Promise<void> {
  const store = useConnectionStore.getState()
  if (store.profiles.length === 0) await store.loadProfiles()
  const ids = useConnectionStore.getState().profiles.map((p) => p.id)
  if (ids.length === 0) {
    toast.info('There are no connections to export', { connection: '' })
    return
  }
  if (ids.length === 1) return exportConnectionIds(ids)
  useDialogStore.getState().open(ExportConnectionsDialog, { preselected, onExport: (chosen: string[]) => void exportConnectionIds(chosen) })
}
