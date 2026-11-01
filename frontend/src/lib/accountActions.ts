/**
 * Pure UI logic of the account panel: which actions are available (and why
 * not), status badges, policy descriptions.
 */
import type { AccountActionId, AccountPolicy, AccountStatus } from '../types/account';
import { daysUntil, endOfLocalDayISO, formatAccountExpiry, formatDateTime, formatDuration, formatRelative, wholeDaysUntil } from './accountTime.ts';
import { firstRDN, parseRDN } from './dn.ts';

const UAC_DONT_EXPIRE_PASSWORD = 0x10000;
const READ_ONLY_REASON = 'The connection is read-only.';

/** Object classes of entries that may be accounts (checked before asking the server). */
const ACCOUNT_OBJECT_CLASSES = new Set([
  'user', 'computer', 'person', 'organizationalperson', 'inetorgperson', 'posixaccount',
  'shadowaccount', 'account', 'simplesecurityobject', 'inetuser', 'nsperson', 'nsaccount',
  'msds-groupmanagedserviceaccount', 'msds-managedserviceaccount',
]);

/** Whether an entry with these object classes may have an account status. */
export function looksLikeAccount(objectClasses: string[] | undefined | null): boolean {
  if (!objectClasses || objectClasses.length === 0) return false;
  const lower = objectClasses.map(o => o.toLowerCase());
  // AD contacts are persons but no accounts.
  if (lower.includes('contact') && !lower.includes('user')) return false;
  return lower.some(o => ACCOUNT_OBJECT_CLASSES.has(o));
}

export interface ActionState {
  enabled: boolean;
  /** Why the action is not available (when disabled). */
  reason?: string;
  /**
   * What blocks the action: the server or account type does not support it
   * (show the reason permanently), the current state (e.g. not locked), or
   * a read-only connection.
   */
  blockedBy?: 'unsupported' | 'state' | 'readOnly';
}

export interface AccountActions {
  unlock: ActionState;
  /** Enable or disable, depending on the current state. */
  toggleEnabled: ActionState & { enable: boolean; label: string };
  /** Set or clear "must change password", depending on the current state. */
  mustChange: ActionState & { set: boolean; label: string };
  /** AD only: set or clear DONT_EXPIRE_PASSWORD. */
  neverExpires: ActionState & { set: boolean; label: string };
  accountExpires: ActionState;
  uac: ActionState;
  resetPassword: ActionState;
}

function gate(status: AccountStatus, action: AccountActionId, readOnly: boolean | string, stateReason?: string): ActionState {
  const unsupported = status.unsupported?.[action];
  if (unsupported) return { enabled: false, reason: unsupported, blockedBy: 'unsupported' };
  if (stateReason) return { enabled: false, reason: stateReason, blockedBy: 'state' };
  if (readOnly) return { enabled: false, reason: typeof readOnly === 'string' ? readOnly : READ_ONLY_REASON, blockedBy: 'readOnly' };
  return { enabled: true };
}

/**
 * Availability of every account action for status on a (read-only)
 * connection. `readOnly` as a string blocks the writes with that reason
 * (a lost connection: "Connection lost: reconnect to edit.", RW2-C-02).
 */
export function getAccountActions(status: AccountStatus, readOnly: boolean | string): AccountActions {
  const isAD = status.serverType === 'ad';

  // Unlock: AD needs a lockout; OpenLDAP/389DS also reset recorded failures.
  let unlockReason: string | undefined;
  const hasLockout = status.locked || !!status.lockoutExpired || (!isAD && status.badPasswordCount > 0);
  if (status.serverType === 'openldap' && !status.enabled && !status.locked) {
    unlockReason = 'The account is disabled (permanently locked); use Enable instead.';
  } else if (!hasLockout) {
    unlockReason = 'The account is not locked out.';
  }

  const enable = !status.enabled;
  const toggleEnabled = {
    ...gate(status, enable ? 'enable' : 'disable', readOnly),
    enable,
    label: enable ? 'Enable account' : 'Disable account',
  };

  const setMustChange = !status.mustChangePassword;
  let mustChangeReason: string | undefined;
  if (setMustChange && isAD && (status.userAccountControl & UAC_DONT_EXPIRE_PASSWORD)) {
    mustChangeReason = '"Password never expires" is set, so AD would not ask for a new password. Clear it first.';
  }
  const mustChange = {
    ...gate(status, 'mustChange', readOnly, mustChangeReason),
    set: setMustChange,
    label: setMustChange ? 'Require password change at next logon' : 'Clear "must change password"',
  };

  const neverSet = !(status.userAccountControl & UAC_DONT_EXPIRE_PASSWORD);
  const neverExpires = {
    ...gate(status, 'neverExpires', readOnly),
    set: neverSet,
    label: neverSet ? 'Set "password never expires"' : 'Clear "password never expires"',
  };

  return {
    unlock: gate(status, 'unlock', readOnly, unlockReason),
    toggleEnabled,
    mustChange,
    neverExpires,
    accountExpires: gate(status, 'accountExpires', readOnly),
    uac: gate(status, 'uac', readOnly),
    resetPassword: gate(status, 'resetPassword', readOnly),
  };
}

export type BadgeTone = 'ok' | 'info' | 'warn' | 'danger' | 'muted';

export interface AccountBadge {
  id: string;
  label: string;
  tone: BadgeTone;
  title?: string;
}

/** Days before an expiry that are shown as a warning. */
export const EXPIRY_WARNING_DAYS = 14;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "in 3 days" (shared rounding rule, wholeDaysUntil) or "in 8 hours" for an upcoming time. */
function inDays(iso: string, now: Date): string {
  const d = daysUntil(iso, now) ?? 0;
  if (d < 1) return formatRelative(iso, now);
  return `in ${plural(wholeDaysUntil(new Date(iso), now), 'day')}`;
}

/** Name of an account for toasts and confirmations: the value of its first RDN ("ux-p-user1"). */
export function accountDisplayName(dn: string): string {
  return parseRDN(firstRDN(dn)).value || dn;
}

/** The one confirmation text of "Disable account" (Account tab, menus, palette). */
export function disableConfirmText(dn: string): { title: string; message: string; confirmLabel: string } {
  return {
    title: 'Disable account?',
    message: `${accountDisplayName(dn)} can no longer log on until the account is enabled again.`,
    confirmLabel: 'Disable',
  };
}

/** Status badges of the account panel. */
export function getAccountBadges(status: AccountStatus, now: Date): AccountBadge[] {
  const badges: AccountBadge[] = [];
  badges.push(status.enabled
    ? { id: 'enabled', label: 'Enabled', tone: 'ok' }
    : { id: 'disabled', label: 'Disabled', tone: 'danger', title: status.disabledBy });

  if (status.locked) {
    let label = 'Locked';
    if (status.lockedUntil) label = `Locked until ${formatDateTime(status.lockedUntil)}`;
    else if (status.lockedPermanently) label = 'Locked until unlocked by an admin';
    badges.push({ id: 'locked', label, tone: 'danger', title: status.lockedAt ? `Locked since ${formatDateTime(status.lockedAt)}` : undefined });
  }

  if (status.mustChangePassword) {
    badges.push({ id: 'mustChange', label: 'Must change password', tone: 'warn' });
  } else if (status.passwordExpired) {
    badges.push({ id: 'pwdExpired', label: 'Password expired', tone: 'danger', title: status.passwordExpires ? `Expired ${formatDateTime(status.passwordExpires)}` : undefined });
  } else if (status.passwordNeverExpires) {
    badges.push({ id: 'pwdNever', label: 'Password never expires', tone: 'muted', title: status.passwordExpiryNote });
  } else if (status.passwordExpires) {
    const days = daysUntil(status.passwordExpires, now) ?? 0;
    badges.push({
      id: 'pwdExpires',
      label: `Password expires ${inDays(status.passwordExpires, now)}`,
      tone: days <= EXPIRY_WARNING_DAYS ? 'warn' : 'info',
      title: formatDateTime(status.passwordExpires),
    });
  }

  if (status.accountExpired) {
    badges.push({ id: 'accExpired', label: `Account expired (${formatAccountExpiry(status.accountExpires).replace(/^End/, 'end')})`, tone: 'danger', title: formatDateTime(status.accountExpires) });
  } else if (status.accountExpires) {
    const days = daysUntil(status.accountExpires, now) ?? 0;
    badges.push({
      id: 'accExpires',
      label: `Account expires ${inDays(status.accountExpires, now)}`,
      tone: days <= EXPIRY_WARNING_DAYS ? 'warn' : 'info',
      title: formatAccountExpiry(status.accountExpires),
    });
  }
  return badges;
}

/** Badges for the editor header: only problems that block logons. */
export function getHeaderBadges(status: AccountStatus | null | undefined): AccountBadge[] {
  if (!status?.applicable) return [];
  const out: AccountBadge[] = [];
  if (!status.enabled) out.push({ id: 'disabled', label: 'Disabled', tone: 'danger', title: status.disabledBy || 'The account is disabled' });
  if (status.locked) {
    out.push({
      id: 'locked',
      label: 'Locked',
      tone: 'danger',
      title: status.lockedUntil ? `Locked until ${formatDateTime(status.lockedUntil)}` : 'Locked until an administrator unlocks it',
    });
  }
  if (status.accountExpired) out.push({ id: 'expired', label: 'Expired', tone: 'danger', title: `Account expired (${formatAccountExpiry(status.accountExpires).replace(/^End/, 'end')})` });
  return out;
}

const POLICY_SOURCE_LABELS: Record<string, string> = {
  pso: 'Fine-grained password policy (PSO)',
  domain: 'Domain policy',
  subentry: 'Policy assigned to the entry',
  default: 'Default policy (olcPPolicyDefault)',
  assumed: 'Assumed default policy',
  global: 'Global policy (cn=config)',
  unknown: 'Unknown policy',
  none: 'No policy applies',
};

export function policySourceLabel(source: string): string {
  return POLICY_SOURCE_LABELS[source] || source;
}

/** Rows (label, value) describing a policy. */
export function describePolicy(policy: AccountPolicy): { label: string; value: string }[] {
  if (!policy.readable) {
    return [{ label: 'Settings', value: policy.source === 'none' ? 'No password policy applies to this entry' : 'Not readable with this connection' }];
  }
  if (policy.source === 'none') return [{ label: 'Settings', value: 'No password policy applies to this entry' }];
  const rows: { label: string; value: string }[] = [];
  if (policy.lockoutEnabled && policy.lockoutThreshold > 0) {
    const duration = policy.lockoutDurationSeconds > 0
      ? `for ${formatDuration(policy.lockoutDurationSeconds)}`
      : 'until an administrator unlocks it';
    rows.push({ label: 'Lockout', value: `after ${plural(policy.lockoutThreshold, 'failed attempt')}, ${duration}` });
    if (policy.observationWindowSeconds > 0) rows.push({ label: 'Failure counter reset', value: `after ${formatDuration(policy.observationWindowSeconds)}` });
  } else if (policy.lockoutEnabled) {
    rows.push({ label: 'Lockout', value: 'enabled' });
  } else {
    rows.push({ label: 'Lockout', value: 'disabled' });
  }
  rows.push({ label: 'Maximum password age', value: policy.maxPasswordAgeSeconds > 0 ? formatDuration(policy.maxPasswordAgeSeconds) : 'never expires' });
  if (policy.minPasswordAgeSeconds > 0) rows.push({ label: 'Minimum password age', value: formatDuration(policy.minPasswordAgeSeconds) });
  if (policy.minPasswordLength > 0) rows.push({ label: 'Minimum length', value: String(policy.minPasswordLength) });
  if (policy.passwordHistory > 0) rows.push({ label: 'Password history', value: plural(policy.passwordHistory, 'password') });
  if (policy.complexityKnown) {
    const ad = policy.source === 'pso' || policy.source === 'domain';
    rows.push({
      label: 'Complexity',
      value: policy.complexityEnabled
        ? ad ? 'required (3 of 4 character classes, no parts of the account name)' : 'required (passwordCheckSyntax)'
        : 'not required',
    });
    if (ad) {
      rows.push({ label: 'Reversible encryption', value: policy.reversibleEncryption ? 'on - passwords are stored reversibly' : 'off' });
    }
  }
  if (policy.expireWarningSeconds > 0) rows.push({ label: 'Expiry warning', value: formatDuration(policy.expireWarningSeconds) });
  if (policy.graceLogins > 0) rows.push({ label: 'Grace logins', value: String(policy.graceLogins) });
  if (policy.source !== 'pso' && policy.source !== 'domain') {
    rows.push({ label: 'Forced change enforced', value: policy.mustChangeEnforced ? 'yes' : 'no' });
  }
  return rows;
}

interface TreeNodeLike {
  dn: string;
  objectClass?: string[];
  children?: TreeNodeLike[];
}

/**
 * Object classes of the tree node dn, searched in the root nodes (and their
 * pre-loaded children) and in the loaded child lists; null when the node is
 * not loaded. DNs are compared case-insensitively.
 */
export function findTreeNodeObjectClasses(
  roots: TreeNodeLike[] | undefined,
  childNodes: Record<string, TreeNodeLike[]> | undefined,
  dn: string,
): string[] | null {
  const target = dn.toLowerCase();
  const stack: TreeNodeLike[] = [...(roots || [])];
  for (const list of Object.values(childNodes || {})) stack.push(...list);
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.dn.toLowerCase() === target) return node.objectClass || [];
    if (node.children) stack.push(...node.children);
  }
  return null;
}

export interface ExpirationPlan {
  /** RFC 3339 instant to store (end of the chosen local day), null when invalid. */
  iso: string | null;
  /** The account is expired immediately (the instant is not in the future). */
  inPast: boolean;
  error?: string;
}

/** Validates a yyyy-mm-dd account expiration day picked in the UI. */
export function planAccountExpiration(day: string, now: Date): ExpirationPlan {
  if (!day) return { iso: null, inPast: false, error: 'Pick a date first.' };
  const iso = endOfLocalDayISO(day);
  if (!iso) return { iso: null, inPast: false, error: 'Invalid date.' };
  const year = Number(day.slice(0, 4));
  if (year < 1601 || year > 9999) return { iso: null, inPast: false, error: 'The year must be between 1601 and 9999.' };
  return { iso, inPast: new Date(iso).getTime() <= now.getTime() };
}

/** Delay after a time boundary before the status is read again (the server needs to see it passed). */
const STATUS_BOUNDARY_MARGIN_MS = 2_000;
/** Re-check interval while a boundary has passed but the status still shows the old state (clock skew). */
const STATUS_RECHECK_MS = 20_000;
/** How long after a boundary such re-checks continue. */
const STATUS_RECHECK_WINDOW_MS = 5 * 60_000;
/** Boundaries further away are not scheduled (browser timers are limited to ~24.8 days anyway). */
const STATUS_MAX_SCHEDULE_MS = 24 * 60 * 60_000;

/**
 * When the account status should be read again because a time it depends on
 * passes: the end of a timed lockout, the password expiry or the account
 * expiry. Returns the delay in ms, or null when nothing changes within a day.
 *
 * A boundary that passed less than 5 minutes ago while the status still
 * shows the old state (e.g. still locked: the server clock lags) is checked
 * again every 20 s, so a stale "Locked" badge does not stay.
 */
export function nextAccountStatusRefresh(status: AccountStatus | null | undefined, nowMs: number): number | null {
  if (!status || !status.applicable) return null;
  const boundaries: { at: string | undefined; pending: boolean }[] = [
    { at: status.locked ? status.lockedUntil : undefined, pending: status.locked },
    {
      at: status.passwordNeverExpires || status.mustChangePassword ? undefined : status.passwordExpires,
      pending: !status.passwordExpired,
    },
    { at: status.accountExpires, pending: !status.accountExpired },
  ];
  let best: number | null = null;
  for (const b of boundaries) {
    if (!b.at || !b.pending) continue;
    const t = Date.parse(b.at);
    if (Number.isNaN(t)) continue;
    let delay: number;
    if (t > nowMs) {
      delay = t - nowMs + STATUS_BOUNDARY_MARGIN_MS;
    } else if (nowMs - t <= STATUS_RECHECK_WINDOW_MS) {
      delay = STATUS_RECHECK_MS;
    } else {
      continue;
    }
    if (delay > STATUS_MAX_SCHEDULE_MS) continue;
    if (best === null || delay < best) best = delay;
  }
  return best;
}
