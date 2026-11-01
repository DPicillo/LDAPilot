/**
 * Search panel (SPEC 10.2): PanelHeader, Quick / Advanced SegmentedControl
 * (persisted), Field-labelled controls.
 *
 * Base DN: remembered per connection (searchStore.baseDNs; a connection
 * switch restores that connection's base, else its profile base DN, else the
 * server's default naming context); "Use Tree Selection" and "Detect from
 * the RootDSE" next to it.
 *
 * Quick: one text box. "Any name" (default) is ambiguous name resolution
 * `(anr=…)` on Active Directory and an OR over the name attributes elsewhere;
 * "Search in" and the object types depend on the server type (AD users =
 * persons that are user objects; LDAP users = inetOrgPerson / posixAccount /
 * account …, lib/searchFilter.ts). Text is matched literally; input starting
 * with "(" is a raw LDAP filter (validated on the server). Quick searches run
 * on the subtree with all attributes and no controls.
 * Advanced: scope, filter (live validation with positions, Filter Builder
 * with round trip), return attributes, Controls (Show Deleted / Show
 * Recycled on AD, ManageDsaIT when the server lists it, time limit).
 * History (per connection, persisted, pinned first, ▶ Run) and saved
 * searches (the visible search with its connection and base).
 * No success toasts: the results strip shows counts, timing and failures (UX-9).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, BookmarkPlus, ChevronDown, ChevronRight, Clock, Code, Crosshair, ListTree, Pin, PinOff, Play, Plug, Save, Search, SlidersHorizontal, Square, Trash2, Wand2, Zap } from 'lucide-react'
import { useSearchStore, type SavedSearch, type SearchHistoryItem } from '../../stores/searchStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useUIStore } from '../../stores/uiStore'
import { useTreeStore, getPrimarySelectedNode, findLoadedTreeNode } from '../../stores/treeStore'
import { isContainerKind, nodeKind } from '../ui/objectKind'
import { ScopeBase, ScopeOne, ScopeSub, type SearchParams, type SearchScope, type ServerInfo } from '../../types/ldap'
import { FilterBuilderDialog } from './FilterBuilder'
import { RawFilterHint, TextOverrideHint } from './RawFilterHint'
import { useFilterCheck } from './useFilterCheck'
import * as wails from '../../lib/wails'
import {
  QUICK_ANY_NAME, buildAnyNameFilter, buildQuickFilter, parseQuickSearchInput, quickObjectTypeFilter,
  quickObjectTypes, quickSearchAttributes,
} from '../../lib/searchFilter'
import { checkFilter } from '../../lib/wails-treesearch'
import { describeFilterError } from '../../lib/ldapFilter'
import type { MatchType } from '../../types/treesearch'
import { ensureServerInfo } from '../ui/commands'
import { describeQuick, historyFor, quickRunProblem, resultCountText, scopeLabel, type QuickSearchSnapshot } from './searchModel'
import { firstRDN, getParentDN, parseRDN } from '../../lib/dn'
import { connectProfile, showActivity, showSearchResults, useShellState } from '../layout/shellState'
import { PanelHeader } from '../ui/PanelHeader'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Field } from '../ui/Field'
import { Input, Select, Textarea } from '../ui/Input'
import { Button, IconButton } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Disclosure } from '../ui/Disclosure'
import { EmptyState } from '../ui/EmptyState'
import { InlineAlert } from '../ui/InlineAlert'
import { Spinner } from '../ui/Spinner'
import { formatDateTime, formatRelative } from '../ui/accountStatus'
import { cn } from '../../lib/utils'

const SCOPE_OPTIONS: { label: string; value: string }[] = [
  { label: 'Base', value: String(ScopeBase) },
  { label: 'One level', value: String(ScopeOne) },
  { label: 'Subtree', value: String(ScopeSub) },
];

const MODE_OPTIONS = [
  { value: 'quick' as const, label: 'Quick', icon: Zap },
  { value: 'advanced' as const, label: 'Advanced', icon: Code },
];

const QUICK_MATCH_TYPES: { value: MatchType; label: string }[] = [
  { value: 'contains', label: 'Contains' },
  { value: 'startsWith', label: 'Starts' },
  { value: 'endsWith', label: 'Ends' },
  { value: 'exact', label: 'Exact' },
];

/** Control OIDs (RootDSE supportedControl). */
const CONTROL_SHOW_DELETED = '1.2.840.113556.1.4.417';
const CONTROL_SHOW_RECYCLED = '1.2.840.113556.1.4.2064';
const CONTROL_MANAGE_DSAIT = '2.16.840.1.113730.3.4.2';

/** Parameters of a quick search run: subtree, all attributes, no controls (hidden advanced settings never change it). */
const QUICK_OVERRIDES: Partial<SearchParams> = { scope: ScopeSub, attributes: [], showDeleted: false, showRecycled: false, manageDsaIT: false };

/** Server capabilities of a profile (cached RootDSE read: server type, controls, naming contexts). */
function useServerInfo(profileId: string | null, connected: boolean): ServerInfo | null {
  const [info, setInfo] = useState<{ id: string; info: ServerInfo | null } | null>(null);
  useEffect(() => {
    if (!profileId || !connected) return;
    let alive = true;
    void ensureServerInfo(profileId).then((i) => alive && setInfo({ id: profileId, info: i }));
    return () => {
      alive = false;
    };
  }, [profileId, connected]);
  return info && info.id === profileId ? info.info : null;
}

/** The quick-search filter of a snapshot (lib/searchFilter.ts builders). */
export function quickFilterOf(q: QuickSearchSnapshot, text: string, serverType: ServerInfo['serverType'] | null): string {
  const typeFilter = quickObjectTypeFilter(q.objectType, serverType);
  // An object type without text lists all objects of that type below the base (RW1-S-02).
  if (!text.trim()) return typeFilter;
  return q.attr === QUICK_ANY_NAME
    ? buildAnyNameFilter(text, q.matchType, serverType ?? null, typeFilter)
    : buildQuickFilter(text, q.attr, q.matchType, typeFilter);
}

/** "cn, mail ,, sn" -> ['cn', 'mail', 'sn']. */
function parseAttributeList(text: string): string[] {
  return text.split(/[,\s]+/).map((a) => a.trim()).filter(Boolean);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function shortDN(dn: string): string {
  return dn ? parseRDN(firstRDN(dn)).value || dn : '';
}

export function SearchPanel() {
  const params = useSearchStore((s) => s.params);
  const loading = useSearchStore((s) => s.loading);
  const cancelling = useSearchStore((s) => s.cancelling);
  const allHistory = useSearchStore((s) => s.history);
  const searchMode = useSearchStore((s) => s.panelMode);
  const quick = useSearchStore((s) => s.quick);
  const { setParams, setQuick, setBaseDN, executeSearch, cancelSearch, restoreSearch, togglePin, removeHistory, clearHistory, setDisplayColumns, setPanelMode } =
    useSearchStore.getState();
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const isConnected = useConnectionStore((s) => (s.activeProfileId ? s.connectionStatuses[s.activeProfileId] === true : false));
  const activeProfile = useConnectionStore((s) => s.profiles.find((p) => p.id === s.activeProfileId) ?? null);
  const setActivity = useUIStore((s) => s.setActivity);
  const treeSelection = useTreeStore((s) => s.selectedNodes);
  const info = useServerInfo(activeProfileId, isConnected);
  const serverType = info?.serverType ?? null;
  const isAD = serverType === 'ad';

  const [showHistory, setShowHistory] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);
  const [returnAttrsText, setReturnAttrsText] = useState(() => params.attributes.join(', '));
  const [detectingBaseDN, setDetectingBaseDN] = useState(false);
  const [sizeText, setSizeText] = useState(String(params.sizeLimit));
  const [savedWarning, setSavedWarning] = useState<string | null>(null);
  // The notice is about one load on one connection: a switch or another search ends it (RW2-S-08).
  useEffect(() => setSavedWarning(null), [activeProfileId]);

  // Return attributes / size limit changed elsewhere (history, saved search, report "Edit as Search"):
  // the text follows, but not while typing ("cn, " parses to the list it already is).
  useEffect(() => {
    setReturnAttrsText((text) => (sameList(parseAttributeList(text), params.attributes) ? text : params.attributes.join(', ')));
  }, [params.attributes]);
  useEffect(() => setSizeText(String(params.sizeLimit)), [params.sizeLimit]);

  // Quick search state
  const [quickError, setQuickError] = useState<string | null>(null);
  const quickInputRef = useRef<HTMLInputElement>(null);
  // Input starting with "(" that the user chose to search as text (cleared by any edit)
  const [quickTextOverride, setQuickTextOverride] = useState<string | null>(null);
  const quickForcedText = quickTextOverride !== null && quickTextOverride === quick.text;
  const quickInput = parseQuickSearchInput(quick.text, quickForcedText);
  const isRawQuick = quickInput.kind === 'raw';
  const showTextOverrideHint = quickForcedText && parseQuickSearchInput(quick.text).kind === 'raw';
  const rawCheck = useFilterCheck(searchMode === 'quick' && isRawQuick ? quickInput.text : null);
  const anyName = quick.attr === QUICK_ANY_NAME;
  // ANR has its own (prefix) semantics: the match type does not apply.
  const matchApplies = !isRawQuick && !(anyName && isAD);
  const advancedCheck = useFilterCheck(searchMode === 'advanced' && params.filter.trim() ? params.filter.trim() : null);

  const attrOptions = useMemo(() => quickSearchAttributes(serverType), [serverType]);
  const typeOptions = useMemo(() => quickObjectTypes(serverType), [serverType]);
  // A choice the server type does not offer (saved on another server) falls back to the default.
  useEffect(() => {
    if (!info) return;
    if (!attrOptions.some((o) => o.value === quick.attr)) setQuick({ attr: QUICK_ANY_NAME });
    if (!typeOptions.some((o) => o.value === quick.objectType)) setQuick({ objectType: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, attrOptions, typeOptions]);

  const history = useMemo(() => historyFor(allHistory, activeProfileId), [allHistory, activeProfileId]);
  // A selected leaf gives its container: a subtree search below a contact finds only the contact (RW2-S-11).
  const treeDN = useMemo(() => {
    const dn = treeSelection.size ? getPrimarySelectedNode() : null;
    if (!dn) return null;
    const ts = useTreeStore.getState();
    const node = findLoadedTreeNode(activeProfileId ? ts.rootNodes[activeProfileId] : undefined, ts.childNodes, dn);
    const leaf = !!node && !node.hasChildren && !isContainerKind(nodeKind(node)) && ts.childNodes[dn] === undefined;
    return leaf ? getParentDN(dn) || dn : dn;
  }, [treeSelection, activeProfileId]);

  const supports = (oid: string) => !!info?.supportedControls?.includes(oid);
  const canShowDeleted = isAD && supports(CONTROL_SHOW_DELETED);
  const canShowRecycled = isAD && supports(CONTROL_SHOW_RECYCLED);
  const canManageDsaIT = supports(CONTROL_MANAGE_DSAIT);

  const quickFilter = (text: string) => quickFilterOf(quick, text, serverType);
  const attrLabel = (a: string) => attrOptions.find((o) => o.value === a)?.label ?? a;
  const typeLabel = (t: string) => typeOptions.find((o) => o.value === t)?.label ?? t;

  // Auto-detect BaseDN from RootDSE
  async function handleDetectBaseDN() {
    if (!activeProfileId) return;
    setDetectingBaseDN(true);
    try {
      const rootDSE = await wails.GetRootDSE(activeProfileId);
      if (rootDSE) {
        const defaultNC = rootDSE.attributes?.find((a) => a.name.toLowerCase() === 'defaultnamingcontext');
        const namingContexts = rootDSE.attributes?.find((a) => a.name.toLowerCase() === 'namingcontexts');
        const baseDN = defaultNC?.values?.[0] || namingContexts?.values?.[0] || '';
        if (baseDN) setBaseDN(activeProfileId, baseDN);
      }
    } catch {
      /* ignore */
    }
    setDetectingBaseDN(false);
  }

  /** Advanced search: unsupported controls of this server are not sent. */
  async function handleSearch() {
    setSavedWarning(null);
    if (!activeProfileId || !isConnected || loading) return;
    if (advancedCheck.status === 'invalid') return;
    showSearchResults();
    await executeSearch(activeProfileId, undefined, {
      mode: 'advanced',
      serverType,
      overrides: {
        showDeleted: !!params.showDeleted && canShowDeleted,
        showRecycled: !!params.showRecycled && canShowRecycled,
        manageDsaIT: !!params.manageDsaIT && canManageDsaIT,
      },
    });
  }

  async function handleQuickSearch(asText = false) {
    setSavedWarning(null);
    const typeOnlyNow = quickInput.kind === 'empty' && !!quickObjectTypeFilter(quick.objectType, serverType);
    if (!activeProfileId || !isConnected || loading || (quickInput.kind === 'empty' && !typeOnlyNow)) return;
    let filter: string;
    if (quickInput.kind === 'raw' && !asText) {
      const invalid = await checkFilter(quickInput.text);
      if (invalid) {
        setQuickError(describeFilterError(quickInput.text, invalid));
        return;
      }
      filter = quickInput.text;
    } else {
      filter = quickFilter(quickInput.text);
    }
    setQuickError(null);
    showSearchResults();
    await executeSearch(activeProfileId, filter, { mode: 'quick', quick: { ...quick }, serverType, overrides: QUICK_OVERRIDES });
  }

  /** Switching to Advanced carries the generated quick filter over (the Filter Builder then starts from it). */
  function switchMode(mode: 'quick' | 'advanced') {
    if (mode === 'advanced' && searchMode === 'quick') {
      if (quickInput.kind === 'raw') setParams({ filter: quickInput.text });
      else if (quickInput.kind === 'text' || quick.objectType) setParams({ filter: quickFilter(quickInput.text) });
    }
    setPanelMode(mode);
  }

  /** A quick search that has no filter here (RW3-S-01): the reason, shown instead of running it. */
  function quickBlocked(q: QuickSearchSnapshot): string | null {
    const problem = quickRunProblem(q, quickObjectTypeFilter(q.objectType, serverType), typeLabel, activeProfile?.name ?? 'this connection');
    if (problem) setSavedWarning(problem);
    return problem;
  }

  async function runHistory(item: SearchHistoryItem) {
    restoreSearch(item);
    if (!activeProfileId || !isConnected) return;
    if (item.mode === 'quick' && item.quick && quickBlocked(item.quick)) return;
    showSearchResults();
    if (item.mode === 'quick' && item.quick) {
      await executeSearch(activeProfileId, quickFilterOf(item.quick, item.quick.text, serverType), { mode: 'quick', quick: item.quick, serverType, overrides: QUICK_OVERRIDES });
    } else {
      await executeSearch(activeProfileId, undefined, { mode: 'advanced', serverType });
    }
  }

  function loadSaved(saved: SavedSearch, runIt: boolean) {
    const warning = useSearchStore.getState().restoreSavedSearch(saved, activeProfileId);
    setSavedWarning(warning);
    if (runIt && activeProfileId && isConnected) {
      const p = useSearchStore.getState();
      // The panel's own rule (Search disabled without a filter) also holds for ▶ (RW3-S-01).
      if (p.panelMode === 'quick' && saved.quick && quickBlocked(saved.quick)) return;
      showSearchResults();
      if (p.panelMode === 'quick' && saved.quick) {
        void executeSearch(activeProfileId, quickFilterOf(saved.quick, saved.quick.text, serverType), { mode: 'quick', quick: saved.quick, serverType, overrides: QUICK_OVERRIDES });
      } else {
        void executeSearch(activeProfileId, undefined, { mode: 'advanced', serverType });
      }
    }
  }

  if (!isConnected) {
    return <DisconnectedSearch profileId={activeProfileId} profileName={activeProfile?.name} />;
  }

  const advancedInvalid = advancedCheck.status === 'invalid';
  // An invalid raw filter in Quick mode blocks Search as in Advanced mode ("Search as text instead" stays; RW2-S-12).
  const quickRawInvalid = searchMode === 'quick' && isRawQuick && (!!quickError || rawCheck.status === 'invalid');
  const typeOnly = searchMode === 'quick' && quickInput.kind === 'empty' && !!quickObjectTypeFilter(quick.objectType, serverType);
  const canSearch = searchMode === 'quick' ? (quickInput.kind !== 'empty' || typeOnly) && !quickRawInvalid : !!params.filter.trim() && !advancedInvalid;
  const controlsOn = [params.showDeleted && canShowDeleted && 'deleted', params.showRecycled && canShowRecycled && 'recycled', params.manageDsaIT && canManageDsaIT && 'ManageDsaIT'].filter(Boolean) as string[];

  return (
    <div className="h-full flex flex-col bg-sidebar">
      <PanelHeader title="Search" />

      <form
        className="flex-1 overflow-auto p-3 space-y-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (searchMode === 'quick') void handleQuickSearch();
          else void handleSearch();
        }}
        // Ctrl+Enter searches from every field of the form, not only from the filter (FIN-W-04:
        // the Base DN field did nothing). The filter's own handler prevents the default first.
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.defaultPrevented || e.nativeEvent.isComposing) return;
          e.preventDefault();
          e.stopPropagation();
          if (searchMode === 'quick') void handleQuickSearch();
          else void handleSearch();
        }}
      >
        <SegmentedControl aria-label="Search mode" options={MODE_OPTIONS} value={searchMode} onValueChange={switchMode} className="w-full [&>button]:flex-1" />

        <Field label="Base DN" hint={!params.baseDN ? `Empty: ${activeProfile?.baseDN || info?.defaultNamingContext || 'the server default'}` : undefined}>
          <Input
            value={params.baseDN}
            onChange={(e) => setBaseDN(activeProfileId, e.target.value)}
            placeholder={activeProfile?.baseDN || info?.defaultNamingContext || 'dc=example,dc=com'}
            mono
            spellCheck={false}
            suffix={
              <span className="flex items-center">
                <IconButton
                  label={treeDN ? `Use Tree Selection (${shortDN(treeDN)})` : 'Use Tree Selection (select a container in the tree)'}
                  icon={ListTree}
                  size="sm"
                  disabled={!treeDN}
                  onClick={() => treeDN && setBaseDN(activeProfileId, treeDN)}
                />
                {detectingBaseDN ? (
                  <Spinner size="sm" label="Reading the RootDSE" />
                ) : (
                  <IconButton label="Detect from the RootDSE" icon={Crosshair} size="sm" onClick={handleDetectBaseDN} />
                )}
              </span>
            }
          />
        </Field>

        {searchMode === 'quick' ? (
          <>
            <Field label="Search for" hint={!isRawQuick && !showTextOverrideHint ? 'Matched literally. Start with ( for a raw LDAP filter.' : undefined}>
              <Input
                ref={quickInputRef}
                value={quick.text}
                onChange={(e) => {
                  setQuick({ text: e.target.value });
                  setQuickError(null);
                  setQuickTextOverride(null);
                }}
                placeholder={anyName ? (isAD ? 'Name, login or e-mail' : 'Name, uid or e-mail') : 'Text to find'}
                mono={isRawQuick}
                spellCheck={false}
                autoFocus
                data-panel-autofocus=""
              />
            </Field>
            {isRawQuick && (
              <RawFilterHint
                check={quickError ? { status: 'invalid', error: quickError } : rawCheck}
                onSearchAsText={() => {
                  setQuickTextOverride(quick.text);
                  void handleQuickSearch(true);
                }}
              />
            )}
            {showTextOverrideHint && <TextOverrideHint onUseAsFilter={() => setQuickTextOverride(null)} />}

            <Field
              label="Search in"
              hint={isRawQuick ? 'Not used for raw filters' : anyName && isAD ? 'Active Directory name resolution (ANR): names, login and e-mail starting with the text' : undefined}
            >
              <Select value={quick.attr} onChange={(e) => setQuick({ attr: e.target.value })} disabled={isRawQuick} options={attrOptions} />
            </Field>

            <div className="space-y-1">
              <span id="search-match-label" className="block text-sm font-medium text-muted-foreground">
                Match
              </span>
              <SegmentedControl
                aria-labelledby="search-match-label"
                options={QUICK_MATCH_TYPES.map((m) => ({ ...m, disabled: !matchApplies }))}
                value={quick.matchType}
                onValueChange={(v) => setQuick({ matchType: v })}
                className="w-full [&>button]:flex-1"
              />
            </div>

            <Field label="Object type" hint={isRawQuick ? 'Not used for raw filters' : undefined}>
              <Select value={quick.objectType} onChange={(e) => setQuick({ objectType: e.target.value })} disabled={isRawQuick} options={typeOptions} />
            </Field>

            {quickInput.kind === 'text' && (
              <div className="space-y-0.5">
                <div className="text-xs text-muted-foreground font-mono bg-background rounded border border-border px-2 py-1 break-all" aria-label="Generated filter">
                  {quickFilter(quickInput.text)}
                </div>
                <Button size="sm" variant="link" onClick={() => switchMode('advanced')} title="Open this filter in the advanced mode (Filter Builder, scope, return attributes)">
                  Edit as Advanced
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="space-y-1">
              <span id="search-scope-label" className="block text-sm font-medium text-muted-foreground">
                Scope
              </span>
              <SegmentedControl
                aria-labelledby="search-scope-label"
                options={SCOPE_OPTIONS}
                value={String(params.scope)}
                onValueChange={(v) => setParams({ scope: Number(v) as SearchScope })}
                className="w-full [&>button]:flex-1"
              />
            </div>

            <Field label="Filter" hint="Ctrl+Enter searches.">
              <Textarea
                value={params.filter}
                onChange={(e) => setParams({ filter: e.target.value })}
                placeholder="(objectClass=*)"
                mono
                rows={3}
                spellCheck={false}
                invalid={advancedInvalid}
                data-search-filter=""
                data-panel-autofocus=""
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void handleSearch();
                  }
                }}
              />
            </Field>
            <FilterStatus check={advancedCheck} />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 -mt-1">
              <Button size="sm" variant="ghost" leftIcon={Wand2} onClick={() => setShowBuilder(true)}>
                Filter Builder…
              </Button>
              <Button size="sm" variant="ghost" leftIcon={BarChart3} onClick={() => setActivity('reports')} title="Ready-made filters (users, groups, security) are reports; Edit as Search copies one here">
                Ready-made filters
              </Button>
            </div>

            <Field label="Return attributes" hint="Comma-separated; empty returns all attributes. objectClass and the account status are always read for the Type and Status columns.">
              <Input
                value={returnAttrsText}
                onChange={(e) => {
                  setReturnAttrsText(e.target.value);
                  setParams({ attributes: parseAttributeList(e.target.value) });
                }}
                placeholder="cn, mail, description"
                mono
                suffix={
                  <Button size="sm" variant="link" disabled={!params.attributes.length} onClick={() => setDisplayColumns(params.attributes, activeProfileId)} title="Show these attributes as result columns">
                    As columns
                  </Button>
                }
              />
            </Field>

            <Disclosure title="Controls" icon={SlidersHorizontal} summary={controlsOn.length ? controlsOn.join(', ') : undefined} className="-mx-1">
              <div className="space-y-2 px-1 pt-1">
                {canShowDeleted && (
                  <Checkbox
                    checked={!!params.showDeleted}
                    onCheckedChange={(v) => setParams({ showDeleted: v })}
                    label="Show deleted objects"
                    description="AD Show Deleted control: tombstones and deleted objects (base e.g. CN=Deleted Objects,…)"
                  />
                )}
                {canShowRecycled && (
                  <Checkbox
                    checked={!!params.showRecycled}
                    onCheckedChange={(v) => setParams({ showRecycled: v })}
                    label="Show recycled objects"
                    description="AD Show Recycled control (objects removed from the Recycle Bin)"
                  />
                )}
                {canManageDsaIT && (
                  <Checkbox
                    checked={!!params.manageDsaIT}
                    onCheckedChange={(v) => setParams({ manageDsaIT: v })}
                    label="Return referral objects as entries (ManageDsaIT)"
                  />
                )}
                {!canShowDeleted && !canShowRecycled && !canManageDsaIT && (
                  <p className="text-xs text-muted-foreground">{info ? 'This server lists none of the optional search controls.' : 'Reading the server capabilities…'}</p>
                )}
                <Field label="Time limit (seconds)" hint="0 = the server's limit">
                  <Input
                    type="number"
                    min={0}
                    value={params.timeLimit}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      setParams({ timeLimit: Number.isFinite(n) && n >= 0 ? n : 0 });
                    }}
                    className="tabular-nums"
                  />
                </Field>
              </div>
            </Disclosure>
          </>
        )}

        <Field label="Size limit" hint="0 = no limit (searches page through everything).">
          <Input
            type="number"
            min={0}
            value={sizeText}
            onChange={(e) => {
              setSizeText(e.target.value);
              const n = parseInt(e.target.value, 10);
              if (Number.isFinite(n) && n >= 0) setParams({ sizeLimit: n });
            }}
            onBlur={() => setSizeText(String(useSearchStore.getState().params.sizeLimit))}
            className="tabular-nums"
          />
        </Field>

        {loading ? (
          <div className="flex gap-2">
            <div className="flex-1 flex items-center justify-center gap-2 h-control rounded bg-primary-subtle text-primary text-sm" role="status">
              <Spinner size="sm" decorative />
              {cancelling ? 'Cancelling…' : 'Searching…'}
            </div>
            <Button leftIcon={Square} onClick={() => void cancelSearch()} disabled={cancelling} title="Cancel the running search">
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            type="submit"
            variant="primary"
            leftIcon={Search}
            disabled={!canSearch}
            className="w-full"
            title={advancedInvalid || quickRawInvalid ? 'Fix the filter first' : !canSearch ? (searchMode === 'quick' ? 'Type a name to search for, or choose an object type to list all of them' : 'Type a filter first') : undefined}
          >
            Search
          </Button>
        )}

        <SaveSearchSection
          serverType={serverType}
          warning={savedWarning}
          onDismissWarning={() => setSavedWarning(null)}
          onLoad={loadSaved}
          describe={(q) => describeQuick(q, attrLabel, typeLabel)}
        />

        {history.length > 0 && (
          <section className="border-t border-border pt-3" aria-label="Search history">
            <div className="flex items-center justify-between mb-1">
              <Button size="sm" variant="ghost" leftIcon={showHistory ? ChevronDown : ChevronRight} aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)} className="-ml-2">
                <Clock size={12} strokeWidth={1.75} aria-hidden />
                History ({history.length})
              </Button>
              {showHistory && (
                <Button size="sm" variant="ghost" onClick={() => clearHistory(activeProfileId)} title="Remove the entries of this connection that are not pinned">
                  Clear
                </Button>
              )}
            </div>
            {showHistory && (
              <ul className="space-y-0.5 max-h-[240px] overflow-auto">
                {history.map((item) => (
                  <HistoryItem
                    key={item.id}
                    item={item}
                    label={item.mode === 'quick' && item.quick ? describeQuick(item.quick, attrLabel, typeLabel) : item.params.filter}
                    mono={!(item.mode === 'quick' && item.quick)}
                    onRestore={() => restoreSearch(item)}
                    onRun={() => void runHistory(item)}
                    onTogglePin={() => togglePin(item.id)}
                    onRemove={() => removeHistory(item.id)}
                  />
                ))}
              </ul>
            )}
          </section>
        )}
      </form>

      {showBuilder && (
        <FilterBuilderDialog
          initialFilter={params.filter}
          serverType={serverType}
          profileId={activeProfileId}
          onApply={(filter) => {
            setParams({ filter });
            setShowBuilder(false);
          }}
          onApplyAndSearch={(filter) => {
            setParams({ filter });
            setShowBuilder(false);
            void handleSearch();
          }}
          onClose={() => setShowBuilder(false)}
        />
      )}
    </div>
  );
}

/** Live validation of the advanced filter: valid, or the problem with its position. */
function FilterStatus({ check }: { check: ReturnType<typeof useFilterCheck> }) {
  if (check.status === 'idle') return null;
  return (
    <div className={cn('-mt-2 text-xs flex items-start gap-1 min-h-4', check.status === 'invalid' ? 'text-destructive' : 'text-muted-foreground')} role="status" aria-live="polite">
      {check.status === 'checking' && <Spinner size="sm" label="Checking the filter" />}
      {check.status === 'valid' && <span>Valid filter</span>}
      {check.status === 'invalid' && <span className="break-words min-w-0">{check.error}</span>}
    </div>
  );
}

/** Not connected: connect the selected connection, or open the connection list. */
function DisconnectedSearch({ profileId, profileName }: { profileId: string | null; profileName?: string }) {
  const connectingId = useShellState((s) => s.connectingId);
  const lastUsed = useShellState((s) => s.lastUsedProfileId);
  const profiles = useConnectionStore((s) => s.profiles);
  const target = profileId ?? (lastUsed && profiles.some((p) => p.id === lastUsed) ? lastUsed : null);
  const targetName = profileId ? profileName : profiles.find((p) => p.id === target)?.name;
  return (
    <div className="h-full flex flex-col bg-sidebar">
      <PanelHeader title="Search" />
      <EmptyState
        icon={Search}
        title="Not connected"
        hint="Connect to a directory to search it."
        action={
          target ? (
            <>
              <Button size="sm" variant="primary" leftIcon={Plug} loading={connectingId === target} onClick={() => void connectProfile(target, { reveal: false })}>
                Connect to {targetName}
              </Button>
              <Button size="sm" onClick={() => showActivity('connections')}>
                Connections…
              </Button>
            </>
          ) : (
            <Button size="sm" variant="primary" leftIcon={Plug} onClick={() => showActivity('connections')}>
              Connect…
            </Button>
          )
        }
      />
    </div>
  );
}

function HistoryItem({ item, label, mono, onRestore, onRun, onTogglePin, onRemove }: {
  item: SearchHistoryItem;
  label: string;
  mono: boolean;
  onRestore: () => void;
  onRun: () => void;
  onTogglePin: () => void;
  onRemove: () => void;
}) {
  const when = new Date(item.timestamp);
  const scope = scopeLabel(item.params.scope);
  return (
    <li className="group flex items-center gap-0.5 rounded hover:bg-accent focus-within:bg-accent">
      <button type="button"
        onClick={onRestore}
        className="flex-1 min-w-0 text-left px-2 py-1 rounded focus-ring-inset"
        title={`${item.params.filter}\nin ${item.params.baseDN || '(connection base)'}${scope ? ` · ${scope}` : ' · subtree'}\n${resultCountText(item.resultCount)} · ${formatDateTime(when)}\nClick loads it into the panel; ▶ runs it.`}
      >
        <span className={cn('block text-xs truncate text-foreground', mono && 'font-mono')}>{label}</span>
        <span className="block text-xs text-muted-foreground tabular-nums truncate">
          {item.params.baseDN ? `in ${shortDN(item.params.baseDN)} · ` : ''}
          {/* Rows that differ only in scope no longer look like duplicates (RW3-S-05). */}
          {scope ? `${scope} · ` : ''}
          {resultCountText(item.resultCount)} · {formatRelative(when)}
        </span>
      </button>
      <IconButton label="Run" icon={Play} size="sm" onClick={onRun} />
      <IconButton label={item.pinned ? 'Unpin' : 'Pin'} icon={item.pinned ? PinOff : Pin} size="sm" pressed={item.pinned} revealOnRowHover={!item.pinned} onClick={onTogglePin} />
      <IconButton label="Remove from history" icon={Trash2} size="sm" revealOnRowHover onClick={onRemove} />
    </li>
  );
}

function SaveSearchSection({ serverType, warning, onDismissWarning, onLoad, describe }: {
  serverType: ServerInfo['serverType'] | null;
  warning: string | null;
  onDismissWarning: () => void;
  onLoad: (saved: SavedSearch, run: boolean) => void;
  /** One-line description of a quick search (the history's wording: "All contacts", RW3-S-02). */
  describe: (q: QuickSearchSnapshot) => string;
}) {
  const savedSearches = useSearchStore((s) => s.savedSearches);
  const panelMode = useSearchStore((s) => s.panelMode);
  const quick = useSearchStore((s) => s.quick);
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const profiles = useConnectionStore((s) => s.profiles);
  const { saveSearch, removeSavedSearch } = useSearchStore.getState();
  const [showSaved, setShowSaved] = useState(false);
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [saveName, setSaveName] = useState('');
  // A type-only quick search (Contacts, no text) is a search too (RW2-S-05).
  const quickEmpty = panelMode === 'quick' && !quick.text.trim() && !quick.objectType;

  function handleSave() {
    if (!saveName.trim()) return;
    const profile = profiles.find((p) => p.id === activeProfileId);
    saveSearch(saveName.trim(), { mode: panelMode, quick, serverType, profileId: activeProfileId, profileName: profile?.name });
    setSaveName('');
    setShowSaveInput(false);
    // The new entry is the feedback (no toast).
    setShowSaved(true);
  }

  const connectionName = (s: SavedSearch) => (s.profileId ? profiles.find((p) => p.id === s.profileId)?.name || s.profileName || 'deleted connection' : 'any connection');

  return (
    <section className="border-t border-border pt-3" aria-label="Saved searches">
      <div className="flex items-center justify-between mb-1">
        <Button size="sm" variant="ghost" leftIcon={showSaved ? ChevronDown : ChevronRight} aria-expanded={showSaved} onClick={() => setShowSaved(!showSaved)} className="-ml-2">
          <BookmarkPlus size={12} strokeWidth={1.75} aria-hidden />
          Saved searches ({savedSearches.length})
        </Button>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={Save}
          aria-expanded={showSaveInput}
          disabled={quickEmpty}
          onClick={() => setShowSaveInput(!showSaveInput)}
          title={quickEmpty ? 'Type something to search for, or choose an object type, first' : `Save the ${panelMode === 'quick' ? 'quick search' : 'filter'} with this connection and base DN`}
        >
          Save
        </Button>
      </div>

      {warning && <InlineAlert tone="warning" body={warning} onDismiss={onDismissWarning} className="mb-2" />}

      {showSaveInput && (
        <div className="flex gap-1 mb-2">
          <Input
            size="sm"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSave();
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setShowSaveInput(false);
              }
            }}
            placeholder="Name of the search"
            aria-label="Name of the search"
            autoFocus
          />
          <Button size="sm" variant="primary" onClick={handleSave} disabled={!saveName.trim()}>
            Save
          </Button>
        </div>
      )}

      {showSaved &&
        (savedSearches.length > 0 ? (
          <ul className="space-y-0.5 max-h-[240px] overflow-auto">
            {savedSearches.map((saved) => {
              const other = !!saved.profileId && saved.profileId !== activeProfileId;
              const what = saved.mode === 'quick' && saved.quick ? describe(saved.quick) : saved.params.filter;
              return (
                <li key={saved.id} className="group flex items-center gap-0.5 rounded hover:bg-accent focus-within:bg-accent">
                  <button type="button"
                    onClick={() => onLoad(saved, false)}
                    className="flex-1 min-w-0 text-left px-2 py-1 rounded focus-ring-inset"
                    title={`${what}\nConnection: ${connectionName(saved)}\nBase DN: ${saved.params.baseDN || '(connection base)'}\nColumns: ${saved.displayColumns.join(', ')}`}
                  >
                    <span className="block text-sm font-medium truncate text-foreground">{saved.name}</span>
                    <span className={cn('block text-xs truncate', saved.mode === 'quick' ? 'text-muted-foreground' : 'text-muted-foreground font-mono')}>{what}</span>
                    <span className={cn('block text-xs truncate', other ? 'text-warning' : 'text-muted-foreground')}>
                      {connectionName(saved)}
                      {saved.params.baseDN ? ` · ${shortDN(saved.params.baseDN)}` : ''}
                    </span>
                  </button>
                  <IconButton label="Run" icon={Play} size="sm" onClick={() => onLoad(saved, true)} />
                  <IconButton label={`Remove saved search ${saved.name}`} icon={Trash2} size="sm" revealOnRowHover onClick={() => removeSavedSearch(saved.id)} />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground text-center py-2">No saved searches yet. Save the current search to reuse it.</p>
        ))}
    </section>
  );
}
