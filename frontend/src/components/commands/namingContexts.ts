/**
 * Naming-context heads (domain roots, Configuration, Schema, DomainDnsZones /
 * ForestDnsZones, OpenLDAP / 389DS suffixes): containers that are never
 * renamed, moved or copied. Known from the RootDSE (ServerInfo naming
 * contexts) plus the domains of an AD forest the tree shows (other domains
 * are not in this DC's namingContexts); before the RootDSE is read, the tree
 * roots count.
 */
import { useTreeStore } from '../../stores/treeStore'
import { normalizeDN } from '../../lib/dn'
import { forestDomainKeys } from '../../lib/treesearch'
import type { ServerInfo } from '../../types/ldap'
import { cachedServerInfo } from '../ui/commands'

const ncSets = new WeakMap<ServerInfo, Set<string>>()

function ncSet(info: ServerInfo): Set<string> {
  let s = ncSets.get(info)
  if (!s) {
    s = new Set(
      [...(info.namingContexts ?? []), info.defaultNamingContext, info.rootDomainNamingContext, info.configurationNamingContext, info.schemaNamingContext]
        .filter((x): x is string => !!x)
        .map(normalizeDN),
    )
    ncSets.set(info, s)
  }
  return s
}

const NO_ROOTS: never[] = []

export function isNamingContextHead(profileId: string | null | undefined, dn: string): boolean {
  if (!profileId || !dn) return false
  const key = normalizeDN(dn)
  const info = cachedServerInfo(profileId)
  const roots = useTreeStore.getState().rootNodes[profileId] ?? NO_ROOTS
  // The forest domains are collected once per roots array (walking 40,000 preloaded
  // children for every call made the editor's breadcrumb root quadratic).
  if (info) return ncSet(info).has(key) || forestDomainKeys(roots).has(key)
  return roots.some((r) => normalizeDN(r.dn) === key) || forestDomainKeys(roots).has(key)
}
