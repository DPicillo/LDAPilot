import { useState } from 'react'
import { Search, Loader2, AlertCircle, ChevronDown, Clock, Pin, Trash2, Wand2 } from 'lucide-react'
import { useSearchStore, SearchHistoryItem } from '../../stores/searchStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useUIStore } from '../../stores/uiStore'
import { ScopeBase, ScopeOne, ScopeSub, SearchScope } from '../../types/ldap'
import { cn } from '../../lib/utils'
import { FilterBuilder } from './FilterBuilder'

const FILTER_TEMPLATES = [
  { label: 'All Entries', filter: '(objectClass=*)' },
  { label: 'All Users', filter: '(&(objectClass=person)(objectClass=user))' },
  { label: 'All Groups', filter: '(objectClass=group)' },
  { label: 'All OUs', filter: '(objectClass=organizationalUnit)' },
  { label: 'All Computers', filter: '(objectClass=computer)' },
  { label: 'Disabled Accounts', filter: '(&(objectClass=user)(userAccountControl:1.2.840.113556.1.4.803:=2))' },
  { label: 'POSIX Users', filter: '(objectClass=posixAccount)' },
  { label: 'POSIX Groups', filter: '(objectClass=posixGroup)' },
];

const SCOPE_OPTIONS: { label: string; value: SearchScope }[] = [
  { label: 'Base', value: ScopeBase },
  { label: 'One Level', value: ScopeOne },
  { label: 'Subtree', value: ScopeSub },
];

export function SearchPanel() {
  const { params, loading, error, history, setParams, executeSearch, clearResults, restoreSearch, togglePin, removeHistory, clearHistory } = useSearchStore();
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const connectionStatuses = useConnectionStore((s) => s.connectionStatuses);
  const profiles = useConnectionStore((s) => s.profiles);
  const toggleBottomPanel = useUIStore((s) => s.toggleBottomPanel);
  const bottomPanelVisible = useUIStore((s) => s.bottomPanelVisible);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);

  const isConnected = activeProfileId ? connectionStatuses[activeProfileId] === true : false;
  const activeProfile = activeProfileId ? profiles.find(p => p.id === activeProfileId) : null;

  async function handleSearch() {
    if (!activeProfileId || !isConnected) return;
    if (!bottomPanelVisible) toggleBottomPanel();
    await executeSearch(activeProfileId);
  }

  if (!isConnected) {
    return (
      <div className="h-full flex flex-col bg-sidebar">
        <div className="flex items-center px-4 h-9 shrink-0 border-b border-border">
          <span className="text-xs font-semibold uppercase tracking-wider text-secondary-foreground">
            Search
          </span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4">
          <Search size={48} strokeWidth={1} className="mb-4 opacity-40" />
          <p className="text-sm text-center">Connect to a server to search</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-sidebar">
      <div className="flex items-center px-4 h-9 shrink-0 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-secondary-foreground">
          Search
        </span>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-3">
        {/* Base DN */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Base DN</label>
          <input
            type="text"
            value={params.baseDN || activeProfile?.baseDN || ''}
            onChange={(e) => setParams({ baseDN: e.target.value })}
            placeholder={activeProfile?.baseDN || 'dc=example,dc=com'}
            className="input-field"
          />
        </div>

        {/* Scope */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Scope</label>
          <select
            value={params.scope}
            onChange={(e) => setParams({ scope: Number(e.target.value) as SearchScope })}
            className="input-field"
          >
            {SCOPE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Filter */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-muted-foreground">Filter</label>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowBuilder(!showBuilder)}
                className="flex items-center gap-0.5 text-xs text-primary hover:text-primary/80"
              >
                <Wand2 size={10} />
                Builder
              </button>
              <button
                onClick={() => setShowTemplates(!showTemplates)}
                className="flex items-center gap-0.5 text-xs text-primary hover:text-primary/80"
              >
                Templates
                <ChevronDown size={10} className={showTemplates ? 'rotate-180' : ''} />
              </button>
            </div>
          </div>
          <textarea
            value={params.filter}
            onChange={(e) => setParams({ filter: e.target.value })}
            placeholder="(objectClass=*)"
            className="input-field font-mono resize-y min-h-[60px]"
            rows={3}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleSearch();
              }
            }}
          />

          {showBuilder && (
            <div className="mt-2">
              <FilterBuilder
                onApply={(filter) => { setParams({ filter }); setShowBuilder(false); }}
                onClose={() => setShowBuilder(false)}
              />
            </div>
          )}

          {showTemplates && (
            <div className="mt-1 space-y-0.5">
              {FILTER_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.label}
                  onClick={() => {
                    setParams({ filter: tpl.filter });
                    setShowTemplates(false);
                  }}
                  className="w-full text-left text-xs px-2 py-1 rounded hover:bg-accent truncate"
                >
                  <span className="text-foreground">{tpl.label}</span>
                  <span className="text-muted-foreground ml-2 font-mono">{tpl.filter}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Size Limit */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Size Limit</label>
          <input
            type="number"
            value={params.sizeLimit}
            onChange={(e) => setParams({ sizeLimit: parseInt(e.target.value) || 1000 })}
            className="input-field"
          />
        </div>

        {error && (
          <div className="flex items-center gap-2 text-xs px-3 py-2 rounded bg-destructive/10 text-destructive">
            <AlertCircle size={14} />
            {error}
          </div>
        )}

        {/* Buttons */}
        <button
          onClick={handleSearch}
          disabled={loading || !params.filter.trim()}
          className="w-full flex items-center justify-center gap-2 text-xs px-3 py-2 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          {loading ? 'Searching...' : 'Search'}
        </button>

        <button
          onClick={clearResults}
          className="w-full text-xs px-3 py-1.5 rounded border border-border hover:bg-accent text-muted-foreground"
        >
          Clear Results
        </button>

        {/* Search History */}
        {history.length > 0 && (
          <div className="border-t border-border pt-3">
            <div className="flex items-center justify-between mb-2">
              <button
                onClick={() => setShowHistory(!showHistory)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Clock size={12} />
                History ({history.length})
                <ChevronDown size={10} className={showHistory ? 'rotate-180' : ''} />
              </button>
              {showHistory && (
                <button
                  onClick={clearHistory}
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                  Clear
                </button>
              )}
            </div>

            {showHistory && (
              <div className="space-y-1 max-h-[200px] overflow-auto">
                {history
                  .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.timestamp - a.timestamp)
                  .map((item) => (
                    <HistoryItem
                      key={item.id}
                      item={item}
                      onRestore={() => restoreSearch(item)}
                      onTogglePin={() => togglePin(item.id)}
                      onRemove={() => removeHistory(item.id)}
                    />
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryItem({ item, onRestore, onTogglePin, onRemove }: {
  item: SearchHistoryItem;
  onRestore: () => void;
  onTogglePin: () => void;
  onRemove: () => void;
}) {
  const timeAgo = formatTimeAgo(item.timestamp);

  return (
    <div className="flex items-center gap-1 group">
      <button
        onClick={onRestore}
        className="flex-1 text-left text-xs px-2 py-1 rounded hover:bg-accent truncate min-w-0"
        title={`${item.params.filter}\n${item.resultCount} results`}
      >
        <div className="font-mono truncate text-foreground">{item.params.filter}</div>
        <div className="text-[10px] text-muted-foreground">{item.resultCount} results - {timeAgo}</div>
      </button>
      <button
        onClick={onTogglePin}
        className={cn(
          'p-0.5 rounded shrink-0',
          item.pinned ? 'text-primary' : 'text-muted-foreground opacity-0 group-hover:opacity-100'
        )}
        title={item.pinned ? 'Unpin' : 'Pin'}
      >
        <Pin size={10} />
      </button>
      <button
        onClick={onRemove}
        className="p-0.5 rounded text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 shrink-0"
        title="Remove"
      >
        <Trash2 size={10} />
      </button>
    </div>
  );
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
