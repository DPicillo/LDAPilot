/**
 * ConfirmDialog, rebuilt on the Dialog primitive. Same export and props as
 * before (title, message, detail, confirmLabel, cancelLabel, variant,
 * onConfirm, onCancel); new optional ones: open, tone (= variant), detail as
 * a DN list, requireTyping (subtree delete), busy.
 */
import { useRef, useState, type ReactNode, type RefObject } from 'react'
import { CircleHelp, Trash2, TriangleAlert } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Dialog } from './Dialog'
import { Button } from './Button'
import { Input } from './Input'
import { Field } from './Field'
import { Dn } from './Dn'
import { typedNameMatches } from '../../lib/recycle'

export type ConfirmTone = 'default' | 'warning' | 'danger'

export interface ConfirmDialogProps {
  title: string
  message: ReactNode
  /** One DN / text, or a list of DNs (newline-separated strings become a list too). */
  detail?: string | string[]
  confirmLabel?: string
  cancelLabel?: string
  tone?: ConfirmTone
  /** @deprecated alias of `tone` (existing call sites). */
  variant?: ConfirmTone
  /** The user must type this text before confirming (non-empty subtree delete). */
  requireTyping?: string
  /** Shows a spinner on the confirm button and blocks closing. */
  busy?: boolean
  /** Defaults to true: existing call sites mount the component only while open. */
  open?: boolean
  /** Focus target on close when the trigger is gone or disabled by then (e.g. Clear empties the list). */
  returnFocus?: RefObject<HTMLElement | null>
  onConfirm: () => void
  onCancel: () => void
}

const ICON = {
  default: { Icon: CircleHelp, cls: 'bg-primary-subtle text-primary' },
  warning: { Icon: TriangleAlert, cls: 'bg-warning-subtle text-warning' },
  danger: { Icon: Trash2, cls: 'bg-destructive-subtle text-destructive' },
} as const

export function ConfirmDialog({
  title,
  message,
  detail,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone,
  variant,
  requireTyping,
  busy,
  open = true,
  returnFocus,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t: ConfirmTone = tone ?? variant ?? 'default'
  const [typed, setTyped] = useState('')
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Case, blanks and punctuation are folded (typedNameMatches, RW1-R-07).
  const typedOk = !requireTyping || typedNameMatches(typed, requireTyping)
  const list = Array.isArray(detail) ? detail : detail && detail.includes('\n') ? detail.split('\n').filter(Boolean) : null
  const { Icon, cls } = ICON[t]

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !busy && onCancel()}
      role="alertdialog"
      size={list && list.length > 1 ? 'md' : 'sm'}
      title={title}
      description={typeof message === 'string' ? message : undefined}
      icon={
        <span className={cn('inline-flex items-center justify-center size-8 rounded-full', cls)}>
          <Icon size={16} strokeWidth={1.75} aria-hidden />
        </span>
      }
      dismissible={busy ? 'never' : requireTyping && typed ? 'when-clean' : 'always'}
      dirty={!!requireTyping && typed.length > 0}
      initialFocus={requireTyping ? undefined : cancelRef}
      returnFocus={returnFocus}
      onSubmit={() => {
        if (typedOk && !busy) onConfirm()
      }}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button type="submit" variant={t === 'danger' ? 'danger' : 'primary'} disabled={!typedOk} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {typeof message !== 'string' && <div className="text-base text-muted-foreground">{message}</div>}
      {detail && !list && <Dn dn={String(detail)} className="block text-sm text-foreground" />}
      {list && (
        <ul className="max-h-40 overflow-auto rounded border border-border bg-background px-2 py-1 text-sm" aria-label="Affected entries">
          {list.map((d) => (
            <li key={d} className="py-0.5">
              <Dn dn={d} />
            </li>
          ))}
        </ul>
      )}
      {requireTyping && (
        <div className="mt-3">
          <Field label={<>Type <span className="font-mono text-foreground">{requireTyping}</span> to confirm</>} required>
            <Input mono autoComplete="off" spellCheck={false} value={typed} placeholder={requireTyping} onChange={(e) => setTyped(e.target.value)} />
          </Field>
        </div>
      )}
    </Dialog>
  )
}
