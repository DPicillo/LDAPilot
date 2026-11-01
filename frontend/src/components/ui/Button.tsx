import { isValidElement, type ButtonHTMLAttributes, type ComponentType, type ReactNode, type Ref } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'
import { Spinner } from './Spinner'
import { Tooltip } from './Tooltip'
import type { Placement } from './layer'
import { formatShortcut } from './shortcuts'

/** Any lucide icon (or a compatible component). */
export type IconType = ComponentType<{ size?: number | string; strokeWidth?: number | string; className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>

/** Renders an icon given as a component (lucide) or as a ready element. */
export function renderIcon(icon: IconType | ReactNode | undefined, size: number, className?: string): ReactNode {
  if (!icon) return null
  if (isValidElement(icon)) return icon
  if (typeof icon === 'function' || (typeof icon === 'object' && icon !== null && '$$typeof' in icon)) {
    const I = icon as IconType
    return <I size={size} strokeWidth={1.75} aria-hidden className={cn('shrink-0', className)} />
  }
  return icon as ReactNode
}

export const buttonVariants = cva(
  [
    'relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded font-medium select-none',
    'transition-colors duration-100 disabled:cursor-not-allowed aria-disabled:cursor-not-allowed',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-foreground enabled:hover:bg-primary/90 enabled:active:brightness-95 disabled:bg-muted disabled:text-disabled-foreground',
        secondary:
          'border border-border-strong bg-transparent text-foreground enabled:hover:bg-accent enabled:active:brightness-95 disabled:border-border disabled:text-disabled-foreground',
        ghost: 'bg-transparent text-foreground enabled:hover:bg-accent enabled:active:brightness-95 disabled:text-disabled-foreground',
        danger:
          'bg-destructive text-destructive-foreground enabled:hover:bg-destructive/90 enabled:active:brightness-95 disabled:bg-muted disabled:text-disabled-foreground',
        'danger-ghost':
          'bg-transparent text-destructive enabled:hover:bg-destructive-subtle enabled:active:brightness-95 disabled:text-disabled-foreground',
        link: 'bg-transparent text-primary underline-offset-2 enabled:hover:underline disabled:text-disabled-foreground px-0! h-auto!',
      },
      size: {
        sm: 'h-control-sm px-2 text-xs',
        md: 'h-control px-3 text-sm',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean
  leftIcon?: IconType | ReactNode
  rightIcon?: IconType | ReactNode
  /** Shortcut hint shown after the label ('Mod+Enter'). */
  kbd?: string
  children?: ReactNode
  ref?: Ref<HTMLButtonElement>
}

/** Every button defaults to type="button". Primary action goes last in a footer. */
export function Button({
  variant,
  size,
  loading,
  leftIcon,
  rightIcon,
  kbd,
  className,
  children,
  type = 'button',
  disabled,
  ...rest
}: ButtonProps) {
  const iconSize = size === 'sm' ? 12 : 14
  return (
    <button type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      {...rest}
    >
      <span className={cn('inline-flex items-center gap-1.5', loading && 'invisible')}>
        {renderIcon(leftIcon, iconSize)}
        {children}
        {renderIcon(rightIcon, iconSize)}
        {kbd && <span className="text-xs font-normal">{formatShortcut(kbd)}</span>}
      </span>
      {loading && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner size="sm" decorative />
        </span>
      )}
    </button>
  )
}

export const iconButtonVariants = cva(
  [
    'inline-flex items-center justify-center shrink-0 rounded transition-colors duration-100',
    'disabled:cursor-not-allowed disabled:text-disabled-foreground',
  ],
  {
    variants: {
      variant: {
        ghost:
          'text-muted-foreground enabled:hover:text-foreground enabled:hover:bg-accent aria-pressed:bg-accent aria-pressed:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground',
        subtle:
          'bg-secondary border border-border text-foreground enabled:hover:bg-accent aria-pressed:bg-selection aria-pressed:text-selection-foreground aria-pressed:border-primary',
      },
      size: {
        sm: 'size-5',
        md: 'size-6',
        lg: 'size-7',
      },
    },
    defaultVariants: { variant: 'ghost', size: 'md' },
  },
)

const ICON_PX = { sm: 12, md: 14, lg: 16 } as const

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'>,
    VariantProps<typeof iconButtonVariants> {
  /** Required accessible name; also the tooltip text. */
  label: string
  icon: IconType | ReactNode
  /** Toggle state: sets aria-pressed. */
  pressed?: boolean
  /** Shortcut shown in the tooltip. */
  shortcut?: string
  /** Hidden until the parent `.group` row is hovered or holds focus (and on own focus). */
  revealOnRowHover?: boolean
  tooltipPlacement?: Placement
  /** Disable the tooltip (the label stays the aria-label). */
  noTooltip?: boolean
  ref?: Ref<HTMLButtonElement>
}

export function IconButton({
  label,
  icon,
  size,
  variant,
  pressed,
  shortcut,
  revealOnRowHover,
  tooltipPlacement,
  noTooltip,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const btn = (
    <button type={type}
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        iconButtonVariants({ variant, size }),
        revealOnRowHover && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
        className,
      )}
      {...rest}
    >
      {renderIcon(icon, ICON_PX[size ?? 'md'])}
    </button>
  )
  if (noTooltip) return btn
  return (
    <Tooltip content={label} shortcut={shortcut} placement={tooltipPlacement}>
      {btn}
    </Tooltip>
  )
}
