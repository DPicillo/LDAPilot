// Run: cd frontend && node --test 'tests/*.test.ts'
// LDIF import helpers: rebase an export into another container, skeleton,
// the records of "Retry failed".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ldifRecordDNs, ldifRecordsAt, ldifSkeleton, rebaseLDIF } from '../src/components/export/ldifRebase.ts';
import { utf8ToBase64 } from '../src/lib/ldif.ts';

const EXPORT = [
  'version: 1',
  '',
  'dn: OU=Special Cases,OU=LDAPilot,DC=ad,DC=lab',
  'objectClass: organizationalUnit',
  'ou: Special Cases',
  '',
  'dn: CN=Schmidt\\, Anna,OU=Special Cases,OU=LDAPilot,DC=ad,DC=lab',
  'objectClass: user',
  'manager: CN=Boss,OU=Special Cases,OU=LDAPilot,DC=ad,DC=lab',
  'memberOf: CN=Domain Users,CN=Users,DC=ad,DC=lab',
  '',
  'dn:: ' + utf8ToBase64('CN=Jürgen,OU=Special Cases,OU=LDAPilot,DC=ad,DC=lab'),
  'objectClass: user',
  'description: OU=Special Cases,OU=LDAPilot,DC=ad,DC=lab is not a DN value here?',
  '',
].join('\n');

test('rebaseLDIF moves the topmost records and everything below them into the target', () => {
  const r = rebaseLDIF(EXPORT, 'OU=ux-search,OU=Track-ux,DC=ad,DC=lab');
  assert.equal(r.oldBase, 'OU=LDAPilot,DC=ad,DC=lab');
  assert.deepEqual(ldifRecordDNs(r.content), [
    'OU=Special Cases,OU=ux-search,OU=Track-ux,DC=ad,DC=lab',
    'CN=Schmidt\\, Anna,OU=Special Cases,OU=ux-search,OU=Track-ux,DC=ad,DC=lab',
    'CN=Jürgen,OU=Special Cases,OU=ux-search,OU=Track-ux,DC=ad,DC=lab',
  ]);
  // DN values into the moved entries follow, others stay
  assert.match(r.content.replace(/\n /g, ''), /manager: CN=Boss,OU=Special Cases,OU=ux-search,OU=Track-ux,DC=ad,DC=lab/);
  assert.match(r.content, /memberOf: CN=Domain Users,CN=Users,DC=ad,DC=lab/);
  // base64 stays base64 (non-ASCII), lines are folded at 76 columns
  assert.ok(r.content.split('\n').every((l) => l.length <= 76));
  assert.ok(r.content.includes('dn:: '));
  // 3 record DNs + manager; the description text is left alone
  assert.equal(r.changed, 4);
  assert.match(r.content, /description: OU=Special Cases,OU=LDAPilot,DC=ad,DC=lab is not/);
  // Already there: nothing to do
  assert.equal(rebaseLDIF(r.content, 'OU=ux-search,OU=Track-ux,DC=ad,DC=lab').changed, 0);
});

test('rebaseLDIF completes relative DNs and rebases newsuperior lines', () => {
  const rel = rebaseLDIF('dn: ou=New\nobjectClass: organizationalUnit\n\ndn: cn=x,ou=New\nobjectClass: device\n', 'ou=sandbox,dc=demo');
  assert.equal(rel.oldBase, '');
  assert.deepEqual(ldifRecordDNs(rel.content), ['ou=New,ou=sandbox,dc=demo', 'cn=x,ou=New,ou=sandbox,dc=demo']);
  const mod = rebaseLDIF('dn: cn=a,ou=old,dc=x\nchangetype: modrdn\nnewrdn: cn=b\ndeleteoldrdn: 1\nnewsuperior: ou=old,dc=x\n', 'ou=new,dc=x');
  assert.match(mod.content, /dn: cn=a,ou=new,dc=x/);
  assert.match(mod.content, /newsuperior: ou=new,dc=x/);
  assert.match(mod.content, /newrdn: cn=b/);
});

test('ldifRecordsAt returns the records starting at the given dn: lines', () => {
  const text = 'version: 1\n\ndn: cn=a\nchangetype: delete\n\ndn: cn=b\nchangetype: delete\n\ndn: cn=c\nchangetype: delete\n';
  assert.equal(ldifRecordsAt(text, [9, 3, 9]), 'version: 1\n\ndn: cn=a\nchangetype: delete\n\ndn: cn=c\nchangetype: delete\n');
  assert.equal(ldifRecordsAt(text, [99]), '');
});

test('ldifSkeleton creates an OU below the container in its naming style', () => {
  assert.match(ldifSkeleton('OU=Sandbox,DC=ad,DC=lab'), /^dn: OU=New OU,OU=Sandbox,DC=ad,DC=lab$/m);
  assert.match(ldifSkeleton('ou=sandbox,dc=demo'), /^dn: ou=New OU,ou=sandbox,dc=demo$/m);
});
