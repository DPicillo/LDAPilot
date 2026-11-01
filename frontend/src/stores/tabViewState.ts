/**
 * View state of an editor tab that outlives the editor's mount (UX loop 3:
 * RW2-E-02, RW2-E-03, M-18). MainPanel mounts only the active tab's
 * EntryEditor and a sub-tab switch unmounts the sub-view, so component state
 * alone forgot the sub-tab, the Membership direction, the attribute filter,
 * typed inline input and the Contents list's filter, sort, selection and
 * scroll position on every tab switch.
 *
 * Keyed by scope (the editor tab id) and key; editorStore drops the scopes
 * of closed tabs (`dropTabViews`) and moves them when a tab is re-keyed
 * (`moveTabView`). In memory only, never persisted. Pure apart from React
 * (tests/loop3.test.ts).
 */
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

const views = new Map<string, Map<string, unknown>>()

/** True when the scope holds a value for key (also an explicit undefined is "none"). */
export function hasTabView(scope: string | null | undefined, key: string): boolean {
  return !!scope && !!views.get(scope)?.has(key)
}

export function getTabView<T>(scope: string | null | undefined, key: string): T | undefined {
  if (!scope) return undefined
  return views.get(scope)?.get(key) as T | undefined
}

/** Stores a value; undefined removes it. */
export function setTabView(scope: string | null | undefined, key: string, value: unknown): void {
  if (!scope) return
  let v = views.get(scope)
  if (value === undefined) {
    v?.delete(key)
    if (v && v.size === 0) views.delete(scope)
    return
  }
  if (!v) {
    v = new Map()
    views.set(scope, v)
  }
  v.set(key, value)
}

/** A tab was re-keyed (server DN spelling): its view state follows. */
export function moveTabView(from: string, to: string): void {
  if (from === to) return
  const v = views.get(from)
  if (!v) return
  views.delete(from)
  views.set(to, v)
}

/** Drops the view state of every scope not in `keep` (closed tabs); returns the dropped scopes. */
export function dropTabViews(keep: ReadonlySet<string>): string[] {
  const dropped: string[] = []
  for (const scope of views.keys()) if (!keep.has(scope)) dropped.push(scope)
  for (const scope of dropped) views.delete(scope)
  return dropped
}

/**
 * useState that keeps its value per scope: a remount of the same scope starts
 * from the remembered value. Without a scope it is plain useState.
 */
export function useTabView<T>(scope: string | null | undefined, key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (scope && hasTabView(scope, key)) return getTabView<T>(scope, key) as T
    return typeof initial === 'function' ? (initial as () => T)() : initial
  })
  useEffect(() => {
    if (scope) setTabView(scope, key, value)
  }, [scope, key, value])
  return [value, setValue]
}
