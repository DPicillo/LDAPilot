import { useState, useEffect, useMemo } from 'react'
import { RefreshCw, Loader2, ChevronRight, ChevronDown, Box, Type, Search } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useConnectionStore } from '../../stores/connectionStore'
import { SchemaInfo, SchemaObjectClass, SchemaAttribute } from '../../types/ldap'
import * as wails from '../../lib/wails'
import { toast } from '../ui/Toast'

type SchemaTab = 'objectClasses' | 'attributes';

export function SchemaBrowser() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const connectionStatuses = useConnectionStore((s) => s.connectionStatuses);
  const isConnected = activeProfileId ? connectionStatuses[activeProfileId] : false;

  const [schema, setSchema] = useState<SchemaInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<SchemaTab>('objectClasses');
  const [filter, setFilter] = useState('');
  const [selectedOC, setSelectedOC] = useState<SchemaObjectClass | null>(null);
  const [selectedAttr, setSelectedAttr] = useState<SchemaAttribute | null>(null);

  useEffect(() => {
    if (activeProfileId && isConnected) {
      loadSchema();
    } else {
      setSchema(null);
    }
  }, [activeProfileId, isConnected]);

  async function loadSchema() {
    if (!activeProfileId) return;
    setLoading(true);
    try {
      const s = await wails.GetSchema(activeProfileId);
      setSchema(s);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to load schema');
    } finally {
      setLoading(false);
    }
  }

  async function handleRefresh() {
    if (!activeProfileId) return;
    setLoading(true);
    try {
      const s = await wails.RefreshSchema(activeProfileId);
      setSchema(s);
      toast.success('Schema refreshed');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to refresh schema');
    } finally {
      setLoading(false);
    }
  }

  const filteredOCs = useMemo(() => {
    if (!schema) return [];
    const list = [...schema.objectClasses].sort((a, b) => a.name.localeCompare(b.name));
    if (!filter) return list;
    const lf = filter.toLowerCase();
    return list.filter(oc => oc.name.toLowerCase().includes(lf) || oc.description.toLowerCase().includes(lf));
  }, [schema, filter]);

  const filteredAttrs = useMemo(() => {
    if (!schema) return [];
    const list = [...schema.attributes].sort((a, b) => a.name.localeCompare(b.name));
    if (!filter) return list;
    const lf = filter.toLowerCase();
    return list.filter(at => at.name.toLowerCase().includes(lf) || at.description.toLowerCase().includes(lf));
  }, [schema, filter]);

  if (!isConnected) {
    return (
      <div className="h-full flex flex-col bg-sidebar">
        <div className="flex items-center px-4 h-9 shrink-0 border-b border-border">
          <span className="text-xs font-semibold uppercase tracking-wider text-secondary-foreground">Schema</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4 text-center">
          Connect to a server to browse its schema
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-sidebar">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-9 shrink-0 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-secondary-foreground">Schema</span>
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-50"
          title="Refresh Schema"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border shrink-0">
        <button
          onClick={() => { setActiveTab('objectClasses'); setSelectedOC(null); setSelectedAttr(null); }}
          className={cn(
            'flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs',
            activeTab === 'objectClasses' ? 'text-foreground border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Box size={12} />
          Classes ({schema?.objectClasses?.length || 0})
        </button>
        <button
          onClick={() => { setActiveTab('attributes'); setSelectedOC(null); setSelectedAttr(null); }}
          className={cn(
            'flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs',
            activeTab === 'attributes' ? 'text-foreground border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Type size={12} />
          Attributes ({schema?.attributes?.length || 0})
        </button>
      </div>

      {/* Filter */}
      <div className="px-3 py-2 border-b border-border shrink-0">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter..."
            className="input-field pl-7 text-xs"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={20} className="animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          {activeTab === 'objectClasses' && !selectedOC && (
            <ObjectClassList items={filteredOCs} onSelect={setSelectedOC} />
          )}
          {activeTab === 'objectClasses' && selectedOC && (
            <ObjectClassDetail oc={selectedOC} onBack={() => setSelectedOC(null)} />
          )}
          {activeTab === 'attributes' && !selectedAttr && (
            <AttributeList items={filteredAttrs} onSelect={setSelectedAttr} />
          )}
          {activeTab === 'attributes' && selectedAttr && (
            <AttributeDetail attr={selectedAttr} onBack={() => setSelectedAttr(null)} />
          )}
        </div>
      )}
    </div>
  );
}

function ObjectClassList({ items, onSelect }: { items: SchemaObjectClass[]; onSelect: (oc: SchemaObjectClass) => void }) {
  return (
    <div className="divide-y divide-border">
      {items.map((oc) => (
        <button
          key={oc.oid + oc.name}
          onClick={() => onSelect(oc)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/50 group"
        >
          <Box size={12} className="text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium truncate">{oc.name}</div>
            {oc.description && (
              <div className="text-[10px] text-muted-foreground truncate">{oc.description}</div>
            )}
          </div>
          <span className={cn(
            'text-[10px] px-1 rounded',
            oc.kind === 'structural' ? 'bg-blue-500/20 text-blue-400' :
            oc.kind === 'auxiliary' ? 'bg-green-500/20 text-green-400' :
            'bg-yellow-500/20 text-yellow-400'
          )}>
            {oc.kind}
          </span>
          <ChevronRight size={12} className="text-muted-foreground opacity-0 group-hover:opacity-100" />
        </button>
      ))}
    </div>
  );
}

function ObjectClassDetail({ oc, onBack }: { oc: SchemaObjectClass; onBack: () => void }) {
  return (
    <div className="p-3 space-y-3">
      <button onClick={onBack} className="flex items-center gap-1 text-xs text-primary hover:underline">
        <ChevronDown size={12} className="rotate-90" /> Back
      </button>

      <div>
        <h3 className="text-sm font-semibold">{oc.name}</h3>
        {oc.description && <p className="text-xs text-muted-foreground mt-0.5">{oc.description}</p>}
      </div>

      <div className="space-y-2 text-xs">
        <DetailRow label="OID" value={oc.oid} />
        <DetailRow label="Kind" value={oc.kind} />
        {oc.superClass?.length > 0 && <DetailRow label="Inherits from" value={oc.superClass.join(', ')} />}

        {oc.must?.length > 0 && (
          <div>
            <span className="text-muted-foreground">Required attributes:</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {oc.must.map((a) => (
                <span key={a} className="px-1.5 py-0.5 bg-red-500/15 text-red-400 rounded text-[10px] font-mono">{a}</span>
              ))}
            </div>
          </div>
        )}

        {oc.may?.length > 0 && (
          <div>
            <span className="text-muted-foreground">Optional attributes:</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {oc.may.map((a) => (
                <span key={a} className="px-1.5 py-0.5 bg-blue-500/15 text-blue-400 rounded text-[10px] font-mono">{a}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AttributeList({ items, onSelect }: { items: SchemaAttribute[]; onSelect: (at: SchemaAttribute) => void }) {
  return (
    <div className="divide-y divide-border">
      {items.map((at) => (
        <button
          key={at.oid + at.name}
          onClick={() => onSelect(at)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/50 group"
        >
          <Type size={12} className="text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium truncate">{at.name}</div>
            {at.syntaxName && (
              <div className="text-[10px] text-muted-foreground truncate">{at.syntaxName}</div>
            )}
          </div>
          {at.singleValue && (
            <span className="text-[10px] px-1 rounded bg-yellow-500/20 text-yellow-400">single</span>
          )}
          <ChevronRight size={12} className="text-muted-foreground opacity-0 group-hover:opacity-100" />
        </button>
      ))}
    </div>
  );
}

function AttributeDetail({ attr, onBack }: { attr: SchemaAttribute; onBack: () => void }) {
  return (
    <div className="p-3 space-y-3">
      <button onClick={onBack} className="flex items-center gap-1 text-xs text-primary hover:underline">
        <ChevronDown size={12} className="rotate-90" /> Back
      </button>

      <div>
        <h3 className="text-sm font-semibold">{attr.name}</h3>
        {attr.description && <p className="text-xs text-muted-foreground mt-0.5">{attr.description}</p>}
      </div>

      <div className="space-y-2 text-xs">
        <DetailRow label="OID" value={attr.oid} />
        <DetailRow label="Syntax" value={attr.syntaxName || attr.syntax} />
        {attr.superType && <DetailRow label="Inherits from" value={attr.superType} />}
        <DetailRow label="Single-valued" value={attr.singleValue ? 'Yes' : 'No'} />
        <DetailRow label="Read-only" value={attr.noUserMod ? 'Yes' : 'No'} />
        <DetailRow label="Usage" value={attr.usage} />
        {attr.equality && <DetailRow label="Equality rule" value={attr.equality} />}
        {attr.ordering && <DetailRow label="Ordering rule" value={attr.ordering} />}
        {attr.substring && <DetailRow label="Substring rule" value={attr.substring} />}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground shrink-0">{label}:</span>
      <span className="font-mono break-all">{value}</span>
    </div>
  );
}
