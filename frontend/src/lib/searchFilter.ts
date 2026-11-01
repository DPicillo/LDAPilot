/**
 * Builds LDAP search filters from user input (RFC 4515).
 *
 * Semantics shared by every search box of the app:
 * - Text is matched literally: `*`, `(`, `)`, `\` and NUL are escaped as
 *   `\2a`, `\28`, `\29`, `\5c`, `\00` (escapeFilterValue). Wildcards are added
 *   only by the chosen match type (contains / starts with / ends with).
 * - Leading and trailing blanks are ignored.
 * - In the quick searches (search panel, tree search) input that starts with
 *   "(" is a raw LDAP filter: it is validated on the server (ValidateFilter)
 *   and sent unchanged.
 */
import { escapeFilterValue, parseFilter, FilterParseError, type FilterNode } from './ldapFilter.ts'
import type { MatchType, QuickSearchInput } from '../types/treesearch'
import type { ServerType } from '../types/ldap'

/**
 * Classifies quick-search input as empty, raw LDAP filter or literal text.
 * `forceText` treats input starting with "(" as literal text as well
 * ("Search as text instead").
 */
export function parseQuickSearchInput(input: string, forceText = false): QuickSearchInput {
  const text = input.trim();
  if (!text) return { kind: 'empty', text };
  return { kind: text.startsWith('(') && !forceText ? 'raw' : 'text', text };
}

/**
 * True for an attribute description usable in a filter: a name (letters,
 * digits, '-', '_') or a numeric OID, optionally followed by ;options.
 */
export function isValidAttributeDescription(attr: string): boolean {
  return /^(?:[A-Za-z][\w-]*|\d+(?:\.\d+)+)(?:;[\w-]+)*$/.test(attr);
}

/**
 * Filter matching `value` literally in `attribute` according to `match`.
 * An empty value matches any entry that has the attribute.
 */
export function buildMatchFilter(attribute: string, value: string, match: MatchType): string {
  if (!value) return `(${attribute}=*)`;
  const v = escapeFilterValue(value);
  switch (match) {
    case 'contains': return `(${attribute}=*${v}*)`;
    case 'startsWith': return `(${attribute}=${v}*)`;
    case 'endsWith': return `(${attribute}=*${v})`;
    case 'exact': return `(${attribute}=${v})`;
  }
}

/** Filter matching `value` literally in any of `attributes` (OR). */
export function buildAnyAttributeFilter(attributes: string[], value: string, match: MatchType = 'contains'): string {
  const parts = attributes.map(a => buildMatchFilter(a, value.trim(), match));
  return parts.length === 1 ? parts[0] : `(|${parts.join('')})`;
}

/**
 * Quick-search filter for literal text: `attribute` matched by `match`,
 * ANDed with `objectTypeFilter` (a complete filter such as
 * "(objectClass=person)", or '' for all types).
 */
export function buildQuickFilter(text: string, attribute: string, match: MatchType, objectTypeFilter: string): string {
  const value = text.trim();
  if (!value) return objectTypeFilter || '(objectClass=*)';
  const attrFilter = buildMatchFilter(attribute, value, match);
  return andWithTypeFilter(objectTypeFilter, attrFilter);
}

/**
 * Attributes of "Any name" on a server that is neither AD nor known as a
 * plain LDAP server (AD uses ambiguous name resolution).
 */
export const ANY_NAME_ATTRIBUTES = ['cn', 'displayName', 'uid', 'mail', 'givenName', 'sn', 'ou', 'sAMAccountName', 'userPrincipalName'];

/** "Any name" on OpenLDAP / 389 Directory Server: no AD-only attributes. */
export const ANY_NAME_LDAP_ATTRIBUTES = ['cn', 'displayName', 'uid', 'mail', 'givenName', 'sn', 'ou'];

/** True for the server types that never have AD attributes (sAMAccountName, userPrincipalName, objectCategory). */
export function isPlainLDAP(serverType: ServerType | null | undefined): boolean {
  return serverType === 'openldap' || serverType === '389ds';
}

/** Value of the "Any name" entry of the quick search's "Search in" list. */
export const QUICK_ANY_NAME = '*any';

/** "Search in" choices of the quick search for a server type (no AD-only attributes on LDAP servers, no uid on AD). */
export function quickSearchAttributes(serverType: ServerType | null | undefined): { value: string; label: string }[] {
  const ad = serverType === 'ad';
  const ldap = isPlainLDAP(serverType);
  return [
    { value: QUICK_ANY_NAME, label: 'Any name' },
    { value: 'cn', label: 'Name (cn)' },
    ...(ldap ? [] : [{ value: 'sAMAccountName', label: 'Login (sAMAccountName)' }]),
    ...(ad ? [] : [{ value: 'uid', label: 'Login (uid)' }]),
    { value: 'displayName', label: 'Display name' },
    { value: 'mail', label: 'E-mail' },
    ...(ldap ? [] : [{ value: 'userPrincipalName', label: 'UPN' }]),
    { value: 'sn', label: 'Surname (sn)' },
    { value: 'givenName', label: 'First name' },
    { value: 'description', label: 'Description' },
    { value: 'telephoneNumber', label: 'Phone' },
  ];
}

/** Object type of the quick search and the filter builder ('' = all types). */
export type QuickObjectType = '' | 'users' | 'contacts' | 'groups' | 'computers' | 'ous';

/**
 * Object types offered for a server type. Active Directory: users (persons
 * that are user objects: no contacts, computers or service accounts),
 * contacts, groups, computers; LDAP servers: users (inetOrgPerson,
 * posixAccount, account), groups (groupOfNames, groupOfUniqueNames,
 * posixGroup, groupOfURLs), computers (device, ipHost); OUs everywhere.
 */
export function quickObjectTypes(serverType: ServerType | null | undefined): { value: QuickObjectType; label: string }[] {
  const ad = serverType === 'ad';
  return [
    { value: '', label: 'All types' },
    { value: 'users', label: 'Users' },
    // LDAP servers have contacts too: persons without a login (M-06, RW3-S-04).
    { value: 'contacts', label: 'Contacts' },
    { value: 'groups', label: 'Groups' },
    { value: 'computers', label: ad ? 'Computers' : 'Computers (devices, hosts)' },
    { value: 'ous', label: 'OUs' },
  ];
}

/** The filter of an object type on a server type ('' for all types or a type the server does not have). */
export function quickObjectTypeFilter(type: QuickObjectType | string, serverType: ServerType | null | undefined): string {
  const ad = serverType === 'ad';
  switch (type) {
    // LDAP: an inetOrgPerson is a user with a login (uid), else a contact — the rule the results'
    // Type column uses (RW3-S-04: "Users" listed the login-less persons typed "Contact").
    case 'users':
      return ad ? '(&(objectCategory=person)(objectClass=user))' : '(|(&(objectClass=inetOrgPerson)(uid=*))(objectClass=posixAccount)(objectClass=account))';
    case 'contacts':
      return ad ? '(objectClass=contact)' : '(&(objectClass=inetOrgPerson)(!(uid=*))(!(objectClass=posixAccount)))';
    case 'groups':
      return ad ? '(objectClass=group)' : '(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup)(objectClass=groupOfURLs))';
    case 'computers':
      return ad ? '(objectClass=computer)' : '(|(objectClass=device)(objectClass=ipHost))';
    case 'ous':
      return '(objectClass=organizationalUnit)';
    default:
      return '';
  }
}

/**
 * Combines an object type filter with a condition: AND, with the parts of
 * an AND type filter merged in ("(&(objectCategory=person)(objectClass=user)(cn=*a*))").
 */
export function andWithTypeFilter(typeFilter: string, filter: string): string {
  if (!typeFilter) return filter;
  if (!filter) return typeFilter;
  const parts = typeFilter.startsWith('(&') ? splitTopLevel(typeFilter.slice(2, -1)) : [typeFilter];
  return `(&${parts.join('')}${filter})`;
}

/** The parenthesised items of a filter list "(a)(b)(c)" (top level only). */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '(') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0 && start >= 0) out.push(list.slice(start, i + 1));
    }
  }
  return out;
}

/**
 * Quick-search filter for "Any name": on Active Directory `(anr=text)`
 * (ambiguous name resolution: names, login and mail starting with the text;
 * the match type does not apply), elsewhere the text matched by `match` in
 * any of ANY_NAME_ATTRIBUTES (ANY_NAME_LDAP_ATTRIBUTES on OpenLDAP / 389DS:
 * no AD-only attributes). `ad` is the server type, or a boolean "is AD"
 * (older callers). ANDed with `objectTypeFilter` like buildQuickFilter.
 */
export function buildAnyNameFilter(text: string, match: MatchType, ad: boolean | ServerType | null, objectTypeFilter: string): string {
  const value = text.trim();
  if (!value) return objectTypeFilter || '(objectClass=*)';
  const isAD = ad === true || ad === 'ad';
  // A boolean (older callers: "is AD") does not know the server type: all name attributes.
  const attrs = typeof ad === 'string' && isPlainLDAP(ad) ? ANY_NAME_LDAP_ATTRIBUTES : ANY_NAME_ATTRIBUTES;
  const nameFilter = isAD ? `(anr=${escapeFilterValue(value)})` : buildAnyAttributeFilter(attrs, value, match);
  return andWithTypeFilter(objectTypeFilter, nameFilter);
}

/**
 * "Search names containing …": the text anywhere in the name attributes
 * (offered when an AD name resolution search, which matches prefixes only,
 * found nothing).
 */
export function buildNameContainsFilter(text: string, serverType: ServerType | null | undefined, objectTypeFilter: string): string {
  const value = text.trim();
  if (!value) return objectTypeFilter || '(objectClass=*)';
  const attrs = serverType === 'ad'
    ? ['cn', 'displayName', 'sAMAccountName', 'userPrincipalName', 'mail', 'givenName', 'sn', 'name']
    : isPlainLDAP(serverType) ? ANY_NAME_LDAP_ATTRIBUTES : ANY_NAME_ATTRIBUTES;
  return andWithTypeFilter(objectTypeFilter, buildAnyAttributeFilter(attrs, value, 'contains'));
}

/**
 * Operators of the filter builder. Negations build a NOT of one item:
 * `!=` → (!(a=v)), `notPresent` → (!(a=*)); `bitAnd` / `bitNotSet` are the
 * AD bitwise AND matching rule (1.2.840.113556.1.4.803: all bits of the
 * value set) and its negation, e.g. userAccountControl bit 2 = disabled.
 */
export type BuilderOperator = '=' | '!=' | '~=' | '>=' | '<=' | 'present' | 'notPresent' | 'substring' | 'startsWith' | 'endsWith' | 'bitAnd' | 'bitNotSet';

/** OID of the AD bitwise AND matching rule (LDAP_MATCHING_RULE_BIT_AND). */
export const BIT_AND_RULE = '1.2.840.113556.1.4.803';

/**
 * The attribute field of a filter-builder condition:
 * - `plain`: an attribute description ("cn", "cn;lang-de", "2.5.4.3")
 * - `extensible`: an RFC 4515 extensible match, everything before "=":
 *   `attr[:dn][:rule]:` or `[:dn]:rule:`, e.g.
 *   "userAccountControl:1.2.840.113556.1.4.803:" (AD bitwise AND) or
 *   "memberOf:1.2.840.113556.1.4.1941:" (AD in-chain). The trailing ":" may
 *   be omitted when typing; `attr` always ends with it.
 * - `invalid`: neither; `reason` says why.
 */
export type BuilderAttribute =
  | { kind: 'plain'; attr: string }
  | { kind: 'extensible'; attr: string }
  | { kind: 'invalid'; reason: string };

const NAME_OR_OID = '(?:[A-Za-z][\\w-]*|\\d+(?:\\.\\d+)+)';
const EXTENSIBLE_RE = new RegExp(`^(${NAME_OR_OID}(?:;[\\w-]+)*)?(:dn)?(?::(${NAME_OR_OID}))?$`, 'i');

/** Classifies the attribute field of a filter-builder condition. */
export function parseBuilderAttribute(input: string): BuilderAttribute {
  const attr = input.trim();
  if (!attr) return { kind: 'invalid', reason: 'Attribute missing' };
  if (!attr.includes(':')) {
    return isValidAttributeDescription(attr)
      ? { kind: 'plain', attr }
      : { kind: 'invalid', reason: `Invalid attribute "${attr}"` };
  }
  const body = attr.endsWith(':') ? attr.slice(0, -1) : attr;
  const m = EXTENSIBLE_RE.exec(body);
  // "attr:dn:rule", "attr:rule", "attr:dn", "attr", ":dn:rule", ":rule" (a rule is required without attr)
  if (!m || (!m[1] && !m[3])) {
    return { kind: 'invalid', reason: `Invalid extensible match "${attr}" (expected attr:rule: or attr:dn:rule:)` };
  }
  return { kind: 'extensible', attr: body + ':' };
}

/**
 * Why a filter-builder condition cannot be built, or null when it can.
 * Extensible matches only support "equals" (`attr:rule:=value`).
 */
export function conditionProblem(attribute: string, operator: BuilderOperator, value?: string): string | null {
  const parsed = parseBuilderAttribute(attribute);
  if (parsed.kind === 'invalid') return parsed.reason;
  if (parsed.kind === 'extensible' && operator !== '=' && operator !== '!=') {
    return `Extensible match "${parsed.attr}" works only with "equals" or "not equals"`;
  }
  if ((operator === 'bitAnd' || operator === 'bitNotSet') && value !== undefined && !/^\d+$/.test(value.trim())) {
    return `Bit value of ${parsed.kind === 'plain' ? parsed.attr : attribute} must be a number`;
  }
  return null;
}

/**
 * One filter-builder condition. Values are literal (escaped); returns '' for
 * a condition that cannot be expressed (see conditionProblem).
 */
export function buildConditionFilter(attribute: string, operator: BuilderOperator, value: string): string {
  if (conditionProblem(attribute, operator, value)) return '';
  const parsed = parseBuilderAttribute(attribute);
  if (parsed.kind !== 'plain' && parsed.kind !== 'extensible') return '';
  const attr = parsed.attr;
  switch (operator) {
    case 'present': return `(${attr}=*)`;
    case 'notPresent': return `(!(${attr}=*))`;
    case 'substring': return buildMatchFilter(attr, value, 'contains');
    case 'startsWith': return buildMatchFilter(attr, value, 'startsWith');
    case 'endsWith': return buildMatchFilter(attr, value, 'endsWith');
    case '!=': return `(!(${attr}=${escapeFilterValue(value)}))`;
    case 'bitAnd': return `(${attr}:${BIT_AND_RULE}:=${value.trim()})`;
    case 'bitNotSet': return `(!(${attr}:${BIT_AND_RULE}:=${value.trim()}))`;
    default: return `(${attr}${operator}${escapeFilterValue(value)})`;
  }
}

/**
 * Combines sub-filters with &, | or !. A NOT over several parts negates
 * their AND, since (!...) takes exactly one filter. Returns '' when there
 * is nothing to combine: never a match-all filter, so dropping the parts of
 * a NOT cannot turn it into "match everything".
 */
export function combineFilters(operator: '&' | '|' | '!', parts: string[]): string {
  const items = parts.filter(Boolean);
  if (items.length === 0) return '';
  if (operator === '!') {
    return `(!${items.length === 1 ? items[0] : `(&${items.join('')})`})`;
  }
  return items.length === 1 ? items[0] : `(${operator}${items.join('')})`;
}

/** A condition of the filter builder. */
export interface BuilderCondition {
  attribute: string;
  operator: BuilderOperator;
  value: string;
}

/** A group of the filter builder: conditions and sub-groups joined by &, | or !. */
export interface BuilderGroup {
  operator: '&' | '|' | '!';
  conditions: (BuilderCondition | BuilderGroup)[];
}

/** Result of buildBuilderFilter: a filter, or '' plus what is wrong. */
export interface BuilderFilterResult {
  filter: string;
  problems: string[];
}

function isBuilderGroup(item: BuilderCondition | BuilderGroup): item is BuilderGroup {
  return 'conditions' in item;
}

/**
 * Builds the filter of a filter-builder tree. Nothing is dropped silently:
 * an invalid condition or an empty group (other than an empty AND/OR root,
 * which means "all entries") makes `filter` '' and is listed in `problems`.
 */
const VALUE_REQUIRED: ReadonlySet<BuilderOperator> = new Set<BuilderOperator>(['=', '!=', '>=', '<=']);

export function buildBuilderFilter(root: BuilderGroup): BuilderFilterResult {
  const problems: string[] = [];
  const build = (group: BuilderGroup, isRoot: boolean): string => {
    if (group.conditions.length === 0) {
      if (isRoot && group.operator !== '!') return '(objectClass=*)';
      problems.push(group.operator === '!' ? 'NOT group without a condition' : 'Empty group: add a condition or remove it');
      return '';
    }
    const parts = group.conditions.map(item => {
      if (isBuilderGroup(item)) return build(item, false);
      const problem = conditionProblem(item.attribute, item.operator, item.value);
      if (problem) {
        problems.push(problem);
        return '';
      }
      // "(mail=)" is never what was meant: equality and ordering need a value (RW1-S-08).
      if (VALUE_REQUIRED.has(item.operator) && item.value.trim() === '') {
        problems.push(`Value missing for ${item.attribute.trim()}`);
        return '';
      }
      return buildConditionFilter(item.attribute, item.operator, item.value);
    });
    return combineFilters(group.operator, parts);
  };
  const filter = build(root, true);
  const unique = [...new Set(problems)];
  return { filter: unique.length > 0 ? '' : filter, problems: unique };
}

/**
 * The filter-builder tree of an existing filter (the builder opens with the
 * current filter, SPEC UX-19), or why the builder cannot show it. Building
 * the returned tree with buildBuilderFilter gives an equivalent filter
 * (values re-escaped, e.g. `\c3\bc` comes back as `ü`).
 */
export function builderGroupFromFilter(filter: string): { group: BuilderGroup } | { error: string } {
  let node: FilterNode;
  try {
    node = parseFilter(filter);
  } catch (err) {
    return { error: err instanceof FilterParseError ? err.message : 'The filter cannot be parsed' };
  }
  const unsupported: string[] = [];
  const item = (n: FilterNode): BuilderCondition | BuilderGroup | null => {
    switch (n.type) {
      case 'and':
      case 'or':
        return { operator: n.type === 'and' ? '&' : '|', conditions: n.children.map(item).filter((x): x is BuilderCondition | BuilderGroup => !!x) };
      case 'not': {
        // NOT of one item: the negated operators
        const c = n.child;
        if (c.type === 'present') return { attribute: c.attr, operator: 'notPresent', value: '' };
        if (c.type === 'equality') return { attribute: c.attr, operator: '!=', value: c.value };
        if (c.type === 'extensible') {
          const bit = bitAndAttribute(c.attr, c.value);
          return bit ? { attribute: bit, operator: 'bitNotSet', value: c.value } : { attribute: c.attr, operator: '!=', value: c.value };
        }
        return { operator: '!', conditions: (c.type === 'and' ? c.children : [c]).map(item).filter((x): x is BuilderCondition | BuilderGroup => !!x) };
      }
      case 'present':
        return { attribute: n.attr, operator: 'present', value: '' };
      case 'equality':
        return { attribute: n.attr, operator: '=', value: n.value };
      case 'extensible': {
        const bit = bitAndAttribute(n.attr, n.value);
        return bit ? { attribute: bit, operator: 'bitAnd', value: n.value } : { attribute: n.attr, operator: '=', value: n.value };
      }
      case 'approx':
        return { attribute: n.attr, operator: '~=', value: n.value };
      case 'greaterOrEqual':
        return { attribute: n.attr, operator: '>=', value: n.value };
      case 'lessOrEqual':
        return { attribute: n.attr, operator: '<=', value: n.value };
      case 'substring': {
        if (n.initial !== undefined && n.final === undefined && n.any.length === 0) return { attribute: n.attr, operator: 'startsWith', value: n.initial };
        if (n.initial === undefined && n.final !== undefined && n.any.length === 0) return { attribute: n.attr, operator: 'endsWith', value: n.final };
        if (n.initial === undefined && n.final === undefined && n.any.length === 1) return { attribute: n.attr, operator: 'substring', value: n.any[0] };
        unsupported.push(`${n.attr} with a wildcard pattern of several parts`);
        return null;
      }
    }
  };
  const root = item(node);
  if (unsupported.length || !root) {
    return { error: `The builder cannot show ${unsupported[0] ?? 'this filter'}; edit it as text instead.` };
  }
  if ('conditions' in root) return { group: root };
  return { group: { operator: '&', conditions: [root] } };
}

/**
 * The plain attribute of an extensible match with the bitwise AND rule and
 * a numeric value ("userAccountControl:1.2.840.113556.1.4.803:" → "userAccountControl"), else null.
 */
function bitAndAttribute(attr: string, value: string): string | null {
  const m = /^([A-Za-z][\w-]*):1\.2\.840\.113556\.1\.4\.803:$/.exec(attr);
  return m && /^\d+$/.test(value) ? m[1] : null;
}

/**
 * Splits the object type off a builder tree: when the root is an AND whose
 * direct items contain every part of one of the server's object type
 * filters, they are removed and the type is returned (the builder shows it
 * in its Object type field). `rest` is the remaining tree.
 */
export function extractObjectType(root: BuilderGroup, serverType: ServerType | null | undefined): { type: QuickObjectType; rest: BuilderGroup } {
  if (root.operator !== '&') return { type: '', rest: root };
  const built = root.conditions.map((c) => ('conditions' in c ? buildBuilderFilter(c).filter : buildConditionFilter(c.attribute, c.operator, c.value)).toLowerCase());
  for (const opt of quickObjectTypes(serverType)) {
    const f = quickObjectTypeFilter(opt.value, serverType);
    if (!f) continue;
    const parts = (f.startsWith('(&') ? splitTopLevel(f.slice(2, -1)) : [f]).map((p) => p.toLowerCase());
    const idx = parts.map((p) => built.indexOf(p));
    if (idx.every((i) => i >= 0) && new Set(idx).size === parts.length) {
      return { type: opt.value, rest: { operator: '&', conditions: root.conditions.filter((_, i) => !idx.includes(i)) } };
    }
  }
  return { type: '', rest: root };
}

/**
 * The builder's filter with an object type: the type filter ANDed with the
 * built tree (an empty AND root means "all entries of the type").
 */
export function buildBuilderFilterWithType(root: BuilderGroup, type: QuickObjectType | string, serverType: ServerType | null | undefined): BuilderFilterResult {
  const typeFilter = quickObjectTypeFilter(type, serverType);
  if (!typeFilter) return buildBuilderFilter(root);
  if (root.conditions.length === 0 && root.operator !== '!') return { filter: typeFilter, problems: [] };
  const r = buildBuilderFilter(root);
  if (r.problems.length) return r;
  // Merge the items of an AND root into the type's AND.
  const inner = root.operator === '&' && r.filter.startsWith('(&') ? splitTopLevel(r.filter.slice(2, -1)).join('') : r.filter;
  return { filter: andWithTypeFilter(typeFilter, inner), problems: [] };
}
