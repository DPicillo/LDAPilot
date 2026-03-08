import { useMemo } from 'react'
import { Star, Trash2, ExternalLink } from 'lucide-react'
import { useBookmarkStore } from '../../stores/bookmarkStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { getIconForObjectClass, getIconColor } from '../../lib/ldap-icons'
import { cn } from '../../lib/utils'

export function BookmarkPanel() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const connectionStatuses = useConnectionStore((s) => s.connectionStatuses);
  const allBookmarks = useBookmarkStore((s) => s.bookmarks);
  const bookmarks = useMemo(() =>
    activeProfileId
      ? allBookmarks.filter(b => b.profileId === activeProfileId).sort((a, b) => a.label.localeCompare(b.label))
      : [],
    [allBookmarks, activeProfileId]
  );
  const removeBookmark = useBookmarkStore((s) => s.removeBookmark);
  const clearBookmarks = useBookmarkStore((s) => s.clearBookmarks);
  const openEntry = useEditorStore((s) => s.openEntry);

  const isConnected = activeProfileId ? connectionStatuses[activeProfileId] === true : false;

  if (!isConnected || !activeProfileId) {
    return (
      <div className="h-full flex flex-col bg-sidebar">
        <div className="flex items-center px-4 h-9 shrink-0 border-b border-border">
          <span className="text-xs font-semibold uppercase tracking-wider text-secondary-foreground">
            Bookmarks
          </span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4">
          <Star size={48} strokeWidth={1} className="mb-4 opacity-40" />
          <p className="text-sm text-center">Connect to a server to see bookmarks</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-sidebar">
      <div className="flex items-center justify-between px-4 h-9 shrink-0 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-secondary-foreground">
          Bookmarks
        </span>
        {bookmarks.length > 0 && (
          <button
            onClick={() => clearBookmarks(activeProfileId)}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            Clear All
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto py-1">
        {bookmarks.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8 px-4">
            <Star size={24} strokeWidth={1} className="mx-auto mb-2 opacity-40" />
            <p>No bookmarks yet.</p>
            <p className="text-[10px] mt-1">Right-click an entry and select "Bookmark" to add one.</p>
          </div>
        ) : (
          bookmarks.map(bm => (
            <div
              key={bm.dn}
              className="flex items-center gap-1.5 px-3 py-1 hover:bg-accent/50 cursor-pointer group"
              onClick={() => openEntry(activeProfileId, bm.dn)}
            >
              <Star size={12} className="text-yellow-500 shrink-0 fill-yellow-500" />
              <div className="flex-1 min-w-0">
                <div className="text-xs truncate">{bm.label}</div>
                <div className="text-[10px] text-muted-foreground truncate font-mono">{bm.dn}</div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); removeBookmark(activeProfileId, bm.dn); }}
                className="p-0.5 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 shrink-0"
                title="Remove bookmark"
              >
                <Trash2 size={10} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
