import { useEffect, useState, useCallback, useMemo } from 'react'
import { RefreshCw, FolderTree, Search, X, ChevronsUpDown, ChevronsDownUp } from 'lucide-react'
import { useTreeStore } from '../../stores/treeStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { TreeNode } from '../../types/ldap'
import { TreeNodeItem } from './TreeNodeItem'
import { TreeContextMenu } from './TreeContextMenu'
import { NewEntryDialog } from '../editor/NewEntryDialog'
import { EditEntryDialog } from '../editor/EditEntryDialog'
import { RenameEntryDialog } from '../editor/RenameEntryDialog'
import { PasswordDialog } from '../editor/PasswordDialog'
import { ExportDialog } from '../export/ExportDialog'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { useBookmarkStore } from '../../stores/bookmarkStore'
import * as wails from '../../lib/wails'
import { toast } from '../ui/Toast'

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
    rootNodes, childNodes, expandedNodes, selectedNode, loading,
    loadRootNodes, toggleExpand, selectNode, refreshNode,
  } = useTreeStore();
  const openEntry = useEditorStore((s) => s.openEntry);
  const { addBookmark, removeBookmark, isBookmarked } = useBookmarkStore();

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [newEntryParentDN, setNewEntryParentDN] = useState<string | null>(null);
  const [editEntryDN, setEditEntryDN] = useState<string | null>(null);
  const [renameEntryDN, setRenameEntryDN] = useState<string | null>(null);
  const [exportDN, setExportDN] = useState<string | null>(null);
  const [deleteDN, setDeleteDN] = useState<string | null>(null);
  const [passwordDN, setPasswordDN] = useState<string | null>(null);
  const [treeFilter, setTreeFilter] = useState('');
  const [showTreeFilter, setShowTreeFilter] = useState(false);

  const isConnected = activeProfileId ? connectionStatuses[activeProfileId] === true : false;
  const activeProfile = activeProfileId ? profiles.find((p) => p.id === activeProfileId) : null;
  const isReadOnly = activeProfile?.readOnly ?? false;
  const nodes = activeProfileId ? (rootNodes[activeProfileId] || []) : [];
  const isRootLoading = activeProfileId ? loading[`root:${activeProfileId}`] : false;

  useEffect(() => {
    if (activeProfileId && isConnected && !rootNodes[activeProfileId]) {
      loadRootNodes(activeProfileId);
    }
  }, [activeProfileId, isConnected, loadRootNodes, rootNodes]);

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

  const renderNodes = useCallback((nodeList: TreeNode[], depth: number) => {
    const filtered = filterLower
      ? nodeList.filter(n => n.rdn?.toLowerCase().includes(filterLower) || n.dn.toLowerCase().includes(filterLower))
      : nodeList;
    return filtered.map((node) => (
      <TreeNodeItem
        key={node.dn}
        node={node}
        depth={depth}
        isExpanded={expandedNodes.has(node.dn)}
        isSelected={selectedNode === node.dn}
        isLoading={loading[node.dn] || false}
        children={childNodes[node.dn] || []}
        onToggle={() => activeProfileId && toggleExpand(activeProfileId, node.dn)}
        onSelect={() => selectNode(node.dn)}
        onDoubleClick={() => handleOpenEntry(node.dn)}
        onContextMenu={(e) => setContextMenu({ x: e.clientX, y: e.clientY, dn: node.dn })}
        onDrop={isReadOnly ? undefined : handleDrop}
        renderChildren={renderNodes}
      />
    ));
  }, [expandedNodes, selectedNode, loading, childNodes, activeProfileId, toggleExpand, selectNode, handleOpenEntry, filterLower, isReadOnly, handleDrop]);

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
            onClick={() => { setShowTreeFilter(!showTreeFilter); if (showTreeFilter) setTreeFilter(''); }}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0"
            title="Filter (Ctrl+F)"
          >
            <Search size={14} />
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
          <Search size={12} className="text-muted-foreground shrink-0" />
          <input
            type="text"
            value={treeFilter}
            onChange={e => setTreeFilter(e.target.value)}
            placeholder="Filter visible nodes..."
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

      {/* Tree Content */}
      <div className="flex-1 overflow-auto py-1">
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
          renderNodes(nodes, 0)
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <TreeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          dn={contextMenu.dn}
          onClose={() => setContextMenu(null)}
          onEditEntry={() => { setEditEntryDN(contextMenu.dn); setContextMenu(null); }}
          onNewChild={() => { setNewEntryParentDN(contextMenu.dn); setContextMenu(null); }}
          onDelete={() => { handleDelete(contextMenu.dn); setContextMenu(null); }}
          onRename={() => { setRenameEntryDN(contextMenu.dn); setContextMenu(null); }}
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
          isBookmarked={activeProfileId ? isBookmarked(activeProfileId, contextMenu.dn) : false}
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

      {/* Delete Confirmation */}
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
    </div>
  );
}
