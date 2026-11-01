/**
 * Context menu of the tree, the container list and the tree search hits
 * (SPEC 6.5, 10.2): built from the command registry, so it lists the same
 * per-type verbs, icons and shortcuts as the Entry menu, the palette and the
 * results; a DN header for one entry, "n entries selected" for several, and a
 * "Read-only connection" header instead of the write verbs.
 *
 * `ctx` is taken when the menu opens (getCommandContext with the clicked
 * selection); the items re-resolve while it is open (account status read on
 * demand by the account verbs).
 */
import { CommandMenuItems, ContextMenu } from '../ui/Menu'
import type { CommandContext } from '../ui/commands'

export interface EntryMenuState {
  point: { clientX: number; clientY: number }
  ctx: CommandContext
}

export function TreeContextMenu({ menu, onClose, label = 'Entry actions' }: { menu: EntryMenuState | null; onClose: () => void; label?: string }) {
  return (
    <ContextMenu point={menu?.point ?? null} onClose={onClose} label={label} minWidth={220}>
      {() => (menu ? <CommandMenuItems ctx={menu.ctx} showDnHeader /> : null)}
    </ContextMenu>
  )
}
