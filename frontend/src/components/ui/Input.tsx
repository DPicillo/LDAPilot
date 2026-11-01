import {
  useEffect,
  useRef,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useFieldControl } from './Field'
import { Kbd } from './Kbd'
import { isEditableTarget, matchShortcut } from './shortcuts'

function mergeRefs<T>(...refs: (Ref<T> | undefined)[]) {
  return (v: T | null) => {
    for (const r of refs) {
      if (!r) continue
      if (typeof r === 'function') r(v)
      else (r as { current: T | null }).current = v
    }
  }
}

/** Shared text-field look: control height, border-strong edge, ring edge on focus. */
const fieldBase =
  'bg-input text-foreground border border-border-strong rounded transition-[border-color,box-shadow] duration-100 hover:border-muted-foreground'
const fieldFocus = 'focus:outline-hidden focus:border-ring focus:ring-1 focus:ring-ring'
const fieldFocusWithin = 'focus-within:border-ring focus-within:ring-1 focus-within:ring-ring'
const fieldDisabled = 'disabled:cursor-not-allowed disabled:bg-muted disabled:text-disabled-foreground disabled:border-border'
const fieldInvalid = 'aria-invalid:border-destructive aria-invalid:focus:ring-destructive'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix' | 'size'> {
  /** default: bordered field; inline: borderless filter field with a focus ring. */
  variant?: 'default' | 'inline'
  size?: 'sm' | 'md'
  prefix?: ReactNode
  suffix?: ReactNode
  mono?: boolean
  invalid?: boolean
  /** Class for the outer wrapper when prefix/suffix are used. */
  wrapperClassName?: string
  ref?: Ref<HTMLInputElement>
}

export function Input({
  variant = 'default',
  size = 'md',
  prefix,
  suffix,
  mono,
  invalid,
  className,
  wrapperClassName,
  id,
  required,
  disabled,
  type = 'text',
  ref,
  ...rest
}: InputProps) {
  const field = useFieldControl({ id, required, 'aria-describedby': rest['aria-describedby'], 'aria-invalid': invalid || rest['aria-invalid'] === true })
  const h = size === 'sm' ? 'h-control-sm text-xs' : 'h-control text-sm'
  const text = cn('placeholder:text-muted-foreground', mono && 'font-mono')
  const common = { ...rest, ...field, type, disabled, ref }
  if (!prefix && !suffix) {
    return (
      <input
        {...common}
        className={cn(
          'w-full min-w-0 px-2',
          h,
          text,
          variant === 'default'
            ? [fieldBase, fieldFocus, fieldDisabled, fieldInvalid]
            : 'bg-transparent border border-transparent rounded focus:outline-hidden focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring disabled:text-disabled-foreground',
          className,
        )}
      />
    )
  }
  return (
    <div
      className={cn(
        'flex items-center w-full min-w-0 gap-1.5 px-2',
        h,
        variant === 'default'
          ? [fieldBase, fieldFocusWithin, disabled && 'bg-muted border-border cursor-not-allowed', (invalid || field['aria-invalid']) && 'border-destructive']
          : 'bg-transparent border border-transparent rounded has-focus-visible:border-ring has-focus-visible:ring-1 has-focus-visible:ring-ring',
        wrapperClassName,
      )}
    >
      {prefix && <span className="flex items-center text-muted-foreground shrink-0">{prefix}</span>}
      <input
        {...common}
        className={cn('flex-1 min-w-0 h-full bg-transparent outline-hidden disabled:cursor-not-allowed disabled:text-disabled-foreground', text, className)}
      />
      {suffix && <span className="flex items-center text-muted-foreground shrink-0">{suffix}</span>}
    </div>
  )
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean
  invalid?: boolean
  ref?: Ref<HTMLTextAreaElement>
}

/** Multi-line field. Inside a Dialog with onSubmit, Ctrl+Enter submits. */
export function Textarea({ mono, invalid, className, id, required, rows = 3, ref, ...rest }: TextareaProps) {
  const field = useFieldControl({ id, required, 'aria-describedby': rest['aria-describedby'], 'aria-invalid': invalid })
  return (
    <textarea
      {...rest}
      {...field}
      ref={ref}
      rows={rows}
      className={cn('w-full min-w-0 px-2 py-1.5 text-sm resize-y placeholder:text-muted-foreground', fieldBase, fieldFocus, fieldDisabled, fieldInvalid, mono && 'font-mono', className)}
    />
  )
}

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  options?: SelectOption[]
  size?: 'sm' | 'md'
  invalid?: boolean
  ref?: Ref<HTMLSelectElement>
}

/** Native select with the themed chevron (native popup follows color-scheme). */
export function Select({ options, size = 'md', invalid, className, id, required, children, ref, ...rest }: SelectProps) {
  const field = useFieldControl({ id, required, 'aria-describedby': rest['aria-describedby'], 'aria-invalid': invalid })
  return (
    <select
      {...rest}
      {...field}
      ref={ref}
      className={cn(
        'w-full min-w-0 pl-2 pr-7 appearance-none cursor-pointer',
        'bg-(image:--select-chevron) bg-no-repeat bg-position-[right_0.25rem_center] bg-size-[1.25em_1.25em]',
        size === 'sm' ? 'h-control-sm text-xs' : 'h-control text-sm',
        fieldBase,
        fieldFocus,
        fieldDisabled,
        fieldInvalid,
        className,
      )}
    >
      {options?.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
      {children}
    </select>
  )
}

export interface SearchInputProps extends Omit<InputProps, 'onChange' | 'value' | 'prefix' | 'suffix' | 'type'> {
  value: string
  onValueChange: (value: string) => void
  /** Hint shown at the right end while empty ('Mod+F'). */
  shortcut?: string
  /** Binds this key to focus the field ('/' or 'Mod+F') while `focusKeyActive` is true. */
  focusKey?: string
  focusKeyActive?: boolean
  /** Called on Escape when the field is already empty (after blurring). */
  onEscape?: () => void
}

/**
 * Search field: icon, clear button, shortcut hint. Escape clears; a second
 * Escape blurs. `focusKey` focuses it while the owning panel is active.
 */
export function SearchInput({
  value,
  onValueChange,
  shortcut,
  focusKey,
  focusKeyActive = true,
  onEscape,
  onKeyDown,
  placeholder = 'Search',
  size = 'md',
  ref,
  ...rest
}: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!focusKey || !focusKeyActive) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || !matchShortcut(e, focusKey)) return
      // A plain key ('/') must not steal typing from another field.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && isEditableTarget(e.target)) return
      if (document.querySelector('[aria-modal="true"]')) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusKey, focusKeyActive])

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e)
    if (e.defaultPrevented || e.key !== 'Escape') return
    // An empty field in a modal dialog leaves Escape to the dialog (it closes a
    // clean dialog, SPEC 6.4): blurring would drop focus to <body> while the
    // aria-modal dialog stays open.
    if (!value && !onEscape && e.currentTarget.closest('[aria-modal="true"]')) return
    e.preventDefault()
    e.stopPropagation()
    if (value) onValueChange('')
    else {
      e.currentTarget.blur()
      onEscape?.()
    }
  }

  return (
    <Input
      {...rest}
      ref={mergeRefs(inputRef, ref)}
      type="search"
      size={size}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onValueChange(e.target.value)}
      onKeyDown={handleKeyDown}
      className="[&::-webkit-search-cancel-button]:hidden"
      prefix={<Search size={size === 'sm' ? 12 : 14} strokeWidth={1.75} aria-hidden />}
      suffix={
        value ? (
          <button type="button"
            aria-label="Clear search"
            tabIndex={-1}
            onClick={() => {
              onValueChange('')
              inputRef.current?.focus()
            }}
            className="inline-flex items-center justify-center size-4 rounded-xs text-muted-foreground hover:text-foreground hover:bg-accent"
          >
            <X size={12} strokeWidth={1.75} aria-hidden />
          </button>
        ) : shortcut ? (
          <Kbd shortcut={shortcut} bare />
        ) : null
      }
    />
  )
}
