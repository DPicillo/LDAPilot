/**
 * The one "send the password unencrypted?" confirmation (DEF-21, P-20):
 * every place that asks before a cleartext password crosses a connection
 * without TLS uses these texts and the same pattern — a warning box with a
 * consent checkbox, then Cancel (initial focus) and Continue (disabled
 * until the box is ticked): PasswordDialog (Reset Password), the password
 * write guard (attribute table, Edit Entry, New / Copy Entry, bulk modify,
 * LDIF import) and the AI approval card (its confirmation checkbox).
 * `allowUnencrypted` is only ever sent after that explicit consent;
 * unicodePwd over plain LDAP is refused before any confirmation
 * (passwordSubmitBlock / Go ErrPasswordNeedsTLS). Pure (node --test).
 */

/** Title of the confirmation dialog. */
export const UNENCRYPTED_TITLE = 'Send the password unencrypted?'

/** The consent checkbox (one sentence everywhere). */
export const UNENCRYPTED_CONSENT = 'Send the password in cleartext over this unencrypted connection (no LDAPS/StartTLS). Anyone on the network path can read it.'

/** The primary button of the confirmation (after Cancel). */
export const UNENCRYPTED_CONTINUE = 'Continue'

/** The risk as a statement (notices, the AI card's red box, the connect prompt). */
export const UNENCRYPTED_RISK = 'The password is sent in cleartext over this unencrypted connection (no LDAPS/StartTLS): anyone on the network path can read it.'

/** What a password reset puts on the wire in cleartext (PasswordDialog's selection). */
export function resetCleartextParts(sel: { method: string; scheme: string; verifyBind: boolean }): string[] {
  return [
    sel.method === 'unicodePwd' ? 'unicodePwd' : sel.method === 'exop' ? 'Password Modify extended operation' : sel.method === 'userPassword' && sel.scheme.toUpperCase() === 'CLEARTEXT' ? 'cleartext userPassword' : '',
    sel.verifyBind ? 'verification bind' : '',
  ].filter(Boolean)
}

/** "The reset sends the new password in cleartext (Password Modify extended operation, verification bind)." */
export function unencryptedWhat(parts: readonly string[], what = 'The reset sends the new password'): string {
  return `${what} in cleartext${parts.length ? ` (${parts.join(', ')})` : ''}.`
}

/**
 * The options a confirmation may send: `allowUnencrypted` only when the
 * consent box was ticked (or the caller had already confirmed it, `base`).
 */
export function withUnencryptedConsent<T extends { allowUnencrypted?: boolean }>(opts: T, needed: boolean, consent: boolean, base = false): T {
  return { ...opts, allowUnencrypted: base || (needed && consent) }
}

/**
 * The connect / test prompt's note: a simple bind over plain LDAP sends the
 * bind password in cleartext (NTLM / Kerberos do not; their own warnings
 * are in the connection dialog). '' when there is nothing to say.
 */
export function connectCleartextNote(authMethod: string | undefined, tlsMode: string | undefined): string {
  return (authMethod ?? 'simple') === 'simple' && (tlsMode ?? 'none') === 'none' ? UNENCRYPTED_RISK : ''
}
