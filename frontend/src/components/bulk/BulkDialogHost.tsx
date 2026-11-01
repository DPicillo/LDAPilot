import { useEffect } from 'react'
import { useBulkDialogStore } from '../../stores/bulkDialogStore'
import { ImportDialog } from '../export/ImportDialog'
import { ExportDialog } from '../export/ExportDialog'
import { BatchOperationDialogView } from '../editor/BatchOperationDialog'
import { useDialogStore } from '../ui/Dialog'
import { BulkRunContext } from './BulkViews'

/**
 * Renders the global bulk dialogs (stores/bulkDialogStore). Mounted once in
 * AppLayout's overlay hosts (inside the zoom wrapper, outside the panes), so
 * layout changes (Ctrl+B / Ctrl+J, activity switches) do not unmount a
 * running bulk run. ImportDialog and BatchOperationDialogView are Dialog
 * primitives (they portal into LayerHost).
 *
 * It also answers "ldapilot:export-request" {profileId, dns} (multi-selection
 * Export…, TRIAGE §0.1) with the Export dialog for those DNs.
 */
export function BulkDialogHost() {
  const importLDIF = useBulkDialogStore((s) => s.importLDIF);
  const closeImportLDIF = useBulkDialogStore((s) => s.closeImportLDIF);
  const batch = useBulkDialogStore((s) => s.batch);
  const closeBatch = useBulkDialogStore((s) => s.closeBatch);

  useEffect(() => {
    const onExport = (e: Event) => {
      const detail = (e as CustomEvent).detail as { profileId?: string; dns?: string[] } | undefined;
      const dns = (detail?.dns ?? []).filter(Boolean);
      if (!dns.length) return;
      useDialogStore.getState().open(ExportDialog, dns.length === 1 ? { dn: dns[0], profileId: detail?.profileId } : { dns, profileId: detail?.profileId });
    };
    window.addEventListener('ldapilot:export-request', onExport);
    return () => window.removeEventListener('ldapilot:export-request', onExport);
  }, []);

  return (
    <>
      {batch && (
        // The batch modify result offers "Open in List" on this connection (DEF-17).
        <BulkRunContext.Provider
          value={{
            profileId: batch.profileId,
            title: 'Bulk modify',
            close: () => {
              closeBatch(batch.seq);
              batch.onClose?.();
            },
          }}
        >
          <BatchOperationDialogView
            key={batch.seq}
            isOpen
            selectedDNs={batch.dns}
            profileID={batch.profileId}
            initialMode={batch.initialMode}
            onApplied={batch.onApplied}
            onClose={() => {
              closeBatch(batch.seq);
              batch.onClose?.();
            }}
          />
        </BulkRunContext.Provider>
      )}
      {importLDIF && (
        <ImportDialog
          key={importLDIF.seq}
          initialContent={importLDIF.initialContent}
          profileId={importLDIF.profileId}
          containerDN={importLDIF.containerDN}
          onClose={closeImportLDIF}
        />
      )}
    </>
  );
}
