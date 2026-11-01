/**
 * Emitters of the cross-batch entry lifecycle events (TRIAGE §0.1): window
 * CustomEvents with fixed names and detail shapes, so the tree, the editor
 * tabs, bookmarks and the search results can follow creates, renames/moves,
 * deletes and restores without importing this feature. Safe to import from
 * node tests (no window → nothing is sent).
 */
import { getParentDN } from '../../lib/dn.ts'

export const ENTRY_CREATED = 'ldapilot:entry-created'
export const ENTRY_MOVED = 'ldapilot:entry-moved'
export const ENTRY_DELETED = 'ldapilot:entry-deleted'
export const ENTRY_RESTORED = 'ldapilot:entry-restored'

export interface EntryCreatedDetail {
  profileId: string
  dn: string
  parentDN: string
  /** Select and reveal the new entry in the tree. */
  select?: boolean
}
export interface EntryMovedDetail {
  profileId: string
  oldDN: string
  newDN: string
}
export interface EntryDeletedDetail {
  profileId: string
  dn: string
  /** Everything at and below dn is gone. */
  subtree: boolean
}
export interface EntryRestoredDetail {
  profileId: string
  dn: string
}

function emit(name: string, detail: object) {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }))
  } catch {
    /* a failing listener must not break the operation that succeeded */
  }
}

export function emitEntryCreated(profileId: string, dn: string, opts: { select?: boolean; parentDN?: string } = {}) {
  const detail: EntryCreatedDetail = { profileId, dn, parentDN: opts.parentDN ?? getParentDN(dn), select: opts.select }
  emit(ENTRY_CREATED, detail)
}

/** One event per entry; a rename is a move within the parent. */
export function emitEntryMoved(profileId: string, oldDN: string, newDN: string) {
  if (!oldDN || !newDN || oldDN === newDN) return
  const detail: EntryMovedDetail = { profileId, oldDN, newDN }
  emit(ENTRY_MOVED, detail)
}

export function emitEntryDeleted(profileId: string, dn: string, subtree: boolean) {
  const detail: EntryDeletedDetail = { profileId, dn, subtree }
  emit(ENTRY_DELETED, detail)
}

export function emitEntryRestored(profileId: string, dn: string) {
  const detail: EntryRestoredDetail = { profileId, dn }
  emit(ENTRY_RESTORED, detail)
}
