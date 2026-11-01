/**
 * Object statistics below a container (TREE-06): total and counts per
 * category (Users, Contacts, Computers, Service accounts, Groups, OUs,
 * Containers, Domains, Other; classified on the server, BrowserService.
 * GetStatisticsRun). Every category is a button that lists its entries in the
 * Search Results (subtree search below the container with the server's filter
 * for exactly that category). "Copy as Text" copies the table.
 *
 * The count can be stopped (DEF-23): Stop while counting, and closing the
 * dialog, cancel the backend search (CancelStatistics with the count's
 * request ID); a stopped count shows no numbers (they would be incomplete)
 * and offers Count Again. A count that stopped at the size limit is marked.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { BarChart3, Box, ClipboardCopy, Contact, FolderTree, Globe, HelpCircle, Monitor, RotateCcw, Square, UserCog, Users } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { useSearchStore } from '../../stores/searchStore'
import { cn } from '../../lib/utils'
import type { ObjectStats } from '../../lib/wails'
import { CancelStatistics, GetStatisticsRun } from '../../lib/wails-stats'
import { ScopeSub } from '../../types/ldap'
import { setNextSearchSource, showSearchResults } from '../layout/shellState'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import { InlineAlert } from '../ui/InlineAlert'
import { TruncatedText } from '../ui/TruncatedText'
import { toast } from '../ui/Toast'
import type { IconType } from '../ui/Button'
import { nextStatsRequestId, statisticsText, statsPhaseAfter, statsShare as share, statsTruncatedNote, type StatsPhase } from './statisticsModel'

export { statisticsText } from './statisticsModel'

interface StatisticsDialogProps {
  dn: string
  /** The entry's connection (default: the active one). */
  profileId?: string
  onClose: () => void
}

/** GetStatistics result; `filters` / `order` come from servers with the TREE-06 classifier. */
type Stats = ObjectStats

const TYPE_ICONS: Record<string, { icon: IconType; color: string }> = {
  Users: { icon: Users, color: 'text-oc-user' },
  Contacts: { icon: Contact, color: 'text-oc-contact' },
  Computers: { icon: Monitor, color: 'text-oc-computer' },
  'Service accounts': { icon: UserCog, color: 'text-oc-service' },
  Groups: { icon: Users, color: 'text-oc-group' },
  OUs: { icon: FolderTree, color: 'text-oc-ou' },
  Containers: { icon: Box, color: 'text-oc-container' },
  Domains: { icon: Globe, color: 'text-oc-domain' },
  Other: { icon: HelpCircle, color: 'text-muted-foreground' },
}

/** Results above this many entries are not worth a size limit below the count. */
const MAX_LIST = 10000

/** Object counts below a container by type (read-only: Escape and the backdrop close it). */
export function StatisticsDialog({ dn, profileId: profileProp, onClose }: StatisticsDialogProps) {
  const storeProfileId = useConnectionStore((s) => s.activeProfileId)
  const activeProfileId = profileProp ?? storeProfileId
  const [stats, setStats] = useState<Stats | null>(null)
  const [phase, setPhase] = useState<StatsPhase>('counting')
  const [error, setError] = useState<string | null>(null)
  /** Count Again: a new count. */
  const [attempt, setAttempt] = useState(0)
  /** The request ID of the count in flight (null: none, or stopped). */
  const running = useRef<string | null>(null)
  const stopButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!activeProfileId) return
    const id = nextStatsRequestId()
    running.current = id
    setPhase('counting')
    setError(null)
    setStats(null)
    GetStatisticsRun(activeProfileId, dn, id)
      .then((s) => {
        // A stopped (or replaced) count's late answer is discarded.
        if (running.current !== id) return
        running.current = null
        setStats(s as Stats | null)
        setPhase(statsPhaseAfter('ok', false))
      })
      .catch((err) => {
        if (running.current !== id) return
        running.current = null
        setError(err?.message || 'Failed to load statistics')
        setPhase(statsPhaseAfter('error', false))
      })
    return () => {
      // Closing the dialog (or a new count) stops the search on the server side too.
      if (running.current === id) {
        running.current = null
        void CancelStatistics(activeProfileId, id)
      }
    }
  }, [activeProfileId, dn, attempt])

  const stop = useCallback(() => {
    const id = running.current
    if (!id || !activeProfileId) return
    running.current = null
    setPhase(statsPhaseAfter('error', true))
    void CancelStatistics(activeProfileId, id)
  }, [activeProfileId])
  const countAgain = () => setAttempt((n) => n + 1)
  const loading = phase === 'counting'

  const sortedTypes = stats ? Object.entries(stats.byType).sort((a, b) => b[1] - a[1]) : []
  const maxCount = sortedTypes.length > 0 ? sortedTypes[0][1] : 0

  /** Lists the category's entries in the Search Results (existing search store API). */
  const listCategory = (type: string, count: number) => {
    const filter = stats?.filters?.[type]
    if (!activeProfileId || !filter) return
    const ss = useSearchStore.getState()
    ss.setParams({ baseDN: dn, filter, scope: ScopeSub, attributes: [], sizeLimit: Math.min(MAX_LIST, Math.max(ss.params.sizeLimit || 1000, count)) })
    showSearchResults()
    setNextSearchSource(`Statistics: ${type}`)
    void ss.executeSearch(activeProfileId, filter).finally(() => setNextSearchSource(null))
    onClose()
  }

  const copyText = () => {
    if (!stats) return
    navigator.clipboard
      .writeText(statisticsText(dn, stats))
      .then(() => toast.success('Statistics copied'))
      .catch((err) => toast.error('Could not copy the statistics', err instanceof Error ? err.message : String(err)))
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      dismissible="always"
      icon={BarChart3}
      title="Object Statistics"
      description={<TruncatedText text={dn} className="font-mono" />}
      initialFocus={stopButton}
      footer={
        <>
          <Button variant="ghost" leftIcon={ClipboardCopy} onClick={copyText} disabled={!stats || loading} className="mr-auto">
            Copy as Text
          </Button>
          {loading ? (
            <Button ref={stopButton} variant="secondary" leftIcon={Square} onClick={stop} title="Stop counting (the server search is cancelled)">
              Stop
            </Button>
          ) : phase === 'stopped' || phase === 'error' ? (
            <Button variant="secondary" leftIcon={RotateCcw} onClick={countAgain}>
              Count Again
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground" role="status">
          <Spinner size="md" decorative />
          Counting objects…
        </div>
      ) : phase === 'stopped' ? (
        <InlineAlert tone="info" title="Counting stopped" body="No numbers are shown: they would be incomplete. Count Again starts over." />
      ) : error ? (
        <InlineAlert tone="danger" body={error} />
      ) : stats ? (
        <>
          {stats.truncated && <InlineAlert tone="warning" body={statsTruncatedNote(stats)} className="mb-3" />}
          <div className="flex items-baseline justify-between mb-4 pb-3 border-b border-border">
            <span className="text-sm font-semibold">Total objects</span>
            <span className="text-2xl font-semibold tabular-nums text-foreground">{stats.totalCount.toLocaleString()}{stats.truncated ? '+' : ''}</span>
          </div>
          <ul className="space-y-0.5" aria-label="Objects by type">
            {sortedTypes.map(([type, count]) => {
              const info = TYPE_ICONS[type] || TYPE_ICONS.Other
              const Icon = info.icon
              const pct = maxCount > 0 ? (count / maxCount) * 100 : 0
              const canList = !!stats.filters?.[type] && count > 0
              const label = `${type}: ${count.toLocaleString()} (${share(count, stats.totalCount)} %)`
              return (
                <li key={type}>
                  <button type="button"
                    disabled={!canList}
                    onClick={() => listCategory(type, count)}
                    aria-label={canList ? `${label}. Show them in the search results` : label}
                    title={canList ? `Show the ${type.toLowerCase()} below this entry in the search results` : undefined}
                    className={cn(
                      'w-full flex items-center gap-2 px-1.5 py-1 rounded text-sm text-left outline-hidden focus-ring-inset',
                      canList ? 'hover:bg-accent cursor-pointer' : 'cursor-default',
                    )}
                  >
                    <Icon size={14} strokeWidth={1.75} aria-hidden className={cn('shrink-0', info.color)} />
                    <span className={cn('w-28 shrink-0', canList && 'text-primary')}>{type}</span>
                    <span aria-hidden className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                      <span className={cn('block h-full rounded-full bg-current', info.color)} style={{ width: `${pct}%` }} />
                    </span>
                    <span className="w-14 text-right tabular-nums">{count.toLocaleString()}</span>
                    <span className="w-12 text-right text-xs text-muted-foreground tabular-nums">{share(count, stats.totalCount)}%</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      ) : null}
    </Dialog>
  )
}
