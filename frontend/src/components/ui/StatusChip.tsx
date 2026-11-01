import { CalendarX, CircleArrowDown, Clock, Eye, History, Infinity as InfinityIcon, KeyRound, Lock } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Badge, type BadgeTone } from './Badge'
import { Tooltip } from './Tooltip'
import type { IconType } from './Button'
import { formatDateTime, formatRelative, type AccountStatus, type AccountStatusKind } from './accountStatus'

const META: Record<AccountStatusKind, { icon: IconType; tone: BadgeTone; label: string }> = {
  disabled: { icon: CircleArrowDown, tone: 'neutral', label: 'Disabled' },
  locked: { icon: Lock, tone: 'warning', label: 'Locked out' },
  expired: { icon: CalendarX, tone: 'danger', label: 'Account expired' },
  expiresSoon: { icon: Clock, tone: 'warning', label: 'Expires soon' },
  pwdExpired: { icon: KeyRound, tone: 'danger', label: 'Password expired' },
  mustChange: { icon: KeyRound, tone: 'warning', label: 'Must change password' },
  pwdNeverExpires: { icon: InfinityIcon, tone: 'neutral', label: 'Password never expires' },
  stale: { icon: History, tone: 'neutral', label: 'Inactive 90+ days' },
  readOnly: { icon: Eye, tone: 'neutral', label: 'Read-only' },
}

export interface StatusChipProps {
  kind?: AccountStatusKind
  /** A derived status (deriveAccountStatus); supplies kind, label, dates and source. */
  status?: AccountStatus
  label?: string
  since?: Date
  until?: Date
  source?: { attribute: string; raw: string }
  size?: 'sm' | 'md'
  /** Glyph only (the label becomes the accessible name and tooltip). */
  iconOnly?: boolean
  now?: Date
  /** Make the chip a tab stop so keyboard users get the tooltip (default off in dense rows). */
  focusable?: boolean
  /** Lists and palette rows: label only; the dates move into the tooltip. */
  compact?: boolean
  /** Makes the chip a button (the editor header opens the Account tab, ED-11). */
  onClick?: () => void
  /** Accessible name of the button (default: "<label> – show details"). */
  actionLabel?: string
  className?: string
}

/**
 * Account state chip: glyph + text, never colour alone. `since` renders
 * "Locked out since 2026-10-29 20:59 (2 h ago)"; the tooltip names the
 * source attribute and its raw value.
 */
export function StatusChip({ kind, status, label, since, until, source, size = 'sm', iconOnly, now, focusable, compact, onClick, actionLabel, className }: StatusChipProps) {
  const k = (status?.kind ?? kind ?? 'disabled') as AccountStatusKind
  const meta = META[k]
  const base = label ?? status?.label ?? meta.label
  const s = since ?? status?.since
  const u = until ?? status?.until
  const src = source ?? status?.source
  const long = s && (k === 'locked' || k === 'disabled') ? `${base} since ${formatDateTime(s)} (${formatRelative(s, now)})` : base
  const text = compact ? base : long
  const tip = [
    // Compact chips may be cut at a narrow column edge: the tooltip always names the state.
    long !== base || iconOnly || compact ? long : null,
    s && k !== 'locked' && k !== 'disabled' ? `Since ${formatDateTime(s)} (${formatRelative(s, now)})` : null,
    u ? `Until ${formatDateTime(u)} (${formatRelative(u, now)})` : null,
    src ? `${src.attribute}: ${src.raw}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  const srDates = [s ? `from ${formatDateTime(s)} (${formatRelative(s, now)})` : null, u ? `until ${formatDateTime(u)} (${formatRelative(u, now)})` : null]
    .filter(Boolean)
    .join(', ')
  const chip = (
    <Badge
      tone={meta.tone}
      size={size}
      icon={meta.icon}
      className={cn(iconOnly && 'px-1', compact && 'max-w-full min-w-0', !onClick && className /* a clickable chip: on its button */)}
      aria-label={iconOnly ? long : undefined}
      role={iconOnly ? 'img' : undefined}
      tabIndex={focusable && !onClick ? 0 : undefined}
    >
      {!iconOnly && (compact ? <span className="truncate min-w-0">{text}</span> : text)}
      {/* Compact chips move the dates into the tooltip; keep them readable for screen readers
          (not the raw source value: a FILETIME read aloud is noise). */}
      {compact && !iconOnly && srDates && <span className="sr-only">, {srDates}</span>}
    </Badge>
  )
  const trigger = onClick ? (
    <button type="button"
      onClick={onClick}
      aria-label={actionLabel ?? `${long} – show details`}
      className={cn(
        'inline-flex rounded-sm cursor-pointer focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-1',
        className,
      )}
    >
      {chip}
    </button>
  ) : chip
  if (!tip) return trigger
  return (
    <Tooltip content={<span className="whitespace-pre-line">{tip}</span>}>
      {trigger}
    </Tooltip>
  )
}

export const STATUS_META = META
