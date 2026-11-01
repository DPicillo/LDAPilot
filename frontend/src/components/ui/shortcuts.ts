/**
 * Shortcut strings: 'Mod+K', 'Ctrl+Shift+P', 'Shift+Alt+C', 'F2', 'Del',
 * 'Alt+Up', 'Mod+='. `Mod` is Ctrl on Windows/Linux and Cmd on macOS.
 * Display order is Ctrl, Shift, Alt, Meta ("Shift+Alt+C", SPEC 9).
 */

export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '')

export interface ParsedShortcut {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  /** Normalized key: lower-case letter/digit, or a KeyboardEvent.key name in lower case. */
  key: string
}

const KEY_ALIASES: Record<string, string> = {
  del: 'delete',
  esc: 'escape',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  pgup: 'pageup',
  pgdn: 'pagedown',
  space: ' ',
  spacebar: ' ',
  plus: '+',
  return: 'enter',
  apps: 'contextmenu',
}

const MOD_RE = /^(mod|ctrl|control|shift|alt|option|meta|cmd|command)$/i

export function parseShortcut(s: string): ParsedShortcut {
  const parts: string[] = []
  // Split on '+', but a trailing '+' (or "++") is the plus key.
  let rest = s.trim()
  while (rest.length) {
    const i = rest.indexOf('+', 1)
    if (i < 0) {
      parts.push(rest)
      break
    }
    parts.push(rest.slice(0, i))
    rest = rest.slice(i + 1)
  }
  const out: ParsedShortcut = { ctrl: false, shift: false, alt: false, meta: false, key: '' }
  for (const p of parts) {
    if (MOD_RE.test(p)) {
      const m = p.toLowerCase()
      if (m === 'mod') {
        if (IS_MAC) out.meta = true
        else out.ctrl = true
      } else if (m === 'ctrl' || m === 'control') out.ctrl = true
      else if (m === 'shift') out.shift = true
      else if (m === 'alt' || m === 'option') out.alt = true
      else out.meta = true
    } else {
      const k = p.toLowerCase()
      out.key = KEY_ALIASES[k] ?? k
    }
  }
  return out
}

/** Normalized key of a keyboard event; layout-independent for letters and digits. */
export function eventKey(e: KeyboardEvent | { key: string; code?: string }): string {
  const code = e.code ?? ''
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6)
  const k = (normalizedKey(e.key, code) ?? e.key ?? '').toLowerCase()
  return k === 'spacebar' ? ' ' : k
}

/** Named keys by their physical code, for events whose `key` the engine left "Unidentified". */
const CODE_KEYS: Record<string, string> = {
  Tab: 'Tab', Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Escape', Space: ' ', Backspace: 'Backspace', Delete: 'Delete',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', ContextMenu: 'ContextMenu',
}

/**
 * The `key` an event should have had, or null when it is fine. WebKitGTK
 * (the Linux webview) reports Shift+Tab — X keysym ISO_Left_Tab — as
 * `key: "Unidentified"` with `code: "Tab"`, so Ctrl+Shift+Tab (Previous
 * Tab), the dialogs' Shift+Tab focus trap and the palette's Shift+Tab never
 * saw a Tab (DEF-26 recheck in the native window). Pure.
 */
export function normalizedKey(key: string | undefined, code: string | undefined): string | null {
  if (key && key !== 'Unidentified') return null
  if (!code) return null
  if (CODE_KEYS[code]) return CODE_KEYS[code]
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return null
}

/**
 * Gives keyboard events with an "Unidentified" named key their key
 * (normalizedKey) before any handler sees them: one capture listener on the
 * window (runs before React's root listeners), so every `e.key === 'Tab'`
 * check works in WebKitGTK too. Installed once by main.tsx; returns the
 * disposer.
 */
export function installKeyNormalization(target: Window = window): () => void {
  const fix = (e: KeyboardEvent) => {
    const k = normalizedKey(e.key, e.code)
    if (!k) return
    try {
      Object.defineProperty(e, 'key', { value: k, configurable: true })
    } catch {
      /* a read-only event: the handlers see the original key */
    }
  }
  target.addEventListener('keydown', fix, true)
  target.addEventListener('keyup', fix, true)
  return () => {
    target.removeEventListener('keydown', fix, true)
    target.removeEventListener('keyup', fix, true)
  }
}

export function matchShortcut(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
  shortcut: string | ParsedShortcut,
): boolean {
  const s = typeof shortcut === 'string' ? parseShortcut(shortcut) : shortcut
  if (e.ctrlKey !== s.ctrl || e.altKey !== s.alt || e.metaKey !== s.meta) return false
  const k = eventKey(e)
  // '=' and '+' share a key; '?' is Shift+'/'.
  if (s.key === '=' || s.key === '+') return (k === '=' || k === '+' || e.key === '=' || e.key === '+') && (s.shift ? e.shiftKey : true)
  // Other symbols ('/', '?', '-') sit on different keys and need different
  // modifiers per layout (German '/' = Shift+7): match the typed character
  // and ignore Shift.
  if (s.key.length === 1 && !/[a-z0-9 ]/.test(s.key)) return e.key === s.key
  if (e.shiftKey !== s.shift) return false
  return k === s.key
}

const DISPLAY_KEYS: Record<string, string> = {
  delete: 'Del',
  escape: 'Esc',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  ' ': 'Space',
  enter: 'Enter',
  backspace: 'Backspace',
  tab: 'Tab',
  contextmenu: 'Menu',
  home: 'Home',
  end: 'End',
}
const MAC_KEYS: Record<string, string> = { arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', enter: '↩', backspace: '⌫', delete: '⌦', escape: '⎋' }

function displayKey(k: string): string {
  if (IS_MAC && MAC_KEYS[k]) return MAC_KEYS[k]
  if (DISPLAY_KEYS[k]) return DISPLAY_KEYS[k]
  if (/^f\d{1,2}$/.test(k)) return k.toUpperCase()
  return k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1)
}

/** Individual key labels, platform-aware: ['Ctrl','K'] or ['⌘','K']. */
export function shortcutParts(s: string): string[] {
  const p = parseShortcut(s)
  const parts: string[] = []
  if (IS_MAC) {
    if (p.ctrl) parts.push('⌃')
    if (p.alt) parts.push('⌥')
    if (p.shift) parts.push('⇧')
    if (p.meta) parts.push('⌘')
  } else {
    if (p.ctrl) parts.push('Ctrl')
    if (p.shift) parts.push('Shift')
    if (p.alt) parts.push('Alt')
    if (p.meta) parts.push('Win')
  }
  parts.push(displayKey(p.key))
  return parts
}

/** 'Mod+K' -> 'Ctrl+K' (Windows/Linux) or '⌘K' (macOS). */
export function formatShortcut(s: string | string[] | undefined): string {
  if (!s) return ''
  const first = Array.isArray(s) ? s[0] : s
  if (!first) return ''
  return shortcutParts(first).join(IS_MAC ? '' : '+')
}

/** True if the shortcut has no Ctrl/Alt/Meta (F2, Del, Enter, Backspace, '/'). */
export function isPlainKey(s: string | ParsedShortcut): boolean {
  const p = typeof s === 'string' ? parseShortcut(s) : s
  return !p.ctrl && !p.alt && !p.meta
}

/**
 * Keys a text field needs for itself: plain keys (typing, F2, Del), caret and
 * word movement (Alt/Ctrl+arrows, Home/End, PgUp/PgDn) and word deletion
 * (Ctrl+Backspace/Del). In an editable target these never run a command
 * (Alt+Left in an input moves the caret, it does not navigate back).
 */
export function isTextEditingShortcut(s: string | ParsedShortcut): boolean {
  const p = typeof s === 'string' ? parseShortcut(s) : s
  if (!p.ctrl && !p.alt && !p.meta) return true
  return /^(arrow|home$|end$|page|backspace$|delete$)/.test(p.key)
}

/**
 * Shortcuts the registry never runs while a text field has focus: the text
 * editing keys (isTextEditingShortcut) plus Ctrl+D (bookmark) and Ctrl+N
 * (new entry), which would act on a selection the user does not look at
 * while typing (a Ctrl+D in the search box removed a bookmark), and
 * Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, the field's own undo / redo (the app's
 * Undo of a move runs outside fields only, RW3-N-04). Ctrl+W, Ctrl+K,
 * Ctrl+B and the other app shortcuts still work in fields.
 */
export function blocksInEditable(s: string | ParsedShortcut): boolean {
  const p = typeof s === 'string' ? parseShortcut(s) : s
  if (isTextEditingShortcut(p)) return true
  if ((p.ctrl || p.meta) && !p.alt && (p.key === 'z' || p.key === 'y')) return true
  return (p.ctrl || p.meta) && !p.alt && !p.shift && (p.key === 'd' || p.key === 'n')
}

/** True for inputs, textareas, selects and contenteditable regions. */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type)
  }
  return false
}

/** F5 without Alt: the web view's reload key, which the app always blocks (it is the registry's Refresh). */
export function isReloadKey(e: { key: string; altKey?: boolean }): boolean {
  return e.key === 'F5' && !e.altKey
}

/**
 * Whether the registry dispatcher ignores a keydown. `reloadGuarded`: the
 * capture-phase reload guard called preventDefault() on this very event (F5),
 * which must not count as "handled elsewhere" — otherwise F5 never reaches
 * the registry's Refresh (CMD-03). Any other prevented event, Escape, IME
 * composition and bare modifier keys are skipped.
 */
export function dispatcherSkips(
  e: { key: string; defaultPrevented: boolean; isComposing?: boolean },
  reloadGuarded = false,
): boolean {
  if (e.defaultPrevented && !reloadGuarded) return true
  if (e.key === 'Escape' || e.isComposing) return true
  return ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)
}
