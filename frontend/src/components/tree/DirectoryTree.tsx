import { useEffect, useState, useCallback } from 'react'
import { RefreshCw, FolderTree } from 'lucide-react'
import { useTreeStore } from '../../stores/treeStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { TreeNode } from '../../types/ldap'
import { TreeNodeItem } from './TreeNodeItem'
import { TreeContextMenu } from './TreeContextMenu'
import { NewEntryDialog } from '../editor/NewEntryDialog'
import { ExportDialog } from '../export/ExportDialog'
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

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [newEntryParentDN, setNewEntryParentDN] = useState<string | null>(null);
  const [exportDN, setExportDN] = useState<string | null>(null);

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

  async function handleDelete(dn: string) {
    if (isReadOnly) {
      toast.error('Connection is read-only');
      return;
    }
    if (!activeProfileId || !confirm(`Delete entry "${dn}"?`)) return;
    try {
      await wails.DeleteEntry(activeProfileId, dn);
      toast.success(`Entry "${dn}" deleted`);
      // Refresh parent
      const parentDN = dn.split(',').slice(1).join(',');
      if (parentDN) {
        refreshNode(activeProfileId, parentDN);
      } else {
        loadRootNodes(activeProfileId);
      }
    } catch (err: any) {
      toast.error(err?.message || 'Failed to delete entry');
    }
  }

  const renderNodes = useCallback((nodeList: TreeNode[], depth: number) => {
    return nodeList.map((node) => (
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
        renderChildren={renderNodes}
      />
    ));
  }, [expandedNodes, selectedNode, loading, childNodes, activeProfileId, toggleExpand, selectNode, handleOpenEntry]);

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
        <button
          onClick={handleRefresh}
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0"
          title="Refresh"
        >
          <RefreshCw size={14} />
        </button>
      </div>

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
          onNewChild={() => { setNewEntryParentDN(contextMenu.dn); setContextMenu(null); }}
          onDelete={() => { handleDelete(contextMenu.dn); setContextMenu(null); }}
          onRename={() => { setContextMenu(null); }}
          onCopyDN={(dn) => { navigator.clipboard.writeText(dn); toast.info('DN copied'); }}
          onExport={() => { setExportDN(contextMenu.dn); setContextMenu(null); }}
          onRefresh={(dn) => { activeProfileId && refreshNode(activeProfileId, dn); setContextMenu(null); }}
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

      {/* Export Dialog */}
      {exportDN && (
        <ExportDialog
          dn={exportDN}
          onClose={() => setExportDN(null)}
        />
      )}
    </div>
  );
}
