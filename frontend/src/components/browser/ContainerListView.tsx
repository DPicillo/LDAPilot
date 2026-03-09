/**
 * ContainerListView - Shows children of a selected container node
 * as a sortable, columnized list view (similar to Softerra/Windows Explorer).
 *
 * Displayed in the main panel when a container node is selected in the tree
 * and no editor tab is open.
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { ArrowUpDown, Loader2, Copy, Check, Pencil, Crosshair, Columns3, X, Plus, RefreshCw, FolderOpen, Star, Download, ClipboardCopy, Trash2 } from 'lucide-react'
import { useTreeStore } from '../../stores/treeStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { useUIStore } from '../../stores/uiStore'
import { useBookmarkStore } from '../../stores/bookmarkStore'
import { getIconForObjectClass, getIconColor } from '../../lib/ldap-icons'
import { TreeNode } from '../../types/ldap'
import { cn } from '../../lib/utils'
import * as wails from '../../lib/wails'
import { LDAPEntry } from '../../types/ldap'
import { toast } from '../ui/Toast'

const DEFAULT_COLUMNS = ['objectClass', 'description'];

const AVAILABLE_COLUMNS = [
  'objectClass', 'description', 'cn', 'sn', 'givenName', 'displayName',
  'mail', 'telephoneNumber', 'sAMAccountName', 'userPrincipalName',
  'title', 'department', 'company', 'ou', 'uid', 'whenCreated', 'whenChanged',
];

type SortKey = 'name' | string;
type SortDir = 'asc' | 'desc';

interface ContainerListViewProps {
  profileId: string;
  containerDN: string;
}

export function ContainerListView({ profileId, containerDN }: ContainerListViewProps) {
  const childNodes = useTreeStore((s) => s.childNodes[containerDN] || []);
  const loading = useTreeStore((s) => s.loading[containerDN] || false);
  const loadChildren = useTreeStore((s) => s.loadChildren);
  const openEntry = useEditorStore((s) => s.openEntry);
  const toggleExpand = useTreeStore((s) => s.toggleExpand);
  const locateInTree = useTreeStore((s) => s.locateInTree);
  const setActivity = useUIStore((s) => s.setActivity);
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const { addBookmark, isBookmarked } = useBookmarkStore();

  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [columns, setColumns] = useState<string[]>([...DEFAULT_COLUMNS]);
  const [showColumnChooser, setShowColumnChooser] = useState(false);
  const [columnFilter, setColumnFilter] = useState('');
  const [copiedDN, setCopiedDN] = useState<string | null>(null);
  const [selectedDN, setSelectedDN] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; dn: string } | null>(null);

  // Load detailed entries for column data
  const [entries, setEntries] = useState<Record<string, LDAPEntry>>({});
  const [loadingEntries, setLoadingEntries] = useState(false);

  // Load column data when children change
  useEffect(() => {
    if (childNodes.length === 0) return;
    const nonOCCols = columns.filter(c => c !== 'objectClass');
    if (nonOCCols.length === 0) return;

    async function loadEntryDetails() {
      setLoadingEntries(true);
      const newEntries: Record<string, LDAPEntry> = {};
      const dns = childNodes.map(n => n.dn);
      for (const dn of dns.slice(0, 200)) {
        try {
          const entry = await wails.GetEntry(profileId, dn);
          if (entry) {
            newEntries[dn] = entry;
          }
        } catch { /* skip failed entries */ }
      }
      setEntries(newEntries);
      setLoadingEntries(false);
    }

    loadEntryDetails();
  }, [childNodes.length, columns.join(','), profileId]);

  function getAttrValue(dn: string, attrName: string): string {
    const entry = entries[dn];
    if (!entry?.attributes) return '';
    const attr = entry.attributes.find(
      a => a.name.toLowerCase() === attrName.toLowerCase()
    );
    if (!attr?.values?.length) return '';
    return attr.values.join('; ');
  }

  function handleRefresh() {
    loadChildren(profileId, containerDN);
  }

  // Click on entry: select + open + focus in tree
  const handleEntryClick = useCallback(async (dn: string) => {
    setSelectedDN(dn);
    openEntry(profileId, dn);
    // Also locate in tree
    setActivity('explorer');
    if (!sidebarVisible) toggleSidebar();
    await locateInTree(profileId, dn);
  }, [profileId, openEntry, locateInTree, setActivity, sidebarVisible, toggleSidebar]);

  const handleSort = useCallback((key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }, [sortKey]);

  const handleCopyDN = useCallback((dn: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(dn);
    setCopiedDN(dn);
    setTimeout(() => setCopiedDN(null), 1200);
  }, []);

  const filteredColumnOptions = useMemo(() => {
    const allOptions = AVAILABLE_COLUMNS.filter(c => !columns.includes(c));
    if (!columnFilter) return allOptions;
    const lf = columnFilter.toLowerCase();
    return allOptions.filter(c => c.toLowerCase().includes(lf));
  }, [columnFilter, columns]);

  const sortedChildren = useMemo(() => {
    return [...childNodes].sort((a, b) => {
      let aVal: string, bVal: string;
      if (sortKey === 'name') {
        aVal = a.rdn || a.dn;
        bVal = b.rdn || b.dn;
      } else if (sortKey === 'objectClass') {
        aVal = (a.objectClass || []).filter((oc: string) => oc !== 'top').join(',');
        bVal = (b.objectClass || []).filter((oc: string) => oc !== 'top').join(',');
      } else {
        aVal = getAttrValue(a.dn, sortKey);
        bVal = getAttrValue(b.dn, sortKey);
      }
      const cmp = aVal.localeCompare(bVal);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [childNodes, sortKey, sortDir, entries]);

  const rdn = containerDN.split(',')[0] || containerDN;

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <FolderOpen size={16} className="text-yellow-400 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{rdn}</div>
            <div className="text-[10px] text-muted-foreground font-mono truncate">{containerDN}</div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-xs text-muted-foreground mr-2">
            {childNodes.length} item{childNodes.length !== 1 ? 's' : ''}
            {loadingEntries && <Loader2 size={10} className="animate-spin inline ml-1" />}
          </span>
          <button
            onClick={() => setShowColumnChooser(!showColumnChooser)}
            className={cn(
              'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors',
              showColumnChooser ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            )}
            title="Choose columns"
          >
            <Columns3 size={11} />
          </button>
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
            title="Refresh"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Column Chooser */}
      {showColumnChooser && (
        <div className="px-3 py-2 border-b border-border bg-card/80 space-y-2 shrink-0">
          <div className="flex flex-wrap gap-1">
            {columns.map(col => (
              <span
                key={col}
                className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 bg-primary/15 text-primary rounded-sm font-mono"
              >
                {col}
                <button onClick={() => setColumns(columns.filter(c => c !== col))} className="hover:text-destructive ml-0.5">
                  <X size={9} />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-1 items-center">
            <input
              type="text"
              value={columnFilter}
              onChange={(e) => setColumnFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && columnFilter.trim()) {
                  if (!columns.includes(columnFilter.trim())) {
                    setColumns([...columns, columnFilter.trim()]);
                  }
                  setColumnFilter('');
                }
              }}
              placeholder="Add column..."
              className="input-field text-xs flex-1 font-mono"
              autoFocus
            />
          </div>
          {filteredColumnOptions.length > 0 && (
            <div className="flex flex-wrap gap-0.5 max-h-20 overflow-auto">
              {filteredColumnOptions.map(col => (
                <button
                  key={col}
                  onClick={() => { setColumns([...columns, col]); setColumnFilter(''); }}
                  className="text-[10px] px-1.5 py-0.5 rounded-sm bg-accent/50 hover:bg-accent text-muted-foreground hover:text-foreground font-mono transition-colors"
                >
                  <Plus size={8} className="inline mr-0.5" />
                  {col}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={20} className="animate-spin text-muted-foreground" />
        </div>
      ) : childNodes.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">
          This container is empty
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card z-10">
              <tr className="border-b border-border">
                <th
                  className="text-left px-3 py-1.5 font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none"
                  onClick={() => handleSort('name')}
                  style={{ minWidth: 200 }}
                >
                  <span className="flex items-center gap-1">
                    Name
                    <ArrowUpDown size={10} className={sortKey === 'name' ? 'text-primary' : ''} />
                  </span>
                </th>
                {columns.map(col => (
                  <th
                    key={col}
                    className="text-left px-3 py-1.5 font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none"
                    onClick={() => handleSort(col)}
                    style={{ minWidth: 100 }}
                  >
                    <span className="flex items-center gap-1 font-mono text-[10px]">
                      {col}
                      <ArrowUpDown size={9} className={sortKey === col ? 'text-primary' : ''} />
                    </span>
                  </th>
                ))}
                <th className="w-16 px-1"></th>
              </tr>
            </thead>
            <tbody>
              {sortedChildren.map((node) => {
                const Icon = getIconForObjectClass(node.objectClass || []);
                const iconColor = getIconColor(node.objectClass || []);
                const isCopied = copiedDN === node.dn;
                const isSelected = selectedDN === node.dn;

                return (
                  <tr
                    key={node.dn}
                    className={cn(
                      'border-b border-border cursor-pointer group',
                      isSelected
                        ? 'bg-primary/10 hover:bg-primary/15'
                        : 'hover:bg-accent/30'
                    )}
                    onClick={() => handleEntryClick(node.dn)}
                    onDoubleClick={() => {
                      if (node.hasChildren) {
                        toggleExpand(profileId, node.dn);
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelectedDN(node.dn);
                      setContextMenu({ x: e.clientX, y: e.clientY, dn: node.dn });
                    }}
                  >
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <Icon size={14} className={cn('shrink-0', iconColor)} />
                        <span className="font-medium truncate" title={node.dn}>
                          {node.rdn || node.dn.split(',')[0]}
                        </span>
                        {node.hasChildren && (
                          <span className="text-[9px] text-muted-foreground bg-accent/60 px-1 rounded">
                            container
                          </span>
                        )}
                      </div>
                    </td>
                    {columns.map(col => (
                      <td key={col} className="px-3 py-1 text-muted-foreground max-w-[200px]">
                        {col === 'objectClass' ? (
                          <div className="flex flex-wrap gap-0.5">
                            {(node.objectClass || []).filter((oc: string) => oc !== 'top').slice(0, 2).map((oc: string) => (
                              <span key={oc} className="px-1 py-0 bg-accent/50 rounded text-[9px]">
                                {oc}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="truncate block" title={getAttrValue(node.dn, col)}>
                            {getAttrValue(node.dn, col) || <span className="opacity-30">—</span>}
                          </span>
                        )}
                      </td>
                    ))}
                    <td className="px-1 py-1">
                      <div className="flex items-center gap-0.5">
                        <button
                          onClick={(e) => { e.stopPropagation(); openEntry(profileId, node.dn); }}
                          className="p-0.5 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Edit Entry"
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          onClick={(e) => handleCopyDN(node.dn, e)}
                          className="p-0.5 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Copy DN"
                        >
                          {isCopied ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <ListContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          dn={contextMenu.dn}
          profileId={profileId}
          onClose={() => setContextMenu(null)}
          onOpen={() => {
            openEntry(profileId, contextMenu.dn);
            setContextMenu(null);
          }}
          onLocateInTree={async () => {
            setActivity('explorer');
            if (!sidebarVisible) toggleSidebar();
            await locateInTree(profileId, contextMenu.dn);
            setContextMenu(null);
          }}
          onCopyDN={() => {
            navigator.clipboard.writeText(contextMenu.dn);
            toast.info('DN copied');
            setContextMenu(null);
          }}
          onCopyRDN={() => {
            const rdn = contextMenu.dn.split(',')[0] || contextMenu.dn;
            navigator.clipboard.writeText(rdn);
            toast.info('RDN copied');
            setContextMenu(null);
          }}
          onBookmark={() => {
            addBookmark(profileId, contextMenu.dn);
            toast.info('Bookmark added');
            setContextMenu(null);
          }}
          isBookmarked={isBookmarked(profileId, contextMenu.dn)}
        />
      )}
    </div>
  );
}

function ListContextMenu({ x, y, dn, profileId, onClose, onOpen, onLocateInTree, onCopyDN, onCopyRDN, onBookmark, isBookmarked: bookmarked }: {
  x: number;
  y: number;
  dn: string;
  profileId: string;
  onClose: () => void;
  onOpen: () => void;
  onLocateInTree: () => void;
  onCopyDN: () => void;
  onCopyRDN: () => void;
  onBookmark: () => void;
  isBookmarked: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const zoomLevel = useUIStore((s) => s.zoomLevel);

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

  const zoomedX = x / zoomLevel;
  const zoomedY = y / zoomLevel;
  const menuWidth = 200;
  const menuHeight = 220;
  const viewportW = window.innerWidth / zoomLevel;
  const viewportH = window.innerHeight / zoomLevel;
  const adjustedX = zoomedX + menuWidth > viewportW ? zoomedX - menuWidth : zoomedX;
  const adjustedY = zoomedY + menuHeight > viewportH ? zoomedY - menuHeight : zoomedY;

  const rdnLabel = dn.split(',')[0] || dn;

  interface MenuItem {
    label: string;
    icon: React.ElementType;
    action: () => void;
    separator?: boolean;
    disabled?: boolean;
  }

  const items: MenuItem[] = [
    { label: 'Open Entry', icon: Pencil, action: onOpen },
    { label: 'Show in Tree', icon: Crosshair, action: onLocateInTree, separator: true },
    { label: 'Copy DN', icon: Copy, action: onCopyDN },
    { label: 'Copy RDN', icon: ClipboardCopy, action: onCopyRDN, separator: true },
    { label: bookmarked ? 'Bookmarked ✓' : 'Add Bookmark', icon: Star, action: onBookmark, disabled: bookmarked },
  ];

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-popover border border-border rounded shadow-xl py-1 min-w-[180px]"
      style={{ left: adjustedX, top: adjustedY }}
      onClick={e => e.stopPropagation()}
    >
      <div className="px-3 py-1 text-[10px] text-muted-foreground border-b border-border mb-1 font-mono truncate max-w-[220px]" title={dn}>
        {rdnLabel}
      </div>
      {items.map((item, i) => (
        <div key={i}>
          {item.separator && i > 0 && (
            <div className="h-px bg-border mx-2 my-1" />
          )}
          <button
            className={cn(
              'w-full flex items-center gap-2 px-3 py-1 text-xs hover:bg-accent text-popover-foreground',
              item.disabled && 'opacity-50 cursor-default'
            )}
            onClick={() => { if (!item.disabled) item.action(); }}
          >
            <item.icon size={12} />
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
