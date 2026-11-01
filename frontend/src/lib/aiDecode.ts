/**
 * Readable forms of account attribute values on the AI approval card (UX
 * A-25: "userAccountControl 512 → 514" and "pwdLastSet → 0" were shown raw).
 * Pure; imports only other pure modules with the .ts extension, so Node's
 * test runner loads it (tests/ai/decode.test.mjs).
 */
import { diffUac, UAC_FLAG_INFO } from './uac.ts';
import { formatAccountAttributeValue } from './accountTime.ts';

function uacInt(v: string): number | null {
  const s = v.trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n >>> 0 : null;
}

/** "Normal account · Account disabled" for a userAccountControl value. */
export function describeUacFlags(value: number): string {
  const v = value >>> 0;
  const labels = UAC_FLAG_INFO.filter((f) => (v & f.bit) !== 0).map((f) => f.label);
  const known = UAC_FLAG_INFO.reduce((m, f) => m | f.bit, 0);
  const unknown = (v & ~known) >>> 0;
  if (unknown) labels.push(`0x${unknown.toString(16).toUpperCase()}`);
  return labels.length ? labels.join(' · ') : 'no flags';
}

function describeGroupType(value: number): string {
  const v = value >>> 0;
  const scope = v & 0x8 ? 'Universal' : v & 0x4 ? 'Domain local' : v & 0x2 ? 'Global' : v & 0x1 ? 'Builtin' : '';
  const kind = v & 0x80000000 ? 'security group' : 'distribution group';
  return scope ? `${scope} ${kind}` : kind;
}

/**
 * The readable form of one value of an account attribute, or null when
 * the raw value says it all (or the attribute is not one of them).
 */
export function decodeAttrValue(attribute: string, value: string): string | null {
  const a = attribute.toLowerCase();
  const v = value.trim();
  switch (a) {
    case 'useraccountcontrol':
    case 'msds-user-account-control-computed': {
      const n = uacInt(v);
      return n === null ? null : describeUacFlags(n);
    }
    case 'grouptype': {
      const n = uacInt(v);
      return n === null ? null : describeGroupType(n);
    }
    case 'pwdlastset':
      if (v === '-1') return 'Set to now (clears “must change at next logon”)';
      break;
    case 'pwdreset':
      return v.toUpperCase() === 'TRUE' ? 'Must change the password at the next bind' : v.toUpperCase() === 'FALSE' ? 'No forced password change' : null;
    case 'nsaccountlock':
      return v.toLowerCase() === 'true' ? 'Account disabled' : v.toLowerCase() === 'false' ? 'Account enabled' : null;
  }
  return formatAccountAttributeValue(attribute, v);
}

/**
 * One line for a userAccountControl change ("sets Account disabled; clears
 * Password never expires"), with the flags that weaken security, or null.
 */
export function describeUacChange(before: string[] | null | undefined, after: string[] | null | undefined): { text: string; danger: string[] } | null {
  const b = uacInt((before ?? [])[0] ?? '');
  const a = uacInt((after ?? [])[0] ?? '');
  if (a === null) return null;
  const d = diffUac(b ?? 0, a);
  const parts: string[] = [];
  if (d.added.length) parts.push('sets ' + d.added.map((f) => f.label).join(', '));
  if (d.removed.length) parts.push('clears ' + d.removed.map((f) => f.label).join(', '));
  if (d.unknownBits) parts.push(`changes bits 0x${d.unknownBits.toString(16).toUpperCase()}`);
  if (!parts.length) return null;
  return { text: parts.join('; '), danger: d.dangerousAdded.map((f) => f.danger ?? f.label) };
}
