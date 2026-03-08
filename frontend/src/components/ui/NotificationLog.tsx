import { useState, useRef, useEffect } from 'react'
import { Bell, X, Trash2, CheckCircle, AlertCircle, Info, Copy, Check } from 'lucide-react'
import { useToastStore } from './Toast'
import { cn } from '../../lib/utils'

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const history = useToastStore((s) => s.history);
  const clearHistory = useToastStore((s) => s.clearHistory);
  const ref = useRef<HTMLDivElement>(null);

  const errorCount = history.filter(h => h.type === 'error').length;
  const hasUnread = history.length > 0;

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [open]);

  const icons = {
    success: <CheckCircle size={12} className="text-green-400 shrink-0" />,
    error: <AlertCircle size={12} className="text-red-400 shrink-0" />,
    info: <Info size={12} className="text-blue-400 shrink-0" />,
  };

  function formatTime(ts: number) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'relative w-12 h-12 flex items-center justify-center',
          'transition-colors duration-150',
          'hover:text-activity-bar-active group',
          open ? 'text-activity-bar-active' : 'text-activity-bar-foreground',
        )}
        title="Notifications"
        aria-label={`Notifications${history.length > 0 ? ` (${history.length} unread)` : ''}`}
      >
        <Bell size={24} strokeWidth={1.5} />
        {hasUnread && (
          <span className={cn(
            'absolute top-2 right-2 min-w-[16px] h-4 rounded-full text-[9px] font-bold flex items-center justify-center px-1',
            errorCount > 0 ? 'bg-red-500 text-white' : 'bg-blue-500 text-white',
          )}>
            {history.length > 99 ? '99+' : history.length}
          </span>
        )}
        {/* Tooltip */}
        <div className={cn(
          'absolute left-14 z-50 px-2 py-1',
          'bg-popover text-popover-foreground text-sm',
          'border border-border rounded shadow-lg whitespace-nowrap',
          'opacity-0 pointer-events-none group-hover:opacity-100',
          'transition-opacity duration-150 delay-300',
        )}>
          Notifications
        </div>
      </button>

      {open && (
        <div className={cn(
          'absolute left-14 bottom-0 z-50 w-96',
          'bg-card border border-border rounded-lg shadow-2xl',
          'animate-in slide-in-from-left-2 fade-in duration-200',
          'flex flex-col max-h-[500px]',
        )}>
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
            <span className="text-xs font-semibold">Notifications</span>
            <div className="flex items-center gap-1">
              {history.length > 0 && (
                <button
                  onClick={clearHistory}
                  className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-accent"
                  title="Clear all"
                >
                  <Trash2 size={12} />
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-accent"
              >
                <X size={12} />
              </button>
            </div>
          </div>

          {/* Log entries */}
          <div className="flex-1 overflow-auto">
            {history.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                <Bell size={24} strokeWidth={1} className="mb-2 opacity-30" />
                <span className="text-xs">No notifications yet</span>
              </div>
            ) : (
              history.map((entry) => (
                <NotificationEntry key={entry.id} entry={entry} icons={icons} formatTime={formatTime} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationEntry({
  entry,
  icons,
  formatTime,
}: {
  entry: { id: string; type: 'success' | 'error' | 'info'; message: string; detail?: string; timestamp: number };
  icons: Record<string, React.ReactNode>;
  formatTime: (ts: number) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text = entry.detail ? `${entry.message}\n\n${entry.detail}` : entry.message;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const bgColors = {
    error: 'hover:bg-red-500/5',
    success: 'hover:bg-green-500/5',
    info: 'hover:bg-blue-500/5',
  };

  return (
    <div
      className={cn(
        'px-3 py-2 border-b border-border/50 cursor-pointer',
        bgColors[entry.type],
      )}
      onClick={() => entry.detail && setExpanded(!expanded)}
    >
      <div className="flex items-start gap-2">
        {icons[entry.type]}
        <div className="flex-1 min-w-0">
          <span className="text-xs leading-relaxed">{entry.message}</span>
          <div className="text-[10px] text-muted-foreground mt-0.5">{formatTime(entry.timestamp)}</div>
        </div>
        {(entry.type === 'error' || entry.detail) && (
          <button
            onClick={(e) => { e.stopPropagation(); handleCopy(); }}
            className="p-0.5 text-muted-foreground hover:text-foreground shrink-0"
            title="Copy"
          >
            {copied ? <Check size={10} className="text-green-400" /> : <Copy size={10} />}
          </button>
        )}
      </div>
      {expanded && entry.detail && (
        <pre className="mt-1.5 text-[10px] text-muted-foreground font-mono whitespace-pre-wrap break-all bg-background/50 rounded p-2">
          {entry.detail}
        </pre>
      )}
    </div>
  );
}
