/**
 * Pure helpers of the Rename dialog (node tests import them with .ts).
 */
import { escapeDNValue } from '../../lib/dn.ts'
import type { AttributeChange } from '../../types/ldap'

/** The new RDN for a plain name: "cn" + "Doe, John" → "cn=Doe\, John". */
export function renamedRDN(attr: string, value: string): string {
  return `${attr}=${escapeDNValue(value.trim())}`
}

export interface LogonNames {
  displayName: string
  sAMAccountName: string
  userPrincipalName: string
}

/**
 * Replace changes for the AD display / logon names that differ from the
 * current values (empty new values are left alone, never deleted).
 */
export function planLogonNameChanges(current: LogonNames, next: LogonNames): AttributeChange[] {
  const out: AttributeChange[] = []
  const add = (attribute: keyof LogonNames) => {
    const v = next[attribute].trim()
    if (v && v !== current[attribute]) out.push({ operation: 'replace', attribute, values: [v], binary: false })
  }
  add('displayName')
  add('sAMAccountName')
  add('userPrincipalName')
  return out
}
