import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Users, UserPlus, X, Loader2, Search, AlertCircle, Trash2 } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { LDAPEntry, ScopeSub } from '../../types/ldap'
import * as wails from '../../lib/wails'
import { toast } from '../ui/Toast'
import { cn } from '../../lib/utils'

interface MembershipPanelProps {
  tabId: string;
}

export function MembershipPanel({ tabId }: MembershipPanelProps) {
  const tab = useEditorStore((s) => s.tabs.find(t => t.id === tabId));
  const entry = useEditorStore((s) => s.entries[tabId]);
  const refreshEntry = useEditorStore((s) => s.refreshEntry);
  const openEntry = useEditorStore((s) => s.openEntry);
  const profiles = useConnectionStore((s) => s.profiles);
  const isReadOnly = tab ? profiles.find(p => p.id === tab.profileId)?.readOnly ?? false : false;

  if (!tab || !entry) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        No entry loaded
      </div>
    );
  }

  const objectClasses = entry.attributes
    ?.find(a => a.name.toLowerCase() === 'objectclass')
    ?.values.map(v => v.toLowerCase()) || [];

  const isGroup = objectClasses.some(oc =>
    ['group', 'groupofnames', 'groupofuniquenames', 'posixgroup'].includes(oc)
  );

  // Get members (for groups)
  const memberAttr = entry.attributes?.find(a =>
    ['member', 'uniquemember'].includes(a.name.toLowerCase())
  );
  const members = memberAttr?.values || [];

  // Get memberOf (for any entry)
  const memberOfAttr = entry.attributes?.find(a => a.name.toLowerCase() === 'memberof');
  const memberOf = memberOfAttr?.values || [];

  return (
    <div className="h-full flex flex-col">
      {isGroup && (
        <MemberList
          title="Members"
          icon={Users}
          items={members}
          attrName={memberAttr?.name || 'member'}
          profileId={tab.profileId}
          dn={tab.dn}
          readOnly={isReadOnly}
          onRefresh={() => refreshEntry(tab.profileId, tab.dn)}
          onNavigate={(dn) => openEntry(tab.profileId, dn)}
        />
      )}

      {memberOf.length > 0 && (
        <MemberList
          title="Member Of"
          icon={Users}
          items={memberOf}
          attrName="memberOf"
          profileId={tab.profileId}
          dn={tab.dn}
          readOnly={true}
          onRefresh={() => refreshEntry(tab.profileId, tab.dn)}
          onNavigate={(dn) => openEntry(tab.profileId, dn)}
        />
      )}

      {!isGroup && memberOf.length === 0 && (
        <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-4">
          <Users size={32} strokeWidth={1} className="mb-2 opacity-40" />
          <p className="text-xs text-center">This entry is not a group and has no group memberships.</p>
        </div>
      )}
    </div>
  );
}

interface MemberListProps {
  title: string;
  icon: React.ElementType;
  items: string[];
  attrName: string;
  profileId: string;
  dn: string;
  readOnly: boolean;
  onRefresh: () => void;
  onNavigate: (dn: string) => void;
}

function MemberList({
  title, icon: Icon, items, attrName, profileId, dn, readOnly, onRefresh, onNavigate,
}: MemberListProps) {
  const [filter, setFilter] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [addDN, setAddDN] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!filter) return items;
    const f = filter.toLowerCase();
    return items.filter(dn => dn.toLowerCase().includes(f));
  }, [items, filter]);

  async function handleAdd() {
    if (!addDN.trim()) return;
    setAdding(true);
    try {
      // Add the new member DN to existing values
      const newValues = [...items, addDN.trim()];
      await wails.ModifyAttribute(profileId, dn, attrName, newValues);
      toast.success('Member added');
      setAddDN('');
      setShowAdd(false);
      onRefresh();
    } catch (err: any) {
      toast.error('Failed to add member', err?.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(memberDN: string) {
    setRemoving(memberDN);
    try {
      const newValues = items.filter(v => v !== memberDN);
      if (newValues.length === 0) {
        // Can't have empty member list for some group types, try anyway
        await wails.ModifyAttribute(profileId, dn, attrName, newValues);
      } else {
        await wails.ModifyAttribute(profileId, dn, attrName, newValues);
      }
      toast.success('Member removed');
      onRefresh();
    } catch (err: any) {
      toast.error('Failed to remove member', err?.message);
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-1.5">
          <Icon size={13} className="text-primary" />
          <span className="text-xs font-semibold">{title}</span>
          <span className="text-[10px] text-muted-foreground">({items.length})</span>
        </div>
        {!readOnly && (
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="flex items-center gap-1 text-xs text-primary hover:text-primary/80"
          >
            <UserPlus size={12} />
            Add
          </button>
        )}
      </div>

      {/* Add member input with autocomplete */}
      {showAdd && (
        <DNAutocomplete
          profileId={profileId}
          value={addDN}
          onChange={setAddDN}
          onSubmit={handleAdd}
          onCancel={() => { setShowAdd(false); setAddDN(''); }}
          loading={adding}
          existingMembers={items}
        />
      )}

      {/* Filter */}
      {items.length > 5 && (
        <div className="flex items-center gap-1 px-3 py-1 border-b border-border">
          <Search size={11} className="text-muted-foreground shrink-0" />
          <input
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter..."
            className="flex-1 text-xs bg-transparent border-none outline-none placeholder:text-muted-foreground/50"
          />
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-4">
            {filter ? 'No matching members' : 'No members'}
          </div>
        ) : (
          filtered.map(memberDN => {
            const rdn = memberDN.split(',')[0] || memberDN;
            const isRemoving = removing === memberDN;
            return (
              <div
                key={memberDN}
                className="flex items-center gap-1.5 px-3 py-1 hover:bg-accent/30 group cursor-pointer border-b border-border/30"
                onClick={() => onNavigate(memberDN)}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs truncate">{rdn}</div>
                  <div className="text-[10px] text-muted-foreground truncate font-mono">{memberDN}</div>
                </div>
                {!readOnly && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRemove(memberDN); }}
                    disabled={isRemoving}
                    className="p-0.5 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 shrink-0 disabled:opacity-50"
                    title="Remove member"
                  >
                    {isRemoving ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** DN input with live LDAP search autocomplete */
function DNAutocomplete({ profileId, value, onChange, onSubmit, onCancel, loading, existingMembers }: {
  profileId: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  loading: boolean;
  existingMembers: string[];
}) {
  const [suggestions, setSuggestions] = useState<{ dn: string; rdn: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const inputRef = useRef<HTMLInputElement>(null);
  const profile = useConnectionStore((s) => s.profiles.find(p => p.id === profileId));

  // Debounced search
  useEffect(() => {
    if (!value || value.length < 2) {
      setSuggestions([]);
      return;
    }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const filter = `(|(cn=*${escapeLDAPFilter(value)}*)(sAMAccountName=*${escapeLDAPFilter(value)}*)(uid=*${escapeLDAPFilter(value)}*))`;
        const result = await wails.SearchLDAP(profileId, {
          baseDN: profile?.baseDN || '',
          scope: ScopeSub,
          filter,
          attributes: ['dn', 'cn'],
          sizeLimit: 15,
          timeLimit: 5,
        });
        const hits = (result?.entries || [])
          .filter(e => !existingMembers.includes(e.dn))
          .map(e => ({
            dn: e.dn,
            rdn: e.dn.split(',')[0] || e.dn,
          }));
        setSuggestions(hits);
        setSelectedIdx(-1);
        setShowSuggestions(true);
      } catch {
        setSuggestions([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timerRef.current);
  }, [value, profileId, profile?.baseDN, existingMembers]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(i => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(i => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIdx >= 0 && selectedIdx < suggestions.length) {
        onChange(suggestions[selectedIdx].dn);
        setShowSuggestions(false);
        // Auto-submit after selecting
        setTimeout(() => onSubmit(), 50);
      } else {
        onSubmit();
      }
    } else if (e.key === 'Escape') {
      if (showSuggestions) {
        setShowSuggestions(false);
      } else {
        onCancel();
      }
    }
  }

  return (
    <div className="relative border-b border-border bg-accent/30">
      <div className="flex items-center gap-1 px-3 py-1.5">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={e => { onChange(e.target.value); setShowSuggestions(true); }}
          onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          placeholder="Search by name or enter DN..."
          className="flex-1 px-2 py-1 text-xs bg-input border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring font-mono"
          autoFocus
          onKeyDown={handleKeyDown}
        />
        {searching && <Loader2 size={12} className="animate-spin text-muted-foreground shrink-0" />}
        <button
          onClick={onSubmit}
          disabled={loading || !value.trim()}
          className="p-1 text-green-400 hover:text-green-300 disabled:opacity-50"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <UserPlus size={12} />}
        </button>
        <button
          onClick={onCancel}
          className="p-1 text-muted-foreground hover:text-foreground"
        >
          <X size={12} />
        </button>
      </div>

      {/* Suggestions dropdown */}
      {showSuggestions && suggestions.length > 0 && (
        <div className="absolute left-2 right-2 top-full z-20 bg-popover border border-border rounded shadow-xl max-h-[200px] overflow-auto">
          {suggestions.map((s, i) => (
            <button
              key={s.dn}
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                onChange(s.dn);
                setShowSuggestions(false);
                setTimeout(() => onSubmit(), 50);
              }}
              className={cn(
                'w-full text-left px-2 py-1.5 text-xs border-b border-border/30 last:border-0',
                i === selectedIdx ? 'bg-accent' : 'hover:bg-accent/50'
              )}
            >
              <div className="font-medium truncate">{s.rdn}</div>
              <div className="text-[10px] text-muted-foreground font-mono truncate">{s.dn}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function escapeLDAPFilter(s: string): string {
  return s.replace(/([\\*()\\0])/g, '\\$1');
}
