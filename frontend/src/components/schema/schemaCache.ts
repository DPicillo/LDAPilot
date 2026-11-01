/**
 * The schema of a connection, read once per connection and shared by the
 * schema views, the Filter Builder and Batch Modify (attribute suggestions).
 * SchemaService caches it in the backend as well; Refresh in the schema
 * browser forgets it here and reloads it there.
 */
import { useEffect, useState } from 'react'
import * as wails from '../../lib/wails'
import type { SchemaInfo } from '../../types/ldap'

const schemaCache = new Map<string, Promise<SchemaInfo>>()
/** The schemas whose read has finished (synchronous lookups, e.g. a tab id by an alias). */
const loaded = new Map<string, SchemaInfo>()

/** GetSchema per profile (failed reads are not cached). */
export function loadSchema(profileId: string): Promise<SchemaInfo> {
  let p = schemaCache.get(profileId)
  if (!p) {
    p = wails.GetSchema(profileId)
    p.then(
      (s) => { if (schemaCache.get(profileId) === p && s) loaded.set(profileId, s) },
      () => schemaCache.delete(profileId),
    )
    schemaCache.set(profileId, p)
  }
  return p
}

/** The schema of a profile when it has been read already, else null. */
export function loadedSchema(profileId: string): SchemaInfo | null {
  return loaded.get(profileId) ?? null
}

/** Forget the cached schema of a profile (Refresh). */
export function forgetSchema(profileId: string) {
  schemaCache.delete(profileId)
  loaded.delete(profileId)
}

/** Replace the cached schema (after a refresh read it again). */
export function rememberSchema(profileId: string, schema: SchemaInfo) {
  schemaCache.set(profileId, Promise.resolve(schema))
  loaded.set(profileId, schema)
}

/** The schema of a profile (null while loading, unreadable or without a profile). */
export function useSchema(profileId: string | null | undefined): SchemaInfo | null {
  const [state, setState] = useState<{ id: string; schema: SchemaInfo } | null>(null)
  useEffect(() => {
    if (!profileId) return
    let alive = true
    loadSchema(profileId)
      .then((schema) => alive && setState({ id: profileId, schema }))
      .catch(() => {
        /* suggestions are optional */
      })
    return () => {
      alive = false
    }
  }, [profileId])
  return state && state.id === profileId ? state.schema : null
}

/** Attribute type names of a schema, sorted case-insensitively. */
export function attributeNames(schema: SchemaInfo | null): string[] {
  if (!schema?.attributes) return []
  return schema.attributes
    .map((a) => a.name)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}
