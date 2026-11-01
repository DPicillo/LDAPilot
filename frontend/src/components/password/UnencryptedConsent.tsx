/**
 * The one "send the password unencrypted?" confirmation (DEF-21; texts in
 * lib/unencryptedConsent.ts): the consent box, and the dialog built on it
 * for a single write (Reset Password). The password write guard puts the
 * same box into its storage dialog; the AI approval card uses the same
 * sentence for its confirmation checkbox.
 */
import { useRef, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { cn } from '../../lib/utils'
import { UNENCRYPTED_CONSENT, UNENCRYPTED_CONTINUE, UNENCRYPTED_TITLE } from '../../lib/unencryptedConsent'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Dn } from '../ui/Dn'

/** The consent checkbox in its warning box (unticked: warning colours). */
export function UnencryptedConsent({ checked, onCheckedChange, className }: { checked: boolean; onCheckedChange: (v: boolean) => void; className?: string }) {
  return (
    <div className={cn('px-2.5 py-2 rounded', checked ? 'bg-secondary' : 'bg-warning-subtle', className)}>
      <Checkbox
        checked={checked}
        onCheckedChange={onCheckedChange}
        label={<span className={checked ? undefined : 'text-warning'}>{UNENCRYPTED_CONSENT}</span>}
      />
    </div>
  )
}

export interface UnencryptedSendDialogProps {
  /** What crosses the connection in cleartext (unencryptedWhat). */
  what: string
  /** The entry the password is for. */
  dn?: string
  onCancel: () => void
  /** Only called after the consent box was ticked. */
  onConfirm: () => void
}

/** "Send the password unencrypted?" for one write: Cancel (focused) · Continue (needs the consent). */
export function UnencryptedSendDialog({ what, dn, onCancel, onConfirm }: UnencryptedSendDialogProps) {
  const [consent, setConsent] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onCancel()}
      size="md"
      role="alertdialog"
      icon={<ShieldAlert size={16} strokeWidth={1.75} aria-hidden className="text-warning" />}
      title={UNENCRYPTED_TITLE}
      initialFocus={cancelRef}
      // Enter sends only with the consent ticked (the form submit stops at this dialog, ACCT-01).
      onSubmit={() => { if (consent) onConfirm() }}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!consent}>{UNENCRYPTED_CONTINUE}</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{what}</p>
        {dn && <Dn dn={dn} className="block text-sm text-foreground" />}
        <UnencryptedConsent checked={consent} onCheckedChange={setConsent} />
      </div>
    </Dialog>
  )
}
