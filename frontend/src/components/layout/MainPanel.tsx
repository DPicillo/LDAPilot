import { useState, useEffect, useRef, useMemo } from 'react'
import { X, Database, Plug, Search, FolderTree, Star, XCircle, Server, ChevronDown, Clock } from 'lucide-react'
import logoImg from '../../assets/logo.png'
import { cn } from '../../lib/utils'
import { useEditorStore } from '../../stores/editorStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useBookmarkStore } from '../../stores/bookmarkStore'
import { useUIStore } from '../../stores/uiStore'
import { useTreeStore, getPrimarySelectedNode } from '../../stores/treeStore'
import { EntryEditor } from '../editor/EntryEditor'
import { ServerInfo } from '../connection/ServerInfo'
import { ContainerListView } from '../browser/ContainerListView'

export function MainPanel() {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const closeTab = useEditorStore((s) => s.closeTab);
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [showTabList, setShowTabList] = useState(false);
  const tabListRef = useRef<HTMLDivElement>(null);

  function closeOtherTabs(keepTabId: string) {
    tabs.filter(t => t.id !== keepTabId).forEach(t => closeTab(t.id));
  }

  function closeAllTabs() {
    tabs.forEach(t => closeTab(t.id));
  }

  function closeTabsToRight(tabId: string) {
    const idx = tabs.findIndex(t => t.id === tabId);
    if (idx >= 0) {
      tabs.slice(idx + 1).forEach(t => closeTab(t.id));
    }
  }

  // Close tab list dropdown when clicking outside
  useEffect(() => {
    if (!showTabList) return;
    function handleClickOutside(e: MouseEvent) {
      if (tabListRef.current && !tabListRef.current.contains(e.target as Node)) {
        setShowTabList(false);
      }
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setShowTabList(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [showTabList]);

  if (tabs.length === 0) {
    return <TreeListViewOrWelcome />;
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Tab Bar */}
      <div className="flex items-center bg-secondary border-b border-border overflow-x-auto shrink-0">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setTabContextMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
            }}
            className={cn(
              'group relative flex items-center gap-1.5 px-3 h-[35px] cursor-pointer',
              'text-sm border-r border-border select-none shrink-0',
              'transition-colors duration-100',
              tab.id === activeTabId
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:bg-accent'
            )}
          >
            {tab.id === activeTabId && (
              <div className="absolute top-0 left-0 right-0 h-px bg-primary" />
            )}
            {tab.id === '__server-info__' ? (
              <Server size={14} className="shrink-0 text-purple-400" />
            ) : (
              <Database size={14} className="shrink-0 opacity-70" />
            )}
            <span className="truncate max-w-[120px]" title={tab.dn}>
              {tab.dirty && <span className="mr-0.5 text-primary">*</span>}
              {tab.label}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
              className={cn(
                'ml-1 p-0.5 rounded-sm shrink-0',
                'opacity-0 group-hover:opacity-100',
                'hover:bg-accent',
                tab.id === activeTabId && 'opacity-60 hover:opacity-100'
              )}
            >
              <X size={14} />
            </button>
          </div>
        ))}

        {/* Close all button */}
        {tabs.length > 1 && (
          <button
            onClick={closeAllTabs}
            className="p-1 ml-1 text-muted-foreground hover:text-foreground rounded hover:bg-accent shrink-0"
            title="Close All Tabs"
          >
            <XCircle size={14} />
          </button>
        )}

        {/* Tab overflow dropdown */}
        {tabs.length > 3 && (
          <div className="relative shrink-0" ref={tabListRef}>
            <button
              onClick={() => setShowTabList(!showTabList)}
              className={cn(
                'p-1 ml-0.5 rounded hover:bg-accent shrink-0',
                showTabList ? 'text-foreground bg-accent' : 'text-muted-foreground hover:text-foreground'
              )}
              title="Show all tabs"
            >
              <ChevronDown size={14} />
            </button>
            {showTabList && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-popover border border-border rounded shadow-xl py-1 min-w-[240px] max-w-[360px] max-h-[320px] overflow-auto">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => {
                      setActiveTab(tab.id);
                      setShowTabList(false);
                    }}
                    className={cn(
                      'w-full flex items-start gap-2 px-3 py-1.5 text-left hover:bg-accent',
                      tab.id === activeTabId && 'bg-accent/60'
                    )}
                  >
                    {tab.id === '__server-info__' ? (
                      <Server size={13} className="shrink-0 mt-0.5 text-purple-400" />
                    ) : (
                      <Database size={13} className="shrink-0 mt-0.5 opacity-70" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium truncate">
                        {tab.dirty && <span className="mr-0.5 text-primary">*</span>}
                        {tab.label}
                      </div>
                      {tab.dn && (
                        <div className="text-[10px] font-mono text-muted-foreground truncate" title={tab.dn}>
                          {tab.dn}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
                <div className="h-px bg-border mx-2 my-1" />
                <button
                  onClick={() => {
                    closeAllTabs();
                    setShowTabList(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-destructive hover:bg-accent"
                >
                  <XCircle size={12} />
                  Close All
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tab Context Menu */}
      {tabContextMenu && (
        <TabContextMenu
          x={tabContextMenu.x}
          y={tabContextMenu.y}
          onClose={() => setTabContextMenu(null)}
          onCloseTab={() => { closeTab(tabContextMenu.tabId); setTabContextMenu(null); }}
          onCloseOthers={() => { closeOtherTabs(tabContextMenu.tabId); setTabContextMenu(null); }}
          onCloseAll={() => { closeAllTabs(); setTabContextMenu(null); }}
          onCloseToRight={() => { closeTabsToRight(tabContextMenu.tabId); setTabContextMenu(null); }}
          hasOtherTabs={tabs.length > 1}
          hasTabsToRight={tabs.findIndex(t => t.id === tabContextMenu.tabId) < tabs.length - 1}
        />
      )}

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden">
        {activeTabId === '__server-info__' ? (
          <ServerInfo />
        ) : activeTabId ? (
          <EntryEditor tabId={activeTabId} />
        ) : null}
      </div>
    </div>
  );
}

function TabContextMenu({ x, y, onClose, onCloseTab, onCloseOthers, onCloseAll, onCloseToRight, hasOtherTabs, hasTabsToRight }: {
  x: number;
  y: number;
  onClose: () => void;
  onCloseTab: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  onCloseToRight: () => void;
  hasOtherTabs: boolean;
  hasTabsToRight: boolean;
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

  // clientX/clientY are in viewport space but rendering happens inside the
  // zoom wrapper (transform: scale), so divide by zoomLevel to convert.
  const adjustedX = x / zoomLevel;
  const adjustedY = y / zoomLevel;

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-popover border border-border rounded shadow-xl py-1 min-w-[160px]"
      style={{ left: adjustedX, top: adjustedY }}
    >
      <button
        className="w-full flex items-center gap-2 px-3 py-1 text-xs hover:bg-accent text-popover-foreground"
        onClick={onCloseTab}
      >
        Close
      </button>
      <button
        className="w-full flex items-center gap-2 px-3 py-1 text-xs hover:bg-accent text-popover-foreground disabled:opacity-30"
        onClick={onCloseOthers}
        disabled={!hasOtherTabs}
      >
        Close Others
      </button>
      <button
        className="w-full flex items-center gap-2 px-3 py-1 text-xs hover:bg-accent text-popover-foreground disabled:opacity-30"
        onClick={onCloseToRight}
        disabled={!hasTabsToRight}
      >
        Close to the Right
      </button>
      <div className="h-px bg-border mx-2 my-1" />
      <button
        className="w-full flex items-center gap-2 px-3 py-1 text-xs hover:bg-accent text-popover-foreground"
        onClick={onCloseAll}
      >
        Close All
      </button>
    </div>
  );
}
function TreeListViewOrWelcome() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const selectedNodes = useTreeStore((s) => s.selectedNodes);
  const childNodes = useTreeStore((s) => s.childNodes);

  // Get the primary selected node
  const selectedDN = getPrimarySelectedNode();

  // Check if the selected node is a container (has children loaded or has children flag)
  const isContainer = selectedDN && childNodes[selectedDN] !== undefined;

  if (activeProfileId && selectedDN && isContainer) {
    return <ContainerListView profileId={activeProfileId} containerDN={selectedDN} />;
  }

  return <WelcomeScreen />;
}

function WelcomeScreen() {
  const isConnected = useConnectionStore((s) => {
    const id = s.activeProfileId;
    return id ? s.connectionStatuses[id] === true : false;
  });
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const allBookmarks = useBookmarkStore((s) => s.bookmarks);
  const bookmarks = useMemo(() =>
    activeProfileId
      ? allBookmarks.filter(b => b.profileId === activeProfileId).sort((a, b) => a.label.localeCompare(b.label))
      : [],
    [allBookmarks, activeProfileId]
  );
  const openEntry = useEditorStore((s) => s.openEntry);
  const setActivity = useUIStore((s) => s.setActivity);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);

  function showPanel(panel: 'connections' | 'explorer' | 'search' | 'bookmarks') {
    setActivity(panel);
    if (!sidebarVisible) toggleSidebar();
  }

  return (
    <div className="h-full flex flex-col items-center justify-center bg-background select-none">
      <div className="flex flex-col items-center gap-6 max-w-md">
        {/* Logo */}
        <div className="flex items-center gap-3 opacity-60">
          <img src={logoImg} alt="LDAPilot" className="w-12 h-12 rounded-xl" />
          <div>
            <h1 className="text-2xl font-light tracking-wide">LDAPilot</h1>
            <p className="text-xs text-muted-foreground">Modern LDAP Browser & Editor</p>
          </div>
        </div>

        {/* Quick actions */}
        <div className="grid grid-cols-2 gap-2 w-full mt-4">
          {!isConnected ? (
            <button
              onClick={() => showPanel('connections')}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-card border border-border hover:bg-accent/50 transition-colors col-span-2"
            >
              <Plug size={16} className="text-primary" />
              <div className="text-left">
                <div className="text-xs font-medium">Connect to Server</div>
                <div className="text-[10px] text-muted-foreground">Set up an LDAP connection</div>
              </div>
            </button>
          ) : (
            <>
              <button
                onClick={() => showPanel('explorer')}
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-card border border-border hover:bg-accent/50 transition-colors"
              >
                <FolderTree size={16} className="text-blue-400" />
                <div className="text-left">
                  <div className="text-xs font-medium">Browse Tree</div>
                  <div className="text-[10px] text-muted-foreground">Explore directory</div>
                </div>
              </button>
              <button
                onClick={() => showPanel('search')}
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-card border border-border hover:bg-accent/50 transition-colors"
              >
                <Search size={16} className="text-green-400" />
                <div className="text-left">
                  <div className="text-xs font-medium">Search</div>
                  <div className="text-[10px] text-muted-foreground">Find entries</div>
                </div>
              </button>
              <button
                onClick={() => {
                  const store = useEditorStore.getState();
                  const existing = store.tabs.find(t => t.id === '__server-info__');
                  if (!existing) {
                    store.addSpecialTab('__server-info__', 'Server Info');
                  }
                  store.setActiveTab('__server-info__');
                }}
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-card border border-border hover:bg-accent/50 transition-colors col-span-2"
              >
                <Server size={16} className="text-purple-400" />
                <div className="text-left">
                  <div className="text-xs font-medium">Server Info</div>
                  <div className="text-[10px] text-muted-foreground">RootDSE & capabilities</div>
                </div>
              </button>
            </>
          )}
        </div>

        {/* Bookmarks */}
        {isConnected && bookmarks.length > 0 && (
          <div className="w-full">
            <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1.5">
              <Star size={11} className="text-yellow-500" />
              Bookmarks
            </div>
            <div className="space-y-0.5">
              {bookmarks.slice(0, 5).map(bm => (
                <button
                  key={bm.dn}
                  onClick={() => activeProfileId && openEntry(activeProfileId, bm.dn)}
                  className="w-full text-left px-2 py-1 rounded hover:bg-accent/50 text-xs font-mono truncate text-muted-foreground hover:text-foreground"
                  title={bm.dn}
                >
                  {bm.label}
                </button>
              ))}
              {bookmarks.length > 5 && (
                <button
                  onClick={() => showPanel('bookmarks')}
                  className="text-[10px] text-primary hover:text-primary/80 px-2"
                >
                  Show all {bookmarks.length} bookmarks...
                </button>
              )}
            </div>
          </div>
        )}

        {/* Recent Entries */}
        {isConnected && activeProfileId && (() => {
          try {
            const recent: { profileId: string; dn: string; label: string; timestamp: number }[] =
              JSON.parse(localStorage.getItem('ldapilot-recent-entries') || '[]');
            const profileRecent = recent
              .filter(r => r.profileId === activeProfileId)
              .slice(0, 5);
            if (profileRecent.length === 0) return null;
            return (
              <div className="w-full">
                <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1.5">
                  <Clock size={11} className="text-blue-400" />
                  Recent
                </div>
                <div className="space-y-0.5">
                  {profileRecent.map(r => (
                    <button
                      key={r.dn}
                      onClick={() => openEntry(activeProfileId!, r.dn)}
                      className="w-full text-left px-2 py-1 rounded hover:bg-accent/50 text-xs font-mono truncate text-muted-foreground hover:text-foreground"
                      title={r.dn}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          } catch { return null; }
        })()}

        {/* Keyboard shortcuts hint */}
        <div className="flex flex-col items-center gap-1.5 text-[10px] text-muted-foreground mt-4">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 bg-secondary rounded border border-border">Ctrl+G</kbd>
              Go to DN
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 bg-secondary rounded border border-border">Ctrl+?</kbd>
              Shortcuts
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 bg-secondary rounded border border-border">F5</kbd>
              Refresh
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
