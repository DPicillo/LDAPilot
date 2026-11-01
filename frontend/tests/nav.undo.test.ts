// Run: cd frontend && node --test 'tests/*.test.ts'
// RW3-N-04: undo of moves / bookmark changes from the toast, the bell and Ctrl+Z.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNDO_LIFETIME_MS, invalidateUndos, latestUndo, liveUndo, registerUndo, resetUndos, runUndo, subscribeUndo, undoButton, undoIdOf, undoVersion } from '../src/components/ui/undo.ts';
import { blocksInEditable } from '../src/components/ui/shortcuts.ts';

const D = 'DC=ad,DC=x';

test('an undo runs once, the newest of the connection first, until it expires', async () => {
  resetUndos();
  let ran: string[] = [];
  const t0 = 1_000_000;
  const a = registerUndo({ label: 'Move of a', profileId: 'ad', dns: [`CN=a,OU=t,${D}`, `OU=s,${D}`], run: () => { ran.push('a'); } }, t0);
  const b = registerUndo({ label: 'Remove Bookmark', profileId: 'ol', run: () => { ran.push('b'); } }, t0 + 1);
  assert.equal(latestUndo('ad', t0 + 2)?.id, a.id);
  assert.equal(latestUndo('ol', t0 + 2)?.id, b.id);
  assert.equal(latestUndo(undefined, t0 + 2)?.id, b.id);
  assert.equal(latestUndo('other', t0 + 2), undefined);
  const v = undoVersion();
  assert.deepEqual(await runUndo(a.id, t0 + 3), { result: 'done' });
  assert.ok(undoVersion() > v);
  assert.equal((await runUndo(a.id, t0 + 4)).result, 'gone', 'only once');
  assert.deepEqual(ran, ['a']);
  assert.equal(latestUndo('ad', t0 + 5), undefined);
  // Expiry.
  assert.ok(liveUndo(b.id, t0 + UNDO_LIFETIME_MS));
  assert.equal(liveUndo(b.id, t0 + 1 + UNDO_LIFETIME_MS), undefined);
  assert.deepEqual(await runUndo(b.id, t0 + 2 + UNDO_LIFETIME_MS), { result: 'gone', reason: 'expired' });
  assert.deepEqual(ran, ['a']);
});

test('moving or deleting the moved entries (or their old parent) ends the undo', async () => {
  resetUndos();
  const now = Date.now();
  const u = registerUndo({ label: 'Move of a', profileId: 'ad', dns: [`CN=a,OU=t,${D}`, `OU=s,${D}`], run: () => {} }, now);
  assert.equal(invalidateUndos('ol', `OU=t,${D}`, 'moved or renamed since'), 0, 'other connection');
  assert.equal(invalidateUndos('ad', `CN=other,OU=t,${D}`, 'moved or renamed since'), 0, 'a sibling');
  assert.ok(liveUndo(u.id, now));
  // The target container was renamed: the entry below it has another DN now.
  assert.equal(invalidateUndos('ad', `OU=t,${D}`, 'moved or renamed since'), 1);
  assert.equal(liveUndo(u.id, now), undefined);
  assert.deepEqual(await runUndo(u.id, now), { result: 'gone', reason: 'moved or renamed since' });
  const w = registerUndo({ label: 'Move of b', profileId: 'ad', dns: [`CN=b,OU=t,${D}`, `OU=s,${D}`], run: () => {} }, now);
  assert.equal(invalidateUndos('ad', `ou=S,${D.toLowerCase()}`, 'deleted since'), 1, 'old parent deleted (DNs compare normalized)');
  assert.equal(liveUndo(w.id, now), undefined);
});

test('toast buttons find their undo again (bell) and report a gone undo', async () => {
  resetUndos();
  let gone: string | undefined = 'none';
  const u = registerUndo({ label: 'Add Bookmark', profileId: 'ad', run: () => {} });
  const btn = undoButton(u, (r) => { gone = r; });
  assert.equal(btn.label, 'Undo');
  assert.equal(undoIdOf(btn), u.id);
  assert.equal(undoIdOf({ label: 'Undo', run: () => {} }), undefined);
  assert.equal(undoIdOf(null), undefined);
  let calls = 0;
  const off = subscribeUndo(() => calls++);
  btn.run();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(liveUndo(u.id), undefined);
  btn.run();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gone, undefined, 'a second click reports it as gone');
  assert.ok(calls >= 1);
  off();
});

test('Ctrl+Z stays the text field undo', () => {
  assert.ok(blocksInEditable('Mod+Z'));
  assert.ok(blocksInEditable('Ctrl+Shift+Z'));
  assert.ok(blocksInEditable('Ctrl+Y'));
  assert.ok(!blocksInEditable('Ctrl+K'));
});
