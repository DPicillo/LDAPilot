import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { RefreshCw, FolderTree, Search, X, ChevronsUpDown, ChevronsDownUp, Loader2, Crosshair, Copy, Download, Trash2, ArrowUpDown } from 'lucide-react'
import { useTreeStore } from '../../stores/treeStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { TreeNode, LDAPEntry, ScopeSub } from '../../types/ldap'
import { TreeNodeRow } from './TreeNodeItem'
import { TreeContextMenu } from './TreeContextMenu'
import { NewEntryDialog } from '../editor/NewEntryDialog'
import { EditEntryDialog } from '../editor/EditEntryDialog'
import { RenameEntryDialog } from '../editor/RenameEntryDialog'
import { CopyEntryDialog } from '../editor/CopyEntryDialog'
import { CompareDialog } from '../editor/CompareDialog'
import { StatisticsDialog } from './StatisticsDialog'
import { PasswordDialog } from '../editor/PasswordDialog'
import { ExportDialog } from '../export/ExportDialog'
import { BatchOperationDialog } from '../editor/BatchOperationDialog'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { useBookmarkStore } from '../../stores/bookmarkStore'
import { getIconForObjectClass, getIconColor } from '../../lib/ldap-icons'
import { cn } from '../../lib/utils'
import * as wails from '../../lib/wails'
import { toast } from '../ui/Toast'

type TreeSortMode = 'default' | 'alpha' | 'type';

const SORT_MODE_LABELS: Record<TreeSortMode, string> = {
  default: 'Server Order',
  alpha: 'Alphabetical (A-Z)',
  type: 'By Type',
};

/** Icon type priority for type-based sorting (lower = higher priority) */
function getIconSortPriority(icon: string): number {
  switch (icon) {
    case 'globe': return 0;      // domains
    case 'folder': return 1;     // OUs
    case 'box': return 2;        // containers
    case 'users': return 3;      // groups
    case 'building': return 4;   // organizations
    default: return 5;           // everything else
  }
}

/** Sort a list of TreeNodes by the given mode, returning a new array */
function sortNodes(nodes: TreeNode[], mode: TreeSortMode): TreeNode[] {
  if (mode === 'default' || nodes.length <= 1) return nodes;
  const sorted = [...nodes];
  if (mode === 'alpha') {
    sorted.sort((a, b) => (a.rdn || '').localeCompare(b.rdn || '', undefined, { sensitivity: 'base' }));
  } else if (mode === 'type') {
    sorted.sort((a, b) => {
      const pa = getIconSortPriority(a.icon);
      const pb = getIconSortPriority(b.icon);
      if (pa !== pb) return pa - pb;
      return (a.rdn || '').localeCompare(b.rdn || '', undefined, { sensitivity: 'base' });
    });
  }
  return sorted;
}

function buildTreeSearchFilter(text: string): string {
  const escaped = text.replace(/([\\*()\0])/g, '\\$1');
  return `(|(cn=*${escaped}*)(displayName=*${escaped}*)(sAMAccountName=*${escaped}*)(uid=*${escaped}*)(description=*${escaped}*))`;
}

interface ContextMenuState {
  x: number;
  y: number;
  dn: string;
}

export function DirectoryTree() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const connectionStatuses = useConnectionStore((s) => s.connectionStatuses);
  const profiles = useConnectionStore((s) => s.profiles);
  const {
    rootNodes, childNodes, expandedNodes, selectedNodes, loading,
    loadRootNodes, toggleExpand, toggleSelectNode, selectRange, clearSelection, refreshNode, locateInTree,
  } = useTreeStore();
  const openEntry = useEditorStore((s) => s.openEntry);
  const { addBookmark, removeBookmark, isBookmarked } = useBookmarkStore();

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [newEntryParentDN, setNewEntryParentDN] = useState<string | null>(null);
  const [editEntryDN, setEditEntryDN] = useState<string | null>(null);
  const [renameEntryDN, setRenameEntryDN] = useState<string | null>(null);
  const [copyEntryDN, setCopyEntryDN] = useState<string | null>(null);
  const [compareDN, setCompareDN] = useState<string | null>(null);
  const [statisticsDN, setStatisticsDN] = useState<string | null>(null);
  const [exportDN, setExportDN] = useState<string | null>(null);
  const [deleteDN, setDeleteDN] = useState<string | null>(null);
  const [batchDeleteDNs, setBatchDeleteDNs] = useState<string[] | null>(null);
  const [batchDialog, setBatchDialog] = useState<{ open: boolean; mode: 'delete' | 'modify' | 'move' }>({ open: false, mode: 'delete' });
  const [passwordDN, setPasswordDN] = useState<string | null>(null);
  const [treeFilter, setTreeFilter] = useState('');
  const [showTreeFilter, setShowTreeFilter] = useState(false);
  const [treeSortMode, setTreeSortMode] = useState<TreeSortMode>('default');
  const [searchResults, setSearchResults] = useState<LDAPEntry[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchDone, setSearchDone] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isConnected = activeProfileId ? connectionStatuses[activeProfileId] === true : false;
  const activeProfile = activeProfileId ? profiles.find((p) => p.id === activeProfileId) : null;
  const isReadOnly = activeProfile?.readOnly ?? false;
  const nodes = activeProfileId ? (rootNodes[activeProfileId] || []) : [];
  const isRootLoading = activeProfileId ? loading[`root:${activeProfileId}`] : false;

  const selectionCount = selectedNodes.size;
  const selectedDNsArray = useMemo(() => Array.from(selectedNodes), [selectedNodes]);

  useEffect(() => {
    if (activeProfileId && isConnected && !rootNodes[activeProfileId]) {
      loadRootNodes(activeProfileId);
    }
  }, [activeProfileId, isConnected, loadRootNodes, rootNodes]);

  // Collect all domain root DNs to search across (including child domains from children)
  const allDomainBaseDNs = useMemo(() => {
    const dns: string[] = [];
    function collectDomains(nodeList: TreeNode[]) {
      for (const n of nodeList) {
        // Domain partitions start with DC= and have globe icon
        if (n.icon === 'globe' && n.dn.toLowerCase().startsWith('dc=')) {
          dns.push(n.dn);
        }
        // Check pre-loaded children for nested child domains
        if (n.children) {
          collectDomains(n.children);
        }
      }
    }
    collectDomains(nodes);
    return dns.length > 0 ? dns : [activeProfile?.baseDN || ''];
  }, [nodes, activeProfile?.baseDN]);

  // Debounced server-side LDAP search — searches across all domain partitions (including referrals)
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    if (!treeFilter || treeFilter.length < 2 || !activeProfileId || !isConnected) {
      setSearchResults([]);
      setSearchLoading(false);
      setSearchDone(false);
      return;
    }

    setSearchLoading(true);
    setSearchDone(false);

    searchTimerRef.current = setTimeout(async () => {
      const allResults: LDAPEntry[] = [];
      const filter = buildTreeSearchFilter(treeFilter);
      const perDomainLimit = Math.max(10, Math.floor(50 / allDomainBaseDNs.length));

      // Search all domain partitions in parallel
      const searches = allDomainBaseDNs.map(async (baseDN) => {
        try {
          const result = await wails.SearchLDAP(activeProfileId!, {
            baseDN,
            filter,
            scope: ScopeSub,
            attributes: ['cn', 'objectClass', 'displayName', 'sAMAccountName'],
            sizeLimit: perDomainLimit,
            timeLimit: 10,
          });
          return result?.entries || [];
        } catch {
          return [];
        }
      });

      const results = await Promise.all(searches);
      for (const entries of results) {
        allResults.push(...entries);
      }

      setSearchResults(allResults);
      setSearchLoading(false);
      setSearchDone(true);
    }, 400);

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [treeFilter, activeProfileId, isConnected, allDomainBaseDNs]);

  const handleOpenEntry = useCallback((dn: string) => {
    if (activeProfileId) {
      openEntry(activeProfileId, dn);
    }
  }, [activeProfileId, openEntry]);

  const handleRefresh = useCallback(() => {
    if (activeProfileId) {
      loadRootNodes(activeProfileId);
    }
  }, [activeProfileId, loadRootNodes]);

  async function handleDeleteConfirmed(dn: string) {
    if (!activeProfileId) return;
    try {
      await wails.DeleteEntry(activeProfileId, dn);
      toast.success(`Entry deleted`);
      const parentDN = dn.split(',').slice(1).join(',');
      if (parentDN) {
        refreshNode(activeProfileId, parentDN);
      } else {
        loadRootNodes(activeProfileId);
      }
    } catch (err: any) {
      toast.error('Failed to delete entry', err?.message);
    }
    setDeleteDN(null);
  }

  function handleDelete(dn: string) {
    if (isReadOnly) {
      toast.error('Connection is read-only');
      return;
    }
    setDeleteDN(dn);
  }

  // --- Batch action handlers ---

  async function handleBatchDeleteConfirmed(dns: string[]) {
    if (!activeProfileId) return;
    const parentDNsToRefresh = new Set<string>();
    let successCount = 0;
    let failCount = 0;
    for (const dn of dns) {
      try {
        await wails.DeleteEntry(activeProfileId, dn);
        successCount++;
        const parentDN = dn.split(',').slice(1).join(',');
        if (parentDN) parentDNsToRefresh.add(parentDN);
      } catch (err: any) {
        failCount++;
        toast.error(`Failed to delete ${dn.split(',')[0]}`, err?.message);
      }
    }
    if (successCount > 0) {
      toast.success(`${successCount} ${successCount === 1 ? 'entry' : 'entries'} deleted`);
      clearSelection();
      for (const parentDN of parentDNsToRefresh) {
        refreshNode(activeProfileId, parentDN);
      }
    }
    if (failCount > 0 && successCount === 0) {
      toast.error(`Failed to delete all ${failCount} entries`);
    }
    setBatchDeleteDNs(null);
  }

  function handleBatchCopyDNs(dns: string[]) {
    navigator.clipboard.writeText(dns.join('\n'));
    toast.info(`${dns.length} DNs copied`);
  }

  async function handleBatchExport(dns: string[]) {
    if (!activeProfileId) return;
    try {
      await wails.ExportToFile(activeProfileId, dns);
      toast.success(`${dns.length} entries exported`);
    } catch (err: any) {
      toast.error('Export failed', err?.message);
    }
  }

  function handleBatchDelete(dns: string[]) {
    if (isReadOnly) {
      toast.error('Connection is read-only');
      return;
    }
    setBatchDeleteDNs(dns);
  }

  const handleDrop = useCallback(async (sourceDN: string, targetDN: string) => {
    if (!activeProfileId || isReadOnly) {
      if (isReadOnly) toast.error('Connection is read-only');
      return;
    }
    const sourceRDN = sourceDN.split(',')[0];
    const sourceParent = sourceDN.split(',').slice(1).join(',');
    if (sourceParent === targetDN) return; // Already in this container

    try {
      await wails.RenameEntry(activeProfileId, sourceDN, sourceRDN, true, targetDN);
      toast.success(`Moved to ${targetDN.split(',')[0]}`);
      // Refresh both old and new parent
      refreshNode(activeProfileId, sourceParent);
      refreshNode(activeProfileId, targetDN);
    } catch (err: any) {
      toast.error('Move failed', err?.message);
    }
  }, [activeProfileId, isReadOnly, refreshNode]);

  const filterLower = treeFilter.toLowerCase();

  // Flatten the tree into a list of visible rows for virtualization
  const flatRows = useMemo(() => {
    const rows: { node: TreeNode; depth: number }[] = [];

    function flatten(nodeList: TreeNode[], depth: number) {
      const sorted = sortNodes(nodeList, treeSortMode);
      for (const node of sorted) {
        // Apply local filter
        if (filterLower) {
          const matches = node.rdn?.toLowerCase().includes(filterLower) || node.dn.toLowerCase().includes(filterLower);
          if (!matches) continue;
        }
        rows.push({ node, depth });
        if (expandedNodes.has(node.dn)) {
          const children = childNodes[node.dn] || [];
          if (children.length > 0) {
            flatten(children, depth + 1);
          }
        }
      }
    }

    flatten(nodes, 0);
    return rows;
  }, [nodes, expandedNodes, childNodes, filterLower, treeSortMode]);

  // Pre-compute the flat DN list for range selection
  const flatDNs = useMemo(() => flatRows.map(r => r.node.dn), [flatRows]);

  const handleNodeSelect = useCallback((dn: string, e: React.MouseEvent) => {
    if (e.shiftKey) {
      selectRange(dn, flatDNs);
    } else if (e.ctrlKey || e.metaKey) {
      toggleSelectNode(dn, true);
    } else {
      toggleSelectNode(dn, false);
    }
  }, [flatDNs, selectRange, toggleSelectNode]);

  const treeContainerRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => treeContainerRef.current,
    estimateSize: () => 22, // matches h-[22px] row height
    overscan: 20,
  });

  // Scroll to the selected node when it changes (e.g. after locateInTree)
  const selectionAnchor = useTreeStore((s) => s.selectionAnchor);
  const scrollTargetRef = useRef<string | null>(null);

  // Track when selection anchor changes - set a scroll target
  useEffect(() => {
    if (selectionAnchor) {
      scrollTargetRef.current = selectionAnchor;
    }
  }, [selectionAnchor]);

  // Attempt scroll whenever flatRows changes and we have a pending scroll target
  useEffect(() => {
    const target = scrollTargetRef.current;
    if (!target) return;

    const idx = flatRows.findIndex(r => r.node.dn === target);
    if (idx >= 0) {
      // Clear target since we found the node
      scrollTargetRef.current = null;
      // Double-rAF to ensure the virtualizer has processed the new row count
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          virtualizer.scrollToIndex(idx, { align: 'center' });
        });
      });
    }
  }, [flatRows]);

  if (!isConnected) {
    return (
      <div className="h-full flex flex-col bg-sidebar">
        <div className="flex items-center px-4 h-9 shrink-0 border-b border-border">
          <span className="text-xs font-semibold uppercase tracking-wider text-secondary-foreground">
            Explorer
          </span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4">
          <FolderTree size={48} strokeWidth={1} className="mb-4 opacity-40" />
          <p className="text-sm text-center">Connect to a server to browse</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-sidebar">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-9 shrink-0 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-secondary-foreground truncate">
          {activeProfile?.name || 'Explorer'}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => {
              setShowTreeFilter(!showTreeFilter);
              if (showTreeFilter) {
                setTreeFilter('');
                setSearchResults([]);
                setSearchDone(false);
              }
            }}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0"
            title="Filter (Ctrl+F)"
          >
            <Search size={14} />
          </button>
          <button
            onClick={() => {
              const modes: TreeSortMode[] = ['default', 'alpha', 'type'];
              const idx = modes.indexOf(treeSortMode);
              setTreeSortMode(modes[(idx + 1) % modes.length]);
            }}
            className={cn(
              'p-1 rounded hover:bg-accent hover:text-foreground shrink-0',
              treeSortMode !== 'default' ? 'text-primary' : 'text-muted-foreground'
            )}
            title={`Sort: ${SORT_MODE_LABELS[treeSortMode]} (click to cycle)`}
          >
            <ArrowUpDown size={14} />
          </button>
          <button
            onClick={() => {
              // Collapse all expanded nodes
              useTreeStore.setState({ expandedNodes: new Set<string>() });
            }}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0"
            title="Collapse All"
          >
            <ChevronsDownUp size={14} />
          </button>
          <button
            onClick={handleRefresh}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Tree Filter */}
      {showTreeFilter && (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-card">
          {searchLoading ? (
            <Loader2 size={12} className="animate-spin text-primary shrink-0" />
          ) : (
            <Search size={12} className="text-muted-foreground shrink-0" />
          )}
          <input
            type="text"
            value={treeFilter}
            onChange={e => setTreeFilter(e.target.value)}
            placeholder="Search entries..."
            className="flex-1 text-xs bg-transparent border-none outline-none placeholder:text-muted-foreground/50"
            autoFocus
          />
          {treeFilter && (
            <button
              onClick={() => setTreeFilter('')}
              className="p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {/* Server Search Results */}
      {showTreeFilter && treeFilter.length >= 2 && (searchLoading || searchDone) && (
        <div className="border-b border-border bg-card/50 max-h-[50%] overflow-auto">
          {searchLoading && searchResults.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" />
              Searching directory...
            </div>
          ) : searchDone && searchResults.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No results found
            </div>
          ) : (
            <>
              <div className="px-3 py-1 text-[10px] text-muted-foreground border-b border-border/50">
                {searchResults.length} result{searchResults.length !== 1 ? 's' : ''} across {allDomainBaseDNs.length} domain{allDomainBaseDNs.length !== 1 ? 's' : ''}
              </div>
              {searchResults.map((entry) => {
                const rdn = entry.dn.split(',')[0] || entry.dn;
                const objectClasses = entry.attributes?.find(a => a.name === 'objectClass')?.values || [];
                const displayName = entry.attributes?.find(a => a.name === 'displayName')?.values?.[0]
                  || entry.attributes?.find(a => a.name === 'cn')?.values?.[0];
                const Icon = getIconForObjectClass(objectClasses);
                const iconColor = getIconColor(objectClasses);
                return (
                  <div
                    key={entry.dn}
                    className="flex items-center hover:bg-accent/50 group"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      toggleSelectNode(entry.dn, false);
                      setContextMenu({ x: e.clientX, y: e.clientY, dn: entry.dn });
                    }}
                  >
                    <button
                      onClick={() => handleOpenEntry(entry.dn)}
                      className="flex-1 flex items-center gap-1.5 px-3 py-1 text-left min-w-0"
                      title={entry.dn}
                    >
                      <Icon size={13} className={cn('shrink-0', iconColor)} />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs truncate">
                          {displayName || rdn}
                        </div>
                        <div className="text-[10px] text-muted-foreground truncate">
                          {entry.dn}
                        </div>
                      </div>
                    </button>
                    <button
                      onClick={async () => {
                        if (!activeProfileId) return;
                        setShowTreeFilter(false);
                        setTreeFilter('');
                        setSearchResults([]);
                        setSearchDone(false);
                        await locateInTree(activeProfileId, entry.dn);
                      }}
                      className="p-1 mr-1 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      title="Show in Tree"
                    >
                      <Crosshair size={11} />
                    </button>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      {/* Tree Content (virtualized) */}
      <div ref={treeContainerRef} className="flex-1 overflow-auto">
        {isRootLoading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <RefreshCw size={16} className="animate-spin mr-2" />
            <span className="text-xs">Loading...</span>
          </div>
        ) : nodes.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">
            No entries found
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const { node, depth } = flatRows[virtualRow.index];
              const children = childNodes[node.dn] || [];
              const isInSelection = selectedNodes.has(node.dn);
              return (
                <div
                  key={node.dn}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: 22,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <TreeNodeRow
                    node={node}
                    depth={depth}
                    isExpanded={expandedNodes.has(node.dn)}
                    isSelected={isInSelection && selectionCount === 1}
                    isMultiSelected={isInSelection && selectionCount > 1}
                    isLoading={loading[node.dn] || false}
                    childCount={children.length}
                    onToggle={() => activeProfileId && toggleExpand(activeProfileId, node.dn)}
                    onSelect={(e) => handleNodeSelect(node.dn, e)}
                    onDoubleClick={() => handleOpenEntry(node.dn)}
                    onContextMenu={(e) => {
                      // If right-clicking on a node not in the selection, select it alone
                      if (!selectedNodes.has(node.dn)) {
                        toggleSelectNode(node.dn, false);
                      }
                      setContextMenu({ x: e.clientX, y: e.clientY, dn: node.dn });
                    }}
                    onDrop={isReadOnly ? undefined : handleDrop}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Batch Action Bar */}
      {selectionCount > 1 && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-t border-border bg-card shrink-0">
          <span className="text-[11px] text-muted-foreground font-medium mr-auto">
            {selectionCount} selected
          </span>
          <button
            onClick={() => handleBatchCopyDNs(selectedDNsArray)}
            className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-border hover:bg-accent text-foreground"
            title="Copy all selected DNs to clipboard"
          >
            <Copy size={12} />
            Copy DNs
          </button>
          <button
            onClick={() => handleBatchExport(selectedDNsArray)}
            className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-border hover:bg-accent text-foreground"
            title="Export selected entries as LDIF"
          >
            <Download size={12} />
            Export
          </button>
          {!isReadOnly && (
            <button
              onClick={() => handleBatchDelete(selectedDNsArray)}
              className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-border hover:bg-red-900/30 text-destructive"
              title="Delete all selected entries"
            >
              <Trash2 size={12} />
              Delete
            </button>
          )}
          <button
            onClick={clearSelection}
            className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
            title="Clear selection"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <TreeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          dn={contextMenu.dn}
          selectedDNs={selectedDNsArray}
          onClose={() => setContextMenu(null)}
          onEditEntry={() => { setEditEntryDN(contextMenu.dn); setContextMenu(null); }}
          onNewChild={() => { setNewEntryParentDN(contextMenu.dn); setContextMenu(null); }}
          onDelete={() => { handleDelete(contextMenu.dn); setContextMenu(null); }}
          onRename={() => { setRenameEntryDN(contextMenu.dn); setContextMenu(null); }}
          onCopyEntry={() => {
            if (isReadOnly) { toast.error('Connection is read-only'); return; }
            setCopyEntryDN(contextMenu.dn); setContextMenu(null);
          }}
          onCopyDN={(dn) => { navigator.clipboard.writeText(dn); toast.info('DN copied'); }}
          onExport={() => { setExportDN(contextMenu.dn); setContextMenu(null); }}
          onRefresh={(dn) => { activeProfileId && refreshNode(activeProfileId, dn); setContextMenu(null); }}
          onChangePassword={(dn) => { setPasswordDN(dn); setContextMenu(null); }}
          onBookmark={(dn) => {
            if (activeProfileId) {
              if (isBookmarked(activeProfileId, dn)) {
                removeBookmark(activeProfileId, dn);
                toast.info('Bookmark removed');
              } else {
                addBookmark(activeProfileId, dn);
                toast.info('Bookmark added');
              }
            }
            setContextMenu(null);
          }}
          onCompare={(dn) => { setCompareDN(dn); setContextMenu(null); }}
          onStatistics={(dn) => { setStatisticsDN(dn); setContextMenu(null); }}
          isBookmarked={activeProfileId ? isBookmarked(activeProfileId, contextMenu.dn) : false}
          onBatchCopyDNs={(dns) => { handleBatchCopyDNs(dns); setContextMenu(null); }}
          onBatchExport={(dns) => { handleBatchExport(dns); setContextMenu(null); }}
          onBatchDelete={!isReadOnly ? ((dns) => { handleBatchDelete(dns); setContextMenu(null); }) : undefined}
          onBatchModify={!isReadOnly ? ((dns) => { setBatchDialog({ open: true, mode: 'modify' }); setContextMenu(null); }) : undefined}
          onBatchMove={!isReadOnly ? ((dns) => { setBatchDialog({ open: true, mode: 'move' }); setContextMenu(null); }) : undefined}
        />
      )}

      {/* Compare Dialog */}
      {compareDN && (
        <CompareDialog
          dn={compareDN}
          onClose={() => setCompareDN(null)}
        />
      )}

      {/* Statistics Dialog */}
      {statisticsDN && (
        <StatisticsDialog
          dn={statisticsDN}
          onClose={() => setStatisticsDN(null)}
        />
      )}

      {/* Edit Entry Dialog */}
      {editEntryDN && (
        <EditEntryDialog
          dn={editEntryDN}
          onClose={() => setEditEntryDN(null)}
          onSaved={() => {
            if (activeProfileId) {
              // Refresh the entry in the editor if it's open
              const editorStore = useEditorStore.getState();
              const tabId = `${activeProfileId}:${editEntryDN}`;
              if (editorStore.tabs.find(t => t.id === tabId)) {
                editorStore.refreshEntry(activeProfileId, editEntryDN);
              }
              // Refresh the parent node in the tree
              const parentDN = editEntryDN.split(',').slice(1).join(',');
              if (parentDN) refreshNode(activeProfileId, parentDN);
            }
          }}
        />
      )}

      {/* New Entry Dialog */}
      {newEntryParentDN && (
        <NewEntryDialog
          parentDN={newEntryParentDN}
          onClose={() => setNewEntryParentDN(null)}
          onCreated={() => {
            if (activeProfileId) refreshNode(activeProfileId, newEntryParentDN);
          }}
        />
      )}

      {/* Rename Dialog */}
      {renameEntryDN && (
        <RenameEntryDialog
          dn={renameEntryDN}
          onClose={() => setRenameEntryDN(null)}
          onRenamed={() => {
            if (activeProfileId) {
              const parentDN = renameEntryDN.split(',').slice(1).join(',');
              if (parentDN) refreshNode(activeProfileId, parentDN);
              else loadRootNodes(activeProfileId);
            }
          }}
        />
      )}

      {/* Copy Entry Dialog */}
      {copyEntryDN && (
        <CopyEntryDialog
          sourceDN={copyEntryDN}
          onClose={() => setCopyEntryDN(null)}
          onCopied={() => {
            if (activeProfileId) {
              const parentDN = copyEntryDN.split(',').slice(1).join(',');
              if (parentDN) refreshNode(activeProfileId, parentDN);
              else loadRootNodes(activeProfileId);
            }
          }}
        />
      )}

      {/* Export Dialog */}
      {exportDN && (
        <ExportDialog
          dn={exportDN}
          onClose={() => setExportDN(null)}
        />
      )}

      {/* Password Dialog */}
      {passwordDN && (
        <PasswordDialog
          dn={passwordDN}
          onClose={() => setPasswordDN(null)}
          onChanged={() => {
            if (activeProfileId) {
              const editorStore = useEditorStore.getState();
              const tabId = `${activeProfileId}:${passwordDN}`;
              if (editorStore.tabs.find(t => t.id === tabId)) {
                editorStore.refreshEntry(activeProfileId, passwordDN);
              }
            }
          }}
        />
      )}

      {/* Delete Confirmation (single entry) */}
      {deleteDN && (
        <ConfirmDialog
          title="Delete Entry"
          message="Are you sure you want to delete this entry? This action cannot be undone."
          detail={deleteDN}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={() => handleDeleteConfirmed(deleteDN)}
          onCancel={() => setDeleteDN(null)}
        />
      )}

      {/* Delete Confirmation (batch) */}
      {batchDeleteDNs && (
        <ConfirmDialog
          title={`Delete ${batchDeleteDNs.length} Entries`}
          message={`Are you sure you want to delete ${batchDeleteDNs.length} entries? This action cannot be undone.`}
          detail={batchDeleteDNs.join('\n')}
          confirmLabel={`Delete ${batchDeleteDNs.length} entries`}
          variant="danger"
          onConfirm={() => handleBatchDeleteConfirmed(batchDeleteDNs)}
          onCancel={() => setBatchDeleteDNs(null)}
        />
      )}

      {/* Batch Operation Dialog */}
      {batchDialog.open && activeProfileId && (
        <BatchOperationDialog
          isOpen={batchDialog.open}
          onClose={() => {
            setBatchDialog({ open: false, mode: 'delete' });
            // Refresh tree after batch operations
            if (activeProfileId) {
              loadRootNodes(activeProfileId);
            }
            clearSelection();
          }}
          selectedDNs={selectedDNsArray}
          profileID={activeProfileId}
          initialMode={batchDialog.mode}
        />
      )}
    </div>
  );
}
