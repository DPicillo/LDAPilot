/**
 * Server Info tab (RootDSE, SPEC 10.2): one DataTable of every RootDSE value
 * (Category, Attribute, Value, Meaning: OID names, functional levels), with a
 * category filter and a text filter. The RootDSE is read completely ("*",
 * "+" and the capability attributes by name: BrowserService.GetRootDSEAll),
 * so supported controls, extensions, features, SASL mechanisms and LDAP
 * versions show on AD, OpenLDAP and 389DS alike; a category the server
 * returned nothing for says so. Naming contexts open as entries; Ctrl+C or
 * the context menu copies a value.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, Database, Globe, RefreshCw, Server, Settings, Shield } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import type { LDAPEntry } from '../../types/ldap'
import { GetRootDSEAll } from '../../lib/wails-serverinfo'
import { DataTable, type DataTableColumn } from '../ui/DataTable'
import { SearchInput, Select } from '../ui/Input'
import { IconButton, type IconType } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { ContextMenu, MenuItem } from '../ui/Menu'
import { TruncatedText } from '../ui/TruncatedText'
import { toast } from '../ui/Toast'

/** Categorize RootDSE attributes for display */
// Categories in display order. A category the server returned nothing for
// shows one "The server returned none" row (so missing controls are visible).
const ATTR_CATEGORIES: Record<string, { label: string; icon: IconType; attrs: string[]; showEmpty?: boolean }> = {
  identity: {
    label: 'Server Identity',
    icon: Server,
    attrs: [
      'vendorName', 'vendorVersion', 'dnsHostName', 'serverName', 'ldapServiceName',
      'dsServiceName', 'currentTime', 'isGlobalCatalogReady', 'isSynchronized', 'altServer',
    ],
  },
  naming: {
    label: 'Naming Contexts',
    icon: Globe,
    attrs: [
      'defaultNamingContext', 'rootDomainNamingContext',
      'configurationNamingContext', 'schemaNamingContext',
      'namingContexts', 'subschemaSubentry',
    ],
    showEmpty: true,
  },
  capabilities: {
    label: 'Capabilities & Versions',
    icon: Shield,
    attrs: [
      'supportedLDAPVersion', 'supportedSASLMechanisms', 'supportedCapabilities', 'supportedFeatures',
      'forestFunctionality', 'domainFunctionality', 'domainControllerFunctionality',
      'highestCommittedUSN', 'supportedLDAPPolicies',
    ],
    showEmpty: true,
  },
  controls: {
    label: 'Supported Controls',
    icon: Settings,
    attrs: ['supportedControl'],
    showEmpty: true,
  },
  extensions: {
    label: 'Supported Extensions',
    icon: Database,
    attrs: ['supportedExtension'],
    showEmpty: true,
  },
};

/** Text of the placeholder row of an empty category. */
export const NONE_RETURNED = 'The server returned none';

/** Names of well-known OIDs (controls, extended operations, features, AD capabilities). */
const KNOWN_OIDS: Record<string, string> = {
  // Active Directory controls
  '1.2.840.113556.1.4.319': 'Paged Results (RFC 2696)',
  '1.2.840.113556.1.4.801': 'Security Descriptor Flags',
  '1.2.840.113556.1.4.473': 'Server-Side Sort (RFC 2891)',
  '1.2.840.113556.1.4.474': 'Sort Response',
  '1.2.840.113556.1.4.417': 'Show Deleted Objects',
  '1.2.840.113556.1.4.2064': 'Show Recycled Objects',
  '1.2.840.113556.1.4.2065': 'Show Deactivated Links',
  '1.2.840.113556.1.4.521': 'Cross-Domain Move',
  '1.2.840.113556.1.4.528': 'Server Notification',
  '1.2.840.113556.1.4.529': 'Extended DN',
  '1.2.840.113556.1.4.619': 'Lazy Commit',
  '1.2.840.113556.1.4.805': 'Tree Delete',
  '1.2.840.113556.1.4.841': 'DirSync',
  '1.2.840.113556.1.4.970': 'Get Statistics',
  '1.2.840.113556.1.4.1338': 'Verify Name',
  '1.2.840.113556.1.4.1339': 'Domain Scope',
  '1.2.840.113556.1.4.1340': 'Search Options',
  '1.2.840.113556.1.4.1341': 'RODC Promotion',
  '1.2.840.113556.1.4.1413': 'Permissive Modify',
  '1.2.840.113556.1.4.1504': 'Attribute Scoped Query',
  '1.2.840.113556.1.4.1852': 'Quota Control',
  '1.2.840.113556.1.4.1907': 'Shutdown Notify',
  '1.2.840.113556.1.4.1948': 'Range Retrieval No-Error',
  '1.2.840.113556.1.4.1974': 'Force Update',
  '1.2.840.113556.1.4.2026': 'Input DN',
  '1.2.840.113556.1.4.2066': 'Policy Hints (deprecated)',
  '1.2.840.113556.1.4.2090': 'DirSync Extended',
  '1.2.840.113556.1.4.2204': 'Tree Delete Extended',
  '1.2.840.113556.1.4.2205': 'Update Statistics',
  '1.2.840.113556.1.4.2206': 'Search Hints',
  '1.2.840.113556.1.4.2211': 'Expected Entry Count',
  '1.2.840.113556.1.4.2239': 'Policy Hints',
  '1.2.840.113556.1.4.2255': 'Set Owner',
  '1.2.840.113556.1.4.2256': 'Bypass Quota',
  '1.2.840.113556.1.4.2309': 'Link TTL',
  '1.2.840.113556.1.4.2330': 'Set Correlation ID',
  '1.2.840.113556.1.4.2354': 'Thread Trace Override',
  // Active Directory capabilities
  '1.2.840.113556.1.4.800': 'Active Directory',
  '1.2.840.113556.1.4.1670': 'Active Directory V51 (2003)',
  '1.2.840.113556.1.4.1791': 'LDAP signing and sealing (integrity)',
  '1.2.840.113556.1.4.1851': 'AD LDS (ADAM)',
  '1.2.840.113556.1.4.1880': 'AD LDS digest authentication',
  '1.2.840.113556.1.4.1920': 'Partial secrets (read-only DC)',
  '1.2.840.113556.1.4.1935': 'Active Directory V60 (2008)',
  '1.2.840.113556.1.4.2080': 'Active Directory V61 R2 (2008 R2)',
  '1.2.840.113556.1.4.2237': 'Active Directory W8 (2012)',
  // Active Directory extended operations
  '1.2.840.113556.1.4.1781': 'Fast Concurrent Bind',
  '1.2.840.113556.1.4.2212': 'Batch Request',
  // Standard / OpenLDAP / 389 Directory Server controls
  '2.16.840.1.113730.3.4.2': 'ManageDsaIT (RFC 3296)',
  '2.16.840.1.113730.3.4.3': 'Persistent Search',
  '2.16.840.1.113730.3.4.4': 'Password Expired',
  '2.16.840.1.113730.3.4.5': 'Password Expiring',
  '2.16.840.1.113730.3.4.9': 'Virtual List View Request',
  '2.16.840.1.113730.3.4.10': 'Virtual List View Response',
  '2.16.840.1.113730.3.4.12': 'Proxied Authorization v1',
  '2.16.840.1.113730.3.4.14': 'Search on a specific backend',
  '2.16.840.1.113730.3.4.15': 'Authorization Identity Response',
  '2.16.840.1.113730.3.4.16': 'Authorization Identity Request',
  '2.16.840.1.113730.3.4.17': 'Real Attributes Only',
  '2.16.840.1.113730.3.4.18': 'Proxied Authorization v2 (RFC 4370)',
  '2.16.840.1.113730.3.4.19': 'Virtual Attributes Only',
  '1.3.6.1.4.1.4203.1.10.1': 'Subentries (RFC 3672)',
  '1.3.6.1.4.1.4203.1.10.2': 'No-Op',
  '1.2.826.0.1.3344810.2.3': 'Matched Values (RFC 3876)',
  '1.3.6.1.1.12': 'Assertion (RFC 4528)',
  '1.3.6.1.1.13.1': 'Pre-Read (RFC 4527)',
  '1.3.6.1.1.13.2': 'Post-Read (RFC 4527)',
  '1.3.6.1.1.22': "Don't Use Copy (RFC 6171)",
  '1.3.6.1.4.1.4203.1.9.1.1': 'Content Synchronization (RFC 4533)',
  '1.3.6.1.4.1.42.2.27.8.5.1': 'Password Policy',
  '1.3.6.1.4.1.4203.666.5.12': 'Relax Rules',
  '1.3.6.1.4.1.4203.666.5.2': 'No-Op (OpenLDAP)',
  // Extended operations
  '1.3.6.1.4.1.1466.20037': 'StartTLS (RFC 4511)',
  '1.3.6.1.4.1.1466.101.119.1': 'Dynamic Refresh (RFC 2589)',
  '1.3.6.1.4.1.4203.1.11.1': 'Password Modify (RFC 3062)',
  '1.3.6.1.4.1.4203.1.11.3': 'Who Am I? (RFC 4532)',
  '1.3.6.1.1.8': 'Cancel (RFC 3909)',
  '1.3.6.1.1.21.1': 'Start Transaction (RFC 5805)',
  '1.3.6.1.1.21.3': 'End Transaction (RFC 5805)',
  // Features
  '1.3.6.1.1.14': 'Modify-Increment (RFC 4525)',
  '1.3.6.1.4.1.4203.1.5.1': 'All Operational Attributes "+" (RFC 3673)',
  '1.3.6.1.4.1.4203.1.5.2': 'Attributes by Object Class "@" (RFC 4529)',
  '1.3.6.1.4.1.4203.1.5.3': 'Absolute True/False Filters (RFC 4526)',
  '1.3.6.1.4.1.4203.1.5.4': 'Language Tags (RFC 3866)',
  '1.3.6.1.4.1.4203.1.5.5': 'Language Ranges (RFC 3866)',
};

const FUNC_LEVELS: Record<string, string> = {
  '0': 'Windows 2000',
  '1': 'Windows 2003 interim',
  '2': 'Windows 2003',
  '3': 'Windows 2008',
  '4': 'Windows 2008 R2',
  '5': 'Windows 2012',
  '6': 'Windows 2012 R2',
  '7': 'Windows 2016',
};

/** RootDSE attributes whose values are DNs (clicking opens the entry). */
const DN_ATTRS = new Set([
  'defaultnamingcontext', 'rootdomainnamingcontext', 'configurationnamingcontext', 'schemanamingcontext',
  'namingcontexts', 'dsservicename', 'servername', 'subschemasubentry',
])

interface InfoRow {
  key: string
  category: string
  categoryLabel: string
  order: number
  attr: string
  value: string
  meaning: string
  /** Placeholder of an empty category ("The server returned none"). */
  none?: boolean
}

function meaningOf(attrName: string, value: string): string {
  const lower = attrName.toLowerCase()
  if (lower.includes('functionality')) return FUNC_LEVELS[value] || 'Unknown level'
  if (lower.includes('control') || lower.includes('extension') || lower.includes('capabilities') || lower.includes('features')) return KNOWN_OIDS[value] ?? ''
  return ''
}

function buildRows(rootDSE: LDAPEntry | null): InfoRow[] {
  if (!rootDSE) return []
  const attrs = rootDSE.attributes ?? []
  const byName = new Map(attrs.map((a) => [a.name.toLowerCase(), a]))
  const rows: InfoRow[] = []
  const seen = new Set<string>()
  let order = 0
  const push = (category: string, categoryLabel: string, name: string, values: string[]) => {
    values.forEach((v, i) => rows.push({ key: `${name}\n${i}`, category, categoryLabel, order: order++, attr: name, value: v, meaning: meaningOf(name, v) }))
  }
  for (const [key, cat] of Object.entries(ATTR_CATEGORIES)) {
    let any = false
    for (const want of cat.attrs) {
      const a = byName.get(want.toLowerCase())
      if (!a || !a.values.length) continue
      seen.add(want.toLowerCase())
      any = true
      push(key, cat.label, a.name, a.binary ? [`<binary, ${a.values.length} value(s)>`] : a.values)
    }
    if (!any && cat.showEmpty) {
      rows.push({ key: `${key}\nnone`, category: key, categoryLabel: cat.label, order: order++, attr: cat.attrs.length === 1 ? cat.attrs[0] : '', value: NONE_RETURNED, meaning: '', none: true })
    }
  }
  for (const a of attrs) {
    if (seen.has(a.name.toLowerCase()) || !a.values.length) continue
    push('other', 'Other Attributes', a.name, a.binary ? [`<binary, ${a.values.length} value(s)>`] : a.values)
  }
  return rows
}

const CATEGORY_OPTIONS = [
  { value: '', label: 'All categories' },
  ...Object.entries(ATTR_CATEGORIES).map(([value, c]) => ({ value, label: c.label })),
  { value: 'other', label: 'Other Attributes' },
]

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch (err) {
    toast.error(`Could not copy ${what}`, err instanceof Error ? err.message : String(err))
  }
}

export function ServerInfo() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId)
  const isConnected = useConnectionStore((s) => (s.activeProfileId ? s.connectionStatuses[s.activeProfileId] === true : false))
  const activeProfile = useConnectionStore((s) => (s.activeProfileId ? s.profiles.find((p) => p.id === s.activeProfileId) : undefined))
  const openEntry = useEditorStore((s) => s.openEntry)

  const [rootDSE, setRootDSE] = useState<LDAPEntry | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [category, setCategory] = useState('')
  const [menu, setMenu] = useState<{ point: { clientX: number; clientY: number }; row: InfoRow } | null>(null)

  const load = useCallback(async () => {
    if (!activeProfileId) return
    setLoading(true)
    setError(null)
    try {
      setRootDSE(await GetRootDSEAll(activeProfileId))
    } catch (err) {
      setRootDSE(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [activeProfileId])

  useEffect(() => {
    if (!activeProfileId || !isConnected) {
      setRootDSE(null)
      return
    }
    void load()
  }, [activeProfileId, isConnected, load])

  const rows = useMemo(() => buildRows(rootDSE), [rootDSE])
  const valueCount = useMemo(() => rows.filter((r) => !r.none).length, [rows])
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return rows.filter(
      (r) =>
        (!category || r.category === category) &&
        (!q || r.attr.toLowerCase().includes(q) || r.value.toLowerCase().includes(q) || r.meaning.toLowerCase().includes(q)),
    )
  }, [rows, filter, category])

  const columns = useMemo<DataTableColumn<InfoRow>[]>(
    () => [
      {
        id: 'category',
        header: 'Category',
        value: (r) => `${String(r.order).padStart(5, '0')}`,
        cell: (r) => <TruncatedText text={r.categoryLabel} className="text-muted-foreground" />,
        sortable: true,
        width: 150,
        minWidth: 80,
      },
      { id: 'attr', header: 'Attribute', value: (r) => r.attr, sortable: true, mono: true, width: 220, minWidth: 100, hideable: false },
      {
        id: 'value',
        header: 'Value',
        value: (r) => r.value,
        renderer: 'text',
        cell: (r) =>
          r.none ? (
            <span className="text-muted-foreground italic">{r.value}</span>
          ) : DN_ATTRS.has(r.attr.toLowerCase()) && activeProfileId ? (
            <button type="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); openEntry(activeProfileId, r.value) }} className="block max-w-full text-left text-primary hover:underline">
              <TruncatedText text={r.value} />
            </button>
          ) : (
            <TruncatedText text={r.value} />
          ),
        sortable: true,
        mono: true,
        width: 320,
        minWidth: 120,
      },
      { id: 'meaning', header: 'Meaning', value: (r) => r.meaning, sortable: true, width: 220, minWidth: 80 },
    ],
    [activeProfileId, openEntry],
  )

  if (!isConnected) {
    return <EmptyState icon={Server} title="Not connected" hint="Connect to a server to view its RootDSE." />
  }

  return (
    <div className="h-full flex flex-col min-w-0 bg-background">
      <div className="flex items-center gap-2 px-3 h-panel-header border-b border-border bg-card shrink-0 min-w-0">
        <Server size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-semibold truncate">{activeProfile?.name || 'Server Info'}</h2>
        <span className="text-xs text-muted-foreground font-mono tabular-nums truncate">
          {activeProfile?.host}:{activeProfile?.port}
        </span>
        <span className="flex-1" />
        <IconButton label="Refresh" icon={RefreshCw} size="md" disabled={loading} onClick={() => void load()} />
      </div>
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border shrink-0 min-w-0">
        <SearchInput value={filter} onValueChange={setFilter} placeholder="Filter attributes and values" aria-label="Filter RootDSE values" size="sm" wrapperClassName="flex-1 min-w-[120px] max-w-[320px]" />
        <Select size="sm" aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} options={CATEGORY_OPTIONS} className="w-auto" />
        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap" role="status">
          {(() => {
            const shown = filtered.filter((r) => !r.none).length
            const word = (n: number) => `${n} value${n === 1 ? '' : 's'}`
            return shown === valueCount ? word(valueCount) : `${shown} of ${word(valueCount)}`
          })()}
        </span>
      </div>
      <div className="flex-1 min-h-0">
        <DataTable<InfoRow>
          aria-label="RootDSE"
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.key}
          getRowDn={(r) => r.value}
          selection="single"
          virtualized
          columnChooser
          persistKey="server-info"
          loading={loading}
          error={error ?? undefined}
          onOpen={(r) => {
            if (!r.none && DN_ATTRS.has(r.attr.toLowerCase()) && activeProfileId) openEntry(activeProfileId, r.value)
          }}
          onContextMenu={(point, rs) => rs[0] && setMenu({ point, row: rs[0] })}
          empty={<EmptyState variant="inline" icon={Database} title={rows.length ? (category && !filter.trim() ? NONE_RETURNED : 'No values match the filter') : 'The server returned no RootDSE attributes'} />}
        />
      </div>
      <ContextMenu point={menu?.point ?? null} onClose={() => setMenu(null)} label="Value actions">
        {() =>
          menu ? (
            <>
              <MenuItem icon={Copy} label="Copy Value" shortcut="Mod+C" onSelect={() => void copyText(menu.row.value, 'Value')} />
              <MenuItem icon={Copy} label="Copy Attribute Name" onSelect={() => void copyText(menu.row.attr, 'Attribute name')} />
              <MenuItem icon={Copy} label="Copy as attribute: value" onSelect={() => void copyText(`${menu.row.attr}: ${menu.row.value}`, 'Line')} />
              {!menu.row.none && DN_ATTRS.has(menu.row.attr.toLowerCase()) && activeProfileId && (
                <MenuItem icon={Globe} label="Open Entry" default onSelect={() => openEntry(activeProfileId, menu.row.value)} />
              )}
            </>
          ) : null
        }
      </ContextMenu>
    </div>
  )
}
