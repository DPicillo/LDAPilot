/**
 * Compare Entries: attribute-by-attribute diff of entry A and entry B.
 * ED-20: "Ignore system attributes" (default on: GUID, SID, USNs, timestamps,
 * DN, name … always differ and say nothing), swap A/B, and the entry B picker
 * lives inside the dialog body: results ranked same kind as A first, then
 * names starting with the query, then alphabetically.
 */
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { X, ArrowLeftRight, Copy, Check } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { LDAPEntry, LDAPAttribute, SchemaAttribute, ScopeSub } from '../../types/ldap'
import { cn } from '../../lib/utils'
import * as wails from '../../lib/wails'
import { buildAnyAttributeFilter } from '../../lib/searchFilter'
import { GetTreeSearchBases } from '../../lib/wails-treesearch'
import { dedupeByDN, normalizeDN, perBaseSizeLimit, resolveTreeSearchBases, splitDN } from '../../lib/treesearch'
import { isCompareNoise } from '../../lib/attributeGroups'
import { binaryValueSummary } from '../../lib/binary'
import { Dialog } from '../ui/Dialog'
import { Button, IconButton } from '../ui/Button'
import { SearchInput } from '../ui/Input'
import { Checkbox } from '../ui/Checkbox'
import { SegmentedControl } from '../ui/SegmentedControl'
import { EmptyState } from '../ui/EmptyState'
import { Spinner } from '../ui/Spinner'
import { Dn } from '../ui/Dn'
import { ObjectIcon } from '../ui/ObjectIcon'
import { resolveObjectKind, type ObjectKind } from '../ui/objectKind'
import { rdnValue } from '../ui/dn'
import { toast } from '../ui/Toast'
import { fileTimeToDate, formatDateTime, generalizedTimeToDate, timesNeedSeconds } from '../ui/accountStatus';

/** Most entries offered as compare target B. */
const MAX_TARGET_RESULTS = 30;

interface CompareDialogProps {
  dn: string; // the base entry to compare
  /** Entry B, preselected (Compare of a two-entry selection). */
  otherDN?: string;
  /** The entries' connection (default: the active one). */
  profileId?: string;
  onClose: () => void;
}

interface Target {
  dn: string;
  name: string;
  kind: ObjectKind;
}

/** Same kind as A first, then names starting with the query, then the rest; alphabetical within. */
function rankTargets(list: Target[], query: string, kindA: ObjectKind | undefined): Target[] {
  const q = query.trim().toLowerCase();
  const score = (t: Target) => (kindA && t.kind === kindA ? 0 : 2) + (t.name.toLowerCase().startsWith(q) ? 0 : 1);
  return [...list].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

export function CompareDialog({ dn, otherDN, profileId: profileProp, onClose }: CompareDialogProps) {
  const storeProfileId = useConnectionStore((s) => s.activeProfileId);
  const activeProfileId = profileProp ?? storeProfileId;
  const profiles = useConnectionStore((s) => s.profiles);
  const activeProfile = activeProfileId ? profiles.find(p => p.id === activeProfileId) : null;

  const [dnA, setDnA] = useState(dn);
  const [dnB, setDnB] = useState(otherDN ?? '');
  const [entryA, setEntryA] = useState<LDAPEntry | null>(null);
  const [entryB, setEntryB] = useState<LDAPEntry | null>(null);
  const [loadingA, setLoadingA] = useState(true);
  const [loadingB, setLoadingB] = useState(false);
  // Differences only by default (UX-20); the same rows are greyed when all are shown.
  const [showDiffs, setShowDiffs] = useState(true);
  const [ignoreSystem, setIgnoreSystem] = useState(true);
  const [copied, setCopied] = useState(false);
  const [schema, setSchema] = useState<Map<string, SchemaAttribute> | null>(null);
  // Bases of the target search, resolved once per dialog/profile like the tree search's
  const [searchBases, setSearchBases] = useState<{ profileId: string; bases: string[] } | null>(null);

  // Entry B picker (inside the dialog body)
  const [query, setQuery] = useState('');
  const [targets, setTargets] = useState<Target[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const searchSeq = useRef(0);
  const listId = 'compare-b-results';

  // Entries A and B (they swap)
  useEffect(() => {
    if (!activeProfileId) return;
    setLoadingA(true);
    wails.GetEntry(activeProfileId, dnA).then(e => setEntryA(e), () => setEntryA(null)).finally(() => setLoadingA(false));
  }, [activeProfileId, dnA]);
  useEffect(() => {
    if (!dnB || !activeProfileId) {
      setEntryB(null);
      return;
    }
    setLoadingB(true);
    wails.GetEntry(activeProfileId, dnB).then(e => setEntryB(e), () => setEntryB(null)).finally(() => setLoadingB(false));
  }, [dnB, activeProfileId]);

  // Schema: system / operational attributes for the "Ignore system attributes" toggle.
  useEffect(() => {
    if (!activeProfileId) return;
    let cancelled = false;
    wails.GetSchema(activeProfileId).then((s) => {
      if (cancelled || !s?.attributes) return;
      setSchema(new Map(s.attributes.map((a) => [a.name.toLowerCase(), a])));
    }).catch(() => { /* names only */ });
    return () => { cancelled = true; };
  }, [activeProfileId]);

  // Resolve the search bases once (AD: base DN root + every domain shown in
  // the tree, since a subtree search does not cross naming contexts).
  const profileBaseDN = activeProfile?.baseDN || '';
  useEffect(() => {
    if (!activeProfileId) return;
    let cancelled = false;
    GetTreeSearchBases(activeProfileId)
      .catch(() => [] as string[])
      .then(bases => {
        if (!cancelled) setSearchBases({ profileId: activeProfileId, bases: resolveTreeSearchBases(bases, [], profileBaseDN) });
      });
    return () => { cancelled = true; };
  }, [activeProfileId, profileBaseDN]);
  // null while the bases of the active profile are not resolved yet
  const searchBasesKey = searchBases?.profileId === activeProfileId ? searchBases.bases.join('\n') : null;

  const objectClassesA = entryA?.attributes?.find((a) => a.name.toLowerCase() === 'objectclass')?.values;
  const kindA = objectClassesA ? resolveObjectKind(objectClassesA) : undefined;

  // Search for entry B (text matched literally in cn, sAMAccountName, uid) below every base
  const loadTargets = useCallback(async (q: string): Promise<Target[]> => {
    if (!activeProfileId || q.trim().length < 2) return [];
    let bases = searchBasesKey?.split('\n');
    if (!bases) {
      bases = resolveTreeSearchBases(await GetTreeSearchBases(activeProfileId).catch(() => [] as string[]), [], profileBaseDN);
    }
    const sizeLimit = perBaseSizeLimit(bases.length, MAX_TARGET_RESULTS);
    const filter = buildAnyAttributeFilter(['cn', 'sAMAccountName', 'uid'], q);
    const results = await Promise.all(bases.map(baseDN =>
      wails.SearchLDAP(activeProfileId, {
        baseDN,
        filter,
        scope: ScopeSub,
        attributes: ['dn', 'cn', 'objectClass'],
        sizeLimit,
        timeLimit: 5,
      }).then(r => r?.entries || [], () => [])
    ));
    const self = normalizeDN(dnA);
    return dedupeByDN(results.flat())
      .filter(e => normalizeDN(e.dn) !== self)
      .slice(0, MAX_TARGET_RESULTS)
      .map(e => ({
        dn: e.dn,
        name: rdnValue(e.dn),
        kind: resolveObjectKind(e.attributes?.find((a) => a.name.toLowerCase() === 'objectclass')?.values),
      }));
  }, [activeProfileId, searchBasesKey, profileBaseDN, dnA]);

  useEffect(() => {
    if (dnB) return;
    const my = ++searchSeq.current;
    if (query.trim().length < 2) {
      setTargets([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      loadTargets(query)
        .then((list) => {
          if (my !== searchSeq.current) return;
          setTargets(rankTargets(list, query, kindA));
          setActiveIndex(0);
        })
        .finally(() => {
          if (my === searchSeq.current) setSearching(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, dnB, loadTargets, kindA]);

  function pickTarget(t: Target | undefined) {
    if (!t) return;
    setDnB(t.dn);
    setQuery('');
    setTargets([]);
  }

  function swap() {
    if (!dnB) return;
    const a = dnA;
    setDnA(dnB);
    setDnB(a);
    setEntryA(entryB);
    setEntryB(entryA);
  }

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
      system: boolean;
      binary: boolean;
    }[] = [];

    for (const key of [...allKeys].sort()) {
      const a = mapA.get(key);
      const b = mapB.get(key);
      const valuesA = a?.values || [];
      const valuesB = b?.values || [];
      const name = a?.name || b?.name || key;
      const system = isCompareNoise(name, schema?.get(key.split(';')[0]));
      const binary = !!(a?.binary || b?.binary);

      if (!a) {
        rows.push({ name, valuesA: [], valuesB: valuesB, status: 'only-b', system, binary });
      } else if (!b) {
        rows.push({ name, valuesA: valuesA, valuesB: [], status: 'only-a', system, binary });
      } else {
        const same = valuesA.length === valuesB.length &&
          valuesA.every((v, i) => v === valuesB[i]);
        rows.push({ name, valuesA, valuesB, status: same ? 'same' : 'different', system, binary });
      }
    }

    return rows;
  }, [entryA, entryB, schema]);

  const considered = ignoreSystem ? comparison.filter(r => !r.system) : comparison;
  const hiddenSystem = comparison.length - considered.length;
  const diffCount = considered.filter(r => r.status !== 'same').length;
  const filtered = showDiffs ? considered.filter(r => r.status !== 'same') : considered;

  function copyDiffReport() {
    const lines = [`Compare: ${dnA}\n     vs: ${dnB}\n`];
    for (const row of considered.filter(r => r.status !== 'same')) {
      lines.push(`[${row.status}] ${row.name}`);
      const show = (vs: string[]) => (row.binary ? vs.map((v) => binaryValueSummary(row.name, v)) : vs).join(', ');
      if (row.valuesA.length) lines.push(`  A: ${show(row.valuesA)}`);
      if (row.valuesB.length) lines.push(`  B: ${show(row.valuesB)}`);
    }
    navigator.clipboard.writeText(lines.join('\n')).then(
      () => toast.success('Comparison copied'),
      () => toast.error('Could not copy to the clipboard'),
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const nameA = splitDN(dnA)[0];
  const nameB = dnB ? splitDN(dnB)[0] : '';
  const activeTarget = targets[Math.min(activeIndex, targets.length - 1)];

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="xl"
      icon={<ArrowLeftRight size={16} strokeWidth={1.75} aria-hidden className="text-primary" />}
      title="Compare Entries"
      dismissible="always"
      className="h-[700px]"
      bodyClassName="p-0 flex flex-col overflow-hidden border-t border-border"
      footer={
        <>
          {entryB && (
            <Button variant="ghost" leftIcon={copied ? Check : Copy} onClick={copyDiffReport} className="mr-auto">
              {copied ? 'Copied' : 'Copy report'}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </>
      }
    >
      {/* Entry selectors */}
      <div className="grid grid-cols-[1fr_auto_1fr] border-b border-border shrink-0">
        <div className="px-3 py-2 min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">Entry A</div>
          <Dn dn={dnA} className="text-sm" />
        </div>
        <div className="flex items-center border-x border-border px-1">
          <IconButton label="Swap A and B" icon={ArrowLeftRight} disabled={!dnB} onClick={swap} />
        </div>
        <div className="px-3 py-2 min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">Entry B</div>
          {dnB ? (
            <div className="flex items-start gap-1">
              <Dn dn={dnB} className="text-sm flex-1 min-w-0" />
              <IconButton size="sm" label="Choose another entry B" icon={X} onClick={() => setDnB('')} />
            </div>
          ) : (
            <SearchInput
              size="sm"
              value={query}
              onValueChange={setQuery}
              autoFocus
              placeholder="Search for the entry to compare (cn, sAMAccountName, uid)…"
              aria-label="Entry B"
              aria-controls={listId}
              aria-activedescendant={activeTarget ? `${listId}-${targets.indexOf(activeTarget)}` : undefined}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  if (!targets.length) return;
                  setActiveIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + targets.length) % targets.length);
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  pickTarget(activeTarget);
                }
              }}
            />
          )}
        </div>
      </div>

      {/* Toolbar */}
      {entryA && entryB && (
        <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border shrink-0">
          <SegmentedControl
            aria-label="Rows"
            value={showDiffs ? 'diff' : 'all'}
            onValueChange={(v) => setShowDiffs(v === 'diff')}
            options={[
              { value: 'diff', label: 'Differences', count: diffCount },
              { value: 'all', label: 'All attributes', count: considered.length },
            ]}
          />
          <Checkbox
            checked={ignoreSystem}
            onCheckedChange={setIgnoreSystem}
            label={ignoreSystem && hiddenSystem ? `Ignore system attributes (${hiddenSystem})` : 'Ignore system attributes'}
          />
          <span className="text-xs text-muted-foreground flex items-center gap-3 ml-auto">
            <Legend status="different" /> <Legend status="only-a" /> <Legend status="only-b" />
          </span>
        </div>
      )}

      {/* Comparison table / entry B results */}
      <div className="flex-1 overflow-auto min-h-0">
        {loadingA || loadingB ? (
          <div className="flex items-center justify-center gap-2 h-full text-muted-foreground" role="status">
            <Spinner size="md" decorative />
            <span className="text-sm">Loading entries…</span>
          </div>
        ) : !dnB ? (
          query.trim().length < 2 ? (
            <EmptyState icon={ArrowLeftRight} title="Select a second entry to compare" hint="Type at least two characters of its name." />
          ) : searching && !targets.length ? (
            <div className="flex items-center justify-center gap-2 h-full text-muted-foreground" role="status">
              <Spinner size="md" decorative />
              <span className="text-sm">Searching…</span>
            </div>
          ) : !targets.length ? (
            <EmptyState variant="inline" title="No matching entries" hint="Searched cn, sAMAccountName and uid below the tree roots." />
          ) : (
            <ul id={listId} role="listbox" aria-label="Entries to compare with" className="py-1">
              {targets.map((t, i) => (
                <li
                  key={t.dn}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={t === activeTarget}
                  onMouseMove={() => setActiveIndex(i)}
                  onClick={() => pickTarget(t)}
                  className={cn('flex items-center gap-2 px-3 py-1 cursor-pointer min-w-0', t === activeTarget ? 'bg-accent' : 'hover:bg-accent')}
                >
                  <ObjectIcon kind={t.kind} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{t.name}</span>
                    <span className="block truncate text-xs text-muted-foreground font-mono">{t.dn}</span>
                  </span>
                  {kindA && t.kind === kindA && <span className="shrink-0 text-xs text-muted-foreground">same type</span>}
                </li>
              ))}
            </ul>
          )
        ) : !entryB ? (
          <EmptyState icon={ArrowLeftRight} title="Entry B could not be read" hint={dnB} />
        ) : filtered.length === 0 ? (
          <EmptyState variant="inline" title="No differences" hint={ignoreSystem && hiddenSystem ? 'Apart from system attributes, both entries have the same attributes and values.' : 'Both entries have the same attributes and values.'} />
        ) : (
          <table className="w-full table-fixed text-sm border-separate border-spacing-0">
            <thead className="sticky top-0 z-(--z-sticky)">
              <tr>
                <th scope="col" className="h-table-row px-2 text-left text-xs font-semibold text-muted-foreground bg-card border-b border-border w-[20%]">Attribute</th>
                <th scope="col" className="h-table-row px-2 text-left text-xs font-semibold text-muted-foreground bg-card border-b border-border w-[40%] truncate" title={dnA}>A: {nameA}</th>
                <th scope="col" className="h-table-row px-2 text-left text-xs font-semibold text-muted-foreground bg-card border-b border-border w-[40%] truncate" title={dnB}>B: {nameB}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(row => (
                <tr key={row.name} className={cn(row.status === 'same' && 'text-muted-foreground')}>
                  <td className="px-2 py-1 font-mono text-muted-foreground align-top border-b border-border">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <StatusDot status={row.status} />
                      <span className="truncate" title={row.name}>{row.name}</span>
                    </span>
                  </td>
                  <td className={cn('px-2 py-1 font-mono align-top wrap-anywhere border-b border-border', cellTone(row.status, 'a'))}>
                    {row.valuesA.map((v, i) => <CompareValue key={i} name={row.name} value={v} binaryOf={row.binary ? row.name : undefined} seconds={compareSeconds(row)} />)}
                    {row.status === 'only-b' && <span className="text-muted-foreground italic font-sans">not set</span>}
                  </td>
                  <td className={cn('px-2 py-1 font-mono align-top wrap-anywhere border-b border-border', cellTone(row.status, 'b'))}>
                    {row.valuesB.map((v, i) => <CompareValue key={i} name={row.name} value={v} binaryOf={row.binary ? row.name : undefined} seconds={compareSeconds(row)} />)}
                    {row.status === 'only-a' && <span className="text-muted-foreground italic font-sans">not set</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Dialog>
  );
}

type RowStatus = 'same' | 'different' | 'only-a' | 'only-b';

const STATUS_TEXT: Record<RowStatus, string> = {
  same: 'Same value',
  different: 'Different values',
  'only-a': 'Only in entry A',
  'only-b': 'Only in entry B',
};

/** Diff fills: values only in A destructive-subtle, only in B success-subtle, different values warning-subtle. */
function cellTone(status: RowStatus, side: 'a' | 'b'): string | undefined {
  if (status === 'different') return 'bg-warning-subtle text-foreground';
  if (status === 'only-a' && side === 'a') return 'bg-destructive-subtle text-foreground';
  if (status === 'only-b' && side === 'b') return 'bg-success-subtle text-foreground';
  return undefined;
}

function StatusDot({ status }: { status: RowStatus }) {
  const colors: Record<RowStatus, string> = {
    same: 'bg-border-strong',
    different: 'bg-warning',
    'only-a': 'bg-destructive',
    'only-b': 'bg-success',
  };
  return (
    <span className={cn('size-1.5 rounded-full shrink-0', colors[status])} title={STATUS_TEXT[status]}>
      <span className="sr-only">{STATUS_TEXT[status]}</span>
    </span>
  );
}

function Legend({ status }: { status: RowStatus }) {
  return (
    <span className="inline-flex items-center gap-1">
      <StatusDot status={status} />
      <span aria-hidden>{STATUS_TEXT[status]}</span>
    </span>
  );
}

/** A DN-shaped value wraps at its commas (<Dn>); other values keep words whole and break only overlong tokens. */
function looksLikeDn(v: string): boolean {
  const parts = splitDN(v);
  return parts.length > 1 && parts.every((p) => /^\s*[A-Za-z0-9][\w.-]*\s*=/.test(p));
}

/** A value; binary ones as a summary with a fingerprint, never their base64 text (RW1-E-08). */
function CompareValue({ name, value, binaryOf, seconds = false }: { name: string; value: string; binaryOf?: string; seconds?: boolean }) {
  if (binaryOf) return <div className="font-sans text-muted-foreground" title={`${value.length.toLocaleString()} base64 characters`}>{binaryValueSummary(binaryOf, value)}</div>;
  // Times as dates, as in the editor (RW2-E-08); the raw value is the tooltip.
  const when = compareTime(name, value, seconds);
  if (when) return <div className="font-sans tabular-nums" title={value}>{when}</div>;
  return <div>{looksLikeDn(value) ? <Dn dn={value} className="wrap-anywhere" /> : value}</div>;
}

const FILETIME_ATTRS = new Set(['accountexpires', 'lastlogon', 'lastlogontimestamp', 'pwdlastset', 'badpasswordtime', 'lockouttime', 'lastlogoff']);
const GENERALIZED_TIME_ATTRS = new Set(['whencreated', 'whenchanged', 'createtimestamp', 'modifytimestamp', 'pwdchangedtime', 'pwdaccountlockedtime', 'pwdfailuretime', 'passwordexpirationtime', 'accountunlocktime']);

/** The date of a time attribute's value, else null. */
function compareDate(name: string, value: string): Date | null {
  const n = name.toLowerCase().split(';')[0];
  return FILETIME_ATTRS.has(n) ? fileTimeToDate(value) : GENERALIZED_TIME_ATTRS.has(n) ? generalizedTimeToDate(value) : null;
}

/** "2026-10-31 14:22" for the time attributes (with seconds when asked), else null. */
function compareTime(name: string, value: string, seconds = false): string | null {
  const d = compareDate(name, value);
  return d ? formatDateTime(d, { seconds }) : null;
}

/** A "different" time row whose values look equal to the minute shows seconds (RW3-E-04). */
function compareSeconds(row: { name: string; status: string; valuesA: string[]; valuesB: string[] }): boolean {
  if (row.status !== 'different') return false;
  const a = row.valuesA.map((v) => compareDate(row.name, v));
  const b = row.valuesB.map((v) => compareDate(row.name, v));
  return a.every(Boolean) && b.every(Boolean) && timesNeedSeconds(a, b);
}
