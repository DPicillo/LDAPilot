import { useContext } from 'react';
import { stripWordJoiner } from '../../lib/aiFormat';
import { copyText } from '../../lib/ai';
import { ScopeBase, ScopeOne, ScopeSub, type SearchScope } from '../../types/ldap';
import { useConnectionStore } from '../../stores/connectionStore';
import { useSearchStore } from '../../stores/searchStore';
import { useUIStore } from '../../stores/uiStore';
import { MessageLinkContext, type FilterUse } from './DnLink';
import { ContextMenu, MenuItem, useContextMenu } from '../ui/Menu';
import { toast } from '../ui/Toast';

export function scopeValue(scope: string | undefined): SearchScope {
  return scope === 'base' ? ScopeBase : scope === 'one' ? ScopeOne : ScopeSub;
}

/** Opens the search panel with this filter, base and scope and runs it. */
export function openInSearch(filter: string, use: Partial<FilterUse> | undefined) {
  const conn = useConnectionStore.getState();
  const profileId = use?.profileId || conn.activeProfileId;
  if (!profileId) {
    toast.info('Connect to a directory to run this search.');
    return;
  }
  const profile = conn.profiles.find((p) => p.id === profileId);
  const baseDN = use?.baseDn || profile?.baseDN || '';
  const search = useSearchStore.getState();
  search.setParams({ filter: stripWordJoiner(filter), baseDN, scope: scopeValue(use?.scope) });
  // The advanced mode shows the raw filter, base and scope that run here.
  search.setPanelMode('advanced');
  const ui = useUIStore.getState();
  ui.setActivity('search');
  if (!ui.sidebarVisible) ui.toggleSidebar();
  // The search panel shows its results in the bottom panel; open it as the
  // panel's own Search button does.
  ui.showBottomTab?.('search-results');
  void search.executeSearch(profileId);
}

export function FilterLink({ filter }: { filter: string }) {
  const links = useContext(MessageLinkContext);
  const menu = useContextMenu();
  const clean = stripWordJoiner(filter).trim();
  const use = links.filters[clean];

  return (
    <>
      <button type="button"
        className="inline cursor-pointer break-all rounded bg-secondary px-1 text-left font-mono text-xs text-primary underline-offset-2 [box-decoration-break:clone] hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        title={use?.baseDn ? `Search below ${use.baseDn} (${use.scope || 'sub'})` : 'Open in search'}
        aria-label={`Search with filter ${clean}`}
        onClick={() => openInSearch(clean, use)}
        onContextMenu={(e) => menu.open(e, undefined)}
      >
        {clean}
      </button>
      <ContextMenu point={menu.point} onClose={menu.close} label="Filter">
        <MenuItem label="Open in search" default onSelect={() => openInSearch(clean, use)} />
        <MenuItem label="Copy filter" onSelect={() => void copyText(clean, 'Filter')} />
      </ContextMenu>
    </>
  );
}
