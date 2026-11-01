/**
 * One object-type resolver for tree, lists, results, tabs, palette and the
 * command registry (SPEC 6.4). Colour comes from the matching text-oc-* token.
 */
import { Box, Contact, FileText, Folder, Globe, Monitor, User, UserCog, Users } from 'lucide-react'
import type { IconType } from './Button'

export type ObjectKind = 'user' | 'group' | 'computer' | 'contact' | 'service' | 'ou' | 'domain' | 'container' | 'other'

/** Object classes that give an LDAP person a login (an account, not a contact). */
const ACCOUNT_CLASSES = ['user', 'posixaccount', 'shadowaccount', 'account', 'sambasamaccount', 'krbprincipalaux', 'uidobject']
/** Attributes that give an LDAP person a login. */
const LOGIN_ATTRIBUTES = ['uid', 'userpassword', 'authpassword', 'krbprincipalname', 'sambantpassword']

/**
 * Priority: service (msDS-(G)MSA) > computer (AD computer, LDAP device /
 * ipHost) > contact > group > user/person/inetOrgPerson/posixAccount >
 * organizationalUnit > domain/domainDNS/dcObject > organization > container
 * (incl. the Configuration and Schema naming contexts). An `o=` entry with
 * dcObject is named by its dc (OpenLDAP suffix): a domain.
 * Service accounts are checked BEFORE computer because their objectClass chain
 * contains `computer` (top/person/organizationalPerson/user/computer/msDS-GMSA);
 * otherwise 'service' could never match an AD object.
 *
 * `presentAttributes` (names the entry is known to have; undefined = unknown):
 * an LDAP person (inetOrgPerson / organizationalPerson / person) without an
 * account class, uid or a password is a contact (the "Contact" templates);
 * while the attributes are unknown it stays a user.
 */
export function resolveObjectKind(objectClass: readonly string[] | undefined | null, presentAttributes?: readonly string[] | null): ObjectKind {
  if (!objectClass || objectClass.length === 0) return 'other'
  const oc = new Set(objectClass.map((c) => c.toLowerCase()))
  if (oc.has('msds-groupmanagedserviceaccount') || oc.has('msds-managedserviceaccount') || oc.has('msds-delegatedmanagedserviceaccount')) return 'service'
  if (oc.has('computer') || oc.has('device') || oc.has('iphost')) return 'computer'
  if (oc.has('contact')) return 'contact'
  if (oc.has('group') || oc.has('groupofnames') || oc.has('groupofuniquenames') || oc.has('posixgroup') || oc.has('groupofmembers')) return 'group'
  if (oc.has('user') || oc.has('posixaccount')) return 'user'
  if (oc.has('person') || oc.has('inetorgperson') || oc.has('organizationalperson')) {
    if (presentAttributes && !ACCOUNT_CLASSES.some((c) => oc.has(c))) {
      const have = new Set(presentAttributes.map((a) => a.toLowerCase().split(';')[0]))
      if (!LOGIN_ATTRIBUTES.some((a) => have.has(a))) return 'contact'
    }
    return 'user'
  }
  if (oc.has('organizationalunit')) return 'ou'
  // A domain component before an organization: the OpenLDAP suffix dc=demo is organization +
  // dcObject and is a domain like AD's domainDNS and 389DS's domain root, not an "Organizational
  // unit" (both are container kinds: menus, drop targets and Contents stay the same).
  if (oc.has('domain') || oc.has('domaindns') || oc.has('dcobject')) return 'domain'
  if (oc.has('organization')) return 'ou'
  // organizationalRole: what the LDAP "Container" template creates (cn=…), a container in the
  // tree, the menus and as a drop target, as the Move / Restore pickers already treat it (M-08).
  if (oc.has('container') || oc.has('builtindomain') || oc.has('lostandfound') || oc.has('nscontainer') || oc.has('configuration') || oc.has('dmd') || oc.has('organizationalrole')) return 'container'
  return 'other'
}

/**
 * Kind of a tree / list node: its object classes plus the login attributes
 * the listing read for person entries (contacts get the contact icon and
 * verbs from the first view on, M-06).
 */
export function nodeKind(node: { objectClass?: readonly string[] | null; loginAttributes?: readonly string[] | null }): ObjectKind {
  return resolveObjectKind(node.objectClass, node.loginAttributes ?? undefined)
}

/**
 * True if the entry can have an account status (enable / disable / unlock):
 * users and service accounts, AD computers and POSIX hosts; not LDAP devices
 * (`device` / `ipHost` without an account class) or contacts.
 */
export function hasAccountSemantics(kind: ObjectKind | undefined, objectClass?: readonly string[] | null): boolean {
  if (kind === 'user' || kind === 'service') return true
  if (kind !== 'computer') return false
  if (!objectClass || !objectClass.length) return true
  const oc = new Set(objectClass.map((c) => c.toLowerCase()))
  return oc.has('computer') || ACCOUNT_CLASSES.some((c) => oc.has(c))
}

/** Person-like LDAP entry whose kind depends on its attributes (resolveObjectKind's contact rule). */
export function kindNeedsAttributes(objectClass: readonly string[] | undefined | null): boolean {
  if (!objectClass?.length) return false
  const oc = new Set(objectClass.map((c) => c.toLowerCase()))
  if (oc.has('user') || oc.has('posixaccount') || oc.has('contact') || oc.has('computer') || oc.has('device')) return false
  if (ACCOUNT_CLASSES.some((c) => oc.has(c))) return false
  return oc.has('person') || oc.has('inetorgperson') || oc.has('organizationalperson')
}

/** The attributes kindNeedsAttributes asks a presence read for. */
export const KIND_ATTRIBUTES = ['uid', 'userPassword', 'authPassword', 'krbPrincipalName', 'sambaNTPassword']

export const OBJECT_KIND_ICON: Record<ObjectKind, IconType> = {
  user: User,
  group: Users,
  computer: Monitor,
  contact: Contact,
  service: UserCog,
  ou: Folder,
  domain: Globe,
  container: Box,
  other: FileText,
}

/** Text colour class of each kind (icons and labels). */
export const OBJECT_KIND_COLOR: Record<ObjectKind, string> = {
  user: 'text-oc-user',
  group: 'text-oc-group',
  computer: 'text-oc-computer',
  contact: 'text-oc-contact',
  service: 'text-oc-service',
  ou: 'text-oc-ou',
  domain: 'text-oc-domain',
  container: 'text-oc-container',
  other: 'text-muted-foreground',
}

export const OBJECT_KIND_LABEL: Record<ObjectKind, string> = {
  user: 'User',
  group: 'Group',
  computer: 'Computer',
  contact: 'Contact',
  service: 'Service account',
  ou: 'Organizational unit',
  domain: 'Domain',
  container: 'Container',
  other: 'Entry',
}

/** Badge tone of each kind. */
export const OBJECT_KIND_TONE = {
  user: 'oc-user',
  group: 'oc-group',
  computer: 'oc-computer',
  contact: 'oc-contact',
  service: 'oc-service',
  ou: 'oc-ou',
  domain: 'oc-domain',
  container: 'oc-container',
  other: 'neutral',
} as const

/** Containers open their contents by default and accept children. */
export function isContainerKind(k: ObjectKind | undefined): boolean {
  return k === 'ou' || k === 'domain' || k === 'container'
}
