import { useState } from 'react'
import { Eye, EyeOff, ShieldAlert } from 'lucide-react'
import { PASSWORD_MASK, passwordSchemeBadge } from '../../lib/passwordPolicy'
import { cn } from '../../lib/utils'
import { Badge } from '../ui/Badge'
import { IconButton } from '../ui/Button'

/**
 * Scheme badge of a stored userPassword value: '{SSHA}', '{CRYPT}$6$', … or a
 * red "cleartext" badge when the value has no storage scheme. Shows no
 * part of the value.
 */
export function PasswordSchemeBadge({ value, binary = false, className }: { value: string; binary?: boolean; className?: string }) {
  const badge = passwordSchemeBadge(value, binary);
  if (!badge) return null;
  return (
    <Badge
      tone={badge.cleartext ? 'danger' : 'neutral'}
      icon={badge.cleartext ? ShieldAlert : undefined}
      className={cn('font-mono shrink-0', badge.cleartext && 'font-semibold', className)}
      title={badge.title}
    >
      {badge.text}
    </Badge>
  );
}

/**
 * The values of a userPassword attribute: masked, each with its scheme
 * badge; "show" reveals the stored values (hashes, or a cleartext password).
 */
export function MaskedPasswordValues({ values, binary = false }: { values: string[]; binary?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex flex-col gap-0.5 font-mono">
      {values.map((v, i) => (
        <div key={i} className="flex items-center gap-1 min-w-0">
          <PasswordSchemeBadge value={v} binary={binary} />
          {show ? (
            <span className="break-all">{binary ? `<${v.length} base64 characters>` : v}</span>
          ) : (
            <span className="text-muted-foreground">{PASSWORD_MASK}</span>
          )}
          {i === 0 && (
            <IconButton size="sm" label={show ? 'Hide stored values' : 'Show stored values'} icon={show ? EyeOff : Eye} pressed={show} onClick={() => setShow(!show)} />
          )}
        </div>
      ))}
    </div>
  );
}
