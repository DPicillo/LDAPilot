import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  X, Loader2, Save, Plus, Trash2, Pencil, Check, ChevronDown, ChevronRight,
  AlertCircle, Box, Shield, Layers, Eye, EyeOff, Link2
} from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import {
  LDAPEntry, LDAPAttribute, SchemaInfo, SchemaObjectClass, SchemaAttribute
} from '../../types/ldap'
import { cn } from '../../lib/utils'
import { DN_REFERENCE_ATTRS, PASSWORD_ATTRS } from '../../lib/ad-constants'
import * as wails from '../../lib/wails'
import { toast } from '../ui/Toast'

interface EditEntryDialogProps {
  dn: string;
  onClose: () => void;
  onSaved?: () => void;
}

// --- Schema helpers ---

/** Resolve the full inheritance chain for an object class (walks SUP). */
function resolveClassHierarchy(
  className: string,
  allClasses: Map<string, SchemaObjectClass>,
  visited = new Set<string>()
): SchemaObjectClass[] {
  const lower = className.toLowerCase();
  if (visited.has(lower)) return [];
  visited.add(lower);

  const oc = allClasses.get(lower);
  if (!oc) return [];

  const chain: SchemaObjectClass[] = [oc];
  for (const sup of oc.superClass || []) {
    chain.push(...resolveClassHierarchy(sup, allClasses, visited));
  }
  return chain;
}

/** Collect all MUST and MAY attributes for a set of object classes, walking SUP chains. */
function collectClassAttributes(
  classNames: string[],
  classMap: Map<string, SchemaObjectClass>
): { must: Set<string>; may: Set<string>; byClass: Map<string, { must: string[]; may: string[] }> } {
  const must = new Set<string>();
  const may = new Set<string>();
  const byClass = new Map<string, { must: string[]; may: string[] }>();

  for (const name of classNames) {
    const chain = resolveClassHierarchy(name, classMap);
    const classMust = new Set<string>();
    const classMay = new Set<string>();

    for (const oc of chain) {
      for (const a of oc.must || []) { must.add(a); classMust.add(a); }
      for (const a of oc.may || []) { may.add(a); classMay.add(a); }
    }

    byClass.set(name, {
      must: Array.from(classMust).sort((a, b) => a.localeCompare(b)),
      may: Array.from(classMay).sort((a, b) => a.localeCompare(b)),
    });
  }

  return { must, may, byClass };
}

// --- Pending changes ---

interface PendingChanges {
  /** Attribute values that changed (attrName → new values) */
  modified: Map<string, string[]>;
  /** Completely new attributes to add */
  added: Map<string, string[]>;
  /** Attributes to delete */
  deleted: Set<string>;
}

function emptyChanges(): PendingChanges {
  return { modified: new Map(), added: new Map(), deleted: new Set() };
}

function hasChanges(changes: PendingChanges, objectClassesChanged: boolean): boolean {
  return changes.modified.size > 0 || changes.added.size > 0 || changes.deleted.size > 0 || objectClassesChanged;
}

// --- Main Component ---

export function EditEntryDialog({ dn, onClose, onSaved }: EditEntryDialogProps) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const profiles = useConnectionStore((s) => s.profiles);
  const isReadOnly = activeProfileId
    ? profiles.find(p => p.id === activeProfileId)?.readOnly ?? false
    : false;

  const [entry, setEntry] = useState<LDAPEntry | null>(null);
  const [schema, setSchema] = useState<SchemaInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Editable state: object classes & attribute working copies
  const [objectClasses, setObjectClasses] = useState<string[]>([]);
  const [originalObjectClasses, setOriginalObjectClasses] = useState<string[]>([]);
  const [workingAttrs, setWorkingAttrs] = useState<Map<string, string[]>>(new Map());
  const [originalAttrs, setOriginalAttrs] = useState<Map<string, string[]>>(new Map());

  // UI state
  const [collapsedClasses, setCollapsedClasses] = useState<Set<string>>(new Set());
  const [editingAttr, setEditingAttr] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [addingAttr, setAddingAttr] = useState<string | null>(null);
  const [addValue, setAddValue] = useState('');
  const [showAddClass, setShowAddClass] = useState(false);
  const [classFilter, setClassFilter] = useState('');

  // Load entry + schema on mount
  useEffect(() => {
    if (!activeProfileId) return;
    setLoading(true);
    Promise.all([
      wails.GetEntry(activeProfileId, dn),
      wails.GetSchema(activeProfileId),
    ]).then(([e, s]) => {
      if (e && s) {
        setEntry(e);
        setSchema(s);

        // Extract object classes
        const ocs = e.attributes.find(a => a.name === 'objectClass')?.values || [];
        setObjectClasses([...ocs]);
        setOriginalObjectClasses([...ocs]);

        // Build working attribute map
        const attrMap = new Map<string, string[]>();
        for (const attr of e.attributes) {
          if (attr.name !== 'objectClass') {
            attrMap.set(attr.name, [...attr.values]);
          }
        }
        setWorkingAttrs(new Map(attrMap));
        setOriginalAttrs(new Map(attrMap.entries()));
      }
    }).catch(err => {
      setError(err?.message || 'Failed to load entry');
    }).finally(() => {
      setLoading(false);
    });
  }, [activeProfileId, dn]);

  // Build schema lookup maps
  const classMap = useMemo(() => {
    const map = new Map<string, SchemaObjectClass>();
    if (schema) {
      for (const oc of schema.objectClasses) {
        map.set(oc.name.toLowerCase(), oc);
      }
    }
    return map;
  }, [schema]);

  const attrMap = useMemo(() => {
    const map = new Map<string, SchemaAttribute>();
    if (schema) {
      for (const at of schema.attributes) {
        map.set(at.name.toLowerCase(), at);
      }
    }
    return map;
  }, [schema]);

  // Collect schema-defined attributes for current object classes
  const classAttrs = useMemo(
    () => collectClassAttributes(objectClasses, classMap),
    [objectClasses, classMap]
  );

  // Compute pending changes
  const pendingChanges = useMemo((): PendingChanges => {
    const changes = emptyChanges();

    // Check modified / deleted
    for (const [name, origValues] of originalAttrs) {
      const current = workingAttrs.get(name);
      if (!current || current.length === 0) {
        changes.deleted.add(name);
      } else if (JSON.stringify(origValues) !== JSON.stringify(current)) {
        changes.modified.set(name, current);
      }
    }

    // Check added
    for (const [name, values] of workingAttrs) {
      if (!originalAttrs.has(name) && values.length > 0) {
        changes.added.set(name, values);
      }
    }

    return changes;
  }, [workingAttrs, originalAttrs]);

  const objectClassesChanged = useMemo(() => {
    return JSON.stringify([...objectClasses].sort()) !== JSON.stringify([...originalObjectClasses].sort());
  }, [objectClasses, originalObjectClasses]);

  const dirty = hasChanges(pendingChanges, objectClassesChanged);

  // Available classes to add (auxiliary and structural, excluding abstract)
  const availableClasses = useMemo(() => {
    if (!schema) return [];
    const currentLower = new Set(objectClasses.map(c => c.toLowerCase()));
    return schema.objectClasses
      .filter(oc => oc.kind !== 'abstract' && !currentLower.has(oc.name.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [schema, objectClasses]);

  const filteredAvailableClasses = useMemo(() => {
    if (!classFilter) return availableClasses;
    const lf = classFilter.toLowerCase();
    return availableClasses.filter(oc =>
      oc.name.toLowerCase().includes(lf) || oc.description.toLowerCase().includes(lf)
    );
  }, [availableClasses, classFilter]);

  // --- Handlers ---

  function handleAddClass(className: string) {
    if (!objectClasses.some(c => c.toLowerCase() === className.toLowerCase())) {
      setObjectClasses([...objectClasses, className]);
    }
    setShowAddClass(false);
    setClassFilter('');
  }

  function handleRemoveClass(className: string) {
    if (className.toLowerCase() === 'top') return;

    // Remove attributes unique to this class that have no values
    const remaining = objectClasses.filter(c => c.toLowerCase() !== className.toLowerCase());
    const remainingAttrs = collectClassAttributes(remaining, classMap);

    // Remove optional attrs that are no longer allowed and have no value
    const newWorkingAttrs = new Map(workingAttrs);
    const classInfo = classAttrs.byClass.get(className);
    if (classInfo) {
      for (const attrName of [...classInfo.must, ...classInfo.may]) {
        if (!remainingAttrs.must.has(attrName) && !remainingAttrs.may.has(attrName)) {
          const vals = newWorkingAttrs.get(attrName);
          if (!vals || vals.length === 0 || vals.every(v => !v)) {
            newWorkingAttrs.delete(attrName);
          }
        }
      }
    }

    setObjectClasses(remaining);
    setWorkingAttrs(newWorkingAttrs);
  }

  function startEditAttr(attrName: string) {
    const vals = workingAttrs.get(attrName) || [];
    setEditingAttr(attrName);
    setEditValue(vals.join('\n'));
  }

  function saveEditAttr() {
    if (!editingAttr) return;
    const values = editValue.split('\n').filter(v => v.trim() !== '');
    const next = new Map(workingAttrs);
    if (values.length > 0) {
      next.set(editingAttr, values);
    } else {
      next.delete(editingAttr);
    }
    setWorkingAttrs(next);
    setEditingAttr(null);
  }

  function cancelEdit() {
    setEditingAttr(null);
    setEditValue('');
  }

  function startAddAttr(attrName: string) {
    setAddingAttr(attrName);
    setAddValue('');
  }

  function confirmAddAttr() {
    if (!addingAttr || !addValue.trim()) return;
    const next = new Map(workingAttrs);
    const existing = next.get(addingAttr) || [];
    next.set(addingAttr, [...existing, addValue.trim()]);
    setWorkingAttrs(next);
    setAddingAttr(null);
    setAddValue('');
  }

  function handleDeleteAttrValue(attrName: string, valueIndex: number) {
    const next = new Map(workingAttrs);
    const vals = [...(next.get(attrName) || [])];
    vals.splice(valueIndex, 1);
    if (vals.length > 0) {
      next.set(attrName, vals);
    } else {
      next.delete(attrName);
    }
    setWorkingAttrs(next);
  }

  function handleDeleteAttr(attrName: string) {
    if (classAttrs.must.has(attrName)) {
      toast.error(`Cannot delete required attribute "${attrName}"`);
      return;
    }
    const next = new Map(workingAttrs);
    next.delete(attrName);
    setWorkingAttrs(next);
  }

  const toggleClassCollapse = useCallback((className: string) => {
    setCollapsedClasses(prev => {
      const next = new Set(prev);
      if (next.has(className)) next.delete(className);
      else next.add(className);
      return next;
    });
  }, []);

  // --- Save ---

  async function handleSave() {
    if (!activeProfileId || isReadOnly) return;
    setSaving(true);
    setError(null);

    try {
      // 1. Update object classes if changed
      if (objectClassesChanged) {
        await wails.ModifyAttribute(activeProfileId, dn, 'objectClass', objectClasses);
      }

      // 2. Add new attributes
      for (const [name, values] of pendingChanges.added) {
        await wails.AddAttribute(activeProfileId, dn, name, values);
      }

      // 3. Modify changed attributes
      for (const [name, values] of pendingChanges.modified) {
        await wails.ModifyAttribute(activeProfileId, dn, name, values);
      }

      // 4. Delete removed attributes
      for (const name of pendingChanges.deleted) {
        await wails.DeleteAttribute(activeProfileId, dn, name);
      }

      toast.success('Entry updated successfully');
      onSaved?.();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to save changes');
      toast.error(err?.message || 'Failed to save changes');
    } finally {
      setSaving(false);
    }
  }

  // --- Render ---

  if (loading) {
    return (
      <DialogShell onClose={onClose} title="Edit Entry">
        <div className="flex-1 flex items-center justify-center p-8">
          <Loader2 size={24} className="animate-spin text-muted-foreground mr-2" />
          <span className="text-sm text-muted-foreground">Loading entry...</span>
        </div>
      </DialogShell>
    );
  }

  if (!entry || !schema) {
    return (
      <DialogShell onClose={onClose} title="Edit Entry">
        <div className="flex-1 flex items-center justify-center p-8">
          <AlertCircle size={16} className="text-destructive mr-2" />
          <span className="text-sm text-destructive">{error || 'Failed to load entry'}</span>
        </div>
      </DialogShell>
    );
  }

  // Build the grouped attribute display
  // Show classes in order: structural first, then auxiliary
  const sortedClasses = [...objectClasses].sort((a, b) => {
    const aOc = classMap.get(a.toLowerCase());
    const bOc = classMap.get(b.toLowerCase());
    const aKind = aOc?.kind || 'structural';
    const bKind = bOc?.kind || 'structural';
    if (aKind === bKind) return a.localeCompare(b);
    if (aKind === 'abstract') return -1;
    if (bKind === 'abstract') return 1;
    if (aKind === 'structural') return -1;
    if (bKind === 'structural') return 1;
    return 0;
  });

  // Collect "extra" attributes: ones on the entry but not defined by any current object class
  const allSchemaAttrs = new Set([...classAttrs.must, ...classAttrs.may]);
  const extraAttrs = Array.from(workingAttrs.keys())
    .filter(name => !allSchemaAttrs.has(name) && name !== 'objectClass')
    .sort((a, b) => a.localeCompare(b));

  return (
    <DialogShell onClose={onClose} title="Edit Entry">
      {/* DN bar */}
      <div className="px-4 py-2 border-b border-border bg-background/50 shrink-0">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">DN</span>
        <div className="text-xs font-mono text-foreground truncate mt-0.5" title={dn}>{dn}</div>
      </div>

      {/* Main two-panel layout */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Left panel: Object Classes */}
        <div className="w-[220px] shrink-0 border-r border-border flex flex-col bg-card/50">
          <div className="px-3 py-2 border-b border-border shrink-0">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Object Classes
            </span>
          </div>
          <div className="flex-1 overflow-auto py-1">
            {objectClasses.map(className => {
              const oc = classMap.get(className.toLowerCase());
              const kind = oc?.kind || 'structural';
              const isRemovable = className.toLowerCase() !== 'top';
              return (
                <div
                  key={className}
                  className="flex items-center gap-1.5 px-3 py-1 group hover:bg-accent/30"
                >
                  <KindIcon kind={kind} />
                  <span className="text-xs flex-1 truncate font-mono">{className}</span>
                  <KindBadge kind={kind} />
                  {!isReadOnly && isRemovable && (
                    <button
                      onClick={() => handleRemoveClass(className)}
                      className="p-0.5 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 shrink-0"
                      title={`Remove ${className}`}
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Add class */}
          {!isReadOnly && (
            <div className="border-t border-border p-2 shrink-0">
              {showAddClass ? (
                <div className="space-y-1">
                  <input
                    type="text"
                    value={classFilter}
                    onChange={e => setClassFilter(e.target.value)}
                    placeholder="Search classes..."
                    className="input-field text-xs"
                    autoFocus
                  />
                  <div className="max-h-[150px] overflow-auto border border-border rounded bg-background">
                    {filteredAvailableClasses.length === 0 ? (
                      <div className="px-2 py-1.5 text-[10px] text-muted-foreground">No matching classes</div>
                    ) : (
                      filteredAvailableClasses.map(oc => (
                        <button
                          key={oc.name}
                          onClick={() => handleAddClass(oc.name)}
                          className="w-full flex items-center gap-1.5 px-2 py-1 text-left hover:bg-accent/50 text-xs"
                        >
                          <KindIcon kind={oc.kind} />
                          <span className="truncate font-mono flex-1">{oc.name}</span>
                          <KindBadge kind={oc.kind} />
                        </button>
                      ))
                    )}
                  </div>
                  <button
                    onClick={() => { setShowAddClass(false); setClassFilter(''); }}
                    className="w-full text-[10px] text-muted-foreground hover:text-foreground py-0.5"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowAddClass(true)}
                  className="w-full flex items-center justify-center gap-1 text-xs text-primary hover:text-primary/80 py-1 rounded hover:bg-accent/30"
                >
                  <Plus size={12} />
                  Add Class
                </button>
              )}
            </div>
          )}
        </div>

        {/* Right panel: Attributes */}
        <div className="flex-1 overflow-auto min-w-0">
          {sortedClasses.map(className => {
            const info = classAttrs.byClass.get(className);
            if (!info) return null;

            // De-duplicate: only show attrs that are "owned" by this class
            // (i.e. not already shown by a parent class earlier in the list)
            const oc = classMap.get(className.toLowerCase());
            const directMust = new Set(oc?.must || []);
            const directMay = new Set(oc?.may || []);
            const allAttrsForClass = [...directMust, ...directMay];
            if (allAttrsForClass.length === 0 && className.toLowerCase() === 'top') return null;

            const isCollapsed = collapsedClasses.has(className);

            return (
              <ClassSection
                key={className}
                className={className}
                kind={oc?.kind || 'structural'}
                isCollapsed={isCollapsed}
                onToggle={() => toggleClassCollapse(className)}
                directMust={directMust}
                directMay={directMay}
                workingAttrs={workingAttrs}
                attrMap={attrMap}
                globalMust={classAttrs.must}
                editingAttr={editingAttr}
                editValue={editValue}
                addingAttr={addingAttr}
                addValue={addValue}
                isReadOnly={isReadOnly}
                onStartEdit={startEditAttr}
                onSaveEdit={saveEditAttr}
                onCancelEdit={cancelEdit}
                onEditValueChange={setEditValue}
                onStartAdd={startAddAttr}
                onConfirmAdd={confirmAddAttr}
                onCancelAdd={() => { setAddingAttr(null); setAddValue(''); }}
                onAddValueChange={setAddValue}
                onDeleteValue={handleDeleteAttrValue}
                onDeleteAttr={handleDeleteAttr}
              />
            );
          })}

          {/* Extra attributes not in any schema class */}
          {extraAttrs.length > 0 && (
            <ClassSection
              className="Other Attributes"
              kind="other"
              isCollapsed={collapsedClasses.has('__other__')}
              onToggle={() => toggleClassCollapse('__other__')}
              directMust={new Set()}
              directMay={new Set(extraAttrs)}
              workingAttrs={workingAttrs}
              attrMap={attrMap}
              globalMust={classAttrs.must}
              editingAttr={editingAttr}
              editValue={editValue}
              addingAttr={addingAttr}
              addValue={addValue}
              isReadOnly={isReadOnly}
              onStartEdit={startEditAttr}
              onSaveEdit={saveEditAttr}
              onCancelEdit={cancelEdit}
              onEditValueChange={setEditValue}
              onStartAdd={startAddAttr}
              onConfirmAdd={confirmAddAttr}
              onCancelAdd={() => { setAddingAttr(null); setAddValue(''); }}
              onAddValueChange={setAddValue}
              onDeleteValue={handleDeleteAttrValue}
              onDeleteAttr={handleDeleteAttr}
            />
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-2 border-t border-border bg-destructive/10 shrink-0">
          <p className="text-xs text-destructive flex items-center gap-1.5">
            <AlertCircle size={12} />
            {error}
          </p>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-border shrink-0">
        <div className="text-[10px] text-muted-foreground">
          {dirty ? (
            <span className="text-primary">Unsaved changes</span>
          ) : (
            <span>No changes</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded border border-border hover:bg-accent"
          >
            Cancel
          </button>
          {!isReadOnly && (
            <button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save Changes
            </button>
          )}
        </div>
      </div>
    </DialogShell>
  );
}

// --- Sub-components ---

function DialogShell({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-card border border-border rounded-md shadow-2xl w-[900px] max-w-[95vw] h-[700px] max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Pencil size={14} className="text-primary" />
            {title}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function KindIcon({ kind }: { kind: string }) {
  switch (kind) {
    case 'structural': return <Box size={10} className="text-blue-400 shrink-0" />;
    case 'auxiliary': return <Layers size={10} className="text-green-400 shrink-0" />;
    case 'abstract': return <Shield size={10} className="text-yellow-400 shrink-0" />;
    default: return <Box size={10} className="text-muted-foreground shrink-0" />;
  }
}

function KindBadge({ kind }: { kind: string }) {
  const colors = {
    structural: 'bg-blue-500/15 text-blue-400',
    auxiliary: 'bg-green-500/15 text-green-400',
    abstract: 'bg-yellow-500/15 text-yellow-400',
  };
  return (
    <span className={cn('text-[8px] px-1 rounded shrink-0', colors[kind as keyof typeof colors] || 'bg-muted text-muted-foreground')}>
      {kind.slice(0, 4)}
    </span>
  );
}

// --- Class section with attributes ---

interface ClassSectionProps {
  className: string;
  kind: string;
  isCollapsed: boolean;
  onToggle: () => void;
  directMust: Set<string>;
  directMay: Set<string>;
  workingAttrs: Map<string, string[]>;
  attrMap: Map<string, SchemaAttribute>;
  globalMust: Set<string>;
  editingAttr: string | null;
  editValue: string;
  addingAttr: string | null;
  addValue: string;
  isReadOnly: boolean;
  onStartEdit: (name: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onEditValueChange: (v: string) => void;
  onStartAdd: (name: string) => void;
  onConfirmAdd: () => void;
  onCancelAdd: () => void;
  onAddValueChange: (v: string) => void;
  onDeleteValue: (name: string, index: number) => void;
  onDeleteAttr: (name: string) => void;
}

function ClassSection({
  className, kind, isCollapsed, onToggle,
  directMust, directMay, workingAttrs, attrMap, globalMust,
  editingAttr, editValue, addingAttr, addValue, isReadOnly,
  onStartEdit, onSaveEdit, onCancelEdit, onEditValueChange,
  onStartAdd, onConfirmAdd, onCancelAdd, onAddValueChange,
  onDeleteValue, onDeleteAttr,
}: ClassSectionProps) {
  const allAttrs = useMemo(() => {
    const must = Array.from(directMust).sort((a, b) => a.localeCompare(b));
    const may = Array.from(directMay)
      .filter(a => !directMust.has(a))
      .sort((a, b) => a.localeCompare(b));
    return [...must, ...may];
  }, [directMust, directMay]);

  if (allAttrs.length === 0) return null;

  const kindColors = {
    structural: 'border-l-blue-500/50',
    auxiliary: 'border-l-green-500/50',
    abstract: 'border-l-yellow-500/50',
    other: 'border-l-muted-foreground/30',
  };

  return (
    <div className={cn('border-b border-border', kindColors[kind as keyof typeof kindColors] || 'border-l-transparent', 'border-l-2')}>
      {/* Section header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 hover:bg-accent/30 text-left"
      >
        {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <KindIcon kind={kind} />
        <span className="text-xs font-semibold">{className}</span>
        <span className="text-[10px] text-muted-foreground ml-1">
          ({allAttrs.length} attr{allAttrs.length !== 1 ? 's' : ''})
        </span>
      </button>

      {!isCollapsed && (
        <table className="w-full text-xs">
          <tbody>
            {allAttrs.map(attrName => {
              const isMust = globalMust.has(attrName);
              const values = workingAttrs.get(attrName) || [];
              const hasValue = values.length > 0 && values.some(v => v !== '');
              const schemaAttr = attrMap.get(attrName.toLowerCase());
              const isNoUserMod = schemaAttr?.noUserMod || false;
              const isEditing = editingAttr === attrName;
              const isAdding = addingAttr === attrName;

              return (
                <tr
                  key={attrName}
                  className={cn(
                    'border-t border-border/50 hover:bg-accent/20 group',
                    isEditing && 'bg-accent/30'
                  )}
                >
                  {/* Attribute name */}
                  <td className="px-3 py-1 w-[200px] align-top">
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-primary/80 truncate" title={schemaAttr?.description || attrName}>
                        {attrName}
                      </span>
                      {isMust && (
                        <span className="text-red-400 text-[10px] shrink-0" title="Required">*</span>
                      )}
                      {isNoUserMod && (
                        <span className="text-[8px] px-0.5 rounded bg-yellow-500/15 text-yellow-400 shrink-0">ro</span>
                      )}
                    </div>
                    {schemaAttr?.syntaxName && (
                      <div className="text-[9px] text-muted-foreground truncate">{schemaAttr.syntaxName}</div>
                    )}
                  </td>

                  {/* Value */}
                  <td className="px-3 py-1 align-top">
                    {isEditing ? (
                      <div className="flex flex-col gap-1">
                        <textarea
                          value={editValue}
                          onChange={e => onEditValueChange(e.target.value)}
                          className="w-full px-1.5 py-1 text-xs bg-input border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring font-mono resize-y min-h-[28px]"
                          rows={Math.max(2, editValue.split('\n').length)}
                          autoFocus
                          placeholder="One value per line"
                          onKeyDown={e => {
                            if (e.key === 'Escape') onCancelEdit();
                            if (e.key === 'Enter' && e.ctrlKey) onSaveEdit();
                          }}
                        />
                        <div className="flex items-center gap-1">
                          <button onClick={onSaveEdit} className="p-0.5 text-green-400 hover:text-green-300" title="Save (Ctrl+Enter)">
                            <Check size={12} />
                          </button>
                          <button onClick={onCancelEdit} className="p-0.5 text-muted-foreground hover:text-foreground" title="Cancel (Esc)">
                            <X size={12} />
                          </button>
                          <span className="text-[9px] text-muted-foreground ml-1">Ctrl+Enter to save, one value per line</span>
                        </div>
                      </div>
                    ) : isAdding ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="text"
                          value={addValue}
                          onChange={e => onAddValueChange(e.target.value)}
                          className="flex-1 px-1.5 py-0.5 text-xs bg-input border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring font-mono"
                          autoFocus
                          placeholder="Enter value..."
                          onKeyDown={e => {
                            if (e.key === 'Enter') onConfirmAdd();
                            if (e.key === 'Escape') onCancelAdd();
                          }}
                        />
                        <button onClick={onConfirmAdd} className="p-0.5 text-green-400 hover:text-green-300">
                          <Check size={12} />
                        </button>
                        <button onClick={onCancelAdd} className="p-0.5 text-muted-foreground hover:text-foreground">
                          <X size={12} />
                        </button>
                      </div>
                    ) : hasValue ? (
                      <div className="font-mono">
                        {values.map((v, i) => (
                          <div key={i} className="flex items-center gap-1 group/val">
                            <AttrValueDisplay value={v} attrName={attrName} />
                            {!isReadOnly && !isNoUserMod && (
                              <button
                                onClick={() => onDeleteValue(attrName, i)}
                                className="p-0.5 text-muted-foreground hover:text-destructive opacity-0 group-hover/val:opacity-100 shrink-0"
                                title="Remove value"
                              >
                                <X size={10} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground/50 italic text-[10px]">
                        {isMust ? 'required — click + to set' : 'not set'}
                      </span>
                    )}
                  </td>

                  {/* Actions */}
                  <td className="px-2 py-1 w-[70px] align-top">
                    {!isReadOnly && !isNoUserMod && !isEditing && !isAdding && (
                      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100">
                        {hasValue ? (
                          <>
                            <button onClick={() => onStartEdit(attrName)} className="p-0.5 text-muted-foreground hover:text-foreground" title="Edit">
                              <Pencil size={12} />
                            </button>
                            <button onClick={() => onStartAdd(attrName)} className="p-0.5 text-muted-foreground hover:text-foreground" title="Add value">
                              <Plus size={12} />
                            </button>
                            {!isMust && (
                              <button onClick={() => onDeleteAttr(attrName)} className="p-0.5 text-muted-foreground hover:text-destructive" title="Delete attribute">
                                <Trash2 size={12} />
                              </button>
                            )}
                          </>
                        ) : (
                          <button onClick={() => onStartAdd(attrName)} className="p-0.5 text-muted-foreground hover:text-primary" title="Set value">
                            <Plus size={12} />
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AttrValueDisplay({ value, attrName }: { value: string; attrName: string }) {
  const [show, setShow] = useState(false);
  const lower = attrName.toLowerCase();
  const isPassword = PASSWORD_ATTRS.has(lower);
  const isDnRef = DN_REFERENCE_ATTRS.has(lower);

  if (isPassword) {
    return (
      <div className="flex items-center gap-1 flex-1 min-w-0">
        <span className="break-all truncate">
          {show ? value : '\u2022'.repeat(Math.min(value.length || 8, 16))}
        </span>
        <button onClick={() => setShow(!show)} className="p-0.5 text-muted-foreground hover:text-foreground shrink-0">
          {show ? <EyeOff size={10} /> : <Eye size={10} />}
        </button>
      </div>
    );
  }

  if (isDnRef) {
    return (
      <div className="flex items-center gap-1 flex-1 min-w-0">
        <Link2 size={10} className="text-blue-400 shrink-0" />
        <span className="break-all text-blue-300">{value}</span>
      </div>
    );
  }

  return <span className="break-all flex-1 min-w-0">{value}</span>;
}
