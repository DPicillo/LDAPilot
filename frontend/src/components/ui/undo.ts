/**
 * Undo of recent actions (RW3-N-04): the move of tree entries (drag and
 * drop; the Move… dialog can register too) and bookmark add / remove. An
 * undo stays available for UNDO_LIFETIME_MS from three places — the toast's
 * Undo, the notification bell's entry of that toast, and Edit ▸ Undo /
 * Ctrl+Z (the newest one of the active connection, never while a text field
 * has focus) — and runs at most once.
 *
 * An undo ends early when what it depends on changed: a move or delete at
 * or above one of its DNs (the moved entries were moved again or deleted,
 * their old parent was renamed), seen through the entry events.
 *
 * Pure apart from the window listeners (node --test: tests/nav.undo.test.ts).
 */
import { isDNAtOrBelow } from '../../lib/dn.ts'

/** How long an undo stays available (bell, Ctrl+Z). */
export const UNDO_LIFETIME_MS = 10 * 60_000

export interface UndoEntry {
  id: string
  /** What is undone, after "Undo " ("Move of Anna Schmidt", "Remove Bookmark"). */
  label: string
  profileId: string
  createdAt: number
  expiresAt: number
  /** DNs the undo needs unchanged: a later move or delete at or above one of them ends it. */
  dns: string[]
  run: () => void | Promise<void>
  /** Ran, or ended early (moved again / deleted). */
  done?: boolean
  /** Why it ended early (shown when its toast button is clicked afterwards). */
  goneReason?: string
}

export interface UndoRequest {
  label: string
  profileId: string
  dns?: string[]
  run: () => void | Promise<void>
  /** Default UNDO_LIFETIME_MS. */
  lifetimeMs?: number
}

/** A toast / bell button (ToastAction's shape). */
export interface UndoButton {
  label: string
  run: () => void
}

let entries: UndoEntry[] = []
const listeners = new Set<() => void>()
let version = 0
let seq = 0
const buttonIds = new WeakMap<object, string>()

function changed() {
  version++
  for (const l of [...listeners]) l()
}

/** Registers an undo; returns its entry. */
export function registerUndo(req: UndoRequest, now = Date.now()): UndoEntry {
  const entry: UndoEntry = {
    id: `undo-${now.toString(36)}-${++seq}`,
    label: req.label,
    profileId: req.profileId,
    createdAt: now,
    expiresAt: now + (req.lifetimeMs ?? UNDO_LIFETIME_MS),
    dns: [...(req.dns ?? [])],
    run: req.run,
  }
  // Drop what has expired; keep the list short.
  entries = [...entries.filter((e) => !e.done && e.expiresAt > now), entry].slice(-50)
  changed()
  return entry
}

/** The undo, while it can still run. */
export function liveUndo(id: string | undefined, now = Date.now()): UndoEntry | undefined {
  if (!id) return undefined
  const e = entries.find((x) => x.id === id)
  return e && !e.done && e.expiresAt > now ? e : undefined
}

/** The newest undo that can still run (of the connection, when given). */
export function latestUndo(profileId?: string | null, now = Date.now()): UndoEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.done || e.expiresAt <= now) continue
    if (profileId !== undefined && profileId !== null && e.profileId !== profileId) continue
    return e
  }
  return undefined
}

/**
 * Runs the undo once. 'gone': it ran already, expired or ended early
 * (`reason` says why when known).
 */
export async function runUndo(id: string, now = Date.now()): Promise<{ result: 'done' | 'gone'; reason?: string }> {
  const e = entries.find((x) => x.id === id)
  if (!e || e.done || e.expiresAt <= now) {
    return { result: 'gone', reason: e?.goneReason ?? (e && !e.done ? 'expired' : undefined) }
  }
  e.done = true
  changed()
  await e.run()
  return { result: 'done' }
}

/**
 * Ends the undos of the connection that depend on `dn` or on something
 * below it (moved / deleted there). Returns how many ended.
 */
export function invalidateUndos(profileId: string, dn: string, reason: string): number {
  let n = 0
  for (const e of entries) {
    if (e.done || e.profileId !== profileId) continue
    if (e.dns.some((d) => isDNAtOrBelow(d, dn))) {
      e.done = true
      e.goneReason = reason
      n++
    }
  }
  if (n) changed()
  return n
}

/**
 * A toast button that runs the undo; the bell finds the undo of a toast's
 * button again with undoIdOf. `onGone` runs instead when the undo can no
 * longer run.
 */
export function undoButton(entry: UndoEntry, onGone?: (reason?: string) => void, label = 'Undo'): UndoButton {
  const button: UndoButton = {
    label,
    run: () => {
      void runUndo(entry.id).then((r) => {
        if (r.result === 'gone') onGone?.(r.reason)
      })
    },
  }
  buttonIds.set(button, entry.id)
  return button
}

/** The undo behind a toast button (undoButton), if any. */
export function undoIdOf(button: unknown): string | undefined {
  return button && typeof button === 'object' ? buttonIds.get(button) : undefined
}

export function subscribeUndo(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Changes whenever an undo is added, runs or ends (useSyncExternalStore). */
export function undoVersion(): number {
  return version
}

/** Tests only. */
export function resetUndos(): void {
  entries = []
  changed()
}

// Moves and deletes made after an undo was registered end the undos that depend on them.
if (typeof window !== 'undefined') {
  window.addEventListener('ldapilot:entry-moved', (e) => {
    const d = (e as CustomEvent<{ profileId?: string; oldDN?: string }>).detail
    if (d?.profileId && d.oldDN) invalidateUndos(d.profileId, d.oldDN, 'moved or renamed since')
  })
  window.addEventListener('ldapilot:entry-deleted', (e) => {
    const d = (e as CustomEvent<{ profileId?: string; dn?: string }>).detail
    if (d?.profileId && d.dn) invalidateUndos(d.profileId, d.dn, 'deleted since')
  })
}
