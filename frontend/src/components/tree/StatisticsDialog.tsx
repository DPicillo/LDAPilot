import { useState, useEffect } from 'react'
import { X, BarChart3, Loader2, Users, FolderTree, Monitor, Box, Globe, HelpCircle } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { cn } from '../../lib/utils'
import * as wails from '../../lib/wails'
import type { ObjectStats } from '../../lib/wails'

interface StatisticsDialogProps {
  dn: string;
  onClose: () => void;
}

const TYPE_ICONS: Record<string, { icon: React.ElementType; color: string }> = {
  Users:      { icon: Users, color: 'text-blue-400' },
  Groups:     { icon: Users, color: 'text-green-400' },
  OUs:        { icon: FolderTree, color: 'text-yellow-400' },
  Computers:  { icon: Monitor, color: 'text-orange-400' },
  Containers: { icon: Box, color: 'text-muted-foreground' },
  Domains:    { icon: Globe, color: 'text-cyan-400' },
  Other:      { icon: HelpCircle, color: 'text-muted-foreground' },
};

export function StatisticsDialog({ dn, onClose }: StatisticsDialogProps) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const [stats, setStats] = useState<ObjectStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeProfileId) return;
    setLoading(true);
    setError(null);
    wails.GetStatistics(activeProfileId, dn).then(s => {
      setStats(s);
      setLoading(false);
    }).catch(err => {
      setError(err?.message || 'Failed to load statistics');
      setLoading(false);
    });
  }, [activeProfileId, dn]);

  const sortedTypes = stats
    ? Object.entries(stats.byType).sort((a, b) => b[1] - a[1])
    : [];

  const maxCount = sortedTypes.length > 0 ? sortedTypes[0][1] : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg shadow-2xl w-[400px] max-w-[90%] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <BarChart3 size={16} className="text-primary" />
            <h2 className="text-sm font-semibold">Object Statistics</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>

        <div className="p-4">
          {/* Base DN */}
          <div className="text-xs font-mono text-muted-foreground mb-3 truncate" title={dn}>
            {dn}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 size={16} className="animate-spin mr-2" />
              <span className="text-xs">Counting objects...</span>
            </div>
          ) : error ? (
            <div className="text-xs text-destructive py-4 text-center">{error}</div>
          ) : stats ? (
            <>
              {/* Total */}
              <div className="flex items-center justify-between mb-4 pb-3 border-b border-border">
                <span className="text-sm font-semibold">Total Objects</span>
                <span className="text-2xl font-bold text-primary">{stats.totalCount.toLocaleString()}</span>
              </div>

              {/* By type */}
              <div className="space-y-2">
                {sortedTypes.map(([type, count]) => {
                  const typeInfo = TYPE_ICONS[type] || TYPE_ICONS['Other'];
                  const Icon = typeInfo.icon;
                  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;

                  return (
                    <div key={type} className="flex items-center gap-2">
                      <Icon size={14} className={cn('shrink-0', typeInfo.color)} />
                      <span className="text-xs w-20 shrink-0">{type}</span>
                      <div className="flex-1 h-4 bg-background rounded overflow-hidden">
                        <div
                          className={cn('h-full rounded transition-all', typeInfo.color.replace('text-', 'bg-').replace('-400', '-500/30'))}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono text-muted-foreground w-12 text-right">
                        {count.toLocaleString()}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Percentage breakdown */}
              {stats.totalCount > 0 && (
                <div className="mt-4 pt-3 border-t border-border flex flex-wrap gap-2">
                  {sortedTypes.map(([type, count]) => {
                    const pct = ((count / stats.totalCount) * 100).toFixed(1);
                    return (
                      <span key={type} className="text-[10px] text-muted-foreground">
                        {type}: {pct}%
                      </span>
                    );
                  })}
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
