/**
 * Export Connections… (DEF-06): a checklist of the saved profiles. Every
 * profile is checked, or the Connections list's multi-selection when it has
 * more than one; "Export n Connections…" opens the save dialog. Passwords
 * are never exported (Go exportProfiles).
 */
import { useMemo, useRef, useState } from 'react'
import { FileOutput } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { initialExportChoice } from './profileLogic'

export interface ExportConnectionsDialogProps {
  /** Profiles to check initially (the Connections list's multi-selection). */
  preselected?: string[]
  /** Called with the chosen profile ids (in list order) after the dialog closed. */
  onExport: (ids: string[]) => void
  onClose: () => void
}

export function ExportConnectionsDialog({ preselected, onExport, onClose }: ExportConnectionsDialogProps) {
  const profiles = useConnectionStore((s) => s.profiles)
  const ids = useMemo(() => profiles.map((p) => p.id), [profiles])
  const [chosen, setChosen] = useState<Set<string>>(() => initialExportChoice(ids, preselected))
  const firstRef = useRef<HTMLInputElement>(null)
  const count = ids.filter((id) => chosen.has(id)).length
  const all = count === ids.length && ids.length > 0

  const toggle = (id: string, on: boolean) =>
    setChosen((cur) => {
      const next = new Set(cur)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Export Connections"
      description="Passwords are never exported. Imported profiles ask for theirs on the first connect."
      icon={FileOutput}
      size="md"
      dismissible="always"
      initialFocus={firstRef}
      onSubmit={() => {
        if (count === 0) return
        const list = ids.filter((id) => chosen.has(id))
        onClose()
        onExport(list)
      }}
      bodyClassName="space-y-2"
      footer={
        <>
          <span className="mr-auto text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {count} of {ids.length} selected
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" leftIcon={FileOutput} disabled={count === 0}>
            {count === 1 ? 'Export 1 Connection…' : `Export ${count} Connections…`}
          </Button>
        </>
      }
    >
      <Checkbox
        ref={firstRef}
        checked={all}
        indeterminate={count > 0 && !all}
        onCheckedChange={(on) => setChosen(on ? new Set(ids) : new Set())}
        label="All connections"
        className="px-2"
      />
      <ul className="max-h-72 overflow-auto rounded border border-border divide-y divide-border" aria-label="Connections to export">
        {profiles.map((p) => (
          <li key={p.id} className="px-2 py-1.5">
            <Checkbox
              checked={chosen.has(p.id)}
              onCheckedChange={(on) => toggle(p.id, on)}
              label={p.name || 'Unnamed'}
              description={
                <span className="font-mono">
                  {p.host}:{p.port}
                  {p.baseDN.trim() ? ` · ${p.baseDN}` : ''}
                  {p.askPassword ? <span className="font-sans"> · asks for the password on every connect</span> : null}
                </span>
              }
            />
          </li>
        ))}
      </ul>
    </Dialog>
  )
}
