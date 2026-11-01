// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ldapErrorKind, matchingProfiles, paletteNameFilters, profileActionTitle, urlMatchesProfile } from '../src/components/commands/paletteSearch.ts';

test('non-AD name search: prefix over cn, displayName, sn, givenName, uid, mail, ou, then a substring pass', () => {
  const f = paletteNameFilters('Meier', false);
  assert.equal(f.first, '(|(cn=Meier*)(displayName=Meier*)(sn=Meier*)(givenName=Meier*)(uid=Meier*)(mail=Meier*)(ou=Meier*))');
  assert.equal(f.fallback, '(|(cn=*Meier*)(displayName=*Meier*)(sn=*Meier*))');
  assert.ok(!f.first.includes('sAMAccountName') && !f.first.includes('userPrincipalName'), 'no AD-only attributes on other servers');
});

test('AD name search: anr, then a substring pass over cn and displayName', () => {
  const f = paletteNameFilters('日本', true);
  assert.equal(f.first, '(anr=日本)');
  assert.equal(f.fallback, '(|(cn=*日本*)(displayName=*日本*))');
});

test('values are escaped (RFC 4515): wildcards and parentheses match literally', () => {
  const f = paletteNameFilters(' a*b(c)\\ ', false);
  assert.ok(f.first.startsWith('(|(cn=a\\2ab\\28c\\29\\5c*)'), f.first);
  assert.equal(paletteNameFilters('x)(uid=*', true).first, '(anr=x\\29\\28uid=\\2a)');
});

test('connections match on name or host; titles say Connect or Switch', () => {
  const ps = [
    { id: '1', name: 'Lab · Samba AD (LDAPS)', host: 'localhost', port: 2636 },
    { id: '2', name: 'OpenLDAP demo', host: 'ldap.demo.local', port: 389 },
  ];
  assert.deepEqual(matchingProfiles(ps, 'samba').map((p) => p.id), ['1']);
  assert.deepEqual(matchingProfiles(ps, 'demo local').map((p) => p.id), ['2']);
  assert.deepEqual(matchingProfiles(ps, ' '), []);
  assert.equal(profileActionTitle('OpenLDAP demo', true), 'Switch to OpenLDAP demo');
  assert.equal(profileActionTitle('OpenLDAP demo', false), 'Connect to OpenLDAP demo');
});

test('noSuchObject is recognised in the raw server text (never shown to the user)', () => {
  assert.equal(ldapErrorKind('LDAP search failed: No Such Object: acl_read: Error retrieving instanceType for base. at source4/dsdb/samdb/ldb_modules/acl_read.c:975'), 'noSuchObject');
  assert.equal(ldapErrorKind('LDAP Result Code 32 "No Such Object": '), 'noSuchObject');
  assert.equal(ldapErrorKind('LDAP Result Code 34 "Invalid DN Syntax": invalid DN'), 'invalidDN');
  assert.equal(ldapErrorKind('LDAP Result Code 50 "Insufficient Access Rights"'), 'other');
});

test('an LDAP URL of another host is detected; no host = this connection', () => {
  const p = { host: 'LocalHost', port: 2636 };
  assert.ok(urlMatchesProfile({ scheme: 'ldaps', host: 'localhost', port: 2636 }, p));
  assert.ok(urlMatchesProfile({ scheme: 'ldap', host: 'localhost.' }, p), 'no port: host decides');
  assert.ok(urlMatchesProfile({ scheme: 'ldap', host: '' }, p));
  assert.ok(!urlMatchesProfile({ scheme: 'ldap', host: 'otherhost.example', port: 389 }, p));
  assert.ok(!urlMatchesProfile({ scheme: 'ldaps', host: 'localhost', port: 636 }, p));
});
