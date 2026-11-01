/**
 * Dialog (SPEC 6.4) — the only file allowed to contain `fixed inset-0`.
 *
 * - role=dialog|alertdialog, aria-modal, aria-labelledby, aria-describedby.
 * - Focus: trapped (Tab / Shift+Tab cycle), initial focus on `initialFocus`
 *   or the first field, restored to the trigger on close (or to `returnFocus`
 *   / the trigger's region when the trigger is gone or disabled by then).
 * - Escape closes a clean dialog; a dirty one shows an inline
 *   "Discard changes? [Keep editing] [Discard]" bar instead. The bar is its
 *   own keyed subtree (no DOM node of it is reused for a footer button), and
 *   Keep editing / Escape return focus to the field that was being edited.
 * - The backdrop closes ONLY dismissible='always' (read-only) dialogs.
 * - Keydown propagation stops at the dialog root, so window shortcuts never
 *   act behind it (and the registry dispatcher checks isModalOpen).
 * - Sizes are % of the zoomed wrapper (w-dialog-*, max-h-[90%]), never vw/vh.
 * - A dialog opened from a dialog stacks at z-(--z-popover).
 * - onSubmit wraps body+footer in a <form>: Enter submits single-line
 *   fields, Ctrl+Enter submits from a textarea. The submit event stops at
 *   the dialog: a nested dialog's submit never reaches the parent's form.
 *
 * DialogHost + useDialogStore().open(Component, props) open dialogs from
 * anywhere (menus, commands) without local state.
 */
import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { create } from 'zustand'
import { TriangleAlert, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { LayerProvider, Portal, focusScopeOf, focusWhenReady, restoreFocus, useLayerContext, workAreaFocusTarget } from './layer'
import { useDismiss } from './useDismiss'
import { Button, IconButton, renderIcon, type IconType } from './Button'

const TABBABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'
const FIELD = 'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),select:not([disabled]),textarea:not([disabled])'

function visibleEls(root: HTMLElement, sel: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(sel)].filter((el) => el.getClientRects().length > 0 && !el.closest('[inert],[hidden]'))
}

let openModals = 0

/**
 * A legacy feature overlay (`fixed inset-0 … bg-overlay`, not this primitive)
 * is open. A dialog opened from one stacks at z-(--z-popover) like a nested
 * primitive: same-z legacy overlays may come later in the DOM than LayerHost
 * (or sit at z-[60]) and would cover it.
 */
function legacyOverlayOpen(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('.fixed.inset-0.bg-overlay:not([data-dialog-backdrop])')
}

interface DialogContextValue {
  /** Close, honouring the dirty guard. */
  requestClose: () => void
  titleId: string
}
const DialogContext = createContext<DialogContextValue | null>(null)
export function useDialogContext() {
  return useContext(DialogContext)
}

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl'
const SIZE: Record<DialogSize, string> = {
  sm: 'w-dialog-sm',
  md: 'w-dialog-md',
  lg: 'w-dialog-lg',
  xl: 'w-dialog-xl',
}

export interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  icon?: IconType | ReactNode
  size?: DialogSize
  /** always: Escape, X and backdrop close (read-only); when-clean: Escape/X close unless dirty; never: only explicit buttons. */
  dismissible?: 'always' | 'when-clean' | 'never'
  dirty?: boolean
  initialFocus?: RefObject<HTMLElement | null>
  /** Where focus goes on close when the trigger was removed or disabled meanwhile (default: the trigger's region). */
  returnFocus?: RefObject<HTMLElement | null>
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void
  footer?: ReactNode
  children?: ReactNode
  role?: 'dialog' | 'alertdialog'
  /** center (default) or top-aligned at 20% (palette). */
  placement?: 'center' | 'top'
  /** No header/body/footer chrome; the title is rendered visually hidden. */
  bare?: boolean
  hideClose?: boolean
  className?: string
  bodyClassName?: string
}

export function Dialog(props: DialogProps) {
  if (!props.open) return null
  return <DialogImpl {...props} />
}

function DialogImpl({
  onOpenChange,
  title,
  description,
  icon,
  size = 'md',
  dismissible = 'when-clean',
  dirty = false,
  initialFocus,
  returnFocus,
  onSubmit,
  footer,
  children,
  role = 'dialog',
  placement = 'center',
  bare,
  hideClose,
  className,
  bodyClassName,
}: Omit<DialogProps, 'open'>) {
  const panelRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const uid = useId().replace(/:/g, '')
  const titleId = `dlg${uid}-t`
  const descId = description ? `dlg${uid}-d` : undefined
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const nestedInTree = useLayerContext().inModal
  const [z] = useState(() => (nestedInTree || openModals > 0 || legacyOverlayOpen() ? 'z-(--z-popover)' : 'z-(--z-modal)'))
  const downOnBackdrop = useRef(false)
  const closing = useRef(false)
  // The trigger, captured at first render: before children with autoFocus take focus in the commit.
  const [opener] = useState(() => (typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null))
  const keepEditingRef = useRef<HTMLButtonElement>(null)
  // Element that was focused when the discard bar opened (focus goes back there on Keep editing).
  const discardReturn = useRef<HTMLElement | null>(null)
  const restoreAfterDiscard = useRef(false)
  const returnFocusRef = useRef(returnFocus)
  returnFocusRef.current = returnFocus

  const close = () => onOpenChange(false)
  const requestClose = () => {
    if (dirty) {
      if (!confirmDiscard) {
        const a = document.activeElement as HTMLElement | null
        discardReturn.current = a && panelRef.current?.contains(a) && !a.hasAttribute('data-dialog-close') ? a : null
      }
      setConfirmDiscard(true)
    } else close()
  }
  /** Leaves the discard bar and puts focus back where the user was editing. */
  const keepEditing = () => {
    restoreAfterDiscard.current = true
    setConfirmDiscard(false)
  }

  // Register on the overlay stack (Escape fallback when focus sits outside, nested-layer bookkeeping).
  useDismiss(rootRef, () => dismissible !== 'never' && requestClose(), { outside: false })

  // Initial focus + restore to the trigger.
  useLayoutEffect(() => {
    closing.current = false
    openModals++
    const active = document.activeElement as HTMLElement | null
    const prev = opener && opener !== document.body && !panelRef.current?.contains(opener) ? opener : active && !rootRef.current?.contains(active) ? active : null
    // Captured while the trigger is connected: its region takes focus if the trigger is gone on close.
    const prevScope = focusScopeOf(prev)
    const panel = panelRef.current
    if (panel) {
      const target =
        (active && panel.contains(active) ? active : null) ??
        initialFocus?.current ??
        visibleEls(panel, FIELD)[0] ??
        visibleEls(panel, TABBABLE).find((el) => !el.hasAttribute('data-dialog-close')) ??
        panel
      focusWhenReady(target, () => !panel.contains(document.activeElement) || document.activeElement === panel)
    }
    return () => {
      openModals--
      // The focus guard must not pull focus back while we hand it to the trigger.
      closing.current = true
      // The trigger may be disabled by now (Clear log empties the list) or removed:
      // then the caller's returnFocus, else the trigger's region. Resolved lazily:
      // a callback ref (SearchInput) is detached during this very commit.
      // Last resort: the work area (crumb / tree), not <body> — e.g. a trust prompt that
      // opened by itself after its trigger went away (RW2-C-03).
      const fallbackRef = returnFocusRef.current
      const fallback = () => fallbackRef?.current ?? (prevScope?.isConnected ? prevScope : null) ?? workAreaFocusTarget()
      if (prev && prev !== document.body) restoreFocus(prev, fallback)
      else restoreFocus(null, fallback)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Focus rescue: a re-render that removed the focused control (a loading state
  // swapping its footer, a button that became disabled) leaves focus on <body>
  // while this modal is open; the topmost dialog takes it back (initial target).
  useLayoutEffect(() => {
    if (closing.current) return
    const a = document.activeElement
    if (a && a !== document.body) return
    const root = rootRef.current
    const panel = panelRef.current
    if (!root || !panel) return
    const roots = document.querySelectorAll('[data-dialog-backdrop]')
    if (roots[roots.length - 1] !== root) return
    const target =
      initialFocus?.current ??
      visibleEls(panel, FIELD)[0] ??
      visibleEls(panel, TABBABLE).find((el) => !el.hasAttribute('data-dialog-close')) ??
      panel
    target.focus({ preventScroll: true })
  })

  // Focus guard: focus that lands outside (and not in an overlay opened later) is pulled back.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (closing.current) return
      const root = rootRef.current
      const t = e.target as Node | null
      if (!root || !t || root.contains(t)) return
      const host = root.parentElement
      // Overlays portaled after this dialog (menus, popovers, nested dialogs) are fine.
      if (host && host.contains(t) && root.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) return
      const panel = panelRef.current
      if (panel) (visibleEls(panel, TABBABLE)[0] ?? panel).focus({ preventScroll: true })
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [])

  useEffect(() => {
    if (confirmDiscard) {
      keepEditingRef.current?.focus()
      return
    }
    if (!restoreAfterDiscard.current) return
    restoreAfterDiscard.current = false
    const panel = panelRef.current
    if (!panel) return
    const back = discardReturn.current
    discardReturn.current = null
    const target =
      (back && back.isConnected && panel.contains(back) && !(back as HTMLButtonElement).disabled ? back : null) ??
      visibleEls(panel, FIELD)[0] ??
      visibleEls(panel, TABBABLE).find((el) => !el.hasAttribute('data-dialog-close')) ??
      panel
    target.focus({ preventScroll: true })
  }, [confirmDiscard])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault()
      if (confirmDiscard) keepEditing()
      else if (dismissible !== 'never') requestClose()
    } else if (e.key === 'Tab' && !e.defaultPrevented && panelRef.current) {
      const els = visibleEls(panelRef.current, TABBABLE)
      if (!els.length) {
        e.preventDefault()
        panelRef.current.focus()
      } else {
        const first = els[0]
        const last = els[els.length - 1]
        const a = document.activeElement
        if (e.shiftKey && (a === first || !panelRef.current.contains(a))) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && (a === last || !panelRef.current.contains(a))) {
          e.preventDefault()
          first.focus()
        }
      }
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onSubmit && formRef.current) {
      e.preventDefault()
      formRef.current.requestSubmit()
    }
    // Window shortcuts (Ctrl+B, Ctrl+W, ...) never act behind a dialog.
    e.stopPropagation()
  }

  const wrap = (content: ReactNode) =>
    onSubmit ? (
      <form
        ref={formRef}
        noValidate
        className="flex flex-col flex-1 min-h-0"
        onSubmit={(e) => {
          e.preventDefault()
          // React bubbles synthetic events along the component tree, through
          // portals: a nested dialog's submit (ConfirmDialog inside
          // PasswordDialog) must never reach the parent dialog's form.
          e.stopPropagation()
          if (!confirmDiscard) onSubmit(e)
        }}
      >
        {content}
      </form>
    ) : (
      content
    )

  return (
    <Portal>
      <LayerProvider value={{ inModal: true }}>
        <div
          ref={rootRef}
          data-dialog-backdrop=""
          className={cn('fixed inset-0 flex flex-col items-center p-4 bg-overlay', z, placement === 'center' ? 'justify-center' : 'justify-start')}
          onMouseDown={(e) => {
            downOnBackdrop.current = e.target === e.currentTarget
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && downOnBackdrop.current && dismissible === 'always') requestClose()
            downOnBackdrop.current = false
          }}
          onKeyDown={onKeyDown}
        >
          {placement === 'top' && <div aria-hidden className="h-[18%] shrink-0" />}
          <div
            ref={panelRef}
            role={role}
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descId}
            tabIndex={-1}
            className={cn(
              'relative flex flex-col min-h-0 outline-hidden',
              placement === 'top' ? 'max-h-[72%]' : 'max-h-[90%]',
              'bg-card text-card-foreground border border-border-strong/60 rounded-lg shadow-modal',
              'animate-in fade-in zoom-in-95',
              SIZE[size],
              className,
            )}
          >
            <DialogContext.Provider value={{ requestClose, titleId }}>
              {bare ? (
                <>
                  <h2 id={titleId} className="sr-only">
                    {title}
                  </h2>
                  {description && (
                    <p id={descId} className="sr-only">
                      {description}
                    </p>
                  )}
                  {children}
                </>
              ) : (
                <>
                  <DialogHeader titleId={titleId} descId={descId} title={title} description={description} icon={icon}>
                    {!hideClose && dismissible !== 'never' && (
                      <IconButton data-dialog-close="" label="Close" icon={X} size="md" onClick={requestClose} className="-mr-1 -mt-0.5" noTooltip />
                    )}
                  </DialogHeader>
                  {wrap(
                    <>
                    <DialogBody className={bodyClassName}>{children}</DialogBody>
                    {(footer || confirmDiscard) && (
                      <DialogFooter>
                        {/* Distinct keys: React must never reuse a bar button's DOM node for a
                            footer button (Enter on "Keep editing" would land on a type=submit). */}
                        {confirmDiscard ? (
                          <Fragment key="discard">
                            <p role="alert" className="flex-1 flex items-center gap-1.5 text-sm text-warning font-medium">
                              <TriangleAlert size={14} strokeWidth={1.75} aria-hidden />
                              Discard changes?
                            </p>
                            <Button
                              ref={keepEditingRef}
                              variant="secondary"
                              onClick={(e) => {
                                // Activation must not reach anything rendered in its place.
                                e.preventDefault()
                                keepEditing()
                              }}
                            >
                              Keep editing
                            </Button>
                            <Button variant="danger" onClick={close}>
                              Discard
                            </Button>
                          </Fragment>
                        ) : (
                          <Fragment key="footer">{footer}</Fragment>
                        )}
                      </DialogFooter>
                    )}
                    </>,
                  )}
                </>
              )}
            </DialogContext.Provider>
          </div>
        </div>
      </LayerProvider>
    </Portal>
  )
}

export function DialogHeader({
  title,
  description,
  icon,
  titleId,
  descId,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  icon?: IconType | ReactNode
  titleId?: string
  descId?: string
  children?: ReactNode
}) {
  return (
    <div className="flex items-start gap-3 px-4 pt-4 pb-2 shrink-0">
      {icon && <span className="mt-0.5 shrink-0">{renderIcon(icon, 16)}</span>}
      <div className="flex-1 min-w-0">
        <h2 id={titleId} className="text-lg font-semibold leading-5 text-foreground">
          {title}
        </h2>
        {description && (
          <p id={descId} className="mt-1 text-base text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  )
}

export function DialogBody({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cn('flex-1 min-h-0 overflow-auto px-4 py-2 text-base', className)}>{children}</div>
}

/** Buttons right-aligned, primary action last (Cancel, then Primary). */
export function DialogFooter({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cn('flex items-center justify-end gap-2 px-4 py-3 mt-2 border-t border-border shrink-0', className)}>{children}</div>
}

// --- DialogHost ---------------------------------------------------------------

/** Props every hosted dialog receives. */
export interface HostedDialogProps {
  onClose: () => void
}

interface HostedDialog {
  id: number
  Component: ComponentType<HostedDialogProps & Record<string, unknown>>
  props: Record<string, unknown>
}

interface DialogStore {
  dialogs: HostedDialog[]
  /** Opens `Component` with `props` (+ onClose). Returns an id for close(). */
  open: <P extends HostedDialogProps>(Component: ComponentType<P>, props?: Omit<P, 'onClose'>) => number
  close: (id: number) => void
  closeAll: () => void
}

let dialogSeq = 1

export const useDialogStore = create<DialogStore>((set) => ({
  dialogs: [],
  open: (Component, props) => {
    const id = dialogSeq++
    set((s) => ({
      dialogs: [...s.dialogs, { id, Component: Component as unknown as HostedDialog['Component'], props: (props ?? {}) as Record<string, unknown> }],
    }))
    return id
  },
  close: (id) => set((s) => ({ dialogs: s.dialogs.filter((d) => d.id !== id) })),
  closeAll: () => set({ dialogs: [] }),
}))

/** Renders dialogs opened through useDialogStore. Mount once (AppLayout). */
export function DialogHost() {
  const dialogs = useDialogStore((s) => s.dialogs)
  const close = useDialogStore((s) => s.close)
  return (
    <>
      {dialogs.map((d) => (
        <d.Component key={d.id} {...d.props} onClose={() => close(d.id)} />
      ))}
    </>
  )
}
