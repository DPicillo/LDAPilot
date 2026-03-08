import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { AlertTriangle, ArrowUpDown, Copy, Check, Download, Pencil, Trash2, Star } from 'lucide-react'
import { useSearchStore } from '../../stores/searchStore'
import { useEditorStore } from '../../stores/editorStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useBookmarkStore } from '../../stores/bookmarkStore'
import { getIconForObjectClass, getIconColor } from '../../lib/ldap-icons'
import { LDAPEntry } from '../../types/ldap'
import { cn } from '../../lib/utils'
import { toast } from '../ui/Toast'

type SortKey = 'dn' | 'objectClass';
type SortDir = 'asc' | 'desc';

export function SearchResults() {
  const results = useSearchStore((s) => s.results);
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const openEntry = useEditorStore((s) => s.openEntry);
  const [sortKey, setSortKey] = useState<SortKey>('dn');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [copiedDN, setCopiedDN] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; dn: string } | null>(null);
  const { addBookmark, isBookmarked } = useBookmarkStore();

  const handleSort = useCallback((key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }, [sortKey]);

  const sortedEntries = useMemo(() => {
    if (!results?.entries) return [];
    return [...results.entries].sort((a, b) => {
      let aVal: string, bVal: string;
      if (sortKey === 'dn') {
        aVal = a.dn;
        bVal = b.dn;
      } else {
        aVal = getOC(a).join(',');
        bVal = getOC(b).join(',');
      }
      const cmp = aVal.localeCompare(bVal);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [results?.entries, sortKey, sortDir]);

  const handleCopyDN = useCallback((dn: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(dn);
    setCopiedDN(dn);
    setTimeout(() => setCopiedDN(null), 1200);
  }, []);

  if (!results) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-xs">
        Run a search to see results
      </div>
    );
  }

  if (results.entries.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-xs">
        No entries found
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Results Header */}
      <div className="flex items-center justify-between px-3 py-1 border-b border-border bg-card shrink-0">
        <span className="text-xs text-muted-foreground">
          {results.totalCount} result{results.totalCount !== 1 ? 's' : ''}
          {results.truncated && (
            <span className="ml-2 text-yellow-400 inline-flex items-center gap-1">
              <AlertTriangle size={10} />
              truncated (size limit reached)
            </span>
          )}
        </span>
      </div>

      {/* Results Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card z-10">
            <tr className="border-b border-border">
              <th
                className="text-left px-3 py-1.5 font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none"
                onClick={() => handleSort('dn')}
              >
                <span className="flex items-center gap-1">
                  DN
                  <ArrowUpDown size={10} className={sortKey === 'dn' ? 'text-primary' : ''} />
                </span>
              </th>
              <th
                className="text-left px-3 py-1.5 font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none w-48"
                onClick={() => handleSort('objectClass')}
              >
                <span className="flex items-center gap-1">
                  Object Classes
                  <ArrowUpDown size={10} className={sortKey === 'objectClass' ? 'text-primary' : ''} />
                </span>
              </th>
              <th className="w-8 px-1"></th>
            </tr>
          </thead>
          <tbody>
            {sortedEntries.map((entry) => {
              const objectClasses = getOC(entry);
              const Icon = getIconForObjectClass(objectClasses);
              const iconColor = getIconColor(objectClasses);
              const isCopied = copiedDN === entry.dn;
              return (
                <tr
                  key={entry.dn}
                  className="border-b border-border hover:bg-accent/30 cursor-pointer group"
                  onClick={() => activeProfileId && openEntry(activeProfileId, entry.dn)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, dn: entry.dn });
                  }}
                >
                  <td className="px-3 py-1 font-mono">
                    <div className="flex items-center gap-1.5">
                      <Icon size={13} className={cn('shrink-0', iconColor)} />
                      <span className="truncate" title={entry.dn}>{entry.dn}</span>
                    </div>
                  </td>
                  <td className="px-3 py-1 text-muted-foreground">
                    <div className="flex flex-wrap gap-0.5">
                      {objectClasses.filter(oc => oc !== 'top').slice(0, 3).map(oc => (
                        <span key={oc} className="px-1 py-0 bg-accent/50 rounded text-[9px]">
                          {oc}
                        </span>
                      ))}
                      {objectClasses.filter(oc => oc !== 'top').length > 3 && (
                        <span className="text-[9px] text-muted-foreground">+{objectClasses.length - 4}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-1 py-1">
                    <button
                      onClick={(e) => handleCopyDN(entry.dn, e)}
                      className="p-0.5 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Copy DN"
                    >
                      {isCopied ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <SearchContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          dn={contextMenu.dn}
          onClose={() => setContextMenu(null)}
          onOpen={() => {
            if (activeProfileId) openEntry(activeProfileId, contextMenu.dn);
            setContextMenu(null);
          }}
          onCopyDN={() => {
            navigator.clipboard.writeText(contextMenu.dn);
            toast.info('DN copied');
            setContextMenu(null);
          }}
          onBookmark={() => {
            if (activeProfileId) {
              addBookmark(activeProfileId, contextMenu.dn);
              toast.info('Bookmark added');
            }
            setContextMenu(null);
          }}
          isBookmarked={activeProfileId ? isBookmarked(activeProfileId, contextMenu.dn) : false}
        />
      )}
    </div>
  );
}

function SearchContextMenu({ x, y, dn, onClose, onOpen, onCopyDN, onBookmark, isBookmarked: bookmarked }: {
  x: number;
  y: number;
  dn: string;
  onClose: () => void;
  onOpen: () => void;
  onCopyDN: () => void;
  onBookmark: () => void;
  isBookmarked: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
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

  const menuWidth = 180;
  const menuHeight = 120;
  const adjustedX = x + menuWidth > window.innerWidth ? x - menuWidth : x;
  const adjustedY = y + menuHeight > window.innerHeight ? y - menuHeight : y;

  const items = [
    { label: 'Open Entry', icon: Pencil, action: onOpen },
    { label: 'Copy DN', icon: Copy, action: onCopyDN },
    { label: bookmarked ? 'Bookmarked' : 'Bookmark', icon: Star, action: onBookmark },
  ];

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-popover border border-border rounded shadow-xl py-1 min-w-[160px]"
      style={{ left: adjustedX, top: adjustedY }}
      onClick={e => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <button
          key={i}
          className="w-full flex items-center gap-2 px-3 py-1 text-xs hover:bg-accent text-popover-foreground"
          onClick={item.action}
        >
          <item.icon size={12} />
          {item.label}
        </button>
      ))}
    </div>
  );
}

function getOC(entry: LDAPEntry): string[] {
  return entry.attributes?.find(a => a.name.toLowerCase() === 'objectclass')?.values || [];
}
