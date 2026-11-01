/**
 * Edit as LDIF (DEF-14), the pure part (tests/editor.ldifedit.test.ts).
 *
 * The editor shows one entry as an LDIF content record (lib/ldif.ts
 * formatEntryForEdit) and turns the edited text into the minimal change set
 * of ONE atomic ModifyEntry (plus a ModifyDN first when the dn: line
 * changed). Rules:
 *
 * - Every attribute written in the text ends up with exactly the text's
 *   values; an attribute that was shown and is no longer in the text is
 *   deleted. Attributes left out of the text (server-maintained, secrets,
 *   large binary values: `hidden`) stay untouched unless the text names them.
 * - Only attributes the user changed are sent. Their change is computed
 *   against the entry as the server has it at review time (`fresh`), so a
 *   concurrent change of another attribute is never undone; an attribute
 *   changed both here and on the server is flagged as a conflict.
 * - Binary attributes (and AD values the backend renders as text, written as
 *   raw base64 like formatEntryAsLDIF) compare by their bytes; a changed one
 *   is replaced (never value-level add/delete: OpenLDAP has no equality rule
 *   for jpegPhoto), an unchanged one is never sent. Values follow the binary
 *   contract (binary: true = standard base64 of the bytes).
 * - Multi-valued text attributes get value-level delete/add when that sends
 *   fewer values than a replace; objectClass is always value-level (new
 *   classes first, removed classes last); single-valued ones are replaced.
 * - Password attributes (userPassword, unicodePwd) are only replaced, never
 *   added, and their values are masked in the review.
 * - A changed dn: line is a rename / move (ModifyDN) before the modify; the
 *   RDN attribute follows the rename unless the text changes it itself.
 *
 * Imports only types and pure .ts modules (node --test).
 */
import type { AttributeChange, LDAPAttribute, LDAPEntry, SchemaAttribute, ServerType } from '../../types/ldap'
import {
  decodeBase64Strict, formatEntryForEdit, parseLDIFRecord, rawADValue, utf8Text, utf8ToBase64,
  type LDIFParsedRecord, type LDIFParseProblem,
} from '../../lib/ldif.ts'
import { isSensitiveAttributeName, objectClassChanges, sameValues } from '../../lib/entryChanges.ts'
import { isServerManagedAttribute } from '../../lib/attributeGroups.ts'
import { base64ByteLength, binaryTransferName, binaryValueSummary, formatByteSize, isBinaryAttributeName } from '../../lib/binary.ts'
import { getParentDN, splitDN } from '../../lib/dn.ts'
import { PASSWORD_MASK, isPasswordWriteAttribute, isUserPasswordAttribute } from '../../lib/passwordPolicy.ts'

/** Binary attributes larger than this (all values, raw bytes) are left out of the text. */
export const LDIF_EDIT_LARGE_BINARY = 16 * 1024

/**
 * Attributes the server maintains that isServerManagedAttribute does not list
 * because they are ordinary attributes elsewhere: back links (AD memberOf /
 * directReports have no NO-USER-MODIFICATION in the subschema) and
 * constructed values.
 */
const EDIT_SERVER_MANAGED = new Set([
  'memberof', 'directreports', 'ismemberof', 'nsrole', 'canonicalname', 'msds-parentdistname', 'entrydn',
  'msds-keyversionnumber', 'tokengroups', 'allowedattributes', 'allowedattributeseffective', 'allowedchildclasses',
  'allowedchildclasseseffective', 'msds-replvaluemetadata', 'lastknownparent', 'isdeleted', 'isrecycled',
])

export type HiddenReason = 'managed' | 'secret' | 'large'

export interface HiddenAttribute {
  name: string
  reason: HiddenReason
  count: number
  /** Raw size of all values (binary attributes). */
  bytes: number
}

/** An attribute in its editable form: binary values (and AD values shown as text) as base64. */
export interface EditAttr {
  name: string
  values: string[]
  binary: boolean
}

/** Schema attribute types by lower-case name, alias and OID. */
export type SchemaIndex = Map<string, SchemaAttribute>

export function schemaIndex(attrs: readonly SchemaAttribute[] | undefined | null): SchemaIndex {
  const idx: SchemaIndex = new Map()
  for (const a of attrs ?? []) {
    for (const n of [a.name, ...(a.aliases ?? []), a.oid]) if (n) idx.set(n.toLowerCase(), a)
  }
  return idx
}

/**
 * Comparison key of an attribute description: the schema's canonical name
 * (aliases and OIDs resolved) plus its options, lower case; the ";binary"
 * transfer option is ignored ("userCertificate" = "userCertificate;binary").
 */
export function attributeKey(name: string, schema?: SchemaIndex): string {
  const [base, ...opts] = name.toLowerCase().split(';')
  const canonical = schema?.get(base)?.name.toLowerCase() ?? base
  const options = opts.filter((o) => o && o !== 'binary').sort()
  return options.length ? `${canonical};${options.join(';')}` : canonical
}

function schemaOf(name: string, schema?: SchemaIndex): SchemaAttribute | undefined {
  return schema?.get(name.toLowerCase().split(';')[0])
}

/** The editable form of a loaded attribute (AD GUID/SID text → raw base64, as formatEntryAsLDIF writes it). */
export function editAttrOf(attr: LDAPAttribute): EditAttr {
  if (attr.binary) return { name: attr.name, values: [...attr.values], binary: true }
  const raw = attr.values.map((v) => rawADValue(attr.name, v))
  if (raw.length > 0 && raw.every((v) => v !== null)) return { name: attr.name, values: raw as string[], binary: true }
  return { name: attr.name, values: [...attr.values], binary: false }
}

function editMapOf(attrs: readonly LDAPAttribute[], schema?: SchemaIndex): Map<string, EditAttr> {
  const out = new Map<string, EditAttr>()
  for (const a of attrs) {
    if (!a.values.length) continue
    const key = attributeKey(a.name, schema)
    const e = editAttrOf(a)
    const prev = out.get(key)
    if (prev && prev.binary === e.binary) prev.values.push(...e.values)
    else if (!prev) out.set(key, e)
  }
  return out
}

/** Why an attribute is left out of the text, or null when it is shown. */
export function hiddenReason(attr: EditAttr, schemaAttr: SchemaAttribute | undefined, serverType?: ServerType | null): HiddenReason | null {
  const base = attr.name.toLowerCase().split(';')[0]
  // Classes are edited value by value on every server, also where the subschema marks
  // objectClass NO-USER-MODIFICATION (Samba).
  if (base === 'objectclass') return null
  if (isServerManagedAttribute(attr.name, schemaAttr) || EDIT_SERVER_MANAGED.has(base) || (serverType === 'ad' && base === 'name')) return 'managed'
  if (isSensitiveAttributeName(attr.name)) return 'secret'
  if (attr.binary && attr.values.reduce((n, v) => n + base64ByteLength(v), 0) > LDIF_EDIT_LARGE_BINARY) return 'large'
  return null
}

export interface LDIFEditSession {
  dn: string
  /** The text the editor starts with. */
  text: string
  /** Attributes written into the text, by attributeKey. */
  shown: Map<string, EditAttr>
  /** Every attribute of the loaded entry (shown and hidden), by attributeKey. */
  all: Map<string, EditAttr>
  hidden: HiddenAttribute[]
}

/** Name of a binary value for the text's comments and the review ("Anna · expires 2027-01-02"), if known. */
export type DescribeBinary = (attribute: string, base64: string) => string | undefined

/**
 * Starts an edit: the text (objectClass first) and what was left out.
 * `describeBinary` names binary values in "# …" comment lines above them.
 */
export function startLDIFEdit(entry: LDAPEntry, opts: { schema?: SchemaIndex; serverType?: ServerType | null; describeBinary?: DescribeBinary } = {}): LDIFEditSession {
  const all = editMapOf(entry.attributes ?? [], opts.schema)
  const shown = new Map<string, EditAttr>()
  const hidden: HiddenAttribute[] = []
  for (const [key, attr] of all) {
    const reason = hiddenReason(attr, schemaOf(attr.name, opts.schema), opts.serverType)
    if (reason) {
      hidden.push({ name: attr.name, reason, count: attr.values.length, bytes: attr.binary ? attr.values.reduce((n, v) => n + base64ByteLength(v), 0) : 0 })
    } else {
      shown.set(key, attr)
    }
  }
  // objectClass first, then the RDN attribute(s), then the entry's order.
  const rdnKeys = new Set(rdnPairs(entry.dn).map((p) => attributeKey(p.attr, opts.schema)))
  const rank = (a: EditAttr) => (a.name.toLowerCase() === 'objectclass' ? 0 : rdnKeys.has(attributeKey(a.name, opts.schema)) ? 1 : 2)
  const ordered = [...shown.values()].sort((a, b) => rank(a) - rank(b))
  const describe = opts.describeBinary
  const comment = describe
    ? (name: string, value: string, index: number, count: number) => {
      const label = describe(name, value)
      return label ? `${name}${count > 1 ? ` ${index + 1} of ${count}` : ''}: ${label}` : undefined
    }
    : undefined
  return { dn: entry.dn, text: formatEntryForEdit(entry.dn, ordered, { comment }), shown, all, hidden }
}

// --- Planning ------------------------------------------------------------------------

/** One edited value: canonical base64 of its bytes and its text (null if not text). */
interface EditedValue {
  b64: string
  text: string | null
  line: number
}

interface EditedAttr {
  name: string
  values: EditedValue[]
  line: number
}

export interface LDIFEditRow {
  /** Attribute as sent. */
  attribute: string
  kind: 'add' | 'delete' | 'replace' | 'modify'
  /** Display values (secrets masked, binary values summarised). */
  removed: string[]
  added: string[]
  /** Values that stay. */
  kept: number
  binary: boolean
  secret: boolean
  /** The server's values changed since the editor opened. */
  conflict: boolean
  /** Line of the attribute in the text (0 = not in the text). */
  line: number
}

export interface LDIFRename {
  oldDN: string
  newDN: string
  newRDN: string
  /** '' = same parent. */
  newSuperior: string
  deleteOldRDN: boolean
}

export interface LDIFEditPlan {
  parsed: LDIFParsedRecord
  /** Blocking: syntax errors and changes the server would refuse. */
  problems: LDIFParseProblem[]
  /** Shown, not blocking. */
  warnings: LDIFParseProblem[]
  rename: LDIFRename | null
  /** The one ModifyEntry (after the rename, against the new DN). */
  changes: AttributeChange[]
  rows: LDIFEditRow[]
  /** Attributes changed both here and on the server since the editor opened. */
  conflicts: string[]
  /** A userPassword value is written (AD asks first). */
  writesUserPassword: boolean
  /** objectClass values after the edit and the other attributes (for SchemaService.ValidateEntry). */
  finalObjectClasses: string[]
  finalAttributes: Record<string, string[]>
}

export interface PlanContext {
  schema?: SchemaIndex
  serverType?: ServerType | null
  /** The entry as the server has it now (default: as loaded). */
  fresh?: LDAPEntry | null
  /** Names binary values in the review rows (else format, size and a short hash). */
  describeBinary?: DescribeBinary
}

/** Mirror of Go ldap.IsBinaryValue: invalid UTF-8 or control characters other than tab, CR, LF. */
function bytesAreBinary(bytes: Uint8Array): boolean {
  const text = utf8Text(bytes)
  if (text === null) return true
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return true
  }
  return false
}

function canonicalBase64(b64: string): string {
  const bytes = decodeBase64Strict(b64)
  if (!bytes) return b64
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/** Values of an EditAttr as canonical base64 (text values encoded as UTF-8). */
function asBase64(attr: EditAttr): string[] {
  return attr.binary ? attr.values.map(canonicalBase64) : attr.values.map(utf8ToBase64)
}

/** RDN attribute-value pairs of a DN's first RDN (multi-valued RDNs split at unescaped "+"). */
export function rdnPairs(dn: string): { attr: string; value: string }[] {
  const rdn = splitDN(dn)[0] ?? ''
  const parts: string[] = []
  let cur = ''
  for (let i = 0; i < rdn.length; i++) {
    const c = rdn[i]
    if (c === '\\' && i + 1 < rdn.length) {
      cur += c + rdn[i + 1]
      i++
    } else if (c === '+') {
      parts.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  parts.push(cur)
  return parts.map((p) => {
    const eq = unescapedIndex(p, '=')
    return eq < 0 ? { attr: '', value: p.trim() } : { attr: p.slice(0, eq).trim(), value: unescapeValue(p.slice(eq + 1).trim()) }
  })
}

function unescapedIndex(s: string, ch: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === ch) return i
  }
  return -1
}

/** RFC 4514 unescape (\, and \2C forms; hex escapes decoded as UTF-8). */
function unescapeValue(v: string): string {
  const bytes: number[] = []
  const enc = new TextEncoder()
  for (let i = 0; i < v.length; i++) {
    const c = v[i]
    if (c === '\\' && i + 1 < v.length) {
      const hex = v.slice(i + 1, i + 3)
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16))
        i += 2
        continue
      }
      bytes.push(...enc.encode(v[i + 1]))
      i++
      continue
    }
    bytes.push(...enc.encode(c))
  }
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

const ATTR_TYPE_RE = /^(?:[A-Za-z][A-Za-z0-9-]*|[0-9]+(?:\.[0-9]+)*)$/

/** Why a DN is not usable, or null. */
export function dnProblem(dn: string): string | null {
  if (!dn.trim()) return 'the DN is empty'
  for (const rdn of splitDN(dn)) {
    if (!rdn.trim()) return `the DN "${dn}" has an empty RDN`
    const pairs = rdnPairs(rdn)
    for (const p of pairs) {
      if (!p.attr || !ATTR_TYPE_RE.test(p.attr)) return `"${rdn}" is no attribute=value pair (escape "," "+" "=" in values with "\\")`
      if (!p.value) return `"${rdn}" has an empty value`
    }
  }
  return null
}

/** True if the DNs are the same (case, blanks around separators, the order of multi-valued RDN parts ignored). */
function sameDNText(a: string, b: string): boolean {
  const key = (dn: string) => (dn.trim() ? splitDN(dn).map((r) => rdnPairs(r).map((p) => `${p.attr.toLowerCase()}=${p.value.toLowerCase()}`).sort().join('+')).join(',') : '')
  return key(a) === key(b)
}

function containsCI(values: readonly string[], v: string): boolean {
  const l = v.toLowerCase()
  return values.some((x) => x.toLowerCase() === l)
}

/** Display form of a value in the review. */
function displayValue(name: string, b64OrText: string, binary: boolean, secret: boolean, describe?: DescribeBinary): string {
  if (secret) return PASSWORD_MASK
  if (!binary) return b64OrText
  const label = describe?.(name, b64OrText)
  return label ? `${label} · ${formatByteSize(base64ByteLength(b64OrText))}` : binaryValueSummary(name, b64OrText)
}

/**
 * The plan of an edited text: problems, the rename, the one change set and
 * the review rows. Nothing is sent; the dialog applies `rename` (if any),
 * then `changes`.
 */
export function planLDIFEdit(session: LDIFEditSession, text: string, ctx: PlanContext = {}): LDIFEditPlan {
  const { schema, serverType } = ctx
  const parsed = parseLDIFRecord(text)
  const problems: LDIFParseProblem[] = [...parsed.errors]
  const warnings: LDIFParseProblem[] = []
  const fresh = ctx.fresh ? editMapOf(ctx.fresh.attributes ?? [], schema) : session.all
  const isAD = serverType === 'ad'

  // --- Edited attributes, merged by key, values decoded ---
  const edited = new Map<string, EditedAttr>()
  for (const pa of parsed.attributes) {
    const key = attributeKey(pa.name, schema)
    let ea = edited.get(key)
    if (!ea) {
      ea = { name: pa.name, values: [], line: pa.values[0]?.line ?? 0 }
      edited.set(key, ea)
    }
    for (const pv of pa.values) {
      if (pv.base64) {
        const bytes = decodeBase64Strict(pv.value) ?? new Uint8Array(0)
        const text = bytesAreBinary(bytes) ? null : utf8Text(bytes)
        ea.values.push({ b64: canonicalBase64(pv.value), text, line: pv.line })
      } else {
        ea.values.push({ b64: utf8ToBase64(pv.value), text: pv.value, line: pv.line })
      }
    }
  }

  // --- Binary-ness of each edited attribute ---
  const binaryOf = (key: string, ea: EditedAttr): boolean => {
    const known = session.all.get(key) ?? fresh.get(key)
    if (isPasswordWriteAttribute(ea.name)) return ea.values.some((v) => v.text === null)
    if (known?.binary) return true
    if (isBinaryAttributeName(ea.name, schemaOf(ea.name, schema)?.syntax)) return true
    return ea.values.some((v) => v.text === null)
  }
  /** Comparable values of an edited attribute in the form of `binary`. */
  const editedValues = (ea: EditedAttr, binary: boolean): string[] => (binary ? ea.values.map((v) => v.b64) : ea.values.map((v) => v.text ?? ''))
  /** Comparable values of a loaded attribute in the form of `binary`. */
  const loadedValues = (attr: EditAttr | undefined, binary: boolean): string[] => {
    if (!attr) return []
    if (binary) return asBase64(attr)
    return attr.binary ? attr.values : [...attr.values]
  }

  // --- What the user changed (against the text they started with) ---
  const changedKeys: string[] = []
  for (const [key, ea] of edited) {
    const shown = session.shown.get(key)
    if (!shown) {
      changedKeys.push(key) // a new attribute or one left out of the text
      continue
    }
    const binary = shown.binary || binaryOf(key, ea)
    if (!sameValues(loadedValues(shown, binary), editedValues(ea, binary))) changedKeys.push(key)
  }
  for (const key of session.shown.keys()) if (!edited.has(key)) changedKeys.push(key)
  const changedSet = new Set(changedKeys)

  // --- Checks of the changed attributes (the server's own values are not judged) ---
  for (const key of changedKeys) {
    const ea = edited.get(key)
    if (!ea) continue
    const seen = new Set<string>()
    for (const v of ea.values) {
      if (v.b64 === '') {
        problems.push({ line: v.line, message: `empty value of "${ea.name}": remove the line to remove the value` })
        continue
      }
      if (seen.has(v.b64)) {
        problems.push({ line: v.line, message: `"${ea.name}" lists the same value twice` })
      }
      seen.add(v.b64)
      if (v.text !== null && v.text !== v.text.trimEnd() && !fresh.get(key)?.values.includes(v.text)) {
        warnings.push({ line: v.line, message: `the value of "${ea.name}" ends with a blank` })
      }
    }
    const sa = schemaOf(ea.name, schema)
    if (schema && schema.size > 0 && !sa) {
      problems.push({ line: ea.line, message: `"${ea.name.split(';')[0]}" is not an attribute of this server's schema` })
    }
    if (sa?.singleValue && ea.values.length > 1) {
      problems.push({ line: ea.values[1].line, message: `${ea.name} is single-valued: give one value (${ea.values.length} lines)` })
    }
  }

  // --- DN: rename / move ---
  let rename: LDIFRename | null = null
  const newDN = parsed.dn.trim()
  /** RDN values the rename adds to an attribute the text changed but did not give them. */
  const implied = new Map<string, string[]>()
  // Fresh values after the rename (the attribute changes are computed against them).
  const afterRename = new Map(fresh)
  if (parsed.dnLine && newDN) {
    const bad = dnProblem(newDN)
    if (bad) {
      problems.push({ line: parsed.dnLine, message: bad })
    } else {
      const oldPairs = rdnPairs(session.dn)
      const newPairs = rdnPairs(newDN)
      const rdnChanged = oldPairs.length !== newPairs.length ||
        oldPairs.some((p) => !newPairs.some((q) => attributeKey(q.attr, schema) === attributeKey(p.attr, schema) && q.value === p.value))
      const oldParent = getParentDN(session.dn)
      const newParent = getParentDN(newDN)
      const moved = !sameDNText(oldParent, newParent)
      if (moved && !newParent) {
        problems.push({ line: parsed.dnLine, message: 'the new DN has no parent: an entry cannot be moved to the top' })
      } else if (rdnChanged || moved) {
        const touchedKeep = oldPairs.some((p) => {
          const key = attributeKey(p.attr, schema)
          const ea = edited.get(key)
          return changedSet.has(key) && !!ea && containsCI(ea.values.map((v) => v.text ?? ''), p.value)
        })
        let deleteOldRDN = rdnChanged && !touchedKeep
        if (isAD && rdnChanged && touchedKeep) {
          const kept = oldPairs.find((p) => containsCI(edited.get(attributeKey(p.attr, schema))?.values.map((v) => v.text ?? '') ?? [], p.value))!
          problems.push({ line: parsed.dnLine, message: `Active Directory removes the old name on a rename: remove "${kept.attr}: ${kept.value}" or keep the old DN` })
        }
        if (isAD) deleteOldRDN = true
        const newRDN = splitDN(newDN)[0].trim()
        // A move keeps the RDN; deleteoldrdn 1 then changes nothing (and AD refuses 0).
        rename = { oldDN: session.dn, newDN, newRDN, newSuperior: moved ? newParent : '', deleteOldRDN: rdnChanged ? deleteOldRDN : true }
        if (rdnChanged) {
          // Simulate the ModifyDN on the server's values.
          for (const p of oldPairs) {
            if (!rename.deleteOldRDN) break
            const key = attributeKey(p.attr, schema)
            const cur = afterRename.get(key)
            if (cur && !cur.binary) afterRename.set(key, { ...cur, values: cur.values.filter((v) => v.toLowerCase() !== p.value.toLowerCase()) })
          }
          for (const p of newPairs) {
            const key = attributeKey(p.attr, schema)
            const cur = afterRename.get(key)
            if (!cur) afterRename.set(key, { name: p.attr, values: [p.value], binary: false })
            else if (!containsCI(cur.values, p.value)) afterRename.set(key, { ...cur, values: [...cur.values, p.value] })
            const ea = edited.get(key)
            if (changedSet.has(key) && ea && !containsCI(ea.values.map((v) => v.text ?? ''), p.value)) {
              implied.set(key, [...(implied.get(key) ?? []), p.value])
              warnings.push({ line: ea.line, message: `"${p.attr}: ${p.value}" is set by the rename (the new RDN), so it stays` })
            }
          }
        }
      }
    }
    if (!rename) {
      // Same DN: the RDN value must stay.
      for (const p of rdnPairs(session.dn)) {
        const key = attributeKey(p.attr, schema)
        if (!changedSet.has(key)) continue
        const ea = edited.get(key)
        if (!ea || !containsCI(ea.values.map((v) => v.text ?? ''), p.value)) {
          problems.push({
            line: ea?.line || parsed.dnLine,
            message: `"${p.attr}: ${p.value}" names the entry (its RDN): keep the value, or change the dn: line to rename the entry`,
          })
        }
      }
    }
  } else if (!problems.length) {
    problems.push({ line: 0, message: 'the dn: line is missing' })
  }

  // --- The change set ---
  const attrChanges: AttributeChange[] = []
  const rows: LDIFEditRow[] = []
  const conflicts: string[] = []
  let ocAdd: AttributeChange | null = null
  let ocRemove: AttributeChange | null = null
  let writesUserPassword = false

  for (const key of changedKeys) {
    const ea = edited.get(key)
    const cur = afterRename.get(key)
    const known = session.all.get(key)
    const sa = schemaOf(ea?.name ?? cur?.name ?? key, schema)
    const secret = isSensitiveAttributeName(ea?.name ?? cur?.name ?? key)
    const binary = ea ? binaryOf(key, ea) : !!cur?.binary
    const typedName = ea?.name ?? key
    const name = cur?.name ?? known?.name ?? (binary ? binaryTransferName(typedName, sa?.syntax) : typedName)
    const extra = (implied.get(key) ?? []).map((v) => (binary ? utf8ToBase64(v) : v))
    const finalValues = ea ? [...editedValues(ea, binary), ...extra] : []
    const curValues = loadedValues(cur, binary)
    const line = ea?.line ?? 0

    // Changed here and on the server since the editor opened.
    const conflict = !!ctx.fresh && !sameValues(loadedValues(session.all.get(key), binary), loadedValues(fresh.get(key), binary))

    if (sameValues(curValues, finalValues)) continue
    if (conflict) {
      conflicts.push(name)
      warnings.push({ line, message: `${name} was changed on the server since the editor opened: applying sets the values of the text` })
    }
    if (ea && !session.shown.has(key) && known && hiddenReason(known, sa, serverType) === 'managed') {
      warnings.push({ line, message: `${name} is maintained by the server: the server will probably refuse to change it` })
    } else if (ea && !known && sa && isServerManagedAttribute(ea.name, sa)) {
      warnings.push({ line, message: `${ea.name} is maintained by the server: the server will probably refuse to set it` })
    }

    const curSet = new Set(curValues)
    const finalSet = new Set(finalValues)
    const removedVals = curValues.filter((v) => !finalSet.has(v))
    const addedVals = finalValues.filter((v) => !curSet.has(v))
    const row: LDIFEditRow = {
      attribute: name,
      kind: 'replace',
      removed: removedVals.map((v) => displayValue(name, v, binary, secret, ctx.describeBinary)),
      added: addedVals.map((v) => displayValue(name, v, binary, secret, ctx.describeBinary)),
      kept: finalValues.length - addedVals.length,
      binary,
      secret,
      conflict,
      line,
    }

    if (key === 'objectclass') {
      const oc = objectClassChanges(curValues, finalValues)
      ocAdd = oc.add
      ocRemove = oc.remove
      row.kind = oc.add && oc.remove ? 'modify' : oc.add ? 'add' : 'delete'
      if (!oc.add && !oc.remove) continue
      rows.push(row)
      continue
    }
    if (isPasswordWriteAttribute(name)) {
      // Passwords are replaced, never added: a second userPassword would keep the old one valid.
      if (finalValues.length === 0) {
        attrChanges.push({ operation: 'delete', attribute: name, values: [], binary })
        row.kind = 'delete'
      } else {
        attrChanges.push({ operation: 'replace', attribute: name, values: finalValues, binary })
        row.kind = 'replace'
        if (isUserPasswordAttribute(name)) writesUserPassword = true
      }
      row.kept = 0
      row.removed = curValues.length ? [`${curValues.length} stored value${curValues.length > 1 ? 's' : ''}`] : []
      rows.push(row)
      continue
    }
    if (finalValues.length === 0) {
      attrChanges.push({ operation: 'delete', attribute: name, values: [], binary })
      row.kind = 'delete'
    } else if (curValues.length === 0) {
      attrChanges.push({ operation: 'add', attribute: name, values: finalValues, binary })
      row.kind = 'add'
    } else if (binary || sa?.singleValue || (curValues.length <= 1 && finalValues.length <= 1) || removedVals.length + addedVals.length >= finalValues.length) {
      attrChanges.push({ operation: 'replace', attribute: name, values: finalValues, binary })
      row.kind = 'replace'
    } else {
      if (removedVals.length) attrChanges.push({ operation: 'delete', attribute: name, values: removedVals, binary })
      if (addedVals.length) attrChanges.push({ operation: 'add', attribute: name, values: addedVals, binary })
      row.kind = 'modify'
    }
    rows.push(row)
  }

  const changes = [...(ocAdd ? [ocAdd] : []), ...attrChanges, ...(ocRemove ? [ocRemove] : [])]

  // --- The entry after the edit (schema check) ---
  const finalAttributes: Record<string, string[]> = {}
  let finalObjectClasses: string[] = []
  for (const [key, attr] of afterRename) {
    if (changedSet.has(key)) continue
    if (key === 'objectclass') finalObjectClasses = [...attr.values]
    else finalAttributes[attr.name] = [...attr.values]
  }
  for (const key of changedSet) {
    const ea = edited.get(key)
    if (!ea) continue
    const binary = binaryOf(key, ea)
    const name = afterRename.get(key)?.name ?? ea.name
    const values = [...editedValues(ea, binary), ...(implied.get(key) ?? [])]
    if (key === 'objectclass') finalObjectClasses = values
    else finalAttributes[name] = values
  }

  return { parsed, problems, warnings, rename, changes, rows, conflicts, writesUserPassword, finalObjectClasses, finalAttributes }
}

/** "3 changes" / "1 change" / "Rename and 2 changes" for the footer. */
export function planSummary(plan: Pick<LDIFEditPlan, 'rows' | 'rename'>): string {
  const n = plan.rows.length
  const attrs = `${n} attribute${n === 1 ? '' : 's'}`
  if (plan.rename && n) return `Rename and ${attrs} changed`
  if (plan.rename) return plan.rename.newSuperior ? 'Move' : 'Rename'
  return n ? `${attrs} changed` : 'No changes'
}

/** Character offset of the start of a 1-based line (to put the caret on a problem). */
export function lineOffset(text: string, line: number): number {
  if (line <= 1) return 0
  let n = 1
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n' && ++n === line) return i + 1
  }
  return text.length
}
