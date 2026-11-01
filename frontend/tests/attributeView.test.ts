// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeGroup, ATTRIBUTE_GROUPS } from '../src/lib/attributeGroups.ts';
import { serverStatusChips } from '../src/lib/accountChips.ts';

test('attribute groups: explicit sections, schema fallback, System collapsed', () => {
  assert.equal(attributeGroup('cn'), 'identity');
  assert.equal(attributeGroup('sAMAccountName'), 'identity');
  assert.equal(attributeGroup('userAccountControl'), 'account');
  assert.equal(attributeGroup('userPassword'), 'account');
  assert.equal(attributeGroup('mail'), 'contact');
  assert.equal(attributeGroup('memberOf'), 'membership');
  assert.equal(attributeGroup('member;range=0-1499'), 'membership');
  assert.equal(attributeGroup('objectGUID'), 'system');
  assert.equal(attributeGroup('msDS-ReplValueMetaData'), 'system');
  assert.equal(attributeGroup('someOperational', { noUserMod: true }), 'system');
  assert.equal(attributeGroup('dirAttr', { usage: 'directoryOperation' }), 'system');
  assert.equal(attributeGroup('custom', { usage: 'userApplications' }), 'identity');
  assert.deepEqual(ATTRIBUTE_GROUPS.filter((g) => g.defaultCollapsed).map((g) => g.id), ['system']);
});

const base = {
  dn: 'CN=Test Locked,OU=Lab,DC=ad,DC=lab', serverType: 'ad', applicable: true, evaluated: '2026-10-31T10:00:00Z',
  enabled: true, locked: false, badPasswordCount: 0, passwordExpired: false, passwordNeverExpires: false,
  mustChangePassword: false, accountExpired: false, accountNeverExpires: true, logonCount: 0, hasLogonCount: false,
  userAccountControl: 512, userAccountControlComputed: 0, unsupported: {}, warnings: [],
};

test('server status chips: locked with dates and source, disabled, expiring, must change', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  const locked = serverStatusChips({ ...base, locked: true, lockedAt: '2026-10-31T10:00:00Z', userAccountControlComputed: 0x10 }, now);
  assert.equal(locked[0].kind, 'locked');
  assert.equal(locked[0].since?.toISOString(), '2026-10-31T10:00:00.000Z');
  assert.match(locked[0].source.raw, /0x10/);
  const dis = serverStatusChips({ ...base, enabled: false, userAccountControl: 514 }, now);
  assert.deepEqual(dis.map((c) => c.kind), ['disabled']);
  const soon = serverStatusChips({ ...base, accountNeverExpires: false, accountExpires: '2026-11-05T12:00:00Z' }, now);
  assert.deepEqual(soon.map((c) => [c.kind, c.label]), [['expiresSoon', 'Expires in 5 days']]);
  const must = serverStatusChips({ ...base, serverType: 'openldap', mustChangePassword: true }, now);
  assert.deepEqual(must.map((c) => [c.kind, c.source.attribute]), [['mustChange', 'pwdReset']]);
  assert.deepEqual(serverStatusChips({ ...base, applicable: false, locked: true }, now), []);
  assert.deepEqual(serverStatusChips(null, now), []);
});
