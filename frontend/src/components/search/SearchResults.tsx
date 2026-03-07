import { AlertTriangle, FileText } from 'lucide-react'
import { useSearchStore } from '../../stores/searchStore'
import { useEditorStore } from '../../stores/editorStore'
import { useConnectionStore } from '../../stores/connectionStore'

export function SearchResults() {
  const results = useSearchStore((s) => s.results);
  const loading = useSearchStore((s) => s.loading);
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const openEntry = useEditorStore((s) => s.openEntry);

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
              truncated
            </span>
          )}
        </span>
      </div>

      {/* Results Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card">
            <tr className="border-b border-border">
              <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">DN</th>
              <th className="text-left px-3 py-1.5 font-medium text-muted-foreground w-32">Object Classes</th>
            </tr>
          </thead>
          <tbody>
            {results.entries.map((entry) => {
              const objectClasses = entry.attributes
                ?.find(a => a.name.toLowerCase() === 'objectclass')
                ?.values || [];
              return (
                <tr
                  key={entry.dn}
                  className="border-b border-border hover:bg-accent/30 cursor-pointer"
                  onClick={() => activeProfileId && openEntry(activeProfileId, entry.dn)}
                  onDoubleClick={() => activeProfileId && openEntry(activeProfileId, entry.dn)}
                >
                  <td className="px-3 py-1 font-mono">
                    <div className="flex items-center gap-1.5">
                      <FileText size={12} className="shrink-0 text-muted-foreground" />
                      <span className="truncate">{entry.dn}</span>
                    </div>
                  </td>
                  <td className="px-3 py-1 text-muted-foreground truncate">
                    {objectClasses.join(', ')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
