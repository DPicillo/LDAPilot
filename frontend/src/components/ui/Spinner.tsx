import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface SpinnerProps {
  size?: 'sm' | 'md'
  /** Accessible name; omit together with `decorative` when a parent already says "busy". */
  label?: string
  decorative?: boolean
  className?: string
}

/** Loader2 only; 12px (sm) or 16px (md). */
export function Spinner({ size = 'md', label = 'Loading', decorative, className }: SpinnerProps) {
  const px = size === 'sm' ? 12 : 16
  return (
    <LoaderCircle
      size={px}
      strokeWidth={1.75}
      className={cn('animate-spin shrink-0', className)}
      role={decorative ? undefined : 'status'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
    />
  )
}

export interface SkeletonProps {
  /** tree: 22px rows, table: --table-row-h rows, text: one line block. */
  variant?: 'tree' | 'table' | 'text'
  rows?: number
  className?: string
}

const WIDTHS = ['62%', '48%', '71%', '55%', '40%', '66%', '51%', '58%']

/** Placeholder rows while a list loads (use with useDelayedFlag to avoid flicker). */
export function Skeleton({ variant = 'text', rows = 1, className }: SkeletonProps) {
  return (
    <div className={cn('flex flex-col', className)} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className={cn(
            'flex items-center gap-2',
            variant === 'tree' && 'h-row px-2',
            variant === 'table' && 'h-table-row px-2 border-b border-border',
            variant === 'text' && 'h-4 my-1',
          )}
          style={variant === 'tree' ? { paddingLeft: 6 + 12 * (i % 3) } : undefined}
        >
          {variant === 'tree' && <div className="size-3.5 rounded-xs bg-muted animate-pulse shrink-0" />}
          <div className="h-2.5 rounded-xs bg-muted animate-pulse" style={{ width: WIDTHS[i % WIDTHS.length] }} />
        </div>
      ))}
    </div>
  )
}

export interface ProgressBarProps {
  /** 0..max; omit for an indeterminate bar. */
  value?: number
  max?: number
  label?: string
  className?: string
}

/** Determinate, or indeterminate when `value` is omitted. */
export function ProgressBar({ value, max = 100, label = 'Progress', className }: ProgressBarProps) {
  const barRef = useRef<HTMLDivElement>(null)
  const indeterminate = value === undefined
  useEffect(() => {
    const el = barRef.current
    if (!indeterminate || !el || typeof el.animate !== 'function') return
    let reduce = false
    try { reduce = matchMedia('(prefers-reduced-motion: reduce)').matches } catch { /* old engines */ }
    if (reduce) return
    const anim = el.animate(
      [{ transform: 'translateX(-100%)' }, { transform: 'translateX(250%)' }],
      { duration: 1200, iterations: Infinity, easing: 'ease-in-out' },
    )
    return () => anim.cancel()
  }, [indeterminate])
  const pct = indeterminate ? 40 : Math.max(0, Math.min(100, (value / max) * 100))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : max}
      aria-valuenow={indeterminate ? undefined : value}
      className={cn('relative h-1 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      <div
        ref={barRef}
        className={cn('h-full rounded-full bg-primary', !indeterminate && 'transition-[width] duration-200')}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

/** True only after `flag` has stayed true for `delay` ms (no spinner flicker on fast calls). */
export function useDelayedFlag(flag: boolean, delay = 200): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!flag) {
      setOn(false)
      return
    }
    const t = setTimeout(() => setOn(true), delay)
    return () => clearTimeout(t)
  }, [flag, delay])
  return flag && on
}
