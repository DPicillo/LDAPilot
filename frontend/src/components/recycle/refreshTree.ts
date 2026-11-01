import { useTreeStore } from '../../stores/treeStore'
import { useSearchStore } from '../../stores/searchStore'
import { useSearchSelectionStore } from '../../stores/searchSelectionStore'
import { planTreeRefresh, withoutDeletedEntries, type DeleteOutcomeSummary } from '../../lib/recycle'

/**
 * Brings the tree and the search results up to date after a delete run
 * (DeleteEntryDialog, for every caller: tree, batch dialog, search results).
 */
export function refreshAfterDelete(profileId: string, outcomes: DeleteOutcomeSummary[]) {
  refreshTreeAfterDelete(profileId, outcomes);
  pruneSearchResultsAfterDelete(profileId, outcomes);
}

/**
 * Removes deleted entries (and entries below a deleted subtree) from the
 * search results and their checkbox selection, as long as the results come
 * from profileId.
 */
export function pruneSearchResultsAfterDelete(profileId: string, outcomes: DeleteOutcomeSummary[]) {
  const state = useSearchStore.getState();
  const prev = state.results;
  if (!prev || state.resultsProfileId !== profileId) return;
  const entries = withoutDeletedEntries(prev.entries, outcomes);
  if (entries.length === prev.entries.length) return;
  const next = { ...prev, entries, totalCount: Math.max(0, prev.totalCount - (prev.entries.length - entries.length)) };
  useSearchSelectionStore.getState().rebase(prev, next);
  useSearchStore.setState({ results: next });
}

/**
 * Brings the directory tree up to date after a delete run, also after a
 * stopped or partly failed recursive delete (see planTreeRefresh). Clears the
 * tree selection when anything was deleted.
 */
export function refreshTreeAfterDelete(profileId: string, outcomes: DeleteOutcomeSummary[]) {
  const tree = useTreeStore.getState();
  const rootKeys = (tree.rootNodes[profileId] ?? []).map((n) => n.dn);
  const plan = planTreeRefresh(outcomes, Object.keys(tree.childNodes), (key) => tree.expandedNodes.has(key), rootKeys);
  if (!plan.reloadRoots && plan.reload.length === 0 && plan.drop.length === 0) return;

  tree.clearSelection();
  if (plan.drop.length > 0) {
    useTreeStore.setState((s) => {
      const childNodes = { ...s.childNodes };
      for (const key of plan.drop) delete childNodes[key];
      return { childNodes };
    });
  }
  if (plan.reloadRoots) tree.loadRootNodes(profileId).catch(() => { /* toast shown by the store */ });
  for (const { key, quiet } of plan.reload) {
    tree.loadChildren(profileId, key, quiet).catch(() => { /* toast shown by the store unless quiet */ });
  }
}
