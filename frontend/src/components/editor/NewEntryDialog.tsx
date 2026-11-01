/**
 * New entry (SPEC 10.2, LIFE-01/02): server-aware templates with forms
 * instead of raw attribute rows.
 *
 * - AD User (ADUC-style): first / initials / last → full name (cn,
 *   displayName); logon name → UPN with a suffix list (domains + uPNSuffixes)
 *   and sAMAccountName; password twice (+ generator), "must change", "account
 *   enabled", "Member of". Sequence: create (disabled) → SetPassword
 *   (unicodePwd, TLS only) → enable → AddToGroups, one result summary.
 * - LDAP User / POSIX User: names → cn, uid (RDN cn or uid), password twice
 *   through the password write guard (issue #1), "must change password at
 *   next logon" as the server's password policy allows (OpenLDAP: pwdReset
 *   in the add; 389DS: its policy marks the password, unticked → cleared
 *   after the create; account/newUserAccount.ts), POSIX IDs from the next
 *   free uidNumber/gidNumber, home directory, "Member of".
 * - Groups (AD scope + type → groupType; groupOfNames with a member picker;
 *   POSIX group with memberUid), AD computer (sAMAccountName, dNSHostName),
 *   contacts (no login), OU, container (LDAP: organizationalRole / OU),
 *   Custom… with a schema-driven structural class + auxiliaries.
 * - Object classes are editable chips for every template; MUST attributes
 *   the form does not cover appear as rows; more attributes can be added.
 * - The DN follows the server's spelling (AD: "CN=…", FIN-W-05).
 * - Title per template ("New User in ux-life"), focus on the first field;
 *   after Create the entry opens (preview) and ldapilot:entry-created is
 *   emitted with select: true.
 */
import { useState, useEffect, useMemo, useId, useRef } from 'react'
import { Plus, Trash2, FilePlus2, KeyRound, X, Copy } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { SchemaObjectClass, SchemaAttribute, LDAPAttribute, ValidationError, ServerType } from '../../types/ldap'
import * as wails from '../../lib/wails'
import { CreateEntryWithOptions } from '../../lib/wails-pwpolicy'
import { SetPassword } from '../../lib/wails-password'
import { SetAccountEnabled, SetMustChangePassword } from '../../lib/wails-account'
import type { AccountPolicy } from '../../types/account'
import { GetNewAccountPolicy, mustChangeAttributes, mustChangeFollowUp, newUserMustChange, serverRdnType } from '../account/newUserAccount'
import { AddGroupMembers, AddToGroups } from '../../lib/wails-membership'
import { EntriesExist, NextPosixIDs, UPNSuffixes } from '../../lib/wails-recycle'
import { DEFAULT_GENERATOR_OPTIONS, generatePassword } from '../../lib/passwordGenerator'
import { isPasswordWriteAttribute } from '../../lib/passwordPolicy'
import { PasswordPolicyHint } from '../password/PasswordPolicyHint'
import { NewPasswordInput, newPasswordReady } from '../password/NewPasswordInput'
import { notifyPasswordWrite, usePasswordWriteGuard } from '../password/PasswordWriteGuard'
import { toast } from '../ui/Toast'
import { Badge } from '../ui/Badge'
import { Dialog } from '../ui/Dialog'
import { DialogCancelButton } from './DialogCancelButton'
import { Button, IconButton } from '../ui/Button'
import { Field } from '../ui/Field'
import { Input, Select } from '../ui/Input'
import { Checkbox, RadioGroup } from '../ui/Checkbox'
import { SegmentedControl } from '../ui/SegmentedControl'
import { InlineAlert } from '../ui/InlineAlert'
import { Dn } from '../ui/Dn'
import { ensureServerType } from '../ui/commands'
import { GroupPicker } from '../lifecycle/GroupPicker'
import { emitEntryCreated } from '../lifecycle/events'
import {
  AD_TEMPLATES, LDAP_TEMPLATES, SERVER_MANAGED, classChain, classesInSchema, classesOfKind, defaultTemplate, dnsDomainOf,
  formMappedAttributes, ldapContainerClass, ldapPosixGroupClasses, loadLastTemplate, mayAttributes, mustAttributes, newEntryDN, newEntryFieldValue,
  newEntryTitle, planNewEntry, saveLastTemplate, summarizeCreate,
  type CreateStep, type FieldKey, type GroupKind, type GroupScope, type NewEntryForm, type NewEntryTemplate, type TemplateDef,
  type TemplateId,
} from '../lifecycle/newEntry'

export type { NewEntryTemplate } from '../lifecycle/newEntry'

interface NewEntryDialogProps {
  parentDN: string;
  onClose: () => void;
  onCreated?: () => void;
  initialTemplate?: NewEntryTemplate;
  /** Connection (default: the active connection). */
  profileId?: string;
}

interface ExtraRow {
  name: string;
  value: string;
}

const USER_LIKE: TemplateId[] = ['user', 'posixUser', 'contact'];

export function NewEntryDialog({ parentDN, onClose, onCreated, initialTemplate, profileId: profileProp }: NewEntryDialogProps) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const profileId = profileProp ?? activeProfileId ?? '';
  const profile = useConnectionStore((s) => s.profiles.find((p) => p.id === profileId));
  const [serverType, setServerType] = useState<ServerType | null>(null);
  const isAD = serverType === 'ad';
  const family = isAD ? 'ad' : 'ldap';
  const [schemaOCs, setSchemaOCs] = useState<SchemaObjectClass[]>([]);
  const [schemaAttrs, setSchemaAttrs] = useState<Map<string, SchemaAttribute>>(new Map());
  const schemaClassNames = useMemo(() => new Set(schemaOCs.map((o) => o.name.toLowerCase())), [schemaOCs]);

  const templates: TemplateDef[] = useMemo(() => {
    if (isAD) return AD_TEMPLATES;
    return LDAP_TEMPLATES.map((t) => (t.id === 'container' ? { ...t, ...ldapContainerClass(schemaClassNames) }
      : t.id === 'posixGroup' ? { ...t, objectClasses: ldapPosixGroupClasses(schemaOCs) } : t));
  }, [isAD, schemaClassNames, schemaOCs]);
  const [templateId, setTemplateId] = useState<TemplateId | null>(null);
  const template = templates.find((t) => t.id === templateId) ?? null;

  const [fields, setFields] = useState<Partial<Record<FieldKey, string>>>({});
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [ldapRdn, setLdapRdn] = useState<'uid' | 'cn'>('uid');
  const [scope, setScope] = useState<GroupScope>('global');
  const [groupKind, setGroupKind] = useState<GroupKind>('security');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [generated, setGenerated] = useState('');
  const [mustChange, setMustChange] = useState(true);
  // LDAP users: the policy of the new account (undefined while it loads) and the admin's choice (null = the policy's default).
  const [newAccountPolicy, setNewAccountPolicy] = useState<AccountPolicy | null | undefined>(undefined);
  const [ldapMustChange, setLdapMustChange] = useState<boolean | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [groups, setGroups] = useState<string[]>([]);
  const [members, setMembers] = useState<string[]>([]);
  const [classes, setClasses] = useState<string[]>([]);
  const [auxiliaries, setAuxiliaries] = useState<string[]>([]);
  const [mustValues, setMustValues] = useState<Record<string, string>>({});
  const [extraRows, setExtraRows] = useState<ExtraRow[]>([]);
  const [upnSuffixes, setUpnSuffixes] = useState<string[]>([]);
  const [posixIDs, setPosixIDs] = useState<{ uid: number; gid: number; primary: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const passwordGuard = usePasswordWriteGuard();
  const uid = useId().replace(/:/g, '');
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const focusedOnce = useRef(false);

  // Server type, schema, AD UPN suffixes.
  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    ensureServerType(profileId).then((t) => { if (!cancelled) setServerType(t ?? 'other'); });
    wails.GetSchema(profileId).then((schema) => {
      if (cancelled) return;
      if (schema?.objectClasses) setSchemaOCs(schema.objectClasses);
      if (schema?.attributes) setSchemaAttrs(new Map(schema.attributes.map((a) => [a.name.toLowerCase(), a])));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [profileId]);

  useEffect(() => {
    if (!isAD || !profileId) return;
    let cancelled = false;
    UPNSuffixes(profileId).then((list) => { if (!cancelled) setUpnSuffixes(list); }).catch(() => {});
    return () => { cancelled = true; };
  }, [isAD, profileId]);

  // The template once the server type is known: requested, last used (never OU), else Custom….
  useEffect(() => {
    if (serverType === null || templateId !== null) return;
    setTemplateId(defaultTemplate(initialTemplate, loadLastTemplate(family), templates));
  }, [serverType, templateId, initialTemplate, family, templates]);

  // POSIX templates: next free IDs (one search, not logged).
  const posix = templateId === 'posixUser' || templateId === 'posixGroup';
  useEffect(() => {
    if (!posix || posixIDs || !profileId) return;
    let cancelled = false;
    NextPosixIDs(profileId).then((ids) => {
      if (!cancelled && ids) setPosixIDs({ uid: ids.uidNumber, gid: ids.gidNumber, primary: ids.primaryGidNumber });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [posix, posixIDs, profileId]);

  // Template changed: object classes, members default, errors cleared.
  useEffect(() => {
    if (!template) return;
    setClasses(template.id === 'custom' ? [] : classesInSchema(template.objectClasses, schemaClassNames));
    setAuxiliaries([]);
    setError(null);
    setValidationErrors([]);
    // The bind DN as first member only when it is an entry: a rootDN (cn=admin on OpenLDAP,
    // cn=Directory Manager on 389DS) has none and would be a dangling member (M-03).
    const bindDN = profile?.bindDN;
    if (template.id === 'group' && !isAD && members.length === 0 && bindDN && bindDN.includes('=')) {
      void EntriesExist(profileId, [bindDN])
        .then((r) => {
          if (r[0]?.exists) setMembers((m) => (m.length === 0 ? [bindDN] : m));
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template?.id, schemaClassNames]);

  // First field focused once the form is there (the Template select comes first in the DOM).
  useEffect(() => {
    if (!template || focusedOnce.current) return;
    focusedOnce.current = true;
    requestAnimationFrame(() => firstFieldRef.current?.focus());
  }, [template]);

  const set = (key: FieldKey, value: string) => {
    setFields((f) => ({ ...f, [key]: value }));
    setTouched((t) => ({ ...t, [key]: true }));
  };
  const domain = upnSuffixes[0] || dnsDomainOf(parentDN);

  // LDAP users: "must change password" follows the password policy a new account below parentDN gets.
  const ldapUserTemplate = !isAD && (templateId === 'user' || templateId === 'posixUser');
  const policyServer = serverType === 'openldap' || serverType === '389ds';
  useEffect(() => {
    if (!ldapUserTemplate || !policyServer || !profileId || newAccountPolicy !== undefined) return;
    let cancelled = false;
    GetNewAccountPolicy(profileId, parentDN)
      .then((pol) => { if (!cancelled) setNewAccountPolicy(pol); })
      .catch(() => { if (!cancelled) setNewAccountPolicy(null); });
    return () => { cancelled = true; };
  }, [ldapUserTemplate, policyServer, profileId, parentDN, newAccountPolicy]);
  const mustChangeOffer = newUserMustChange(serverType, newAccountPolicy);
  const ldapMustChangeChecked = ldapMustChange ?? mustChangeOffer.checked;

  // --- Classes and attribute rows ---

  const structural = template?.id === 'custom' ? fields.structural ?? '' : '';
  const effectiveClasses = useMemo(() => {
    if (template?.id === 'custom') return structural ? classChain(structural, auxiliaries, schemaOCs) : [];
    const base = [...classes];
    for (const a of auxiliaries) if (!base.some((c) => c.toLowerCase() === a.toLowerCase())) base.push(a);
    return base;
  }, [template?.id, structural, auxiliaries, classes, schemaOCs]);

  const serverManaged = (name: string) => SERVER_MANAGED.has(name.toLowerCase()) || !!schemaAttrs.get(name.toLowerCase())?.noUserMod;
  const mustList = useMemo(() => mustAttributes(effectiveClasses, schemaOCs), [effectiveClasses, schemaOCs]);
  const mayList = useMemo(() => mayAttributes(effectiveClasses, schemaOCs), [effectiveClasses, schemaOCs]);

  // The naming attribute is usually a required one (account: MUST uid, although its MAY has ou).
  function defaultCustomRdn(): string {
    const must = mustList.filter((a) => !serverManaged(a));
    const may = mayList.filter((a) => !serverManaged(a));
    for (const list of [must, may]) {
      for (const pref of ['cn', 'ou', 'uid', 'o', 'dc']) {
        const hit = list.find((a) => a.toLowerCase() === pref);
        if (hit) return hit;
      }
    }
    return must[0] ?? may[0] ?? 'cn';
  }

  // --- The entry the form describes (pure: lifecycle/newEntry.ts) ---

  const form: NewEntryForm = {
    template: template?.id ?? 'custom', templateRdnAttr: template?.rdnAttr ?? 'cn', isAD, parentDN, fields, touched, ldapRdn,
    scope, groupKind, password, members, upnSuffixes, posixIDs, customRdnDefault: defaultCustomRdn(), mustValues, extraRows,
  };
  const val = (key: FieldKey) => newEntryFieldValue(form, key);

  const p = planNewEntry(form);
  // The server's spelling of the RDN type: AD returns "CN=…" (FIN-W-05).
  const dn = newEntryDN(serverRdnType(p.rdnAttr, serverType), p.rdnValue, parentDN);
  const covered = new Set(Object.keys(p.attrs).map((k) => k.toLowerCase()));
  // Attributes the template's fields fill (sn, cn, uid, homeDirectory …) get no second input row (M-02).
  const mapped = formMappedAttributes(form);
  const requiredHere = mustList.filter((m) => !serverManaged(m) && m.toLowerCase() !== p.rdnAttr.toLowerCase() && !isPasswordWriteAttribute(m));
  const mustRows = requiredHere.filter((m) => (!covered.has(m.toLowerCase()) && !mapped.has(m.toLowerCase())) || mustValues[m] !== undefined);
  const hasAttr = (name: string) => Object.entries(p.attrs).some(([k, v]) => k.toLowerCase() === name.toLowerCase() && v.length > 0);
  // Still blocks Create while a mapped MUST attribute is empty (its form field says which).
  const missingRequired = requiredHere.filter((m) => !hasAttr(m));

  const isADUser = isAD && template?.id === 'user';
  const isLDAPAccount = !isAD && (template?.id === 'user' || template?.id === 'posixUser');
  const tlsOK = (profile?.tlsMode ?? 'none') !== 'none';
  const passwordOK = !password && !confirm ? true : newPasswordReady(password, confirm);
  const membersOK = !(template?.id === 'group' && !isAD) || members.length > 0;
  const customOK = template?.id !== 'custom' || !!structural;
  const adUserOK = !isADUser || (!!val('sam').trim() && !!val('logon').trim());
  const canCreate = !loading && !!template && !!dn && missingRequired.length === 0 && passwordOK && membersOK && customOK && adUserOK;
  const dirty = Object.values(fields).some((v) => (v ?? '').trim() !== '') || !!password || groups.length > 0 || extraRows.length > 0;

  async function handleCreate() {
    if (!canCreate || !template) return;
    const attrMap = p.attrs;
    const objectClasses = effectiveClasses;
    try {
      const valErrors = (await wails.ValidateEntry(profileId, objectClasses, attrMap)) ?? [];
      const blocking = valErrors.filter((e) => !serverManaged(e.attribute) && !isPasswordWriteAttribute(e.attribute));
      if (blocking.length > 0) {
        setValidationErrors(blocking);
        return;
      }
    } catch {
      // Validation service unavailable — proceed without validation
    }
    setValidationErrors([]);

    // OpenLDAP "must change": pwdReset TRUE in the same add (FIN-W-03).
    const mustChangeAttrs = isLDAPAccount ? mustChangeAttributes(mustChangeOffer, ldapMustChangeChecked, !!password) : [];
    const ldapAttrs: LDAPAttribute[] = [
      { name: 'objectClass', values: objectClasses, binary: false },
      ...Object.entries(attrMap).map(([name, values]) => ({ name, values, binary: false })),
      ...mustChangeAttrs,
    ];
    const name = p.rdnValue.trim();
    setLoading(true);
    setError(null);
    const steps: CreateStep[] = [];
    try {
      const opts = await passwordGuard.check(profileId, { attributes: ldapAttrs });
      if (!opts) return; // cancelled: nothing was sent
      let report;
      try {
        report = await CreateEntryWithOptions(profileId, dn, ldapAttrs, opts);
      } catch (err: any) {
        setError(err?.message || 'Failed to create entry');
        return;
      }
      steps.push({ id: 'create', state: 'done', text: 'created' });

      // LDAP user: must change at next logon (OpenLDAP: in the add; 389DS: its policy, cleared when unticked).
      if (isLDAPAccount && password && mustChangeOffer.enabled) {
        if (mustChangeAttrs.length > 0 || (mustChangeOffer.mode === 'dsPolicy' && ldapMustChangeChecked)) {
          steps.push({ id: 'mustChange', state: 'done', text: 'must change password at next logon' });
        } else if (mustChangeFollowUp(mustChangeOffer, ldapMustChangeChecked, !!password) === 'clear') {
          try {
            await SetMustChangePassword(profileId, dn, false);
            steps.push({ id: 'mustChange', state: 'done', text: 'no password change required' });
          } catch (err: any) {
            steps.push({ id: 'mustChange', state: 'failed', text: 'clear "must change password"', detail: err?.message || String(err) });
          }
        }
      }

      // AD user: password (TLS only), then enable; the account was created disabled.
      if (isADUser) {
        let passwordSet = false;
        if (!tlsOK) {
          steps.push({ id: 'password', state: 'skipped', text: 'password', detail: 'Active Directory accepts passwords only over LDAPS or StartTLS: the account stays disabled. Set the password with Reset Password… over a TLS connection, then enable the account.' });
        } else if (password) {
          try {
            await SetPassword(profileId, { dn, password, method: 'unicodePwd', scheme: '', mustChange, unlock: false, verifyBind: false });
            passwordSet = true;
            steps.push({ id: 'password', state: 'done', text: mustChange ? 'password set (must change at next logon)' : 'password set' });
          } catch (err: any) {
            steps.push({ id: 'password', state: 'failed', text: 'password', detail: err?.message || String(err) });
          }
        }
        if (passwordSet && enabled) {
          try {
            await SetAccountEnabled(profileId, dn, true);
            steps.push({ id: 'enable', state: 'done', text: 'enabled' });
          } catch (err: any) {
            steps.push({ id: 'enable', state: 'failed', text: 'account enabled', detail: err?.message || String(err) });
          }
        } else if (tlsOK && (passwordSet || !password)) {
          // No password typed, or "Account enabled" unticked: disabled on purpose.
          steps.push({ id: 'enable', state: 'done', text: passwordSet ? 'disabled' : 'disabled (no password)' });
        }
      }

      // Groups of a new account / members of a new AD group.
      if (groups.length > 0 && (USER_LIKE.includes(template.id) || template.id === 'computer' || template.id === 'group')) {
        try {
          const res = await AddToGroups(profileId, dn, groups);
          const failed = res.failed ?? [];
          steps.push(failed.length
            ? { id: 'groups', state: 'failed', text: `member of ${groups.length - failed.length} of ${groups.length} groups`, detail: failed.map((f) => `${f.dn}: ${f.error}`).join('\n') }
            : { id: 'groups', state: 'done', text: `added to ${res.changed.length + res.unchanged.length} group${res.changed.length + res.unchanged.length === 1 ? '' : 's'}` });
        } catch (err: any) {
          steps.push({ id: 'groups', state: 'failed', text: 'group memberships', detail: err?.message || String(err) });
        }
      }
      if (isAD && template.id === 'group' && members.length > 0) {
        try {
          const res = await AddGroupMembers(profileId, dn, members);
          const failed = res.failed ?? [];
          steps.push(failed.length
            ? { id: 'members', state: 'failed', text: `${members.length - failed.length} of ${members.length} members added`, detail: failed.map((f) => `${f.dn}: ${f.error}`).join('\n') }
            : { id: 'members', state: 'done', text: `${res.changed.length} member${res.changed.length === 1 ? '' : 's'} added` });
        } catch (err: any) {
          steps.push({ id: 'members', state: 'failed', text: 'members', detail: err?.message || String(err) });
        }
      }

      const summary = summarizeCreate(name, steps);
      if (attrMap.userPassword?.length && report) {
        // The password write's own toast (stored scheme, cleartext warnings) carries the summary.
        notifyPasswordWrite(report, summary.message, { profileId, dn });
        if (summary.level === 'warning') toast.warning('Not everything was done', summary.detail);
      } else if (summary.level === 'success') toast.success(summary.message);
      else toast.warning(summary.message, summary.detail);

      saveLastTemplate(family, template.id);
      onCreated?.();
      onClose();
      // Show the new entry: preview tab, and the tree selects it (entry-created).
      useEditorStore.getState().openEntry(profileId, dn, { preview: true });
      emitEntryCreated(profileId, dn, { select: true, parentDN });
    } catch (err: any) {
      setError(err?.message || 'Failed to create entry');
    } finally {
      setLoading(false);
    }
  }

  function generate() {
    const pw = generatePassword(DEFAULT_GENERATOR_OPTIONS);
    setPassword(pw);
    setConfirm(pw);
    setGenerated(pw);
  }

  const title = template ? newEntryTitle(template.noun, parentDN) : 'New Entry';
  const auxOptions = classesOfKind(schemaOCs, 'auxiliary').filter((c) => !effectiveClasses.some((e) => e.toLowerCase() === c.toLowerCase()));
  const structuralOptions = classesOfKind(schemaOCs, 'structural');
  const nameLabel = template?.id === 'ou' ? 'Name (ou)' : template?.id === 'computer' ? 'Computer name' : template?.id === 'custom' ? `Name (${val('rdnAttr')})` : 'Name';
  const textField = (key: FieldKey, label: string, opts: { required?: boolean; hint?: string; first?: boolean; mono?: boolean; placeholder?: string; maxLength?: number; className?: string } = {}) => (
    <Field label={label} required={opts.required} hint={opts.hint} className={opts.className}>
      <Input
        ref={opts.first ? firstFieldRef : undefined}
        value={val(key)}
        mono={opts.mono}
        maxLength={opts.maxLength}
        placeholder={opts.placeholder}
        onChange={(e) => set(key, e.target.value)}
        invalid={validationErrors.some((v) => v.attribute.toLowerCase() === key.toLowerCase())}
      />
    </Field>
  );

  const passwordBlock = () => (
    <div className="space-y-1.5">
      <Field label="Password" id={`ne${uid}-pw`}>
        <div className="flex items-start gap-1.5">
          <NewPasswordInput
            id={`ne${uid}-pw`}
            size="md"
            value={password}
            onChange={(v) => { setPassword(v); setGenerated(''); }}
            confirm={confirm}
            onConfirmChange={(v) => { setConfirm(v); setGenerated(''); }}
            placeholder={isADUser ? 'Password' : 'Password (optional)'}
            className="flex-1"
          />
          <Button variant="secondary" leftIcon={KeyRound} onClick={generate}>Generate</Button>
        </div>
      </Field>
      {generated && (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          Generated: <span className="font-mono text-foreground select-all">{generated}</span>
          <IconButton label="Copy password" icon={Copy} onClick={() => { void navigator.clipboard.writeText(generated).then(() => toast.success('Password copied')); }} />
        </div>
      )}
    </div>
  );

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !loading && onClose()}
      size="lg"
      icon={<FilePlus2 size={16} strokeWidth={1.75} aria-hidden className="text-primary" />}
      title={title}
      description={<span>In <Dn dn={parentDN} /></span>}
      dismissible={loading ? 'never' : 'when-clean'}
      dirty={dirty}
      initialFocus={firstFieldRef}
      onSubmit={() => { if (canCreate) void handleCreate(); }}
      footer={
        <>
          <DialogCancelButton disabled={loading} />
          <Button type="submit" variant="primary" leftIcon={Plus} loading={loading} disabled={!canCreate}>
            {template ? `Create ${template.noun}` : 'Create'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Template" hint={isAD ? 'Active Directory templates' : serverType ? 'LDAP templates' : undefined}>
          <Select
            value={templateId ?? ''}
            onChange={(e) => setTemplateId(e.target.value as TemplateId)}
            options={templates.map((t) => ({ value: t.id, label: t.label }))}
            disabled={!template}
          />
        </Field>

        {/* --- Template forms --- */}
        {(template?.id === 'user' || template?.id === 'posixUser' || template?.id === 'contact') && (
          <div className="grid grid-cols-6 gap-2">
            {textField('first', 'First name', { first: true, className: 'col-span-3' })}
            {isAD ? textField('initials', 'Initials', { className: 'col-span-1', maxLength: 6 }) : null}
            {textField('last', 'Last name', { className: isAD ? 'col-span-2' : 'col-span-3', required: !isAD })}
            {textField('fullName', isAD ? 'Full name (cn, displayName)' : 'Full name (cn)', { className: 'col-span-6', required: true })}
            {isADUser && (
              <>
                <Field label="User logon name (userPrincipalName)" className="col-span-6" required>
                  <div className="flex items-center gap-1">
                    <Input value={val('logon')} onChange={(e) => set('logon', e.target.value)} className="flex-1" />
                    <Select
                      aria-label="UPN suffix"
                      value={val('upnSuffix')}
                      onChange={(e) => set('upnSuffix', e.target.value)}
                      options={(upnSuffixes.length ? upnSuffixes : [domain]).filter(Boolean).map((s) => ({ value: s, label: `@${s}` }))}
                      className="w-auto max-w-[50%]"
                    />
                  </div>
                </Field>
                {textField('sam', 'Pre-Windows 2000 logon name (sAMAccountName)', { className: 'col-span-6', required: true, maxLength: 20, hint: 'Max. 20 characters; unique in the domain.' })}
              </>
            )}
            {isLDAPAccount && (
              <>
                {textField('uid', 'User ID (uid)', { className: 'col-span-3', required: true })}
                <Field label="Entry named by" className="col-span-3">
                  <SegmentedControl
                    aria-label="RDN attribute"
                    value={ldapRdn}
                    onValueChange={(v) => setLdapRdn(v as 'uid' | 'cn')}
                    options={[{ value: 'uid', label: 'uid' }, { value: 'cn', label: 'cn (full name)' }]}
                  />
                </Field>
              </>
            )}
            {textField('mail', 'E-mail (mail)', { className: 'col-span-3' })}
            {template?.id === 'contact' && textField('phone', 'Telephone', { className: 'col-span-3' })}
            {template?.id === 'posixUser' && (
              <>
                {textField('uidNumber', 'uidNumber', { className: 'col-span-2', required: true, hint: posixIDs ? 'Next free ID' : undefined })}
                {textField('gidNumber', 'gidNumber (primary group)', { className: 'col-span-2', required: true })}
                {textField('shell', 'Login shell', { className: 'col-span-2', mono: true })}
                {textField('home', 'Home directory', { className: 'col-span-6', mono: true, required: true })}
              </>
            )}
          </div>
        )}
        {template?.id === 'contact' && !isAD && (
          <InlineAlert tone="info" body="No uid and no password: the entry is a contact, not an account (no logon, no account actions)." />
        )}

        {(template?.id === 'group' || template?.id === 'posixGroup' || template?.id === 'computer' || template?.id === 'ou' || template?.id === 'container' || template?.id === 'custom') && (
          <div className="grid grid-cols-6 gap-2">
            {template.id === 'custom' && (
              <>
                <Field label="Structural object class" required className="col-span-3">
                  <Select
                    value={val('structural')}
                    onChange={(e) => set('structural', e.target.value)}
                    options={[{ value: '', label: structuralOptions.length ? 'Choose a class…' : 'Schema not loaded' }, ...structuralOptions.map((c) => ({ value: c, label: c }))]}
                  />
                </Field>
                <Field label="Named by (RDN attribute)" className="col-span-3">
                  <Select
                    value={val('rdnAttr')}
                    onChange={(e) => set('rdnAttr', e.target.value)}
                    options={[...new Set([val('rdnAttr'), ...mustList, ...mayList].filter((a) => a && !serverManaged(a)))].map((a) => ({ value: a, label: a }))}
                  />
                </Field>
              </>
            )}
            {textField('name', nameLabel, { first: true, required: true, className: 'col-span-6' })}
            {template.id === 'group' && isAD && (
              <>
                {textField('sam', 'Group name (pre-Windows 2000, sAMAccountName)', { className: 'col-span-6', required: true, maxLength: 256 })}
                <Field label="Group scope" className="col-span-3">
                  <RadioGroup
                    aria-label="Group scope"
                    value={scope}
                    onValueChange={(v) => setScope(v as GroupScope)}
                    options={[{ value: 'domainLocal', label: 'Domain local' }, { value: 'global', label: 'Global' }, { value: 'universal', label: 'Universal' }]}
                  />
                </Field>
                <Field label="Group type" className="col-span-3">
                  <RadioGroup
                    aria-label="Group type"
                    value={groupKind}
                    onValueChange={(v) => setGroupKind(v as GroupKind)}
                    options={[{ value: 'security', label: 'Security' }, { value: 'distribution', label: 'Distribution' }]}
                  />
                </Field>
              </>
            )}
            {template.id === 'computer' && isAD && (
              <>
                {textField('sam', 'Computer name (pre-Windows 2000)', { className: 'col-span-3', required: true, mono: true })}
                {textField('dnsHostName', 'DNS host name', { className: 'col-span-3', mono: true })}
              </>
            )}
            {template.id === 'posixGroup' && (
              <>
                {textField('gidNumber', 'gidNumber', { className: 'col-span-2', required: true, hint: posixIDs ? 'Next free ID' : undefined })}
                {textField('memberUids', 'Members (memberUid)', { className: 'col-span-4', hint: 'User IDs separated by spaces or commas' })}
              </>
            )}
            {template.id !== 'custom' && textField('description', 'Description', { className: 'col-span-6' })}
          </div>
        )}

        {template?.id === 'group' && (
          <Field label={isAD ? 'Members (optional)' : 'Members (groupOfNames needs at least one)'} required={!isAD}>
            <GroupPicker profileId={profileId} value={members} onChange={setMembers} groupsOnly={false} aria-label="Members" />
          </Field>
        )}

        {isADUser && !tlsOK && (
          <InlineAlert tone="warning" body="This connection is not encrypted: Active Directory accepts passwords only over LDAPS or StartTLS. The user is created disabled and without a password; set it with Reset Password… over a TLS connection, then enable the account." />
        )}
        {(isLDAPAccount || (isADUser && tlsOK)) && (
          <>
            {passwordBlock()}
            {isADUser && (
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <Checkbox checked={mustChange && !!password} onCheckedChange={setMustChange} label="User must change password at next logon" disabled={!password} />
                <Checkbox
                  checked={enabled && !!password}
                  onCheckedChange={setEnabled}
                  label="Account enabled"
                  description={!password ? 'Needs a password: without one the account stays disabled' : undefined}
                  disabled={!password}
                />
              </div>
            )}
            {isLDAPAccount && mustChangeOffer.shown && (
              <Checkbox
                checked={ldapMustChangeChecked && mustChangeOffer.enabled && !!password}
                onCheckedChange={setLdapMustChange}
                label="User must change password at next logon"
                disabled={!password || !mustChangeOffer.enabled}
                description={password ? mustChangeOffer.note : 'Needs a password'}
              />
            )}
            {isLDAPAccount && !mustChangeOffer.shown && mustChangeOffer.note && password && (
              <p className="text-sm text-muted-foreground">{mustChangeOffer.note}</p>
            )}
            {isLDAPAccount && password && <PasswordPolicyHint profileId={profileId} />}
          </>
        )}

        {template && (USER_LIKE.includes(template.id) || template.id === 'computer' || (template.id === 'group' && isAD)) && (
          <Field label="Member of (optional)">
            <GroupPicker profileId={profileId} value={groups} onChange={setGroups} groupsOnly aria-label="Member of" />
          </Field>
        )}

        {dn && (
          <div className="text-sm text-muted-foreground bg-background px-2 py-1 rounded border border-border" aria-live="polite">
            DN: <Dn dn={dn} className="text-foreground" />
          </div>
        )}

        {/* --- Object classes (editable) --- */}
        {template && (
          <div>
            <div className="text-sm font-medium text-muted-foreground mb-1">Object classes</div>
            <div className="flex flex-wrap items-center gap-1">
              {effectiveClasses.map((oc) => {
                const removable = oc.toLowerCase() !== 'top' && (template.id === 'custom'
                  ? auxiliaries.some((a) => a.toLowerCase() === oc.toLowerCase())
                  : true);
                return (
                  <Badge key={oc} className="font-mono pr-0.5">
                    {oc}
                    {removable && (
                      <button type="button"
                        aria-label={`Remove object class ${oc}`}
                        onClick={() => {
                          setAuxiliaries((a) => a.filter((x) => x.toLowerCase() !== oc.toLowerCase()));
                          setClasses((c) => c.filter((x) => x.toLowerCase() !== oc.toLowerCase()));
                        }}
                        className="inline-flex items-center justify-center size-3.5 rounded-xs hover:bg-background"
                      >
                        <X size={12} strokeWidth={1.75} aria-hidden />
                      </button>
                    )}
                  </Badge>
                );
              })}
              {auxOptions.length > 0 && (
                <Select
                  size="sm"
                  aria-label="Add an auxiliary object class"
                  value=""
                  onChange={(e) => { const v = e.target.value; if (v) setAuxiliaries((a) => [...a, v]); }}
                  options={[{ value: '', label: '+ Add class…' }, ...auxOptions.map((c) => ({ value: c, label: c }))]}
                  className="w-auto"
                />
              )}
            </div>
          </div>
        )}

        {/* --- Required attributes the form does not fill, and extra attributes --- */}
        {template && (mustRows.length > 0 || extraRows.length > 0 || template.id === 'custom') && (
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium text-muted-foreground">
              {mustRows.length > 0 ? 'Required attributes' : 'Attributes'}
            </legend>
            {mustRows.map((m) => (
              <div key={m} className="grid grid-cols-[10rem_minmax(0,1fr)_1.5rem] items-center gap-1.5">
                <span className="font-mono text-sm truncate" title={m}>{m}</span>
                <Input
                  aria-label={`${m} value`}
                  aria-required
                  value={mustValues[m] ?? ''}
                  onChange={(e) => setMustValues((v) => ({ ...v, [m]: e.target.value }))}
                  placeholder="Required"
                  invalid={validationErrors.some((v) => v.attribute.toLowerCase() === m.toLowerCase())}
                />
                <span className="text-center text-destructive" title="Required by the schema" aria-hidden>*</span>
              </div>
            ))}
            {template.id === 'custom' && mustRows.length === 0 && structural && (
              <p className="text-sm text-muted-foreground">The class needs no further attributes besides the name.</p>
            )}
          </fieldset>
        )}
        {template && (
          <fieldset className="space-y-1.5">
            <div className="flex items-center justify-between">
              <legend className="text-sm font-medium text-muted-foreground">More attributes</legend>
              <Button size="sm" variant="ghost" leftIcon={Plus} onClick={() => setExtraRows((r) => [...r, { name: '', value: '' }])}>
                Add attribute
              </Button>
            </div>
            <datalist id={`ne${uid}-may`}>
              {mayList.filter((a) => !serverManaged(a)).map((a) => <option key={a} value={a} />)}
            </datalist>
            {extraRows.map((r, i) => (
              <div key={i} className="grid grid-cols-[10rem_minmax(0,1fr)_auto] items-start gap-1.5">
                <Input
                  mono
                  aria-label={`Attribute ${i + 1} name`}
                  list={`ne${uid}-may`}
                  value={r.name}
                  onChange={(e) => setExtraRows((rows) => rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  placeholder="Attribute"
                />
                {isPasswordWriteAttribute(r.name.trim()) ? (
                  <p className="text-sm text-muted-foreground py-1">Use the password field of a user template (passwords are asked twice).</p>
                ) : (
                  <Input
                    aria-label={`${r.name || 'Attribute'} value`}
                    value={r.value}
                    onChange={(e) => setExtraRows((rows) => rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                    placeholder="Value"
                  />
                )}
                <IconButton label={`Remove ${r.name || 'attribute'}`} icon={Trash2} className="enabled:hover:text-destructive" onClick={() => setExtraRows((rows) => rows.filter((_, j) => j !== i))} />
              </div>
            ))}
          </fieldset>
        )}

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
      {passwordGuard.element}
    </Dialog>
  );
}
