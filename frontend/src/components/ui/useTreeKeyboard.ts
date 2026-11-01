/**
 * useTreeKeyboard (SPEC 6.4) for virtualized trees (DirectoryTree; tested in
 * the gallery with 2,000 rows).
 *
 * - role=tree/treeitem, aria-level/expanded/selected/setsize/posinset.
 * - Roving tabindex on the focused row + scrollToIndex.
 * - Focus recovery: the focused id is stored; when the virtualizer unmounts
 *   the focused row, focus parks on the tree container (not <body>), keys
 *   keep working from the stored row, and the row is re-focused when it
 *   remounts.
 * - Keys: Up/Down, Right (expand / first child), Left (collapse / parent),
 *   Home/End, PgUp/PgDn, type-ahead, Enter (open) / Ctrl+Enter (pin), Space
 *   (select), Shift/Ctrl+arrows (extend / move only), F2, Del, Ctrl+N,
 *   Shift+Alt+C, Shift+F10 / Menu key, Alt+Up / Backspace (parent), '*'
 *   (expand siblings).
 */
import { useCallback, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { matchShortcut } from './shortcuts'

export interface TreeKeyboardItem {
  id: string
  label: string
  level: number
  parentId: string | null
  expandable: boolean
  expanded: boolean
}

export interface UseTreeKeyboardOptions {
  /** Visible rows in display order (the flattened tree). */
  items: TreeKeyboardItem[]
  selectedIds: Set<string>
  /** replace = click/arrow, toggle = Space/Ctrl+click, range = Shift. */
  onSelect: (id: string, mode: 'replace' | 'toggle' | 'range', anchorId: string | null) => void
  onExpand: (id: string) => void
  onCollapse: (id: string) => void
  onOpen?: (id: string, opts: { pin: boolean }) => void
  onRename?: (id: string) => void
  onDelete?: (ids: string[]) => void
  onNewChild?: (id: string) => void
  onCopyDn?: (ids: string[]) => void
  onContextMenu?: (id: string, el: HTMLElement | null) => void
  /** Alt+Up / Backspace (after focus moved to the parent). */
  onParent?: (parentId: string) => void
  /** '*': expand all siblings of the focused row. */
  onExpandSiblings?: (ids: string[]) => void
  /** virtualizer.scrollToIndex. */
  scrollToIndex: (index: number) => void
  /** Rows per page for PgUp/PgDn. */
  pageSize?: number
  /** Accessible name of the tree. */
  label: string
  multiSelect?: boolean
}

export function useTreeKeyboard(o: UseTreeKeyboardOptions) {
  const { items } = o
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const focusedRef = useRef<string | null>(null)
  focusedRef.current = focusedId
  const containerRef = useRef<HTMLElement | null>(null)
  const rowEls = useRef(new Map<string, HTMLElement>())
  const refCbs = useRef(new Map<string, (el: HTMLElement | null) => void>())
  const pending = useRef<string | null>(null)
  const parking = useRef(false)
  const anchor = useRef<string | null>(null)
  const typeahead = useRef({ buf: '', t: 0 })
  const opts = useRef(o)
  opts.current = o

  const index = useMemo(() => {
    const m = new Map<string, number>()
    items.forEach((it, i) => m.set(it.id, i))
    return m
  }, [items])

  // aria-setsize / aria-posinset per sibling group.
  const siblings = useMemo(() => {
    const groups = new Map<string | null, string[]>()
    for (const it of items) {
      const g = groups.get(it.parentId) ?? []
      g.push(it.id)
      groups.set(it.parentId, g)
    }
    const pos = new Map<string, { size: number; pos: number; group: string[] }>()
    for (const g of groups.values()) g.forEach((id, i) => pos.set(id, { size: g.length, pos: i + 1, group: g }))
    return pos
  }, [items])

  const effectiveFocus = focusedId != null && index.has(focusedId) ? focusedId : items[0]?.id ?? null

  const focusId = useCallback(
    (id: string) => {
      setFocusedId(id)
      focusedRef.current = id
      const i = index.get(id)
      if (i === undefined) return
      opts.current.scrollToIndex(i)
      const el = rowEls.current.get(id)
      if (el) el.focus({ preventScroll: true })
      else pending.current = id
    },
    [index],
  )

  const itemRef = (id: string) => {
    let cb = refCbs.current.get(id)
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        if (el) {
          rowEls.current.set(id, el)
          const a = document.activeElement
          const ownsFocus = !a || a === document.body || !!containerRef.current?.contains(a)
          if (pending.current === id && ownsFocus) {
            pending.current = null
            el.focus({ preventScroll: true })
          }
        } else {
          const prev = rowEls.current.get(id)
          // Virtualizer unmounts the focused row: park focus on the tree, remember the row.
          if (prev && document.activeElement === prev) {
            // Keep a pending keyboard move; otherwise remember this row for recovery.
            if (pending.current == null) pending.current = id
            parking.current = true
            containerRef.current?.focus({ preventScroll: true })
            parking.current = false
          }
          rowEls.current.delete(id)
        }
      }
      refCbs.current.set(id, cb)
    }
    return cb
  }

  const select = (id: string, mode: 'replace' | 'toggle' | 'range') => {
    if (mode !== 'range') anchor.current = id
    opts.current.onSelect(id, mode, anchor.current)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const p = opts.current
    if (!items.length) return
    const curId = focusedRef.current && index.has(focusedRef.current) ? focusedRef.current : items[0].id
    const i = index.get(curId) ?? 0
    const cur = items[i]
    const ctrl = e.ctrlKey || e.metaKey
    const move = (n: number) => {
      const t = items[Math.max(0, Math.min(items.length - 1, n))]
      focusId(t.id)
      if (ctrl) return
      if (e.shiftKey && p.multiSelect) select(t.id, 'range')
      else select(t.id, 'replace')
    }
    const page = p.pageSize ?? 10
    const done = () => {
      e.preventDefault()
      e.stopPropagation()
    }

    if (e.altKey && !ctrl && e.key === 'ArrowUp') {
      done()
      if (cur.parentId && index.has(cur.parentId)) {
        focusId(cur.parentId)
        select(cur.parentId, 'replace')
        p.onParent?.(cur.parentId)
      }
      return
    }
    if (matchShortcut(e, 'Shift+Alt+C')) {
      done()
      const ids = p.selectedIds.has(curId) ? [...p.selectedIds] : [curId]
      p.onCopyDn?.(ids)
      return
    }
    if (e.altKey) return
    // Space inside a running type-ahead ("test l") is part of the search text.
    const typing = typeahead.current.buf !== '' && Date.now() - typeahead.current.t < 600
    if (e.key === ' ' && typing && !ctrl) {
      const ta = typeahead.current
      ta.buf += ' '
      ta.t = Date.now()
      done()
      return
    }
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      done()
      p.onContextMenu?.(curId, rowEls.current.get(curId) ?? null)
      return
    }
    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'n' && p.onNewChild) {
      done()
      p.onNewChild(curId)
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        done()
        return move(focusedRef.current == null ? 0 : i + 1)
      case 'ArrowUp':
        done()
        return move(i - 1)
      case 'Home':
        done()
        return move(0)
      case 'End':
        done()
        return move(items.length - 1)
      case 'PageDown':
        done()
        return move(i + page)
      case 'PageUp':
        done()
        return move(i - page)
      case 'ArrowRight':
        done()
        if (cur.expandable && !cur.expanded) p.onExpand(cur.id)
        else if (cur.expanded && items[i + 1]?.parentId === cur.id) move(i + 1)
        return
      case 'ArrowLeft':
        done()
        if (cur.expandable && cur.expanded) p.onCollapse(cur.id)
        else if (cur.parentId && index.has(cur.parentId)) move(index.get(cur.parentId)!)
        return
      case 'Backspace':
        done()
        if (cur.parentId && index.has(cur.parentId)) {
          move(index.get(cur.parentId)!)
          p.onParent?.(cur.parentId)
        }
        return
      case 'Enter':
        done()
        p.onOpen?.(cur.id, { pin: ctrl })
        return
      case ' ':
        done()
        select(cur.id, ctrl || p.multiSelect ? 'toggle' : 'replace')
        return
      case 'F2':
        if (!p.onRename) return
        done()
        p.onRename(cur.id)
        return
      case 'Delete':
        if (!p.onDelete) return
        done()
        p.onDelete(p.selectedIds.has(cur.id) ? [...p.selectedIds] : [cur.id])
        return
      case '*':
        done()
        p.onExpandSiblings?.((siblings.get(cur.id)?.group ?? []).filter((id) => items[index.get(id)!]?.expandable))
        return
    }
    // Type-ahead on the label (RDN value).
    if (e.key.length === 1 && !ctrl) {
      const now = Date.now()
      const ta = typeahead.current
      ta.buf = now - ta.t > 600 ? e.key.toLowerCase() : ta.buf + e.key.toLowerCase()
      ta.t = now
      const start = ta.buf.length === 1 ? i + 1 : i
      for (let k = 0; k < items.length; k++) {
        const it = items[(start + k) % items.length]
        if (it.label.toLowerCase().startsWith(ta.buf)) {
          done()
          focusId(it.id)
          select(it.id, 'replace')
          return
        }
      }
    }
  }

  const getTreeProps = () => ({
    ref: (el: HTMLElement | null) => {
      containerRef.current = el
    },
    role: 'tree' as const,
    'aria-label': o.label,
    'aria-multiselectable': o.multiSelect || undefined,
    // A tab stop only while the focused row is not rendered.
    tabIndex: effectiveFocus && rowEls.current.has(effectiveFocus) ? -1 : 0,
    onKeyDown,
    onFocus: (e: FocusEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget || parking.current) return
      // Focus arrived on the container (Tab, or parked after unmount): go to the stored row.
      const id = pending.current ?? effectiveFocus
      if (id && !rowEls.current.has(id)) {
        pending.current = id
        const i = index.get(id)
        if (i !== undefined) opts.current.scrollToIndex(i)
      } else if (id && e.relatedTarget && !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
        rowEls.current.get(id)?.focus({ preventScroll: true })
      }
    },
  })

  const getItemProps = (item: TreeKeyboardItem) => {
    const s = siblings.get(item.id)
    return {
      ref: itemRef(item.id),
      role: 'treeitem' as const,
      id: undefined as string | undefined,
      tabIndex: item.id === effectiveFocus ? 0 : -1,
      'aria-level': item.level,
      'aria-expanded': item.expandable ? item.expanded : undefined,
      'aria-selected': o.selectedIds.has(item.id),
      'aria-setsize': s?.size,
      'aria-posinset': s?.pos,
      'data-tree-id': item.id,
      onFocus: () => {
        if (focusedRef.current !== item.id) setFocusedId(item.id)
      },
    }
  }

  /**
   * Moves the roving tab stop to id WITHOUT focusing it (the selection changed
   * elsewhere, e.g. "Show in Tree" while focus is in the editor): Tab into the
   * tree then lands on that row.
   */
  const setRovingId = useCallback((id: string | null) => {
    focusedRef.current = id
    setFocusedId(id)
  }, [])

  return { focusedId: effectiveFocus, setFocusedId: focusId, setRovingId, getTreeProps, getItemProps, select }
}
