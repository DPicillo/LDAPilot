/**
 * Pure schema helpers for the schema views: the SUP chain of an object class,
 * its inherited MUST / MAY grouped by the class that defines them, lookups
 * by name, alias or OID (DEF-25: rfc822Mailbox is mail), and an RFC 4512
 * definition text for "Copy Definition". Runs under `node --test`.
 */
import type { SchemaAttribute, SchemaInfo, SchemaObjectClass } from '../../types/ldap'

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })

/** A schema element with its further NAMEs (SchemaAttribute.aliases; object classes carry them too since DEF-25). */
export interface NamedSchemaElement {
  name: string
  oid?: string
  aliases?: string[]
}

/** The further NAMEs of an attribute type or object class. */
export function aliasesOf(el: NamedSchemaElement | null | undefined): string[] {
  return el?.aliases ?? []
}

/** Whether `name` (case-insensitive, attribute options ignored) is the element's name, an alias or its OID. */
export function hasSchemaName(el: NamedSchemaElement, name: string): boolean {
  const n = name.split(';')[0].trim()
  if (!n) return false
  const l = n.toLowerCase()
  return el.name.toLowerCase() === l || (!!el.oid && el.oid === n) || aliasesOf(el).some((a) => a.toLowerCase() === l)
}

/** The element named `name` (primary name or OID first, then aliases), undefined when unknown. */
export function findSchemaElement<T extends NamedSchemaElement>(list: readonly T[] | null | undefined, name: string): T | undefined {
  if (!list) return undefined
  const n = name.split(';')[0].trim()
  const l = n.toLowerCase()
  return list.find((e) => e.name.toLowerCase() === l || (!!e.oid && e.oid === n)) ?? list.find((e) => hasSchemaName(e, n))
}

/** The attribute type with the name, alias or OID. */
export function findAttribute(schema: SchemaInfo | null | undefined, name: string): SchemaAttribute | undefined {
  return findSchemaElement(schema?.attributes, name)
}

/** The object class with the name, alias or OID. */
export function findObjectClass(schema: SchemaInfo | null | undefined, name: string): SchemaObjectClass | undefined {
  return findSchemaElement(schema?.objectClasses, name)
}

/** The primary name of an attribute type given by name, alias or OID (the name itself when unknown). */
export function attributeName(schema: SchemaInfo | null | undefined, name: string): string {
  return findAttribute(schema, name)?.name ?? name
}

/** Whether a filter text matches the element's name, an alias, its description or OID (schema browser filter). */
export function schemaElementMatches(el: NamedSchemaElement & { description?: string }, filter: string): boolean {
  const f = filter.trim().toLowerCase()
  if (!f) return true
  return el.name.toLowerCase().includes(f)
    || aliasesOf(el).some((a) => a.toLowerCase().includes(f))
    || (el.description ?? '').toLowerCase().includes(f)
    || (!!el.oid && el.oid.includes(f))
}

/** Names sorted case-insensitively, duplicates (any case) removed. */
export function sortedNames(names: string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of names ?? []) {
    const k = n.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(n)
  }
  return out.sort(byName)
}

/** The superclasses of a class, nearest first (breadth-first along SUP, each once, cycles ignored). */
export function classAncestors(schema: SchemaInfo, oc: SchemaObjectClass): SchemaObjectClass[] {
  const index = new Map(schema.objectClasses.map((o) => [o.name.toLowerCase(), o]))
  for (const o of schema.objectClasses) if (o.oid && !index.has(o.oid)) index.set(o.oid, o)
  for (const o of schema.objectClasses) for (const a of aliasesOf(o)) if (!index.has(a.toLowerCase())) index.set(a.toLowerCase(), o)
  const seen = new Set([oc.name.toLowerCase()])
  const out: SchemaObjectClass[] = []
  let queue = [...(oc.superClass ?? [])]
  while (queue.length) {
    const next: string[] = []
    for (const name of queue) {
      const sup = index.get(name.toLowerCase()) ?? index.get(name)
      if (!sup || seen.has(sup.name.toLowerCase())) continue
      seen.add(sup.name.toLowerCase())
      out.push(sup)
      next.push(...(sup.superClass ?? []))
    }
    queue = next
  }
  return out
}

/** Attributes a class requires / allows, its own first, then per superclass ("from person: cn, sn"). */
export interface AttributeGroup {
  /** '' = defined by the class itself. */
  from: string
  names: string[]
}

export interface ClassAttributes {
  must: AttributeGroup[]
  may: AttributeGroup[]
  mustCount: number
  mayCount: number
}

/**
 * MUST and MAY of a class including everything inherited along SUP. Each
 * attribute is listed once, by its primary name (an alias or OID in a
 * definition resolves to it), under the nearest class that names it; an
 * attribute required anywhere is not listed as optional. Names are sorted.
 */
export function classAttributes(schema: SchemaInfo, oc: SchemaObjectClass): ClassAttributes {
  const chain = [oc, ...classAncestors(schema, oc)]
  const primary = (names: string[] | undefined) => sortedNames((names ?? []).map((n) => attributeName(schema, n)))
  const mustSeen = new Set<string>()
  const must: AttributeGroup[] = []
  for (const c of chain) {
    const names = primary(c.must).filter((n) => !mustSeen.has(n.toLowerCase()))
    names.forEach((n) => mustSeen.add(n.toLowerCase()))
    if (names.length || c === oc) must.push({ from: c === oc ? '' : c.name, names })
  }
  const maySeen = new Set(mustSeen)
  const may: AttributeGroup[] = []
  for (const c of chain) {
    const names = primary(c.may).filter((n) => !maySeen.has(n.toLowerCase()))
    names.forEach((n) => maySeen.add(n.toLowerCase()))
    if (names.length || c === oc) may.push({ from: c === oc ? '' : c.name, names })
  }
  return {
    must,
    may,
    mustCount: must.reduce((n, g) => n + g.names.length, 0),
    mayCount: may.reduce((n, g) => n + g.names.length, 0),
  }
}

function quoted(s: string): string {
  return `'${s.replace(/\\/g, '\\5c').replace(/'/g, '\\27')}'`
}

function list(names: string[] | undefined): string {
  if (!names?.length) return ''
  return names.length === 1 ? names[0] : `( ${names.join(' $ ')} )`
}

/** NAME with every alias: "NAME 'sn'" or "NAME ( 'mail' 'rfc822Mailbox' )". */
function nameField(el: NamedSchemaElement): string {
  const names = [el.name, ...aliasesOf(el)]
  return names.length === 1 ? `NAME ${quoted(el.name)}` : `NAME ( ${names.map(quoted).join(' ')} )`
}

/** RFC 4512 objectClass description of a parsed class (Copy Definition). */
export function objectClassDefinition(oc: SchemaObjectClass): string {
  const parts = [`( ${oc.oid || oc.name}`, nameField(oc)]
  if (oc.description) parts.push(`DESC ${quoted(oc.description)}`)
  if (oc.superClass?.length) parts.push(`SUP ${list(oc.superClass)}`)
  parts.push(oc.kind === 'abstract' ? 'ABSTRACT' : oc.kind === 'auxiliary' ? 'AUXILIARY' : 'STRUCTURAL')
  if (oc.must?.length) parts.push(`MUST ${list(oc.must)}`)
  if (oc.may?.length) parts.push(`MAY ${list(oc.may)}`)
  return parts.join(' ') + ' )'
}

/** RFC 4512 attributeType description of a parsed attribute (Copy Definition; inherited syntax and rules included). */
export function attributeDefinition(at: SchemaAttribute): string {
  const parts = [`( ${at.oid || at.name}`, nameField(at)]
  if (at.description) parts.push(`DESC ${quoted(at.description)}`)
  if (at.superType) parts.push(`SUP ${at.superType}`)
  if (at.equality) parts.push(`EQUALITY ${at.equality}`)
  if (at.ordering) parts.push(`ORDERING ${at.ordering}`)
  if (at.substring) parts.push(`SUBSTR ${at.substring}`)
  if (at.syntax) parts.push(`SYNTAX ${at.syntax}`)
  if (at.singleValue) parts.push('SINGLE-VALUE')
  if (at.noUserMod) parts.push('NO-USER-MODIFICATION')
  if (at.usage && at.usage !== 'userApplications') parts.push(`USAGE ${at.usage}`)
  return parts.join(' ') + ' )'
}
