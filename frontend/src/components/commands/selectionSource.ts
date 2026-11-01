/**
 * Which selection the menubar, the palette and the global shortcuts act on
 * (commands/selectionContext): the most recent of the active tab, the tree
 * selection, the search-results selection and the Contents list selection.
 * Pure state, unit-tested (tests/shell.test.ts, tests/cmd.selection.test.ts).
 */
export type SelectionSource = 'tab' | 'tree' | 'results' | 'list'

export interface SourceTracker {
  current(): SelectionSource
  /** A store change: a tree/results/list selection was made or an editor tab activated. */
  set(src: SelectionSource): void
  /**
   * Focus or a click landed in a region (null: outside the tracked regions).
   * Focus that a closing overlay hands back (`restored`) is not the user's
   * choice and never changes the source: Ctrl+K from the tree that opens an
   * entry returns focus to the tree row, but the opened tab stays current.
   */
  focus(src: SelectionSource | null, restored?: boolean): void
  reset(): void
}

export function createSourceTracker(initial: SelectionSource = 'tab'): SourceTracker {
  let src = initial
  return {
    current: () => src,
    set: (s) => {
      src = s
    },
    focus: (s, restored = false) => {
      if (s && !restored) src = s
    },
    reset: () => {
      src = initial
    },
  }
}

/**
 * The Contents lists that are mounted (the standalone list and the embedded
 * ones of container tabs). The one the user last worked in is active; when it
 * unmounts, the most recently mounted remaining one takes over. Pure.
 */
export interface ListRegistry<T> {
  add(id: string, view: T): () => void
  activate(id: string): void
  active(): T | undefined
  activeId(): string | null
}

export function createListRegistry<T>(): ListRegistry<T> {
  const views = new Map<string, T>()
  let order: string[] = []
  let current: string | null = null
  return {
    add(id, view) {
      views.set(id, view)
      order = [...order.filter((x) => x !== id), id]
      if (current === null) current = id
      return () => {
        views.delete(id)
        order = order.filter((x) => x !== id)
        if (current === id) current = order.length ? order[order.length - 1] : null
      }
    },
    activate(id) {
      if (views.has(id)) current = id
    },
    active: () => (current !== null ? views.get(current) : undefined),
    activeId: () => current,
  }
}
