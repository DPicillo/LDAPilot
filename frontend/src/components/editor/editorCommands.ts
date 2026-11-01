/**
 * Commands of the entry editor package: "Edit as LDIF…" (DEF-14) in the
 * Entry menu, the entry context menus and the palette. Registered by
 * registerFeatureCommands (commands/featureCommands.tsx) next to the tree
 * commands; the editor toolbar and the LDIF sub-tab open the dialog directly.
 */
import { FileCode2 } from 'lucide-react'
import { one, registerCommands, type Command, type CommandContext } from '../ui/commands'
import { useDialogStore } from '../ui/Dialog'
import { EditAsLdifDialog } from './EditAsLdifDialog'

/** Opens Edit as LDIF for one entry of a connection. */
export function openEditAsLDIF(profileId: string, dn: string, onSaved?: (dn: string) => void) {
  useDialogStore.getState().open(EditAsLdifDialog, { profileId, dn, onSaved })
}

const dnOf = (ctx: CommandContext) => ctx.selection[0]?.dn ?? ''

export const editAsLdifCommand: Command = {
  id: 'entry.editLdif',
  title: 'Edit as LDIF…',
  icon: FileCode2,
  group: 'entry',
  section: 'edit',
  // Right after Edit Entry… (order 0).
  order: 0.5,
  write: true,
  when: (ctx) => one(ctx) && ctx.connected && !!ctx.profileId,
  run: (ctx) => {
    const dn = dnOf(ctx)
    if (ctx.profileId && dn) openEditAsLDIF(ctx.profileId, dn)
  },
  keywords: ['ldif', 'text', 'raw', 'modify', 'attributes', 'rename'],
}

/** Registers the editor commands; returns the disposer. */
export function registerEditorCommands(): () => void {
  return registerCommands([editAsLdifCommand])
}
