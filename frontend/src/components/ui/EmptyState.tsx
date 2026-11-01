import type { ReactNode } from 'react'
import { Inbox } from 'lucide-react'
import { cn } from '../../lib/utils'
import { renderIcon, type IconType } from './Button'

export interface EmptyStateProps {
  icon?: IconType | ReactNode
  title: ReactNode
  hint?: ReactNode
  /** Usually a <Button>. */
  action?: ReactNode
  /** panel: centred, 40px icon; inline: one row inside a table or list. */
  variant?: 'panel' | 'inline'
  className?: string
  children?: ReactNode
}

export function EmptyState({ icon = Inbox, title, hint, action, variant = 'panel', className, children }: EmptyStateProps) {
  if (variant === 'inline') {
    return (
      // Wraps in a narrow view: the action moves below the text instead of off-screen (RW1-S-03).
      <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm text-muted-foreground', className)} role="status">
        {renderIcon(icon, 16)}
        <span className="text-foreground">{title}</span>
        {hint && <span className="text-xs min-w-0">{hint}</span>}
        {action && <span className="ml-auto shrink-0">{action}</span>}
      </div>
    )
  }
  return (
    <div className={cn('h-full w-full flex flex-col items-center justify-center gap-2 p-6 text-center', className)} role="status">
      <span className="text-muted-foreground mb-1">{renderIcon(icon, 40)}</span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint && <p className="text-xs text-muted-foreground max-w-[280px]">{hint}</p>}
      {action && <div className="mt-2 flex items-center gap-2">{action}</div>}
      {children}
    </div>
  )
}
