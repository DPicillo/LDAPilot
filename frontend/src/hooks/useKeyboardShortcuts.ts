import { useEffect } from 'react'
import { useUIStore } from '../stores/uiStore'
import { useEditorStore } from '../stores/editorStore'

export function useKeyboardShortcuts() {
  const setActivity = useUIStore((s) => s.setActivity);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleBottomPanel = useUIStore((s) => s.toggleBottomPanel);
  const closeTab = useEditorStore((s) => s.closeTab);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const tabs = useEditorStore((s) => s.tabs);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const goBack = useEditorStore((s) => s.goBack);
  const goForward = useEditorStore((s) => s.goForward);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const alt = e.altKey;

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
        return;
      }

      // Ctrl+Shift+F: Show search
      if (ctrl && shift && e.key === 'F') {
        e.preventDefault();
        setActivity('search');
        return;
      }

      // Ctrl+Shift+C: Show connections
      if (ctrl && shift && e.key === 'C') {
        e.preventDefault();
        setActivity('connections');
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
  }, [setActivity, toggleSidebar, toggleBottomPanel, closeTab, activeTabId, tabs, setActiveTab, goBack, goForward]);
}
