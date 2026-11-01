/**
 * Schema browser (SPEC 10.2): PanelHeader with Refresh ("Schema reloaded:
 * n classes, m attributes" as a status line, no toast for a read), Classes /
 * Attributes tabs with exact counts, SearchInput filter (Ctrl+F while the
 * panel is shown; names, aliases, descriptions, OIDs), one-line rows with
 * the aliases ("mail (rfc822Mailbox)", DEF-25), kind Badges and the schema context
 * menu (copy name / OID / definition, find entries, open in a new tab).
 * Details open as main-area tabs (SchemaDetailView): a click opens the
 * schema preview tab, a double-click (or Ctrl+Enter) keeps it open.
 */
import { useState, useEffect, useMemo } from 'react'
import { BookOpen, Box, RefreshCw, Type } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { useUIStore } from '../../stores/uiStore'
import type { SchemaInfo } from '../../types/ldap'
import * as wails from '../../lib/wails'
import { toast } from '../ui/Toast'
import { Badge } from '../ui/Badge'
import { PanelHeader } from '../ui/PanelHeader'
import { Tabs, TabPanel } from '../ui/Tabs'
import { SearchInput } from '../ui/Input'
import { EmptyState } from '../ui/EmptyState'
import { Skeleton, useDelayedFlag } from '../ui/Spinner'
import { ContextMenu, useContextMenu } from '../ui/Menu'
import { OC_KIND_TONE, forgetSchema, openSchemaTab, parseSchemaTabId, type SchemaKind } from './SchemaDetailView'
import { rememberSchema } from './schemaCache'
import { aliasesOf, hasSchemaName, schemaElementMatches, type NamedSchemaElement } from './schemaModel'
import { SchemaItemMenu, type SchemaMenuTarget } from './schemaActions'

type SchemaTab = 'objectClasses' | 'attributes';
const TABS_ID = 'schema'

export function SchemaBrowser() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const isConnected = useConnectionStore((s) => (s.activeProfileId ? s.connectionStatuses[s.activeProfileId] === true : false));
  const panelShown = useUIStore((s) => s.sidebarVisible && s.activeActivity === 'schema');
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const openRef = parseSchemaTabId(activeTabId);

  const [schema, setSchema] = useState<SchemaInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<SchemaTab>('objectClasses');
  const [filter, setFilter] = useState('');
  const [reloaded, setReloaded] = useState<{ profileId: string; text: string } | null>(null);
  const showSkeleton = useDelayedFlag(loading);
  const menu = useContextMenu<SchemaMenuTarget>();

  useEffect(() => {
    if (activeProfileId && isConnected) {
      void loadSchema(false);
    } else {
      setSchema(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfileId, isConnected]);

  async function loadSchema(refresh: boolean) {
    if (!activeProfileId) return;
    const profileId = activeProfileId;
    setLoading(true);
    try {
      if (refresh) forgetSchema(profileId);
      const s = refresh ? await wails.RefreshSchema(profileId) : await wails.GetSchema(profileId);
      // Detail tabs (and opening one by an alias) use the same schema.
      if (s) rememberSchema(profileId, s);
      if (refresh && s) {
        const at = new Date();
        setReloaded({
          profileId,
          text: `Schema reloaded at ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}: ${s.objectClasses.length} classes, ${s.attributes.length} attributes`,
        });
      }
      if (useConnectionStore.getState().activeProfileId === profileId) setSchema(s);
    } catch (err) {
      toast.error(refresh ? 'Could not refresh the schema' : 'Could not load the schema', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const filteredOCs = useMemo(() => {
    if (!schema) return [];
    const list = [...schema.objectClasses].sort((a, b) => a.name.localeCompare(b.name));
    if (!filter) return list;
    return list.filter((oc) => schemaElementMatches(oc, filter));
  }, [schema, filter]);

  const filteredAttrs = useMemo(() => {
    if (!schema) return [];
    const list = [...schema.attributes].sort((a, b) => a.name.localeCompare(b.name));
    if (!filter) return list;
    return list.filter((at) => schemaElementMatches(at, filter));
  }, [schema, filter]);

  if (!isConnected || !activeProfileId) {
    return (
      <div className="h-full flex flex-col bg-sidebar">
        <PanelHeader title="Schema" />
        <EmptyState icon={BookOpen} title="Not connected" hint="Connect to a directory to browse its schema." />
      </div>
    );
  }

  const open = (kind: SchemaKind, name: string, pin: boolean) => openSchemaTab(activeProfileId, kind, name, pin);
  // A tab opened by an alias (rfc822Mailbox) is the row of its type (mail).
  const isOpen = (kind: SchemaKind, el: NamedSchemaElement) =>
    !!openRef && openRef.profileId === activeProfileId && openRef.kind === kind && hasSchemaName(el, openRef.name);

  return (
    <div className="h-full flex flex-col bg-sidebar">
      <PanelHeader
        title="Schema"
        actions={[{ id: 'refresh', label: 'Refresh Schema', icon: RefreshCw, onClick: () => void loadSchema(true), disabled: loading }]}
        filter={
          <SearchInput
            size="sm"
            value={filter}
            onValueChange={setFilter}
            placeholder="Filter by name, description or OID"
            aria-label="Filter the schema"
            focusKey="Mod+F"
            focusKeyActive={panelShown}
          />
        }
      />

      <Tabs
        variant="sub"
        idPrefix={TABS_ID}
        aria-label="Schema elements"
        value={activeTab}
        onValueChange={(id) => setActiveTab(id as SchemaTab)}
        items={[
          // Exact counts in the label (the count badge caps at 99+).
          { id: 'objectClasses', label: schema ? `Classes (${filter ? `${filteredOCs.length} of ${schema.objectClasses.length}` : schema.objectClasses.length})` : 'Classes', icon: Box },
          { id: 'attributes', label: schema ? `Attributes (${filter ? `${filteredAttrs.length} of ${schema.attributes.length}` : schema.attributes.length})` : 'Attributes', icon: Type },
        ]}
        className="shrink-0"
      />
      {reloaded && reloaded.profileId === activeProfileId && (
        <p className="px-3 py-1 text-xs text-muted-foreground border-b border-border shrink-0" role="status">
          {reloaded.text}
        </p>
      )}

      {loading && !schema ? (
        showSkeleton ? <Skeleton variant="tree" rows={12} className="pt-1" /> : null
      ) : (
        <>
          <TabPanel idPrefix={TABS_ID} value="objectClasses" selected={activeTab} className="flex-1 min-h-0 overflow-auto">
            <SchemaList
              label="Object classes"
              items={filteredOCs.map((oc) => ({
                key: oc.oid + oc.name,
                name: oc.name,
                aliases: aliasesOf(oc),
                detail: oc.description,
                badge: <Badge tone={OC_KIND_TONE[oc.kind] ?? 'neutral'} size="sm">{oc.kind}</Badge>,
                open: (pin: boolean) => open('oc', oc.name, pin),
                current: isOpen('oc', oc),
                onMenu: (e: React.MouseEvent) => menu.open(e, { kind: 'oc', item: oc }),
              }))}
              icon={Box}
            />
          </TabPanel>
          <TabPanel idPrefix={TABS_ID} value="attributes" selected={activeTab} className="flex-1 min-h-0 overflow-auto">
            <SchemaList
              label="Attribute types"
              items={filteredAttrs.map((at) => ({
                key: at.oid + at.name,
                name: at.name,
                aliases: aliasesOf(at),
                detail: at.syntaxName || at.description,
                badge: at.singleValue ? <Badge tone="warning" size="sm">single</Badge> : null,
                open: (pin: boolean) => open('at', at.name, pin),
                current: isOpen('at', at),
                onMenu: (e: React.MouseEvent) => menu.open(e, { kind: 'at', item: at }),
              }))}
              icon={Type}
            />
          </TabPanel>
        </>
      )}
      <ContextMenu point={menu.point} onClose={menu.close} label="Schema actions">
        {() => menu.data && <SchemaItemMenu target={menu.data} profileId={activeProfileId} onOpen={(pin) => open(menu.data!.kind, menu.data!.item.name, pin)} />}
      </ContextMenu>
    </div>
  );
}

interface SchemaListItem {
  key: string;
  name: string;
  /** Further NAMEs, shown after the name. */
  aliases?: string[];
  detail?: string;
  badge?: React.ReactNode;
  open: (pin: boolean) => void;
  current: boolean;
  onMenu: (e: React.MouseEvent) => void;
}

function SchemaList({ items, icon: Icon, label }: { items: SchemaListItem[]; icon: typeof Box; label: string }) {
  if (!items.length) return <EmptyState variant="inline" title="Nothing matches the filter" />;
  return (
    <ul aria-label={label} className="py-0.5">
      {items.map((it) => (
        <li key={it.key}>
          <button type="button"
            onClick={(e) => it.open(e.ctrlKey || e.metaKey)}
            onDoubleClick={() => it.open(true)}
            onContextMenu={it.onMenu}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                it.open(true);
              } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                it.onMenu({ clientX: r.left + 16, clientY: r.bottom, preventDefault: () => {} } as unknown as React.MouseEvent);
              }
            }}
            aria-current={it.current || undefined}
            title={`${it.name}${it.aliases?.length ? ` (also ${it.aliases.join(', ')})` : ''}${it.detail ? ` — ${it.detail}` : ''}`}
            className={cn('w-full flex items-center gap-2 h-row px-3 text-left text-sm focus-ring-inset', it.current ? 'row-selected-inactive' : 'hover:bg-accent')}
          >
            <Icon size={14} strokeWidth={1.75} aria-hidden className="text-muted-foreground shrink-0" />
            <span className="truncate text-foreground">
              {it.name}
              {!!it.aliases?.length && <span className="text-muted-foreground"> ({it.aliases.join(', ')})</span>}
            </span>
            {it.detail && <span className="truncate text-xs text-muted-foreground min-w-0 flex-1">{it.detail}</span>}
            {!it.detail && <span className="flex-1" />}
            {it.badge}
          </button>
        </li>
      ))}
    </ul>
  );
}
