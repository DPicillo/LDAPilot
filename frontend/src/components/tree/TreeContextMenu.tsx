import { useEffect, useRef } from 'react'
import { FolderPlus, Trash2, Type, Copy, Download, RefreshCw, Pencil, ClipboardCopy, KeyRound, Star } from 'lucide-react'

interface TreeContextMenuProps {
  x: number;
  y: number;
  dn: string;
  onClose: () => void;
  onNewChild: (parentDN: string) => void;
  onEditEntry: (dn: string) => void;
  onDelete: (dn: string) => void;
  onRename: (dn: string) => void;
  onCopyDN: (dn: string) => void;
  onExport: (dn: string) => void;
  onRefresh: (dn: string) => void;
  onChangePassword?: (dn: string) => void;
  onBookmark?: (dn: string) => void;
  isBookmarked?: boolean;
}

interface MenuItem {
  label: string;
  icon: React.ElementType;
  action: () => void;
  destructive?: boolean;
  separator?: boolean;
}

export function TreeContextMenu({
  x, y, dn, onClose, onNewChild, onEditEntry, onDelete, onRename, onCopyDN, onExport, onRefresh,
  onChangePassword, onBookmark, isBookmarked,
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

  const rdn = dn.split(',')[0] || dn;

  const items: MenuItem[] = [
    { label: 'Edit Entry', icon: Pencil, action: () => onEditEntry(dn) },
    { label: 'New Child Entry', icon: FolderPlus, action: () => onNewChild(dn), separator: true },
    { label: 'Rename / Move', icon: Type, action: () => onRename(dn) },
    ...(onChangePassword ? [{ label: 'Change Password', icon: KeyRound, action: () => onChangePassword(dn) } as MenuItem] : []),
    ...(onBookmark ? [{ label: isBookmarked ? 'Remove Bookmark' : 'Bookmark', icon: Star, action: () => onBookmark(dn) } as MenuItem] : []),
    { label: 'Copy DN', icon: Copy, action: () => onCopyDN(dn), separator: true },
    { label: 'Copy RDN', icon: ClipboardCopy, action: () => { navigator.clipboard.writeText(rdn); } },
    { label: 'Export LDIF', icon: Download, action: () => onExport(dn), separator: true },
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
