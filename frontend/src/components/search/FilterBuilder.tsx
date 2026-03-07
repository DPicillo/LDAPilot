import { useState, useCallback } from 'react'
import { Plus, Trash2, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

type FilterOperator = '=' | '~=' | '>=' | '<=' | 'present' | 'substring';
type GroupOperator = '&' | '|' | '!';

interface FilterCondition {
  id: string;
  attribute: string;
  operator: FilterOperator;
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

function buildFilter(group: FilterGroup): string {
  if (group.conditions.length === 0) return '(objectClass=*)';

  const parts = group.conditions.map(item => {
    if (isGroup(item)) return buildFilter(item);
    const { attribute, operator, value } = item;
    if (!attribute) return '';
    switch (operator) {
      case 'present': return `(${attribute}=*)`;
      case 'substring': return `(${attribute}=*${value}*)`;
      default: return `(${attribute}${operator}${value})`;
    }
  }).filter(Boolean);

  if (parts.length === 0) return '(objectClass=*)';
  if (group.operator === '!' && parts.length === 1) return `(!${parts[0]})`;
  if (parts.length === 1) return parts[0];
  return `(${group.operator}${parts.join('')})`;
}

const COMMON_ATTRS = [
  'cn', 'sn', 'givenName', 'uid', 'mail', 'telephoneNumber',
  'objectClass', 'ou', 'dc', 'description', 'member', 'memberOf',
  'userPrincipalName', 'sAMAccountName', 'displayName',
  'uidNumber', 'gidNumber', 'homeDirectory', 'loginShell',
];

const OPERATORS: { value: FilterOperator; label: string }[] = [
  { value: '=', label: 'equals' },
  { value: '~=', label: 'approx' },
  { value: '>=', label: '>=' },
  { value: '<=', label: '<=' },
  { value: 'present', label: 'exists' },
  { value: 'substring', label: 'contains' },
];

interface FilterBuilderProps {
  onApply: (filter: string) => void;
  onClose: () => void;
}

export function FilterBuilder({ onApply, onClose }: FilterBuilderProps) {
  const [root, setRoot] = useState<FilterGroup>({
    id: generateId(),
    operator: '&',
    conditions: [{ id: generateId(), attribute: 'objectClass', operator: '=', value: '*' }],
  });

  const updateRoot = useCallback((updater: (g: FilterGroup) => FilterGroup) => {
    setRoot(prev => updater(prev));
  }, []);

  function addCondition(groupId: string) {
    function addToGroup(group: FilterGroup): FilterGroup {
      if (group.id === groupId) {
        return {
          ...group,
          conditions: [...group.conditions, { id: generateId(), attribute: '', operator: '=' as FilterOperator, value: '' }],
        };
      }
      return {
        ...group,
        conditions: group.conditions.map(c => isGroup(c) ? addToGroup(c) : c),
      };
    }
    updateRoot(addToGroup);
  }

  function addGroup(parentGroupId: string) {
    function addToGroup(group: FilterGroup): FilterGroup {
      if (group.id === parentGroupId) {
        return {
          ...group,
          conditions: [...group.conditions, { id: generateId(), operator: '&' as GroupOperator, conditions: [] }],
        };
      }
      return {
        ...group,
        conditions: group.conditions.map(c => isGroup(c) ? addToGroup(c) : c),
      };
    }
    updateRoot(addToGroup);
  }

  function removeItem(itemId: string) {
    function removeFromGroup(group: FilterGroup): FilterGroup {
      return {
        ...group,
        conditions: group.conditions
          .filter(c => c.id !== itemId)
          .map(c => isGroup(c) ? removeFromGroup(c) : c),
      };
    }
    updateRoot(removeFromGroup);
  }

  function updateCondition(condId: string, field: keyof FilterCondition, value: string) {
    function update(group: FilterGroup): FilterGroup {
      return {
        ...group,
        conditions: group.conditions.map(c => {
          if (isGroup(c)) return update(c);
          if (c.id === condId) return { ...c, [field]: value };
          return c;
        }),
      };
    }
    updateRoot(update);
  }

  function updateGroupOperator(groupId: string, op: GroupOperator) {
    function update(group: FilterGroup): FilterGroup {
      if (group.id === groupId) return { ...group, operator: op };
      return {
        ...group,
        conditions: group.conditions.map(c => isGroup(c) ? update(c) : c),
      };
    }
    updateRoot(update);
  }

  const filterStr = buildFilter(root);

  return (
    <div className="space-y-3">
      <GroupEditor
        group={root}
        depth={0}
        onAddCondition={addCondition}
        onAddGroup={addGroup}
        onRemoveItem={removeItem}
        onUpdateCondition={updateCondition}
        onUpdateGroupOperator={updateGroupOperator}
        isRoot
      />

      {/* Preview */}
      <div className="bg-background border border-border rounded p-2">
        <div className="text-[10px] text-muted-foreground mb-1">Generated filter:</div>
        <div className="text-xs font-mono text-foreground break-all">{filterStr}</div>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={() => onApply(filterStr)}
          className="flex-1 text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90"
        >
          Apply Filter
        </button>
        <button
          onClick={onClose}
          className="text-xs px-3 py-1.5 rounded border border-border hover:bg-accent"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function GroupEditor({
  group, depth, onAddCondition, onAddGroup, onRemoveItem,
  onUpdateCondition, onUpdateGroupOperator, isRoot,
}: {
  group: FilterGroup;
  depth: number;
  onAddCondition: (groupId: string) => void;
  onAddGroup: (groupId: string) => void;
  onRemoveItem: (id: string) => void;
  onUpdateCondition: (condId: string, field: keyof FilterCondition, value: string) => void;
  onUpdateGroupOperator: (groupId: string, op: GroupOperator) => void;
  isRoot?: boolean;
}) {
  return (
    <div className={cn(
      'rounded border border-border p-2 space-y-1',
      depth > 0 && 'ml-3 bg-accent/20'
    )}>
      <div className="flex items-center gap-2">
        <select
          value={group.operator}
          onChange={(e) => onUpdateGroupOperator(group.id, e.target.value as GroupOperator)}
          className="input-field w-16 text-xs font-semibold"
        >
          <option value="&">AND</option>
          <option value="|">OR</option>
          <option value="!">NOT</option>
        </select>

        <div className="flex items-center gap-1 ml-auto">
          <button
            onClick={() => onAddCondition(group.id)}
            className="flex items-center gap-0.5 text-[10px] text-primary hover:text-primary/80 px-1"
          >
            <Plus size={10} /> Condition
          </button>
          <button
            onClick={() => onAddGroup(group.id)}
            className="flex items-center gap-0.5 text-[10px] text-primary hover:text-primary/80 px-1"
          >
            <Plus size={10} /> Group
          </button>
          {!isRoot && (
            <button
              onClick={() => onRemoveItem(group.id)}
              className="p-0.5 text-muted-foreground hover:text-destructive"
            >
              <Trash2 size={10} />
            </button>
          )}
        </div>
      </div>

      {group.conditions.map(item => (
        isGroup(item) ? (
          <GroupEditor
            key={item.id}
            group={item}
            depth={depth + 1}
            onAddCondition={onAddCondition}
            onAddGroup={onAddGroup}
            onRemoveItem={onRemoveItem}
            onUpdateCondition={onUpdateCondition}
            onUpdateGroupOperator={onUpdateGroupOperator}
          />
        ) : (
          <ConditionEditor
            key={item.id}
            condition={item}
            onUpdate={onUpdateCondition}
            onRemove={() => onRemoveItem(item.id)}
          />
        )
      ))}
    </div>
  );
}

function ConditionEditor({ condition, onUpdate, onRemove }: {
  condition: FilterCondition;
  onUpdate: (id: string, field: keyof FilterCondition, value: string) => void;
  onRemove: () => void;
}) {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const filtered = COMMON_ATTRS.filter(a =>
    a.toLowerCase().includes(condition.attribute.toLowerCase())
  );

  return (
    <div className="flex items-center gap-1">
      <div className="relative flex-1">
        <input
          type="text"
          value={condition.attribute}
          onChange={(e) => { onUpdate(condition.id, 'attribute', e.target.value); setShowSuggestions(true); }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          placeholder="attribute"
          className="input-field font-mono text-xs w-full"
        />
        {showSuggestions && condition.attribute && filtered.length > 0 && (
          <div className="absolute z-10 top-full left-0 right-0 bg-popover border border-border rounded shadow-lg max-h-32 overflow-auto">
            {filtered.slice(0, 8).map(attr => (
              <button
                key={attr}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onUpdate(condition.id, 'attribute', attr); setShowSuggestions(false); }}
                className="w-full text-left text-xs px-2 py-1 hover:bg-accent font-mono"
              >
                {attr}
              </button>
            ))}
          </div>
        )}
      </div>

      <select
        value={condition.operator}
        onChange={(e) => onUpdate(condition.id, 'operator', e.target.value)}
        className="input-field text-xs w-20"
      >
        {OPERATORS.map(op => (
          <option key={op.value} value={op.value}>{op.label}</option>
        ))}
      </select>

      {condition.operator !== 'present' && (
        <input
          type="text"
          value={condition.value}
          onChange={(e) => onUpdate(condition.id, 'value', e.target.value)}
          placeholder="value"
          className="input-field text-xs flex-1"
        />
      )}

      <button
        onClick={onRemove}
        className="p-0.5 text-muted-foreground hover:text-destructive shrink-0"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}
