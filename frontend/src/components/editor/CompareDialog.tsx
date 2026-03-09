import { useState, useEffect, useMemo } from 'react'
import { X, Loader2, ArrowLeftRight, Search, Copy, Check } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { LDAPEntry, LDAPAttribute, ScopeSub } from '../../types/ldap'
import { cn } from '../../lib/utils'
import * as wails from '../../lib/wails'

interface CompareDialogProps {
  dn: string; // the base entry to compare
  onClose: () => void;
}

export function CompareDialog({ dn, onClose }: CompareDialogProps) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const profiles = useConnectionStore((s) => s.profiles);
  const activeProfile = activeProfileId ? profiles.find(p => p.id === activeProfileId) : null;

  const [entryA, setEntryA] = useState<LDAPEntry | null>(null);
  const [entryB, setEntryB] = useState<LDAPEntry | null>(null);
  const [loadingA, setLoadingA] = useState(true);
  const [loadingB, setLoadingB] = useState(false);
  const [dnB, setDnB] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ dn: string; rdn: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [showDiffs, setShowDiffs] = useState(false);
  const [copied, setCopied] = useState(false);

  // Load entry A
  useEffect(() => {
    if (!activeProfileId) return;
    setLoadingA(true);
    wails.GetEntry(activeProfileId, dn).then(e => {
      setEntryA(e);
      setLoadingA(false);
    }).catch(() => setLoadingA(false));
  }, [activeProfileId, dn]);

  // Search for entry B
  useEffect(() => {
    if (!searchQuery || searchQuery.length < 2 || !activeProfileId) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const escaped = searchQuery.replace(/([\\*()\0])/g, '\\$1');
        const result = await wails.SearchLDAP(activeProfileId, {
          baseDN: activeProfile?.baseDN || '',
          filter: `(|(cn=*${escaped}*)(sAMAccountName=*${escaped}*)(uid=*${escaped}*))`,
          scope: ScopeSub,
          attributes: ['dn', 'cn'],
          sizeLimit: 10,
          timeLimit: 5,
        });
        setSearchResults((result?.entries || [])
          .filter(e => e.dn !== dn)
          .map(e => ({ dn: e.dn, rdn: e.dn.split(',')[0] }))
        );
      } catch {
        setSearchResults([]);
      }
      setSearching(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, activeProfileId, activeProfile?.baseDN, dn]);

  // Load entry B when DN is set
  useEffect(() => {
    if (!dnB || !activeProfileId) {
      setEntryB(null);
      return;
    }
    setLoadingB(true);
    wails.GetEntry(activeProfileId, dnB).then(e => {
      setEntryB(e);
      setLoadingB(false);
    }).catch(() => setLoadingB(false));
  }, [dnB, activeProfileId]);

  // Compare attributes
  const comparison = useMemo(() => {
    if (!entryA || !entryB) return [];

    const mapA = new Map<string, LDAPAttribute>();
    const mapB = new Map<string, LDAPAttribute>();
    for (const a of entryA.attributes || []) mapA.set(a.name.toLowerCase(), a);
    for (const a of entryB.attributes || []) mapB.set(a.name.toLowerCase(), a);

    const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);
    const rows: {
      name: string;
      valuesA: string[];
      valuesB: string[];
      status: 'same' | 'different' | 'only-a' | 'only-b';
    }[] = [];

    for (const key of [...allKeys].sort()) {
      const a = mapA.get(key);
      const b = mapB.get(key);
      const valuesA = a?.values || [];
      const valuesB = b?.values || [];
      const name = a?.name || b?.name || key;

      if (!a) {
        rows.push({ name, valuesA: [], valuesB: valuesB, status: 'only-b' });
      } else if (!b) {
        rows.push({ name, valuesA: valuesA, valuesB: [], status: 'only-a' });
      } else {
        const same = valuesA.length === valuesB.length &&
          valuesA.every((v, i) => v === valuesB[i]);
        rows.push({ name, valuesA, valuesB, status: same ? 'same' : 'different' });
      }
    }

    return rows;
  }, [entryA, entryB]);

  const diffCount = comparison.filter(r => r.status !== 'same').length;
  const filtered = showDiffs ? comparison.filter(r => r.status !== 'same') : comparison;

  function copyDiffReport() {
    const lines = [`Compare: ${dn}\n     vs: ${dnB}\n`];
    for (const row of comparison.filter(r => r.status !== 'same')) {
      lines.push(`[${row.status}] ${row.name}`);
      if (row.valuesA.length) lines.push(`  A: ${row.valuesA.join(', ')}`);
      if (row.valuesB.length) lines.push(`  B: ${row.valuesB.join(', ')}`);
    }
    navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-card border border-border rounded-md shadow-2xl w-[950px] max-w-[95%] h-[700px] max-h-[90%] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <ArrowLeftRight size={16} className="text-primary" />
            <h2 className="text-sm font-semibold">Compare Entries</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>

        {/* Entry selectors */}
        <div className="flex items-stretch border-b border-border shrink-0">
          {/* Entry A */}
          <div className="flex-1 px-3 py-2 border-r border-border">
            <div className="text-[10px] text-muted-foreground mb-0.5">Entry A</div>
            <div className="text-xs font-mono truncate text-foreground" title={dn}>
              {dn.split(',')[0]}
            </div>
          </div>

          {/* Entry B */}
          <div className="flex-1 px-3 py-2">
            <div className="text-[10px] text-muted-foreground mb-0.5">Entry B</div>
            {dnB ? (
              <div className="flex items-center gap-1">
                <span className="text-xs font-mono truncate text-foreground flex-1" title={dnB}>
                  {dnB.split(',')[0]}
                </span>
                <button onClick={() => { setDnB(''); setSearchQuery(''); }} className="text-muted-foreground hover:text-foreground p-0.5">
                  <X size={10} />
                </button>
              </div>
            ) : (
              <div className="relative">
                <div className="flex items-center gap-1">
                  <Search size={10} className="text-muted-foreground shrink-0" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Search for entry to compare..."
                    className="flex-1 text-xs bg-transparent border-none outline-none placeholder:text-muted-foreground/50"
                    autoFocus
                  />
                  {searching && <Loader2 size={10} className="animate-spin text-muted-foreground" />}
                </div>
                {searchResults.length > 0 && (
                  <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-popover border border-border rounded shadow-xl max-h-[200px] overflow-auto">
                    {searchResults.map(r => (
                      <button
                        key={r.dn}
                        onClick={() => { setDnB(r.dn); setSearchQuery(''); setSearchResults([]); }}
                        className="w-full text-left px-2 py-1.5 text-xs hover:bg-accent border-b border-border/30 last:border-0"
                      >
                        <div className="font-medium truncate">{r.rdn}</div>
                        <div className="text-[10px] text-muted-foreground font-mono truncate">{r.dn}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Toolbar */}
        {entryB && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0">
            <button
              onClick={() => setShowDiffs(!showDiffs)}
              className={cn(
                'text-xs px-2 py-0.5 rounded border',
                showDiffs ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
              )}
            >
              {showDiffs ? 'Show all' : `Show differences (${diffCount})`}
            </button>
            <span className="text-[10px] text-muted-foreground flex-1">
              {comparison.length} attributes, {diffCount} difference{diffCount !== 1 ? 's' : ''}
            </span>
            <button
              onClick={copyDiffReport}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {copied ? <Check size={10} className="text-green-400" /> : <Copy size={10} />}
              Copy report
            </button>
          </div>
        )}

        {/* Comparison table */}
        <div className="flex-1 overflow-auto">
          {loadingA || loadingB ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <Loader2 size={16} className="animate-spin mr-2" />
              Loading entries...
            </div>
          ) : !entryB ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
              <ArrowLeftRight size={32} strokeWidth={1} className="mr-3 opacity-30" />
              Select a second entry to compare
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card z-10">
                <tr className="border-b border-border">
                  <th className="px-2 py-1 text-left font-medium text-muted-foreground w-[20%]">Attribute</th>
                  <th className="px-2 py-1 text-left font-medium text-muted-foreground w-[40%]">
                    {dn.split(',')[0]}
                  </th>
                  <th className="px-2 py-1 text-left font-medium text-muted-foreground w-[40%]">
                    {dnB.split(',')[0]}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(row => (
                  <tr
                    key={row.name}
                    className={cn(
                      'border-b border-border/30',
                      row.status === 'same' && 'opacity-60',
                      row.status === 'different' && 'bg-yellow-500/5',
                      row.status === 'only-a' && 'bg-red-500/5',
                      row.status === 'only-b' && 'bg-green-500/5',
                    )}
                  >
                    <td className="px-2 py-1 font-mono text-primary/70 align-top">
                      <div className="flex items-center gap-1">
                        <StatusDot status={row.status} />
                        {row.name}
                      </div>
                    </td>
                    <td className="px-2 py-1 font-mono align-top break-all">
                      {row.valuesA.map((v, i) => <div key={i}>{v}</div>)}
                      {row.status === 'only-b' && <span className="text-muted-foreground italic">--</span>}
                    </td>
                    <td className="px-2 py-1 font-mono align-top break-all">
                      {row.valuesB.map((v, i) => <div key={i}>{v}</div>)}
                      {row.status === 'only-a' && <span className="text-muted-foreground italic">--</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: 'same' | 'different' | 'only-a' | 'only-b' }) {
  const colors = {
    same: 'bg-muted-foreground/30',
    different: 'bg-yellow-400',
    'only-a': 'bg-red-400',
    'only-b': 'bg-green-400',
  };
  const titles = {
    same: 'Same value',
    different: 'Different values',
    'only-a': 'Only in Entry A',
    'only-b': 'Only in Entry B',
  };
  return <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', colors[status])} title={titles[status]} />;
}
