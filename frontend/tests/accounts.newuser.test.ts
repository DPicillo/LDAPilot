// Run: cd frontend && node --test 'tests/*.test.ts'
// New User dialog on LDAP servers: "must change password at next logon"
// from the new account's password policy (FIN-W-03); the DN in the
// server's spelling (FIN-W-05).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mustChangeAttributes, mustChangeFollowUp, newUserMustChange, serverRdnType } from '../src/components/account/newUserAccount.ts';
import { newEntryDN } from '../src/components/lifecycle/newEntry.ts';
import type { AccountPolicy } from '../src/types/account.ts';

const policy = (p: Partial<AccountPolicy>): AccountPolicy => ({
  name: 'default-ppolicy', dn: 'cn=default-ppolicy,ou=Policies,dc=demo', source: 'assumed', readable: true, lockoutEnabled: true, lockoutThreshold: 3,
  lockoutDurationSeconds: 0, observationWindowSeconds: 0, maxPasswordAgeSeconds: 0, minPasswordAgeSeconds: 0, minPasswordLength: 8,
  passwordHistory: 5, expireWarningSeconds: 0, graceLogins: 0, mustChangeEnforced: true, ...p,
});

test('OpenLDAP: pwdReset TRUE in the add when the policy enforces it (ticked by default)', () => {
  const o = newUserMustChange('openldap', policy({}));
  assert.deepEqual([o.shown, o.enabled, o.checked, o.mode], [true, true, true, 'pwdReset']);
  assert.match(o.note!, /pwdReset: TRUE.*default-ppolicy.*pwdMustChange TRUE/);
  assert.deepEqual(mustChangeAttributes(o, true, true), [{ name: 'pwdReset', values: ['TRUE'], binary: false }]);
  assert.deepEqual(mustChangeAttributes(o, false, true), []);
  assert.deepEqual(mustChangeAttributes(o, true, false), [], 'no password, no pwdReset');
  assert.equal(mustChangeFollowUp(o, false, true), null);
});

test('OpenLDAP: shown disabled with the reason when the policy ignores pwdReset; unticked when unreadable', () => {
  const off = newUserMustChange('openldap', policy({ mustChangeEnforced: false }));
  assert.deepEqual([off.shown, off.enabled, off.checked], [true, false, false]);
  assert.match(off.note!, /pwdMustChange FALSE/);
  assert.deepEqual(mustChangeAttributes(off, true, true), []);
  const none = newUserMustChange('openldap', policy({ source: 'none', name: 'No password policy', dn: undefined }));
  assert.deepEqual([none.shown, none.enabled], [true, false]);
  assert.match(none.note!, /No password policy/);
  for (const unknown of [null, policy({ readable: false, source: 'unknown' })]) {
    const u = newUserMustChange('openldap', unknown);
    assert.deepEqual([u.shown, u.enabled, u.checked, u.mode], [true, true, false, 'pwdReset']);
    assert.match(u.note!, /not readable/);
  }
  assert.equal(newUserMustChange('openldap', undefined).shown, false, 'while the policy loads');
});

test('389DS: the policy marks the password itself; unticked clears the mark after the create', () => {
  const on = newUserMustChange('389ds', policy({ name: 'Global password policy', dn: 'cn=config', source: 'global' }));
  assert.deepEqual([on.shown, on.enabled, on.checked, on.mode], [true, true, true, 'dsPolicy']);
  assert.match(on.note!, /passwordMustChange on/);
  assert.deepEqual(mustChangeAttributes(on, true, true), [], 'nothing in the add: the server marks it');
  assert.equal(mustChangeFollowUp(on, true, true), null);
  assert.equal(mustChangeFollowUp(on, false, true), 'clear');
  assert.equal(mustChangeFollowUp(on, false, false), null);
  const off = newUserMustChange('389ds', policy({ mustChangeEnforced: false, source: 'global', name: 'Global password policy' }));
  assert.deepEqual([off.shown, off.enabled, off.checked], [true, false, false]);
  assert.match(off.note!, /passwordMustChange on.*off/);
  const unreadable = newUserMustChange('389ds', null);
  assert.equal(unreadable.shown, false);
  assert.match(unreadable.note!, /not readable/);
});

test('AD and other servers: not offered here (AD has its own option)', () => {
  assert.equal(newUserMustChange('ad', policy({})).shown, false);
  assert.equal(newUserMustChange('other', policy({})).shown, false);
  assert.equal(newUserMustChange(null, policy({})).shown, false);
});

test('the DN follows the server: AD upper-cases the standard RDN types', () => {
  assert.equal(newEntryDN(serverRdnType('cn', 'ad'), 'Ann Lee', 'OU=Track,DC=ad,DC=lab'), 'CN=Ann Lee,OU=Track,DC=ad,DC=lab');
  assert.equal(serverRdnType('ou', 'ad'), 'OU');
  assert.equal(serverRdnType('msDS-Foo', 'ad'), 'msDS-Foo');
  assert.equal(serverRdnType('uid', 'openldap'), 'uid');
  assert.equal(serverRdnType('cn', '389ds'), 'cn');
  assert.equal(serverRdnType('cn', null), 'cn');
});
