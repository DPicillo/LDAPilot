export type Activity = 'connections' | 'explorer' | 'search' | 'export' | 'schema' | 'bookmarks' | 'ai' | 'reports';

/**
 * Why an entry tab shows no attributes (ED-04, ED-16). A tab in one of these
 * states never shows cached values:
 * - deleted: an `ldapilot:entry-deleted` event named the entry (or an
 *   ancestor with `subtree`); `at` = when the app learned it.
 * - missing: the last load failed with noSuchObject (32).
 * - error: the last load failed for another reason (`code` = LDAP result
 *   code when the message names one).
 * A load that fails while the connection is lost or disconnected keeps the
 * cached values (marked stale) instead, see `EditorTab.stale`.
 */
export type EntryTabState =
  | { kind: 'deleted'; at: number; subtree: boolean }
  | { kind: 'missing'; message: string; code: number }
  | { kind: 'error'; message: string; code?: number };

export interface EditorTab {
  id: string;
  profileId: string;
  label: string;
  dn: string;
  /**
   * Unsaved local input (an inline edit, a filled add row or Edit Entry with
   * changes; mirrored from stores/unsavedEdits). Never set by a successful
   * write (ED-02).
   */
  dirty: boolean;
  /** Preview tab (italic): the next preview open replaces it; an edit, double-click or Ctrl+Enter pins it (UX-3). */
  preview?: boolean;
  /** The connection was lost or closed while the tab was open: values may be out of date (refreshed on reconnect). */
  stale?: boolean;
  /** Deleted / missing / failed load (no attributes are shown). */
  state?: EntryTabState;
  /** Time of the last successful load (ms); openEntry reloads a tab older than a move/restore of its DN (ED-22). */
  loadedAt?: number;
}
