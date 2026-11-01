/**
 * Pure logic of the New Entry dialog (LIFE-01/02): templates per server
 * type, name derivations (ADUC-style user names, logon names, uid, AD
 * computer DNS name, AD group type), schema helpers for the object class
 * picker and MUST/MAY rows, the remembered template and the result summary
 * of the AD user sequence. Imports only `.ts` modules (node tests).
 */
import { escapeDNValue, parseRDN, splitDN } from '../../lib/dn.ts'
import { suggestSAMAccountName, suggestUid } from '../../lib/entryChanges.ts'
import type { SchemaObjectClass } from '../../types/ldap'

/** Template preselected by the "New ▸" commands (NewEntryDialog initialTemplate). */
export type NewEntryTemplate = 'ou' | 'user' | 'group' | 'computer' | 'contact' | 'container' | 'custom'
export type TemplateId = NewEntryTemplate | 'posixUser' | 'posixGroup'

export interface TemplateDef {
  id: TemplateId
  /** Select label. */
  label: string
  /** Title noun: "New <noun> in <parent>". */
  noun: string
  objectClasses: string[]
  rdnAttr: string
}

/** AD: ADUC defaults (global security group, workstation trust account). */
export const AD_TEMPLATES: TemplateDef[] = [
  { id: 'user', label: 'User', noun: 'User', objectClasses: ['top', 'person', 'organizationalPerson', 'user'], rdnAttr: 'cn' },
  { id: 'group', label: 'Group', noun: 'Group', objectClasses: ['top', 'group'], rdnAttr: 'cn' },
  { id: 'computer', label: 'Computer', noun: 'Computer', objectClasses: ['top', 'person', 'organizationalPerson', 'user', 'computer'], rdnAttr: 'cn' },
  { id: 'contact', label: 'Contact', noun: 'Contact', objectClasses: ['top', 'person', 'organizationalPerson', 'contact'], rdnAttr: 'cn' },
  { id: 'ou', label: 'Organizational Unit', noun: 'Organizational Unit', objectClasses: ['top', 'organizationalUnit'], rdnAttr: 'ou' },
  { id: 'container', label: 'Container', noun: 'Container', objectClasses: ['top', 'container'], rdnAttr: 'cn' },
  { id: 'custom', label: 'Custom…', noun: 'Entry', objectClasses: ['top'], rdnAttr: 'cn' },
]

export const LDAP_TEMPLATES: TemplateDef[] = [
  { id: 'user', label: 'User (inetOrgPerson)', noun: 'User', objectClasses: ['top', 'person', 'organizationalPerson', 'inetOrgPerson'], rdnAttr: 'uid' },
  { id: 'posixUser', label: 'POSIX User', noun: 'POSIX User', objectClasses: ['top', 'person', 'organizationalPerson', 'inetOrgPerson', 'posixAccount', 'shadowAccount'], rdnAttr: 'uid' },
  { id: 'group', label: 'Group (groupOfNames)', noun: 'Group', objectClasses: ['top', 'groupOfNames'], rdnAttr: 'cn' },
  { id: 'posixGroup', label: 'POSIX Group', noun: 'POSIX Group', objectClasses: ['top', 'posixGroup'], rdnAttr: 'cn' },
  { id: 'computer', label: 'Computer (device)', noun: 'Computer', objectClasses: ['top', 'device'], rdnAttr: 'cn' },
  { id: 'contact', label: 'Contact (no login)', noun: 'Contact', objectClasses: ['top', 'person', 'organizationalPerson', 'inetOrgPerson'], rdnAttr: 'cn' },
  { id: 'ou', label: 'Organizational Unit', noun: 'Organizational Unit', objectClasses: ['top', 'organizationalUnit'], rdnAttr: 'ou' },
  // objectClasses/rdnAttr are resolved from the schema (ldapContainerClass).
  { id: 'container', label: 'Container', noun: 'Container', objectClasses: ['top', 'organizationalRole'], rdnAttr: 'cn' },
  { id: 'custom', label: 'Custom…', noun: 'Entry', objectClasses: ['top'], rdnAttr: 'cn' },
]

/**
 * The LDAP "Container" class: organizationalRole (cn) when the schema has
 * it, else organizationalUnit (ou). AD's `container` class exists on
 * neither OpenLDAP nor 389DS.
 */
export function ldapContainerClass(schemaClassNames: ReadonlySet<string>): { objectClasses: string[]; rdnAttr: string } {
  return schemaClassNames.size === 0 || schemaClassNames.has('organizationalrole')
    ? { objectClasses: ['top', 'organizationalRole'], rdnAttr: 'cn' }
    : { objectClasses: ['top', 'organizationalUnit'], rdnAttr: 'ou' }
}

/**
 * Object classes of the LDAP "POSIX Group" template. posixGroup is
 * structural in OpenLDAP's nis schema but auxiliary in rfc2307bis and in
 * 389DS's rfc2307compat schema: an entry needs a structural class then, so
 * groupOfNames (what 389DS's dsidm uses; its MUST rows follow) or
 * namedObject is added.
 */
export function ldapPosixGroupClasses(schemaOCs: SchemaObjectClass[]): string[] {
  const byName = classIndex(schemaOCs)
  const pg = byName.get('posixgroup')
  if (!pg || pg.kind !== 'auxiliary') return ['top', 'posixGroup']
  for (const name of ['groupofnames', 'namedobject']) {
    const oc = byName.get(name)
    if (oc && oc.kind === 'structural') return ['top', oc.name, pg.name]
  }
  return ['top', pg.name]
}

/** Classes of a template that the schema knows (all of them when the schema is not loaded). */
export function classesInSchema(classes: string[], schemaClassNames: ReadonlySet<string>): string[] {
  if (schemaClassNames.size === 0) return classes
  return classes.filter((c) => schemaClassNames.has(c.toLowerCase()))
}

/** Default template: the requested one, else the last used one (never OU), else Custom…. */
export function defaultTemplate(initial: TemplateId | undefined, lastUsed: string | null, available: TemplateDef[]): TemplateId {
  const has = (id: string | null | undefined) => !!id && available.some((t) => t.id === id)
  if (initial && has(initial)) return initial
  if (lastUsed && lastUsed !== 'ou' && has(lastUsed)) return lastUsed as TemplateId
  return 'custom'
}

const LAST_TEMPLATE_KEY = 'ldapilot.newEntry.lastTemplate.'

/** Last template created with, per server family ('ad' | 'ldap'); null without storage. */
export function loadLastTemplate(family: 'ad' | 'ldap'): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(LAST_TEMPLATE_KEY + family)
  } catch {
    return null
  }
}

export function saveLastTemplate(family: 'ad' | 'ldap', id: TemplateId) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LAST_TEMPLATE_KEY + family, id)
  } catch {
    /* private window: the default is Custom… then */
  }
}

/** "New User in ux-life" (parent shown by its unescaped first RDN value). */
export function newEntryTitle(noun: string, parentDN: string): string {
  const first = splitDN(parentDN)[0]
  const name = first ? parseRDN(first).value || first : ''
  return name ? `New ${noun} in ${name}` : `New ${noun}`
}

// --- Name derivations -----------------------------------------------------------

/** ADUC full name: "First I. Last" (initials get a dot unless they end with one). */
export function fullNameOf(first: string, initials: string, last: string): string {
  const i = initials.trim()
  return [first.trim(), i ? (i.endsWith('.') ? i : `${i}.`) : '', last.trim()].filter(Boolean).join(' ')
}

/** Logon name suggestion: "first.last" folded to lowercase ASCII (or the full name when both are empty). */
export function logonNameOf(first: string, last: string, fallback = ''): string {
  const both = [first.trim(), last.trim()].filter(Boolean).join(' ')
  return suggestUid(both || fallback)
}

/** sAMAccountName for a logon name (max. 20 characters, invalid characters removed). */
export function samFromLogon(logon: string): string {
  return suggestSAMAccountName(logon)
}

/** AD computer: sAMAccountName "NAME$" (NetBIOS name, 15 characters). */
export function computerSAM(name: string): string {
  return suggestSAMAccountName(name.toUpperCase(), true)
}

/** DNS name of the DC= components of a DN ("OU=x,DC=ad,DC=example" → "ad.example"). */
export function dnsDomainOf(dn: string): string {
  return splitDN(dn)
    .map((rdn) => parseRDN(rdn))
    .filter((r) => r.attr.toLowerCase() === 'dc' && r.value)
    .map((r) => r.value)
    .join('.')
}

/** dNSHostName of an AD computer: lower-case name + domain ("WS01" → "ws01.ad.example.org"). */
export function computerDNSHostName(name: string, domain: string): string {
  const host = name.trim().replace(/\$+$/, '').toLowerCase()
  return host && domain ? `${host}.${domain}` : ''
}

export type GroupScope = 'domainLocal' | 'global' | 'universal'
export type GroupKind = 'security' | 'distribution'

const SCOPE_BITS: Record<GroupScope, number> = { global: 0x2, domainLocal: 0x4, universal: 0x8 }

/** AD groupType (signed 32-bit, as AD stores it): scope bit | 0x80000000 for security groups. */
export function adGroupType(scope: GroupScope, kind: GroupKind): number {
  const v = SCOPE_BITS[scope] | (kind === 'security' ? 0x80000000 : 0)
  return v | 0
}

/** Home directory of a POSIX user: /home/<uid>. */
export function homeDirectoryOf(uid: string): string {
  return uid.trim() ? `/home/${uid.trim()}` : ''
}

/** memberUid values typed as a list ("a, b c" → ["a", "b", "c"]), unique, in order. */
export function parseUidList(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of text.split(/[\s,;]+/)) {
    const u = v.trim()
    if (u && !seen.has(u.toLowerCase())) {
      seen.add(u.toLowerCase())
      out.push(u)
    }
  }
  return out
}

/** The DN of a new entry: <rdnAttr>=<escaped value>,<parent> ('' without a value). */
export function newEntryDN(rdnAttr: string, value: string, parentDN: string): string {
  const v = value.trim()
  if (!v || !rdnAttr.trim()) return ''
  const rdn = `${rdnAttr.trim()}=${escapeDNValue(v)}`
  return parentDN ? `${rdn},${parentDN}` : rdn
}

// --- Schema helpers ------------------------------------------------------------

/** Attributes the server sets itself: never offered as rows and never a reason to block. */
export const SERVER_MANAGED = new Set([
  'objectclass', 'ntsecuritydescriptor', 'instancetype', 'objectcategory', 'objectsid', 'objectguid', 'samaccounttype',
  'distinguishedname', 'name', 'whencreated', 'whenchanged', 'usncreated', 'usnchanged', 'creatorsname', 'modifiersname',
  'createtimestamp', 'modifytimestamp', 'entryuuid', 'entrydn', 'structuralobjectclass', 'subschemasubentry', 'hassubordinates',
])

function classIndex(schemaOCs: SchemaObjectClass[]) {
  return new Map(schemaOCs.map((o) => [o.name.toLowerCase(), o]))
}

function collect(classes: string[], schemaOCs: SchemaObjectClass[], pick: (o: SchemaObjectClass) => string[] | undefined): string[] {
  const byName = classIndex(schemaOCs)
  const out = new Map<string, string>()
  const seen = new Set<string>()
  const visit = (name: string) => {
    const k = name.toLowerCase()
    if (seen.has(k)) return
    seen.add(k)
    const oc = byName.get(k)
    if (!oc) return
    for (const a of pick(oc) ?? []) if (!out.has(a.toLowerCase())) out.set(a.toLowerCase(), a)
    for (const sup of oc.superClass ?? []) visit(sup)
  }
  classes.forEach(visit)
  return [...out.values()]
}

/** MUST attributes of the classes including their SUP chain. */
export function mustAttributes(classes: string[], schemaOCs: SchemaObjectClass[]): string[] {
  return collect(classes, schemaOCs, (o) => o.must)
}

/** MAY attributes of the classes including their SUP chain (MUST ones left out). */
export function mayAttributes(classes: string[], schemaOCs: SchemaObjectClass[]): string[] {
  const must = new Set(mustAttributes(classes, schemaOCs).map((a) => a.toLowerCase()))
  return collect(classes, schemaOCs, (o) => o.may).filter((a) => !must.has(a.toLowerCase()))
}

/** Schema classes of a kind ('structural' | 'auxiliary'), sorted by name. */
export function classesOfKind(schemaOCs: SchemaObjectClass[], kind: 'structural' | 'auxiliary'): string[] {
  return schemaOCs.filter((o) => o.kind === kind).map((o) => o.name).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

/**
 * Object classes for a structural class plus auxiliaries: the structural
 * class with its SUP chain ("top" first), then the auxiliaries, without
 * duplicates.
 */
export function classChain(structural: string, auxiliaries: string[], schemaOCs: SchemaObjectClass[]): string[] {
  const byName = classIndex(schemaOCs)
  const chain: string[] = []
  const seen = new Set<string>()
  const visit = (name: string) => {
    const k = name.toLowerCase()
    if (!k || seen.has(k)) return
    seen.add(k)
    const oc = byName.get(k)
    for (const sup of oc?.superClass ?? []) visit(sup)
    chain.push(oc?.name ?? name)
  }
  visit(structural)
  for (const a of auxiliaries) {
    if (!seen.has(a.toLowerCase())) {
      seen.add(a.toLowerCase())
      chain.push(byName.get(a.toLowerCase())?.name ?? a)
    }
  }
  return chain
}

// --- The entry a form describes ------------------------------------------------

/** Form fields of the New Entry dialog; derived ones follow their sources until typed into. */
export type FieldKey =
  | 'first' | 'initials' | 'last' | 'fullName' | 'logon' | 'upnSuffix' | 'sam' | 'uid' | 'mail' | 'phone'
  | 'name' | 'description' | 'dnsHostName' | 'uidNumber' | 'gidNumber' | 'home' | 'shell' | 'memberUids'
  | 'rdnAttr' | 'structural'

export interface NewEntryForm {
  template: TemplateId
  /** RDN attribute of the template (TemplateDef.rdnAttr). */
  templateRdnAttr: string
  isAD: boolean
  parentDN: string
  /** Typed values. */
  fields: Partial<Record<FieldKey, string>>
  /** Fields typed into (a derived field keeps its typed value, also when empty). */
  touched: Partial<Record<FieldKey, boolean>>
  /** LDAP / POSIX users: the RDN attribute. */
  ldapRdn: 'uid' | 'cn'
  scope: GroupScope
  groupKind: GroupKind
  /** userPassword of LDAP accounts (AD users get theirs via SetPassword). */
  password: string
  /** groupOfNames members (DNs). */
  members: string[]
  /** AD UPN suffixes (connection's domain first). */
  upnSuffixes: string[]
  posixIDs: { uid: number; gid: number; primary: number } | null
  /** Custom…: the RDN attribute offered first (cn, ou, uid, … of the class's MUST/MAY). */
  customRdnDefault: string
  /** Values of the "Required attributes" rows. */
  mustValues: Record<string, string>
  /** "More attributes" rows. */
  extraRows: { name: string; value: string }[]
}

export interface NewEntryPlan {
  rdnAttr: string
  rdnValue: string
  /** Attributes without objectClass (values trimmed, empty ones left out). */
  attrs: Record<string, string[]>
}

const raw = (f: NewEntryForm, key: FieldKey) => f.fields[key] ?? ''

/** Value of a form field: typed, else derived from other fields / defaults. */
export function newEntryFieldValue(f: NewEntryForm, key: FieldKey): string {
  if (f.touched[key]) return raw(f, key)
  const id = f.template
  switch (key) {
    case 'fullName': return fullNameOf(raw(f, 'first'), raw(f, 'initials'), raw(f, 'last'))
    case 'logon': return logonNameOf(raw(f, 'first'), raw(f, 'last'), newEntryFieldValue(f, 'fullName'))
    case 'upnSuffix': return f.upnSuffixes[0] || dnsDomainOf(f.parentDN)
    case 'sam':
      if (id === 'computer') return computerSAM(raw(f, 'name'))
      if (id === 'group') return suggestSAMAccountName(raw(f, 'name'))
      return samFromLogon(newEntryFieldValue(f, 'logon'))
    case 'uid': return logonNameOf(raw(f, 'first'), raw(f, 'last'), raw(f, 'fullName'))
    case 'home': return homeDirectoryOf(newEntryFieldValue(f, 'uid'))
    case 'shell': return '/bin/bash'
    case 'dnsHostName': return computerDNSHostName(raw(f, 'name'), dnsDomainOf(f.parentDN))
    case 'uidNumber': return f.posixIDs ? String(f.posixIDs.uid) : ''
    case 'gidNumber':
      return f.posixIDs ? String(id === 'posixUser' ? f.posixIDs.primary || f.posixIDs.gid : f.posixIDs.gid) : ''
    case 'rdnAttr': return f.customRdnDefault || 'cn'
    default: return raw(f, key)
  }
}

/**
 * The entry a New Entry form describes: RDN and attributes (objectClass
 * comes from the class chips). AD users are created disabled (514) with
 * cn/displayName = full name, sAMAccountName and UPN; LDAP/POSIX users get
 * cn, sn (last name, else the full name), uid and the typed userPassword;
 * POSIX users their IDs, home and shell; contacts no login; AD groups
 * sAMAccountName + groupType, groupOfNames its members, POSIX groups
 * gidNumber + memberUid; AD computers NAME$, UAC 4128 and dNSHostName. The
 * "Required attributes" rows fill MUST attributes the form does not set,
 * "More attributes" rows add values; the RDN value is always a value of
 * its attribute.
 */
export function planNewEntry(f: NewEntryForm): NewEntryPlan {
  const id = f.template
  const val = (key: FieldKey) => newEntryFieldValue(f, key)
  const a: Record<string, string[]> = {}
  const put = (name: string, v: string | string[] | undefined) => {
    const values = (Array.isArray(v) ? v : [v ?? '']).map((x) => x.trim()).filter(Boolean)
    if (values.length) a[name] = values
  }
  let rdnAttr = f.templateRdnAttr || 'cn'
  let rdnValue = ''
  switch (id) {
    case 'user':
    case 'contact':
    case 'posixUser': {
      const full = val('fullName') || val('uid')
      put('givenName', raw(f, 'first'))
      put('sn', raw(f, 'last') || (id !== 'user' || !f.isAD ? full : ''))
      put('mail', raw(f, 'mail'))
      put('telephoneNumber', raw(f, 'phone'))
      put('description', raw(f, 'description'))
      if (f.isAD) {
        rdnAttr = 'cn'
        rdnValue = full
        put('displayName', full)
        if (raw(f, 'initials')) put('initials', raw(f, 'initials').replace(/\.$/, ''))
        if (id === 'user') {
          put('sAMAccountName', val('sam'))
          if (val('logon')) put('userPrincipalName', `${val('logon')}@${val('upnSuffix')}`)
          // NORMAL_ACCOUNT | ACCOUNTDISABLE: without it AD/Samba add PASSWD_NOTREQD (546),
          // which would stay set after enabling.
          put('userAccountControl', '514')
        }
      } else if (id === 'contact') {
        rdnAttr = 'cn'
        rdnValue = full
        put('cn', full)
      } else {
        rdnAttr = f.ldapRdn
        rdnValue = f.ldapRdn === 'uid' ? val('uid') : full
        put('cn', full)
        put('uid', val('uid'))
        if (id === 'posixUser') {
          put('uidNumber', val('uidNumber'))
          put('gidNumber', val('gidNumber'))
          put('homeDirectory', val('home'))
          put('loginShell', val('shell'))
        }
        if (f.password) a.userPassword = [f.password]
      }
      break
    }
    case 'group':
      rdnAttr = 'cn'
      rdnValue = raw(f, 'name')
      put('description', raw(f, 'description'))
      if (f.isAD) {
        put('sAMAccountName', val('sam'))
        put('groupType', String(adGroupType(f.scope, f.groupKind)))
      } else {
        put('member', f.members)
      }
      break
    case 'posixGroup':
      rdnAttr = 'cn'
      rdnValue = raw(f, 'name')
      put('gidNumber', val('gidNumber'))
      put('memberUid', parseUidList(raw(f, 'memberUids')))
      put('description', raw(f, 'description'))
      break
    case 'computer':
      rdnAttr = 'cn'
      rdnValue = f.isAD ? raw(f, 'name').toUpperCase() : raw(f, 'name')
      put('description', raw(f, 'description'))
      if (f.isAD) {
        put('sAMAccountName', val('sam'))
        put('userAccountControl', '4128')
        put('dNSHostName', val('dnsHostName'))
      }
      break
    case 'custom':
      rdnAttr = val('rdnAttr')
      rdnValue = raw(f, 'name')
      break
    default:
      rdnValue = raw(f, 'name')
      put('description', raw(f, 'description'))
  }
  // MUST rows the form does not fill, then the extra rows.
  for (const [name, v] of Object.entries(f.mustValues)) if (!a[name] && v.trim()) a[name] = [v.trim()]
  for (const r of f.extraRows) {
    const name = r.name.trim()
    if (name && r.value.trim()) a[name] = [...(a[name] ?? []), r.value]
  }
  const value = rdnValue.trim()
  if (value) {
    const key = Object.keys(a).find((k) => k.toLowerCase() === rdnAttr.toLowerCase())
    if (key) {
      if (!a[key].some((v) => v === value)) a[key] = [value, ...a[key]]
    } else a[rdnAttr] = [value]
  }
  return { rdnAttr, rdnValue: value, attrs: a }
}

// --- AD user sequence ------------------------------------------------------------

export type StepState = 'done' | 'skipped' | 'failed'

export interface CreateStep {
  /** 'create' | 'password' | 'enable' | 'groups' | 'members' */
  id: string
  state: StepState
  /** Short text for the summary ("password set", "added to 2 groups"). */
  text: string
  /** Why it was skipped or failed. */
  detail?: string
}

/**
 * One result summary of a create sequence: success when every step worked,
 * otherwise a warning that lists what was skipped or failed (the entry
 * itself exists).
 */
export function summarizeCreate(name: string, steps: CreateStep[]): { level: 'success' | 'warning'; message: string; detail?: string } {
  const done = steps.filter((s) => s.state === 'done' && s.id !== 'create').map((s) => s.text)
  const problems = steps.filter((s) => s.state !== 'done')
  const message = [`${name} created`, ...done].join(' · ')
  if (problems.length === 0) return { level: 'success', message }
  return {
    level: 'warning',
    message: `${message} — ${problems.length} step${problems.length === 1 ? '' : 's'} not done`,
    detail: problems.map((p) => `${p.text}: ${p.detail ?? (p.state === 'skipped' ? 'skipped' : 'failed')}`).join('\n'),
  }
}

const ALL_FIELD_KEYS: FieldKey[] = [
  'first', 'initials', 'last', 'fullName', 'logon', 'upnSuffix', 'sam', 'uid', 'mail', 'phone',
  'name', 'description', 'dnsHostName', 'uidNumber', 'gidNumber', 'home', 'shell', 'memberUids',
]

/**
 * Attributes (lower case) the template's own fields fill — Last name → sn,
 * Full name → cn, Logon → uid, Home → homeDirectory, …: the form computed
 * with every field typed. The "Required attributes" rows leave them out, so
 * no attribute gets two inputs (M-02).
 */
export function formMappedAttributes(f: NewEntryForm): Set<string> {
  const fields: Partial<Record<FieldKey, string>> = {}
  for (const k of ALL_FIELD_KEYS) fields[k] = k === 'uidNumber' || k === 'gidNumber' ? '1000' : 'x'
  const filled: NewEntryForm = {
    ...f,
    fields: { ...fields, rdnAttr: f.fields.rdnAttr, structural: f.fields.structural },
    touched: Object.fromEntries(ALL_FIELD_KEYS.map((k) => [k, true])) as Partial<Record<FieldKey, boolean>>,
    password: f.password || 'x',
    members: f.members.length ? f.members : ['cn=x'],
    mustValues: {},
    extraRows: [],
  }
  const p = planNewEntry(filled)
  return new Set([p.rdnAttr.toLowerCase(), ...Object.keys(p.attrs).map((k) => k.toLowerCase())])
}
