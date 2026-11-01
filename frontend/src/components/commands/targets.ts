/**
 * What a command acts on, for the create and refresh verbs (pure,
 * tests/cmd.targets.test.ts).
 */
import type { CommandContext } from '../ui/commands'
import { isContainerKind } from '../ui/objectKind.ts'
import { getParentDN } from '../../lib/dn.ts'

type Ctx = Pick<CommandContext, 'selection' | 'containerDN' | 'source'> & Partial<Pick<CommandContext, 'foreign'>>

/**
 * Where New ▸ / Ctrl+N create: the selected container, the parent of a
 * selected leaf (a sibling), or the container a Contents list shows when
 * nothing in it is selected. Null: nothing to create in.
 */
export function createParent(ctx: Pick<Ctx, 'selection' | 'containerDN'>): string | null {
  if (ctx.selection.length === 1) {
    const it = ctx.selection[0]
    if (isContainerKind(it.kind)) return it.dn
    return getParentDN(it.dn) || null
  }
  if (ctx.selection.length === 0 && ctx.containerDN) return ctx.containerDN
  return null
}

/** A leaf is selected: New ▸ creates next to it ("New in <parent>"). */
export function createsSibling(ctx: Pick<Ctx, 'selection' | 'containerDN'>): boolean {
  return ctx.selection.length === 1 && !isContainerKind(ctx.selection[0].kind) && createParent(ctx) !== null
}

export type RefreshTarget =
  | { kind: 'entry'; dn: string }
  | { kind: 'container'; dn: string }
  | { kind: 'tree' }
  /** The one entry (tab) of another connection a surface targets: reloaded on its own connection (RW2-C-01). */
  | { kind: 'foreign'; profileId: string; dn: string }
  | { kind: 'none' }

/**
 * What F5 / Refresh reloads: one selected entry (its tab and its listing);
 * with nothing (or several entries) selected, the container a Contents list
 * shows; outside a region (source 'editor'), in the tree, from the menubar or
 * the palette with nothing selected, or anywhere while no tab is open
 * (`tabOpen: false`, the welcome screen), the tree (CMD-03, N-48). A tab of
 * another connection (the single foreign DN) reloads on its own connection,
 * like the read verbs Copy DN / Show in Tree (RW2-C-01); a special tab
 * (Server Info) in the editor area has nothing to refresh.
 */
export function refreshTarget(ctx: Ctx, opts: { tabOpen?: boolean } = {}): RefreshTarget {
  if (ctx.selection.length === 1) return { kind: 'entry', dn: ctx.selection[0].dn }
  if (ctx.containerDN) return { kind: 'container', dn: ctx.containerDN }
  if (ctx.foreign) {
    const dns = ctx.foreign.dns ?? []
    return ctx.selection.length === 0 && dns.length === 1 ? { kind: 'foreign', profileId: ctx.foreign.profileId, dn: dns[0] } : { kind: 'none' }
  }
  if (opts.tabOpen === false) return { kind: 'tree' }
  if (ctx.source === 'editor' || ctx.source === 'tree' || ctx.source === 'menubar' || ctx.source === 'palette') return { kind: 'tree' }
  return { kind: 'none' }
}
