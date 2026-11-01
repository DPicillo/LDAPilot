/**
 * Add to Group… for users, computers, contacts, groups (nesting) and
 * multi-selections: a group picker (search by name, or a typed DN), then
 * n × m adds through EditorService.AddToGroups (one single-value modify per
 * membership, audited, refused on read-only connections) and a result list
 * that names every entry.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { UserPlus, X } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import * as wails from '../../lib/wails'
import { AddToGroups, ResolveMemberOf, newMembershipRequestId } from '../../lib/wails-membership'
import { pickerSearchFilter, splitKnownMembers, withSkippedUnchanged } from '../../lib/membership'
import { refreshOpenTabsOf } from '../../stores/editorStore'
import { errorMessage } from '../../lib/wails-account'
import { firstRDN, parseRDN } from '../../lib/dn'
import { ScopeSub, type LDAPEntry } from '../../types/ldap'
import { Dialog } from '../ui/Dialog'
import { Button, IconButton } from '../ui/Button'
import { Combobox } from '../ui/Listbox'
import { Field } from '../ui/Field'
import { Badge } from '../ui/Badge'
import { ObjectIcon } from '../ui/ObjectIcon'
import { InlineAlert } from '../ui/InlineAlert'
import { TruncatedText } from '../ui/TruncatedText'
import { toast } from '../ui/Toast'
import { isLikelyDn } from '../ui/dn'
import type { ObjectKind } from '../ui/objectKind'
import { ensureServerInfo } from '../ui/commands'
import { addSummary, closesAfterAdd, entryOutcome, groupsFor, outcomeText, outcomeTone, type EntryAddOutcome, type GroupPick } from './addToGroups'

interface GroupOption extends GroupPick {
  objectClass?: string[]
  /** A typed DN, not a search hit. */
  typed?: boolean
}

const nameOf = (dn: string) => parseRDN(firstRDN(dn)).value || dn

function attr(e: LDAPEntry, name: string): string | undefined {
  return e.attributes.find((a) => a.name.toLowerCase() === name.toLowerCase())?.values[0]
}

export interface AddToGroupsDialogProps {
  profileId: string
  entries: { dn: string; kind: ObjectKind; label?: string }[]
  /** Entries whose memberships changed (open tabs reload). */
  onChanged?: (dns: string[]) => void
  onClose: () => void
}

export function AddToGroupsDialog({ profileId, entries, onChanged, onClose }: AddToGroupsDialogProps) {
  const [groups, setGroups] = useState<GroupOption[]>([])
  const [busy, setBusy] = useState(false)
  const [outcomes, setOutcomes] = useState<EntryAddOutcome[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const selfKeys = useMemo(() => new Set(entries.map((e) => e.dn.toLowerCase())), [entries])
  // The title follows the menu item's title case ("Add 2 Entries to Groups", M-14).
  const subject = entries.length === 1 ? entries[0].label || nameOf(entries[0].dn) : `${entries.length} Entries`

  const loadOptions = useCallback(
    async (query: string): Promise<GroupOption[]> => {
      setSearchError(null)
      const out: GroupOption[] = []
      if (isLikelyDn(query)) out.push({ dn: query, name: nameOf(query), typed: true })
      try {
        const info = await ensureServerInfo(profileId)
        const profile = useConnectionStore.getState().profiles.find((p) => p.id === profileId)
        const res = await wails.SearchLDAP(profileId, {
          baseDN: profile?.baseDN || info?.defaultNamingContext || '',
          filter: pickerSearchFilter(query, true),
          scope: ScopeSub,
          attributes: ['cn', 'displayName', 'objectClass'],
          sizeLimit: 25,
          timeLimit: 10,
        })
        const q = query.toLowerCase()
        const hits = (res.entries ?? [])
          .map((e): GroupOption => ({ dn: e.dn, name: attr(e, 'displayName') || attr(e, 'cn') || nameOf(e.dn), objectClass: e.attributes.find((a) => a.name.toLowerCase() === 'objectclass')?.values }))
          // Exact, then prefix, then the rest; by name.
          .sort((a, b) => {
            const r = (g: GroupOption) => (g.name.toLowerCase() === q ? 0 : g.name.toLowerCase().startsWith(q) ? 1 : 2)
            return r(a) - r(b) || a.name.localeCompare(b.name)
          })
        out.push(...hits)
      } catch (err) {
        setSearchError(errorMessage(err, 'The group search failed'))
      }
      const chosen = new Set(groups.map((g) => g.dn.toLowerCase()))
      return out.filter((g) => !chosen.has(g.dn.toLowerCase()) && !selfKeys.has(g.dn.toLowerCase()))
    },
    [profileId, groups, selfKeys],
  )

  const submit = async () => {
    if (!groups.length || busy) return
    setBusy(true)
    const results: EntryAddOutcome[] = []
    for (const e of entries) {
      const { send, self } = groupsFor(e.dn, groups)
      if (!send.length) {
        results.push(entryOutcome(e.dn, null, self))
        continue
      }
      try {
        // Memberships that exist already are reported as such, never sent (the server
        // would log "attribute value already exists" errors; M-14, like the Membership panel).
        let known: string[] = []
        let toSend = send
        try {
          const direct = await ResolveMemberOf(profileId, e.dn, false, newMembershipRequestId())
          if (direct) ({ send: toSend, known } = splitKnownMembers(send, direct.items ?? []))
        } catch {
          /* unknown: send all, the server reports existing ones */
        }
        const res = toSend.length ? await AddToGroups(profileId, e.dn, toSend) : null
        results.push(entryOutcome(e.dn, withSkippedUnchanged(res, known), self))
      } catch (err) {
        results.push(entryOutcome(e.dn, null, self, errorMessage(err, 'The membership change failed')))
      }
      setOutcomes([...results])
    }
    setOutcomes(results)
    setBusy(false)
    const changed = results.filter((o) => o.added.length).map((o) => o.dn)
    if (changed.length) onChanged?.(changed)
    // Open tabs of the groups show their new members (M-18).
    refreshOpenTabsOf(profileId, [...new Set(results.flatMap((o) => o.added))])
    const { text, failed } = addSummary(results, groups.length)
    if (failed) toast.error(text, results.filter((o) => o.error || o.failed.length).map((o) => `${nameOf(o.dn)}: ${outcomeText(o)}`).join('\n'))
    else if (changed.length) toast.success(text)
    else toast.info(text)
    if (closesAfterAdd(results)) onClose()
  }

  const done = !!outcomes && !busy
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      size="md"
      icon={UserPlus}
      title={`Add ${subject} to Groups`}
      description={done ? 'Result per entry.' : 'Search for groups by name, or paste a group DN. Each entry is added to every chosen group.'}
      dismissible={busy ? 'never' : groups.length && !done ? 'when-clean' : 'always'}
      dirty={!!groups.length && !done}
      onSubmit={() => void submit()}
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
            <Button type="submit" variant="primary" kbd="Mod+Enter" loading={busy} disabled={!groups.length || busy}>
              {groups.length > 1 ? `Add to ${groups.length} Groups` : 'Add to Group'}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3 min-h-0">
        {!done && (
          <div
            ref={pickerRef}
            onKeyDown={(e) => {
              // Enter with typed text that chose nothing (results still loading) must not submit the dialog.
              if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && e.target instanceof HTMLInputElement && e.target.value.trim()) e.preventDefault()
            }}
          >
            <Field label="Groups">
              <Combobox<GroupOption>
                loadOptions={loadOptions}
                getKey={(g) => g.dn}
                getLabel={(g) => g.name}
                minChars={2}
                clearOnSelect
                autoFocus
                aria-label="Find a group"
                placeholder="Group name or DN"
                emptyText="No matching groups"
                renderItem={(g) => (
                  <span className="flex items-center gap-2 min-w-0">
                    <ObjectIcon kind="group" size={14} />
                    <span className="truncate">{g.typed ? `Use DN ${g.dn}` : g.name}</span>
                    {!g.typed && <span className="truncate text-xs text-muted-foreground font-mono">{g.dn}</span>}
                  </span>
                )}
                onSelect={(g) => setGroups((cur) => (cur.some((x) => x.dn.toLowerCase() === g.dn.toLowerCase()) ? cur : [...cur, g]))}
              />
            </Field>
            {searchError && <InlineAlert tone="danger" body={searchError} className="mt-2" />}
          </div>
        )}
        {!done && groups.length > 0 && (
          <ul className="flex flex-wrap gap-1" aria-label="Chosen groups">
            {groups.map((g) => (
              <li key={g.dn}>
                <Badge tone="oc-group" className="gap-0.5 pr-0.5 max-w-[320px]" title={g.dn}>
                  <span className="truncate">{g.name}</span>
                  <IconButton label={`Remove ${g.name}`} icon={X} size="sm" disabled={busy} onClick={() => setGroups((cur) => cur.filter((x) => x.dn !== g.dn))} />
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {entries.length > 1 && !outcomes && (
          <p className="text-xs text-muted-foreground">
            {entries.length} entries × {groups.length || 'no'} group{groups.length === 1 ? '' : 's'} = {entries.length * groups.length} memberships
          </p>
        )}
        {outcomes && (
          <ul className="max-h-72 overflow-auto border border-border rounded divide-y divide-border" aria-label="Result per entry" role="list">
            {outcomes.map((o) => {
              const tone = outcomeTone(o)
              return (
                <li key={o.dn} className="flex items-start gap-2 px-2 py-1.5 min-w-0">
                  <span className="w-40 shrink-0 min-w-0 text-sm">
                    <TruncatedText text={nameOf(o.dn)} tooltip={o.dn} />
                  </span>
                  <span className={tone === 'danger' ? 'text-sm text-destructive min-w-0 break-words' : tone === 'success' ? 'text-sm text-foreground min-w-0 break-words' : 'text-sm text-muted-foreground min-w-0 break-words'}>
                    {outcomeText(o)}
                    {o.warnings.length > 0 && <span className="block text-xs text-warning">{o.warnings.join(' · ')}</span>}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Dialog>
  )
}
