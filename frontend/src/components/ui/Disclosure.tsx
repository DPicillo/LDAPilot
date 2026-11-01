import { useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils'
import { renderIcon, type IconType } from './Button'

export interface DisclosureButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onToggle'> {
  open: boolean
  onToggle: () => void
  /** id of the region the button shows and hides (aria-controls). */
  controls?: string
  icon?: IconType | ReactNode
}

/**
 * The one expand/collapse trigger (SPEC 6): a chevron (right = closed, down =
 * open), optional icon and label, aria-expanded / aria-controls. Used for
 * "Advanced settings", "Password storage", "Advanced methods"…; never a native
 * <details> marker (its triangle differs per engine and disappears on a flex
 * <summary>).
 */
export function DisclosureButton({ open, onToggle, controls, icon, className, children, ...rest }: DisclosureButtonProps) {
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <button type="button"
      {...rest}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={cn(
        'flex items-center gap-1.5 min-h-control max-w-full text-sm text-left rounded-xs text-muted-foreground hover:text-foreground',
        'outline-hidden focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-1',
        className,
      )}
    >
      <Chevron size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
      {renderIcon(icon, 14)}
      {children}
    </button>
  )
}

export interface DisclosureProps {
  title: ReactNode
  icon?: IconType | ReactNode
  /** Muted text after the title (the current value while collapsed). */
  summary?: ReactNode
  /** Controlled state; leave undefined for an uncontrolled disclosure. */
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
  contentClassName?: string
  children: ReactNode
}

/** Trigger + region. The region stays mounted while closed (fields keep their values). */
export function Disclosure({ title, icon, summary, open, defaultOpen = false, onOpenChange, className, contentClassName, children }: DisclosureProps) {
  const [inner, setInner] = useState(defaultOpen)
  const isOpen = open ?? inner
  const id = `disc-${useId().replace(/:/g, '')}`
  const toggle = () => {
    const next = !isOpen
    if (open === undefined) setInner(next)
    onOpenChange?.(next)
  }
  return (
    <div className={cn('text-sm', className)}>
      <DisclosureButton open={isOpen} onToggle={toggle} controls={id} icon={icon}>
        <span className="min-w-0 truncate">{title}</span>
        {summary != null && <span className="min-w-0 truncate text-xs">({summary})</span>}
      </DisclosureButton>
      <div id={id} hidden={!isOpen} className={contentClassName}>
        {children}
      </div>
    </div>
  )
}
