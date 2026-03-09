import { useEffect, useRef } from 'react'
import { FolderPlus, Trash2, Type, Copy, Download, RefreshCw, Pencil, ClipboardCopy, KeyRound, Star, CopyPlus, ArrowLeftRight, BarChart3, ArrowRightLeft } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'

interface TreeContextMenuProps {
  x: number;
  y: number;
  dn: string;
  /** All currently selected DNs (for batch context menu). */
  selectedDNs?: string[];
  onClose: () => void;
  onNewChild: (parentDN: string) => void;
  onEditEntry: (dn: string) => void;
  onDelete: (dn: string) => void;
  onRename: (dn: string) => void;
  onCopyEntry: (dn: string) => void;
  onCopyDN: (dn: string) => void;
  onExport: (dn: string) => void;
  onRefresh: (dn: string) => void;
  onChangePassword?: (dn: string) => void;
  onBookmark?: (dn: string) => void;
  onCompare?: (dn: string) => void;
  onStatistics?: (dn: string) => void;
  isBookmarked?: boolean;
  onBatchCopyDNs?: (dns: string[]) => void;
  onBatchExport?: (dns: string[]) => void;
  onBatchDelete?: (dns: string[]) => void;
  onBatchModify?: (dns: string[]) => void;
  onBatchMove?: (dns: string[]) => void;
}

interface MenuItem {
  label: string;
  icon: React.ElementType;
  action: () => void;
  destructive?: boolean;
  separator?: boolean;
}

export function TreeContextMenu({
  x, y, dn, selectedDNs, onClose, onNewChild, onEditEntry, onDelete, onRename, onCopyEntry, onCopyDN, onExport, onRefresh,
  onChangePassword, onBookmark, onCompare, onStatistics, isBookmarked,
  onBatchCopyDNs, onBatchExport, onBatchDelete, onBatchModify, onBatchMove,
}: TreeContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const zoomLevel = useUIStore((s) => s.zoomLevel);

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

  const isBatch = selectedDNs && selectedDNs.length > 1;
  const count = selectedDNs?.length || 1;
  const rdn = dn.split(',')[0] || dn;

  const items: MenuItem[] = isBatch
    ? [
        // Batch context menu
        { label: `Copy ${count} DNs`, icon: Copy, action: () => onBatchCopyDNs?.(selectedDNs!) },
        { label: `Export ${count} entries`, icon: Download, action: () => onBatchExport?.(selectedDNs!), separator: true },
        ...(onBatchModify ? [{ label: `Batch Modify...`, icon: Pencil, action: () => onBatchModify(selectedDNs!), separator: true } as MenuItem] : []),
        ...(onBatchMove ? [{ label: `Batch Move...`, icon: ArrowRightLeft, action: () => onBatchMove(selectedDNs!) } as MenuItem] : []),
        ...(onBatchDelete ? [{ label: `Delete ${count} entries`, icon: Trash2, action: () => onBatchDelete(selectedDNs!), destructive: true, separator: true } as MenuItem] : []),
      ]
    : [
        // Single-node context menu
        { label: 'Edit Entry', icon: Pencil, action: () => onEditEntry(dn) },
        { label: 'New Child Entry', icon: FolderPlus, action: () => onNewChild(dn), separator: true },
        { label: 'Rename / Move', icon: Type, action: () => onRename(dn) },
        { label: 'Copy Entry...', icon: CopyPlus, action: () => onCopyEntry(dn) },
        ...(onChangePassword ? [{ label: 'Change Password', icon: KeyRound, action: () => onChangePassword(dn) } as MenuItem] : []),
        ...(onBookmark ? [{ label: isBookmarked ? 'Remove Bookmark' : 'Bookmark', icon: Star, action: () => onBookmark(dn) } as MenuItem] : []),
        ...(onCompare ? [{ label: 'Compare with...', icon: ArrowLeftRight, action: () => onCompare(dn) } as MenuItem] : []),
        { label: 'Copy DN', icon: Copy, action: () => onCopyDN(dn), separator: true },
        { label: 'Copy RDN', icon: ClipboardCopy, action: () => { navigator.clipboard.writeText(rdn); } },
        { label: 'Export LDIF', icon: Download, action: () => onExport(dn), separator: true },
        ...(onStatistics ? [{ label: 'Statistics', icon: BarChart3, action: () => onStatistics(dn) } as MenuItem] : []),
        { label: 'Refresh', icon: RefreshCw, action: () => onRefresh(dn), separator: true },
        { label: 'Delete', icon: Trash2, action: () => onDelete(dn), destructive: true },
      ];

  // Adjust position to stay within viewport.
  // clientX/clientY are in viewport space but rendering happens inside the
  // zoom wrapper (transform: scale), so divide by zoomLevel to convert.
  const zoomedX = x / zoomLevel;
  const zoomedY = y / zoomLevel;
  const menuWidth = 200;
  const menuHeight = items.length * 28 + 8;
  const viewportW = window.innerWidth / zoomLevel;
  const viewportH = window.innerHeight / zoomLevel;
  const adjustedX = zoomedX + menuWidth > viewportW ? zoomedX - menuWidth : zoomedX;
  const adjustedY = zoomedY + menuHeight > viewportH ? zoomedY - menuHeight : zoomedY;

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-popover border border-border rounded shadow-xl py-1 min-w-[180px]"
      style={{ left: adjustedX, top: adjustedY }}
    >
      {isBatch && (
        <div className="px-3 py-1 text-[10px] text-muted-foreground border-b border-border mb-1">
          {count} entries selected
        </div>
      )}
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
