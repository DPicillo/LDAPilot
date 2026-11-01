/**
 * The feature tracks' verbs in the command registry (SPEC 6.5, 10.1 P5):
 * handlers for the per-type placeholders of ui/coreCommands.ts plus the
 * feature commands the core set does not have. The menubar (File, Go,
 * Entry), the palette, the shortcut dispatcher (F2, Del, Ctrl+N, Ctrl+D,
 * Shift+Alt+C) and every context menu built from CommandMenuItems show the
 * same verbs.
 *
 * Registered by AppLayout in the same effect as, and after, the core and
 * shell commands, so same-id definitions here override them (also after an
 * ErrorBoundary remount).
 *
 * Handlers act on ctx.profileId (the active connection; the registry drops
 * selection items of other connections) and read the account status again
 * before every account write: when()/title() only use the cached status or
 * the item's evidence for display (commands/accountState.ts). While the
 * server status of an entry is read, the Unlock slot holds a disabled
 * "Checking account status…" item and the Enable/Disable title is kept
 * (stableTitle), so open menus never shift; when the read fails the verbs
 * stay available (the handler reads the status again and decides).
 */
import {
  ArchiveRestore,
  FileBadge,
  FolderSearch,
  History,
  ImageDown,
  ImageUp,
  KeyRound,
  ListChecks,
  LockOpen,
  Power,
  UserPlus,
  Users,
} from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { useTreeStore } from '../../stores/treeStore'
import { useRecycleStore } from '../../stores/recycleStore'
import { useSearchStore } from '../../stores/searchStore'
import { useUIStore } from '../../stores/uiStore'
import { openBatchDialog } from '../../stores/bulkDialogStore'
import { openEntryWithIntent } from '../../stores/entryIntentStore'
import { rememberAccountStatus } from '../../stores/accountStatusCache'
import * as wails from '../../lib/wails'
import { SetAccountEnabled, SetMustChangePassword, UnlockAccount, errorMessage, readAccountStatusShared } from '../../lib/wails-account'
import { SaveBinaryValue } from '../../lib/wails-binary'
import { disableConfirmText, getAccountActions } from '../../lib/accountActions'
import { refreshAfterBulkApply } from '../../lib/bulkRefresh'
import { getParentDN, parseRDN, firstRDN, normalizeDN } from '../../lib/dn'
import type { AccountStatus } from '../../types/account'
import type { LDAPEntry } from '../../types/ldap'
import { PasswordDialog } from '../editor/PasswordDialog'
import { RenameEntryDialog } from '../editor/RenameEntryDialog'
import { MoveEntryDialog } from '../lifecycle/MoveEntryDialog'
import { NewEntryDialog, type NewEntryTemplate } from '../editor/NewEntryDialog'
import { CompareDialog } from '../editor/CompareDialog'
import { StatisticsDialog } from '../tree/StatisticsDialog'
import { ExportDialog } from '../export/ExportDialog'
import { useDialogStore } from '../ui/Dialog'
import { ConfirmDialog, type ConfirmDialogProps } from '../ui/ConfirmDialog'
import { toast } from '../ui/Toast'
import { hasAccountSemantics, isContainerKind } from '../ui/objectKind'
import { createParent, ncHeadSelected } from '../ui/coreCommands'
import { isKind, many, one, registerCommandHandlers, registerCommands, type Command, type CommandContext, type SelectionItem } from '../ui/commands'
import { registerSelectionContext } from './selectionContext'
import { registerTreeCommands } from '../tree/treeCommands'
import { registerAICommands } from '../ai/aiCommands'
import { CHECKING_STATUS, mustChangeTitle, promisedToggle, toggleEnabledTitle, unlockSlot } from './accountDisplay'
import { accountDisplay, afterAccountChange } from './accountState'
import { CERT_ATTRS, PHOTO_ATTRS, hasAnyAttribute, prefetchPresence, presentAttributes } from './presence'
import { chooseBinaryValue } from '../editor/BinaryValuePicker'
import { binaryChoices } from '../editor/certificateCard'
import { registerEditorCommands } from '../editor/editorCommands'
import { emitAuditFilter, emitExportRequest } from './events'
import { showPanel } from './panels'
import { connectProfile } from '../layout/shellState'
import { BulkEnableDialog } from './BulkEnableDialog'
import { AddToGroupsDialog } from './AddToGroupsDialog'
import { PhotoUploadDialog } from './PhotoUploadDialog'

// --- Helpers ---------------------------------------------------------------------

const dnOf = (ctx: CommandContext) => ctx.selection[0]?.dn ?? ''
const dnsOf = (ctx: CommandContext) => ctx.selection.map((s) => s.dn)
const connected = (ctx: CommandContext) => ctx.connected && !!ctx.profileId
const label = (dn: string) => parseRDN(firstRDN(dn)).value || dn
const MEMBER_KINDS = ['user', 'computer', 'service', 'contact', 'group'] as const

/** Entries with an account status (users, service accounts, AD computers; not LDAP devices or contacts). */
const isAccount = (s: SelectionItem) => hasAccountSemantics(s.kind, s.objectClass)
const oneUser = (ctx: CommandContext) => one(ctx) && isKind(ctx, 'user') && isAccount(ctx.selection[0])

function readOnlyProfile(profileId: string): boolean {
  return !!useConnectionStore.getState().profiles.find((p) => p.id === profileId)?.readOnly
}

/** Loaded entry of an open editor tab (no server read). */
function openTabEntry(profileId: string | null, dn: string): LDAPEntry | undefined {
  if (!profileId) return undefined
  return useEditorStore.getState().entries[`${profileId}:${dn}`]
}

function refreshOpenTab(profileId: string, dn: string) {
  const es = useEditorStore.getState()
  if (es.tabs.some((t) => t.id === `${profileId}:${dn}`)) void es.refreshEntry(profileId, dn, { silent: true })
}

/** Reloads the tree listing that shows dn (its parent), or the roots. */
function refreshTreeParent(profileId: string, dn: string) {
  const ts = useTreeStore.getState()
  const parent = getParentDN(dn)
  if (parent) void ts.refreshNode(profileId, parent).catch(() => {})
  else void ts.loadRootNodes(profileId).catch(() => {})
}

/** A ConfirmDialog hosted by DialogHost that resolves a promise. */
function HostedConfirm({ onClose, resolve, ...props }: Omit<ConfirmDialogProps, 'onConfirm' | 'onCancel'> & { onClose: () => void; resolve: (ok: boolean) => void }) {
  return (
    <ConfirmDialog
      {...props}
      onConfirm={() => {
        resolve(true)
        onClose()
      }}
      onCancel={() => {
        resolve(false)
        onClose()
      }}
    />
  )
}

function confirmAsync(props: Omit<ConfirmDialogProps, 'onConfirm' | 'onCancel'>): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogStore.getState().open(HostedConfirm, { ...props, resolve })
  })
}

// --- Account (account track) -----------------------------------------------------

/**
 * How old a status read (the menu that offered the action, a report row)
 * may be for the pre-check of an action (RW1-P-06: at human speed every
 * Unlock read the status twice before the write). The backend plans the
 * change from its own read anyway; a remembered state that would refuse the
 * action is read again before anything is said.
 */
const PRECHECK_MAX_AGE_MS = 30_000

/**
 * Authoritative status (GetAccountStatus), cached for when()/title(). Null
 * after an error toast. `allows`: whether the status permits the action; a
 * recent read that does not is confirmed by a fresh one.
 */
async function readAccount(profileId: string, dn: string, allows?: (st: AccountStatus) => boolean): Promise<AccountStatus | null> {
  try {
    let st = await readAccountStatusShared(profileId, dn, PRECHECK_MAX_AGE_MS)
    if (st?.applicable && allows && !allows(st)) st = await readAccountStatusShared(profileId, dn, 0)
    if (!st) {
      toast.error('The account status is not available', 'Not running under Wails')
      return null
    }
    rememberAccountStatus(profileId, st)
    if (!st.applicable) {
      toast.info(st.reason || `${label(dn)} has no account status`)
      return null
    }
    return st
  } catch (err) {
    toast.error('Could not read the account status', errorMessage(err, 'Unknown error'))
    return null
  }
}

async function unlockAccount(ctx: CommandContext) {
  const profileId = ctx.profileId
  const dn = dnOf(ctx)
  if (!profileId || !dn) return
  const st = await readAccount(profileId, dn, (s) => getAccountActions(s, readOnlyProfile(profileId)).unlock.enabled)
  if (!st) return
  const action = getAccountActions(st, readOnlyProfile(profileId)).unlock
  if (!action.enabled) {
    toast.info(action.reason || `${label(dn)} is not locked`)
    void afterAccountChange(profileId, dn)
    return
  }
  try {
    await UnlockAccount(profileId, dn)
    toast.success(`${label(dn)} unlocked`)
    refreshOpenTab(profileId, dn)
    await afterAccountChange(profileId, dn)
  } catch (err) {
    toast.error(`Could not unlock ${label(dn)}`, errorMessage(err, 'The account action failed'))
  }
}

async function toggleEnabled(ctx: CommandContext) {
  const profileId = ctx.profileId
  if (!profileId) return
  if (many(ctx)) {
    useDialogStore.getState().open(BulkEnableDialog, { profileId, dns: dnsOf(ctx) })
    return
  }
  const dn = dnOf(ctx)
  // What the clicked item said (menus keep their first title); else what a title would say now.
  const promised = ctx.shownTitle !== undefined ? promisedToggle(ctx.shownTitle) : promisedToggle(toggleEnabledTitle(accountDisplay(ctx)))
  const st = await readAccount(profileId, dn, (s) => {
    const a = getAccountActions(s, readOnlyProfile(profileId)).toggleEnabled
    return a.enabled && (a.enable ? 'enable' : 'disable') === promised
  })
  if (!st) return
  const action = getAccountActions(st, readOnlyProfile(profileId)).toggleEnabled
  if (!action.enabled) {
    toast.info(action.reason || 'The account cannot be changed')
    return
  }
  // Disabling always asks; enabling asks when the item did not say "Enable Account" (the server decides).
  const actual = action.enable ? 'enable' : 'disable'
  if (!action.enable || promised !== actual) {
    // One Disable text everywhere (Account tab, menus, palette: ACCT-09).
    const off = disableConfirmText(dn)
    const ok = await confirmAsync({
      title: action.enable ? 'Enable account?' : off.title,
      message: action.enable ? `${label(dn)} is disabled on the server. Enable it?` : off.message,
      detail: dn,
      confirmLabel: action.enable ? 'Enable' : off.confirmLabel,
      tone: action.enable ? 'default' : 'warning',
    })
    if (!ok) return
  }
  try {
    await SetAccountEnabled(profileId, dn, action.enable)
    toast.success(action.enable ? `${label(dn)} enabled` : `${label(dn)} disabled`)
    refreshOpenTab(profileId, dn)
    await afterAccountChange(profileId, dn)
  } catch (err) {
    toast.error(action.enable ? `Could not enable ${label(dn)}` : `Could not disable ${label(dn)}`, errorMessage(err, 'The account action failed'))
  }
}

async function toggleMustChange(ctx: CommandContext) {
  const profileId = ctx.profileId
  const dn = dnOf(ctx)
  if (!profileId || !dn) return
  // What the clicked item promised: "Require…" unless it said "Clear…".
  const title = ctx.shownTitle ?? mustChangeTitle(accountDisplay(ctx))
  const promisedSet = !title.startsWith('Clear')
  const st = await readAccount(profileId, dn, (s) => {
    const a = getAccountActions(s, readOnlyProfile(profileId)).mustChange
    return a.enabled && a.set === promisedSet
  })
  if (!st) return
  const action = getAccountActions(st, readOnlyProfile(profileId)).mustChange
  if (!action.enabled) {
    toast.info(action.reason || 'Not available for this account')
    return
  }
  if (promisedSet !== action.set) {
    const ok = await confirmAsync({
      title: action.set ? 'Require a password change?' : 'Clear "Must Change Password"?',
      message: action.set
        ? `${label(dn)} does not have to change the password on the server. Require a change at the next logon?`
        : `${label(dn)} already has to change the password at the next logon. Clear that requirement?`,
      detail: dn,
      confirmLabel: action.set ? 'Require' : 'Clear',
    })
    if (!ok) return
  }
  try {
    await SetMustChangePassword(profileId, dn, action.set)
    toast.success(action.set ? `${label(dn)} must change the password at the next logon` : `"Must change password" cleared for ${label(dn)}`)
    refreshOpenTab(profileId, dn)
    await afterAccountChange(profileId, dn)
  } catch (err) {
    toast.error('The account action failed', errorMessage(err, 'Unknown error'))
  }
}

function resetPassword(ctx: CommandContext) {
  const profileId = ctx.profileId
  const dn = dnOf(ctx)
  if (!profileId || !dn) return
  useDialogStore.getState().open(PasswordDialog, {
    dn,
    // The item's own connection (a results row / tab of another connection).
    profileId,
    onChanged: () => {
      refreshOpenTab(profileId, dn)
      void afterAccountChange(profileId, dn)
    },
  })
}

// --- Membership (membership track) -------------------------------------------------

function showEffective(ctx: CommandContext) {
  if (!ctx.profileId) return
  const group = isKind(ctx, 'group')
  openEntryWithIntent(ctx.profileId, dnOf(ctx), {
    subTab: 'members',
    membership: { direction: group ? 'members' : 'memberOf', mode: 'effective' },
  })
}

function addMembers(ctx: CommandContext) {
  if (!ctx.profileId) return
  openEntryWithIntent(ctx.profileId, dnOf(ctx), { subTab: 'members', membership: { direction: 'members', add: true } })
}

function addToGroups(ctx: CommandContext) {
  const profileId = ctx.profileId
  if (!profileId || !ctx.selection.length) return
  useDialogStore.getState().open(AddToGroupsDialog, {
    profileId,
    entries: ctx.selection.map((s) => ({ dn: s.dn, kind: s.kind ?? 'other', label: s.label })),
    onChanged: (dns: string[]) => dns.forEach((dn) => refreshOpenTab(profileId, dn)),
  })
}

// --- Entry verbs (tree, recycle, bulk) ---------------------------------------------

function deleteEntries(ctx: CommandContext) {
  if (!ctx.profileId || !ctx.selection.length) return
  // Recycle's confirmation: counts children, offers "Delete including all N
  // children" (tree delete control on AD/Samba), reports and refreshes.
  useRecycleStore.getState().requestDelete(ctx.profileId, dnsOf(ctx))
}

function renameEntry(ctx: CommandContext) {
  const profileId = ctx.profileId
  const dn = dnOf(ctx)
  if (!profileId || !dn) return
  // Renaming the active tab's entry from the editor, the Entry menu or the palette: the
  // re-keyed tab's editor takes focus afterwards (RW2-E-04 a). From a list the row does.
  const es = useEditorStore.getState()
  const tab = es.tabs.find((t) => t.id === es.activeTabId)
  const focusEditorAfter = !['tree', 'list', 'results'].includes(ctx.source) && !!tab?.dn && tab.profileId === profileId && normalizeDN(tab.dn) === normalizeDN(dn)
  useDialogStore.getState().open(RenameEntryDialog, { dn, profileId, focusEditorAfter, onRenamed: () => refreshTreeParent(profileId, dn) })
}

/** Move… / Move n Entries…: the Move to… dialog with the container picker, for one or several entries (LIFE-04). */
function moveEntries(ctx: CommandContext) {
  const profileId = ctx.profileId
  if (!profileId || !ctx.selection.length) return
  // The dialog emits ldapilot:entry-moved per moved entry (tabs, tree, bookmarks, results follow).
  useDialogStore.getState().open(MoveEntryDialog, { profileId, dns: dnsOf(ctx), onMoved: (moved: { dn: string; newDN: string }[]) => moved.forEach((m) => refreshTreeParent(profileId, m.dn)) })
}

function modifySelected(ctx: CommandContext) {
  const profileId = ctx.profileId
  if (!profileId || !ctx.selection.length) return
  openBatchDialog({ profileId, dns: dnsOf(ctx), initialMode: 'modify', onApplied: (r) => void refreshAfterBulkApply(profileId, r).catch(() => {}) })
}

/**
 * New ▸ / Ctrl+N: in the selected container, next to a selected leaf (its
 * parent), or in the container a Contents list shows. "Other Entry…" starts
 * on Custom… (NewEntryDialog remembers the last used template).
 */
function newChild(template: NewEntryTemplate) {
  return (ctx: CommandContext) => {
    const profileId = ctx.profileId
    const parentDN = createParent(ctx)
    if (!profileId || !parentDN) return
    useDialogStore.getState().open(NewEntryDialog, {
      parentDN,
      profileId,
      initialTemplate: template,
      onCreated: () => void useTreeStore.getState().refreshNode(profileId, parentDN).catch(() => {}),
    })
  }
}

/**
 * Export of the selection: one entry opens the Export dialog; 2+ entries ask
 * the Export dialog host for the DN list (ldapilot:export-request), so the
 * user picks format, attributes and "importable" options there.
 */
function exportSelection(ctx: CommandContext) {
  if (!ctx.profileId) return
  const dns = dnsOf(ctx)
  if (!dns.length) return
  if (dns.length === 1) {
    useDialogStore.getState().open(ExportDialog, { dn: dns[0], profileId: ctx.profileId ?? undefined })
    return
  }
  emitExportRequest(ctx.profileId, dns)
}

/** Show History: the Audit Log, filtered to this entry. */
function showHistory(ctx: CommandContext) {
  const profileId = ctx.profileId
  const dn = dnOf(ctx)
  if (!profileId || !dn) return
  useUIStore.getState().showBottomTab('audit')
  emitAuditFilter(profileId, dn)
}

/** Search in This Container…: the Search panel with this base DN, focused. */
async function searchHere(ctx: CommandContext) {
  const dn = dnOf(ctx)
  if (!dn) return
  // The search panel searches the active connection: an entry of another one (a tab's
  // header) switches to it first, else its base DN would land on the wrong server.
  if (ctx.profileId && ctx.profileId !== useConnectionStore.getState().activeProfileId) {
    await connectProfile(ctx.profileId, { reveal: false })
    if (useConnectionStore.getState().activeProfileId !== ctx.profileId) return
  }
  useSearchStore.getState().setParams({ baseDN: dn })
  showPanel('search')
}

// --- Binary values (binary track) ----------------------------------------------------

function findAttr(entry: LDAPEntry | undefined | null, names: string[]) {
  if (!entry) return undefined
  for (const n of names) {
    const a = entry.attributes.find((x) => x.name.toLowerCase() === n.toLowerCase() && x.values.length > 0)
    if (a) return a
  }
  return undefined
}

/** The selected entry as returned by the current search, when the results are of this profile. */
function resultEntry(profileId: string | null, dn: string): LDAPEntry | undefined {
  const ss = useSearchStore.getState()
  if (!profileId || !ss.results || (ss.resultsProfileId ?? profileId) !== profileId) return undefined
  const lower = dn.toLowerCase()
  return ss.results.entries.find((e) => e.dn.toLowerCase() === lower)
}

/**
 * Download Photo / Certificate: 'yes' when the entry has such a value (the
 * loaded tab, a search result that returned it, or the presence read),
 * 'no' when it has none, 'checking' while the presence read runs: the item
 * then stays in place, disabled, so the menu does not shift when it arrives.
 */
function presenceOf(ctx: CommandContext, names: string[]): 'yes' | 'no' | 'checking' {
  const dn = dnOf(ctx)
  const entry = openTabEntry(ctx.profileId, dn)
  if (entry) return findAttr(entry, names) ? 'yes' : 'no'
  if (findAttr(resultEntry(ctx.profileId, dn), names)) return 'yes'
  if (!ctx.profileId || !ctx.connected || !dn) return 'no'
  const p = presentAttributes(ctx.profileId, dn)
  if (Array.isArray(p)) return hasAnyAttribute(p, names) ? 'yes' : 'no'
  if (p === undefined) prefetchPresence(ctx.profileId, dn)
  return 'checking'
}

async function downloadValue(ctx: CommandContext, names: string[], what: string) {
  const profileId = ctx.profileId
  const dn = dnOf(ctx)
  if (!profileId || !dn) return
  try {
    const entry = openTabEntry(profileId, dn) ?? (await wails.GetEntry(profileId, dn))
    const choices = binaryChoices(entry?.attributes, names)
    if (!choices.length) {
      toast.info(`${label(dn)} has no ${what}`)
      return
    }
    // Several photos (thumbnailPhoto, jpegPhoto values) or certificates: ask which (DEF-13).
    const choice = await chooseBinaryValue({ title: `Download which ${what}?`, verb: 'Save…', choices })
    if (!choice) return
    const path = await SaveBinaryValue(dn, choice.attribute, choice.value)
    if (path) toast.success(`${choice.attribute} saved to ${path}`)
  } catch (err) {
    toast.error(`Could not save the ${what}`, errorMessage(err, 'Unknown error'))
  }
}

function uploadPhoto(ctx: CommandContext) {
  const profileId = ctx.profileId
  const dn = dnOf(ctx)
  if (!profileId || !dn) return
  useDialogStore.getState().open(PhotoUploadDialog, { profileId, dn, serverType: ctx.serverType, onUploaded: () => refreshOpenTab(profileId, dn) })
}

// --- Registration ----------------------------------------------------------------------

/** Deleted Objects: Active Directory only (Show Deleted control, tombstones / Recycle Bin). */
const adOnly = (ctx: CommandContext) => (ctx.serverType === 'ad' ? undefined : ctx.serverType ? 'Active Directory only' : 'Reading the server type…')

function featureCommands(): Command[] {
  return [
    // Overrides of core definitions -----------------------------------------------
    {
      // Core: groups only. Users, computers and service accounts get their effective group memberships.
      id: 'membership.showEffective',
      title: (ctx) => (isKind(ctx, 'group') ? 'Show Effective Members' : 'Show Effective Membership'),
      icon: Users,
      group: 'membership',
      section: 'membership',
      order: 2,
      when: (ctx) => isKind(ctx, 'group', 'user', 'computer', 'service', 'contact'),
      keywords: ['nested', 'recursive', 'transitive', 'memberOf', 'groups'],
    },
    {
      // Users, computers, contacts, groups (nesting) and multi-selections of them: one group picker, n × m adds.
      id: 'membership.addToGroup',
      title: (ctx) => (many(ctx) ? `Add ${ctx.selection.length} Entries to Group…` : 'Add to Group…'),
      icon: UserPlus,
      group: 'membership',
      section: (ctx) => (many(ctx) ? 'bulk' : isKind(ctx, 'group') ? 'membership' : 'account'),
      order: 4,
      write: true,
      when: (ctx) => connected(ctx) && ctx.selection.length > 0 && ctx.selection.every((s) => (MEMBER_KINDS as readonly string[]).includes(s.kind ?? '')),
      keywords: ['member', 'group', 'nesting', 'memberOf'],
    },
    {
      id: 'account.toggleEnabled',
      title: (ctx) => (many(ctx) ? `Enable/Disable ${ctx.selection.length} Accounts…` : toggleEnabledTitle(accountDisplay(ctx))),
      icon: Power,
      group: 'account',
      section: (ctx) => (many(ctx) ? 'bulk' : 'account'),
      order: 3,
      write: true,
      stableTitle: true,
      when: (ctx) => ctx.selection.length > 0 && ctx.selection.every(isAccount),
      keywords: ['enable', 'disable', 'userAccountControl', 'nsAccountLock', 'pwdAccountLockedTime'],
    },
    {
      id: 'account.unlock',
      // While the status is read the slot holds a disabled placeholder, so the menu does not shift when it arrives.
      title: (ctx) => (unlockSlot(accountDisplay(ctx), accountDisplay(ctx).canRead) === 'checking' ? CHECKING_STATUS : 'Unlock Account'),
      icon: LockOpen,
      group: 'account',
      section: 'account',
      order: 1,
      write: true,
      // The placeholder's slot stays in an open menu once the read says "not locked": with the reason (RW3-P-04).
      goneReason: 'Not locked',
      // SPEC 6.5: users, only when locked. Unknown status (the read failed):
      // offered, the handler reads the status and says when it is not locked.
      when: (ctx) => {
        if (!oneUser(ctx)) return false
        const st = accountDisplay(ctx)
        return unlockSlot(st, st.canRead) !== 'hidden'
      },
      enabled: (ctx) => {
        const st = accountDisplay(ctx)
        return unlockSlot(st, st.canRead) === 'offer'
      },
      keywords: ['lockout', 'locked'],
    },
    {
      id: 'account.resetPassword',
      title: 'Reset Password…',
      icon: KeyRound,
      group: 'account',
      section: 'account',
      order: 2,
      write: true,
      when: oneUser,
      keywords: ['password', 'change', 'set password'],
    },
    // New feature commands --------------------------------------------------------------
    {
      id: 'account.mustChangePassword',
      title: (ctx) => mustChangeTitle(accountDisplay(ctx)),
      icon: KeyRound,
      group: 'account',
      section: 'account',
      order: 2.5,
      write: true,
      stableTitle: true,
      when: oneUser,
      run: toggleMustChange,
      keywords: ['must change', 'pwdLastSet', 'pwdReset', 'next logon', 'expire password'],
    },
    {
      id: 'recycle.deletedObjects',
      title: 'Deleted Objects…',
      icon: ArchiveRestore,
      group: 'navigate',
      section: 'navigate',
      order: 5,
      when: connected,
      enabled: (ctx) => ctx.serverType === 'ad',
      disabledReason: adOnly,
      run: (ctx) => {
        if (ctx.profileId) useRecycleStore.getState().openDeletedObjects(ctx.profileId)
      },
      keywords: ['recycle bin', 'restore', 'tombstone', 'undelete'],
    },
    {
      id: 'recycle.deletedObjectsHere',
      title: 'Deleted Objects…',
      icon: ArchiveRestore,
      group: 'entry',
      section: 'manage',
      order: 4,
      // The palette has the Go ▸ Deleted Objects… entry (one name, no duplicate).
      palette: false,
      // Naming-context heads of an AD directory (domain, Configuration, DNS zones): the view of this partition.
      when: (ctx) => one(ctx) && connected(ctx) && ctx.serverType === 'ad' && (isKind(ctx, 'domain') || ncHeadSelected(ctx)),
      run: (ctx) => {
        if (ctx.profileId) useRecycleStore.getState().openDeletedObjects(ctx.profileId, dnOf(ctx))
      },
      keywords: ['recycle bin', 'restore', 'tombstone', 'undelete'],
    },
    {
      id: 'bulk.modifySelected',
      title: (ctx) => `Modify ${ctx.selection.length} Entries…`,
      icon: ListChecks,
      group: 'entry',
      section: 'bulk',
      order: 2,
      write: true,
      when: (ctx) => many(ctx) && connected(ctx),
      run: modifySelected,
      keywords: ['batch', 'bulk', 'template', 'replace', 'dry run'],
    },
    {
      id: 'entry.history',
      title: 'Show History',
      icon: History,
      group: 'entry',
      section: 'manage',
      order: 9,
      when: (ctx) => one(ctx) && !!ctx.profileId,
      run: showHistory,
      keywords: ['audit', 'audit log', 'changes', 'who changed', 'history'],
    },
    {
      id: 'entry.searchHere',
      title: 'Search in This Container…',
      icon: FolderSearch,
      group: 'entry',
      section: 'manage',
      order: 1.5,
      when: (ctx) => one(ctx) && connected(ctx) && isContainerKind(ctx.selection[0].kind),
      run: searchHere,
      keywords: ['search below', 'base dn', 'find in container', 'subtree'],
    },
    {
      id: 'binary.uploadPhoto',
      title: 'Upload Photo…',
      icon: ImageUp,
      group: 'entry',
      section: 'manage',
      order: 10,
      write: true,
      when: (ctx) => one(ctx) && connected(ctx) && isKind(ctx, 'user', 'contact'),
      run: uploadPhoto,
      keywords: ['thumbnailPhoto', 'jpegPhoto', 'picture', 'image', 'binary', 'replace photo'],
    },
    {
      id: 'binary.downloadPhoto',
      title: 'Download Photo…',
      icon: ImageDown,
      group: 'entry',
      section: 'manage',
      order: 11,
      when: (ctx) => one(ctx) && connected(ctx) && isKind(ctx, 'user', 'contact') && presenceOf(ctx, PHOTO_ATTRS) !== 'no',
      enabled: (ctx) => presenceOf(ctx, PHOTO_ATTRS) === 'yes',
      run: (ctx) => downloadValue(ctx, PHOTO_ATTRS, 'photo'),
      keywords: ['thumbnailPhoto', 'jpegPhoto', 'picture', 'image', 'save', 'binary'],
    },
    {
      id: 'binary.downloadCertificate',
      title: 'Download Certificate…',
      icon: FileBadge,
      group: 'entry',
      section: 'manage',
      order: 12,
      when: (ctx) => one(ctx) && connected(ctx) && isKind(ctx, 'user', 'computer', 'service') && presenceOf(ctx, CERT_ATTRS) !== 'no',
      enabled: (ctx) => presenceOf(ctx, CERT_ATTRS) === 'yes',
      run: (ctx) => downloadValue(ctx, CERT_ATTRS, 'certificate'),
      keywords: ['userCertificate', 'x509', 'der', 'save', 'binary'],
    },
  ]
}

/** Handlers for the placeholders of the core set (visible but disabled until now). */
const HANDLERS: Record<string, (ctx: CommandContext) => void | Promise<void>> = {
  'account.unlock': unlockAccount,
  'account.resetPassword': resetPassword,
  'account.toggleEnabled': toggleEnabled,
  'membership.addToGroup': addToGroups,
  'membership.addMembers': addMembers,
  'membership.showEffective': showEffective,
  'create.user': newChild('user'),
  'create.group': newChild('group'),
  'create.ou': newChild('ou'),
  'create.computer': newChild('computer'),
  'create.contact': newChild('contact'),
  'create.entry': newChild('custom'),
  'entry.statistics': (ctx) => {
    useDialogStore.getState().open(StatisticsDialog, { dn: dnOf(ctx), profileId: ctx.profileId ?? undefined })
  },
  'entry.rename': renameEntry,
  'entry.move': moveEntries,
  'entry.compareWith': (ctx) => {
    useDialogStore.getState().open(CompareDialog, { dn: dnOf(ctx), profileId: ctx.profileId ?? undefined })
  },
  'entry.compare2': (ctx) => {
    useDialogStore.getState().open(CompareDialog, { dn: ctx.selection[0].dn, otherDN: ctx.selection[1].dn, profileId: ctx.profileId ?? undefined })
  },
  'entry.exportSelection': exportSelection,
  'entry.delete': deleteEntries,
}

/** Registers the feature commands, handlers and selection providers; returns the disposer (AppLayout effect, after the core set). */
export function registerFeatureCommands(): () => void {
  const offs = [registerCommands(featureCommands()), registerCommandHandlers(HANDLERS), registerSelectionContext(), registerTreeCommands(), registerAICommands(), registerEditorCommands()]
  return () => offs.forEach((off) => off())
}
