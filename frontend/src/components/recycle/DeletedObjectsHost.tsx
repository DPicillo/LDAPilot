import { useRecycleStore } from '../../stores/recycleStore'
import { DeletedObjectsDialog } from './DeletedObjectsDialog'
import { DeleteEntryDialog } from './DeleteEntryDialog'

/**
 * Renders the dialogs opened via useRecycleStore (mounted once in App.tsx):
 * the Deleted Objects view and the delete confirmation requested from
 * outside the tree (e.g. the Delete action of the batch operations dialog).
 */
export function DeletedObjectsHost() {
  const view = useRecycleStore((s) => s.deletedObjects);
  const close = useRecycleStore((s) => s.closeDeletedObjects);
  const pendingDelete = useRecycleStore((s) => s.pendingDelete);
  const closeDelete = useRecycleStore((s) => s.closeDelete);
  return (
    <>
      {view && (
        <DeletedObjectsDialog
          key={`${view.profileId}:${view.namingContext}`}
          profileId={view.profileId}
          namingContext={view.namingContext}
          focusDN={view.focusDN}
          onClose={close}
        />
      )}
      {pendingDelete && (
        <DeleteEntryDialog
          key={`${pendingDelete.profileId}:${pendingDelete.dns.join('\n')}`}
          profileId={pendingDelete.profileId}
          dns={pendingDelete.dns}
          onDeleted={pendingDelete.onDeleted}
          onClose={closeDelete}
        />
      )}
    </>
  );
}
