// Run: cd frontend && node --test 'tests/*.test.ts'
// DEF-20: the delete dialog lists the first descendants as a tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descendantListLimit, descendantListSummary, descendantRows } from '../src/components/recycle/descendantList.ts';

const R = 'OU=ux-del,DC=ad,DC=x';

test('breadth-first DNs become a tree: each entry under its parent, siblings by name (natural)', () => {
  const dns = [`OU=sub,${R}`, `CN=user10,${R}`, `CN=user2,${R}`, `CN=Schmidt\\, Anna,OU=sub,${R}`, `CN=a,OU=deep,OU=sub,${R}`, `OU=deep,OU=sub,${R}`, `cn=user2,${R.toLowerCase()}`];
  const rows = descendantRows(R, dns);
  assert.deepEqual(rows.map((r) => [r.label, r.depth]), [
    ['OU=sub', 1],
    ['OU=deep', 2],
    ['CN=a', 3],
    ['CN=Schmidt, Anna', 2],
    ['CN=user2', 1],
    ['CN=user10', 1],
  ]);
  assert.equal(rows[3].dn, `CN=Schmidt\\, Anna,OU=sub,${R}`);
  // An entry whose parent was not listed still shows.
  assert.deepEqual(descendantRows(R, [`CN=x,OU=gone,${R}`]).map((r) => [r.label, r.depth]), [['CN=x', 2]]);
  assert.deepEqual(descendantRows(R, [R]), []);
});

test('list header and room per root', () => {
  assert.equal(descendantListSummary(3, 3, false), 'all 3');
  assert.equal(descendantListSummary(1, 1, false), 'the 1 entry');
  assert.equal(descendantListSummary(50, 132, false), 'first 50 of 132');
  assert.equal(descendantListSummary(50, 10000, true), 'first 50 of more than 10,000');
  assert.equal(descendantListLimit(1), 50);
  assert.equal(descendantListLimit(3), 20);
  assert.equal(descendantListLimit(8), 10);
});
