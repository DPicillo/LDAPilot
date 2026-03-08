import { useState, useRef, useEffect, useCallback } from 'react'
import { Minus, Square, X, Copy } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useUIStore } from '../../stores/uiStore'
import { useEditorStore } from '../../stores/editorStore'
import { useConnectionStore } from '../../stores/connectionStore'
import logoImg from '../../assets/logo.png'

interface MenuItem {
  label: string;
  shortcut?: string;
  action?: () => void;
  separator?: boolean;
  disabled?: boolean;
}

interface MenuDef {
  label: string;
  items: MenuItem[];
}

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuBarRef = useRef<HTMLDivElement>(null);

  const setActivity = useUIStore((s) => s.setActivity);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const bottomPanelVisible = useUIStore((s) => s.bottomPanelVisible);
  const toggleBottomPanel = useUIStore((s) => s.toggleBottomPanel);
  const showBottomTab = useUIStore((s) => s.showBottomTab);
  const closeTab = useEditorStore((s) => s.closeTab);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const tabs = useEditorStore((s) => s.tabs);
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const isConnected = useConnectionStore((s) => {
    const id = s.activeProfileId;
    return id ? s.connectionStatuses[id] === true : false;
  });
  const disconnect = useConnectionStore((s) => s.disconnect);

  // Close menu when clicking outside
  useEffect(() => {
    if (!openMenu) return;
    function handleClick(e: MouseEvent) {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpenMenu(null);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [openMenu]);

  function showSidebar(panel: 'connections' | 'explorer' | 'search' | 'bookmarks' | 'export' | 'schema') {
    setActivity(panel);
    if (!sidebarVisible) toggleSidebar();
    setOpenMenu(null);
  }

  const menus: MenuDef[] = [
    {
      label: 'File',
      items: [
        { label: 'New Connection...', action: () => showSidebar('connections') },
        { label: 'Import LDIF...', shortcut: '', action: () => showSidebar('export'), disabled: !isConnected },
        { label: 'Export...', action: () => showSidebar('export'), disabled: !isConnected },
        { separator: true, label: '' },
        { label: 'Disconnect', action: () => { if (activeProfileId) { disconnect(activeProfileId); } setOpenMenu(null); }, disabled: !isConnected },
        { separator: true, label: '' },
        { label: 'Close Tab', shortcut: 'Ctrl+W', action: () => { if (activeTabId) closeTab(activeTabId); setOpenMenu(null); }, disabled: !activeTabId },
        { label: 'Close All Tabs', action: () => { tabs.forEach(t => closeTab(t.id)); setOpenMenu(null); }, disabled: tabs.length === 0 },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Explorer', shortcut: 'Ctrl+Shift+E', action: () => showSidebar('explorer') },
        { label: 'Search', shortcut: 'Ctrl+Shift+F', action: () => showSidebar('search') },
        { label: 'Connections', shortcut: 'Ctrl+Shift+C', action: () => showSidebar('connections') },
        { label: 'Bookmarks', action: () => showSidebar('bookmarks') },
        { label: 'Schema Browser', action: () => showSidebar('schema') },
        { separator: true, label: '' },
        { label: 'Toggle Sidebar', shortcut: 'Ctrl+B', action: () => { toggleSidebar(); setOpenMenu(null); } },
        { label: 'Toggle Panel', shortcut: 'Ctrl+J', action: () => { toggleBottomPanel(); setOpenMenu(null); } },
        { separator: true, label: '' },
        { label: 'Operations Log', action: () => { showBottomTab('output'); setOpenMenu(null); } },
        { label: 'Audit Log', action: () => { showBottomTab('audit'); setOpenMenu(null); } },
        { label: 'Search Results', action: () => { showBottomTab('search-results'); setOpenMenu(null); } },
      ],
    },
    {
      label: 'Go',
      items: [
        { label: 'Go to DN...', shortcut: 'Ctrl+G', action: () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true })); setOpenMenu(null); } },
        { label: 'Back', shortcut: 'Alt+Left', action: () => { useEditorStore.getState().goBack(); setOpenMenu(null); } },
        { label: 'Forward', shortcut: 'Alt+Right', action: () => { useEditorStore.getState().goForward(); setOpenMenu(null); } },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'Keyboard Shortcuts', shortcut: 'Ctrl+/', action: () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true })); setOpenMenu(null); } },
        { separator: true, label: '' },
        { label: 'GitHub Repository', action: () => { const w = (window as any); w.runtime?.BrowserOpenURL?.('https://github.com/DPicillo/LDAPilot'); setOpenMenu(null); } },
        { label: 'Report Issue', action: () => { const w = (window as any); w.runtime?.BrowserOpenURL?.('https://github.com/DPicillo/LDAPilot/issues'); setOpenMenu(null); } },
      ],
    },
  ];

  function handleMinimize() {
    (window as any).runtime?.WindowMinimise?.();
  }

  function handleMaximize() {
    (window as any).runtime?.WindowToggleMaximise?.();
    setIsMaximized(!isMaximized);
  }

  function handleClose() {
    (window as any).runtime?.Quit?.();
  }

  return (
    <div
      className="flex items-center h-[30px] bg-[#1e1e2e] border-b border-border select-none shrink-0"
      style={{ '--wails-draggable': 'drag' } as React.CSSProperties}
    >
      {/* Logo */}
      <div className="flex items-center px-2.5 h-full" style={{ '--wails-draggable': 'no-drag' } as React.CSSProperties}>
        <img src={logoImg} alt="" className="w-4 h-4" />
      </div>

      {/* Menu Bar */}
      <div
        ref={menuBarRef}
        className="flex items-center h-full"
        style={{ '--wails-draggable': 'no-drag' } as React.CSSProperties}
      >
        {menus.map((menu) => (
          <div key={menu.label} className="relative h-full">
            <button
              onClick={() => setOpenMenu(openMenu === menu.label ? null : menu.label)}
              onMouseEnter={() => { if (openMenu) setOpenMenu(menu.label); }}
              className={cn(
                'h-full px-2 text-xs transition-colors',
                openMenu === menu.label
                  ? 'bg-white/10 text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
              )}
            >
              {menu.label}
            </button>

            {/* Dropdown */}
            {openMenu === menu.label && (
              <div className="absolute left-0 top-full z-[100] bg-popover border border-border rounded-md shadow-2xl py-1 min-w-[220px]">
                {menu.items.map((item, i) =>
                  item.separator ? (
                    <div key={i} className="my-1 mx-2 h-px bg-border" />
                  ) : (
                    <button
                      key={i}
                      onClick={() => { if (!item.disabled) item.action?.(); }}
                      disabled={item.disabled}
                      className={cn(
                        'w-full flex items-center justify-between px-3 py-1 text-xs text-left',
                        item.disabled
                          ? 'text-muted-foreground/40 cursor-default'
                          : 'text-popover-foreground hover:bg-accent'
                      )}
                    >
                      <span>{item.label}</span>
                      {item.shortcut && (
                        <span className="text-[10px] text-muted-foreground/60 ml-6">{item.shortcut}</span>
                      )}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Center title - draggable */}
      <div
        className="flex-1 h-full flex items-center justify-center"
        style={{ '--wails-draggable': 'drag' } as React.CSSProperties}
      >
        <span className="text-[11px] text-muted-foreground/50">LDAPilot</span>
      </div>

      {/* Window Controls */}
      <div className="flex items-center h-full" style={{ '--wails-draggable': 'no-drag' } as React.CSSProperties}>
        <button
          onClick={handleMinimize}
          className="w-[46px] h-full flex items-center justify-center text-muted-foreground hover:bg-white/10 transition-colors"
          title="Minimize"
        >
          <Minus size={14} strokeWidth={1.5} />
        </button>
        <button
          onClick={handleMaximize}
          className="w-[46px] h-full flex items-center justify-center text-muted-foreground hover:bg-white/10 transition-colors"
          title={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? <Copy size={11} strokeWidth={1.5} /> : <Square size={11} strokeWidth={1.5} />}
        </button>
        <button
          onClick={handleClose}
          className="w-[46px] h-full flex items-center justify-center text-muted-foreground hover:bg-[#c42b1c] hover:text-white transition-colors"
          title="Close"
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}
