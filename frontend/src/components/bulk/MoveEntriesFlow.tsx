/**
 * The one move flow (RW3-S-07) of "Move… / Move n Entries…" (tree, list,
 * results, Rename's "Move to Another Container…": MoveEntriesDialog) and of
 * the batch dialog's Move tab (useMoveFlow, body + footer):
 *
 * 1. Pick the target (ContainerPicker; focused).
 * 2. "Move n Entries…" runs the dry run (BatchService.BatchMovePreview:
 *    target exists and is no moved entry, each entry still exists, is not
 *    already there and its name is free in the target) and shows the plan
 *    as the confirmation: "2 will move · 1 already there · 1 will fail",
 *    one line per entry with its new DN or the reason. One entry the dry
 *    run has no objection to moves at once (no extra step).
 * 3. "Move n Entries" moves the planned ones (one entry: ModifyDN, several:
 *    BatchMove with progress); predicted failures are not sent.
 * 4. The result: moved / already there / failed; "Retry n Entries…" goes
 *    back to the picker with the failed ones. Every moved entry emits
 *    ldapilot:entry-moved; the toast names the target.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ArrowLeft, ArrowRightLeft, CheckCircle2, FolderInput, MinusCircle, RotateCcw, XCircle } from 'lucide-react'
import * as wails from '../../lib/wails'
import { BatchMove } from '../../lib/wails-recycle'
import { firstRDN, getParentDN, normalizeDN } from '../../lib/dn'
import { useConnectionStore } from '../../stores/connectionStore'
import { Dialog, useDialogContext } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { InlineAlert } from '../ui/InlineAlert'
import { Dn } from '../ui/Dn'
import { ProgressBar, Spinner } from '../ui/Spinner'
import { toast } from '../ui/Toast'
import { ContainerPicker, type TargetStatus } from '../lifecycle/ContainerPicker'
import { containerName, rememberTarget } from '../lifecycle/containerPicker'
import { emitEntryMoved } from '../lifecycle/events'
import { refreshLoadedContainers } from '../lifecycle/refresh'
import { BatchMovePreview } from './moveApi'
import { moveUndoButton } from '../tree/moveUndo'
import { moveClosesDialog, moveToastText, plannedMoves, planSummary, skipReview, type MovePlan, type MovePlanItem } from './moveModel'

type Step = 'pick' | 'checking' | 'review' | 'moving' | 'done'

interface MoveOutcome {
  moved: { dn: string; newDN: string }[]
  unchanged: number
  failed: { dn: string; message: string }[]
  /** Nothing ran (the target turned out unusable). */
  refused?: string
}

interface Progress {
  current: number
  total: number
  currentDN: string
}

const plural = (n: number) => `${n} ${n === 1 ? 'entry' : 'entries'}`
/** Title case for buttons and titles, as the menus ("Move 2 Entries…"). */
const titleCount = (n: number) => (n === 1 ? 'Entry' : `${n} Entries`)

export interface MoveFlowOptions {
  profileId: string
  dns: string[]
  /** After at least one entry moved: old and new DNs. */
  onMoved?: (moved: { dn: string; newDN: string }[]) => void
  /** Everything planned moved without a failure (`moveClosesDialog`): the host dialog closes. */
  onDone?: () => void
  /** Footer Cancel / Close. */
  onClose: () => void
}

export interface MoveFlow {
  body: ReactNode
  footer: ReactNode
  /** The picker's filter field (the dialog's initial focus). */
  pickerInput: RefObject<HTMLInputElement | null>
  /** A target was typed and nothing moved yet ("Discard changes?"). */
  dirty: boolean
  busy: boolean
  /** Enter in the dialog: the step's primary action. */
  submit: () => void
}

/** Footer Cancel that asks "Discard changes?" like Escape when a target was typed (RW1-S-05). */
function GuardedCancel({ disabled, done, onClose }: { disabled?: boolean; done: boolean; onClose: () => void }) {
  const dialog = useDialogContext()
  return (
    <Button variant="secondary" onClick={() => (done || !dialog ? onClose() : dialog.requestClose())} disabled={disabled}>
      {done ? 'Close' : 'Cancel'}
    </Button>
  )
}

export function useMoveFlow({ profileId, dns, onMoved, onDone, onClose }: MoveFlowOptions): MoveFlow {
  const [pending, setPending] = useState<string[]>(dns)
  const [target, setTarget] = useState('')
  const [status, setStatus] = useState<TargetStatus>({ dn: '', state: 'empty' })
  const [step, setStep] = useState<Step>('pick')
  const [plan, setPlan] = useState<MovePlan | null>(null)
  const [outcome, setOutcome] = useState<MoveOutcome | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pickerInput = useRef<HTMLInputElement>(null)
  const latest = useRef({ onMoved, onDone })
  latest.current = { onMoved, onDone }

  const commonParent = useMemo(() => {
    const parents = new Set(dns.map((d) => normalizeDN(getParentDN(d))))
    return parents.size === 1 ? getParentDN(dns[0]) : ''
  }, [dns])
  const to = target.trim()
  const targetReady = status.state === 'ok' && normalizeDN(status.dn) === normalizeDN(to)
  const targetName = containerName(to) || to
  const busy = step === 'checking' || step === 'moving'

  // Progress of a batch move.
  useEffect(() => {
    if (step !== 'moving') return
    const runtime = (window as unknown as { runtime?: { EventsOn?: (n: string, cb: (d: Progress) => void) => (() => void) | void } }).runtime
    const off = runtime?.EventsOn?.('batch:progress', (d) => setProgress(d))
    return () => {
      if (typeof off === 'function') off()
    }
  }, [step])

  const move = useCallback(
    async (p: MovePlan) => {
      const list = plannedMoves(p)
      if (!list.length) return
      setStep('moving')
      setProgress(null)
      setError(null)
      const moved: { dn: string; newDN: string }[] = []
      const failed: { dn: string; message: string }[] = []
      let unchanged = p.unchanged
      let refused: string | undefined
      try {
        if (list.length === 1) {
          const from = list[0]
          const rdn = firstRDN(from)
          try {
            await wails.RenameEntry(profileId, from, rdn, true, to)
            moved.push({ dn: from, newDN: `${rdn},${to}` })
          } catch (err) {
            failed.push({ dn: from, message: err instanceof Error ? err.message : String(err) })
          }
        } else {
          const res = await BatchMove(profileId, list, to)
          if (res.refused) refused = res.errors?.[0]?.message || 'The target container cannot be used.'
          moved.push(...(res.moved ?? []))
          unchanged += res.unchanged ?? 0
          for (const e of res.errors ?? []) if (e.dn) failed.push({ dn: e.dn, message: e.message })
        }
      } catch (err) {
        refused = err instanceof Error ? err.message : String(err)
      }
      // Predicted failures were not sent: they count as failed.
      for (const it of p.items) if (it.status === 'fail') failed.push({ dn: it.dn, message: it.message ?? 'predicted to fail' })

      for (const m of moved) emitEntryMoved(profileId, m.dn, m.newDN)
      if (moved.length > 0) {
        rememberTarget(profileId, to)
        refreshLoadedContainers(profileId, [...moved.map((m) => getParentDN(m.dn)), to])
        latest.current.onMoved?.(moved)
      }
      const result: MoveOutcome = { moved, unchanged, failed, refused }
      setOutcome(result)
      setPending(failed.map((f) => f.dn))
      setStep('done')
      if (moveClosesDialog({ moved: moved.length, failed: failed.length, refused })) {
        // Toasts name the object (§0.2), as the drag-and-drop move does (M-12).
        // Undo as after a drag-and-drop move: toast, bell entry and Ctrl+Z while valid (RW3-N-04).
        // Both hosts (Move… and the batch dialog's Move tab) close now; a failure keeps the result.
        toast.success(moveToastText(moved.map((m) => containerName(m.dn)), targetName, unchanged), {
          action: moveUndoButton(profileId, moved.map((m) => m.dn), to),
        })
        latest.current.onDone?.()
      } else if (!refused && moved.length > 0) {
        toast.warning(`${moved.length} of ${moved.length + failed.length} entries moved to ${targetName}, ${failed.length} failed`, failed.map((f) => `${f.dn}: ${f.message}`).join('\n'))
      }
    },
    [profileId, to, targetName],
  )

  const check = useCallback(async () => {
    if (!targetReady || !pending.length || busy) return
    setStep('checking')
    setError(null)
    try {
      const p = await BatchMovePreview(profileId, pending, to)
      setPlan(p)
      if (skipReview(p)) {
        await move(p)
        return
      }
      setStep('review')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStep('pick')
    }
  }, [targetReady, pending, busy, profileId, to, move])

  const back = () => {
    setStep('pick')
    setPlan(null)
    requestAnimationFrame(() => pickerInput.current?.focus())
  }
  const retry = () => {
    setOutcome(null)
    setPlan(null)
    setStep('pick')
    requestAnimationFrame(() => pickerInput.current?.focus())
  }

  const n = pending.length
  const submit = () => {
    if (step === 'pick') void check()
    else if (step === 'review' && plan && plan.ready > 0) void move(plan)
  }
  const done = step === 'done'
  const retryable = done && !!outcome && !outcome.refused && pending.length > 0

  const body = (
    <div className="space-y-3">
      {(step === 'pick' || step === 'checking') && (
        <>
          <p className="text-sm text-muted-foreground">
            {outcome ? `${plural(n)} could not be moved: retry into the same or another container.` : n === 1 ? 'Move the entry to another container.' : `Move ${plural(n)} to another container.`}
          </p>
          <ContainerPicker
            profileId={profileId}
            value={target}
            onChange={setTarget}
            onStatusChange={setStatus}
            moving={pending}
            revealDN={commonParent}
            inputRef={pickerInput}
            disabled={busy}
          />
          {targetReady && n > 0 && (
            <div className="text-sm text-muted-foreground" aria-live="polite">
              New DN{n > 1 ? ' (first entry)' : ''}: <Dn dn={`${firstRDN(pending[0])},${to}`} className="text-foreground" />
            </div>
          )}
          {n > 1 && <DNList title={outcome ? 'Entries to retry' : 'Entries to move'} dns={pending} />}
          {step === 'checking' && (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
              <Spinner size="sm" decorative /> Checking {plural(n)}…
            </div>
          )}
          {error && <InlineAlert tone="danger" body={error} />}
        </>
      )}

      {step === 'review' && plan && (
        <div className="space-y-2" role="status">
          {plan.refused ? (
            <InlineAlert tone="danger" title="Nothing can be moved" body={plan.reason} />
          ) : (
            <>
              <p className="text-sm text-foreground">
                Dry run for <strong>{targetName}</strong>: {planSummary(plan)}.
              </p>
              <p className="text-xs text-muted-foreground font-mono break-all">{to}</p>
              <PlanList items={plan.items} />
              {plan.failing > 0 && plan.ready > 0 && <p className="text-xs text-muted-foreground">Entries predicted to fail are not sent.</p>}
            </>
          )}
        </div>
      )}

      {step === 'moving' && (
        <div className="space-y-2" role="status">
          <div className="flex items-center justify-between text-sm text-foreground">
            <span className="flex items-center gap-1.5">
              <Spinner size="sm" decorative />
              Moving to {targetName}…
            </span>
            {progress && <span className="tabular-nums">{progress.current} / {progress.total}</span>}
          </div>
          {progress && <ProgressBar value={progress.total ? Math.round((progress.current / progress.total) * 100) : 0} label="Move progress" />}
          {progress && <div className="text-xs text-muted-foreground truncate" title={progress.currentDN}>{progress.currentDN}</div>}
        </div>
      )}

      {done && outcome && (
        <div className="space-y-2" role="status">
          <div className="text-sm font-medium text-foreground">
            {outcome.refused ? 'Nothing was moved' : outcome.failed.length === 0 ? `Moved to ${targetName}` : 'Result'}
          </div>
          {outcome.refused ? (
            <InlineAlert tone="danger" body={outcome.refused} />
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <Badge tone="success" icon={CheckCircle2}>{outcome.moved.length} moved</Badge>
              {outcome.unchanged > 0 && <Badge>{outcome.unchanged} already there</Badge>}
              {outcome.failed.length > 0 && <Badge tone="danger" icon={XCircle}>{outcome.failed.length} failed</Badge>}
            </div>
          )}
          {outcome.failed.length > 0 && (
            <ul className="max-h-32 overflow-auto space-y-0.5 border border-border rounded bg-background px-2 py-1 text-sm" aria-label="Entries not moved">
              {outcome.failed.map((f) => (
                <li key={f.dn} className="flex items-start gap-1">
                  <XCircle size={12} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-destructive" />
                  <span className="min-w-0 break-words"><span className="font-mono">{firstRDN(f.dn)}</span>: {f.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )

  const footer = (
    <>
      {step === 'review' ? (
        <Button variant="secondary" leftIcon={ArrowLeft} onClick={back}>
          Back
        </Button>
      ) : (
        <GuardedCancel disabled={busy} done={done} onClose={onClose} />
      )}
      {(step === 'pick' || step === 'checking') && (
        <Button variant="primary" leftIcon={outcome ? RotateCcw : FolderInput} loading={step === 'checking'} disabled={busy || !targetReady || n === 0} onClick={() => void check()}>
          {outcome ? `Retry ${titleCount(n)}…` : `Move ${titleCount(n)}…`}
        </Button>
      )}
      {step === 'review' && plan && !plan.refused && (
        <Button variant="primary" leftIcon={ArrowRightLeft} disabled={plan.ready === 0} onClick={() => void move(plan)}>
          {plan.ready === 0 ? 'Nothing to Move' : plan.total > 1 ? `Move ${plan.ready} ${plan.ready === 1 ? 'Entry' : 'Entries'}` : 'Move Entry'}
        </Button>
      )}
      {step === 'moving' && (
        <Button variant="primary" leftIcon={ArrowRightLeft} loading disabled>
          Moving…
        </Button>
      )}
      {retryable && (
        <Button variant="primary" leftIcon={RotateCcw} onClick={retry}>
          {`Retry ${titleCount(pending.length)}…`}
        </Button>
      )}
    </>
  )

  return { body, footer, pickerInput, dirty: to !== '' && !outcome, busy, submit }
}

function PlanList({ items }: { items: MovePlanItem[] }) {
  return (
    <ul className="max-h-[220px] overflow-auto border border-border rounded bg-background text-sm" aria-label="Dry run per entry">
      {items.map((it) => (
        <li key={it.dn} className="flex items-start gap-1.5 px-2 py-0.5 border-b border-border last:border-b-0" title={it.dn}>
          {it.status === 'move' ? (
            <ArrowRightLeft size={12} strokeWidth={1.75} aria-hidden className="mt-1 shrink-0 text-primary" />
          ) : it.status === 'unchanged' ? (
            <MinusCircle size={12} strokeWidth={1.75} aria-hidden className="mt-1 shrink-0 text-muted-foreground" />
          ) : (
            <XCircle size={12} strokeWidth={1.75} aria-hidden className="mt-1 shrink-0 text-destructive" />
          )}
          <span className="min-w-0 flex-1">
            <span className="font-mono text-foreground break-all">{firstRDN(it.dn)}</span>
            <span className={it.status === 'fail' ? 'text-destructive' : 'text-muted-foreground'}>
              {' '}
              {it.status === 'move' ? `→ ${it.newDN ?? ''}` : it.status === 'unchanged' ? '(already there)' : `: ${it.message ?? 'will fail'}`}
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function DNList({ title, dns }: { title: string; dns: string[] }) {
  return (
    <div className="max-h-[160px] overflow-auto border border-border rounded bg-background">
      <div className="px-3 py-1 text-xs font-semibold text-muted-foreground border-b border-border sticky top-0 bg-background">
        {title} ({dns.length})
      </div>
      <ul>
        {dns.map((dn) => (
          <li key={dn} className="px-3 py-0.5 text-sm text-muted-foreground truncate font-mono" title={dn}>
            {dn}
          </li>
        ))}
      </ul>
    </div>
  )
}

export interface MoveEntriesDialogProps {
  /** Connection of the entries (default: the active connection). */
  profileId?: string
  /** Entries to move. */
  dns?: string[]
  /** One entry (alternative to dns). */
  dn?: string
  onClose: () => void
  /** After at least one entry moved: old and new DNs. */
  onMoved?: (moved: { dn: string; newDN: string }[]) => void
}

/** Move… / Move n Entries… (registry entry.move, Rename's Move to Another Container…): the one move flow in a dialog. */
export function MoveEntriesDialog({ profileId: profileProp, dns: dnsProp, dn, onClose, onMoved }: MoveEntriesDialogProps) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId)
  const profileId = profileProp ?? activeProfileId ?? ''
  const [initial] = useState(() => (dnsProp && dnsProp.length ? [...dnsProp] : dn ? [dn] : []))
  const flow = useMoveFlow({ profileId, dns: initial, onMoved, onDone: onClose, onClose })
  const commonParent = useMemo(() => {
    const parents = new Set(initial.map((d) => normalizeDN(getParentDN(d))))
    return parents.size === 1 ? getParentDN(initial[0]) : ''
  }, [initial])
  const single = initial.length === 1
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !flow.busy && onClose()}
      size="md"
      icon={<FolderInput size={16} strokeWidth={1.75} aria-hidden className="text-primary" />}
      title={single ? `Move "${containerName(initial[0] ?? '')}" to…` : `Move ${initial.length} Entries to…`}
      description={commonParent ? <span>From <Dn dn={commonParent} /></span> : `${initial.length} entries from several containers`}
      dismissible={flow.busy ? 'never' : 'when-clean'}
      dirty={flow.dirty}
      initialFocus={flow.pickerInput}
      onSubmit={flow.submit}
      footer={flow.footer}
    >
      {flow.body}
    </Dialog>
  )
}
