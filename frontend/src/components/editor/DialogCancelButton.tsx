import type { ReactNode } from 'react'
import { useDialogContext } from '../ui/Dialog'
import { Button } from '../ui/Button'

/**
 * Footer Cancel of a Dialog with a dirty guard: closes like Escape / X, so a
 * dialog with unsaved input shows "Discard changes?" instead of losing it.
 */
export function DialogCancelButton({ children = 'Cancel', disabled }: { children?: ReactNode; disabled?: boolean }) {
  const dialog = useDialogContext()
  return (
    <Button variant="secondary" disabled={disabled} onClick={() => dialog?.requestClose()}>
      {children}
    </Button>
  )
}
