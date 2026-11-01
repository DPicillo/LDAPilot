/**
 * Pure helpers of the app chrome owned with the connections (zoom steps,
 * toast merging and unread counting, the quit guard, About diagnostics).
 * No React, no stores: tested with node (tests/conn.*.test.ts).
 */

// --- Zoom ------------------------------------------------------------------------

/** Zoom levels of View ▸ Zoom and the status bar menu; Ctrl+= / Ctrl+- step through them. */
export const ZOOM_PRESETS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const

/**
 * Next preset above (dir 1) or below (dir -1) `level`. A level between two
 * presets (an older 120 %) goes to the neighbouring preset; at either end it
 * stays.
 */
export function stepZoom(level: number, dir: 1 | -1, presets: readonly number[] = ZOOM_PRESETS): number {
  const eps = 0.001
  if (dir > 0) return presets.find((p) => p > level + eps) ?? presets[presets.length - 1]
  for (let i = presets.length - 1; i >= 0; i--) if (presets[i] < level - eps) return presets[i]
  return presets[0]
}

// --- Toasts -----------------------------------------------------------------------

export type NoticeType = 'success' | 'error' | 'info' | 'warning'

/** Identical toasts (type, text, detail) merge into one with a counter. */
export function toastKey(type: NoticeType, message: string, detail?: string): string {
  return `${type}\n${message}\n${detail ?? ''}`
}

/** Toasts with a button (Undo, Review, Reset Password…) stay at least this long (RW3-N-04). */
export const ACTION_TOAST_MIN_MS = 10_000

/**
 * How long a toast stays: 0 = until dismissed. A toast with an action is
 * never gone before ACTION_TOAST_MIN_MS — "Moved … · Undo" with the 3 s of a
 * plain success toast was often gone before the user reached for Undo.
 */
export function toastDuration(base: number, hasAction: boolean): number {
  if (base <= 0) return 0
  return hasAction ? Math.max(base, ACTION_TOAST_MIN_MS) : base
}

/** Only errors and warnings ask for attention; success and info land in the history as read. */
export function countsAsUnread(type: NoticeType): boolean {
  return type === 'error' || type === 'warning'
}

/** Unread entries of the notification history: errors and warnings newer than lastSeen. */
export function unreadEntries<T extends { type: NoticeType; timestamp: number }>(history: readonly T[], lastSeen: number): T[] {
  return history.filter((h) => h.timestamp > lastSeen && countsAsUnread(h.type))
}

// --- Quit guard ---------------------------------------------------------------------

export interface QuitBusyState {
  /** Bulk modify / batch dialog open (bulkDialogStore.batch). */
  batchDialog: boolean
  /** LDIF import / change file dialog open (bulkDialogStore.importLDIF). */
  ldifDialog: boolean
  /** Recursive deletes still running (recycle:delete-progress without phase "done"). */
  runningDeletes: number
  /** Labels of editor tabs with unsaved edits. */
  dirtyTabs: string[]
}

/** Why closing the window now would lose work; empty = quit at once. */
export function quitBusyReasons(s: QuitBusyState): string[] {
  const out: string[] = []
  if (s.runningDeletes > 0) out.push(s.runningDeletes === 1 ? 'A recursive delete is running.' : `${s.runningDeletes} recursive deletes are running.`)
  if (s.batchDialog) out.push('The batch operations dialog is open (a bulk run may be in progress).')
  if (s.ldifDialog) out.push('The LDIF import dialog is open (an import may be in progress).')
  if (s.dirtyTabs.length === 1) out.push(`"${s.dirtyTabs[0]}" has unsaved changes.`)
  else if (s.dirtyTabs.length > 1) out.push(`${s.dirtyTabs.length} tabs have unsaved changes: ${s.dirtyTabs.slice(0, 5).join(', ')}${s.dirtyTabs.length > 5 ? ', …' : ''}.`)
  return out
}

/**
 * A recursive delete that sent no progress event for this long counts as
 * ended: a run that fails before it starts deleting (the subtree cannot be
 * listed) never sends phase "done".
 */
export const DELETE_PROGRESS_STALE_MS = 120_000

/**
 * Running recursive deletes by operation id (time of the last
 * recycle:delete-progress event); phase "done" removes the run.
 */
export function trackDeleteProgress(running: ReadonlyMap<string, number>, ev: { operationId?: string; phase?: string } | null | undefined, now: number): Map<string, number> {
  const next = new Map(running)
  if (!ev?.operationId) return next
  if (ev.phase === 'done') next.delete(ev.operationId)
  else next.set(ev.operationId, now)
  return next
}

/** Recursive deletes still running at `now` (a run without events for DELETE_PROGRESS_STALE_MS has ended). */
export function runningDeleteCount(running: ReadonlyMap<string, number>, now: number, staleMs = DELETE_PROGRESS_STALE_MS): number {
  let n = 0
  for (const t of running.values()) if (now - t < staleMs) n++
  return n
}

// --- About / Report Issue ---------------------------------------------------------------

export const REPO_URL = 'https://github.com/DPicillo/LDAPilot'
export const ISSUES_URL = 'https://github.com/DPicillo/LDAPilot/issues'

export interface DiagnosticsInput {
  version: string
  commit?: string
  buildDate?: string
  modified?: boolean
  goVersion?: string
  wailsVersion?: string
  webView?: string
  userAgent?: string
  os?: string
  arch?: string
  configDir?: string
  /** Detected type of the active connection's server (ad, openldap, 389ds, other). */
  serverType?: string | null
}

const SERVER_TYPE_NAMES: Record<string, string> = { ad: 'Active Directory', openldap: 'OpenLDAP', '389ds': '389 Directory Server', other: 'other LDAP server' }

/**
 * Version line: "v0.5.0 (abc1234, 2026-10-31, modified)"; an unstamped build
 * (no ldflags: `wails dev`, a plain `wails build`) reports the declared
 * release + "-dev" and reads "v0.5.0 development build" (RW1-C-04;
 * scripts/build.sh stamps version, commit and date).
 */
export function versionLine(d: Pick<DiagnosticsInput, 'version' | 'commit' | 'buildDate' | 'modified'>): string {
  const parts = [d.commit, d.buildDate ? d.buildDate.slice(0, 10) : '', d.modified ? 'modified' : ''].filter(Boolean)
  const dev = d.version?.match(/^(.+)-dev$/)
  const version = !d.version || d.version === 'dev' ? 'development build' : dev ? `${dev[1]} development build` : d.version
  return `${version}${parts.length ? ` (${parts.join(', ')})` : ''}`
}

/**
 * A path without the OS user name (RW1-C-11: diagnostics end up in public
 * GitHub issues): the home directory becomes "~" (Linux / macOS) or
 * %APPDATA% / %LOCALAPPDATA% / %USERPROFILE% (Windows); any other location
 * keeps only its last two parts ("…/config/LDAPilot").
 */
export function redactUserPath(path: string | undefined): string | undefined {
  if (!path) return path
  const p = path.trim()
  const win = p.match(/^[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\]+(\\.*)?$/i)
  if (win) {
    const rest = win[1] ?? ''
    const roaming = rest.match(/^\\AppData\\Roaming(\\.*)?$/i)
    if (roaming) return `%APPDATA%${roaming[1] ?? ''}`
    const local = rest.match(/^\\AppData\\Local(\\.*)?$/i)
    if (local) return `%LOCALAPPDATA%${local[1] ?? ''}`
    return `%USERPROFILE%${rest}`
  }
  const unix = p.match(/^(?:\/home\/[^/]+|\/Users\/[^/]+|\/root|\/var\/home\/[^/]+)(\/.*)?$/)
  if (unix) return `~${unix[1] ?? ''}`
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/'
  const parts = p.split(sep).filter(Boolean)
  return parts.length <= 2 ? p : `…${sep}${parts.slice(-2).join(sep)}`
}

/** Plain-text diagnostics for "Copy diagnostics" and bug reports (no secrets, no host names). */
export function diagnosticsText(d: DiagnosticsInput): string {
  const lines = [
    `LDAPilot ${versionLine(d)}`,
    d.goVersion && `Go: ${d.goVersion}`,
    d.wailsVersion && `Wails: ${d.wailsVersion}`,
    (d.webView || d.userAgent) && `Web view: ${[d.webView, d.userAgent].filter(Boolean).join(' · ')}`,
    d.os && `OS: ${d.os}${d.arch ? ` ${d.arch}` : ''}`,
    d.configDir && `Config: ${redactUserPath(d.configDir)}`,
    d.serverType !== undefined && `Active server: ${d.serverType ? SERVER_TYPE_NAMES[d.serverType] ?? d.serverType : 'none'}`,
  ]
  return lines.filter(Boolean).join('\n')
}

/** GitHub "new issue" URL with the diagnostics prefilled. */
export function newIssueURL(issuesURL: string, d: DiagnosticsInput): string {
  const body = `**What happened?**\n\n\n**Steps to reproduce**\n1. \n\n**Environment**\n\`\`\`\n${diagnosticsText(d)}\n\`\`\`\n`
  return `${issuesURL.replace(/\/+$/, '')}/new?body=${encodeURIComponent(body)}`
}

// --- Shell view after a reload (cross-area note C via N) ------------------------------

/** Side bar activities (types/ui Activity) that can be restored. */
export const SHELL_ACTIVITIES = ['connections', 'explorer', 'search', 'export', 'schema', 'bookmarks', 'ai', 'reports'] as const
export type ShellActivity = (typeof SHELL_ACTIVITIES)[number]
/** Bottom panel tabs (uiStore BottomTab). */
export const SHELL_BOTTOM_TABS = ['search-results', 'output', 'audit'] as const
export type ShellBottomTab = (typeof SHELL_BOTTOM_TABS)[number]

/** What is remembered of the shell across a WebView reload / restart (localStorage SHELL_VIEW_KEY). */
export interface ShellView {
  activity: ShellActivity
  bottomVisible: boolean
  bottomTab: ShellBottomTab
}

export const SHELL_VIEW_KEY = 'ldapilot-shell-view'
export const DEFAULT_SHELL_VIEW: ShellView = { activity: 'connections', bottomVisible: false, bottomTab: 'search-results' }

/**
 * The remembered side bar activity and bottom panel state, validated:
 * unknown values fall back to the defaults (Connections, panel hidden), and
 * the AI activity is not restored while the chat is docked right (its side
 * bar slot is empty then: the Explorer instead, like uiStore.setAIDock).
 */
export function parseShellView(raw: string | null | undefined, aiDock: 'sidebar' | 'right'): ShellView {
  let v: Partial<Record<keyof ShellView, unknown>> = {}
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') v = parsed as typeof v
  } catch {
    /* bad JSON: defaults */
  }
  let activity = (SHELL_ACTIVITIES as readonly unknown[]).includes(v.activity) ? (v.activity as ShellActivity) : DEFAULT_SHELL_VIEW.activity
  if (activity === 'ai' && aiDock === 'right') activity = 'explorer'
  return {
    activity,
    bottomVisible: typeof v.bottomVisible === 'boolean' ? v.bottomVisible : DEFAULT_SHELL_VIEW.bottomVisible,
    bottomTab: (SHELL_BOTTOM_TABS as readonly unknown[]).includes(v.bottomTab) ? (v.bottomTab as ShellBottomTab) : DEFAULT_SHELL_VIEW.bottomTab,
  }
}

/** The JSON stored for a shell view. */
export function serializeShellView(v: ShellView): string {
  return JSON.stringify({ activity: v.activity, bottomVisible: v.bottomVisible, bottomTab: v.bottomTab })
}
