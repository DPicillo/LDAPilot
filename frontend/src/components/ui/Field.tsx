import { createContext, useContext, useId, type ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface FieldControlProps {
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: true
  required?: boolean
}

interface FieldContextValue {
  id: string
  describedBy?: string
  invalid: boolean
  required: boolean
}

const FieldContext = createContext<FieldContextValue | null>(null)

/**
 * Props a control inside <Field> should carry (id, aria-describedby,
 * aria-invalid, required). Explicit props on the control win.
 */
export function useFieldControl(own: { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean | 'true' | 'false'; required?: boolean } = {}): Partial<FieldControlProps> {
  const f = useContext(FieldContext)
  const ownInvalid = own['aria-invalid'] === true || own['aria-invalid'] === 'true'
  if (!f) {
    return {
      ...(own.id !== undefined && { id: own.id }),
      'aria-describedby': own['aria-describedby'],
      'aria-invalid': ownInvalid ? true : undefined,
      required: own.required,
    }
  }
  const describedBy = [own['aria-describedby'], f.describedBy].filter(Boolean).join(' ') || undefined
  return {
    id: own.id ?? f.id,
    'aria-describedby': describedBy,
    'aria-invalid': f.invalid || ownInvalid ? true : undefined,
    required: own.required ?? (f.required || undefined),
  }
}

export interface FieldProps {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  /** stacked: label above; inline: 160px label column. */
  layout?: 'stacked' | 'inline'
  /** Override the generated control id. */
  id?: string
  className?: string
  /** The control (Input, Select, Textarea...). It picks up id/aria wiring from context. */
  children: ReactNode
}

/**
 * Label + control + hint/error. Generates the id with useId and wires
 * htmlFor, aria-describedby and aria-invalid (SPEC 6.3).
 */
export function Field({ label, hint, error, required = false, layout = 'stacked', id, className, children }: FieldProps) {
  const auto = useId()
  const controlId = id ?? `f${auto.replace(/:/g, '')}`
  const hintId = hint ? `${controlId}-hint` : undefined
  const errorId = error ? `${controlId}-err` : undefined
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined
  const inline = layout === 'inline'
  return (
    <FieldContext.Provider value={{ id: controlId, describedBy, invalid: !!error, required }}>
      <div className={cn(inline ? 'grid grid-cols-[160px_minmax(0,1fr)] items-start gap-x-3' : 'flex flex-col gap-1', className)}>
        <label
          htmlFor={controlId}
          className={cn('text-sm font-medium text-muted-foreground', inline && 'pt-1.5 leading-4 truncate')}
        >
          {label}
          {required && (
            <span className="text-destructive ml-0.5" aria-hidden="true">
              *
            </span>
          )}
        </label>
        <div className="flex flex-col gap-1 min-w-0">
          {children}
          {error && (
            <p id={errorId} className="flex items-start gap-1 text-xs text-destructive" aria-live="polite">
              <CircleAlert size={12} strokeWidth={1.75} className="mt-px shrink-0" aria-hidden />
              <span>{error}</span>
            </p>
          )}
          {hint && (
            <p id={hintId} className="text-xs text-muted-foreground">
              {hint}
            </p>
          )}
        </div>
      </div>
    </FieldContext.Provider>
  )
}
