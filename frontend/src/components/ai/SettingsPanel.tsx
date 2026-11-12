import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Globe, HardDrive, Loader2, Lock, Plug, RefreshCw, Save, X } from 'lucide-react';
import type { AIConfig, AccessEntry, ClaudeCodeHosts, ModelDiscovery, ModelInfo, ProviderTestResult } from '../../types/ai';
import { classifyDestination, DEFAULT_URLS, formatRelativeTime, formatTokens, isLoopbackHost, providerKeyOf, urlHost } from '../../lib/aiFormat';
import * as api from '../../lib/ai';
import { useAIStore } from '../../stores/aiStore';
import { soleModel } from '../../lib/aiComposer';
import { discoveryNeedsKey, reloadSettingsDraft } from '../../lib/aiSettings';
import { anthropicEnvHint, CC_RUNTIMES, ccRuntimeHint, distroOptions, locationText } from '../../lib/aiClaudeCode';
import { scanPasswords } from '../../lib/aiPassword';
import { useConnectionStore } from '../../stores/connectionStore';
import { CapabilityChips } from './ModelPicker';
import { chip, iconButton, primaryButton, textButton, tone } from './tone';
import { cn } from '../../lib/utils';
import { Checkbox } from '../ui/Checkbox';
import { Input, Select, Textarea } from '../ui/Input';
import { SegmentedControl } from '../ui/SegmentedControl';
import { toast } from '../ui/Toast';

interface Preset {
  id: string;
  label: string;
  provider: string;
  flavor: string;
  /** "" = user-supplied */
  url: string;
}

const PRESETS: Preset[] = [
  { id: 'ollama', label: 'Ollama (native, recommended)', provider: 'ollama', flavor: '', url: 'http://localhost:11434' },
  { id: 'openai/ollama', label: 'Ollama (OpenAI-compatible)', provider: 'openai', flavor: 'ollama', url: 'http://localhost:11434/v1' },
  { id: 'openai/openai', label: 'OpenAI', provider: 'openai', flavor: 'openai', url: 'https://api.openai.com/v1' },
  { id: 'anthropic', label: 'Anthropic', provider: 'anthropic', flavor: '', url: 'https://api.anthropic.com' },
  { id: 'openai/litellm', label: 'LiteLLM', provider: 'openai', flavor: 'litellm', url: '' },
  { id: 'openai/vllm', label: 'vLLM', provider: 'openai', flavor: 'vllm', url: 'http://localhost:8000/v1' },
  { id: 'openai/lmstudio', label: 'LM Studio', provider: 'openai', flavor: 'lmstudio', url: 'http://localhost:1234/v1' },
  { id: 'openai/custom', label: 'Custom OpenAI-compatible', provider: 'openai', flavor: 'custom', url: '' },
];

const LEVELS = [
  { value: 'none', label: 'None' },
  { value: 'ask', label: 'Ask' },
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Write' },
];
const ENGINES = [
  { value: 'builtin', label: 'Built-in' },
  { value: 'claudecode', label: 'Claude Code' },
] as const;
const THINKING = [
  { value: '', label: 'Auto' },
  { value: 'off', label: 'Off (best effort)' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];
const LEVEL_RANK: Record<string, number> = { none: 0, ask: 1, read: 2, write: 3 };
const REDACT_RE = /^([A-Za-z][A-Za-z0-9-]*\*?|[0-9]+(\.[0-9]+)+)$/;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function presetIdOf(cfg: AIConfig): string {
  if (!cfg.provider) return '';
  return cfg.provider === 'openai' ? 'openai/' + (cfg.flavor || 'custom') : cfg.provider;
}

function Section({ title, children, defaultOpen = true, icon }: { title: string; children: ReactNode; defaultOpen?: boolean; icon?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-border">
      <button type="button" className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wider text-secondary-foreground hover:bg-accent" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {icon} {title}
      </button>
      {open && <div className="space-y-2 px-3 pb-3 pt-1 text-xs">{children}</div>}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-0.5">
      <span className="text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-muted-foreground [overflow-wrap:anywhere]">{hint}</span>}
    </label>
  );
}

function Toggle({ checked, onChange, label, hint, disabled, title }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean; title?: string }) {
  // ui Checkbox; long unbroken hint tokens (env var lists) wrap inside the
  // sidebar instead of running past its edge (defect D5).
  return (
    <div title={title}>
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="flex w-full text-xs"
        label={label}
        description={hint ? <span className="block [overflow-wrap:anywhere]">{hint}</span> : undefined}
      />
    </div>
  );
}

function NumberInput({ value, onChange, placeholder, min, max, step, ariaLabel }: { value: number; onChange: (v: number) => void; placeholder?: string; min?: number; max?: number; step?: number; ariaLabel: string }) {
  return (
    <Input
      type="number"
      size="sm"
      aria-label={ariaLabel}
      value={value ? String(value) : ''}
      placeholder={placeholder}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
    />
  );
}

/** Shown instead of a model list for OpenAI / Anthropic until a key is entered (A-32): a hint, not an error. */
const NEEDS_KEY = 'Enter the API key to list the models.';

/** Model list fed by discovery, with capability chips, refresh and warnings (§10.3, Addendum A). */
function ModelSection({ draft, discovery, loading, onRefresh, value, onChange }: {
  draft: AIConfig;
  discovery: ModelDiscovery | null;
  loading: boolean;
  onRefresh: () => void;
  value: string;
  onChange: (id: string) => void;
}) {
  const models = discovery?.models ?? [];
  const selected = models.find((m) => m.id === value);
  const cc = draft.engine === 'claudecode';
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          Model
          {discovery?.version ? ` · Claude Code ${discovery.version}` : ''}
          {discovery?.fetchedAt ? ` · ${discovery.fromCache ? 'cached' : 'updated'} ${formatRelativeTime(discovery.fetchedAt)}` : ''}
        </span>
        <button type="button" className={textButton + ' ml-auto'} aria-label="Refresh models" disabled={loading} onClick={onRefresh}>
          {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} Refresh
        </button>
      </div>
      {discovery?.error === NEEDS_KEY && <div className="text-muted-foreground">{NEEDS_KEY}</div>}
      {discovery?.error && discovery.error !== NEEDS_KEY && <div className={cn('flex items-start gap-1', tone.warningText)}><AlertTriangle size={11} className="mt-px shrink-0" /> {discovery.error}</div>}
      {(discovery?.warnings ?? []).map((w, i) => <div key={i} className={tone.warningText}>{w}</div>)}
      {discovery?.modelMissing && discovery.configuredModel && (
        <div className={tone.warningText}>
          The configured model “{discovery.configuredModel}” is not available; {discovery.effectiveModel ? `“${discovery.effectiveModel}” will be used` : 'the provider default will be used'}.
        </div>
      )}
      {/* With an error (or the key hint) above and no list, an empty box saying
          "No models found." only repeated it (S4, OpenAI preset). */}
      {(cc || models.length > 0 || loading || !discovery?.error) && (
        <div className="max-h-56 overflow-auto rounded border border-border" role="radiogroup" aria-label="Model">
          {cc && (
            <ModelRow m={null} label="CLI default" checked={!value} onSelect={() => onChange('')} />
          )}
          {models.map((m) => <ModelRow key={m.id} m={m} checked={value === m.id} showRemote={!cc && (draft.provider === 'ollama' || draft.flavor === 'ollama')} onSelect={() => onChange(m.id)} />)}
          {models.length === 0 && !cc && <div className="px-2 py-1.5 text-muted-foreground">{loading ? 'Loading models…' : 'No models found.'}</div>}
        </div>
      )}
      <Input
        size="sm"
        mono
        aria-label="Model ID"
        value={value}
        placeholder={cc ? 'default' : 'or enter a model ID'}
        onChange={(e) => onChange(e.target.value.trim())}
      />
      {selected?.tools === 'no' && <div className={cn('flex items-center gap-1', tone.warningText)}><AlertTriangle size={11} /> LDAP tools will not work with this model.</div>}
      {selected?.tools === 'unknown' && <div className="text-muted-foreground">Tool support is unverified for this model; it is assumed to work.</div>}
    </div>
  );
}

function ModelRow({ m, label, checked, onSelect, showRemote }: { m: ModelInfo | null; label?: string; checked: boolean; onSelect: () => void; showRemote?: boolean }) {
  return (
    <button type="button" role="radio" aria-checked={checked} className={cn('flex w-full flex-wrap items-center gap-1 px-2 py-1 text-left hover:bg-accent', checked && 'bg-accent')} onClick={onSelect} title={m?.description || m?.note}>
      <span className="w-3 shrink-0">{checked && <Check size={11} />}</span>
      <span className="font-mono">{m ? m.id : label}</span>
      {m?.resolvedModel && m.resolvedModel !== m.id && <span className="text-muted-foreground">→ {m.resolvedModel}</span>}
      {m?.displayName && m.displayName !== m.id && !m.resolvedModel && <span className="text-muted-foreground">{m.displayName}</span>}
      {m?.default && <span className={chip}>default</span>}
      {m && <CapabilityChips m={m} showRemote={showRemote} />}
    </button>
  );
}

function TestResult({ r }: { r: ProviderTestResult }) {
  return (
    <div className={cn('rounded border px-2 py-1', r.ok ? tone.successBorder : tone.dangerBorder)} role="status">
      <div className={cn('flex items-center gap-1', r.ok ? tone.successText : tone.dangerText)}>
        {r.ok ? <Check size={11} /> : <X size={11} />} {r.message}
      </div>
      {r.ok && (
        <div className="mt-0.5 text-muted-foreground">
          {r.latencyMs} ms · model {r.modelFound ? 'found' : 'not found'} · tools {r.tools}
          {r.contextWindow ? ` · context ${formatTokens(r.contextWindow)}` : ''} · {r.local ? 'local' : 'remote'}
        </div>
      )}
      {(r.warnings ?? []).map((w, i) => <div key={i} className={tone.warningText}>{w}</div>)}
    </div>
  );
}

/** AI settings (§10.3). Save is explicit and carries the revision; Test and Refresh never save. */
export function SettingsPanel() {
  const saved = useAIStore((s) => s.config);
  const loadConfig = useAIStore((s) => s.loadConfig);
  const remoteRevision = useAIStore((s) => s.remoteConfigRevision);
  const builtins = useAIStore((s) => s.builtinRedactions);
  const dispatch = useAIStore((s) => s.dispatch);
  const profiles = useConnectionStore((s) => s.profiles);
  const statuses = useConnectionStore((s) => s.connectionStatuses);

  // The draft lives in the store: leaving the settings (back to the chat,
  // another chat, another activity) keeps unsaved edits until Save or Discard.
  const stored = useAIStore((s) => s.settingsDraft);
  const setStored = useAIStore((s) => s.setSettingsDraft);
  const draft: AIConfig | null = stored?.draft ?? saved;
  const keyMode = stored?.keyMode ?? 'keep';
  const newKey = stored?.newKey ?? '';
  const update = useCallback((patch: Partial<{ draft: AIConfig; base: AIConfig; keyMode: 'keep' | 'replace' | 'clear'; newKey: string }>) => {
    const cur = useAIStore.getState().settingsDraft;
    const config = useAIStore.getState().config;
    const from = cur?.draft ?? config;
    if (!from) return;
    // The first edit records the config it starts from (merge base of Reload, P2).
    const base = patch.base ?? cur?.base ?? (cur ? undefined : config ? clone(config) : undefined);
    setStored({ draft: patch.draft ?? (cur ? cur.draft : clone(from)), base, keyMode: patch.keyMode ?? cur?.keyMode ?? 'keep', newKey: patch.newKey ?? cur?.newKey ?? '' });
  }, [setStored]);
  const setDraft = useCallback((v: AIConfig | null | ((d: AIConfig | null) => AIConfig | null)) => {
    const cur = useAIStore.getState().settingsDraft?.draft ?? useAIStore.getState().config;
    const next = typeof v === 'function' ? v(cur ? clone(cur) : null) : v;
    if (next) update({ draft: next });
  }, [update]);
  const setKeyMode = (m: 'keep' | 'replace' | 'clear') => update({ keyMode: m });
  const setNewKey = (k: string) => update({ newKey: k });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /**
   * Save and Discard disable themselves once nothing is unsaved, which
   * dropped the focus to <body> (S4): it moves to "Back to the chat", the
   * next step after saving.
   */
  const backRef = useRef<HTMLButtonElement>(null);
  const keepFocus = () => requestAnimationFrame(() => {
    const a = document.activeElement;
    if (!a || a === document.body || (a instanceof HTMLButtonElement && a.disabled)) backRef.current?.focus();
  });
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ProviderTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<ModelDiscovery | null>(null);
  const [discovering, setDiscovering] = useState(false);
  // Where Claude Code can run (Windows: the WSL distributions).
  const [ccHosts, setCCHosts] = useState<ClaudeCodeHosts | null>(null);
  const [ccHostsLoading, setCCHostsLoading] = useState(false);
  const [redactInput, setRedactInput] = useState('');
  const [notesOpen, setNotesOpen] = useState<string | null>(null);
  const [showBuiltins, setShowBuiltins] = useState(false);
  const discoverSeq = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const askNewChat = useAIStore((s) => s.askNewChat);
  const setAskNewChat = useAIStore((s) => s.setAskNewChat);
  // Opening the settings moves the focus into them (A-04).
  const loaded = !!draft && !!saved;
  useEffect(() => {
    if (loaded) rootRef.current?.querySelector<HTMLElement>('[data-settings-body] button, [data-settings-body] input, [data-settings-body] select')?.focus();
  }, [loaded]);

  useEffect(() => {
    if (!saved) void loadConfig();
  }, [saved, loadConfig]);

  const loadCCHosts = useCallback(async () => {
    setCCHostsLoading(true);
    try {
      setCCHosts(await api.GetClaudeCodeHosts());
    } catch {
      setCCHosts({ os: '' });
    } finally {
      setCCHostsLoading(false);
    }
  }, []);
  const ccEngine = draft?.engine === 'claudecode';
  useEffect(() => {
    if (ccEngine && !ccHosts) void loadCCHosts();
  }, [ccEngine, ccHosts, loadCCHosts]);

  const dirty = useMemo(() => {
    if (!saved || !draft) return false;
    return keyMode !== 'keep' || JSON.stringify(draft) !== JSON.stringify(saved);
  }, [saved, draft, keyMode]);

  // A draft without changes is dropped (the form then follows the saved
  // config); a dirty form shows the stale banner instead (a stale save is
  // rejected by Go anyway).
  useEffect(() => {
    if (saved && stored && !dirty) setStored(null);
  }, [saved, stored, dirty, setStored]);
  const stale = !!draft && !!saved && dirty && Math.max(remoteRevision, saved.revision) > draft.revision;

  /** The draft as the Go side receives it (unsaved key included, never persisted by Test/Discover). */
  const forCall = useCallback((d: AIConfig): AIConfig => {
    const c = clone(d);
    c.apiKey = keyMode === 'replace' ? newKey : '';
    c.clearApiKey = keyMode === 'clear';
    return c;
  }, [keyMode, newKey]);

  const runDiscovery = useCallback(async (refresh: boolean) => {
    if (!draft) return;
    if (draft.engine !== 'claudecode' && !draft.provider) {
      setDiscovery(null);
      return;
    }
    // OpenAI and Anthropic list models only with a key: do not call them
    // (and show their 401) before one is entered (A-32).
    const cfgSaved = useAIStore.getState().config;
    const sameEndpoint = !!cfgSaved && draft.provider === cfgSaved.provider && (draft.flavor || '') === (cfgSaved.flavor || '') && draft.url.replace(/\/+$/, '') === cfgSaved.url.replace(/\/+$/, '');
    const haveKey = keyMode === 'replace' ? newKey.length > 0 : keyMode === 'keep' && !!cfgSaved?.hasKey && sameEndpoint;
    if (discoveryNeedsKey(draft, haveKey)) {
      ++discoverSeq.current;
      setDiscovering(false);
      setDiscovery({ provider: providerKeyOf(draft), baseUrl: draft.url, models: [], fetchedAt: 0, fromCache: true, error: NEEDS_KEY });
      return;
    }
    const seq = ++discoverSeq.current;
    setDiscovering(true);
    try {
      const d = await api.DiscoverModels(forCall(draft), refresh);
      if (seq !== discoverSeq.current) return;
      setDiscovery(d);
      dispatch({ name: 'local/models', payload: { providerKey: d.provider || providerKeyOf(draft), discovery: d } });
      // The only installed (tool-capable) model is preselected (A-33).
      const only = !d.error && draft.engine !== 'claudecode' && !draft.model ? soleModel(d.models) : null;
      if (only) setDraft((cur) => (cur && !cur.model && cur.engine !== 'claudecode' ? { ...cur, model: only } : cur));
    } catch (err) {
      if (seq !== discoverSeq.current) return;
      setDiscovery({ provider: providerKeyOf(draft), baseUrl: draft.url, models: discovery?.models ?? [], fetchedAt: 0, fromCache: true, error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (seq === discoverSeq.current) setDiscovering(false);
    }
  }, [draft, forCall, dispatch, discovery?.models, keyMode, newKey, setDraft]);

  // Discover when the endpoint changes (debounced) and when the settings open.
  const endpointKey = draft ? JSON.stringify([draft.engine, draft.provider, draft.flavor, draft.url, keyMode, keyMode === 'replace' ? newKey.length > 0 : 0,
    draft.claudeCode.path, draft.claudeCode.runtime, draft.claudeCode.wslDistro, draft.claudeCode.wslPath, draft.tlsSkipVerify]) : '';
  useEffect(() => {
    if (!draft) return;
    const t = setTimeout(() => void runDiscovery(false), 500);
    return () => clearTimeout(t);
  }, [endpointKey]);
  // A test result belongs to the endpoint and the model it was made for
  // (A-32: "No model selected" stayed after picking one).
  const testedModel = draft ? (draft.engine === 'claudecode' ? draft.claudeCode.model : draft.model) ?? '' : '';
  useEffect(() => {
    setTest(null);
    setTestError(null);
  }, [endpointKey, testedModel]);

  if (!draft || !saved) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground"><Loader2 size={14} className="mr-1 animate-spin" /> Loading settings…</div>;
  }

  const set = (patch: Partial<AIConfig>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setCC = (patch: Partial<AIConfig['claudeCode']>) => setDraft((d) => (d ? { ...d, claudeCode: { ...d.claudeCode, ...patch } } : d));
  const cc = draft.engine === 'claudecode';
  const ccWindows = ccHosts?.os === 'windows';
  const ccRuntime = ccWindows ? draft.claudeCode.runtime ?? '' : '';
  const dest = classifyDestination(draft);
  const host = urlHost(draft.url);
  const loop = isLoopbackHost(host);
  const flavor = draft.flavor || 'custom';
  const canEndpointLocal = draft.provider === 'openai' && ['litellm', 'custom', 'vllm', 'lmstudio'].includes(flavor) && loop;
  const endpointChanged = draft.provider !== saved.provider || (draft.flavor || '') !== (saved.flavor || '') || draft.url.replace(/\/+$/, '') !== saved.url.replace(/\/+$/, '');
  const keyStored = saved.hasKey && keyMode === 'keep' && !endpointChanged;
  const selectedModel = (discovery?.models ?? []).find((m) => m.id === (cc ? draft.claudeCode.model : draft.model));

  const choosePreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) {
      set({ provider: '', flavor: '', url: '' });
      return;
    }
    const sameKind = presetIdOf(draft) === p.id;
    set({ provider: p.provider, flavor: p.flavor || undefined, url: sameKind ? draft.url : p.url || (p.id === 'openai/litellm' ? DEFAULT_URLS['openai/litellm'] : ''), effort: p.provider === 'anthropic' ? draft.effort : undefined });
  };

  const accessOf = (id: string): AccessEntry => draft.connectionAccess?.[id] ?? { level: draft.defaultAccess || 'ask' };
  const hasHost = (list: string[] | undefined, h: string) => (list ?? []).some((x) => x.toLowerCase() === h.toLowerCase());
  const putAccess = (id: string, e: AccessEntry) => set({
    connectionAccess: {
      ...(draft.connectionAccess ?? {}),
      [id]: { level: e.level, hosts: e.hosts?.length ? e.hosts : undefined, readHosts: e.readHosts?.length ? e.readHosts : undefined },
    },
  });
  const setAccess = (id: string, level: string) => {
    const prev = accessOf(id);
    let hosts = [...(prev.hosts ?? [])];
    let readHosts = [...(prev.readHosts ?? [])];
    if (level === 'none' || level === 'ask') {
      hosts = [];
      readHosts = [];
    } else if (!dest.local && LEVEL_RANK[level] > LEVEL_RANK[prev.level] && dest.host && !hasHost(hosts, dest.host)) {
      hosts.push(dest.host);
      readHosts = readHosts.filter((x) => x.toLowerCase() !== dest.host.toLowerCase());
    }
    putAccess(id, { level, hosts, readHosts });
  };
  /** Lets the current remote host use the row's level (also when the level is already set). */
  const allowHost = (id: string) => {
    const prev = accessOf(id);
    if (!dest.host) return;
    putAccess(id, { level: prev.level, hosts: [...(prev.hosts ?? []), dest.host], readHosts: (prev.readHosts ?? []).filter((x) => x.toLowerCase() !== dest.host.toLowerCase()) });
  };
  const removeHost = (id: string, h: string) => {
    const prev = accessOf(id);
    putAccess(id, { ...prev, hosts: (prev.hosts ?? []).filter((x) => x !== h), readHosts: (prev.readHosts ?? []).filter((x) => x !== h) });
  };

  const addRedaction = () => {
    const v = redactInput.trim();
    if (!v) return;
    if (!REDACT_RE.test(v)) {
      toast.error('Not a valid entry', 'Use an attribute name, a prefix ending in * or a numeric OID.');
      return;
    }
    const list = draft.redactAttributes ?? [];
    if (!list.some((x) => x.toLowerCase() === v.toLowerCase())) set({ redactAttributes: [...list, v] });
    setRedactInput('');
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const out = forCall(draft);
      if (profiles.length > 0) {
        const ids = new Set(profiles.map((p) => p.id));
        out.connectionAccess = Object.fromEntries(Object.entries(out.connectionAccess ?? {}).filter(([k]) => ids.has(k)));
        if (out.connectionNotes) out.connectionNotes = Object.fromEntries(Object.entries(out.connectionNotes).filter(([k, v]) => ids.has(k) && v.trim()));
      }
      out.hasKey = false;
      out.keyError = undefined;
      out.warnings = undefined;
      await api.SaveAIConfig(out);
      setStored(null);
      await loadConfig();
      toast.success('AI settings saved', { action: { label: 'Back to chat', run: () => useAIStore.getState().setView('chat') } });
      keepFocus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/changed elsewhere/i.test(msg)) void loadConfig();
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  };

  const reload = async () => {
    setStored(null);
    await loadConfig();
    setSaveError(null);
    keepFocus();
  };

  /** "Settings changed elsewhere": load them and keep the user's unsaved changes on top (A-35). */
  const reloadKeepingDraft = async () => {
    const cur = useAIStore.getState().settingsDraft;
    const savedNow = useAIStore.getState().config;
    const mine = cur?.draft ?? draft;
    const fresh = await loadConfig();
    setSaveError(null);
    if (!fresh || !savedNow || !mine) return;
    update(reloadSettingsDraft(mine, cur?.base, savedNow, fresh));
    toast.info('Settings reloaded; your unsaved changes were kept. Review them and save.');
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    setTestError(null);
    try {
      setTest(await api.TestProvider(forCall(draft)));
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const ctxDiscovered = selectedModel?.contextWindow ?? 0;
  const ctxSource = selectedModel?.contextSource ?? '';
  // What a run will use with "auto" (§4.2/§4.3): native Ollama runs with
  // min(16k, the model's maximum), grown in 8k steps up to 32k while the
  // offered tools leave less than 8k for the conversation (contextmgr
  // AutoWindow, test-1 D2); Ollama /v1 with the loaded or Modelfile num_ctx
  // (else 4096); other providers with the reported window.
  const ctxAuto = (() => {
    if (draft.provider === 'ollama') {
      if (!ctxDiscovered) return null;
      const eff = Math.min(16384, ctxDiscovered);
      const most = Math.min(32768, ctxDiscovered);
      const range = most > eff ? `${formatTokens(eff)}–${formatTokens(most)}, as much as the tools need` : formatTokens(eff);
      return `Auto: ${range}${most < ctxDiscovered ? ` (the model supports ${formatTokens(ctxDiscovered)}${ctxSource ? `, ${ctxSource}` : ''})` : ctxSource ? ` (${ctxSource})` : ''}.`;
    }
    if (draft.provider === 'openai' && draft.flavor === 'ollama') {
      const n = selectedModel?.loadedContext || selectedModel?.configuredCtx || 4096;
      return `Auto: ${formatTokens(n)} (${selectedModel?.loadedContext ? 'loaded model' : selectedModel?.configuredCtx ? 'Modelfile num_ctx' : 'Ollama /v1 default'}; the model supports ${ctxDiscovered ? formatTokens(ctxDiscovered) : 'an unknown size'}).`;
    }
    if (ctxSource === 'default' || !ctxDiscovered) return null;
    return `Auto: ${formatTokens(ctxDiscovered)}${ctxSource ? ` (${ctxSource})` : ''}.`;
  })();

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      {stale && (
        <div className={cn('flex items-center gap-1 border-b px-3 py-1 text-xs', tone.warningBorder, tone.warningBg)} role="alert">
          <AlertTriangle size={12} className={tone.warningText} />
          Settings changed elsewhere (e.g. you allowed access in a chat).
          <button type="button" className={textButton + ' ml-auto'} aria-label="Reload settings" title="Loads the saved settings and keeps your unsaved changes" onClick={() => void reloadKeepingDraft()}>Reload</button>
        </div>
      )}
      {saved.keyError && <div className={cn('border-b px-3 py-1 text-xs', tone.dangerBorder, tone.dangerBg)}>{saved.keyError}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto" data-settings-body>
        <Section title="Engine and provider" icon={<Plug size={11} />}>
          <SegmentedControl
            aria-label="Engine"
            options={ENGINES}
            value={cc ? 'claudecode' : 'builtin'}
            onValueChange={(v) => set({ engine: v })}
          />

          {cc ? (
            <>
              <p className="text-muted-foreground">
                LDAPilot runs the Claude Code CLI installed on this machine{ccWindows ? ' (in Windows or in WSL)' : ''} (with your Claude login) and gives it LDAPilot's directory tools. Approvals, access levels and redaction apply as with the built-in engine.
              </p>
              {ccWindows && (
                <div className="space-y-1">
                  <span className="text-muted-foreground" id="cc-runtime-label">Claude Code runs in</span>
                  <SegmentedControl aria-labelledby="cc-runtime-label" options={CC_RUNTIMES} value={ccRuntime} onValueChange={(v) => setCC({ runtime: v || undefined })} />
                  <span className="block text-muted-foreground">{ccRuntimeHint(ccRuntime)}</span>
                </div>
              )}
              {ccWindows && ccRuntime !== 'windows' && (
                <Field
                  label="WSL distribution"
                  hint={ccHosts?.wsl?.error ? <span className={ccRuntime === 'wsl' ? tone.warningText : undefined}>{ccHosts.wsl.error}</span> : undefined}
                >
                  <div className="flex items-center gap-1">
                    <Select
                      size="sm"
                      aria-label="WSL distribution"
                      className="min-w-0 flex-1"
                      value={draft.claudeCode.wslDistro ?? ''}
                      options={distroOptions(ccHosts?.wsl, draft.claudeCode.wslDistro ?? '')}
                      onChange={(e) => setCC({ wslDistro: e.target.value || undefined })}
                    />
                    <button type="button" className={textButton} aria-label="Refresh the list of WSL distributions" disabled={ccHostsLoading} onClick={() => void loadCCHosts()}>
                      {ccHostsLoading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                    </button>
                  </div>
                </Field>
              )}
              {ccRuntime === 'wsl' ? (
                <Field label="Claude Code path in WSL" hint="Leave empty to find it like a terminal in that distribution does (login shell PATH, ~/.local/bin, npm global, nvm).">
                  <Input size="sm" mono aria-label="Claude Code path in WSL" value={draft.claudeCode.wslPath ?? ''} placeholder="auto-detect, e.g. /home/you/.local/bin/claude" onChange={(e) => setCC({ wslPath: e.target.value.trim() || undefined })} />
                </Field>
              ) : (
                <Field label={ccWindows ? 'Claude Code CLI path (Windows)' : 'Claude Code CLI path'} hint="Leave empty to detect it automatically.">
                  <Input size="sm" mono aria-label="Claude Code CLI path" value={draft.claudeCode.path ?? ''} placeholder="auto-detect" onChange={(e) => setCC({ path: e.target.value.trim() || undefined })} />
                </Field>
              )}
              {discovery?.claudeCode && <p className="text-muted-foreground [overflow-wrap:anywhere]" data-cc-location>{locationText(discovery.claudeCode, ccHosts?.os ?? '')}</p>}
              <ModelSection draft={draft} discovery={discovery} loading={discovering} onRefresh={() => void runDiscovery(true)} value={draft.claudeCode.model ?? ''} onChange={(id) => setCC({ model: id || undefined })} />
              <Field label="Maximum cost per message (USD)" hint="Claude Code stops a response that would cost more (default 1.00).">
                <NumberInput ariaLabel="Maximum cost per message in USD" value={draft.claudeCode.maxBudgetUsd ?? 0} placeholder="1.00" min={0.01} max={100} step={0.05} onChange={(v) => setCC({ maxBudgetUsd: v || undefined })} />
              </Field>
              <Toggle
                checked={!!draft.claudeCode.allowResume}
                onChange={(v) => setCC({ allowResume: v || undefined })}
                label="Let Claude Code resume its own sessions"
                hint={draft.claudeCode.allowResume ? <span className={tone.warningText}>Claude Code will keep its own unencrypted copy of these chats in ~/.claude.</span> : 'Off: LDAPilot replays the conversation itself and Claude Code keeps no copy.'}
              />
              <Toggle
                checked={!!draft.claudeCode.useAnthropicEnv}
                onChange={(v) => setCC({ useAnthropicEnv: v || undefined })}
                label="Use my environment's Anthropic settings"
                hint={anthropicEnvHint(discovery?.claudeCode?.runtime === 'wsl' || ccRuntime === 'wsl')}
              />
              <p className="text-muted-foreground">Managed (enterprise) Claude Code settings still apply.</p>
            </>
          ) : (
            <>
              <Field label="Provider">
                <Select
                  size="sm"
                  aria-label="Provider preset"
                  value={presetIdOf(draft)}
                  options={[{ value: '', label: 'Not configured' }, ...PRESETS.map((p) => ({ value: p.id, label: p.label }))]}
                  onChange={(e) => choosePreset(e.target.value)}
                />
              </Field>
              {draft.provider && (
                <>
                  <Field
                    label="URL"
                    hint={
                      <span className="flex items-center gap-1">
                        {dest.local ? <HardDrive size={11} className={tone.successText} /> : <Globe size={11} className={tone.warningText} />}
                        {dest.local ? 'Local: data stays on this machine.' : `Remote: directory data is sent to ${dest.host || 'this host'}.`}
                      </span>
                    }
                  >
                    <Input
                      size="sm"
                      mono
                      aria-label="Provider URL"
                      value={draft.url}
                      placeholder={DEFAULT_URLS[providerKeyOf(draft)] || 'https://…'}
                      onChange={(e) => set({ url: e.target.value.trim() })}
                    />
                  </Field>
                  {/^[a-z]+:\/\/[^/]*@/i.test(draft.url) && <div className={tone.dangerText}>The URL must not contain a user name or password; enter the API key below.</div>}
                  {canEndpointLocal && (
                    <Toggle checked={!!draft.endpointLocal} onChange={(v) => set({ endpointLocal: v || undefined })} label="This endpoint runs on this machine and does not forward requests to other services" />
                  )}

                  <div className="space-y-0.5">
                    <span className="text-muted-foreground">API key</span>
                    {keyStored ? (
                      <div className="flex items-center gap-1">
                        <span className="font-mono">•••• stored</span>
                        <button type="button" className={textButton} aria-label="Replace the API key" onClick={() => setKeyMode('replace')}>Replace</button>
                        <button type="button" className={textButton} aria-label="Clear the API key" onClick={() => setKeyMode('clear')}>Clear</button>
                      </div>
                    ) : keyMode === 'clear' ? (
                      <div className="flex items-center gap-1">
                        <span className="text-muted-foreground">The stored key will be removed when you save.</span>
                        <button type="button" className={textButton} aria-label="Keep the API key" onClick={() => setKeyMode('keep')}>Undo</button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Input
                          type="password"
                          autoComplete="off"
                          size="sm"
                          mono
                          aria-label="API key"
                          value={newKey}
                          placeholder={draft.provider === 'ollama' || draft.flavor === 'ollama' ? 'not needed for a local Ollama' : 'sk-…'}
                          onChange={(e) => { setNewKey(e.target.value); setKeyMode(e.target.value ? 'replace' : 'keep'); }}
                        />
                        {saved.hasKey && !endpointChanged && keyMode === 'replace' && (
                          <button type="button" className={textButton} aria-label="Keep the stored key" onClick={() => { setNewKey(''); setKeyMode('keep'); }}>Keep stored</button>
                        )}
                      </div>
                    )}
                    {saved.hasKey && endpointChanged && keyMode === 'keep' && (
                      <div className="text-muted-foreground">The stored key is not sent to a changed provider or URL. Enter the key for the new endpoint.</div>
                    )}
                  </div>

                  {draft.provider === 'anthropic' && (
                    <>
                      <Field label="Auth header">
                        <Select
                          size="sm"
                          aria-label="Anthropic auth header"
                          value={draft.anthropicAuth || 'x-api-key'}
                          options={[{ value: 'x-api-key', label: 'x-api-key (default)' }, { value: 'bearer', label: 'Authorization: Bearer' }]}
                          onChange={(e) => set({ anthropicAuth: e.target.value === 'x-api-key' ? undefined : e.target.value })}
                        />
                      </Field>
                      <Toggle checked={!!draft.anthropicFallback} onChange={(v) => set({ anthropicFallback: v || undefined })} label="Retry refusals with the fallback model (experimental)" />
                    </>
                  )}
                  {/* TLS applies to https:// only (A-32); a switched-off check stays visible to turn it back on. */}
                  {(/^https:\/\//i.test(draft.url || DEFAULT_URLS[providerKeyOf(draft)] || '') || draft.tlsSkipVerify) && (
                    <Toggle
                      checked={!draft.tlsSkipVerify}
                      onChange={(v) => set({ tlsSkipVerify: !v || undefined })}
                      label="Verify TLS certificates"
                      hint={draft.tlsSkipVerify && (saved.hasKey || keyMode === 'replace') ? <span className={tone.warningText}>TLS certificate checks are off while an API key is sent.</span> : undefined}
                    />
                  )}
                  {draft.url.startsWith('http://') && !loop && (
                    <Toggle checked={!!draft.allowInsecureHttp} onChange={(v) => set({ allowInsecureHttp: v || undefined })} label="Allow sending the API key over unencrypted http://" />
                  )}
                  <ModelSection draft={draft} discovery={discovery} loading={discovering} onRefresh={() => void runDiscovery(true)} value={draft.model} onChange={(id) => set({ model: id })} />
                </>
              )}
            </>
          )}

          {(saved.warnings ?? []).map((w, i) => <div key={i} className={tone.warningText}>{w}</div>)}
          <div className="flex items-center gap-1">
            <button type="button" className={textButton} aria-label="Test the provider" disabled={testing || (!cc && !draft.provider)} onClick={() => void runTest()}>
              {testing ? <Loader2 size={11} className="animate-spin" /> : <Plug size={11} />} Test
            </button>
            <span className="text-muted-foreground">Test and Refresh never save.</span>
          </div>
          {test && <TestResult r={test} />}
          {testError && <div className={tone.dangerText}>{testError}</div>}
        </Section>

        {!cc && (
          <Section title="Limits" defaultOpen={false}>
            <Field
              label="Context window (tokens)"
              hint={
                ctxAuto === null && !draft.contextWindow
                  ? 'Auto: unknown — please enter the context size of the model.'
                  : `${ctxAuto ?? 'Auto: …'}${draft.provider === 'ollama' ? ' Changing it reloads the model in Ollama.' : ''}`
              }
            >
              <NumberInput ariaLabel="Context window" value={draft.contextWindow} placeholder="auto" min={2048} max={2000000} step={1024} onChange={(v) => set({ contextWindow: v })} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Max output tokens">
                <NumberInput ariaLabel="Max output tokens" value={draft.maxOutputTokens} placeholder="auto" min={256} max={262144} onChange={(v) => set({ maxOutputTokens: v })} />
              </Field>
              <Field label="Max steps per answer">
                <NumberInput ariaLabel="Max steps" value={draft.maxSteps} placeholder="12" min={2} max={50} onChange={(v) => set({ maxSteps: v })} />
              </Field>
              <Field label="Thinking">
                <Select
                  size="sm"
                  aria-label="Thinking"
                  value={draft.thinking}
                  options={THINKING}
                  onChange={(e) => set({ thinking: e.target.value })}
                />
              </Field>
              <Field label="Effort (Anthropic)">
                <Select
                  size="sm"
                  aria-label="Effort"
                  value={draft.effort ?? ''}
                  disabled={draft.provider !== 'anthropic'}
                  title={draft.provider !== 'anthropic' ? 'Only the Anthropic provider supports effort' : undefined}
                  options={[
                    { value: '', label: 'Default' },
                    ...['low', 'medium', 'high', 'xhigh', 'max'].map((v) => ({ value: v, label: v, disabled: !!selectedModel?.effortLevels?.length && !selectedModel.effortLevels.includes(v) })),
                  ]}
                  onChange={(e) => set({ effort: e.target.value || undefined })}
                />
              </Field>
              <Field label="Request timeout (s)">
                <NumberInput ariaLabel="Request timeout in seconds" value={draft.requestTimeoutSec} placeholder="120" min={10} max={3600} onChange={(v) => set({ requestTimeoutSec: v })} />
              </Field>
              {(draft.provider === 'ollama' || draft.flavor === 'ollama') && (
                <Field label="Ollama keep-alive">
                  <Input size="sm" aria-label="Ollama keep-alive" value={draft.ollamaKeepAlive ?? ''} placeholder="30m" onChange={(e) => set({ ollamaKeepAlive: e.target.value.trim() || undefined })} />
                </Field>
              )}
            </div>
            <Toggle checked={!draft.hideThinking} onChange={(v) => set({ hideThinking: !v })} label="Show the model's reasoning (collapsed)" />
          </Section>
        )}
        {cc && (
          <Section title="Display" defaultOpen={false}>
            <Toggle checked={!draft.hideThinking} onChange={(v) => set({ hideThinking: !v })} label="Show the model's reasoning (collapsed)" />
          </Section>
        )}

        <Section title="Directory access" icon={<Lock size={11} />}>
          <Toggle
            checked={draft.allowWrites}
            onChange={(v) => set({ allowWrites: v })}
            label={<b>Allow the assistant to propose changes (each change needs your approval)</b>}
            hint={draft.allowWrites ? <span className={tone.warningText}>The assistant can propose changes on connections set to Write. Nothing is changed until you approve the exact diff; read-only profiles are never changed.</span> : 'Off: the assistant can only read.'}
          />
          <ul className="divide-y divide-border rounded border border-border" aria-label="AI access per connection">
            {profiles.map((p) => {
              const a = accessOf(p.id);
              const note = draft.connectionNotes?.[p.id] ?? '';
              return (
                <li key={p.id} className="space-y-1 px-2 py-1.5">
                  <div className="flex items-center gap-1">
                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statuses[p.id] ? tone.successDot : 'bg-border')} aria-label={statuses[p.id] ? 'connected' : 'not connected'} />
                    <span className="truncate font-medium" title={p.name}>{p.name}</span>
                    {p.readOnly && <span className={chip} title="Read-only profile: never changed">read-only</span>}
                    {/* host:port, plus the base DN when another profile uses the same server (A-34) */}
                    <span className="ml-auto min-w-0 truncate text-muted-foreground" title={`${p.host}:${p.port}${p.baseDN ? ` · ${p.baseDN}` : ''}`}>
                      {p.host}:{p.port}{p.baseDN && profiles.some((o) => o.id !== p.id && o.host === p.host && o.port === p.port) ? ` · ${p.baseDN}` : ''}
                    </span>
                  </div>
                  <div className="flex items-start gap-1.5">
                    <Select size="sm" className="w-24 shrink-0" aria-label={`AI access for ${p.name}`} value={a.level} onChange={(e) => setAccess(p.id, e.target.value)}>
                      {LEVELS.map((l) => (
                        <option
                          key={l.value}
                          value={l.value}
                          disabled={l.value === 'write' && (p.readOnly || !draft.allowWrites)}
                          title={l.value === 'write' && p.readOnly ? 'The profile is read-only' : l.value === 'write' && !draft.allowWrites ? 'Turn on "Allow the assistant to propose changes" first' : undefined}
                        >
                          {/* the reason is visible in the list, not only in a tooltip (A-34) */}
                          {l.value === 'write' && p.readOnly ? `${l.label} (read-only profile)` : l.value === 'write' && !draft.allowWrites ? `${l.label} (changes are off)` : l.label}
                        </option>
                      ))}
                    </Select>
                    <div className="min-w-0 flex-1 pt-0.5">
                      {a.level === 'read' || a.level === 'write' ? (
                        <div className="flex flex-wrap items-center gap-0.5">
                          <span className="text-muted-foreground">allowed for</span>
                          <span className={chip}>local models</span>
                          {(a.hosts ?? []).map((h) => (
                            <span key={h} className={chip}>
                              {h}
                              <button type="button" className="hover:text-foreground" aria-label={`Remove ${h}`} onClick={() => removeHost(p.id, h)}><X size={9} /></button>
                            </span>
                          ))}
                          {(a.readHosts ?? []).map((h) => (
                            <span key={'r:' + h} className={chip} title="Allowed from an access card: this host may read, not propose changes">
                              {h} (read only)
                              <button type="button" className="hover:text-foreground" aria-label={`Remove ${h}`} onClick={() => removeHost(p.id, h)}><X size={9} /></button>
                            </span>
                          ))}
                          {!dest.local && dest.host && !hasHost(a.hosts, dest.host) && (
                            <span className={cn('flex flex-wrap items-center gap-0.5', tone.warningText)}>
                              <AlertTriangle size={10} />
                              {hasHost(a.readHosts, dest.host) ? `read only for ${dest.host}` : `not for ${dest.host} (asks in each chat)`}
                              <button type="button" className={textButton} aria-label={`Allow ${dest.host} for ${p.name}`} onClick={() => allowHost(p.id)}>
                                Allow {dest.host}
                              </button>
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">{a.level === 'ask' ? 'asks once per chat' : 'nothing is shared'}</span>
                      )}
                    </div>
                    <button type="button" className="shrink-0 pt-0.5 text-muted-foreground underline-offset-2 hover:underline" aria-label={`Notes for ${p.name}`} aria-expanded={notesOpen === p.id} onClick={() => setNotesOpen(notesOpen === p.id ? null : p.id)}>
                      {note ? 'notes ✓' : 'notes'}
                    </button>
                  </div>
                  {notesOpen === p.id && (
                    <div>
                      <Textarea
                        mono
                        rows={3}
                        className="text-xs"
                        aria-label={`Notes for ${p.name}`}
                        maxLength={2000}
                        placeholder="Conventions the assistant should know for this directory: OUs, naming rules, where users and groups live…"
                        value={note}
                        onChange={(e) => set({ connectionNotes: { ...(draft.connectionNotes ?? {}), [p.id]: e.target.value } })}
                      />
                      {scanPasswords(note).matches.some((m) => m.sure) && (
                        <div className={tone.warningText} role="status">
                          The notes contain a password. LDAPilot removes it before the notes are sent; the assistant never needs one (it asks for a
                          reset, and LDAPilot generates the password).
                        </div>
                      )}
                      <div className="text-muted-foreground">
                        Sent with every message once the assistant may access this directory; they apply to reading and to changes. To limit only changes, say so (“Only change objects below OU=Sandbox”). {note.length}/2000
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
            {profiles.length === 0 && <li className="px-2 py-1 text-muted-foreground">No connection profiles yet.</li>}
          </ul>
          {!dest.local && dest.host && (cc || draft.provider) && (
            <div className="text-muted-foreground">
              With a remote provider ({dest.host}), Read and Write apply only to the hosts listed for a connection; "Allow {dest.host}" adds it.
              New connections at the default level ask in each chat.
            </div>
          )}
          <Field label="Default for new connections">
            <Select
              size="sm"
              aria-label="Default access for new connections"
              value={draft.defaultAccess || 'ask'}
              options={[{ value: 'ask', label: 'Ask' }, { value: 'none', label: 'None' }, { value: 'read', label: 'Read' }]}
              onChange={(e) => set({ defaultAccess: e.target.value === 'ask' ? '' : e.target.value })}
            />
          </Field>
        </Section>

        <Section title="Privacy" defaultOpen={false}>
          <div>
            <div className="text-muted-foreground">Attributes never sent to the assistant</div>
            <div className="mt-0.5 flex flex-wrap gap-0.5">
              {(draft.redactAttributes ?? []).map((a) => (
                <span key={a} className={chip}>
                  <span className="font-mono">{a}</span>
                  <button type="button" className="hover:text-foreground" aria-label={`Remove ${a}`} onClick={() => set({ redactAttributes: (draft.redactAttributes ?? []).filter((x) => x !== a) })}><X size={9} /></button>
                </span>
              ))}
            </div>
            <div className="mt-1 flex gap-1">
              <Input
                size="sm"
                mono
                aria-label="Add an attribute to redact"
                value={redactInput}
                placeholder="attribute, prefix* or OID"
                onChange={(e) => setRedactInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRedaction(); } }}
              />
              <button type="button" className={textButton} aria-label="Add attribute" onClick={addRedaction}>Add</button>
            </div>
            <button type="button" className="mt-1 flex items-center gap-0.5 text-muted-foreground hover:text-foreground" aria-expanded={showBuiltins} onClick={() => setShowBuiltins(!showBuiltins)}>
              {showBuiltins ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Built-in ({builtins.length}, always hidden)
            </button>
            {showBuiltins && (
              <div className="mt-0.5 flex flex-wrap gap-0.5">
                {builtins.map((b) => <span key={b} className={cn(chip, 'font-mono')}>{b}</span>)}
                <span className="text-muted-foreground">plus every attribute whose name contains password, secret or privatekey, or ends in pwd, rootpw or credentials, and msLAPS-*.</span>
              </div>
            )}
          </div>
          <Field label="Hide password-like text in attributes such as description">
            <Select
              size="sm"
              aria-label="Hide password-like text"
              value={draft.maskPasswordValues || 'remote'}
              options={[{ value: 'remote', label: 'Remote providers only (default)' }, { value: 'always', label: 'Always' }, { value: 'never', label: 'Never' }]}
              onChange={(e) => set({ maskPasswordValues: e.target.value === 'remote' ? '' : e.target.value })}
            />
          </Field>
          <p className="text-muted-foreground">Binary values (photos, certificates, SIDs) are summarized, never sent.</p>
        </Section>

        <Section title="Chats" defaultOpen={false}>
          <Toggle checked={!draft.disableTitleGeneration} onChange={(v) => set({ disableTitleGeneration: !v })} label="Let the model write chat titles" hint="Off: the title is taken from your first message." />
          <Toggle
            checked={askNewChat}
            onChange={setAskNewChat}
            label="“Ask AI about …” starts a new chat"
            hint="Applies right away on this computer. Off: the entries are added to the open chat."
          />
          <p className="text-muted-foreground">Chats are stored encrypted in your LDAPilot configuration folder with the same key as your connection passwords.</p>
        </Section>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5 text-xs">
        {saveError && <span className={cn('min-w-0 flex-1 truncate', tone.dangerText)} title={saveError}>{saveError}</span>}
        {!saveError && <span className="flex-1 text-muted-foreground">{dirty ? 'Unsaved changes' : 'Saved'}</span>}
        <button type="button" className={textButton} aria-label="Discard changes" disabled={!dirty || saving} onClick={() => void reload()}>Discard</button>
        <button type="button" className={primaryButton} aria-label="Save settings" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />} Save
        </button>
        <button type="button"
          ref={backRef}
          className={iconButton}
          aria-label="Back to the chat"
          title={dirty ? 'Back to the chat (unsaved changes are kept until you save or discard them)' : 'Back to the chat'}
          onClick={() => useAIStore.getState().setView('chat')}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
