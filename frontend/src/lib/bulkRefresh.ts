/**
 * Brings the tree, open editor tabs and search results up to date after a
 * bulk apply run. Module functions only (no component state), because they
 * may run after the component that opened the bulk dialog unmounted.
 */
import { useTreeStore } from '../stores/treeStore'
import { useEditorStore } from '../stores/editorStore'
import { useSearchStore } from '../stores/searchStore'
import { useSearchSelectionStore } from '../stores/searchSelectionStore'
import type { LDAPEntry } from '../types/ldap'
import type { BulkApplyResult } from '../types/bulk'
import * as wails from './wails'
import { normalizeDN } from './dn'
import { affectedParentDNs, modifiedDNs, restrictToAttributes } from './bulk'

export async function refreshAfterBulkApply(profileId: string, result: BulkApplyResult): Promise<void> {
  const tree = useTreeStore.getState();
  const parents = new Set(affectedParentDNs(result));
  const loaded = Object.keys(tree.childNodes).filter(dn => parents.has(dn.toLowerCase()));
  await Promise.all(loaded.map(dn => tree.loadChildren(profileId, dn, true).catch(() => {})));

  const changed = new Set(modifiedDNs(result));
  const editor = useEditorStore.getState();
  for (const tab of editor.tabs) {
    if (tab.profileId === profileId && changed.has(tab.dn.toLowerCase())) {
      editor.refreshEntry(profileId, tab.dn).catch(() => {});
    }
  }
}

/**
 * refreshAfterBulkApply plus: re-reads the entries a bulk modify changed and
 * updates their rows in the search results (keeping each row's columns), as
 * long as the results still come from profileId. The checkbox selection of
 * the results is kept.
 */
export async function refreshSearchResultsAfterBulk(profileId: string, result: BulkApplyResult): Promise<void> {
  refreshAfterBulkApply(profileId, result).catch(() => {});
  const dns = (result.items || []).filter(it => it.status === 'success').map(it => it.dn);
  const updated = new Map<string, LDAPEntry>();
  let next = 0;
  const worker = async () => {
    while (next < dns.length) {
      const dn = dns[next++];
      try {
        const entry = await wails.GetEntry(profileId, dn);
        if (entry) updated.set(dn, entry);
      } catch { /* keep the old values */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, dns.length) }, worker));
  if (updated.size === 0) return;

  const state = useSearchStore.getState();
  const prev = state.results;
  if (!prev || state.resultsProfileId !== profileId) return; // other results by now
  const keep = state.displayColumns;
  const nextResults = {
    ...prev,
    entries: prev.entries.map(e => {
      const fresh = updated.get(e.dn);
      return fresh ? restrictToAttributes(fresh, e, keep) : e;
    }),
  };
  useSearchSelectionStore.getState().rebase(prev, nextResults);
  useSearchStore.setState({ results: nextResults });
}

/**
 * Re-reads the search result rows of `dns` (entries a change touched, e.g.
 * the modify records of an LDIF import, RW2-S-02) while the results come
 * from profileId; rows keep their columns. Only DNs shown in the results
 * are read.
 */
export async function refreshSearchRowsOf(profileId: string, dns: readonly string[]): Promise<void> {
  const state = useSearchStore.getState();
  if (!state.results || state.resultsProfileId !== profileId || !dns.length) return;
  const wanted = new Set(dns.map((d) => normalizeDN(d)));
  const shown = state.results.entries.filter((e) => wanted.has(normalizeDN(e.dn))).map((e) => e.dn);
  if (!shown.length) return;
  const updated = new Map<string, LDAPEntry>();
  let next = 0;
  const worker = async () => {
    while (next < shown.length) {
      const dn = shown[next++];
      try {
        const entry = await wails.GetEntry(profileId, dn);
        if (entry) updated.set(dn, entry);
      } catch { /* keep the old values */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, shown.length) }, worker));
  if (updated.size === 0) return;
  const now = useSearchStore.getState();
  const prev = now.results;
  if (!prev || now.resultsProfileId !== profileId) return; // other results by now
  const keep = now.displayColumns;
  const nextResults = {
    ...prev,
    entries: prev.entries.map((e) => {
      const fresh = updated.get(e.dn);
      return fresh ? restrictToAttributes(fresh, e, keep) : e;
    }),
  };
  useSearchSelectionStore.getState().rebase(prev, nextResults);
  useSearchStore.setState({ results: nextResults });
}
