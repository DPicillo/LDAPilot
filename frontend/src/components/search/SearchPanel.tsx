import { useState, useRef, useEffect } from 'react'
import { Search, Loader2, AlertCircle, ChevronDown, Clock, Pin, Trash2, Wand2, Code, Zap, Info, Save, BookmarkPlus } from 'lucide-react'
import { useSearchStore, SearchHistoryItem, SavedSearch } from '../../stores/searchStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useUIStore } from '../../stores/uiStore'
import { ScopeBase, ScopeOne, ScopeSub, SearchScope } from '../../types/ldap'
import { cn } from '../../lib/utils'
import { FilterBuilder } from './FilterBuilder'
import * as wails from '../../lib/wails'

const FILTER_TEMPLATES = [
  { label: 'All Entries', filter: '(objectClass=*)' },
  { label: 'All Users', filter: '(&(objectClass=person)(objectClass=user))' },
  { label: 'All Groups', filter: '(objectClass=group)' },
  { label: 'All OUs', filter: '(objectClass=organizationalUnit)' },
  { label: 'All Computers', filter: '(objectClass=computer)' },
  { label: 'Disabled Accounts', filter: '(&(objectClass=user)(userAccountControl:1.2.840.113556.1.4.803:=2))' },
  { label: 'Locked-Out Users', filter: '(&(objectClass=user)(lockoutTime>=1))' },
  { label: 'Password Never Expires', filter: '(&(objectClass=user)(userAccountControl:1.2.840.113556.1.4.803:=65536))' },
  { label: 'Empty Groups', filter: '(&(objectClass=group)(!(member=*)))' },
  { label: 'Users w/o Email', filter: '(&(objectClass=user)(!(mail=*)))' },
  { label: 'Service Accounts', filter: '(objectClass=msDS-ManagedServiceAccount)' },
  { label: 'POSIX Users', filter: '(objectClass=posixAccount)' },
  { label: 'POSIX Groups', filter: '(objectClass=posixGroup)' },
];

const SCOPE_OPTIONS: { label: string; value: SearchScope }[] = [
  { label: 'Base', value: ScopeBase },
  { label: 'One Level', value: ScopeOne },
  { label: 'Subtree', value: ScopeSub },
];

type SearchMode = 'quick' | 'advanced';
type QuickMatchType = 'contains' | 'startsWith' | 'exact';

const QUICK_SEARCH_ATTRS = [
  { value: 'cn', label: 'Name (cn)' },
  { value: 'sAMAccountName', label: 'Login (sAMAccountName)' },
  { value: 'displayName', label: 'Display Name' },
  { value: 'mail', label: 'E-Mail' },
  { value: 'uid', label: 'UID' },
  { value: 'userPrincipalName', label: 'UPN' },
  { value: 'sn', label: 'Surname (sn)' },
  { value: 'givenName', label: 'First Name' },
  { value: 'description', label: 'Description' },
  { value: 'telephoneNumber', label: 'Phone' },
];

const QUICK_OBJECT_TYPES = [
  { value: '', label: 'All types' },
  { value: '(objectClass=person)', label: 'Users' },
  { value: '(objectClass=group)', label: 'Groups' },
  { value: '(objectClass=organizationalUnit)', label: 'OUs' },
  { value: '(objectClass=computer)', label: 'Computers' },
];

function buildQuickFilter(searchText: string, attribute: string, matchType: QuickMatchType, objectTypeFilter: string): string {
  if (!searchText.trim()) return '(objectClass=*)';

  // Escape LDAP special chars in search text
  const escaped = searchText.replace(/([\\*()\\0])/g, '\\$1');

  let attrFilter: string;
  switch (matchType) {
    case 'contains':
      attrFilter = `(${attribute}=*${escaped}*)`;
      break;
    case 'startsWith':
      attrFilter = `(${attribute}=${escaped}*)`;
      break;
    case 'exact':
      attrFilter = `(${attribute}=${escaped})`;
      break;
  }

  if (objectTypeFilter) {
    return `(&${objectTypeFilter}${attrFilter})`;
  }
  return attrFilter;
}

export function SearchPanel() {
  const { params, loading, error, history, setParams, executeSearch, clearResults, restoreSearch, togglePin, removeHistory, clearHistory, setDisplayColumns } = useSearchStore();
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const connectionStatuses = useConnectionStore((s) => s.connectionStatuses);
  const profiles = useConnectionStore((s) => s.profiles);
  const showBottomTab = useUIStore((s) => s.showBottomTab);
  const bottomPanelVisible = useUIStore((s) => s.bottomPanelVisible);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>('quick');
  const [returnAttrsText, setReturnAttrsText] = useState('');
  const [detectingBaseDN, setDetectingBaseDN] = useState(false);

  // Quick search state
  const [quickSearchText, setQuickSearchText] = useState('');
  const [quickAttr, setQuickAttr] = useState('cn');
  const [quickMatchType, setQuickMatchType] = useState<QuickMatchType>('contains');
  const [quickObjectType, setQuickObjectType] = useState('');
  const quickInputRef = useRef<HTMLInputElement>(null);

  const isConnected = activeProfileId ? connectionStatuses[activeProfileId] === true : false;
  const activeProfile = activeProfileId ? profiles.find(p => p.id === activeProfileId) : null;

  // Sync baseDN from profile when active profile changes
  useEffect(() => {
    if (activeProfile && !params.baseDN) {
      setParams({ baseDN: activeProfile.baseDN || '' });
    }
  }, [activeProfileId]);

  // Auto-detect BaseDN from RootDSE
  async function handleDetectBaseDN() {
    if (!activeProfileId) return;
    setDetectingBaseDN(true);
    try {
      const rootDSE = await wails.GetRootDSE(activeProfileId);
      if (rootDSE) {
        const defaultNC = rootDSE.attributes?.find(
          a => a.name.toLowerCase() === 'defaultnamingcontext'
        );
        const namingContexts = rootDSE.attributes?.find(
          a => a.name.toLowerCase() === 'namingcontexts'
        );
        const baseDN = defaultNC?.values?.[0] || namingContexts?.values?.[0] || '';
        if (baseDN) {
          setParams({ baseDN });
        }
      }
    } catch { /* ignore */ }
    setDetectingBaseDN(false);
  }

  async function handleSearch() {
    if (!activeProfileId || !isConnected) return;
    showBottomTab('search-results');
    await executeSearch(activeProfileId);
  }

  async function handleQuickSearch() {
    if (!activeProfileId || !isConnected) return;
    showBottomTab('search-results');
    const filter = buildQuickFilter(quickSearchText, quickAttr, quickMatchType, quickObjectType);
    await executeSearch(activeProfileId, filter);
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
      {/* Header with mode toggle */}
      <div className="flex items-center justify-between px-4 h-9 shrink-0 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-secondary-foreground">
          Search
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setSearchMode('quick')}
            className={cn(
              'p-1 rounded text-xs flex items-center gap-0.5',
              searchMode === 'quick' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
            )}
            title="Quick Search"
          >
            <Zap size={12} />
          </button>
          <button
            onClick={() => setSearchMode('advanced')}
            className={cn(
              'p-1 rounded text-xs flex items-center gap-0.5',
              searchMode === 'advanced' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
            )}
            title="Advanced (LDAP Filter)"
          >
            <Code size={12} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-3">
        {/* Base DN - shown in both modes */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-muted-foreground">Base DN</label>
            <button
              onClick={handleDetectBaseDN}
              disabled={detectingBaseDN}
              className="flex items-center gap-0.5 text-[10px] text-primary hover:text-primary/80"
              title="Auto-detect Base DN from RootDSE"
            >
              {detectingBaseDN ? <Loader2 size={9} className="animate-spin" /> : <Info size={9} />}
              Detect
            </button>
          </div>
          <input
            type="text"
            value={params.baseDN}
            onChange={(e) => setParams({ baseDN: e.target.value })}
            placeholder={activeProfile?.baseDN || 'dc=example,dc=com'}
            className="input-field"
          />
        </div>

        {searchMode === 'quick' ? (
          /* ========== QUICK SEARCH MODE ========== */
          <>
            {/* Search text */}
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Search</label>
              <div className="flex gap-1">
                <input
                  ref={quickInputRef}
                  type="text"
                  value={quickSearchText}
                  onChange={(e) => setQuickSearchText(e.target.value)}
                  placeholder="Type a name..."
                  className="input-field flex-1"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleQuickSearch();
                    }
                  }}
                />
              </div>
            </div>

            {/* Attribute to search */}
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Search in</label>
              <select
                value={quickAttr}
                onChange={(e) => setQuickAttr(e.target.value)}
                className="input-field"
              >
                {QUICK_SEARCH_ATTRS.map(a => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
            </div>

            {/* Match type */}
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Match</label>
              <div className="flex gap-1">
                {([
                  { value: 'contains', label: 'Contains' },
                  { value: 'startsWith', label: 'Starts with' },
                  { value: 'exact', label: 'Exact' },
                ] as const).map(m => (
                  <button
                    key={m.value}
                    onClick={() => setQuickMatchType(m.value)}
                    className={cn(
                      'flex-1 text-xs py-1 rounded border transition-colors',
                      quickMatchType === m.value
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30'
                    )}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Object type filter */}
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Object type</label>
              <select
                value={quickObjectType}
                onChange={(e) => setQuickObjectType(e.target.value)}
                className="input-field"
              >
                {QUICK_OBJECT_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            {/* Generated filter preview */}
            {quickSearchText && (
              <div className="text-[10px] text-muted-foreground font-mono bg-background/50 rounded px-2 py-1 break-all">
                {buildQuickFilter(quickSearchText, quickAttr, quickMatchType, quickObjectType)}
              </div>
            )}
          </>
        ) : (
          /* ========== ADVANCED MODE ========== */
          <>
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
          </>
        )}

        {/* Return Attributes (advanced only) */}
        {searchMode === 'advanced' && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-muted-foreground">Return Attributes</label>
              <button
                onClick={() => {
                  const attrs = returnAttrsText.split(',').map(a => a.trim()).filter(Boolean);
                  if (attrs.length > 0) {
                    setParams({ attributes: attrs });
                    setDisplayColumns(attrs);
                  }
                }}
                className="text-[10px] text-primary hover:text-primary/80"
                title="Apply and set as display columns"
              >
                Apply as Columns
              </button>
            </div>
            <input
              type="text"
              value={returnAttrsText}
              onChange={(e) => {
                setReturnAttrsText(e.target.value);
                const attrs = e.target.value.split(',').map(a => a.trim()).filter(Boolean);
                setParams({ attributes: attrs });
              }}
              placeholder="Leave empty for all (e.g. cn,mail,description)"
              className="input-field font-mono text-[10px]"
            />
            <div className="text-[10px] text-muted-foreground mt-0.5">Comma-separated. Empty = all attributes.</div>
          </div>
        )}

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
          onClick={searchMode === 'quick' ? handleQuickSearch : handleSearch}
          disabled={loading || (searchMode === 'advanced' && !params.filter.trim()) || (searchMode === 'quick' && !quickSearchText.trim())}
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

        {/* Save Search */}
        <SaveSearchSection />

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

function SaveSearchSection() {
  const { savedSearches, saveSearch, removeSavedSearch, restoreSavedSearch, params } = useSearchStore();
  const [showSaved, setShowSaved] = useState(false);
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [saveName, setSaveName] = useState('');

  function handleSave() {
    if (!saveName.trim()) return;
    saveSearch(saveName.trim());
    setSaveName('');
    setShowSaveInput(false);
  }

  return (
    <div className="border-t border-border pt-3">
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setShowSaved(!showSaved)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <BookmarkPlus size={12} />
          Saved Searches ({savedSearches.length})
          <ChevronDown size={10} className={showSaved ? 'rotate-180' : ''} />
        </button>
        <button
          onClick={() => setShowSaveInput(!showSaveInput)}
          className="flex items-center gap-0.5 text-[10px] text-primary hover:text-primary/80"
          title="Save current search"
        >
          <Save size={10} />
          Save
        </button>
      </div>

      {showSaveInput && (
        <div className="flex gap-1 mb-2">
          <input
            type="text"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            placeholder="Search name..."
            className="input-field text-xs flex-1"
            autoFocus
          />
          <button
            onClick={handleSave}
            disabled={!saveName.trim()}
            className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      )}

      {showSaved && savedSearches.length > 0 && (
        <div className="space-y-1 max-h-[200px] overflow-auto">
          {savedSearches.map((saved) => (
            <div key={saved.id} className="flex items-center gap-1 group">
              <button
                onClick={() => restoreSavedSearch(saved)}
                className="flex-1 text-left text-xs px-2 py-1 rounded hover:bg-accent truncate min-w-0"
                title={`${saved.params.filter}\nColumns: ${saved.displayColumns.join(', ')}`}
              >
                <div className="font-medium truncate text-foreground">{saved.name}</div>
                <div className="text-[10px] text-muted-foreground font-mono truncate">{saved.params.filter}</div>
              </button>
              <button
                onClick={() => removeSavedSearch(saved.id)}
                className="p-0.5 rounded text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 shrink-0"
                title="Remove"
              >
                <Trash2 size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      {showSaved && savedSearches.length === 0 && (
        <div className="text-[10px] text-muted-foreground text-center py-2">
          No saved searches yet. Click "Save" to save the current search.
        </div>
      )}
    </div>
  );
}
