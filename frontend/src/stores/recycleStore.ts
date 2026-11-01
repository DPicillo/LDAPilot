import { create } from 'zustand'
import type { DeleteOutcomeSummary } from '../lib/recycle'

/**
 * Global entry points of the recycle feature, rendered by DeletedObjectsHost
 * (mounted once in App.tsx):
 * - the Deleted Objects view: `useRecycleStore.getState().openDeletedObjects(profileId)`
 * - the delete confirmation (child count, recursive delete, report) for
 *   callers outside the tree, e.g. the Delete action of BatchOperationDialog:
 *   `useRecycleStore.getState().requestDelete(profileId, dns, { onDeleted })`.
 *   It stacks above an open dialog, so Cancel returns to that dialog.
 */
export interface DeleteRequestOptions {
  /** After a run that ended (also stopped or partly failed) with the outcome of every root. */
  onDeleted?: (outcomes: DeleteOutcomeSummary[]) => void
}

interface RecycleState {
  /** Open view: profile, preselected naming context ('' = default) and the object to find (its DN before the delete). */
  deletedObjects: { profileId: string; namingContext: string; focusDN?: string } | null;
  openDeletedObjects: (profileId: string, namingContext?: string, opts?: { focusDN?: string }) => void;
  closeDeletedObjects: () => void;

  /** Entries waiting in the delete confirmation. */
  pendingDelete: ({ profileId: string; dns: string[] } & DeleteRequestOptions) | null;
  requestDelete: (profileId: string, dns: string[], options?: DeleteRequestOptions) => void;
  closeDelete: () => void;
}

export const useRecycleStore = create<RecycleState>((set) => ({
  deletedObjects: null,
  openDeletedObjects: (profileId, namingContext = '', opts) => set({ deletedObjects: { profileId, namingContext, focusDN: opts?.focusDN } }),
  closeDeletedObjects: () => set({ deletedObjects: null }),

  pendingDelete: null,
  requestDelete: (profileId, dns, options) => set({ pendingDelete: dns.length > 0 ? { profileId, dns: [...dns], onDeleted: options?.onDeleted } : null }),
  closeDelete: () => set({ pendingDelete: null }),
}));
