import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { renderIcon, type IconType } from './Button'

export interface SegmentedOption<T extends string = string> {
  value: T
  label: ReactNode
  icon?: IconType
  /** Accessible name when the label is visually hidden (iconOnly). */
  ariaLabel?: string
  /** Small count shown after the label. */
  count?: number
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string = string> {
  options: readonly SegmentedOption<T>[]
  value: T
  onValueChange: (value: T) => void
  size?: 'sm' | 'md'
  iconOnly?: boolean
  className?: string
  'aria-label'?: string
  'aria-labelledby'?: string
}

/**
 * role=radiogroup; arrows move AND select (roving tabindex on the checked
 * segment). Quick/Advanced, Direct/Effective, scope, error-only toggle...
 */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onValueChange,
  size = 'sm',
  iconOnly,
  className,
  ...aria
}: SegmentedControlProps<T>) {
  const ref = useRef<HTMLDivElement>(null)
  const enabled = options.filter((o) => !o.disabled)

  const move = (e: KeyboardEvent, dir: number | 'first' | 'last') => {
    e.preventDefault()
    if (!enabled.length) return
    const i = enabled.findIndex((o) => o.value === value)
    const next =
      dir === 'first' ? enabled[0] : dir === 'last' ? enabled[enabled.length - 1] : enabled[(i + dir + enabled.length) % enabled.length]
    onValueChange(next.value)
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus())
  }

  return (
    <div
      ref={ref}
      role="radiogroup"
      {...aria}
      className={cn('inline-flex items-center gap-0.5 p-0.5 rounded bg-secondary border border-border', className)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(e, 1)
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(e, -1)
        else if (e.key === 'Home') move(e, 'first')
        else if (e.key === 'End') move(e, 'last')
      }}
    >
      {options.map((o) => {
        const checked = o.value === value
        return (
          <button type="button"
            key={o.value}
            role="radio"
            aria-checked={checked}
            aria-label={iconOnly ? (o.ariaLabel ?? (typeof o.label === 'string' ? o.label : undefined)) : o.ariaLabel}
            data-value={o.value}
            tabIndex={checked ? 0 : -1}
            disabled={o.disabled}
            onClick={() => onValueChange(o.value)}
            className={cn(
              'inline-flex items-center justify-center gap-1 rounded-xs whitespace-nowrap transition-colors duration-100',
              size === 'sm' ? 'h-[18px] px-2 text-xs' : 'h-[20px] px-2.5 text-sm',
              iconOnly && 'px-1.5',
              checked
                ? 'bg-background text-foreground font-medium shadow-[0_0_0_1px_var(--color-border-strong)]'
                : 'text-muted-foreground enabled:hover:text-foreground enabled:hover:bg-accent',
              'disabled:text-disabled-foreground disabled:cursor-not-allowed',
            )}
          >
            {renderIcon(o.icon, 12)}
            {!iconOnly && o.label}
            {o.count !== undefined && <span className="tabular-nums text-xs">{o.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
