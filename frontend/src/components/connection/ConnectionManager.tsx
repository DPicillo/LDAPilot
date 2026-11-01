/**
 * Connections panel (SPEC 7.4, UX-18): PanelHeader, the saved profiles as
 * compact rows in a listbox (roving focus, type-ahead incl. blanks). Enter or
 * double-click connects (connectProfile: the same connecting state as the
 * status bar and the Explorer), F2 edits, Del deletes after a ConfirmDialog
 * (focus then moves to the next row), Shift+F10 / the context menu has every
 * action. A failed connect is shown with the profile's name, Edit… and
 * Retry, and marks the row. Dialogs open through DialogHost.
 *
 * Multi-selection (DEF-02, aria-multiselectable): Ctrl+Click / Ctrl+Space
 * toggle a row, Shift+Click / Shift+Arrow select a range, Ctrl+A all, Escape
 * goes back to the active row. With several rows selected, Del, the context
 * menu and the selection bar delete (one confirmation listing the names) or
 * export them; focus then moves to the row after the deleted ones.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { CopyPlus, FileInput, FileOutput, FlaskConical, Pencil, Plug, Plus, RefreshCw, RotateCw, Trash2, Unplug, X } from 'lucide-react'
import { ensureProfilesLoaded, useConnectionStore } from '../../stores/connectionStore'
import type { ConnectionProfile } from '../../types/ldap'
import { PanelHeader, type PanelAction } from '../ui/PanelHeader'
import { EmptyState } from '../ui/EmptyState'
import { InlineAlert } from '../ui/InlineAlert'
import { DisclosureButton } from '../ui/Disclosure'
import { Button, IconButton } from '../ui/Button'
import { Toolbar, type ToolbarItem } from '../ui/Toolbar'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { useDialogStore } from '../ui/Dialog'
import { ContextMenu, MenuItem, MenuSeparator, MenuHeader, contextMenuPoint } from '../ui/Menu'
import { domId } from '../ui/dnParse'
import { useShellState } from '../layout/shellState'
import { connectAndBrowse } from './connectFlow'
import { focusWorkAreaSoon } from '../editor/editorFocus'
import { ConnectionCard } from './ConnectionCard'
import { cloneConnection, openConnectionDialog } from './ConnectionDialog'
import { exportConnectionProfiles, importConnectionProfiles } from './connectionTransfer'
import { testSavedConnection } from './testSavedConnection'
import {
  actionTargets, focusAfterRemoval, focusAfterRemovals, listTabStop, listedNames, pruneSelection, rangeSelection, splitConnectError, toggleInSelection,
  typeAheadKey, typeAheadMatch,
} from './profileLogic'
import { editSectionForError } from '../../lib/connectionAuth'

/** Hosted delete confirmation (DialogHost passes onClose). */
function DeleteProfileDialog({ profile, onClose, onDeleted }: { profile: ConnectionProfile; onClose: () => void; onDeleted?: () => void }) {
  return (
    <ConfirmDialog
      tone="danger"
      title="Delete connection?"
      message={
        <>
          The connection profile <span className="font-medium">{profile.name || 'Unnamed'}</span> and its stored password are removed. The
          directory itself is not changed.
        </>
      }
      detail={`${profile.host}:${profile.port}${profile.baseDN ? ` · ${profile.baseDN}` : ''}`}
      confirmLabel="Delete"
      onConfirm={() => {
        onClose()
        void useConnectionStore.getState().deleteProfile(profile.id).then(() => onDeleted?.())
      }}
      onCancel={onClose}
    />
  )
}

/** Hosted confirmation for deleting several profiles at once (DEF-02). */
function DeleteProfilesDialog({ profiles, onClose, onDeleted }: { profiles: ConnectionProfile[]; onClose: () => void; onDeleted?: (ids: string[]) => void }) {
  const statuses = useConnectionStore((s) => s.connectionStatuses)
  const open = profiles.filter((p) => statuses[p.id] === true).length
  const n = profiles.length
  return (
    <ConfirmDialog
      tone="danger"
      title={`Delete ${n} connections?`}
      message={
        <>
          These {n} connection profiles and their stored passwords are removed.
          {open > 0 && <> {open === 1 ? 'One of them is connected and is' : `${open} of them are connected and are`} disconnected first.</>} The
          directories themselves are not changed.
        </>
      }
      detail={listedNames(profiles.map((p) => `${p.name || 'Unnamed'} (${p.host}:${p.port})`))}
      confirmLabel={`Delete ${n} Connections`}
      onConfirm={() => {
        onClose()
        void useConnectionStore.getState().deleteProfiles(profiles.map((p) => p.id)).then((ids) => onDeleted?.(ids))
      }}
      onCancel={onClose}
    />
  )
}

/**
 * The connect error in the narrow sidebar (RW1-C-01): the sentence to act on,
 * clamped to three lines, and the raw server text behind "Show details".
 */
function ConnectErrorText({ message }: { message: string }) {
  const [open, setOpen] = useState(false)
  const { summary, detail } = splitConnectError(message)
  const id = `conn-err-${useId().replace(/:/g, '')}`
  return (
    <div className="min-w-0">
      <p className="break-words line-clamp-3 select-text" title={detail ?? undefined}>
        {summary}
      </p>
      {detail && (
        <>
          <DisclosureButton open={open} onToggle={() => setOpen((v) => !v)} controls={id} className="text-xs min-h-0 mt-0.5">
            {open ? 'Hide details' : 'Show details'}
          </DisclosureButton>
          <p id={id} hidden={!open} className="mt-0.5 max-h-32 overflow-auto break-words text-xs text-muted-foreground font-mono select-text">
            {detail}
          </p>
        </>
      )}
    </div>
  )
}

export function ConnectionManager() {
  const profiles = useConnectionStore((s) => s.profiles)
  const activeProfileId = useConnectionStore((s) => s.activeProfileId)
  const connectionStatuses = useConnectionStore((s) => s.connectionStatuses)
  const error = useConnectionStore((s) => s.error)
  const errorProfileId = useConnectionStore((s) => s.errorProfileId)
  const connectErrors = useConnectionStore((s) => s.connectErrors)
  const connectingId = useShellState((s) => s.connectingId)
  const lastUsedId = useShellState((s) => s.lastUsedProfileId)
  const { reloadProfiles, disconnect, setActiveProfile, clearError } = useConnectionStore.getState()

  const [focusId, setFocusId] = useState<string | null>(null)
  const [listFocused, setListFocused] = useState(false)
  const [menu, setMenu] = useState<{ point: { clientX: number; clientY: number }; profile: ConnectionProfile } | null>(null)
  // Multi-selection (DEF-02): empty = just the active row; `anchor` is where Shift ranges start.
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const anchor = useRef<string | null>(null)
  const rowEls = useRef(new Map<string, HTMLDivElement>())
  const typeahead = useRef({ buf: '', t: 0 })

  // Loaded once at start-up (also by the status bar, whichever panel is shown first).
  useEffect(() => ensureProfilesLoaded(), [])

  const ids = useMemo(() => profiles.map((p) => p.id), [profiles])
  // Deleted / reloaded profiles leave the selection.
  useEffect(() => {
    setPicked((cur) => pruneSelection(cur, ids))
  }, [ids])
  const selected: Set<string> = picked.size > 0 ? picked : new Set(activeProfileId && ids.includes(activeProfileId) ? [activeProfileId] : [])
  const multi = selected.size > 1

  const tabStop = listTabStop(ids, focusId, activeProfileId, lastUsedId)
  const optionId = (id: string) => `conn-${domId(id)}`

  const openDialog = (profile?: ConnectionProfile) => openConnectionDialog(profile)
  const cloneProfile = (profile: ConnectionProfile) => cloneConnection(profile)
  const focusRow = (id: string) => {
    setFocusId(id)
    const el = rowEls.current.get(id)
    el?.focus()
    el?.scrollIntoView({ block: 'nearest' })
  }
  /** Focus a row once the list re-rendered (after a dialog returned focus to its trigger). */
  const focusRowSoon = (id: string | null) => {
    if (!id) return
    setFocusId(id)
    requestAnimationFrame(() => requestAnimationFrame(() => focusRow(id)))
  }
  const deleteProfile = (profile: ConnectionProfile) => {
    const targets = actionTargets(ids, selected, profile.id)
    if (targets.length > 1) {
      deleteProfiles(targets)
      return
    }
    const next = focusAfterRemoval(ids, profile.id)
    useDialogStore.getState().open(DeleteProfileDialog, { profile, onDeleted: () => focusRowSoon(next) })
  }
  /** Several profiles: one confirmation listing them; focus goes to the row after them (DEF-02). */
  const deleteProfiles = (targetIds: string[]) => {
    const list = profiles.filter((p) => targetIds.includes(p.id))
    if (list.length === 0) return
    if (list.length === 1) {
      const next = focusAfterRemoval(ids, list[0].id)
      useDialogStore.getState().open(DeleteProfileDialog, { profile: list[0], onDeleted: () => focusRowSoon(next) })
      return
    }
    const next = focusAfterRemovals(ids, targetIds)
    useDialogStore.getState().open(DeleteProfilesDialog, {
      profiles: list,
      onDeleted: () => {
        setPicked(new Set())
        anchor.current = null
        focusRowSoon(next)
      },
    })
  }
  const exportSelection = () => void exportConnectionProfiles(multi ? ids.filter((id) => selected.has(id)) : undefined)
  const clearSelection = () => {
    setPicked(new Set())
    anchor.current = activeProfileId
  }
  /** Click on a row: plain = select + activate (as before), Ctrl = toggle, Shift = range. */
  const selectRow = (e: MouseEvent, profile: ConnectionProfile) => {
    if (e.shiftKey) {
      setPicked(rangeSelection(ids, anchor.current ?? activeProfileId, profile.id))
      return
    }
    if (e.ctrlKey || e.metaKey) {
      setPicked(toggleInSelection(selected, profile.id))
      anchor.current = profile.id
      return
    }
    setPicked(new Set())
    anchor.current = profile.id
    setActiveProfile(profile.id)
  }
  // Like Create and Connect: the Explorer replaces this list, so focus the first tree row (RW1-C-05).
  const connect = (id: string) => void connectAndBrowse(id)
  const errorProfile = errorProfileId ? profiles.find((p) => p.id === errorProfileId) : undefined
  const dismissError = () => {
    const id = errorProfileId
    clearError()
    focusRowSoon(id && profiles.some((p) => p.id === id) ? id : tabStop)
  }

  const onRowKeyDown = (e: KeyboardEvent<HTMLDivElement>, profile: ConnectionProfile) => {
    const i = profiles.findIndex((p) => p.id === profile.id)
    const ctrl = e.ctrlKey || e.metaKey
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault()
      openMenu(contextMenuPoint({ target: e.currentTarget }), profile)
      return
    }
    // Multi-selection keys (DEF-02).
    if (ctrl && !e.altKey && !e.shiftKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault()
      e.stopPropagation()
      setPicked(new Set(ids))
      return
    }
    if (ctrl && !e.altKey && e.key === ' ') {
      e.preventDefault()
      setPicked(toggleInSelection(selected, profile.id))
      anchor.current = profile.id
      return
    }
    if (e.shiftKey && !ctrl && !e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      const n = e.key === 'ArrowDown' ? Math.min(profiles.length - 1, i + 1) : Math.max(0, i - 1)
      // A range starts at the anchor while the focused row belongs to the selection, else at the focused row.
      if (!anchor.current || !ids.includes(anchor.current) || !selected.has(profile.id)) anchor.current = profile.id
      setPicked(rangeSelection(ids, anchor.current, profiles[n].id))
      focusRow(profiles[n].id)
      return
    }
    if (e.key === 'Escape' && multi && !ctrl && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      clearSelection()
      return
    }
    if (ctrl || e.altKey) return
    let n: number | null = null
    switch (e.key) {
      case 'ArrowDown': n = Math.min(profiles.length - 1, i + 1); break
      case 'ArrowUp': n = Math.max(0, i - 1); break
      case 'Home': n = 0; break
      case 'End': n = profiles.length - 1; break
      case 'Enter':
        e.preventDefault()
        connect(profile.id)
        return
      case 'F2':
        e.preventDefault()
        openDialog(profile)
        return
      case 'Delete':
        e.preventDefault()
        deleteProfile(profile)
        return
    }
    if (n !== null) {
      e.preventDefault()
      focusRow(profiles[n].id)
      return
    }
    // Type-ahead (a blank inside a burst is part of the name: "UX-C DS").
    const ta = typeAheadKey(typeahead.current, e.key, Date.now())
    if (ta.consumed) {
      e.preventDefault()
      typeahead.current = ta.state
      const hit = typeAheadMatch(profiles.map((p) => p.name || ''), ta.state.buf, i)
      if (hit >= 0) focusRow(profiles[hit].id)
      return
    }
    if (e.key === ' ') {
      e.preventDefault()
      setPicked(new Set())
      anchor.current = profile.id
      setActiveProfile(profile.id)
    }
  }
  /** The context menu acts on the multi-selection when the row is part of it, else on the row alone. */
  const openMenu = (point: { clientX: number; clientY: number }, profile: ConnectionProfile) => {
    if (multi && !selected.has(profile.id)) setPicked(new Set())
    setMenu({ point, profile })
  }

  const actions: PanelAction[] = [
    { id: 'new', label: 'New Connection…', icon: Plus, onClick: () => openDialog() },
    { id: 'refresh', label: 'Reload Profiles', icon: RefreshCw, onClick: () => void reloadProfiles() },
    { id: 'import', label: 'Import Connections…', icon: FileInput, onClick: () => void importConnectionProfiles() },
    { id: 'export', label: 'Export Connections…', icon: FileOutput, onClick: exportSelection, disabled: profiles.length === 0 },
  ]

  const menuProfile = menu?.profile
  const menuConnected = menuProfile ? connectionStatuses[menuProfile.id] === true : false
  const menuTargets = menuProfile ? actionTargets(ids, selected, menuProfile.id) : []
  const selectionItems: ToolbarItem[] = [
    { id: 'export', label: `Export ${selected.size} Connections…`, icon: FileOutput, onClick: exportSelection },
    { id: 'delete', label: `Delete ${selected.size} Connections…`, icon: Trash2, danger: true, separator: true, onClick: () => deleteProfiles(ids.filter((id) => selected.has(id))) },
  ]

  return (
    <div className="h-full flex flex-col bg-sidebar min-w-0">
      <PanelHeader title="Connections" icon={Plug} actions={actions} />

      {error && (
        <div className="px-3 pt-2 shrink-0">
          <InlineAlert
            tone="danger"
            title={errorProfile ? `Could not connect to ${errorProfile.name || 'Unnamed'}` : undefined}
            body={<ConnectErrorText message={error} />}
            actionsBelow
            actions={
              errorProfile ? (
                <>
                  <Button size="sm" variant="secondary" leftIcon={Pencil} onClick={() => openConnectionDialog(errorProfile, { initialSection: editSectionForError(error) })}>
                    Edit…
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={RotateCw}
                    disabled={!!connectingId}
                    data-connect-retry=""
                    // A failed retry hands focus back to Retry, a successful one to the tree (RW2-C-03).
                    onClick={() => void connectAndBrowse(errorProfile.id).finally(() => focusWorkAreaSoon(() => document.querySelector<HTMLElement>('[data-connect-retry]')))}
                  >
                    Retry
                  </Button>
                </>
              ) : undefined
            }
            onDismiss={dismissError}
          />
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto p-2">
        {profiles.length === 0 ? (
          <EmptyState
            icon={Plug}
            title="No connections yet"
            hint="Create a connection profile for an LDAP server or Active Directory domain controller."
            action={
              <Button variant="primary" size="sm" leftIcon={Plus} onClick={() => openDialog()} data-panel-autofocus="">
                New Connection…
              </Button>
            }
          />
        ) : (
          <div
            role="listbox"
            aria-label="Saved connections"
            aria-multiselectable="true"
            className="flex flex-col gap-0.5"
            onFocus={() => setListFocused(true)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setListFocused(false)
            }}
          >
            {profiles.map((profile) => (
              <ConnectionCard
                key={profile.id}
                id={optionId(profile.id)}
                rowRef={(el) => {
                  if (el) rowEls.current.set(profile.id, el)
                  else rowEls.current.delete(profile.id)
                }}
                profile={profile}
                isConnected={connectionStatuses[profile.id] === true}
                isActive={activeProfileId === profile.id}
                isSelected={selected.has(profile.id)}
                isConnecting={connectingId === profile.id}
                connectError={connectErrors[profile.id]}
                tabStop={tabStop === profile.id}
                listFocused={listFocused}
                onConnect={() => connect(profile.id)}
                onDisconnect={() => void disconnect(profile.id)}
                onEdit={() => openDialog(profile)}
                onDelete={() => deleteProfile(profile)}
                onClone={() => cloneProfile(profile)}
                onSelect={(e) => selectRow(e, profile)}
                onFocus={() => setFocusId(profile.id)}
                onContextMenu={(e) => openMenu({ clientX: e.clientX, clientY: e.clientY }, profile)}
                onKeyDown={(e) => onRowKeyDown(e, profile)}
              />
            ))}
          </div>
        )}
      </div>

      {multi && (
        <div className="flex items-center gap-2 pl-3 pr-1 h-panel-header border-t border-border bg-card shrink-0 min-w-0">
          <span className="text-xs text-muted-foreground tabular-nums shrink-0" role="status">
            {selected.size} selected
          </span>
          <Toolbar
            aria-label="Selection actions"
            items={selectionItems}
            className="flex-1"
            end={<IconButton label="Clear selection" shortcut="Escape" icon={X} size="md" onClick={() => { clearSelection(); focusRowSoon(focusId ?? activeProfileId) }} />}
          />
        </div>
      )}

      <ContextMenu point={menu?.point ?? null} onClose={() => setMenu(null)} label="Connection actions" minWidth={200}>
        {() =>
          menuProfile && menuTargets.length > 1 ? (
            <>
              <MenuHeader>{`${menuTargets.length} connections`}</MenuHeader>
              <MenuItem icon={FileOutput} label={`Export ${menuTargets.length} Connections…`} onSelect={() => void exportConnectionProfiles(menuTargets)} />
              <MenuItem icon={X} label="Clear Selection" shortcut="Escape" onSelect={clearSelection} />
              <MenuSeparator />
              <MenuItem icon={Trash2} label={`Delete ${menuTargets.length} Connections…`} shortcut="Delete" tone="danger" onSelect={() => deleteProfiles(menuTargets)} />
            </>
          ) : menuProfile ? (
            <>
              <MenuHeader>{menuProfile.name || 'Unnamed'}</MenuHeader>
              {menuConnected ? (
                <MenuItem icon={Unplug} label="Disconnect" onSelect={() => void disconnect(menuProfile.id)} />
              ) : (
                <MenuItem icon={Plug} label="Connect" shortcut="Enter" default disabled={!!connectingId} onSelect={() => connect(menuProfile.id)} />
              )}
              <MenuItem icon={FlaskConical} label="Test Connection" onSelect={() => void testSavedConnection(menuProfile.id)} />
              <MenuSeparator />
              <MenuItem icon={Pencil} label="Edit…" shortcut="F2" onSelect={() => openDialog(menuProfile)} />
              <MenuItem icon={CopyPlus} label="Clone…" onSelect={() => cloneProfile(menuProfile)} />
              <MenuSeparator />
              <MenuItem icon={Trash2} label="Delete…" shortcut="Delete" tone="danger" onSelect={() => deleteProfile(menuProfile)} />
            </>
          ) : null
        }
      </ContextMenu>
    </div>
  )
}
