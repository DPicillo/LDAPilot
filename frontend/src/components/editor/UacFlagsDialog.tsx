import { useEffect, useMemo, useState } from 'react'
import { ShieldAlert, AlertTriangle, Lock, ArrowLeft } from 'lucide-react'
import { UAC_FLAG_INFO, diffUac, formatUac, isUacFlagShownSet, rebaseUacDraft, setUacBit, uacChangeWeakens } from '../../lib/uac'
import { SetUserAccountControl, errorMessage, isAccountConflict } from '../../lib/wails-account'
import { accountDisplayName } from '../../lib/accountActions'
import { cn } from '../../lib/utils'
import { toast } from '../ui/Toast'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Checkbox } from '../ui/Checkbox'
import { InlineAlert } from '../ui/InlineAlert'
import { Dn } from '../ui/Dn'
import { DialogCancelButton } from './DialogCancelButton'
import { afterAccountChange } from '../commands/accountState'

interface UacFlagsDialogProps {
  profileId: string;
  dn: string;
  /**
   * userAccountControl as read with the account status. When it changes
   * (status reloaded), the edits are re-applied on the new value.
   */
  value: number;
  /** msDS-User-Account-Control-Computed (LOCKOUT / PASSWORD_EXPIRED). */
  computed: number;
  onClose: () => void;
  onSaved: () => void;
  /** Reads the account status again (called when the server value changed meanwhile). */
  onConflict?: () => void;
}

/**
 * Checkbox editor for the AD userAccountControl flags. Saving shows a review
 * step first; flags that weaken security are highlighted there. The backend
 * only applies the change when the value on the server is still the edit
 * base. When it is not (conflict), the status is read again and the edits
 * are re-applied on the current value for another review.
 */
export function UacFlagsDialog({ profileId, dn, value, computed, onClose, onSaved, onConflict }: UacFlagsDialogProps) {
  // The value the edit is based on (sent as the expected value).
  const [base, setBase] = useState(value >>> 0);
  const [draft, setDraft] = useState(value >>> 0);
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const diff = useMemo(() => diffUac(base, draft), [base, draft]);
  const weakens = uacChangeWeakens(diff);
  const changed = draft !== base;

  // A newer server value (status reloaded): keep the user's edits on top of it.
  useEffect(() => {
    const fresh = value >>> 0;
    if (fresh === base) return;
    setDraft(d => rebaseUacDraft(base, d, fresh));
    setBase(fresh);
    setReviewing(false);
    setError(null);
    setNotice(`userAccountControl was changed on the server (${formatUac(base)} -> ${formatUac(fresh)}). `
      + 'Your edits were applied to the current value; review them and apply again.');
  }, [value, base]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await SetUserAccountControl(profileId, dn, base, draft);
      toast.success(`userAccountControl of ${accountDisplayName(dn)} set to ${formatUac(draft)}`);
      // One status read the views share; they get it with the event (RW1-P-06).
      void afterAccountChange(profileId, dn);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err, 'Failed to save userAccountControl'));
      setReviewing(false);
      // Read the current value; the effect above re-applies the edits on it.
      if (isAccountConflict(err)) onConflict?.();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !saving && onClose()}
      size="lg"
      icon={<ShieldAlert size={16} strokeWidth={1.75} aria-hidden className="text-primary" />}
      title={reviewing ? 'Review userAccountControl change' : 'userAccountControl flags'}
      description={
        <span className="flex items-center gap-3 min-w-0">
          <Dn dn={dn} className="flex-1 min-w-0" />
          <span className="shrink-0 tabular-nums">
            {formatUac(base)}
            {changed && <> {'→'} <span className="text-foreground font-medium">{formatUac(draft)}</span></>}
          </span>
        </span>
      }
      dismissible={saving ? 'never' : 'when-clean'}
      dirty={changed}
      footer={reviewing ? (
        <>
          <Button variant="secondary" leftIcon={ArrowLeft} onClick={() => setReviewing(false)} disabled={saving} className="mr-auto">Back</Button>
          <DialogCancelButton disabled={saving} />
          <Button
            variant={weakens ? 'danger' : 'primary'}
            onClick={save}
            loading={saving}
            autoFocus
          >
            {weakens ? 'Apply anyway' : 'Apply'}
          </Button>
        </>
      ) : (
        <>
          {changed && <Button variant="ghost" onClick={() => setDraft(base)} className="mr-auto">Reset</Button>}
          <DialogCancelButton />
          <Button variant="primary" disabled={!changed} onClick={() => { setError(null); setNotice(null); setReviewing(true); }}>
            Review changes…
          </Button>
        </>
      )}
    >
      {!reviewing ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
          {UAC_FLAG_INFO.map(flag => {
            const checked = isUacFlagShownSet(draft, computed, flag.bit);
            const locked = !!flag.readOnly;
            const isDanger = !!flag.danger;
            return (
              <div
                key={flag.bit}
                className={cn(
                  'px-2 py-1.5 rounded border',
                  !locked && isDanger ? 'border-destructive' : 'border-transparent',
                  isDanger && checked && 'bg-destructive-subtle',
                  !locked && 'hover:bg-accent',
                )}
                title={flag.readOnly || flag.danger || flag.description}
              >
                <Checkbox
                  checked={checked}
                  disabled={locked || saving}
                  onCheckedChange={(v) => setDraft(d => setUacBit(d, flag.bit, v))}
                  label={
                    <span className="flex items-center gap-1 flex-wrap">
                      <span className={cn('font-medium', isDanger ? 'text-destructive' : locked ? 'text-disabled-foreground' : 'text-foreground')}>{flag.label}</span>
                      {isDanger && <AlertTriangle size={12} strokeWidth={1.75} aria-hidden className="text-destructive shrink-0" />}
                      {locked && <Lock size={12} strokeWidth={1.75} aria-label="read-only" className="text-muted-foreground shrink-0" />}
                    </span>
                  }
                  description={
                    <>
                      <span className="block font-mono">{flag.name} (0x{flag.bit.toString(16).toUpperCase()})</span>
                      <span className="block leading-snug mt-0.5">{flag.description}</span>
                      {isDanger && <span className="block text-destructive leading-snug mt-0.5">{flag.danger}</span>}
                      {locked && <span className="block italic leading-snug mt-0.5">{flag.readOnly}</span>}
                    </>
                  }
                  className="w-full"
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          {weakens && (
            <InlineAlert
              tone="danger"
              title="This change weakens the security of the account"
              body={<>
                {diff.dangerousAdded.map(f => (
                  <div key={f.bit}>
                    <span className="font-mono font-medium">+ {f.name}</span>
                    <span className="text-foreground">: {f.danger}</span>
                  </div>
                ))}
                {diff.dangerousRemoved.map(f => (
                  <div key={f.bit}>
                    <span className="font-mono font-medium">- {f.name}</span>
                    <span className="text-foreground">: {f.protective}</span>
                  </div>
                ))}
              </>}
            />
          )}
          {diff.added.length > 0 && (
            <div>
              <div className="text-muted-foreground mb-1">Flags to set</div>
              <ul className="space-y-0.5">
                {diff.added.map(f => (
                  <li key={f.bit} className={cn('font-mono', f.danger ? 'text-destructive' : 'text-success')}>+ {f.name} <span className="font-sans text-muted-foreground">({f.label})</span></li>
                ))}
              </ul>
            </div>
          )}
          {diff.removed.length > 0 && (
            <div>
              <div className="text-muted-foreground mb-1">Flags to clear</div>
              <ul className="space-y-0.5">
                {diff.removed.map(f => (
                  <li key={f.bit} className={cn('font-mono', f.protective ? 'text-destructive' : 'text-foreground')}>- {f.name} <span className="font-sans text-muted-foreground">({f.label})</span></li>
                ))}
              </ul>
            </div>
          )}
          <div className="text-muted-foreground">
            New value: <span className="font-mono text-foreground">{formatUac(draft)}</span>. The change is only applied if
            userAccountControl on the server is still {formatUac(base)}.
          </div>
        </div>
      )}

      {notice && !error && <InlineAlert tone="info" className="mt-3" body={<span className="break-words">{notice}</span>} />}
      {error && <InlineAlert tone="danger" className="mt-3" body={<span className="break-words">{error}</span>} />}
    </Dialog>
  );
}
