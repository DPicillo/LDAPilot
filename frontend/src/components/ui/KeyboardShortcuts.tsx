/**
 * Keyboard shortcuts (Help ▸ Keyboard Shortcuts, Ctrl+/). Generated from the
 * command registry (SPEC 10.2): every command with a shortcut, grouped like
 * the palette, plus the few keys that widgets handle themselves (menus,
 * context menus, Escape). Opened through DialogHost:
 *   useDialogStore.getState().open(KeyboardShortcutsDialog)
 */
import { useMemo, useState } from 'react'
import { Keyboard } from 'lucide-react'
import { Dialog } from './Dialog'
import { SearchInput } from './Input'
import { Kbd } from './Kbd'
import { EmptyState } from './EmptyState'
import { COMMAND_GROUPS, getCommandContext, getCommands, useCommandRegistryVersion, type CommandGroup } from './commands'
import { formatShortcut } from './shortcuts'

export interface ShortcutRow {
  title: string
  /** Shortcut strings ('Mod+K'); alternatives are shown with "or". */
  keys: string[]
  /** Display-only label instead of `keys` (ranges such as Ctrl+1–9). */
  label?: string
}

export interface ShortcutSection {
  id: string
  label: string
  rows: ShortcutRow[]
}

/** Keys handled by widgets (not registry commands). */
const WIDGET_ROWS: ShortcutRow[] = [
  { title: 'Focus the menu bar', keys: ['Alt'], label: 'Alt or F10' },
  { title: 'Context menu of the focused row', keys: ['Shift+F10'], label: 'Shift+F10 or Menu key' },
  { title: 'Move between rows, select with Space', keys: [], label: 'Up / Down, Space' },
  { title: 'Extend the selection', keys: [], label: 'Shift+Up / Down' },
  { title: 'Select all rows (tables)', keys: ['Mod+A'] },
  { title: 'Copy the DNs of the selected rows (tables)', keys: ['Mod+C'] },
  { title: 'Edit the value (attribute table), rename (lists)', keys: ['F2'] },
  { title: 'Open the preview / keep it open (pin) in lists', keys: [], label: `Enter / ${formatShortcut('Mod+Enter')}` },
  { title: 'Contents list of an entry tab: a click selects, Enter or a double-click opens', keys: [], label: 'Enter / double-click' },
  { title: 'Actions for the highlighted entry (palette)', keys: [], label: 'Tab' },
  { title: 'Expand all siblings (tree)', keys: [], label: '*' },
  { title: 'Go to the parent entry (Backspace in tree or list)', keys: ['Alt+Up', 'Backspace'] },
  { title: 'Edit the breadcrumb as a DN or LDAP URL (editor)', keys: ['Mod+L', 'F4'] },
  { title: 'Close a dialog, menu or the palette', keys: ['Escape'] },
]

const TAB_INDEX_ID = /^view\.tab[1-9]$/

/** The shortcut list, grouped by command group (pure on the current registry). */
export function buildShortcutSections(): ShortcutSection[] {
  const ctx = getCommandContext('palette', { selection: [] })
  const byGroup = new Map<CommandGroup, ShortcutRow[]>()
  let tabIndex = false
  for (const c of getCommands()) {
    if (!c.shortcut) continue
    if (TAB_INDEX_ID.test(c.id)) {
      tabIndex = true
      continue
    }
    let title: string
    try {
      title = typeof c.title === 'function' ? c.title(ctx) : c.title
    } catch {
      continue
    }
    const keys = Array.isArray(c.shortcut) ? c.shortcut : [c.shortcut]
    const list = byGroup.get(c.group) ?? []
    list.push({ title: title.replace(/…$/, ''), keys })
    byGroup.set(c.group, list)
  }
  if (tabIndex) {
    const list = byGroup.get('view') ?? []
    list.push({ title: 'Go to tab 1–8', keys: ['Mod+1'], label: `${formatShortcut('Mod+1').replace(/1$/, '')}1–8` })
    list.push({ title: 'Go to the last tab', keys: ['Mod+9'] })
    byGroup.set('view', list)
  }
  const sections: ShortcutSection[] = COMMAND_GROUPS.filter((g) => byGroup.has(g.id)).map((g) => ({ id: g.id, label: g.label, rows: byGroup.get(g.id)! }))
  sections.push({ id: 'widgets', label: 'Menus and lists', rows: WIDGET_ROWS })
  return sections
}

function rowText(r: ShortcutRow): string {
  return `${r.title} ${r.label ?? r.keys.map((k) => formatShortcut(k)).join(' ')}`.toLowerCase()
}

export function KeyboardShortcutsDialog({ onClose }: { onClose: () => void }) {
  const v = useCommandRegistryVersion()
  const [query, setQuery] = useState('')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sections = useMemo(() => buildShortcutSections(), [v])
  const q = query.trim().toLowerCase()
  const shown = sections
    .map((s) => ({ ...s, rows: q ? s.rows.filter((r) => rowText(r).includes(q)) : s.rows }))
    .filter((s) => s.rows.length > 0)

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Keyboard Shortcuts"
      icon={Keyboard}
      size="md"
      dismissible="always"
      bodyClassName="pt-0"
      className="h-[80%]"
    >
      <div className="sticky top-0 z-(--z-sticky) bg-card pt-1 pb-2">
        <SearchInput value={query} onValueChange={setQuery} placeholder="Filter shortcuts" aria-label="Filter shortcuts" />
      </div>
      {shown.length === 0 ? (
        <EmptyState variant="inline" title="No matching shortcut" />
      ) : (
        <div className="space-y-4 pb-2">
          {shown.map((s) => (
            <section key={s.id} aria-labelledby={`kbd-sec-${s.id}`}>
              <h3 id={`kbd-sec-${s.id}`} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                {s.label}
              </h3>
              <dl className="divide-y divide-border">
                {s.rows.map((r, i) => (
                  <div key={`${r.title}-${i}`} className="flex items-center justify-between gap-3 py-1">
                    <dt className="text-sm text-foreground min-w-0 truncate">{r.title}</dt>
                    <dd className="flex items-center gap-1 shrink-0 text-xs text-muted-foreground">
                      {r.label ? (
                        <Kbd>{r.label}</Kbd>
                      ) : (
                        r.keys.map((k, ki) => (
                          <span key={k} className="inline-flex items-center gap-1">
                            {ki > 0 && <span>or</span>}
                            <Kbd shortcut={k} />
                          </span>
                        ))
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
    </Dialog>
  )
}
