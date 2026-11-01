// Run: cd frontend && node --test 'tests/*.test.ts'
// Report rows after an account action: patched from the status the action's
// event carries instead of a second read (RW1-P-06 c).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canPatchFromStatus, patchReportRowFromStatus } from '../src/components/account/reportRows.ts';
import type { AccountStatus } from '../src/types/account.ts';
import type { LDAPEntry } from '../src/types/ldap.ts';

const status = (p: Partial<AccountStatus>): AccountStatus => ({
  dn: 'uid=u1,ou=People,dc=demo', serverType: 'openldap', applicable: true, evaluated: '2026-11-01T12:00:00Z', enabled: true, locked: false,
  badPasswordCount: 0, passwordExpired: false, passwordNeverExpires: false, mustChangePassword: false, accountExpired: false,
  accountNeverExpires: true, logonCount: 0, hasLogonCount: false, userAccountControl: 0, userAccountControlComputed: 0,
  unsupported: {}, warnings: [], ...p,
} as AccountStatus);

const row = (dn: string, extra: Record<string, string> = {}): LDAPEntry => ({
  dn,
  attributes: [
    { name: 'uid', values: [dn.slice(4, dn.indexOf(','))], binary: false },
    ...Object.entries(extra).map(([name, v]) => ({ name, values: [v], binary: false })),
  ],
});

test('account reports are patched from the status; group reports and whenChanged columns are re-read', () => {
  assert.ok(canPatchFromStatus('locked', ['uid', 'Locked since', 'Locked until', 'Failed logons']));
  assert.ok(canPatchFromStatus('disabled', ['uid', 'Disabled by', 'description']));
  assert.ok(canPatchFromStatus('neverLoggedOn', ['uid', 'Created', 'Password last set', 'description']));
  assert.ok(!canPatchFromStatus('disabled', ['sAMAccountName', 'description', 'whenChanged']), 'AD: whenChanged changes with the write');
  assert.ok(!canPatchFromStatus('privilegedMembers', ['sAMAccountName', 'Privileged groups', 'Nested via']));
  assert.ok(!canPatchFromStatus('emptyGroups', ['cn']));
});

test('an unlocked row loses its lock columns, keeps its LDAP attributes and its place', () => {
  const rows = [
    row('uid=u0,ou=People,dc=demo', { 'Locked since': '2026-11-01 10:00', 'Locked until': 'permanent', 'Failed logons': '3' }),
    row('uid=u1,ou=People,dc=demo', { 'Locked since': '2026-11-01 11:00', 'Locked until': 'permanent', 'Failed logons': '3', mail: 'u1@x', pwdAccountLockedTime: '20261101110000Z', pwdFailureTime: '20261101110000Z', createTimestamp: '20260101000000Z' }),
  ];
  const out = patchReportRowFromStatus(rows, 'UID=u1, ou=People,dc=demo', 'locked', status({ locked: false, badPasswordCount: 0 }), new Date('2026-11-01T12:00:00Z'));
  assert.ok(out);
  assert.equal(out![0], rows[0], 'other rows untouched');
  const names = out![1].attributes.map((a) => a.name);
  // The lock attributes from before the Unlock go (a status derived from them would say "Locked out").
  assert.deepEqual(names, ['uid', 'mail', 'createTimestamp', 'Failed logons']);
  assert.deepEqual(out![1].attributes.find((a) => a.name === 'Failed logons')?.values, ['0']);
  assert.notEqual(out, rows, 'a new array (the store sees the change)');
});

test('a row still locked after the action gets fresh columns; unknown DNs and non-accounts are not patched', () => {
  const rows = [row('uid=u1,ou=People,dc=demo', { 'Locked until': 'permanent' })];
  const locked = patchReportRowFromStatus(rows, 'uid=u1,ou=People,dc=demo', 'locked',
    status({ locked: true, lockedPermanently: false, lockedAt: '2026-11-01T11:00:00Z', lockedUntil: '2026-11-01T13:00:00Z', badPasswordCount: 4 }), new Date());
  assert.deepEqual(locked![0].attributes.find((a) => a.name === 'Failed logons')?.values, ['4']);
  assert.notEqual(locked![0].attributes.find((a) => a.name === 'Locked until')?.values[0], 'permanent');
  assert.equal(patchReportRowFromStatus(rows, 'uid=other,dc=demo', 'locked', status({}), new Date()), null);
  assert.equal(patchReportRowFromStatus(rows, 'uid=u1,ou=People,dc=demo', 'locked', status({ applicable: false }), new Date()), null);
});
