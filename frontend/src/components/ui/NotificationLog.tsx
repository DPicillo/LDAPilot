/**
 * Notification bell + history popover (SPEC 7.4), rebuilt on Popover,
 * IconButton, Badge and EmptyState. The unread count only counts errors and
 * warnings newer than the last time the popover was opened (persisted
 * `lastSeen`); success and info messages are history only. The badge is red
 * when there are unread errors. All text >= 11px. Rows that were unread when
 * the popover opened stay marked while it is open. Each row names its
 * connection and how often it occurred (×n). Opening focuses the history
 * list, never "Clear all"; Clear all offers Undo.
 * A row whose toast offered an undo that is still valid (ui/undo.ts: a tree
 * move or a bookmark change, 10 minutes, until the entries change again)
 * keeps its Undo button (RW3-N-04).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Bell, Check, ChevronDown, ChevronRight, CircleAlert, CircleCheck, Copy, Info, Trash2, TriangleAlert, Undo2 } from 'lucide-react'
import { useToastStore, type Toast } from './Toast'
import { cn } from '../../lib/utils'
import { Popover } from './Popover'
import { Button, IconButton } from './Button'
import { EmptyState } from './EmptyState'
import { Tooltip } from './Tooltip'
import { formatRelative } from './accountStatus'
import { countsAsUnread, unreadEntries } from '../connection/chromeLogic'
import { liveUndo, runUndo, subscribeUndo, undoIdOf, undoVersion } from './undo'

const SEEN_KEY = 'ldapilot-notifications-seen'

function loadSeen(): number {
  try {
    const v = Number(localStorage.getItem(SEEN_KEY))
    return Number.isFinite(v) ? v : 0
  } catch {
    return 0
  }
}
function saveSeen(ts: number) {
  try {
    localStorage.setItem(SEEN_KEY, String(ts))
  } catch {
    /* blocked storage */
  }
}

type NotificationType = 'success' | 'error' | 'info' | 'warning'
interface NotificationEntryData {
  id: string
  type: NotificationType
  message: string
  detail?: string
  timestamp: number
  connection?: string
  count?: number
  actions?: Toast['actions']
}

const TYPE_ICON = {
  success: { Icon: CircleCheck, cls: 'text-success', label: 'Success' },
  error: { Icon: CircleAlert, cls: 'text-destructive', label: 'Error' },
  info: { Icon: Info, cls: 'text-info', label: 'Info' },
  warning: { Icon: TriangleAlert, cls: 'text-warning', label: 'Warning' },
} as const

export interface NotificationBellProps {
  className?: string
  /** Icon size (activity bar: 20). */
  iconSize?: number
}

export function NotificationBell({ className, iconSize = 20 }: NotificationBellProps) {
  const [open, setOpen] = useState(false)
  const [lastSeen, setLastSeen] = useState(loadSeen)
  // lastSeen as it was when the popover opened: rows newer than this are marked unread.
  const [seenAtOpen, setSeenAtOpen] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const history = useToastStore((s) => s.history) as NotificationEntryData[]
  const btnRef = useRef<HTMLButtonElement>(null)
  // Entries removed by Clear all, until Undo or the popover closes.
  const [cleared, setCleared] = useState<Toast[] | null>(null)

  // Undo buttons follow the undo registry (ran / ended) and expire while the popover is open.
  useSyncExternalStore(subscribeUndo, undoVersion, undoVersion)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [open])

  const unread = unreadEntries(history, lastSeen)
  const unreadErrors = unread.filter((h) => h.type === 'error').length
  const label = unread.length
    ? `Notifications, ${unread.length} unread${unreadErrors ? ` (${unreadErrors} error${unreadErrors === 1 ? '' : 's'})` : ''}`
    : 'Notifications'

  const markSeen = () => {
    const ts = Math.max(Date.now(), ...history.map((h) => h.timestamp))
    setLastSeen(ts)
    saveSeen(ts)
  }

  return (
    <>
      <Tooltip content={label} placement="right">
        <button type="button"
          ref={btnRef}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            if (!open) {
              setSeenAtOpen(lastSeen)
              markSeen()
            }
            setOpen(!open)
          }}
          className={cn(
            'relative size-10 flex items-center justify-center transition-colors duration-100',
            open ? 'text-activity-bar-active' : 'text-activity-bar-foreground hover:text-activity-bar-active',
            className,
          )}
        >
          <Bell size={iconSize} strokeWidth={1.75} aria-hidden />
          {unread.length > 0 && (
            <span
              aria-hidden
              className={cn(
                'absolute top-1 right-0.5 min-w-4 h-4 px-1 rounded-full text-xs font-semibold leading-none tabular-nums flex items-center justify-center',
                unreadErrors > 0 ? 'bg-destructive text-destructive-foreground' : 'bg-primary text-primary-foreground',
              )}
            >
              {unread.length > 99 ? '99+' : unread.length}
            </span>
          )}
        </button>
      </Tooltip>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) {
            markSeen()
            setCleared(null)
          }
        }}
        anchor={btnRef.current}
        placement="right-end"
        aria-label="Notifications"
        initialFocus={listRef}
        className="w-[384px] max-w-[95%] max-h-[480px]"
      >
        <div className="flex items-center justify-between h-panel-header px-3 border-b border-border shrink-0">
          <h2 className="text-xs font-semibold uppercase tracking-wide">Notifications</h2>
          <IconButton
            label="Clear all notifications"
            icon={Trash2}
            size="md"
            disabled={history.length === 0}
            onClick={() => {
              const removed = useToastStore.getState().clearHistory()
              if (removed.length) setCleared(removed)
              listRef.current?.focus()
            }}
          />
        </div>
        {cleared && (
          <div role="status" className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border text-sm shrink-0">
            <span className="text-muted-foreground">
              {cleared.length} notification{cleared.length === 1 ? '' : 's'} cleared
            </span>
            <Button
              size="sm"
              variant="ghost"
              leftIcon={Undo2}
              onClick={() => {
                useToastStore.getState().restoreHistory(cleared)
                setCleared(null)
                listRef.current?.focus()
              }}
            >
              Undo
            </Button>
          </div>
        )}
        {/* Initial focus (scrollable with the arrow keys); Tab continues to the rows' buttons. */}
        <div ref={listRef} tabIndex={-1} aria-label="Notification history" role="group" className="flex-1 overflow-auto min-h-0 focus-ring-inset">
          {history.length === 0 ? (
            <EmptyState icon={Bell} title="No notifications yet" hint="Connection changes, errors and results of write operations appear here." className="py-8" />
          ) : (
            <ul aria-label="Notification history">
              {history.map((entry) => (
                <NotificationEntry key={entry.id} entry={entry} unread={entry.timestamp > seenAtOpen && countsAsUnread(entry.type)} />
              ))}
            </ul>
          )}
        </div>
      </Popover>
    </>
  )
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function NotificationEntry({ entry, unread }: { entry: NotificationEntryData; unread: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const { Icon, cls, label } = TYPE_ICON[entry.type]
  // The toast's Undo, while the undo can still run (RW3-N-04).
  const undo = (entry.actions ?? []).map((a) => liveUndo(undoIdOf(a))).find((u) => !!u)

  const handleCopy = () => {
    const text = entry.detail ? `${entry.message}\n\n${entry.detail}` : entry.message
    navigator.clipboard?.writeText(text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <li className={cn('group px-3 py-2 border-b border-border', unread && 'bg-secondary')}>
      <div className="flex items-start gap-2">
        <Icon size={14} strokeWidth={1.75} className={cn('mt-px shrink-0', cls)} aria-label={label} role="img" />
        <div className="flex-1 min-w-0">
          <p className="text-sm break-words">
            {entry.message}
            {(entry.count ?? 1) > 1 && (
              <span className="ml-1.5 text-xs font-semibold tabular-nums text-muted-foreground" aria-label={`${entry.count} times`}>
                ×{entry.count}
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground tabular-nums mt-0.5 truncate">
            <time dateTime={new Date(entry.timestamp).toISOString()}>{formatTime(entry.timestamp)}</time>
            <span aria-hidden> · </span>
            {formatRelative(new Date(entry.timestamp))}
            {entry.connection && (
              <>
                <span aria-hidden> · </span>
                <span title={`Connection: ${entry.connection}`}>{entry.connection}</span>
              </>
            )}
            {unread && <span className="sr-only"> (unread)</span>}
          </p>
        </div>
        <div className="flex items-center shrink-0">
          {undo && (
            <Button
              size="sm"
              variant="ghost"
              leftIcon={Undo2}
              title={`Undo ${undo.label} (until ${formatTime(undo.expiresAt).slice(0, 5)})`}
              aria-label={`Undo ${undo.label}`}
              onClick={() => void runUndo(undo.id)}
            >
              Undo
            </Button>
          )}
          {entry.detail && (
            <IconButton
              label={expanded ? 'Hide details' : 'Show details'}
              icon={expanded ? ChevronDown : ChevronRight}
              size="sm"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            />
          )}
          {(entry.type === 'error' || entry.detail) && (
            <IconButton label={copied ? 'Copied' : 'Copy message'} icon={copied ? Check : Copy} size="sm" onClick={handleCopy} />
          )}
        </div>
      </div>
      {expanded && entry.detail && (
        <pre className="mt-1.5 text-xs text-muted-foreground font-mono whitespace-pre-wrap break-all bg-background rounded p-2 border border-border">{entry.detail}</pre>
      )}
    </li>
  )
}
