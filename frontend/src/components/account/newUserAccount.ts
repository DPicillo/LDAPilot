/**
 * Account options of the New User dialog on LDAP servers (FIN-W-03) and the
 * DN spelling of new entries (FIN-W-05). Pure helpers (node-tested in
 * tests/accounts.newuser.test.ts) plus the binding of the policy read.
 *
 * "User must change password at next logon":
 * - OpenLDAP (ppolicy): `pwdReset: TRUE` in the same add. The overlay only
 *   enforces it when the effective policy has pwdMustChange TRUE, and a new
 *   entry gets the default policy (it has no pwdPolicySubentry). Offered and
 *   ticked when the policy demands it; offered unticked when the policy is
 *   not readable; shown disabled with the reason when the policy ignores it.
 * - 389DS: the password policy decides. With passwordMustChange on the server
 *   marks a password an administrator sets (passwordExpirationTime
 *   19700101000000Z) by itself; unticking clears that mark right after the
 *   create (the account action "Clear must change"). With it off the option
 *   is shown disabled with the reason.
 */
import { getBinding } from '../../lib/wails.ts'
import type { AccountPolicy } from '../../types/account'
import type { LDAPAttribute, ServerType } from '../../types/ldap'

export interface MustChangeOffer {
  /** The checkbox is shown (else `note` alone, when set). */
  shown: boolean
  /** The admin can change it (else it shows what the policy decides). */
  enabled: boolean
  /** Initial state. */
  checked: boolean
  /** Below the checkbox: what it does or why it is not available. */
  note?: string
  /** How a choice is applied: in the add (`pwdReset`), by the 389DS policy (cleared after the create when unticked), not at all. */
  mode: 'pwdReset' | 'dsPolicy' | 'none'
}

const NONE: MustChangeOffer = { shown: false, enabled: false, checked: false, mode: 'none' }

function policyName(p: AccountPolicy): string {
  return p.name || p.dn || 'the password policy'
}

/**
 * The "must change password" option for a new LDAP user. `policy` is the
 * policy of the new account (GetNewAccountPolicy); undefined while it loads,
 * null when it could not be read.
 */
export function newUserMustChange(serverType: ServerType | null | undefined, policy: AccountPolicy | null | undefined): MustChangeOffer {
  if (policy === undefined) return NONE
  if (serverType === 'openldap') {
    if (policy?.source === 'none') {
      return { shown: true, enabled: false, checked: false, mode: 'none', note: 'No password policy (ppolicy) applies to new entries here, so OpenLDAP cannot ask for a new password.' }
    }
    if (policy?.readable && !policy.mustChangeEnforced) {
      return { shown: true, enabled: false, checked: false, mode: 'none', note: `The password policy ${policyName(policy)} has pwdMustChange FALSE, so OpenLDAP ignores pwdReset.` }
    }
    if (policy?.readable) {
      return { shown: true, enabled: true, checked: true, mode: 'pwdReset', note: `Sets pwdReset: TRUE in the new entry; the password policy ${policyName(policy)} enforces it (pwdMustChange TRUE).` }
    }
    return { shown: true, enabled: true, checked: false, mode: 'pwdReset', note: 'Sets pwdReset: TRUE in the new entry. Whether OpenLDAP enforces it depends on the password policy (pwdMustChange), which is not readable with this connection.' }
  }
  if (serverType === '389ds') {
    if (policy?.readable && policy.mustChangeEnforced) {
      return { shown: true, enabled: true, checked: true, mode: 'dsPolicy', note: `389 Directory Server's password policy requires it (${policyName(policy)}: passwordMustChange on). Untick to clear the mark right after the user is created.` }
    }
    if (policy?.readable) {
      return { shown: true, enabled: false, checked: false, mode: 'none', note: `389 Directory Server asks for a new password only when the password policy has passwordMustChange on (${policyName(policy)}: off).` }
    }
    return { ...NONE, note: '389 Directory Server\'s password policy (passwordMustChange) decides whether the user must change the password; it is not readable with this connection.' }
  }
  return NONE
}

/** Attributes the add carries for the choice (OpenLDAP: pwdReset TRUE; only with a password). */
export function mustChangeAttributes(offer: MustChangeOffer, checked: boolean, hasPassword: boolean): LDAPAttribute[] {
  if (offer.mode !== 'pwdReset' || !offer.enabled || !checked || !hasPassword) return []
  return [{ name: 'pwdReset', values: ['TRUE'], binary: false }]
}

/** 389DS: the follow-up after the create (`clear` = remove the server's must-change mark), or null. */
export function mustChangeFollowUp(offer: MustChangeOffer, checked: boolean, hasPassword: boolean): 'clear' | null {
  return offer.mode === 'dsPolicy' && offer.enabled && !checked && hasPassword ? 'clear' : null
}

/**
 * Attribute types Active Directory spells in upper case in every DN it
 * returns (CN=…,OU=…,DC=…).
 */
const AD_UPPER_TYPES = new Set(['cn', 'ou', 'dc', 'o', 'l', 'st', 'c', 'street'])

/**
 * The RDN attribute type as the server spells it in DNs: AD upper-cases the
 * standard short names ("CN=Ann Lee,OU=Sales,DC=…"), other servers keep the
 * template's spelling.
 */
export function serverRdnType(attr: string, serverType: ServerType | null | undefined): string {
  const a = attr.trim()
  return serverType === 'ad' && AD_UPPER_TYPES.has(a.toLowerCase()) ? a.toUpperCase() : a
}

/**
 * The password policy an account created below parentDN gets
 * (BrowserService.GetNewAccountPolicy); null outside Wails or for server
 * types without account policies.
 */
export async function GetNewAccountPolicy(profileId: string, parentDN: string): Promise<AccountPolicy | null> {
  const svc = getBinding('BrowserService')
  if (svc?.GetNewAccountPolicy) return svc.GetNewAccountPolicy(profileId, parentDN)
  return null
}
