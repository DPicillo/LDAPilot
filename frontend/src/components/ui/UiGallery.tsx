/**
 * UiGallery (SPEC 6.4 / 10.1 P3) — dev only. AppLayout renders it instead of
 * the shell when `import.meta.env.DEV && location.search.includes('ui-gallery')`
 * (or via the "Developer: UI Gallery" command). Every primitive in every
 * variant and state, in the current theme, as the Playwright surface for
 * screenshots, the contrast scan and the keyboard scripts.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FilePlus2,
  Filter,
  KeyRound,
  ListFilter,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Trash2,
  Upload,
  UserPlus,
  Users,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { useUIStore } from '../../stores/uiStore'
import { THEME_OPTIONS, DENSITY_OPTIONS, type ThemePref, type Density } from './theme'
import { Button, IconButton } from './Button'
import { Field } from './Field'
import { Input, Select, SearchInput, Textarea } from './Input'
import { Checkbox, RadioGroup, Switch } from './Checkbox'
import { SegmentedControl } from './SegmentedControl'
import { TabPanel, Tabs, type TabItem } from './Tabs'
import {
  CommandMenuItems,
  ContextMenu,
  DropdownMenu,
  MenuBar,
  MenuCheckboxItem,
  MenuHeader,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  SubMenu,
  isContextMenuKey,
  useContextMenu,
} from './Menu'
import { DropdownPanel } from './Popover'
import { Combobox, Listbox } from './Listbox'
import { Badge, CountBadge, type BadgeTone } from './Badge'
import { StatusChip } from './StatusChip'
import { ObjectIcon } from './ObjectIcon'
import { Dn } from './Dn'
import { TruncatedText } from './TruncatedText'
import { DnBreadcrumb } from './DnBreadcrumb'
import { PanelHeader } from './PanelHeader'
import { Toolbar } from './Toolbar'
import { EmptyState } from './EmptyState'
import { Banner, InlineAlert } from './InlineAlert'
import { ProgressBar, Skeleton, Spinner, useDelayedFlag } from './Spinner'
import { Kbd } from './Kbd'
import { Tooltip } from './Tooltip'
import { DataTable, type DataTableColumn } from './DataTable'
import { useTreeKeyboard, type TreeKeyboardItem } from './useTreeKeyboard'
import { EntrySummaryHeader } from './EntrySummaryHeader'
import { Dialog, useDialogStore, type HostedDialogProps } from './Dialog'
import { ConfirmDialog } from './ConfirmDialog'
import { ErrorBoundary } from './ErrorBoundary'
import { NotificationBell } from './NotificationLog'
import { usePaletteStore } from './paletteStore'
import { deriveAccountStatus, type AccountStatus, type AccountStatusKind } from './accountStatus'
import { OBJECT_KIND_LABEL, type ObjectKind } from './objectKind'
import type { CommandContext, SelectionItem } from './commands'
import { formatShortcut } from './shortcuts'

const BASE = 'OU=LDAPilot,DC=lab,DC=local'
const NOW = new Date()
const ft = (d: Date) => String(BigInt(d.getTime() + 11_644_473_600_000) * 10000n)
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)

const LOCKED: AccountStatus[] = deriveAccountStatus({ userAccountControl: '512', lockoutTime: ft(new Date(NOW.getTime() - 2 * 3_600_000)) }, { now: NOW })
const DISABLED: AccountStatus[] = deriveAccountStatus({ userAccountControl: '514' }, { now: NOW })
const MIXED: AccountStatus[] = deriveAccountStatus(
  { userAccountControl: String(512 | 0x10000), pwdLastSet: '0', accountExpires: ft(new Date(NOW.getTime() + 5 * 86_400_000)) },
  { now: NOW },
)

function ctxFor(selection: SelectionItem[], extra: Partial<CommandContext> = {}): CommandContext {
  return { profileId: 'gallery', serverType: 'ad', connected: true, readOnly: false, selection, source: 'tree', ...extra }
}
const SEL: Record<string, SelectionItem> = {
  user: { dn: `CN=Test Locked,OU=Special,OU=Users,${BASE}`, kind: 'user', status: ['locked'], label: 'Test Locked' },
  userDisabled: { dn: `CN=Test Disabled,OU=Special,OU=Users,${BASE}`, kind: 'user', status: ['disabled'] },
  group: { dn: `CN=GG-Nested-Level1,OU=Groups,${BASE}`, kind: 'group' },
  computer: { dn: `CN=SRV-APP01,OU=Servers,OU=Computers,${BASE}`, kind: 'computer' },
  ou: { dn: `OU=Users,${BASE}`, kind: 'ou' },
  contact: { dn: `CN=Bulk Contact 0001,OU=Bulk,${BASE}`, kind: 'contact' },
}

function Section({ id, title, children, className }: { id: string; title: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className={cn('border border-border rounded-lg bg-card', className)}>
      <h2 id={`${id}-h`} className="px-3 h-panel-header flex items-center border-b border-border text-xs font-semibold uppercase tracking-wide">
        {title}
      </h2>
      <div className="p-3 flex flex-col gap-3">{children}</div>
    </section>
  )
}

function Row({ label, children, className }: { label?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {label && <span className="w-36 shrink-0 text-xs text-muted-foreground">{label}</span>}
      {children}
    </div>
  )
}

/** A menu rendered inline (not portaled) so every per-type set is visible at once. */
function StaticMenu({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{title}</span>
      <div role="menu" aria-label={title} className="w-[260px] py-1 bg-popover text-popover-foreground border border-border-strong/60 rounded-md shadow-popover text-sm">
        {children}
      </div>
    </div>
  )
}

// --- Fake tree (2,000 rows) ------------------------------------------------------

interface FakeNode {
  id: string
  label: string
  level: number
  parentId: string | null
  kind: ObjectKind
  status?: AccountStatusKind
  children: FakeNode[]
}

function buildTree(): FakeNode[] {
  const roots: FakeNode[] = []
  const domain: FakeNode = { id: 'DC=lab,DC=local', label: 'lab.local', level: 1, parentId: null, kind: 'domain', children: [] }
  roots.push(domain)
  for (let o = 0; o < 20; o++) {
    const ou: FakeNode = { id: `OU=Dept ${o + 1},DC=lab,DC=local`, label: `Dept ${String(o + 1).padStart(2, '0')}`, level: 2, parentId: domain.id, kind: 'ou', children: [] }
    domain.children.push(ou)
    for (let i = 0; i < 99; i++) {
      const kind: ObjectKind = i % 10 === 0 ? 'group' : i % 13 === 0 ? 'computer' : i % 17 === 0 ? 'contact' : 'user'
      const status: AccountStatusKind | undefined = kind === 'user' && i % 11 === 0 ? 'locked' : kind === 'user' && i % 7 === 0 ? 'disabled' : undefined
      ou.children.push({ id: `CN=Object ${o}-${i},${ou.id}`, label: `${OBJECT_KIND_LABEL[kind]} ${o + 1}-${String(i + 1).padStart(3, '0')}`, level: 3, parentId: ou.id, kind, status, children: [] })
    }
  }
  return roots
}

function GalleryTree() {
  const roots = useMemo(buildTree, [])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['DC=lab,DC=local', ...roots[0].children.map((c) => c.id)]))
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [log, setLog] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const flat = useMemo(() => {
    const out: FakeNode[] = []
    const walk = (ns: FakeNode[]) => {
      for (const n of ns) {
        out.push(n)
        if (expanded.has(n.id)) walk(n.children)
      }
    }
    walk(roots)
    return out
  }, [roots, expanded])
  const byId = useMemo(() => new Map(flat.map((n) => [n.id, n])), [flat])
  const items: TreeKeyboardItem[] = useMemo(
    () => flat.map((n) => ({ id: n.id, label: n.label, level: n.level, parentId: n.parentId, expandable: n.children.length > 0, expanded: expanded.has(n.id) })),
    [flat, expanded],
  )
  const virt = useVirtualizer({ count: flat.length, getScrollElement: () => scrollRef.current, estimateSize: () => 22, overscan: 10 })
  const flatIds = useMemo(() => flat.map((n) => n.id), [flat])

  const tree = useTreeKeyboard({
    items,
    label: 'Gallery tree (2,000 rows)',
    multiSelect: true,
    selectedIds: selected,
    pageSize: 12,
    onSelect: (id, mode, anchor) => {
      setSelected((prev) => {
        if (mode === 'toggle') {
          const n = new Set(prev)
          if (n.has(id)) n.delete(id)
          else n.add(id)
          return n
        }
        if (mode === 'range' && anchor) {
          const a = flatIds.indexOf(anchor)
          const b = flatIds.indexOf(id)
          return new Set(flatIds.slice(Math.min(a, b), Math.max(a, b) + 1))
        }
        return new Set([id])
      })
    },
    onExpand: (id) => setExpanded((p) => new Set(p).add(id)),
    onCollapse: (id) => setExpanded((p) => {
      const n = new Set(p)
      n.delete(id)
      return n
    }),
    onOpen: (id, o) => setLog(`open ${o.pin ? 'pinned' : 'preview'}: ${byId.get(id)?.label}`),
    onRename: (id) => setLog(`rename: ${byId.get(id)?.label}`),
    onDelete: (ids) => setLog(`delete ${ids.length}`),
    onCopyDn: (ids) => setLog(`copy DN: ${ids[0]}`),
    onContextMenu: (id) => setLog(`context menu: ${byId.get(id)?.label}`),
    onParent: (id) => setLog(`parent: ${byId.get(id)?.label}`),
    onExpandSiblings: (ids) => setExpanded((p) => new Set([...p, ...ids])),
    scrollToIndex: (i) => virt.scrollToIndex(i, { align: 'auto' }),
  })
  const [hasFocus, setHasFocus] = useState(false)
  const tp = tree.getTreeProps()

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={scrollRef}
        className="h-[264px] overflow-auto border border-border rounded bg-sidebar"
        data-testid="gallery-tree-scroll"
        onFocus={() => setHasFocus(true)}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setHasFocus(false)}
      >
        <div {...tp} className="relative outline-hidden focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2" style={{ height: virt.getTotalSize() }}>
          {virt.getVirtualItems().map((vi) => {
            const n = flat[vi.index]
            const it = items[vi.index]
            const sel = selected.has(n.id)
            return (
              <div
                key={n.id}
                {...tree.getItemProps(it)}
                onClick={(e) => {
                  tree.setFocusedId(n.id)
                  tree.select(n.id, e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'range' : 'replace')
                }}
                className={cn(
                  'absolute left-0 right-0 h-row flex items-center gap-1 pr-2 text-sm cursor-default focus-ring-inset outline-hidden',
                  sel ? (hasFocus ? 'row-selected' : 'row-selected-inactive') : 'hover:bg-accent',
                )}
                style={{ top: vi.start, paddingLeft: 6 + 12 * (n.level - 1), ['--row-bg' as string]: sel ? 'var(--color-selection)' : 'var(--color-sidebar)' }}
              >
                <span
                  className="size-3.5 flex items-center justify-center text-muted-foreground shrink-0"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (it.expandable) setExpanded((p) => {
                      const s = new Set(p)
                      if (s.has(n.id)) s.delete(n.id)
                      else s.add(n.id)
                      return s
                    })
                  }}
                >
                  {it.expandable && (it.expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />)}
                </span>
                <ObjectIcon kind={n.kind} status={n.status} />
                <span className="truncate">{n.label}</span>
                {n.children.length > 0 && <span className="ml-auto text-xs text-muted-foreground tabular-nums">{n.children.length}</span>}
              </div>
            )
          })}
        </div>
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite" data-testid="gallery-tree-log">
        {flat.length.toLocaleString()} rows · focused {tree.focusedId ? byId.get(tree.focusedId)?.label : '—'} · {selected.size} selected {log && `· ${log}`}
      </p>
    </div>
  )
}

// --- Table data -------------------------------------------------------------------

interface UserRow {
  dn: string
  name: string
  login: string
  type: ObjectKind
  status: AccountStatus[]
  lastLogon: string
  uac: number
  dept: string
}

const TABLE_ROWS: UserRow[] = [
  { dn: `CN=Test Locked,OU=Special,OU=Users,${BASE}`, name: 'Test Locked', login: 'test.locked', type: 'user', status: LOCKED, lastLogon: ft(daysAgo(1)), uac: 512, dept: 'QA' },
  { dn: `CN=Test Disabled,OU=Special,OU=Users,${BASE}`, name: 'Test Disabled', login: 'test.disabled', type: 'user', status: DISABLED, lastLogon: '0', uac: 514, dept: 'QA' },
  { dn: `CN=Test Expiring,OU=Special,OU=Users,${BASE}`, name: 'Test Expiring', login: 'test.expiring', type: 'user', status: MIXED, lastLogon: ft(daysAgo(3)), uac: 66048, dept: 'QA' },
  { dn: `CN=Patrick O'Brien,OU=Sales,OU=Users,${BASE}`, name: "Patrick O'Brien", login: 'patrick.obrien', type: 'user', status: [], lastLogon: ft(daysAgo(12)), uac: 512, dept: 'Sales' },
  { dn: `CN=SRV-APP01,OU=Servers,OU=Computers,${BASE}`, name: 'SRV-APP01', login: 'SRV-APP01$', type: 'computer', status: [], lastLogon: ft(daysAgo(0)), uac: 4096, dept: '' },
  { dn: `CN=GG-Nested-Level1,OU=Groups,${BASE}`, name: 'GG-Nested-Level1', login: 'GG-Nested-Level1', type: 'group', status: [], lastLogon: '', uac: 0, dept: '' },
]

const COLUMNS: DataTableColumn<UserRow>[] = [
  {
    id: 'name',
    header: 'Name',
    width: 190,
    sortable: true,
    hideable: false,
    cell: (r) => (
      <span className="flex items-center gap-1.5 min-w-0">
        <ObjectIcon kind={r.type} status={r.status} />
        <TruncatedText text={r.name} />
      </span>
    ),
    value: (r) => r.name,
  },
  { id: 'type', header: 'Type', width: 100, sortable: true, renderer: 'badge', value: (r) => OBJECT_KIND_LABEL[r.type], badgeTone: (r) => `oc-${r.type === 'other' ? 'container' : r.type}` as BadgeTone },
  { id: 'status', header: 'Status', width: 210, renderer: 'status', value: (r) => r.status },
  { id: 'login', header: 'Login', width: 140, sortable: true, mono: true },
  { id: 'lastLogon', header: 'Last logon', width: 150, sortable: true, renderer: 'date' },
  { id: 'uac', header: 'userAccountControl', width: 220, renderer: 'uac' },
  { id: 'dn', header: 'Container', width: 280, renderer: 'dn', defaultHidden: false },
  { id: 'dept', header: 'Department', width: 110, sortable: true, defaultHidden: true },
]

const BIG_ROWS = Array.from({ length: 2000 }, (_, i) => ({ id: `row-${i}`, name: `Bulk Contact ${String(i + 1).padStart(4, '0')}`, mail: `bulk${String(i + 1).padStart(4, '0')}@bulk.example`, n: i }))

// --- Dialog demos -------------------------------------------------------------------

function HostedDemoDialog({ onClose, label }: HostedDialogProps & { label: string }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Opened through DialogHost" description={label} size="sm" dismissible="always" footer={<Button variant="primary" onClick={onClose}>OK</Button>}>
      <p className="text-base">useDialogStore().open(Component, props) renders this without local state.</p>
    </Dialog>
  )
}

function FormDialogDemo({ open, onOpenChange, nested }: { open: boolean; onOpenChange: (o: boolean) => void; nested?: boolean }) {
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [inner, setInner] = useState(false)
  const [mode, setMode] = useState('rename')
  const dirty = name !== '' || notes !== ''
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) {
          setName('')
          setNotes('')
        }
      }}
      title={nested ? 'Nested dialog' : 'Rename entry'}
      description="Escape closes when clean; with typed input it asks first. The backdrop never closes this dialog."
      icon={<Pencil size={16} className="text-primary" aria-hidden />}
      size="md"
      dirty={dirty}
      onSubmit={() => onOpenChange(false)}
      footer={
        <>
          {!nested && (
            <Button variant="ghost" className="mr-auto" onClick={() => setInner(true)}>
              Open nested…
            </Button>
          )}
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!name}>
            Rename
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="New RDN value" hint="Enter submits; Ctrl+Enter submits from the notes field." required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Test Renamed" />
        </Field>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </Field>
        <Field label="Mode">
          <Select value={mode} onChange={(e) => setMode(e.target.value)} options={[{ value: 'rename', label: 'Rename only' }, { value: 'move', label: 'Rename and move' }]} />
        </Field>
        <Checkbox label="Delete old RDN value" defaultChecked />
        <DropdownMenu label="Menu inside a dialog" trigger={<Button size="sm" rightIcon={ChevronDown} className="self-start">Menu in dialog</Button>}>
          <MenuItem label="Item one" />
          <MenuItem label="Item two" />
        </DropdownMenu>
      </div>
      {!nested && <FormDialogDemo open={inner} onOpenChange={setInner} nested />}
    </Dialog>
  )
}

function Thrower({ when }: { when: boolean }) {
  if (when) throw new Error('Demo failure thrown inside a region')
  return <p className="text-sm">Region content renders normally.</p>
}

// --- Gallery ------------------------------------------------------------------------

export function UiGallery() {
  const themePref = useUIStore((s) => s.themePref)
  const setThemePref = useUIStore((s) => s.setThemePref)
  const density = useUIStore((s) => s.density)
  const setDensity = useUIStore((s) => s.setDensity)
  const openDialog = useDialogStore((s) => s.open)
  const openPalette = usePaletteStore((s) => s.openPalette)

  const [text, setText] = useState('Test Locked')
  const [search, setSearch] = useState('')
  const [chk, setChk] = useState(true)
  const [sw, setSw] = useState(true)
  const [radio, setRadio] = useState('sub')
  const [seg, setSeg] = useState('quick')
  const [seg2, setSeg2] = useState('direct')
  const [editorTab, setEditorTab] = useState('t2')
  const [editorTabs, setEditorTabs] = useState<TabItem[]>([
    { id: 't1', label: 'Users', title: `OU=Users,${BASE}`, kind: 'ou', closable: true },
    { id: 't2', label: 'Test Locked', title: SEL.user.dn, kind: 'user', status: 'locked', closable: true },
    { id: 't3', label: 'Test Disabled', title: SEL.userDisabled.dn, kind: 'user', status: 'disabled', closable: true, preview: true },
    { id: 't4', label: 'GG-Nested-Level1', title: SEL.group.dn, kind: 'group', closable: true, dirty: true },
    { id: 't5', label: 'SRV-APP01', title: SEL.computer.dn, kind: 'computer', closable: true },
    { id: 't6', label: 'A very long common name that needs truncation at 160px', title: `CN=A very long common name,${BASE}`, kind: 'contact', closable: true },
  ])
  const [panelTab, setPanelTab] = useState('results')
  const [subTab, setSubTab] = useState('attributes')
  const [menuCheck, setMenuCheck] = useState(true)
  const [menuRadio, setMenuRadio] = useState('dark')
  const cm = useContextMenu<string>()
  const [listValue, setListValue] = useState<string | null>('user')
  const [comboPick, setComboPick] = useState('')
  const [tableSel, setTableSel] = useState<Set<string>>(new Set([TABLE_ROWS[0].dn]))
  const [bigSel, setBigSel] = useState<Set<string>>(new Set())
  const [dlg, setDlg] = useState<null | 'sm' | 'md-form' | 'lg' | 'xl' | 'never'>(null)
  const [confirm, setConfirm] = useState<null | 'default' | 'warning' | 'danger' | 'typing' | 'list'>(null)
  const [busyFlag, setBusyFlag] = useState(false)
  const delayed = useDelayedFlag(busyFlag, 200)
  const [boom, setBoom] = useState(false)
  const [breadcrumbDn, setBreadcrumbDn] = useState(`CN=Test Locked,OU=Special,OU=Users,OU=Departments,${BASE}`)

  const tones: BadgeTone[] = ['neutral', 'primary', 'success', 'warning', 'danger', 'info', 'oc-user', 'oc-group', 'oc-ou', 'oc-computer', 'oc-contact', 'oc-domain', 'oc-container', 'oc-service']
  const statusKinds: AccountStatusKind[] = ['disabled', 'locked', 'expired', 'expiresSoon', 'pwdExpired', 'mustChange', 'pwdNeverExpires', 'stale', 'readOnly']
  const kinds: ObjectKind[] = ['user', 'group', 'computer', 'contact', 'service', 'ou', 'domain', 'container', 'other']

  return (
    <div className="h-full overflow-auto bg-background text-foreground" data-testid="ui-gallery">
      <div className="sticky top-0 z-(--z-sticky) flex flex-wrap items-center gap-3 px-4 h-11 border-b border-border bg-secondary">
        <h1 className="text-lg font-semibold">UI Gallery</h1>
        <SegmentedControl aria-label="Theme" options={THEME_OPTIONS} value={themePref} onValueChange={(v) => setThemePref(v as ThemePref)} />
        <SegmentedControl aria-label="Density" options={DENSITY_OPTIONS} value={density} onValueChange={(v) => setDensity(v as Density)} />
        <Button size="sm" variant="secondary" leftIcon={Search} kbd="Mod+K" onClick={() => openPalette()}>
          Go to anything
        </Button>
        <span className="text-xs text-muted-foreground">dev only · ?ui-gallery</span>
        <div className="ml-auto">
          <NotificationBell className="size-8" iconSize={16} />
        </div>
      </div>

      <div className="grid gap-4 p-4 grid-cols-1 xl:grid-cols-2 items-start">
        <Section id="g-buttons" title="Button · IconButton">
          {(['primary', 'secondary', 'ghost', 'danger', 'danger-ghost', 'link'] as const).map((v) => (
            <Row key={v} label={v}>
              <Button variant={v}>Label</Button>
              <Button variant={v} size="sm">Small</Button>
              <Button variant={v} leftIcon={Save}>With icon</Button>
              <Button variant={v} disabled>Disabled</Button>
              <Button variant={v} loading>Loading</Button>
            </Row>
          ))}
          <Row label="kbd hint">
            <Button variant="primary" kbd="Mod+Enter">Apply</Button>
            <Button variant="secondary" kbd="Esc">Cancel</Button>
          </Row>
          <Row label="IconButton sizes">
            <IconButton label="Refresh (sm)" icon={RefreshCw} size="sm" />
            <IconButton label="Refresh (md)" icon={RefreshCw} size="md" shortcut="F5" />
            <IconButton label="Refresh (lg)" icon={RefreshCw} size="lg" />
            <IconButton label="Filter (pressed)" icon={Filter} pressed />
            <IconButton label="Settings (subtle)" icon={Settings} variant="subtle" />
            <IconButton label="Pressed subtle" icon={ListFilter} variant="subtle" pressed />
            <IconButton label="Disabled" icon={Trash2} disabled />
          </Row>
          <Row label="revealOnRowHover">
            <div className="group flex items-center gap-2 h-table-row px-2 border border-border rounded w-72 hover:bg-accent">
              <span className="text-sm flex-1">Hover or focus this row</span>
              <IconButton label="Copy value" icon={Copy} size="sm" revealOnRowHover />
              <IconButton label="Edit value" icon={Pencil} size="sm" revealOnRowHover />
            </div>
          </Row>
        </Section>

        <Section id="g-fields" title="Field · Input · Select · Textarea · SearchInput">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Display name" hint="Shown in address lists" required>
              <Input value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
            <Field label="Login (mono)">
              <Input mono defaultValue="test.locked" />
            </Field>
            <Field label="With prefix / suffix">
              <Input prefix={<Search size={14} aria-hidden />} suffix={<Kbd shortcut="Mod+F" bare />} placeholder="Filter attributes" />
            </Field>
            <Field label="Invalid" error="This DN does not exist">
              <Input mono defaultValue="CN=Nobody,DC=lab" />
            </Field>
            <Field label="Disabled">
              <Input disabled defaultValue="read-only value" />
            </Field>
            <Field label="Small">
              <Input size="sm" defaultValue="22px control" />
            </Field>
            <Field label="Select">
              <Select options={[{ value: 'sub', label: 'Subtree' }, { value: 'one', label: 'One level' }, { value: 'base', label: 'Base' }]} defaultValue="sub" />
            </Field>
            <Field label="Select (disabled)">
              <Select disabled options={[{ value: 'x', label: 'Disabled select' }]} />
            </Field>
          </div>
          <Field label="Description" layout="inline" hint="Inline layout: 160px label column">
            <Textarea defaultValue="Locked out by failed binds (PSO-Lockout-Test: threshold 3)" rows={2} />
          </Field>
          <Field label="Base DN" layout="inline">
            <Input mono defaultValue={BASE} />
          </Field>
          <Row label="SearchInput">
            <div className="w-72">
              <SearchInput aria-label="Filter tree" value={search} onValueChange={setSearch} placeholder="Filter tree" shortcut="Mod+F" />
            </div>
            <div className="w-56">
              <Input variant="inline" aria-label="Inline filter" placeholder="Inline filter variant" size="sm" />
            </div>
          </Row>
        </Section>

        <Section id="g-choice" title="Checkbox · Switch · RadioGroup · SegmentedControl">
          <Row label="Checkbox">
            <Checkbox label="Checked" checked={chk} onCheckedChange={setChk} />
            <Checkbox label="Unchecked" defaultChecked={false} />
            <Checkbox label="Indeterminate" indeterminate checked={false} onChange={() => {}} />
            <Checkbox label="Disabled" disabled />
            <Checkbox label="Disabled checked" disabled defaultChecked />
            <Checkbox aria-label="No label" />
          </Row>
          <Checkbox label="Account is disabled" description="Stages a userAccountControl change (0x2)" />
          <Row label="Switch">
            <Switch label="Follow active tab" checked={sw} onCheckedChange={setSw} />
            <Switch label="Off" checked={false} onCheckedChange={() => {}} />
            <Switch label="Disabled" checked disabled onCheckedChange={() => {}} />
          </Row>
          <Row label="RadioGroup">
            <RadioGroup
              aria-label="Scope"
              orientation="horizontal"
              value={radio}
              onValueChange={setRadio}
              options={[{ value: 'base', label: 'Base' }, { value: 'one', label: 'One level' }, { value: 'sub', label: 'Subtree' }, { value: 'x', label: 'Disabled', disabled: true }]}
            />
          </Row>
          <RadioGroup
            aria-label="Password options"
            value="must"
            onValueChange={() => {}}
            options={[{ value: 'must', label: 'User must change password at next logon', description: 'Sets pwdLastSet = 0' }, { value: 'never', label: 'Password never expires' }]}
          />
          <Row label="Segmented sm">
            <SegmentedControl aria-label="Search mode" options={[{ value: 'quick', label: 'Quick' }, { value: 'advanced', label: 'Advanced' }]} value={seg} onValueChange={setSeg} />
            <SegmentedControl aria-label="Membership" options={[{ value: 'direct', label: 'Direct', count: 4 }, { value: 'effective', label: 'Effective', count: 11 }, { value: 'x', label: 'Disabled', disabled: true }]} value={seg2} onValueChange={setSeg2} />
          </Row>
          <Row label="Segmented md / icons">
            <SegmentedControl size="md" aria-label="Error filter" options={[{ value: 'all', label: 'All' }, { value: 'errors', label: 'Errors only' }]} value="all" onValueChange={() => {}} />
            <SegmentedControl iconOnly aria-label="View" options={[{ value: 'list', label: 'List', icon: ListFilter }, { value: 'users', label: 'Users', icon: Users }]} value="list" onValueChange={() => {}} />
          </Row>
        </Section>

        <Section id="g-tabs" title="Tabs (editor · panel · sub)">
          <div className="border border-border rounded overflow-hidden">
            <Tabs
              variant="editor"
              idPrefix="g-ed"
              aria-label="Open entries"
              items={editorTabs}
              value={editorTab}
              onValueChange={setEditorTab}
              onClose={(id) => {
                setEditorTabs((t) => t.filter((x) => x.id !== id))
                if (id === editorTab) setEditorTab(editorTabs.find((x) => x.id !== id)?.id ?? '')
              }}
            />
            {editorTabs.map((t) => (
              <TabPanel key={t.id} idPrefix="g-ed" value={t.id} selected={editorTab} className="p-3 text-sm">
                Panel of <Dn dn={t.title ?? ''} />
              </TabPanel>
            ))}
          </div>
          <div className="border border-border rounded">
            <Tabs
              variant="panel"
              idPrefix="g-pn"
              aria-label="Bottom panel"
              items={[{ id: 'results', label: 'Results', count: 12 }, { id: 'ops', label: 'Operations' }, { id: 'audit', label: 'Audit Log' }]}
              value={panelTab}
              onValueChange={setPanelTab}
              className="border-b border-border"
              end={
                <>
                  <IconButton label="Open as tab" icon={FilePlus2} size="md" />
                  <IconButton label="Export" icon={Download} size="md" />
                </>
              }
            />
            <TabPanel idPrefix="g-pn" value={panelTab} selected={panelTab} className="p-3 text-sm text-muted-foreground">
              {panelTab} panel
            </TabPanel>
          </div>
          <div className="border border-border rounded">
            <Tabs
              variant="sub"
              idPrefix="g-sub"
              aria-label="Entry views"
              items={[{ id: 'attributes', label: 'Attributes' }, { id: 'account', label: 'Account' }, { id: 'membership', label: 'Membership', count: 7 }, { id: 'ldif', label: 'LDIF' }, { id: 'off', label: 'Disabled', disabled: true }]}
              value={subTab}
              onValueChange={setSubTab}
            />
            <TabPanel idPrefix="g-sub" value={subTab} selected={subTab} className="p-3 text-sm">
              {subTab}
            </TabPanel>
          </div>
        </Section>

        <Section id="g-menus" title="Menus · MenuBar · ContextMenu">
          <Row label="MenuBar">
            <div className="h-titlebar border border-border rounded bg-titlebar text-titlebar-foreground">
              <MenuBar
                aria-label="Gallery menu"
                menus={[
                  {
                    id: 'file',
                    label: 'File',
                    content: () => (
                      <>
                        <MenuItem icon={Plus} label="New Connection…" />
                        <MenuItem icon={Upload} label="Import LDIF…" />
                        <MenuItem icon={Download} label="Export…" />
                        <MenuSeparator />
                        <MenuItem label="Exit" />
                      </>
                    ),
                  },
                  {
                    id: 'edit',
                    label: 'Edit',
                    content: () => (
                      <>
                        <MenuItem icon={Copy} label="Copy DN" shortcut="Shift+Alt+C" />
                        <MenuItem icon={Search} label="Go to Anything" shortcut="Mod+K" />
                      </>
                    ),
                  },
                  {
                    id: 'view',
                    label: 'View',
                    content: () => (
                      <>
                        <SubMenu label="Theme">
                          <MenuRadioGroup value={themePref} onValueChange={(v) => setThemePref(v as ThemePref)} label="Theme">
                            {THEME_OPTIONS.map((o) => (
                              <MenuRadioItem key={o.value} value={o.value} label={o.label} />
                            ))}
                          </MenuRadioGroup>
                        </SubMenu>
                        <SubMenu label="Density">
                          <MenuRadioGroup value={density} onValueChange={(v) => setDensity(v as Density)} label="Density">
                            {DENSITY_OPTIONS.map((o) => (
                              <MenuRadioItem key={o.value} value={o.value} label={o.label} />
                            ))}
                          </MenuRadioGroup>
                        </SubMenu>
                        <MenuSeparator />
                        <MenuCheckboxItem label="Sidebar" shortcut="Mod+B" checked={menuCheck} onCheckedChange={setMenuCheck} />
                      </>
                    ),
                  },
                  { id: 'entry', label: 'Entry', content: () => <CommandMenuItems ctx={ctxFor([SEL.user])} /> },
                  { id: 'help', label: 'Help', content: () => <MenuItem label="Keyboard Shortcuts" shortcut="Mod+/" /> },
                ]}
              />
            </div>
            <span className="text-xs text-muted-foreground">Alt (tap) or F10 focuses it</span>
          </Row>
          <Row label="DropdownMenu">
            <DropdownMenu label="Demo menu" trigger={<Button rightIcon={ChevronDown}>Open menu</Button>}>
              <MenuHeader>Header</MenuHeader>
              <MenuItem icon={Search} label="Open" default shortcut="Enter" />
              <MenuItem label="Open in New Tab" shortcut="Mod+Enter" />
              <MenuSeparator />
              <MenuCheckboxItem label="Show RDN type" checked={menuCheck} onCheckedChange={setMenuCheck} />
              <MenuRadioGroup value={menuRadio} onValueChange={setMenuRadio} label="Theme">
                <MenuRadioItem value="dark" label="Dark" />
                <MenuRadioItem value="light" label="Light" />
              </MenuRadioGroup>
              <SubMenu label="New" icon={Plus}>
                <MenuItem label="User…" />
                <MenuItem label="Group…" />
                <MenuItem label="Other Entry…" shortcut="Mod+N" />
              </SubMenu>
              <MenuItem label="Disabled item" disabled shortcut="F2" />
              <MenuSeparator />
              <MenuItem icon={Trash2} label="Delete" tone="danger" shortcut="Delete" />
            </DropdownMenu>
            <div
              tabIndex={0}
              role="button"
              aria-label="Context menu area: right-click or press Shift+F10"
              onContextMenu={(e) => cm.open(e, 'user')}
              onKeyDown={(e) => isContextMenuKey(e) && cm.open(e, 'user')}
              className="h-control px-3 flex items-center rounded border border-dashed border-border-strong text-sm text-muted-foreground"
            >
              Right-click / Shift+F10 here
            </div>
            <ContextMenu point={cm.point} onClose={cm.close} label="Entry actions">
              {() => <CommandMenuItems ctx={ctxFor([SEL.user])} showDnHeader />}
            </ContextMenu>
          </Row>
          <p className="text-xs text-muted-foreground">Per-type action sets (SPEC 6.5), generated from the registry:</p>
          <div className="flex flex-wrap gap-3 items-start" data-testid="gallery-command-menus">
            <StaticMenu title="User (locked)">
              <CommandMenuItems ctx={ctxFor([SEL.user])} showDnHeader />
            </StaticMenu>
            <StaticMenu title="Group">
              <CommandMenuItems ctx={ctxFor([SEL.group])} />
            </StaticMenu>
            <StaticMenu title="Computer">
              <CommandMenuItems ctx={ctxFor([SEL.computer])} />
            </StaticMenu>
            <StaticMenu title="OU">
              <CommandMenuItems ctx={ctxFor([SEL.ou])} />
            </StaticMenu>
            <StaticMenu title="Contact">
              <CommandMenuItems ctx={ctxFor([SEL.contact])} />
            </StaticMenu>
            <StaticMenu title="Multi-selection (2)">
              <CommandMenuItems ctx={ctxFor([SEL.user, SEL.userDisabled])} showDnHeader />
            </StaticMenu>
            <StaticMenu title="User on a read-only connection">
              <CommandMenuItems ctx={ctxFor([SEL.userDisabled], { readOnly: true })} />
            </StaticMenu>
          </div>
        </Section>

        <Section id="g-overlays" title="Popover · Tooltip · Listbox · Combobox">
          <Row label="DropdownPanel">
            <DropdownPanel aria-label="Column chooser demo" placement="bottom-start" className="p-3 w-64" trigger={<Button leftIcon={Settings}>Popover</Button>}>
              {(close) => (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">Popover content</p>
                  <Checkbox label="Name" defaultChecked />
                  <Checkbox label="Status" defaultChecked />
                  <Button size="sm" variant="primary" onClick={close}>
                    Done
                  </Button>
                </div>
              )}
            </DropdownPanel>
            <Tooltip content="Tooltip with a shortcut" shortcut="Mod+K">
              <Button variant="ghost">Hover for tooltip</Button>
            </Tooltip>
            <div className="w-40">
              <TruncatedText text={`CN=Test Locked,OU=Special,OU=Users,${BASE}`} className="text-sm font-mono" />
            </div>
          </Row>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Listbox (type-ahead)">
              <Listbox
                aria-label="Object kinds"
                items={kinds}
                getKey={(k) => k}
                getLabel={(k) => OBJECT_KIND_LABEL[k]}
                value={listValue}
                onValueChange={(k) => setListValue(k)}
                renderItem={(k, s) => (
                  <>
                    <ObjectIcon kind={k} />
                    <span className={cn('flex-1', s.selected && 'font-medium')}>{OBJECT_KIND_LABEL[k]}</span>
                  </>
                )}
                className="max-h-40"
              />
            </Field>
            <div className="flex flex-col gap-3">
              <Field label="Combobox (static)" hint={comboPick ? `Picked: ${comboPick}` : 'Down opens, Enter chooses'}>
                <Combobox items={TABLE_ROWS} getKey={(r) => r.dn} getLabel={(r) => r.name} onSelect={(r) => setComboPick(r.name)} placeholder="Entry B" renderItem={(r) => (<><ObjectIcon kind={r.type} /><span className="truncate">{r.name}</span></>)} />
              </Field>
              <Field label="Combobox (async, 250 ms debounce)">
                <Combobox
                  getKey={(r: UserRow) => r.dn}
                  getLabel={(r: UserRow) => r.name}
                  minChars={1}
                  loadOptions={(q, signal) =>
                    new Promise<UserRow[]>((resolve, reject) => {
                      const t = setTimeout(() => resolve(TABLE_ROWS.filter((r) => r.name.toLowerCase().includes(q.toLowerCase()))), 300)
                      signal.addEventListener('abort', () => {
                        clearTimeout(t)
                        reject(new DOMException('aborted', 'AbortError'))
                      })
                    })
                  }
                  onSelect={(r) => setComboPick(r.name)}
                  placeholder="Add to group…"
                />
              </Field>
            </div>
          </div>
        </Section>

        <Section id="g-badges" title="Badge · StatusChip · ObjectIcon · Kbd">
          {(['soft', 'solid', 'outline'] as const).map((a) => (
            <Row key={a} label={a}>
              {tones.map((t) => (
                <Badge key={t} tone={t} appearance={a}>
                  {t}
                </Badge>
              ))}
            </Row>
          ))}
          <Row label="sizes / counts">
            <Badge size="md" tone="warning">md 20px</Badge>
            <Badge tone="info" icon={KeyRound}>with icon</Badge>
            <CountBadge count={7} />
            <CountBadge count={128} tone="danger" />
          </Row>
          <Row label="StatusChip">
            {statusKinds.map((k) => (
              <StatusChip key={k} kind={k} />
            ))}
          </Row>
          <Row label="derived">
            {[...LOCKED, ...DISABLED, ...MIXED].map((s, i) => (
              <StatusChip key={i} status={s} focusable />
            ))}
          </Row>
          <Row label="iconOnly">
            {statusKinds.map((k) => (
              <StatusChip key={k} kind={k} iconOnly />
            ))}
          </Row>
          <Row label="ObjectIcon 14/16/32">
            {kinds.map((k) => (
              <span key={k} className="flex items-center gap-1">
                <ObjectIcon kind={k} />
                <ObjectIcon kind={k} size={16} />
                <ObjectIcon kind={k} size={32} />
              </span>
            ))}
          </Row>
          <Row label="status overlays">
            <span className="flex items-center gap-1.5 text-sm"><ObjectIcon kind="user" status="disabled" /> disabled</span>
            <span className="flex items-center gap-1.5 text-sm"><ObjectIcon kind="user" status="locked" /> locked</span>
            <span className="flex items-center gap-1.5 text-sm"><ObjectIcon kind="user" status="expired" /> expired</span>
            <span className="flex items-center gap-1.5 text-sm"><ObjectIcon kind="computer" status="disabled" size={16} /> computer</span>
            <ObjectIcon kind="user" status="locked" size={32} />
          </Row>
          <Row label="Kbd">
            <Kbd shortcut="Mod+K" />
            <Kbd shortcut="Shift+Alt+C" split />
            <Kbd shortcut="F2" />
            <Kbd>Esc</Kbd>
            <span className="text-sm">{formatShortcut('Mod+Shift+P')}</span>
          </Row>
        </Section>

        <Section id="g-dn" title="Dn · TruncatedText · DnBreadcrumb · PanelHeader · Toolbar">
          <Dn dn={`CN=Test Locked,OU=Special,OU=Users,${BASE}`} className="text-sm" />
          <Dn dn={`CN=Doe\\, John,OU=Sales,${BASE}`} hideRdnType className="text-sm" />
          <div className="border border-border rounded px-2 flex items-center gap-2">
            <DnBreadcrumb
              dn={breadcrumbDn}
              onNavigate={setBreadcrumbDn}
              loadSiblings={async () => [`CN=Test Disabled,OU=Special,OU=Users,OU=Departments,${BASE}`, `CN=Test Expired,OU=Special,OU=Users,OU=Departments,${BASE}`]}
            />
            <IconButton label="Refresh" icon={RefreshCw} size="md" />
          </div>
          <div className="border border-border rounded px-2 flex items-center">
            <DnBreadcrumb dn={`OU=Users,${BASE}`} onNavigate={setBreadcrumbDn} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_200px] gap-3 items-start">
            <div className="border border-border rounded bg-sidebar">
              <PanelHeader
                title="Explorer"
                subtitle="lab.local · Domain Admin"
                actions={[
                  { id: 'new', label: 'New entry', icon: Plus, onClick: () => {} },
                  { id: 'refresh', label: 'Refresh', icon: RefreshCw, onClick: () => {}, shortcut: 'F5' },
                  { id: 'filter', label: 'Filter', icon: Filter, onClick: () => {}, pressed: true },
                ]}
                filter={<SearchInput aria-label="Filter tree" size="sm" value={search} onValueChange={setSearch} placeholder="Filter" />}
              />
            </div>
            <div className="border border-border rounded bg-sidebar">
              <PanelHeader title="Narrow" subtitle="Folds actions into …" actions={[{ id: 'a', label: 'Add', icon: Plus, onClick: () => {} }, { id: 'b', label: 'Refresh', icon: RefreshCw, onClick: () => {} }]} />
            </div>
          </div>
          <div className="border border-border rounded p-1">
            <Toolbar
              aria-label="Entry actions"
              items={[
                { id: 'save', label: 'Save', icon: Save, display: 'button', variant: 'primary' },
                { id: 'refresh', label: 'Refresh', icon: RefreshCw, shortcut: 'F5' },
                { id: 'add', label: 'Add attribute', icon: Plus, separator: true },
                { id: 'member', label: 'Add to group', icon: UserPlus },
                { id: 'pwd', label: 'Reset password', icon: KeyRound },
                { id: 'copy', label: 'Copy DN', icon: Copy, shortcut: 'Shift+Alt+C' },
                { id: 'del', label: 'Delete', icon: Trash2, danger: true, separator: true },
              ]}
            />
          </div>
          <div className="border border-border rounded p-1 w-40">
            <Toolbar
              aria-label="Narrow toolbar"
              items={[
                { id: 'refresh', label: 'Refresh', icon: RefreshCw },
                { id: 'add', label: 'Add attribute', icon: Plus },
                { id: 'member', label: 'Add to group', icon: UserPlus },
                { id: 'pwd', label: 'Reset password', icon: KeyRound },
                { id: 'copy', label: 'Copy DN', icon: Copy },
                { id: 'export', label: 'Export', icon: Download },
                { id: 'del', label: 'Delete', icon: Trash2, danger: true },
              ]}
            />
          </div>
        </Section>

        <Section id="g-feedback" title="EmptyState · InlineAlert · Banner · Spinner · Skeleton · ProgressBar">
          <Banner tone="warning" title="Connection to lab.local lost" body="retrying in 4 s (attempt 2/5)" actions={<><Button size="sm" variant="secondary">Reconnect now</Button><Button size="sm" variant="ghost">Dismiss</Button></>} />
          {(['info', 'success', 'warning', 'danger'] as const).map((t) => (
            <InlineAlert key={t} tone={t} title={`${t[0].toUpperCase()}${t.slice(1)} title`} body="Body text in the foreground colour on the opaque subtle fill." onDismiss={() => {}} />
          ))}
          <InlineAlert tone="warning" title="Account is locked out" body="Locked out since 2026-10-29 20:59 (2 h ago)" actions={<Button size="sm" variant="primary">Unlock</Button>} />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="border border-border rounded h-48">
              <EmptyState icon={Users} title="No members" hint="This group has no direct members." action={<Button size="sm" variant="secondary" leftIcon={UserPlus}>Add members…</Button>} />
            </div>
            <div className="border border-border rounded flex flex-col gap-2 p-2">
              <EmptyState variant="inline" title="No results" hint="Try another filter" />
              <Row label="Spinner">
                <Spinner size="sm" />
                <Spinner />
                <Button size="sm" variant="secondary" onClick={() => setBusyFlag((b) => !b)}>
                  {busyFlag ? 'Stop' : 'Start'} (delayed flag)
                </Button>
                {delayed && <Spinner label="Delayed spinner" />}
              </Row>
              <ProgressBar value={66} label="Page 2 of 3" />
              <ProgressBar label="Loading" />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Skeleton variant="tree" rows={5} className="border border-border rounded" />
            <Skeleton variant="table" rows={4} className="border border-border rounded" />
            <Skeleton variant="text" rows={4} />
          </div>
        </Section>

        <Section id="g-summary" title="EntrySummaryHeader" className="xl:col-span-2">
          <div className="border border-border rounded overflow-hidden">
            <EntrySummaryHeader
              name="Test Locked"
              dn={SEL.user.dn}
              kind="user"
              statuses={LOCKED}
              meta={{ login: 'test.locked', upn: 'test.locked@lab.local', lastLogon: daysAgo(1), badPwdCount: 4, memberOfCount: 3, onMemberOfClick: () => {} }}
              ctx={ctxFor([SEL.user])}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="border border-border rounded overflow-hidden">
              <EntrySummaryHeader name="Test Disabled" kind="user" statuses={[...DISABLED, ...MIXED]} meta={{ login: 'test.disabled', lastLogon: null, badPwdCount: 0, memberOfCount: 1 }} ctx={ctxFor([SEL.userDisabled])} />
            </div>
            <div className="border border-border rounded overflow-hidden">
              <EntrySummaryHeader name="SRV-APP01" kind="computer" ctx={ctxFor([SEL.computer])} meta={{ login: 'SRV-APP01$' }} />
            </div>
          </div>
        </Section>

        <Section id="g-table" title="DataTable" className="xl:col-span-2">
          <div className="h-[220px] border border-border rounded overflow-hidden">
            <DataTable
              aria-label="Search results"
              columns={COLUMNS}
              rows={TABLE_ROWS}
              rowKey={(r) => r.dn}
              selection="multi"
              selectedKeys={tableSel}
              onSelectionChange={setTableSel}
              getRowDn={(r) => r.dn}
              onOpenDn={(dn) => setBreadcrumbDn(dn)}
              defaultSort={{ id: 'name', dir: 'asc' }}
              columnChooser
              persistKey="gallery-results"
              commandScope="results"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="h-[260px] border border-border rounded overflow-hidden">
              <DataTable
                aria-label="2,000 virtualized rows"
                virtualized
                columns={[
                  { id: 'name', header: 'Name', width: 160, sortable: true },
                  { id: 'mail', header: 'Mail', width: 200, mono: true },
                ]}
                rows={BIG_ROWS}
                rowKey={(r) => r.id}
                selection="multi"
                selectedKeys={bigSel}
                onSelectionChange={setBigSel}
              />
            </div>
            <div className="h-[120px] border border-border rounded overflow-hidden">
              <DataTable aria-label="Empty table" columns={COLUMNS.slice(0, 3)} rows={[] as UserRow[]} rowKey={(r) => r.dn} empty={<EmptyState variant="inline" title="No entries match" hint="(objectClass=nothing)" />} />
            </div>
            <div className="flex flex-col gap-3">
              <div className="h-[120px] border border-border rounded overflow-hidden">
                <DataTable aria-label="Loading table" columns={COLUMNS.slice(0, 3)} rows={[] as UserRow[]} rowKey={(r) => r.dn} loading />
              </div>
              <div className="h-[110px] border border-border rounded overflow-hidden">
                <DataTable aria-label="Failed table" columns={COLUMNS.slice(0, 2)} rows={[] as UserRow[]} rowKey={(r) => r.dn} error="Size limit exceeded (4)" />
              </div>
            </div>
          </div>
        </Section>

        <Section id="g-tree" title="useTreeKeyboard (2,000 rows, 22px)">
          <GalleryTree />
        </Section>

        <Section id="g-dialogs" title="Dialog · ConfirmDialog · DialogHost · ErrorBoundary · Palette">
          <Row label="Dialog">
            <Button onClick={() => setDlg('sm')}>Read-only (sm)</Button>
            <Button onClick={() => setDlg('md-form')}>Form, dirty guard (md)</Button>
            <Button onClick={() => setDlg('lg')}>lg</Button>
            <Button onClick={() => setDlg('xl')}>xl</Button>
            <Button onClick={() => setDlg('never')}>Not dismissible</Button>
            <Button onClick={() => openDialog(HostedDemoDialog, { label: 'Opened from a button' })}>DialogHost</Button>
          </Row>
          <Row label="ConfirmDialog">
            <Button onClick={() => setConfirm('default')}>Default</Button>
            <Button onClick={() => setConfirm('warning')}>Warning</Button>
            <Button variant="danger" onClick={() => setConfirm('danger')}>Danger</Button>
            <Button variant="danger-ghost" onClick={() => setConfirm('typing')}>Require typing</Button>
            <Button variant="secondary" onClick={() => setConfirm('list')}>DN list</Button>
          </Row>
          <Row label="Palette">
            <Button variant="secondary" leftIcon={Search} kbd="Mod+K" onClick={() => openPalette()}>Go to anything</Button>
            <Button variant="secondary" kbd="Mod+Shift+P" onClick={() => openPalette({ scope: 'actions' })}>Commands</Button>
            <Button variant="secondary" onClick={() => openPalette({ scope: 'dn', query: SEL.user.dn })}>DN mode</Button>
          </Row>
          <div className="border border-border rounded h-36">
            <ErrorBoundary variant="region" name="Demo region" onReset={() => setBoom(false)}>
              <div className="p-3 flex flex-col gap-2 items-start">
                <Thrower when={boom} />
                <Button size="sm" variant="danger-ghost" onClick={() => setBoom(true)}>
                  Throw inside this region
                </Button>
              </div>
            </ErrorBoundary>
          </div>
        </Section>
      </div>

      {/* Dialogs */}
      <Dialog
        open={dlg === 'sm'}
        onOpenChange={(o) => !o && setDlg(null)}
        size="sm"
        dismissible="always"
        title="Statistics"
        description="Read-only dialog: Escape, X and the backdrop close it."
        footer={<Button variant="primary" onClick={() => setDlg(null)}>Close</Button>}
      >
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm tabular-nums">
          <dt className="text-muted-foreground">Users</dt>
          <dd>1,284</dd>
          <dt className="text-muted-foreground">Groups</dt>
          <dd>212</dd>
          <dt className="text-muted-foreground">Contacts</dt>
          <dd>1,532</dd>
        </dl>
      </Dialog>
      <FormDialogDemo open={dlg === 'md-form'} onOpenChange={(o) => !o && setDlg(null)} />
      <Dialog open={dlg === 'lg' || dlg === 'xl'} onOpenChange={(o) => !o && setDlg(null)} size={dlg === 'xl' ? 'xl' : 'lg'} title={`Size ${dlg}`} dismissible="always" footer={<Button onClick={() => setDlg(null)}>Close</Button>}>
        <p className="text-base">Width min({dlg === 'xl' ? 960 : 720}px, 95%) of the zoomed wrapper; max height 90%.</p>
        {Array.from({ length: 30 }, (_, i) => (
          <p key={i} className="text-sm text-muted-foreground">Scrolling body line {i + 1}</p>
        ))}
      </Dialog>
      <Dialog open={dlg === 'never'} onOpenChange={(o) => !o && setDlg(null)} size="sm" dismissible="never" title="Applying changes" description="Escape and the backdrop do nothing here." footer={<Button variant="primary" onClick={() => setDlg(null)}>Done</Button>}>
        <ProgressBar label="Applying" />
      </Dialog>
      <ConfirmDialog
        open={confirm === 'default' || confirm === 'warning' || confirm === 'danger'}
        tone={confirm === 'warning' ? 'warning' : confirm === 'danger' ? 'danger' : 'default'}
        title={confirm === 'danger' ? 'Delete Entry' : confirm === 'warning' ? 'Disable account?' : 'Clear operations log?'}
        message={confirm === 'danger' ? 'Are you sure you want to delete this entry? This action cannot be undone.' : 'You can undo this later.'}
        detail={confirm === 'danger' ? SEL.user.dn : undefined}
        confirmLabel={confirm === 'danger' ? 'Delete' : 'Confirm'}
        onConfirm={() => setConfirm(null)}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'typing'}
        tone="danger"
        title="Delete subtree"
        message="OU=Users contains 1,284 entries. Every entry below it will be deleted."
        detail={`OU=Users,${BASE}`}
        requireTyping="Users"
        confirmLabel="Delete subtree"
        onConfirm={() => setConfirm(null)}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'list'}
        tone="danger"
        title="Delete 3 Entries"
        message="Are you sure you want to delete 3 entries? This action cannot be undone."
        detail={[SEL.user.dn, SEL.userDisabled.dn, SEL.contact.dn].join('\n')}
        confirmLabel="Delete 3 entries"
        onConfirm={() => setConfirm(null)}
        onCancel={() => setConfirm(null)}
      />
    </div>
  )
}

export default UiGallery
