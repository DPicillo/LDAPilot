// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createListRegistry, createSourceTracker } from '../src/components/commands/selectionSource.ts';
import { createParent, createsSibling, refreshTarget } from '../src/components/commands/targets.ts';

test('the Contents list is a selection source like the tree and the results', () => {
  const t = createSourceTracker('tab');
  t.set('tree');
  t.set('list'); // rows selected in OU=Special Cases → Entry ▸ Delete targets them
  assert.equal(t.current(), 'list');
  t.focus('tree', true); // a closing menu hands focus back: no change
  assert.equal(t.current(), 'list');
  t.focus('tab');
  assert.equal(t.current(), 'tab');
});

test('the list the user last worked in is the active one; another takes over when it unmounts', () => {
  const r = createListRegistry<string>();
  const offA = r.add('a', 'standalone');
  const offB = r.add('b', 'embedded');
  assert.equal(r.active(), 'standalone', 'the first mounted is active until another is used');
  r.activate('b');
  assert.equal(r.active(), 'embedded');
  offB();
  assert.equal(r.active(), 'standalone');
  offA();
  assert.equal(r.active(), undefined);
  r.activate('a');
  assert.equal(r.activeId(), null, 'activating an unmounted list does nothing');
});

const item = (dn: string, kind: 'user' | 'ou' | 'container' | 'other') => ({ dn, kind });

test('New ▸ / Ctrl+N: in a container, next to a leaf (its parent), in the shown container of an empty Contents selection', () => {
  assert.equal(createParent({ selection: [item('OU=Special Cases,DC=lab', 'ou')] }), 'OU=Special Cases,DC=lab');
  assert.equal(createParent({ selection: [item('CN=Schmidt\\, Anna,OU=Special Cases,DC=lab', 'user')] }), 'OU=Special Cases,DC=lab');
  assert.ok(createsSibling({ selection: [item('CN=Schmidt\\, Anna,OU=Special Cases,DC=lab', 'user')] }));
  assert.ok(!createsSibling({ selection: [item('OU=Special Cases,DC=lab', 'ou')] }));
  assert.equal(createParent({ selection: [], containerDN: 'OU=Bulk,DC=lab' }), 'OU=Bulk,DC=lab');
  assert.equal(createParent({ selection: [] }), null);
  assert.equal(createParent({ selection: [item('CN=a,DC=lab', 'user'), item('CN=b,DC=lab', 'user')] }), null);
});

test('F5: the selected entry; a Contents list; else the tree outside a region', () => {
  assert.deepEqual(refreshTarget({ selection: [item('CN=u,DC=lab', 'user')], source: 'tab' }), { kind: 'entry', dn: 'CN=u,DC=lab' });
  assert.deepEqual(refreshTarget({ selection: [], containerDN: 'OU=Bulk,DC=lab', source: 'list' }), { kind: 'container', dn: 'OU=Bulk,DC=lab' });
  assert.deepEqual(refreshTarget({ selection: [], source: 'editor' }), { kind: 'tree' });
  assert.deepEqual(refreshTarget({ selection: [item('CN=a', 'user'), item('CN=b', 'user')], source: 'tree' }), { kind: 'tree' });
  assert.deepEqual(refreshTarget({ selection: [], source: 'tab' }), { kind: 'none' }, 'a special tab (Server Info) has nothing to refresh');
  assert.deepEqual(refreshTarget({ selection: [], source: 'tab' }, { tabOpen: true }), { kind: 'none' });
  assert.deepEqual(refreshTarget({ selection: [], source: 'tab' }, { tabOpen: false }), { kind: 'tree' }, 'no tab open (welcome screen): F5 = Refresh Tree');
  assert.deepEqual(
    refreshTarget({ selection: [], source: 'tab', foreign: { profileId: 'p2', name: 'Other', count: 1 } }, { tabOpen: true }),
    { kind: 'none' },
    'a tab of another connection never refreshes the active tree',
  );
});
