import { useEffect, useState, type ReactNode } from 'react'
import { KeyRound, RectangleEllipsis, ShieldAlert, ShieldCheck, ShieldOff, TriangleAlert } from 'lucide-react'
import type { ConnectionProfile } from '../../types/ldap'
import type { EffectivePasswordPolicy } from '../../types/passwordPolicy'
import { profileSecurity } from '../../lib/connectionAuth'
import { GetPasswordPolicy } from '../../lib/wails-pwpolicy'
import { policyShortLabel } from '../../lib/passwordPolicy'
import { useAuthEnvironment } from '../../stores/authEnvStore'
import { cn } from '../../lib/utils'
import { ensureServerType } from '../ui/commands'
import { Tooltip } from '../ui/Tooltip'

/**
 * The chip's root: a button (keyboard reachable, tooltip on hover and focus)
 * when `onActivate` is given, else a span with a native title (old use).
 */
function ChipRoot({ title, label, onActivate, className, children }: { title: string; label: string; onActivate?: () => void; className?: string; children: ReactNode }) {
  if (!onActivate) {
    return (
      <span className={cn('inline-flex items-center gap-1 whitespace-nowrap', className)} title={title}>
        {children}
      </span>
    );
  }
  return (
    <Tooltip content={<span className="whitespace-pre-line">{title}</span>} placement="top">
      <button type="button" onClick={onActivate} aria-label={label} className={cn('inline-flex items-center gap-1 whitespace-nowrap', className)}>
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * Auth method and TLS trust of the active connection, compact for the status
 * bar (StatusBar.tsx): it inherits the bar's text colour at full strength
 * (no opacity, SPEC 7.8); a weak setup (plain LDAP with credentials,
 * certificate not verified) adds a warning glyph instead of a tinted chip,
 * which would lose contrast on the coloured bar. The tooltip and the
 * screen-reader text have the details, e.g. "NTLM as EXAMPLE\alice /
 * LDAPS, certificate pinned (1)". With `onActivate` it is a button (the
 * status bar opens Edit Connection at TLS trust).
 */
export function ConnectionSecurityStatus({ profile, className, onActivate }: { profile: ConnectionProfile; className?: string; onActivate?: () => void }) {
  const env = useAuthEnvironment();
  const sec = profileSecurity(profile, env);
  const TransportIcon = sec.trustMode === 'plain' ? ShieldOff : sec.trustMode === 'skip' ? ShieldAlert : ShieldCheck;
  const transport = sec.trustMode === 'plain' ? 'Plain' : sec.transport;
  const label = `Connection security${sec.tone === 'warning' ? ' (weak)' : ''}: ${sec.title.replace(/\n/g, '; ')}${onActivate ? '. Edit TLS trust and authentication' : ''}`;
  return (
    <ChipRoot title={onActivate ? `${sec.title}\nClick to edit TLS trust and authentication` : sec.title} label={label} onActivate={onActivate} className={className}>
      {sec.tone === 'warning' && <TriangleAlert size={12} strokeWidth={1.75} aria-hidden />}
      <KeyRound size={12} strokeWidth={1.75} aria-hidden />
      <span aria-hidden>{sec.auth}</span>
      <TransportIcon size={12} strokeWidth={1.75} aria-hidden className="ml-1" />
      <span aria-hidden>
        {transport}
        {sec.trust && ` (${sec.trust})`}
      </span>
      {!onActivate && <span className="sr-only">{label}</span>}
    </ChipRoot>
  );
}

const POLICY_SHORT: Record<string, string> = { client: 'client hashing', server: 'server hashing', ask: 'ask' };

/**
 * The connection's password storage policy (issue #1) in the status bar:
 * how userPassword values are stored (client-side hash, server-side, ask on
 * every write). Hidden on AD, where userPassword is left to the server and
 * passwords are set with unicodePwd: there it is not read at all (the
 * cached RootDSE server type decides first). Read again when the profile
 * changes (Connection dialog ▸ Password storage) or the connection is
 * re-established; the backend caches the server probe per connection and
 * does not log the cn=config read. With `onActivate` it is a button (the
 * status bar opens Edit Connection at Password storage).
 */
export function PasswordStorageStatus({ profile, connected, className, onActivate }: { profile: ConnectionProfile; connected: boolean; className?: string; onActivate?: () => void }) {
  const [eff, setEff] = useState<EffectivePasswordPolicy | null>(null);
  useEffect(() => {
    if (!connected) {
      setEff(null);
      return;
    }
    let cancelled = false;
    ensureServerType(profile.id)
      .then((type) => (cancelled || type === 'ad' ? null : GetPasswordPolicy(profile.id)))
      .then((p) => !cancelled && setEff(p))
      .catch(() => !cancelled && setEff(null));
    return () => { cancelled = true; };
  }, [profile.id, profile.passwordPolicy, profile.passwordScheme, profile.tlsMode, connected]);

  if (!eff || eff.policy === 'ad') return null;
  const short = POLICY_SHORT[eff.policy] ?? eff.policy;
  const warn = eff.warnings.length > 0 || (eff.policy === 'server' && !eff.serverHashes && !eff.passwordModifyExop);
  const title = [
    `Password storage: ${policyShortLabel(eff)}${eff.source === 'profile' ? '' : ' (default for this server)'}`,
    eff.summary,
    ...eff.warnings,
  ].filter(Boolean).join('\n');
  // One period between the sentences (RW1-C-13 / RW1-P-05).
  const label = `${title.replace(/\n/g, '; ').replace(/[.\s]+$/, '')}${onActivate ? '. Edit the password storage setting' : ''}`;
  return (
    <ChipRoot title={onActivate ? `${title}\nClick to change the password storage setting` : title} label={label} onActivate={onActivate} className={className}>
      {warn ? <TriangleAlert size={12} strokeWidth={1.75} aria-hidden /> : <RectangleEllipsis size={12} strokeWidth={1.75} aria-hidden />}
      <span aria-hidden>{short}</span>
      {!onActivate && <span className="sr-only">{label}</span>}
    </ChipRoot>
  );
}
