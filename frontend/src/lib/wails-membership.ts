/**
 * Wails wrappers for group membership (BrowserService.Resolve* /
 * CancelMembership, EditorService.*GroupMembers / *Groups). Writes go through EditorService,
 * so read-only profiles are refused and every change is audited.
 */
import { getBinding } from './wails';
import type { MembershipChangeResult, MembershipResult } from '../types/membership';

/**
 * Groups of an entry: direct + primary, with `effective` also nested ones.
 * `requestId` identifies the call for CancelMembership. Null when not running
 * under Wails.
 */
export async function ResolveMemberOf(profileID: string, dn: string, effective: boolean, requestId = ''): Promise<MembershipResult | null> {
  const svc = getBinding('BrowserService');
  if (svc?.ResolveMemberOf) return svc.ResolveMemberOf(profileID, dn, effective, requestId);
  return null;
}

/**
 * Members of a group: direct + primary members, with `effective` also those
 * of nested groups. `requestId` identifies the call for CancelMembership.
 * Null when not running under Wails.
 */
export async function ResolveGroupMembers(profileID: string, groupDN: string, effective: boolean, requestId = ''): Promise<MembershipResult | null> {
  const svc = getBinding('BrowserService');
  if (svc?.ResolveGroupMembers) return svc.ResolveGroupMembers(profileID, groupDN, effective, requestId);
  return null;
}

/**
 * Stops the resolution started with `requestId` (all of the profile's
 * resolutions for ''); it then rejects with "search cancelled". Returns the
 * number of resolutions stopped.
 */
export async function CancelMembership(profileID: string, requestId = ''): Promise<number> {
  const svc = getBinding('BrowserService');
  if (svc?.CancelMembership) return svc.CancelMembership(profileID, requestId);
  return 0;
}

let requestCounter = 0;

/** A request ID unique within this app session. */
export function newMembershipRequestId(): string {
  requestCounter += 1;
  return `m${Date.now().toString(36)}-${requestCounter}`;
}

function unavailable(): never {
  throw new Error('Membership changes are only available in the desktop app');
}

/** Adds members to a group, one single-value modify per member. */
export async function AddGroupMembers(profileID: string, groupDN: string, memberDNs: string[]): Promise<MembershipChangeResult> {
  const svc = getBinding('EditorService');
  if (svc?.AddGroupMembers) return svc.AddGroupMembers(profileID, groupDN, memberDNs);
  return unavailable();
}

/** Removes members from a group, one single-value modify per member (a plain uid removes a memberUid). */
export async function RemoveGroupMembers(profileID: string, groupDN: string, memberDNs: string[]): Promise<MembershipChangeResult> {
  const svc = getBinding('EditorService');
  if (svc?.RemoveGroupMembers) return svc.RemoveGroupMembers(profileID, groupDN, memberDNs);
  return unavailable();
}

/** Adds the entry to several groups; the result lists group DNs. */
export async function AddToGroups(profileID: string, dn: string, groupDNs: string[]): Promise<MembershipChangeResult> {
  const svc = getBinding('EditorService');
  if (svc?.AddToGroups) return svc.AddToGroups(profileID, dn, groupDNs);
  return unavailable();
}

/** Removes the entry from several groups; the result lists group DNs. */
export async function RemoveFromGroups(profileID: string, dn: string, groupDNs: string[]): Promise<MembershipChangeResult> {
  const svc = getBinding('EditorService');
  if (svc?.RemoveFromGroups) return svc.RemoveFromGroups(profileID, dn, groupDNs);
  return unavailable();
}
