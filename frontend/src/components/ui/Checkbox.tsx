import { useEffect, useId, useRef, type InputHTMLAttributes, type ReactNode, type Ref } from 'react'
import { Check, Minus } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useFieldControl } from './Field'

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'onChange'> {
  indeterminate?: boolean
  onCheckedChange?: (checked: boolean) => void
  onChange?: InputHTMLAttributes<HTMLInputElement>['onChange']
  label?: ReactNode
  description?: ReactNode
  ref?: Ref<HTMLInputElement>
}

/** 14px box, border-strong edge, primary check, indeterminate state. Native input = native keyboard/a11y. */
export function Checkbox({
  indeterminate,
  onCheckedChange,
  onChange,
  label,
  description,
  className,
  id,
  disabled,
  ref,
  ...rest
}: CheckboxProps) {
  const inner = useRef<HTMLInputElement | null>(null)
  const field = useFieldControl({ id, 'aria-describedby': rest['aria-describedby'] })
  const auto = useId()
  const inputId = field.id ?? (label ? `cb${auto.replace(/:/g, '')}` : undefined)
  const descId = description && inputId ? `${inputId}-desc` : undefined

  useEffect(() => {
    if (inner.current) inner.current.indeterminate = !!indeterminate
  }, [indeterminate])

  const box = (
    <span className="relative inline-flex size-3.5 shrink-0">
      <input
        {...rest}
        {...field}
        id={inputId}
        aria-describedby={[field['aria-describedby'], descId].filter(Boolean).join(' ') || undefined}
        aria-checked={indeterminate ? 'mixed' : undefined}
        ref={(el) => {
          inner.current = el
          if (typeof ref === 'function') ref(el)
          else if (ref) (ref as { current: HTMLInputElement | null }).current = el
        }}
        type="checkbox"
        disabled={disabled}
        onChange={(e) => {
          onChange?.(e)
          onCheckedChange?.(e.target.checked)
        }}
        className={cn(
          'peer appearance-none size-3.5 m-0 rounded-xs border border-border-strong bg-input cursor-pointer',
          'checked:bg-primary checked:border-primary indeterminate:bg-primary indeterminate:border-primary',
          'hover:border-muted-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:border-border',
          'disabled:checked:bg-disabled-foreground disabled:checked:border-disabled-foreground',
          !label && className,
        )}
      />
      <Check
        size={12}
        strokeWidth={3}
        aria-hidden
        className="pointer-events-none absolute inset-px hidden text-primary-foreground peer-checked:block peer-indeterminate:hidden"
      />
      <Minus
        size={12}
        strokeWidth={3}
        aria-hidden
        className="pointer-events-none absolute inset-px hidden text-primary-foreground peer-indeterminate:block"
      />
    </span>
  )
  if (!label) return box
  return (
    <label
      htmlFor={inputId}
      aria-disabled={disabled || undefined}
      className={cn('inline-flex items-start gap-2 text-sm select-none', disabled ? 'text-disabled-foreground cursor-not-allowed' : 'cursor-pointer', className)}
    >
      <span className="flex items-center h-4">{box}</span>
      <span className="flex flex-col gap-0.5 min-w-0">
        <span className="leading-4">{label}</span>
        {description && (
          <span id={descId} className={cn('text-xs', disabled ? 'text-disabled-foreground' : 'text-muted-foreground')}>
            {description}
          </span>
        )}
      </span>
    </label>
  )
}

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label?: ReactNode
  disabled?: boolean
  id?: string
  className?: string
  'aria-label'?: string
}

/** On/off switch (button role=switch). Use for settings that apply immediately. */
export function Switch({ checked, onCheckedChange, label, disabled, id, className, ...aria }: SwitchProps) {
  const field = useFieldControl({ id })
  const auto = useId()
  const btnId = field.id ?? `sw${auto.replace(/:/g, '')}`
  const btn = (
    <button type="button"
      role="switch"
      id={btnId}
      aria-checked={checked}
      aria-label={aria['aria-label']}
      aria-describedby={field['aria-describedby']}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors duration-100',
        checked ? 'bg-primary border-primary' : 'bg-muted border-border-strong',
        'disabled:cursor-not-allowed disabled:bg-muted disabled:border-border',
        !label && className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'block size-2.5 rounded-full transition-transform duration-100',
          checked ? 'translate-x-[13px] bg-primary-foreground' : 'translate-x-[2px] bg-muted-foreground',
          disabled && 'bg-disabled-foreground',
        )}
      />
    </button>
  )
  if (!label) return btn
  return (
    <span className={cn('inline-flex items-center gap-2 text-sm', disabled && 'text-disabled-foreground', className)}>
      {btn}
      <label htmlFor={btnId} aria-disabled={disabled || undefined} className={disabled ? 'cursor-not-allowed' : 'cursor-pointer'}>
        {label}
      </label>
    </span>
  )
}

export interface RadioOption {
  value: string
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
}

export interface RadioGroupProps {
  options: RadioOption[]
  value: string
  onValueChange: (value: string) => void
  name?: string
  orientation?: 'vertical' | 'horizontal'
  disabled?: boolean
  className?: string
  'aria-label'?: string
  'aria-labelledby'?: string
}

/** Native radios (arrow keys move and select) in a labelled radiogroup. */
export function RadioGroup({ options, value, onValueChange, name, orientation = 'vertical', disabled, className, ...aria }: RadioGroupProps) {
  const auto = useId()
  const groupName = name ?? `rg${auto.replace(/:/g, '')}`
  const field = useFieldControl({})
  return (
    <div
      role="radiogroup"
      aria-label={aria['aria-label']}
      aria-labelledby={aria['aria-labelledby']}
      aria-describedby={field['aria-describedby']}
      id={field.id}
      className={cn('flex gap-2', orientation === 'vertical' ? 'flex-col' : 'flex-row flex-wrap gap-x-4', className)}
    >
      {options.map((o) => {
        const id = `${groupName}-${o.value.replace(/[^\w-]/g, '_')}`
        const dis = disabled || o.disabled
        return (
          <label key={o.value} htmlFor={id} aria-disabled={dis || undefined} className={cn('inline-flex items-start gap-2 text-sm', dis ? 'text-disabled-foreground cursor-not-allowed' : 'cursor-pointer')}>
            <span className="flex items-center h-4">
              <input
                id={id}
                type="radio"
                name={groupName}
                value={o.value}
                checked={value === o.value}
                disabled={dis}
                onChange={() => onValueChange(o.value)}
                className={cn(
                  'appearance-none size-3.5 m-0 rounded-full border border-border-strong bg-input cursor-pointer shrink-0',
                  'checked:border-primary checked:border-4 hover:border-muted-foreground',
                  'disabled:cursor-not-allowed disabled:bg-muted disabled:border-border',
                )}
              />
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="leading-4">{o.label}</span>
              {o.description && <span className={cn('text-xs', dis ? 'text-disabled-foreground' : 'text-muted-foreground')}>{o.description}</span>}
            </span>
          </label>
        )
      })}
    </div>
  )
}
