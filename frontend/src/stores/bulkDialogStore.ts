import { create } from 'zustand'
import type { BulkApplyResult } from '../types/bulk'

export type BatchMode = 'delete' | 'modify' | 'move';

/** What the batch operations dialog works on. */
export interface BatchDialogRequest {
  /** Connection the DNs belong to; all reads and writes go there. */
  profileId: string;
  dns: string[];
  initialMode?: BatchMode;
  /**
   * Called after a batch modify changed at least one entry. It also runs
   * when the component that opened the dialog is gone, so it must only use
   * stores and module functions.
   */
  onApplied?: (result: BulkApplyResult) => void;
  /** Called after the dialog was closed. */
  onClose?: () => void;
}

/** Where an LDIF import was started from. */
export interface ImportLDIFOptions {
  /** Connection to import into (default: the active one). */
  profileId?: string;
  /**
   * Container the import was opened on (tree / list "Import LDIF…"): the
   * dialog shows "into <container>", offers a skeleton and rebases the file's
   * DNs into it.
   */
  containerDN?: string;
}

/**
 * Global bulk dialogs that can be opened from anywhere (menus, context
 * menus, search results, the tree). Rendered by components/bulk/BulkDialogHost,
 * which is mounted once in App.tsx outside the layout, so a running bulk run
 * keeps its dialog (progress, Stop, report) when the sidebar or the bottom
 * panel is hidden or switched.
 */
interface BulkDialogState {
  /** Open LDIF import / change file dialog; null when closed. */
  importLDIF: ({ seq: number; initialContent: string } & ImportLDIFOptions) | null;
  /** Opens the LDIF import dialog (optionally pre-filled, optionally on a container). */
  openImportLDIF: (initialContent?: string, options?: ImportLDIFOptions) => void;
  closeImportLDIF: () => void;

  /** Open batch operations dialog; null when closed. */
  batch: (BatchDialogRequest & { seq: number }) | null;
  /** Opens the batch operations dialog; returns its id for closeBatch. */
  openBatch: (request: BatchDialogRequest) => number;
  /** Closes the batch dialog (only the one with this id, if given). */
  closeBatch: (seq?: number) => void;
}

let seq = 0;

export const useBulkDialogStore = create<BulkDialogState>((set, get) => ({
  importLDIF: null,
  openImportLDIF: (initialContent = '', options = {}) => {
    seq++;
    set({ importLDIF: { seq, initialContent, ...options } });
  },
  closeImportLDIF: () => set({ importLDIF: null }),

  batch: null,
  openBatch: (request) => {
    seq++;
    set({ batch: { ...request, dns: [...request.dns], seq } });
    return seq;
  },
  closeBatch: (id) => {
    const cur = get().batch;
    if (cur && (id === undefined || cur.seq === id)) set({ batch: null });
  },
}));

/**
 * Opens the LDIF import / change file dialog (for menus and commands). A
 * string argument pre-fills the content; pass `{ containerDN }` (tree / list
 * "Import LDIF…" on a container) to import into that container.
 */
export function openImportLDIF(initialContent?: string | ImportLDIFOptions, options?: ImportLDIFOptions): void {
  if (typeof initialContent === 'object' && initialContent !== null) {
    useBulkDialogStore.getState().openImportLDIF('', initialContent);
    return;
  }
  useBulkDialogStore.getState().openImportLDIF(initialContent, options);
}

/** Opens the batch operations dialog (modify / move / delete) for DNs of one connection. */
export function openBatchDialog(request: BatchDialogRequest): number {
  return useBulkDialogStore.getState().openBatch(request);
}
