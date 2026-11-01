/**
 * Type-ahead of the Menu primitive (DEF-10, WAI-ARIA menu pattern): typing
 * moves focus to the next item whose label starts with the typed text.
 *
 * - One character: the next matching item after the focused one (wrapping),
 *   so pressing the same letter again cycles through "Delete…", "Deleted
 *   Objects…", "Disconnect".
 * - Several characters typed within TYPEAHEAD_MS: the first item from the
 *   focused one on that starts with all of them ("de" → Delete…, "dis" →
 *   Disconnect); a repeated single letter ("ddd") keeps cycling.
 * - Leading punctuation and case are ignored ("“Ben”…" matches "b"); an
 *   enabled match wins over a disabled one.
 *
 * Pure (node --test: tests/nav.menu.test.ts).
 */

export const TYPEAHEAD_MS = 500

export interface TypeaheadState {
  buf: string
  t: number
}

export interface TypeaheadItem {
  label: string
  disabled?: boolean
}

/** Lower-case label without leading punctuation / symbols. */
export function typeaheadText(label: string): string {
  return label.trim().toLowerCase().replace(/^[^\p{L}\p{N}]+/u, '')
}

/** True for a key that types a character (no Ctrl / Alt / Meta). */
export function isTypeaheadKey(e: { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): boolean {
  return e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.altKey && !e.metaKey
}

/**
 * The item to focus after `key` was typed (index into items, or -1 for no
 * match) and the new type-ahead state. `current` is the focused item (-1 =
 * none).
 */
export function typeaheadMatch(
  items: readonly TypeaheadItem[],
  current: number,
  state: TypeaheadState,
  key: string,
  now: number,
): { index: number; state: TypeaheadState } {
  const ch = key.toLowerCase()
  const buf = now - state.t > TYPEAHEAD_MS ? ch : state.buf + ch
  const next = { buf, t: now }
  const n = items.length
  if (!n) return { index: -1, state: next }
  // "dd…" cycles like a single "d".
  const repeated = [...buf].every((c) => c === buf[0])
  const prefix = repeated ? buf[0] : buf
  const start = repeated ? current + 1 : Math.max(current, 0)
  let disabledHit = -1
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n
    if (!typeaheadText(items[i].label).startsWith(prefix)) continue
    if (!items[i].disabled) return { index: i, state: next }
    if (disabledHit < 0) disabledHit = i
  }
  return { index: disabledHit, state: next }
}
