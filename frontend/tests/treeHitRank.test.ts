// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankTreeHits, treeHitScore } from '../src/lib/treeHitRank.ts';

const hit = (dn: string, attrs: Record<string, string[]> = {}) => ({
  dn,
  attributes: Object.entries(attrs).map(([name, values]) => ({ name, values })),
});

test('name matches rank before description-only matches (Find in Tree)', () => {
  const bulk = hit('CN=Bulk Contact 1040,OU=Bulk,DC=ad', { description: ['Paging test object'] });
  const locked = hit('CN=Test Locked,OU=Special Cases,DC=ad', { sAMAccountName: ['test.locked'] });
  const latest = hit('CN=Latest Run,DC=ad', { displayName: ['Latest test run'] });
  const contest = hit('CN=Contest,DC=ad');
  const ranked = rankTreeHits([bulk, contest, latest, locked], 'test');
  assert.deepEqual(ranked.map((h) => h.dn), [locked.dn, latest.dn, contest.dn, bulk.dn]);
  assert.equal(treeHitScore(hit('uid=test,ou=People'), 'TEST'), 0);
  assert.equal(treeHitScore(bulk, 'test'), 4);
});

test('ranking is stable within a score and handles escaped commas', () => {
  const a = hit('CN=Test A,DC=x');
  const b = hit('CN=Test B,DC=x');
  assert.deepEqual(rankTreeHits([b, a], 'test').map((h) => h.dn), [b.dn, a.dn]);
  assert.equal(treeHitScore(hit('CN=Doe\\, Test,DC=x'), 'test'), 2);
  assert.deepEqual(rankTreeHits([], 'x'), []);
});
