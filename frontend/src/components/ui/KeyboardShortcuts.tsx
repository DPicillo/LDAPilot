import { useEffect } from 'react'
import { X, Keyboard } from 'lucide-react'
import { cn } from '../../lib/utils'

interface Shortcut {
  keys: string[];
  description: string;
  category: string;
}

const shortcuts: Shortcut[] = [
  // Navigation
  { keys: ['Ctrl', 'Shift', 'C'], description: 'Connections panel', category: 'Navigation' },
  { keys: ['Ctrl', 'Shift', 'E'], description: 'Explorer panel', category: 'Navigation' },
  { keys: ['Ctrl', 'Shift', 'F'], description: 'Search panel', category: 'Navigation' },
  { keys: ['Ctrl', 'B'], description: 'Toggle sidebar', category: 'Navigation' },
  { keys: ['Ctrl', 'J'], description: 'Toggle bottom panel', category: 'Navigation' },
  { keys: ['Ctrl', 'G'], description: 'Go to DN', category: 'Navigation' },
  { keys: ['Ctrl', '?'], description: 'Show keyboard shortcuts', category: 'Navigation' },
  // Editor
  { keys: ['Ctrl', 'W'], description: 'Close active tab', category: 'Editor' },
  { keys: ['Ctrl', 'Tab'], description: 'Next tab', category: 'Editor' },
  { keys: ['Ctrl', 'Shift', 'Tab'], description: 'Previous tab', category: 'Editor' },
  { keys: ['Ctrl', '1-9'], description: 'Switch to tab by index', category: 'Editor' },
  { keys: ['Alt', '\u2190'], description: 'Navigate back', category: 'Editor' },
  { keys: ['Alt', '\u2192'], description: 'Navigate forward', category: 'Editor' },
  // View
  { keys: ['Ctrl', '+'], description: 'Zoom in', category: 'View' },
  { keys: ['Ctrl', '-'], description: 'Zoom out', category: 'View' },
  { keys: ['Ctrl', '0'], description: 'Reset zoom', category: 'View' },
  // Actions
  { keys: ['F5'], description: 'Refresh current view', category: 'Actions' },
  { keys: ['Escape'], description: 'Close dialog / cancel', category: 'Actions' },
];

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
        className="bg-card border border-border rounded-lg shadow-2xl w-[500px] max-w-[90%] max-h-[80%] flex flex-col"
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
