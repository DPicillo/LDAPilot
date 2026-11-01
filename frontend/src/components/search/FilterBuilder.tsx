/**
 * Filter builder (SPEC 10.2, UX-19): an lg Dialog that opens with the current
 * filter (parsed by lib/ldapFilter.ts, converted by builderGroupFromFilter)
 * and applies the built one. Apply, or Search (apply and run) when the host
 * offers it.
 *
 * An Object type field (server-aware, lib/searchFilter.ts) ANDs the type
 * filter (AD users = persons that are user objects); a loaded filter that
 * contains a type's parts shows them there. Operators include the negations
 * "not equals" and "does not exist" and the AD bitwise "bit set" / "bit not
 * set" with a userAccountControl flag picker. Values are literal: *, ( ) and
 * \ are escaped; use "contains" / "starts with" / "ends with" / "exists" for
 * wildcards. The attribute may be an extensible match (attr:rule:, "equals"
 * / "not equals"). Invalid conditions are never dropped: Apply stays
 * disabled until they are fixed, and a filter the builder cannot show is
 * never half-loaded. A new condition (or group, which starts with one
 * condition) takes the focus in its attribute field.
 */
import { useMemo, useState } from 'react'
import { Flag, FolderPlus, Plus, Search, Trash2, Wand2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  BIT_AND_RULE, buildBuilderFilterWithType, builderGroupFromFilter, conditionProblem, extractObjectType, parseBuilderAttribute, quickObjectTypes,
  type BuilderCondition, type BuilderGroup, type BuilderOperator, type QuickObjectType,
} from '../../lib/searchFilter'
import { checkFilter } from '../../lib/wails-treesearch'
import { describeFilterError } from '../../lib/ldapFilter'
import { UAC_FLAGS } from '../../lib/ad-constants'
import { UAC_COMPUTED_BITS } from '../../lib/uac'
import type { ServerType } from '../../types/ldap'
import { useFilterCheck } from './useFilterCheck'
import { suggestNames } from './searchModel'
import { attributeNames, useSchema } from '../schema/schemaCache'
import { Dialog } from '../ui/Dialog'
import { Button, IconButton } from '../ui/Button'
import { Input, Select } from '../ui/Input'
import { Combobox } from '../ui/Listbox'
import { InlineAlert } from '../ui/InlineAlert'
import { Spinner } from '../ui/Spinner'
import { DropdownMenu, MenuCheckboxItem, MenuHeader } from '../ui/Menu'

type GroupOperator = '&' | '|' | '!';

interface FilterCondition {
  id: string;
  attribute: string;
  operator: BuilderOperator;
  value: string;
}

interface FilterGroup {
  id: string;
  operator: GroupOperator;
  conditions: (FilterCondition | FilterGroup)[];
}

function isGroup(item: FilterCondition | FilterGroup): item is FilterGroup {
  return 'conditions' in item;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Builder tree (lib/searchFilter.ts) -> editor state with ids. */
function withIds(g: BuilderGroup): FilterGroup {
  return {
    id: generateId(),
    operator: g.operator,
    conditions: g.conditions.map((c) => ('conditions' in c ? withIds(c) : { id: generateId(), ...(c as BuilderCondition) })),
  };
}

const emptyCondition = (): FilterCondition => ({ id: generateId(), attribute: '', operator: '=', value: '' });

const COMMON_ATTRS = [
  'cn', 'sn', 'givenName', 'uid', 'mail', 'telephoneNumber',
  'objectClass', 'objectCategory', 'ou', 'dc', 'description', 'member', 'memberOf',
  'userPrincipalName', 'sAMAccountName', 'displayName', 'userAccountControl',
  'uidNumber', 'gidNumber', 'homeDirectory', 'loginShell', 'whenCreated', 'whenChanged',
  // AD extensible matches: nested membership ("equals" only)
  'memberOf:1.2.840.113556.1.4.1941:',
  'member:1.2.840.113556.1.4.1941:',
];

const OPERATORS: { value: BuilderOperator; label: string }[] = [
  { value: '=', label: 'equals' },
  { value: '!=', label: 'not equals' },
  { value: 'substring', label: 'contains' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'endsWith', label: 'ends with' },
  { value: 'present', label: 'exists' },
  { value: 'notPresent', label: 'does not exist' },
  { value: '~=', label: 'approx' },
  { value: '>=', label: '>=' },
  { value: '<=', label: '<=' },
  { value: 'bitAnd', label: 'bit set' },
  { value: 'bitNotSet', label: 'bit not set' },
];

const NO_VALUE: BuilderOperator[] = ['present', 'notPresent'];
const BIT_OPS: BuilderOperator[] = ['bitAnd', 'bitNotSet'];

/** Flag attributes the bit operators offer a flag picker for. */
const UAC_ATTRS = new Set(['useraccountcontrol', 'msds-user-account-control-computed']);

/** Known matching rules of extensible matches (shown under the condition). */
const RULE_NAMES: Record<string, string> = {
  [BIT_AND_RULE]: 'bitwise AND (all bits set)',
  '1.2.840.113556.1.4.804': 'bitwise OR (any bit set)',
  '1.2.840.113556.1.4.1941': 'in chain (nested membership)',
};

const GROUP_OPERATORS = [
  { value: '&', label: 'All of (AND)' },
  { value: '|', label: 'Any of (OR)' },
  { value: '!', label: 'None of (NOT)' },
];

export interface FilterBuilderDialogProps {
  /** The current filter; the builder opens with it when it can show it. */
  initialFilter?: string;
  /** Server type of the connection (object types, flag picker). */
  serverType?: ServerType | null;
  /** Connection whose schema suggests attribute names. */
  profileId?: string | null;
  onApply: (filter: string) => void;
  /** Applies the filter and runs the search (primary action when given). */
  onApplyAndSearch?: (filter: string) => void;
  onClose: () => void;
}

export function FilterBuilderDialog({ initialFilter = '', serverType = null, profileId, onApply, onApplyAndSearch, onClose }: FilterBuilderDialogProps) {
  // Parsed once: the builder starts with the current filter (round trip), or empty with a notice.
  const [initial] = useState(() => {
    const text = initialFilter.trim();
    const blank = { root: { id: generateId(), operator: '&' as const, conditions: [emptyCondition()] }, type: '' as QuickObjectType, notice: null as string | null };
    if (!text || text.toLowerCase() === '(objectclass=*)') return blank;
    const r = builderGroupFromFilter(text);
    if (!('group' in r)) return { ...blank, notice: r.error };
    const { type, rest } = extractObjectType(r.group, serverType);
    const root = withIds(rest);
    if (type && root.conditions.length === 0) root.conditions.push(emptyCondition());
    return { root, type, notice: null };
  });
  const [root, setRoot] = useState<FilterGroup>(initial.root);
  const [objectType, setObjectType] = useState<QuickObjectType>(initial.type);
  // The condition whose attribute field takes the focus (new conditions, the first empty one).
  const [focusId, setFocusId] = useState<string | null>(() => {
    const first = initial.root.conditions[0];
    return first && !isGroup(first) && !first.attribute ? first.id : null;
  });
  const typeOptions = useMemo(() => quickObjectTypes(serverType), [serverType]);
  const schema = useSchema(profileId);
  const attrNames = useMemo(() => {
    const names = attributeNames(schema);
    const seen = new Set(names.map((n) => n.toLowerCase()));
    return [...COMMON_ATTRS.filter((a) => !seen.has(a.toLowerCase())), ...names];
  }, [schema]);

  const build = (r: FilterGroup, t: QuickObjectType) => buildBuilderFilterWithType(stripEmpty(r), t, serverType);
  const startFilter = useMemo(() => build(initial.root, initial.type).filter, [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateGroup = (groupId: string, fn: (g: FilterGroup) => FilterGroup) => {
    const walk = (g: FilterGroup): FilterGroup => (g.id === groupId ? fn(g) : { ...g, conditions: g.conditions.map((c) => (isGroup(c) ? walk(c) : c)) });
    setRoot((prev) => walk(prev));
  };

  const addCondition = (groupId: string) => {
    const c = emptyCondition();
    setFocusId(c.id);
    updateGroup(groupId, (g) => ({ ...g, conditions: [...g.conditions, c] }));
  };

  const addGroup = (groupId: string) => {
    const c = emptyCondition();
    setFocusId(c.id);
    updateGroup(groupId, (g) => ({ ...g, conditions: [...g.conditions, { id: generateId(), operator: '&', conditions: [c] }] }));
  };

  const removeItem = (itemId: string) => {
    const walk = (g: FilterGroup): FilterGroup => ({
      ...g,
      conditions: g.conditions.filter((c) => c.id !== itemId).map((c) => (isGroup(c) ? walk(c) : c)),
    });
    setRoot((prev) => walk(prev));
  };

  const updateCondition = (condId: string, field: 'attribute' | 'operator' | 'value', value: string) => {
    const walk = (g: FilterGroup): FilterGroup => ({
      ...g,
      conditions: g.conditions.map((c) => (isGroup(c) ? walk(c) : c.id === condId ? { ...c, [field]: value } : c)),
    });
    setRoot((prev) => walk(prev));
  };

  const { filter: filterStr, problems } = build(root, objectType);
  const serverCheck = useFilterCheck(filterStr || null);
  // Error of the last Apply attempt; only shown while the filter is unchanged.
  const [applyError, setApplyError] = useState<{ filter: string; error: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const serverError = (applyError?.filter === filterStr ? applyError.error : null) ?? (serverCheck.status === 'invalid' ? serverCheck.error : null);
  const canApply = problems.length === 0 && !!filterStr && !serverError && !applying;
  const dirty = filterStr !== startFilter || problems.length > 0;

  async function handleApply(andSearch: boolean) {
    if (!canApply) return;
    setApplying(true);
    const invalid = await checkFilter(filterStr);
    setApplying(false);
    if (invalid) {
      setApplyError({ filter: filterStr, error: describeFilterError(filterStr, invalid) });
      return;
    }
    if (andSearch && onApplyAndSearch) onApplyAndSearch(filterStr);
    else onApply(filterStr);
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Filter Builder"
      description="Conditions are matched literally; use contains, starts with, ends with or exists for wildcards."
      icon={Wand2}
      size="lg"
      dirty={dirty}
      onSubmit={() => void handleApply(!!onApplyAndSearch)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type={onApplyAndSearch ? 'button' : 'submit'}
            variant={onApplyAndSearch ? 'secondary' : 'primary'}
            loading={applying && !onApplyAndSearch}
            disabled={!canApply}
            onClick={onApplyAndSearch ? () => void handleApply(false) : undefined}
            title={canApply ? 'Put the filter into the search panel' : problems.length ? 'Fix the marked conditions first' : undefined}
          >
            Apply Filter
          </Button>
          {onApplyAndSearch && (
            <Button type="submit" variant="primary" leftIcon={Search} loading={applying} disabled={!canApply} title={canApply ? 'Apply the filter and search' : undefined}>
              Search
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {initial.notice && <InlineAlert tone="warning" title="The current filter was not loaded" body={`${initial.notice} Apply replaces it with the filter built here.`} />}
        <div className="flex items-center gap-2">
          <label htmlFor="fb-object-type" className="text-sm font-medium text-muted-foreground shrink-0">
            Object type
          </label>
          <Select id="fb-object-type" size="sm" value={objectType} onChange={(e) => setObjectType(e.target.value as QuickObjectType)} options={typeOptions} className="w-56" />
          {objectType && <span className="text-xs text-muted-foreground">and all of the conditions below</span>}
        </div>
        <GroupEditor
          group={root}
          depth={0}
          attrNames={attrNames}
          serverType={serverType}
          focusId={focusId}
          onAddCondition={addCondition}
          onAddGroup={addGroup}
          onRemoveItem={removeItem}
          onUpdateCondition={updateCondition}
          onUpdateGroupOperator={(id, op) => updateGroup(id, (g) => ({ ...g, operator: op }))}
          isRoot
        />

        {problems.length > 0 ? (
          <InlineAlert
            tone="danger"
            title="Fix these conditions to build the filter"
            body={
              <ul className="space-y-0.5">
                {problems.map((p) => (
                  <li key={p} className="break-all">
                    {p}
                  </li>
                ))}
              </ul>
            }
          />
        ) : (
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              Generated filter
              {serverCheck.status === 'checking' && <Spinner size="sm" label="Checking the filter" />}
            </div>
            <div className="text-sm font-mono text-foreground break-all rounded border border-border bg-background px-2 py-1.5" aria-live="polite">
              {filterStr}
            </div>
            {serverError && <InlineAlert tone="danger" body={serverError} />}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The tree without top-level conditions that are still completely empty (an
 * untouched new row), so an empty first row of a typed search does not block
 * Apply. Inside a group an untouched row stays and is reported as a missing
 * attribute, not as an "Empty group" (RW1-S-08).
 */
function stripEmpty(g: FilterGroup, top = true): BuilderGroup {
  return {
    operator: g.operator,
    conditions: g.conditions
      .filter((c) => !top || isGroup(c) || c.attribute.trim() !== '' || (c.value !== '' && !NO_VALUE.includes(c.operator)))
      .map((c) => (isGroup(c) ? stripEmpty(c, false) : { attribute: c.attribute, operator: c.operator, value: c.value })),
  };
}

interface EditorProps {
  attrNames: string[];
  serverType: ServerType | null;
  focusId: string | null;
}

function GroupEditor({
  group, depth, attrNames, serverType, focusId, onAddCondition, onAddGroup, onRemoveItem, onUpdateCondition, onUpdateGroupOperator, isRoot,
}: EditorProps & {
  group: FilterGroup;
  depth: number;
  onAddCondition: (groupId: string) => void;
  onAddGroup: (groupId: string) => void;
  onRemoveItem: (id: string) => void;
  onUpdateCondition: (condId: string, field: 'attribute' | 'operator' | 'value', value: string) => void;
  onUpdateGroupOperator: (groupId: string, op: GroupOperator) => void;
  isRoot?: boolean;
}) {
  return (
    <fieldset className={cn('rounded border border-border p-2 space-y-1.5 min-w-0', depth > 0 && 'ml-4 bg-secondary')}>
      <legend className="sr-only">{isRoot ? 'Filter' : 'Group'}</legend>
      <div className="flex items-center gap-2">
        <Select
          size="sm"
          aria-label="Combine conditions"
          value={group.operator}
          onChange={(e) => onUpdateGroupOperator(group.id, e.target.value as GroupOperator)}
          options={GROUP_OPERATORS}
          className="w-36 font-medium"
        />
        <div className="flex items-center gap-1 ml-auto">
          <Button size="sm" variant="ghost" leftIcon={Plus} onClick={() => onAddCondition(group.id)}>
            Condition
          </Button>
          <Button size="sm" variant="ghost" leftIcon={FolderPlus} onClick={() => onAddGroup(group.id)}>
            Group
          </Button>
          {!isRoot && <IconButton label="Remove group" icon={Trash2} size="sm" onClick={() => onRemoveItem(group.id)} />}
        </div>
      </div>

      {group.conditions.map((item) =>
        isGroup(item) ? (
          <GroupEditor
            key={item.id}
            group={item}
            depth={depth + 1}
            attrNames={attrNames}
            serverType={serverType}
            focusId={focusId}
            onAddCondition={onAddCondition}
            onAddGroup={onAddGroup}
            onRemoveItem={onRemoveItem}
            onUpdateCondition={onUpdateCondition}
            onUpdateGroupOperator={onUpdateGroupOperator}
          />
        ) : (
          <ConditionEditor key={item.id} condition={item} attrNames={attrNames} serverType={serverType} focusId={focusId} onUpdate={onUpdateCondition} onRemove={() => onRemoveItem(item.id)} />
        ),
      )}
      {group.conditions.length === 0 && <p className="text-xs text-muted-foreground px-1">Empty group: add a condition.</p>}
    </fieldset>
  );
}

function ConditionEditor({ condition, attrNames, serverType, focusId, onUpdate, onRemove }: EditorProps & {
  condition: FilterCondition;
  onUpdate: (id: string, field: 'attribute' | 'operator' | 'value', value: string) => void;
  onRemove: () => void;
}) {
  // An empty attribute is listed below the tree but not marked while typing.
  const problem = condition.attribute.trim() !== '' ? conditionProblem(condition.attribute, condition.operator, BIT_OPS.includes(condition.operator) && condition.value === '' ? undefined : condition.value) : null;
  const parsed = parseBuilderAttribute(condition.attribute);
  const items = useMemo(() => suggestNames(attrNames, condition.attribute, 60), [attrNames, condition.attribute]);
  const bitOp = BIT_OPS.includes(condition.operator);
  const flagPicker = bitOp && parsed.kind === 'plain' && UAC_ATTRS.has(parsed.attr.toLowerCase()) && (serverType === 'ad' || serverType === null || serverType === 'other');
  const extensibleRule = parsed.kind === 'extensible' ? /:([\d.]+):$/.exec(parsed.attr)?.[1] : undefined;

  return (
    <div className="space-y-0.5">
      <div className="flex items-start gap-1.5">
        <div className="flex-[3] min-w-0" title={problem ?? (condition.attribute || undefined)}>
          <Combobox
            items={items}
            getKey={(a) => a}
            getLabel={(a) => a}
            filter={() => true}
            inputValue={condition.attribute}
            onInputChange={(v) => onUpdate(condition.id, 'attribute', v)}
            onSelect={(a) => onUpdate(condition.id, 'attribute', a)}
            placeholder="attribute"
            mono
            size="sm"
            aria-label="Attribute"
            autoFocus={focusId === condition.id}
            className={cn(problem && '[&_input]:border-destructive')}
          />
        </div>
        <Select size="sm" aria-label="Operator" value={condition.operator} onChange={(e) => onUpdate(condition.id, 'operator', e.target.value)} options={OPERATORS} className="w-32 shrink-0" />
        {!NO_VALUE.includes(condition.operator) ? (
          <div className="flex-[2] min-w-0 flex items-center gap-1">
            <Input
              size="sm"
              aria-label="Value"
              value={condition.value}
              onChange={(e) => onUpdate(condition.id, 'value', e.target.value)}
              placeholder={bitOp ? 'bits, e.g. 2' : 'value'}
              inputMode={bitOp ? 'numeric' : undefined}
              title={bitOp ? 'Decimal bit mask' : 'Matched literally; *, ( ) and \\ are escaped'}
              className="min-w-0"
              wrapperClassName="flex-1 min-w-0"
            />
            {flagPicker && <FlagPicker value={condition.value} onChange={(v) => onUpdate(condition.id, 'value', v)} />}
          </div>
        ) : (
          <span className="flex-[2]" />
        )}
        <IconButton label="Remove condition" icon={Trash2} size="sm" className="mt-px" onClick={onRemove} />
      </div>
      {(extensibleRule || flagPicker) && (
        <p className="text-xs text-muted-foreground pl-1 break-all">
          {extensibleRule && (
            <>
              Extensible match <span className="font-mono text-foreground">{parsed.kind === 'extensible' ? parsed.attr : condition.attribute}</span>
              {RULE_NAMES[extensibleRule] ? ` · ${RULE_NAMES[extensibleRule]}` : ''}
            </>
          )}
          {flagPicker && flagSummary(condition.value)}
        </p>
      )}
    </div>
  );
}

/** "Account is disabled + Password never expires" for a userAccountControl bit mask. */
function flagSummary(value: string): string {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || !n) return 'Pick the flags with the flag button.';
  const names = UAC_FLAGS.filter((f) => (n & f.bit) === f.bit).map((f) => f.description);
  return names.length ? names.join(' + ') : `No known flag in ${n}`;
}

/** userAccountControl flags as checkboxes; the value is their sum. */
function FlagPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const n = /^\d+$/.test(value.trim()) ? Number(value) : 0;
  return (
    <DropdownMenu label="userAccountControl flags" placement="bottom-end" minWidth={280} trigger={<IconButton label="Pick Flags" icon={Flag} size="sm" />}>
      <MenuHeader>Account flags (all checked bits must be set)</MenuHeader>
      {/* LOCKOUT / PASSWORD_EXPIRED are never stored in userAccountControl (AD computes them in
          msDS-User-Account-Control-Computed, which no filter can use): offered disabled with the
          way to find them (RW1-S-06). */}
      {UAC_FLAGS.map((f) => {
        const computed = (f.bit & UAC_COMPUTED_BITS) !== 0;
        return (
          <MenuCheckboxItem
            key={f.bit}
            checked={(n & f.bit) === f.bit}
            keepOpen
            disabled={computed && (n & f.bit) !== f.bit}
            label={f.description}
            hint={computed ? (f.bit === 0x10 ? 'computed: use lockoutTime>=1 or the Locked-Out Users report' : 'computed: use the Expired Passwords report') : `0x${f.bit.toString(16)}`}
            onCheckedChange={(on) => onChange(String(on ? n | f.bit : n & ~f.bit))}
          />
        );
      })}
    </DropdownMenu>
  );
}
