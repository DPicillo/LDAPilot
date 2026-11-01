/**
 * Wails wrappers for the tree/search features (BrowserService, SearchService).
 */
import { getBinding } from './wails'

/**
 * Base DNs the tree search must search (subtree) to cover what the tree
 * shows: for Active Directory the base DN root and every domain in the tree,
 * otherwise the profile base DN. Empty when not running under Wails.
 */
export async function GetTreeSearchBases(profileID: string): Promise<string[]> {
  const svc = getBinding('BrowserService');
  if (svc?.GetTreeSearchBases) return (await svc.GetTreeSearchBases(profileID)) || [];
  return [];
}

/**
 * Validates an LDAP filter on the server (SearchService.ValidateFilter).
 * Resolves to null when the filter is valid, else to the error message.
 */
export async function checkFilter(filter: string): Promise<string | null> {
  const svc = getBinding('SearchService');
  if (!svc?.ValidateFilter) return null;
  try {
    await svc.ValidateFilter(filter);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Invalid LDAP filter';
    return msg || 'Invalid LDAP filter';
  }
}
