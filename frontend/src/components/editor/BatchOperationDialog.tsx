import { useRecycleStore } from '../../stores/recycleStore'
import { useState, useEffect, useCallback, useRef } from 'react'
import { Trash2, Pencil, ArrowRightLeft } from 'lucide-react'
import type { BulkApplyResult } from '../../types/bulk'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Tabs, TabPanel, type TabItem } from '../ui/Tabs'
import { BatchModifyPanel } from './BatchModifyPanel'
import { ConnectionTag } from '../bulk/BulkViews'
import { useMoveFlow } from '../bulk/MoveEntriesFlow'
import { openBatchDialog, useBulkDialogStore, type BatchMode } from '../../stores/bulkDialogStore'

interface BatchOperationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  selectedDNs: string[];
  profileID: string;
  initialMode?: BatchMode;
  /**
   * Called after a batch modify changed at least one entry; it may run after
   * the opening component unmounted (use stores / module functions only).
   */
  onApplied?: (result: BulkApplyResult) => void;
}

/**
 * Opens the batch operations dialog in the global BulkDialogHost while
 * isOpen is true and renders nothing itself. The dialog is not part of the
 * opening component, so a running batch keeps its progress, Stop button and
 * result report when that component unmounts (sidebar / bottom panel hidden
 * or switched). Props are taken when the dialog opens; onClose is called
 * when it closes. New code can call openBatchDialog() directly.
 */
export function BatchOperationDialog({ isOpen, onClose, selectedDNs, profileID, initialMode = 'delete', onApplied }: BatchOperationDialogProps) {
  const latest = useRef({ onClose, selectedDNs, profileID, initialMode, onApplied });
  latest.current = { onClose, selectedDNs, profileID, initialMode, onApplied };
  const openId = useRef<number | null>(null);

  useEffect(() => {
    if (!isOpen) {
      if (openId.current !== null) useBulkDialogStore.getState().closeBatch(openId.current);
      openId.current = null;
      return;
    }
    if (openId.current !== null) return; // already open (effects may run twice)
    const p = latest.current;
    openId.current = openBatchDialog({
      profileId: p.profileID,
      dns: p.selectedDNs,
      initialMode: p.initialMode,
      onApplied: p.onApplied,
      onClose: () => {
        openId.current = null;
        p.onClose();
      },
    });
    // No cleanup on unmount on purpose: the dialog outlives its opener.
  }, [isOpen]);

  return null;
}

/**
 * Batch operations on several entries of one connection (tree
 * multi-selection or search results): modify (templates, dry run, apply with
 * report) and move — the one move flow of "Move n Entries…" (RW3-S-07,
 * bulk/MoveEntriesFlow: picker, dry run as the confirmation, result with
 * retry). Delete is an action of the dialog: the delete confirmation stacks
 * above it, so Cancel there returns here with the rows. Rendered by
 * components/bulk/BulkDialogHost.
 */
export function BatchOperationDialogView({ isOpen, onClose, selectedDNs, profileID, initialMode = 'delete', onApplied }: BatchOperationDialogProps) {
  const [mode, setMode] = useState<'modify' | 'move'>(initialMode === 'move' ? 'move' : 'modify');
  const [modifyBusy, setModifyBusy] = useState(false);
  const [modifyDirty, setModifyDirty] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Move: the one move flow (picker, dry run as the confirmation, result with retry; RW3-S-07).
  // A full success closes the dialog like Move… does (the toast keeps Undo); a failure keeps the result.
  const move = useMoveFlow({ profileId: profileID, dns: selectedDNs, onDone: onClose, onClose });
  /** The last tab switch came from a pointer (then focus goes on to the tab's field). */
  const tabPointer = useRef(false);
  // Modify: the first attribute field takes the focus, never the operation select (RW1-S-01).
  const modifyFirst = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (initialMode !== 'delete') setMode(initialMode);
  }, [initialMode]);

  /**
   * Hands the rows to the delete confirmation (child count, recursive
   * delete, report). It stacks above this dialog: Cancel returns here with
   * the rows; once something was deleted this dialog closes.
   */
  const requestDelete = useCallback(() => {
    setDeleting(true);
    useRecycleStore.getState().requestDelete(profileID, selectedDNs, {
      onDeleted: (outcomes) => {
        if (outcomes.some((o) => o.deleted > 0 || o.deletedUnknown)) onClose();
      },
    });
  }, [profileID, selectedDNs, onClose]);
  // The delete confirmation closed (cancelled or done): Delete is possible again.
  const pendingDelete = useRecycleStore((s) => s.pendingDelete);
  useEffect(() => { if (!pendingDelete) setDeleting(false); }, [pendingDelete]);

  // Opened with initialMode 'delete' (legacy Delete tab): ask at once, above the dialog.
  const askedInitialDelete = useRef(false);
  useEffect(() => {
    if (!isOpen || initialMode !== 'delete' || askedInitialDelete.current) return;
    askedInitialDelete.current = true;
    requestDelete();
  }, [isOpen, initialMode, requestDelete]);

  if (!isOpen) return null;

  const busy = move.busy || modifyBusy;
  const switchMode = (next: 'modify' | 'move') => {
    setMode(next);
    // A click on a tab goes on to its first field (RW1-S-01); arrow keys stay on the
    // tab list, so ArrowLeft / ArrowRight switch back and forth (RW2-S-06).
    const byPointer = tabPointer.current;
    tabPointer.current = false;
    if (byPointer) requestAnimationFrame(() => requestAnimationFrame(() => (next === 'move' ? move.pickerInput.current : modifyFirst.current)?.focus()));
  };

  const tabs: TabItem[] = [
    { id: 'modify', label: 'Modify', icon: Pencil, disabled: busy && mode !== 'modify' },
    { id: 'move', label: 'Move', icon: ArrowRightLeft, disabled: busy && mode !== 'move' },
  ];
  const count = `${selectedDNs.length} ${selectedDNs.length === 1 ? 'entry' : 'entries'}`;
  const deleteLabel = selectedDNs.length === 1 ? 'Delete Entry…' : `Delete ${selectedDNs.length} Entries…`;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      size={mode === 'modify' ? 'xl' : 'lg'}
      title={`Batch Operations (${count})`}
      description={<span className="inline-flex items-center gap-1.5">on <ConnectionTag profileId={profileID} /></span>}
      dismissible={busy ? 'never' : 'when-clean'}
      dirty={(mode === 'modify' && modifyDirty) || (mode === 'move' && move.dirty)}
      initialFocus={mode === 'move' ? move.pickerInput : modifyFirst}
      className={mode === 'modify' ? 'h-[88%]' : undefined}
      bodyClassName="p-0 flex flex-col overflow-hidden"
      footer={mode === 'modify' ? undefined : (
        <>
          <Button variant="danger-ghost" leftIcon={Trash2} onClick={requestDelete} disabled={busy || deleting} className="mr-auto">
            {deleteLabel}
          </Button>
          {move.footer}
        </>
      )}
    >
      <div className="flex items-center shrink-0 pr-2" onPointerDownCapture={() => { tabPointer.current = true; }} onKeyDownCapture={() => { tabPointer.current = false; }}>
        <Tabs
          variant="sub"
          idPrefix="batch-ops"
          aria-label="Batch operation"
          items={tabs}
          value={mode}
          onValueChange={(id) => {
            if (busy) return;
            switchMode(id as 'modify' | 'move');
          }}
          className="flex-1 min-w-0"
        />
      </div>

      <TabPanel idPrefix="batch-ops" value={mode} selected={mode} className="flex-1 min-h-0 flex flex-col">
        {mode === 'modify' ? (
          <BatchModifyPanel
            profileID={profileID}
            dns={selectedDNs}
            onClose={onClose}
            firstFieldRef={modifyFirst}
            onApplied={onApplied}
            onBusyChange={setModifyBusy}
            onDirtyChange={setModifyDirty}
            footerStart={
              <Button variant="danger-ghost" leftIcon={Trash2} onClick={requestDelete} disabled={busy || deleting}>
                {deleteLabel}
              </Button>
            }
          />
        ) : (
          <div className="flex-1 overflow-auto px-4 py-3">{move.body}</div>
        )}
      </TabPanel>

    </Dialog>
  );
}
