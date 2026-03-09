/** Attributes whose values are Distinguished Names referencing other entries. */
export const DN_REFERENCE_ATTRS = new Set([
  'member',
  'memberof',
  'managedby',
  'manager',
  'directreports',
  'msds-membertransitive',
  'msds-memberoftransitive',
  'distinguishedname',
  'defaultnamingcontext',
  'schemanamingcontext',
  'configurationnamingcontext',
  'rootdomainnamingcontext',
  'namingcontexts',
  'subschemasubentry',
  'dscorepropagationdata',
  'msds-lastknownrdn',
  'objectcategory',
  'seealso',
  'modifiedcountatlastprom',
  'lastknownparent',
]);

/** Attributes containing password / credential data. */
export const PASSWORD_ATTRS = new Set([
  'userpassword',
  'unicodepwd',
  'sambantpassword',
  'sambalmpassword',
]);

/** Active Directory userAccountControl flags */
export const UAC_FLAGS: { bit: number; name: string; description: string }[] = [
  { bit: 0x0001, name: 'SCRIPT', description: 'Logon script is executed' },
  { bit: 0x0002, name: 'ACCOUNTDISABLE', description: 'Account is disabled' },
  { bit: 0x0008, name: 'HOMEDIR_REQUIRED', description: 'Home directory required' },
  { bit: 0x0010, name: 'LOCKOUT', description: 'Account is locked out' },
  { bit: 0x0020, name: 'PASSWD_NOTREQD', description: 'No password required' },
  { bit: 0x0040, name: 'PASSWD_CANT_CHANGE', description: 'User cannot change password' },
  { bit: 0x0080, name: 'ENCRYPTED_TEXT_PWD_ALLOWED', description: 'Encrypted text password allowed' },
  { bit: 0x0100, name: 'TEMP_DUPLICATE_ACCOUNT', description: 'Temp duplicate account' },
  { bit: 0x0200, name: 'NORMAL_ACCOUNT', description: 'Normal user account' },
  { bit: 0x0800, name: 'INTERDOMAIN_TRUST_ACCOUNT', description: 'Interdomain trust account' },
  { bit: 0x1000, name: 'WORKSTATION_TRUST_ACCOUNT', description: 'Workstation trust account' },
  { bit: 0x2000, name: 'SERVER_TRUST_ACCOUNT', description: 'Server trust account (DC)' },
  { bit: 0x10000, name: 'DONT_EXPIRE_PASSWORD', description: 'Password never expires' },
  { bit: 0x20000, name: 'MNS_LOGON_ACCOUNT', description: 'MNS logon account' },
  { bit: 0x40000, name: 'SMARTCARD_REQUIRED', description: 'Smart card required for login' },
  { bit: 0x80000, name: 'TRUSTED_FOR_DELEGATION', description: 'Trusted for Kerberos delegation' },
  { bit: 0x100000, name: 'NOT_DELEGATED', description: 'Account cannot be delegated' },
  { bit: 0x200000, name: 'USE_DES_KEY_ONLY', description: 'Use DES encryption only' },
  { bit: 0x400000, name: 'DONT_REQ_PREAUTH', description: 'Kerberos pre-auth not required' },
  { bit: 0x800000, name: 'PASSWORD_EXPIRED', description: 'Password has expired' },
  { bit: 0x1000000, name: 'TRUSTED_TO_AUTH_FOR_DELEGATION', description: 'Trusted to authenticate for delegation' },
  { bit: 0x4000000, name: 'PARTIAL_SECRETS_ACCOUNT', description: 'Partial secrets account (RODC)' },
];

/** Decode a userAccountControl value into active flag names */
export function decodeUAC(value: number): { name: string; description: string; active: boolean }[] {
  return UAC_FLAGS.map(f => ({
    name: f.name,
    description: f.description,
    active: (value & f.bit) !== 0,
  }));
}

/** Attributes that contain binary image data */
export const PHOTO_ATTRS = new Set([
  'thumbnailphoto',
  'jpegphoto',
  'photo',
  'usercertificate',
]);

/** Attributes whose values are timestamps (Windows FileTime / Generalized Time) */
export const TIMESTAMP_ATTRS = new Set([
  'whencreated',
  'whenchanged',
  'lastlogon',
  'lastlogontimestamp',
  'pwdlastset',
  'accountexpires',
  'badpasswordtime',
  'lockouttime',
  'ms-ds-lastsuccessfulinteractivelogontime',
  'ms-ds-lastfailedinteractivelogontime',
]);
