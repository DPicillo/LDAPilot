// Run: cd frontend && node --test 'tests/*.test.ts'
// ContainerPicker logic, lifecycle events, delete/restore helpers (LIFE-04…08).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  containerName, isContainerNode, loadRecentTargets, looksLikeDN, matchesContainerFilter, pathFromRoot, rememberTarget,
  forgetTarget, targetProblem, withRecentTarget, RECENT_TARGETS_MAX, type KeyValueStorage,
} from '../src/components/lifecycle/containerPickerModel.ts';
import { emitEntryMoved } from '../src/components/lifecycle/events.ts';
import {
  deleteConfirmation, deleteReportText, deleteToastText, deletedEvents, describeRestoreLoss, friendlyTypeName, nearestExisting,
  rangeBetween, restoreTargetCandidates, typedConfirmationMatches, withDeletedChildren, isNamingContextDN,
  type DeleteReportOutcome,
} from '../src/lib/recycle.ts';

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

test('container nodes: containers (also empty ones), never accounts or groups', () => {
  assert.equal(isContainerNode({ dn: 'ou=empty', hasChildren: false, objectClass: ['top', 'organizationalUnit'] }), true);
  assert.equal(isContainerNode({ dn: 'cn=Users', hasChildren: true, objectClass: ['top', 'container'] }), true);
  assert.equal(isContainerNode({ dn: 'dc=ad', hasChildren: true, objectClass: ['top', 'domain', 'domainDNS'] }), true);
  assert.equal(isContainerNode({ dn: 'cn=u', hasChildren: true, objectClass: ['top', 'person', 'user'] }), false);
  assert.equal(isContainerNode({ dn: 'cn=g', hasChildren: false, objectClass: ['top', 'groupOfNames'] }), false);
  assert.equal(isContainerNode({ dn: 'cn=x', hasChildren: true, objectClass: ['top', 'applicationProcess'] }), true);
  assert.equal(isContainerNode({ dn: 'cn=x', hasChildren: false, objectClass: ['top', 'applicationProcess'] }), false);
});

test('target checks: empty, self, below, same parent, DN shape', () => {
  const moving = ['CN=Doe\\, John,OU=A,DC=x', 'CN=B,OU=A,DC=x'];
  assert.equal(targetProblem('', moving), 'empty');
  assert.equal(targetProblem('cn=doe\\, john, ou=a,dc=x', moving), 'self');
  assert.equal(targetProblem('OU=Sub,CN=Doe\\, John,OU=A,DC=x', moving), 'below');
  assert.equal(targetProblem('ou=a,dc=x', moving), 'sameParent');
  assert.equal(targetProblem('OU=B,DC=x', moving), '');
  assert.equal(targetProblem('OU=A,DC=x', []), '', 'no entries moved (copy/restore): any container');
  assert.equal(looksLikeDN('OU=Sales,DC=x'), true);
  assert.equal(looksLikeDN('Sales'), false);
  assert.equal(containerName('OU=Sales\\, EU,DC=x'), 'Sales, EU');
  assert.equal(matchesContainerFilter('OU=Sales\\, EU,DC=x', 'sales'), true);
  assert.equal(matchesContainerFilter('OU=Sales,DC=x', 'hr'), false);
});

test('recent targets per connection: most recent first, unique, capped', () => {
  const s = memoryStorage();
  for (let i = 0; i < 10; i++) rememberTarget('p1', `ou=t${i},dc=x`, s);
  rememberTarget('p1', 'OU=T3, DC=x', s);
  const list = loadRecentTargets('p1', s);
  assert.equal(list.length, RECENT_TARGETS_MAX);
  assert.equal(list[0], 'OU=T3, DC=x');
  assert.equal(list.filter((d) => d.toLowerCase().replace(/\s/g, '') === 'ou=t3,dc=x').length, 1);
  assert.deepEqual(loadRecentTargets('p2', s), []);
  forgetTarget('p1', 'ou=t3,dc=x', s);
  assert.ok(!loadRecentTargets('p1', s).some((d) => /t3/i.test(d)));
  s.setItem('ldapilot.lifecycle.recentTargets.bad', '{not json');
  assert.deepEqual(loadRecentTargets('bad', s), []);
  assert.deepEqual(withRecentTarget(['a=1'], ' b=2 '), ['b=2', 'a=1']);
  assert.deepEqual(loadRecentTargets('p1', null), []);
});

test('pathFromRoot expands from the deepest matching root', () => {
  assert.deepEqual(pathFromRoot('ou=b,ou=a,dc=x', ['dc=x', 'cn=Configuration,dc=x']), ['dc=x', 'ou=a,dc=x', 'ou=b,ou=a,dc=x']);
  assert.deepEqual(pathFromRoot('CN=Schema,CN=Configuration,DC=x', ['DC=x', 'CN=Configuration,DC=x']), ['CN=Configuration,DC=x', 'CN=Schema,CN=Configuration,DC=x']);
  assert.deepEqual(pathFromRoot('o=other', ['dc=x']), []);
});

test('lifecycle events are a no-op without window (node)', () => {
  assert.doesNotThrow(() => emitEntryMoved('p', 'cn=a,dc=x', 'cn=b,dc=x'));
});

test('typed delete confirmation for naming contexts and large deletes (LIFE-08)', () => {
  const isNC = (dn: string) => isNamingContextDN(dn, ['dc=demo,dc=ldapilot,dc=local']);
  const nc = deleteConfirmation(['DC=demo, DC=ldapilot,DC=local'], isNC, 354, true);
  assert.equal(nc.kind, 'typeDN');
  assert.equal(typedConfirmationMatches(nc, 'dc=demo,dc=ldapilot,dc=local'), true);
  assert.equal(typedConfirmationMatches(nc, 'dc=demo'), false);
  const big = deleteConfirmation(['ou=big,dc=x'], () => false, 501, true);
  assert.deepEqual(big, { kind: 'typeCount', phrase: 'DELETE 501', ncHeads: [] });
  assert.equal(typedConfirmationMatches(big, ' DELETE 501 '), true);
  assert.equal(typedConfirmationMatches(big, 'delete 501'), false);
  assert.equal(deleteConfirmation(['ou=small,dc=x'], () => false, 12, true).kind, 'checkbox');
  assert.equal(deleteConfirmation(['cn=leaf,dc=x'], () => false, 1, false).kind, 'none');
  assert.equal(deleteConfirmation(['dc=a', 'cn=leaf,dc=x'], (d) => d === 'dc=a', 2, false).kind, 'typeCount', 'several roots incl. an NC head');
});

test('delete toast, report with DNs, entry-deleted events', () => {
  assert.equal(deleteToastText(['CN=ux-m-contact1,OU=ux,DC=ad']), 'ux-m-contact1 deleted');
  assert.equal(deleteToastText(['cn=a,dc=x', 'cn=b\\, c,dc=x']), '2 entries deleted (a, b, c)');
  assert.match(deleteToastText(['cn=a,dc=x', 'cn=b,dc=x', 'cn=c,dc=x', 'cn=d,dc=x']), /^4 entries deleted \(a, b, c, …\)$/);
  const outcomes: DeleteReportOutcome[] = [
    { dn: 'cn=leaf,dc=x', ok: true, deleted: 1, failed: 0, skipped: 0, cancelled: false, method: 'plain', errors: [], deletedDNs: ['cn=leaf,dc=x'] },
    { dn: 'ou=t,dc=x', ok: false, deleted: 2, failed: 1, skipped: 1, cancelled: false, method: 'clientSide',
      errors: [{ dn: 'cn=p,ou=t,dc=x', message: 'insufficient rights' }, { dn: 'ou=t,dc=x', message: 'skipped', skipped: true }],
      deletedDNs: ['cn=a,cn=p,ou=t,dc=x', 'cn=b,ou=t,dc=x'] },
  ];
  const report = deleteReportText(outcomes, 'Lab OL');
  assert.match(report, /^Delete report \(Lab OL\): 3 deleted, 1 failed, 1 skipped/);
  assert.match(report, /Deleted entries \(3\):\ncn=leaf,dc=x\ncn=a,cn=p,ou=t,dc=x\ncn=b,ou=t,dc=x/);
  assert.match(report, /error cn=p,ou=t,dc=x: insufficient rights/);
  assert.deepEqual(deletedEvents(outcomes), [
    { dn: 'cn=leaf,dc=x', subtree: false },
    { dn: 'cn=a,cn=p,ou=t,dc=x', subtree: false },
    { dn: 'cn=b,ou=t,dc=x', subtree: false },
  ]);
  assert.deepEqual(deletedEvents([{ ...outcomes[1], ok: true, method: 'treeDelete', deletedDNs: ['ou=t,dc=x'] }]), [{ dn: 'ou=t,dc=x', subtree: true }]);
});

test('deleted objects: friendly types, select with children, ranges (LIFE-07)', () => {
  assert.equal(friendlyTypeName({ objectClass: ['top', 'organizationalUnit'], structuralClass: 'organizationalUnit' }), 'OU');
  assert.equal(friendlyTypeName({ objectClass: ['top', 'person', 'organizationalPerson', 'user'], structuralClass: 'user' }), 'User');
  assert.equal(friendlyTypeName({ objectClass: ['top', 'person', 'organizationalPerson', 'user', 'computer'], structuralClass: 'computer' }), 'Computer');
  assert.equal(friendlyTypeName({ objectClass: ['top', 'msExchFoo'], structuralClass: 'msExchFoo' }), 'MsExchFoo');
  const objs = [
    { dn: 'OU=del\\0ADEL:1,CN=Deleted Objects,DC=x', lastKnownParent: 'OU=ux,DC=x', parentDeleted: false },
    { dn: 'CN=c1\\0ADEL:2,CN=Deleted Objects,DC=x', lastKnownParent: 'OU=del\\0ADEL:1,CN=Deleted Objects,DC=x', parentDeleted: true },
    { dn: 'OU=sub\\0ADEL:3,CN=Deleted Objects,DC=x', lastKnownParent: 'OU=del\\0ADEL:1,CN=Deleted Objects,DC=x', parentDeleted: true },
    { dn: 'CN=c2\\0ADEL:4,CN=Deleted Objects,DC=x', lastKnownParent: 'OU=sub\\0ADEL:3,CN=Deleted Objects,DC=x', parentDeleted: true },
    { dn: 'CN=other\\0ADEL:5,CN=Deleted Objects,DC=x', lastKnownParent: 'CN=Users,DC=x', parentDeleted: false },
  ];
  assert.deepEqual(withDeletedChildren(objs, objs[0].dn), [objs[0].dn, objs[1].dn, objs[2].dn, objs[3].dn]);
  assert.deepEqual(withDeletedChildren(objs, objs[4].dn), [objs[4].dn]);
  const order = ['a', 'b', 'c', 'd'];
  assert.deepEqual(rangeBetween(order, 'b', 'd'), ['b', 'c', 'd']);
  assert.deepEqual(rangeBetween(order, 'c', 'a'), ['a', 'b', 'c']);
  assert.deepEqual(rangeBetween(order, null, 'c'), ['c']);
});

test('Restore to… candidates: nearest live ancestor of the last known location, never CN=Users (LIFE-06)', () => {
  const objs = [
    { dn: 'OU=del\\0ADEL:1,CN=Deleted Objects,DC=x', lastKnownParent: 'OU=ux-m,OU=Track-ux,DC=x' },
    { dn: 'CN=c1\\0ADEL:2,CN=Deleted Objects,DC=x', lastKnownParent: 'OU=del\\0ADEL:1,CN=Deleted Objects,DC=x' },
  ];
  const cands = restoreTargetCandidates(objs[1], objs);
  assert.deepEqual(cands, ['OU=ux-m,OU=Track-ux,DC=x', 'OU=Track-ux,DC=x', 'DC=x']);
  assert.ok(!cands.some((c) => /cn=users/i.test(c)));
  const existing = new Set(['OU=Track-ux,DC=x', 'DC=x']);
  assert.equal(nearestExisting(cands, (d) => existing.has(d)), 'OU=Track-ux,DC=x');
  assert.equal(nearestExisting(cands, () => undefined), '');
  // the deleted parent itself is not listed: no live location known
  assert.deepEqual(restoreTargetCandidates({ lastKnownParent: 'OU=gone\\0ADEL:9,CN=Deleted Objects,DC=x' }, []), []);
});

test('restore loss text', () => {
  assert.equal(describeRestoreLoss({ without: ['givenName', 'mail', 'sn', 'password'], withoutOther: 0, linksRemoved: true }), 'givenName, mail, sn, password; group memberships');
  assert.equal(describeRestoreLoss({ without: ['a', 'b', 'c'], withoutOther: 2 }, 2), 'a, b and 3 more attributes');
  assert.equal(describeRestoreLoss({ without: [], withoutOther: 1 }), '1 attribute');
  assert.equal(describeRestoreLoss({}), '');
});
