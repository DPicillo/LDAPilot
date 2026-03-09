import { useState, useCallback, memo } from 'react'
import { ChevronRight, ChevronDown, Loader2 } from 'lucide-react'
import { TreeNode } from '../../types/ldap'
import { getIconForHint, getIconForObjectClass, getIconColor } from '../../lib/ldap-icons'
import { cn } from '../../lib/utils'

interface TreeNodeRowProps {
  node: TreeNode;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  isMultiSelected: boolean;
  isLoading: boolean;
  childCount: number;
  onToggle: () => void;
  onSelect: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDrop?: (sourceDN: string, targetDN: string) => void;
}

export const TreeNodeRow = memo(function TreeNodeRow({
  node,
  depth,
  isExpanded,
  isSelected,
  isMultiSelected,
  isLoading,
  childCount,
  onToggle,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onDrop,
}: TreeNodeRowProps) {
  const Icon = node.icon
    ? getIconForHint(node.icon)
    : getIconForObjectClass(node.objectClass || []);
  const iconColor = getIconColor(node.objectClass || []);
  const [dragOver, setDragOver] = useState(false);

  const paddingLeft = 12 + depth * 16;

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', node.dn);
    e.dataTransfer.effectAllowed = 'move';
  }, [node.dn]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (node.hasChildren) {
      e.dataTransfer.dropEffect = 'move';
      setDragOver(true);
    }
  }, [node.hasChildren]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDropEvent = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const sourceDN = e.dataTransfer.getData('text/plain');
    if (sourceDN && sourceDN !== node.dn && onDrop) {
      if (!sourceDN.endsWith(',' + node.dn) && !node.dn.endsWith(',' + sourceDN)) {
        onDrop(sourceDN, node.dn);
      }
    }
  }, [node.dn, onDrop]);

  return (
    <div
      className={cn(
        'flex items-center h-[22px] cursor-pointer select-none group',
        'hover:bg-accent/50',
        isSelected && 'bg-accent text-accent-foreground',
        !isSelected && isMultiSelected && 'bg-accent/60 text-accent-foreground',
        dragOver && 'bg-primary/20 outline outline-1 outline-primary/50'
      )}
      style={{ paddingLeft }}
      draggable
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDropEvent}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(e);
        // Only toggle expand on plain clicks (no Ctrl/Shift)
        if (node.hasChildren && !e.ctrlKey && !e.metaKey && !e.shiftKey) onToggle();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect(e);
        onContextMenu(e);
      }}
    >
      {/* Expand/Collapse Arrow */}
      <span className="w-4 h-4 flex items-center justify-center shrink-0">
        {node.hasChildren ? (
          isLoading ? (
            <Loader2 size={12} className="animate-spin text-muted-foreground" />
          ) : isExpanded ? (
            <ChevronDown size={12} className="text-muted-foreground" />
          ) : (
            <ChevronRight size={12} className="text-muted-foreground" />
          )
        ) : null}
      </span>

      {/* Multi-select indicator */}
      {isMultiSelected && (
        <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 mr-0.5" />
      )}

      {/* Icon */}
      <Icon size={14} className={cn('shrink-0 mr-1.5', iconColor)} />

      {/* Label */}
      <span className="text-sm truncate" title={node.dn}>{node.rdn || node.dn}</span>

      {/* Child count badge */}
      {isExpanded && childCount > 0 && (
        <span className="ml-1 text-[9px] text-muted-foreground/60 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {childCount}
        </span>
      )}
    </div>
  );
});

// Keep the old export name for backwards compatibility with TreeContextMenu imports etc.
export { TreeNodeRow as TreeNodeItem };
