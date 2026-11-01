/**
 * Semantic colour classes for the AI panel (design tokens of
 * styles/globals.css; both themes) and the button/chip classes of the ui
 * primitives (Button, IconButton, Badge) for places where a plain element
 * is needed (e.g. a <label> or <summary>). New code uses <Button>,
 * <IconButton> and <Badge> from components/ui directly.
 */
import { buttonVariants, iconButtonVariants } from '../ui/Button';

export const tone = {
  successText: 'text-success',
  successBg: 'bg-success-subtle',
  successBorder: 'border-success',
  successDot: 'bg-success',
  warningText: 'text-warning',
  warningBg: 'bg-warning-subtle',
  warningBorder: 'border-warning',
  warningDot: 'bg-warning',
  infoText: 'text-info',
  dangerText: 'text-destructive',
  dangerBg: 'bg-destructive-subtle',
  dangerBorder: 'border-destructive',
  /** stroke colours for the context meter ring */
  successStroke: 'stroke-success',
  warningStroke: 'stroke-warning',
  dangerStroke: 'stroke-destructive',
} as const;

/** IconButton (ghost, sm). */
export const iconButton = iconButtonVariants({ variant: 'ghost', size: 'sm' });

/** Button secondary, sm. */
export const textButton = buttonVariants({ variant: 'secondary', size: 'sm' });

/** Button primary, sm. */
export const primaryButton = buttonVariants({ variant: 'primary', size: 'sm' });

/** Button danger-ghost, sm. */
export const dangerButton = buttonVariants({ variant: 'danger-ghost', size: 'sm' });

/** Neutral outline chip (Badge outline). */
export const chip = 'inline-flex h-[18px] items-center gap-1 rounded-sm border border-border px-1.5 text-xs leading-none whitespace-nowrap text-muted-foreground';
