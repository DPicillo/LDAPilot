/**
 * Commands owned by the shell (menubar items that are not in the core set),
 * registered through the same registry so the palette and the shortcut list
 * see them. Registered once by AppLayout next to registerCoreCommands().
 *
 * Placeholders without a handler (visible, disabled until wired POST):
 *   edit.findInTree (Ctrl+F, tree filter), view.showRdnType (tree RDN prefix);
 *   tree/treeCommands.tsx overrides both.
 */
import { Bug, Download, ExternalLink, FileInput, FileOutput, Info, LogOut, Maximize2, RefreshCw, Search, Type } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { useUIStore } from '../../stores/uiStore'
import { useSearchStore } from '../../stores/searchStore'
import { registerCommands, type Command } from '../ui/commands'
import { useDialogStore } from '../ui/Dialog'
import { ExportDialog } from '../export/ExportDialog'
import { AboutDialog } from './AboutDialog'
import { exportConnectionProfiles, importConnectionProfiles } from '../connection/connectionTransfer'
import { requestQuit } from '../connection/QuitGuard'
import { reportIssue } from '../connection/diagnostics'
import { getExportTarget, useShellState } from './shellState'
import { openResultsSnapshot } from '../search/resultsSnapshots'
import { contextHeadLabel } from '../../lib/treesearch'
import { firstRDN, parseRDN } from '../../lib/dn'

/** What File ▸ Export… exports: the context's entry (most recent source), else the export target. */
function exportDnOf(ctx: { selection: { dn: string }[] }): string {
  return ctx.selection[0]?.dn || getExportTarget().dn
}
import { reconnectProfile } from './useConnectionWatch'

function shellCommands(): Command[] {
  return [
    {
      id: 'connection.importProfiles',
      title: 'Import Connections…',
      icon: FileInput,
      group: 'connection',
      section: 'connection',
      order: 20,
      // One implementation for every entry point (CONN-04): the import report, silent Cancel.
      run: () => importConnectionProfiles(),
      keywords: ['profiles', 'json'],
    },
    {
      id: 'connection.exportProfiles',
      title: 'Export Connections…',
      icon: FileOutput,
      group: 'connection',
      section: 'connection',
      order: 21,
      // Silent Cancel, "n connections exported to <path>" (CONN-05).
      run: () => exportConnectionProfiles(),
      keywords: ['profiles', 'json', 'backup'],
    },
    {
      id: 'app.exit',
      title: 'Exit',
      icon: LogOut,
      group: 'view',
      section: 'app',
      // Through the quit guard (unsaved edits, running batch / delete: CONN-15).
      run: () => requestQuit(),
      keywords: ['quit', 'close window'],
    },
    {
      id: 'edit.findInTree',
      title: 'Find in Tree',
      icon: Search,
      group: 'navigate',
      section: 'navigate',
      shortcut: 'Mod+F',
      displayOnly: true,
      palette: false,
    },
    {
      id: 'view.showRdnType',
      title: 'Show RDN Type',
      icon: Type,
      group: 'view',
      section: 'layout',
      toggle: true,
      checked: () => false,
      palette: false,
    },
    {
      id: 'view.maximizePanel',
      title: () => (useShellState.getState().bottomMaximized && useUIStore.getState().bottomPanelVisible ? 'Restore Panel' : 'Maximize Panel'),
      icon: Maximize2,
      group: 'view',
      section: 'layout',
      run: () => {
        const ui = useUIStore.getState()
        const shell = useShellState.getState()
        if (!ui.bottomPanelVisible) {
          ui.toggleBottomPanel()
          shell.setBottomMaximized(true)
        } else shell.toggleBottomMaximized()
      },
      keywords: ['bottom panel', 'results', 'fullscreen'],
    },
    {
      id: 'view.resultsAsTab',
      title: 'Open Results as Tab',
      icon: ExternalLink,
      group: 'view',
      section: 'logs',
      enabled: () => !!useSearchStore.getState().results,
      // A results tab with a snapshot of the panel's rows (DEF-16); the panel stays live.
      run: () => void openResultsSnapshot(),
    },
    {
      // Overrides the core definition: prefill the tree selection, else the active tab, else the base DN.
      id: 'file.export',
      // The File menu names what it exports (RW1-R-08): the most recent selection source
      // (tree row, results row, Contents list, active tab), else the export target.
      title: (ctx) => {
        if (ctx.source !== 'menubar') return 'Export…'
        const dn = exportDnOf(ctx)
        const name = dn ? (/^dc=/i.test(dn.trim()) ? contextHeadLabel(dn) : parseRDN(firstRDN(dn)).value) : ''
        return name ? `Export “${name}”…` : 'Export…'
      },
      stableTitle: true,
      icon: Download,
      group: 'connection',
      section: 'transfer',
      when: (ctx) => ctx.connected && !!ctx.profileId,
      run: (ctx) => {
        const dn = exportDnOf(ctx)
        useDialogStore.getState().open(ExportDialog, { dn: dn || undefined })
      },
      keywords: ['ldif', 'csv'],
    },
    {
      // Overrides the core definition: File ▸ Reconnect and the palette go through the
      // connection watch, so the banner / status bar / retry budget follow the result.
      id: 'connection.reconnect',
      title: 'Reconnect',
      icon: RefreshCw,
      group: 'connection',
      section: 'connection',
      when: (ctx) => !!ctx.profileId,
      enabled: () => !useConnectionStore.getState().loading,
      run: (ctx) => reconnectProfile(ctx.profileId),
    },
    {
      id: 'help.reportIssue',
      title: 'Report Issue',
      icon: Bug,
      group: 'help',
      section: 'help',
      // Prefilled new issue (version, OS, server type; CONN-14).
      run: () => reportIssue(),
    },
    {
      id: 'help.about',
      title: 'About LDAPilot',
      icon: Info,
      group: 'help',
      section: 'help',
      order: 100,
      run: () => {
        useDialogStore.getState().open(AboutDialog)
      },
      keywords: ['version', 'author'],
    },
  ]
}

/** Registers the shell commands; returns the disposer (AppLayout effect). */
export function registerShellCommands(): () => void {
  return registerCommands(shellCommands())
}

