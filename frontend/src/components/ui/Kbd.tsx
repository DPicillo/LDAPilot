import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/utils'
import { formatShortcut, shortcutParts } from './shortcuts'

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  /** Shortcut string ('Mod+K'); platform-aware label. Children win when given. */
  shortcut?: string
  /** Render one <kbd> per key ("Ctrl" "K") instead of one combined label. */
  split?: boolean
  /** Plain variant for shortcut columns in menus (no box). */
  bare?: boolean
}

/** Keyboard key. 11px, border-strong edge, secondary fill (SPEC 6.4). */
export function Kbd({ shortcut, split, bare, className, children, ...rest }: KbdProps) {
  const box = bare
    ? 'text-xs text-muted-foreground font-sans'
    : 'inline-flex items-center justify-center h-[18px] min-w-[18px] px-1 rounded-xs border border-border-strong bg-secondary text-secondary-foreground text-xs font-sans leading-none whitespace-nowrap'
  if (split && shortcut && !children) {
    return (
      <span className={cn('inline-flex items-center gap-0.5', className)} {...rest}>
        {shortcutParts(shortcut).map((k, i) => (
          <kbd key={i} className={box}>{k}</kbd>
        ))}
      </span>
    )
  }
  return (
    <kbd className={cn(box, className)} {...rest}>
      {children ?? formatShortcut(shortcut)}
    </kbd>
  )
}
