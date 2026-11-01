import type { ServerType } from './ldap'
import type { AccountPolicy } from './account'
import type { EffectivePasswordPolicy } from './passwordPolicy'

/** Password change method - mirrors the Go models.PasswordMethod* constants */
export type PasswordMethod = 'unicodePwd' | 'exop' | 'userPassword';

/** Request of EditorService.SetPassword - mirrors Go models.PasswordChangeRequest */
export interface PasswordChangeRequest {
  dn: string;
  password: string;
  method: PasswordMethod;
  /** Client-side scheme id for method 'userPassword' ("SSHA", "CLEARTEXT", ...) */
  scheme: string;
  /** AD: pwdLastSet=0; OpenLDAP ppolicy: pwdReset=TRUE */
  mustChange: boolean;
  /** AD: lockoutTime=0; OpenLDAP ppolicy: clear pwdAccountLockedTime */
  unlock: boolean;
  /** Bind as the entry with the new password afterwards */
  verifyBind: boolean;
  /** Confirms sending the cleartext password over a connection without TLS (else SetPassword refuses; unicodePwd is always refused without TLS) */
  allowUnencrypted?: boolean;
  /** Enable a disabled account with the reset (AD ACCOUNTDISABLE, 389DS nsAccountLock; OpenLDAP = unlock) */
  enable?: boolean;
}

/** Result of EditorService.SetPassword - mirrors Go models.PasswordChangeResult */
export interface PasswordChangeResult {
  method: PasswordMethod;
  scheme: string;
  /** Scheme of the userPassword value read back after the change ('' if unreadable) */
  storedScheme: string;
  /** storedScheme for display: '{SSHA}', '{CRYPT} SHA-512-crypt ($6$)', 'cleartext' (Go ldap.PasswordSchemeLabel) */
  storedSchemeLabel: string;
  operations: string[];
  warnings: string[];
  verified: boolean;
  verifyError: string;
  /** The new password most likely does not work (re-hashed/unsupported scheme, hashed userPassword on AD, failed bind) */
  ineffective: boolean;
  /** Nothing proves the server can verify the stored value (module needed / support unknown, no verification bind) */
  unconfirmed: boolean;
  /** AD: pwdLastSet=0 was written but is not enforced because the password never expires */
  mustChangeIgnored: boolean;
}

/** 'system': verified by the server host's crypt(3) library ({CRYPT} bcrypt needs libxcrypt) */
export type SchemeSupportLevel = 'native' | 'module' | 'system' | 'no';
export type SchemeSecurity = 'strong' | 'good' | 'weak' | 'none';

/** Mirrors Go models.PasswordSchemeSupport */
export interface PasswordSchemeSupport {
  server: ServerType;
  level: SchemeSupportLevel;
  note: string;
}

/** Client-side userPassword scheme - mirrors Go models.PasswordScheme */
export interface PasswordScheme {
  id: string;
  label: string;
  description: string;
  security: SchemeSecurity;
  support: PasswordSchemeSupport[];
}

/** Server and entry facts for the password dialog - mirrors Go models.PasswordContext */
export interface PasswordContext {
  dn: string;
  serverType: ServerType;
  vendorName: string;
  vendorVersion: string;
  tls: boolean;
  tlsMode: string;
  passwordModifyExop: boolean;
  ppolicyControl: boolean;
  objectClasses: string[];
  isADAccount: boolean;
  hasUserPassword: boolean;
  currentScheme: string;
  /** currentScheme for display (Go ldap.PasswordSchemeLabel) */
  currentSchemeLabel: string;
  locked: boolean;
  mustChange: boolean;
  disabled: boolean;
  /** AD userAccountControl DONT_EXPIRE_PASSWORD: pwdLastSet=0 is not enforced */
  passwordNeverExpires: boolean;
  readOnly: boolean;
  schemes: PasswordScheme[];
  defaultScheme: string;
  /** The connection's password storage policy; preselects method and scheme */
  policy?: EffectivePasswordPolicy;
  /** The entry's effective account policy (requirements, OpenLDAP pwdMustChange); missing when unknown */
  accountPolicy?: AccountPolicy;
  /** sAMAccountName, uid, cn, givenName, sn, displayName (strength meter name check) */
  accountNames?: string[];
}
