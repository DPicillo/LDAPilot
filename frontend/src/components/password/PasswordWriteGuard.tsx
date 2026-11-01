import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Info, KeyRound, ShieldAlert } from 'lucide-react'
import { GetPasswordPolicyCatalog, ModifyEntryWithOptions, PlanPasswordWrite } from '../../lib/wails-pwpolicy'
import {
  AS_IS_NOTICE, PASSWORD_TOAST_ACTION_LABELS, bulkPasswordOutcome, defaultClientScheme, passwordToastActions, planNeedsPrompt,
  reportHeadline, reportKeptDisabled, reportOutcome, reportSuccessDetail, reportSummary, targetHasPasswordValues, type BulkPasswordCounts,
  type PasswordToastAction,
} from '../../lib/passwordPolicy'
import { accountDisplayName } from '../../lib/accountActions'
import { schemeWithStrength, serverHashingScheme } from '../../lib/passwordMethod'
import { normalizeDN } from '../../lib/dn'
import type { PasswordScheme } from '../../types/password'
import type { PasswordWriteOptions, PasswordWritePlan, PasswordWriteReport, PasswordWriteTarget } from '../../types/passwordPolicy'
import { useEditorStore } from '../../stores/editorStore'
import { toast, type ToastAction } from '../ui/Toast'
import { cn } from '../../lib/utils'
import { Dialog, useDialogStore } from '../ui/Dialog'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Button } from '../ui/Button'
import { Checkbox, RadioGroup } from '../ui/Checkbox'
import { Select } from '../ui/Input'
import { Spinner } from '../ui/Spinner'
import { InlineAlert } from '../ui/InlineAlert'
import { PasswordDialog } from '../editor/PasswordDialog'
import { UnencryptedConsent } from './UnencryptedConsent'
import { UNENCRYPTED_CONTINUE, UNENCRYPTED_TITLE, withUnencryptedConsent } from '../../lib/unencryptedConsent'
import { dismissPasswordWarnings, rememberPasswordWarning } from './passwordToastRegistry'
import { afterAccountChange } from '../commands/accountState'

export { dismissPasswordWarnings } from './passwordToastRegistry'

/** Extra information for the confirmation dialog. */
export interface PasswordCheckInfo {
  /** The write is repeated for this many entries (bulk modify): the plan shown is per entry. */
  entries?: number;
}

interface PendingCheck {
  profileId: string;
  target: PasswordWriteTarget;
  base: PasswordWriteOptions;
  plan: PasswordWritePlan;
  info: PasswordCheckInfo;
  /** Preselected answer of an "ask" decision */
  decision: 'client' | 'server';
  resolve: (opts: PasswordWriteOptions | null) => void;
}

/**
 * Pre-write check of the password storage policy for every UI write path
 * that can carry userPassword values. `check` returns the options to send
 * with the write: right away when nothing needs the user, after the dialog
 * when the policy is "ask" or a cleartext password would go over an
 * unencrypted connection; null when the user cancelled. Render `element`
 * in the calling component.
 */
export function usePasswordWriteGuard(): {
  check: (profileId: string, target: PasswordWriteTarget, base?: PasswordWriteOptions, info?: PasswordCheckInfo) => Promise<PasswordWriteOptions | null>;
  element: ReactNode;
} {
  const [pending, setPending] = useState<PendingCheck | null>(null);

  const check = useCallback(async (profileId: string, target: PasswordWriteTarget, base: PasswordWriteOptions = {}, info: PasswordCheckInfo = {}) => {
    if (!targetHasPasswordValues(target)) return base;
    const plan = await PlanPasswordWrite(profileId, { ...target, options: base });
    if (!planNeedsPrompt(plan)) return base;
    const decision = plan!.needsDecision ? await preselectDecision(profileId, target, base, plan!) : 'client';
    return new Promise<PasswordWriteOptions | null>((resolve) => {
      setPending({ profileId, target, base, plan: plan!, info, decision, resolve });
    });
  }, []);

  // A pending check must not hang when the caller unmounts.
  const pendingRef = useRef<PendingCheck | null>(null);
  pendingRef.current = pending;
  useEffect(() => () => pendingRef.current?.resolve(null), []);

  const finish = (opts: PasswordWriteOptions | null) => {
    pending?.resolve(opts);
    setPending(null);
  };

  const element = pending ? (
    <PasswordWriteConfirmDialog
      profileId={pending.profileId}
      target={pending.target}
      base={pending.base}
      initialPlan={pending.plan}
      initialDecision={pending.decision}
      entries={pending.info.entries}
      onCancel={() => finish(null)}
      onConfirm={finish}
    />
  ) : null;

  return { check, element };
}

/**
 * The answer preselected for an "ask" decision: server-side hashing only
 * when the server is known to hash cleartext values, or when this write
 * would use the Password Modify extended operation (a single password
 * replace); otherwise sending cleartext may store it unhashed, so
 * client-side hashing is the safe default.
 */
async function preselectDecision(profileId: string, target: PasswordWriteTarget, base: PasswordWriteOptions, plan: PasswordWritePlan): Promise<'client' | 'server'> {
  if (plan.policy.serverHashes) return 'server';
  if (!plan.policy.passwordModifyExop) return 'client';
  try {
    const server = await PlanPasswordWrite(profileId, { ...target, options: { ...base, policy: 'server' } });
    return server?.exop ? 'server' : 'client';
  } catch {
    return 'client';
  }
}

/** The entry a password write went to: enables the toast's actions and the clean-up of older warnings. */
export interface PasswordWriteTargetEntry {
  profileId: string;
  dn: string;
}

/**
 * The one toast after a write with password values (instead of a separate
 * success toast): done is what was written ('Entry created'). Success with
 * the stored scheme when the passwords need no attention; a persistent
 * error toast when the server stored the password in cleartext or the new
 * password will not work; a persistent warning toast with the warnings
 * otherwise (scheme not confirmed, cleartext risk when the stored value is
 * not readable, AD userPassword). Never a green toast next to a red one.
 *
 * The headline names the reason (reportHeadline). With entry, problem
 * toasts offer the follow-up action ("Remove Value", "Reset Password…",
 * "Open Entry"), and a later successful password write of the same entry
 * dismisses them.
 */
export function notifyPasswordWrite(report: PasswordWriteReport | null | undefined, done: string, entry?: PasswordWriteTargetEntry): void {
  const outcome = reportOutcome(report);
  if (!report || outcome === 'none' || outcome === 'ok') {
    // "(userPassword stored as …, account stays disabled)"
    const summary = outcome === 'ok' ? reportSuccessDetail(report) : '';
    if (entry && outcome === 'ok') dismissPasswordWarnings(entry.profileId, entry.dn);
    // "ux-1 updated: userPassword stored as {PBKDF2-SHA512}" (no double parentheses, RW2-P-04).
    toast.success(summary ? `${done}: ${summary}` : done);
    return;
  }
  const title = `${reportHeadline(report)} (${done})`;
  const detail = [
    `${reportSummary(report)}.`,
    ...(reportKeptDisabled(report) ? ['The account stays disabled (permanent ppolicy lock set again after the password change).'] : []),
    ...report.warnings,
  ].join('\n\n');
  // Follow-up buttons, the most useful first ("Remove Value", "Reset Password…", "Open Entry").
  const actions = entry ? passwordToastActions(report).map((kind) => passwordToastAction(kind, entry)) : [];
  const buttons = actions.length > 0 ? { actions } : {};
  const id = outcome === 'error'
    // Persistent (not collapsed into the bell after 8 s): a cleartext or unusable password needs action.
    ? toast.error(title, detail, { persistent: true, ...buttons })
    : toast.warning(title, detail, buttons);
  if (entry) rememberPasswordWarning(entry.profileId, entry.dn, id);
}

/** The toast button of a follow-up action on entry. */
export function passwordToastAction(kind: PasswordToastAction, entry: PasswordWriteTargetEntry): ToastAction {
  const run: Record<PasswordToastAction, () => void> = {
    remove: () => useDialogStore.getState().open(RemoveUserPasswordDialog, { profileId: entry.profileId, dn: entry.dn }),
    reset: () => useDialogStore.getState().open(PasswordDialog, { dn: entry.dn, profileId: entry.profileId }),
    open: () => useEditorStore.getState().openEntry(entry.profileId, entry.dn),
  };
  return { label: PASSWORD_TOAST_ACTION_LABELS[kind], run: run[kind] };
}

/**
 * "Remove Value" of a password toast: deletes userPassword (the attribute,
 * so no value crosses the wire) after a confirmation, through the password
 * policy write path (lock guard and audit in EditorService).
 */
function RemoveUserPasswordDialog({ profileId, dn, onClose }: { profileId: string; dn: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const name = accountDisplayName(dn);
  const remove = async () => {
    setBusy(true);
    try {
      const report = await ModifyEntryWithOptions(profileId, dn, [{ operation: 'delete', attribute: 'userPassword', values: [] }], {});
      dismissPasswordWarnings(profileId, dn);
      toast.success(`userPassword removed from ${name}${reportKeptDisabled(report) ? ' (account stays disabled)' : ''}`);
      // One status read the views share; they get it with the event (RW1-P-06).
      void afterAccountChange(profileId, dn);
      const key = normalizeDN(dn);
      const tab = useEditorStore.getState().tabs.find((t) => t.profileId === profileId && t.dn && normalizeDN(t.dn) === key);
      if (tab?.dn) void useEditorStore.getState().refreshEntry(profileId, tab.dn, { silent: true });
      onClose();
    } catch (err) {
      toast.error(`Could not remove userPassword from ${name}`, err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      title="Remove userPassword?"
      message={`All userPassword values of ${name} are removed, including the readable one. Set a new password afterwards with Reset Password… if the account needs one.`}
      detail={dn}
      confirmLabel="Remove Value"
      tone="danger"
      busy={busy}
      onCancel={onClose}
      onConfirm={() => void remove()}
    />
  );
}

/**
 * The toast after a bulk modify / LDIF apply run: success only when every
 * item succeeded and no written password needs attention (stored in
 * cleartext, will not work, scheme not confirmed, other warnings).
 */
export function notifyBulkResult(
  res: BulkPasswordCounts & { succeeded: number; failed: number; notProcessed: number; stopped: boolean },
  texts: { success: string; partial: string },
): void {
  const pw = bulkPasswordOutcome(res);
  const attention = 'See "Items that need attention" in the result.';
  if (res.failed === 0 && !res.stopped && !pw) {
    toast.success(texts.success);
  } else if (res.failed === 0 && !res.stopped && pw) {
    if (pw.level === 'error') toast.error(`${texts.success}, but ${pw.text}`, attention, { persistent: true });
    else toast.warning(`${texts.success}; ${pw.text}`, attention);
  } else {
    toast.error(pw ? `${texts.partial}; ${pw.text}` : texts.partial, pw ? attention : undefined, { persistent: !!pw && pw.level === 'error' });
  }
}

function PasswordWriteConfirmDialog({ profileId, target, base, initialPlan, initialDecision, entries, onCancel, onConfirm }: {
  profileId: string;
  target: PasswordWriteTarget;
  base: PasswordWriteOptions;
  initialPlan: PasswordWritePlan;
  initialDecision: 'client' | 'server';
  entries?: number;
  onCancel: () => void;
  onConfirm: (opts: PasswordWriteOptions) => void;
}) {
  const needsDecision = initialPlan.needsDecision;
  const serverType = initialPlan.policy.serverType;
  const [decision, setDecision] = useState<'client' | 'server'>(initialDecision);
  const [scheme, setScheme] = useState(initialPlan.policy.scheme || defaultClientScheme(serverType));
  const [schemes, setSchemes] = useState<PasswordScheme[]>([]);
  const [plan, setPlan] = useState<PasswordWritePlan>(initialPlan);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!needsDecision) return;
    GetPasswordPolicyCatalog().then((c) => setSchemes(c?.schemes ?? []), () => setSchemes([]));
  }, [needsDecision]);

  const options = useCallback((): PasswordWriteOptions => (
    needsDecision ? { ...base, policy: decision, scheme: decision === 'client' ? scheme : undefined } : { ...base }
  ), [base, decision, scheme, needsDecision]);

  // The decision changes what is sent: plan again.
  useEffect(() => {
    if (!needsDecision) return;
    let cancelled = false;
    setPlanning(true);
    setPlanError(null);
    PlanPasswordWrite(profileId, { ...target, options: options() }).then(
      (p) => { if (!cancelled && p) setPlan(p); },
      (err) => { if (!cancelled) setPlanError(err?.message || String(err)); },
    ).finally(() => { if (!cancelled) setPlanning(false); });
    return () => { cancelled = true; };
  }, [needsDecision, profileId, target, options]);

  const mustConfirm = plan.needsConfirm;
  const canContinue = !planning && !planError && !plan.needsDecision && (!mustConfirm || confirmed);
  const schemeOptions = schemes.length === 0
    ? [{ value: scheme, label: scheme }]
    : schemes.map((s) => {
      const sup = s.support.find((x) => x.server === serverType);
      const suffix = sup?.level === 'module' ? ' - needs server module' : sup?.level === 'system' ? ' - depends on the server\'s crypt(3)' : sup?.level === 'no' ? ' - not supported here' : '';
      // Weak / not hashed schemes are marked as in the connection dialog (RW3-P-03).
      return { value: s.id, label: `${schemeWithStrength(s.label, s.security)}${suffix}` };
    });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onCancel()}
      size="md"
      role="alertdialog"
      icon={mustConfirm && !needsDecision ? <ShieldAlert size={16} strokeWidth={1.75} aria-hidden className="text-warning" /> : <KeyRound size={16} strokeWidth={1.75} aria-hidden className="text-primary" />}
      title={needsDecision ? 'How should the password be stored?' : UNENCRYPTED_TITLE}
      initialFocus={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!canContinue}
            onClick={() => onConfirm(withUnencryptedConsent(options(), mustConfirm, confirmed, !!base.allowUnencrypted))}
          >
            {UNENCRYPTED_CONTINUE}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {base.asIs
          ? <p className="text-warning">{AS_IS_NOTICE}</p>
          : <p className="text-muted-foreground">{initialPlan.policy.summary}</p>}

        {needsDecision && (
          <RadioGroup
            aria-label="Password storage"
            value={decision}
            onValueChange={(v) => setDecision(v as 'client' | 'server')}
            options={[
              {
                value: 'client',
                label: 'Hash on the client',
                description: (
                  <Select
                    size="sm"
                    aria-label="Client-side hashing scheme"
                    value={scheme}
                    onChange={(e) => setScheme(e.target.value)}
                    disabled={decision !== 'client'}
                    options={schemeOptions}
                    className="mt-1"
                  />
                ),
              },
              {
                value: 'server',
                label: 'Server-side hashing',
                description: initialPlan.policy.serverHashes
                  ? `The server hashes cleartext passwords${serverHashingScheme(initialPlan.policy.serverHashing)}.`
                  : initialPlan.policy.passwordModifyExop
                    ? 'A single password change uses the Password Modify extended operation (RFC 3062); other writes send cleartext, which this server may store unhashed.'
                    : 'This server is not known to hash cleartext passwords and may store them as sent.',
              },
            ]}
          />
        )}

        {planning && <div className="flex items-center gap-1.5 text-muted-foreground"><Spinner size="sm" decorative /> Checking…</div>}
        {planError && <InlineAlert tone="danger" body={planError} />}

        {!planning && plan.actions.length > 0 && !!entries && entries > 1 && (
          <p className="text-muted-foreground">For each of the {entries} entries:</p>
        )}
        {!planning && plan.actions.length > 0 && (
          <ul className="space-y-0.5 text-muted-foreground">
            {plan.actions.map((a, i) => (
              <li key={i} className="flex items-start gap-1.5"><Info size={12} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0" /><span>{a}</span></li>
            ))}
          </ul>
        )}
        {!planning && plan.warnings.length > 0 && (
          <ul className="space-y-0.5 text-warning">
            {plan.warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-1.5"><AlertTriangle size={12} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0" /><span>{w}</span></li>
            ))}
          </ul>
        )}

        {/* The one unencrypted-send consent (DEF-21), as in Reset Password. */}
        {mustConfirm && !planning && <UnencryptedConsent checked={confirmed} onCheckedChange={setConfirmed} />}
      </div>
    </Dialog>
  );
}
