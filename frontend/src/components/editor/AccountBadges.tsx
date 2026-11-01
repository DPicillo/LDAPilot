import { Lock, UserX, CalendarX } from 'lucide-react'
import type { AccountStatus } from '../../types/account'
import { getHeaderBadges, type AccountBadge as Badge, type BadgeTone } from '../../lib/accountActions'
import { Badge as UiBadge, type BadgeTone as UiBadgeTone } from '../ui/Badge'

/** Account badge tones on the design Badge (opaque *-subtle fills). */
const TONES: Record<BadgeTone, UiBadgeTone> = {
  ok: 'success',
  info: 'primary',
  warn: 'warning',
  danger: 'danger',
  muted: 'neutral',
};

/** One status badge of the account panel. */
export function AccountBadge({ badge, className }: { badge: Badge; className?: string }) {
  return (
    <UiBadge tone={TONES[badge.tone]} className={className} title={badge.title}>
      {badge.label}
    </UiBadge>
  );
}

const HEADER_ICONS: Record<string, React.ElementType> = {
  disabled: UserX,
  locked: Lock,
  expired: CalendarX,
};

/**
 * Compact badges for the entry editor header: only states that block logons
 * (disabled, locked, account expired). Clicking one opens the Account tab.
 */
export function AccountHeaderBadges({ status, onClick }: { status: AccountStatus | null | undefined; onClick?: () => void }) {
  const badges = getHeaderBadges(status);
  if (badges.length === 0) return null;
  return (
    <span className="flex items-center gap-1 shrink-0 ml-1">
      {badges.map(b => {
        const Icon = HEADER_ICONS[b.id] || Lock;
        return (
          <button type="button"
            key={b.id}
            onClick={onClick}
            className="inline-flex rounded-sm"
            title={`${b.title || b.label} - open the Account tab`}
          >
            <UiBadge tone={TONES[b.tone]} icon={<Icon size={12} strokeWidth={1.75} aria-hidden />}>{b.label}</UiBadge>
          </button>
        );
      })}
    </span>
  );
}
