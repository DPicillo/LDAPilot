/**
 * Quit guard (CONN-15). Every way of closing the window (title bar button,
 * File ▸ Exit, Alt+F4, the window manager) reaches Go's OnBeforeClose, which
 * holds the close back and emits `app:before-close`. This guard answers at
 * once (AckClose) and quits unless work would be lost: an open bulk / batch
 * or LDIF import dialog (a run may be in progress), a running recursive
 * delete (`recycle:delete-progress` without phase "done") or editor tabs
 * with unsaved edits. Then it asks "Quit anyway?". Go closes anyway when
 * the frontend does not answer within 2 s or the user closes again within
 * 5 s, so a broken frontend never traps the window.
 *
 * Mount `useQuitGuard()` once (AppLayout) and render <QuitGuardDialog />
 * in the overlay hosts; File ▸ Exit calls `requestQuit()`.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { useBulkDialogStore } from '../../stores/bulkDialogStore'
import { useEditorStore } from '../../stores/editorStore'
import { hasUnsavedEdits } from '../../stores/unsavedEdits'
import { AckClose, APP_BEFORE_CLOSE_EVENT, CancelClose, QuitApp } from '../../lib/wails-app'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { onWailsEvent } from '../layout/shellState'
import { quitBusyReasons, runningDeleteCount, trackDeleteProgress } from './chromeLogic'

// Recursive deletes by operation id → time of their last progress event.
let runningDeletes = new Map<string, number>()

const useQuitStore = create<{ reasons: string[] | null }>(() => ({ reasons: null }))

/** What would be lost by quitting now (empty: nothing). */
export function currentQuitBlockers(): string[] {
  const bulk = useBulkDialogStore.getState()
  const es = useEditorStore.getState()
  const dirtyTabs = es.tabs.filter((t) => t.dn && (t.dirty || hasUnsavedEdits(t.profileId, t.dn))).map((t) => t.label || t.dn)
  return quitBusyReasons({
    batchDialog: !!bulk.batch,
    ldifDialog: !!bulk.importLDIF,
    runningDeletes: runningDeleteCount(runningDeletes, Date.now()),
    dirtyTabs,
  })
}

/** Quits, or asks "Quit anyway?" first when work would be lost (File ▸ Exit, window close). */
export function requestQuit(): void {
  const reasons = currentQuitBlockers()
  if (reasons.length === 0) {
    void QuitApp()
    return
  }
  useQuitStore.setState({ reasons })
}

/** Subscribes to the close request and the recursive delete progress. Mount once (AppLayout). */
export function useQuitGuard(): void {
  useEffect(() => {
    const offDelete = onWailsEvent('recycle:delete-progress', (...data: unknown[]) => {
      runningDeletes = trackDeleteProgress(runningDeletes, data[0] as { operationId?: string; phase?: string }, Date.now())
    })
    const offClose = onWailsEvent(APP_BEFORE_CLOSE_EVENT, () => {
      void AckClose().catch(() => {})
      requestQuit()
    })
    return () => {
      offDelete()
      offClose()
    }
  }, [])
}

/** The "Quit anyway?" confirmation (overlay host). */
export function QuitGuardDialog() {
  const reasons = useQuitStore((s) => s.reasons)
  if (!reasons) return null
  return (
    <ConfirmDialog
      tone="warning"
      title="Quit anyway?"
      message={
        <div className="space-y-2">
          <p>Work in progress would be lost:</p>
          <ul className="list-disc pl-5 space-y-0.5 text-foreground">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      }
      confirmLabel="Quit Anyway"
      cancelLabel="Keep Working"
      onConfirm={() => {
        useQuitStore.setState({ reasons: null })
        void QuitApp()
      }}
      onCancel={() => {
        useQuitStore.setState({ reasons: null })
        void CancelClose().catch(() => {})
      }}
    />
  )
}
