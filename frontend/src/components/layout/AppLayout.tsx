/**
 * Application shell (SPEC 7.2).
 * - Overlay hosts (the feature hosts, DialogHost, CommandPalette, LayerHost,
 *   TooltipHost), the registry shortcut dispatcher, the core, shell and
 *   feature commands and the connection watch, all inside the zoom wrapper.
 * - The feature hosts render BEFORE LayerHost; every dialog they open is a
 *   Dialog primitive, and a dialog opened from a dialog (Import LDIF's and
 *   Batch Modify's "Apply without dry run" confirmations) stacks above it.
 * - The feature commands are registered in the same effect as, and after,
 *   the core and shell sets, so their same-id overrides win again after an
 *   ErrorBoundary "Try again" remounts the layout. The connection handlers
 *   (import/export connections, File ▸ Exit through the quit guard, Report
 *   Issue) come last.
 * - The quit guard (useQuitGuard) answers the backend's app:before-close and
 *   asks "Quit anyway?" while a bulk/LDIF dialog, a recursive delete or
 *   unsaved edits would be lost.
 * - Allotment panes use `visible` instead of conditional rendering, so
 *   Ctrl+B / Ctrl+J never unmount the sidebar or the panel (C1/K1).
 * - proportionalLayout={false}: the sidebar keeps its pixel width when the
 *   window resizes; sidebar width and panel height are persisted in px.
 * - One region ErrorBoundary each around sidebar, main and bottom.
 * - Hidden panes stay mounted but are `inert` (out of the tab order and the
 *   accessibility tree).
 * - The row around the Allotment is its own stacking context (relative z-[1]):
 *   Allotment's sashes have z-index 35, which would otherwise paint over (and
 *   take the clicks of) menus and popovers at --z-dropdown (30) in the zoom
 *   wrapper. z-[1] rather than `isolate`: the title and status bars are
 *   stacking contexts too (@container).
 */
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Allotment, LayoutPriority, type AllotmentHandle } from 'allotment'
import 'allotment/dist/style.css'

import { useUIStore } from '../../stores/uiStore'
import { TitleBar } from './TitleBar'
import { ActivityBar } from './ActivityBar'
import { Sidebar } from './Sidebar'
import { MainPanel } from './MainPanel'
import { BottomPanel } from './BottomPanel'
import { StatusBar } from './StatusBar'
import { LayerHost, focusScopeTarget } from '../ui/layer'
import { TooltipHost } from '../ui/Tooltip'
import { DialogHost } from '../ui/Dialog'
import { CommandPalette } from '../ui/CommandPalette'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { useCommandShortcuts } from '../ui/commands'
import { registerCoreCommands } from '../ui/coreCommands'
import { registerShellCommands } from './shellCommands'
import { registerFeatureCommands } from '../commands/featureCommands'
import { DeletedObjectsHost } from '../recycle/DeletedObjectsHost'
import { BulkDialogHost } from '../bulk/BulkDialogHost'
import { CertificateTrustPrompt } from '../connection/CertificateTrustPrompt'
import { ConnectPasswordPrompt } from '../connection/ConnectPasswordPrompt'
import { QuitGuardDialog, useQuitGuard } from '../connection/QuitGuard'
import { registerConnectionCommands } from '../connection/connectionCommands'
import { useConnectionWatch } from './useConnectionWatch'
import { ConnectionAnnouncer } from './ConnectionBanner'
import { AI_PANE_MAX, AI_PANE_MIN, BOTTOM_MIN, SIDEBAR_MAX, SIDEBAR_MIN, loadLayout, saveLayout, useShellState } from './shellState'
import { AIChatPanel } from '../ai/AIChat'
import { EDITOR_MIN_DOCKED, fitDockedPanes, needsRefit } from '../../lib/aiDock'

// Dev-only primitive gallery (?ui-gallery). The dynamic import is dropped from production builds.
const UiGallery = import.meta.env.DEV ? lazy(() => import('../ui/UiGallery')) : null
const galleryRequested = () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('ui-gallery')

/** Overlay hosts: inside the zoom wrapper so fixed positioning and % sizes follow the zoom. */
function OverlayHosts() {
  return (
    <>
      <CertificateTrustPrompt />
      <ConnectPasswordPrompt />
      <QuitGuardDialog />
      <DeletedObjectsHost />
      <BulkDialogHost />
      <DialogHost />
      <CommandPalette />
      <LayerHost />
      <TooltipHost />
      <ConnectionAnnouncer />
    </>
  )
}

export function AppLayout() {
  const sidebarVisible = useUIStore((s) => s.sidebarVisible)
  const bottomPanelVisible = useUIStore((s) => s.bottomPanelVisible)
  const bottomMaximized = useShellState((s) => s.bottomMaximized)
  // The AI chat docked right of the editor (View ▸ Move AI Chat to the Right).
  const aiDock = useUIStore((s) => s.aiDock)
  const aiRight = useUIStore((s) => s.aiDock === 'right' && s.aiPaneVisible)
  const [layout] = useState(loadLayout)

  // Global keyboard plumbing (SPEC 6.2): the dispatcher runs every global shortcut
  // (registry commands) and stays out of open dialogs (isModalOpen); dialogs stop
  // keydown propagation at their root.
  useCommandShortcuts()
  useEffect(() => {
    // Order matters: same-id definitions registered later override earlier ones.
    const offs = [registerCoreCommands(), registerShellCommands(), registerFeatureCommands(), registerConnectionCommands()]
    return () => offs.reverse().forEach((off) => off())
  }, [])
  useConnectionWatch()
  useQuitGuard()

  // Hiding the panel also leaves the maximized state.
  useEffect(() => {
    if (!bottomPanelVisible && bottomMaximized) useShellState.getState().setBottomMaximized(false)
  }, [bottomPanelVisible, bottomMaximized])

  // A hidden pane stays mounted but inert: focus inside it (Ctrl+B in the tree,
  // Ctrl+J in the panel, or a menu returning focus there) would fall to <body>.
  // The pane that last had focus is tracked; when it is hidden, focus moves to
  // the editor's tab stop (else another visible pane). Re-showing a pane does
  // not take focus (POST-NOTES).
  const lastPane = useRef<string | null>(null)
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const p = (e.target as Element | null)?.closest?.('[data-pane]')?.getAttribute('data-pane')
      if (p) lastPane.current = p
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [])
  const mainShown = !(bottomPanelVisible && bottomMaximized)

  // Toasts sit above the bottom panel while it shows next to the main pane, so they never
  // cover the rows of the results / reports grid (RW2-P-03, RW2-S-13): --toast-lift = its height.
  useEffect(() => {
    const root = document.documentElement
    const panel = document.querySelector<HTMLElement>('[data-pane="panel"]')
    const apply = () => {
      const lift = bottomPanelVisible && mainShown && panel ? panel.offsetHeight : 0
      root.style.setProperty('--toast-lift', `${lift}px`)
    }
    apply()
    if (!panel || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(apply)
    ro.observe(panel)
    return () => ro.disconnect()
  }, [bottomPanelVisible, mainShown])

  // Toasts stay left of the AI chat docked right (N1): over it they covered an approval
  // card's buttons and the composer. --toast-right = the pane's width while it shows.
  useEffect(() => {
    const root = document.documentElement
    const pane = document.querySelector<HTMLElement>('[data-pane="ai"]')
    const apply = () => root.style.setProperty('--toast-right', `${aiRight && pane ? pane.offsetWidth : 0}px`)
    apply()
    if (!aiRight || !pane || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(apply)
    ro.observe(pane)
    return () => {
      ro.disconnect()
      root.style.setProperty('--toast-right', '0px')
    }
  }, [aiRight])

  // The editor column keeps EDITOR_MIN_DOCKED next to the chat docked right (N2): when the
  // window is too narrow for the saved widths, the AI pane and then the side bar give way
  // (lib/aiDock.ts); a wider window gives them back. Only a drag saves widths (onDragEnd).
  const hSplit = useRef<AllotmentHandle>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const wasDocked = useRef(aiRight)
  useEffect(() => {
    const row = rowRef.current
    const width = (p: string) => document.querySelector<HTMLElement>(`[data-pane="${p}"]`)?.offsetWidth ?? 0
    const undocked = wasDocked.current && !aiRight
    wasDocked.current = aiRight
    if (!row || (!aiRight && !undocked)) return
    let raf = 0
    const fit = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const sidebarOn = useUIStore.getState().sidebarVisible
        const now = { sidebar: sidebarOn ? width('sidebar') : 0, ai: aiRight ? width('ai') : 0 }
        // the editor column: the main pane, or the bottom panel while it is maximized
        const total = now.sidebar + now.ai + Math.max(width('main'), width('panel'))
        if (!total || (aiRight && !now.ai)) return
        const pref = loadLayout()
        // Moved back to the side bar: the side bar gets its saved width again.
        const target = aiRight
          ? fitDockedPanes({ total, sidebar: sidebarOn ? pref.sidebarWidth : 0, sidebarMin: SIDEBAR_MIN, ai: pref.aiWidth, aiMin: AI_PANE_MIN, editorMin: EDITOR_MIN_DOCKED })
          : fitDockedPanes({ total, sidebar: sidebarOn ? pref.sidebarWidth : 0, sidebarMin: SIDEBAR_MIN, ai: 0, aiMin: 0, editorMin: 0 })
        if (needsRefit(now, target)) hSplit.current?.resize([target.sidebar, target.editor, target.ai])
      })
    }
    fit()
    if (!aiRight || typeof ResizeObserver === 'undefined') return () => cancelAnimationFrame(raf)
    const ro = new ResizeObserver(fit)
    ro.observe(row)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [aiRight, sidebarVisible])

  // Leaving the maximized state, or a panel shown again: the panel gets its saved height,
  // not Allotment's minimum (RW1-R-01: a report run with the panel hidden left it at 120 px).
  const vSplit = useRef<AllotmentHandle>(null)
  const wasShown = useRef({ main: mainShown, panel: bottomPanelVisible })
  useEffect(() => {
    const before = wasShown.current
    wasShown.current = { main: mainShown, panel: bottomPanelVisible }
    if (!mainShown || !bottomPanelVisible || (before.main && before.panel)) return
    const raf = requestAnimationFrame(() => {
      const main = document.querySelector<HTMLElement>('[data-pane="main"]')
      const panel = document.querySelector<HTMLElement>('[data-pane="panel"]')
      const total = (main?.offsetHeight ?? 0) + (panel?.offsetHeight ?? 0)
      if (!total) return
      const h = Math.max(BOTTOM_MIN, Math.min(loadLayout().bottomHeight, total - 120))
      vSplit.current?.resize([total - h, h])
    })
    return () => cancelAnimationFrame(raf)
  }, [mainShown, bottomPanelVisible])

  useLayoutEffect(() => {
    const hidden: Record<string, boolean> = { sidebar: !sidebarVisible, main: !mainShown, panel: !bottomPanelVisible, ai: !aiRight }
    const p = lastPane.current
    if (!p || !hidden[p]) return
    const rescue = () => {
      const a = document.activeElement
      if (a && a !== document.body && !a.closest('[inert]')) return
      for (const x of ['main', 'panel', 'sidebar', 'ai']) {
        if (hidden[x]) continue
        const scope = document.querySelector<HTMLElement>(`[data-pane="${x}"] [role="region"]`)
        const t = scope && focusScopeTarget(scope)
        if (t) {
          t.focus({ preventScroll: true })
          return
        }
      }
    }
    rescue()
    const raf = requestAnimationFrame(rescue)
    return () => cancelAnimationFrame(raf)
  }, [sidebarVisible, mainShown, bottomPanelVisible, aiRight])

  if (UiGallery && galleryRequested()) {
    return (
      <div className="h-full flex flex-col">
        <Suspense fallback={null}>
          <UiGallery />
        </Suspense>
        <OverlayHosts />
      </div>
    )
  }

  const mainVisible = !(bottomPanelVisible && bottomMaximized)

  return (
    <div className="h-full flex flex-col">
      <TitleBar />
      <div ref={rowRef} className="relative z-[1] flex-1 flex overflow-hidden min-h-0">
        <ActivityBar />
        {/* separator={false}: the sidebar draws its own 1px edge, so nothing overlays the
            main pane's first pixels (the row-selected bar of full-bleed tables). */}
        <Allotment
          ref={hSplit}
          proportionalLayout={false}
          separator={false}
          onDragEnd={(sizes) => {
            const w = sizes[0]
            if (sidebarVisible && w >= SIDEBAR_MIN && w <= SIDEBAR_MAX) saveLayout({ sidebarWidth: Math.round(w) })
            const a = sizes[2]
            if (aiRight && a >= AI_PANE_MIN && a <= AI_PANE_MAX) saveLayout({ aiWidth: Math.round(a) })
          }}
        >
          <Allotment.Pane visible={sidebarVisible} preferredSize={layout.sidebarWidth} minSize={SIDEBAR_MIN} maxSize={SIDEBAR_MAX} priority={LayoutPriority.Low}>
            <div className="h-full border-r border-border" data-pane="sidebar" inert={!sidebarVisible}>
              <ErrorBoundary variant="region" name="Sidebar">
                <Sidebar />
              </ErrorBoundary>
            </div>
          </Allotment.Pane>
          <Allotment.Pane priority={LayoutPriority.High} minSize={320}>
            <Allotment
              ref={vSplit}
              vertical
              proportionalLayout={false}
              separator={false}
              onDragEnd={(sizes) => {
                const h = sizes[1]
                if (bottomPanelVisible && mainVisible && h >= BOTTOM_MIN) saveLayout({ bottomHeight: Math.round(h) })
              }}
              onVisibleChange={(index, visible) => {
                // The panel snapped closed by dragging: keep the store in sync.
                if (index === 1 && !visible && useUIStore.getState().bottomPanelVisible) useUIStore.getState().toggleBottomPanel()
              }}
            >
              <Allotment.Pane visible={mainVisible} priority={LayoutPriority.High} minSize={120}>
                <div className="h-full" data-pane="main" inert={!mainVisible}>
                  <ErrorBoundary variant="region" name="Editor">
                    <MainPanel />
                  </ErrorBoundary>
                </div>
              </Allotment.Pane>
              <Allotment.Pane visible={bottomPanelVisible} preferredSize={layout.bottomHeight} minSize={BOTTOM_MIN} snap priority={LayoutPriority.Low}>
                <div className="h-full" data-pane="panel" inert={!bottomPanelVisible}>
                  <ErrorBoundary variant="region" name="Panel">
                    <BottomPanel />
                  </ErrorBoundary>
                </div>
              </Allotment.Pane>
            </Allotment>
          </Allotment.Pane>
          {/* The AI chat right of the editor: mounted only while docked here (the
              side bar mounts it otherwise), kept mounted while hidden. */}
          <Allotment.Pane visible={aiRight} preferredSize={layout.aiWidth} minSize={AI_PANE_MIN} maxSize={AI_PANE_MAX} priority={LayoutPriority.Low}>
            <div className={`h-full bg-sidebar text-sidebar-foreground ${aiRight ? 'border-l border-border' : ''}`} data-pane="ai" inert={!aiRight}>
              {aiDock === 'right' && (
                <ErrorBoundary variant="region" name="AI Chat">
                  <div className="h-full" role="region" aria-label="AI Chat">
                    <AIChatPanel />
                  </div>
                </ErrorBoundary>
              )}
            </div>
          </Allotment.Pane>
        </Allotment>
      </div>
      <StatusBar />
      <OverlayHosts />
    </div>
  )
}
