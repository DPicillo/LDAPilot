import { create } from 'zustand'
import type { SearchResult } from '../types/ldap'
import { useSearchStore } from './searchStore'
import { restrictToAttributes } from '../lib/bulk'
import { ACCOUNT_STATUS_ATTRIBUTES } from '../components/ui/accountStatus'
import { rekeyChecked, withMovedRows, withoutDeletedRows } from '../components/search/snapshotModel'
import { isComputedReportColumn } from '../lib/accountReports'
import { readRowEntryShared } from '../lib/rowRead'

/**
 * Checkbox selection of the search results (bulk operations). It lives
 * outside the SearchResults component so that it survives switching bottom
 * panel tabs or hiding the panel, and belongs to one results object: a new
 * search (or cleared results) means nothing is selected.
 */
interface SearchSelectionState {
  /** Results the selection belongs to (object identity). */
  results: SearchResult | null;
  checked: ReadonlySet<string>;
  /** Anchor of Shift+Click range selection. */
  anchor: string | null;
  /** Sets the selection of `results`. */
  select: (results: SearchResult, checked: ReadonlySet<string>, anchor: string | null) => void;
  clear: () => void;
  /**
   * Keeps the selection when `prev` is replaced by `next`, the same results
   * with re-read or removed entries (DNs no longer in `next` are unchecked).
   * Call before putting `next` into the search store.
   */
  rebase: (prev: SearchResult, next: SearchResult) => void;
}

const EMPTY: ReadonlySet<string> = new Set();

export const useSearchSelectionStore = create<SearchSelectionState>((set, get) => ({
  results: null,
  checked: EMPTY,
  anchor: null,
  select: (results, checked, anchor) => set({ results, checked, anchor }),
  clear: () => set({ results: null, checked: EMPTY, anchor: null }),
  rebase: (prev, next) => {
    const sel = get();
    if (sel.results !== prev) return;
    const present = new Set(next.entries.map((e) => e.dn));
    const kept = [...sel.checked].filter((dn) => present.has(dn));
    set({
      results: next,
      checked: kept.length === sel.checked.size ? sel.checked : new Set(kept),
      anchor: sel.anchor !== null && present.has(sel.anchor) ? sel.anchor : null,
    });
  },
}));

// New results (another search, cleared results): drop the selection.
useSearchStore.subscribe((state) => {
  const sel = useSearchSelectionStore.getState();
  if (sel.results !== null && sel.results !== state.results) sel.clear();
});

/** Checked DNs of `results` (empty when the selection belongs to other results). */
export function useSearchChecked(results: SearchResult | null): ReadonlySet<string> {
  return useSearchSelectionStore((s) => (results !== null && s.results === results ? s.checked : EMPTY));
}

/** Shift+Click anchor of `results`. */
export function useSearchAnchor(results: SearchResult | null): string | null {
  return useSearchSelectionStore((s) => (results !== null && s.results === results ? s.anchor : null));
}

// --- Result rows follow entry events (window CustomEvents, TRIAGE §0.1) -----
// Here (not in searchStore) because replacing the results must keep the
// checkbox selection: rebase() before the search store is updated.

/** A renamed / moved entry: its row (and rows below it) get the new DN; checked rows stay checked. */
function onEntryMoved(detail: { profileId?: string; oldDN?: string; newDN?: string } | undefined) {
  const s = useSearchStore.getState();
  const prev = s.results;
  if (!detail?.oldDN || !detail.newDN || !prev || s.resultsProfileId !== detail.profileId) return;
  const moved = withMovedRows(prev, detail.oldDN, detail.newDN);
  if (!moved) return;
  const { next, renamed } = moved;
  const sel = useSearchSelectionStore.getState();
  if (sel.results === prev) {
    const checked = rekeyChecked(sel.checked, renamed);
    const anchor = sel.anchor !== null ? renamed.get(sel.anchor) ?? sel.anchor : null;
    useSearchSelectionStore.setState({ results: next, checked, anchor });
  }
  useSearchStore.setState({ results: next });
  // The renamed entry's own attributes (cn, name) changed too: read the row again (RW1-S-04).
  onAccountChanged({ profileId: detail.profileId, dn: detail.newDN });
}

/**
 * A deleted entry (LDIF delete records, the AI, any delete path): its rows go (RW1-S-04).
 * The results count the removed rows, so results emptied by deletions say so.
 */
function onEntryDeleted(detail: { profileId?: string; dn?: string; subtree?: boolean } | undefined) {
  const s = useSearchStore.getState();
  const prev = s.results;
  if (!detail?.dn || !prev || s.resultsProfileId !== detail.profileId) return;
  const next = withoutDeletedRows(prev, detail.dn, !!detail.subtree);
  if (!next) return;
  useSearchSelectionStore.getState().rebase(prev, next);
  useSearchStore.setState({ results: next });
}

/** Rows whose account changed are re-read (Status column), coalesced per 300 ms. */
const pendingStatus = new Map<string, { profileId: string; dn: string }>();
let statusTimer: ReturnType<typeof setTimeout> | null = null;

function onAccountChanged(detail: { profileId?: string; dn?: string } | undefined) {
  const s = useSearchStore.getState();
  if (!detail?.dn || !detail.profileId || !s.results || s.resultsProfileId !== detail.profileId) return;
  const lower = detail.dn.toLowerCase();
  const row = s.results.entries.find((e) => e.dn.toLowerCase() === lower);
  if (!row) return;
  // A backend report row (computed columns such as "Locked until", which contain a blank) is
  // never re-read with a plain GetEntry: restrictToAttributes would drop its computed columns.
  // Report rows live in their results tabs, which patch them from the event's status or re-read
  // them through the report (resultsSnapshots, RW1-P-06 c).
  if ((row.attributes ?? []).some((a) => isComputedReportColumn(a.name))) return;
  pendingStatus.set(`${detail.profileId}|${lower}`, { profileId: detail.profileId, dn: detail.dn });
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    const jobs = [...pendingStatus.values()];
    pendingStatus.clear();
    for (const job of jobs) {
      // Shared with the results tabs that show the same row (lib/rowRead.ts).
      readRowEntryShared(job.profileId, job.dn)
        .then((fresh) => {
          const st = useSearchStore.getState();
          const prev = st.results;
          if (!fresh || !prev || st.resultsProfileId !== job.profileId) return;
          const l = job.dn.toLowerCase();
          const keep = [...st.displayColumns, ...ACCOUNT_STATUS_ATTRIBUTES];
          const next: SearchResult = { ...prev, entries: prev.entries.map((e) => (e.dn.toLowerCase() === l ? restrictToAttributes(fresh, e, keep) : e)) };
          useSearchSelectionStore.getState().rebase(prev, next);
          useSearchStore.setState({ results: next });
        })
        .catch(() => {
          /* keep the row */
        });
    }
  }, 300);
}

if (typeof window !== 'undefined') {
  window.addEventListener('ldapilot:entry-moved', (e) => onEntryMoved((e as CustomEvent).detail));
  window.addEventListener('ldapilot:entry-deleted', (e) => onEntryDeleted((e as CustomEvent).detail));
  window.addEventListener('ldapilot:account-changed', (e) => onAccountChanged((e as CustomEvent).detail));
}
