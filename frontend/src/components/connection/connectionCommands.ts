/**
 * Handlers this batch gives to shell commands (registered by AppLayout after
 * the core, shell and feature sets, so they win): File ▸ Import / Export
 * Connections… (messages for every outcome, silent Cancel), File ▸ Exit
 * (quit guard) and Help ▸ Report Issue (prefilled new issue); plus the
 * "Edit…" action of failed connect toasts (setConnectionEditor). The command
 * definitions (titles, menus, palette) stay in layout/shellCommands.ts; new
 * here are connection.edit ("Edit Connection…") and connection.test ("Test
 * Connection") for the active profile.
 */
import { FlaskConical, Pencil } from 'lucide-react'
import { registerCommandHandlers, registerCommands } from '../ui/commands'
import { exportConnectionProfiles, importConnectionProfiles } from './connectionTransfer'
import { requestQuit } from './QuitGuard'
import { reportIssue } from './diagnostics'
import { editConnection } from './ConnectionDialog'
import { setConnectionEditor, useConnectionStore } from '../../stores/connectionStore'
import { testSavedConnection } from './testSavedConnection'

const profileName = (id: string | null | undefined) => useConnectionStore.getState().profiles.find((p) => p.id === id)?.name

export function registerConnectionCommands(): () => void {
  // "Edit…" on a failed connect toast (the store cannot import the dialog).
  setConnectionEditor((id, section) => editConnection(id, section))
  const off = registerCommandHandlers({
    'connection.importProfiles': () => importConnectionProfiles(),
    'connection.exportProfiles': () => exportConnectionProfiles(),
    'app.exit': () => requestQuit(),
    'help.reportIssue': () => reportIssue(),
  })
  // Edit / Test of the active connection (palette; the status bar and the
  // Connections list offer them per profile).
  const offDefs = registerCommands([
    {
      id: 'connection.edit',
      title: (ctx) => (profileName(ctx.profileId) ? `Edit Connection "${profileName(ctx.profileId)}"…` : 'Edit Connection…'),
      icon: Pencil,
      group: 'connection',
      section: 'connection',
      order: 30,
      when: (ctx) => !!ctx.profileId,
      run: (ctx) => {
        if (ctx.profileId) editConnection(ctx.profileId)
      },
      keywords: ['settings', 'profile', 'properties', 'tls', 'password'],
    },
    {
      id: 'connection.test',
      title: 'Test Connection',
      icon: FlaskConical,
      group: 'connection',
      section: 'connection',
      order: 31,
      when: (ctx) => !!ctx.profileId,
      run: (ctx) => {
        if (ctx.profileId) void testSavedConnection(ctx.profileId)
      },
      keywords: ['check', 'bind', 'verify'],
    },
  ])
  return () => {
    offDefs()
    off()
    setConnectionEditor(null)
  }
}
