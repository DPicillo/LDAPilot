// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasAccountSemantics, kindNeedsAttributes, resolveObjectKind } from '../src/components/ui/objectKind.ts';

test('LDAP device and ipHost are computers, without account verbs', () => {
  assert.equal(resolveObjectKind(['top', 'device']), 'computer');
  assert.equal(resolveObjectKind(['top', 'device', 'ipHost']), 'computer');
  assert.ok(!hasAccountSemantics('computer', ['top', 'device', 'ipHost']));
  // AD computers and POSIX hosts have accounts.
  assert.ok(hasAccountSemantics('computer', ['top', 'person', 'organizationalPerson', 'user', 'computer']));
  assert.ok(hasAccountSemantics('computer', ['top', 'device', 'posixAccount']));
});

test('an LDAP person without uid, password or account class is a contact (only when the attributes are known)', () => {
  const oc = ['top', 'person', 'organizationalPerson', 'inetOrgPerson'];
  assert.equal(resolveObjectKind(oc), 'user', 'attributes unknown: stays a user');
  assert.equal(resolveObjectKind(oc, ['cn', 'sn', 'mail', 'objectClass']), 'contact');
  assert.equal(resolveObjectKind(oc, ['cn', 'sn', 'uid']), 'user');
  assert.equal(resolveObjectKind(oc, ['cn', 'sn', 'userPassword']), 'user');
  assert.equal(resolveObjectKind(oc, ['cn', 'userPassword;binary']), 'user', 'options are ignored');
  assert.equal(resolveObjectKind([...oc, 'posixAccount'], ['cn']), 'user');
  assert.ok(!hasAccountSemantics('contact', oc));
  assert.ok(kindNeedsAttributes(oc));
  assert.ok(!kindNeedsAttributes(['top', 'user']));
  assert.ok(!kindNeedsAttributes([...oc, 'posixAccount']));
});

test('AD kinds are unchanged; Configuration and Schema heads are containers', () => {
  assert.equal(resolveObjectKind(['top', 'person', 'organizationalPerson', 'user', 'inetOrgPerson'], ['cn']), 'user');
  assert.equal(resolveObjectKind(['top', 'person', 'organizationalPerson', 'contact']), 'contact');
  assert.equal(resolveObjectKind(['top', 'person', 'organizationalPerson', 'user', 'computer', 'msDS-GroupManagedServiceAccount']), 'service');
  assert.equal(resolveObjectKind(['top', 'configuration']), 'container');
  assert.equal(resolveObjectKind(['top', 'dMD']), 'container');
  assert.equal(resolveObjectKind(['top', 'domainDNS']), 'domain');
});
