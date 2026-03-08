import { useEffect, useState, useCallback } from 'react'
import { useUIStore } from '../stores/uiStore'
import { useEditorStore } from '../stores/editorStore'
import { useConnectionStore } from '../stores/connectionStore'

export function useKeyboardShortcuts() {
  const setActivity = useUIStore((s) => s.setActivity);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const toggleBottomPanel = useUIStore((s) => s.toggleBottomPanel);
  const closeTab = useEditorStore((s) => s.closeTab);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const tabs = useEditorStore((s) => s.tabs);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const goBack = useEditorStore((s) => s.goBack);
  const goForward = useEditorStore((s) => s.goForward);
  const refreshEntry = useEditorStore((s) => s.refreshEntry);
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showGoToDN, setShowGoToDN] = useState(false);

  const toggleShortcuts = useCallback(() => setShowShortcuts(prev => !prev), []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const alt = e.altKey;

      // Ctrl+? or Ctrl+/ — toggle shortcuts overlay (works always)
      if (ctrl && (e.key === '?' || e.key === '/')) {
        e.preventDefault();
        setShowShortcuts(prev => !prev);
        return;
      }

      // Escape — close overlays
      if (e.key === 'Escape') {
        if (showShortcuts) {
          setShowShortcuts(false);
          e.preventDefault();
          return;
        }
      }

      // Alt+Left: Navigate back
      if (alt && !ctrl && e.key === 'ArrowLeft') {
        e.preventDefault();
        goBack();
        return;
      }

      // Alt+Right: Navigate forward
      if (alt && !ctrl && e.key === 'ArrowRight') {
        e.preventDefault();
        goForward();
        return;
      }

      // Ctrl+B: Toggle sidebar
      if (ctrl && !shift && e.key === 'b') {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // Ctrl+Shift+E: Show explorer
      if (ctrl && shift && e.key === 'E') {
        e.preventDefault();
        setActivity('explorer');
        if (!sidebarVisible) toggleSidebar();
        return;
      }

      // Ctrl+Shift+F: Show search
      if (ctrl && shift && e.key === 'F') {
        e.preventDefault();
        setActivity('search');
        if (!sidebarVisible) toggleSidebar();
        return;
      }

      // Ctrl+Shift+C: Show connections
      if (ctrl && shift && e.key === 'C') {
        e.preventDefault();
        setActivity('connections');
        if (!sidebarVisible) toggleSidebar();
        return;
      }

      // Ctrl+G: Go to DN
      if (ctrl && !shift && e.key === 'g') {
        e.preventDefault();
        setShowGoToDN(prev => !prev);
        return;
      }

      // Ctrl+J: Toggle bottom panel
      if (ctrl && !shift && e.key === 'j') {
        e.preventDefault();
        toggleBottomPanel();
        return;
      }

      // Ctrl+W: Close active tab
      if (ctrl && !shift && e.key === 'w') {
        e.preventDefault();
        if (activeTabId) closeTab(activeTabId);
        return;
      }

      // F5: Refresh current entry
      if (e.key === 'F5') {
        e.preventDefault();
        if (activeProfileId && activeTabId) {
          const tab = tabs.find(t => t.id === activeTabId);
          if (tab) refreshEntry(tab.profileId, tab.dn);
        }
        return;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab: Cycle through tabs
      if (ctrl && e.key === 'Tab') {
        e.preventDefault();
        if (tabs.length <= 1) return;
        const idx = tabs.findIndex(t => t.id === activeTabId);
        if (shift) {
          const prev = idx <= 0 ? tabs.length - 1 : idx - 1;
          setActiveTab(tabs[prev].id);
        } else {
          const next = idx >= tabs.length - 1 ? 0 : idx + 1;
          setActiveTab(tabs[next].id);
        }
        return;
      }

      // Ctrl+1-9: Switch to tab by index
      if (ctrl && !shift && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const idx = parseInt(e.key) - 1;
        if (idx < tabs.length) {
          setActiveTab(tabs[idx].id);
        }
        return;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setActivity, toggleSidebar, sidebarVisible, toggleBottomPanel, closeTab, activeTabId, tabs, setActiveTab, goBack, goForward, showShortcuts, activeProfileId, refreshEntry]);

  return {
    showShortcuts,
    toggleShortcuts,
    closeShortcuts: () => setShowShortcuts(false),
    showGoToDN,
    closeGoToDN: () => setShowGoToDN(false),
  };
}
