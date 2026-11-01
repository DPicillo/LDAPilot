/**
 * Activity bar (SPEC 7.4): 40px rail, 40px items, 20px icons, scrolls
 * vertically (nothing clips at 600px x 1.2 zoom). Active item: 2px primary
 * bar + aria-pressed. One Tooltip (with shortcut) per item, suppressed after a
 * click. Roving focus: one tab stop, Up/Down/Home/End move. The bell sits at
 * the bottom; About moved to Help. Names and shortcuts come from the one
 * panel table (commands/panelTable.ts, also the View menu and the palette);
 * showing a panel focuses its main control.
 */
import { useRef, type KeyboardEvent } from 'react'
import { ArrowDownUp, BarChart3, BookOpen, Bot, FolderTree, Plug, Search, Star, type LucideIcon } from 'lucide-react'
import { PANELS } from '../commands/panelTable'
import { focusPanel } from '../commands/panels'
import { cn } from '../../lib/utils'
import { useUIStore } from '../../stores/uiStore'
import { selectPendingApprovalCount, useAIStore } from '../../stores/aiStore'
import type { Activity } from '../../types/ui'
import { NotificationBell } from '../ui/NotificationLog'
import { Tooltip } from '../ui/Tooltip'
import { getCommand, useCommandRegistryVersion } from '../ui/commands'

interface ActivityItem {
  id: Activity
  icon: LucideIcon
  label: string
  shortcut?: string
}

const ICONS: Record<Activity, LucideIcon> = {
  connections: Plug,
  explorer: FolderTree,
  search: Search,
  reports: BarChart3,
  bookmarks: Star,
  schema: BookOpen,
  export: ArrowDownUp,
  ai: Bot,
}

// `command`: the registry view command whose shortcut the tooltip shows
// (coreCommands.ts), so the two cannot drift apart; `shortcut` is the
// fallback before the registry is filled.
const ACTIVITIES: (ActivityItem & { command: string })[] = PANELS.map((p) => ({ id: p.activity, icon: ICONS[p.activity], label: p.label, shortcut: p.shortcut, command: p.command }))

function shortcutOf(item: (typeof ACTIVITIES)[number]): string | undefined {
  const s = getCommand(item.command)?.shortcut
  return (Array.isArray(s) ? s[0] : s) ?? item.shortcut
}

export function ActivityBar() {
  const activeActivity = useUIStore((s) => s.activeActivity)
  const sidebarVisible = useUIStore((s) => s.sidebarVisible)
  const setActivity = useUIStore((s) => s.setActivity)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  // Docked right of the editor, the AI item shows/hides that pane instead.
  const aiRight = useUIStore((s) => s.aiDock === 'right')
  const aiPaneVisible = useUIStore((s) => s.aiPaneVisible)
  // AI approvals waiting for the user (AI spec 2.2): badge on the AI item.
  const pendingApprovals = useAIStore(selectPendingApprovalCount)
  useCommandRegistryVersion()
  const listRef = useRef<HTMLDivElement>(null)

  const handleClick = (activity: Activity) => {
    if (activity === 'ai' && aiRight) {
      useUIStore.getState().toggleAIPane()
      return
    }
    if (activeActivity === activity && sidebarVisible) {
      toggleSidebar()
    } else {
      setActivity(activity)
      if (!sidebarVisible) toggleSidebar()
      focusPanel(activity)
    }
  }

  // Roving tab stop: the active activity (or the first one).
  const tabStop = ACTIVITIES.some((a) => a.id === activeActivity) ? activeActivity : ACTIVITIES[0].id

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-activity]') ?? [])]
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (i < 0) return
    let n = -1
    if (e.key === 'ArrowDown') n = (i + 1) % buttons.length
    else if (e.key === 'ArrowUp') n = (i - 1 + buttons.length) % buttons.length
    else if (e.key === 'Home') n = 0
    else if (e.key === 'End') n = buttons.length - 1
    if (n < 0) return
    e.preventDefault()
    buttons.forEach((b, j) => (b.tabIndex = j === n ? 0 : -1))
    buttons[n].focus()
  }

  return (
    <nav aria-label="Activity bar" className="flex flex-col w-activitybar bg-activity-bar border-r border-border select-none shrink-0 min-h-0">
      <div
        ref={listRef}
        role="toolbar"
        aria-orientation="vertical"
        aria-label="Activities"
        onKeyDown={onKeyDown}
        className="flex flex-col flex-1 min-h-0 overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {ACTIVITIES.map((item) => {
          const isActive = item.id === 'ai' && aiRight ? aiPaneVisible : activeActivity === item.id && sidebarVisible
          const Icon = item.icon
          const badge = item.id === 'ai' ? pendingApprovals : 0
          const label = badge > 0 ? `${item.label}, ${badge} approval${badge === 1 ? '' : 's'} pending` : item.label
          return (
            <Tooltip key={item.id} content={label} shortcut={shortcutOf(item)} placement="right">
              <button type="button"
                data-activity={item.id}
                tabIndex={item.id === tabStop ? 0 : -1}
                aria-label={label}
                aria-pressed={isActive}
                onClick={() => handleClick(item.id)}
                className={cn(
                  'relative size-10 shrink-0 flex items-center justify-center transition-colors duration-100',
                  'focus-ring-inset',
                  isActive ? 'text-activity-bar-active' : 'text-activity-bar-foreground hover:text-activity-bar-active',
                )}
              >
                {isActive && <span aria-hidden className="absolute left-0 inset-y-0 w-0.5 bg-primary" />}
                <Icon size={20} strokeWidth={1.75} aria-hidden />
                {badge > 0 && (
                  <span
                    aria-hidden
                    className="absolute top-1 right-0.5 min-w-4 h-4 px-1 rounded-full text-xs font-semibold leading-none tabular-nums flex items-center justify-center bg-warning text-warning-foreground"
                  >
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </button>
            </Tooltip>
          )
        })}
      </div>
      <div className="shrink-0 flex flex-col items-center pb-1">
        <NotificationBell iconSize={20} className="focus-ring-inset" />
      </div>
    </nav>
  )
}
