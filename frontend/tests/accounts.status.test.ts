// Run: cd frontend && node --test 'tests/*.test.ts'
// ACCT-03 / ACCT-09: one account status on every surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveAccountStatus, deriveRowStatus, expiresInLabel, formatRelative as uiRelative } from '../src/components/ui/accountStatus.ts';
import { serverStatusChips } from '../src/lib/accountChips.ts';
import { formatAccountExpiry, formatRelative, wholeDaysUntil, endOfLocalDayISO, formatSortableDateTime } from '../src/lib/accountTime.ts';
import { accountDisplayName, describePolicy, disableConfirmText, getAccountBadges } from '../src/lib/accountActions.ts';
import { diffUac, uacChangeWeakens } from '../src/lib/uac.ts';
import type { AccountPolicy, AccountStatus } from '../src/types/account.ts';

const USER = ['top', 'person', 'organizationalPerson', 'user'];
const FT = (d: Date) => String(BigInt(d.getTime()) * 10000n + 116444736000000000n);

test('pwdLastSet = 0 is "must change", never also "password expired" (test.mustchange)', () => {
  // The DC sets PASSWORD_EXPIRED (0x800000) in the computed flags for pwdLastSet = 0.
  const st = deriveAccountStatus({ objectClass: USER, userAccountControl: '512', 'msDS-User-Account-Control-Computed': '8388608', pwdLastSet: '0' }, { serverType: 'ad' });
  assert.deepEqual(st.map((s) => s.kind), ['mustChange']);
  assert.equal(st[0].label, 'Must change password');
  // DONT_EXPIRE_PASSWORD: AD ignores pwdLastSet = 0 (like computeADStatus)
  const never = deriveAccountStatus({ objectClass: USER, userAccountControl: '66048', pwdLastSet: '0', 'msDS-User-Account-Control-Computed': '0' }, { serverType: 'ad' });
  assert.deepEqual(never.map((s) => s.kind), ['pwdNeverExpires']);
  // A really expired password stays "Password expired"
  const expired = deriveAccountStatus({ objectClass: USER, userAccountControl: '512', 'msDS-User-Account-Control-Computed': '8388608', pwdLastSet: '133000000000000000' }, { serverType: 'ad' });
  assert.deepEqual(expired.map((s) => s.kind), ['pwdExpired']);
  // Computers change their own password
  const computer = deriveAccountStatus({ objectClass: [...USER, 'computer'], userAccountControl: '4096', pwdLastSet: '0', 'msDS-User-Account-Control-Computed': '8388608' });
  assert.deepEqual(computer.map((s) => s.kind), []);
  // The server status agrees: only "Must change password"
  const server = serverStatusChips({
    dn: 'cn=t', serverType: 'ad', applicable: true, evaluated: '', enabled: true, locked: false, badPasswordCount: 0,
    passwordExpired: false, passwordNeverExpires: false, mustChangePassword: true, accountExpired: false, accountNeverExpires: true,
    logonCount: 0, hasLogonCount: false, userAccountControl: 512, userAccountControlComputed: 0x800000, unsupported: {}, warnings: [],
  });
  assert.deepEqual(server.map((c) => c.label), ['Must change password']);
});

test('one day-rounding rule: chip, server chip, Account tab badge and tooltip agree (test.expiring)', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  for (const hours of [3.4 * 24, 3.6 * 24, 1.2 * 24, 13 * 24 + 5]) {
    const until = new Date(now.getTime() + hours * 3_600_000);
    const days = wholeDaysUntil(until, now);
    const derived = deriveAccountStatus({ objectClass: USER, userAccountControl: '512', accountExpires: FT(until) }, { now }).find((s) => s.kind === 'expiresSoon');
    assert.ok(derived, `derived chip for ${hours} h`);
    const server = serverStatusChips({
      dn: 'cn=t', serverType: 'ad', applicable: true, evaluated: '', enabled: true, locked: false, badPasswordCount: 0,
      passwordExpired: false, passwordNeverExpires: false, mustChangePassword: false, accountExpired: false, accountNeverExpires: false,
      accountExpires: until.toISOString(), logonCount: 0, hasLogonCount: false, userAccountControl: 512, userAccountControlComputed: 0,
      unsupported: {}, warnings: [],
    }, now).find((c) => c.kind === 'expiresSoon');
    const expected = `Expires in ${days} day${days === 1 ? '' : 's'}`;
    assert.equal(derived!.label, expected, 'derived');
    assert.equal(server!.label, expected, 'server');
    assert.equal(uiRelative(until, now), `in ${days} day${days === 1 ? '' : 's'}`, 'StatusChip tooltip');
    assert.equal(formatRelative(until.toISOString(), now), days === 1 ? 'tomorrow' : `in ${days} days`, 'Account tab');
    const st = { applicable: true, enabled: true, locked: false, mustChangePassword: false, passwordExpired: false, passwordNeverExpires: true, accountExpired: false, accountExpires: until.toISOString() } as AccountStatus;
    assert.equal(getAccountBadges(st, now).find((b) => b.id === 'accExpires')!.label, `Account expires in ${days} day${days === 1 ? '' : 's'}`, 'badge');
  }
  assert.equal(expiresInLabel(new Date(now.getTime() + 5 * 3_600_000), now), 'Expires in < 1 day');
});

test('389DS lockouts are derived from accountUnlockTime (report rows, Contents list)', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  const permanent = deriveRowStatus({ objectClass: ['inetOrgPerson'], accountUnlockTime: '19700101000000Z' });
  assert.deepEqual(permanent.map((s) => [s.kind, s.source.attribute]), [['locked', 'accountUnlockTime']]);
  assert.equal(permanent[0].until, undefined);
  const timed = deriveAccountStatus({ objectClass: ['inetOrgPerson'], accountUnlockTime: '20261031130000Z' }, { now });
  assert.equal(timed[0].kind, 'locked');
  assert.equal(timed[0].until?.toISOString(), '2026-10-31T13:00:00.000Z');
  const over = deriveAccountStatus({ objectClass: ['inetOrgPerson'], accountUnlockTime: '20261031110000Z' }, { now });
  assert.deepEqual(over, [], 'an expired lockout is not locked');
});

test('account expiration reads "End of <day>" like ADUC', () => {
  const iso = endOfLocalDayISO('2026-12-24')!;
  const text = formatAccountExpiry(iso);
  assert.match(text, /^End of /);
  assert.ok(text.includes('24'), text);
  assert.ok(!formatAccountExpiry('2026-12-24T10:30:00Z').startsWith('End of') || new Date('2026-12-24T10:30:00Z').getHours() === 0);
  assert.equal(formatAccountExpiry(''), '');
  assert.match(formatSortableDateTime('2026-10-31T12:00:00Z'), /^2026-10-3\d \d{2}:\d{2}$/);
});

test('domain policy shows complexity and reversible encryption', () => {
  const pol: AccountPolicy = {
    name: 'Domain password policy', source: 'domain', readable: true, lockoutEnabled: true, lockoutThreshold: 3, lockoutDurationSeconds: 1800,
    observationWindowSeconds: 1800, maxPasswordAgeSeconds: 0, minPasswordAgeSeconds: 0, minPasswordLength: 7, passwordHistory: 24,
    expireWarningSeconds: 0, graceLogins: 0, mustChangeEnforced: true, complexityKnown: true, complexityEnabled: true, reversibleEncryption: false,
  };
  const rows = Object.fromEntries(describePolicy(pol).map((r) => [r.label, r.value]));
  assert.match(rows['Complexity'], /^required/);
  assert.equal(rows['Reversible encryption'], 'off');
  assert.equal(describePolicy({ ...pol, complexityKnown: false }).some((r) => r.label === 'Complexity'), false);
});

test('names and the one Disable confirmation', () => {
  assert.equal(accountDisplayName('CN=Schmidt\\, Anna,OU=Lab,DC=ad'), 'Schmidt, Anna');
  assert.equal(accountDisplayName('uid=ux-p-user1,ou=people,dc=x'), 'ux-p-user1');
  const c = disableConfirmText('uid=ux-p-user2,ou=people,dc=x');
  assert.equal(c.title, 'Disable account?');
  assert.equal(c.message, 'ux-p-user2 can no longer log on until the account is enabled again.');
});

test('clearing protective userAccountControl flags weakens the account', () => {
  const NOT_DELEGATED = 0x100000;
  const SMARTCARD = 0x40000;
  const d = diffUac(0x200 | NOT_DELEGATED | SMARTCARD, 0x200);
  assert.deepEqual(d.dangerousRemoved.map((f) => f.name).sort(), ['NOT_DELEGATED', 'SMARTCARD_REQUIRED']);
  assert.equal(uacChangeWeakens(d), true);
  const harmless = diffUac(0x200, 0x200 | NOT_DELEGATED);
  assert.equal(uacChangeWeakens(harmless), false);
  assert.equal(uacChangeWeakens(diffUac(0x200, 0x200 | 0x20)), true, 'PASSWD_NOTREQD set');
});
