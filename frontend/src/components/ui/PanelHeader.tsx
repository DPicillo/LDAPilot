/**
 * PanelHeader (SPEC 6.3): 32px; title, subtitle (truncated + tooltip),
 * action IconButtons, optional filter row. A @container query folds the
 * actions into "…" when the panel is narrow. Replaces 14 hand-made headers.
 */
import type { ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { cn } from '../../lib/utils'
import { IconButton, renderIcon, type IconType } from './Button'
import { DropdownMenu, MenuItem } from './Menu'
import { TruncatedText } from './TruncatedText'

export interface PanelAction {
  id: string
  label: string
  icon: IconType
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  shortcut?: string
}

export interface PanelHeaderProps {
  title: string
  subtitle?: string
  icon?: IconType | ReactNode
  actions?: PanelAction[]
  /** Free-form content before the actions (a count Badge). */
  extra?: ReactNode
  /** Filter row below the header (SearchInput). */
  filter?: ReactNode
  /** Heading level for the title (default 2). */
  level?: 2 | 3
  className?: string
}

export function PanelHeader({ title, subtitle, icon, actions = [], extra, filter, level = 2, className }: PanelHeaderProps) {
  const H = level === 2 ? 'h2' : 'h3'
  return (
    <div className={cn('@container shrink-0 border-b border-border', className)}>
      <div className="flex items-center gap-2 h-panel-header px-3 min-w-0">
        {icon && <span className="text-muted-foreground shrink-0">{renderIcon(icon, 14)}</span>}
        <H className="text-xs font-semibold uppercase tracking-wide text-foreground whitespace-nowrap shrink-0">{title}</H>
        {subtitle && <TruncatedText text={subtitle} className="text-xs text-muted-foreground flex-1" />}
        {!subtitle && <span className="flex-1" />}
        {extra}
        {actions.length > 0 && (
          <>
            <div className={cn('items-center gap-0.5 shrink-0', actions.length > 1 ? 'hidden @[240px]:flex' : 'flex')}>
              {actions.map((a) => (
                <IconButton key={a.id} label={a.label} icon={a.icon} onClick={a.onClick} disabled={a.disabled} pressed={a.pressed} shortcut={a.shortcut} size="md" />
              ))}
            </div>
            {actions.length > 1 && (
              <div className="@[240px]:hidden shrink-0">
                <DropdownMenu label={`${title} actions`} placement="bottom-end" trigger={<IconButton label={`${title} actions`} icon={MoreHorizontal} size="md" />}>
                  {actions.map((a) => (
                    <MenuItem key={a.id} icon={a.icon} label={a.label} shortcut={a.shortcut} disabled={a.disabled} onSelect={a.onClick} />
                  ))}
                </DropdownMenu>
              </div>
            )}
          </>
        )}
      </div>
      {filter && <div className="px-2 pb-2">{filter}</div>}
    </div>
  )
}
