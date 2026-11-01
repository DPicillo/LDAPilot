/**
 * The primary account verb of an entry (pure; node --test:
 * tests/nav.palette.test.ts): Unlock when locked, Enable when disabled,
 * otherwise Reset Password. The editor header shows it as its primary
 * button; the palette preselects it when Tab opens a hit's actions and runs
 * it on Shift+Enter (FIN-W-02, WF-2 from the start state).
 */

export interface VerbItem {
  id: string
  enabled: boolean
}

/**
 * The primary verb among `items` (resolved account commands), or undefined.
 * Disabled items (e.g. the "Checking account status…" placeholder in the
 * Unlock slot) are never the primary. `fallback`: any enabled item when
 * none of the three applies (the editor header always shows a button).
 */
export function primaryAccountVerb<T extends VerbItem>(
  items: readonly T[],
  statusKinds: readonly string[] | undefined,
  opts: { locked?: boolean; fallback?: boolean } = {},
): T | undefined {
  const by = (id: string) => items.find((i) => i.id === id && i.enabled)
  if ((opts.locked || statusKinds?.includes('locked')) && by('account.unlock')) return by('account.unlock')
  if (statusKinds?.includes('disabled') && by('account.toggleEnabled')) return by('account.toggleEnabled')
  return by('account.resetPassword') ?? (opts.fallback ? items.find((i) => i.enabled) : undefined)
}

/**
 * What the editor header's primary button is (RW2-C-02): while the tab's
 * connection is lost or closed the account verbs cannot write (they hide as
 * on a read-only connection), so the primary is "Reconnect" (the banner
 * keeps its own); once the connection is back the account verb returns.
 */
export function editorHeaderPrimary(o: { offline: boolean }): 'reconnect' | 'account' {
  return o.offline ? 'reconnect' : 'account'
}
