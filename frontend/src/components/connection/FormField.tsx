import type { ReactNode } from 'react'
import { FolderOpen } from 'lucide-react'
import { Field as UIField } from '../ui/Field'
import { Input } from '../ui/Input'
import { Button } from '../ui/Button'

/**
 * A field of the connection dialog: the Field primitive (label wired to the
 * control with htmlFor, hint and error via aria-describedby, aria-invalid).
 * The help text gives way to the error, as before.
 */
export function Field({ label, error, help, required, className, children }: {
  label: ReactNode
  error?: string
  help?: ReactNode
  required?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <UIField label={label} error={error || undefined} hint={error ? undefined : help} required={required} className={className}>
      {children}
    </UIField>
  )
}

/** Text input for a file path with a "Browse…" button (the input takes the Field's id). */
export function PathInput({ value, onChange, onBrowse, placeholder, browseLabel = 'Browse…' }: {
  value: string
  onChange: (value: string) => void
  onBrowse: () => void
  placeholder?: string
  browseLabel?: string
}) {
  return (
    <div className="flex gap-1.5 min-w-0">
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} mono spellCheck={false} />
      <Button variant="secondary" leftIcon={FolderOpen} aria-label={browseLabel} title={browseLabel} className="px-2 shrink-0" onClick={onBrowse} />
    </div>
  )
}
