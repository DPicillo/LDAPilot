/**
 * The tree's verbs in the command registry (SPEC 6.5): the actions the old
 * hand-made tree and list menus had that the core / feature sets lack (Edit
 * Entry…, Copy Entry…, Copy RDN, Copy Name, Copy n DNs, Export Entry… of a
 * leaf, Import LDIF…, Show in Tree), plus the handlers of the shell
 * placeholders "Find in Tree" (Ctrl+F) and "Show RDN Type".
 *
 * Ctrl+F outside the editor, the bottom panel and the Schema panel (which
 * have their own find) switches to the Explorer and focuses Find in Tree.
 *
 * Registered by registerFeatureCommands() (commands/featureCommands.tsx),
 * i.e. after the core and shell sets, so the two placeholder overrides win.
 * Dialogs open through useDialogStore (DialogHost), never from component
 * state, so a global shortcut that unmounts a panel cannot destroy them.
 */
import { ClipboardCopy, ClipboardType, Copy, CopyPlus, Crosshair, Download, FilePen, Search, Type, Upload } from 'lucide-react'
import { useEditorStore } from '../../stores/editorStore'
import { useTreeStore } from '../../stores/treeStore'
import { openImportLDIF } from '../../stores/bulkDialogStore'
import { firstRDN, getParentDN, parseRDN } from '../../lib/dn'
import { EditEntryDialog } from '../editor/EditEntryDialog'
import { CopyEntryDialog } from '../editor/CopyEntryDialog'
import { ExportDialog } from '../export/ExportDialog'
import { ScopeBase } from '../../types/ldap'
import { useDialogStore } from '../ui/Dialog'
import { toast } from '../ui/Toast'
import { isContainerKind } from '../ui/objectKind'
import { foreignDn, kindOf, many, notifyCommandsChanged, one, registerCommands, type Command, type CommandContext } from '../ui/commands'
import { useConnectionStore } from '../../stores/connectionStore'
import { showActivity } from '../layout/shellState'
import { showPanel, whenPanelShown } from '../commands/panels'
import { useTreePrefs } from './treePrefs'

const dnOf = (ctx: CommandContext) => ctx.selection[0]?.dn ?? ''
const connected = (ctx: CommandContext) => ctx.connected && !!ctx.profileId
const container = (ctx: CommandContext) => one(ctx) && isContainerKind(kindOf(ctx))
const ncHead = (ctx: CommandContext) => ctx.selection.some((s) => !!s.ncHead)

/** Focus is where Ctrl+F has its own find (editor attribute filter, bottom panel tables, schema filter). */
function focusHasOwnFind(): boolean {
  const a = typeof document !== 'undefined' ? document.activeElement : null
  return a instanceof Element && !!a.closest('[role="region"][aria-label="Editor"], [role="region"][aria-label="Panel"], [data-panel="schema"]')
}

/** Explorer visible, then the tree's Find in Tree field focused (also when the Explorer was never shown: it mounts first). */
export function findInTree() {
  showPanel('explorer', { focus: false })
  whenPanelShown('explorer', (p) => !!p.querySelector('[data-command-scope="tree"]'), () => useTreePrefs.getState().requestFilterFocus())
}

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch (err) {
    toast.error(`Could not copy ${what}`, err instanceof Error ? err.message : String(err))
  }
}

/** Reloads the tree listing that shows dn (its parent), or the roots. */
function refreshTreeParent(profileId: string, dn: string) {
  const ts = useTreeStore.getState()
  const parent = getParentDN(dn)
  if (parent && ts.childNodes[parent]) void ts.refreshNode(profileId, parent).catch(() => {})
  else if (!parent) void ts.loadRootNodes(profileId).catch(() => {})
}

function refreshOpenTab(profileId: string, dn: string) {
  const es = useEditorStore.getState()
  if (es.tabs.some((t) => t.id === `${profileId}:${dn}`)) void es.refreshEntry(profileId, dn, { silent: true })
}

/** Explorer visible, then the tree selects (and expands the path to) dn. */
export function showInTree(profileId: string, dn: string) {
  showActivity('explorer')
  void useTreeStore.getState().locateInTree(profileId, dn)
}

function treeCommands(): Command[] {
  return [
    // Shell placeholders (layout/shellCommands.ts) ---------------------------------
    {
      id: 'edit.findInTree',
      title: 'Find in Tree',
      icon: Search,
      group: 'navigate',
      section: 'navigate',
      // Dispatched everywhere except where Ctrl+F has its own find (then the
      // command is disabled for the key and the region's own handler runs).
      shortcut: 'Mod+F',
      when: connected,
      enabled: () => !focusHasOwnFind(),
      run: findInTree,
      keywords: ['filter', 'search tree', 'locate', 'find'],
    },
    {
      id: 'view.showRdnType',
      title: 'Show RDN Type',
      icon: Type,
      group: 'view',
      section: 'layout',
      toggle: true,
      checked: () => useTreePrefs.getState().showRdnType,
      run: () => {
        useTreePrefs.getState().toggleRdnType()
        notifyCommandsChanged()
      },
      keywords: ['cn=', 'ou=', 'prefix', 'tree labels'],
    },
    // Entry verbs the old tree / list menus had ---------------------------------------
    {
      id: 'entry.showInTree',
      title: 'Show in Tree',
      icon: Crosshair,
      group: 'entry',
      section: 'open',
      order: 3,
      // A tab of another connection: locateInTree switches to it first (when connected).
      when: (ctx) => (one(ctx) && connected(ctx) && ctx.source !== 'tree') || (!!foreignDn(ctx) && useConnectionStore.getState().connectionStatuses[ctx.foreign!.profileId] === true),
      run: (ctx) => {
        const fdn = foreignDn(ctx)
        if (fdn && ctx.foreign) showInTree(ctx.foreign.profileId, fdn)
        else if (ctx.profileId) showInTree(ctx.profileId, dnOf(ctx))
      },
      keywords: ['locate', 'reveal', 'tree'],
    },
    {
      id: 'entry.edit',
      title: 'Edit Entry…',
      icon: FilePen,
      group: 'entry',
      section: 'edit',
      order: 0,
      write: true,
      when: (ctx) => one(ctx) && connected(ctx),
      run: (ctx) => {
        const profileId = ctx.profileId
        const dn = dnOf(ctx)
        if (!profileId || !dn) return
        useDialogStore.getState().open(EditEntryDialog, {
          dn,
          profileId,
          onSaved: () => {
            refreshOpenTab(profileId, dn)
            refreshTreeParent(profileId, dn)
          },
        })
      },
      keywords: ['attributes', 'objectClass', 'modify'],
    },
    {
      id: 'entry.copyEntry',
      title: 'Copy Entry…',
      icon: CopyPlus,
      group: 'entry',
      section: 'edit',
      order: 2,
      write: true,
      // Never a naming-context head (domain root, Configuration, Schema, suffix).
      when: (ctx) => one(ctx) && connected(ctx) && !ncHead(ctx),
      run: (ctx) => {
        const profileId = ctx.profileId
        const dn = dnOf(ctx)
        if (!profileId || !dn) return
        useDialogStore.getState().open(CopyEntryDialog, { sourceDN: dn, profileId, onCopied: () => refreshTreeParent(profileId, dn) })
      },
      keywords: ['duplicate', 'clone', 'template'],
    },
    {
      id: 'entry.copyRdn',
      title: 'Copy RDN',
      icon: ClipboardCopy,
      group: 'entry',
      section: 'edit',
      order: 10.5,
      when: one,
      run: (ctx) => copyText(firstRDN(dnOf(ctx)) || dnOf(ctx), 'RDN'),
      keywords: ['relative distinguished name', 'clipboard'],
    },
    {
      // The plain name ("Schmidt, Anna"), without the attribute type and escapes of the RDN.
      id: 'entry.copyName',
      title: 'Copy Name',
      icon: ClipboardType,
      group: 'entry',
      section: 'edit',
      order: 10.6,
      when: one,
      run: (ctx) => copyText(parseRDN(firstRDN(dnOf(ctx))).value || dnOf(ctx), 'Name'),
      keywords: ['name', 'cn', 'clipboard', 'rdn value'],
    },
    {
      id: 'entry.copyDns',
      title: (ctx) => `Copy ${ctx.selection.length} DNs`,
      icon: Copy,
      group: 'entry',
      section: 'bulk',
      order: 7,
      when: many,
      run: (ctx) => copyText(ctx.selection.map((s) => s.dn).join('\n'), `${ctx.selection.length} DNs`),
      keywords: ['distinguished names', 'clipboard'],
    },
    {
      // Containers have "Export Subtree…" (core); leaves export the entry itself.
      // "Export Entry…", not "Export…": File ▸ Export… is another palette action.
      id: 'entry.export',
      title: 'Export Entry…',
      icon: Download,
      group: 'entry',
      section: 'manage',
      order: 2,
      when: (ctx) => one(ctx) && connected(ctx) && !container(ctx),
      run: (ctx) => {
        // The label says "Entry": start with "This entry", not the subtree (RW3-R-06).
        useDialogStore.getState().open(ExportDialog, { dn: dnOf(ctx), profileId: ctx.profileId ?? undefined, scope: ScopeBase })
      },
      keywords: ['ldif', 'csv'],
    },
    {
      // Containers in the tree and list keep "Import LDIF…"; File ▸ Import LDIF… is the global entry.
      id: 'entry.importLdif',
      // Read-only connections open it for dry runs (Apply disabled with the reason: SRCH-17).
      title: (ctx) => (ctx.readOnly ? 'Check LDIF (Dry Run)…' : 'Import LDIF…'),
      icon: Upload,
      group: 'entry',
      section: 'manage',
      order: 5,
      palette: false,
      // Not while the connection is lost: neither a dry run nor an import can reach the
      // server (the other write verbs hide too, RW2-C-02).
      when: (ctx) => container(ctx) && connected(ctx) && !ctx.offline && (ctx.source === 'tree' || ctx.source === 'list'),
      // "into <container>": prefilled target, Rebase DNs and Prefill skeleton.
      run: (ctx) => openImportLDIF({ profileId: ctx.profileId ?? undefined, containerDN: dnOf(ctx) || undefined }),
      keywords: ['ldif', 'change file'],
    },
  ]
}

/** Registers the tree commands; returns the disposer. */
export function registerTreeCommands(): () => void {
  return registerCommands(treeCommands())
}
