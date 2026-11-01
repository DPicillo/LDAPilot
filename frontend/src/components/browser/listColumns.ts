/**
 * Contents list "Add column…" (pure, tests/cmd.list.test.ts): what a typed
 * attribute name does — show a built-in column (also a hidden one), add a new
 * attribute column, or nothing.
 */

export type ColumnInput =
  | { kind: 'invalid' }
  | { kind: 'empty' }
  /** A built-in attribute column (its canonical spelling). */
  | { kind: 'predefined'; name: string }
  /** An attribute column added earlier. */
  | { kind: 'existing'; name: string }
  | { kind: 'new'; name: string }

const ATTR_RE = /^[A-Za-z][\w-]*(;[\w-]+)*$/

export function columnInputResult(input: string, predefined: readonly string[], extra: readonly string[]): ColumnInput {
  const name = input.trim()
  if (!name) return { kind: 'empty' }
  if (!ATTR_RE.test(name)) return { kind: 'invalid' }
  const lower = name.toLowerCase()
  const p = predefined.find((c) => c.toLowerCase() === lower)
  if (p) return { kind: 'predefined', name: p }
  const e = extra.find((c) => c.toLowerCase() === lower)
  if (e) return { kind: 'existing', name: e }
  return { kind: 'new', name }
}

/** The hidden column ids after showing `id`. */
export function hiddenAfterShow(hidden: readonly string[], id: string): string[] {
  return hidden.filter((h) => h !== id)
}
