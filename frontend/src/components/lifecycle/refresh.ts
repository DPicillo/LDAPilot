/**
 * Brings loaded tree listings up to date after a create / move / restore
 * done by a lifecycle dialog. The tree also follows the §0.1 entry events;
 * a refresh of a listing that is already current is cheap, and only
 * listings the tree has loaded are touched.
 */
import { useTreeStore } from '../../stores/treeStore'
import { normalizeDN } from '../../lib/dn'

/** Reloads the loaded tree listings of the containers (DN spelling of the tree kept). */
export function refreshLoadedContainers(profileId: string, containers: string[]) {
  const tree = useTreeStore.getState()
  const loaded = new Map(Object.keys(tree.childNodes).map((k) => [normalizeDN(k), k]))
  const done = new Set<string>()
  for (const dn of containers) {
    const key = normalizeDN(dn)
    if (!dn.trim() || done.has(key)) continue
    done.add(key)
    const treeKey = loaded.get(key)
    if (treeKey) void tree.refreshNode(profileId, treeKey).catch(() => {})
  }
}
