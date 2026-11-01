import {
  cloneElement,
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react'
import { cn } from '../../lib/utils'
import { Portal, focusWhenReady, useAnchoredPosition, useOverlayZ, type Placement } from './layer'
import { useDismiss } from './useDismiss'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export interface PopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchor: HTMLElement | null
  placement?: Placement
  offset?: number
  matchWidth?: boolean
  /** Move focus into the popover on open (first focusable, else the panel). Default true. */
  autoFocus?: boolean
  /** Element to focus on open instead of the first focusable (never put a destructive action first). */
  initialFocus?: RefObject<HTMLElement | null>
  /** Return focus to the anchor when closed with Escape. Default true. */
  restoreFocus?: boolean
  /** Close when focus leaves the popover. */
  closeOnFocusOut?: boolean
  role?: 'dialog' | 'region' | 'listbox' | 'group'
  'aria-label'?: string
  'aria-labelledby'?: string
  id?: string
  className?: string
  children: ReactNode
}

/**
 * Non-modal floating panel anchored to an element: connection switcher,
 * ColumnChooser, notifications, zoom menu. Zoom-aware, flips and clamps.
 */
export function Popover({
  open,
  onOpenChange,
  anchor,
  placement = 'bottom-start',
  offset = 4,
  matchWidth,
  autoFocus = true,
  initialFocus,
  restoreFocus = true,
  closeOnFocusOut,
  role = 'dialog',
  className,
  children,
  ...aria
}: PopoverProps) {
  if (!open) return null
  return (
    <PopoverImpl
      {...{ onOpenChange, anchor, placement, offset, matchWidth, autoFocus, initialFocus, restoreFocus, closeOnFocusOut, role, className, children }}
      {...aria}
    />
  )
}

function PopoverImpl({
  onOpenChange,
  anchor,
  placement,
  offset,
  matchWidth,
  autoFocus,
  initialFocus,
  restoreFocus,
  closeOnFocusOut,
  role,
  className,
  children,
  ...aria
}: Omit<PopoverProps, 'open'>) {
  const ref = useRef<HTMLDivElement | null>(null)
  const z = useOverlayZ()
  const pos = useAnchoredPosition({ anchor, placement, offset, matchWidth })
  const close = (restore: boolean) => {
    onOpenChange(false)
    if (restore && restoreFocus && anchor?.isConnected) anchor.focus()
  }
  const { onKeyDown } = useDismiss(ref, (reason) => close(reason === 'escape'), {
    focusOut: closeOnFocusOut,
    ignore: () => [anchor],
  })

  useLayoutEffect(() => {
    if (!pos.ready || !autoFocus || !ref.current) return
    const target = initialFocus?.current ?? ref.current.querySelector<HTMLElement>(FOCUSABLE) ?? ref.current
    const before = document.activeElement
    focusWhenReady(target, () => document.activeElement === before || document.activeElement === document.body)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos.ready])

  return (
    <Portal>
      <div
        ref={(el) => {
          ref.current = el
          pos.ref(el)
        }}
        role={role}
        tabIndex={-1}
        {...aria}
        style={pos.style}
        onKeyDown={(e: ReactKeyboardEvent) => {
          onKeyDown(e)
          // Keys typed inside a popover never reach the region behind it.
          e.stopPropagation()
        }}
        className={cn(
          z,
          'flex flex-col overflow-auto outline-hidden bg-popover text-popover-foreground border border-border-strong/60 rounded-md shadow-popover text-sm',
          pos.ready && 'animate-in fade-in',
          className,
        )}
      >
        {children}
      </div>
    </Portal>
  )
}

export interface DropdownPanelProps extends Omit<PopoverProps, 'open' | 'onOpenChange' | 'anchor' | 'children'> {
  /** One element; receives onClick, aria-haspopup, aria-expanded. */
  trigger: ReactElement
  children: ReactNode | ((close: () => void) => ReactNode)
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/** Popover with its own trigger and open state. */
export function DropdownPanel({ trigger, children, open: openProp, onOpenChange, role = 'dialog', ...rest }: DropdownPanelProps) {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const anchorRef = useRef<HTMLElement | null>(null)
  const setOpen = (o: boolean) => {
    if (openProp === undefined) setOpenState(o)
    onOpenChange?.(o)
  }
  const tp = (isValidElement(trigger) ? trigger.props : {}) as { onClick?: (e: ReactMouseEvent<HTMLElement>) => void }
  const t = cloneElement(trigger as ReactElement<Record<string, unknown>>, {
    'aria-haspopup': role === 'listbox' ? 'listbox' : 'dialog',
    'aria-expanded': open,
    onClick: (e: ReactMouseEvent<HTMLElement>) => {
      tp.onClick?.(e)
      anchorRef.current = e.currentTarget
      setOpen(!open)
    },
  })
  return (
    <>
      {t}
      <Popover open={open} onOpenChange={setOpen} anchor={anchorRef.current} role={role} {...rest}>
        {typeof children === 'function' ? children(() => setOpen(false)) : children}
      </Popover>
    </>
  )
}
