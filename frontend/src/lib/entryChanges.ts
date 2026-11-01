/**
 * Pure functions that turn edited attribute values into the AttributeChange
 * list of ONE atomic ModifyEntry call, and build the attribute list of an
 * entry copy. It imports only types and lib/dn.ts (with the .ts extension),
 * so the module runs under `node --test`.
 */
import type { AttributeChange, LDAPAttribute, ValidationError } from '../types/ldap';
import { escapeDNValue, firstRDN, getParentDN, parseRDN } from './dn.ts';

/** True if both lists hold the same values, ignoring order. */
export function sameValues(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * The change that turns `original` into `final` for one attribute, or null
 * if the values are the same (unchanged attributes are never sent):
 * - no values left: delete the attribute (no values sent)
 * - attribute is new: add the values
 * - otherwise: replace with the final values.
 * Value-level add/delete is not used for existing attributes because
 * OpenLDAP refuses it on attributes without an equality rule (jpegPhoto:
 * "modify/add: jpegPhoto: no equality matching rule"). unicodePwd is always
 * replaced (an admin reset; AD refuses a plain add).
 */
export function attributeChange(
  name: string,
  original: readonly string[],
  final: readonly string[],
  binary = false,
): AttributeChange | null {
  if (sameValues(original, final)) return null;
  if (final.length === 0) {
    return { operation: 'delete', attribute: name, values: [], binary };
  }
  const isUnicodePwd = name.toLowerCase().split(';')[0] === 'unicodepwd';
  if (original.length === 0 && !isUnicodePwd) {
    return { operation: 'add', attribute: name, values: [...final], binary };
  }
  return { operation: 'replace', attribute: name, values: [...final], binary };
}

/**
 * objectClass changes as value-level add/delete (case-insensitive), so only
 * the added or removed classes are sent (AD rejects a replace that touches
 * the structural class chain).
 */
export function objectClassChanges(
  original: readonly string[],
  final: readonly string[],
): { add: AttributeChange | null; remove: AttributeChange | null } {
  const origLower = new Set(original.map((c) => c.toLowerCase()));
  const finalLower = new Set(final.map((c) => c.toLowerCase()));
  const added = final.filter((c) => !origLower.has(c.toLowerCase()));
  const removed = original.filter((c) => !finalLower.has(c.toLowerCase()));
  return {
    add: added.length ? { operation: 'add', attribute: 'objectClass', values: added, binary: false } : null,
    remove: removed.length ? { operation: 'delete', attribute: 'objectClass', values: removed, binary: false } : null,
  };
}

export interface EntryEditState {
  originalObjectClasses: readonly string[];
  objectClasses: readonly string[];
  /** Attribute values as loaded (without objectClass). */
  originalAttrs: ReadonlyMap<string, readonly string[]>;
  /** Attribute values as edited (without objectClass). */
  workingAttrs: ReadonlyMap<string, readonly string[]>;
  /** Names of binary attributes (values are base64); case-insensitive. */
  binaryAttrs: ReadonlySet<string>;
}

/**
 * All changes of an edit session for one ModifyEntry call, in an order that
 * keeps every intermediate step schema-valid where possible: new object
 * classes first, then the attribute changes, removed object classes last.
 * Attribute names are matched case-insensitively; binary attributes keep
 * binary: true so their base64 values are decoded by the backend.
 */
export function buildEntryChanges(state: EntryEditState): AttributeChange[] {
  const binaryLower = new Set([...state.binaryAttrs].map((n) => n.toLowerCase()));
  const original = new Map<string, { name: string; values: readonly string[] }>();
  for (const [name, values] of state.originalAttrs) {
    original.set(name.toLowerCase(), { name, values });
  }
  const working = new Map<string, { name: string; values: readonly string[] }>();
  for (const [name, values] of state.workingAttrs) {
    const key = name.toLowerCase();
    const prev = working.get(key);
    // Two spellings of one attribute: merge their values.
    working.set(key, { name: prev?.name ?? name, values: prev ? [...prev.values, ...values] : values });
  }

  const attrChanges: AttributeChange[] = [];
  const keys = [...original.keys(), ...[...working.keys()].filter((k) => !original.has(k))];
  for (const key of keys) {
    const orig = original.get(key);
    const cur = working.get(key);
    const name = orig?.name ?? cur!.name;
    const change = attributeChange(name, orig?.values ?? [], cur?.values ?? [], binaryLower.has(key));
    if (change) attrChanges.push(change);
  }

  const oc = objectClassChanges(state.originalObjectClasses, state.objectClasses);
  return [...(oc.add ? [oc.add] : []), ...attrChanges, ...(oc.remove ? [oc.remove] : [])];
}

/**
 * The key in `keys` that denotes attribute `name`: the exact name, else a
 * case-insensitive match, else a name that differs only in options
 * ("userCertificate" ↔ "userCertificate;binary"). undefined if none.
 */
export function findAttributeKey(keys: Iterable<string>, name: string): string | undefined {
  const list = [...keys];
  if (list.includes(name)) return name;
  const lower = name.toLowerCase();
  const exact = list.find((k) => k.toLowerCase() === lower);
  if (exact !== undefined) return exact;
  const base = lower.split(';')[0];
  return list.find((k) => k.toLowerCase().split(';')[0] === base);
}

/** Lower-cased attribute type without options ("userCertificate;binary" → "usercertificate"). */
function baseNameLower(name: string): string {
  return name.toLowerCase().split(';')[0];
}

/**
 * True if `attr` was required by the entry's object classes before the edit
 * (`mustBefore`) but is missing from the loaded entry: the server keeps it
 * without returning it for "*" / "+" (AD's nTSecurityDescriptor) or access
 * control hides it. Such an attribute is not the edit's business.
 */
export function requiredButNotLoaded(
  attr: string,
  mustBefore: Iterable<string>,
  originalAttrNames: Iterable<string>,
): boolean {
  const base = baseNameLower(attr);
  if (![...mustBefore].some((m) => baseNameLower(m) === base)) return false;
  return ![...originalAttrNames].some((n) => baseNameLower(n) === base);
}

/**
 * Splits SchemaService.ValidateEntry errors of the edit dialog into those
 * that block the save and those that are ignored. A missing required
 * attribute blocks if the edit caused it: the user removed it, or an object
 * class added in this edit requires it. It is ignored if it was required
 * before and missing from the loaded entry already (requiredButNotLoaded),
 * e.g. nTSecurityDescriptor, which every AD object has (MUST of top) but
 * Samba/AD only return when asked for explicitly. objectClass errors block
 * only if the object classes changed; errors without an attribute always block.
 */
export function blockingValidationErrors(
  errors: readonly ValidationError[],
  opts: { mustBefore: Iterable<string>; originalAttrNames: Iterable<string>; objectClassesChanged: boolean },
): { blocking: ValidationError[]; ignored: ValidationError[] } {
  const mustBefore = [...opts.mustBefore];
  const originalAttrNames = [...opts.originalAttrNames];
  const blocking: ValidationError[] = [];
  const ignored: ValidationError[] = [];
  for (const e of errors) {
    let blocks = true;
    if (e.attribute && baseNameLower(e.attribute) === 'objectclass') {
      blocks = opts.objectClassesChanged;
    } else if (e.attribute) {
      blocks = !requiredButNotLoaded(e.attribute, mustBefore, originalAttrNames);
    }
    (blocks ? blocking : ignored).push(e);
  }
  return { blocking, ignored };
}

/** Names of attributes whose values are masked in the audit log (mirrors sensitiveAttributes in services/audit_helper.go). */
const SENSITIVE_ATTRS = new Set([
  'userpassword', 'unicodepwd', 'sambantpassword', 'sambalmpassword',
  'supplementalcredentials', 'krbprincipalkey', 'krbmkey', 'userpkcs12',
  'mstpm-ownerinformation', 'olcrootpw', 'nsslapd-rootpw',
  // userPassword, unicodePwd, authPassword written by their OID
  '2.5.4.35', '1.2.840.113556.1.4.90', '1.3.6.1.4.1.4203.1.3.4',
]);

/**
 * True if values of the attribute are secrets that must not be shown
 * (passwords, hashes, keys): the names and patterns that
 * services/audit_helper.go isSensitiveAttribute masks ("password", "…pwd",
 * "pwdhistory", "…rootpw", "secret"). pwdLastSet, pwdReset etc. are not masked.
 */
export function isSensitiveAttributeName(name: string): boolean {
  const n = baseNameLower(name);
  if (SENSITIVE_ATTRS.has(n)) return true;
  // Timestamps, counters and policy values that merely mention "password"
  // (badPasswordTime, passwordExpirationTime, passwordRetryCount,
  // msDS-UserPasswordExpiryTimeComputed, msDS-MinimumPasswordLength/Age) are
  // shown like any other value (mirrors isPasswordMetadata in audit_helper.go).
  if (n.includes('password') && PASSWORD_METADATA_SUFFIXES.some((x) => n.endsWith(x))) return false;
  return n.includes('password') || n.endsWith('pwd') ||
    n.includes('pwdhistory') || n.endsWith('rootpw') || n.includes('secret');
}

const PASSWORD_METADATA_SUFFIXES = ['time', 'timecomputed', 'count', 'length', 'age', 'precedence', 'enabled', 'warned'];

/**
 * One line per change for the edit dialog's footer tooltip, e.g.
 * "add objectClass: posixAccount". Binary values are counted, secret values
 * (isSensitiveAttributeName) masked, at most three values listed.
 */
export function describeChange(ch: AttributeChange): string {
  if (ch.operation === 'delete' && ch.values.length === 0) return `delete ${ch.attribute}`;
  const n = ch.values.length;
  let vals: string;
  if (ch.binary) vals = `${n} binary value${n !== 1 ? 's' : ''}`;
  else if (isSensitiveAttributeName(ch.attribute)) vals = `*** (${n} value${n !== 1 ? 's' : ''})`;
  else vals = ch.values.slice(0, 3).join(', ') + (n > 3 ? ', …' : '');
  return `${ch.operation} ${ch.attribute}: ${vals}`;
}

/** Where an uploaded file goes: a new value, or in place of value `index`. */
export type UploadTarget = { type: 'add' } | { type: 'replace'; index: number };

/** Values after putting `data` at `target` (an out-of-range index adds). */
export function valuesWithUpload(current: readonly string[], target: UploadTarget, data: string): string[] {
  if (target.type === 'replace' && target.index >= 0 && target.index < current.length) {
    return current.map((v, i) => (i === target.index ? data : v));
  }
  return [...current, data];
}

/**
 * Lower-case names of AD attributes that are unique per account or bind
 * credentials to one account, so a copy must not take them: SPNs (a
 * duplicate fails with "0000202F: samldb: spn[…] would cause a conflict"),
 * DNS host names of computers, additional sAMAccountNames, certificate
 * mappings and Windows Hello keys.
 */
export const COPY_PER_ACCOUNT_ATTRS = new Set([
  'serviceprincipalname', 'dnshostname', 'msds-additionaldnshostname', 'msds-additionalsamaccountname',
  'altsecurityidentities', 'msds-keycredentiallink',
]);

/**
 * Lower-case names of attributes that are never copied: operational and
 * server-maintained attributes, AD logon/lockout state, and per-object
 * identifiers that must stay unique (mailbox/consistency GUIDs, SID history;
 * objectGUID/objectSid and the formatted GUIDs are also text, not raw bytes),
 * and COPY_PER_ACCOUNT_ATTRS.
 */
export const COPY_EXCLUDED_ATTRS = new Set([
  'objectguid', 'whencreated', 'whenchanged', 'usncreated', 'usnchanged', 'objectsid',
  'distinguishedname', 'name', 'entryuuid', 'entrydn', 'createtimestamp', 'modifytimestamp',
  'creatorsname', 'modifiersname', 'structuralobjectclass', 'subschemasubentry',
  'hassubordinates', 'numsubordinates', 'entrycsn', 'contextcsn', 'pwdchangedtime',
  'memberof', 'dscorepropagationdata', 'lastlogontimestamp', 'lastlogon', 'logoncount',
  'badpasswordtime', 'badpwdcount', 'primarygroupid', 'objectcategory', 'instancetype',
  'iscriticalsystemobject', 'systemflags', 'admincount', 'samaccounttype',
  'showinadvancedviewonly', 'ntsecuritydescriptor', 'replpropertymetadata',
  'msds-replattributemetadata', 'ismemberof',
  // AD: only 0/-1 may be written, logon state, unique identifiers
  'pwdlastset', 'lastlogoff', 'lockouttime', 'msexchmailboxguid', 'msds-generationid',
  'ms-ds-consistencyguid', 'sidhistory',
  ...COPY_PER_ACCOUNT_ATTRS,
  // OpenLDAP ppolicy state
  'pwdhistory', 'pwdfailuretime', 'pwdaccountlockedtime', 'pwdgraceusetime',
  // 389 Directory Server operational attributes
  'nsuniqueid', 'parentid', 'entryid', 'dsentrydn', 'nsrole', 'nsroledn', 'passwordexpwarned',
  'passwordretrycount', 'retrycountresettime', 'accountunlocktime',
  'passwordgraceusertime', 'passwordexpirationtime', 'passwordallowchangetime',
  'passwordhistory',
]);

/** userAccountControl ACCOUNTDISABLE flag. */
const UAC_ACCOUNTDISABLE = 0x2;

export interface CopyOptions {
  /**
   * sAMAccountName for a copy of an AD account (the source's name is taken).
   * Without it the source's sAMAccountName and userPrincipalName are left
   * out and AD generates a name. For a computer account (source name ends
   * with "$") a missing trailing "$" is added.
   */
  sAMAccountName?: string;
  /**
   * userPrincipalName of an AD account copy; default: the new
   * sAMAccountName with the source's UPN suffix.
   */
  userPrincipalName?: string;
  /**
   * uid of a copy of an LDAP account (copyLoginFields().uid). The source's
   * uid is a login name and is never kept: without a new one it is left out
   * (unless uid is the RDN attribute, which takes the new RDN value).
   */
  uid?: string;
  /** uidNumber of a POSIX account copy (the source's ID belongs to the source). */
  uidNumber?: string;
  /** Container of the copy; default: the source's parent. */
  parentDN?: string;
}

/** Object classes whose uid is a login name (account copies need a new one). */
const LOGIN_CLASSES = ['posixaccount', 'inetorgperson', 'account', 'shadowaccount', 'person', 'organizationalperson'];

/** Login identity fields an entry copy must get anew. */
export interface CopyLoginFields {
  /** The source has a uid that is a login name (LDAP account) and is not named by it. */
  uid: boolean;
  /**
   * The source is an LDAP account named by its uid ("uid=jdoe,…"): the new
   * RDN value is the copy's login name and needs the duplicate check.
   */
  rdnIsLogin: boolean;
  /** AD account: sAMAccountName (and the UPN derived from it). */
  sAMAccountName: boolean;
  /** AD computer account (sAMAccountName ends with "$"). */
  computer: boolean;
  /** UPN suffix of the source ("@ad.example.org"), '' when it has none. */
  upnSuffix: string;
  /** POSIX account: the copy needs its own uidNumber. */
  posix: boolean;
  /** Source values, for the duplicate check and the home directory. */
  sourceUid: string;
  sourceSAM: string;
}

function firstValue(source: readonly LDAPAttribute[], name: string): string {
  const lower = name.toLowerCase();
  return source.find((a) => a.name.toLowerCase() === lower && !a.binary)?.values[0] ?? '';
}

/** Which login identity attributes a copy of `source` must not take over. */
export function copyLoginFields(source: readonly LDAPAttribute[], rdnAttr = ''): CopyLoginFields {
  const classes = (source.find((a) => a.name.toLowerCase() === 'objectclass')?.values ?? []).map((c) => c.toLowerCase());
  const sourceUid = firstValue(source, 'uid');
  const sourceSAM = firstValue(source, 'sAMAccountName');
  const upn = firstValue(source, 'userPrincipalName');
  const loginClass = classes.some((c) => LOGIN_CLASSES.includes(c));
  return {
    uid: !!sourceUid && rdnAttr.toLowerCase() !== 'uid' && loginClass,
    rdnIsLogin: rdnAttr.toLowerCase() === 'uid' && loginClass,
    sAMAccountName: !!sourceSAM,
    computer: sourceSAM.endsWith('$'),
    upnSuffix: upn.includes('@') ? upn.slice(upn.lastIndexOf('@')) : '',
    posix: classes.includes('posixaccount') && !!firstValue(source, 'uidNumber'),
    sourceUid,
    sourceSAM,
  };
}

/**
 * A login name derived from a display name for LDAP account copies and new
 * users: lowercase ASCII letters/digits, words joined by "." ("Copy of Jürgen
 * Groß" → "copy.of.juergen.gross"), at most 32 characters.
 */
export function suggestUid(name: string): string {
  const folded = name.trim().toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return folded
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 32)
    .replace(/[.-]+$/, '');
}

/**
 * Names of the source's attributes that a copy never takes because they hold
 * secrets (isSensitiveAttributeName: userPassword, authPassword,
 * sambaNTPassword, …), in source order.
 */
export function copySecretAttributes(source: readonly LDAPAttribute[]): string[] {
  return source.filter((a) => isSensitiveAttributeName(a.name)).map((a) => a.name);
}

/**
 * Attributes for a copy of an entry: operational attributes are dropped, the
 * RDN attribute gets the new value (and is added if the source lacks it),
 * everything else (binary values included, still base64 with binary: true)
 * is copied unchanged, except the login identity of accounts: AD accounts
 * get opts.sAMAccountName / userPrincipalName, LDAP accounts opts.uid (the
 * source's uid is never kept), POSIX accounts opts.uidNumber and a home
 * directory ending in the new uid, and a displayName equal to the old name
 * follows the new name. Secrets (copySecretAttributes) are never copied on
 * any server type, so a copy of an account cannot log on with the source's
 * password, also when the source was disabled with state the copy does not
 * take (OpenLDAP pwdAccountLockedTime, 389DS nsRoleDN). AD accounts
 * (sAMAccountName present) get the new sAMAccountName, a userPrincipalName
 * with the source's UPN suffix, and are created disabled.
 */
export function buildCopyAttributes(
  source: readonly LDAPAttribute[],
  rdnAttr: string,
  newRdnValue: string,
  opts: CopyOptions = {},
): LDAPAttribute[] {
  const out: LDAPAttribute[] = [];
  let hasRdnAttr = false;
  let sam = opts.sAMAccountName?.trim();
  const sourceSam = source.find((a) => a.name.toLowerCase() === 'samaccountname')?.values[0] ?? '';
  if (sam && sourceSam.endsWith('$') && !sam.endsWith('$')) sam += '$';
  const login = copyLoginFields(source, rdnAttr);
  const uid = opts.uid?.trim();
  // The copy's login name: opts.uid, or the new RDN value of a uid-named account.
  const newLogin = uid || (login.rdnIsLogin ? newRdnValue.trim() : '');
  const sourceRdnValue = firstValue(source, rdnAttr);
  for (const attr of source) {
    const lower = attr.name.toLowerCase();
    if (COPY_EXCLUDED_ATTRS.has(baseNameLower(attr.name)) || isSensitiveAttributeName(attr.name)) continue;
    if (lower === rdnAttr.toLowerCase()) {
      out.push({ name: attr.name, values: [newRdnValue], binary: false });
      hasRdnAttr = true;
    } else if (lower === 'samaccountname') {
      if (sam) out.push({ name: attr.name, values: [sam], binary: false });
    } else if (lower === 'userprincipalname') {
      const at = (attr.values[0] || '').lastIndexOf('@');
      const upn = opts.userPrincipalName?.trim() || (sam && at >= 0 ? sam + attr.values[0].slice(at) : '');
      if (upn) out.push({ name: attr.name, values: [upn], binary: false });
    } else if (lower === 'uid' && login.uid) {
      // The source's login name never goes to a copy (P-25).
      if (uid) out.push({ name: attr.name, values: [uid], binary: false });
    } else if (lower === 'uidnumber' && login.posix) {
      if (opts.uidNumber?.trim()) out.push({ name: attr.name, values: [opts.uidNumber.trim()], binary: false });
    } else if (lower === 'homedirectory' && login.posix && newLogin && login.sourceUid && !attr.binary) {
      const home = attr.values[0] || '';
      const suffix = '/' + login.sourceUid;
      out.push({ name: attr.name, values: [home.endsWith(suffix) ? home.slice(0, -login.sourceUid.length) + newLogin : home], binary: false });
    } else if ((lower === 'displayname' || lower === 'cn') && !attr.binary && sourceRdnValue && attr.values.length === 1
      && attr.values[0].toLowerCase() === sourceRdnValue.toLowerCase()) {
      // The display name (or the cn of a uid-named entry) followed the name: it follows the copy's name.
      out.push({ name: attr.name, values: [newRdnValue], binary: false });
    } else if (lower === 'useraccountcontrol' && !attr.binary && /^\d+$/.test(attr.values[0] || '')) {
      out.push({ name: attr.name, values: [String(Number(attr.values[0]) | UAC_ACCOUNTDISABLE)], binary: false });
    } else {
      out.push({ name: attr.name, values: [...attr.values], binary: !!attr.binary });
    }
  }
  if (!hasRdnAttr && rdnAttr) out.push({ name: rdnAttr, values: [newRdnValue], binary: false });
  return out;
}

/** Characters AD does not allow in a sAMAccountName. */
const SAM_INVALID = /["/\\[\]:;|=,+*?<>@]/g;

/**
 * A sAMAccountName derived from a name: invalid characters removed, spaces →
 * ".", at most 20 characters. For a computer account: spaces and dots → "-",
 * at most 15 characters (NetBIOS name) plus the trailing "$".
 */
export function suggestSAMAccountName(name: string, computer = false): string {
  const clean = name.replace(SAM_INVALID, '').trim();
  if (computer) {
    const base = clean.replace(/\$+$/, '').replace(/[\s.]+/g, '-').slice(0, 15).replace(/-+$/, '');
    return base ? `${base}$` : '';
  }
  return clean
    .replace(/\s+/g, '.')
    .slice(0, 20)
    .replace(/\.+$/, '');
}

export { parseRDN, escapeDNValue };

/** Splits a DN into its first RDN and the parent DN; escaped commas ("CN=Doe\\, John,…") stay in the RDN. */
export function splitFirstRDN(dn: string): { rdn: string; parent: string } {
  return { rdn: firstRDN(dn), parent: getParentDN(dn) };
}

/**
 * DN of a copy of sourceDN with a new RDN value (same RDN attribute), in
 * parentDN (default: the source's parent).
 */
export function copyTargetDN(sourceDN: string, newRdnValue: string, parentDN?: string): string {
  const { rdn, parent: sourceParent } = splitFirstRDN(sourceDN);
  const parent = parentDN?.trim() || sourceParent;
  const newRdn = `${parseRDN(rdn).attr}=${escapeDNValue(newRdnValue.trim())}`;
  return parent ? `${newRdn},${parent}` : newRdn;
}

/** DN and attributes of a copy of an entry (CopyEntryDialog). */
export function planEntryCopy(
  sourceDN: string,
  source: readonly LDAPAttribute[],
  newRdnValue: string,
  opts: CopyOptions = {},
): { dn: string; attributes: LDAPAttribute[] } {
  const rdnAttr = parseRDN(splitFirstRDN(sourceDN).rdn).attr;
  return {
    dn: copyTargetDN(sourceDN, newRdnValue, opts.parentDN),
    attributes: buildCopyAttributes(source, rdnAttr, newRdnValue.trim(), opts),
  };
}

// --- Edit Entry: input still open when Save is clicked (RW1-E-02) ----------------------

export interface OpenEditInputs {
  /** The add row: attribute and typed text (one value). */
  add?: { attr: string; value: string; password?: boolean } | null;
  /** The inline edit: attribute and text (one value per line); a password counts once confirmed (`ready`). */
  edit?: { attr: string; value: string; password?: boolean; ready?: boolean } | null;
}

export interface StagedOpenInputs {
  /** The working attributes with the typed values staged. */
  attrs: Map<string, string[]>;
  /** Number of open inputs whose text Save would otherwise drop. */
  staged: number;
  /** Attributes that were staged this way (their binary flag no longer applies: password edits). */
  passwordAttrs: string[];
  /** Why Save must wait (a typed password not confirmed yet), else null. */
  blocked: string | null;
}

/**
 * The attributes Edit Entry saves: the working copy plus what the open add
 * row / inline editor holds. A value that was typed but not added with
 * Enter is saved too (it was silently dropped), an unchanged inline editor
 * adds nothing, and a typed but unconfirmed password blocks Save.
 */
export function stageOpenInputs(working: ReadonlyMap<string, string[]>, inputs: OpenEditInputs): StagedOpenInputs {
  const attrs = new Map(working);
  let staged = 0;
  const passwordAttrs: string[] = [];
  let blocked: string | null = null;
  const edit = inputs.edit;
  if (edit?.attr) {
    if (edit.password) {
      if (edit.value) {
        if (edit.ready) {
          attrs.set(edit.attr, [edit.value]);
          passwordAttrs.push(edit.attr);
          staged++;
        } else blocked = `Confirm the new ${edit.attr} (type it twice) or cancel the edit`;
      }
    } else {
      const values = edit.value.split('\n').filter((v) => v.trim() !== '');
      if (!sameValues(values, attrs.get(edit.attr) ?? [])) {
        if (values.length) attrs.set(edit.attr, values);
        else attrs.delete(edit.attr);
        staged++;
      }
    }
  }
  const add = inputs.add;
  if (add?.attr && add.value.trim()) {
    attrs.set(add.attr, [...(attrs.get(add.attr) ?? []), add.password ? add.value : add.value.trim()]);
    staged++;
  }
  return { attrs, staged, passwordAttrs, blocked };
}
