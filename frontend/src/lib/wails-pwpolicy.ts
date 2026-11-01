/**
 * Wails wrappers for the password storage policy (issue #1): policy lookup,
 * write planning (confirmation / "ask" decision) and the entry writes that
 * carry per-write password decisions (EditorService).
 */
import { getBinding } from './wails'
import type { AttributeChange, LDAPAttribute } from '../types/ldap'
import type {
  EffectivePasswordPolicy, PasswordPolicyCatalog, PasswordWriteOptions, PasswordWritePlan, PasswordWritePlanRequest,
  PasswordWriteReport,
} from '../types/passwordPolicy'

function requireMethod(method: string): (...args: any[]) => Promise<any> {
  const svc = getBinding('EditorService');
  if (svc?.[method]) return svc[method];
  throw new Error('Not running under Wails: entry writes are unavailable');
}

/** Client-side schemes and default policy per server type (connection dialog). Null outside Wails. */
export async function GetPasswordPolicyCatalog(): Promise<PasswordPolicyCatalog | null> {
  const svc = getBinding('EditorService');
  if (svc?.GetPasswordPolicyCatalog) return svc.GetPasswordPolicyCatalog();
  return null;
}

/** Effective password storage policy of a connected profile. Null outside Wails. */
export async function GetPasswordPolicy(profileID: string): Promise<EffectivePasswordPolicy | null> {
  const svc = getBinding('EditorService');
  if (svc?.GetPasswordPolicy) return svc.GetPasswordPolicy(profileID);
  return null;
}

/** What the policy does with the password values of a write, without writing. Null outside Wails. */
export async function PlanPasswordWrite(profileID: string, req: PasswordWritePlanRequest): Promise<PasswordWritePlan | null> {
  const svc = getBinding('EditorService');
  if (svc?.PlanPasswordWrite) return svc.PlanPasswordWrite(profileID, req);
  return null;
}

/** CreateEntry with password decisions; the report says how userPassword was stored (null without passwords). */
export async function CreateEntryWithOptions(
  profileID: string, dn: string, attributes: LDAPAttribute[], opts: PasswordWriteOptions,
): Promise<PasswordWriteReport | null> {
  return requireMethod('CreateEntryWithOptions')(profileID, dn, attributes, opts);
}

/** ModifyEntry (one atomic request) with password decisions; see CreateEntryWithOptions. */
export async function ModifyEntryWithOptions(
  profileID: string, dn: string, changes: AttributeChange[], opts: PasswordWriteOptions,
): Promise<PasswordWriteReport | null> {
  return requireMethod('ModifyEntryWithOptions')(profileID, dn, changes, opts);
}
