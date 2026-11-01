import { createContext, useContext, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { stripWordJoiner, dnUnder, dnKey, dnCanonKey, rdnValue, resolveAnswerDN } from '../../lib/aiFormat';
import { copyText } from '../../lib/ai';
import { regKey } from '../../lib/aiReducer';
import { useAIStore } from '../../stores/aiStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { useEditorStore } from '../../stores/editorStore';
import { useTreeStore } from '../../stores/treeStore';
import { useUIStore } from '../../stores/uiStore';
import { CommandMenuItems, ContextMenu, ENTRY_COMMAND_GROUPS, MenuItem, MenuSeparator, useContextMenu } from '../ui/Menu';
import { getCommandContext, resolveCommands, type SelectionItem } from '../ui/commands';
import { toast } from '../ui/Toast';
import * as wails from '../../lib/wails';
import { AtSign, Copy, Crosshair, ExternalLink } from 'lucide-react';

/** Verbs the DN menu has itself (the registry's versions act on the active connection only). */
const OWN_VERBS = new Set(['entry.open', 'entry.showInTree', 'entry.copyDn', 'ai.askAbout']);

/**
 * The objectClass of a DN for the registry verbs (cached per DN). The
 * account state is left to the registry (accountStatusCache, read once by
 * the first surface that needs it), so it is never stale here.
 */
const itemCache = new Map<string, SelectionItem>();

async function loadItem(profileId: string, dn: string): Promise<SelectionItem | null> {
  const key = profileId + '\n' + dnKey(dn);
  const hit = itemCache.get(key);
  if (hit) return hit;
  try {
    const res = await wails.SearchLDAP(profileId, { baseDN: dn, filter: '(objectClass=*)', scope: 0, attributes: ['objectClass'], sizeLimit: 1, timeLimit: 5 });
    const e = res.entries?.[0];
    if (!e) return null;
    const oc = e.attributes.find((a) => a.name.toLowerCase() === 'objectclass')?.values;
    const item: SelectionItem = { dn, profileId, objectClass: oc };
    if (itemCache.size > 200) itemCache.clear();
    itemCache.set(key, item);
    return item;
  } catch {
    return null;
  }
}

/** Search context of a filter the assistant used in this message. */
export interface FilterUse {
  profileId: string;
  baseDn: string;
  scope: string;
}

/** Link targets known from the tool cards of the message being rendered. */
export interface MessageLinks {
  /** regKey(dn) → profileId */
  dnProfiles: Record<string, string>;
  /** filter text → search context */
  filters: Record<string, FilterUse>;
  /** dnCanonKey(dn) → the DN as the tool results wrote it */
  dns?: Record<string, string>;
}

export const MessageLinkContext = createContext<MessageLinks>({ dnProfiles: {}, filters: {} });

/** dnCanonKey → DN for a list of DNs (the first spelling wins). */
export function dnIndex(dns: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dn of dns) {
    const k = dnCanonKey(dn);
    if (k && !(k in out)) out[k] = dn;
  }
  return out;
}

/** The DN registry (DNs of every loaded tool result) by dnCanonKey, rebuilt when it changes. */
let registryIndex: { reg: object; index: Record<string, string> } | null = null;
function registryLookup(key: string): string | undefined {
  const reg = useAIStore.getState().dnRegistry;
  if (!registryIndex || registryIndex.reg !== reg) registryIndex = { reg, index: dnIndex(Object.values(reg).map((r) => r.dn).filter(Boolean)) };
  return registryIndex.index[key];
}

/**
 * The DN a link opens: the DN of this message's tool results (else of any
 * loaded tool result) that the written one stands for, also when the model
 * doubled its escapes (P3, A-21: "CN=Semi\\3BColon \\<Angle\\>" failed with
 * "Invalid DN Syntax").
 */
export function linkTarget(written: string, links: MessageLinks): string {
  return resolveAnswerDN(written, (k) => links.dns?.[k] ?? registryLookup(k));
}

/**
 * DN profile choice (§10.2): the connection of a tool card in the same
 * message that returned this DN, then the DN registry, then the longest
 * base-DN suffix among connected profiles, then the active profile.
 */
export function resolveDNProfile(dn: string, links: MessageLinks): string | null {
  const key = regKey(dn);
  if (links.dnProfiles[key]) return links.dnProfiles[key];
  const reg = useAIStore.getState().dnRegistry[key];
  if (reg) return reg.profileId;
  const conn = useConnectionStore.getState();
  let best: { id: string; len: number } | null = null;
  for (const p of conn.profiles) {
    if (!conn.connectionStatuses[p.id] || !p.baseDN) continue;
    if (dnUnder(dn, p.baseDN)) {
      const len = dnKey(p.baseDN).length;
      if (!best || len > best.len) best = { id: p.id, len };
    }
  }
  if (best) return best.id;
  return conn.activeProfileId;
}

/** A DN in an answer; `compact` shows only its RDN value (table cells). */
export function DnLink({ dn, compact }: { dn: string; compact?: boolean }) {
  const links = useContext(MessageLinkContext);
  const menu = useContextMenu();
  // What the entry verbs act on: the DN the tool saw, not the model's spelling of it.
  const clean = linkTarget(stripWordJoiner(dn).trim(), links);

  const open = () => {
    const pid = resolveDNProfile(clean, links);
    if (!pid) {
      toast.info('Connect to the directory to open this entry.');
      return;
    }
    useEditorStore.getState().openEntry(pid, clean);
  };
  const locate = () => {
    const pid = resolveDNProfile(clean, links);
    if (!pid) {
      toast.info('Connect to the directory to show this entry in the tree.');
      return;
    }
    showInTree(pid, clean);
  };
  const mention = () => {
    const pid = resolveDNProfile(clean, links);
    if (!pid) return;
    void useAIStore.getState().askAbout([{ profileId: pid, dn: clean }]);
  };
  const pid = resolveDNProfile(clean, links);
  const foreign = !!pid && pid !== useConnectionStore.getState().activeProfileId;
  // The registry's entry verbs (Reset Password, Show Effective Membership,
  // Copy RDN, Bookmark, …) for an entry of the active connection (A-21);
  // its object class decides which apply, so it is read when the menu opens.
  const [item, setItem] = useState<SelectionItem | null>(null);
  const seq = useRef(0);
  const openMenu = (e: ReactMouseEvent) => {
    menu.open(e, undefined);
    const my = ++seq.current;
    setItem(null);
    const conn = useConnectionStore.getState();
    if (!pid || pid !== conn.activeProfileId || !conn.connectionStatuses[pid]) return;
    setItem({ dn: clean, profileId: pid });
    void loadItem(pid, clean).then((it) => {
      if (it && my === seq.current) setItem(it);
    });
  };

  return (
    <>
      <button type="button"
        className="inline cursor-pointer break-all rounded bg-secondary px-1 text-left font-mono text-xs text-primary underline-offset-2 [box-decoration-break:clone] hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        title={`Open ${clean}`}
        aria-label={`Open entry ${clean}`}
        onClick={open}
        onContextMenu={openMenu}
      >
        {compact ? rdnValue(clean) || clean : clean}
      </button>
      <ContextMenu point={menu.point} onClose={menu.close} label="Entry">
        {() => (
          <>
            <MenuItem icon={ExternalLink} label="Open" default onSelect={open} />
            <MenuItem icon={Crosshair} label="Show in Tree" hint={foreign ? 'switches the connection' : undefined} onSelect={locate} />
            <MenuItem icon={AtSign} label="Mention in Message" onSelect={mention} />
            <MenuSeparator />
            <MenuItem icon={Copy} label="Copy DN" onSelect={() => void copyText(clean, 'DN')} />
            {item && <RegistryVerbs item={item} />}
          </>
        )}
      </ContextMenu>
    </>
  );
}

/** The registry's entry verbs for one DN of the active connection, without the ones the DN menu has itself. */
function RegistryVerbs({ item }: { item: SelectionItem }) {
  const ctx = getCommandContext('list', { selection: [item] });
  if (ctx.selection.length !== 1) return null;
  const ids = resolveCommands(ctx, { group: ENTRY_COMMAND_GROUPS, surface: 'menu' }).items.map((r) => r.id).filter((id) => !OWN_VERBS.has(id));
  if (ids.length === 0) return null;
  return (
    <>
      <MenuSeparator />
      <CommandMenuItems ctx={ctx} ids={ids} />
    </>
  );
}

/**
 * "Show in Tree" for a DN in a message (A-21): the tree shows only the
 * active connection, so an entry of another connection switches to it
 * first, like the search results do.
 */
export function showInTree(profileId: string, dn: string) {
  const conn = useConnectionStore.getState();
  if (profileId !== conn.activeProfileId) {
    const name = conn.profiles.find((p) => p.id === profileId)?.name ?? 'the connection';
    if (!conn.connectionStatuses[profileId]) {
      toast.error('Cannot show the entry in the tree', `Connect to "${name}" (the connection this entry belongs to) first`);
      return;
    }
    conn.setActiveProfile(profileId);
    toast.info(`Switched to "${name}"`);
  }
  // Like the editor's and the search results' "Show in Tree": show the
  // explorer first, then select the node.
  const ui = useUIStore.getState();
  ui.setActivity('explorer');
  if (!ui.sidebarVisible) ui.toggleSidebar();
  void useTreeStore.getState().locateInTree(profileId, dn);
}
