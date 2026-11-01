import type { KeyboardEvent, MouseEvent, Ref } from 'react'
import { CircleAlert, KeyRound, Lock, LockOpen, MoreHorizontal, Pencil, Plug, ShieldAlert, Unplug } from 'lucide-react'
import type { ConnectionProfile } from '../../types/ldap'
import { cn } from '../../lib/utils'
import { profileSecurity } from '../../lib/connectionAuth'
import { useAuthEnvironment } from '../../stores/authEnvStore'
import { Badge } from '../ui/Badge'
import { IconButton } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import { TruncatedText } from '../ui/TruncatedText'

interface ConnectionCardProps {
  profile: ConnectionProfile
  isConnected: boolean
  /** The active profile (the one the tree, menus and searches use). */
  isActive: boolean
  /** Part of the list's selection (the active row, or a Ctrl/Shift multi-selection, DEF-02). */
  isSelected?: boolean
  isConnecting: boolean
  /** The last connect attempt failed with this message (error mark on the row). */
  connectError?: string
  /** Roving tab stop of the list. */
  tabStop: boolean
  /** The list owns focus (selected look vs. inactive look). */
  listFocused: boolean
  id: string
  rowRef?: Ref<HTMLDivElement>
  onConnect: () => void
  onDisconnect: () => void
  onEdit: () => void
  onDelete: () => void
  onClone: () => void
  /** Click: the modifier keys pick plain / Ctrl (toggle) / Shift (range) selection. */
  onSelect: (e: MouseEvent) => void
  onFocus: () => void
  onContextMenu: (e: MouseEvent) => void
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void
}

/**
 * One saved connection as a compact row (SPEC UX-18): status dot (spinner
 * while connecting, red mark after a failed connect), name, the base DN
 * ("all naming contexts" when empty: tells profiles of one server apart),
 * then host:port, read-only badge and the security summary on one line (the
 * host truncates first, the chips keep their text). Double-click or Enter
 * connects.
 * Small icon actions sit at the right end of the name line only (they never
 * cover the row's middle, the double-click target): Connect/Disconnect on
 * hover, focus and the active profile; Edit and More (Clone, Delete: the
 * context menu) on hover and focus (and F2 / Del).
 */
export function ConnectionCard({
  profile,
  isConnected,
  isActive,
  isSelected = isActive,
  isConnecting,
  connectError,
  tabStop,
  listFocused,
  id,
  rowRef,
  onConnect,
  onDisconnect,
  onEdit,
  onSelect,
  onFocus,
  onContextMenu,
  onKeyDown,
}: ConnectionCardProps) {
  const name = profile.name || 'Unnamed'
  const env = useAuthEnvironment()
  const sec = profileSecurity(profile, env)
  const secText = `${sec.auth}, ${sec.transport}${sec.trust ? ` · ${sec.trust}` : ''}`
  return (
    <div
      ref={rowRef}
      id={id}
      role="option"
      aria-selected={isSelected}
      aria-label={`${name}, ${profile.baseDN || 'all naming contexts'}, ${profile.host}:${profile.port}${isConnecting ? ', connecting' : isConnected ? ', connected' : connectError ? ', last connect failed' : ''}${profile.readOnly ? ', read-only' : ''}${isActive && !isSelected ? ', active' : ''}, ${secText}`}
      tabIndex={tabStop ? 0 : -1}
      // Showing the Connections panel (Ctrl+Shift+C) focuses the list's tab stop.
      data-panel-autofocus={tabStop ? '' : undefined}
      onClick={(e) => onSelect(e)}
      onDoubleClick={onConnect}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(e)
      }}
      className={cn(
        'group relative flex flex-col justify-center px-2 py-0.5 rounded-sm cursor-default select-none outline-hidden focus-ring-inset',
        isSelected ? (listFocused ? 'row-selected' : 'row-selected-inactive') : 'hover:bg-accent',
      )}
    >
      <div className="flex items-center gap-2 min-w-0 h-5">
        <span className="size-3 flex items-center justify-center shrink-0" aria-hidden>
          {isConnecting ? (
            <Spinner size="sm" decorative />
          ) : connectError && !isConnected ? (
            <span title={`Last connect failed: ${connectError}`} className="flex">
              <CircleAlert size={12} strokeWidth={2} className="text-destructive" />
            </span>
          ) : (
            <span className={cn('size-2 rounded-full', isConnected ? 'bg-success' : 'border border-border-strong')} />
          )}
        </span>
        <TruncatedText text={name} className="text-sm font-medium text-foreground flex-1" />
        {/* Icon actions at the right end of the name line (about 64px; the row's middle stays the
            select / double-click-to-connect target): on hover and focus; Connect/Disconnect also
            on the active row. A double-click on them does not connect twice. */}
        {/* While connecting the status dot shows the spinner; no actions then. */}
        {!isConnecting && (
        <span
          className={cn('items-center gap-0.5 shrink-0 -mr-1', isActive ? 'flex' : 'hidden group-hover:flex group-focus-within:flex')}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <span className={cn('items-center gap-0.5', isActive ? 'hidden group-hover:flex group-focus-within:flex' : 'flex')}>
            <IconButton label="Edit…" shortcut="F2" icon={Pencil} size="sm" tabIndex={-1} onClick={(e) => { e.stopPropagation(); onEdit() }} />
            <IconButton
              label="More actions (Clone, Delete…)"
              icon={MoreHorizontal}
              size="sm"
              tabIndex={-1}
              aria-haspopup="menu"
              onClick={(e) => { e.stopPropagation(); onContextMenu(e) }}
            />
          </span>
          {isConnected ? (
            <IconButton label="Disconnect" icon={Unplug} size="sm" tabIndex={-1} onClick={(e) => { e.stopPropagation(); onDisconnect() }} />
          ) : (
            <IconButton label="Connect" icon={Plug} size="sm" tabIndex={-1} className="text-primary" onClick={(e) => { e.stopPropagation(); onConnect() }} />
          )}
        </span>
        )}
      </div>
      {/* Base DN: profiles of the same server differ here. */}
      <div className="min-w-0 pl-5 text-xs text-muted-foreground">
        {profile.baseDN.trim() ? (
          <TruncatedText text={profile.baseDN} className="font-mono" />
        ) : (
          <span className="italic">all naming contexts</span>
        )}
      </div>
      {/* The host keeps its text; the security chips give up their room first (RW1-C-06). */}
      <div className="flex items-center gap-x-2 min-w-0 pl-5 text-xs text-muted-foreground">
        <TruncatedText text={`${profile.host}:${profile.port}`} className="font-mono tabular-nums min-w-[4ch]" />
        {profile.readOnly && (
          <Badge size="sm" tone="warning" className="shrink-0">
            Read-only
          </Badge>
        )}
        <SecurityBadges profile={profile} compact className="min-w-0 ml-auto shrink-[100]" />
      </div>
    </div>
  )
}

/** Auth method and transport security of a profile, compact (the tooltip has the details). */
export function SecurityBadges({ profile, compact, className }: { profile: ConnectionProfile; compact?: boolean; className?: string }) {
  const env = useAuthEnvironment()
  const sec = profileSecurity(profile, env)
  const TransportIcon = sec.trustMode === 'plain' ? LockOpen : sec.trustMode === 'skip' ? ShieldAlert : Lock
  // Compact (the narrow Connections list, RW1-C-06): no chip for the default simple bind,
  // the transport word only; the warning icon and the tooltip carry the trust details.
  const showAuth = !compact || !/^simple/i.test(sec.auth)
  return (
    <span className={cn('inline-flex items-center gap-1 min-w-0 text-xs overflow-hidden', className)} title={sec.title}>
      {showAuth && (
        <>
          <KeyRound size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
          {/* Compact: the key icon alone (the tooltip names the method), so "Anonymous" never truncates the row (RW1-C-06). */}
          <span className={compact ? 'sr-only' : 'truncate'}>{sec.auth}</span>
        </>
      )}
      <TransportIcon size={12} strokeWidth={1.75} aria-hidden className={cn('shrink-0', showAuth && 'ml-1', sec.tone === 'warning' && 'text-warning')} />
      <span className={cn(compact ? 'shrink-0 whitespace-nowrap' : 'truncate', sec.tone === 'warning' && 'text-warning')}>
        {sec.transport}
        {!compact && sec.trust && ` · ${sec.trust}`}
      </span>
    </span>
  )
}
