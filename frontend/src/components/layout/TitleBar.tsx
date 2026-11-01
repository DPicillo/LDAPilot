/**
 * Title bar (SPEC 7.3): 30px, frameless-window drag region, MenuBar
 * primitive (Alt tap / F10, arrows, mnemonics, Escape restores focus).
 * Menu items come from the command registry: tracks attach handlers with
 * registerCommandHandlers() and the items enable themselves. The Entry menu
 * is generated for the active entry (per-type sets of SPEC 6.5).
 * Centre: "{active entry} — {its connection}". Right: Go to anything (Ctrl+K)
 * and the window controls. Hover / open states use titlebar-hover (accent is
 * 1.03:1 on the light bar); the open menu also gets a 2px primary bar.
 */
import { useEffect, useState, type CSSProperties } from 'react'
import { Copy, Minus, Navigation, Rows3, Square, SunMoon, X, ZoomIn } from 'lucide-react'
import logoImg from '../../assets/logo.png'
import { useUIStore } from '../../stores/uiStore'
import { useEditorStore } from '../../stores/editorStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { ZOOM_PRESETS, setZoomLevel, useShellState, wailsRuntime } from './shellState'
import {
  getCommand,
  getCommandContext,
  isCommandEnabled,
  runCommand,
  useCommandRegistryVersion,
  type CommandContext,
} from '../ui/commands'
import {
  CommandMenuItems,
  MenuBar,
  MenuCheckboxItem,
  MenuHeader,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  SubMenu,
  type MenuBarMenu,
} from '../ui/Menu'
import { Kbd } from '../ui/Kbd'
import { usePaletteStore } from '../ui/paletteStore'
import { DENSITY_OPTIONS, THEME_OPTIONS, type Density, type ThemePref } from '../ui/theme'

const DRAG = { '--wails-draggable': 'drag' } as CSSProperties
const NO_DRAG = { '--wails-draggable': 'no-drag' } as CSSProperties

/**
 * One registry command as a menubar item. Unlike context menus (which hide
 * what does not apply), the menubar keeps its items in place and disables
 * them: not applicable, no handler yet, or a write verb on a read-only
 * connection.
 */
function Cmd({ id, ctx, label }: { id: string; ctx: CommandContext; label?: string }) {
  const c = getCommand(id)
  if (!c) return null
  let applies = true
  let title = label ?? ''
  try {
    applies = c.when ? c.when(ctx) : true
    if (!label) title = typeof c.title === 'function' ? c.title(ctx) : c.title
  } catch {
    applies = false
    if (!label) title = typeof c.title === 'string' ? c.title : id
  }
  const readOnlyBlocked = !!c.write && ctx.readOnly
  const enabled = applies && !readOnlyBlocked && isCommandEnabled(c, ctx)
  const shortcut = Array.isArray(c.shortcut) ? c.shortcut[0] : c.shortcut
  let reason: string | undefined
  if (applies && !readOnlyBlocked && !enabled) {
    try {
      reason = c.disabledReason?.(ctx)
    } catch {
      reason = undefined
    }
  }
  if (c.checked) {
    let checked = false
    try {
      checked = !!c.checked(ctx)
    } catch {
      /* ignore */
    }
    return <MenuCheckboxItem label={title} checked={checked} shortcut={shortcut} disabled={!enabled} onCheckedChange={() => runCommand(id, ctx)} />
  }
  return (
    <MenuItem
      icon={c.icon}
      label={title}
      shortcut={shortcut}
      tone={c.danger ? 'danger' : 'default'}
      disabled={!enabled}
      hint={readOnlyBlocked && applies ? 'Read-only' : reason}
      onSelect={() => runCommand(id, { ...ctx, shownTitle: title })}
    />
  )
}

function useMenus(): MenuBarMenu[] {
  // Re-render when handlers register and when the state the menus show changes.
  useCommandRegistryVersion()
  const themePref = useUIStore((s) => s.themePref)
  const density = useUIStore((s) => s.density)
  const zoomLevel = useUIStore((s) => s.zoomLevel)
  const setThemePref = useUIStore((s) => s.setThemePref)
  const setDensity = useUIStore((s) => s.setDensity)
  useUIStore((s) => s.bottomPanelVisible)
  useShellState((s) => s.bottomMaximized)
  useEditorStore((s) => s.activeTabId)
  useEditorStore((s) => s.entries)
  useConnectionStore((s) => s.activeProfileId)
  useConnectionStore((s) => s.connectionStatuses)
  useConnectionStore((s) => s.loading)

  const ctx = () => getCommandContext('menubar')

  return [
    {
      id: 'file',
      label: 'File',
      content: () => {
        const c = ctx()
        return (
          <>
            <Cmd id="connection.new" ctx={c} />
            <MenuSeparator />
            <Cmd id="connection.importProfiles" ctx={c} />
            <Cmd id="connection.exportProfiles" ctx={c} />
            <MenuSeparator />
            <Cmd id="file.importLdif" ctx={c} />
            <Cmd id="file.export" ctx={c} />
            <MenuSeparator />
            <Cmd id="connection.reconnect" ctx={c} />
            <Cmd id="connection.disconnect" ctx={c} />
            <Cmd id="connection.edit" ctx={c} />
            <Cmd id="connection.test" ctx={c} />
            <MenuSeparator />
            <Cmd id="view.closeTab" ctx={c} />
            <Cmd id="view.closeAllTabs" ctx={c} />
            <MenuSeparator />
            <Cmd id="app.exit" ctx={c} />
          </>
        )
      },
    },
    {
      id: 'edit',
      label: 'Edit',
      content: () => {
        const c = ctx()
        return (
          <>
            <Cmd id="edit.undo" ctx={c} />
            <MenuSeparator />
            <Cmd id="entry.copyDn" ctx={c} />
            <Cmd id="entry.copyLdif" ctx={c} />
            <MenuSeparator />
            <Cmd id="palette.open" ctx={c} />
            <Cmd id="palette.commands" ctx={c} />
            <MenuSeparator />
            <Cmd id="edit.findInTree" ctx={c} />
            <Cmd id="view.search" ctx={c} label="Search Directory" />
          </>
        )
      },
    },
    {
      id: 'view',
      label: 'View',
      content: () => {
        const c = ctx()
        return (
          <>
            <Cmd id="view.connections" ctx={c} />
            <Cmd id="view.explorer" ctx={c} />
            <Cmd id="view.search" ctx={c} />
            <Cmd id="view.reports" ctx={c} />
            <Cmd id="view.bookmarks" ctx={c} />
            <Cmd id="view.schema" ctx={c} />
            <Cmd id="view.transfer" ctx={c} />
            <Cmd id="view.ai" ctx={c} />
            <Cmd id="ai.newChat" ctx={c} />
            <Cmd id="view.aiDock" ctx={c} />
            <Cmd id="view.serverInfo" ctx={c} />
            <MenuSeparator />
            <Cmd id="view.sidebar" ctx={c} />
            <Cmd id="view.panel" ctx={c} />
            <Cmd id="view.maximizePanel" ctx={c} />
            <MenuSeparator />
            <Cmd id="view.results" ctx={c} />
            <Cmd id="view.resultsAsTab" ctx={c} />
            <Cmd id="view.operations" ctx={c} />
            <Cmd id="view.audit" ctx={c} />
            <MenuSeparator />
            <SubMenu label="Theme" icon={SunMoon}>
              <MenuRadioGroup value={themePref} onValueChange={(v) => setThemePref(v as ThemePref)} label="Theme">
                {THEME_OPTIONS.map((o) => (
                  <MenuRadioItem key={o.value} value={o.value} label={o.label} />
                ))}
              </MenuRadioGroup>
            </SubMenu>
            <SubMenu label="Density" icon={Rows3}>
              <MenuRadioGroup value={density} onValueChange={(v) => setDensity(v as Density)} label="Density">
                {DENSITY_OPTIONS.map((o) => (
                  <MenuRadioItem key={o.value} value={o.value} label={o.label} />
                ))}
              </MenuRadioGroup>
            </SubMenu>
            <SubMenu label="Zoom" icon={ZoomIn}>
              <Cmd id="view.zoomIn" ctx={c} />
              <Cmd id="view.zoomOut" ctx={c} />
              <Cmd id="view.zoomReset" ctx={c} />
              <MenuSeparator />
              <MenuRadioGroup value={String(zoomLevel)} onValueChange={(v) => setZoomLevel(Number(v))} label="Zoom level">
                {ZOOM_PRESETS.map((z) => (
                  <MenuRadioItem key={z} value={String(z)} label={`${Math.round(z * 100)}%`} />
                ))}
              </MenuRadioGroup>
            </SubMenu>
            <MenuSeparator />
            <Cmd id="view.showRdnType" ctx={c} />
            <Cmd id="view.singleClickPreview" ctx={c} />
          </>
        )
      },
    },
    {
      id: 'go',
      label: 'Go',
      content: () => {
        const c = ctx()
        return (
          <>
            <Cmd id="navigate.back" ctx={c} />
            <Cmd id="navigate.forward" ctx={c} />
            <MenuSeparator />
            <Cmd id="palette.open" ctx={c} />
            <Cmd id="navigate.gotoDn" ctx={c} />
            <MenuSeparator />
            <Cmd id="recycle.deletedObjects" ctx={c} />
          </>
        )
      },
    },
    {
      id: 'entry',
      label: 'Entry',
      mnemonic: 'n',
      content: () => {
        const c = ctx()
        if (!c.selection.length) {
          // The active tab may belong to another connection than the active one:
          // its actions would run against the wrong directory; CommandMenuItems
          // offers "Switch to <profile>" and the read verbs (RW1-N-02, RW1-C-07).
          if (c.foreign) return <CommandMenuItems ctx={c} showDnHeader />
          return (
            <>
              <MenuHeader>No entry open</MenuHeader>
              <MenuItem label="Open an entry in a tab to see its actions" disabled />
            </>
          )
        }
        return <CommandMenuItems ctx={c} showDnHeader />
      },
    },
    {
      id: 'help',
      label: 'Help',
      content: () => {
        const c = ctx()
        return (
          <>
            <Cmd id="help.shortcuts" ctx={c} />
            <MenuSeparator />
            <Cmd id="help.github" ctx={c} />
            <Cmd id="help.reportIssue" ctx={c} />
            {import.meta.env.DEV && <Cmd id="help.uiGallery" ctx={c} />}
            <MenuSeparator />
            <Cmd id="help.about" ctx={c} />
          </>
        )
      },
    },
  ]
}

/** Window controls: like native caption buttons they are not tab stops (Alt+F4 / the WM still work). */
function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    const rt = wailsRuntime()
    if (!rt?.WindowIsMaximised) return
    let alive = true
    const sync = () => {
      try {
        Promise.resolve(rt.WindowIsMaximised?.())
          .then((m) => alive && setIsMaximized(m === true))
          .catch(() => {})
      } catch {
        /* runtime without the call */
      }
    }
    sync()
    window.addEventListener('resize', sync)
    return () => {
      alive = false
      window.removeEventListener('resize', sync)
    }
  }, [])

  const btn =
    'w-[46px] h-full flex items-center justify-center text-titlebar-foreground transition-colors duration-100 focus-ring-inset'
  return (
    <div className="flex items-stretch h-full shrink-0" style={NO_DRAG}>
      <button type="button" tabIndex={-1} aria-label="Minimize" title="Minimize" onClick={() => wailsRuntime()?.WindowMinimise?.()} className={`${btn} hover:bg-titlebar-hover hover:text-foreground`}>
        <Minus size={14} strokeWidth={1.5} aria-hidden />
      </button>
      <button type="button"
        tabIndex={-1}
        aria-label={isMaximized ? 'Restore' : 'Maximize'}
        title={isMaximized ? 'Restore' : 'Maximize'}
        onClick={() => {
          wailsRuntime()?.WindowToggleMaximise?.()
          setIsMaximized((m) => !m)
        }}
        className={`${btn} hover:bg-titlebar-hover hover:text-foreground`}
      >
        {isMaximized ? <Copy size={11} strokeWidth={1.5} aria-hidden /> : <Square size={11} strokeWidth={1.5} aria-hidden />}
      </button>
      <button type="button" tabIndex={-1} aria-label="Close" title="Close" onClick={() => wailsRuntime()?.Quit?.()} className={`${btn} hover:bg-titlebar-close hover:text-white`}>
        <X size={14} strokeWidth={1.5} aria-hidden />
      </button>
    </div>
  )
}

export function TitleBar() {
  const menus = useMenus()
  const activeTab = useEditorStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const profileName = useConnectionStore((s) => s.profiles.find((p) => p.id === s.activeProfileId)?.name)
  const connected = useConnectionStore((s) => (s.activeProfileId ? s.connectionStatuses[s.activeProfileId] === true : false))
  // Entry tabs of several connections coexist: name the tab's own connection, not the active one.
  const tabProfileName = useConnectionStore((s) => (activeTab?.profileId ? s.profiles.find((p) => p.id === activeTab.profileId)?.name : undefined))

  // Results tabs are labelled after their report / search (the tab label), like the tab itself.
  const parts = (activeTab ? [activeTab.label, tabProfileName ?? (connected ? profileName : undefined)] : [connected ? profileName : undefined]).filter(Boolean) as string[]
  const title = parts.length ? parts.join(' — ') : 'LDAPilot'

  return (
    <header className="@container flex items-center h-titlebar bg-titlebar text-titlebar-foreground border-b border-border select-none shrink-0" style={DRAG}>
      <div className="flex items-center px-2.5 h-full shrink-0" style={NO_DRAG}>
        <img src={logoImg} alt="" className="size-4" />
      </div>

      <div className="h-full shrink-0" style={NO_DRAG}>
        <MenuBar
          menus={menus}
          aria-label="Application menu"
          itemClassName="text-titlebar-foreground hover:bg-titlebar-hover aria-expanded:bg-titlebar-hover"
        />
      </div>

      {/* Centre title: drag region */}
      <div className="flex-1 min-w-0 h-full flex items-center justify-center px-3" style={DRAG}>
        <span className="text-xs text-titlebar-foreground truncate" title={activeTab?.dn || title}>
          {title}
        </span>
      </div>

      <div className="flex items-center h-full shrink-0 pr-1" style={NO_DRAG}>
        <button type="button"
          onClick={() => usePaletteStore.getState().openPalette()}
          aria-label="Go to anything"
          aria-keyshortcuts="Control+K"
          className="flex items-center gap-2 h-[22px] pl-2 pr-1 rounded text-xs text-titlebar-foreground hover:bg-titlebar-hover hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-1"
        >
          <Navigation size={12} strokeWidth={1.75} aria-hidden />
          <span className="hidden @[900px]:inline">Go to anything</span>
          <Kbd shortcut="Mod+K" />
        </button>
      </div>

      <WindowControls />
    </header>
  )
}

