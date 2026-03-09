import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { AlertTriangle, ArrowUpDown, Copy, Check, Download, Pencil, Trash2, Star, Crosshair, Columns3, Plus, X, FileDown, FolderPlus, Type, ClipboardCopy, KeyRound, CopyPlus } from 'lucide-react'
import { useSearchStore } from '../../stores/searchStore'
import { useEditorStore } from '../../stores/editorStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useBookmarkStore } from '../../stores/bookmarkStore'
import { useTreeStore } from '../../stores/treeStore'
import { useUIStore } from '../../stores/uiStore'
import { getIconForObjectClass, getIconColor } from '../../lib/ldap-icons'
import { LDAPEntry } from '../../types/ldap'
import { cn } from '../../lib/utils'
import { toast } from '../ui/Toast'

type SortKey = 'dn' | 'objectClass' | string;
type SortDir = 'asc' | 'desc';

const COMMON_COLUMNS = [
  'cn', 'sn', 'givenName', 'displayName', 'mail', 'telephoneNumber',
  'sAMAccountName', 'userPrincipalName', 'description', 'title',
  'department', 'company', 'physicalDeliveryOfficeName', 'l', 'st', 'co',
  'memberOf', 'member', 'ou', 'uid', 'uidNumber', 'gidNumber',
  'homeDirectory', 'loginShell', 'whenCreated', 'whenChanged',
  'userAccountControl', 'objectCategory', 'distinguishedName',
];

export function SearchResults() {
  const results = useSearchStore((s) => s.results);
  const displayColumns = useSearchStore((s) => s.displayColumns);
  const addDisplayColumn = useSearchStore((s) => s.addDisplayColumn);
  const removeDisplayColumn = useSearchStore((s) => s.removeDisplayColumn);
  const getEntryAttrValue = useSearchStore((s) => s.getEntryAttrValue);
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const openEntry = useEditorStore((s) => s.openEntry);
  const [sortKey, setSortKey] = useState<SortKey>('dn');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [copiedDN, setCopiedDN] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; dn: string } | null>(null);
  const [showColumnChooser, setShowColumnChooser] = useState(false);
  const [columnFilter, setColumnFilter] = useState('');
  const [selectedDN, setSelectedDN] = useState<string | null>(null);
  const { addBookmark, isBookmarked } = useBookmarkStore();
  const locateInTree = useTreeStore((s) => s.locateInTree);
  const setActivity = useUIStore((s) => s.setActivity);
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const tableContainerRef = useRef<HTMLDivElement>(null);

  // Click on an entry: select it, open it, AND focus it in the tree
  const handleEntryClick = useCallback(async (dn: string) => {
    if (!activeProfileId) return;
    setSelectedDN(dn);
    openEntry(activeProfileId, dn);
    // Also locate in tree for instant visual feedback
    setActivity('explorer');
    if (!sidebarVisible) toggleSidebar();
    await locateInTree(activeProfileId, dn);
  }, [activeProfileId, openEntry, locateInTree, setActivity, sidebarVisible, toggleSidebar]);

  const handleLocateInTree = useCallback(async (dn: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!activeProfileId) return;
    setActivity('explorer');
    if (!sidebarVisible) toggleSidebar();
    await locateInTree(activeProfileId, dn);
  }, [activeProfileId, locateInTree, setActivity, sidebarVisible, toggleSidebar]);

  const handleSort = useCallback((key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }, [sortKey]);

  // Discover available attributes from results
  const availableAttributes = useMemo(() => {
    if (!results?.entries) return [];
    const attrSet = new Set<string>();
    for (const entry of results.entries) {
      for (const attr of entry.attributes || []) {
        attrSet.add(attr.name);
      }
    }
    return Array.from(attrSet).sort((a, b) => a.localeCompare(b));
  }, [results?.entries]);

  const filteredColumnOptions = useMemo(() => {
    const allOptions = [...new Set([...COMMON_COLUMNS, ...availableAttributes])].sort();
    if (!columnFilter) return allOptions.filter(c => !displayColumns.includes(c));
    const lf = columnFilter.toLowerCase();
    return allOptions.filter(c => !displayColumns.includes(c) && c.toLowerCase().includes(lf));
  }, [columnFilter, displayColumns, availableAttributes]);

  const sortedEntries = useMemo(() => {
    if (!results?.entries) return [];
    return [...results.entries].sort((a, b) => {
      let aVal: string, bVal: string;
      if (sortKey === 'dn') {
        aVal = a.dn;
        bVal = b.dn;
      } else if (sortKey === 'objectClass') {
        aVal = getOC(a).join(',');
        bVal = getOC(b).join(',');
      } else {
        aVal = getEntryAttrValue(a, sortKey);
        bVal = getEntryAttrValue(b, sortKey);
      }
      const cmp = aVal.localeCompare(bVal);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [results?.entries, sortKey, sortDir, getEntryAttrValue]);

  // Keyboard navigation in results (must be after sortedEntries)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!sortedEntries.length) return;
      const container = tableContainerRef.current;
      if (!container || !container.contains(document.activeElement as Node)) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const currentIdx = selectedDN ? sortedEntries.findIndex(en => en.dn === selectedDN) : -1;
        const nextIdx = Math.min(currentIdx + 1, sortedEntries.length - 1);
        setSelectedDN(sortedEntries[nextIdx].dn);
        const row = container.querySelector(`[data-dn="${CSS.escape(sortedEntries[nextIdx].dn)}"]`);
        row?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const currentIdx = selectedDN ? sortedEntries.findIndex(en => en.dn === selectedDN) : sortedEntries.length;
        const prevIdx = Math.max(currentIdx - 1, 0);
        setSelectedDN(sortedEntries[prevIdx].dn);
        const row = container.querySelector(`[data-dn="${CSS.escape(sortedEntries[prevIdx].dn)}"]`);
        row?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && selectedDN) {
        e.preventDefault();
        handleEntryClick(selectedDN);
      } else if (e.key === 'Escape') {
        setSelectedDN(null);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [sortedEntries, selectedDN, handleEntryClick]);

  const handleCopyDN = useCallback((dn: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(dn);
    setCopiedDN(dn);
    setTimeout(() => setCopiedDN(null), 1200);
  }, []);

  // Export search results as CSV
  const handleExportCSV = useCallback(() => {
    if (!results?.entries || results.entries.length === 0) return;

    const headers = ['DN', ...displayColumns];
    const rows = results.entries.map(entry => {
      const values = [
        `"${entry.dn.replace(/"/g, '""')}"`,
        ...displayColumns.map(col => {
          const val = getEntryAttrValue(entry, col);
          return `"${val.replace(/"/g, '""')}"`;
        })
      ];
      return values.join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ldap-search-results-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${results.entries.length} entries as CSV`);
  }, [results, displayColumns, getEntryAttrValue]);

  // Export as LDIF
  const handleExportLDIF = useCallback(() => {
    if (!results?.entries || results.entries.length === 0) return;

    const ldifLines: string[] = [];
    for (const entry of results.entries) {
      ldifLines.push(`dn: ${entry.dn}`);
      for (const attr of entry.attributes || []) {
        for (const val of attr.values) {
          ldifLines.push(`${attr.name}: ${val}`);
        }
      }
      ldifLines.push('');
    }

    const ldif = ldifLines.join('\n');
    const blob = new Blob([ldif], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ldap-search-results-${new Date().toISOString().slice(0, 10)}.ldif`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${results.entries.length} entries as LDIF`);
  }, [results]);

  // Copy results to clipboard as tab-separated
  const handleCopyTable = useCallback(() => {
    if (!results?.entries || results.entries.length === 0) return;

    const headers = ['DN', ...displayColumns];
    const rows = results.entries.map(entry => {
      return [entry.dn, ...displayColumns.map(col => getEntryAttrValue(entry, col))].join('\t');
    });

    const text = [headers.join('\t'), ...rows].join('\n');
    navigator.clipboard.writeText(text);
    toast.success('Table copied to clipboard');
  }, [results, displayColumns, getEntryAttrValue]);

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
        <div className="flex items-center gap-1">
          {/* Column Chooser */}
          <button
            onClick={() => setShowColumnChooser(!showColumnChooser)}
            className={cn(
              'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors',
              showColumnChooser ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            )}
            title="Choose columns"
          >
            <Columns3 size={11} />
            Columns
          </button>

          {/* Export dropdown */}
          <ExportMenu
            onExportCSV={handleExportCSV}
            onExportLDIF={handleExportLDIF}
            onCopyTable={handleCopyTable}
          />
        </div>
      </div>

      {/* Column Chooser Panel */}
      {showColumnChooser && (
        <div className="px-3 py-2 border-b border-border bg-card/80 space-y-2 shrink-0">
          {/* Active columns */}
          <div className="flex flex-wrap gap-1">
            {displayColumns.map(col => (
              <span
                key={col}
                className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 bg-primary/15 text-primary rounded-sm font-mono"
              >
                {col}
                <button
                  onClick={() => removeDisplayColumn(col)}
                  className="hover:text-destructive ml-0.5"
                >
                  <X size={9} />
                </button>
              </span>
            ))}
          </div>
          {/* Add column */}
          <div className="flex gap-1 items-center">
            <input
              type="text"
              value={columnFilter}
              onChange={(e) => setColumnFilter(e.target.value)}
              placeholder="Add column..."
              className="input-field text-xs flex-1 font-mono"
              autoFocus
            />
          </div>
          {(columnFilter || filteredColumnOptions.length > 0) && (
            <div className="flex flex-wrap gap-0.5 max-h-20 overflow-auto">
              {filteredColumnOptions.slice(0, 30).map(col => (
                <button
                  key={col}
                  onClick={() => { addDisplayColumn(col); setColumnFilter(''); }}
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

      {/* Results Table */}
      <div className="flex-1 overflow-auto outline-none" ref={tableContainerRef} tabIndex={0}>
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card z-10">
            <tr className="border-b border-border">
              <th
                className="text-left px-3 py-1.5 font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none"
                onClick={() => handleSort('dn')}
                style={{ minWidth: 200 }}
              >
                <span className="flex items-center gap-1">
                  Name / DN
                  <ArrowUpDown size={10} className={sortKey === 'dn' ? 'text-primary' : ''} />
                </span>
              </th>
              {displayColumns.map(col => (
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
              <th
                className="text-left px-3 py-1.5 font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none w-32"
                onClick={() => handleSort('objectClass')}
              >
                <span className="flex items-center gap-1">
                  Type
                  <ArrowUpDown size={10} className={sortKey === 'objectClass' ? 'text-primary' : ''} />
                </span>
              </th>
              <th className="w-16 px-1"></th>
            </tr>
          </thead>
          <tbody>
            {sortedEntries.map((entry) => {
              const objectClasses = getOC(entry);
              const Icon = getIconForObjectClass(objectClasses);
              const iconColor = getIconColor(objectClasses);
              const isCopied = copiedDN === entry.dn;
              const isSelected = selectedDN === entry.dn;
              return (
                <tr
                  key={entry.dn}
                  data-dn={entry.dn}
                  className={cn(
                    'border-b border-border cursor-pointer group',
                    isSelected
                      ? 'bg-primary/10 hover:bg-primary/15'
                      : 'hover:bg-accent/30'
                  )}
                  onClick={() => handleEntryClick(entry.dn)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSelectedDN(entry.dn);
                    setContextMenu({ x: e.clientX, y: e.clientY, dn: entry.dn });
                  }}
                >
                  <td className="px-3 py-1 font-mono">
                    <div className="flex items-center gap-1.5">
                      <Icon size={13} className={cn('shrink-0', iconColor)} />
                      <div className="min-w-0">
                        <div className="font-medium truncate text-foreground" title={entry.dn}>
                          {entry.dn.split(',')[0]}
                        </div>
                        <div className="text-[10px] text-muted-foreground/60 truncate" title={entry.dn}>
                          {entry.dn.split(',').slice(1).join(',') || '(root)'}
                        </div>
                      </div>
                    </div>
                  </td>
                  {displayColumns.map(col => (
                    <td key={col} className="px-3 py-1 text-muted-foreground max-w-[200px]">
                      <span className="truncate block" title={getEntryAttrValue(entry, col)}>
                        {getEntryAttrValue(entry, col) || <span className="opacity-30">—</span>}
                      </span>
                    </td>
                  ))}
                  <td className="px-3 py-1 text-muted-foreground">
                    <div className="flex flex-wrap gap-0.5">
                      {objectClasses.filter(oc => oc !== 'top').slice(0, 2).map(oc => (
                        <span key={oc} className="px-1 py-0 bg-accent/50 rounded text-[9px]">
                          {oc}
                        </span>
                      ))}
                      {objectClasses.filter(oc => oc !== 'top').length > 2 && (
                        <span className="text-[9px] text-muted-foreground">+{objectClasses.filter(oc => oc !== 'top').length - 2}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-1 py-1">
                    <div className="flex items-center gap-0.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleLocateInTree(entry.dn); }}
                        className="p-0.5 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Show in Tree"
                      >
                        <Crosshair size={11} />
                      </button>
                      <button
                        onClick={(e) => handleCopyDN(entry.dn, e)}
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
          onLocateInTree={async () => {
            if (activeProfileId) {
              setActivity('explorer');
              if (!sidebarVisible) toggleSidebar();
              await locateInTree(activeProfileId, contextMenu.dn);
            }
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
            if (activeProfileId) {
              addBookmark(activeProfileId, contextMenu.dn);
              toast.info('Bookmark added');
            }
            setContextMenu(null);
          }}
          onExportLDIF={() => {
            // Export single entry as LDIF
            const entry = results?.entries?.find(e => e.dn === contextMenu.dn);
            if (entry) {
              const lines: string[] = [`dn: ${entry.dn}`];
              for (const attr of entry.attributes || []) {
                for (const val of attr.values) {
                  lines.push(`${attr.name}: ${val}`);
                }
              }
              navigator.clipboard.writeText(lines.join('\n'));
              toast.success('LDIF copied to clipboard');
            }
            setContextMenu(null);
          }}
          isBookmarked={activeProfileId ? isBookmarked(activeProfileId, contextMenu.dn) : false}
        />
      )}
    </div>
  );
}

// Export results dropdown menu
function ExportMenu({ onExportCSV, onExportLDIF, onCopyTable }: {
  onExportCSV: () => void;
  onExportLDIF: () => void;
  onCopyTable: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors',
          open ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
        )}
        title="Export results"
      >
        <FileDown size={11} />
        Export
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-popover border border-border rounded shadow-xl py-1 min-w-[140px]">
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent text-popover-foreground"
            onClick={() => { onExportCSV(); setOpen(false); }}
          >
            <Download size={12} />
            Export as CSV
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent text-popover-foreground"
            onClick={() => { onExportLDIF(); setOpen(false); }}
          >
            <Download size={12} />
            Export as LDIF
          </button>
          <div className="border-t border-border my-1" />
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent text-popover-foreground"
            onClick={() => { onCopyTable(); setOpen(false); }}
          >
            <Copy size={12} />
            Copy Table
          </button>
        </div>
      )}
    </div>
  );
}

function SearchContextMenu({ x, y, dn, onClose, onOpen, onLocateInTree, onCopyDN, onCopyRDN, onBookmark, onExportLDIF, isBookmarked: bookmarked }: {
  x: number;
  y: number;
  dn: string;
  onClose: () => void;
  onOpen: () => void;
  onLocateInTree: () => void;
  onCopyDN: () => void;
  onCopyRDN: () => void;
  onBookmark: () => void;
  onExportLDIF: () => void;
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
  const menuHeight = 250;
  const viewportW = window.innerWidth / zoomLevel;
  const viewportH = window.innerHeight / zoomLevel;
  const adjustedX = zoomedX + menuWidth > viewportW ? zoomedX - menuWidth : zoomedX;
  const adjustedY = zoomedY + menuHeight > viewportH ? zoomedY - menuHeight : zoomedY;

  const rdn = dn.split(',')[0] || dn;

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
    { label: 'Copy RDN', icon: ClipboardCopy, action: onCopyRDN },
    { label: 'Export as LDIF', icon: Download, action: onExportLDIF, separator: true },
    { label: bookmarked ? 'Bookmarked ✓' : 'Add Bookmark', icon: Star, action: onBookmark, disabled: bookmarked },
  ];

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-popover border border-border rounded shadow-xl py-1 min-w-[180px]"
      style={{ left: adjustedX, top: adjustedY }}
      onClick={e => e.stopPropagation()}
    >
      {/* Header showing the RDN */}
      <div className="px-3 py-1 text-[10px] text-muted-foreground border-b border-border mb-1 font-mono truncate max-w-[220px]" title={dn}>
        {rdn}
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

function getOC(entry: LDAPEntry): string[] {
  return entry.attributes?.find(a => a.name.toLowerCase() === 'objectclass')?.values || [];
}
