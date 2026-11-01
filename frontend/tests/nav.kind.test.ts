// Run: cd frontend && node --test 'tests/*.test.ts'
// Cross-note (A via N): the OpenLDAP suffix dc=demo (organization + dcObject) is a domain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OBJECT_KIND_LABEL, isContainerKind, resolveObjectKind } from '../src/components/ui/objectKind.ts';

test('domain components rank before organization, OUs stay OUs', () => {
  // The three lab roots.
  assert.equal(resolveObjectKind(['top', 'dcObject', 'organization']), 'domain', 'OpenLDAP dc=demo');
  assert.equal(OBJECT_KIND_LABEL[resolveObjectKind(['organization', 'dcObject'])], 'Domain');
  assert.equal(resolveObjectKind(['top', 'domain']), 'domain', '389DS dc=dirsrv');
  assert.equal(resolveObjectKind(['top', 'domain', 'domainDNS']), 'domain', 'AD domain');
  // Other entries keep their kind.
  assert.equal(resolveObjectKind(['top', 'organization']), 'ou', 'o=Company');
  assert.equal(resolveObjectKind(['top', 'organizationalUnit']), 'ou');
  assert.equal(resolveObjectKind(['top', 'organizationalUnit', 'dcObject']), 'ou', 'an OU with a dc stays an OU');
  assert.equal(resolveObjectKind(['top', 'container']), 'container');
  assert.equal(resolveObjectKind(['inetOrgPerson', 'organizationalPerson', 'person']), 'user');
  // Both are containers: menus, Contents and drop targets do not change.
  assert.ok(isContainerKind(resolveObjectKind(['organization', 'dcObject'])));
});
