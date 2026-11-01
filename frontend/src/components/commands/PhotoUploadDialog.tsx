/**
 * Upload Photo…: the current and the new picture side by side, type and size
 * checks before anything is written (thumbnailPhoto ≤ 100 KiB), "Replace
 * Photo" as the explicit confirmation, and on AD "Also update jpegPhoto"
 * (default on when the entry has one). One ModifyEntry with binary replace
 * changes (photoPlan.ts).
 */
import { useEffect, useRef, useState } from 'react'
import { ImageUp } from 'lucide-react'
import * as wails from '../../lib/wails'
import { OpenBinaryFile } from '../../lib/wails-binary'
import { errorMessage } from '../../lib/wails-account'
import { formatByteSize, imageDataUrl } from '../../lib/binary'
import { firstRDN, parseRDN } from '../../lib/dn'
import type { BinaryFile } from '../../types/binary'
import type { ServerType } from '../../types/ldap'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { InlineAlert } from '../ui/InlineAlert'
import { Spinner } from '../ui/Spinner'
import { toast } from '../ui/Toast'
import { checkPhotoFile, defaultAlsoJpeg, photoTargets, planPhotoChanges, primaryPhotoAttribute, valuesOf, type PhotoValues } from './photoPlan'
import { PHOTO_ATTRS, forgetPresence } from './presence'
import { chooseBinaryValue } from '../editor/BinaryValuePicker'
import { binaryChoices } from '../editor/certificateCard'

export interface PhotoUploadDialogProps {
  profileId: string
  dn: string
  serverType: ServerType | null
  onUploaded?: () => void
  onClose: () => void
}

function Preview({ caption, value, empty }: { caption: string; value?: string; empty: string }) {
  const src = value ? imageDataUrl(value) : null
  return (
    <figure className="flex flex-col items-center gap-1.5 min-w-0">
      <div className="size-32 rounded border border-border bg-muted flex items-center justify-center overflow-hidden">
        {src ? <img src={src} alt={caption} className="max-w-full max-h-full object-contain" /> : <span className="px-2 text-center text-xs text-muted-foreground">{value ? 'Not an image' : empty}</span>}
      </div>
      <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
    </figure>
  )
}

export function PhotoUploadDialog({ profileId, dn, serverType, onUploaded, onClose }: PhotoUploadDialogProps) {
  const name = parseRDN(firstRDN(dn)).value || dn
  const primary = primaryPhotoAttribute(serverType)
  const [current, setCurrent] = useState<PhotoValues | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [file, setFile] = useState<BinaryFile | null>(null)
  const [alsoJpeg, setAlsoJpeg] = useState<boolean | null>(null)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chooseRef = useRef<HTMLButtonElement>(null)
  const submitRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let alive = true
    wails
      .GetEntry(profileId, dn)
      .then((e) => {
        if (!alive) return
        const out: PhotoValues = {}
        for (const a of e?.attributes ?? []) if (PHOTO_ATTRS.some((p) => p.toLowerCase() === a.name.toLowerCase())) out[a.name] = a.values
        setCurrent(out)
      })
      .catch((err) => alive && setLoadError(errorMessage(err, 'Could not read the entry')))
    return () => {
      alive = false
    }
  }, [profileId, dn])

  const also = alsoJpeg ?? (current ? defaultAlsoJpeg(current) : false)
  const targets = photoTargets(serverType, also)
  const currentValue = current ? valuesOf(current, primary)[0] ?? valuesOf(current, 'jpegPhoto')[0] ?? valuesOf(current, 'thumbnailPhoto')[0] : undefined
  const hasCurrent = !!current && targets.some((t) => valuesOf(current, t).length > 0)
  const check = file ? checkPhotoFile(file.data, targets) : null
  const canSubmit = !!file && !!current && !check?.problems.length && !busy

  const choose = async () => {
    setError(null)
    setPicking(true)
    let picked = false
    try {
      // The backend checks the format and the size cap of the primary attribute before returning the file.
      const f = await OpenBinaryFile(profileId, primary)
      if (f) {
        setFile(f)
        picked = true
      }
    } catch (err) {
      setError(errorMessage(err, 'Could not open the file'))
    } finally {
      setPicking(false)
    }
    // Back from the native picker focus sat behind the dialog: the primary button takes it once
    // a file is chosen (Enter replaces), else Choose File… (RW2-E-04 c).
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const target = picked && submitRef.current && !submitRef.current.disabled ? submitRef.current : chooseRef.current
      target?.focus({ preventScroll: true })
    }))
  }

  // Upload Photo… opens the file picker straight away; the dialog then shows the preview
  // (WF-17 / RW1-E-10: one step less). Cancelling the picker leaves the dialog with Choose File….
  useEffect(() => {
    // A timer, not a "done" ref: StrictMode's double mount clears the first one.
    const t = setTimeout(() => void choose(), 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = async () => {
    if (!canSubmit || !file || !current) return
    // A target with several pictures: which one the new file replaces (DEF-13), never silently the first.
    const replaceIndex: Record<string, number> = {}
    for (const t of targets) {
      const choices = binaryChoices(Object.entries(current).map(([n, values]) => ({ name: n, values, binary: true })), [t])
      if (choices.length < 2) continue
      const choice = await chooseBinaryValue({ title: `Replace which ${t} value?`, verb: 'Replace', choices })
      if (!choice) return
      replaceIndex[t] = choice.index
    }
    const changes = planPhotoChanges(targets, current, file.data, replaceIndex)
    if (!changes.length) {
      toast.info(`${name} already has this photo`)
      onClose()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await wails.ModifyEntry(profileId, dn, changes)
      forgetPresence(profileId, dn)
      toast.success(`Photo of ${name} ${hasCurrent ? 'replaced' : 'uploaded'} (${changes.map((c) => c.attribute).join(', ')})`)
      onUploaded?.()
      onClose()
    } catch (err) {
      setError(errorMessage(err, 'The photo could not be written'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      size="md"
      icon={ImageUp}
      title={hasCurrent ? `Replace Photo of ${name}` : `Upload Photo for ${name}`}
      description={hasCurrent ? 'The new picture replaces the current one.' : undefined}
      dismissible={busy ? 'never' : 'when-clean'}
      dirty={!!file}
      initialFocus={chooseRef}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button ref={submitRef} type="submit" variant="primary" loading={busy} disabled={!canSubmit}>
            {hasCurrent ? 'Replace Photo' : 'Upload Photo'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {loadError && <InlineAlert tone="danger" body={loadError} />}
        <div className="flex items-start justify-center gap-6">
          {current ? <Preview caption="Current" value={currentValue} empty="No photo" /> : <Spinner label="Reading the current photo" />}
          <Preview caption="New" value={file?.data} empty="No file chosen" />
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <Button ref={chooseRef} variant="secondary" size="sm" loading={picking} disabled={busy || !current} onClick={() => void choose()}>
            {file ? 'Choose Another File…' : 'Choose File…'}
          </Button>
          {file && (
            <span className="text-xs text-muted-foreground truncate tabular-nums" title={file.name}>
              {file.name} · {(file.format || 'unknown').toUpperCase()} · {formatByteSize(file.size)}
              {file.width > 0 && ` · ${file.width}×${file.height}px`}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {serverType === 'ad' ? 'Outlook and Teams show thumbnailPhoto (at most 100 KiB; 96×96 px recommended).' : 'Stored in jpegPhoto.'}
        </p>
        {serverType === 'ad' && (
          <Checkbox
            checked={also}
            onCheckedChange={(v) => setAlsoJpeg(v)}
            disabled={busy}
            label="Also update jpegPhoto"
            description={current && valuesOf(current, 'jpegPhoto').length ? 'The entry has a jpegPhoto; keep both pictures the same.' : 'Some applications read jpegPhoto instead of thumbnailPhoto.'}
          />
        )}
        {check?.problems.map((p) => <InlineAlert key={p} tone="danger" body={p} />)}
        {check?.warnings.map((w) => <InlineAlert key={w} tone="warning" body={w} />)}
        {error && <InlineAlert tone="danger" body={error} />}
      </div>
    </Dialog>
  )
}
