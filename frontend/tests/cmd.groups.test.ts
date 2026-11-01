// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSummary, entryOutcome, groupsFor, outcomeText, outcomeTone } from '../src/components/commands/addToGroups.ts';

const groups = [
  { dn: 'CN=Sales,OU=Groups,DC=lab', name: 'Sales' },
  { dn: 'CN=VPN,OU=Groups,DC=lab', name: 'VPN' },
];

test('a group is never added to itself (nesting a selection of groups)', () => {
  assert.deepEqual(groupsFor('cn=sales,ou=groups,dc=lab', groups), { send: ['CN=VPN,OU=Groups,DC=lab'], self: true });
  assert.deepEqual(groupsFor('CN=Anna,DC=lab', groups).send.length, 2);
});

test('the result names every entry: added, already a member, failed', () => {
  const o = entryOutcome('CN=Schmidt\\, Anna,DC=lab', {
    changed: ['CN=Sales,OU=Groups,DC=lab'],
    unchanged: ['CN=VPN,OU=Groups,DC=lab'],
    failed: [{ dn: 'CN=Admins,DC=lab', error: 'insufficient access' }],
  }, false);
  assert.equal(outcomeText(o), 'added to Sales · already in VPN · failed: Admins (insufficient access)');
  assert.equal(outcomeTone(o), 'danger');
  const self = entryOutcome('CN=Sales,OU=Groups,DC=lab', null, true);
  assert.equal(outcomeText(self), 'not added to itself');
  assert.equal(outcomeText(entryOutcome('CN=x,DC=lab', null, false, 'read-only connection')), 'failed: read-only connection');
});

test('summary toast', () => {
  const ok = entryOutcome('CN=Anna,DC=lab', { changed: groups.map((g) => g.dn), unchanged: [], failed: [] }, false);
  assert.deepEqual(addSummary([ok], 2), { text: 'Added Anna to 2 groups', failed: 0 });
  const bad = entryOutcome('CN=Bob,DC=lab', { changed: [], unchanged: [], failed: [{ dn: groups[0].dn, error: 'x' }] }, false);
  assert.deepEqual(addSummary([ok, bad], 2), { text: 'Added 1 of 2 entries to 2 groups, 1 failed', failed: 1 });
});
