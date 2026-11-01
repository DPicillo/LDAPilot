/**
 * Password storage policy (GitHub issue #1) - mirrors Go
 * internal/models/password_policy.go.
 */
import type { AttributeChange, LDAPAttribute, ServerType } from './ldap'
import type { PasswordScheme } from './password'

/** Profile setting (ConnectionProfile.passwordPolicy); '' / 'auto' = default of the server type. */
export type PasswordPolicySetting = '' | 'auto' | 'client' | 'server' | 'ask';

/** Effective policy: 'ad' only on Active Directory (userPassword passed through). */
export type PasswordPolicyMode = 'client' | 'server' | 'ask' | 'ad';

/** Mirrors Go models.EffectivePasswordPolicy */
export interface EffectivePasswordPolicy {
  /** Profile setting, 'auto' when not set */
  configured: string;
  policy: PasswordPolicyMode;
  /** Client-side scheme id (PasswordScheme.id) for 'client' */
  scheme: string;
  schemeLabel: string;
  /** 'profile' | 'default' | 'write' */
  source: string;
  reason: string;
  serverType: ServerType;
  /** The server is known to hash cleartext userPassword values itself */
  serverHashes: boolean;
  serverHashing: string;
  passwordModifyExop: boolean;
  tls: boolean;
  summary: string;
  warnings: string[];
}

/** Per-write decisions - mirrors Go models.PasswordWriteOptions */
export interface PasswordWriteOptions {
  /** Store userPassword values exactly as given (LDIF opt-out) */
  asIs?: boolean;
  /** Answer of the 'ask' policy: 'client' (with scheme) or 'server' */
  policy?: 'client' | 'server';
  scheme?: string;
  /** Confirms sending a cleartext password over a connection without TLS */
  allowUnencrypted?: boolean;
}

/** Mirrors Go models.PasswordWritePlanRequest */
export interface PasswordWritePlanRequest {
  attributes?: LDAPAttribute[];
  changes?: AttributeChange[];
  ldif?: string;
  options: PasswordWriteOptions;
}

/** Mirrors Go models.PasswordWritePlan */
export interface PasswordWritePlan {
  policy: EffectivePasswordPolicy;
  hasPasswords: boolean;
  values: number;
  hashed: number;
  kept: number;
  cleartext: number;
  exop: boolean;
  asIs: boolean;
  cleartextSent: boolean;
  unencrypted: boolean;
  needsConfirm: boolean;
  needsDecision: boolean;
  actions: string[];
  warnings: string[];
}

/** Mirrors Go models.PasswordWriteReport */
export interface PasswordWriteReport {
  actions: string[];
  warnings: string[];
  /** Labels of the userPassword values read back: '{SSHA}', '{CRYPT} SHA-512-crypt ($6$)', 'cleartext' */
  storedSchemes: string[];
  cleartext: boolean;
  ineffective: boolean;
  /** The client-side scheme is not built into the server type: the password may not work */
  unconfirmed: boolean;
  exop: boolean;
}

/** Mirrors Go models.PasswordPolicyDefault */
export interface PasswordPolicyDefault {
  serverType: ServerType;
  policy: PasswordPolicyMode;
  scheme: string;
  reason: string;
}

/** Mirrors Go models.PasswordPolicyCatalog */
export interface PasswordPolicyCatalog {
  schemes: PasswordScheme[];
  defaults: PasswordPolicyDefault[];
}

/** What a write is about, for EditorService.PlanPasswordWrite. */
export type PasswordWriteTarget =
  | { attributes: LDAPAttribute[] }
  | { changes: AttributeChange[] }
  | { ldif: string };
