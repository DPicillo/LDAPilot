// Run: cd frontend && node --test 'tests/*.test.ts'
// Server-aware quick search types, the filter builder's negated and bitwise
// operators (round trip) and filter error messages with positions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  andWithTypeFilter, buildAnyNameFilter, buildBuilderFilter, buildBuilderFilterWithType, buildConditionFilter, buildNameContainsFilter,
  buildQuickFilter, builderGroupFromFilter, conditionProblem, extractObjectType, quickObjectTypeFilter, quickObjectTypes, quickSearchAttributes,
} from '../src/lib/searchFilter.ts';
import { describeFilterError, parseFilter } from '../src/lib/ldapFilter.ts';

test('object types: AD users are persons that are user objects; LDAP servers have their own classes', () => {
  assert.equal(quickObjectTypeFilter('users', 'ad'), '(&(objectCategory=person)(objectClass=user))');
  assert.equal(quickObjectTypeFilter('contacts', 'ad'), '(objectClass=contact)');
  assert.equal(quickObjectTypeFilter('computers', 'ad'), '(objectClass=computer)');
  // LDAP users have a login (uid); persons without one are contacts (RW3-S-04).
  assert.equal(quickObjectTypeFilter('users', 'openldap'), '(|(&(objectClass=inetOrgPerson)(uid=*))(objectClass=posixAccount)(objectClass=account))');
  assert.equal(quickObjectTypeFilter('groups', '389ds'), '(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup)(objectClass=groupOfURLs))');
  assert.equal(quickObjectTypeFilter('computers', 'openldap'), '(|(objectClass=device)(objectClass=ipHost))');
  // Contacts on LDAP servers: inetOrgPerson without uid (RW3-S-04); unknown types give no filter
  assert.equal(quickObjectTypeFilter('contacts', 'openldap'), '(&(objectClass=inetOrgPerson)(!(uid=*))(!(objectClass=posixAccount)))');
  assert.equal(quickObjectTypeFilter('nope', 'ad'), '');
  assert.ok(quickObjectTypes('ad').some((t) => t.value === 'contacts'));
  assert.ok(quickObjectTypes('openldap').some((t) => t.value === 'contacts'));
});

test('"Search in": no AD-only attributes on LDAP servers, no uid on AD', () => {
  const ol = quickSearchAttributes('openldap').map((o) => o.value);
  assert.ok(!ol.includes('sAMAccountName') && !ol.includes('userPrincipalName'));
  assert.ok(ol.includes('uid'));
  const ad = quickSearchAttributes('ad').map((o) => o.value);
  assert.ok(ad.includes('sAMAccountName') && ad.includes('userPrincipalName') && !ad.includes('uid'));
  // Unknown server type: everything
  const other = quickSearchAttributes(null).map((o) => o.value);
  assert.ok(other.includes('sAMAccountName') && other.includes('uid'));
});

test('quick filters merge the parts of an AND type filter and work without text', () => {
  const users = quickObjectTypeFilter('users', 'ad');
  assert.equal(buildQuickFilter('jo', 'cn', 'startsWith', users), '(&(objectCategory=person)(objectClass=user)(cn=jo*))');
  assert.equal(buildQuickFilter('', 'cn', 'contains', users), users, 'empty text = every entry of the type');
  assert.equal(andWithTypeFilter('(objectClass=group)', '(cn=a)'), '(&(objectClass=group)(cn=a))');
  assert.equal(andWithTypeFilter('', '(cn=a)'), '(cn=a)');
  assert.equal(buildAnyNameFilter('jo', 'contains', 'ad', users), '(&(objectCategory=person)(objectClass=user)(anr=jo))');
  assert.equal(buildAnyNameFilter('jo', 'exact', 'openldap', ''), '(|(cn=jo)(displayName=jo)(uid=jo)(mail=jo)(givenName=jo)(sn=jo)(ou=jo))');
  // Values stay literal
  assert.equal(buildAnyNameFilter('a*(b)', 'exact', 'ad', ''), '(anr=a\\2a\\28b\\29)');
});

test('"Search names containing": the text anywhere in the AD name attributes', () => {
  assert.equal(
    buildNameContainsFilter('mid', 'ad', quickObjectTypeFilter('users', 'ad')),
    '(&(objectCategory=person)(objectClass=user)(|(cn=*mid*)(displayName=*mid*)(sAMAccountName=*mid*)(userPrincipalName=*mid*)(mail=*mid*)(givenName=*mid*)(sn=*mid*)(name=*mid*)))',
  );
  assert.ok(!buildNameContainsFilter('x', 'openldap', '').includes('sAMAccountName'));
});

test('builder: not equals, does not exist, bit set / not set build NOTs and AD bitwise matches', () => {
  assert.equal(buildConditionFilter('mail', 'notPresent', ''), '(!(mail=*))');
  assert.equal(buildConditionFilter('cn', '!=', 'a*b'), '(!(cn=a\\2ab))');
  assert.equal(buildConditionFilter('userAccountControl', 'bitAnd', '2'), '(userAccountControl:1.2.840.113556.1.4.803:=2)');
  assert.equal(buildConditionFilter('userAccountControl', 'bitNotSet', ' 65536 '), '(!(userAccountControl:1.2.840.113556.1.4.803:=65536))');
  assert.match(conditionProblem('userAccountControl', 'bitAnd', 'two') ?? '', /must be a number/);
  assert.equal(conditionProblem('memberOf:1.2.840.113556.1.4.1941:', '!=', 'x'), null);
  assert.match(conditionProblem('memberOf:1.2.840.113556.1.4.1941:', 'substring', 'x') ?? '', /only with "equals" or "not equals"/);
});

test('builder round trip: negations and bit operators load back as the same operators', () => {
  for (const f of [
    '(&(!(mail=*))(!(cn=x))(userAccountControl:1.2.840.113556.1.4.803:=2))',
    '(|(!(userAccountControl:1.2.840.113556.1.4.803:=65536))(sn>=m))',
    '(!(&(cn=a)(sn=b)))',
  ]) {
    const r = builderGroupFromFilter(f);
    assert.ok('group' in r, f);
    assert.equal(buildBuilderFilter(r.group).filter, f);
  }
  const r = builderGroupFromFilter('(&(!(mail=*))(userAccountControl:1.2.840.113556.1.4.803:=2))');
  assert.ok('group' in r);
  assert.deepEqual(r.group.conditions.map((c) => ('operator' in c && 'attribute' in c ? c.operator : 'group')), ['notPresent', 'bitAnd']);
});

test('builder object type: split off a loaded filter, ANDed back in when built', () => {
  const f = '(&(objectCategory=person)(objectClass=user)(!(mail=*)))';
  const r = builderGroupFromFilter(f);
  assert.ok('group' in r);
  const { type, rest } = extractObjectType(r.group, 'ad');
  assert.equal(type, 'users');
  assert.equal(rest.conditions.length, 1);
  assert.equal(buildBuilderFilterWithType(rest, type, 'ad').filter, f);
  // Only the type: all entries of the type
  assert.equal(buildBuilderFilterWithType({ operator: '&', conditions: [] }, 'groups', 'openldap').filter, quickObjectTypeFilter('groups', 'openldap'));
  // A filter without the type's parts keeps every condition
  const plain = builderGroupFromFilter('(&(objectClass=user)(cn=a))');
  assert.ok('group' in plain);
  assert.equal(extractObjectType(plain.group, 'ad').type, '');
});

test('filter errors name the problem and its position', () => {
  assert.throws(() => parseFilter('(&(cn=a)(sn=b)'), /Missing "\)" at position 15/);
  assert.equal(describeFilterError('(&(cn=a)(sn=b)', 'LDAP Result Code 201 "Filter Compile Error": ldap: finished compiling filter with extra at end'), 'Missing ")" at position 15');
  // The local parser accepts it: the server's text without the go-ldap prefixes
  assert.equal(describeFilterError('(cn=a)', 'invalid LDAP filter: LDAP Result Code 201 "Filter Compile Error": ldap: unexpected thing'), 'Unexpected thing');
});
