/**
 * Authentication method for LDAP connections - must match Go AuthMethod.
 * ntlm/kerberos use bindDN as user name and password as password; see
 * types/auth.ts and lib/connectionAuth.ts.
 */
export type AuthMethod = 'none' | 'simple' | 'ntlm' | 'kerberos' | 'external';

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
  /**
   * Ask for the password on every Connect / Reconnect (simple bind with a
   * DN, NTLM, Kerberos with a password): none is stored, a typed one is
   * used for that connect only. Go drops it for methods without a password.
   */
  askPassword?: boolean;

  // Authentication & TLS trust (track auth) - omitted by Go when empty.
  /** NetBIOS domain for NTLM when bindDN is a bare user name. */
  ntlmDomain?: string;
  /** Kerberos credentials: 'password' (default) or 'system' (Windows logon / ticket cache). */
  krbCredSource?: 'password' | 'system';
  krbRealm?: string;
  /** KDC override host[:port]; builds the Kerberos config programmatically (TCP). */
  krbKDC?: string;
  /** SPN override, default ldap/<host>. */
  krbSPN?: string;
  /** Credential cache file for 'system' on Linux/macOS. */
  krbCCache?: string;
  tlsCACertFile?: string;
  tlsCACertPEM?: string;
  tlsClientCertFile?: string;
  tlsClientKeyFile?: string;
  /** SHA-256 fingerprints (AB:CD:...) of trusted server certificates. */
  tlsPinnedCerts?: string[];
  /** When each pin was added (fingerprint → RFC 3339 UTC); older pins have none. */
  tlsPinnedAt?: Record<string, string>;
  /** Subject, issuer and validity per pinned fingerprint (missing for manual and older pins). */
  tlsPinnedInfo?: Record<string, import('./auth').PinnedCertificateInfo>;

  /**
   * Password storage policy (issue #1, types/passwordPolicy.ts): how
   * cleartext userPassword values are stored; omitted = auto (default of the
   * server type). passwordScheme is the client-side scheme for 'client'.
   */
  passwordPolicy?: '' | 'client' | 'server' | 'ask';
  passwordScheme?: string;
}

/** Result of ConnectionService.ExportConnections - mirrors Go ConnectionExportResult. An empty path means cancelled. */
export interface ConnectionExportResult {
  path: string;
  count: number;
}

/** A profile of an import file that was not imported - mirrors Go ConnectionImportSkip. */
export interface ConnectionImportSkip {
  name: string;
  reason: string;
}

/** Result of ConnectionService.ImportConnections - mirrors Go ConnectionImportReport. */
export interface ConnectionImportReport {
  cancelled: boolean;
  path: string;
  /** Profiles in the file. */
  total: number;
  /** Names of the imported profiles. */
  imported: string[];
  /** Skipped: same host, port, bind DN and base DN as a saved profile. */
  duplicates: string[];
  skipped: ConnectionImportSkip[];
  /** Imported profiles that ask for their password on the first connect. */
  needPassword: string[];
  /** Imported profiles that ask for the password on every connect (not in needPassword). */
  askPassword?: string[];
}

/** Tree node representing a DN in the directory tree - mirrors Go TreeNode */
export interface TreeNode {
  dn: string;
  rdn: string;
  hasChildren: boolean;
  objectClass: string[];
  icon: string;
  children?: TreeNode[];
  /**
   * Account states a one-level read tells reliably ('disabled', 'expired';
   * 'locked' for 389DS / OpenLDAP lockouts), for the icon overlay (see Go
   * TreeNode.Status).
   */
  status?: ('disabled' | 'expired' | 'locked')[];
  /**
   * Which login attributes (uid, userPassword, …) an LDAP person without an
   * account class has: [] = none (a contact), null/undefined = unknown (M-06).
   */
  loginAttributes?: string[] | null;
}

/**
 * Single LDAP attribute with name and values - mirrors Go LDAPAttribute.
 * Binary contract: when `binary` is true, every value is standard base64
 * (RFC 4648, padded) of the raw bytes - never decode it into a text field and
 * send it back as text. When false, values are plain text.
 */
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
  /** AD Show Deleted control (1.2.840.113556.1.4.417), sent as critical */
  showDeleted?: boolean;
  /** AD Show Recycled control (1.2.840.113556.1.4.2064), sent as critical */
  showRecycled?: boolean;
  /** ManageDsaIT control (2.16.840.1.113730.3.4.2), sent as critical */
  manageDsaIT?: boolean;
}

/**
 * One change of an atomic modify - mirrors Go models.AttributeChange.
 * `delete` with empty values removes the whole attribute, otherwise only the
 * given values. With `binary: true` values are base64. unicodePwd values are
 * plain-text passwords (delete old + add new = own password change).
 */
export interface AttributeChange {
  operation: 'add' | 'delete' | 'replace';
  attribute: string;
  values: string[];
  binary?: boolean;
}

/** Server type detected from the RootDSE - mirrors Go models.ServerType* */
export type ServerType = 'ad' | 'openldap' | '389ds' | 'other';

/** RootDSE capabilities of a server - mirrors Go models.ServerInfo */
export interface ServerInfo {
  serverType: ServerType;
  vendorName: string;
  vendorVersion: string;
  supportedControls: string[];
  supportedExtensions: string[];
  supportedCapabilities: string[];
  supportedSASLMechanisms: string[];
  namingContexts: string[];
  defaultNamingContext: string;
  rootDomainNamingContext: string;
  configurationNamingContext: string;
  schemaNamingContext: string;
  subschemaSubentry: string;
  dnsHostName: string;
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
  /** Further NAMEs of the class (newPilotPerson for pilotPerson); must/may/superClass hold primary names. */
  aliases?: string[];
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
  /** Further NAMEs of the type ("surname" for sn); accepted where a name is typed. */
  aliases?: string[];
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
