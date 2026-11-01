/**
 * Pure helpers of the connection UI (profile lists, status bar, active
 * profile). No React, no stores: tested with node (tests/conn.*.test.ts),
 * so only type imports or `.ts` imports.
 */
import type { ConnectionProfile } from '../../types/ldap'

// --- Preselection -------------------------------------------------------------

/**
 * Row a saved-profile list (welcome screen, Explorer while disconnected)
 * preselects, so Enter connects it: the last used profile, else the active
 * one, else none (the first row would be whatever sorts first - for the
 * owner a production directory). Arrow keys select a row from there.
 */
export function preselectedProfileId(ids: readonly string[], lastUsedId: string | null | undefined, activeId: string | null | undefined): string | null {
  if (lastUsedId && ids.includes(lastUsedId)) return lastUsedId
  if (activeId && ids.includes(activeId)) return activeId
  return null
}

/**
 * Roving tab stop of the Connections list: the row focused last, else the
 * active profile, else the last used one, else the first row (a listbox needs
 * one tab stop; Enter on it connects, so it is never the alphabetically first
 * profile while a last used one exists).
 */
export function listTabStop(ids: readonly string[], focusId: string | null | undefined, activeId: string | null | undefined, lastUsedId: string | null | undefined): string | null {
  for (const id of [focusId, activeId, lastUsedId]) if (id && ids.includes(id)) return id
  return ids[0] ?? null
}

// --- Type-ahead (WAI-ARIA listbox) ---------------------------------------------

export interface TypeAheadState {
  buf: string
  t: number
}

/** Keys typed within this many ms form one search string. */
export const TYPEAHEAD_MS = 600

/**
 * Feeds a key into the type-ahead buffer. Space continues a running search
 * ("UX-C DS" types a blank); outside a burst it is not consumed (it selects
 * the row, as before). Returns the new state and whether the key was used.
 */
export function typeAheadKey(state: TypeAheadState, key: string, now: number, timeout = TYPEAHEAD_MS): { state: TypeAheadState; consumed: boolean } {
  if (key.length !== 1) return { state, consumed: false }
  const burst = now - state.t <= timeout && state.buf.length > 0
  if (key === ' ' && !burst) return { state, consumed: false }
  const buf = burst ? state.buf + key.toLowerCase() : key.toLowerCase()
  return { state: { buf, t: now }, consumed: true }
}

/**
 * Index of the next name starting with buf. A one-letter search starts after
 * the current row (repeated "o" cycles through the "o…" names); a longer one
 * may stay on the current row.
 */
export function typeAheadMatch(names: readonly string[], buf: string, current: number): number {
  if (!buf || names.length === 0) return -1
  const start = buf.length === 1 ? current + 1 : Math.max(current, 0)
  for (let k = 0; k < names.length; k++) {
    const i = (((start + k) % names.length) + names.length) % names.length
    if (names[i].toLowerCase().startsWith(buf)) return i
  }
  return -1
}

/** Row to focus after removing `removedId` from `ids` (next row, else the previous one, else none). */
export function focusAfterRemoval(ids: readonly string[], removedId: string): string | null {
  const i = ids.indexOf(removedId)
  if (i < 0) return ids[0] ?? null
  return ids[i + 1] ?? ids[i - 1] ?? null
}

/**
 * Row to focus after removing several rows (DEF-02): the first remaining row
 * after the last removed one, else the last remaining row before the first
 * removed one, else none.
 */
export function focusAfterRemovals(ids: readonly string[], removed: Iterable<string>): string | null {
  const gone = new Set(removed)
  const idx = ids.map((id, i) => (gone.has(id) ? i : -1)).filter((i) => i >= 0)
  if (idx.length === 0) return ids[0] ?? null
  const last = idx[idx.length - 1]
  for (let i = last + 1; i < ids.length; i++) if (!gone.has(ids[i])) return ids[i]
  for (let i = idx[0] - 1; i >= 0; i--) if (!gone.has(ids[i])) return ids[i]
  return ids.find((id) => !gone.has(id)) ?? null
}

// --- Multi-selection (DEF-02) -------------------------------------------------------

/** Ctrl+Click / Ctrl+Space: the selection with `id` added or removed. */
export function toggleInSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** Shift+Click / Shift+Arrow: the rows from the anchor to `target` (list order), or just the target without a usable anchor. */
export function rangeSelection(ids: readonly string[], anchor: string | null | undefined, target: string): Set<string> {
  const a = anchor ? ids.indexOf(anchor) : -1
  const b = ids.indexOf(target)
  if (b < 0) return new Set()
  if (a < 0) return new Set([target])
  const [from, to] = a <= b ? [a, b] : [b, a]
  return new Set(ids.slice(from, to + 1))
}

/**
 * The profiles a row action applies to: the whole multi-selection when the
 * row is part of it (and more than one row is selected), else that row.
 */
export function actionTargets(ids: readonly string[], selected: ReadonlySet<string>, rowId: string): string[] {
  if (selected.size > 1 && selected.has(rowId)) return ids.filter((id) => selected.has(id))
  return [rowId]
}

/** The selection after the list changed: ids that no longer exist are dropped. */
export function pruneSelection(selected: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  const known = new Set(ids)
  const next = new Set([...selected].filter((id) => known.has(id)))
  return next.size === selected.size ? (selected as Set<string>) : next
}

/** Names for a confirmation listing several profiles: at most `max`, then "… and n more". */
export function listedNames(names: readonly string[], max = 8): string[] {
  const shown = names.slice(0, max).map((n) => n || 'Unnamed')
  if (names.length > max) shown.push(`… and ${names.length - max} more`)
  return shown
}

// --- Status bar ----------------------------------------------------------------

/**
 * Text of the status bar's connection switcher when the active profile is
 * not connected. Other open connections are counted, so "No connection"
 * never shows while connections are open.
 */
export function idleSwitcherLabel(activeName: string | null | undefined, openCount: number): string {
  const open = openCount > 0 ? ` · ${openCount} open` : ''
  if (activeName) return `${activeName} – not connected${open}`
  return openCount > 0 ? `No active connection${open}` : 'No connection · Connect…'
}

/** Base DN label of the status bar: an empty base DN browses every naming context. */
export function baseDnLabel(baseDN: string | undefined): string {
  return baseDN?.trim() ? baseDN.trim() : 'all naming contexts'
}

/**
 * Tree selection summary for the status bar: what the count refers to,
 * "12 children of Users · 1 selected" (the anchor's loaded children, else its
 * siblings = the parent's children).
 */
export function selectionSummaryText(selected: number, count: number | null, ofName: string | null): string {
  const sel = `${selected} selected`
  if (count === null) return sel
  const what = `${count} ${count === 1 ? 'child' : 'children'}`
  return ofName ? `${what} of ${ofName} · ${sel}` : `${what} · ${sel}`
}

// --- Active profile (CONN-20) --------------------------------------------------

/**
 * Profile to activate when connections are open but none is active (after a
 * page reload, or after the active one was disconnected): the last active
 * one (the user's explicit choice) if it is connected, else the profile of
 * the active editor tab if connected (RW1-C-12: a preview tab of another
 * connection no longer wins), else the first connected profile in list
 * order. null when nothing should change.
 */
export function profileToActivate(input: {
  activeProfileId: string | null
  profiles: readonly Pick<ConnectionProfile, 'id'>[]
  statuses: Readonly<Record<string, boolean>>
  activeTabProfileId?: string | null
  lastActiveId?: string | null
}): string | null {
  const { activeProfileId, profiles, statuses } = input
  if (activeProfileId) return null
  const connected = (id: string | null | undefined): id is string => !!id && statuses[id] === true && profiles.some((p) => p.id === id)
  if (connected(input.lastActiveId)) return input.lastActiveId
  if (connected(input.activeTabProfileId)) return input.activeTabProfileId
  return profiles.find((p) => statuses[p.id] === true)?.id ?? null
}

// --- Connect error (RW1-C-01) ---------------------------------------------------

/**
 * A connect error split for a narrow panel: `summary` is the sentence an
 * admin acts on (the bind hint Go appends after " — ", else the last part of
 * the error chain: "connection refused", "i/o timeout"), `detail` the full
 * server text, or null when it says nothing more than the summary.
 */
export function splitConnectError(message: string): { summary: string; detail: string | null } {
  const msg = (message || '').trim()
  if (!msg) return { summary: 'Connection failed', detail: null }
  // A certificate problem is said by its kind, the x509 text is the detail (RW2-C-05: "Cannot
  // validate certificate for 127.0.0.1 because it doesn't contain any IP SANs" next to
  // "Server certificate changed").
  if (/untrusted TLS certificate/i.test(msg)) {
    return { summary: /\bpinn?ed\b/i.test(msg) ? 'The server certificate changed: review it' : 'The server certificate is not trusted: review it', detail: msg }
  }
  const dash = msg.lastIndexOf(' — ')
  let summary: string
  if (dash > 0) summary = msg.slice(dash + 3).trim()
  else {
    // "LDAP Result Code 200 \"Network Error\": dial tcp …: connect: connection refused"
    const parts = msg.split(/:\s+/).map((p) => p.trim()).filter(Boolean)
    summary = parts[parts.length - 1] ?? msg
    // A bare code or a quoted fragment says nothing: keep the whole message.
    if (summary.length < 6 || /^["'(\d]/.test(summary)) summary = msg
  }
  summary = summary.charAt(0).toUpperCase() + summary.slice(1)
  if (summary.length > 160) summary = summary.slice(0, 157).trimEnd() + '…'
  const detail = summary.toLowerCase() === msg.toLowerCase() ? null : msg
  return { summary, detail }
}

// --- Password prompt -----------------------------------------------------------

/** True when connecting the profile sends a password and none is stored (imported profiles): ask for it first. */
export function needsPasswordPrompt(p: Pick<ConnectionProfile, 'authMethod' | 'bindDN' | 'hasPassword' | 'krbCredSource'>): boolean {
  if (p.hasPassword) return false
  switch (p.authMethod) {
    case 'simple':
      return !!p.bindDN.trim()
    case 'ntlm':
      return true
    case 'kerberos':
      return p.krbCredSource !== 'system'
    default:
      return false
  }
}

// --- Import / export messages --------------------------------------------------

export interface ImportSummary {
  tone: 'success' | 'info' | 'warning'
  message: string
  detail?: string
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Message for an import report (every case, including an empty file). */
export function importSummary(r: { total: number; imported: string[]; duplicates: string[]; skipped: { name: string; reason: string }[]; needPassword: string[]; askPassword?: string[] }): ImportSummary {
  const lines: string[] = []
  if (r.duplicates.length) lines.push(`Already saved (same host, port, bind DN and base DN), skipped: ${r.duplicates.join(', ')}`)
  for (const s of r.skipped) lines.push(`Not imported: ${s.name} - ${s.reason}`)
  if (r.needPassword.length) lines.push(`Asks for the password on the first connect: ${r.needPassword.join(', ')}`)
  if (r.askPassword?.length) lines.push(`Asks for the password on every connect: ${r.askPassword.join(', ')}`)
  const detail = lines.length ? lines.join('\n') : undefined
  if (r.total === 0) return { tone: 'info', message: 'The file contains no connection profiles' }
  const n = r.imported.length
  const extra = [r.duplicates.length && `${r.duplicates.length} already saved`, r.skipped.length && `${r.skipped.length} skipped`].filter(Boolean).join(', ')
  if (n === 0) return { tone: r.skipped.length ? 'warning' : 'info', message: `No connections imported${extra ? ` (${extra})` : ''}`, detail }
  return { tone: r.skipped.length ? 'warning' : 'success', message: `${plural(n, 'connection')} imported${extra ? ` (${extra})` : ''}`, detail }
}

/**
 * The export checklist's initial choice (DEF-06): the Connections list's
 * multi-selection when it has more than one profile, else every profile.
 */
export function initialExportChoice(ids: readonly string[], preselected?: readonly string[] | null): Set<string> {
  const known = (preselected ?? []).filter((id) => ids.includes(id))
  return new Set(known.length > 1 ? known : ids)
}

/** Message after an export ('' path = cancelled → no message). */
export function exportSummary(r: { path: string; count: number }): string | null {
  if (!r.path) return null
  return `${plural(r.count, 'connection')} exported to ${r.path}`
}
