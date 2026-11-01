/**
 * Toasts (SPEC 6.4 / 10.2, UX-9): quiet feedback for writes and failures.
 *
 * - Bottom-right, above the status bar (RW1-E-06 / RW1-R-03: top-right they
 *   covered the editor toolbar and header buttons right under the pointer),
 *   inside the zoom wrapper (fixed positions resolve against the scaled
 *   wrapper, so the offset follows the zoom). They sit below the dialog layer
 *   (scrim and dialogs at --z-overlay/--z-modal) and below menus
 *   (--z-dropdown), so a toast never covers a dialog's buttons or an open menu.
 *   With the AI chat docked right they stay left of it (`--toast-right` =
 *   its width, set by AppLayout; N1: they covered its approval cards).
 * - Identical toasts (type, text, detail, no action) merge into one with a
 *   counter ("×3") and a fresh timer; the bell keeps one entry with the count.
 * - At most MAX_VISIBLE (3) on screen; an older one is pushed out (it stays
 *   in the notification history behind the bell).
 * - success: 3 s; info: 5 s; error: collapses into the bell after 8 s;
 *   warning (and `persistent: true`): stays until dismissed. Timers pause
 *   while the pointer moves over a toast (a pointer resting where the toast
 *   appeared does not count) or focus is inside it, and while its details
 *   are expanded.
 * - One polite live region (always mounted, so additions are announced);
 *   errors are role=alert (assertive).
 * - Optional action buttons ("Undo", "Show"; `action` or several `actions`):
 *   run and dismiss the toast. Toasts with buttons never merge.
 *
 * Every toast also lands in the notification history (NotificationLog / the
 * bell) with the connection that was active (setToastConnectionProvider);
 * only errors and warnings count as unread. Reads should not toast at all
 * (UX-9: the results strip and the status bar carry search counts).
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { create } from 'zustand'
import { Check, ChevronDown, ChevronUp, CircleAlert, CircleCheck, Copy, Info, TriangleAlert, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { IconButton } from './Button'
import { toastDuration, toastKey } from '../connection/chromeLogic'

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  /** ms on screen; 0 = until dismissed. Default by type (see DEFAULT_DURATION). */
  duration?: number;
  detail?: string;
  /** Stay until dismissed (e.g. a password stored in cleartext). */
  persistent?: boolean;
  action?: ToastAction;
  /** Several buttons, in order ("Remove Value", "Reset Password…", "Open Entry"); `action` is the same as `actions: [action]`. */
  actions?: ToastAction[];
  /** Connection the message is about (default: the active one, see setToastConnectionProvider); '' = none (app-wide). */
  connection?: string;
  /** false: an interim message ("Testing …") that does not go into the bell's history (RW1-C-08). */
  history?: boolean;
}

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  detail?: string;
  duration?: number;
  timestamp: number;
  /** The first of `actions` (kept for existing readers). */
  action?: ToastAction;
  actions?: ToastAction[];
  /** Name of the connection the message belongs to (bell). */
  connection?: string;
  /** How many identical toasts were merged into this one (≥ 1). */
  count?: number;
}

let connectionProvider: (() => string | undefined) | null = null;

/**
 * Names the connection a toast belongs to when the caller does not say
 * (connectionStore registers the active profile's name). Kept as a provider
 * so this module does not import the stores (they import it).
 */
export function setToastConnectionProvider(fn: (() => string | undefined) | null): void {
  connectionProvider = fn;
}

function currentConnection(): string | undefined {
  try {
    return connectionProvider?.() || undefined;
  } catch {
    return undefined;
  }
}

/** History entries of the same toast within this window merge in the bell. */
const HISTORY_MERGE_MS = 60_000;

/** Visible toasts at most; older ones are pushed into the bell. */
export const MAX_VISIBLE = 3;

export const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 3000,
  info: 5000,
  error: 8000,
  // Persistent: something worked but needs attention (issue #1 password warnings).
  warning: 0,
};

interface ToastState {
  toasts: Toast[];
  history: Toast[];
  addToast: (type: ToastType, message: string, options?: ToastOptions) => string;
  removeToast: (id: string) => void;
  /** Empties the history; returns what was removed (for Undo). */
  clearHistory: () => Toast[];
  /** Puts cleared entries back (Undo of Clear all), merged with newer ones. */
  restoreHistory: (entries: Toast[]) => void;
}

const keyOf = (t: Pick<Toast, 'type' | 'message' | 'detail'>) => toastKey(t.type, t.message, t.detail);

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  history: [],
  addToast: (type, message, options) => {
    const now = Date.now();
    const actions = options?.actions?.length ? options.actions : options?.action ? [options.action] : undefined;
    // A toast with a button (Undo …) stays at least 10 s (RW3-N-04).
    const duration = options?.persistent ? 0 : toastDuration(options?.duration ?? DEFAULT_DURATION[type], !!actions);
    const connection = options?.connection ?? currentConnection();
    const key = toastKey(type, message, options?.detail);
    // An identical toast on screen: count it up and restart its timer (toasts with buttons never merge).
    const same = actions ? undefined : get().toasts.find((t) => !t.actions?.length && keyOf(t) === key && t.connection === connection);
    if (same) {
      const count = (same.count ?? 1) + 1;
      set((state) => {
        const bumped: Toast = { ...same, count, timestamp: now, duration };
        const head = state.history[0];
        const history = head && head.id === same.id
          ? [{ ...head, count, timestamp: now }, ...state.history.slice(1)]
          : [bumped, ...state.history.filter((h) => h.id !== same.id)].slice(0, 200);
        return { toasts: [...state.toasts.filter((t) => t.id !== same.id), bumped], history };
      });
      return same.id;
    }
    const id = now.toString() + Math.random().toString(36).slice(2);
    const entry: Toast = { id, type, message, detail: options?.detail, duration, timestamp: now, action: actions?.[0], actions, connection: connection || undefined, count: 1 };
    set((state) => {
      const toasts = [...state.toasts, entry];
      if (options?.history === false) {
        return { toasts: toasts.length > MAX_VISIBLE ? toasts.slice(toasts.length - MAX_VISIBLE) : toasts };
      }
      // The same message again shortly after (its toast already gone): one bell entry with a count.
      const head = state.history[0];
      const history = !actions && head && !head.actions?.length && keyOf(head) === key && head.connection === connection && now - head.timestamp < HISTORY_MERGE_MS
        ? [{ ...entry, count: (head.count ?? 1) + 1 }, ...state.history.slice(1)]
        : [entry, ...state.history].slice(0, 200);
      // Keep the newest MAX_VISIBLE; the pushed-out ones stay in the history.
      return {
        toasts: toasts.length > MAX_VISIBLE ? toasts.slice(toasts.length - MAX_VISIBLE) : toasts,
        history,
      };
    });
    return id;
  },
  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },
  clearHistory: () => {
    const removed = get().history;
    set({ history: [] });
    return removed;
  },
  restoreHistory: (entries) => set((state) => {
    const have = new Set(state.history.map((h) => h.id));
    return { history: [...state.history, ...entries.filter((e) => !have.has(e.id))].sort((a, b) => b.timestamp - a.timestamp).slice(0, 200) };
  }),
}));

type MsgOptions = Omit<ToastOptions, 'detail'>;

/**
 * Convenience functions. The second argument of error/warning is the detail
 * text (kept for the existing call sites); every function takes options last
 * (success and info take the detail there).
 */
export const toast = {
  success: (msg: string, options?: ToastOptions) => useToastStore.getState().addToast('success', msg, options),
  /** Collapses into the bell after 8 s unless `persistent`. */
  error: (msg: string, detail?: string, options?: MsgOptions) => useToastStore.getState().addToast('error', msg, { ...options, detail }),
  info: (msg: string, options?: ToastOptions) => useToastStore.getState().addToast('info', msg, options),
  /** Persistent (like before): something worked, but needs attention. */
  warning: (msg: string, detail?: string, options?: MsgOptions) => useToastStore.getState().addToast('warning', msg, { ...options, detail }),
  dismiss: (id: string) => useToastStore.getState().removeToast(id),
};

const ICONS = {
  success: { Icon: CircleCheck, cls: 'text-success', bar: 'border-l-success', label: 'Success' },
  error: { Icon: CircleAlert, cls: 'text-destructive', bar: 'border-l-destructive', label: 'Error' },
  info: { Icon: Info, cls: 'text-info', bar: 'border-l-info', label: 'Info' },
  warning: { Icon: TriangleAlert, cls: 'text-warning', bar: 'border-l-warning', label: 'Warning' },
} as const;

function ToastItem({ toast: t }: { toast: Toast }) {
  const removeToast = useToastStore((s) => s.removeToast);
  const onRemove = useCallback(() => removeToast(t.id), [removeToast, t.id]);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [held, setHeld] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Remaining time survives pauses (hover, focus, expanded details).
  const remaining = useRef(t.duration ?? 0);
  const paused = held || expanded;
  const count = t.count ?? 1;

  // A merged duplicate restarts the timer.
  useEffect(() => {
    remaining.current = t.duration ?? 0;
  }, [count, t.duration]);

  useEffect(() => {
    if (!t.duration || t.duration <= 0 || paused) return;
    const started = Date.now();
    // A paused toast gets at least 2 s after the pointer / focus leaves.
    const ms = Math.max(2000, remaining.current);
    const timer = setTimeout(onRemove, ms);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, ms - (Date.now() - started));
    };
  }, [t.duration, paused, onRemove, count]);

  const handleCopy = useCallback(() => {
    const text = t.detail ? `${t.message}\n\n${t.detail}` : t.message;
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [t.message, t.detail]);

  const meta = ICONS[t.type];
  const attention = t.type === 'error' || t.type === 'warning';

  return (
    <div
      ref={rootRef}
      role={t.type === 'error' ? 'alert' : 'status'}
      aria-atomic="true"
      // Only a pointer that moves over the toast holds it: one that was resting where the
      // toast appeared (the button just clicked) must not keep it there.
      onPointerMove={(e) => {
        if (!held && (e.movementX || e.movementY)) setHeld(true);
      }}
      onPointerLeave={() => {
        if (!rootRef.current?.contains(document.activeElement)) setHeld(false);
      }}
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setHeld(false);
      }}
      className={cn(
        'pointer-events-auto flex flex-col w-[360px] max-w-full px-3 py-2 rounded-md border border-border border-l-2 shadow-popover',
        'bg-popover text-popover-foreground text-sm animate-in fade-in slide-in-from-bottom-2',
        meta.bar,
      )}
    >
      <div className="flex items-start gap-2">
        <meta.Icon size={14} strokeWidth={1.75} aria-hidden className={cn('shrink-0 mt-0.5', meta.cls)} />
        <span className="sr-only">{meta.label}:</span>
        <span className="flex-1 min-w-0 break-words">
          {t.message}
          {count > 1 && (
            <span className="ml-1.5 align-baseline text-xs font-semibold tabular-nums text-muted-foreground" aria-label={`${count} times`}>
              ×{count}
            </span>
          )}
        </span>
        <div className="flex items-center gap-0.5 shrink-0 -mr-1 -mt-0.5">
          {attention && (
            <IconButton
              label={copied ? 'Copied' : t.type === 'error' ? 'Copy error' : 'Copy warning'}
              icon={copied ? Check : Copy}
              size="sm"
              noTooltip
              onClick={handleCopy}
            />
          )}
          {t.detail && (
            <IconButton
              label={expanded ? 'Hide details' : 'Show details'}
              icon={expanded ? ChevronUp : ChevronDown}
              size="sm"
              noTooltip
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            />
          )}
          <IconButton label="Dismiss notification" icon={X} size="sm" noTooltip onClick={onRemove} />
        </div>
      </div>
      {(t.actions?.length ?? 0) > 0 && (
        <div className="flex flex-wrap justify-end gap-1 mt-1">
          {t.actions!.map((a) => (
            <button type="button"
              key={a.label}
              onClick={() => {
                onRemove();
                a.run();
              }}
              className="h-control-sm px-2 rounded text-xs font-medium text-primary hover:bg-accent focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus"
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
      {expanded && t.detail && (
        <div className="mt-1.5 pt-1.5 border-t border-border">
          <pre className="text-xs text-muted-foreground font-mono whitespace-pre-wrap break-all leading-relaxed max-h-48 overflow-auto">{t.detail}</pre>
        </div>
      )}
    </div>
  );
}

/**
 * Mount once inside the zoom wrapper (App.tsx). The live region is always
 * present so screen readers announce toasts added later.
 */
export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);

  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      aria-label="Notifications"
      // Bottom-right above the status bar, clear of the editor toolbar; under menus (--z-dropdown) and the dialog layer.
      // Left of the AI chat docked right (--toast-right, set by AppLayout; N1).
      className="fixed right-[calc(0.75rem+var(--toast-right,0px))] bottom-[calc(var(--spacing-statusbar)+8px+var(--toast-lift,0px))] z-[calc(var(--z-dropdown)-1)] flex flex-col items-end gap-2 max-w-[calc(100%-24px-var(--toast-right,0px))] pointer-events-none"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
