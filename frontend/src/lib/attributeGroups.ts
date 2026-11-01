/**
 * Attribute table sections (SPEC 10.2 AttributeTable, UX-11): Identity,
 * Account, Contact, Membership and System (collapsed by default), plus the
 * pure attribute helpers of the entry editor: server-managed attributes,
 * the single-value check, the add-attribute suggestions, the row menu's
 * copy / search texts, links, well-known primary groups and the compare
 * dialog's noise filter. Pure, so it is tested with node --test
 * (tests/editor.attributes.test.ts).
 */
import { escapeFilterValue } from './ldapFilter.ts'

export type AttributeGroupId = 'identity' | 'account' | 'contact' | 'membership' | 'system'

export const ATTRIBUTE_GROUPS: { id: AttributeGroupId; label: string; defaultCollapsed?: boolean }[] = [
  { id: 'identity', label: 'Identity' },
  { id: 'account', label: 'Account' },
  { id: 'contact', label: 'Contact' },
  { id: 'membership', label: 'Membership' },
  { id: 'system', label: 'System', defaultCollapsed: true },
]

const MEMBERSHIP = new Set([
  'member', 'memberof', 'uniquemember', 'memberuid', 'primarygroupid', 'ismemberof', 'groupmembership', 'nsroledn', 'nsrole',
])

const ACCOUNT = new Set([
  'useraccountcontrol', 'msds-user-account-control-computed', 'accountexpires', 'pwdlastset', 'lockouttime', 'badpwdcount',
  'badpasswordtime', 'lastlogon', 'lastlogontimestamp', 'lastlogoff', 'logoncount', 'logonhours', 'userworkstations',
  'userpassword', 'unicodepwd', 'authpassword', 'sambantpassword', 'sambalmpassword', 'sambapwdlastset', 'sambaacctflags',
  'pwdaccountlockedtime', 'pwdreset', 'pwdchangedtime', 'pwdfailuretime', 'pwdhistory', 'pwdpolicysubentry', 'pwdgraceusetime',
  'nsaccountlock', 'passwordexpirationtime', 'passwordretrycount', 'retrycountresettime', 'accountunlocktime', 'passwordgraceusertime',
  'loginshell', 'homedirectory', 'uidnumber', 'gidnumber', 'gecos', 'scriptpath', 'profilepath', 'homedrive',
  'serviceprincipalname', 'msds-supportedencryptiontypes', 'msds-resultantpso', 'msds-allowedtodelegateto',
  'msds-allowedtoactonbehalfofotheridentity', 'krbprincipalname', 'krbpasswordexpiration', 'krblastpwdchange',
  'ms-mcs-admpwd', 'ms-mcs-admpwdexpirationtime', 'mslaps-password', 'mslaps-passwordexpirationtime', 'mslaps-encryptedpassword',
  'dnshostname', 'operatingsystem', 'operatingsystemversion', 'operatingsystemservicepack',
])

const CONTACT = new Set([
  'mail', 'othermailbox', 'proxyaddresses', 'telephonenumber', 'othertelephone', 'mobile', 'othermobile', 'homephone',
  'otherhomephone', 'pager', 'otherpager', 'facsimiletelephonenumber', 'otherfacsimiletelephonenumber', 'ipphone',
  'otheripphone', 'street', 'streetaddress', 'postofficebox', 'l', 'st', 'postalcode', 'postaladdress', 'c', 'co',
  'countrycode', 'physicaldeliveryofficename', 'roomnumber', 'wwwhomepage', 'url', 'labeleduri', 'title', 'department',
  'departmentnumber', 'company', 'o', 'division', 'manager', 'directreports', 'secretary', 'info', 'homepostaladdress',
  'targetaddress', 'msexchhidefromaddresslists', 'mailnickname', 'legacyexchangedn',
])

const SYSTEM = new Set([
  'objectguid', 'objectsid', 'sidhistory', 'whencreated', 'whenchanged', 'usncreated', 'usnchanged', 'createtimestamp',
  'modifytimestamp', 'creatorsname', 'modifiersname', 'entryuuid', 'entrydn', 'entrycsn', 'structuralobjectclass',
  'subschemasubentry', 'hassubordinates', 'numsubordinates', 'nsuniqueid', 'instancetype', 'objectcategory',
  'dscorepropagationdata', 'ntsecuritydescriptor', 'distinguishedname', 'samaccounttype', 'iscriticalsystemobject',
  'systemflags', 'showinadvancedviewonly', 'replpropertymetadata', 'msds-replattributemetadata', 'objectversion',
  'isdeleted', 'isrecycled', 'lastknownparent', 'msds-lastknownrdn', 'msds-approx-immed-subordinates', 'entryttl',
  'msds-generationid', 'ms-ds-consistencyguid', 'msds-objectreferenceback', 'wellknownobjects',
  'otherwellknownobjects', 'msds-keycredentiallink', 'parentguid', 'contextcsn', 'nsds5replconflict', 'ldapsubentry',
  'msds-principalname', 'msds-revealeddsas', 'revision', 'admincount',
])

/**
 * The section of an attribute. `schema` (when known) moves other operational /
 * server-managed attributes (noUserMod, non-userApplications usage) to System.
 */
export function attributeGroup(name: string, schema?: { noUserMod?: boolean; usage?: string } | null): AttributeGroupId {
  const lower = name.toLowerCase().split(';')[0]
  if (MEMBERSHIP.has(lower)) return 'membership'
  if (ACCOUNT.has(lower)) return 'account'
  if (CONTACT.has(lower)) return 'contact'
  if (SYSTEM.has(lower)) return 'system'
  if (lower.startsWith('msds-') || lower.startsWith('msexch') && lower !== 'msexchhidefromaddresslists') return 'system'
  if (schema && (schema.noUserMod || (schema.usage && schema.usage !== '' && schema.usage.toLowerCase() !== 'userapplications'))) return 'system'
  return 'identity'
}

// --- Server-managed attributes (ED-08) ------------------------------------------------------

/**
 * Attributes the server maintains even where the schema does not say
 * NO-USER-MODIFICATION (AD marks most of them systemOnly, which the
 * subschema does not show): edits fail with "can only be modified as system".
 */
const SERVER_MANAGED = new Set([
  'objectguid', 'objectsid', 'usncreated', 'usnchanged', 'whencreated', 'whenchanged', 'samaccounttype', 'distinguishedname',
  'pwdhistory', 'createtimestamp', 'modifytimestamp', 'creatorsname', 'modifiersname', 'entryuuid', 'entrydn', 'entrycsn',
  'structuralobjectclass', 'subschemasubentry', 'hassubordinates', 'numsubordinates', 'nsuniqueid', 'instancetype',
  'dscorepropagationdata', 'msds-approx-immed-subordinates', 'replpropertymetadata', 'msds-replattributemetadata',
  'objectversion', 'contextcsn', 'msds-user-account-control-computed', 'msds-resultantpso',
  'badpwdcount', 'badpasswordtime', 'lastlogon', 'lastlogontimestamp', 'logoncount', 'lastlogoff',
])

/** True when the server maintains the attribute (no Edit / Delete in the editor). */
export function isServerManagedAttribute(name: string, schema?: { noUserMod?: boolean } | null): boolean {
  if (schema?.noUserMod) return true
  return SERVER_MANAGED.has(name.toLowerCase().split(';')[0])
}

/** Problem of saving `values` for a single-valued attribute, or null. */
export function singleValueProblem(name: string, values: string[], schema?: { singleValue?: boolean } | null): string | null {
  if (!schema?.singleValue || values.length <= 1) return null
  return `${name} is single-valued: enter one value (${values.length} lines given)`
}

// --- Add attribute suggestions (ED-13) -----------------------------------------------------

/** Names matching `query`: exact first, then prefix, then substring matches, each alphabetical (case-insensitive). */
export function rankAttributeNames(names: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase()
  const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  if (!q) return sorted
  const tier = (n: string) => {
    const l = n.toLowerCase()
    return l === q ? 0 : l.startsWith(q) ? 1 : l.includes(q) ? 2 : 3
  }
  return sorted.filter((n) => tier(n) < 3).sort((a, b) => tier(a) - tier(b))
}

export interface ClassDef {
  name: string
  superClass?: string[]
  must?: string[]
  may?: string[]
}

/** MUST and MAY attributes of the entry's object classes (SUP chains walked), lower-case names -> schema spelling. */
export function classAttributes(objectClasses: readonly string[], classes: readonly ClassDef[]): { must: Map<string, string>; may: Map<string, string> } {
  const byName = new Map(classes.map((c) => [c.name.toLowerCase(), c]))
  const must = new Map<string, string>()
  const may = new Map<string, string>()
  const seen = new Set<string>()
  const walk = (name: string) => {
    const key = name.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    const c = byName.get(key)
    if (!c) return
    for (const a of c.must ?? []) must.set(a.toLowerCase(), a)
    for (const a of c.may ?? []) may.set(a.toLowerCase(), a)
    for (const sup of c.superClass ?? []) walk(sup)
  }
  objectClasses.forEach(walk)
  for (const k of must.keys()) may.delete(k)
  return { must, may }
}

/**
 * Options of the add-attribute combobox: the attributes the entry's classes
 * allow (MUST/MAY), ranked; an exact match from the rest of the schema is
 * always offered first. `more` = how many other schema attributes match
 * (behind "Show all attributes"); with `showAll` they follow the allowed ones.
 */
export function attributeSuggestions(query: string, allowed: readonly string[], all: readonly string[], showAll: boolean): { items: string[]; more: number } {
  const allowedSet = new Set(allowed.map((n) => n.toLowerCase()))
  const rest = all.filter((n) => !allowedSet.has(n.toLowerCase()))
  const q = query.trim().toLowerCase()
  const rankedAllowed = rankAttributeNames(allowed, query)
  const rankedRest = rankAttributeNames(rest, query)
  const exact = q ? rankedRest.find((n) => n.toLowerCase() === q) : undefined
  if (showAll) {
    const items = exact ? [exact, ...rankedAllowed, ...rankedRest.filter((n) => n !== exact)] : [...rankedAllowed, ...rankedRest]
    return { items, more: 0 }
  }
  return { items: exact ? [exact, ...rankedAllowed] : rankedAllowed, more: rankedRest.length - (exact ? 1 : 0) }
}

// --- Row menu texts (ED-12) ------------------------------------------------------------------

/**
 * `attr: value` lines (one per value) for the clipboard. Binary values
 * (already base64) use the LDIF form `attr:: base64`, so they never read as
 * text (RW1-E-12).
 */
export function attributeLines(name: string, values: readonly string[], binary = false): string {
  return values.map((v) => (binary ? `${name}:: ${v}` : `${name}: ${v}`)).join('\n')
}

/** Equality filter for "Search for This Value": `(attr=value)`, the value RFC 4515 escaped. */
export function valueSearchFilter(name: string, value: string): string {
  return `(${name}=${escapeFilterValue(value)})`
}

// --- Display helpers (ED-19) -----------------------------------------------------------------

const URL_ATTRS = new Set(['url', 'wwwhomepage', 'labeleduri'])

/**
 * Link of a url / wWWHomePage / labeledURI value (labeledURI: "URI label"),
 * http(s) only; null for other attributes and schemes.
 */
export function valueLink(attrName: string, value: string): { href: string; label?: string } | null {
  if (!URL_ATTRS.has(attrName.toLowerCase().split(';')[0])) return null
  const t = value.trim()
  const m = /^(\S+)(?:\s+(.+))?$/.exec(t)
  if (!m) return null
  const href = m[1]
  if (!/^https?:\/\/[^\s/]+/i.test(href)) return null
  const label = attrName.toLowerCase().startsWith('labeleduri') && m[2] ? m[2].trim() : undefined
  return label ? { href, label } : { href }
}

/** Domain-relative well-known group RIDs (MS-DTYP 2.4.2.4) for primaryGroupID. */
const WELL_KNOWN_GROUP_RIDS: Record<number, string> = {
  512: 'Domain Admins',
  513: 'Domain Users',
  514: 'Domain Guests',
  515: 'Domain Computers',
  516: 'Domain Controllers',
  517: 'Cert Publishers',
  518: 'Schema Admins',
  519: 'Enterprise Admins',
  520: 'Group Policy Creator Owners',
  521: 'Read-only Domain Controllers',
  522: 'Cloneable Domain Controllers',
  498: 'Enterprise Read-only Domain Controllers',
  553: 'RAS and IAS Servers',
}

/** Name of a well-known primary group RID, or undefined. */
export function wellKnownGroupName(rid: string | number): string | undefined {
  const n = typeof rid === 'number' ? rid : Number(String(rid).trim())
  return Number.isInteger(n) ? WELL_KNOWN_GROUP_RIDS[n] : undefined
}

/**
 * SID of the primary group: the account's domain SID (its objectSid without
 * the last sub-authority) plus primaryGroupID; null when the objectSid is no
 * domain account SID (S-1-5-21-…) or the RID is not a positive integer.
 */
export function primaryGroupSid(objectSid: string | undefined, rid: string | number): string | null {
  const m = /^(S-1-5-21(?:-\d+){3})-\d+$/i.exec((objectSid ?? '').trim())
  const n = typeof rid === 'number' ? rid : Number(String(rid).trim())
  if (!m || !Number.isInteger(n) || n <= 0) return null
  return `${m[1].toUpperCase()}-${n}`
}

// --- Compare (ED-20) ---------------------------------------------------------------------------

/**
 * Attributes that differ between any two entries and say nothing about
 * them (GUID, SID, USNs, timestamps, DN, name, …): hidden by the compare
 * dialog's "Ignore system attributes" toggle.
 */
export function isCompareNoise(name: string, schema?: { noUserMod?: boolean; usage?: string } | null): boolean {
  const lower = name.toLowerCase().split(';')[0]
  if (lower === 'name' || COMPARE_NOISE_TIMES.has(lower)) return true
  return attributeGroup(name, schema) === 'system' || isServerManagedAttribute(name, schema)
}

/**
 * Times and counters that differ between any two accounts without saying
 * anything about how they are set up (RW2-E-08: pwdLastSet stayed among the
 * differences with "Ignore system attributes" on).
 */
const COMPARE_NOISE_TIMES = new Set([
  'pwdlastset', 'badpasswordtime', 'badpwdcount', 'lastlogon', 'lastlogontimestamp', 'lastlogoff', 'logoncount',
  'pwdchangedtime', 'pwdfailuretime', 'passwordexpirationtime', 'passwordretrycount', 'retrycountresettime',
])

/**
 * Where the caret goes when the inline value editor opens: an untouched
 * value is selected (typing replaces it, ED-08), typed input that came back
 * (a tab switch) keeps the caret at its end (RW3-E-03).
 */
export function inlineEditCaret(value: string, original: string): 'select' | 'end' {
  return value === original ? 'select' : 'end'
}

/** Table width from which the attribute table shows its Raw column (narrower: raw values in the tooltip). */
export const RAW_MIN_TABLE_PX = 820

/** The Raw column fits (0 = not measured yet: shown). */
export function showRawColumn(tableWidth: number): boolean {
  return tableWidth === 0 || tableWidth >= RAW_MIN_TABLE_PX
}
