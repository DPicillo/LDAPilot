/**
 * Move to… (LIFE-04): the one move flow (RW3-S-07, components/bulk/MoveEntriesFlow):
 * container picker, dry run as the confirmation (BatchService.BatchMovePreview),
 * move with progress, result with "Retry n Entries…". One entry the dry run has
 * no objection to moves at once. Every moved entry emits ldapilot:entry-moved;
 * the toast names the target.
 */
export { MoveEntriesDialog as MoveEntryDialog, type MoveEntriesDialogProps as MoveEntryDialogProps } from '../bulk/MoveEntriesFlow'
