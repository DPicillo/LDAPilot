/**
 * The sidebar panels: ONE name and ONE shortcut per panel for the View menu,
 * the palette, the activity bar tooltip and the panel header (Sidebar's
 * PANEL_NAMES use the same names). Pure (tests/cmd.panels.test.ts).
 */
import type { Activity } from '../../types/ui'

export interface PanelDef {
  activity: Activity
  /** Registry command id (View menu, palette). */
  command: string
  label: string
  shortcut: string
  keywords?: string[]
}

export const PANELS: PanelDef[] = [
  { activity: 'connections', command: 'view.connections', label: 'Connections', shortcut: 'Mod+Shift+C', keywords: ['profiles', 'servers'] },
  { activity: 'explorer', command: 'view.explorer', label: 'Explorer', shortcut: 'Mod+Shift+E', keywords: ['tree', 'browse'] },
  { activity: 'search', command: 'view.search', label: 'Search', shortcut: 'Mod+Shift+F', keywords: ['find', 'filter', 'ldap search'] },
  { activity: 'reports', command: 'view.reports', label: 'Reports', shortcut: 'Mod+Shift+R', keywords: ['locked', 'disabled', 'expired', 'account report'] },
  { activity: 'bookmarks', command: 'view.bookmarks', label: 'Bookmarks', shortcut: 'Mod+Shift+B', keywords: ['favorites', 'star'] },
  { activity: 'schema', command: 'view.schema', label: 'Schema', shortcut: 'Mod+Shift+S', keywords: ['schema browser', 'object classes', 'attribute types'] },
  { activity: 'export', command: 'view.transfer', label: 'Import / Export', shortcut: 'Mod+Shift+L', keywords: ['ldif', 'csv', 'transfer'] },
  { activity: 'ai', command: 'view.ai', label: 'AI Chat', shortcut: 'Mod+Shift+A', keywords: ['assistant', 'chat'] },
]

export function panelDef(activity: Activity): PanelDef | undefined {
  return PANELS.find((p) => p.activity === activity)
}

/** Panel shortcuts must not collide with each other or with the other app shortcuts (normalized, case-insensitive). */
export function shortcutCollisions(shortcuts: readonly string[]): string[] {
  const seen = new Map<string, number>()
  for (const s of shortcuts) {
    const k = s
      .split('+')
      .map((p) => p.trim().toLowerCase())
      .map((p) => (p === 'ctrl' ? 'mod' : p))
      .sort()
      .join('+')
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k)
}
