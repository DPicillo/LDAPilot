import { useEffect, useId } from 'react'
import { normalizeDN } from '../lib/dn.ts'

/**
 * Entries with pending, unsaved edits in a form (EditEntryDialog, an inline
 * edit or the add row of the attribute table). The AI store reads it before
 * it refreshes an entry the assistant changed: a refresh would not touch the
 * form, and saving the form afterwards could overwrite the assistant's
 * change, so it warns instead. The editor store mirrors it into the tab's
 * `dirty` flag (the unsaved-changes dot, the close guard: ED-02, ED-03) via
 * `subscribeUnsavedEdits`.
 */
const sources = new Map<string, Set<string>>()
const listeners = new Set<(profileId: string, dn: string) => void>()

const keyOf = (profileId: string, dn: string) => `${profileId}\n${normalizeDN(dn)}`

/** Registers (on) or removes (off) one form's pending edits for an entry. */
export function setUnsavedEdits(source: string, profileId: string, dn: string, on: boolean): void {
  if (!profileId || !dn) return
  const key = keyOf(profileId, dn)
  const set = sources.get(key)
  const before = (set?.size ?? 0) > 0
  if (on) {
    if (set) set.add(source)
    else sources.set(key, new Set([source]))
  } else if (set) {
    set.delete(source)
    if (set.size === 0) sources.delete(key)
  }
  if (before !== hasUnsavedEdits(profileId, dn)) listeners.forEach((l) => l(profileId, dn))
}

/** True while any form holds unsaved edits of the entry. */
export function hasUnsavedEdits(profileId: string, dn: string): boolean {
  if (!profileId || !dn) return false
  return (sources.get(keyOf(profileId, dn))?.size ?? 0) > 0
}

/** Called whenever an entry gains its first or loses its last unsaved edit. Returns the disposer. */
export function subscribeUnsavedEdits(listener: (profileId: string, dn: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Keeps the entry flagged while `on` is true; clears it on change and unmount. */
export function useUnsavedEdits(profileId: string | null | undefined, dn: string | null | undefined, on: boolean): void {
  const source = useId()
  useEffect(() => {
    if (!profileId || !dn || !on) return
    setUnsavedEdits(source, profileId, dn, true)
    return () => setUnsavedEdits(source, profileId, dn, false)
  }, [source, profileId, dn, on])
}

// --- Input kept across remounts (UX loop 3, RW2-E-02) -----------------------------------

/**
 * Unsaved input that survives its form's unmount: the attribute table keeps
 * inline drafts per editor tab (stores/tabViewState), so the tab keeps its
 * dot and its close guard while another tab is shown. Registered under the
 * tab id (`scope`); editorStore clears it when the tab closes.
 */
const scoped = new Map<string, { profileId: string; dn: string }>()
const scopedSource = (scope: string) => `tab:${scope}`

export function setScopedUnsavedEdits(scope: string, profileId: string, dn: string, on: boolean): void {
  if (!scope || !profileId || !dn) return
  const cur = scoped.get(scope)
  if (cur && (cur.profileId !== profileId || normalizeDN(cur.dn) !== normalizeDN(dn))) {
    setUnsavedEdits(scopedSource(scope), cur.profileId, cur.dn, false)
    scoped.delete(scope)
  }
  if (on) scoped.set(scope, { profileId, dn })
  else scoped.delete(scope)
  setUnsavedEdits(scopedSource(scope), profileId, dn, on)
}

/** The tab closed (its input was discarded): its entry loses the mark. */
export function dropScopedUnsavedEdits(scope: string): void {
  const cur = scoped.get(scope)
  if (!cur) return
  scoped.delete(scope)
  setUnsavedEdits(scopedSource(scope), cur.profileId, cur.dn, false)
}

/** The tab was re-keyed: the registration follows (same entry, new spelling). */
export function moveScopedUnsavedEdits(from: string, to: string, dn: string): void {
  const cur = scoped.get(from)
  if (!cur || from === to) return
  scoped.delete(from)
  setUnsavedEdits(scopedSource(from), cur.profileId, cur.dn, false)
  scoped.set(to, { profileId: cur.profileId, dn })
  setUnsavedEdits(scopedSource(to), cur.profileId, dn, true)
}

/** Keeps the entry flagged while `on`; with a scope the mark outlives the unmount (cleared by the tab). */
export function useScopedUnsavedEdits(scope: string | null | undefined, profileId: string | null | undefined, dn: string | null | undefined, on: boolean): void {
  const source = useId()
  useEffect(() => {
    if (!profileId || !dn) return
    if (scope) {
      setScopedUnsavedEdits(scope, profileId, dn, on)
      return
    }
    if (!on) return
    setUnsavedEdits(source, profileId, dn, true)
    return () => setUnsavedEdits(source, profileId, dn, false)
  }, [scope, source, profileId, dn, on])
}
