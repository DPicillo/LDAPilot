/**
 * Open menus never shift (pure, tests/cmd.menu.test.ts): state that arrives
 * after a menu opened (account status, presence reads) re-resolves it, but
 * an item shown once stays in its place — disabled when it no longer applies
 * — and commands with `stableTitle` keep their first title.
 */
import type { ResolvedCommand } from '../ui/commands'

/**
 * `items`: the freshly resolved items (sorted); `seen`: the menu instance's
 * memory (id -> the item as first shown, in display order; updated here);
 * `fresh(id, section)`: the current resolution of an item that is no longer
 * listed (for its current title), or undefined.
 */
export function stabilizeItems(
  items: readonly ResolvedCommand[],
  seen: Map<string, ResolvedCommand>,
  fresh: (id: string, section: string) => ResolvedCommand | undefined,
): ResolvedCommand[] {
  const now = new Map(items.map((i) => [i.id, i]))
  const ids = items.map((i) => i.id)
  // A gone item goes back right after its previous neighbour in the shown order.
  const shown = [...seen.keys()]
  shown.forEach((id, k) => {
    if (now.has(id)) return
    let at = 0
    for (let j = k - 1; j >= 0; j--) {
      const i = ids.indexOf(shown[j])
      if (i >= 0) {
        at = i + 1
        break
      }
    }
    ids.splice(at, 0, id)
  })
  const out = ids.map((id): ResolvedCommand => {
    const cur = now.get(id)
    const first = seen.get(id)
    if (cur) return first && cur.command.stableTitle ? { ...cur, title: first.title } : cur
    const f = first!
    const r = fresh(id, f.section) ?? f
    // No longer applies: stays in place, disabled, with its current title ("Unlock Account" after "Checking…").
    return { ...r, section: f.section, title: f.command.stableTitle ? f.title : r.title, enabled: false, isDefault: false, disabledReason: f.command.goneReason }
  })
  const next = new Map(out.map((rc) => [rc.id, seen.get(rc.id) ?? rc]))
  seen.clear()
  next.forEach((v, k) => seen.set(k, v))
  return out
}
