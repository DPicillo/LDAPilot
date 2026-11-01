// UX loop round 2: shortcut dispatch, refresh targets, foreign selections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatcherSkips, isReloadKey } from '../src/components/ui/shortcuts.ts';
import { refreshTarget } from '../src/components/commands/targets.ts';

test('F5 reaches the registry although the reload guard prevented the page reload (RW1-E-01)', () => {
  const f5 = { key: 'F5', defaultPrevented: true };
  assert.equal(isReloadKey({ key: 'F5' }), true);
  assert.equal(isReloadKey({ key: 'F5', altKey: true }), false);
  assert.equal(dispatcherSkips(f5, true), false, 'prevented by the reload guard: entry.refresh still runs');
  assert.equal(dispatcherSkips(f5, false), true, 'prevented by someone else (a widget handled it)');
  assert.equal(dispatcherSkips({ key: 'F5', defaultPrevented: false }), false);
  assert.equal(dispatcherSkips({ key: 'Escape', defaultPrevented: false }), true);
  assert.equal(dispatcherSkips({ key: 'k', defaultPrevented: false, isComposing: true }), true);
  assert.equal(dispatcherSkips({ key: 'Shift', defaultPrevented: false }), true);
});

test('no tab, no selection: F5 / palette / Entry menu refresh the tree (RW1-N-03)', () => {
  for (const source of ['editor', 'tab', 'palette', 'menubar', 'results', 'list'] as const) {
    assert.deepEqual(refreshTarget({ selection: [], source }, { tabOpen: false }), { kind: 'tree' }, source);
  }
  assert.deepEqual(refreshTarget({ selection: [], source: 'palette' }, { tabOpen: true }), { kind: 'tree' }, 'palette with a special tab: Refresh Tree');
  assert.deepEqual(refreshTarget({ selection: [], source: 'tab' }, { tabOpen: true }), { kind: 'none' }, 'F5 inside a special tab');
  assert.deepEqual(
    refreshTarget({ selection: [], source: 'menubar', foreign: { profileId: 'p2', name: 'Other', count: 1 } }, { tabOpen: true }),
    { kind: 'none' },
  );
});
