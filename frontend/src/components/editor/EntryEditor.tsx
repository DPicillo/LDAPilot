/**
 * Entry editor (SPEC 10.2): editable DnBreadcrumb (Ctrl+L / F4, Alt+Up goes
 * up one level; crumbs start at the entry's tree root) with the entry Toolbar,
 * EntrySummaryHeader (type, status chips from the server account status that
 * open the Account tab, primary account action from the command registry),
 * and sub Tabs: Attributes, Contents (containers), Membership (always for
 * accounts and groups, so the first member can be added), Account (account
 * track) and LDIF (highlighted; its "Edit as LDIF…" and the toolbar's open
 * EditAsLdifDialog).
 *
 * The tab's own connection decides (ED-06, ED-16): a tab of another
 * connection than the active one says so with a one-click "Switch to"; a tab
 * whose connection is closed or lost shows its values read-only with
 * "Reconnect". Deleted / missing / failed entries show their state instead
 * of values (ED-04). Writes never mark the tab dirty (ED-02): the dot is
 * unsaved input only (stores/unsavedEdits).
 */
import { useState, useMemo, useEffect, useCallback, useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTabView } from '../../stores/tabViewState'
import { focusActiveEditorSoon, focusWorkAreaSoon, peekEditorFocus, requestEditorFocus, takeEditorFocus } from './editorFocus'
import {
  RefreshCw, ArrowLeft, ArrowRight, Lock, LockOpen, Copy, Check, Star, List, Users, FileText, Crosshair, ClipboardCopy, UserCog,
  FolderOpen, Trash2, CircleSlash, TriangleAlert, CloudOff, Server, ArchiveRestore, FolderUp, X, FileCode2,
} from 'lucide-react'
import { useEditorStore } from '../../stores/editorStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useBookmarkStore } from '../../stores/bookmarkStore'
import { useTreeStore, selectChildNodes, selectNodeLoading } from '../../stores/treeStore'
import { useSearchStore } from '../../stores/searchStore'
import { useRecycleStore } from '../../stores/recycleStore'
import { AttributeTable } from './AttributeTable'
import { MembershipPanel } from './MembershipPanel'
import { AccountPanel } from './AccountPanel'
import { useAccountStatus } from './useAccountStatus'
import { useAdUserPasswordPrompt } from './EditEntryDialog'
import { openEditAsLDIF } from './editorCommands'
import { looksLikeAccount } from '../../lib/accountActions'
import { LDAPEntry, SchemaInfo, type ServerType } from '../../types/ldap'
import type { EntryTabState } from '../../types/ui'
import { cn } from '../../lib/utils'
import { formatEntryAsLDIF } from '../../lib/ldif'
import { hasMembershipInfo, rawMembershipCounts } from '../../lib/membership'
import { imageDataUrl } from '../../lib/binary'
import { classAttributes, valueSearchFilter } from '../../lib/attributeGroups'
import { owningTreeRoot } from '../../lib/treesearch'
import { firstRDN, normalizeDN, parseRDN } from '../../lib/dn'
import { isNamingContextHead } from '../commands/namingContexts'
import { sameDN } from '../../lib/entryEvents'
import { serverStatusChips } from '../../lib/accountChips'
import * as wails from '../../lib/wails'
import { AttributesPresent } from '../../lib/wails-binary'
import { ModifyEntryWithOptions } from '../../lib/wails-pwpolicy'
import { OID_UNICODE_PWD, isPasswordWriteAttribute, isUserPasswordAttribute } from '../../lib/passwordPolicy'
import { notifyPasswordWrite, usePasswordWriteGuard } from '../password/PasswordWriteGuard'
import { toast } from '../ui/Toast'
import { setEntryIntent, useEntryIntentStore } from '../../stores/entryIntentStore'
import { accountStatusKinds, rememberAccountStatus } from '../../stores/accountStatusCache'
import { ContainerListView } from '../browser/ContainerListView'
import { openSchemaTab } from '../schema/SchemaDetailView'
import { Tabs, TabPanel, type TabItem } from '../ui/Tabs'
import { Toolbar, type ToolbarItem } from '../ui/Toolbar'
import { DnBreadcrumb } from '../ui/DnBreadcrumb'
import { EntrySummaryHeader } from '../ui/EntrySummaryHeader'
import { editorHeaderPrimary } from '../ui/primaryAction'
import { Button, IconButton } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { Spinner } from '../ui/Spinner'
import { EmptyState } from '../ui/EmptyState'
import { focusScopeTarget } from '../ui/layer'
import { DisclosureButton } from '../ui/Disclosure'
import { Banner, InlineAlert } from '../ui/InlineAlert'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Tooltip } from '../ui/Tooltip'
import { ensureServerType, getCommandContext, runCommand, useCommandRegistryVersion } from '../ui/commands'
import { formatDateTime, formatRelative } from '../ui/accountStatus'
import { parentDn, rdnValue } from '../ui/dn'
import { resolveObjectKind } from '../ui/objectKind'
import { isEditableTarget, matchShortcut } from '../ui/shortcuts'
import { useConnectionHealth } from '../layout/useConnectionWatch'
import { connectProfile, showActivity } from '../layout/shellState'

interface EntryEditorProps {
  tabId: string;
}

type SubTab = 'attributes' | 'contents' | 'members' | 'account' | 'ldif';

const SUB_TABS_ID = 'entry-sub';


function attrValues(entry: LDAPEntry | undefined, name: string): string[] {
  return entry?.attributes?.find(a => a.name.toLowerCase() === name.toLowerCase())?.values ?? [];
}

/** Groups that are a member of this group and contain it too (A ∈ B ∈ A), visible without opening Membership (WF-3c). */
function directCycle(entry: LDAPEntry | undefined): { dn: string; name: string }[] | undefined {
  const memberOf = new Set(attrValues(entry, 'memberOf').map((d) => normalizeDN(d)));
  if (!memberOf.size) return undefined;
  const out = [...attrValues(entry, 'member'), ...attrValues(entry, 'uniqueMember')]
    .filter((d) => memberOf.has(normalizeDN(d)))
    .map((dn) => ({ dn, name: parseRDN(firstRDN(dn)).value || dn }));
  return out.length ? out : undefined;
}

/** Entries whose children are worth listing: OU/container/domain kinds, or any entry the server says has children. */
function isContainerEntry(entry: LDAPEntry | undefined, objectClasses: string[] | undefined): boolean {
  const kind = resolveObjectKind(objectClasses);
  if (kind === 'ou' || kind === 'container' || kind === 'domain') return true;
  if (attrValues(entry, 'hasSubordinates')[0]?.toUpperCase() === 'TRUE') return true;
  const n = Number(attrValues(entry, 'numSubordinates')[0] ?? attrValues(entry, 'msDS-Approx-Immed-Subordinates')[0] ?? 0);
  return Number.isFinite(n) && n > 0;
}

const TLS_TEXT = { none: 'unencrypted LDAP', ssl: 'LDAPS (TLS)', starttls: 'StartTLS' } as const;

export function EntryEditor({ tabId }: EntryEditorProps) {
  const tab = useEditorStore((s) => s.tabs.find(t => t.id === tabId));
  const entry = useEditorStore((s) => s.entries[tabId]);
  const isLoading = useEditorStore((s) => s.loadingEntries[tabId]);
  const refreshEntry = useEditorStore((s) => s.refreshEntry);
  const goBack = useEditorStore((s) => s.goBack);
  const goForward = useEditorStore((s) => s.goForward);
  const canBack = useEditorStore((s) => s.canGoBack());
  const canForward = useEditorStore((s) => s.canGoForward());
  const closeTab = useEditorStore((s) => s.closeTab);
  // Tabs of more than one connection are open: say which one this is (ED-06).
  const multiConnection = useEditorStore((s) => new Set(s.tabs.filter((t) => t.dn && t.profileId).map((t) => t.profileId)).size > 1);
  const profiles = useConnectionStore((s) => s.profiles);
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const connected = useConnectionStore((s) => (tab ? s.connectionStatuses[tab.profileId] === true : false));
  const lost = useConnectionHealth((h) => !!tab && h.status === 'lost' && h.profileId === tab.profileId);
  const profile = tab ? profiles.find(p => p.id === tab.profileId) : undefined;
  const isReadOnly = profile?.readOnly ?? false;
  const offline = !connected || lost;
  // The header's Reconnect (RW2-C-02) goes away when the connection is back; focus fell to
  // <body> with it: the work area (crumb) takes it, like after the banner's Reconnect.
  const headerReconnect = useRef(false);
  useEffect(() => {
    if (offline || !headerReconnect.current) return;
    headerReconnect.current = false;
    focusWorkAreaSoon();
  }, [offline]);
  const foreign = !!tab && tab.profileId !== activeProfileId;
  const roots = useTreeStore((s) => (tab ? s.rootNodes[tab.profileId] : undefined));

  const openEntry = useEditorStore((s) => s.openEntry);
  const bookmarked = useBookmarkStore((s) => (tab ? s.isBookmarked(tab.profileId, tab.dn) : false));
  const locateInTree = useTreeStore((s) => s.locateInTree);
  useCommandRegistryVersion();

  // null = the default sub-tab of the entry (Contents for containers, else Attributes)
  // Kept per tab (stores/tabViewState): a tab switch remounts the editor (M-18).
  const [subTab, setSubTab] = useTabView<SubTab | null>(tabId, 'subTab', null);
  const [schema, setSchema] = useState<SchemaInfo | undefined>();
  const [serverType, setServerType] = useState<ServerType | null>(null);
  const [crumbEditing, setCrumbEditing] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ name: string; cleared: boolean; resolve: (ok: boolean) => void } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Schema (tooltips, sections, single-value check, the attribute picker) and the server type.
  useEffect(() => {
    if (!tab) return;
    let cancelled = false;
    wails.GetSchema(tab.profileId).then(s => {
      if (!cancelled && s?.attributes) setSchema(s);
    }).catch(() => { /* Schema may not be available */ });
    void ensureServerType(tab.profileId).then((type) => { if (!cancelled) setServerType(type); });
    return () => { cancelled = true; };
  }, [tab?.profileId, connected]);

  // A navigation that remounted the editor hands focus back (ED-15).
  useEffect(() => {
    // 'list' belongs to the Contents list (it may mount after the entry loaded): left for it;
    // without a kept row it expires and focus stays on the clicked tab.
    if (peekEditorFocus() === 'list') return;
    const want = takeEditorFocus();
    if (!want) return;
    requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) return;
      const a = document.activeElement;
      if (a && a !== document.body && root.contains(a)) return;
      const target =
        want === 'crumb'
          ? root.querySelector<HTMLElement>('nav[aria-label="Breadcrumb"] [aria-current="page"]')
          : root.querySelector<HTMLElement>(`button[aria-label="${want === 'back' ? 'Go Back' : 'Go Forward'}"]:not([disabled])`);
      (target ?? root.querySelector<HTMLElement>('nav[aria-label="Breadcrumb"] [aria-current="page"]'))?.focus({ preventScroll: true });
    });
  }, [tabId]);

  // The entry went missing / deleted under the user (F5 into "No such object"): the attribute
  // grid that had focus is gone, the current crumb takes it instead of <body> (RW2-E-04 b).
  useEffect(() => {
    if (tab?.state) focusActiveEditorSoon();
  }, [tab?.state?.kind]);

  // Account status (user / computer / person entries): Account sub-tab and header chips.
  const objectClasses = useMemo(
    () => entry?.attributes?.find(a => a.name.toLowerCase() === 'objectclass')?.values,
    [entry],
  );
  // The loaded entry's attributes decide user vs contact (an LDAP person without uid or a
  // password is a contact: no Account tab, no account verbs, "Contact" chip; M-06).
  const kind = resolveObjectKind(objectClasses, entry ? entry.attributes.map((a) => a.name) : undefined);
  const showAccountTab = !!entry && looksLikeAccount(objectClasses) && kind !== 'contact';
  const account = useAccountStatus(tab?.profileId, tab?.dn, entry && kind !== 'contact' ? objectClasses : undefined, entry);
  // The command registry (Entry menu, palette) reads the authoritative status from here.
  useEffect(() => {
    if (tab && account.status) rememberAccountStatus(tab.profileId, account.status);
  }, [tab?.profileId, account.status]);

  // The attributes the entry's classes allow (MUST/MAY), offered first when adding one (ED-13).
  const allowedAttributes = useMemo(() => {
    if (!schema?.objectClasses || !objectClasses) return undefined;
    const { must, may } = classAttributes(objectClasses, schema.objectClasses);
    return [...must.values(), ...may.values()].filter((n) => n.toLowerCase() !== 'objectclass');
  }, [schema, objectClasses]);

  // The tree root (naming context) the entry belongs to: the first breadcrumb (ED-15).
  // Only roots and the naming-context heads injected below them (child domains),
  // not every preloaded first-level child (RW1-N-01: CN=Users hid the domain).
  const rootDn = useMemo(() => {
    if (!tab || !roots?.length) return undefined;
    const profileId = tab.profileId;
    return owningTreeRoot(roots, tab.dn, (dn) => isNamingContextHead(profileId, dn))?.dn;
  }, [roots, tab?.dn, tab?.profileId]);

  const showMembers = !!entry && (hasMembershipInfo(entry) || kind === 'user' || kind === 'group' || kind === 'computer' || kind === 'contact' || kind === 'service');
  // Contents lists the tree store's children, which holds the active connection only:
  // for a tab of another connection it stays visible but disabled (ED-06).
  const isContainer = !!entry && isContainerEntry(entry, objectClasses);
  const contentsUsable = isContainer && !foreign;
  const defaultSubTab: SubTab = contentsUsable ? 'contents' : 'attributes';
  const visible = (t: SubTab) =>
    t === 'attributes' || t === 'ldif' || (t === 'contents' && contentsUsable) || (t === 'members' && showMembers) || (t === 'account' && showAccountTab);
  const activeSubTab: SubTab = subTab && visible(subTab) ? subTab : defaultSubTab;

  // A command asked for a sub-tab ("Show Effective Members", "Add to Group…").
  // The Membership sub-tab consumes its part (view, mode, picker) itself.
  const intent = useEntryIntentStore((s) => s.intents[tabId]);
  useEffect(() => {
    if (!intent) return;
    if (intent.subTab === 'members' && entry && !showMembers) {
      useEntryIntentStore.getState().consume(tabId, intent.seq);
      toast.info('This entry has no group membership information');
      return;
    }
    setSubTab(intent.subTab);
    if (intent.subTab !== 'members') useEntryIntentStore.getState().consume(tabId, intent.seq);
  }, [intent?.seq, tabId, !!entry]);
  // userPassword / unicodePwd edits: password storage policy (ask, unencrypted confirmation)
  const passwordGuard = usePasswordWriteGuard();
  // userPassword on AD: offer Reset Password instead (ED-10)
  const adPasswordPrompt = useAdUserPasswordPrompt();

  const chips = useMemo(() => serverStatusChips(account.status), [account.status]);
  // The header (primary button, More actions) acts on the tab's own connection, like its
  // Account tab: a tab of another connection keeps Reset Password… (ED-06, RW2-P-02).
  // `offline` (lost or disconnected) hides the write verbs as in the menus; it is a
  // dependency, so a loss after the load re-resolves the header (RW2-C-02).
  const commandCtx = useMemo(() => {
    if (!tab) return undefined;
    return getCommandContext('tab', {
      profileId: tab.profileId,
      connected,
      readOnly: isReadOnly,
      offline,
      serverType,
      selection: [{
        dn: tab.dn,
        profileId: tab.profileId,
        objectClass: objectClasses,
        status: account.status ? accountStatusKinds(account.status) : undefined,
        label: tab.label,
      }],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.dn, tab?.profileId, tab?.label, objectClasses, account.status, activeProfileId, connected, offline, isReadOnly, serverType]);

  const navigateTo = useCallback((dn: string, reveal = false) => {
    if (!tab) return;
    if (!sameDN(dn, tab.dn)) requestEditorFocus('crumb');
    openEntry(tab.profileId, dn);
    // A crumb opens the entry (containers on Contents) and selects it in the tree; the
    // keyboard stays in the editor (RW1-E-04: F4 / Ctrl+L kept working only there).
    if (reveal && tab.profileId === useConnectionStore.getState().activeProfileId) {
      void locateInTree(tab.profileId, dn, { focus: false });
    }
  }, [tab?.profileId, tab?.dn, openEntry, locateInTree]);

  if (!tab) return null;
  const t = tab;

  /** Command context for this tab's entry on its own connection (Bookmark, Reset Password). */
  function tabContext() {
    return getCommandContext('tab', {
      profileId: t.profileId,
      connected,
      readOnly: isReadOnly,
      serverType,
      selection: [{ dn: t.dn, profileId: t.profileId, objectClass: objectClasses, label: t.label }],
    });
  }

  /** Switches to the tab's connection (connects it when needed). */
  async function switchToTabConnection(): Promise<boolean> {
    if (useConnectionStore.getState().activeProfileId === t.profileId && connected) return true;
    await connectProfile(t.profileId, { reveal: false });
    return useConnectionStore.getState().activeProfileId === t.profileId;
  }

  /**
   * The foreign banner's "Switch to …": the keyboard stays in the editor (its current
   * crumb, as after the palette) and the tab's entry is selected in the tree without
   * moving focus there (RW3-N-03: one tab ended on the tree root row, another on the
   * crumb). The crumb takes focus before the switch, so no tree row that mounts with a
   * pending focus can take it from <body>.
   */
  async function switchFromBanner() {
    rootRef.current?.querySelector<HTMLElement>('nav[aria-label="Breadcrumb"] [aria-current="page"]')?.focus({ preventScroll: true });
    if (!(await switchToTabConnection())) return;
    focusActiveEditorSoon();
    void locateInTree(t.profileId, t.dn, { focus: false, quiet: true });
  }

  /** Reconnect from the header's primary (RW2-C-02): once the connection is back, the effect below hands focus on. */
  function reconnectFromHeader(button: HTMLElement) {
    headerReconnect.current = true;
    reconnectFrom(button);
  }

  /** Reconnect from a banner / empty state: focus comes back to the button or the crumb (RW2-C-03). */
  function reconnectFrom(button: HTMLElement) {
    void reconnect().finally(() => focusWorkAreaSoon(button));
  }

  async function reconnect() {
    const cs = useConnectionStore.getState();
    if (cs.connectionStatuses[t.profileId] === true) {
      try {
        await cs.reconnect(t.profileId);
      } catch {
        /* the store toasts */
      }
    } else {
      await connectProfile(t.profileId, { reveal: false });
    }
  }

  function toggleBookmark() {
    // One path for every surface (toast and Undo come with the command).
    runCommand('entry.bookmark', tabContext());
  }

  function copyDN() {
    navigator.clipboard.writeText(t.dn).then(() => toast.success('DN copied', { connection: profile?.name }), () => toast.error('Could not copy DN'));
  }

  async function handleShowInTree(dn = t.dn) {
    if (foreign && !(await switchToTabConnection())) return;
    showActivity('explorer');
    await locateInTree(t.profileId, dn);
  }

  function copyAsLDIF() {
    if (!entry) return;
    // Same output as the LDIF tab: binary values are already base64, text
    // values are UTF-8 safe base64 encoded where LDIF requires it.
    navigator.clipboard.writeText(formatEntryAsLDIF(t.dn, entry)).then(
      () => toast.success('LDIF copied'),
      () => toast.error('Could not copy LDIF'),
    );
  }

  /** Toolbar Refresh: the entry, and for a container its list with the expanded sub-containers (as F5). */
  function refreshTab() {
    if (isContainer) void useTreeStore.getState().refreshSubtree(t.profileId, t.dn).catch(() => {});
    void refreshEntry(t.profileId, t.dn);
  }

  /** Reloads the entry without the loading spinner (keeps sub-tabs mounted); the new entry object reloads the account status. */
  function reloadQuietly() {
    return refreshEntry(t.profileId, t.dn, { silent: true });
  }

  /**
   * Writes a password attribute with the connection's password storage
   * policy; returns false when the user cancelled or the write failed.
   * A password attribute that already has a value is replaced (an added
   * second userPassword would leave the old password valid, ED-09).
   */
  async function writePassword(operation: 'replace' | 'add', attrName: string, values: string[]): Promise<boolean> {
    if (isUserPasswordAttribute(attrName) && serverType === 'ad') {
      const answer = await adPasswordPrompt.ask();
      if (answer === 'cancel') return false;
      if (answer === 'reset') {
        if (foreign && !(await switchToTabConnection())) return false;
        runCommand('account.resetPassword', getCommandContext('tab', { selection: [{ dn: t.dn, profileId: t.profileId, objectClass: objectClasses, label: t.label }] }));
        return true;
      }
    }
    const changes = [{ operation, attribute: attrName, values }];
    const opts = await passwordGuard.check(t.profileId, { changes });
    if (!opts) return false;
    const report = await ModifyEntryWithOptions(t.profileId, t.dn, changes, opts);
    void reloadQuietly();
    // With the entry: problem toasts get Remove Value / Reset Password… / Open Entry (ACCT-10).
    notifyPasswordWrite(report, `Attribute "${attrName}" ${operation === 'add' ? 'added' : 'replaced'}`, { profileId: t.profileId, dn: t.dn });
    return true;
  }

  async function handleModify(attrName: string, values: string[]): Promise<boolean> {
    try {
      if (isPasswordWriteAttribute(attrName)) return await writePassword('replace', attrName, values);
      await wails.ModifyAttribute(t.profileId, t.dn, attrName, values);
      void reloadQuietly();
      toast.success(`Attribute "${attrName}" modified`);
      return true;
    } catch (err: any) {
      toast.error(`Failed to modify "${attrName}"`, err?.message || (typeof err === 'string' ? err : undefined));
      return false;
    }
  }

  async function handleAdd(attrName: string, values: string[]): Promise<boolean> {
    try {
      if (isPasswordWriteAttribute(attrName)) {
        const existing = attrValues(entry, attrName).length > 0;
        // unicodePwd is never read back: an admin sets it with replace.
        const unicodePwd = ['unicodepwd', OID_UNICODE_PWD].includes(attrName.toLowerCase().split(';')[0]);
        return await writePassword(existing || unicodePwd ? 'replace' : 'add', attrName, values);
      }
      await wails.AddAttribute(t.profileId, t.dn, attrName, values);
      void reloadQuietly();
      toast.success(`Attribute "${attrName}" added`);
      return true;
    } catch (err: any) {
      toast.error(`Failed to add "${attrName}"`, err?.message || (typeof err === 'string' ? err : undefined));
      return false;
    }
  }

  async function deleteAttribute(attrName: string): Promise<boolean> {
    try {
      await wails.DeleteAttribute(t.profileId, t.dn, attrName);
      void reloadQuietly();
      toast.success(`Attribute "${attrName}" deleted`);
      return true;
    } catch (err: any) {
      toast.error(`Failed to delete "${attrName}"`, err?.message || (typeof err === 'string' ? err : undefined));
      return false;
    }
  }

  /** Asks before an attribute is removed; resolves true once it is deleted. */
  function requestDelete(name: string, opts?: { cleared?: boolean }): Promise<boolean> {
    return new Promise((resolve) => setPendingDelete({ name, cleared: !!opts?.cleared, resolve }));
  }

  /** "Search for This Value": the search panel with (attr=value) on the tab's connection. */
  async function searchForValue(attrName: string, value: string) {
    if (foreign && !(await switchToTabConnection())) return;
    const ss = useSearchStore.getState();
    ss.setPanelMode('advanced');
    ss.setParams({ filter: valueSearchFilter(attrName, value) });
    showActivity('search');
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-search-filter]')?.focus());
  }

  /** Editor-scope keys: Ctrl+L / F4 edit the breadcrumb, Alt+Up opens the parent. */
  function onEditorKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    const native = e.nativeEvent;
    if (matchShortcut(native, 'Mod+L') || (e.key === 'F4' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey)) {
      if ((e.target as HTMLElement).closest('[aria-label="Distinguished name or LDAP URL"]')) return;
      e.preventDefault();
      setCrumbEditing(true);
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && e.key === 'ArrowUp' && !isEditableTarget(e.target)) {
      const parent = parentDn(t.dn);
      if (!parent) return;
      e.preventDefault();
      navigateTo(parent, true);
    }
  }

  const memberCounts = entry ? rawMembershipCounts(entry) : { members: 0, memberOf: 0 };
  const photoValue = attrValues(entry, 'thumbnailPhoto')[0] ?? attrValues(entry, 'jpegPhoto')[0];
  const photo = photoValue ? imageDataUrl(photoValue) ?? undefined : undefined;
  const st = account.status;
  const lastLogonIso = st?.lastLogonReplicated ?? st?.lastLogon;
  // A domain root is named like its tree root and tab ("ad.ldapilot.lab", RW2-N-07).
  const headerName = attrValues(entry, 'displayName')[0] || (t.label !== rdnValue(t.dn) && isContainer ? t.label : rdnValue(t.dn)) || t.label;
  // Logon times and bad-password counts exist on AD only (ED-11).
  const isAD = (st?.serverType ?? serverType) === 'ad';
  const gone = t.state?.kind === 'deleted' || t.state?.kind === 'missing';
  // Edit affordances only with a usable, writable connection and a shown entry.
  const readOnlyReason = isReadOnly ? 'The connection is read-only' : offline ? (lost && connected ? 'Connection lost: reconnect to edit' : 'Not connected: reconnect to edit') : undefined;

  const toolbarItems: ToolbarItem[] = [
    { id: 'locate', label: 'Show in Tree', icon: Crosshair, disabled: gone, onClick: () => void handleShowInTree() },
    {
      id: 'bookmark',
      label: bookmarked ? 'Remove Bookmark' : 'Add Bookmark',
      icon: bookmarked ? <Star size={14} strokeWidth={1.75} aria-hidden className="fill-current text-warning" /> : Star,
      pressed: bookmarked,
      shortcut: 'Mod+D',
      onClick: toggleBookmark,
    },
    { id: 'copy-dn', label: 'Copy DN', icon: Copy, shortcut: 'Shift+Alt+C', onClick: copyDN },
    { id: 'copy-ldif', label: 'Copy as LDIF', icon: FileText, disabled: !entry, onClick: copyAsLDIF },
    // The same reload as F5 in the tab: a container also reloads its Contents list (RW2-N-02).
    { id: 'refresh', label: 'Refresh', icon: RefreshCw, shortcut: 'F5', disabled: !connected, onClick: () => refreshTab() },
    // Last, so it is the first to fold into "More tools" (ED-01: the five above stay visible at 1100 px).
    // A read-only connection opens it for a dry run (Apply disabled with the reason).
    { id: 'edit-ldif', label: 'Edit as LDIF…', icon: FileCode2, disabled: !entry || offline || gone, onClick: () => openEditAsLDIF(t.profileId, t.dn) },
  ];

  const subTabs: TabItem[] = [
    { id: 'attributes', label: 'Attributes', icon: List },
    ...(isContainer
      ? [{
          id: 'contents',
          label: 'Contents',
          icon: FolderOpen,
          disabled: foreign,
          hint: foreign ? `Contents lists the tree of the active connection: switch to ${profile?.name ?? 'this connection'} to see it` : undefined,
        }]
      : []),
    ...(showMembers ? [{ id: 'members', label: 'Membership', icon: Users, count: memberCounts.members + memberCounts.memberOf }] : []),
    ...(showAccountTab ? [{ id: 'account', label: 'Account', icon: UserCog }] : []),
    { id: 'ldif', label: 'LDIF', icon: FileText },
  ];

  const tlsText = profile ? TLS_TEXT[profile.tlsMode] ?? profile.tlsMode : '';
  const connectionChip = profile && (foreign || multiConnection) && (
    <Tooltip content={`Connection: ${profile.name} · ${tlsText}${isReadOnly ? ' · read-only' : ''}${offline ? ' · not connected' : ''}`}>
      <span tabIndex={0} className="shrink min-w-0 max-w-[160px] inline-flex rounded-sm focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus">
        <Badge tone={foreign ? 'info' : 'neutral'} icon={profile.tlsMode === 'none' ? LockOpen : Lock} className="min-w-0 max-w-full">
          <span className="truncate">{profile.name}</span>
        </Badge>
      </span>
    </Tooltip>
  );

  const pending = pendingDelete;
  const pendingValues = pending ? attrValues(entry, pending.name) : [];

  return (
    <div
      ref={rootRef}
      className="h-full flex flex-col min-h-0"
      onKeyDown={onEditorKeyDown}
      onFocus={() => setFocusWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
      }}
    >
      {/* Navigation: back/forward, editable breadcrumb, entry toolbar */}
      <div className="flex items-center gap-1 px-2 h-panel-header border-b border-border bg-card shrink-0 min-w-0">
        <IconButton
          label="Go Back"
          icon={ArrowLeft}
          shortcut="Alt+ArrowLeft"
          disabled={!canBack}
          onClick={() => {
            requestEditorFocus('back');
            goBack();
          }}
        />
        <IconButton
          label="Go Forward"
          icon={ArrowRight}
          shortcut="Alt+ArrowRight"
          disabled={!canForward}
          onClick={() => {
            requestEditorFocus('forward');
            goForward();
          }}
        />
        <DnBreadcrumb
          dn={t.dn}
          rootDn={rootDn}
          editing={crumbEditing}
          onEditingChange={setCrumbEditing}
          onNavigate={(dn) => navigateTo(dn, true)}
          onSubmitDn={(dn) => navigateTo(dn, true)}
          onShowInTree={(dn) => void handleShowInTree(dn)}
          loadSiblings={async (dn) => {
            const parent = parentDn(dn);
            if (!parent) return [];
            const children = await wails.GetChildren(t.profileId, parent);
            return (children ?? []).map(c => c.dn);
          }}
          className="ml-1 min-w-32"
        />
        {connectionChip}
        {isReadOnly && <Badge tone="warning" icon={Lock} className="shrink-0">Read-only</Badge>}
        <Toolbar aria-label="Entry actions" items={toolbarItems} overflowLabel="More tools" />
      </div>

      {/* A closed connection is said once (the Disconnected banner reconnects and switches). */}
      {foreign && !offline && (
        <Banner
          tone="info"
          body={
            <>
              Entry of <span className="font-medium">{profile?.name ?? t.profileId}</span>
              {isContainer ? ' — switch to list its contents and use its menus.' : ' — the tree, the menus and the status bar show another connection.'}
            </>
          }
          actions={<Button size="sm" leftIcon={Server} onClick={() => void switchFromBanner()}>Switch to {profile?.name ?? 'this connection'}</Button>}
        />
      )}
      {offline && !t.state && (
        <Banner
          tone="warning"
          title={lost && connected ? 'Connection lost' : 'Disconnected'}
          body={entry ? 'The values may be out of date. Editing is off until the connection is back.' : 'Reconnect to load this entry.'}
          actions={<Button size="sm" leftIcon={RefreshCw} onClick={(e) => reconnectFrom(e.currentTarget)}>Reconnect</Button>}
        />
      )}

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center gap-2 text-muted-foreground">
          <Spinner size="md" decorative />
          <span className="text-sm">Loading entry…</span>
        </div>
      ) : t.state ? (
        <EntryStateView
          profileId={t.profileId}
          dn={t.dn}
          rootDn={rootDn}
          state={t.state}
          serverType={serverType}
          connected={connected}
          onRetry={() => void refreshEntry(t.profileId, t.dn)}
          onOpen={(dn) => navigateTo(dn, true)}
          onClose={() => {
            // The next tab's editor takes focus (its breadcrumb), not its tab button (RW1-E-05).
            requestEditorFocus('crumb');
            closeTab(t.id);
            // Focus goes to the editor area (the next tab, or the welcome screen), not <body> (RW1-E-04).
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const a = document.activeElement;
              if (a && a !== document.body) return;
              const scope = document.querySelector<HTMLElement>('[role="region"][aria-label="Editor"]');
              (scope && focusScopeTarget(scope))?.focus({ preventScroll: true });
            }));
          }}
        />
      ) : !entry ? (
        offline ? (
          <EmptyState
            icon={CloudOff}
            title="Not connected"
            hint={`${profile?.name ?? 'The connection'} is not connected. Reconnect to load this entry.`}
            action={<Button size="sm" leftIcon={RefreshCw} onClick={(e) => reconnectFrom(e.currentTarget)}>Reconnect</Button>}
          />
        ) : (
          <EmptyState
            title="No entry data loaded"
            hint="The entry has not been read yet."
            action={<Button size="sm" leftIcon={RefreshCw} onClick={() => void refreshEntry(t.profileId, t.dn)}>Load</Button>}
          />
        )
      ) : (
        <>
          <EntrySummaryHeader
            name={headerName}
            dn={t.dn}
            objectClass={objectClasses}
            kind={kind}
            statuses={chips}
            photo={photo}
            ctx={commandCtx}
            locked={!!st?.locked}
            // Lost / closed connection: the primary is Reconnect (RW2-C-02); focus comes back
            // to it, else the crumb (focusWorkAreaSoon), and the account verb returns.
            primaryAction={editorHeaderPrimary({ offline }) === 'reconnect' ? { title: 'Reconnect', icon: RefreshCw, run: reconnectFromHeader } : undefined}
            onStatusClick={showAccountTab ? () => setSubTab('account') : undefined}
            meta={{
              login: attrValues(entry, 'sAMAccountName')[0] || attrValues(entry, 'uid')[0] || undefined,
              upn: attrValues(entry, 'userPrincipalName')[0] || undefined,
              lastLogon: st && isAD ? (lastLogonIso ? new Date(lastLogonIso) : null) : undefined,
              badPwdCount: st?.applicable && isAD ? st.badPasswordCount : undefined,
              memberOfCount: showMembers ? memberCounts.memberOf : undefined,
              cycleWith: kind === 'group' ? directCycle(entry) : undefined,
              onMemberOfClick: showMembers ? () => setEntryIntent(tabId, { subTab: 'members', membership: { direction: 'memberOf' } }) : undefined,
            }}
            className="shrink-0"
          />

          <Tabs
            variant="sub"
            idPrefix={SUB_TABS_ID}
            aria-label="Entry views"
            items={subTabs}
            value={activeSubTab}
            onValueChange={(id) => setSubTab(id as SubTab)}
            className="shrink-0 bg-card"
          />

          <TabPanel idPrefix={SUB_TABS_ID} value={activeSubTab} selected={activeSubTab} className="flex-1 min-h-0 overflow-hidden">
            {activeSubTab === 'members' ? (
              <MembershipPanel tabId={tabId} />
            ) : activeSubTab === 'contents' ? (
              <ContentsTab profileId={t.profileId} dn={t.dn} viewKey={tabId} />
            ) : activeSubTab === 'account' ? (
              <AccountPanel
                profileId={t.profileId}
                dn={t.dn}
                readOnly={isReadOnly || (offline ? (lost && connected ? 'Connection lost: reconnect to edit.' : 'Not connected: reconnect to edit.') : false)}
                account={account}
                onChanged={() => void reloadQuietly()}
              />
            ) : activeSubTab === 'ldif' ? (
              <LdifViewer dn={t.dn} entry={entry} onEdit={offline ? undefined : () => openEditAsLDIF(t.profileId, t.dn)} />
            ) : (
              <AttributeTable
                attributes={entry.attributes || []}
                onModify={handleModify}
                onAdd={handleAdd}
                onDelete={requestDelete}
                onNavigateDN={(dn) => openEntry(t.profileId, dn)}
                readOnly={!!readOnlyReason}
                readOnlyReason={readOnlyReason}
                schemaAttributes={schema?.attributes}
                allowedAttributes={allowedAttributes}
                profileId={t.profileId}
                dn={t.dn}
                onBinaryChanged={() => void reloadQuietly()}
                onShowInSchema={(name) => openSchemaTab(t.profileId, 'at', name, true)}
                onSearchValue={(name, value) => void searchForValue(name, value)}
                filterShortcutActive={focusWithin}
                viewKey={tabId}
              />
            )}
          </TabPanel>
        </>
      )}
      {pending && (
        <ConfirmDialog
          title={pending.cleared ? 'Remove all values' : 'Delete attribute'}
          message={
            <>
              <p>
                {pending.cleared ? `Remove all values of "${pending.name}"?` : `Delete the attribute "${pending.name}" and ${pendingValues.length === 1 ? 'its value' : `all its ${pendingValues.length} values`}?`}
              </p>
              <DeletedValuesPreview name={pending.name} values={pendingValues} binary={!!entry?.attributes?.find((a) => a.name === pending.name)?.binary} />
            </>
          }
          detail={t.dn}
          confirmLabel={pending.cleared ? 'Remove' : 'Delete'}
          tone="danger"
          onCancel={() => {
            pending.resolve(false);
            setPendingDelete(null);
          }}
          onConfirm={() => {
            const { name, resolve } = pending;
            setPendingDelete(null);
            void deleteAttribute(name).then(resolve);
          }}
        />
      )}
      {passwordGuard.element}
      {adPasswordPrompt.element}
    </div>
  );
}

/** The values an attribute delete removes (masked secrets, binary sizes; at most 8). */
function DeletedValuesPreview({ name, values, binary }: { name: string; values: string[]; binary: boolean }) {
  if (!values.length) return null;
  const secret = isPasswordWriteAttribute(name) || /password|pwdhistory|secret/i.test(name);
  const shown = values.slice(0, 8);
  return (
    <ul className="mt-1.5 max-h-40 overflow-auto rounded border border-border bg-background px-2 py-1 font-mono text-xs space-y-0.5">
      {shown.map((v, i) => (
        <li key={i} className="truncate">
          {secret ? '••••••••' : binary ? `<binary value, ${Math.floor((v.length * 3) / 4)} bytes>` : v}
        </li>
      ))}
      {values.length > shown.length && <li className="text-muted-foreground">…and {values.length - shown.length} more</li>}
    </ul>
  );
}

/**
 * The server's own text of a failure behind "Details" (RW1-E-14 / RW1-R-05:
 * "acl_read: Error retrieving instanceType for base. at source4/…" is no
 * sentence for an admin). Phrasing content only: it sits inside a <p>.
 */
function ServerDetail({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const id = `srv-detail-${useId().replace(/:/g, '')}`;
  if (!text.trim()) return null;
  return (
    <span className="block mt-1">
      <DisclosureButton open={open} onToggle={() => setOpen((v) => !v)} controls={id} className="mx-auto text-xs min-h-0">
        {open ? 'Hide server details' : 'Server details'}
      </DisclosureButton>
      <span id={id} hidden={!open} className="block mt-1 font-mono text-xs break-all select-text">{text}</span>
    </span>
  );
}

/**
 * Deleted / missing / failed entry (ED-04): no values, the reason, and what
 * can be done (Restore… on AD, open the parent or the nearest existing one,
 * try again, close the tab).
 */
function EntryStateView({ profileId, dn, rootDn, state, serverType, connected, onRetry, onOpen, onClose }: {
  profileId: string;
  dn: string;
  rootDn?: string;
  state: EntryTabState;
  serverType: ServerType | null;
  connected: boolean;
  onRetry: () => void;
  onOpen: (dn: string) => void;
  onClose: () => void;
}) {
  const parent = parentDn(dn);
  // Nearest existing ancestor of a missing entry (unlogged presence reads, at most 12 levels).
  const [nearest, setNearest] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (state.kind !== 'missing' || !connected) return;
    let cancelled = false;
    setNearest(undefined);
    (async () => {
      let cur = parentDn(dn);
      for (let i = 0; cur && i < 12; i++) {
        try {
          await AttributesPresent(profileId, cur, ['objectClass']);
          if (!cancelled) setNearest(cur);
          return;
        } catch {
          if (rootDn && sameDN(cur, rootDn)) break;
          cur = parentDn(cur);
        }
      }
      if (!cancelled) setNearest(null);
    })();
    return () => { cancelled = true; };
  }, [state.kind, profileId, dn, rootDn, connected]);

  const closeBtn = <Button size="sm" variant="ghost" leftIcon={X} onClick={onClose}>Close Tab</Button>;

  if (state.kind === 'deleted') {
    const at = new Date(state.at);
    return (
      <EmptyState
        icon={Trash2}
        title="Deleted"
        hint={`This entry${state.subtree ? ' (with everything below it)' : ''} was deleted in LDAPilot at ${formatDateTime(at)} (${formatRelative(at)}). Its values are no longer shown.`}
        action={
          <span className="flex flex-wrap items-center justify-center gap-2">
            {serverType === 'ad' && (
              <Button size="sm" leftIcon={ArchiveRestore} onClick={() => useRecycleStore.getState().openDeletedObjects(profileId, '', { focusDN: dn })}>
                Restore…
              </Button>
            )}
            {parent && <Button size="sm" variant="secondary" leftIcon={FolderUp} onClick={() => onOpen(parent)}>Open Parent</Button>}
            {closeBtn}
          </span>
        }
      />
    );
  }
  if (state.kind === 'missing') {
    return (
      <EmptyState
        icon={CircleSlash}
        title="No such object (32)"
        hint={
          <>
            The entry does not exist (any more): it may have been renamed, moved or deleted.{' '}
            {nearest === undefined && connected ? 'Looking for the nearest existing parent…' : nearest ? `Nearest existing parent: ${rdnValue(nearest)}.` : ''}
            <ServerDetail text={state.message} />
          </>
        }
        action={
          <span className="flex flex-wrap items-center justify-center gap-2">
            {nearest && <Button size="sm" leftIcon={FolderUp} onClick={() => onOpen(nearest)}>Open {rdnValue(nearest)}</Button>}
            <Button size="sm" variant="secondary" leftIcon={RefreshCw} disabled={!connected} onClick={onRetry}>Try Again</Button>
            {closeBtn}
          </span>
        }
      />
    );
  }
  return (
    <EmptyState
      icon={TriangleAlert}
      title={`Could not load the entry${state.code !== undefined ? ` (${state.code})` : ''}`}
      hint={<span className="font-mono break-all">{state.message}</span>}
      action={
        <span className="flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" leftIcon={RefreshCw} disabled={!connected} onClick={onRetry}>Try Again</Button>
          {closeBtn}
        </span>
      }
    />
  );
}

/** Children of a container (ContainerListView over the tree store's children of this DN). */
function ContentsTab({ profileId, dn, viewKey }: { profileId: string; dn: string; viewKey: string }) {
  // The tab's own profile view of the tree store (TREE-03).
  const loaded = useTreeStore((s) => selectChildNodes(profileId, dn)(s) !== undefined);
  const loading = useTreeStore(selectNodeLoading(profileId, dn));
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    useTreeStore.getState().loadChildren(profileId, dn, true).catch((err) => {
      setError(err instanceof Error ? err.message : String(err) || 'Failed to load the children');
    });
  }, [profileId, dn]);
  useEffect(() => {
    if (!loaded && !selectNodeLoading(profileId, dn)(useTreeStore.getState())) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dn, profileId]);

  // ContainerListView selects childNodes[dn] with a fallback array: mount it only once the list exists.
  if (loaded) return <ContainerListView profileId={profileId} containerDN={dn} embedded viewKey={viewKey} />;
  if (error) {
    return (
      <div className="p-3">
        <InlineAlert tone="danger" title="Could not list the children" body={error} actions={<Button size="sm" onClick={load}>Retry</Button>} />
      </div>
    );
  }
  return (
    <div className="h-full flex items-center justify-center gap-2 text-muted-foreground">
      <Spinner size="md" decorative />
      <span className="text-sm">{loading ? 'Loading children…' : 'Preparing the list…'}</span>
    </div>
  );
}

/** LDIF view with light highlighting: the dn line emphasised, attribute names muted, base64 markers in the info tone. */
function LdifViewer({ dn, entry, onEdit }: {
  dn: string;
  entry: { attributes?: { name: string; values: string[]; binary?: boolean }[] };
  /** Opens Edit as LDIF (not offered while the connection is down). */
  onEdit?: () => void;
}) {
  const ldifText = useMemo(() => formatEntryAsLDIF(dn, entry), [dn, entry]);
  const lines = useMemo(() => ldifText.split('\n'), [ldifText]);
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(ldifText).then(() => {
      setCopied(true);
      toast.success('LDIF copied');
      setTimeout(() => setCopied(false), 1500);
    }, () => toast.error('Could not copy LDIF'));
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-1 border-b border-border bg-card shrink-0">
        <span className="text-xs text-muted-foreground flex-1 min-w-0 truncate">LDIF (RFC 2849) of this entry — binary and non-ASCII values base64, lines folded at 76 columns</span>
        <Button size="sm" variant="ghost" leftIcon={copied ? Check : ClipboardCopy} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
        {onEdit && <Button size="sm" variant="secondary" leftIcon={FileCode2} onClick={onEdit}>Edit as LDIF…</Button>}
      </div>
      <div className="flex-1 overflow-auto p-3">
        <pre className="text-sm font-mono text-foreground whitespace-pre select-text leading-5" aria-label="LDIF">
          {lines.map((line, i) => <LdifLine key={i} line={line} />)}
        </pre>
      </div>
    </div>
  );
}

function LdifLine({ line }: { line: string }) {
  // Inline spans + '\n' inside <pre>: copying keeps the exact LDIF text.
  if (line.startsWith('#')) return <span className="text-muted-foreground italic">{line}{'\n'}</span>;
  const m = line.startsWith(' ') ? null : /^([^:\s]+)(::|:<|:)(.*)$/.exec(line);
  if (!m) return <>{line}{'\n'}</>;
  const [, name, sep, value] = m;
  const isDn = name.toLowerCase() === 'dn';
  return (
    <span className={cn(isDn && 'font-semibold')}>
      <span className={isDn ? 'text-foreground' : 'text-muted-foreground'}>{name}</span>
      <span className={sep === ':' ? 'text-muted-foreground' : 'text-info font-semibold'}>{sep}</span>
      {value}
      {'\n'}
    </span>
  );
}
