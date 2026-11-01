/**
 * Wails wrappers for the password feature (EditorService password methods).
 */
import { getBinding } from './wails'
import type { PasswordChangeRequest, PasswordChangeResult, PasswordContext } from '../types/password'

/** Server type, TLS, Password Modify/ppolicy support, stored scheme and account state of an entry. */
export async function GetPasswordContext(profileID: string, dn: string): Promise<PasswordContext | null> {
  const svc = getBinding('EditorService');
  if (svc?.GetPasswordContext) return svc.GetPasswordContext(profileID, dn);
  return null;
}

/** Resets a password (unicodePwd, RFC 3062 Password Modify or hashed userPassword); audited without the password. */
export async function SetPassword(profileID: string, req: PasswordChangeRequest): Promise<PasswordChangeResult> {
  const svc = getBinding('EditorService');
  if (svc?.SetPassword) return svc.SetPassword(profileID, req);
  throw new Error('Not running under Wails: password change unavailable');
}
