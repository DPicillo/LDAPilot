import { ChevronRight, ChevronDown, Loader2 } from 'lucide-react'
import { TreeNode } from '../../types/ldap'
import { getIconForHint, getIconForObjectClass } from '../../lib/ldap-icons'
import { cn } from '../../lib/utils'

interface TreeNodeItemProps {
  node: TreeNode;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  isLoading: boolean;
  children: TreeNode[];
  onToggle: () => void;
  onSelect: () => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  renderChildren: (children: TreeNode[], depth: number) => React.ReactNode;
}

export function TreeNodeItem({
  node,
  depth,
  isExpanded,
  isSelected,
  isLoading,
  children,
  onToggle,
  onSelect,
  onDoubleClick,
  onContextMenu,
  renderChildren,
}: TreeNodeItemProps) {
  const Icon = node.icon
    ? getIconForHint(node.icon)
    : getIconForObjectClass(node.objectClass || []);

  const paddingLeft = 12 + depth * 16;

  return (
    <div>
      <div
        className={cn(
          'flex items-center h-[22px] cursor-pointer select-none group',
          'hover:bg-accent/50',
          isSelected && 'bg-accent text-accent-foreground'
        )}
        style={{ paddingLeft }}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
          if (node.hasChildren) onToggle();
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onDoubleClick();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSelect();
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

        {/* Icon */}
        <Icon size={14} className="shrink-0 mr-1.5 text-muted-foreground" />

        {/* Label */}
        <span className="text-sm truncate">{node.rdn || node.dn}</span>
      </div>

      {/* Children */}
      {isExpanded && children.length > 0 && (
        <div>{renderChildren(children, depth + 1)}</div>
      )}
    </div>
  );
}
