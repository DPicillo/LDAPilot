// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeGroup, attributeLines, attributeSuggestions, classAttributes, isCompareNoise, isServerManagedAttribute, rankAttributeNames,
  primaryGroupSid, singleValueProblem, valueLink, valueSearchFilter, wellKnownGroupName,
} from '../src/lib/attributeGroups.ts';

test('server-managed attributes: schema noUserMod plus the AD systemOnly fallback list', () => {
  for (const n of ['objectGUID', 'objectSid', 'uSNCreated', 'uSNChanged', 'whenCreated', 'whenChanged', 'sAMAccountType', 'distinguishedName', 'pwdHistory']) {
    assert.equal(isServerManagedAttribute(n), true, n);
  }
  assert.equal(isServerManagedAttribute('description'), false);
  assert.equal(isServerManagedAttribute('someOperational', { noUserMod: true }), true);
  assert.equal(isServerManagedAttribute('telephoneNumber', { noUserMod: false }), false);
  assert.equal(isServerManagedAttribute('objectGUID;binary'), true);
});

test('single-value check before sending', () => {
  assert.equal(singleValueProblem('givenName', ['a', 'b'], { singleValue: true }), 'givenName is single-valued: enter one value (2 lines given)');
  assert.equal(singleValueProblem('givenName', ['a'], { singleValue: true }), null);
  assert.equal(singleValueProblem('description', ['a', 'b'], { singleValue: false }), null);
  assert.equal(singleValueProblem('x', ['a', 'b'], undefined), null);
});

test('rankAttributeNames: exact > prefix > substring, case-insensitive', () => {
  const names = ['meetingDescription', 'description', 'dhcpObjDescription', 'descriptionExtra', 'cn'];
  assert.deepEqual(rankAttributeNames(names, 'Description'), ['description', 'descriptionExtra', 'dhcpObjDescription', 'meetingDescription']);
  assert.deepEqual(rankAttributeNames(names, ''), ['cn', 'description', 'descriptionExtra', 'dhcpObjDescription', 'meetingDescription']);
  assert.deepEqual(rankAttributeNames(names, 'zzz'), []);
});

test('classAttributes walks SUP chains; MUST wins over MAY', () => {
  const classes = [
    { name: 'top', must: ['objectClass'] },
    { name: 'person', superClass: ['top'], must: ['cn', 'sn'], may: ['description', 'telephoneNumber'] },
    { name: 'organizationalPerson', superClass: ['person'], may: ['title', 'sn'] },
    { name: 'inetOrgPerson', superClass: ['organizationalPerson'], may: ['mail'] },
  ];
  const { must, may } = classAttributes(['inetOrgPerson'], classes);
  assert.deepEqual([...must.values()].sort(), ['cn', 'objectClass', 'sn']);
  assert.deepEqual([...may.values()].sort(), ['description', 'mail', 'telephoneNumber', 'title']);
  // Unknown classes and cycles are harmless
  const cyc = classAttributes(['a', 'nope'], [{ name: 'a', superClass: ['b'], may: ['x'] }, { name: 'b', superClass: ['a'], may: ['y'] }]);
  assert.deepEqual([...cyc.may.values()].sort(), ['x', 'y']);
});

test('attributeSuggestions: allowed first, exact match from the schema always, the rest behind "Show all"', () => {
  const allowed = ['description', 'telephoneNumber', 'title'];
  const all = ['description', 'telephoneNumber', 'title', 'meetingDescription', 'mail', 'dhcpObjDescription'];
  assert.deepEqual(attributeSuggestions('desc', allowed, all, false), { items: ['description'], more: 2 });
  assert.deepEqual(attributeSuggestions('desc', allowed, all, true), { items: ['description', 'dhcpObjDescription', 'meetingDescription'], more: 0 });
  assert.deepEqual(attributeSuggestions('mail', allowed, all, false), { items: ['mail'], more: 0 });
  assert.deepEqual(attributeSuggestions('', allowed, all, false), { items: ['description', 'telephoneNumber', 'title'], more: 3 });
});

test('row menu texts: attr: value lines and an escaped equality filter', () => {
  assert.equal(attributeLines('mail', ['a@x', 'b@x']), 'mail: a@x\nmail: b@x');
  assert.equal(valueSearchFilter('cn', 'Schmidt, Anna (HR)*'), '(cn=Schmidt, Anna \\28HR\\29\\2a)');
  assert.equal(valueSearchFilter('description', 'a\\b'), '(description=a\\5cb)');
});

test('valueLink: http(s) only, labeledURI label', () => {
  assert.deepEqual(valueLink('url', 'https://example.org/x'), { href: 'https://example.org/x' });
  assert.deepEqual(valueLink('labeledURI', 'http://example.org Home page'), { href: 'http://example.org', label: 'Home page' });
  assert.deepEqual(valueLink('wWWHomePage', 'http://intranet'), { href: 'http://intranet' });
  assert.equal(valueLink('url', 'javascript:alert(1)'), null);
  assert.equal(valueLink('url', 'file:///etc/passwd'), null);
  assert.equal(valueLink('description', 'https://example.org'), null);
});

test('well-known primary groups', () => {
  assert.equal(wellKnownGroupName('513'), 'Domain Users');
  assert.equal(wellKnownGroupName(515), 'Domain Computers');
  assert.equal(wellKnownGroupName('1105'), undefined);
  assert.equal(wellKnownGroupName('x'), undefined);
});

test('primary group SID: domain SID of the account + primaryGroupID', () => {
  assert.equal(primaryGroupSid('S-1-5-21-2935511413-1781990272-1200128551-1105', '1220'), 'S-1-5-21-2935511413-1781990272-1200128551-1220');
  assert.equal(primaryGroupSid(' s-1-5-21-1-2-3-500 ', 513), 'S-1-5-21-1-2-3-513');
  // Builtin / well-known SIDs and malformed input have no domain part.
  assert.equal(primaryGroupSid('S-1-5-32-544', '513'), null);
  assert.equal(primaryGroupSid(undefined, '513'), null);
  assert.equal(primaryGroupSid('S-1-5-21-1-2-3-500', '0'), null);
  assert.equal(primaryGroupSid('S-1-5-21-1-2-3-500', 'abc'), null);
});

test('compare noise: system attributes and name, not the identity', () => {
  for (const n of ['objectGUID', 'objectSid', 'uSNChanged', 'whenCreated', 'distinguishedName', 'name', 'lastLogon']) assert.equal(isCompareNoise(n), true, n);
  for (const n of ['cn', 'description', 'memberOf', 'mail', 'userAccountControl']) assert.equal(isCompareNoise(n), false, n);
  assert.equal(isCompareNoise('someOp', { usage: 'directoryOperation' }), true);
  assert.equal(attributeGroup('mail'), 'contact');
});
