import { useState, useEffect, useRef } from 'react'
import { ChevronDown, Search, Terminal, Trash2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useUIStore } from '../../stores/uiStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { SearchResults } from '../search/SearchResults'
import * as wails from '../../lib/wails'
import type { LogEntry } from '../../lib/wails'

type BottomTab = 'search-results' | 'output';

interface BottomTabItem {
  id: BottomTab;
  label: string;
  icon: React.ElementType;
}

const bottomTabs: BottomTabItem[] = [
  { id: 'search-results', label: 'Search Results', icon: Search },
  { id: 'output', label: 'Output', icon: Terminal },
];

export function BottomPanel() {
  const [activeTab, setActiveTab] = useState<BottomTab>('search-results');
  const toggleBottomPanel = useUIStore((s) => s.toggleBottomPanel);

  return (
    <div className="h-full flex flex-col bg-background border-t border-border">
      {/* Panel Header */}
      <div className="flex items-center justify-between px-2 h-[35px] border-b border-border shrink-0">
        <div className="flex items-center gap-1">
          {bottomTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex items-center gap-1.5 px-2 py-1 text-xs rounded-sm',
                  'transition-colors duration-100',
                  activeTab === tab.id
                    ? 'text-foreground border-b-2 border-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon size={14} />
                {tab.label}
              </button>
            );
          })}
        </div>
        <button
          onClick={toggleBottomPanel}
          className="p-1 text-muted-foreground hover:text-foreground rounded-sm hover:bg-accent"
          title="Hide Panel"
        >
          <ChevronDown size={16} />
        </button>
      </div>

      {/* Panel Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'search-results' && <SearchResults />}
        {activeTab === 'output' && <OutputLog />}
      </div>
    </div>
  );
}

function OutputLog() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const connectionStatuses = useConnectionStore((s) => s.connectionStatuses);
  const isConnected = activeProfileId ? connectionStatuses[activeProfileId] : false;
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeProfileId || !isConnected) {
      setLogs([]);
      return;
    }

    // Load existing logs
    wails.GetLogs(activeProfileId).then(setLogs);

    // Start streaming
    wails.StartLogStream(activeProfileId);

    // Listen for new log entries via Wails events
    const w = (window as any);
    if (w.runtime?.EventsOn) {
      const cancel = w.runtime.EventsOn('operation:log', (entry: LogEntry) => {
        setLogs(prev => [...prev, entry]);
      });
      return () => {
        if (typeof cancel === 'function') cancel();
      };
    }
  }, [activeProfileId, isConnected]);

  useEffect(() => {
    // Auto-scroll to bottom
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  function handleClear() {
    if (activeProfileId) {
      wails.ClearLogs(activeProfileId);
      setLogs([]);
    }
  }

  if (!isConnected) {
    return (
      <div className="text-muted-foreground text-xs p-3 font-mono">
        Connect to a server to see operation logs.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-end px-2 py-1 border-b border-border shrink-0">
        <button
          onClick={handleClear}
          className="p-1 text-muted-foreground hover:text-foreground rounded-sm hover:bg-accent"
          title="Clear Logs"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <div ref={logRef} className="flex-1 overflow-auto p-2 font-mono text-[11px]">
        {logs.length === 0 ? (
          <span className="text-muted-foreground">Ready.</span>
        ) : (
          logs.map((log, i) => (
            <div key={i} className="flex gap-2 py-0.5 hover:bg-accent/30">
              <span className="text-muted-foreground shrink-0">{log.timestamp}</span>
              <span className={cn(
                'font-semibold shrink-0 w-16',
                log.error ? 'text-destructive' : 'text-green-400'
              )}>
                {log.operation}
              </span>
              <span className="text-foreground truncate flex-1">{log.details}</span>
              <span className="text-muted-foreground shrink-0">{log.duration}</span>
              {log.error && (
                <span className="text-destructive shrink-0">{log.error}</span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
