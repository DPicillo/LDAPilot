import { useState, useEffect, useRef, useMemo } from 'react'
import { Navigation, Loader2, AlertCircle } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { useBookmarkStore } from '../../stores/bookmarkStore'
import * as wails from '../../lib/wails'
import { toast } from './Toast'

interface GoToDNDialogProps {
  onClose: () => void;
}

export function GoToDNDialog({ onClose }: GoToDNDialogProps) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const isConnected = useConnectionStore((s) =>
    activeProfileId ? s.connectionStatuses[activeProfileId] === true : false
  );
  const openEntry = useEditorStore((s) => s.openEntry);
  const allBookmarks = useBookmarkStore((s) => s.bookmarks);
  const bookmarks = useMemo(() =>
    activeProfileId
      ? allBookmarks.filter(b => b.profileId === activeProfileId).sort((a, b) => a.label.localeCompare(b.label))
      : [],
    [allBookmarks, activeProfileId]
  );
  const recentDNs = useEditorStore((s) => s.tabs.map(t => t.dn));

  const [dn, setDN] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  async function handleGo() {
    if (!activeProfileId || !isConnected || !dn.trim()) return;
    setLoading(true);
    setError(null);
    try {
      // Verify the entry exists
      const entry = await wails.GetEntry(activeProfileId, dn.trim());
      if (!entry) {
        setError('Entry not found');
        return;
      }
      openEntry(activeProfileId, dn.trim());
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Entry not found');
    } finally {
      setLoading(false);
    }
  }

  // Build suggestions from bookmarks + recent tabs
  const suggestions = [...new Set([
    ...bookmarks.map(b => b.dn),
    ...recentDNs,
  ])].filter(d => {
    if (!dn) return true;
    return d.toLowerCase().includes(dn.toLowerCase());
  }).slice(0, 8);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/40" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg shadow-2xl w-[550px] max-w-[90vw] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
          <Navigation size={14} className="text-primary shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={dn}
            onChange={e => { setDN(e.target.value); setError(null); }}
            placeholder="Enter DN to navigate to..."
            className="flex-1 text-sm bg-transparent border-none outline-none font-mono placeholder:text-muted-foreground/50"
            onKeyDown={e => {
              if (e.key === 'Enter') handleGo();
            }}
          />
          {loading && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-destructive bg-destructive/10">
            <AlertCircle size={12} />
            {error}
          </div>
        )}

        {/* Suggestions */}
        {suggestions.length > 0 && (
          <div className="max-h-[240px] overflow-auto">
            {suggestions.map(sugDN => {
              const rdn = sugDN.split(',')[0];
              return (
                <button
                  key={sugDN}
                  onClick={() => {
                    if (activeProfileId) {
                      openEntry(activeProfileId, sugDN);
                      onClose();
                    }
                  }}
                  className="w-full flex items-start gap-2 px-3 py-1.5 text-left hover:bg-accent/50 border-b border-border/30"
                >
                  <span className="text-xs text-foreground font-medium shrink-0 mt-0.5">{rdn}</span>
                  <span className="text-[10px] font-mono text-muted-foreground truncate" title={sugDN}>{sugDN}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Footer hint */}
        <div className="px-3 py-1.5 text-[10px] text-muted-foreground bg-card/50 border-t border-border">
          <kbd className="px-1 py-0.5 bg-secondary rounded text-[9px] border border-border mr-1">Enter</kbd>
          to navigate
          <kbd className="px-1 py-0.5 bg-secondary rounded text-[9px] border border-border ml-3 mr-1">Esc</kbd>
          to close
        </div>
      </div>
    </div>
  );
}
