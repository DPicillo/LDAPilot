import type { ReactNode } from 'react'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { IconType } from './Button'

export type AlertTone = 'info' | 'success' | 'warning' | 'danger'

const TONE: Record<AlertTone, { fill: string; text: string; icon: IconType; bar: string }> = {
  info: { fill: 'bg-info-subtle', text: 'text-info', icon: Info, bar: 'border-l-info' },
  success: { fill: 'bg-success-subtle', text: 'text-success', icon: CircleCheck, bar: 'border-l-success' },
  warning: { fill: 'bg-warning-subtle', text: 'text-warning', icon: TriangleAlert, bar: 'border-l-warning' },
  danger: { fill: 'bg-destructive-subtle', text: 'text-destructive', icon: CircleAlert, bar: 'border-l-destructive' },
}

export interface InlineAlertProps {
  tone?: AlertTone
  title?: ReactNode
  /** Body text (or children). */
  body?: ReactNode
  children?: ReactNode
  /** Buttons at the end (Button size="sm"). */
  actions?: ReactNode
  /** Put the buttons on their own row under the text (narrow panels: the text keeps the width). */
  actionsBelow?: boolean
  onDismiss?: () => void
  /** banner: full-width strip (top of a panel / main area); inline: boxed. */
  variant?: 'inline' | 'banner'
  /**
   * Live region (role=alert/status), default true. Pass false when the content
   * ticks (a countdown) and announcements are made elsewhere, once per change.
   */
  live?: boolean
  className?: string
}

/**
 * Opaque *-subtle fill + tone icon. role=alert for danger, status otherwise.
 * Body text uses foreground; the title uses the tone colour (>= 5.33:1 on subtle).
 */
export function InlineAlert({ tone = 'info', title, body, children, actions, actionsBelow, onDismiss, variant = 'inline', live = true, className }: InlineAlertProps) {
  const t = TONE[tone]
  const Icon = t.icon
  return (
    <div
      role={live ? (tone === 'danger' ? 'alert' : 'status') : undefined}
      className={cn(
        'flex items-start gap-2 text-sm text-foreground',
        t.fill,
        variant === 'banner' ? 'w-full px-3 py-1.5 border-b border-l-2' : 'rounded border border-l-2 px-3 py-2',
        'border-border',
        t.bar,
        className,
      )}
    >
      <Icon size={14} strokeWidth={1.75} aria-hidden className={cn('mt-px shrink-0', t.text)} />
      <div className={cn('flex-1 min-w-0', variant === 'banner' && 'flex flex-wrap items-center gap-x-2')}>
        {title && <p className={cn('font-medium', t.text)}>{title}</p>}
        {(body || children) && <div className={cn(variant === 'banner' ? '' : title && 'mt-0.5')}>{body ?? children}</div>}
        {actions && actionsBelow && <div className="flex flex-wrap items-center gap-1.5 mt-1.5">{actions}</div>}
      </div>
      {actions && !actionsBelow && <div className="flex items-center gap-1.5 shrink-0 -my-0.5">{actions}</div>}
      {onDismiss && (
        <button type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="inline-flex items-center justify-center size-5 -my-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent shrink-0"
        >
          <X size={12} strokeWidth={1.75} aria-hidden />
        </button>
      )}
    </div>
  )
}

/** Full-width strip variant (ConnectionBanner, read-only notices). */
export function Banner(props: Omit<InlineAlertProps, 'variant'>) {
  return <InlineAlert {...props} variant="banner" />
}
