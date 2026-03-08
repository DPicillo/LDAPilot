import { useEffect, useState } from 'react'
import { X, Keyboard } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { useEditorStore } from '../../stores/editorStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { cn } from '../../lib/utils'

interface Shortcut {
  keys: string[];
  description: string;
  category: string;
}

const shortcuts: Shortcut[] = [
  // Navigation
  { keys: ['Ctrl', '1'], description: 'Connections panel', category: 'Navigation' },
  { keys: ['Ctrl', '2'], description: 'Explorer panel', category: 'Navigation' },
  { keys: ['Ctrl', '3'], description: 'Search panel', category: 'Navigation' },
  { keys: ['Ctrl', 'B'], description: 'Toggle sidebar', category: 'Navigation' },
  { keys: ['Ctrl', 'J'], description: 'Toggle bottom panel', category: 'Navigation' },
  { keys: ['Ctrl', 'G'], description: 'Go to DN', category: 'Navigation' },
  { keys: ['Ctrl', '?'], description: 'Show keyboard shortcuts', category: 'Navigation' },
  // Editor
  { keys: ['Ctrl', 'W'], description: 'Close active tab', category: 'Editor' },
  { keys: ['Ctrl', 'Tab'], description: 'Next tab', category: 'Editor' },
  { keys: ['Alt', '\u2190'], description: 'Navigate back', category: 'Editor' },
  { keys: ['Alt', '\u2192'], description: 'Navigate forward', category: 'Editor' },
  // Actions
  { keys: ['Ctrl', 'F'], description: 'Focus search/filter', category: 'Actions' },
  { keys: ['F5'], description: 'Refresh current view', category: 'Actions' },
  { keys: ['Escape'], description: 'Close dialog / cancel', category: 'Actions' },
];

export function useKeyboardShortcuts() {
  const setActivity = useUIStore((s) => s.setActivity);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleBottomPanel = useUIStore((s) => s.toggleBottomPanel);
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const closeTab = useEditorStore((s) => s.closeTab);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const goBack = useEditorStore((s) => s.goBack);
  const goForward = useEditorStore((s) => s.goForward);
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const refreshEntry = useEditorStore((s) => s.refreshEntry);
  const tabs = useEditorStore((s) => s.tabs);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ignore if in input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      // Ctrl+? — show help (works everywhere)
      if (e.ctrlKey && (e.key === '?' || e.key === '/')) {
        e.preventDefault();
        setShowHelp(prev => !prev);
        return;
      }

      // Ctrl+B — toggle sidebar
      if (e.ctrlKey && e.key === 'b' && !isInput) {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // Ctrl+J — toggle bottom panel
      if (e.ctrlKey && e.key === 'j' && !isInput) {
        e.preventDefault();
        toggleBottomPanel();
        return;
      }

      // Ctrl+1/2/3 — switch panels
      if (e.ctrlKey && e.key === '1') {
        e.preventDefault();
        setActivity('connections');
        if (!sidebarVisible) toggleSidebar();
        return;
      }
      if (e.ctrlKey && e.key === '2') {
        e.preventDefault();
        setActivity('explorer');
        if (!sidebarVisible) toggleSidebar();
        return;
      }
      if (e.ctrlKey && e.key === '3') {
        e.preventDefault();
        setActivity('search');
        if (!sidebarVisible) toggleSidebar();
        return;
      }

      // Ctrl+W — close active tab
      if (e.ctrlKey && e.key === 'w' && !isInput) {
        e.preventDefault();
        if (activeTabId) closeTab(activeTabId);
        return;
      }

      // Alt+Left/Right — navigate
      if (e.altKey && e.key === 'ArrowLeft' && !isInput) {
        e.preventDefault();
        goBack();
        return;
      }
      if (e.altKey && e.key === 'ArrowRight' && !isInput) {
        e.preventDefault();
        goForward();
        return;
      }

      // F5 — refresh current entry
      if (e.key === 'F5') {
        e.preventDefault();
        if (activeProfileId && activeTabId) {
          const tab = tabs.find(t => t.id === activeTabId);
          if (tab) refreshEntry(tab.profileId, tab.dn);
        }
        return;
      }

      // Escape — close help
      if (e.key === 'Escape') {
        if (showHelp) {
          setShowHelp(false);
          e.preventDefault();
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [setActivity, toggleSidebar, toggleBottomPanel, sidebarVisible, closeTab, activeTabId, goBack, goForward, showHelp, activeProfileId, refreshEntry, tabs]);

  return { showHelp, setShowHelp };
}

export function KeyboardShortcutsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const categories = [...new Set(shortcuts.map(s => s.category))];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg shadow-2xl w-[500px] max-w-[90vw] max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Keyboard size={16} className="text-primary" />
            Keyboard Shortcuts
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-4">
          {categories.map(cat => (
            <div key={cat}>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{cat}</h3>
              <div className="space-y-1">
                {shortcuts.filter(s => s.category === cat).map((s, i) => (
                  <div key={i} className="flex items-center justify-between py-1">
                    <span className="text-xs text-foreground">{s.description}</span>
                    <div className="flex items-center gap-1">
                      {s.keys.map((key, ki) => (
                        <span key={ki}>
                          {ki > 0 && <span className="text-muted-foreground mx-0.5">+</span>}
                          <kbd className={cn(
                            'inline-flex items-center justify-center min-w-[24px] h-5 px-1.5',
                            'text-[10px] font-mono rounded',
                            'bg-background border border-border shadow-sm',
                          )}>
                            {key}
                          </kbd>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground text-center shrink-0">
          Press <kbd className="px-1 py-0.5 bg-background border border-border rounded text-[9px]">Ctrl+?</kbd> to toggle this dialog
        </div>
      </div>
    </div>
  );
}
