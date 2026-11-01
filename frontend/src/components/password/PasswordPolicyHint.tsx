import { useEffect, useState } from 'react'
import { AlertTriangle, KeyRound } from 'lucide-react'
import { GetPasswordPolicy } from '../../lib/wails-pwpolicy'
import { policyNotices } from '../../lib/passwordPolicy'
import type { EffectivePasswordPolicy } from '../../types/passwordPolicy'
import { cn } from '../../lib/utils'

/** The effective password storage policy of a connected profile (null while loading or unavailable). */
export function usePasswordPolicy(profileId: string | null | undefined, enabled = true): EffectivePasswordPolicy | null {
  const [policy, setPolicy] = useState<EffectivePasswordPolicy | null>(null);
  useEffect(() => {
    if (!profileId || !enabled) return;
    let cancelled = false;
    GetPasswordPolicy(profileId).then(
      (p) => { if (!cancelled) setPolicy(p); },
      () => { if (!cancelled) setPolicy(null); },
    );
    return () => { cancelled = true; };
  }, [profileId, enabled]);
  return policy;
}

/**
 * How a userPassword value typed here will be stored (connection's password
 * storage policy), shown below password fields of the write paths. asIs:
 * the values are stored exactly as given (LDIF opt-out), the policy does
 * not apply.
 */
export function PasswordPolicyHint({ profileId, asIs = false, className }: { profileId: string | null | undefined; asIs?: boolean; className?: string }) {
  const policy = usePasswordPolicy(profileId);
  if (!policy) return null;
  return (
    <div className={cn('space-y-0.5 text-xs leading-snug', className)}>
      {policyNotices(policy, { asIs }).map((n, i) => (
        <div key={i} className={cn('flex items-start gap-1', n.level === 'warning' ? 'text-warning' : 'text-muted-foreground')}>
          {n.level === 'warning' ? <AlertTriangle size={12} strokeWidth={1.75} aria-hidden className="mt-px shrink-0" /> : <KeyRound size={12} strokeWidth={1.75} aria-hidden className="mt-px shrink-0" />}
          <span>{n.text}</span>
        </div>
      ))}
    </div>
  );
}
