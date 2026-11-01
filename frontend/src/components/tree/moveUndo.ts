/**
 * Undo of a move (TREE-02, RW3-N-04): moves the entries back to their former
 * parents with one BatchMove per parent (audited) and one entry-moved per
 * entry. `moveUndoButton` registers the undo (ui/undo.ts) and returns the
 * toast button: the undo then also runs from the bell entry of that toast
 * and from Edit ▸ Undo / Ctrl+Z while it is valid (10 minutes, until the
 * entries are moved or deleted again).
 *
 * The Move… dialog can offer the same Undo: pass the moved entries' former
 * DNs and the target container.
 */
import * as wails from '../../lib/wails'
import { emitEntryEvent, firstRDN, getParentDN, movedDN, normalizeDN, type EntryMovedDetail, ENTRY_MOVED } from '../../lib/treesearch'
import { parseRDN } from '../../lib/dn'
import { toast, type ToastAction } from '../ui/Toast'
import { registerUndo, undoButton } from '../ui/undo'

const nameOf = (dn: string) => parseRDN(firstRDN(dn)).value || dn

type BatchResult = { failed: number; total: number; errors?: { dn: string; message: string }[] | null }

/** DNs of `dns` that BatchMove moved (an error without DN = nothing was done, e.g. read-only). */
export function movedOf(dns: string[], result: BatchResult): { moved: string[]; errors: { dn: string; message: string }[] } {
  const errors = result.errors ?? []
  if (errors.some((e) => !e.dn) || (result.total > 0 && result.failed >= result.total)) {
    return { moved: [], errors: errors.length ? errors : dns.map((dn) => ({ dn, message: 'Not moved' })) }
  }
  const failed = new Set(errors.map((e) => normalizeDN(e.dn)))
  return { moved: dns.filter((dn) => !failed.has(normalizeDN(dn))), errors }
}

export function moveErrorText(errors: { dn: string; message: string }[]): string {
  return errors.map((e) => (e.dn ? `${e.dn}: ${e.message}` : e.message)).join('\n')
}

/** Moves the entries (former DNs `moved`, now below targetDN) back to their former parents. */
export async function undoTreeMove(profileId: string, moved: string[], targetDN: string): Promise<void> {
  const byParent = new Map<string, string[]>()
  for (const dn of moved) {
    const parent = getParentDN(dn)
    byParent.set(parent, [...(byParent.get(parent) ?? []), dn])
  }
  let back = 0
  const errors: { dn: string; message: string }[] = []
  for (const [parent, originals] of byParent) {
    const current = originals.map((dn) => movedDN(dn, targetDN))
    try {
      const result = await wails.BatchMove(profileId, current, parent)
      const r = movedOf(current, result)
      errors.push(...r.errors)
      for (const dn of r.moved) emitEntryEvent<EntryMovedDetail>(ENTRY_MOVED, { profileId, oldDN: dn, newDN: movedDN(dn, parent) })
      back += r.moved.length
    } catch (err) {
      errors.push({ dn: '', message: err instanceof Error ? err.message : String(err) })
    }
  }
  if (back > 0) toast.success(back === 1 && moved.length === 1 ? `${nameOf(moved[0])} moved back` : `${back} entries moved back`)
  if (errors.length) toast.error(back === 0 ? 'Undo failed' : `${errors.length} entries could not be moved back`, moveErrorText(errors))
}

/**
 * Registers the undo of a move and returns its toast button ("Undo").
 * `moved` are the former DNs of the moved entries, `targetDN` the container
 * they were moved into.
 */
export function moveUndoButton(profileId: string, moved: string[], targetDN: string): ToastAction {
  const entry = registerUndo({
    label: moved.length === 1 ? `Move of ${nameOf(moved[0])}` : `Move of ${moved.length} Entries`,
    profileId,
    // The entries where they are now, and the parents they go back to.
    dns: [...moved.map((dn) => movedDN(dn, targetDN)), ...new Set(moved.map((dn) => getParentDN(dn)).filter(Boolean))],
    run: () => undoTreeMove(profileId, moved, targetDN),
  })
  return undoButton(entry, (reason) =>
    toast.info(
      reason && reason !== 'expired'
        ? `Cannot undo the move: ${moved.length === 1 ? nameOf(moved[0]) : 'the entries'} ${moved.length === 1 ? 'was' : 'were'} ${reason}`
        : 'This move was already undone or is too old to undo',
    ),
  )
}
