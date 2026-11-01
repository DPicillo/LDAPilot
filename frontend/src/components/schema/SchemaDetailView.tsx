/**
 * Schema details as main-area tabs (SPEC 10.2 SchemaBrowser "Details as main
 * tabs"). Tab ids: `__schema__|<profileId>|oc|<name>` (object class) and
 * `__schema__|<profileId>|at|<name>` (attribute type). The schema comes from
 * SchemaService.GetSchema (cached per connection, schemaCache.ts).
 *
 * A schema tab belongs to a connection: its label and header name it (the
 * active connection may be another one). Classes list their required and
 * optional attributes including the inherited ones, grouped by the class that
 * defines them ("from person: cn, sn"), sorted. Every chip has the schema
 * context menu (copy, find entries, open in a new tab). A tab opened by an
 * alias or OID (rfc822Mailbox) shows the element itself (mail) with its
 * aliases (DEF-25).
 *
 * Opening from the browser list is a preview tab (one schema preview at a
 * time, replaced by the next); a double-click on the list item or the tab,
 * or a link inside a detail view with Ctrl, pins it.
 */
import { useEffect, useMemo, useState } from 'react'
import { Box, Type } from 'lucide-react'
import { useEditorStore } from '../../stores/editorStore'
import { useConnectionStore } from '../../stores/connectionStore'
import type { EditorTab } from '../../types/ui'
import type { SchemaAttribute, SchemaInfo, SchemaObjectClass } from '../../types/ldap'
import { Badge, type BadgeTone } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { InlineAlert } from '../ui/InlineAlert'
import { Spinner } from '../ui/Spinner'
import { ContextMenu, useContextMenu } from '../ui/Menu'
import { ConnectionTag } from '../bulk/BulkViews'
import { loadSchema, loadedSchema, forgetSchema as forgetCachedSchema } from './schemaCache'
import { aliasesOf, classAttributes, findAttribute, findObjectClass, hasSchemaName, sortedNames, type AttributeGroup } from './schemaModel'
import { SchemaItemMenu, type SchemaMenuTarget } from './schemaActions'

export type SchemaKind = 'oc' | 'at'
const PREFIX = '__schema__|'

export function schemaTabId(profileId: string, kind: SchemaKind, name: string): string {
  return `${PREFIX}${profileId}|${kind}|${name}`
}

export function parseSchemaTabId(id: string | null | undefined): { profileId: string; kind: SchemaKind; name: string } | null {
  if (!id || !id.startsWith(PREFIX)) return null
  const [profileId, kind, ...rest] = id.slice(PREFIX.length).split('|')
  if (!profileId || (kind !== 'oc' && kind !== 'at') || !rest.length) return null
  return { profileId, kind, name: rest.join('|') }
}

/** Tab label: the element and its connection ("user · Lab AD"). */
function schemaTabLabel(profileId: string, name: string): string {
  const conn = useConnectionStore.getState().profiles.find((p) => p.id === profileId)?.name
  return conn ? `${name} · ${conn}` : name
}

/**
 * Opens a schema detail tab; `pin` false = the schema preview tab (replaced
 * by the next preview). An alias or OID opens the element's own tab
 * (rfc822Mailbox -> mail) once the schema has been read.
 */
export function openSchemaTab(profileId: string, kind: SchemaKind, requested: string, pin = false) {
  const schema = loadedSchema(profileId)
  const name = (kind === 'oc' ? findObjectClass(schema, requested) : findAttribute(schema, requested))?.name ?? requested
  const id = schemaTabId(profileId, kind, name)
  useEditorStore.setState((st) => {
    if (st.tabs.some((t) => t.id === id)) {
      return { activeTabId: id, tabs: pin ? st.tabs.map((t) => (t.id === id ? { ...t, preview: undefined } : t)) : st.tabs }
    }
    const tab: EditorTab = { id, profileId: '', label: schemaTabLabel(profileId, name), dn: '', dirty: false, preview: pin ? undefined : true }
    const replace = pin ? -1 : st.tabs.findIndex((t) => t.preview && parseSchemaTabId(t.id))
    const tabs = [...st.tabs]
    if (replace >= 0) tabs[replace] = tab
    else tabs.push(tab)
    return { tabs, activeTabId: id }
  })
}

export const OC_KIND_TONE: Record<string, BadgeTone> = { structural: 'primary', auxiliary: 'success', abstract: 'warning' }

/** Forget the cached schema of a profile (SchemaBrowser Refresh). */
export function forgetSchema(profileId: string) {
  forgetCachedSchema(profileId)
}

export function SchemaDetailView({ tabId }: { tabId: string }) {
  const ref = parseSchemaTabId(tabId)
  const [schema, setSchema] = useState<SchemaInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!ref) return
    let alive = true
    setError(null)
    loadSchema(ref.profileId)
      .then((s) => alive && setSchema(s))
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.profileId])

  const name = ref?.name ?? ''
  const oc = useMemo(() => (ref?.kind === 'oc' ? findObjectClass(schema, name) : undefined), [schema, ref?.kind, name])
  const at = useMemo(() => (ref?.kind === 'at' ? findAttribute(schema, name) : undefined), [schema, ref?.kind, name])
  const menu = useContextMenu<SchemaMenuTarget>()

  if (!ref) return null
  if (error) return <div className="p-4"><InlineAlert tone="danger" title="The schema could not be read" body={error} /></div>
  if (!schema) {
    return (
      <div className="h-full flex items-center justify-center">
        <Spinner label="Loading the schema" />
      </div>
    )
  }
  if (!oc && !at) {
    return <EmptyState icon={ref.kind === 'oc' ? Box : Type} title={`${ref.name} is not in the schema`} hint="It may have been removed; refresh the schema browser." />
  }
  const open = (kind: SchemaKind, name: string, pin: boolean) => openSchemaTab(ref.profileId, kind, name, pin)
  const onMenu = (e: React.MouseEvent, kind: SchemaKind, name: string) => {
    const target: SchemaMenuTarget | null =
      kind === 'oc'
        ? (() => { const item = findObjectClass(schema, name); return item ? { kind: 'oc' as const, item } : null })()
        : (() => { const item = findAttribute(schema, name); return item ? { kind: 'at' as const, item } : null })()
    if (target) menu.open(e, target)
  }
  return (
    <div className="h-full overflow-auto">
      <div className="max-w-[880px] p-4 space-y-4">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Schema of <ConnectionTag profileId={ref.profileId} />
        </p>
        {oc ? (
          <ClassDetail oc={oc} schema={schema} open={open} onMenu={onMenu} onHeaderMenu={(e) => menu.open(e, { kind: 'oc', item: oc })} />
        ) : (
          <AttributeDetail at={at!} schema={schema} open={open} onMenu={onMenu} onHeaderMenu={(e) => menu.open(e, { kind: 'at', item: at! })} />
        )}
      </div>
      <ContextMenu point={menu.point} onClose={menu.close} label="Schema actions">
        {() => menu.data && <SchemaItemMenu target={menu.data} profileId={ref.profileId} onOpen={(pin) => open(menu.data!.kind, menu.data!.item.name, pin)} />}
      </ContextMenu>
    </div>
  )
}

type Opener = (kind: SchemaKind, name: string, pin: boolean) => void
type MenuOpener = (e: React.MouseEvent, kind: SchemaKind, name: string) => void

function Header({ icon: Icon, name, badge, oid, description, onMenu }: { icon: typeof Box; name: string; badge?: React.ReactNode; oid: string; description?: string; onMenu: (e: React.MouseEvent) => void }) {
  return (
    <header className="space-y-1" onContextMenu={onMenu}>
      <div className="flex items-center gap-2 min-w-0">
        <Icon size={20} strokeWidth={1.75} aria-hidden className="text-muted-foreground shrink-0" />
        <h2 className="text-xl font-semibold text-foreground truncate">{name}</h2>
        {badge}
      </div>
      <p className="text-sm font-mono text-muted-foreground select-text">{oid}</p>
      {description && <p className="text-base text-foreground">{description}</p>}
    </header>
  )
}

function Links({ kind, names, open, onMenu, tone = 'neutral', empty }: { kind: SchemaKind; names: string[]; open: Opener; onMenu: MenuOpener; tone?: BadgeTone; empty?: string }) {
  if (!names.length) return <p className="text-sm text-muted-foreground">{empty ?? 'None'}</p>
  return (
    <ul className="flex flex-wrap gap-1">
      {names.map((n) => (
        <li key={n}>
          <button type="button"
            onClick={(e) => open(kind, n, e.ctrlKey || e.metaKey)}
            onContextMenu={(e) => onMenu(e, kind, n)}
            className="rounded-sm focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-1"
            title={`Open ${n} (Ctrl+click keeps it open; right-click for more)`}
          >
            <Badge tone={tone} className="font-mono cursor-pointer hover:underline">
              {n}
            </Badge>
          </button>
        </li>
      ))}
    </ul>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_minmax(0,1fr)] gap-x-3 py-1 border-b border-border">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground min-w-0 break-words">{children}</dd>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

/** Own attributes first, then "from <class>" groups (inherited along SUP). */
function GroupedLinks({ groups, open, onMenu, tone }: { groups: AttributeGroup[]; open: Opener; onMenu: MenuOpener; tone?: BadgeTone }) {
  const own = groups.find((g) => g.from === '')
  const inherited = groups.filter((g) => g.from !== '')
  return (
    <div className="space-y-1.5">
      <Links kind="at" names={own?.names ?? []} open={open} onMenu={onMenu} tone={tone} empty={inherited.length ? 'None of its own' : 'None'} />
      {inherited.map((g) => (
        <div key={g.from} className="flex items-start gap-2">
          <span className="text-xs text-muted-foreground shrink-0 pt-0.5">
            from{' '}
            <button type="button" onClick={(e) => open('oc', g.from, e.ctrlKey || e.metaKey)} onContextMenu={(e) => onMenu(e, 'oc', g.from)} className="font-mono text-foreground hover:underline rounded-xs focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus">
              {g.from}
            </button>
            :
          </span>
          <Links kind="at" names={g.names} open={open} onMenu={onMenu} tone={tone} />
        </div>
      ))}
    </div>
  )
}

/** The further NAMEs of an element; a schema lookup by any of them finds it (DEF-25). */
function AliasRow({ aliases }: { aliases: string[] }) {
  if (!aliases.length) return null
  return (
    <Row label={aliases.length === 1 ? 'Alias' : 'Aliases'}>
      <span className="font-mono select-text">{aliases.join(', ')}</span>
    </Row>
  )
}

function ClassDetail({ oc, schema, open, onMenu, onHeaderMenu }: { oc: SchemaObjectClass; schema: SchemaInfo; open: Opener; onMenu: MenuOpener; onHeaderMenu: (e: React.MouseEvent) => void }) {
  const subclasses = sortedNames(schema.objectClasses.filter((o) => o.superClass?.some((s) => hasSchemaName(oc, s))).map((o) => o.name))
  const attrs = useMemo(() => classAttributes(schema, oc), [schema, oc])
  return (
    <>
      <Header icon={Box} name={oc.name} oid={oc.oid} description={oc.description} onMenu={onHeaderMenu} badge={<Badge tone={OC_KIND_TONE[oc.kind] ?? 'neutral'}>{oc.kind}</Badge>} />
      <dl>
        <AliasRow aliases={aliasesOf(oc)} />
        <Row label="Inherits from">{oc.superClass?.length ? <Links kind="oc" names={oc.superClass} open={open} onMenu={onMenu} /> : 'None'}</Row>
        <Row label="Subclasses">
          <Links kind="oc" names={subclasses} open={open} onMenu={onMenu} empty="None" />
        </Row>
      </dl>
      <Section title={`Required attributes (${attrs.mustCount})`}>
        <GroupedLinks groups={attrs.must} open={open} onMenu={onMenu} tone="danger" />
      </Section>
      <Section title={`Optional attributes (${attrs.mayCount})`}>
        <GroupedLinks groups={attrs.may} open={open} onMenu={onMenu} />
      </Section>
    </>
  )
}

function AttributeDetail({ at, schema, open, onMenu, onHeaderMenu }: { at: SchemaAttribute; schema: SchemaInfo; open: Opener; onMenu: MenuOpener; onHeaderMenu: (e: React.MouseEvent) => void }) {
  // Definitions may name the type by an alias or its OID (cosine's pilotPerson: MAY rfc822Mailbox).
  const usedMust = sortedNames(schema.objectClasses.filter((o) => o.must?.some((a) => hasSchemaName(at, a))).map((o) => o.name))
  const usedMay = sortedNames(schema.objectClasses.filter((o) => o.may?.some((a) => hasSchemaName(at, a))).map((o) => o.name))
  const subtypes = sortedNames(schema.attributes.filter((a) => !!a.superType && hasSchemaName(at, a.superType)).map((a) => a.name))
  return (
    <>
      <Header
        icon={Type}
        name={at.name}
        oid={at.oid}
        description={at.description}
        onMenu={onHeaderMenu}
        badge={
          <span className="flex gap-1">
            {at.singleValue && <Badge tone="warning">single-valued</Badge>}
            {at.noUserMod && <Badge tone="neutral">read-only</Badge>}
          </span>
        }
      />
      <dl>
        <AliasRow aliases={aliasesOf(at)} />
        <Row label="Syntax">
          {at.syntaxName ? (
            <>
              {at.syntaxName} <span className="font-mono text-muted-foreground">{at.syntax}</span>
            </>
          ) : (
            <span className="font-mono">{at.syntax || '—'}</span>
          )}
        </Row>
        {at.superType && (
          <Row label="Inherits from">
            <Links kind="at" names={[at.superType]} open={open} onMenu={onMenu} />
          </Row>
        )}
        {subtypes.length > 0 && (
          <Row label="Subtypes">
            <Links kind="at" names={subtypes} open={open} onMenu={onMenu} />
          </Row>
        )}
        <Row label="Single-valued">{at.singleValue ? 'Yes' : 'No'}</Row>
        <Row label="User-modifiable">{at.noUserMod ? 'No (server-managed)' : 'Yes'}</Row>
        {at.usage && <Row label="Usage">{at.usage}</Row>}
        <Row label="Equality rule"><span className="font-mono">{at.equality || '—'}</span></Row>
        <Row label="Ordering rule"><span className="font-mono">{at.ordering || '—'}</span></Row>
        <Row label="Substring rule"><span className="font-mono">{at.substring || '—'}</span></Row>
      </dl>
      <Section title={`Required by (${usedMust.length})`}>
        <Links kind="oc" names={usedMust} open={open} onMenu={onMenu} tone="danger" />
      </Section>
      <Section title={`Allowed in (${usedMay.length})`}>
        <Links kind="oc" names={usedMay} open={open} onMenu={onMenu} />
      </Section>
    </>
  )
}
