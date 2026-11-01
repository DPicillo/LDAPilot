/**
 * Which value? (DEF-13) — when an entry has several photos (thumbnailPhoto,
 * jpegPhoto values) or several certificates, Save / Replace / Remove ask
 * instead of silently taking the first value. Each choice shows what it is:
 * the picture with its size, or the certificate's name, validity, purpose
 * and expiry. `chooseBinaryValue` resolves at once when there is only one.
 */
import { useEffect, useRef, useState } from 'react'
import { FileBadge, ImageIcon, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { imageDataUrl, isPKCS7SignedData, base64ToBytes, certValidity, commonName } from '../../lib/binary'
import type { CertificateSummary } from '../../types/binary'
import { Dialog, useDialogStore } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { DialogCancelButton } from './DialogCancelButton'
import { describeCertificateCached } from './BinaryValueView'
import { certExpiryNote, certPurpose, certWhen, choiceMeta, choiceTitle, type BinaryChoice } from './certificateCard'

export interface BinaryValuePickerProps {
  /** "Save which photo?" */
  title: string
  /** Primary button: "Save…", "Replace…", "Remove". */
  verb: string
  choices: BinaryChoice[]
  /** Preselected choice (default: the first). */
  initial?: number
  danger?: boolean
  onPick: (choice: BinaryChoice) => void
  onCancel: () => void
  onClose: () => void
}

/**
 * Asks which value when there are several; resolves with the only one at
 * once, with null when cancelled or there is none.
 */
export function chooseBinaryValue(opts: { title: string; verb: string; choices: BinaryChoice[]; initial?: number; danger?: boolean }): Promise<BinaryChoice | null> {
  if (opts.choices.length <= 1) return Promise.resolve(opts.choices[0] ?? null)
  return new Promise((resolve) => {
    let settled = false
    const settle = (c: BinaryChoice | null) => {
      if (settled) return
      settled = true
      resolve(c)
    }
    useDialogStore.getState().open(BinaryValuePicker, { ...opts, onPick: (c: BinaryChoice) => settle(c), onCancel: () => settle(null) })
  })
}

export function BinaryValuePicker({ title, verb, choices, initial = 0, danger, onPick, onCancel, onClose }: BinaryValuePickerProps) {
  const [selected, setSelected] = useState(Math.min(Math.max(initial, 0), choices.length - 1))
  const listRef = useRef<HTMLDivElement>(null)

  function pick(i = selected) {
    const c = choices[i]
    if (!c) return
    onPick(c)
    onClose()
  }
  function cancel() {
    onCancel()
    onClose()
  }

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && cancel()}
      size="md"
      title={title}
      description={`${choices.length} values — choose one`}
      dismissible="always"
      initialFocus={listRef}
      onSubmit={() => pick()}
      footer={
        <>
          <DialogCancelButton />
          <Button type="submit" variant={danger ? 'danger' : 'primary'}>{verb}</Button>
        </>
      }
    >
      <div
        ref={listRef}
        role="listbox"
        aria-label={title}
        aria-activedescendant={`binpick-${selected}`}
        tabIndex={0}
        className="max-h-[380px] overflow-auto rounded border border-border focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((i) => Math.min(i + 1, choices.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((i) => Math.max(i - 1, 0)) }
          else if (e.key === 'Home') { e.preventDefault(); setSelected(0) }
          else if (e.key === 'End') { e.preventDefault(); setSelected(choices.length - 1) }
          // Enter picks (a form submits only from its fields, not from the list)
          else if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); pick() }
        }}
      >
        {choices.map((c, i) => (
          <div
            key={`${c.attribute}-${c.index}`}
            id={`binpick-${i}`}
            data-index={i}
            role="option"
            aria-selected={i === selected}
            onClick={() => setSelected(i)}
            onDoubleClick={() => pick(i)}
            className={cn(
              'flex items-center gap-2 px-2 py-1.5 cursor-default border-b border-border last:border-b-0',
              i === selected ? 'bg-primary-subtle' : 'hover:bg-accent',
            )}
          >
            <ChoicePreview choice={c} />
          </div>
        ))}
      </div>
    </Dialog>
  )
}

function ChoicePreview({ choice }: { choice: BinaryChoice }) {
  if (choice.kind === 'image') return <ImageChoice choice={choice} />
  if (choice.kind === 'certificate' && !isPKCS7SignedData(base64ToBytes(choice.value, 24))) return <CertificateChoice choice={choice} />
  return (
    <span className="min-w-0">
      <span className="block font-mono text-sm truncate">{choiceTitle(choice)}</span>
      <span className="block text-xs text-muted-foreground">{choiceMeta(choice)}</span>
    </span>
  )
}

function ImageChoice({ choice }: { choice: BinaryChoice }) {
  const url = imageDataUrl(choice.value)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  return (
    <>
      <span className="size-12 shrink-0 rounded border border-border bg-background flex items-center justify-center overflow-hidden">
        {url ? (
          <img src={url} alt="" className="max-w-full max-h-full object-contain" onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
        ) : <ImageIcon size={16} aria-hidden className="text-muted-foreground" />}
      </span>
      <span className="min-w-0">
        <span className="block font-mono text-sm truncate">{choiceTitle(choice)}</span>
        <span className="block text-xs text-muted-foreground">{choiceMeta(choice)}{size ? ` · ${size.w}×${size.h} px` : ''}</span>
      </span>
    </>
  )
}

function CertificateChoice({ choice }: { choice: BinaryChoice }) {
  const [info, setInfo] = useState<CertificateSummary | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    describeCertificateCached(choice.value).then((r) => { if (alive) setInfo(r) }, () => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [choice.value])
  const expiry = info ? certExpiryNote(info) : null
  const v = info ? certValidity(info.notBefore, info.notAfter) : null
  return (
    <>
      <FileBadge size={16} aria-hidden className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="font-mono text-sm truncate">{choiceTitle(choice)}</span>
          {v && <Badge tone={v.status === 'valid' ? 'success' : v.status === 'expired' ? 'danger' : 'warning'} className="shrink-0">{v.status === 'valid' ? 'valid' : v.status === 'expired' ? 'expired' : v.status === 'expiring' ? 'expiring' : 'not yet valid'}</Badge>}
        </span>
        {info ? (
          <>
            <span className="block text-xs truncate" title={info.subject}>{commonName(info.subject)} · {certWhen(info)}</span>
            {certPurpose(info) && <span className="block text-xs text-muted-foreground truncate">{certPurpose(info)}</span>}
            {expiry && <span className={cn('block text-xs', expiry.tone === 'danger' ? 'text-destructive' : 'text-warning')}>{expiry.text}</span>}
          </>
        ) : failed ? (
          <span className="block text-xs text-muted-foreground">{choiceMeta(choice)} · not a readable X.509 certificate</span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 size={12} aria-hidden className="animate-spin" />Reading certificate…</span>
        )}
      </span>
    </>
  )
}
