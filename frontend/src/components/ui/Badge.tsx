import type { HTMLAttributes, ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'
import { renderIcon, type IconType } from './Button'

export type BadgeTone =
  | 'neutral'
  | 'primary'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'oc-user'
  | 'oc-group'
  | 'oc-ou'
  | 'oc-computer'
  | 'oc-contact'
  | 'oc-domain'
  | 'oc-container'
  | 'oc-service'

/*
 * Full class strings per tone so Tailwind sees them. Soft fills are the
 * OPAQUE *-subtle tokens (never tone/15), which keep >= 4.5:1 on selected
 * rows too; oc tones sit on bg-muted (5.12-8.75).
 */
const SOFT: Record<BadgeTone, string> = {
  neutral: 'bg-muted text-foreground',
  primary: 'bg-primary-subtle text-primary',
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  danger: 'bg-destructive-subtle text-destructive',
  info: 'bg-info-subtle text-info',
  'oc-user': 'bg-muted text-oc-user',
  'oc-group': 'bg-muted text-oc-group',
  'oc-ou': 'bg-muted text-oc-ou',
  'oc-computer': 'bg-muted text-oc-computer',
  'oc-contact': 'bg-muted text-oc-contact',
  'oc-domain': 'bg-muted text-oc-domain',
  'oc-container': 'bg-muted text-oc-container',
  'oc-service': 'bg-muted text-oc-service',
}
const SOLID: Record<BadgeTone, string> = {
  neutral: 'bg-muted-foreground text-background',
  primary: 'bg-primary text-primary-foreground',
  success: 'bg-success text-success-foreground',
  warning: 'bg-warning text-warning-foreground',
  danger: 'bg-destructive text-destructive-foreground',
  info: 'bg-info text-info-foreground',
  'oc-user': 'bg-oc-user text-background',
  'oc-group': 'bg-oc-group text-background',
  'oc-ou': 'bg-oc-ou text-background',
  'oc-computer': 'bg-oc-computer text-background',
  'oc-contact': 'bg-oc-contact text-background',
  'oc-domain': 'bg-oc-domain text-background',
  'oc-container': 'bg-oc-container text-background',
  'oc-service': 'bg-oc-service text-background',
}
const OUTLINE: Record<BadgeTone, string> = {
  neutral: 'border-border-strong text-foreground',
  primary: 'border-primary text-primary',
  success: 'border-success text-success',
  warning: 'border-warning text-warning',
  danger: 'border-destructive text-destructive',
  info: 'border-info text-info',
  'oc-user': 'border-oc-user text-oc-user',
  'oc-group': 'border-oc-group text-oc-group',
  'oc-ou': 'border-oc-ou text-oc-ou',
  'oc-computer': 'border-oc-computer text-oc-computer',
  'oc-contact': 'border-oc-contact text-oc-contact',
  'oc-domain': 'border-oc-domain text-oc-domain',
  'oc-container': 'border-oc-container text-oc-container',
  'oc-service': 'border-oc-service text-oc-service',
}

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm px-1.5 text-xs font-medium leading-none whitespace-nowrap align-middle tabular-nums',
  {
    variants: {
      size: { sm: 'h-[18px]', md: 'h-5' },
      appearance: { soft: '', solid: '', outline: 'border bg-transparent' },
    },
    defaultVariants: { size: 'sm', appearance: 'soft' },
  },
)

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  tone?: BadgeTone
  icon?: IconType | ReactNode
}

/** Always 11px, rounded-sm, nowrap. Replaces the tinted span chips and the 3 colour maps. */
export function Badge({ tone = 'neutral', appearance = 'soft', size, icon, className, children, ...rest }: BadgeProps) {
  const toneCls = appearance === 'solid' ? SOLID[tone] : appearance === 'outline' ? OUTLINE[tone] : SOFT[tone]
  return (
    <span className={cn(badgeVariants({ size, appearance }), toneCls, className)} {...rest}>
      {renderIcon(icon, 12)}
      {children}
    </span>
  )
}

/** Small round counter (tab counts, unread). */
export function CountBadge({ count, tone = 'neutral', max = 99, className, ...rest }: { count: number; tone?: BadgeTone; max?: number } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn('inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full text-xs font-semibold leading-none tabular-nums', SOFT[tone], className)}
      {...rest}
    >
      {count > max ? `${max}+` : count}
    </span>
  )
}
