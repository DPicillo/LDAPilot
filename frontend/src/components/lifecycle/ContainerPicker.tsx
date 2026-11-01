/**
 * Target container picker (LIFE-04): a lazy container tree of the connection
 * (GetRootEntries / GetChildren, containers only), a type-ahead filter over
 * the loaded containers plus a server search for matching containers, the
 * connection's recent targets, and the target DN as an editable field whose
 * existence is checked (EntriesExist, unlogged) while typing and on blur.
 * Used by Move…, the batch move, Copy Entry and Restore to….
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { ChevronDown, ChevronRight, CircleCheck, CircleAlert, History } from 'lucide-react'
import { cn } from '../../lib/utils'
import * as wails from '../../lib/wails'
import { EntriesExist } from '../../lib/wails-recycle'
import { escapeFilterValue } from '../../lib/ldapFilter'
import { getParentDN, normalizeDN } from '../../lib/dn'
import { ScopeSub, type TreeNode } from '../../types/ldap'
import { useConnectionStore } from '../../stores/connectionStore'
import { OBJECT_KIND_COLOR, OBJECT_KIND_ICON, resolveObjectKind } from '../ui/objectKind'
import { Input, SearchInput } from '../ui/Input'
import { Field } from '../ui/Field'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import {
  containerName, isContainerNode, targetProblemText, loadRecentTargets, looksLikeDN, matchesContainerFilter, offeredRecentTargets,
  pathFromRoot, targetProblem,
} from './containerPicker'

export type TargetState = 'empty' | 'checking' | 'ok' | 'missing' | 'problem' | 'error'

/** Validity of the chosen target, reported to the dialog (submit only when 'ok'). */
export interface TargetStatus {
  dn: string
  state: TargetState
  message?: string
}

export interface ContainerSuggestion {
  dn: string
  /** Shown instead of the container name ("original location", …). */
  label?: string
}

interface ContainerPickerProps {
  profileId: string
  value: string
  onChange: (dn: string) => void
  onStatusChange?: (status: TargetStatus) => void
  /** Entries being moved: they and everything below them are no targets; their parent is "already there". */
  moving?: string[]
  /** Container expanded and shown initially (e.g. the current parent). */
  revealDN?: string
  /** Gets the filter field (the dialog's initialFocus). */
  inputRef?: RefObject<HTMLInputElement | null>
  /** Shown before the recent targets (e.g. the nearest existing container of a restore). */
  suggestions?: ContainerSuggestion[]
  label?: string
  disabled?: boolean
  className?: string
}

interface Row {
  node: TreeNode
  depth: number
  key: string
}

const SERVER_HITS = 25

export function ContainerPicker({
  profileId, value, onChange, onStatusChange, moving, revealDN, inputRef, suggestions, label = 'Target container', disabled, className,
}: ContainerPickerProps) {
  const baseDN = useConnectionStore((s) => s.profiles.find((p) => p.id === profileId)?.baseDN ?? '')
  const [roots, setRoots] = useState<TreeNode[] | null>(null)
  const [children, setChildren] = useState<Record<string, TreeNode[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [serverHits, setServerHits] = useState<TreeNode[]>([])
  const [searching, setSearching] = useState(false)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [recent] = useState(() => loadRecentTargets(profileId))
  // Recent containers that no longer exist (deleted since) are not offered (M-12): one batched check.
  const [missingRecent, setMissingRecent] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    if (!recent.length) return
    let cancelled = false
    EntriesExist(profileId, recent)
      .then((checks) => {
        if (cancelled) return
        const gone = new Set(checks.filter((c) => !c.exists && !c.error).map((c) => normalizeDN(c.dn)))
        if (gone.size) setMissingRecent(gone)
      })
      .catch(() => { /* unknown: keep the chips */ })
    return () => {
      cancelled = true
    }
  }, [profileId, recent])
  const [status, setStatus] = useState<TargetStatus>({ dn: '', state: 'empty' })
  // DNs the server listed (tree, search hits): known to exist.
  const known = useRef(new Set<string>())
  const listRef = useRef<HTMLDivElement>(null)
  const statusId = `cp${useId().replace(/:/g, '')}-status`

  const remember = (nodes: TreeNode[]) => nodes.forEach((n) => known.current.add(normalizeDN(n.dn)))

  // One listing request per container (a failed one may be repeated).
  const pendingLoads = useRef(new Map<string, Promise<TreeNode[]>>())
  const loadChildren = useCallback((dn: string): Promise<TreeNode[]> => {
    const key = normalizeDN(dn)
    const pending = pendingLoads.current.get(key)
    if (pending) return pending
    setLoading((s) => new Set(s).add(key))
    const p = (async () => {
      try {
        const list = (await wails.GetChildren(profileId, dn)) ?? []
        remember(list)
        setChildren((c) => ({ ...c, [key]: list.filter(isContainerNode) }))
        return list
      } catch (err) {
        pendingLoads.current.delete(key)
        setLoadError(err instanceof Error ? err.message : String(err))
        return []
      } finally {
        setLoading((s) => {
          const n = new Set(s)
          n.delete(key)
          return n
        })
      }
    })()
    pendingLoads.current.set(key, p)
    return p
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId])

  // Roots; a single root is expanded.
  useEffect(() => {
    let cancelled = false
    pendingLoads.current.clear()
    wails.GetRootEntries(profileId).then(async (list) => {
      if (cancelled) return
      const r = list ?? []
      remember(r)
      setRoots(r)
      if (r.length === 1) {
        setExpanded((prev) => new Set(prev).add(normalizeDN(r[0].dn)))
        await loadChildren(r[0].dn)
      }
    }).catch((err) => !cancelled && setLoadError(err instanceof Error ? err.message : String(err)))
    return () => { cancelled = true }
  }, [profileId, loadChildren])

  // Expand down to revealDN (or the initial value), also when revealDN arrives
  // later (Restore to…: the nearest existing container is found after opening).
  const initialValue = useRef(value)
  const revealTarget = (revealDN || initialValue.current || '').trim()
  const revealedFor = useRef('')
  useEffect(() => {
    if (!roots || !revealTarget || revealedFor.current === normalizeDN(revealTarget)) return
    revealedFor.current = normalizeDN(revealTarget)
    const path = pathFromRoot(revealTarget, roots.map((n) => n.dn))
    if (path.length === 0) return
    let cancelled = false
    let done = false
    void (async () => {
      // Every ancestor is expanded; the target container itself stays collapsed.
      for (const dn of path.slice(0, -1)) {
        await loadChildren(dn)
        if (cancelled) return
        setExpanded((prev) => new Set(prev).add(normalizeDN(dn)))
      }
      done = true
      const key = normalizeDN(path[path.length - 1])
      setActiveKey(key)
      requestAnimationFrame(() => listRef.current?.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' }))
    })()
    return () => {
      cancelled = true
      // Interrupted (e.g. a StrictMode re-run): the next run reveals again.
      if (!done) revealedFor.current = ''
    }
  }, [roots, revealTarget, loadChildren])

  const toggle = useCallback((node: TreeNode) => {
    const key = normalizeDN(node.dn)
    const opening = !expanded.has(key)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (opening) next.add(key)
      else next.delete(key)
      return next
    })
    if (opening) void loadChildren(node.dn)
  }, [expanded, loadChildren])

  // Visible rows: the hierarchy, or (while filtering) the matching loaded
  // containers plus the server's hits.
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    if (!roots) return out
    if (filter.trim()) {
      const seen = new Set<string>()
      const add = (n: TreeNode) => {
        const key = normalizeDN(n.dn)
        if (seen.has(key) || !matchesContainerFilter(n.dn, filter)) return
        seen.add(key)
        out.push({ node: n, depth: 0, key })
      }
      roots.filter(isContainerNode).forEach(add)
      Object.values(children).flat().forEach(add)
      serverHits.forEach(add)
      return out
    }
    const walk = (list: TreeNode[], depth: number) => {
      for (const n of list) {
        const key = normalizeDN(n.dn)
        out.push({ node: n, depth, key })
        if (expanded.has(key) && children[key]) walk(children[key], depth + 1)
      }
    }
    walk(roots, 0)
    return out
  }, [roots, children, expanded, filter, serverHits])

  // Server search for containers by name while filtering (2+ characters).
  useEffect(() => {
    const q = filter.trim()
    if (q.length < 2 || !roots) {
      setServerHits([])
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      setSearching(true)
      try {
        const v = escapeFilterValue(q)
        const res = await wails.SearchLDAP(profileId, {
          baseDN: baseDN || roots[0]?.dn || '',
          scope: ScopeSub,
          filter: `(&(|(objectClass=organizationalUnit)(objectClass=container)(objectClass=organizationalRole)(objectClass=organization)(objectClass=builtinDomain))(|(ou=*${v}*)(cn=*${v}*)(o=*${v}*)))`,
          attributes: ['objectClass'],
          sizeLimit: SERVER_HITS,
          timeLimit: 5,
        })
        if (cancelled) return
        const hits: TreeNode[] = (res?.entries ?? []).map((e) => ({
          dn: e.dn,
          rdn: containerName(e.dn),
          hasChildren: true,
          objectClass: e.attributes?.find((a) => a.name.toLowerCase() === 'objectclass')?.values ?? [],
          icon: '',
        }))
        remember(hits)
        setServerHits(hits)
      } catch {
        if (!cancelled) setServerHits([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [filter, profileId, baseDN, roots])

  // Validity of the target: problems found locally, else the server's answer.
  useEffect(() => {
    const dn = value.trim()
    const set = (s: TargetStatus) => setStatus((prev) => (prev.dn === s.dn && prev.state === s.state && prev.message === s.message ? prev : s))
    if (!dn) return set({ dn, state: 'empty' })
    const problem = targetProblem(dn, moving ?? [])
    if (problem && problem !== 'empty') return set({ dn, state: 'problem', message: targetProblemText(problem, moving?.length ?? 0) })
    if (!looksLikeDN(dn)) return set({ dn, state: 'problem', message: 'Enter a DN such as OU=Sales,DC=example,DC=com, or pick a container above.' })
    if (known.current.has(normalizeDN(dn))) return set({ dn, state: 'ok' })
    set({ dn, state: 'checking' })
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const [check] = await EntriesExist(profileId, [dn])
        if (cancelled) return
        if (!check) set({ dn, state: 'error', message: 'The container could not be checked.' })
        else if (check.error) set({ dn, state: 'error', message: `The container could not be checked: ${check.error}` })
        else if (check.exists) {
          known.current.add(normalizeDN(dn))
          set({ dn, state: 'ok' })
        } else set({ dn, state: 'missing', message: 'No entry with this DN exists. Check the spelling or pick a container above.' })
      } catch (err) {
        if (!cancelled) set({ dn, state: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [value, profileId, moving])

  useEffect(() => { onStatusChange?.(status) }, [status, onStatusChange])

  const choose = (dn: string) => {
    if (disabled) return
    onChange(dn)
    setActiveKey(normalizeDN(dn))
  }

  const focusRow = (key: string | null) => {
    setActiveKey(key)
    if (!key) return
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
      el?.focus({ preventScroll: false })
    })
  }

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = rows.findIndex((r) => r.key === activeKey)
    const row = i >= 0 ? rows[i] : undefined
    const move = (to: number) => {
      e.preventDefault()
      if (rows.length) focusRow(rows[Math.max(0, Math.min(rows.length - 1, to))].key)
    }
    switch (e.key) {
      case 'ArrowDown': return move(i + 1)
      case 'ArrowUp':
        if (i <= 0 && inputRef?.current) {
          e.preventDefault()
          inputRef.current.focus()
          return
        }
        return move(i - 1)
      case 'Home': return move(0)
      case 'End': return move(rows.length - 1)
      case 'ArrowRight':
        if (row && !filter.trim()) {
          e.preventDefault()
          if (!expanded.has(row.key)) toggle(row.node)
          else if (children[row.key]?.length) focusRow(normalizeDN(children[row.key][0].dn))
        }
        return
      case 'ArrowLeft':
        if (row && !filter.trim()) {
          e.preventDefault()
          if (expanded.has(row.key)) toggle(row.node)
          else {
            const parent = normalizeDN(getParentDN(row.node.dn))
            if (rows.some((r) => r.key === parent)) focusRow(parent)
          }
        }
        return
      case ' ':
        if (row) {
          e.preventDefault()
          choose(row.node.dn)
        }
        return
      case 'Enter':
        // Enter picks the row; the dialog submits on the next Enter.
        if (row && normalizeDN(value) !== row.key) {
          e.preventDefault()
          e.stopPropagation()
          choose(row.node.dn)
        }
        return
    }
  }

  const onFilterKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && rows.length) {
      e.preventDefault()
      focusRow(rows.find((r) => r.key === activeKey)?.key ?? rows[0].key)
    } else if (e.key === 'Enter' && filter.trim() && rows.length === 1 && normalizeDN(value) !== rows[0].key) {
      e.preventDefault()
      e.stopPropagation()
      choose(rows[0].node.dn)
    }
  }

  const tabStop = activeKey && rows.some((r) => r.key === activeKey) ? activeKey : rows[0]?.key
  const selectedKey = normalizeDN(value)
  const extra: ContainerSuggestion[] = [
    ...(suggestions ?? []),
    ...offeredRecentTargets(recent, moving, missingRecent).filter((dn) => !(suggestions ?? []).some((s) => normalizeDN(s.dn) === normalizeDN(dn))).map((dn) => ({ dn })),
  ].slice(0, 8)

  return (
    <div className={cn('space-y-1.5', className)}>
      <SearchInput
        ref={inputRef}
        size="sm"
        value={filter}
        onValueChange={setFilter}
        onKeyDown={onFilterKeyDown}
        placeholder="Filter containers by name"
        aria-label="Filter containers"
        disabled={disabled}
      />
      {extra.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Suggested and recent containers">
          <History size={12} strokeWidth={1.75} aria-hidden className="text-muted-foreground shrink-0" />
          {extra.map((s) => (
            <Button
              key={s.dn}
              size="sm"
              variant={normalizeDN(s.dn) === selectedKey ? 'primary' : 'secondary'}
              onClick={() => choose(s.dn)}
              title={s.dn}
              disabled={disabled}
              className="max-w-[16rem] font-normal"
            >
              <span className="truncate">{s.label ? `${s.label}: ${containerName(s.dn)}` : containerName(s.dn)}</span>
            </Button>
          ))}
        </div>
      )}
      <div
        ref={listRef}
        role="tree"
        aria-label="Containers"
        onKeyDown={onListKeyDown}
        className="h-48 overflow-auto rounded border border-border bg-background py-0.5"
      >
        {!roots && !loadError && (
          <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground" role="status">
            <Spinner size="sm" decorative /> Loading containers…
          </div>
        )}
        {loadError && <div className="px-2 py-1 text-xs text-destructive">{loadError}</div>}
        {roots && rows.length === 0 && (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {filter.trim() ? (searching ? 'Searching…' : 'No container matches the filter.') : 'No containers.'}
          </div>
        )}
        {rows.map((r) => {
          const kind = resolveObjectKind(r.node.objectClass)
          const Icon = OBJECT_KIND_ICON[kind]
          const open = expanded.has(r.key)
          const selected = r.key === selectedKey
          const filtering = !!filter.trim()
          return (
            <div
              key={r.key}
              data-key={r.key}
              role="treeitem"
              aria-level={r.depth + 1}
              aria-selected={selected}
              aria-expanded={filtering || !r.node.hasChildren ? undefined : open}
              tabIndex={r.key === tabStop ? 0 : -1}
              onClick={() => choose(r.node.dn)}
              onDoubleClick={() => !filtering && r.node.hasChildren && toggle(r.node)}
              onFocus={() => setActiveKey(r.key)}
              className={cn(
                'flex items-center gap-1 h-row pr-2 text-sm cursor-default outline-hidden focus-ring-inset',
                selected ? 'row-selected' : 'hover:bg-accent',
              )}
              style={{ paddingLeft: 4 + r.depth * 14 }}
              title={r.node.dn}
            >
              {!filtering && r.node.hasChildren ? (
                <button type="button"
                  tabIndex={-1}
                  aria-label={open ? `Collapse ${containerName(r.node.dn)}` : `Expand ${containerName(r.node.dn)}`}
                  onClick={(e) => { e.stopPropagation(); toggle(r.node) }}
                  className="inline-flex items-center justify-center size-4 shrink-0 text-muted-foreground"
                >
                  {loading.has(r.key) ? <Spinner size="sm" decorative /> : open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
                </button>
              ) : (
                <span className="size-4 shrink-0" aria-hidden />
              )}
              <Icon size={14} strokeWidth={1.75} aria-hidden className={cn('shrink-0', OBJECT_KIND_COLOR[kind])} />
              <span className="truncate">{containerName(r.node.dn)}</span>
              {filtering && <span className="truncate text-xs text-muted-foreground font-mono">{getParentDN(r.node.dn)}</span>}
            </div>
          )
        })}
        {filter.trim().length >= 2 && searching && rows.length > 0 && (
          <div className="flex items-center gap-1.5 px-2 py-0.5 text-xs text-muted-foreground"><Spinner size="sm" decorative /> Searching the server…</div>
        )}
      </div>
      <Field
        label={label}
        required
        error={status.state === 'missing' || status.state === 'problem' || status.state === 'error' ? status.message : undefined}
      >
        <Input
          mono
          size="sm"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="OU=Users,DC=example,DC=com"
          disabled={disabled}
          aria-describedby={statusId}
          suffix={
            <span id={statusId} className="inline-flex items-center" aria-live="polite">
              {status.state === 'checking' && <Spinner size="sm" label="Checking the container" />}
              {status.state === 'ok' && <CircleCheck size={14} strokeWidth={1.75} className="text-success" aria-label="Container exists" />}
              {(status.state === 'missing' || status.state === 'error') && <CircleAlert size={14} strokeWidth={1.75} className="text-destructive" aria-label="Container not found" />}
            </span>
          }
        />
      </Field>
    </div>
  )
}
