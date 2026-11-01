/**
 * Attribute table of the entry editor (SPEC 10.2, UX-11/12): DataTable with
 * a sticky header, virtualized measured rows, sections (Identity, Account,
 * Contact, Membership, System collapsed), interpreted values first with the
 * raw value in a muted Raw column (only when some row has one), neutral mono
 * attribute names, DN links, schema details in a Tooltip, inline edit
 * (double-click, Enter, F2; row actions visible on hover and on focus),
 * binary previews (BinaryValueView) and masked userPassword values with their
 * storage scheme badge (issue #1).
 *
 * UX round (ED-08, ED-12, ED-13, ED-19, ED-21):
 * - The inline editor opens with its text selected, checks SINGLE-VALUE
 *   before sending, stays open with the input when the server refuses the
 *   change, and asks before an emptied editor removes the attribute.
 * - Server-maintained attributes (schema NO-USER-MODIFICATION plus AD's
 *   systemOnly ones: objectGUID, uSN*, when*, …) offer no Edit / Delete.
 * - Row context menu (right-click, Shift+F10, Menu key): copy name / values /
 *   "attr: value", Edit, Add Value, Delete, binary file actions, Show in
 *   Schema, Search for This Value. Ctrl+A selects the rows, Ctrl+C copies
 *   (with a toast).
 * - Add attribute: the entry's MUST/MAY first (exact > prefix > substring),
 *   the rest behind "Show all attributes"; "Add Another" keeps the row open;
 *   a password attribute that has a value is replaced, never added twice.
 * - Read-only (or disconnected) connections answer edit gestures with one
 *   "The connection is read-only" hint per burst.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import {
  Binary, Calendar, Check, Copy, Download, ExternalLink, Eye, EyeOff, FileUp, Hash, Image, Link2, Pencil, Plus, Search, ShieldCheck, Trash2,
  Upload, X, BookOpen, ClipboardList,
} from 'lucide-react'
import { LDAPAttribute, SchemaAttribute, ScopeBase } from '../../types/ldap'
import * as wails from '../../lib/wails'
import { cn } from '../../lib/utils'
import { DN_REFERENCE_ATTRS, PASSWORD_ATTRS, UAC_FLAGS } from '../../lib/ad-constants'
import { attrBaseName, binaryKind, binaryTransferName, isBinaryAttributeName } from '../../lib/binary'
import { findAttributeKey, isSensitiveAttributeName } from '../../lib/entryChanges'
import { firstRDN } from '../../lib/dn'
import { Dn } from '../ui/Dn'
import {
  ATTRIBUTE_GROUPS, attributeGroup, attributeLines, attributeSuggestions, inlineEditCaret, isServerManagedAttribute, primaryGroupSid, showRawColumn, singleValueProblem,
  valueLink, wellKnownGroupName,
} from '../../lib/attributeGroups'
import { BinaryValueView } from './BinaryValueView'
import { MaskedPasswordValues } from '../password/PasswordSchemeBadge'
import { PasswordPolicyHint } from '../password/PasswordPolicyHint'
import { NewPasswordInput, newPasswordReady } from '../password/NewPasswordInput'
import { PASSWORD_MASK, isPasswordWriteAttribute, isUserPasswordAttribute } from '../../lib/passwordPolicy'
import { useBinaryActions } from './useBinaryActions'
import { chooseBinaryValue } from './BinaryValuePicker'
import { binaryChoices, nameColumnWidth } from './certificateCard'
import { useScopedUnsavedEdits } from '../../stores/unsavedEdits'
import { useTabView } from '../../stores/tabViewState'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { toast } from '../ui/Toast'
import { Badge } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { Input, SearchInput, Textarea } from '../ui/Input'
import { Combobox } from '../ui/Listbox'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Tooltip } from '../ui/Tooltip'
import { ContextMenu, MenuHeader, MenuItem, MenuSeparator, SubMenu } from '../ui/Menu'
import { DataTable, type DataTableColumn, type DataTableGroup } from '../ui/DataTable'
import { OBJECT_KIND_TONE, resolveObjectKind } from '../ui/objectKind'
import { fileTimeToDate, formatDateTime, formatRelative, generalizedTimeToDate } from '../ui/accountStatus'

interface AttributeTableProps {
  attributes: LDAPAttribute[];
  /** Saves the values of an attribute; resolve false when it failed (the inline editor keeps the input). */
  onModify?: (attrName: string, values: string[]) => Promise<boolean> | void;
  /** Adds values (a password attribute with a value is replaced by the caller); resolve false when it failed. */
  onAdd?: (attrName: string, values: string[]) => Promise<boolean> | void;
  /** The user asked to delete the attribute (the caller confirms; `cleared`: the inline editor was emptied). Resolve true once deleted. */
  onDelete?: (attrName: string, opts?: { cleared?: boolean }) => Promise<boolean> | void;
  onNavigateDN?: (dn: string) => void;
  readOnly?: boolean;
  /** Why the table is read-only (the hint edit gestures get; default "The connection is read-only"). */
  readOnlyReason?: string;
  schemaAttributes?: SchemaAttribute[];
  /** MUST/MAY attributes of the entry's classes: offered first when adding an attribute. */
  allowedAttributes?: string[];
  /** Profile and DN of the entry; required for binary uploads/removals (writes go through ModifyEntry). */
  profileId?: string;
  dn?: string;
  /** Called after a binary value was uploaded, replaced or removed. */
  onBinaryChanged?: () => void;
  /** Row menu "Show in Schema". */
  onShowInSchema?: (attrName: string) => void;
  /** Row menu "Search for This Value". */
  onSearchValue?: (attrName: string, value: string) => void;
  /** Ctrl+F focuses the filter (true while the editor holds focus). */
  filterShortcutActive?: boolean;
  /**
   * Editor tab id: the filter and typed inline input (edit and add row) are
   * kept per tab and come back after a tab or sub-tab switch; the tab keeps
   * its unsaved mark meanwhile (RW2-E-02).
   */
  viewKey?: string;
}

// Attribute type detection
const TIME_ATTRS = new Set(['createtimestamp', 'modifytimestamp', 'pwdchangedtime', 'whenchanged', 'whencreated', 'accountexpires', 'lastlogon', 'lastlogontimestamp', 'pwdlastset', 'badpasswordtime', 'lockouttime', 'lastlogoff', 'pwdaccountlockedtime', 'pwdfailuretime', 'passwordexpirationtime']);
const IMAGE_ATTRS = new Set(['jpegphoto', 'thumbnailphoto', 'photo']);
const FLAGS_ATTRS: Record<string, Record<number, string>> = {
  useraccountcontrol: Object.fromEntries(UAC_FLAGS.map((f) => [f.bit, f.name])),
  grouptype: {
    0x00000001: 'BUILTIN_LOCAL',
    0x00000002: 'ACCOUNT_GROUP',
    0x00000004: 'RESOURCE_GROUP',
    0x00000008: 'UNIVERSAL_GROUP',
    0x80000000: 'SECURITY_ENABLED',
  },
  systemflags: {
    0x00000001: 'ATTR_NOT_REPLICATED',
    0x00000002: 'ATTR_REQ_PARTIAL_SET_MEMBER',
    0x00000004: 'ATTR_IS_CONSTRUCTED',
    0x00000010: 'CATEGORY_1_OBJECT',
    0x00000020: 'CONFIG_ALLOW_RENAME',
    0x00000040: 'CONFIG_ALLOW_MOVE',
    0x00000080: 'CONFIG_ALLOW_LIMITED_MOVE',
    0x02000000: 'DOMAIN_DISALLOW_RENAME',
    0x04000000: 'DOMAIN_DISALLOW_MOVE',
    0x10000000: 'DISALLOW_DELETE',
  },
};

const ENUM_ATTRS: Record<string, Record<number, string>> = {
  samaccounttype: {
    0x00000000: 'DOMAIN_OBJECT',
    0x10000000: 'GROUP_OBJECT',
    0x10000001: 'NON_SECURITY_GROUP_OBJECT',
    0x20000000: 'ALIAS_OBJECT',
    0x20000001: 'NON_SECURITY_ALIAS_OBJECT',
    0x30000000: 'USER_OBJECT',
    0x30000001: 'MACHINE_ACCOUNT',
    0x30000002: 'TRUST_ACCOUNT',
    0x40000000: 'APP_BASIC_GROUP',
    0x40000001: 'APP_QUERY_GROUP',
  },
};

/** Binary values listed per attribute before "+N more". */
const MAX_BINARY_VALUES_SHOWN = 50;

type AttrType = 'password' | 'time' | 'image' | 'certificate' | 'flags' | 'enum' | 'dn-reference' | 'binary' | 'text';

function getAttrType(name: string, binary = false): AttrType {
  const lower = name.toLowerCase();
  if (PASSWORD_ATTRS.has(lower) || isSensitiveAttributeName(name)) return 'password';
  if (TIME_ATTRS.has(lower)) return 'time';
  if (IMAGE_ATTRS.has(lower)) return 'image';
  if (binaryKind(name) === 'certificate') return 'certificate';
  if (binary) return 'binary';
  if (FLAGS_ATTRS[lower]) return 'flags';
  if (ENUM_ATTRS[lower]) return 'enum';
  if (DN_REFERENCE_ATTRS.has(lower)) return 'dn-reference';
  return 'text';
}

/** Width of an element (ResizeObserver); 0 until measured. */
function useElementWidth(ref: { readonly current: HTMLElement | null }): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Raw values only where the Value column shows an interpretation. */
function rawText(attr: LDAPAttribute): string {
  const t = getAttrType(attr.name, attr.binary);
  return t === 'time' || t === 'flags' || t === 'enum' ? attr.values.join(', ') : '';
}

const EMPTY_SET = new Set<string>();

/** Filter mode of the attribute filter, remembered for the session (ED-19). */
let sessionFilterMode: 'name' | 'all' = 'all';
/** Time of the last edit-gesture hint: one hint per burst (ED-21). */
let lastGestureHint = 0;
/** The "Show all attributes" option of the add-attribute combobox. */
const MORE = '\u0000more';

function gestureHint(text: string) {
  const now = Date.now();
  const quiet = now - lastGestureHint > 2500;
  lastGestureHint = now;
  if (quiet) toast.info(text);
}

function copyToClipboard(text: string, done: string) {
  navigator.clipboard.writeText(text).then(() => toast.success(done), () => toast.error('Could not copy to the clipboard'));
}

function shortValue(v: string, max = 40): string {
  const one = v.replace(/\s+/g, ' ');
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function AttributeTable({
  attributes,
  onModify,
  onAdd,
  onDelete,
  onNavigateDN,
  readOnly = false,
  readOnlyReason,
  schemaAttributes,
  allowedAttributes,
  profileId,
  dn,
  onBinaryChanged,
  onShowInSchema,
  onSearchValue,
  filterShortcutActive = false,
  viewKey,
}: AttributeTableProps) {
  // Kept per editor tab (stores/tabViewState): a tab or sub-tab switch remounts the table.
  const [editingAttr, setEditingAttr] = useTabView<string | null>(viewKey, 'attr.editing', null);
  const rootRef = useRef<HTMLDivElement>(null);
  const valueInputRef = useRef<HTMLInputElement>(null);
  /** The add row's value column (text input or the password pair). */
  const addValueRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const [editValue, setEditValue] = useTabView(viewKey, 'attr.editValue', '');
  /** The editor's starting text: unchanged input is no unsaved edit. */
  const [editOriginal, setEditOriginal] = useTabView(viewKey, 'attr.editOriginal', '');
  // Password edits are typed twice (a typo would replace the stored password with an unknown one)
  const [editConfirm, setEditConfirm] = useTabView(viewKey, 'attr.editConfirm', '');
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useTabView(viewKey, 'attr.filter', '');
  const [filterMode, setFilterModeState] = useState<'name' | 'all'>(sessionFilterMode);
  const setFilterMode = (m: 'name' | 'all') => {
    sessionFilterMode = m;
    setFilterModeState(m);
  };
  const [showAddRow, setShowAddRow] = useTabView(viewKey, 'attr.addRow', false);
  /** Remounts the name combobox (focus, reopened list). */
  const [addRowKey, setAddRowKey] = useState(0);
  const [showAllAttrs, setShowAllAttrs] = useState(false);
  const [newAttrName, setNewAttrName] = useTabView(viewKey, 'attr.addName', '');
  /** The schema name a typed unknown name probably meant ("otherTel" → otherTelephone). */
  const [addNameHint, setAddNameHint] = useState<string | null>(null);
  /** A typed name the loaded schema does not know: refused before sending (RW1-E-11). */
  const [addNameError, setAddNameError] = useState<string | null>(null);
  const [newAttrValue, setNewAttrValue] = useTabView(viewKey, 'attr.addValue', '');
  const [newAttrConfirm, setNewAttrConfirm] = useTabView(viewKey, 'attr.addConfirm', '');
  const [adding, setAdding] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<{ attr: LDAPAttribute; index: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [rowMenu, setRowMenu] = useState<{ point: { clientX: number; clientY: number }; rows: LDAPAttribute[] } | null>(null);
  // Typed input that is not saved yet: the tab's unsaved-changes dot, the
  // close guard, and an AI write warns instead of refreshing (ED-02/03).
  useScopedUnsavedEdits(
    viewKey,
    profileId,
    dn,
    (editingAttr !== null && editValue !== editOriginal) || (showAddRow && newAttrValue !== ''),
  );
  const binaryActions = useBinaryActions(profileId, dn, onBinaryChanged);
  // objectSid of the entry: the primary group's SID is its domain part + primaryGroupID (ED-19).
  const objectSid = attributes.find((a) => a.name.toLowerCase() === 'objectsid' && !a.binary)?.values[0];
  // Binary values can only be written with the entry's profile and DN.
  const canWriteBinary = !readOnly && !!profileId && !!dn;
  const readOnlyText = readOnlyReason ?? 'The connection is read-only';

  // Build schema lookup map
  const schemaMap = useMemo(() => {
    if (!schemaAttributes) return null;
    const map = new Map<string, SchemaAttribute>();
    for (const sa of schemaAttributes) {
      map.set(sa.name.toLowerCase(), sa);
      for (const alias of sa.aliases ?? []) if (!map.has(alias.toLowerCase())) map.set(alias.toLowerCase(), sa);
      if (sa.oid && !map.has(sa.oid)) map.set(sa.oid, sa);
    }
    return map;
  }, [schemaAttributes]);
  const schemaOf = useCallback((name: string) => schemaMap?.get(attrBaseName(name)), [schemaMap]);

  const rows = useMemo(() => attributes.filter(attr => {
    if (!filter) return true;
    const f = filter.toLowerCase();
    if (filterMode === 'name') return attr.name.toLowerCase().includes(f);
    // Binary values are base64; matching them as text is meaningless.
    return attr.name.toLowerCase().includes(f) || (!attr.binary && attr.values.some(v => v.toLowerCase().includes(f)));
  }), [attributes, filter, filterMode]);

  /** The server maintains it (schema NO-USER-MODIFICATION, AD systemOnly): no Edit / Delete. */
  const managed = (attr: LDAPAttribute) => isServerManagedAttribute(attr.name, schemaOf(attr.name));
  /** A row can be edited as text (binary values are base64; a password is typed new). */
  const canEdit = (attr: LDAPAttribute) => !readOnly && (!attr.binary || isUserPasswordAttribute(attr.name)) && !managed(attr);
  const canDelete = (attr: LDAPAttribute) => !readOnly && !managed(attr);
  /** "Add Value": multi-valued (or empty) text attributes; passwords are replaced via Edit. */
  const canAddValue = (attr: LDAPAttribute) =>
    !readOnly && !managed(attr) && !attr.binary && !isPasswordWriteAttribute(attr.name) && !(schemaOf(attr.name)?.singleValue && attr.values.length > 0);

  /** Why an edit gesture (double-click, Enter, F2, Del) does nothing on this row. */
  function explainNoEdit(attr: LDAPAttribute, verb: 'edited' | 'deleted') {
    if (readOnly) gestureHint(readOnlyText);
    else if (managed(attr)) gestureHint(`${attr.name} is maintained by the server and cannot be ${verb}`);
    else if (attr.binary) gestureHint(`${attr.name} holds binary data: use the file actions of its row (right-click)`);
  }

  function startEdit(attr: LDAPAttribute) {
    if (!canEdit(attr)) {
      explainNoEdit(attr, 'edited');
      return;
    }
    // Passwords are typed new (the stored values are hashes); the value
    // replaces all values and follows the password storage policy.
    const initial = isPasswordWriteAttribute(attr.name) ? '' : attr.values.join('\n');
    setEditingAttr(attr.name);
    setEditValue(initial);
    setEditOriginal(initial);
    setEditConfirm('');
    setEditError(null);
  }

  /** Current inline input (read by the editor's mount callback). */
  const draftRef = useRef({ value: editValue, original: editOriginal });
  draftRef.current = { value: editValue, original: editOriginal };

  /**
   * The inline editor opens with its text selected: typing replaces the old
   * value (ED-08, WF-16). Typed input that came back after a tab switch keeps
   * the caret at its end. Decided from the input itself, not a one-shot flag:
   * StrictMode calls ref callbacks twice and selected a restored draft
   * (RW3-E-03).
   */
  const selectOnMount = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    requestAnimationFrame(() => {
      el.focus({ preventScroll: true });
      const { value, original } = draftRef.current;
      if (inlineEditCaret(value, original) === 'end') el.setSelectionRange(el.value.length, el.value.length);
      else el.select();
    });
  }, []);

  /**
   * Ends inline editing. The focused editor unmounts with it, so focus that
   * was in the table goes back to the attribute's row (the grid keeps its
   * place; F2 / Enter edit again) instead of falling to <body>.
   */
  function finishEdit(attrName: string | null) {
    const hadFocus = !!rootRef.current?.contains(document.activeElement);
    setEditingAttr(null);
    setEditError(null);
    setEditConfirm('');
    if (!hadFocus || !attrName) return;
    requestAnimationFrame(() => {
      const root = rootRef.current;
      const a = document.activeElement;
      if (!root || (a && a !== document.body)) return;
      const row =
        root.querySelector<HTMLElement>(`tr[data-key="${CSS.escape(attrName)}"]`) ??
        root.querySelector<HTMLElement>('[role="grid"] tr[role="row"][tabindex="0"]');
      row?.focus({ preventScroll: true });
    });
  }

  async function saveEdit(attrName: string) {
    if (saving) return;
    const current = attributes.find((a) => a.name === attrName)?.values ?? [];
    if (isPasswordWriteAttribute(attrName)) {
      if (!editValue) {
        finishEdit(attrName);
        return;
      }
      if (!newPasswordReady(editValue, editConfirm)) return; // confirmation missing or different
      setSaving(true);
      const ok = await onModify?.(attrName, [editValue]);
      setSaving(false);
      if (ok === false) return; // refused or cancelled: the input stays
      setEditValue('');
      finishEdit(attrName);
      return;
    }
    const values = editValue.split('\n').filter(v => v.trim());
    if (values.length === 0) {
      if (!current.length) {
        finishEdit(attrName);
        return;
      }
      // Emptying the editor removes the attribute: ask like the trash button does.
      setSaving(true);
      const removed = await onDelete?.(attrName, { cleared: true });
      setSaving(false);
      if (removed) finishEdit(attrName);
      return;
    }
    const problem = singleValueProblem(attrName, values, schemaOf(attrName));
    if (problem) {
      setEditError(problem);
      return;
    }
    if (values.length === current.length && values.every((v, i) => v === current[i])) {
      finishEdit(attrName);
      return;
    }
    setSaving(true);
    const ok = await onModify?.(attrName, values);
    setSaving(false);
    if (ok === false) {
      setEditError('Not saved: the server refused the change (see the notification). Your input is kept.');
      return;
    }
    finishEdit(attrName);
  }

  function cancelEdit() {
    finishEdit(editingAttr);
  }

  function closeAddRow() {
    setAddNameHint(null);
    setShowAddRow(false);
    setShowAllAttrs(false);
    setNewAttrName('');
    setNewAttrValue('');
    setNewAttrConfirm('');
  }

  /** Escape / × in the add row: the row goes, focus returns to "Add attribute" (RW2-E-04 d), not <body>. */
  function cancelAddRow() {
    closeAddRow();
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (a && a !== document.body && a.isConnected) return;
      addButtonRef.current?.focus({ preventScroll: true });
    });
  }

  /** The value field of the add row (after the name was chosen). */
  function focusAddValue() {
    requestAnimationFrame(() => addValueRef.current?.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled])')?.focus());
  }

  function openAddRow(name = '') {
    if (readOnly) {
      gestureHint(readOnlyText);
      return;
    }
    setShowAddRow(true);
    setNewAttrName(name);
    setNewAttrValue('');
    setNewAttrConfirm('');
    setAddRowKey((k) => k + 1);
    if (name) requestAnimationFrame(() => valueInputRef.current?.focus());
  }

  const typedName = newAttrName.trim();
  const addIsPassword = isPasswordWriteAttribute(typedName);
  const existingTyped = typedName ? attributes.find((a) => attrBaseName(a.name) === attrBaseName(typedName)) : undefined;
  /** A password attribute that has a value: the add row replaces it (two userPasswords would both be valid, ED-09). */
  const addReplacesPassword = addIsPassword && !!existingTyped?.values.length;

  async function handleAddAttribute(another = false) {
    const typed = newAttrName.trim();
    if (!typed || adding) return;
    // A prefix of a schema name ("otherTel") is no attribute: say so instead of sending it (RW1-E-11).
    const meant = unknownNameSuggestion(typed);
    if (meant) {
      setAddNameHint(meant);
      return;
    }
    // Any other name the server's schema does not have would only fail on the server.
    if (schemaMap && schemaMap.size > 0 && !schemaOf(typed)) {
      setAddNameError(`"${typed}" is not an attribute of this server's schema`);
      return;
    }
    if (isBinaryAttributeName(typed, schemaOf(typed)?.syntax)) {
      // Text would be stored as is; binary values come from a file.
      toast.info(`"${typed}" holds binary data — use the upload button to add a value from a file`);
      return;
    }
    if (!newAttrValue.trim()) return;
    const password = isPasswordWriteAttribute(typed);
    if (password && !newPasswordReady(newAttrValue, newAttrConfirm)) return; // confirmation missing or different
    if (!password && existingTyped?.values.length && schemaOf(typed)?.singleValue) {
      toast.info(`${typed} is single-valued and already set: edit its value instead`);
      return;
    }
    setAdding(true);
    // Passwords are taken as typed (leading/trailing blanks included).
    const ok = await onAdd?.(typed, [password ? newAttrValue : newAttrValue.trim()]);
    setAdding(false);
    if (ok === false) return; // refused: keep the input
    if (another) {
      // Keep the row: next value of the same attribute, or type another name.
      setNewAttrValue('');
      setNewAttrConfirm('');
      requestAnimationFrame(() => valueInputRef.current?.focus());
    } else {
      closeAddRow();
    }
  }

  /** Add-row "from file": upload into the typed attribute (new value, or replace if single-valued). */
  async function handleAddFromFile() {
    const typed = newAttrName.trim();
    if (!typed) return;
    const schemaAttr = schemaOf(typed);
    const existingKey = findAttributeKey(attributes.map(a => a.name), typed);
    const existing = attributes.find(a => a.name === existingKey);
    // Existing spelling, else the name the server expects (";binary" for certificate syntaxes on OpenLDAP)
    const name = existing?.name ?? binaryTransferName(typed, schemaAttr?.syntax);
    const current = existing?.binary ? existing.values : [];
    const done = await binaryActions.upload(name, current, schemaAttr?.singleValue && current.length > 0 ? { type: 'replace', index: 0 } : { type: 'add' });
    if (!done) return; // keep the row so the user can retry or pick another file
    closeAddRow();
  }

  function isSingleValued(attrName: string): boolean {
    return !!schemaOf(attrName)?.singleValue;
  }

  /** Ctrl+C on a row (or the selected rows): their values, "attr: value" lines for several rows. */
  function onKeyDownCapture(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'c') return;
    const target = e.target as HTMLElement;
    if (target.getAttribute('role') !== 'row' || !target.dataset.key) return;
    if (window.getSelection()?.toString()) return;
    const key = target.dataset.key;
    const keys = selected.has(key) && selected.size > 1 ? [...selected] : [key];
    const list = keys.map((k) => attributes.find((a) => a.name === k)).filter((a): a is LDAPAttribute => !!a);
    if (!list.length) return;
    e.preventDefault();
    e.stopPropagation();
    if (list.length === 1) {
      const a = list[0];
      copyToClipboard(a.values.join('\n'), a.values.length > 1 ? `${a.values.length} values copied` : 'Value copied');
    } else {
      copyToClipboard(list.map((a) => attributeLines(a.name, a.values, a.binary)).join('\n'), `${list.length} attributes copied`);
    }
  }

  const groups = useMemo<DataTableGroup[]>(() => ATTRIBUTE_GROUPS.map((g) => ({ id: g.id, label: g.label, defaultCollapsed: g.defaultCollapsed })), []);
  // The Raw column only when some value has an interpretation to compare with (ED-19), and
  // only where it leaves the Value column room: below RAW_MIN_TABLE_PX the raw text moves into
  // the value's tooltip (RW1-E-13: at 1100 px the Value column was 230 px, certificate cards
  // and photo metadata wrapped every few characters).
  const tableWidth = useElementWidth(rootRef);
  const anyRaw = useMemo(() => attributes.some((a) => rawText(a) !== ''), [attributes]);
  const hasRaw = anyRaw && showRawColumn(tableWidth);

  const columns: DataTableColumn<LDAPAttribute>[] = [
    {
      id: 'name',
      header: 'Attribute',
      // Narrow tables give the values the room (certificate cards, photos; RW1-E-13); a resize by the user wins.
      width: nameColumnWidth(tableWidth),
      minWidth: 120,
      sortable: true,
      hideable: false,
      value: (a) => a.name,
      cell: (a) => <NameCell attr={a} schema={schemaOf(a.name)} highlight={filter} managed={managed(a)} />,
    },
    {
      id: 'value',
      header: 'Value',
      sortable: true,
      hideable: false,
      value: (a) => (a.binary ? '' : a.values[0] ?? ''),
      cell: (attr) => {
        if (editingAttr === attr.name && isPasswordWriteAttribute(attr.name)) {
          return (
            <div className="py-1 space-y-1 whitespace-normal">
              <NewPasswordInput
                value={editValue}
                onChange={setEditValue}
                confirm={editConfirm}
                onConfirmChange={setEditConfirm}
                placeholder="New password (replaces all values)"
                autoFocus
                onSubmit={() => void saveEdit(attr.name)}
                onCancel={cancelEdit}
              />
              {isUserPasswordAttribute(attr.name) && <PasswordPolicyHint profileId={profileId} />}
            </div>
          );
        }
        if (editingAttr === attr.name) {
          const single = isSingleValued(attr.name);
          return (
            <div className="py-1 whitespace-normal">
              <Textarea
                ref={selectOnMount}
                mono
                aria-label={`Values of ${attr.name}, one per line`}
                aria-describedby={editError ? 'attr-edit-error' : undefined}
                invalid={!!editError}
                value={editValue}
                onChange={(e) => {
                  setEditValue(e.target.value);
                  setEditError(null);
                }}
                rows={Math.min(12, Math.max(1, editValue.split('\n').length))}
                autoFocus
                className="min-h-[26px] py-0.5"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    cancelEdit();
                  }
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void saveEdit(attr.name);
                  }
                }}
              />
              <span className="text-xs text-muted-foreground">
                {single ? 'Single-valued' : 'One value per line'} · Ctrl+Enter saves · Escape cancels
              </span>
              {editError && (
                <span id="attr-edit-error" role="alert" className="block text-xs text-destructive">
                  {editError}
                </span>
              )}
            </div>
          );
        }
        if (attr.binary && !isUserPasswordAttribute(attr.name)) {
          return (
            <div className="py-1 space-y-1 whitespace-normal">
              {attr.values.slice(0, MAX_BINARY_VALUES_SHOWN).map((v, i) => (
                <BinaryValueView
                  key={i}
                  attrName={attr.name}
                  value={v}
                  actions={{
                    onDownload: () => binaryActions.download(attr.name, v),
                    onReplace: canWriteBinary && !managed(attr) && !binaryActions.busy
                      ? () => binaryActions.upload(attr.name, attr.values, { type: 'replace', index: i })
                      : undefined,
                    onRemove: canWriteBinary && !managed(attr) && !binaryActions.busy
                      ? () => setPendingRemove({ attr, index: i })
                      : undefined,
                  }}
                />
              ))}
              {attr.values.length > MAX_BINARY_VALUES_SHOWN && (
                <span className="text-xs text-muted-foreground">+{attr.values.length - MAX_BINARY_VALUES_SHOWN} more</span>
              )}
            </div>
          );
        }
        return (
          // Row height follows the density token (24 / 28 incl. the 1px border, SPEC 11.5).
          <div className="py-[calc((var(--table-row-h)-17px)/2)] whitespace-normal min-w-0" title={!hasRaw && anyRaw ? rawText(attr) || undefined : undefined}>
            <AttrValueRenderer attr={attr} onNavigateDN={onNavigateDN} highlight={filter} profileId={profileId} objectSid={objectSid} />
          </div>
        );
      },
    },
    ...(hasRaw
      ? [{
          id: 'raw',
          header: 'Raw',
          width: 170,
          minWidth: 80,
          value: rawText,
          cell: (a: LDAPAttribute) => {
            const raw = rawText(a);
            return raw ? <div className="py-[calc((var(--table-row-h)-17px)/2)] whitespace-normal wrap-anywhere font-mono text-xs text-muted-foreground">{raw}</div> : null;
          },
        } satisfies DataTableColumn<LDAPAttribute>]
      : []),
  ];
  if (!readOnly) {
    columns.push({
      id: 'actions',
      header: 'Actions',
      width: 96,
      minWidth: 96,
      hideable: false,
      cell: (attr) => editingAttr === attr.name ? (
        <div className="flex items-center gap-0.5">
          <IconButton
            size="sm"
            label={isPasswordWriteAttribute(attr.name) ? 'Set the password (type it twice)' : 'Save (Ctrl+Enter)'}
            icon={Check}
            disabled={saving || (isPasswordWriteAttribute(attr.name) && editValue.length > 0 && !newPasswordReady(editValue, editConfirm))}
            onClick={() => void saveEdit(attr.name)}
          />
          <IconButton size="sm" label="Cancel (Escape)" icon={X} onClick={cancelEdit} />
        </div>
      ) : (
        <div className="flex items-center gap-0.5">
          {canEdit(attr) && <IconButton size="sm" label={`Edit ${attr.name}`} icon={Pencil} shortcut="F2" revealOnRowHover onClick={() => startEdit(attr)} />}
          {attr.binary && canWriteBinary && !managed(attr) && !isUserPasswordAttribute(attr.name) && (
            <IconButton
              size="sm"
              label={isSingleValued(attr.name) && attr.values.length > 0 ? 'Replace value from file' : 'Add value from file'}
              icon={Upload}
              revealOnRowHover
              disabled={binaryActions.busy}
              onClick={() => binaryActions.upload(
                attr.name,
                attr.values,
                isSingleValued(attr.name) && attr.values.length > 0 ? { type: 'replace', index: 0 } : { type: 'add' },
              )}
            />
          )}
          <CopyValueButton text={attr.values.join('\n')} label={attr.binary ? 'Copy value (base64)' : 'Copy value'} count={attr.values.length} />
          {canDelete(attr) && (
            <IconButton size="sm" label={`Delete ${attr.name}`} icon={Trash2} shortcut="Delete" revealOnRowHover className="enabled:hover:text-destructive" onClick={() => void onDelete?.(attr.name)} />
          )}
        </div>
      ),
    });
  } else {
    columns.push({
      id: 'actions',
      header: 'Actions',
      width: 40,
      minWidth: 40,
      hideable: false,
      cell: (attr) => (
        <div className="flex items-center">
          <CopyValueButton text={attr.values.join('\n')} label={attr.binary ? 'Copy value (base64)' : 'Copy value'} count={attr.values.length} />
        </div>
      ),
    });
  }

  // Add attribute: the entry's MUST/MAY first, the rest behind "Show all attributes" (ED-13).
  const allNames = useMemo(() => (schemaAttributes ?? []).map((a) => a.name), [schemaAttributes]);
  const restricted = !!allowedAttributes?.length;
  const suggestions = useMemo(
    () => attributeSuggestions(newAttrName, restricted ? allowedAttributes! : allNames, allNames, showAllAttrs || !restricted),
    [newAttrName, restricted, allowedAttributes, allNames, showAllAttrs],
  );
  const comboItems = suggestions.more > 0 ? [...suggestions.items, MORE] : suggestions.items;
  /** A typed name the schema does not know but one of its names starts with: that name, else null (aliases pass). */
  function unknownNameSuggestion(typed: string): string | null {
    if (!allNames.length) return null;
    const t = attrBaseName(typed);
    if (allNames.some((n) => n.toLowerCase() === t)) return null;
    return attributeSuggestions(typed, allNames, allNames, true).items.find((n) => n.toLowerCase().startsWith(t)) ?? null;
  }

  const menuRows = rowMenu?.rows ?? [];

  return (
    <div ref={rootRef} className="h-full flex flex-col min-h-0" onKeyDownCapture={onKeyDownCapture}>
      {/* Filter strip */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card shrink-0">
        <SearchInput
          size="sm"
          value={filter}
          onValueChange={setFilter}
          placeholder="Filter attributes"
          aria-label="Filter attributes"
          shortcut="Mod+F"
          focusKey="Mod+F"
          focusKeyActive={filterShortcutActive}
          wrapperClassName="flex-1 min-w-[120px]"
        />
        <SegmentedControl
          aria-label="Filter matches"
          value={filterMode}
          onValueChange={setFilterMode}
          options={[
            { value: 'all', label: 'Name + value' },
            { value: 'name', label: 'Name' },
          ]}
        />
        <span className="text-xs text-muted-foreground tabular-nums shrink-0" aria-live="polite">
          {filter ? `${rows.length} of ${attributes.length}` : attributes.length} attribute{(filter ? rows.length : attributes.length) !== 1 ? 's' : ''}
        </span>
        {!readOnly && (
          <Button ref={addButtonRef} size="sm" variant="ghost" leftIcon={Plus} onClick={() => openAddRow()} disabled={showAddRow}>
            Add attribute
          </Button>
        )}
      </div>

      {/* Add attribute */}
      {showAddRow && !readOnly && (
        <div
          className="flex items-start gap-2 px-3 py-1.5 border-b border-border bg-secondary shrink-0"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !e.defaultPrevented) {
              e.preventDefault();
              cancelAddRow();
            }
          }}
        >
          <div
            className="w-[220px] shrink-0"
            onKeyDown={(e) => {
              // Enter on a typed name the list did not take (closed list, exact name): on to the
              // value, never appending the value to the name (RW3 cross-area note).
              if (e.key === 'Enter' && !e.defaultPrevented && newAttrName.trim()) {
                e.preventDefault();
                focusAddValue();
              }
            }}
          >
            <Combobox
              key={`${addRowKey}:${showAllAttrs ? 'all' : 'allowed'}`}
              items={comboItems}
              getKey={(n) => n}
              getLabel={(n) => (n === MORE ? newAttrName : n)}
              filter={() => true}
              renderItem={(n) =>
                n === MORE ? (
                  <span className="text-primary">Show all attributes ({suggestions.more} more match)</span>
                ) : (
                  <span className="truncate">{n}</span>
                )
              }
              inputValue={newAttrName}
              onInputChange={(v) => {
                setNewAttrName(v);
                setAddNameHint(null);
                setAddNameError(null);
              }}
              onSelect={(n) => {
                setAddNameHint(null);
                if (n === MORE) setShowAllAttrs(true);
                else {
                  setNewAttrName(n);
                  // A chosen name (Enter, click, Tab) continues in the value field.
                  focusAddValue();
                }
              }}
              acceptOnTab
              placeholder="Attribute name"
              aria-label="Attribute name"
              mono
              size="sm"
              autoFocus={!newAttrName || showAllAttrs}
              emptyText={restricted && !showAllAttrs ? 'Not allowed by the entry\'s classes' : 'Not in the schema'}
            />
            {addNameError ? (
              <span className="block text-xs text-destructive mt-0.5" role="alert">
                {addNameError}
              </span>
            ) : addNameHint ? (
              <span className="block text-xs text-destructive mt-0.5" role="alert">
                Not in the schema.{' '}
                <button type="button" className="text-primary hover:underline" onClick={() => { setNewAttrName(addNameHint); setAddNameHint(null); requestAnimationFrame(() => valueInputRef.current?.focus()); }}>
                  Use {addNameHint}
                </button>
              </span>
            ) : restricted && !showAllAttrs && (
              <span className="block text-xs text-muted-foreground mt-0.5">Attributes of the entry's object classes</span>
            )}
          </div>
          <div ref={addValueRef} className="flex-1 min-w-0 space-y-1">
            {addIsPassword ? (
              <NewPasswordInput
                value={newAttrValue}
                onChange={setNewAttrValue}
                confirm={newAttrConfirm}
                onConfirmChange={setNewAttrConfirm}
                placeholder={addReplacesPassword ? 'New password (replaces the current one)' : 'New password'}
                onSubmit={() => void handleAddAttribute()}
                onCancel={cancelAddRow}
              />
            ) : (
              <Input
                ref={valueInputRef}
                size="sm"
                aria-label="Value"
                value={newAttrValue}
                onChange={(e) => setNewAttrValue(e.target.value)}
                placeholder="Value"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleAddAttribute(e.shiftKey);
                  }
                }}
              />
            )}
            {addReplacesPassword && (
              <p className="text-xs text-warning">{typedName} already has a value: this replaces it, the current password stops working.</p>
            )}
            {isUserPasswordAttribute(typedName) && <PasswordPolicyHint profileId={profileId} />}
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <IconButton
              label={addReplacesPassword ? 'Replace the password (type it twice)' : addIsPassword ? 'Set the password (type it twice)' : 'Add text value (Enter)'}
              icon={Check}
              disabled={adding || !typedName || !newAttrValue.trim() || (addIsPassword && !newPasswordReady(newAttrValue, newAttrConfirm))}
              onClick={() => void handleAddAttribute()}
            />
            {!addIsPassword && (
              <Button
                size="sm"
                variant="ghost"
                disabled={adding || !typedName || !newAttrValue.trim()}
                onClick={() => void handleAddAttribute(true)}
                title="Add this value and keep the row open (Shift+Enter)"
              >
                Add Another
              </Button>
            )}
            {canWriteBinary && (
              <IconButton
                label="Upload value from file (photos, certificates, binary data)"
                icon={Upload}
                disabled={!typedName || binaryActions.busy}
                onClick={handleAddFromFile}
              />
            )}
            <IconButton label="Cancel" icon={X} onClick={cancelAddRow} />
          </div>
        </div>
      )}

      <DataTable
        aria-label="Attributes"
        className="flex-1 min-h-0"
        columns={columns}
        rows={rows}
        rowKey={(a) => a.name}
        groupBy={(a) => attributeGroup(a.name, schemaOf(a.name))}
        groups={groups}
        collapsedGroups={filter ? EMPTY_SET : undefined}
        virtualized
        measureRows
        stickyHeader
        columnChooser
        persistKey="attributes"
        defaultSort={{ id: 'name', dir: 'asc' }}
        selection="multi"
        selectedKeys={selected}
        onSelectionChange={setSelected}
        onOpen={(a) => startEdit(a)}
        onEdit={(a) => startEdit(a)}
        onDelete={onDelete ? (list) => {
          if (list.length > 1) {
            // One attribute per delete (each asks with its values); say so instead of doing nothing (RW2-E-06).
            gestureHint(`${list.length} attributes are selected: select one attribute to delete it`);
            return;
          }
          if (list.length !== 1) return;
          const a = list[0];
          if (!canDelete(a)) explainNoEdit(a, 'deleted');
          else void onDelete(a.name);
        } : undefined}
        onContextMenu={(point, list) => list.length && setRowMenu({ point, rows: list })}
        getRowDn={(a) => a.values.join('\n')}
        empty={
          <div className="px-3 py-4 text-sm text-muted-foreground">
            {filter ? 'No attribute matches the filter.' : 'This entry has no readable attributes.'}
          </div>
        }
      />

      <ContextMenu point={rowMenu?.point ?? null} onClose={() => setRowMenu(null)} label="Attribute actions">
        {menuRows.length > 1 ? (
          <>
            <MenuHeader>{menuRows.length} attributes</MenuHeader>
            <MenuItem
              icon={ClipboardList}
              label={`Copy ${menuRows.length} Attributes`}
              hint="attr: value"
              shortcut="Mod+C"
              onSelect={() => copyToClipboard(menuRows.map((a) => attributeLines(a.name, a.values, a.binary)).join('\n'), `${menuRows.length} attributes copied`)}
            />
            <MenuItem icon={Copy} label="Copy Names" onSelect={() => copyToClipboard(menuRows.map((a) => a.name).join('\n'), `${menuRows.length} names copied`)} />
          </>
        ) : menuRows.length === 1 ? (
          <RowMenuItems
            attr={menuRows[0]}
            schema={schemaOf(menuRows[0].name)}
            canEdit={canEdit(menuRows[0])}
            canDelete={canDelete(menuRows[0])}
            canAddValue={canAddValue(menuRows[0])}
            canWriteBinary={canWriteBinary && !managed(menuRows[0]) && !binaryActions.busy}
            onEdit={() => startEdit(menuRows[0])}
            onAddValue={() => openAddRow(menuRows[0].name)}
            onDelete={onDelete ? () => void onDelete(menuRows[0].name) : undefined}
            onSave={(i) => binaryActions.download(menuRows[0].name, menuRows[0].values[i])}
            onReplace={(i) => binaryActions.upload(menuRows[0].name, menuRows[0].values, { type: 'replace', index: i })}
            onAddFromFile={() => binaryActions.upload(menuRows[0].name, menuRows[0].values, isSingleValued(menuRows[0].name) && menuRows[0].values.length > 0 ? { type: 'replace', index: 0 } : { type: 'add' })}
            onRemove={(i) => setPendingRemove({ attr: menuRows[0], index: i })}
            onShowInSchema={onShowInSchema}
            onSearchValue={onSearchValue}
          />
        ) : null}
      </ContextMenu>

      {pendingRemove && (
        <ConfirmDialog
          title={`Remove ${pendingRemove.attr.name} value`}
          message={pendingRemove.attr.values.length > 1
            ? `Remove value ${pendingRemove.index + 1} of ${pendingRemove.attr.values.length} from "${pendingRemove.attr.name}"? The other values stay.`
            : `Remove the only value of "${pendingRemove.attr.name}"? The attribute will be deleted.`}
          detail={dn}
          confirmLabel="Remove"
          tone="danger"
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => {
            const { attr, index } = pendingRemove;
            setPendingRemove(null);
            binaryActions.removeValue(attr.name, attr.values, index);
          }}
        />
      )}
    </div>
  );
}

/** The row menu of one attribute (ED-12). */
function RowMenuItems({
  attr, schema, canEdit, canDelete, canAddValue, canWriteBinary, onEdit, onAddValue, onDelete, onSave, onReplace, onAddFromFile, onRemove,
  onShowInSchema, onSearchValue,
}: {
  attr: LDAPAttribute;
  schema?: SchemaAttribute;
  canEdit: boolean;
  canDelete: boolean;
  canAddValue: boolean;
  canWriteBinary: boolean;
  onEdit: () => void;
  onAddValue: () => void;
  onDelete?: () => void;
  onSave: (index: number) => void;
  onReplace: (index: number) => void;
  onAddFromFile: () => void;
  onRemove: (index: number) => void;
  onShowInSchema?: (name: string) => void;
  onSearchValue?: (name: string, value: string) => void;
}) {
  const n = attr.values.length;
  const secret = getAttrType(attr.name, attr.binary) === 'password';
  const fileValues = attr.binary && !isUserPasswordAttribute(attr.name);
  /**
   * One item; with several values it asks which one in the value picker
   * (pictures, certificate names, validity and expiry), never the first
   * value silently (DEF-13).
   */
  const perValue = (label: string, icon: typeof Download, run: (i: number) => void, pick: { title: string; verb: string }, tone?: 'danger') => (
    <MenuItem
      icon={icon}
      label={`${label}…`}
      hint={n > 1 ? `${n} values` : undefined}
      tone={tone}
      onSelect={() => {
        if (n === 1) {
          run(0);
          return;
        }
        void chooseBinaryValue({ title: pick.title, verb: pick.verb, danger: tone === 'danger', choices: binaryChoices([attr], [attr.name]) })
          .then((c) => { if (c) run(c.index); });
      }}
    />
  );
  const searchable = !!onSearchValue && !attr.binary && !secret && n > 0;
  return (
    <>
      <MenuHeader mono>{attr.name}</MenuHeader>
      <MenuItem icon={Copy} label="Copy Name" onSelect={() => copyToClipboard(attr.name, 'Name copied')} />
      <MenuItem
        icon={Copy}
        label={n > 1 ? `Copy ${n} Values` : attr.binary ? 'Copy Value (base64)' : 'Copy Value'}
        shortcut="Mod+C"
        disabled={n === 0}
        onSelect={() => copyToClipboard(attr.values.join('\n'), n > 1 ? `${n} values copied` : 'Value copied')}
      />
      <MenuItem icon={ClipboardList} label={'Copy as "attr: value"'} disabled={n === 0} onSelect={() => copyToClipboard(attributeLines(attr.name, attr.values, attr.binary), n > 1 ? `${n} lines copied` : 'Line copied')} />
      {(canEdit || canAddValue || canDelete) && <MenuSeparator />}
      {canEdit && <MenuItem icon={Pencil} label={isPasswordWriteAttribute(attr.name) ? 'Replace Password…' : 'Edit'} shortcut="F2" onSelect={onEdit} />}
      {canAddValue && <MenuItem icon={Plus} label="Add Value" onSelect={onAddValue} />}
      {canDelete && onDelete && <MenuItem icon={Trash2} label="Delete…" tone="danger" shortcut="Delete" onSelect={onDelete} />}
      {fileValues && n > 0 && (
        <>
          <MenuSeparator />
          {perValue('Save Value to File', Download, onSave, { title: `Save which ${attr.name} value?`, verb: 'Save…' })}
          {canWriteBinary && perValue('Replace Value from File', FileUp, onReplace, { title: `Replace which ${attr.name} value?`, verb: 'Choose File…' })}
          {canWriteBinary && (!schema?.singleValue || n === 0) && <MenuItem icon={Upload} label="Add Value from File…" onSelect={onAddFromFile} />}
          {canWriteBinary && perValue('Remove Value', X, onRemove, { title: `Remove which ${attr.name} value?`, verb: 'Remove…' }, 'danger')}
        </>
      )}
      {(schema && onShowInSchema) || searchable ? <MenuSeparator /> : null}
      {schema && onShowInSchema && <MenuItem icon={BookOpen} label="Show in Schema" onSelect={() => onShowInSchema(schema.name)} />}
      {searchable &&
        (n === 1 ? (
          <MenuItem icon={Search} label="Search for This Value" hint={shortValue(attr.values[0], 24)} onSelect={() => onSearchValue!(attr.name, attr.values[0])} />
        ) : (
          <SubMenu icon={Search} label="Search for This Value">
            {attr.values.slice(0, 15).map((v, i) => (
              <MenuItem key={i} label={shortValue(v)} onSelect={() => onSearchValue!(attr.name, v)} />
            ))}
          </SubMenu>
        ))}
    </>
  );
}

function NameCell({ attr, schema, highlight, managed }: { attr: LDAPAttribute; schema?: SchemaAttribute; highlight: string; managed: boolean }) {
  const name = (
    <span className="flex items-center gap-1 min-w-0 py-[calc((var(--table-row-h)-17px)/2)] font-mono text-muted-foreground" tabIndex={schema ? -1 : undefined}>
      <AttrIcon type={getAttrType(attr.name, attr.binary)} />
      <span className="truncate">
        <HighlightText text={attr.name} highlight={highlight} />
      </span>
    </span>
  );
  if (!schema && !managed) return name;
  return (
    <Tooltip content={schema ? <SchemaDetails schema={schema} managed={managed} /> : <span>Maintained by the server</span>} placement="bottom-start">
      {name}
    </Tooltip>
  );
}

function SchemaDetails({ schema, managed }: { schema: SchemaAttribute; managed: boolean }) {
  const operational = !!schema.usage && schema.usage.toLowerCase() !== 'userapplications';
  return (
    <span className="block space-y-0.5 max-w-[360px]">
      <span className="block font-semibold text-foreground">{schema.name}</span>
      {schema.description && <span className="block text-muted-foreground">{schema.description}</span>}
      <span className="grid grid-cols-[auto_1fr] gap-x-2">
        <span className="text-muted-foreground">OID</span>
        <span className="font-mono">{schema.oid}</span>
        <span className="text-muted-foreground">Syntax</span>
        <span>
          {schema.syntaxName || 'unknown'}
          {schema.syntax && <span className="font-mono text-muted-foreground"> {schema.syntax}</span>}
        </span>
        <span className="text-muted-foreground">Values</span>
        <span>{schema.singleValue ? 'Single-value' : 'Multi-value'}</span>
        {(managed || operational) && (
          <>
            <span className="text-muted-foreground">Access</span>
            <span className="text-warning">
              {schema.noUserMod ? 'System-only (NO-USER-MODIFICATION)' : managed ? 'System-only (maintained by the server)' : 'Operational'}
              {operational ? ` · ${schema.usage}` : ''}
            </span>
          </>
        )}
      </span>
      <span className="block text-xs text-muted-foreground pt-0.5">Show in Schema: right-click the row (Shift+F10)</span>
    </span>
  );
}

function AttrIcon({ type }: { type: AttrType }) {
  const cls = 'shrink-0';
  switch (type) {
    case 'password': return <EyeOff size={12} strokeWidth={1.75} aria-hidden className={cn(cls, 'text-warning')} />;
    case 'time': return <Calendar size={12} strokeWidth={1.75} aria-hidden className={cn(cls, 'text-info')} />;
    case 'image': return <Image size={12} strokeWidth={1.75} aria-hidden className={cn(cls, 'text-success')} />;
    case 'certificate': return <ShieldCheck size={12} strokeWidth={1.75} aria-hidden className={cn(cls, 'text-success')} />;
    case 'binary': return <Binary size={12} strokeWidth={1.75} aria-hidden className={cls} />;
    case 'flags':
    case 'enum': return <Hash size={12} strokeWidth={1.75} aria-hidden className={cls} />;
    case 'dn-reference': return <Link2 size={12} strokeWidth={1.75} aria-hidden className={cn(cls, 'text-primary')} />;
    default: return <span className="w-3 shrink-0" aria-hidden />;
  }
}

function CopyValueButton({ text, label, count = 1 }: { text: string; label: string; count?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      size="sm"
      label={copied ? 'Copied' : label}
      icon={copied ? <Check size={14} strokeWidth={1.75} aria-hidden className="text-success" /> : Copy}
      revealOnRowHover
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            toast.success(count > 1 ? `${count} values copied` : 'Value copied');
            setTimeout(() => setCopied(false), 1200);
          },
          () => toast.error('Could not copy the value'),
        );
      }}
    />
  );
}

/** Opens an http(s) link in the system browser (Wails runtime), else a new window. */
function openExternal(href: string) {
  const rt = (window as unknown as { runtime?: { BrowserOpenURL?: (u: string) => void } }).runtime;
  if (rt?.BrowserOpenURL) rt.BrowserOpenURL(href);
  else window.open(href, '_blank', 'noopener,noreferrer');
}

/** Interpreted text of a time value: sentinels ("Never"), else the local date and the relative time. */
function interpretTime(value: string, attrName: string): { text: string; relative?: string } | null {
  const lower = attrName.toLowerCase();
  if (lower === 'pwdlastset' && value === '0') return { text: 'Must change at next logon' };
  if (lower === 'accountexpires' && (value === '0' || value === '9223372036854775807')) return { text: 'Never' };
  if (lower === 'lockouttime' && value === '0') return { text: 'Not locked out' };
  if ((lower === 'lastlogon' || lower === 'lastlogontimestamp' || lower === 'badpasswordtime' || lower === 'lastlogoff') && value === '0') return { text: 'Never' };
  if (lower === 'pwdaccountlockedtime' && value === '000001010000Z') return { text: 'Locked permanently (disabled)' };
  // 389DS sentinels (RW1-P-04): the epoch is "must change" / "until unlocked", not a 1970 date.
  if (lower === 'passwordexpirationtime' && value === '19700101000000Z') return { text: 'Must change at next bind' };
  if (lower === 'accountunlocktime' && value === '19700101000000Z') return { text: 'Locked until an administrator unlocks it' };
  const d = /^\d{14}/.test(value) && /(Z|[+-]\d{2,4})$/.test(value) ? generalizedTimeToDate(value) : /^-?\d{1,19}$/.test(value) ? fileTimeToDate(value) : null;
  if (!d) return null;
  return { text: formatDateTime(d), relative: formatRelative(d) };
}

function uacSummary(n: number): string {
  if (n & 0x1000) return 'Workstation account';
  if (n & 0x2000) return 'Server trust account';
  if (n & 0x800) return 'Interdomain trust account';
  if (n & 0x200) return 'Normal account';
  return '';
}

function AttrValueRenderer({ attr, onNavigateDN, highlight, profileId, objectSid }: {
  attr: LDAPAttribute;
  onNavigateDN?: (dn: string) => void;
  highlight?: string;
  /** For primaryGroupID: the entry's connection and objectSid (the group is looked up by its SID). */
  profileId?: string;
  objectSid?: string;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const type = getAttrType(attr.name);

  // objectClass: one Badge per class, toned by object kind
  if (attr.name.toLowerCase() === 'objectclass') {
    return (
      <div className="flex flex-wrap gap-0.5 font-mono">
        {attr.values.map((v, i) => (
          <Badge key={i} tone={OBJECT_KIND_TONE[resolveObjectKind([v])]}>
            {v}
          </Badge>
        ))}
      </div>
    );
  }

  switch (type) {
    case 'password':
      // userPassword: every value masked with its storage scheme badge
      // ({SSHA}, {CRYPT}$6$, red "cleartext").
      if (isUserPasswordAttribute(attr.name)) return <MaskedPasswordValues values={attr.values} binary={attr.binary} />;
      // Other secrets (unicodePwd, pwdHistory, authPassword, LAPS, …): every
      // value masked with a fixed width (the length is not revealed)
      return (
        <div className="flex flex-col gap-0.5 font-mono">
          {attr.values.map((v, i) => (
            <div key={i} className="flex items-center gap-1 min-w-0">
              {showPassword ? (
                <span className="wrap-anywhere">{attr.binary ? `<${v.length} base64 characters>` : v}</span>
              ) : (
                <span className="text-muted-foreground">{PASSWORD_MASK}</span>
              )}
              {i === 0 && (
                <IconButton size="sm" label={showPassword ? 'Hide values' : 'Show values'} icon={showPassword ? EyeOff : Eye} pressed={showPassword} onClick={() => setShowPassword(!showPassword)} />
              )}
            </div>
          ))}
        </div>
      );

    case 'time':
      return (
        <div>
          {attr.values.map((v, i) => {
            const t = interpretTime(v, attr.name);
            return (
              <div key={i} className="flex items-baseline gap-2 tabular-nums">
                {t ? (
                  <>
                    <span>{t.text}</span>
                    {t.relative && <span className="text-xs text-muted-foreground">{t.relative}</span>}
                  </>
                ) : (
                  <span className="font-mono wrap-anywhere">{v}</span>
                )}
              </div>
            );
          })}
        </div>
      );

    case 'flags': {
      const lower = attr.name.toLowerCase();
      const flagDefs = FLAGS_ATTRS[lower];
      const numVal = attr.values[0] !== undefined ? Number(attr.values[0]) : NaN;
      if (flagDefs && Number.isFinite(numVal)) {
        const n = numVal >>> 0;
        const activeFlags = Object.entries(flagDefs)
          .filter(([bit]) => (n & Number(bit)) !== 0 && !(lower === 'useraccountcontrol' && Number(bit) === 0x200))
          .map(([, name]) => name);
        const summary = lower === 'useraccountcontrol' ? uacSummary(n) : '';
        return (
          <div className="flex flex-wrap items-center gap-1">
            {summary && <span>{summary}</span>}
            {activeFlags.map(flag => (
              <Badge key={flag} tone={flag === 'ACCOUNTDISABLE' || flag === 'LOCKOUT' ? 'warning' : 'neutral'} className="font-mono">
                {flag}
              </Badge>
            ))}
            {!summary && activeFlags.length === 0 && <span className="text-muted-foreground">No flags</span>}
          </div>
        );
      }
      return <div className="font-mono wrap-anywhere">{attr.values.join(', ')}</div>;
    }

    case 'enum': {
      const enumDefs = ENUM_ATTRS[attr.name.toLowerCase()];
      const numVal = attr.values[0] !== undefined ? Number(attr.values[0]) : NaN;
      const label = enumDefs && Number.isFinite(numVal) ? enumDefs[numVal] : undefined;
      return label ? <Badge className="font-mono">{label}</Badge> : <div className="font-mono wrap-anywhere">{attr.values.join(', ')}</div>;
    }

    case 'dn-reference':
      return attr.values.length > 3 ? (
        // Compact chips for many DN references
        <div className="flex flex-wrap gap-0.5">
          {attr.values.slice(0, 10).map((v, i) => (
            <DnLink key={i} dn={v} onNavigate={onNavigateDN} chip />
          ))}
          {attr.values.length > 10 && (
            <span className="text-xs text-muted-foreground px-1">+{attr.values.length - 10} more</span>
          )}
        </div>
      ) : (
        <div className="font-mono">
          {attr.values.map((v, i) => (
            <div key={i} className="wrap-anywhere">
              <DnLink dn={v} onNavigate={onNavigateDN} highlight={highlight} />
            </div>
          ))}
        </div>
      );

    default:
      if (attr.name.toLowerCase() === 'primarygroupid' && attr.values.length === 1) {
        return <PrimaryGroupValue rid={attr.values[0]} profileId={profileId} objectSid={objectSid} onNavigateDN={onNavigateDN} />;
      }
      if (attr.values.some((v) => valueLink(attr.name, v))) {
        return (
          <div className="font-mono">
            {attr.values.map((v, i) => {
              const link = valueLink(attr.name, v);
              if (!link) return <div key={i} className="wrap-anywhere">{v}</div>;
              return (
                <div key={i} className="flex items-baseline gap-1 min-w-0">
                  <button type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openExternal(link.href);
                    }}
                    className="inline-flex items-baseline gap-1 text-left text-primary hover:underline wrap-anywhere"
                    title={`Open ${link.href} in the browser`}
                  >
                    {link.label ?? link.href}
                    <ExternalLink size={12} strokeWidth={1.75} aria-hidden className="shrink-0 self-center" />
                  </button>
                  {link.label && <span className="text-xs text-muted-foreground truncate">{link.href}</span>}
                </div>
              );
            })}
          </div>
        );
      }
      if (attr.values.length > 3) {
        // Multi-value chips for attributes with many values
        return (
          <div className="flex flex-wrap gap-0.5 font-mono">
            {attr.values.slice(0, 20).map((v, i) => (
              <Badge key={i} className="max-w-[300px] truncate font-normal" title={v}>
                <span className="truncate"><HighlightText text={v} highlight={highlight || ''} /></span>
              </Badge>
            ))}
            {attr.values.length > 20 && (
              <span className="text-xs text-muted-foreground px-1">+{attr.values.length - 20} more</span>
            )}
          </div>
        );
      }
      return (
        <div className="font-mono">
          {attr.values.map((v, i) => (
            <div key={i} className="wrap-anywhere"><HighlightText text={v} highlight={highlight || ''} /></div>
          ))}
        </div>
      );
  }
}

/** Primary groups looked up per connection + SID (one base read of `<SID=…>` each, AD only). */
const primaryGroupCache = new Map<string, Promise<{ dn: string; name: string } | null>>();

function lookupPrimaryGroup(profileId: string, sid: string): Promise<{ dn: string; name: string } | null> {
  const key = `${profileId}\n${sid}`;
  let p = primaryGroupCache.get(key);
  if (!p) {
    p = wails
      .SearchLDAP(profileId, { baseDN: `<SID=${sid}>`, filter: '(objectClass=*)', scope: ScopeBase, attributes: ['cn'], sizeLimit: 1, timeLimit: 5 })
      .then((r) => {
        const e = r?.entries?.[0];
        if (!e?.dn) return null;
        return { dn: e.dn, name: e.attributes?.find((a) => a.name.toLowerCase() === 'cn')?.values[0] || firstRDN(e.dn) };
      })
      .catch(() => null);
    primaryGroupCache.set(key, p);
    // A failed lookup is tried again the next time the entry is shown.
    void p.then((v) => { if (!v) primaryGroupCache.delete(key); });
  }
  return p;
}

/**
 * primaryGroupID with the group's name (ED-19): well-known RIDs by name,
 * other RIDs looked up by their SID (domain part of the entry's objectSid)
 * and shown as a link to the group.
 */
function PrimaryGroupValue({ rid, profileId, objectSid, onNavigateDN }: { rid: string; profileId?: string; objectSid?: string; onNavigateDN?: (dn: string) => void }) {
  const known = wellKnownGroupName(rid);
  const sid = primaryGroupSid(objectSid, rid);
  const [group, setGroup] = useState<{ dn: string; name: string } | null | undefined>(undefined);
  useEffect(() => {
    if (!profileId || !sid) return;
    let cancelled = false;
    setGroup(undefined);
    void lookupPrimaryGroup(profileId, sid).then((g) => { if (!cancelled) setGroup(g); });
    return () => { cancelled = true; };
  }, [profileId, sid]);
  const name = group?.name ?? known;
  return (
    <div className="font-mono">
      {rid}
      <span className="font-sans text-muted-foreground"> · </span>
      {group && onNavigateDN ? (
        <Tooltip content={<span className="font-mono">{group.dn}</span>}>
          <button type="button"
            onClick={(e) => {
              e.stopPropagation();
              onNavigateDN(group.dn);
            }}
            className="font-sans text-primary hover:underline rounded-xs"
          >
            {group.name}
          </button>
        </Tooltip>
      ) : (
        <span className="font-sans text-muted-foreground">
          {name ?? (sid && group === undefined ? 'looking up the group…' : 'primary group (see Membership)')}
        </span>
      )}
    </div>
  );
}

/** A DN value: primary link (underlined on hover) that opens the entry. */
function DnLink({ dn, onNavigate, chip, highlight }: { dn: string; onNavigate?: (dn: string) => void; chip?: boolean; highlight?: string }) {
  // A DN wraps at its commas (<Dn>), not inside an RDN; a filter highlight keeps the plain text.
  const content: ReactNode = chip ? firstRDN(dn) : highlight ? <HighlightText text={dn} highlight={highlight} /> : <Dn dn={dn} />;
  if (!onNavigate) return <span className="font-mono">{content}</span>;
  return (
    <Tooltip content={<span className="font-mono">{dn}</span>}>
      <button type="button"
        onClick={(e) => {
          e.stopPropagation();
          onNavigate(dn);
        }}
        className={cn(
          'font-mono text-left text-primary hover:underline rounded-xs',
          chip && 'inline-flex items-center gap-0.5 h-[18px] px-1.5 bg-muted text-xs',
        )}
      >
        {chip && <Link2 size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />}
        {content}
      </button>
    </Tooltip>
  );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function HighlightText({ text, highlight }: { text: string; highlight: string }) {
  if (!highlight) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegex(highlight)})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === highlight.toLowerCase()
          ? <mark key={i} className="bg-warning-subtle text-warning rounded-xs px-0.5">{part}</mark>
          : part
      )}
    </>
  );
}
