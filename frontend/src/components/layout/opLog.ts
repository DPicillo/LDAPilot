/**
 * Pure helpers of the Operations log view (RW1-C-02, RW1-C-03): every
 * connected profile streams "operation:log" events, each entry names its
 * profile (`profileId`) and carries the per-profile sequence number `seq`
 * (internal/ldap/logger.go). Tests: tests/loop2.conn.test.ts.
 */

/** The fields of a Go ldap.LogEntry these helpers read. */
export interface LogSeqEntry {
  profileId?: string
  seq?: number
}

/** Entries the Go log keeps per profile (Logger.maxSize). */
export const LOG_VIEW_LIMIT = 1000

/**
 * Whether a streamed entry belongs to the log of `profileId`. An entry
 * without a profile (an older backend) counts for the view it arrives in.
 */
export function entryForProfile(entry: LogSeqEntry, profileId: string | null | undefined): boolean {
  if (!profileId) return false
  return !entry.profileId || entry.profileId === profileId
}

/**
 * The view's entries plus `incoming` (GetLogs or one streamed entry), in
 * sequence order, without the entries it already holds (same `seq`): the
 * CONNECT entry that both GetLogs and the stream deliver is listed once.
 * Entries without a sequence number are kept in arrival order at the end.
 */
export function mergeLogEntries<T extends LogSeqEntry>(current: readonly T[], incoming: readonly T[], limit = LOG_VIEW_LIMIT): T[] {
  if (!incoming.length) return current as T[]
  const seen = new Set<number>()
  for (const e of current) if (hasSeq(e)) seen.add(e.seq!)
  const out = [...current]
  let ordered = true
  let last = lastSeq(current)
  for (const e of incoming) {
    if (hasSeq(e)) {
      if (seen.has(e.seq!)) continue
      seen.add(e.seq!)
      if (e.seq! < last) ordered = false
      last = Math.max(last, e.seq!)
    }
    out.push(e)
  }
  if (!ordered) {
    const withSeq = out.filter(hasSeq).sort((a, b) => a.seq! - b.seq!)
    const without = out.filter((e) => !hasSeq(e))
    out.length = 0
    out.push(...withSeq, ...without)
  }
  return out.length > limit ? out.slice(out.length - limit) : out
}

function hasSeq(e: LogSeqEntry): boolean {
  return typeof e.seq === 'number' && e.seq > 0
}

function lastSeq(list: readonly LogSeqEntry[]): number {
  for (let i = list.length - 1; i >= 0; i--) if (hasSeq(list[i])) return list[i].seq!
  return 0
}

/** A file-system friendly name part ("Lab · Samba AD (LDAPS)" → "Lab-Samba-AD-LDAPS"). */
export function fileNamePart(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
}
