// Run: cd frontend && node --test 'tests/*.test.ts'
// Results tabs and the panel's results (op-search): rows that follow deletions and moves,
// "emptied by deletions" instead of "No entries found", tab titles, the unified column
// chooser's layout rules, "Open in List" DNs, the move dry run and LDIF runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deletedCount, deletedEmptyState, emptiedByDeletions, isResultsTabId, keepPresent, moveColumnId, orderedColumnIds, rekeyChecked,
  resultsCountText, resultsTabId, setColumnShown, shortFilter, snapshotTitle, touchedEntryDNs, withFoundCount, withMovedRows,
  withoutDeletedRows, type CountedResult,
} from '../src/components/search/snapshotModel.ts';
import { localMovePlan, normalizePlan, plannedMoves, planSummary, skipReview } from '../src/components/bulk/moveModel.ts';
import { groupLDIFRuns, ldifRunTag, runSummary, runTime } from '../src/components/export/ldifRuns.ts';

const entry = (dn: string) => ({ dn, attributes: [] });
const results = (...dns: string[]): CountedResult => ({ entries: dns.map(entry), totalCount: dns.length, truncated: false });

test('results tab ids', () => {
  assert.equal(resultsTabId(3), '__results__:3');
  assert.ok(isResultsTabId('__results__:3'));
  assert.ok(!isResultsTabId('__search-results__'));
  assert.ok(!isResultsTabId('p1:cn=a,dc=x'));
  assert.ok(!isResultsTabId(null));
});

test('deletions: rows go, the found count stays (cross-note: emptied results are not "No entries found")', () => {
  const r0 = withFoundCount(results('cn=a,ou=x,dc=y', 'cn=b,ou=x,dc=y', 'ou=x,dc=y'));
  assert.equal(r0.found, 3);
  assert.equal(deletedCount(r0), 0);
  const r1 = withoutDeletedRows(r0, 'CN=A,ou=x,dc=y', false)!;
  assert.equal(r1.entries.length, 2);
  assert.equal(r1.totalCount, 2);
  assert.equal(deletedCount(r1), 1);
  assert.equal(resultsCountText(r1), '2 entries · 1 deleted');
  assert.equal(withoutDeletedRows(r1, 'cn=zzz,dc=y', true), null, 'no row matched');
  // A subtree delete removes the rows below it too.
  const r2 = withoutDeletedRows(r1, 'ou=x,dc=y', true)!;
  assert.equal(r2.entries.length, 0);
  assert.ok(emptiedByDeletions(r2));
  assert.deepEqual(deletedEmptyState(r2), {
    title: 'All 3 entries found were deleted',
    hint: 'The search found 3 entries; they were deleted since. Run the search again to see the current state.',
  });
  // Results that never had a found count get the one before the removal.
  const r3 = withoutDeletedRows(results('cn=a,dc=y'), 'cn=a,dc=y', false)!;
  assert.equal(deletedEmptyState(r3)?.title, 'The entry found was deleted');
  // A prune by others (`{ ...prev, entries }`) keeps `found`: still counted.
  const pruned: CountedResult = { ...r0, entries: [], totalCount: 0 };
  assert.ok(emptiedByDeletions(pruned));
  // A plain empty search is no deletion.
  assert.equal(deletedEmptyState(withFoundCount(results())), null);
  assert.equal(resultsCountText(results('cn=a,dc=y')), '1 entry');
});

test('moves: rows at and below the moved entry are re-keyed, checked rows follow', () => {
  const r = results('cn=a,ou=old,dc=y', 'ou=old,dc=y', 'cn=b,ou=other,dc=y');
  const m = withMovedRows(r, 'ou=old,dc=y', 'ou=new,dc=y')!;
  assert.deepEqual(m.next.entries.map((e) => e.dn), ['cn=a,ou=new,dc=y', 'ou=new,dc=y', 'cn=b,ou=other,dc=y']);
  assert.equal(m.renamed.get('cn=a,ou=old,dc=y'), 'cn=a,ou=new,dc=y');
  assert.deepEqual([...rekeyChecked(new Set(['cn=a,ou=old,dc=y', 'cn=b,ou=other,dc=y']), m.renamed)], ['cn=a,ou=new,dc=y', 'cn=b,ou=other,dc=y']);
  assert.equal(withMovedRows(r, 'ou=none,dc=y', 'ou=new,dc=y'), null);
  const checked = new Set(['cn=a,ou=new,dc=y', 'cn=gone,dc=y']);
  assert.deepEqual([...keepPresent(checked, m.next.entries)], ['cn=a,ou=new,dc=y']);
  const all = new Set(['cn=a,ou=new,dc=y']);
  assert.equal(keepPresent(all, m.next.entries), all, 'unchanged selection keeps its identity');
});

test('tab titles: report name, quick text, else the filter', () => {
  assert.equal(snapshotTitle({ source: 'Locked-Out Accounts', mode: 'advanced', filter: '(x=1)' }), 'Locked-Out Accounts');
  assert.equal(snapshotTitle({ source: 'Search', mode: 'quick', quickText: ' eva ', filter: '(anr=eva)' }), 'Search “eva”');
  assert.equal(snapshotTitle({ source: 'Quick search', mode: 'advanced', filter: '(&(objectClass=user)(cn=e*))' }), '(&(objectClass=user)(cn=e*))');
  assert.equal(snapshotTitle({ mode: 'advanced', filter: '' }), 'Search Results');
  const long = '(&(objectClass=user)(|(cn=very-long-name-*)(mail=*@example.com)))';
  assert.equal(shortFilter(long).length, 40);
  assert.ok(shortFilter(long).endsWith('…'));
});

test('one column chooser: order and visibility follow DataTable rules', () => {
  const declared = ['name', 'type', 'status', 'container', 'attr:cn', 'attr:mail', 'dn'];
  assert.deepEqual(orderedColumnIds(declared, []), declared);
  // Persisted order first (unknown ids dropped), the rest as declared.
  assert.deepEqual(orderedColumnIds(declared, ['attr:mail', 'gone', 'name']), ['attr:mail', 'name', 'type', 'status', 'container', 'attr:cn', 'dn']);
  assert.deepEqual(moveColumnId(declared, [], 'attr:cn', -1), ['name', 'type', 'status', 'attr:cn', 'container', 'attr:mail', 'dn']);
  assert.deepEqual(moveColumnId(declared, [], 'name', -1), declared, 'the first column cannot move up');
  assert.deepEqual(moveColumnId(declared, [], 'dn', 1), declared, 'the last column cannot move down');
  assert.deepEqual(setColumnShown(declared, ['dn'], 'dn', true), []);
  assert.deepEqual(setColumnShown(declared, [], 'type', false), ['type']);
  // The last visible column stays.
  const allButName = declared.filter((c) => c !== 'name');
  assert.deepEqual(setColumnShown(declared, allButName, 'name', false), allButName);
});

test('Open in List: entries a run created or changed, at their new DN, without deletes and failures', () => {
  const items = [
    { dn: 'ou=a,dc=x', operation: 'add', status: 'success' },
    { dn: 'cn=b,ou=a,dc=x', operation: 'add', status: 'success' },
    { dn: 'cn=c,ou=a,dc=x', operation: 'add', status: 'failed' },
    { dn: 'cn=b,ou=a,dc=x', operation: 'modify', status: 'success' },
    { dn: 'cn=b,ou=a,dc=x', operation: 'modrdn', status: 'success', newDn: 'cn=b2,ou=a,dc=x' },
    { dn: 'cn=d,dc=x', operation: 'delete', status: 'success' },
    { dn: 'cn=e,dc=x', operation: 'modify', status: 'success' },
    { dn: 'cn=e,dc=x', operation: 'delete', status: 'success' },
    { dn: 'cn=f,dc=x', status: 'success' },
    { dn: 'cn=g,dc=x', status: 'unchanged' },
  ];
  assert.deepEqual(touchedEntryDNs(items), ['ou=a,dc=x', 'cn=b2,ou=a,dc=x', 'cn=f,dc=x']);
});

test('move flow: plans, summary and when the review step is skipped', () => {
  const local = localMovePlan(['cn=a,ou=one,dc=x', 'cn=b,OU=Target,dc=x'], ' ou=target,dc=x ');
  assert.equal(local.ready, 1);
  assert.equal(local.unchanged, 1);
  assert.equal(local.items[0].newDN, 'cn=a,ou=target,dc=x');
  assert.deepEqual(plannedMoves(local), ['cn=a,ou=one,dc=x']);
  assert.equal(planSummary(local), '1 will move · 1 already there');
  const server = normalizePlan({ total: 9, ready: 9, items: [{ dn: 'cn=a,dc=x', status: 'move', newDN: 'cn=a,ou=t,dc=x' }, { dn: 'cn=b,dc=x', status: 'fail', message: 'an entry with this name already exists in the target container' }] }, ['cn=a,dc=x', 'cn=b,dc=x']);
  assert.equal(server.ready, 1, 'counts come from the items');
  assert.equal(server.failing, 1);
  assert.equal(planSummary(server), '1 will move · 1 will fail');
  assert.equal(skipReview(server), false, 'a predicted failure is shown');
  assert.equal(skipReview(normalizePlan({ items: [{ dn: 'cn=a,dc=x', status: 'move' }] }, ['cn=a,dc=x'])), true, 'one entry without objection moves at once');
  assert.equal(skipReview(localMovePlan(['cn=a,ou=t,dc=x'], 'ou=t,dc=x')), false, 'already there: shown');
  const refused = normalizePlan({ refused: true, reason: 'the target container ou=x does not exist', items: [] }, ['cn=a,dc=x']);
  assert.ok(refused.refused);
  assert.equal(refused.reason, 'the target container ou=x does not exist');
  assert.equal(planSummary(normalizePlan({ items: [] }, [])), 'nothing to move');
});

test('recent LDIF changes: grouped by run tag, older rows by time', () => {
  const row = (timestamp: string, operation: string, dn: string, details: string, error?: string) => ({ timestamp, operation, dn, details, error });
  // Newest first, as the audit log lists them.
  const rows = [
    row('2026-11-01 15:40:02', 'MODIFY', 'cn=x,dc=y', 'attribute "description" modified'),
    row('2026-11-01 15:36:13', 'MODIFY', 'cn=b,dc=y', 'LDIF modify [run 1a2b3c4d]: description: x'),
    row('2026-11-01 15:36:12', 'CREATE', 'cn=a,dc=y', 'LDIF import [run 1a2b3c4d], cn=a'),
    row('2026-11-01 15:36:12', 'CREATE', 'ou=z,dc=y', 'LDIF import [run 1a2b3c4d], ou=z', 'already exists'),
    row('2026-11-01 15:30:00', 'DELETE', 'cn=c,dc=y', 'LDIF delete [run ffff0000]'),
    row('2026-11-01 15:00:05', 'CREATE', 'cn=old2,dc=y', 'LDIF import, cn=old2'),
    row('2026-11-01 15:00:00', 'CREATE', 'cn=old1,dc=y', 'LDIF import, cn=old1'),
    row('2026-11-01 14:00:00', 'RENAME', 'cn=old0,dc=y', 'LDIF modrdn: newRDN=cn=n newDN=cn=n,dc=y'),
  ];
  assert.equal(ldifRunTag(rows[1].details), '1a2b3c4d');
  assert.equal(ldifRunTag('LDIF import, cn=a'), null);
  const runs = groupLDIFRuns(rows);
  assert.deepEqual(runs.map((r) => r.rows.length), [3, 1, 2, 1]);
  assert.equal(runs[0].tag, '1a2b3c4d');
  assert.equal(runs[0].startedAt, '2026-11-01 15:36:12');
  assert.equal(runs[0].endedAt, '2026-11-01 15:36:13');
  assert.equal(runSummary(runs[0]), '3 records · 2 created, 1 modified · 1 failed');
  assert.equal(runSummary(runs[1]), '1 record · 1 deleted');
  assert.equal(runs[2].tag, null, 'untagged rows 5 s apart are one run');
  assert.equal(runs[3].rows[0].dn, 'cn=old0,dc=y', 'an hour later is another run');
  assert.equal(groupLDIFRuns(rows, 2).length, 2, 'at most maxRuns runs');
  assert.equal(runTime('2026-11-01 15:36:12', '2026-11-01'), '15:36:12');
  assert.equal(runTime('2026-10-31 15:36:12', '2026-11-01'), '2026-10-31 15:36');
});
