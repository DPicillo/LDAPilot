/**
 * Context menu of schema list rows and chips (R-22): Copy Name / OID /
 * Definition, Find Entries of This Class / with This Attribute (a subtree
 * search below the connection's base DN in the Search panel), Open in New Tab.
 */
import { Copy, ExternalLink, FileCode, Hash, Search } from 'lucide-react'
import { useSearchStore } from '../../stores/searchStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useUIStore } from '../../stores/uiStore'
import { escapeFilterValue } from '../../lib/ldapFilter'
import { ScopeSub, type SchemaAttribute, type SchemaObjectClass } from '../../types/ldap'
import { MenuHeader, MenuItem, MenuSeparator } from '../ui/Menu'
import { toast } from '../ui/Toast'
import { attributeDefinition, objectClassDefinition } from './schemaModel'
import { showSearchResults } from '../layout/shellState'

export type SchemaMenuTarget = { kind: 'oc'; item: SchemaObjectClass } | { kind: 'at'; item: SchemaAttribute }

function copy(text: string, what: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success(`${what} copied`))
    .catch((err) => toast.error(`Could not copy the ${what.toLowerCase()}`, err instanceof Error ? err.message : String(err)))
}

/**
 * Runs `filter` as a subtree search on the profile below its search base DN
 * (remembered per connection, else the profile base) and shows the Search
 * panel with the filter in the advanced mode.
 */
export function findEntries(profileId: string, filter: string) {
  const cs = useConnectionStore.getState()
  if (cs.connectionStatuses[profileId] !== true) {
    toast.info('Connect to the directory to search it.')
    return
  }
  const ss = useSearchStore.getState()
  const baseDN = ss.baseDNs[profileId] ?? cs.profiles.find((p) => p.id === profileId)?.baseDN ?? ''
  if (cs.activeProfileId === profileId) ss.setParams({ filter, scope: ScopeSub })
  ss.setPanelMode('advanced')
  const ui = useUIStore.getState()
  ui.setActivity('search')
  if (!ui.sidebarVisible) ui.toggleSidebar()
  showSearchResults()
  void ss.executeSearch(profileId, filter, { mode: 'advanced', overrides: { baseDN, scope: ScopeSub } })
}

/** Menu items for a schema class or attribute (rendered inside a ContextMenu). */
export function SchemaItemMenu({ target, profileId, onOpen }: { target: SchemaMenuTarget; profileId: string; onOpen: (pin: boolean) => void }) {
  const { item } = target
  const name = item.name
  return (
    <>
      <MenuHeader mono>{name}</MenuHeader>
      <MenuItem icon={ExternalLink} label="Open in New Tab" default onSelect={() => onOpen(true)} />
      {target.kind === 'oc' ? (
        <MenuItem icon={Search} label="Find Entries of This Class" hint={`(objectClass=${name})`} onSelect={() => findEntries(profileId, `(objectClass=${escapeFilterValue(name)})`)} />
      ) : (
        <MenuItem icon={Search} label="Find Entries with This Attribute" hint={`(${name}=*)`} onSelect={() => findEntries(profileId, `(${name}=*)`)} />
      )}
      <MenuSeparator />
      <MenuItem icon={Copy} label="Copy Name" onSelect={() => copy(name, 'Name')} />
      <MenuItem icon={Hash} label="Copy OID" disabled={!item.oid} onSelect={() => copy(item.oid, 'OID')} />
      <MenuItem
        icon={FileCode}
        label="Copy Definition"
        onSelect={() => copy(target.kind === 'oc' ? objectClassDefinition(target.item) : attributeDefinition(target.item), 'Definition')}
      />
    </>
  )
}
