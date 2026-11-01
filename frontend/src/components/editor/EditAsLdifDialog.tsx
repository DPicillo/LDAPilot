/**
 * Edit as LDIF (DEF-14): the entry as an LDIF content record in a text
 * editor. "Review Changes" re-reads the entry and shows the dry run (the
 * rename, the one change set, conflicts, schema problems, the password
 * storage plan) without writing anything; Apply sends the ModifyDN (only if
 * the dn: line changed) and then ONE atomic ModifyEntry through
 * EditorService (read-only enforced and audited in the backend; userPassword
 * through the password storage policy and, on AD, the cleartext question).
 * The planning rules are in ldifEdit.ts.
 */
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, CircleSlash, FileCode2, FolderInput, KeyRound, TriangleAlert, Type } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { setUnsavedEdits } from '../../stores/unsavedEdits'
import { refreshOpenTabsOf } from '../../stores/editorStore'
import type { SchemaInfo, ServerType, ValidationError } from '../../types/ldap'
import type { PasswordWritePlan } from '../../types/passwordPolicy'
import type { CertificateSummary } from '../../types/binary'
import * as wails from '../../lib/wails'
import { ModifyEntryWithOptions, PlanPasswordWrite } from '../../lib/wails-pwpolicy'
import { blockingValidationErrors } from '../../lib/entryChanges'
import { classAttributes } from '../../lib/attributeGroups'
import { firstRDN, parseRDN } from '../../lib/dn'
import { cn } from '../../lib/utils'
import { targetHasPasswordValues } from '../../lib/passwordPolicy'
import { base64ToBytes, binaryKind, formatByteSize, isPKCS7SignedData } from '../../lib/binary'
import {
  lineOffset, planLDIFEdit, planSummary, schemaIndex, startLDIFEdit,
  type HiddenAttribute, type LDIFEditPlan, type LDIFEditRow, type LDIFEditSession, type SchemaIndex,
} from './ldifEdit'
import { useAdUserPasswordPrompt } from './EditEntryDialog'
import { describeCertificateCached } from './BinaryValueView'
import { binaryValueLabel } from './certificateCard'
import { errorMessage } from './useBinaryActions'
import { DialogCancelButton } from './DialogCancelButton'
import { notifyPasswordWrite, usePasswordWriteGuard } from '../password/PasswordWriteGuard'
import { emitEntryMoved } from '../lifecycle/events'
import { ensureServerType, getCommandContext, runCommand } from '../ui/commands'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Textarea } from '../ui/Input'
import { InlineAlert } from '../ui/InlineAlert'
import { Badge, type BadgeTone } from '../ui/Badge'
import { Spinner } from '../ui/Spinner'
import { Dn } from '../ui/Dn'
import { toast } from '../ui/Toast'

export interface EditAsLdifDialogProps {
  dn: string
  /** The entry's connection (default: the active one). */
  profileId?: string
  onClose: () => void
  /** After a successful apply, with the entry's DN (the new one after a rename). */
  onSaved?: (dn: string) => void
}

interface Review {
  plan: LDIFEditPlan
  validation: ValidationError[]
  password: PasswordWritePlan | null
}

const HIDDEN_TEXT: Record<HiddenAttribute['reason'], string> = {
  managed: 'maintained by the server',
  secret: 'secret values (type a line such as "userPassword: <new password>" to replace them)',
  large: 'large binary values (change them with the attribute table’s file actions)',
}

/** The entry's display name ("Anna Schmidt" for "cn=Anna Schmidt,…"). */
function entryName(dn: string): string {
  return parseRDN(firstRDN(dn)).value || dn
}

export function EditAsLdifDialog({ dn: initialDN, profileId: profileProp, onClose, onSaved }: EditAsLdifDialogProps) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId)
  const profileId = profileProp ?? activeProfileId ?? ''
  const profile = useConnectionStore((s) => s.profiles.find((p) => p.id === profileId))
  const connected = useConnectionStore((s) => s.connectionStatuses[profileId] === true)
  const readOnlyReason = profile?.readOnly ? 'The connection is read-only: review the changes, but they cannot be applied' : !connected ? 'Not connected: reconnect to apply changes' : null

  const [dn, setDN] = useState(initialDN)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [schema, setSchema] = useState<SchemaInfo | null>(null)
  const [serverType, setServerType] = useState<ServerType | null>(null)
  const [session, setSession] = useState<LDIFEditSession | null>(null)
  const [text, setText] = useState('')
  const [step, setStep] = useState<'edit' | 'review'>('edit')
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState<'review' | 'apply' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const applyRef = useRef<HTMLButtonElement>(null)
  const passwordGuard = usePasswordWriteGuard()
  const adPasswordPrompt = useAdUserPasswordPrompt()

  const index: SchemaIndex = useMemo(() => schemaIndex(schema?.attributes), [schema])
  // Certificate summaries by base64 value: comments above the base64 blocks and names in the review.
  const certInfos = useRef(new Map<string, CertificateSummary>())
  const describeBinary = useCallback((name: string, b64: string) => binaryValueLabel(name, b64, certInfos.current.get(b64)), [])

  // Load the entry, the schema and the server type once.
  useEffect(() => {
    if (!profileId) return
    let cancelled = false
    Promise.all([
      wails.GetEntry(profileId, initialDN),
      wails.GetSchema(profileId).catch(() => null),
      ensureServerType(profileId),
    ]).then(async ([e, s, t]) => {
      if (cancelled) return
      if (!e) {
        setLoadError('The entry could not be read')
        return
      }
      const sch = s?.attributes ? s : null
      await describeCertificates(e.attributes.filter((a) => a.binary).map((a) => ({ name: a.name, values: a.values })))
      if (cancelled) return
      setSchema(sch)
      setServerType(t)
      const sess = startLDIFEdit(e, { schema: schemaIndex(sch?.attributes), serverType: t, describeBinary })
      setSession(sess)
      setText(sess.text)
      requestAnimationFrame(() => {
        const el = textRef.current
        if (!el) return
        el.focus({ preventScroll: true })
        el.setSelectionRange(0, 0)
        el.scrollTop = 0
      })
    }).catch((err) => {
      if (!cancelled) setLoadError(errorMessage(err, 'The entry could not be read'))
    })
    return () => { cancelled = true }
  }, [profileId, initialDN])

  /** Reads the summaries of certificate values not described yet (failures stay unnamed). */
  async function describeCertificates(attrs: { name: string; values: readonly string[] }[]) {
    const todo = attrs
      .filter((a) => binaryKind(a.name) === 'certificate')
      .flatMap((a) => a.values)
      .filter((v) => !certInfos.current.has(v) && !isPKCS7SignedData(base64ToBytes(v, 24)))
    await Promise.all(todo.slice(0, 50).map((v) => describeCertificateCached(v).then((info) => { certInfos.current.set(v, info) }, () => {})))
  }

  // Live plan while typing (no server read): syntax problems and the change count.
  const deferredText = useDeferredValue(text)
  const live = useMemo(
    () => (session ? planLDIFEdit(session, deferredText, { schema: index, serverType, describeBinary }) : null),
    [session, deferredText, index, serverType, describeBinary],
  )
  // Unsaved input of this entry (the tab's dot, the AI write guard). Registered by hand: after an
  // apply it must be gone before the open tabs are refreshed (refreshOpenTabsOf skips dirty tabs).
  const unsavedSource = `edit-ldif:${useId()}`
  const [applied, setApplied] = useState(false)
  const dirty = !!session && !applied && text !== session.text
  useEffect(() => {
    if (!profileId || !dn || !dirty) return
    setUnsavedEdits(unsavedSource, profileId, dn, true)
    return () => setUnsavedEdits(unsavedSource, profileId, dn, false)
  }, [unsavedSource, profileId, dn, dirty])

  const nothingToDo = !!live && !live.rename && live.rows.length === 0
  const liveBlocked = !!live && live.problems.length > 0

  /** Selects a line of the text (from a problem or a change row; the review step switches back first). */
  function jumpToLine(line: number) {
    if (line <= 0) return
    if (step !== 'edit') setStep('edit')
    // Two frames: the textarea mounts again when coming from the review.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = textRef.current
      if (!el) return
      const start = lineOffset(text, line)
      const end = text.indexOf('\n', start)
      el.focus()
      el.setSelectionRange(start, end < 0 ? text.length : end)
      // Bring the line into view (16 px per line in text-sm/leading-4 mono).
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 16
      el.scrollTop = Math.max(0, (line - 3) * lineHeight)
    }))
  }

  /** The dry run: the entry as the server has it now, the plan against it, the schema check and the password plan. */
  async function startReview() {
    if (!session || !live || liveBlocked || nothingToDo || busy) return
    setBusy('review')
    setError(null)
    try {
      const fresh = await wails.GetEntry(profileId, dn)
      if (!fresh) throw new Error('The entry no longer exists')
      let plan = planLDIFEdit(session, text, { schema: index, serverType, fresh })
      // Certificates pasted into the text: named in the review too.
      const pasted = plan.changes.filter((c) => c.binary && c.operation !== 'delete').map((c) => ({ name: c.attribute, values: c.values }))
      if (pasted.some((a) => binaryKind(a.name) === 'certificate' && a.values.some((v) => !certInfos.current.has(v)))) {
        await describeCertificates(pasted)
      }
      plan = planLDIFEdit(session, text, { schema: index, serverType, fresh, describeBinary })
      let validation: ValidationError[] = []
      if (!plan.problems.length && schema) {
        try {
          const errs = await wails.ValidateEntry(profileId, plan.finalObjectClasses, plan.finalAttributes)
          const original = fresh.attributes.find((a) => a.name.toLowerCase() === 'objectclass')?.values ?? []
          const { must } = classAttributes(original, schema.objectClasses)
          validation = blockingValidationErrors(errs ?? [], {
            mustBefore: must.values(),
            originalAttrNames: fresh.attributes.map((a) => a.name),
            objectClassesChanged: plan.changes.some((c) => c.attribute.toLowerCase() === 'objectclass'),
          }).blocking
        } catch {
          // Validation unavailable: the server checks on apply.
        }
      }
      let password: PasswordWritePlan | null = null
      if (targetHasPasswordValues({ changes: plan.changes })) {
        password = await PlanPasswordWrite(profileId, { changes: plan.changes, options: {} }).catch(() => null)
      }
      setReview({ plan, validation, password })
      setStep('review')
      requestAnimationFrame(() => applyRef.current?.focus({ preventScroll: true }))
    } catch (err) {
      setError(errorMessage(err, 'The entry could not be read'))
    } finally {
      setBusy(null)
    }
  }

  const reviewBlocked = !review || review.plan.problems.length > 0 || review.validation.length > 0
  const canApply = step === 'review' && !reviewBlocked && !readOnlyReason && !busy && !!review && (!!review.plan.rename || review.plan.changes.length > 0)

  async function apply() {
    if (!canApply || !review || !session) return
    const { plan } = review
    if (plan.writesUserPassword && serverType === 'ad') {
      const answer = await adPasswordPrompt.ask()
      if (answer === 'cancel') return
      if (answer === 'reset') {
        onClose()
        runCommand('account.resetPassword', getCommandContext('editor', { selection: [{ dn, profileId }] }))
        return
      }
    }
    setBusy('apply')
    setError(null)
    let target = dn
    let renamed = false
    try {
      // Password decisions first: a cancelled one must not leave a renamed entry behind.
      const opts = plan.changes.length ? await passwordGuard.check(profileId, { changes: plan.changes }) : {}
      if (!opts) return
      if (plan.rename) {
        const r = plan.rename
        try {
          await wails.RenameEntry(profileId, dn, r.newRDN, r.deleteOldRDN, r.newSuperior)
        } catch (err) {
          setError(`${r.newSuperior ? 'Move' : 'Rename'} failed — nothing was changed: ${errorMessage(err, 'unknown error')}`)
          return
        }
        renamed = true
        target = r.newDN
        emitEntryMoved(profileId, dn, target)
        setDN(target)
        setSession({ ...session, dn: target })
      }
      if (plan.changes.length) {
        try {
          const report = await ModifyEntryWithOptions(profileId, target, plan.changes, opts)
          const n = plan.changes.length
          notifyPasswordWrite(report, `${entryName(target)} ${renamed ? 'renamed and updated' : 'updated'}${n > 1 ? ` (${n} changes)` : ''}`, { profileId, dn: target })
        } catch (err) {
          const msg = errorMessage(err, 'unknown error')
          setError(renamed
            ? `${plan.rename?.newSuperior ? 'Moved' : 'Renamed to'} ${entryName(target)}, but the attribute changes were not applied (nothing else changed): ${msg}`
            : `${msg} — nothing was changed`)
          setStep('edit')
          return
        }
      } else if (renamed) {
        toast.success(plan.rename?.newSuperior ? `${entryName(target)} moved` : `Renamed to ${entryName(target)}`)
      }
      setUnsavedEdits(unsavedSource, profileId, dn, false)
      setUnsavedEdits(unsavedSource, profileId, target, false)
      setApplied(true)
      refreshOpenTabsOf(profileId, [target])
      onSaved?.(target)
      onClose()
    } finally {
      setBusy(null)
    }
  }

  const title = <span>Edit as LDIF · <span className="font-normal">{entryName(dn)}</span></span>
  const description = <span className="flex items-center gap-1 min-w-0"><Dn dn={dn} className="truncate" />{profile && <span className="shrink-0 text-muted-foreground">· {profile.name}</span>}</span>

  const loading = !session && !loadError
  const applyLabel = review?.plan.rename
    ? review.plan.changes.length ? (review.plan.rename.newSuperior ? 'Move and Apply' : 'Rename and Apply') : review.plan.rename.newSuperior ? 'Move' : 'Rename'
    : `Apply ${review?.plan.changes.length ?? 0} Change${review?.plan.changes.length === 1 ? '' : 's'}`

  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && !busy && onClose()}
        size="xl"
        icon={<FileCode2 size={16} strokeWidth={1.75} aria-hidden className="text-primary" />}
        title={title}
        description={description}
        dismissible={busy ? 'never' : 'when-clean'}
        dirty={dirty}
        initialFocus={textRef}
        className="h-[680px]"
        bodyClassName="p-0 flex flex-col overflow-hidden border-t border-border"
        onSubmit={() => {
          if (step === 'edit') void startReview()
          else void apply()
        }}
        footer={
          step === 'edit' ? (
            <>
              <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">
                {live ? (liveBlocked ? `${live.problems.length} problem${live.problems.length === 1 ? '' : 's'}` : planSummary(live)) : ''}
              </span>
              <DialogCancelButton disabled={!!busy} />
              <Button
                type="submit"
                variant="primary"
                loading={busy === 'review'}
                disabled={!live || liveBlocked || nothingToDo}
                title={liveBlocked ? 'Fix the problems listed below the text first' : nothingToDo ? 'The text has no changes yet' : 'Read the entry again and show what Apply would send (nothing is written)'}
              >
                Review Changes…
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" leftIcon={ArrowLeft} className="mr-auto" disabled={!!busy} onClick={() => { setStep('edit'); requestAnimationFrame(() => textRef.current?.focus()) }}>
                Back to Editing
              </Button>
              <DialogCancelButton disabled={!!busy} />
              <Button ref={applyRef} type="submit" variant="primary" loading={busy === 'apply'} disabled={!canApply} title={readOnlyReason ?? undefined}>
                {applyLabel}
              </Button>
            </>
          )
        }
      >
        {loading ? (
          <div className="flex-1 flex items-center justify-center gap-2 text-muted-foreground" role="status">
            <Spinner size="md" decorative />
            <span className="text-sm">Loading entry…</span>
          </div>
        ) : loadError ? (
          <div className="p-4">
            <InlineAlert tone="danger" title="Could not load the entry" body={loadError} />
          </div>
        ) : step === 'edit' ? (
          <EditStep
            session={session!}
            text={text}
            onText={setText}
            textRef={textRef}
            plan={live}
            error={error}
            readOnlyReason={readOnlyReason}
            onJump={jumpToLine}
          />
        ) : (
          <ReviewStep review={review!} readOnlyReason={readOnlyReason} error={error} onJump={jumpToLine} />
        )}
      </Dialog>
      {passwordGuard.element}
      {adPasswordPrompt.element}
    </>
  )
}

function EditStep({ session, text, onText, textRef, plan, error, readOnlyReason, onJump }: {
  session: LDIFEditSession
  text: string
  onText: (t: string) => void
  textRef: React.RefObject<HTMLTextAreaElement | null>
  plan: LDIFEditPlan | null
  error: string | null
  readOnlyReason: string | null
  onJump: (line: number) => void
}) {
  const groups = (['secret', 'large', 'managed'] as const)
    .map((reason) => ({ reason, attrs: session.hidden.filter((h) => h.reason === reason) }))
    .filter((g) => g.attrs.length > 0)
  const problems = plan?.problems ?? []
  return (
    <>
      <div className="px-3 py-2 space-y-1 text-xs text-muted-foreground shrink-0 border-b border-border bg-card">
        <p>
          The text is the entry: change, add or remove value lines. A changed <span className="font-mono">dn:</span> line renames or moves the entry.
          Nothing is written before you review the changes.
        </p>
        {groups.length > 0 && (
          <p>
            <span className="text-foreground">Not in the text</span> (kept as they are unless you add them):{' '}
            {groups.map((g, i) => (
              <span key={g.reason}>
                {i > 0 && '; '}
                <span className="font-mono text-foreground" title={g.attrs.map((h) => `${h.name} (${h.count} value${h.count === 1 ? '' : 's'}${h.bytes ? `, ${formatByteSize(h.bytes)}` : ''})`).join('\n')}>
                  {g.attrs.slice(0, 6).map((h) => h.name).join(', ')}{g.attrs.length > 6 ? ` +${g.attrs.length - 6}` : ''}
                </span>{' '}
                — {HIDDEN_TEXT[g.reason]}
              </span>
            ))}
          </p>
        )}
      </div>
      {readOnlyReason && <InlineAlert variant="banner" tone="warning" body={readOnlyReason} />}
      {error && <InlineAlert variant="banner" tone="danger" body={error} />}
      <div className="flex-1 min-h-0 p-2">
        <Textarea
          ref={textRef}
          mono
          aria-label="LDIF of the entry"
          value={text}
          onChange={(e) => onText(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          invalid={problems.length > 0}
          className="h-full resize-none leading-4 text-xs whitespace-pre"
        />
      </div>
      {problems.length > 0 && (
        <div className="shrink-0 max-h-28 overflow-auto border-t border-border px-3 py-1.5" role="status" aria-live="polite">
          <ProblemList items={problems} tone="danger" onJump={onJump} />
        </div>
      )}
    </>
  )
}

function ProblemList({ items, tone, onJump }: { items: { line: number; message: string }[]; tone: 'danger' | 'warning'; onJump: (line: number) => void }) {
  return (
    <ul className="space-y-0.5 text-xs">
      {items.map((p, i) => (
        <li key={i} className="flex items-start gap-1.5">
          {tone === 'danger'
            ? <CircleSlash size={12} aria-hidden className="mt-0.5 shrink-0 text-destructive" />
            : <TriangleAlert size={12} aria-hidden className="mt-0.5 shrink-0 text-warning" />}
          {p.line > 0 ? (
            <button type="button" className="shrink-0 font-mono text-primary hover:underline" onClick={() => onJump(p.line)} title="Show the line">
              line {p.line}
            </button>
          ) : null}
          <span className="min-w-0">{p.message}</span>
        </li>
      ))}
    </ul>
  )
}

const KIND: Record<LDIFEditRow['kind'], { label: string; tone: BadgeTone }> = {
  add: { label: 'Add', tone: 'success' },
  delete: { label: 'Delete', tone: 'danger' },
  replace: { label: 'Replace', tone: 'warning' },
  modify: { label: 'Modify', tone: 'info' },
}

function ReviewStep({ review, readOnlyReason, error, onJump }: {
  review: Review
  readOnlyReason: string | null
  error: string | null
  onJump: (line: number) => void
}) {
  const { plan, validation, password } = review
  const blocked = plan.problems.length > 0 || validation.length > 0
  const ops = (plan.rename ? 1 : 0) + (plan.changes.length ? 1 : 0)
  const verb = plan.rename?.newSuperior ? 'move' : 'rename'
  return (
    <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
      <InlineAlert
        tone="info"
        title="Dry run — nothing has been written yet"
        body={
          ops > 1
            ? `Apply sends two operations: first the ${verb} (ModifyDN), then one modify with all attribute changes (all or none). If the modify fails, the entry stays ${verb === 'move' ? 'moved' : 'renamed'}.`
            : plan.rename
              ? `Apply sends one ModifyDN request (${verb}).`
              : `Apply sends one modify request with ${plan.changes.length === 1 ? 'this change' : `these ${plan.changes.length} changes`}: the server applies all of them or none.`
        }
      />
      {readOnlyReason && <InlineAlert tone="warning" body={readOnlyReason} />}
      {error && <InlineAlert tone="danger" body={error} />}
      {blocked && (
        <InlineAlert tone="danger" title="These changes cannot be applied">
          <ProblemList items={[...plan.problems, ...validation.map((v) => ({ line: 0, message: v.attribute ? `${v.attribute}: ${v.message}` : v.message }))]} tone="danger" onJump={onJump} />
        </InlineAlert>
      )}
      {plan.warnings.length > 0 && (
        <InlineAlert tone="warning" title={plan.conflicts.length ? `Changed on the server meanwhile: ${plan.conflicts.join(', ')}` : 'Check before applying'}>
          <ProblemList items={plan.warnings} tone="warning" onJump={onJump} />
        </InlineAlert>
      )}
      {password && (password.actions.length > 0 || password.warnings.length > 0) && (
        <InlineAlert tone={password.warnings.length ? 'warning' : 'info'} title="Password storage">
          <ul className="space-y-0.5 text-xs">
            {[...password.actions, ...password.warnings].map((a, i) => <li key={i} className="flex gap-1.5"><KeyRound size={12} aria-hidden className="mt-0.5 shrink-0" />{a}</li>)}
          </ul>
        </InlineAlert>
      )}

      {plan.rename && (
        <section aria-label="Rename" className="rounded border border-border">
          <div className="flex items-center gap-1.5 px-2 py-1 border-b border-border bg-card text-xs font-medium">
            {plan.rename.newSuperior ? <FolderInput size={12} aria-hidden /> : <Type size={12} aria-hidden />}
            {plan.rename.newSuperior ? 'Move (ModifyDN)' : 'Rename (ModifyDN)'}
            {!plan.rename.deleteOldRDN && <Badge className="ml-1">old RDN value kept</Badge>}
          </div>
          <div className="px-2 py-1.5 text-xs font-mono space-y-0.5 break-all">
            <div className="text-destructive line-through">{plan.rename.oldDN}</div>
            <div className="text-success">{plan.rename.newDN}</div>
          </div>
        </section>
      )}

      {plan.rows.length > 0 && (
        <section aria-label="Attribute changes" className="rounded border border-border">
          <div className="px-2 py-1 border-b border-border bg-card text-xs font-medium">
            {plan.rows.length} attribute{plan.rows.length === 1 ? '' : 's'} · {plan.changes.length} change{plan.changes.length === 1 ? '' : 's'} in one modify
          </div>
          <ul className="divide-y divide-border">
            {plan.rows.map((r, i) => <ChangeRow key={i} row={r} onJump={onJump} />)}
          </ul>
        </section>
      )}
    </div>
  )
}

function ChangeRow({ row, onJump }: { row: LDIFEditRow; onJump: (line: number) => void }) {
  const k = KIND[row.kind]
  return (
    <li className="grid grid-cols-[auto_minmax(7rem,12rem)_1fr] gap-x-2 px-2 py-1 text-xs items-start">
      <Badge tone={k.tone} className="mt-px justify-center min-w-14">{k.label}</Badge>
      <span className="font-mono truncate pt-0.5 flex items-center gap-1 min-w-0" title={row.attribute}>
        {row.line > 0 ? (
          <button type="button" className="truncate hover:underline text-left" onClick={() => onJump(row.line)} title={`${row.attribute} — show the line`}>{row.attribute}</button>
        ) : <span className="truncate">{row.attribute}</span>}
        {row.conflict && <TriangleAlert size={12} aria-label="Changed on the server meanwhile" className="shrink-0 text-warning" />}
      </span>
      <span className="font-mono min-w-0 space-y-0.5 pt-0.5">
        {row.removed.map((v, i) => <span key={`r${i}`} className={cn('block break-all text-destructive', !row.secret && 'line-through')}>− {v}</span>)}
        {row.added.map((v, i) => <span key={`a${i}`} className="block break-all text-success">+ {v}</span>)}
        {row.kind === 'delete' && !row.removed.length && <span className="block text-muted-foreground">all values</span>}
        {row.kept > 0 && <span className="block text-muted-foreground font-sans">{row.kept} value{row.kept === 1 ? '' : 's'} unchanged{row.binary && row.kind === 'replace' ? ' (sent again: binary values are replaced as a whole)' : ''}</span>}
        {row.secret && row.added.length > 0 && <span className="flex items-center gap-1 text-muted-foreground font-sans"><Check size={12} aria-hidden />replaces the stored value{row.removed.length ? 's' : ''}; the connection's password storage policy applies</span>}
      </span>
    </li>
  )
}
