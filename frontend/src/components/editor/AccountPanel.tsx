import { useEffect, useState } from 'react'
import {
  RefreshCw, Loader2, Unlock, UserCheck, UserX, KeyRound, CalendarClock, ShieldAlert, AlertTriangle,
  Info, Timer, LogIn, ShieldCheck,
} from 'lucide-react'
import type { AccountStatus } from '../../types/account'
import type { AccountStatusState } from './useAccountStatus'
import {
  accountDisplayName, disableConfirmText, getAccountActions, getAccountBadges, describePolicy, policySourceLabel, planAccountExpiration,
  type ActionState,
} from '../../lib/accountActions'
import { formatAccountExpiry, formatDateTime, formatRelative, localDayEndingAt } from '../../lib/accountTime'
import { formatUac, uacFlagNames } from '../../lib/uac'
import {
  UnlockAccount, SetAccountEnabled, SetMustChangePassword, SetPasswordNeverExpires, SetAccountExpiration, errorMessage,
} from '../../lib/wails-account'
import { cn } from '../../lib/utils'
import type { IconType } from '../ui/Button'
import { toast } from '../ui/Toast'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { PasswordDialog } from './PasswordDialog'
import { UacFlagsDialog } from './UacFlagsDialog'
import { AccountBadge } from './AccountBadges'
import { Button, IconButton } from '../ui/Button'
import { Input } from '../ui/Input'
import { InlineAlert } from '../ui/InlineAlert'
import { Spinner } from '../ui/Spinner'
import { EmptyState } from '../ui/EmptyState'
import { Tooltip } from '../ui/Tooltip'
import { afterAccountChange } from '../commands/accountState'

interface AccountPanelProps {
  profileId: string;
  dn: string;
  /** Writes are off: true (read-only connection) or the reason (connection lost). */
  readOnly: boolean | string;
  account: AccountStatusState;
  /** Reloads the entry after a change (which reloads the account status). */
  onChanged: () => Promise<void> | void;
}

interface PendingConfirm {
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  variant: 'danger' | 'warning' | 'default';
  run: () => void;
}

/** Account status and account actions of a user / computer entry. */
export function AccountPanel({ profileId, dn, readOnly, account, onChanged }: AccountPanelProps) {
  const { status, loading, error, reload } = account;
  const name = accountDisplayName(dn);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showUac, setShowUac] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // Relative times ("in 5 min") stay current.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { setNow(new Date()); }, [status]);

  async function run(id: string, successMessage: string, fn: () => Promise<void>) {
    setBusy(id);
    try {
      await fn();
      toast.success(successMessage);
      // One status read the views share; they get it with the event (RW1-P-06).
      void afterAccountChange(profileId, dn);
      try {
        await onChanged();
      } catch {
        reload();
      }
    } catch (err) {
      toast.error(errorMessage(err, 'The account action failed'));
      reload();
    } finally {
      setBusy(null);
    }
  }

  if (!status) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-muted-foreground text-sm p-4">
        {loading ? (
          <div className="flex items-center gap-2" role="status"><Spinner size="md" decorative /><span>Reading account status…</span></div>
        ) : error ? (
          <InlineAlert
            tone="danger"
            title="The account status could not be read"
            body={<span className="break-words">{error}</span>}
            actions={<Button size="sm" variant="secondary" leftIcon={RefreshCw} onClick={reload}>Retry</Button>}
            className="max-w-[90%]"
          />
        ) : (
          <EmptyState variant="inline" title="No account status available" />
        )}
      </div>
    );
  }

  if (!status.applicable) {
    return (
      <EmptyState icon={Info} title="No account status" hint={status.reason || 'This entry has no account status.'} />
    );
  }

  const actions = getAccountActions(status, readOnly);
  const badges = getAccountBadges(status, now);
  const isAD = status.serverType === 'ad';
  const disabledAll = busy !== null;
  // The password dialog takes this tab's connection (not necessarily the active one).
  const passwordReset: ActionState = actions.resetPassword;
  // Unlock lives in the locked banner; the Lockout row only offers clearing recorded failures (OpenLDAP / 389DS).
  const clearFailures: ActionState = status.locked ? { enabled: false, blockedBy: 'state' } : actions.unlock;

  function askDisable() {
    const text = disableConfirmText(dn);
    setConfirm({
      ...text,
      detail: dn,
      variant: 'warning',
      run: () => run('toggleEnabled', `${name} disabled`, () => SetAccountEnabled(profileId, dn, false)),
    });
  }

  return (
    <div className="h-full overflow-auto">
      {/* Toolbar with badges */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card sticky top-0 z-(--z-sticky)">
        <div className="flex items-center gap-1 flex-wrap flex-1 min-w-0">
          {badges.map(b => <AccountBadge key={b.id} badge={b} />)}
        </div>
        <span className="text-xs text-muted-foreground shrink-0" title={formatDateTime(status.evaluated)}>
          {status.kind === 'computer' ? 'Computer account' : status.kind === 'serviceAccount' ? 'Managed service account' : 'User account'}
        </span>
        <IconButton label="Reload account status" icon={loading ? <Spinner size="sm" decorative /> : RefreshCw} disabled={loading} onClick={reload} />
      </div>

      <div className="p-3 space-y-3 max-w-[1100px]">
        {status.locked && (
          <InlineAlert
            tone="warning"
            title={status.lockedAt ? `Locked out since ${formatDateTime(status.lockedAt)} (${formatRelative(status.lockedAt, now)})` : 'The account is locked out'}
            body={status.lockedUntil
              ? `Unlocks automatically at ${formatDateTime(status.lockedUntil)} (${formatRelative(status.lockedUntil, now)}).`
              : status.lockedPermanently ? 'It stays locked until an administrator unlocks it.' : undefined}
            actions={actions.unlock.enabled ? (
              <Button size="sm" variant="primary" leftIcon={Unlock} loading={busy === 'unlock'} disabled={disabledAll}
                onClick={() => run('unlock', `${name} unlocked`, () => UnlockAccount(profileId, dn))}>
                Unlock
              </Button>
            ) : undefined}
          />
        )}
        {status.warnings.length > 0 && (
          <InlineAlert tone="warning" body={status.warnings.map((w, i) => <div key={i}>{w}</div>)} />
        )}

        <Section title="Status and actions">
          <Row label="Account" icon={status.enabled ? UserCheck : UserX}
            value={status.enabled
              ? <span>Enabled</span>
              : <span><span className="text-destructive font-medium">Disabled</span>{status.disabledBy && <Sub>{status.disabledBy}</Sub>}</span>}
            actions={[
              <ActionButton key="toggle" state={actions.toggleEnabled} busy={busy === 'toggleEnabled'} disabled={disabledAll}
                icon={actions.toggleEnabled.enable ? UserCheck : UserX} label={actions.toggleEnabled.enable ? 'Enable' : 'Disable'}
                onClick={() => actions.toggleEnabled.enable
                  ? run('toggleEnabled', `${name} enabled`, () => SetAccountEnabled(profileId, dn, true))
                  : askDisable()} />,
            ]}
            note={blockedNote(actions.toggleEnabled)}
          />

          <Row label="Lockout" icon={Timer}
            value={<LockoutValue status={status} now={now} />}
            actions={clearFailures.enabled ? [
              <ActionButton key="unlock" state={clearFailures} busy={busy === 'unlock'} disabled={disabledAll}
                icon={Unlock} label="Clear Failed Logons"
                onClick={() => run('unlock', `Failed logons of ${name} cleared`, () => UnlockAccount(profileId, dn))} />,
            ] : undefined}
            note={blockedNote(actions.unlock)}
          />

          <Row label="Password" icon={KeyRound}
            value={<PasswordValue status={status} now={now} />}
            actions={[
              <ActionButton key="reset" state={passwordReset} disabled={disabledAll} icon={KeyRound} label="Reset Password…"
                onClick={() => setShowPassword(true)} />,
              <ActionButton key="must" state={actions.mustChange} busy={busy === 'mustChange'} disabled={disabledAll}
                label={actions.mustChange.set ? 'Require change at next logon' : 'Clear "must change"'}
                onClick={() => run('mustChange',
                  actions.mustChange.set ? `${name} must change the password at the next logon` : `"Must change password" cleared for ${name}`,
                  () => SetMustChangePassword(profileId, dn, actions.mustChange.set))} />,
            ]}
            note={blockedNote(actions.mustChange) || blockedNote(passwordReset)}
          />

          <Row label="Password never expires" icon={ShieldCheck}
            value={isAD
              ? <span>{status.userAccountControl & 0x10000 ? 'Yes (DONT_EXPIRE_PASSWORD)' : 'No'}</span>
              : <span className="text-muted-foreground">Not a per-account setting on this server</span>}
            actions={[
              <ActionButton key="never" state={actions.neverExpires} busy={busy === 'neverExpires'} disabled={disabledAll}
                label={actions.neverExpires.set ? 'Set' : 'Clear'}
                onClick={() => run('neverExpires',
                  actions.neverExpires.set ? `"Password never expires" set for ${name}` : `"Password never expires" cleared for ${name}`,
                  () => SetPasswordNeverExpires(profileId, dn, actions.neverExpires.set))} />,
            ]}
            note={blockedNote(actions.neverExpires)}
          />

          <AccountExpirationRow
            status={status}
            now={now}
            state={actions.accountExpires}
            busy={busy === 'accountExpires'}
            disabled={disabledAll}
            onSet={(iso, inPast) => {
              const apply = () => run('accountExpires', `Account of ${name} expires: ${formatAccountExpiry(iso)}`,
                () => SetAccountExpiration(profileId, dn, iso));
              if (inPast) {
                setConfirm({
                  title: 'Expire account now?',
                  message: 'The chosen date is in the past, so the account is expired immediately and can no longer log on.',
                  detail: dn,
                  confirmLabel: 'Expire account',
                  variant: 'warning',
                  run: apply,
                });
              } else {
                apply();
              }
            }}
            onClear={() => run('accountExpires', `Account expiration of ${name} removed`, () => SetAccountExpiration(profileId, dn, ''))}
          />

          {isAD && (
            <Row label="userAccountControl" icon={ShieldAlert}
              value={
                <span>
                  <span className="font-mono">{formatUac(status.userAccountControl)}</span>
                  <Sub mono>{uacFlagNames(status.userAccountControl).join(', ') || 'no flags'}</Sub>
                  {status.userAccountControlComputed !== 0 && (
                    <Sub mono>computed: {uacFlagNames(status.userAccountControlComputed).join(', ') || formatUac(status.userAccountControlComputed)}</Sub>
                  )}
                </span>
              }
              actions={[
                <ActionButton key="uac" state={actions.uac} disabled={disabledAll} icon={ShieldAlert} label="Edit Flags…"
                  onClick={() => setShowUac(true)} />,
              ]}
              note={blockedNote(actions.uac)}
            />
          )}
        </Section>

        <Section title="Logons">
          <Row label={isAD ? 'Last logon (this DC)' : 'Last logon'} icon={LogIn}
            value={<When iso={status.lastLogon} now={now} empty={isAD ? 'Never (on this domain controller)' : 'Not recorded by this server'} />} />
          {isAD && (
            <Row label="Last logon (replicated)" icon={LogIn}
              value={<span><When iso={status.lastLogonReplicated} now={now} empty="Never" /><Sub>lastLogonTimestamp, may lag up to 14 days</Sub></span>} />
          )}
          {status.hasLogonCount && <Row label="Logon count" value={<span>{status.logonCount}</span>} />}
          <Row label="Failed logons" value={
            <span>
              {status.badPasswordCount}
              {status.lastBadPassword && <span className="text-muted-foreground"> - last <When iso={status.lastBadPassword} now={now} /></span>}
            </span>
          } />
          <Row label="Created" icon={CalendarClock} value={<When iso={status.created} now={now} empty="Unknown" />} />
        </Section>

        <Section title="Effective password policy">
          {status.policy ? (
            <>
              <Row label="Policy" value={
                <span>
                  <span className="inline-flex items-center gap-1">
                    {status.policy.name}
                    {status.policyNote && <PolicyNoteIcon note={status.policyNote} />}
                  </span>
                  <Sub>{policySourceLabel(status.policy.source)}</Sub>
                  {status.policy.dn && <Sub mono>{status.policy.dn}</Sub>}
                </span>
              } />
              {describePolicy(status.policy).map(r => <Row key={r.label} label={r.label} value={<span>{r.value}</span>} />)}
            </>
          ) : (
            <Row label="Policy" value={<span className="text-muted-foreground">Unknown</span>} />
          )}
        </Section>
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          detail={confirm.detail}
          confirmLabel={confirm.confirmLabel}
          variant={confirm.variant}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; setConfirm(null); c.run(); }}
        />
      )}
      {showPassword && (
        <PasswordDialog
          dn={dn}
          profileId={profileId}
          onClose={() => setShowPassword(false)}
          onChanged={() => { void onChanged(); }}
        />
      )}
      {showUac && (
        <UacFlagsDialog
          profileId={profileId}
          dn={dn}
          value={status.userAccountControl}
          computed={status.userAccountControlComputed}
          onClose={() => setShowUac(false)}
          onSaved={() => { void onChanged(); }}
          onConflict={reload}
        />
      )}
    </div>
  );
}

/** The reason shown below a row: only for actions the server or account type does not support. */
function blockedNote(state: ActionState): string | undefined {
  return !state.enabled && state.blockedBy === 'unsupported' ? state.reason : undefined;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-border bg-card" aria-label={title}>
      <h3 className="px-3 py-1.5 border-b border-border text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

function Row({ label, icon: Icon, value, actions, note }: {
  label: string;
  icon?: React.ElementType;
  value: React.ReactNode;
  actions?: React.ReactNode[];
  note?: string;
}) {
  return (
    <div className="flex items-start gap-3 px-3 py-1.5 text-sm">
      <div className="w-[170px] shrink-0 flex items-center gap-1.5 text-muted-foreground pt-0.5">
        {Icon ? <Icon size={12} strokeWidth={1.75} aria-hidden className="shrink-0" /> : <span className="w-3 shrink-0" />}
        <span className="truncate" title={label}>{label}</span>
      </div>
      <div className="flex-1 min-w-0 pt-0.5 text-foreground break-words">
        {value}
        {note && (
          <span className="flex items-start gap-1 mt-0.5 text-xs text-muted-foreground italic">
            <Info size={12} strokeWidth={1.75} aria-hidden className="mt-px shrink-0" />
            {note}
          </span>
        )}
      </div>
      {actions && actions.length > 0 && <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end">{actions}</div>}
    </div>
  );
}

function Sub({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  // DNs and flag lists may break anywhere; prose only between words.
  return <span className={cn('block text-xs text-muted-foreground', mono ? 'font-mono break-all' : 'break-words')}>{children}</span>;
}

/** Informational note about how the policy was found (e.g. cn=config not readable), once per policy as an icon. */
function PolicyNoteIcon({ note }: { note: string }) {
  return (
    <Tooltip content={note}>
      <span tabIndex={0} role="img" aria-label={note} className="inline-flex text-info rounded-xs outline-hidden focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-1">
        <Info size={12} strokeWidth={1.75} aria-hidden />
      </span>
    </Tooltip>
  );
}

/** Local time plus relative time ("Oct 30, 2026, 7:59 AM (in 8 hours)"). */
function When({ iso, now, empty = '-' }: { iso?: string; now: Date; empty?: string }) {
  if (!iso) return <span className="text-muted-foreground">{empty}</span>;
  return (
    <span title={iso}>
      {formatDateTime(iso)} <span className="text-muted-foreground">({formatRelative(iso, now)})</span>
    </span>
  );
}

/** Account expiration like ADUC: "end of Dec 24, 2026 (in 3 days)". */
function ExpiryWhen({ iso, now }: { iso?: string; now: Date }) {
  if (!iso) return null;
  const text = formatAccountExpiry(iso);
  return (
    <span title={iso}>
      {text.startsWith('End of') ? text.replace(/^End/, 'end') : text} <span className="text-muted-foreground">({formatRelative(iso, now)})</span>
    </span>
  );
}

function ActionButton({ state, label, icon: Icon, onClick, busy, disabled, primary }: {
  state: ActionState;
  label: string;
  icon?: React.ElementType;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  primary?: boolean;
}) {
  const off = !state.enabled || disabled;
  return (
    <Button
      size="sm"
      variant={primary && state.enabled ? 'primary' : 'secondary'}
      leftIcon={Icon as IconType | undefined}
      loading={busy}
      onClick={onClick}
      disabled={off}
      title={!state.enabled ? state.reason : undefined}
    >
      {label}
    </Button>
  );
}

function LockoutValue({ status, now }: { status: AccountStatus; now: Date }) {
  if (status.locked) {
    return (
      <span>
        <span className="text-destructive font-medium">Locked</span>
        {status.lockedAt && <> since <When iso={status.lockedAt} now={now} /></>}
        <Sub>
          {status.lockedUntil
            ? <>Unlocks automatically at {formatDateTime(status.lockedUntil)} ({formatRelative(status.lockedUntil, now)})</>
            : status.lockedPermanently
              ? 'Stays locked until an administrator unlocks it'
              : 'Lockout end unknown'}
        </Sub>
      </span>
    );
  }
  if (status.lockoutExpired) {
    return (
      <span>
        Not locked
        <Sub>
          A lockout {status.lockedAt ? <>from {formatDateTime(status.lockedAt)} </> : ''}is recorded but its duration has passed.
        </Sub>
      </span>
    );
  }
  return <span>Not locked</span>;
}

function PasswordValue({ status, now }: { status: AccountStatus; now: Date }) {
  let expiry: React.ReactNode;
  if (status.mustChangePassword) {
    expiry = <span className="text-warning font-medium">Must be changed at the next logon</span>;
  } else if (status.passwordExpired) {
    expiry = <span className="text-destructive font-medium">Expired{status.passwordExpires && <> <When iso={status.passwordExpires} now={now} /></>}</span>;
  } else if (status.passwordNeverExpires) {
    expiry = <span>Never expires</span>;
  } else if (status.passwordExpires) {
    expiry = <span>Expires <When iso={status.passwordExpires} now={now} /></span>;
  } else {
    expiry = <span className="text-muted-foreground">Expiry unknown</span>;
  }
  return (
    <span>
      {expiry}
      {status.passwordExpiryNote && <Sub>{status.passwordExpiryNote}</Sub>}
      <Sub>
        Last set: {status.passwordLastSet
          ? <>{formatDateTime(status.passwordLastSet)} ({formatRelative(status.passwordLastSet, now)})</>
          : status.mustChangePassword && status.serverType === 'ad' ? 'Must change (pwdLastSet = 0)' : 'unknown'}
      </Sub>
    </span>
  );
}

function AccountExpirationRow({ status, now, state, busy, disabled, onSet, onClear }: {
  status: AccountStatus;
  now: Date;
  state: ActionState;
  busy: boolean;
  disabled: boolean;
  onSet: (iso: string, inPast: boolean) => void;
  onClear: () => void;
}) {
  const [day, setDay] = useState(() => localDayEndingAt(status.accountExpires));
  useEffect(() => { setDay(localDayEndingAt(status.accountExpires)); }, [status.accountExpires]);
  const plan = planAccountExpiration(day, now);
  const unchanged = !!plan.iso && plan.iso === status.accountExpires;

  let value: React.ReactNode;
  if (status.accountExpired) {
    value = <span className="text-destructive font-medium">Expired <ExpiryWhen iso={status.accountExpires} now={now} /></span>;
  } else if (status.accountExpires) {
    value = <span>Expires <ExpiryWhen iso={status.accountExpires} now={now} /></span>;
  } else {
    value = <span>Never expires</span>;
  }
  const clearState: ActionState = state.enabled && status.accountNeverExpires
    ? { enabled: false, reason: 'The account has no expiration date.', blockedBy: 'state' }
    : state;
  const setState: ActionState = !state.enabled ? state
    : plan.error ? { enabled: false, reason: plan.error, blockedBy: 'state' }
      : unchanged ? { enabled: false, reason: 'The account already expires at the end of this day.', blockedBy: 'state' }
        : state;

  return (
    <Row label="Account expiration" icon={CalendarClock}
      value={value}
      actions={[
        <Input
          key="day"
          type="date"
          size="sm"
          aria-label="Last day the account can log on"
          value={day}
          onChange={e => setDay(e.target.value)}
          disabled={!state.enabled || disabled}
          title={state.enabled ? 'Last day the account can log on' : state.reason}
          className="w-[130px]"
        />,
        <ActionButton key="set" state={setState} busy={busy} disabled={disabled} label="Set" onClick={() => plan.iso && onSet(plan.iso, plan.inPast)} />,
        <ActionButton key="clear" state={clearState} disabled={disabled} label="Never" onClick={onClear} />,
      ]}
      note={blockedNote(state)}
    />
  );
}
