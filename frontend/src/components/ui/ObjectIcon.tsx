import { CircleArrowDown, Clock, Lock } from 'lucide-react'
import { cn } from '../../lib/utils'
import { OBJECT_KIND_COLOR, OBJECT_KIND_ICON, resolveObjectKind, type ObjectKind } from './objectKind'
import { primaryStatus, type AccountStatus, type AccountStatusKind } from './accountStatus'

export interface ObjectIconProps {
  objectClass?: readonly string[]
  /** Skip resolving when the kind is already known. */
  kind?: ObjectKind
  /** Account state; disabled / locked / expired add the overlay glyph. */
  status?: AccountStatusKind | readonly (AccountStatus | AccountStatusKind)[]
  size?: 14 | 16 | 32 | 40
  className?: string
}

const OVERLAY: Partial<Record<AccountStatusKind, { Icon: typeof Lock; cls: string; text: string }>> = {
  disabled: { Icon: CircleArrowDown, cls: 'text-status-disabled', text: 'disabled' },
  locked: { Icon: Lock, cls: 'text-status-locked', text: 'locked out' },
  expired: { Icon: Clock, cls: 'text-status-expired', text: 'expired' },
}

/**
 * Object-class icon in its text-oc-* colour, with an optional status overlay
 * (9px glyph bottom-right, 1px ring in the row background) plus sr-only text,
 * so status is never colour alone. Set `--row-bg` on the row to match the ring.
 */
export function ObjectIcon({ objectClass, kind, status, size = 14, className }: ObjectIconProps) {
  const k = kind ?? resolveObjectKind(objectClass)
  const Icon = OBJECT_KIND_ICON[k]
  const st = typeof status === 'string' ? status : primaryStatus(status)
  const ov = st ? OVERLAY[st] : undefined
  const ovPx = size >= 32 ? 14 : 9
  return (
    <span className={cn('relative inline-flex shrink-0', OBJECT_KIND_COLOR[k], className)} style={{ width: size, height: size }}>
      <Icon size={size} strokeWidth={1.75} aria-hidden />
      {ov && (
        <>
          <span
            aria-hidden
            className={cn('absolute -right-0.5 -bottom-0.5 inline-flex rounded-full', ov.cls)}
            style={{ background: 'var(--row-bg, var(--color-background))', boxShadow: '0 0 0 1px var(--row-bg, var(--color-background))' }}
          >
            <ov.Icon size={ovPx} strokeWidth={2.25} />
          </span>
          <span className="sr-only">({ov.text})</span>
        </>
      )}
    </span>
  )
}
