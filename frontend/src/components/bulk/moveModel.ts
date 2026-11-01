/**
 * The move dry run (BatchService.BatchMovePreview) and its fallback, pure
 * parts of the one move flow (RW3-S-07, MoveEntriesFlow.tsx). Runs under
 * `node --test` (tests/search.move.test.ts).
 */
import { firstRDN, getParentDN, normalizeDN } from '../../lib/dn.ts'

export type MovePlanStatus = 'move' | 'unchanged' | 'fail'

export interface MovePlanItem {
  dn: string
  newDN?: string
  status: MovePlanStatus
  message?: string
}

/** Go services.BatchMovePlan. */
export interface MovePlan {
  total: number
  ready: number
  unchanged: number
  failing: number
  refused?: boolean
  reason?: string
  items: MovePlanItem[]
}

/**
 * A plan without the server check (older backend): entries already in the
 * target are unchanged, the others will move. Names taken in the target are
 * found by the move itself.
 */
export function localMovePlan(dns: readonly string[], target: string): MovePlan {
  const t = normalizeDN(target.trim())
  const items: MovePlanItem[] = dns.map((dn) =>
    normalizeDN(getParentDN(dn)) === t ? { dn, status: 'unchanged', message: 'already in the target container' } : { dn, newDN: `${firstRDN(dn)},${target.trim()}`, status: 'move' },
  )
  return {
    total: dns.length,
    ready: items.filter((i) => i.status === 'move').length,
    unchanged: items.filter((i) => i.status === 'unchanged').length,
    failing: 0,
    items,
  }
}

/** A plan from the backend with the counts recomputed from its items (never trust a partial answer). */
export function normalizePlan(raw: Partial<MovePlan> | null | undefined, dns: readonly string[]): MovePlan {
  const items = (raw?.items ?? []).filter((i): i is MovePlanItem => !!i && typeof i.dn === 'string')
  if (raw?.refused) return { total: dns.length, ready: 0, unchanged: 0, failing: 0, refused: true, reason: raw.reason || 'The target container cannot be used.', items: [] }
  return {
    total: dns.length,
    ready: items.filter((i) => i.status === 'move').length,
    unchanged: items.filter((i) => i.status === 'unchanged').length,
    failing: items.filter((i) => i.status === 'fail').length,
    items,
  }
}

/** The DNs the plan moves (status move), in the order given. */
export function plannedMoves(plan: MovePlan): string[] {
  return plan.items.filter((i) => i.status === 'move').map((i) => i.dn)
}

/** "2 will move · 1 already there · 1 will fail". */
export function planSummary(plan: MovePlan): string {
  return [
    plan.ready ? `${plan.ready} will move` : 'nothing to move',
    plan.unchanged ? `${plan.unchanged} already there` : '',
    plan.failing ? `${plan.failing} will fail` : '',
  ].filter(Boolean).join(' · ')
}

/**
 * Whether the flow can move at once without showing the plan: one entry
 * that the dry run says will move (the plan is the confirmation for
 * several entries or for a predicted problem).
 */
export function skipReview(plan: MovePlan): boolean {
  return !plan.refused && plan.total === 1 && plan.ready === 1
}

/**
 * Whether a move run closes its dialog (Move… and the batch dialog's Move
 * tab alike): something moved and nothing failed or was refused. The toast
 * (with Undo) then reports it; otherwise the dialog stays on its result with
 * "Retry n Entries…".
 */
export function moveClosesDialog(outcome: { moved: number; failed: number; refused?: string | boolean }): boolean {
  return !outcome.refused && outcome.failed === 0 && outcome.moved > 0
}

/** The toast of a fully successful move: "<name> moved to <target>" / "n entries moved to <target> (m already there)". */
export function moveToastText(movedNames: readonly string[], targetName: string, unchanged = 0): string {
  return movedNames.length === 1
    ? `${movedNames[0]} moved to ${targetName}`
    : `${movedNames.length} entries moved to ${targetName}${unchanged ? ` (${unchanged} already there)` : ''}`
}
