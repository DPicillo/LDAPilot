import { useState, useEffect, useRef, useMemo } from 'react'
import { ChevronDown, Search, Terminal, Trash2, Filter, Clock, AlertCircle, CheckCircle2, XCircle, ScrollText, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useUIStore } from '../../stores/uiStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { SearchResults } from '../search/SearchResults'
import * as wails from '../../lib/wails'
import type { LogEntry, AuditEntry } from '../../lib/wails'

import type { BottomTab } from '../../stores/uiStore'

interface BottomTabItem {
  id: BottomTab;
  label: string;
  icon: React.ElementType;
}

const bottomTabs: BottomTabItem[] = [
  { id: 'search-results', label: 'Search Results', icon: Search },
  { id: 'output', label: 'Operations', icon: Terminal },
  { id: 'audit', label: 'Audit Log', icon: ScrollText },
];

export function BottomPanel() {
  const activeTab = useUIStore((s) => s.bottomPanelTab);
  const showBottomTab = useUIStore((s) => s.showBottomTab);
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
                onClick={() => showBottomTab(tab.id)}
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
        {activeTab === 'audit' && <AuditLog />}
      </div>
    </div>
  );
}

// Operation type color mapping
const OP_COLORS: Record<string, string> = {
  SEARCH: 'text-blue-400',
  BIND: 'text-purple-400',
  ADD: 'text-green-400',
  MODIFY: 'text-yellow-400',
  DELETE: 'text-red-400',
  RENAME: 'text-orange-400',
  COMPARE: 'text-cyan-400',
};

function getOpColor(op: string): string {
  const upper = op.toUpperCase();
  for (const [key, color] of Object.entries(OP_COLORS)) {
    if (upper.includes(key)) return color;
  }
  return 'text-muted-foreground';
}

function OutputLog() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const connectionStatuses = useConnectionStore((s) => s.connectionStatuses);
  const isConnected = activeProfileId ? connectionStatuses[activeProfileId] : false;
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

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
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const filteredLogs = useMemo(() => {
    let result = logs;
    if (showErrors) {
      result = result.filter(l => l.error);
    }
    if (filter) {
      const f = filter.toLowerCase();
      result = result.filter(l =>
        l.operation.toLowerCase().includes(f) ||
        l.details.toLowerCase().includes(f) ||
        (l.error && l.error.toLowerCase().includes(f))
      );
    }
    return result;
  }, [logs, filter, showErrors]);

  const errorCount = logs.filter(l => l.error).length;

  function handleClear() {
    if (activeProfileId) {
      wails.ClearLogs(activeProfileId);
      setLogs([]);
    }
  }

  function handleScroll() {
    if (logRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = logRef.current;
      setAutoScroll(scrollHeight - scrollTop - clientHeight < 30);
    }
  }

  if (!isConnected) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-xs">
        <Terminal size={16} className="mr-2 opacity-40" />
        Connect to a server to see operations
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col relative">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border shrink-0">
        <div className="flex items-center gap-1 flex-1">
          <Filter size={11} className="text-muted-foreground shrink-0" />
          <input
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter operations..."
            className="flex-1 text-xs bg-transparent border-none outline-none placeholder:text-muted-foreground/50"
          />
        </div>
        <button
          onClick={() => setShowErrors(!showErrors)}
          className={cn(
            'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded',
            showErrors ? 'bg-red-500/15 text-red-400' : 'text-muted-foreground hover:text-foreground'
          )}
          title="Show errors only"
        >
          <AlertCircle size={10} />
          {errorCount > 0 && errorCount}
        </button>
        <span className="text-[10px] text-muted-foreground">
          {filteredLogs.length}/{logs.length}
        </span>
        <button
          onClick={handleClear}
          className="p-0.5 text-muted-foreground hover:text-foreground rounded hover:bg-accent"
          title="Clear"
        >
          <Trash2 size={11} />
        </button>
      </div>

      {/* Log entries */}
      <div
        ref={logRef}
        className="flex-1 overflow-auto font-mono text-[11px]"
        onScroll={handleScroll}
      >
        {filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
            {logs.length === 0 ? 'Waiting for operations...' : 'No matching operations'}
          </div>
        ) : (
          <table className="w-full">
            <tbody>
              {filteredLogs.map((log, i) => (
                <tr key={i} className="hover:bg-accent/30 border-b border-border/20">
                  <td className="px-2 py-0.5 text-muted-foreground shrink-0 whitespace-nowrap w-[1%]">
                    <div className="flex items-center gap-1">
                      <Clock size={9} className="opacity-50" />
                      {log.timestamp}
                    </div>
                  </td>
                  <td className="px-2 py-0.5 whitespace-nowrap w-[1%]">
                    {log.error ? (
                      <XCircle size={10} className="text-red-400" />
                    ) : (
                      <CheckCircle2 size={10} className="text-green-400/60" />
                    )}
                  </td>
                  <td className={cn('px-2 py-0.5 font-semibold whitespace-nowrap w-[1%]', getOpColor(log.operation))}>
                    {log.operation}
                  </td>
                  <td className="px-2 py-0.5 text-foreground truncate max-w-0">
                    <span className="truncate block">
                      {log.details}
                      {log.error && (
                        <span className="text-red-400 ml-2" title={log.error}>{log.error}</span>
                      )}
                    </span>
                  </td>
                  <td className="px-2 py-0.5 text-muted-foreground whitespace-nowrap w-[1%] text-right">
                    {log.duration}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Auto-scroll indicator */}
      {!autoScroll && logs.length > 0 && (
        <button
          onClick={() => {
            setAutoScroll(true);
            if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
          }}
          className="absolute bottom-1 right-2 text-[10px] px-2 py-0.5 rounded bg-primary text-primary-foreground shadow"
        >
          Scroll to latest
        </button>
      )}
    </div>
  );
}

// Audit operation color mapping
const AUDIT_OP_COLORS: Record<string, string> = {
  CREATE: 'text-green-400',
  MODIFY: 'text-yellow-400',
  DELETE: 'text-red-400',
  RENAME: 'text-orange-400',
  ADD_ATTR: 'text-cyan-400',
  DEL_ATTR: 'text-pink-400',
  MOVE: 'text-purple-400',
};

function getAuditOpColor(op: string): string {
  return AUDIT_OP_COLORS[op.toUpperCase()] || 'text-muted-foreground';
}

function AuditLog() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const connectionStatuses = useConnectionStore((s) => s.connectionStatuses);
  const isConnected = activeProfileId ? connectionStatuses[activeProfileId] : false;
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadEntries = async () => {
    if (!activeProfileId) return;
    setLoading(true);
    try {
      const result = await wails.GetAuditLog(activeProfileId, 500);
      setEntries(result || []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!activeProfileId || !isConnected) {
      setEntries([]);
      return;
    }
    loadEntries();
  }, [activeProfileId, isConnected]);

  const filteredEntries = useMemo(() => {
    let result = entries;
    if (showErrors) {
      result = result.filter(e => e.error);
    }
    if (filter) {
      const f = filter.toLowerCase();
      result = result.filter(e =>
        e.operation.toLowerCase().includes(f) ||
        e.dn.toLowerCase().includes(f) ||
        (e.details && e.details.toLowerCase().includes(f)) ||
        (e.error && e.error.toLowerCase().includes(f))
      );
    }
    return result;
  }, [entries, filter, showErrors]);

  const errorCount = entries.filter(e => e.error).length;

  function handleClear() {
    if (activeProfileId) {
      wails.ClearAuditLog(activeProfileId);
      setEntries([]);
    }
  }

  if (!isConnected) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-xs">
        <ScrollText size={16} className="mr-2 opacity-40" />
        Connect to a server to see audit log
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border shrink-0">
        <div className="flex items-center gap-1 flex-1">
          <Filter size={11} className="text-muted-foreground shrink-0" />
          <input
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter audit entries..."
            className="flex-1 text-xs bg-transparent border-none outline-none placeholder:text-muted-foreground/50"
          />
        </div>
        <button
          onClick={() => setShowErrors(!showErrors)}
          className={cn(
            'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded',
            showErrors ? 'bg-red-500/15 text-red-400' : 'text-muted-foreground hover:text-foreground'
          )}
          title="Show errors only"
        >
          <AlertCircle size={10} />
          {errorCount > 0 && errorCount}
        </button>
        <span className="text-[10px] text-muted-foreground">
          {filteredEntries.length}/{entries.length}
        </span>
        <button
          onClick={loadEntries}
          className="p-0.5 text-muted-foreground hover:text-foreground rounded hover:bg-accent"
          title="Refresh"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={handleClear}
          className="p-0.5 text-muted-foreground hover:text-foreground rounded hover:bg-accent"
          title="Clear audit log"
        >
          <Trash2 size={11} />
        </button>
      </div>

      {/* Entries */}
      <div className="flex-1 overflow-auto font-mono text-[11px]">
        {filteredEntries.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
            {entries.length === 0 ? 'No audit entries yet — changes will be logged here' : 'No matching entries'}
          </div>
        ) : (
          <table className="w-full">
            <thead className="sticky top-0 bg-card z-10">
              <tr className="border-b border-border text-[10px] text-muted-foreground">
                <th className="px-2 py-0.5 text-left font-medium">Time</th>
                <th className="px-2 py-0.5 text-left font-medium w-[1%]"></th>
                <th className="px-2 py-0.5 text-left font-medium">Operation</th>
                <th className="px-2 py-0.5 text-left font-medium">DN</th>
                <th className="px-2 py-0.5 text-left font-medium">Details</th>
                <th className="px-2 py-0.5 text-left font-medium">User</th>
              </tr>
            </thead>
            <tbody>
              {filteredEntries.map((entry, i) => (
                <tr key={i} className="hover:bg-accent/30 border-b border-border/20">
                  <td className="px-2 py-0.5 text-muted-foreground whitespace-nowrap w-[1%]">
                    {entry.timestamp}
                  </td>
                  <td className="px-2 py-0.5 whitespace-nowrap w-[1%]">
                    {entry.error ? (
                      <XCircle size={10} className="text-red-400" />
                    ) : (
                      <CheckCircle2 size={10} className="text-green-400/60" />
                    )}
                  </td>
                  <td className={cn('px-2 py-0.5 font-semibold whitespace-nowrap w-[1%]', getAuditOpColor(entry.operation))}>
                    {entry.operation}
                  </td>
                  <td className="px-2 py-0.5 text-foreground truncate max-w-0" title={entry.dn}>
                    <span className="truncate block">{entry.dn}</span>
                  </td>
                  <td className="px-2 py-0.5 text-muted-foreground truncate max-w-0" title={entry.details || ''}>
                    <span className="truncate block">{entry.details}</span>
                  </td>
                  <td className="px-2 py-0.5 text-muted-foreground truncate max-w-[120px]" title={entry.user || ''}>
                    {entry.user && entry.user.split(',')[0]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
