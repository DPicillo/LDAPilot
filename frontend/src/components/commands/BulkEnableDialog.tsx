/**
 * Enable or disable several accounts (multi-selection "Enable/Disable n
 * Accounts…", the tree's selection toolbar): every entry with its current
 * state (read from the server) and the planned change, then the result per
 * entry (changed / skipped / failed). Each change re-reads the status, emits
 * ldapilot:account-changed and refreshes the menus (afterAccountChange).
 */
import { useEffect, useMemo, useState } from 'react'
import { Power } from 'lucide-react'
import { rememberAccountStatus } from '../../stores/accountStatusCache'
import { useEditorStore } from '../../stores/editorStore'
import { GetAccountStatus, SetAccountEnabled, errorMessage } from '../../lib/wails-account'
import { firstRDN, parseRDN } from '../../lib/dn'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Badge, type BadgeTone } from '../ui/Badge'
import { Spinner } from '../ui/Spinner'
import { toast } from '../ui/Toast'
import { TruncatedText } from '../ui/TruncatedText'
import { bulkEnableCounts, defaultBulkEnable, planBulkEnableRow, type BulkEnableRow } from './accountDisplay'
import { afterAccountChange } from './accountState'

type Outcome = { status: 'changed' | 'skipped' | 'failed'; text: string }

const CURRENT_TEXT: Record<BulkEnableRow['current'], { text: string; tone: BadgeTone }> = {
  enabled: { text: 'Enabled', tone: 'success' },
  disabled: { text: 'Disabled', tone: 'warning' },
  noAccount: { text: 'No account', tone: 'neutral' },
  unknown: { text: 'Unknown', tone: 'neutral' },
  reading: { text: 'Reading…', tone: 'neutral' },
}

const nameOf = (dn: string) => parseRDN(firstRDN(dn)).value || dn

export function BulkEnableDialog({ profileId, dns, onClose }: { profileId: string; dns: string[]; onClose: () => void }) {
  const [rows, setRows] = useState<BulkEnableRow[]>(() => dns.map((dn) => ({ dn, name: nameOf(dn), current: 'reading' })))
  const [choice, setChoice] = useState<'enable' | 'disable' | null>(null)
  const [busy, setBusy] = useState(false)
  const [outcomes, setOutcomes] = useState<Map<string, Outcome> | null>(null)
  const reading = rows.some((r) => r.current === 'reading')

  // Current state of every entry (4 reads at a time).
  useEffect(() => {
    let alive = true
    const queue = [...dns]
    const worker = async () => {
      for (let dn = queue.shift(); dn !== undefined; dn = queue.shift()) {
        let next: BulkEnableRow
        try {
          const st = await GetAccountStatus(profileId, dn)
          if (st) rememberAccountStatus(profileId, st)
          next = !st ? { dn, name: nameOf(dn), current: 'unknown', error: 'Not available' } : !st.applicable ? { dn, name: nameOf(dn), current: 'noAccount', error: st.reason } : { dn, name: nameOf(dn), current: st.enabled ? 'enabled' : 'disabled' }
        } catch (err) {
          next = { dn, name: nameOf(dn), current: 'unknown', error: errorMessage(err, 'status not readable') }
        }
        if (!alive) return
        setRows((rs) => rs.map((r) => (r.dn === next.dn ? next : r)))
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, dns.length) }, worker))
    return () => {
      alive = false
    }
  }, [profileId, dns])

  const enable = choice ? choice === 'enable' : defaultBulkEnable(rows)
  const counts = useMemo(() => bulkEnableCounts(rows, enable), [rows, enable])
  const verb = enable ? 'Enable' : 'Disable'

  const run = async () => {
    setBusy(true)
    const out = new Map<string, Outcome>()
    for (const row of rows) {
      const plan = planBulkEnableRow(row, enable)
      if (plan === 'noAccount') {
        out.set(row.dn, { status: 'skipped', text: 'no account' })
        continue
      }
      if (plan === 'same') {
        out.set(row.dn, { status: 'skipped', text: `already ${enable ? 'enabled' : 'disabled'}` })
        continue
      }
      try {
        // The server decides: read again right before writing.
        const st = await GetAccountStatus(profileId, row.dn)
        if (!st || !st.applicable) {
          out.set(row.dn, { status: 'skipped', text: 'no account' })
          continue
        }
        if (st.enabled === enable) {
          out.set(row.dn, { status: 'skipped', text: `already ${enable ? 'enabled' : 'disabled'}` })
          continue
        }
        await SetAccountEnabled(profileId, row.dn, enable)
        out.set(row.dn, { status: 'changed', text: enable ? 'enabled' : 'disabled' })
        const es = useEditorStore.getState()
        if (es.tabs.some((t) => t.id === `${profileId}:${row.dn}`)) void es.refreshEntry(profileId, row.dn, { silent: true })
        void afterAccountChange(profileId, row.dn)
      } catch (err) {
        out.set(row.dn, { status: 'failed', text: errorMessage(err, 'The account action failed') })
      }
      setOutcomes(new Map(out))
    }
    setOutcomes(out)
    setBusy(false)
    const changed = [...out.entries()].filter(([, o]) => o.status === 'changed').map(([dn]) => nameOf(dn))
    const failed = [...out.entries()].filter(([, o]) => o.status === 'failed')
    const skipped = [...out.values()].filter((o) => o.status === 'skipped').length
    const summary = [
      changed.length ? `${changed.length === 1 ? changed[0] : `${changed.length} accounts`} ${enable ? 'enabled' : 'disabled'}` : `No account ${enable ? 'enabled' : 'disabled'}`,
      skipped ? `${skipped} skipped` : '',
      failed.length ? `${failed.length} failed` : '',
    ]
      .filter(Boolean)
      .join(', ')
    if (failed.length) toast.error(summary, failed.map(([dn, o]) => `${nameOf(dn)}: ${o.text}`).join('\n'))
    else if (changed.length) toast.success(summary)
    else toast.info(summary)
  }

  const done = !!outcomes && !busy
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      size="md"
      title={`Enable or Disable ${dns.length} Accounts`}
      description={done ? 'Result per entry.' : 'Accounts that already have the chosen state, and entries without an account, are skipped. Disabled accounts can no longer log on.'}
      icon={Power}
      dismissible={busy ? 'never' : 'always'}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant={enable ? 'primary' : 'danger'} loading={busy} disabled={busy || reading || counts.change + counts.unknown === 0} onClick={() => void run()}>
              {`${verb} ${counts.change + counts.unknown} Account${counts.change + counts.unknown === 1 ? '' : 's'}`}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-2 min-h-0">
        {!done && (
          <div className="flex items-center gap-2">
            <SegmentedControl
              aria-label="Action"
              options={[
                { value: 'disable', label: 'Disable' },
                { value: 'enable', label: 'Enable' },
              ]}
              value={enable ? 'enable' : 'disable'}
              onValueChange={(v) => setChoice(v)}
            />
            <span className="text-xs text-muted-foreground tabular-nums" role="status">
              {reading ? 'Reading the account states…' : `${counts.change} to change · ${counts.same} unchanged · ${counts.noAccount} without account${counts.unknown ? ` · ${counts.unknown} unknown` : ''}`}
            </span>
          </div>
        )}
        <div className="max-h-72 overflow-auto border border-border rounded">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
              <tr>
                <th className="text-left font-semibold px-2 h-table-row">Entry</th>
                <th className="text-left font-semibold px-2 h-table-row w-28">{done ? 'Before' : 'Current'}</th>
                <th className="text-left font-semibold px-2 h-table-row w-44">{done ? 'Result' : 'Planned'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const cur = CURRENT_TEXT[r.current]
                const plan = planBulkEnableRow(r, enable)
                const o = outcomes?.get(r.dn)
                return (
                  <tr key={r.dn} className="border-t border-border">
                    <td className="px-2 h-table-row max-w-0">
                      <TruncatedText text={r.name} tooltip={r.dn} />
                    </td>
                    <td className="px-2 h-table-row">
                      {r.current === 'reading' ? <Spinner size="sm" label={`Reading ${r.name}`} /> : <Badge tone={cur.tone}>{cur.text}</Badge>}
                    </td>
                    <td className="px-2 h-table-row max-w-0">
                      {o ? (
                        <TruncatedText
                          text={o.status === 'changed' ? `✓ ${o.text}` : o.status === 'failed' ? `Failed: ${o.text}` : `Skipped (${o.text})`}
                          className={o.status === 'failed' ? 'text-destructive' : o.status === 'changed' ? 'text-success' : 'text-muted-foreground'}
                        />
                      ) : (
                        <TruncatedText
                          text={
                            plan === 'change'
                              ? `→ ${enable ? 'Enabled' : 'Disabled'}`
                              : plan === 'same'
                                ? 'Unchanged'
                                : plan === 'noAccount'
                                  ? 'Skipped (no account)'
                                  : r.current === 'reading'
                                    ? ''
                                    : `Checked again${r.error ? ` (${r.error})` : ''}`
                          }
                          className={plan === 'change' ? 'text-foreground' : 'text-muted-foreground'}
                        />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Dialog>
  )
}
