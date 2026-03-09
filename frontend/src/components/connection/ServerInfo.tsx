import { useState, useEffect } from 'react'
import { Server, RefreshCw, Loader2, Copy, Check, Globe, Shield, Database, Settings } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { LDAPEntry, LDAPAttribute } from '../../types/ldap'
import { cn } from '../../lib/utils'
import * as wails from '../../lib/wails'

/** Categorize RootDSE attributes for display */
const ATTR_CATEGORIES: Record<string, { label: string; icon: React.ElementType; attrs: string[] }> = {
  identity: {
    label: 'Server Identity',
    icon: Server,
    attrs: [
      'dnsHostName', 'serverName', 'ldapServiceName',
      'dsServiceName', 'currentTime', 'isGlobalCatalogReady',
      'isSynchronized',
    ],
  },
  naming: {
    label: 'Naming Contexts',
    icon: Globe,
    attrs: [
      'defaultNamingContext', 'rootDomainNamingContext',
      'configurationNamingContext', 'schemaNamingContext',
      'namingContexts',
    ],
  },
  capabilities: {
    label: 'Capabilities & Versions',
    icon: Shield,
    attrs: [
      'supportedLDAPVersion', 'supportedSASLMechanisms',
      'forestFunctionality', 'domainFunctionality',
      'domainControllerFunctionality',
      'highestCommittedUSN',
    ],
  },
  controls: {
    label: 'Supported Controls',
    icon: Settings,
    attrs: [
      'supportedControl',
    ],
  },
  extensions: {
    label: 'Supported Extensions',
    icon: Database,
    attrs: [
      'supportedExtension', 'supportedCapabilities',
    ],
  },
};

/** Map well-known AD OIDs to human-readable names */
const KNOWN_OIDS: Record<string, string> = {
  '1.2.840.113556.1.4.319': 'Paged Results',
  '1.2.840.113556.1.4.801': 'Security Descriptor',
  '1.2.840.113556.1.4.473': 'Server-Side Sort',
  '1.2.840.113556.1.4.474': 'Sort Response',
  '1.2.840.113556.1.4.417': 'Show Deleted Objects',
  '1.2.840.113556.1.4.521': 'Cross-Domain Move',
  '1.2.840.113556.1.4.528': 'Server Notification',
  '1.2.840.113556.1.4.529': 'Extended DN',
  '1.2.840.113556.1.4.619': 'Lazy Commit',
  '1.2.840.113556.1.4.800': 'Active Directory',
  '1.2.840.113556.1.4.1670': 'Active Directory V51 (2003)',
  '1.2.840.113556.1.4.1791': 'NTLM Authentication',
  '1.2.840.113556.1.4.1935': 'Active Directory V60 (2008)',
  '1.2.840.113556.1.4.2080': 'Active Directory V61R2 (2008 R2)',
  '1.2.840.113556.1.4.2237': 'Active Directory W8 (2012)',
  '1.2.840.113556.1.4.1340': 'Range Retrieval',
  '1.2.840.113556.1.4.1413': 'Permissive Modify',
  '1.2.840.113556.1.4.805': 'Tree Delete',
  '1.2.840.113556.1.4.1338': 'Verify Name',
  '1.2.840.113556.1.4.1339': 'Domain Scope',
  '1.2.840.113556.1.4.1504': 'Attribute Scoped Query',
  '1.2.840.113556.1.4.1852': 'FAST Concurrent Bind',
  '1.2.840.113556.1.4.841': 'DirSync',
  '1.3.6.1.4.1.4203.1.5.3': 'LDAPv3 Return All Operational Attributes',
  '2.16.840.1.113730.3.4.9': 'VLV Request',
  '2.16.840.1.113730.3.4.10': 'VLV Response',
  '1.3.6.1.4.1.4203.1.11.1': 'Password Modify (RFC 3062)',
  '1.3.6.1.4.1.4203.1.11.3': 'Who Am I? (RFC 4532)',
  '1.3.6.1.1.8': 'Cancel (RFC 3909)',
};

const FUNC_LEVELS: Record<string, string> = {
  '0': 'Windows 2000',
  '1': 'Windows 2003 interim',
  '2': 'Windows 2003',
  '3': 'Windows 2008',
  '4': 'Windows 2008 R2',
  '5': 'Windows 2012',
  '6': 'Windows 2012 R2',
  '7': 'Windows 2016',
};

export function ServerInfo() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const connectionStatuses = useConnectionStore((s) => s.connectionStatuses);
  const profiles = useConnectionStore((s) => s.profiles);
  const isConnected = activeProfileId ? connectionStatuses[activeProfileId] === true : false;
  const activeProfile = activeProfileId ? profiles.find(p => p.id === activeProfileId) : null;

  const [rootDSE, setRootDSE] = useState<LDAPEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set(['identity', 'naming', 'capabilities']));

  useEffect(() => {
    if (!activeProfileId || !isConnected) {
      setRootDSE(null);
      return;
    }
    loadRootDSE();
  }, [activeProfileId, isConnected]);

  async function loadRootDSE() {
    if (!activeProfileId) return;
    setLoading(true);
    try {
      const entry = await wails.GetRootDSE(activeProfileId);
      setRootDSE(entry);
    } catch {
      setRootDSE(null);
    }
    setLoading(false);
  }

  function toggleCategory(cat: string) {
    setExpandedCats(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  function getAttrValues(name: string): string[] {
    if (!rootDSE) return [];
    const attr = rootDSE.attributes?.find(a => a.name.toLowerCase() === name.toLowerCase());
    return attr?.values || [];
  }

  function formatValue(attrName: string, value: string): string {
    const lower = attrName.toLowerCase();
    // Functional levels
    if (lower.includes('functionality')) {
      return `${value} (${FUNC_LEVELS[value] || 'Unknown'})`;
    }
    // OIDs
    if (lower.includes('control') || lower.includes('extension') || lower.includes('capabilities')) {
      const label = KNOWN_OIDS[value];
      return label ? `${value} (${label})` : value;
    }
    return value;
  }

  if (!isConnected) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-4">
        <Server size={48} strokeWidth={1} className="mb-4 opacity-40" />
        <p className="text-sm text-center">Connect to a server to view server info</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <Loader2 size={16} className="animate-spin mr-2" />
        <span className="text-xs">Loading server info...</span>
      </div>
    );
  }

  // Collect uncategorized attributes
  const categorizedAttrs = new Set<string>();
  Object.values(ATTR_CATEGORIES).forEach(cat => cat.attrs.forEach(a => categorizedAttrs.add(a.toLowerCase())));
  const uncategorized = rootDSE?.attributes?.filter(a => !categorizedAttrs.has(a.name.toLowerCase())) || [];

  return (
    <div className="h-full overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <Server size={16} className="text-primary" />
          <div>
            <h2 className="text-sm font-semibold">{activeProfile?.name || 'Server Info'}</h2>
            <p className="text-[10px] text-muted-foreground">{activeProfile?.host}:{activeProfile?.port}</p>
          </div>
        </div>
        <button
          onClick={loadRootDSE}
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
          title="Refresh"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Categories */}
      <div className="p-2 space-y-1">
        {Object.entries(ATTR_CATEGORIES).map(([key, cat]) => {
          const Icon = cat.icon;
          const isExpanded = expandedCats.has(key);
          const attrs = cat.attrs.filter(a => getAttrValues(a).length > 0);
          if (attrs.length === 0) return null;

          return (
            <div key={key} className="border border-border rounded bg-card">
              <button
                onClick={() => toggleCategory(key)}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold hover:bg-accent/50 rounded-t"
              >
                <Icon size={13} className="text-primary shrink-0" />
                <span className="flex-1 text-left">{cat.label}</span>
                <span className="text-[10px] text-muted-foreground">{attrs.length}</span>
              </button>

              {isExpanded && (
                <div className="border-t border-border">
                  {attrs.map(attrName => {
                    const values = getAttrValues(attrName);
                    return (
                      <div key={attrName} className="flex border-b border-border/30 last:border-0">
                        <div className="w-1/3 px-3 py-1 text-[11px] font-mono text-primary/70 truncate shrink-0" title={attrName}>
                          {attrName}
                        </div>
                        <div className="flex-1 px-3 py-1 text-[11px] font-mono break-all">
                          {values.length === 1 ? (
                            <CopyableValue value={formatValue(attrName, values[0])} />
                          ) : (
                            <div className="space-y-0.5">
                              {values.map((v, i) => (
                                <CopyableValue key={i} value={formatValue(attrName, v)} />
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* Uncategorized */}
        {uncategorized.length > 0 && (
          <div className="border border-border rounded bg-card">
            <button
              onClick={() => toggleCategory('other')}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold hover:bg-accent/50 rounded-t"
            >
              <Database size={13} className="text-muted-foreground shrink-0" />
              <span className="flex-1 text-left">Other Attributes</span>
              <span className="text-[10px] text-muted-foreground">{uncategorized.length}</span>
            </button>

            {expandedCats.has('other') && (
              <div className="border-t border-border">
                {uncategorized.map(attr => (
                  <div key={attr.name} className="flex border-b border-border/30 last:border-0">
                    <div className="w-1/3 px-3 py-1 text-[11px] font-mono text-primary/70 truncate shrink-0" title={attr.name}>
                      {attr.name}
                    </div>
                    <div className="flex-1 px-3 py-1 text-[11px] font-mono break-all">
                      {attr.values.map((v, i) => (
                        <div key={i}>{v}</div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CopyableValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-center gap-1 group/copy">
      <span className="break-all">{value}</span>
      <button
        onClick={() => {
          navigator.clipboard.writeText(value.split(' (')[0]); // copy just the OID/value, not the label
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        className="opacity-0 group-hover/copy:opacity-100 p-0.5 text-muted-foreground hover:text-foreground shrink-0"
        title="Copy"
      >
        {copied ? <Check size={9} className="text-green-400" /> : <Copy size={9} />}
      </button>
    </div>
  );
}
