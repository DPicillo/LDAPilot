/** Authentication method for LDAP connections - must match Go AuthMethod */
export type AuthMethod = 'none' | 'simple';

/** TLS mode for LDAP connections - must match Go TLSMode */
export type TLSMode = 'none' | 'ssl' | 'starttls';

/** LDAP search scope - must match Go SearchScope */
export type SearchScope = 0 | 1 | 2;
export const ScopeBase: SearchScope = 0;
export const ScopeOne: SearchScope = 1;
export const ScopeSub: SearchScope = 2;

/** Connection profile representing a saved LDAP server configuration - mirrors Go ConnectionProfile */
export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  baseDN: string;
  authMethod: AuthMethod;
  bindDN: string;
  password: string;
  hasPassword: boolean;
  tlsMode: TLSMode;
  tlsSkipVerify: boolean;
  pageSize: number;
  timeout: number;
  readOnly: boolean;
  disableReferrals: boolean;
}

/** Tree node representing a DN in the directory tree - mirrors Go TreeNode */
export interface TreeNode {
  dn: string;
  rdn: string;
  hasChildren: boolean;
  objectClass: string[];
  icon: string;
  children?: TreeNode[];
}

/** Single LDAP attribute with name and values - mirrors Go LDAPAttribute */
export interface LDAPAttribute {
  name: string;
  values: string[];
  binary: boolean;
}

/** Full LDAP entry with DN and attributes - mirrors Go LDAPEntry */
export interface LDAPEntry {
  dn: string;
  attributes: LDAPAttribute[];
}

/** Search parameters for LDAP search operations - mirrors Go SearchParams */
export interface SearchParams {
  baseDN: string;
  filter: string;
  scope: SearchScope;
  attributes: string[];
  sizeLimit: number;
  timeLimit: number;
}

/** Search result containing matching entries - mirrors Go SearchResult */
export interface SearchResult {
  entries: LDAPEntry[];
  totalCount: number;
  truncated: boolean;
}

/** Schema objectClass definition - mirrors Go SchemaObjectClass */
export interface SchemaObjectClass {
  oid: string;
  name: string;
  description: string;
  superClass: string[];
  kind: string;
  must: string[];
  may: string[];
}

/** Schema attribute definition - mirrors Go SchemaAttribute */
export interface SchemaAttribute {
  oid: string;
  name: string;
  description: string;
  syntax: string;
  syntaxName: string;
  singleValue: boolean;
  noUserMod: boolean;
  usage: string;
  superType: string;
  equality: string;
  ordering: string;
  substring: string;
}

/** Full schema info - mirrors Go SchemaInfo */
export interface SchemaInfo {
  objectClasses: SchemaObjectClass[];
  attributes: SchemaAttribute[];
}

/** ObjectClass details with inheritance info - mirrors Go ObjectClassInfo */
export interface ObjectClassInfo {
  name: string;
  oid: string;
  description: string;
  superior: string[];
  must: string[];
  may: string[];
  type: string;
}

/** Schema validation error - mirrors Go ValidationError */
export interface ValidationError {
  attribute: string;
  message: string;
  type: string;
}

/** LDIF import result - mirrors Go ldif.ImportResult */
export interface ImportResult {
  entries: LDAPEntry[];
  total: number;
  succeeded: number;
  failed: number;
  errors: string[];
}

/** Result of a batch operation - mirrors Go BatchResult */
export interface BatchResult {
  total: number;
  succeeded: number;
  failed: number;
  errors: BatchError[];
}

/** Single error from a batch operation - mirrors Go BatchError */
export interface BatchError {
  dn: string;
  message: string;
}

/** Attribute change for batch modify - mirrors Go BatchModifyChange */
export interface BatchModifyChange {
  operation: 'add' | 'replace' | 'delete';
  attribute: string;
  values: string[];
}

/** Default empty connection profile */
export function newConnectionProfile(): ConnectionProfile {
  return {
    id: '',
    name: '',
    host: '',
    port: 389,
    baseDN: '',
    authMethod: 'simple',
    bindDN: '',
    password: '',
    hasPassword: false,
    tlsMode: 'none',
    tlsSkipVerify: false,
    pageSize: 500,
    timeout: 10,
    readOnly: false,
    disableReferrals: false,
  };
}
