/**
 * Edit Entry (one atomic save): object classes left, the attributes of every
 * class right. UX round: attribute filter + "Set and required only" (default
 * on for AD, whose classes allow hundreds of attributes), Save stays disabled
 * while required attributes are missing (links jump to their rows), the
 * pending changes are listed (secrets masked), password attributes are typed
 * twice and only replaced, never added (ED-09, ED-14), and a userPassword on
 * AD asks first (ED-10).
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  X, Save, Plus, Trash2, Pencil, Check, ChevronDown, ChevronRight,
  Box, Shield, Layers, Eye, EyeOff, Link2, Upload, KeyRound, TriangleAlert, ListChecks,
} from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { useUnsavedEdits } from '../../stores/unsavedEdits'
import {
  LDAPEntry, SchemaInfo, SchemaObjectClass, SchemaAttribute, ValidationError, type ServerType,
} from '../../types/ldap'
import { cn } from '../../lib/utils'
import { DN_REFERENCE_ATTRS, PASSWORD_ATTRS } from '../../lib/ad-constants'
import {
  blockingValidationErrors, buildEntryChanges, describeChange, findAttributeKey, requiredButNotLoaded, stageOpenInputs,
} from '../../lib/entryChanges'
import { attrBaseName, binaryTransferName, isBinaryAttributeName } from '../../lib/binary'
import * as wails from '../../lib/wails'
import { firstRDN, parseRDN } from '../../lib/dn'
import { OpenBinaryFile } from '../../lib/wails-binary'
import { BinaryValueView } from './BinaryValueView'
import { PasswordSchemeBadge } from '../password/PasswordSchemeBadge'
import { PasswordPolicyHint } from '../password/PasswordPolicyHint'
import { notifyPasswordWrite, usePasswordWriteGuard } from '../password/PasswordWriteGuard'
import { ModifyEntryWithOptions } from '../../lib/wails-pwpolicy'
import { PASSWORD_MASK, isHashedPasswordValue, isPasswordWriteAttribute, isUserPasswordAttribute } from '../../lib/passwordPolicy'
import { describeUploadedFile, errorMessage } from './useBinaryActions'
import { toast } from '../ui/Toast'
import { Badge, type BadgeTone } from '../ui/Badge'
import { Dialog } from '../ui/Dialog'
import { Button, IconButton } from '../ui/Button'
import { Input, SearchInput, Textarea } from '../ui/Input'
import { Checkbox } from '../ui/Checkbox'
import { Disclosure } from '../ui/Disclosure'
import { NewPasswordInput, newPasswordReady } from '../password/NewPasswordInput'
import { ensureServerType, getCommandContext, runCommand } from '../ui/commands'
import { Combobox } from '../ui/Listbox'
import { InlineAlert } from '../ui/InlineAlert'
import { Spinner } from '../ui/Spinner'
import { Dn } from '../ui/Dn'
import { TruncatedText } from '../ui/TruncatedText'
import { DialogCancelButton } from './DialogCancelButton'

interface EditEntryDialogProps {
  dn: string;
  /** The entry's connection (default: the active one); a tab of another connection passes its own. */
  profileId?: string;
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

// --- userPassword on AD (ED-10) ---

export type AdUserPasswordAnswer = 'reset' | 'store' | 'cancel';

/**
 * Asks before a userPassword value is written on AD: Active Directory never
 * uses it for logons and stores it readable. The default answer is Reset
 * Password… (unicodePwd); "Store as Cleartext" writes it anyway.
 */
export function useAdUserPasswordPrompt() {
  const [pending, setPending] = useState<((answer: AdUserPasswordAnswer) => void) | null>(null);
  const resetRef = useRef<HTMLButtonElement>(null);
  const ask = useCallback(() => new Promise<AdUserPasswordAnswer>((resolve) => setPending(() => resolve)), []);
  const answer = (a: AdUserPasswordAnswer) => {
    const resolve = pending;
    setPending(null);
    resolve?.(a);
  };
  const element = pending ? (
    <Dialog
      open
      onOpenChange={(o) => !o && answer('cancel')}
      size="sm"
      role="alertdialog"
      icon={<TriangleAlert size={16} strokeWidth={1.75} aria-hidden className="text-warning" />}
      title="Store a readable cleartext userPassword?"
      dismissible="always"
      initialFocus={resetRef}
      footer={
        <>
          <Button variant="secondary" onClick={() => answer('cancel')}>Cancel</Button>
          <Button variant="secondary" onClick={() => answer('store')}>Store as Cleartext</Button>
          <Button ref={resetRef} variant="primary" leftIcon={KeyRound} onClick={() => answer('reset')}>Reset Password…</Button>
        </>
      }
    >
      <p className="text-sm">
        Active Directory does not use <span className="font-mono">userPassword</span> for logons: the value is stored exactly as typed, and
        everyone who may read the attribute can read it. To set the account's password, use Reset Password.
      </p>
    </Dialog>
  ) : null;
  return { ask, element };
}

// --- Main Component ---

export function EditEntryDialog({ dn, profileId: profileProp, onClose, onSaved }: EditEntryDialogProps) {
  // The entry's own connection (named activeProfileId for history: it is the dialog's profile).
  const storeProfileId = useConnectionStore((s) => s.activeProfileId);
  const activeProfileId = profileProp ?? storeProfileId;
  const profiles = useConnectionStore((s) => s.profiles);
  const isReadOnly = activeProfileId
    ? profiles.find(p => p.id === activeProfileId)?.readOnly ?? false
    : false;
  // Focus target once the entry has loaded: the attribute pane (the loading
  // state's Close button is gone by then; never the first "Remove class" X).
  const attrPaneRef = useRef<HTMLDivElement>(null);

  const [entry, setEntry] = useState<LDAPEntry | null>(null);
  const [schema, setSchema] = useState<SchemaInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);

  // Editable state: object classes & attribute working copies
  const [objectClasses, setObjectClasses] = useState<string[]>([]);
  const [originalObjectClasses, setOriginalObjectClasses] = useState<string[]>([]);
  const [workingAttrs, setWorkingAttrs] = useState<Map<string, string[]>>(new Map());
  const [originalAttrs, setOriginalAttrs] = useState<Map<string, string[]>>(new Map());
  // Lower-case names of binary attributes (values are base64, see
  // LDAPAttribute): those of the loaded entry plus attributes that got a
  // value from a file in this dialog.
  const [binaryAttrs, setBinaryAttrs] = useState<Set<string>>(new Set());

  // UI state
  const [collapsedClasses, setCollapsedClasses] = useState<Set<string>>(new Set());
  const [editingAttr, setEditingAttr] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  // Passwords are typed twice (a typo would set a password nobody knows, ED-09)
  const [editConfirm, setEditConfirm] = useState('');
  // Attribute filter and "Set and required only" (null = default: on for AD, ED-14)
  const [attrFilter, setAttrFilter] = useState('');
  const [setOnlyChoice, setSetOnlyChoice] = useState<boolean | null>(null);
  const [serverType, setServerType] = useState<ServerType | null>(null);
  const [addingAttr, setAddingAttr] = useState<string | null>(null);
  const [addValue, setAddValue] = useState('');
  const [showAddClass, setShowAddClass] = useState(false);
  // Save with password values: password storage policy (ask, unencrypted confirmation)
  const passwordGuard = usePasswordWriteGuard();
  const adPasswordPrompt = useAdUserPasswordPrompt();

  useEffect(() => {
    if (!activeProfileId) return;
    let cancelled = false;
    void ensureServerType(activeProfileId).then((t) => { if (!cancelled) setServerType(t); });
    return () => { cancelled = true; };
  }, [activeProfileId]);
  const setOrRequiredOnly = setOnlyChoice ?? serverType === 'ad';

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
        setBinaryAttrs(new Set(e.attributes.filter(a => a.binary).map(a => a.name.toLowerCase())));
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

  // MUST attributes of the classes the entry had when loaded
  const mustBefore = useMemo(
    () => collectClassAttributes(originalObjectClasses, classMap).must,
    [originalObjectClasses, classMap]
  );

  /**
   * Required attributes the server keeps but did not return (AD's
   * nTSecurityDescriptor): shown as such, never offered for editing, and
   * their absence does not block Save.
   */
  const isNotLoadedRequired = useCallback(
    (schemaName: string) => requiredButNotLoaded(schemaName, mustBefore, originalAttrs.keys()),
    [mustBefore, originalAttrs]
  );

  /** Whether value of attribute name was added in this dialog (not stored yet). */
  const isStagedValue = useCallback(
    (name: string, value: string) => !(originalAttrs.get(name) || []).includes(value),
    [originalAttrs]
  );

  // All pending changes as the single atomic ModifyEntry request that Save
  // sends: objectClass adds, attribute adds/replaces/deletes (binary ones
  // with binary: true, unchanged attributes left out), objectClass deletes.
  // A value typed into the add row or the inline editor but not added with
  // Enter is saved too, never dropped silently (RW1-E-02).
  const openInputs = useMemo(() => stageOpenInputs(workingAttrs, {
    add: addingAttr ? { attr: addingAttr, value: addValue, password: isPasswordWriteAttribute(addingAttr) } : null,
    edit: editingAttr
      ? isPasswordWriteAttribute(editingAttr)
        ? { attr: editingAttr, value: editValue, password: true, ready: !!editValue && newPasswordReady(editValue, editConfirm) }
        : { attr: editingAttr, value: editValue }
      : null,
  }), [workingAttrs, addingAttr, addValue, editingAttr, editValue, editConfirm]);
  const effectiveAttrs = openInputs.attrs;
  const effectiveBinary = useMemo(() => {
    if (!openInputs.passwordAttrs.length) return binaryAttrs;
    const next = new Set(binaryAttrs);
    for (const a of openInputs.passwordAttrs) next.delete(a.toLowerCase());
    return next;
  }, [binaryAttrs, openInputs]);
  const changes = useMemo(() => buildEntryChanges({
    originalObjectClasses,
    objectClasses,
    originalAttrs,
    workingAttrs: effectiveAttrs,
    binaryAttrs: effectiveBinary,
  }), [originalObjectClasses, objectClasses, originalAttrs, effectiveAttrs, effectiveBinary]);

  const dirty = changes.length > 0;
  // Pending changes: an AI write to this entry warns instead of refreshing.
  useUnsavedEdits(activeProfileId, dn, dirty);

  // MUST attributes, case-insensitive and without ";binary" options (the entry may spell them differently).
  const mustLower = useMemo(() => new Set([...classAttrs.must].map(a => a.toLowerCase())), [classAttrs]);
  const isMustAttr = useCallback((name: string) => mustLower.has(attrBaseName(name)), [mustLower]);

  /**
   * Required attributes without a value that Save would be refused for (ED-14):
   * not those the server keeps without returning them (requiredButNotLoaded).
   */
  const missingRequired = useMemo(() => {
    const out: string[] = [];
    for (const name of classAttrs.must) {
      if (name.toLowerCase() === 'objectclass') continue;
      const key = findAttributeKey(effectiveAttrs.keys(), name) ?? name;
      const vals = effectiveAttrs.get(key) || [];
      if (vals.some(v => v !== '')) continue;
      if (requiredButNotLoaded(name, mustBefore, originalAttrs.keys())) continue;
      out.push(name);
    }
    return out.sort((a, b) => a.localeCompare(b));
  }, [classAttrs, effectiveAttrs, mustBefore, originalAttrs]);

  // Available classes to add (auxiliary and structural, excluding abstract)
  const availableClasses = useMemo(() => {
    if (!schema) return [];
    const currentLower = new Set(objectClasses.map(c => c.toLowerCase()));
    return schema.objectClasses
      .filter(oc => oc.kind !== 'abstract' && !currentLower.has(oc.name.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [schema, objectClasses]);

  // --- Handlers ---

  function handleAddClass(className: string) {
    if (!objectClasses.some(c => c.toLowerCase() === className.toLowerCase())) {
      setObjectClasses([...objectClasses, className]);
    }
    setShowAddClass(false);
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
      for (const schemaName of [...classInfo.must, ...classInfo.may]) {
        if (!remainingAttrs.must.has(schemaName) && !remainingAttrs.may.has(schemaName)) {
          // The entry may spell it differently (case, ";binary")
          const key = findAttributeKey(newWorkingAttrs.keys(), schemaName) ?? schemaName;
          const vals = newWorkingAttrs.get(key);
          if (!vals || vals.length === 0 || vals.every(v => !v)) {
            newWorkingAttrs.delete(key);
          }
        }
      }
    }

    setObjectClasses(remaining);
    setWorkingAttrs(newWorkingAttrs);
  }

  /** True if values of the attribute are base64 binary data. */
  const isBinaryAttr = useCallback(
    (attrName: string) => binaryAttrs.has(attrName.toLowerCase()),
    [binaryAttrs]
  );

  /** True if new values of the attribute come from a file (binary now or by name/schema syntax). */
  const takesFileValues = useCallback(
    (attrName: string) => isBinaryAttr(attrName) ||
      (!workingAttrs.get(attrName)?.length && isBinaryAttributeName(attrName, attrMap.get(attrBaseName(attrName))?.syntax)),
    [isBinaryAttr, workingAttrs, attrMap]
  );

  /**
   * The working-copy key of a schema attribute name: the entry may spell it
   * differently ("userCertificate;binary" on OpenLDAP, other case).
   */
  const resolveKey = useCallback(
    (schemaName: string) => findAttributeKey(workingAttrs.keys(), schemaName) ?? schemaName,
    [workingAttrs]
  );

  function startEditAttr(attrName: string) {
    if (isPasswordWriteAttribute(attrName)) {
      // A password is typed new (stored values are hashes), twice, and replaces all values.
      setEditingAttr(attrName);
      setEditValue('');
      setEditConfirm('');
      return;
    }
    if (isBinaryAttr(attrName)) {
      toast.info(`"${attrName}" is binary and cannot be edited as text`);
      return;
    }
    const vals = workingAttrs.get(attrName) || [];
    setEditingAttr(attrName);
    setEditValue(vals.join('\n'));
  }

  function saveEditAttr() {
    if (!editingAttr) return;
    if (isPasswordWriteAttribute(editingAttr)) {
      if (editValue && !newPasswordReady(editValue, editConfirm)) return; // not typed the same twice
      if (editValue) {
        const next = new Map(workingAttrs);
        next.set(editingAttr, [editValue]);
        setWorkingAttrs(next);
        // the new password is text, also when the stored value was binary
        setBinaryAttrs(prev => { const n = new Set(prev); n.delete(editingAttr.toLowerCase()); return n; });
      }
      setEditingAttr(null);
      setEditValue('');
      setEditConfirm('');
      return;
    }
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
    setEditConfirm('');
  }

  function startAddAttr(attrName: string) {
    // A password is set (typed twice) and replaces all values, never added as a second one.
    if (isPasswordWriteAttribute(attrName)) {
      startEditAttr(attrName);
      return;
    }
    if (takesFileValues(attrName)) {
      void addValueFromFile(attrName);
      return;
    }
    setAddingAttr(attrName);
    setAddValue('');
  }

  /**
   * Reads a file for a binary attribute and stages it: a new value, or the
   * only value of a single-valued attribute. Nothing is written until Save.
   */
  async function addValueFromFile(attrName: string) {
    if (!activeProfileId) return;
    try {
      const schemaAttr = attrMap.get(attrBaseName(attrName));
      // Existing spelling, else the name the server expects (";binary" for certificate syntaxes on OpenLDAP)
      const name = findAttributeKey(workingAttrs.keys(), attrName) ?? binaryTransferName(attrName, schemaAttr?.syntax);
      const file = await OpenBinaryFile(activeProfileId, name);
      if (!file) return;
      const existing = isBinaryAttr(name) ? (workingAttrs.get(name) || []) : [];
      if (existing.includes(file.data)) {
        toast.info(`${name} already holds this file`);
        return;
      }
      const next = new Map(workingAttrs);
      next.set(name, schemaAttr?.singleValue ? [file.data] : [...existing, file.data]);
      setWorkingAttrs(next);
      setBinaryAttrs(prev => new Set(prev).add(name.toLowerCase()));
      toast.info(`${name}: ${describeUploadedFile(file)} staged — Save applies it`);
    } catch (err) {
      toast.error(`Failed to read file for ${attrName}`, errorMessage(err, 'Unknown error'));
    }
  }

  function confirmAddAttr() {
    if (!addingAttr || !addValue.trim()) return;
    const next = new Map(workingAttrs);
    const existing = next.get(addingAttr) || [];
    // Passwords are taken as typed (leading/trailing blanks included).
    next.set(addingAttr, [...existing, isPasswordWriteAttribute(addingAttr) ? addValue : addValue.trim()]);
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
    if (isMustAttr(attrName)) {
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

  // Clear validation errors when attributes or object classes change
  useEffect(() => {
    setValidationErrors([]);
  }, [workingAttrs, objectClasses]);

  /** Shows a required attribute's row and opens its input (the footer links). */
  function jumpToAttribute(schemaName: string) {
    setAttrFilter('');
    setCollapsedClasses(new Set());
    const key = findAttributeKey(workingAttrs.keys(), schemaName) ?? schemaName;
    requestAnimationFrame(() => {
      const row = attrPaneRef.current?.querySelector<HTMLElement>(`tr[data-attr="${CSS.escape(schemaName.toLowerCase())}"]`);
      row?.scrollIntoView({ block: 'center' });
      if (takesFileValues(key)) row?.querySelector<HTMLElement>('button')?.focus();
      else startAddAttr(key);
    });
  }

  async function handleSave() {
    if (!activeProfileId || isReadOnly || missingRequired.length > 0 || openInputs.blocked) return;

    // Build attributes map for validation (with the values still typed in an open input)
    const attrMapForValidation: Record<string, string[]> = {};
    for (const [name, values] of effectiveAttrs) {
      attrMapForValidation[name] = values;
    }

    // Validate against schema before saving. Only problems this edit causes
    // block: AD never returns nTSecurityDescriptor (MUST of top) for "*"/"+",
    // so its absence is not an error here.
    try {
      const valErrors = await wails.ValidateEntry(activeProfileId, objectClasses, attrMapForValidation);
      const { blocking } = blockingValidationErrors(valErrors ?? [], {
        mustBefore,
        originalAttrNames: originalAttrs.keys(),
        objectClassesChanged: changes.some(c => c.attribute === 'objectClass'),
      });
      if (blocking.length > 0) {
        setValidationErrors(blocking);
        return;
      }
    } catch {
      // Validation service unavailable — proceed without validation
    }
    setValidationErrors([]);

    if (changes.length === 0) return;
    // userPassword on AD is stored readable and never used for logons (ED-10).
    if (serverType === 'ad' && changes.some(c => isUserPasswordAttribute(c.attribute) && c.operation !== 'delete' && c.values.length > 0)) {
      const answer = await adPasswordPrompt.ask();
      if (answer === 'cancel') return;
      if (answer === 'reset') {
        runCommand('account.resetPassword', getCommandContext('editor', { selection: [{ dn, profileId: activeProfileId }] }));
        return;
      }
    }
    setSaving(true);
    setError(null);

    try {
      // One Modify request: the server applies all changes or none, so an
      // auxiliary class can be added together with its required attributes
      // and a failure never leaves the entry half-saved.
      const opts = await passwordGuard.check(activeProfileId, { changes });
      if (!opts) return; // cancelled: nothing was sent
      const report = await ModifyEntryWithOptions(activeProfileId, dn, changes, opts);
      // The toast names the entry (§0.2): "ux-1 updated" / "ux-1 updated (3 changes)".
      const entryName = parseRDN(firstRDN(dn)).value || dn;
      notifyPasswordWrite(report, `${entryName} updated${changes.length > 1 ? ` (${changes.length} changes)` : ''}`, { profileId: activeProfileId, dn });
      onSaved?.();
      onClose();
    } catch (err) {
      const msg = errorMessage(err, 'Failed to save changes');
      setError(`${msg} — nothing was changed`);
      toast.error('Failed to save changes', msg);
    } finally {
      setSaving(false);
    }
  }

  // --- Render ---

  if (loading || !entry || !schema) {
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        size="xl"
        icon={<Pencil size={16} strokeWidth={1.75} aria-hidden className="text-primary" />}
        title="Edit Entry"
        dismissible="always"
        footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
      >
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-muted-foreground" role="status">
            <Spinner size="md" decorative />
            <span className="text-sm">Loading entry…</span>
          </div>
        ) : (
          <InlineAlert tone="danger" title="The entry could not be loaded" body={error || 'Failed to load entry'} />
        )}
      </Dialog>
    );
  }

  // Build the grouped attribute display: one section per class of the SUP chains, also
  // the classes the entry does not list (RW2-E-01: OpenLDAP entries often store only
  // inetOrgPerson, so cn, sn, description, telephoneNumber, userPassword of
  // organizationalPerson / person had no section and were kept out of Other Attributes).
  // Order: abstract, structural, auxiliary; inside a kind the listed classes first,
  // then the inherited ones from the most specific up.
  const sectionClasses: { name: string; inherited: boolean }[] = [];
  {
    const seen = new Set<string>();
    for (const name of objectClasses) {
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      sectionClasses.push({ name, inherited: false });
    }
    for (const name of objectClasses) {
      for (const oc of resolveClassHierarchy(name, classMap)) {
        if (seen.has(oc.name.toLowerCase())) continue;
        seen.add(oc.name.toLowerCase());
        sectionClasses.push({ name: oc.name, inherited: true });
      }
    }
  }
  const kindRank = (name: string) => {
    const kind = classMap.get(name.toLowerCase())?.kind || 'structural';
    return kind === 'abstract' ? 0 : kind === 'structural' ? 1 : 2;
  };
  const sortedClasses = sectionClasses
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => {
      const k = kindRank(a.name) - kindRank(b.name);
      if (k) return k;
      if (a.inherited !== b.inherited) return a.inherited ? 1 : -1;
      return a.inherited ? a.i - b.i : a.name.localeCompare(b.name);
    });

  // Each attribute in one section: the first class (in display order) that declares it.
  const sectionShown = new Set<string>();
  const sectionPlans = sortedClasses.flatMap(({ name, inherited }) => {
    const oc = classMap.get(name.toLowerCase());
    if (!oc && inherited) return [];
    const directMust = new Set((oc?.must || []).filter((a) => !sectionShown.has(a.toLowerCase())));
    const directMay = new Set((oc?.may || []).filter((a) => !sectionShown.has(a.toLowerCase()) && !directMust.has(a)));
    for (const a of [...directMust, ...directMay]) sectionShown.add(a.toLowerCase());
    if (directMust.size + directMay.size === 0 && name.toLowerCase() === 'top') return [];
    return [{ name, inherited, oc, directMust, directMay }];
  });

  // Collect "extra" attributes: ones on the entry but not defined by any current object class
  const shownBySchema = new Set([...classAttrs.must, ...classAttrs.may].map(resolveKey));
  const extraAttrs = Array.from(workingAttrs.keys())
    .filter(name => !shownBySchema.has(name) && name !== 'objectClass')
    .sort((a, b) => a.localeCompare(b));
  // A typed filter that matches no attribute says so instead of an empty pane (RW2-E-01).
  const filterLower = attrFilter.trim().toLowerCase();
  const filterHits = !filterLower || [...sectionShown, ...extraAttrs.map((a) => a.toLowerCase())].some((name) =>
    name !== 'objectclass' && (name.includes(filterLower) || resolveKey(name).toLowerCase().includes(filterLower)));

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !saving && onClose()}
      size="xl"
      icon={<Pencil size={16} strokeWidth={1.75} aria-hidden className="text-primary" />}
      title="Edit Entry"
      description={<Dn dn={dn} />}
      dismissible={saving ? 'never' : 'when-clean'}
      dirty={dirty}
      initialFocus={attrPaneRef}
      className="h-[700px]"
      bodyClassName="p-0 flex flex-col overflow-hidden border-t border-border"
      footer={
        <>
          <span className="mr-auto min-w-0 text-sm text-muted-foreground flex flex-wrap items-center gap-x-1.5" aria-live="polite">
            {!isReadOnly && missingRequired.length > 0 ? (
              <>
                <span className="text-destructive font-medium">
                  {missingRequired.length} required missing:
                </span>
                {missingRequired.slice(0, 4).map((name) => (
                  <Button key={name} size="sm" variant="link" className="font-mono" onClick={() => jumpToAttribute(name)}>
                    {name}
                  </Button>
                ))}
                {missingRequired.length > 4 && <span>…</span>}
              </>
            ) : !isReadOnly && openInputs.blocked ? (
              <span className="text-destructive">{openInputs.blocked}</span>
            ) : dirty ? (
              <span className="text-foreground">
                {changes.length} unsaved change{changes.length !== 1 ? 's' : ''}
                {openInputs.staged > 0 &&
                  // A typed new password is the change itself, not "a value typed but not added" (RW2-P-04).
                  (openInputs.passwordAttrs.length === openInputs.staged && changes.length === openInputs.staged
                    ? ` (new ${openInputs.passwordAttrs.length === 1 ? 'password' : 'passwords'})`
                    : ` (incl. ${openInputs.staged === 1 ? 'a value typed but not added yet' : `${openInputs.staged} values typed but not added yet`})`)}
                {' '}— saved together in one request
              </span>
            ) : (
              'No changes'
            )}
          </span>
          <DialogCancelButton disabled={saving}>{isReadOnly ? 'Close' : 'Cancel'}</DialogCancelButton>
          {!isReadOnly && (
            <Button
              variant="primary"
              leftIcon={Save}
              loading={saving}
              disabled={!dirty || missingRequired.length > 0 || !!openInputs.blocked}
              title={missingRequired.length > 0 ? `Set the required attributes first: ${missingRequired.join(', ')}` : openInputs.blocked ?? undefined}
              onClick={() => void handleSave()}
            >
              Save Changes
            </Button>
          )}
        </>
      }
    >

      {/* Attribute filter (ED-14) */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border bg-card shrink-0">
        <SearchInput
          size="sm"
          value={attrFilter}
          onValueChange={setAttrFilter}
          placeholder="Filter attributes"
          aria-label="Filter attributes"
          wrapperClassName="flex-1 min-w-[160px] max-w-[320px]"
        />
        <Checkbox
          checked={setOrRequiredOnly}
          onCheckedChange={(c) => setSetOnlyChoice(c)}
          label="Set and required only"
        />
        {setOrRequiredOnly && attrFilter.trim() && <span className="text-xs text-muted-foreground">all attributes while filtering</span>}
      </div>

      {/* Main two-panel layout */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Left panel: Object Classes */}
        <div className="w-[240px] shrink-0 border-r border-border flex flex-col bg-secondary">
          <div className="px-3 py-2 border-b border-border shrink-0">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Object Classes
            </h3>
          </div>
          <div className="flex-1 overflow-auto py-1">
            {objectClasses.map(className => {
              const oc = classMap.get(className.toLowerCase());
              const kind = oc?.kind || 'structural';
              const isRemovable = className.toLowerCase() !== 'top';
              return (
                <div
                  key={className}
                  className="flex items-center gap-1.5 px-3 h-table-row group hover:bg-accent"
                >
                  <KindIcon kind={kind} />
                  <TruncatedText text={className} className="text-sm flex-1 font-mono" />
                  <KindBadge kind={kind} />
                  {!isReadOnly && isRemovable && (
                    <IconButton size="sm" label={`Remove ${className}`} icon={X} revealOnRowHover className="enabled:hover:text-destructive" onClick={() => handleRemoveClass(className)} />
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
                  <Combobox
                    items={availableClasses}
                    getKey={(oc) => oc.name}
                    getLabel={(oc) => oc.name}
                    filter={(oc, q) => oc.name.toLowerCase().includes(q.trim().toLowerCase()) || oc.description.toLowerCase().includes(q.trim().toLowerCase())}
                    renderItem={(oc) => (
                      <>
                        <KindIcon kind={oc.kind} />
                        <span className="truncate font-mono flex-1">{oc.name}</span>
                        <KindBadge kind={oc.kind} />
                      </>
                    )}
                    onSelect={(oc) => handleAddClass(oc.name)}
                    clearOnSelect
                    autoFocus
                    size="sm"
                    placeholder="Search classes…"
                    aria-label="Object class to add"
                    emptyText="No matching classes"
                  />
                  <Button size="sm" variant="ghost" className="w-full" onClick={() => setShowAddClass(false)}>Cancel</Button>
                </div>
              ) : (
                <Button size="sm" variant="ghost" leftIcon={Plus} className="w-full" onClick={() => setShowAddClass(true)}>
                  Add Class
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Right panel: Attributes (focusable: arrow keys scroll it, Tab enters its controls) */}
        <div ref={attrPaneRef} tabIndex={-1} role="group" aria-label="Attributes" className="flex-1 overflow-auto min-w-0 outline-hidden focus-ring-inset">
          {sectionPlans.map(({ name: className, inherited, oc, directMust, directMay }) => {

            const isCollapsed = collapsedClasses.has(className);

            return (
              <ClassSection
                key={className}
                className={className}
                inherited={inherited}
                kind={oc?.kind || 'structural'}
                isCollapsed={isCollapsed}
                onToggle={() => toggleClassCollapse(className)}
                directMust={directMust}
                directMay={directMay}
                workingAttrs={workingAttrs}
                attrMap={attrMap}
                globalMust={mustLower}
                editingAttr={editingAttr}
                editValue={editValue}
                editConfirm={editConfirm}
                onEditConfirmChange={setEditConfirm}
                filterText={attrFilter.trim().toLowerCase()}
                setOrRequiredOnly={setOrRequiredOnly}
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
                isBinaryAttr={isBinaryAttr}
                takesFileValues={takesFileValues}
                resolveKey={resolveKey}
                isNotLoadedRequired={isNotLoadedRequired}
                isStagedValue={isStagedValue}
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
              globalMust={mustLower}
              editingAttr={editingAttr}
              editValue={editValue}
              editConfirm={editConfirm}
              onEditConfirmChange={setEditConfirm}
              filterText={attrFilter.trim().toLowerCase()}
              setOrRequiredOnly={setOrRequiredOnly}
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
              isBinaryAttr={isBinaryAttr}
              takesFileValues={takesFileValues}
              resolveKey={resolveKey}
              isNotLoadedRequired={isNotLoadedRequired}
              isStagedValue={isStagedValue}
            />
          )}
          {!filterHits && (
            <p className="px-3 py-4 text-sm text-muted-foreground" role="status">
              No attribute matches "{attrFilter.trim()}".
            </p>
          )}
        </div>
      </div>

      {/* The pending changes, secrets masked (ED-14) */}
      {dirty && (
        <div className="px-4 py-1.5 border-t border-border shrink-0">
          <Disclosure
            title="Changes"
            icon={ListChecks}
            summary={`${changes.length} · saved together in one request`}
            defaultOpen
            contentClassName="mt-1 max-h-24 overflow-auto"
          >
            <ul className="font-mono text-xs space-y-0.5">
              {changes.map((c, i) => (
                <li key={i} className="truncate" title={describeChange(c)}>{describeChange(c)}</li>
              ))}
            </ul>
          </Disclosure>
        </div>
      )}

      {/* Validation errors / save error */}
      {(validationErrors.length > 0 || error) && (
        <div className="px-4 py-2 border-t border-border shrink-0 space-y-2">
          {validationErrors.length > 0 && (
            <InlineAlert
              tone="danger"
              title="The schema check failed"
              body={
                <ul className="space-y-0.5">
                  {validationErrors.map((e, i) => (
                    <li key={i}><span className="font-medium font-mono">{e.attribute}:</span> {e.message}</li>
                  ))}
                </ul>
              }
            />
          )}
          {error && <InlineAlert tone="danger" body={error} />}
        </div>
      )}

      {/* Staged password values: how the connection's policy stores them */}
      {changes.some(c => isUserPasswordAttribute(c.attribute) && c.operation !== 'delete' && c.values.length > 0) && (
        <PasswordPolicyHint profileId={activeProfileId} className="px-4 py-1.5 border-t border-border shrink-0" />
      )}
      {passwordGuard.element}
      {adPasswordPrompt.element}
    </Dialog>
  );
}

// --- Sub-components ---

function KindIcon({ kind }: { kind: string }) {
  switch (kind) {
    case 'structural': return <Box size={12} strokeWidth={1.75} aria-hidden className="text-primary shrink-0" />;
    case 'auxiliary': return <Layers size={12} strokeWidth={1.75} aria-hidden className="text-success shrink-0" />;
    case 'abstract': return <Shield size={12} strokeWidth={1.75} aria-hidden className="text-warning shrink-0" />;
    default: return <Box size={12} strokeWidth={1.75} aria-hidden className="text-muted-foreground shrink-0" />;
  }
}

/** The full kind label, as the Schema browser shows it (tones = SchemaDetailView OC_KIND_TONE). */
function KindBadge({ kind }: { kind: string }) {
  const tones: Record<string, BadgeTone> = {
    structural: 'primary',
    auxiliary: 'success',
    abstract: 'warning',
  };
  return (
    <Badge tone={tones[kind] ?? 'neutral'} className="shrink-0">
      {kind}
    </Badge>
  );
}

// --- Class section with attributes ---

interface ClassSectionProps {
  className: string;
  /** A superclass the entry does not list in objectClass (its attributes still apply). */
  inherited?: boolean;
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
  /** Confirmation of a password being typed. */
  editConfirm: string;
  onEditConfirmChange: (v: string) => void;
  /** Lower-case attribute filter ('' = all). */
  filterText: string;
  /** Only attributes with a value or required by the schema. */
  setOrRequiredOnly: boolean;
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
  /** Values are base64 binary data (rendered as preview, never edited as text). */
  isBinaryAttr: (name: string) => boolean;
  /** New values come from a file instead of a text field. */
  takesFileValues: (name: string) => boolean;
  /** Working-copy key for a schema attribute name. */
  resolveKey: (schemaName: string) => string;
  /** Required before the edit but not returned by the server (kept as is). */
  isNotLoadedRequired: (schemaName: string) => boolean;
  /** The value is new in this dialog (not stored yet). */
  isStagedValue: (name: string, value: string) => boolean;
}

function ClassSection({
  className, inherited, kind, isCollapsed, onToggle,
  directMust, directMay, workingAttrs, attrMap, globalMust,
  editingAttr, editValue, editConfirm, onEditConfirmChange, filterText, setOrRequiredOnly, addingAttr, addValue, isReadOnly,
  onStartEdit, onSaveEdit, onCancelEdit, onEditValueChange,
  onStartAdd, onConfirmAdd, onCancelAdd, onAddValueChange,
  onDeleteValue, onDeleteAttr, isBinaryAttr, takesFileValues, resolveKey, isNotLoadedRequired, isStagedValue,
}: ClassSectionProps) {
  const allAttrs = useMemo(() => {
    // objectClass is edited in the left panel
    const notOC = (a: string) => a.toLowerCase() !== 'objectclass';
    const must = Array.from(directMust).filter(notOC).sort((a, b) => a.localeCompare(b));
    const may = Array.from(directMay)
      .filter(a => !directMust.has(a) && notOC(a))
      .sort((a, b) => a.localeCompare(b));
    return [...must, ...may];
  }, [directMust, directMay]);

  const shownAttrs = allAttrs.filter((schemaName) => {
    const attrName = resolveKey(schemaName);
    if (filterText && !attrName.toLowerCase().includes(filterText) && !schemaName.toLowerCase().includes(filterText)) return false;
    // A typed filter searches every attribute: looking for an unset one ("mobile") is the
    // usual reason to filter (RW1-E-09).
    if (!setOrRequiredOnly || filterText || editingAttr === attrName || addingAttr === attrName) return true;
    const hasValue = (workingAttrs.get(attrName) || []).some(v => v !== '');
    return hasValue || globalMust.has(schemaName.toLowerCase());
  });
  if (shownAttrs.length === 0) return null;

  const kindColors = {
    structural: 'border-l-primary',
    auxiliary: 'border-l-success',
    abstract: 'border-l-warning',
    other: 'border-l-border-strong',
  };

  return (
    <div className={cn('border-b border-border', kindColors[kind as keyof typeof kindColors] || 'border-l-transparent', 'border-l-2')}>
      {/* Section header */}
      <button type="button"
        onClick={onToggle}
        aria-expanded={!isCollapsed}
        className="w-full flex items-center gap-1.5 px-3 h-table-row bg-secondary hover:bg-accent text-left focus-ring-inset"
      >
        {isCollapsed ? <ChevronRight size={12} strokeWidth={1.75} aria-hidden /> : <ChevronDown size={12} strokeWidth={1.75} aria-hidden />}
        <KindIcon kind={kind} />
        <span className="text-sm font-semibold font-mono">{className}</span>
        {inherited && <span className="text-xs text-muted-foreground" title="A superclass of the entry's object classes (not listed in objectClass)">inherited</span>}
        <span className="text-xs text-muted-foreground ml-1 tabular-nums">
          {shownAttrs.length < allAttrs.length ? `${shownAttrs.length} of ${allAttrs.length}` : allAttrs.length} attribute{allAttrs.length !== 1 ? 's' : ''}
        </span>
      </button>

      {!isCollapsed && (
        <table className="w-full text-sm">
          <tbody>
            {shownAttrs.map(schemaName => {
              const attrName = resolveKey(schemaName);
              const isMust = globalMust.has(schemaName.toLowerCase());
              const values = workingAttrs.get(attrName) || [];
              const hasValue = values.length > 0 && values.some(v => v !== '');
              const schemaAttr = attrMap.get(schemaName.toLowerCase()) ?? attrMap.get(attrBaseName(attrName));
              const isNoUserMod = schemaAttr?.noUserMod || false;
              const isEditing = editingAttr === attrName;
              const isAdding = addingAttr === attrName;
              const isBinary = isBinaryAttr(attrName);
              const fromFile = takesFileValues(attrName);
              const replacesFromFile = fromFile && !!schemaAttr?.singleValue && hasValue;
              const notLoaded = !hasValue && isNotLoadedRequired(schemaName);

              return (
                <tr
                  key={schemaName}
                  data-attr={schemaName.toLowerCase()}
                  className={cn(
                    'border-t border-border hover:bg-accent group focus-within:bg-accent',
                    isEditing && 'bg-accent'
                  )}
                >
                  {/* Attribute name */}
                  <td className="px-3 py-1 w-[220px] align-top">
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-muted-foreground truncate" title={schemaAttr?.description || attrName}>
                        {attrName}
                      </span>
                      {isMust && (
                        <span className="text-destructive shrink-0" title="Required by the schema">*<span className="sr-only">required</span></span>
                      )}
                      {isNoUserMod && (
                        <Badge tone="warning" className="shrink-0">ro</Badge>
                      )}
                    </div>
                    {schemaAttr?.syntaxName && (
                      <div className="text-xs text-muted-foreground truncate">{schemaAttr.syntaxName}</div>
                    )}
                  </td>

                  {/* Value */}
                  <td className="px-3 py-1 align-top">
                    {isEditing && isPasswordWriteAttribute(attrName) ? (
                      <div className="flex items-start gap-1">
                        <NewPasswordInput
                          value={editValue}
                          onChange={onEditValueChange}
                          confirm={editConfirm}
                          onConfirmChange={onEditConfirmChange}
                          aria-label={`New ${attrName} (replaces all values)`}
                          placeholder={hasValue ? 'New password (replaces the current one)' : 'New password'}
                          autoFocus
                          onSubmit={onSaveEdit}
                          onCancel={onCancelEdit}
                          className="flex-1 min-w-0"
                        />
                        <IconButton label="Stage (Enter; type it twice)" icon={Check} disabled={!newPasswordReady(editValue, editConfirm)} onClick={onSaveEdit} />
                        <IconButton label="Cancel (Escape)" icon={X} onClick={onCancelEdit} />
                      </div>
                    ) : isEditing ? (
                      <div className="flex flex-col gap-1">
                        <Textarea
                          mono
                          aria-label={`Values of ${attrName}, one per line`}
                          value={editValue}
                          onChange={e => onEditValueChange(e.target.value)}
                          rows={Math.max(2, editValue.split('\n').length)}
                          autoFocus
                          placeholder="One value per line"
                          onKeyDown={e => {
                            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancelEdit(); }
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); onSaveEdit(); }
                          }}
                        />
                        <div className="flex items-center gap-1">
                          <IconButton label="Stage (Ctrl+Enter)" icon={Check} onClick={onSaveEdit} />
                          <IconButton label="Cancel (Escape)" icon={X} onClick={onCancelEdit} />
                          <span className="text-xs text-muted-foreground ml-1">Ctrl+Enter stages, one value per line</span>
                        </div>
                      </div>
                    ) : isAdding ? (
                      <div className="flex items-center gap-1">
                        <Input
                          type={isPasswordWriteAttribute(attrName) ? 'password' : 'text'}
                          size="sm"
                          mono
                          aria-label={`New value of ${attrName}`}
                          autoComplete="new-password"
                          value={addValue}
                          onChange={e => onAddValueChange(e.target.value)}
                          autoFocus
                          placeholder="Enter value…"
                          onKeyDown={e => {
                            if (e.key === 'Enter') { e.preventDefault(); onConfirmAdd(); }
                            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancelAdd(); }
                          }}
                        />
                        <IconButton label="Stage value (Enter)" icon={Check} onClick={onConfirmAdd} />
                        <IconButton label="Cancel (Escape)" icon={X} onClick={onCancelAdd} />
                      </div>
                    ) : hasValue ? (
                      <div className="font-mono">
                        {values.map((v, i) => (
                          <div key={i} className="flex items-center gap-1">
                            {isUserPasswordAttribute(attrName) ? (
                              <PasswordValueDisplay value={v} binary={isBinary} staged={isStagedValue(attrName, v)} />
                            ) : isBinary ? (
                              <div className="flex-1 min-w-0"><BinaryValueView attrName={attrName} value={v} compact /></div>
                            ) : (
                              <AttrValueDisplay value={v} attrName={attrName} />
                            )}
                            {!isReadOnly && !isNoUserMod && (
                              <IconButton size="sm" label="Remove value" icon={X} revealOnRowHover className="enabled:hover:text-destructive" onClick={() => onDeleteValue(attrName, i)} />
                            )}
                          </div>
                        ))}
                      </div>
                    ) : notLoaded ? (
                      <span
                        className="text-muted-foreground italic"
                        title="Required by the schema and kept by the server, but not returned when the entry is read (e.g. nTSecurityDescriptor). Saving leaves it unchanged."
                      >
                        kept by the server — not loaded
                      </span>
                    ) : (
                      <span className="text-muted-foreground italic">
                        {isMust ? 'required — use + to set it' : 'not set'}
                      </span>
                    )}
                  </td>

                  {/* Actions */}
                  <td className="px-2 py-1 w-[70px] align-top">
                    {!isReadOnly && !isNoUserMod && !notLoaded && !isEditing && !isAdding && (
                      <div className="flex gap-0.5">
                        {hasValue ? (
                          <>
                            {(!isBinary || isPasswordWriteAttribute(attrName)) && (
                              <IconButton label={`Edit ${attrName}`} icon={Pencil} revealOnRowHover onClick={() => onStartEdit(attrName)} />
                            )}
                            {/* A password is replaced (Edit), never added as a second valid one (ED-09). */}
                            {!isPasswordWriteAttribute(attrName) && (
                              <IconButton
                                label={fromFile ? (replacesFromFile ? 'Replace value from file' : 'Add value from file') : `Add a value to ${attrName}`}
                                icon={fromFile ? Upload : Plus}
                                revealOnRowHover
                                onClick={() => onStartAdd(attrName)}
                              />
                            )}
                            {!isMust && (
                              <IconButton label={`Delete ${attrName}`} icon={Trash2} revealOnRowHover className="enabled:hover:text-destructive" onClick={() => onDeleteAttr(attrName)} />
                            )}
                          </>
                        ) : (
                          <IconButton
                            label={fromFile ? `Set ${attrName} from file` : `Set ${attrName}`}
                            icon={fromFile ? Upload : Plus}
                            revealOnRowHover={!isMust}
                            onClick={() => onStartAdd(attrName)}
                          />
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

/**
 * A userPassword value: masked with its storage scheme badge; a value staged
 * in this dialog is marked "new" (the password storage policy decides how it
 * is stored on save).
 */
function PasswordValueDisplay({ value, binary, staged }: { value: string; binary: boolean; staged: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex items-center gap-1 flex-1 min-w-0">
      {staged && !isHashedPasswordValue(value) ? (
        <Badge tone="primary" className="shrink-0" title="Set on save; stored according to the connection's password storage policy">new</Badge>
      ) : (
        <PasswordSchemeBadge value={value} binary={binary} />
      )}
      <span className="truncate">
        {show && !binary ? value : PASSWORD_MASK}
      </span>
      {!binary && (
        <IconButton size="sm" label={show ? 'Hide value' : 'Show value'} icon={show ? EyeOff : Eye} pressed={show} onClick={() => setShow(!show)} />
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
        <span className="truncate">
          {show ? value : PASSWORD_MASK}
        </span>
        <IconButton size="sm" label={show ? 'Hide value' : 'Show value'} icon={show ? EyeOff : Eye} pressed={show} onClick={() => setShow(!show)} />
      </div>
    );
  }

  if (isDnRef) {
    return (
      <div className="flex items-center gap-1 flex-1 min-w-0">
        <Link2 size={12} strokeWidth={1.75} aria-hidden className="text-primary shrink-0" />
        <Dn dn={value} className="text-primary wrap-anywhere min-w-0" />
      </div>
    );
  }

  return <span className="wrap-anywhere flex-1 min-w-0">{value}</span>;
}
