/**
 * Status bar (SPEC 7.8), 22px: the connection control centre. States: idle /
 * connecting / connected / lost (warning fill, "Reconnecting… (n/5)"). All
 * text at full statusbar-*-foreground, no opacity. Left: connection switcher
 * (DropdownMenu, status dots, keyboard; connecting from it shows the
 * Explorer; Disconnect / Edit / Test submenus per profile), host:port and
 * base DN (click copies; an empty base DN reads "all naming contexts"). An
 * active profile that is not connected reads "<profile> – not connected · n
 * open". Right: in-flight spinner + last operation (opens Operations),
 * selection summary ("12 children of Users · 1 selected"), results, tabs,
 * auth + TLS trust and password storage policy (buttons: Edit Connection at
 * TLS trust / Password storage), Read-only badge, zoom menu, panel toggle.
 * Narrow windows (@container): tab count, then base DN, then last op hide.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Check, ChevronUp, FlaskConical, Lock, Pencil, Plug, PlugZap, RefreshCw, Settings2, Terminal, TriangleAlert, Unplug } from 'lucide-react'
import { cn } from '../../lib/utils'
import { ensureProfilesLoaded, useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { useSearchStore } from '../../stores/searchStore'
import { useTreeStore } from '../../stores/treeStore'
import { useUIStore } from '../../stores/uiStore'
import { DropdownMenu, MenuHeader, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, SubMenu } from '../ui/Menu'
import { Badge } from '../ui/Badge'
import { Spinner, useDelayedFlag } from '../ui/Spinner'
import { Tooltip } from '../ui/Tooltip'
import { toast } from '../ui/Toast'
import { parentDn } from '../ui/dnParse'
import { firstRDN, parseRDN } from '../../lib/dn'
import { ConnectionSecurityStatus, PasswordStorageStatus } from '../connection/ConnectionSecurityStatus'
import { editConnection } from '../connection/ConnectionDialog'
import { testSavedConnection } from '../connection/testSavedConnection'
import { connectAndBrowse } from '../connection/connectFlow'
import { focusWorkAreaSoon } from '../editor/editorFocus'
import { baseDnLabel, idleSwitcherLabel, selectionSummaryText } from '../connection/profileLogic'
import { contextHeadLabel } from '../../lib/treesearch'
import { ZOOM_PRESETS, setZoomLevel, showActivity, showSearchResults, useShellState } from './shellState'
import { MAX_RETRY_ATTEMPTS, reconnectProfile, useConnectionHealth } from './useConnectionWatch'

type BarState = 'idle' | 'connecting' | 'connected' | 'lost'

// Focus: 2px in the bar's own text colour (outline-current), because the
// near-black/near-white `focus` token is < 3:1 on the connected/warning fills.
// outline-solid is required: outline-hidden sets --tw-outline-style: none.
const item =
  'inline-flex items-center gap-1 h-[18px] px-1 rounded-sm whitespace-nowrap outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-current focus-visible:outline-offset-0'

/** Classes of a status bar button (also given to the security / password chips). */
const sbItemClass = cn(item, 'hover:underline underline-offset-2 disabled:cursor-default disabled:no-underline')

/** A status bar button: underline on hover, outline on keyboard focus. */
function SbButton({ children, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button type="button" className={cn(sbItemClass, className)} {...rest}>
      {children}
    </button>
  )
}

function useInFlight(): boolean {
  const searching = useSearchStore((s) => s.loading)
  const entryLoading = useEditorStore((s) => Object.values(s.loadingEntries).some(Boolean))
  const treeLoading = useTreeStore((s) => Object.values(s.loading).some(Boolean))
  return useDelayedFlag(searching || entryLoading || treeLoading, 150)
}

/** Display name of a DN (its RDN value). */
const nameOf = (dn: string) => parseRDN(firstRDN(dn)).value || dn

/**
 * "12 children of Users · 1 selected" for the tree selection: the anchor's
 * loaded children, else its siblings (the children of its parent), so the
 * number always says what it counts.
 */
function useSelectionSummary(): string | null {
  return useTreeStore((s) => {
    const n = s.selectedNodes.size
    if (!n) return null
    const anchor = s.selectionAnchor && s.selectedNodes.has(s.selectionAnchor) ? s.selectionAnchor : s.selectedNodes.values().next().value
    if (!anchor) return null
    // A tree root is named like its row ("ad.ldapilot.lab", not "ad"; RW1-C-13).
    const isRoot = (dn: string) => Object.values(s.rootNodes).some((list) => list.some((r) => r.dn === dn))
    const label = (dn: string) => (isRoot(dn) ? contextHeadLabel(dn) : nameOf(dn))
    const own = s.childNodes[anchor]
    if (own) return selectionSummaryText(n, own.length, label(anchor))
    const parent = parentDn(anchor)
    const siblings = s.childNodes[parent]
    if (siblings) return selectionSummaryText(n, siblings.length, label(parent))
    const roots = Object.values(s.rootNodes).find((list) => list.some((r) => r.dn === anchor))
    return roots ? `${roots.length} root entr${roots.length === 1 ? 'y' : 'ies'} · ${n} selected` : `${n} selected`
  })
}

function opLabel(op: string) {
  return op.toLowerCase()
}

export function StatusBar() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId)
  const profiles = useConnectionStore((s) => s.profiles)
  const connectionStatuses = useConnectionStore((s) => s.connectionStatuses)
  const storeLoading = useConnectionStore((s) => s.loading)
  const connectingId = useShellState((s) => s.connectingId)
  const lastOp = useShellState((s) => (activeProfileId ? s.lastOps[activeProfileId] : undefined) ?? null)
  const health = useConnectionHealth()
  const tabs = useEditorStore((s) => s.tabs.length)
  const results = useSearchStore((s) => s.results)
  // Results of another connection say whose they are (round-2/3 observation).
  const resultsProfileId = useSearchStore((s) => s.resultsProfileId)
  const resultsOf = useConnectionStore((s) =>
    resultsProfileId && resultsProfileId !== s.activeProfileId ? s.profiles.find((p) => p.id === resultsProfileId)?.name ?? null : null,
  )
  const bottomPanelVisible = useUIStore((s) => s.bottomPanelVisible)
  const toggleBottomPanel = useUIStore((s) => s.toggleBottomPanel)
  const showBottomTab = useUIStore((s) => s.showBottomTab)
  const zoomLevel = useUIStore((s) => s.zoomLevel)
  const inFlight = useInFlight()
  const selection = useSelectionSummary()

  // The profiles, whichever side bar panel is restored (the Connections panel used to load them).
  useEffect(() => ensureProfilesLoaded(), [])

  const isConnected = activeProfileId ? connectionStatuses[activeProfileId] === true : false
  const activeProfile = activeProfileId ? profiles.find((p) => p.id === activeProfileId) : undefined
  const lost = health.status === 'lost' && health.profileId === activeProfileId && !!activeProfileId
  const connectingProfile = profiles.find((p) => p.id === (connectingId ?? activeProfileId))

  // Connecting: a connect started by the shell, or the store busy for the active profile
  // (ConnectionManager selects the profile before connecting). Not during loadProfiles.
  const connecting = useDelayedFlag(!!connectingId || (storeLoading && !!activeProfileId), 200)
  const state: BarState = lost ? 'lost' : connecting && !isConnected ? 'connecting' : isConnected ? 'connected' : 'idle'

  // Retry countdown for the lost state ("Reconnecting… (2/5)").
  const [, tick] = useState(0)
  useEffect(() => {
    if (!lost || !health.nextRetryAt) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [lost, health.nextRetryAt])

  const copyText = (text: string, what: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(`${what} copied`))
      .catch((err) => toast.error(`Could not copy the ${what.toLowerCase()}`, err instanceof Error ? err.message : String(err)))
  }
  const openCount = profiles.filter((p) => connectionStatuses[p.id] === true).length

  const lostText = health.stopReason === 'certificate'
    ? 'Certificate not trusted'
    : health.retrying
    ? `Reconnecting… (${Math.max(1, health.attempt)}/${MAX_RETRY_ATTEMPTS})`
    : health.nextRetryAt
      ? `Reconnecting… (${health.attempt + 1}/${MAX_RETRY_ATTEMPTS}) in ${Math.max(0, Math.ceil((health.nextRetryAt - Date.now()) / 1000))} s`
      : 'Connection lost'

  const switcherLabel =
    state === 'connecting'
      ? `Connecting to ${connectingProfile?.name ?? 'server'}…`
      : state === 'idle'
        ? idleSwitcherLabel(activeProfile?.name, openCount)
        : (activeProfile?.name ?? 'Connected')

  return (
    <footer
      className={cn(
        '@container flex items-center justify-between gap-3 px-1.5 h-statusbar text-xs select-none shrink-0 transition-colors duration-200',
        state === 'lost'
          ? 'bg-statusbar-warning text-statusbar-warning-foreground'
          : state === 'connected' || state === 'connecting'
            ? 'bg-statusbar-connected text-statusbar-connected-foreground'
            : 'bg-statusbar text-statusbar-foreground',
      )}
      aria-label="Status bar"
    >
      {/* Left */}
      <div className="flex items-center gap-2 min-w-0">
        <DropdownMenu
          label="Connections"
          placement="top-start"
          minWidth={280}
          trigger={
            <SbButton aria-label={`Connection: ${switcherLabel}. Switch connection`} className="font-medium min-w-0">
              {state === 'connecting' ? (
                <Spinner size="sm" decorative />
              ) : state === 'lost' ? (
                <TriangleAlert size={12} strokeWidth={1.75} aria-hidden />
              ) : state === 'connected' ? (
                <PlugZap size={12} strokeWidth={1.75} aria-hidden />
              ) : (
                <Plug size={12} strokeWidth={1.75} aria-hidden />
              )}
              <span className="truncate max-w-[220px]">{switcherLabel}</span>
              <ChevronUp size={10} strokeWidth={1.75} aria-hidden />
            </SbButton>
          }
        >
          {() => (
            <>
              <MenuHeader>Switch connection</MenuHeader>
              {profiles.length === 0 && <MenuItem label="No saved connections" disabled />}
              {profiles.map((p) => {
                const connected = connectionStatuses[p.id] === true
                const isActive = p.id === activeProfileId
                return (
                  <MenuItem
                    key={p.id}
                    icon={<span aria-hidden className={cn('size-2 rounded-full', connected ? 'bg-success' : 'border border-border-strong')} />}
                    label={
                      <>
                        {p.name}
                        <span className="sr-only">{connected ? ', connected' : ', not connected'}{isActive ? ', active' : ''}</span>
                      </>
                    }
                    textValue={p.name}
                    hint={
                      <span className="inline-flex items-center gap-1.5 font-mono">
                        {p.host}:{p.port}
                        {isActive ? <Check size={12} strokeWidth={2} aria-hidden className="text-primary" /> : <span className="w-3" />}
                      </span>
                    }
                    onSelect={() => {
                      // Connecting shows the Explorer and focuses the tree (like the Connections list);
                      // switching between open connections keeps the current panel.
                      if (!connected) void connectAndBrowse(p.id)
                      else if (!isActive) useConnectionStore.getState().setActiveProfile(p.id)
                    }}
                  />
                )
              })}
              {profiles.length > 0 && (
                <>
                  <MenuSeparator />
                  <SubMenu label="Disconnect" icon={Unplug} disabled={openCount === 0}>
                    {profiles.filter((p) => connectionStatuses[p.id] === true).map((p) => (
                      <MenuItem key={p.id} label={p.name} textValue={p.name} hint={<span className="font-mono">{p.host}:{p.port}</span>} onSelect={() => void useConnectionStore.getState().disconnect(p.id)} />
                    ))}
                  </SubMenu>
                  <SubMenu label="Edit Connection" icon={Pencil}>
                    {profiles.map((p) => (
                      <MenuItem key={p.id} label={`${p.name}…`} textValue={p.name} hint={<span className="font-mono">{p.host}:{p.port}</span>} onSelect={() => editConnection(p.id)} />
                    ))}
                  </SubMenu>
                  <SubMenu label="Test Connection" icon={FlaskConical}>
                    {profiles.map((p) => (
                      <MenuItem key={p.id} label={p.name} textValue={p.name} hint={<span className="font-mono">{p.host}:{p.port}</span>} onSelect={() => void testSavedConnection(p.id)} />
                    ))}
                  </SubMenu>
                </>
              )}
              <MenuSeparator />
              <MenuItem icon={Settings2} label="Manage Connections…" shortcut="Mod+Shift+C" onSelect={() => showActivity('connections')} />
            </>
          )}
        </DropdownMenu>

        {/* Not a live region: the countdown changes every second. State changes are
            announced once by ConnectionAnnouncer (ConnectionBanner.tsx). */}
        {state === 'lost' && <span className="whitespace-nowrap">{lostText}</span>}

        {(isConnected || lost) && activeProfile && (
          <>
            <Tooltip content={`${activeProfile.host}:${activeProfile.port} — click to copy`} placement="top-start">
              <SbButton className="hidden @[420px]:inline-flex font-mono" onClick={() => copyText(`${activeProfile.host}:${activeProfile.port}`, 'Host and port')} aria-label={`Server ${activeProfile.host}:${activeProfile.port}, copy`}>
                {activeProfile.host}:{activeProfile.port}
              </SbButton>
            </Tooltip>
            {activeProfile.baseDN.trim() ? (
              <Tooltip content={`${activeProfile.baseDN} — click to copy`} placement="top-start">
                <SbButton className="hidden @[760px]:inline-flex font-mono min-w-0" onClick={() => copyText(activeProfile.baseDN, 'Base DN')} aria-label={`Base DN ${activeProfile.baseDN}, copy`}>
                  <span className="truncate max-w-[240px]">{activeProfile.baseDN}</span>
                </SbButton>
              </Tooltip>
            ) : (
              <span className="hidden @[760px]:inline whitespace-nowrap italic" title="The profile has no base DN: the tree shows every naming context of the server">
                {baseDnLabel(activeProfile.baseDN)}
              </span>
            )}
          </>
        )}
      </div>

      {/* Right */}
      <div className="flex items-center gap-2 shrink-0">
        {(inFlight || lastOp) && (isConnected || lost) && (
          <SbButton className="hidden @[620px]:inline-flex" onClick={() => showBottomTab('output')} aria-label="Last operation, open the Operations log">
            {inFlight && <Spinner size="sm" decorative />}
            {lastOp && (
              <span className={cn('tabular-nums', lastOp.error && 'underline decoration-wavy')}>
                {opLabel(lastOp.operation)} · {lastOp.duration.replace(/(\d)(ms)$/, '$1 $2')}
                {lastOp.error && <span className="sr-only"> (failed)</span>}
              </span>
            )}
          </SbButton>
        )}

        {selection && isConnected && <span className="whitespace-nowrap tabular-nums hidden @[520px]:inline">{selection}</span>}

        {results && results.totalCount > 0 && (
          <SbButton onClick={() => showSearchResults()} className="tabular-nums" title={resultsOf ? `Results of ${resultsOf}` : undefined}>
            {results.totalCount} result{results.totalCount !== 1 ? 's' : ''}
            {results.truncated && ' (truncated)'}
            {resultsOf && <span className="hidden @[700px]:inline"> · {resultsOf}</span>}
          </SbButton>
        )}

        {tabs > 0 && <span className="whitespace-nowrap tabular-nums hidden @[900px]:inline">{tabs} tab{tabs !== 1 ? 's' : ''}</span>}

        {isConnected && activeProfile && (
          <>
            <Tooltip content="Reconnect" placement="top">
              <SbButton
                aria-label="Reconnect"
                disabled={storeLoading}
                data-sb-reconnect=""
                onClick={() => {
                  // Disabled while it runs: focus comes back to it (or the work area) afterwards (RW2-C-03).
                  if (activeProfileId) void reconnectProfile(activeProfileId).finally(() => focusWorkAreaSoon(() => document.querySelector<HTMLElement>('[data-sb-reconnect]')))
                }}
              >
                <RefreshCw size={12} strokeWidth={1.75} aria-hidden className={storeLoading ? 'animate-spin' : undefined} />
              </SbButton>
            </Tooltip>
            {/* Auth method + TLS trust (auth track), password storage policy (issue #1): buttons
                opening Edit Connection at that section. */}
            <ConnectionSecurityStatus profile={activeProfile} className={sbItemClass} onActivate={() => editConnection(activeProfile.id, 'tls')} />
            <PasswordStorageStatus
              profile={activeProfile}
              connected={isConnected}
              className={cn(sbItemClass, 'hidden @[760px]:inline-flex')}
              onActivate={() => editConnection(activeProfile.id, 'password')}
            />
          </>
        )}

        {activeProfile?.readOnly && (
          <Badge tone="warning" size="sm" icon={Lock}>
            Read-only
          </Badge>
        )}

        <DropdownMenu
          label="Zoom"
          placement="top-end"
          trigger={
            <SbButton aria-label={`Zoom ${Math.round(zoomLevel * 100)}%, change`} className="tabular-nums">
              {Math.round(zoomLevel * 100)}%
            </SbButton>
          }
        >
          {() => (
            <>
              <MenuRadioGroup value={String(zoomLevel)} onValueChange={(v) => setZoomLevel(Number(v))} label="Zoom level">
                {ZOOM_PRESETS.map((z) => (
                  <MenuRadioItem key={z} value={String(z)} label={`${Math.round(z * 100)}%`} />
                ))}
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuItem label="Zoom In" shortcut="Mod+=" onSelect={() => useUIStore.getState().zoomIn()} />
              <MenuItem label="Zoom Out" shortcut="Mod+-" onSelect={() => useUIStore.getState().zoomOut()} />
              <MenuItem label="Reset Zoom" shortcut="Mod+0" onSelect={() => useUIStore.getState().zoomReset()} />
            </>
          )}
        </DropdownMenu>

        <Tooltip content={bottomPanelVisible ? 'Hide Panel' : 'Show Panel'} shortcut="Mod+J" placement="top-end">
          <SbButton aria-label={bottomPanelVisible ? 'Hide Panel' : 'Show Panel'} aria-pressed={bottomPanelVisible} onClick={toggleBottomPanel}>
            <Terminal size={12} strokeWidth={1.75} aria-hidden />
            <span className="hidden @[520px]:inline">Panel</span>
          </SbButton>
        </Tooltip>
      </div>
    </footer>
  )
}
