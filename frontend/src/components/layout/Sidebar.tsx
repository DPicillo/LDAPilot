/**
 * Sidebar (SPEC 7.4).
 * - Keep-alive: a panel mounts on its first visit and then stays mounted,
 *   hidden with `hidden`, so switching activities keeps scroll, filters and
 *   typed input.
 * - DirectoryTree is NOT mounted while the active profile is disconnected
 *   (contains the V1 render loop); the Explorer shows the saved profiles
 *   instead (Enter or double-click connects). Without profiles its
 *   "New Connection…" runs the registry command `connection.new` (the
 *   connection dialog), like File ▸ New Connection… and the palette.
 * - The old Export placeholder is the TransferPanel.
 */
import { useState, type ReactNode } from 'react'
import { Bot, FolderTree, PanelLeft, Plus } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { useConnectionStore } from '../../stores/connectionStore'
import type { Activity } from '../../types/ui'
import { ConnectionManager } from '../connection/ConnectionManager'
import { DirectoryTree } from '../tree/DirectoryTree'
import { SearchPanel } from '../search/SearchPanel'
import { SchemaBrowser } from '../schema/SchemaBrowser'
import { BookmarkPanel } from '../bookmarks/BookmarkPanel'
import { AIChatPanel } from '../ai/AIChat'
import { ReportsPanel } from '../reports/ReportsPanel'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { PanelHeader } from '../ui/PanelHeader'
import { EmptyState } from '../ui/EmptyState'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import { TransferPanel } from './TransferPanel'
import { ProfileList } from './ProfileList'
import { showActivity, useShellState } from './shellState'
import { runCommand } from '../ui/commands'

const PANEL_NAMES: Record<Activity, string> = {
  connections: 'Connections',
  explorer: 'Explorer',
  search: 'Search',
  reports: 'Reports',
  bookmarks: 'Bookmarks',
  schema: 'Schema',
  export: 'Import / Export',
  ai: 'AI Chat',
}

function useActiveConnected(): boolean {
  return useConnectionStore((s) => (s.activeProfileId ? s.connectionStatuses[s.activeProfileId] === true : false))
}

/** Explorer while no profile is connected: saved profiles instead of the tree. */
function ExplorerDisconnected() {
  const hasProfiles = useConnectionStore((s) => s.profiles.length > 0)
  const connectingId = useShellState((s) => s.connectingId)
  const connectingName = useConnectionStore((s) => s.profiles.find((p) => p.id === connectingId)?.name)
  return (
    <div className="h-full flex flex-col bg-sidebar text-sidebar-foreground overflow-hidden">
      <PanelHeader title="Explorer" icon={FolderTree} />
      <div className="flex-1 min-h-0 overflow-auto">
        <EmptyState
          icon={FolderTree}
          title={connectingName ? `Connecting to ${connectingName}…` : 'Not connected'}
          hint={hasProfiles ? 'Choose a saved connection: double-click it, or select it and press Enter.' : 'Create a connection profile to browse a directory.'}
          action={
            connectingName ? (
              <Spinner label={`Connecting to ${connectingName}`} />
            ) : (
              <Button size="sm" leftIcon={Plus} onClick={() => (hasProfiles ? showActivity('connections') : runCommand('connection.new'))}>
                {hasProfiles ? 'Manage Connections' : 'New Connection…'}
              </Button>
            )
          }
          className="h-auto pt-8 pb-4"
        />
        {hasProfiles && <ProfileList className="mx-3 mb-3" aria-label="Saved connections" />}
      </div>
    </div>
  )
}

function ExplorerPanel() {
  const connected = useActiveConnected()
  return connected ? <DirectoryTree /> : <ExplorerDisconnected />
}

/** The AI slot of the side bar: the chat, or a note while it is docked right of the editor. */
function AISidebarPanel() {
  const dock = useUIStore((s) => s.aiDock)
  if (dock === 'sidebar') return <AIChatPanel />
  return (
    <div className="h-full flex flex-col bg-sidebar text-sidebar-foreground overflow-hidden">
      <PanelHeader title="AI Chat" icon={Bot} />
      <EmptyState
        icon={Bot}
        title="The AI chat is docked on the right"
        hint="It stays next to the tree and the editor while you browse."
        action={
          <Button size="sm" leftIcon={PanelLeft} onClick={() => useUIStore.getState().setAIDock('sidebar')}>
            Move it back here
          </Button>
        }
        className="h-auto pt-8 pb-4"
      />
    </div>
  )
}

function renderPanel(activity: Activity): ReactNode {
  switch (activity) {
    case 'connections':
      return <ConnectionManager />
    case 'explorer':
      return <ExplorerPanel />
    case 'search':
      return <SearchPanel />
    case 'bookmarks':
      return <BookmarkPanel />
    case 'export':
      return <TransferPanel />
    case 'schema':
      return <SchemaBrowser />
    case 'reports':
      return <ReportsPanel />
    case 'ai':
      return <AISidebarPanel />
    default:
      return null
  }
}

export function Sidebar() {
  const activeActivity = useUIStore((s) => s.activeActivity)
  const [visited, setVisited] = useState<Activity[]>(() => [activeActivity])
  // Adjust state during render (no extra frame without the panel).
  if (!visited.includes(activeActivity)) setVisited([...visited, activeActivity])

  return (
    <div className="h-full bg-sidebar text-sidebar-foreground" role="region" aria-label={`Sidebar: ${PANEL_NAMES[activeActivity] ?? ''}`}>
      {visited.map((a) => (
        <div key={a} className="h-full" hidden={a !== activeActivity} data-panel={a}>
          <ErrorBoundary variant="region" name={PANEL_NAMES[a]}>
            {renderPanel(a)}
          </ErrorBoundary>
        </div>
      ))}
    </div>
  )
}
