/**
 * Saved connection profiles as compact rows (SPEC 7.4 / 7.5): Enter or
 * double-click connects, single click selects. role=listbox with
 * aria-activedescendant, type-ahead (a blank inside a burst is part of the
 * name); the last used profile comes first and is preselected - never the
 * alphabetically first one (that may be a production directory): without a
 * last used / active profile nothing is preselected and Enter does nothing
 * until a row is chosen. The name always wins over the "Last used" badge.
 * Profiles with the same name are told apart by host:port.
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { cn } from '../../lib/utils'
import { useConnectionStore } from '../../stores/connectionStore'
import { Badge } from '../ui/Badge'
import { Kbd } from '../ui/Kbd'
import { Spinner } from '../ui/Spinner'
import { domId } from '../ui/dn'
import { connectProfile, useShellState } from './shellState'
import { preselectedProfileId, typeAheadKey, typeAheadMatch } from '../connection/profileLogic'

export interface ProfileListProps {
  'aria-label'?: string
  className?: string
  /** Max rows before the list scrolls (default: all). */
  maxRows?: number
  /** Show the Explorer after connecting (default true). */
  reveal?: boolean
}

export function ProfileList({ className, maxRows, reveal = true, ...aria }: ProfileListProps) {
  const profiles = useConnectionStore((s) => s.profiles)
  const statuses = useConnectionStore((s) => s.connectionStatuses)
  const activeProfileId = useConnectionStore((s) => s.activeProfileId)
  const connectingId = useShellState((s) => s.connectingId)
  const lastUsedId = useShellState((s) => s.lastUsedProfileId)
  const listId = `pl${useId().replace(/:/g, '')}`
  const ta = useRef({ buf: '', t: 0 })

  const sorted = useMemo(() => {
    const list = [...profiles].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    const i = list.findIndex((p) => p.id === lastUsedId)
    if (i > 0) list.unshift(...list.splice(i, 1))
    return list
  }, [profiles, lastUsedId])

  const [active, setActive] = useState<string | null>(null)
  const activeKey = active && sorted.some((p) => p.id === active) ? active : preselectedProfileId(sorted.map((p) => p.id), lastUsedId, activeProfileId)
  const optionId = (id: string) => `${listId}-${domId(id)}`

  const move = (key: string) => {
    if (!sorted.length) return false
    const idx = activeKey ? sorted.findIndex((p) => p.id === activeKey) : -1
    let n: number
    switch (key) {
      case 'ArrowDown':
        n = Math.min(sorted.length - 1, idx + 1)
        break
      case 'ArrowUp':
        n = Math.max(0, idx < 0 ? 0 : idx - 1)
        break
      case 'Home':
        n = 0
        break
      case 'End':
        n = sorted.length - 1
        break
      default:
        return false
    }
    const id = sorted[n].id
    setActive(id)
    document.getElementById(optionId(id))?.scrollIntoView({ block: 'nearest' })
    return true
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (move(e.key)) {
      e.preventDefault()
      return
    }
    if (e.key === 'Enter' && activeKey) {
      e.preventDefault()
      void connectProfile(activeKey, { reveal })
      return
    }
    const next = typeAheadKey(ta.current, e.key, Date.now())
    if (next.consumed) {
      e.preventDefault()
      ta.current = next.state
      const cur = activeKey ? sorted.findIndex((p) => p.id === activeKey) : -1
      const hit = typeAheadMatch(sorted.map((p) => p.name), next.state.buf, cur)
      if (hit >= 0) {
        setActive(sorted[hit].id)
        document.getElementById(optionId(sorted[hit].id))?.scrollIntoView({ block: 'nearest' })
      }
    }
  }

  if (!sorted.length) return null

  return (
    <div
      role="listbox"
      tabIndex={0}
      aria-label={aria['aria-label'] ?? 'Saved connections'}
      aria-activedescendant={activeKey ? optionId(activeKey) : undefined}
      onKeyDown={onKeyDown}
      // Focus: a 2px frame on the list itself plus the inset ring on the active option.
      className={cn('group/pl py-1 overflow-y-auto rounded border border-border bg-card focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-1', className)}
      style={maxRows ? { maxHeight: maxRows * 28 + 8 } : undefined}
    >
      {sorted.map((p) => {
        const connected = statuses[p.id] === true
        const isActive = p.id === activeKey
        const connecting = connectingId === p.id
        return (
          <div
            key={p.id}
            id={optionId(p.id)}
            role="option"
            aria-selected={isActive}
            title={`${p.name} (${p.host}:${p.port})${p.baseDN ? `\n${p.baseDN}` : ''}`}
            onClick={() => setActive(p.id)}
            onDoubleClick={() => void connectProfile(p.id, { reveal })}
            className={cn(
              'flex items-center gap-2 h-7 mx-1 px-2 rounded-sm text-sm cursor-default select-none',
              isActive ? 'bg-accent' : 'hover:bg-accent',
              isActive && 'group-focus-visible/pl:outline-2 group-focus-visible/pl:outline-focus group-focus-visible/pl:-outline-offset-2',
            )}
          >
            <span
              aria-hidden
              className={cn('size-2 rounded-full shrink-0', connected ? 'bg-success' : 'border border-border-strong')}
            />
            <span className="sr-only">{connected ? 'Connected: ' : ''}</span>
            {/* The name shrinks last (shrink 0, capped at the row); badges and host give way first. */}
            <span className="shrink-0 max-w-full truncate font-medium text-foreground">{p.name}</span>
            {p.id === lastUsedId && (
              <span className="min-w-0 overflow-hidden shrink">
                <Badge size="sm" tone="neutral">
                  Last used
                </Badge>
              </span>
            )}
            {p.readOnly && (
              <span className="min-w-0 overflow-hidden shrink">
                <Badge size="sm" tone="warning">
                  Read-only
                </Badge>
              </span>
            )}
            <span className="ml-auto pl-2 min-w-0 truncate text-xs text-muted-foreground font-mono tabular-nums shrink-[100]">
              {p.host}:{p.port}
            </span>
            {connecting ? (
              <Spinner size="sm" label={`Connecting to ${p.name}`} />
            ) : (
              isActive && <Kbd className="shrink-0 hidden group-focus-visible/pl:inline-flex">Enter</Kbd>
            )}
          </div>
        )
      })}
    </div>
  )
}
