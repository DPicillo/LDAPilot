// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLoadError, connectionMarkers, emitEntryEvent, entryLabel, historyAfterMove, isEntryEventDetail, onEntryEvent, parseRecents,
  rebaseDN, recentsAfterDelete, recentsAfterMove, recentsSetObjectClass, recentsTouch, tabIdOf, tabNeedsReload, tabsAfterDelete,
  tabsAfterMove, tabsOfDN, type RecentEntry,
} from '../src/lib/entryEvents.ts';
import type { EditorTab } from '../src/types/ui.ts';

const tab = (profileId: string, dn: string, extra: Partial<EditorTab> = {}): EditorTab => ({
  id: tabIdOf(profileId, dn), profileId, dn, label: entryLabel(dn), dirty: false, ...extra,
});

test('rebaseDN keeps the RDNs below the moved base', () => {
  assert.equal(rebaseDN('CN=A,OU=X,DC=lab', 'CN=A,OU=X,DC=lab', 'CN=B,OU=X,DC=lab'), 'CN=B,OU=X,DC=lab');
  assert.equal(rebaseDN('cn=child,CN=A,OU=X,DC=lab', 'cn=a,ou=x,dc=lab', 'CN=A,OU=Y,DC=lab'), 'cn=child,CN=A,OU=Y,DC=lab');
  assert.equal(rebaseDN('CN=Schmidt\\, Anna,OU=X,DC=lab', 'OU=X,DC=lab', 'OU=Z,DC=lab'), 'CN=Schmidt\\, Anna,OU=Z,DC=lab');
  assert.equal(rebaseDN('CN=Other,OU=Y,DC=lab', 'OU=X,DC=lab', 'OU=Z,DC=lab'), null);
  // Not a suffix match on raw text: OU=XX is not below OU=X
  assert.equal(rebaseDN('CN=A,OU=XX,DC=lab', 'OU=X,DC=lab', 'OU=Z,DC=lab'), null);
  assert.equal(rebaseDN('', 'OU=X', 'OU=Y'), null);
});

test('tabsAfterMove re-keys moved tabs and their descendants, keeps flags and order', () => {
  const tabs = [
    tab('p1', 'CN=One,OU=X,DC=lab', { preview: true, dirty: true, loadedAt: 5, state: { kind: 'error', message: 'x' } }),
    tab('p1', 'CN=Kid,CN=One,OU=X,DC=lab'),
    tab('p2', 'CN=One,OU=X,DC=lab'),
    { id: '__server-info__', profileId: '', label: 'Server Info', dn: '', dirty: false },
  ];
  const { tabs: out, renamed } = tabsAfterMove(tabs, 'p1', 'CN=One,OU=X,DC=lab', 'CN=Uno,OU=X,DC=lab');
  assert.deepEqual(out.map((t) => t.id), ['p1:CN=Uno,OU=X,DC=lab', 'p1:CN=Kid,CN=Uno,OU=X,DC=lab', 'p2:CN=One,OU=X,DC=lab', '__server-info__']);
  assert.equal(out[0].label, 'Uno');
  assert.equal(out[0].preview, true);
  assert.equal(out[0].dirty, true);
  assert.equal(out[0].state, undefined, 'a moved tab reloads');
  assert.equal(out[0].loadedAt, undefined);
  assert.deepEqual(renamed, { 'p1:CN=One,OU=X,DC=lab': 'p1:CN=Uno,OU=X,DC=lab', 'p1:CN=Kid,CN=One,OU=X,DC=lab': 'p1:CN=Kid,CN=Uno,OU=X,DC=lab' });
  // Nothing moved: the same array comes back
  const same = tabsAfterMove(tabs, 'p1', 'CN=Nope,DC=lab', 'CN=Still,DC=lab');
  assert.equal(same.tabs, tabs);
});

test('tabsAfterMove merges into an already open tab of the new DN', () => {
  const tabs = [tab('p1', 'CN=Old,DC=lab'), tab('p1', 'CN=New,DC=lab')];
  const { tabs: out, renamed } = tabsAfterMove(tabs, 'p1', 'CN=Old,DC=lab', 'CN=New,DC=lab');
  assert.deepEqual(out.map((t) => t.id), ['p1:CN=New,DC=lab']);
  assert.equal(renamed['p1:CN=Old,DC=lab'], 'p1:CN=New,DC=lab');
});

test('tabsAfterDelete marks the entry (and with subtree its descendants) deleted', () => {
  const tabs = [tab('p1', 'OU=Gone,DC=lab'), tab('p1', 'CN=Kid,OU=Gone,DC=lab'), tab('p1', 'CN=Keep,DC=lab'), tab('p2', 'OU=Gone,DC=lab')];
  const leaf = tabsAfterDelete(tabs, 'p1', 'ou=gone,dc=lab', false, 42);
  assert.deepEqual(leaf.hit, ['p1:OU=Gone,DC=lab']);
  assert.deepEqual(leaf.tabs[0].state, { kind: 'deleted', at: 42, subtree: false });
  assert.equal(leaf.tabs[1].state, undefined);
  const sub = tabsAfterDelete(tabs, 'p1', 'OU=Gone,DC=lab', true, 42);
  assert.deepEqual(sub.hit, ['p1:OU=Gone,DC=lab', 'p1:CN=Kid,OU=Gone,DC=lab']);
  assert.equal(sub.tabs[3].state, undefined, 'other connection untouched');
  assert.equal(tabsAfterDelete(tabs, 'p1', 'CN=None,DC=lab', true, 1).tabs, tabs);
  assert.equal(tabsOfDN(tabs, 'p1', 'cn=keep, dc=lab').length, 1);
});

test('tabNeedsReload: failed / deleted tabs and tabs older than a move or restore', () => {
  assert.equal(tabNeedsReload({ loadedAt: 10 }, undefined), false);
  assert.equal(tabNeedsReload({ loadedAt: 10 }, 5), false);
  assert.equal(tabNeedsReload({ loadedAt: 10 }, 20), true);
  assert.equal(tabNeedsReload({}, 20), true);
  assert.equal(tabNeedsReload({ loadedAt: 99, state: { kind: 'deleted', at: 1, subtree: false } }, undefined), true);
  assert.equal(tabNeedsReload({ loadedAt: 99, state: { kind: 'missing', message: 'x', code: 32 } }, undefined), true);
});

test('historyAfterMove follows the move', () => {
  const h = [{ profileId: 'p1', dn: 'CN=A,DC=lab' }, { profileId: 'p2', dn: 'CN=A,DC=lab' }];
  const out = historyAfterMove(h, 'p1', 'CN=A,DC=lab', 'CN=B,DC=lab');
  assert.deepEqual(out, [{ profileId: 'p1', dn: 'CN=B,DC=lab' }, { profileId: 'p2', dn: 'CN=A,DC=lab' }]);
  assert.equal(historyAfterMove(h, 'p1', 'CN=Z,DC=lab', 'CN=Y,DC=lab'), h);
});

test('recent entries: touch keeps the objectClass, follow moves, drop deletes', () => {
  let list: RecentEntry[] = [];
  list = recentsTouch(list, 'p1', 'CN=A,OU=X,DC=lab', 1);
  list = recentsTouch(list, 'p1', 'CN=B,OU=X,DC=lab', 2);
  assert.deepEqual(list.map((r) => r.label), ['B', 'A']);
  const withOc = recentsSetObjectClass(list, 'p1', 'cn=a,ou=x,dc=lab', ['top', 'person']);
  assert.ok(withOc);
  assert.deepEqual(withOc![1].objectClass, ['top', 'person']);
  assert.equal(recentsSetObjectClass(withOc!, 'p1', 'CN=A,OU=X,DC=lab', ['top', 'person']), null, 'unchanged');
  list = recentsTouch(withOc!, 'p1', 'CN=A,OU=X,DC=lab', 3);
  assert.deepEqual(list[0].objectClass, ['top', 'person'], 'touch keeps the known objectClass');
  const moved = recentsAfterMove(list, 'p1', 'OU=X,DC=lab', 'OU=Y,DC=lab');
  assert.deepEqual(moved!.map((r) => r.dn), ['CN=A,OU=Y,DC=lab', 'CN=B,OU=Y,DC=lab']);
  assert.equal(recentsAfterMove(list, 'p2', 'OU=X,DC=lab', 'OU=Y,DC=lab'), null);
  // A move onto an entry that is already listed keeps one record
  const merged = recentsAfterMove(list, 'p1', 'CN=A,OU=X,DC=lab', 'CN=B,OU=X,DC=lab');
  assert.equal(merged!.length, 1);
  assert.deepEqual(recentsAfterDelete(list, 'p1', 'CN=A,OU=X,DC=lab', false)!.map((r) => r.label), ['B']);
  assert.deepEqual(recentsAfterDelete(list, 'p1', 'OU=X,DC=lab', true), []);
  assert.equal(recentsAfterDelete(list, 'p1', 'OU=Q,DC=lab', true), null);
  for (let i = 0; i < 40; i++) list = recentsTouch(list, 'p1', `CN=E${i},DC=lab`, i);
  assert.equal(list.length, 30);
});

test('parseRecents tolerates bad storage', () => {
  assert.deepEqual(parseRecents(null), []);
  assert.deepEqual(parseRecents('{'), []);
  assert.deepEqual(parseRecents('{"a":1}'), []);
  assert.equal(parseRecents('[{"profileId":"p","dn":"CN=A"},{"dn":"x"},null]').length, 1);
});

test('classifyLoadError: noSuchObject, offline, other errors with their code', () => {
  assert.deepEqual(classifyLoadError('LDAP search failed: No Such Object: acl_read: Error retrieving instanceType for base.'), {
    kind: 'missing', code: 32, message: 'No Such Object: acl_read: Error retrieving instanceType for base.',
  });
  assert.equal(classifyLoadError('LDAP entry not found: CN=x').kind, 'missing');
  assert.equal(classifyLoadError(new Error('LDAP Result Code 32 "No Such Object": ')).kind, 'missing');
  assert.equal(classifyLoadError('not connected to LDAP server').kind, 'offline');
  assert.equal(classifyLoadError('LDAP search failed: Network Error: read tcp: connection reset by peer').code, 200);
  assert.equal(classifyLoadError('LDAP search failed: Network Error: x').kind, 'offline');
  const denied = classifyLoadError('LDAP search failed: Insufficient Access Rights: no read access');
  assert.equal(denied.kind, 'error');
  assert.equal(denied.code, 50);
  assert.equal(classifyLoadError(undefined).message, 'Failed to load the entry');
  assert.equal(classifyLoadError('LDAP search failed: Other: boom').code, undefined);
});

test('connectionMarkers drop the shared words and stay distinct', () => {
  assert.deepEqual(connectionMarkers({ a: 'Lab · Samba AD (LDAPS)', b: 'Lab · OpenLDAP', c: 'Lab · 389 Directory Server' }), {
    a: 'Samba AD (L…', b: 'OpenLDAP', c: '389 Directo…',
  });
  assert.deepEqual(connectionMarkers({ a: 'UX-C OL', b: 'UX-C OL-RO', c: 'UX-C DS' }), { a: 'OL', b: 'OL-RO', c: 'DS' });
  assert.deepEqual(connectionMarkers({ a: 'Prod', b: 'Prod' }), { a: 'Prod', b: 'Prod #2' });
  assert.deepEqual(connectionMarkers({ a: 'Single name' }), { a: 'Single name' });
});

test('event details are checked before use; emit is a no-op without window', () => {
  assert.equal(isEntryEventDetail('ldapilot:entry-moved', { profileId: 'p', oldDN: 'a', newDN: 'b' }), true);
  assert.equal(isEntryEventDetail('ldapilot:entry-moved', { profileId: 'p', dn: 'a' }), false);
  assert.equal(isEntryEventDetail('ldapilot:entry-deleted', { profileId: 'p', dn: 'a', subtree: true }), true);
  assert.equal(isEntryEventDetail('ldapilot:entry-deleted', { profileId: 'p', dn: 'a', subtree: 'yes' }), false);
  assert.equal(isEntryEventDetail('ldapilot:entry-restored', null), false);
  assert.equal(isEntryEventDetail('ldapilot:entry-loaded', { profileId: 'p', dn: 'a', objectClass: [] }), true);
  emitEntryEvent('ldapilot:entry-restored', { profileId: 'p', dn: 'a' });
  const off = onEntryEvent('ldapilot:entry-restored', () => {});
  off();
});

test('events reach typed listeners and skip malformed raw details', () => {
  const target = new EventTarget();
  const g = globalThis as unknown as { window?: EventTarget };
  const had = 'window' in g;
  g.window = target;
  try {
    const got: string[] = [];
    const off = onEntryEvent('ldapilot:entry-moved', (d) => got.push(`${d.oldDN}->${d.newDN}`));
    emitEntryEvent('ldapilot:entry-moved', { profileId: 'p', oldDN: 'CN=A', newDN: 'CN=B' });
    target.dispatchEvent(new CustomEvent('ldapilot:entry-moved', { detail: { profileId: 'p' } }));
    off();
    emitEntryEvent('ldapilot:entry-moved', { profileId: 'p', oldDN: 'CN=B', newDN: 'CN=C' });
    assert.deepEqual(got, ['CN=A->CN=B']);
  } finally {
    if (!had) delete g.window;
  }
});
