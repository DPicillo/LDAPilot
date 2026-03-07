import { useEffect, useRef } from 'react'
import { FolderPlus, Trash2, Type, Copy, Download, RefreshCw } from 'lucide-react'

interface TreeContextMenuProps {
  x: number;
  y: number;
  dn: string;
  onClose: () => void;
  onNewChild: (parentDN: string) => void;
  onDelete: (dn: string) => void;
  onRename: (dn: string) => void;
  onCopyDN: (dn: string) => void;
  onExport: (dn: string) => void;
  onRefresh: (dn: string) => void;
}

interface MenuItem {
  label: string;
  icon: React.ElementType;
  action: () => void;
  destructive?: boolean;
  separator?: boolean;
}

export function TreeContextMenu({
  x, y, dn, onClose, onNewChild, onDelete, onRename, onCopyDN, onExport, onRefresh,
}: TreeContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  const items: MenuItem[] = [
    { label: 'New Child Entry', icon: FolderPlus, action: () => onNewChild(dn) },
    { label: 'Rename', icon: Type, action: () => onRename(dn) },
    { label: 'Copy DN', icon: Copy, action: () => onCopyDN(dn), separator: true },
    { label: 'Export LDIF', icon: Download, action: () => onExport(dn) },
    { label: 'Refresh', icon: RefreshCw, action: () => onRefresh(dn), separator: true },
    { label: 'Delete', icon: Trash2, action: () => onDelete(dn), destructive: true },
  ];

  // Adjust position to stay within viewport
  const menuWidth = 200;
  const menuHeight = items.length * 28 + 8;
  const adjustedX = x + menuWidth > window.innerWidth ? x - menuWidth : x;
  const adjustedY = y + menuHeight > window.innerHeight ? y - menuHeight : y;

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-popover border border-border rounded shadow-xl py-1 min-w-[180px]"
      style={{ left: adjustedX, top: adjustedY }}
    >
      {items.map((item, i) => (
        <div key={i}>
          {item.separator && i > 0 && (
            <div className="h-px bg-border mx-2 my-1" />
          )}
          <button
            className={`w-full flex items-center gap-2 px-3 py-1 text-xs hover:bg-accent ${
              item.destructive ? 'text-destructive hover:text-destructive' : 'text-popover-foreground'
            }`}
            onClick={() => { item.action(); onClose(); }}
          >
            <item.icon size={14} />
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
