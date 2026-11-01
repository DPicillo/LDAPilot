import { getParentDN, normalizeDN } from '../../lib/dn.ts'

/**
 * Text colour (text-op-* token) of an operation in the Operations and Audit
 * logs. Exact names first (every operation the backend logs or audits),
 * then substring rules for unknown ones; muted when nothing matches.
 *
 * Operations log (internal/ldap logger): CONNECT, RECONNECT, BIND,
 * BIND_CHECK, ROOTDSE, SEARCH, READ (failed reads), REFERRAL, MEMBERSHIP,
 * ADD, MODIFY, PASSWD_MODIFY, PWPOLICY, RENAME, DELETE, RESTORE.
 * Audit log (services): CREATE, MODIFY, ADD_ATTR, DEL_ATTR, RENAME, MOVE,
 * DELETE, TREE_DELETE, RESTORE, AUDIT_CLEARED.
 *
 * Also the pure helpers of the log views (no React; `node --test`).
 */
const EXACT: Record<string, string> = {
  CONNECT: 'text-op-connect',
  RECONNECT: 'text-op-connect',
  BIND: 'text-op-bind',
  BIND_CHECK: 'text-op-bind',
  ROOTDSE: 'text-op-search',
  SEARCH: 'text-op-search',
  READ: 'text-op-search',
  COMPARE: 'text-op-search',
  // Referral chasing and membership resolution are reads on behalf of a search / view.
  REFERRAL: 'text-op-search',
  MEMBERSHIP: 'text-op-search',
  ADD: 'text-op-add',
  CREATE: 'text-op-add',
  ADD_ATTR: 'text-op-add',
  // A restored deleted object is (re-)created.
  RESTORE: 'text-op-add',
  MODIFY: 'text-op-modify',
  PASSWD_MODIFY: 'text-op-modify',
  // Password storage policy notes accompany the password writes.
  PWPOLICY: 'text-op-modify',
  RENAME: 'text-op-modrdn',
  MODRDN: 'text-op-modrdn',
  MOVE: 'text-op-modrdn',
  DELETE: 'text-op-delete',
  DEL_ATTR: 'text-op-delete',
  TREE_DELETE: 'text-op-delete',
  AUDIT_CLEARED: 'text-op-delete',
}

export function opTone(op: string): string {
  const u = op.toUpperCase()
  const exact = EXACT[u]
  if (exact) return exact
  if (u.includes('DELETE')) return 'text-op-delete'
  if (u.includes('SEARCH') || u.includes('COMPARE')) return 'text-op-search'
  if (u.includes('BIND')) return 'text-op-bind'
  if (u.includes('CONNECT')) return 'text-op-connect'
  if (u.includes('ADD') || u.includes('CREATE')) return 'text-op-add'
  if (u.includes('MODIFY')) return 'text-op-modify'
  if (u.includes('RENAME') || u.includes('MODRDN') || u.includes('MOVE')) return 'text-op-modrdn'
  return 'text-muted-foreground'
}

/** Result of an operations log row: a cancelled search is logged without error but "-> cancelled after n entries". */
export function logResult(entry: { details: string; error?: string }): 'ok' | 'error' | 'cancelled' {
  if (entry.error) return 'error'
  return / -> cancelled after \d+ entr(?:y|ies)$/.test(entry.details) ? 'cancelled' : 'ok'
}

/**
 * What ends a DN in the operation log details (internal/ldap logger):
 * "dn=<DN> changes=…", "base=<DN> scope=…", "dn=<DN> newRDN=…", "dn=<DN>
 * target=…" (restore), "dn=<DN> members effective=…" (membership),
 * "dn=<DN> -> failed", "dn=<DN> (RFC 3062 …)", "dn=<DN> WARNING: …".
 */
const DN_END = / (?:scope=|newRDN=|newSuperior=|controls=|changes=|target=|(?:members |memberOf )?effective=|-> |WARNING: |add |delete |replace |increment |\(|attrs?=|limit=)/

/**
 * The DN an operations log row is about: "dn=<DN>" (reads and writes) or
 * "base=<DN>" (searches); '' when there is none.
 */
export function logEntryDN(details: string): string {
  const m = /(?:^|\s)(?:dn|base)=/.exec(details)
  if (!m) return ''
  const rest = details.slice(m.index + m[0].length)
  const end = DN_END.exec(rest)
  return (end ? rest.slice(0, end.index) : rest).trim()
}

/**
 * The DN an entry has after a RENAME / MOVE audit row: "newDN=…" (written
 * since the UX fixes), else newRDN below newSuperior or the old parent.
 * '' for other rows.
 */
export function auditNewDN(entry: { operation: string; dn: string; details?: string }): string {
  const op = entry.operation.toUpperCase()
  if (op !== 'RENAME' && op !== 'MOVE') return ''
  const d = entry.details ?? ''
  const nd = / newDN=(.+)$/.exec(d)
  if (nd) return nd[1].trim()
  const rdn = /newRDN=(.+?)(?= deleteOldRDN=| newSuperior=|$)/.exec(d)?.[1]?.trim()
  if (!rdn) return ''
  const sup = /newSuperior=(.+?)(?= deleteOldRDN=| newDN=|$)/.exec(d)?.[1]?.trim()
  const parent = sup || getParentDN(entry.dn)
  return parent ? `${rdn},${parent}` : rdn
}

// --- Show History across renames (RW1-R-04) ------------------------------------------

interface AuditLike {
  operation: string
  dn: string
  details?: string
  timestamp: string
  error?: string
}

const isMove = (e: AuditLike) => !e.error && (e.operation.toUpperCase() === 'RENAME' || e.operation.toUpperCase() === 'MOVE')

/**
 * The DNs an entry had: `dn` plus every earlier DN reached by following
 * RENAME / MOVE rows backwards (newDN = a known DN → its old DN), lower
 * case and normalized. Show History matches rows of all of them.
 */
export function historyDNs(entries: readonly AuditLike[], dn: string): Set<string> {
  const known = new Set([normalizeDN(dn)])
  for (let changed = true, rounds = 0; changed && rounds < 50; rounds++) {
    changed = false
    for (const e of entries) {
      if (!isMove(e)) continue
      const nd = auditNewDN(e)
      if (!nd || !known.has(normalizeDN(nd))) continue
      const old = normalizeDN(e.dn)
      if (!known.has(old)) {
        known.add(old)
        changed = true
      }
    }
  }
  return known
}

/**
 * The DN the entry of an audit row has now: RENAME / MOVE rows of that DN
 * after the row's time are followed forward (a link to an old DN opens the
 * renamed entry instead of "No such object").
 */
export function forwardDN(entries: readonly AuditLike[], dn: string, after = ''): string {
  let cur = dn
  let at = after
  for (let i = 0; i < 20; i++) {
    const key = normalizeDN(cur)
    const next = entries
      .filter((e) => isMove(e) && e.timestamp >= at && normalizeDN(e.dn) === key)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0]
    const nd = next ? auditNewDN(next) : ''
    if (!next || !nd || normalizeDN(nd) === key) return cur
    cur = nd
    at = next.timestamp
  }
  return cur
}

/**
 * A successful DELETE row whose entry was not added again later (same DN):
 * there is no entry to open (RW3-S-08: Recent LDIF changes opened a "No such
 * object" tab). The AD panel opens Deleted Objects instead.
 */
export function deletedForGood(entries: readonly AuditLike[], row: AuditLike): boolean {
  if (row.error || row.operation.toUpperCase() !== 'DELETE') return false
  const key = normalizeDN(row.dn)
  return !entries.some((e) => !e.error && e.operation.toUpperCase() === 'ADD' && e.timestamp > row.timestamp && normalizeDN(e.dn) === key)
}

// --- Log filters per connection (FIN-W-01) ---------------------------------------------

/**
 * A log view's value (text filter, Show History DN) for one connection:
 * `slots[profileId]`, else `initial`. The Operations and Audit Log views
 * keep their filter per connection, so "Show History" on an AD entry no
 * longer leaves the OpenLDAP audit log filtered to that DN ("0 of 2 · No
 * matching entries").
 */
export function profileSlot<T>(slots: Readonly<Record<string, T>>, profileId: string | null, initial: T): T {
  if (!profileId) return initial
  return Object.prototype.hasOwnProperty.call(slots, profileId) ? slots[profileId] : initial
}

/** `slots` with the value of one connection replaced (no connection: unchanged). */
export function withProfileSlot<T>(slots: Readonly<Record<string, T>>, profileId: string | null, value: T): Record<string, T> {
  if (!profileId) return slots as Record<string, T>
  return { ...slots, [profileId]: value }
}
