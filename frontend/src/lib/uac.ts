/**
 * Active Directory userAccountControl flags for the flag editor: what each
 * flag means, which ones weaken security when set (danger), and which ones
 * cannot be edited here (readOnly; the backend refuses them as well, see
 * uacProtectedBits in internal/ldap/account_ad.go).
 */

export interface UacFlagInfo {
  bit: number;
  name: string;
  label: string;
  description: string;
  /** Why setting this flag is a security risk. */
  danger?: string;
  /** Why clearing this protective flag weakens the account. */
  protective?: string;
  /** Why the flag cannot be changed in the editor. */
  readOnly?: string;
}

const ACCOUNT_TYPE = 'Account type flag; changing the account type is not supported here.';

export const UAC_FLAG_INFO: UacFlagInfo[] = [
  { bit: 0x0001, name: 'SCRIPT', label: 'Run logon script', description: 'Legacy flag: the logon script is run. Has no effect on current Windows versions.' },
  { bit: 0x0002, name: 'ACCOUNTDISABLE', label: 'Account disabled', description: 'The account is disabled and cannot log on.' },
  { bit: 0x0008, name: 'HOMEDIR_REQUIRED', label: 'Home folder required', description: 'Legacy flag: a home folder is required.' },
  { bit: 0x0010, name: 'LOCKOUT', label: 'Locked out', description: 'The account is locked out.', readOnly: 'Computed by the domain controller; use "Unlock" instead.' },
  {
    bit: 0x0020, name: 'PASSWD_NOTREQD', label: 'Password not required',
    description: 'The account may have an empty password, regardless of the password policy.',
    danger: 'Allows an empty password for this account.',
  },
  { bit: 0x0040, name: 'PASSWD_CANT_CHANGE', label: 'User cannot change password', description: 'The user cannot change the password.', readOnly: 'Stored as a permission (ACE) on the object, not in userAccountControl; AD ignores this bit.' },
  {
    bit: 0x0080, name: 'ENCRYPTED_TEXT_PWD_ALLOWED', label: 'Reversible encryption',
    description: 'The password is stored with reversible encryption.',
    danger: 'The password is stored reversibly, which is equivalent to storing it in clear text.',
  },
  { bit: 0x0100, name: 'TEMP_DUPLICATE_ACCOUNT', label: 'Temporary duplicate account', description: 'Local account for users whose primary account is in another domain.', readOnly: ACCOUNT_TYPE },
  { bit: 0x0200, name: 'NORMAL_ACCOUNT', label: 'Normal account', description: 'A normal user account.', readOnly: ACCOUNT_TYPE },
  { bit: 0x0800, name: 'INTERDOMAIN_TRUST_ACCOUNT', label: 'Interdomain trust account', description: 'Trust account of a domain that trusts this one.', readOnly: ACCOUNT_TYPE },
  { bit: 0x1000, name: 'WORKSTATION_TRUST_ACCOUNT', label: 'Workstation trust account', description: 'Computer account of a workstation or member server.', readOnly: ACCOUNT_TYPE },
  { bit: 0x2000, name: 'SERVER_TRUST_ACCOUNT', label: 'Server trust account', description: 'Computer account of a domain controller.', readOnly: ACCOUNT_TYPE },
  { bit: 0x10000, name: 'DONT_EXPIRE_PASSWORD', label: 'Password never expires', description: 'The password never expires, regardless of the maximum password age.' },
  { bit: 0x20000, name: 'MNS_LOGON_ACCOUNT', label: 'MNS logon account', description: 'Majority Node Set (cluster) logon account.' },
  {
    bit: 0x40000, name: 'SMARTCARD_REQUIRED', label: 'Smart card required',
    description: 'Interactive logon requires a smart card. Depending on the domain configuration AD sets a random password.',
    protective: 'Without it the account can log on with a password again (set a new password first).',
  },
  {
    bit: 0x80000, name: 'TRUSTED_FOR_DELEGATION', label: 'Trusted for delegation (unconstrained)',
    description: 'Services running as this account receive the Kerberos TGT of connecting users.',
    danger: 'Unconstrained delegation: whoever controls this account can impersonate every user who connects to it, anywhere in the forest.',
  },
  {
    bit: 0x100000, name: 'NOT_DELEGATED', label: 'Sensitive, cannot be delegated',
    description: 'The account cannot be delegated by a service (protective).',
    protective: 'Services trusted for delegation can then act as this account (recommended on for administrator accounts).',
  },
  {
    bit: 0x200000, name: 'USE_DES_KEY_ONLY', label: 'Use DES keys only',
    description: 'Restricts Kerberos to DES encryption.',
    danger: 'DES is broken; tickets for this account can be cracked easily.',
  },
  {
    bit: 0x400000, name: 'DONT_REQ_PREAUTH', label: 'No Kerberos pre-authentication',
    description: 'Kerberos pre-authentication is not required.',
    danger: 'Anyone can request an AS-REP for this account and crack the password offline (AS-REP roasting).',
  },
  { bit: 0x800000, name: 'PASSWORD_EXPIRED', label: 'Password expired', description: 'The password has expired.', readOnly: 'Computed by the domain controller; use "Require password change" instead.' },
  {
    bit: 0x1000000, name: 'TRUSTED_TO_AUTH_FOR_DELEGATION', label: 'Trusted to authenticate for delegation',
    description: 'Protocol transition: the account may obtain tickets on behalf of any user for the services in msDS-AllowedToDelegateTo.',
    danger: 'Lets this account impersonate any user (without their password) to the services it may delegate to.',
  },
  {
    bit: 0x2000000, name: 'NO_AUTH_DATA_REQUIRED', label: 'No PAC required',
    description: 'Service tickets for this account do not contain a PAC (authorization data).',
  },
  { bit: 0x4000000, name: 'PARTIAL_SECRETS_ACCOUNT', label: 'Read-only DC account', description: 'Computer account of a read-only domain controller.', readOnly: ACCOUNT_TYPE },
  { bit: 0x8000000, name: 'USE_AES_KEYS', label: 'Use AES keys', description: 'Legacy flag: use AES keys for Kerberos.' },
];

/** Bits the editor never changes (computed, ACL based or account type). */
export const UAC_READONLY_MASK = UAC_FLAG_INFO.filter(f => f.readOnly).reduce((m, f) => m | f.bit, 0);

/** Sets or clears bit in value. */
export function setUacBit(value: number, bit: number, on: boolean): number {
  return on ? (value | bit) >>> 0 : (value & ~bit) >>> 0;
}

/** "0x200 (512)" */
export function formatUac(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase()} (${value >>> 0})`;
}

export interface UacDiff {
  added: UacFlagInfo[];
  removed: UacFlagInfo[];
  /** Added flags that weaken security. */
  dangerousAdded: UacFlagInfo[];
  /** Cleared protective flags (NOT_DELEGATED, SMARTCARD_REQUIRED): they weaken security too. */
  dangerousRemoved: UacFlagInfo[];
  /** Changed bits without a known flag. */
  unknownBits: number;
}

/** Flags added and removed between two userAccountControl values. */
export function diffUac(oldValue: number, newValue: number): UacDiff {
  const changed = (oldValue ^ newValue) >>> 0;
  const added: UacFlagInfo[] = [];
  const removed: UacFlagInfo[] = [];
  let known = 0;
  for (const f of UAC_FLAG_INFO) {
    known |= f.bit;
    if (!(changed & f.bit)) continue;
    if (newValue & f.bit) added.push(f);
    else removed.push(f);
  }
  return {
    added,
    removed,
    dangerousAdded: added.filter(f => f.danger),
    dangerousRemoved: removed.filter(f => f.protective),
    unknownBits: (changed & ~known) >>> 0,
  };
}

/** Whether the change weakens the account: a risky flag set or a protective flag cleared. */
export function uacChangeWeakens(d: UacDiff): boolean {
  return d.dangerousAdded.length > 0 || d.dangerousRemoved.length > 0;
}

/** One-line summary of a diff for the confirmation dialog. */
export function describeUacDiff(oldValue: number, newValue: number): string {
  const d = diffUac(oldValue, newValue);
  const parts: string[] = [`userAccountControl ${formatUac(oldValue)} -> ${formatUac(newValue)}`];
  if (d.added.length) parts.push('set: ' + d.added.map(f => f.name).join(', '));
  if (d.removed.length) parts.push('cleared: ' + d.removed.map(f => f.name).join(', '));
  return parts.join('; ');
}

/** Names of the known flags set in value (e.g. ["NORMAL_ACCOUNT", "DONT_EXPIRE_PASSWORD"]). */
export function uacFlagNames(value: number): string[] {
  return UAC_FLAG_INFO.filter(f => (value & f.bit) !== 0).map(f => f.name);
}

/** userAccountControl bits the DC computes (msDS-User-Account-Control-Computed). */
export const UAC_COMPUTED_BITS = 0x0010 | 0x800000;

/**
 * Whether a flag shows as set in the editor: stored in userAccountControl,
 * or for LOCKOUT / PASSWORD_EXPIRED reported by the computed attribute.
 */
export function isUacFlagShownSet(value: number, computed: number, bit: number): boolean {
  if ((value & bit) !== 0) return true;
  return (bit & UAC_COMPUTED_BITS) !== 0 && (computed & bit) !== 0;
}

/**
 * Re-applies the flags changed in draft (relative to oldBase, the value the
 * edit started from) on newBase, the value now on the server. Flags the user
 * did not touch take the server's value.
 */
export function rebaseUacDraft(oldBase: number, draft: number, newBase: number): number {
  const changed = (oldBase ^ draft) >>> 0;
  return (((newBase >>> 0) & ~changed) | (draft & changed)) >>> 0;
}
