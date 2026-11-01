/**
 * Wails wrapper of BrowserService.GetRootDSEAll (Go services/serverinfo_view.go):
 * the complete RootDSE for the Server Info view.
 */
import { getBinding } from './wails';
import type { LDAPEntry } from '../types/ldap';

/** Every RootDSE attribute of the connected server (read fresh). Rejects with the server's message. */
export async function GetRootDSEAll(profileID: string): Promise<LDAPEntry | null> {
  const svc = getBinding('BrowserService');
  if (svc?.GetRootDSEAll) return (await svc.GetRootDSEAll(profileID)) ?? null;
  if (svc?.GetRootDSE) return (await svc.GetRootDSE(profileID)) ?? null;
  return null;
}
