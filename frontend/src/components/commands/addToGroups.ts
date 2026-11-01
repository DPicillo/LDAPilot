/**
 * Add to Group… (pure parts, tests/cmd.groups.test.ts): which picked groups
 * an entry is sent to, and the result line per entry.
 */
import type { MembershipChangeResult } from '../../types/membership'
import { normalizeDN, parseRDN, firstRDN } from '../../lib/dn.ts'

export interface GroupPick {
  dn: string
  name: string
}

/** Groups to send for one entry: never the entry itself (a group is not its own member). */
export function groupsFor(entryDN: string, groups: readonly GroupPick[]): { send: string[]; self: boolean } {
  const key = normalizeDN(entryDN)
  const send = groups.filter((g) => normalizeDN(g.dn) !== key).map((g) => g.dn)
  return { send, self: send.length < groups.length }
}

const short = (dn: string) => parseRDN(firstRDN(dn)).value || dn

export interface EntryAddOutcome {
  dn: string
  added: string[]
  already: string[]
  failed: { dn: string; error: string }[]
  warnings: string[]
  self: boolean
  /** The whole call failed (not per group). */
  error?: string
}

/** Outcome of one entry from the backend result (group DNs). */
export function entryOutcome(dn: string, res: MembershipChangeResult | null, self: boolean, error?: string): EntryAddOutcome {
  return {
    dn,
    added: res?.changed ?? [],
    already: res?.unchanged ?? [],
    failed: res?.failed ?? [],
    warnings: res?.warnings ?? [],
    self,
    error,
  }
}

/** "added to Sales, VPN · already in Staff · failed: Admins (insufficient access)". */
export function outcomeText(o: EntryAddOutcome): string {
  if (o.error) return `failed: ${o.error}`
  const parts: string[] = []
  if (o.added.length) parts.push(`added to ${o.added.map(short).join(', ')}`)
  if (o.already.length) parts.push(`already in ${o.already.map(short).join(', ')}`)
  if (o.failed.length) parts.push(`failed: ${o.failed.map((f) => `${short(f.dn)} (${f.error})`).join(', ')}`)
  if (o.self) parts.push('not added to itself')
  if (!parts.length) parts.push('nothing to do')
  return parts.join(' · ')
}

export function outcomeTone(o: EntryAddOutcome): 'success' | 'danger' | 'neutral' {
  if (o.error || o.failed.length) return 'danger'
  return o.added.length ? 'success' : 'neutral'
}

/** Toast summary: "Added Anna to 2 groups" / "Added 3 entries to 2 groups, 1 failed". */
export function addSummary(outcomes: readonly EntryAddOutcome[], groupCount: number): { text: string; failed: number } {
  const failed = outcomes.filter((o) => o.error || o.failed.length).length
  const changed = outcomes.filter((o) => o.added.length).length
  const groups = `${groupCount} group${groupCount === 1 ? '' : 's'}`
  const who = outcomes.length === 1 ? short(outcomes[0].dn) : `${changed} of ${outcomes.length} entries`
  let text = changed ? `Added ${who} to ${groups}` : outcomes.length === 1 ? `${short(outcomes[0].dn)}: no membership added` : 'No membership added'
  if (failed) text += `, ${failed} failed`
  return { text, failed }
}

/**
 * One entry, everything added (nothing already there, failed or skipped):
 * the dialog closes and the toast is the result (M-14: the result page cost
 * one more click than the Membership panel). Several entries, or anything to
 * look at, keep the result page.
 */
export function closesAfterAdd(outcomes: readonly EntryAddOutcome[]): boolean {
  if (outcomes.length !== 1) return false
  const o = outcomes[0]
  return !o.error && !o.self && o.added.length > 0 && !o.already.length && !o.failed.length && !o.warnings.length
}
