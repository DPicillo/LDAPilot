// Run: cd frontend && node --test 'tests/*.test.ts'
// Membership panel helpers (LIFE-10): exports, picker ranking, add planning, counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cycleCreatingValues, isSelfReference, membershipCSV, membershipExportName, membershipTable, rankPickerHits,
  rawMembershipCounts, shownText, splitKnownMembers, withSkippedUnchanged, canRemoveItem, describeMembershipChange,
} from '../src/lib/membership.ts';
import type { MembershipItem } from '../src/types/membership';

const item = (p: Partial<MembershipItem>): MembershipItem => ({ dn: '', name: '', objectType: 'user', direct: true, depth: 1, path: [], ...p });

test('CSV / table export: name, type, DN, via, depth, flags (formula safe)', () => {
  const items = [
    item({ dn: 'CN=Doe\\, John,OU=x,DC=ad', name: 'Doe, John' }),
    item({ dn: 'CN=L1,DC=ad', name: 'L1', objectType: 'group', direct: false, depth: 2, path: ['CN=GG-Level2,DC=ad'], inCycle: true }),
    item({ dn: '', name: 'jdoe', objectType: 'unknown', unresolved: true }),
    item({ dn: 'CN==cmd,DC=ad', name: '=cmd' }),
    item({ dn: 'CN=g,DC=ad', name: 'g', objectType: 'group', self: true, inCycle: true }),
  ];
  const csv = membershipCSV(items);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'name,type,dn,via,depth,flags');
  assert.equal(lines[1], '"Doe, John",user,"CN=Doe\\, John,OU=x,DC=ad",,1,');
  assert.equal(lines[2], 'L1,group,"CN=L1,DC=ad",GG-Level2,2,cycle');
  assert.equal(lines[3], 'jdoe,unknown,memberUid: jdoe,,1,no account');
  assert.ok(lines[4].startsWith("'=cmd,"), 'formula injection neutralized');
  assert.ok(lines[5].endsWith(',itself cycle'));
  const tsv = membershipTable(items.slice(0, 2));
  assert.equal(tsv.split('\n')[1], 'Doe, John\tuser\tCN=Doe\\, John,OU=x,DC=ad\t\t1\t');
  assert.equal(membershipExportName('CN=GG-IT Admins,OU=x,DC=ad', 'members', true), 'GG-IT_Admins-members-effective.csv');
  assert.equal(membershipExportName('uid=jdoe,dc=x', 'memberOf', false), 'jdoe-member-of.csv');
});

test('picker hits: exact > prefix > rest, then users, groups, …, then name', () => {
  const hits = [
    { dn: '1', name: 'xadmins', type: 'group' },
    { dn: '2', name: 'Admins-Old', type: 'group' },
    { dn: '3', name: 'admin', type: 'user' },
    { dn: '4', name: 'admins', type: 'group' },
    { dn: '5', name: 'admins2', type: 'user' },
  ];
  assert.deepEqual(rankPickerHits(hits, 'Admins').map((h) => h.dn), ['4', '5', '2', '3', '1']);
});

test('adding: known members skipped as unchanged, self refused, cycles found', () => {
  const items = [
    item({ dn: 'CN=a,DC=x', name: 'a' }),
    item({ dn: 'CN=nested,DC=x', name: 'nested', direct: false, depth: 2 }),
    item({ dn: '', name: 'jdoe', objectType: 'unknown', unresolved: true }),
  ];
  assert.deepEqual(splitKnownMembers(['cn=A, dc=x', 'CN=nested,DC=x', 'JDoe', 'CN=b,DC=x'], items), {
    send: ['CN=nested,DC=x', 'CN=b,DC=x'],
    known: ['cn=A, dc=x', 'JDoe'],
  });
  const merged = withSkippedUnchanged({ changed: ['CN=b,DC=x'], unchanged: [], failed: [] }, ['cn=A, dc=x']);
  assert.deepEqual(describeMembershipChange(merged, 'add', 'member'), { level: 'success', message: 'Added 1 member, 1 already a member', detail: undefined });
  assert.deepEqual(describeMembershipChange(withSkippedUnchanged(null, ['x']), 'add', 'group').level, 'info');
  assert.equal(isSelfReference('cn=G1, dc=x', 'CN=g1,DC=x'), true);
  assert.equal(isSelfReference('g1', 'CN=g1,DC=x'), false);
  assert.deepEqual(cycleCreatingValues(['CN=Parent,DC=x', 'CN=Other,DC=x', 'uid1'], ['cn=parent,dc=x', 'cn=grand,dc=x']), ['CN=Parent,DC=x']);
  assert.equal(shownText(3, 72), '3 of 72 shown');
  assert.equal(shownText(72, 72), '');
  // the self row of a group stored in itself can be removed
  assert.equal(canRemoveItem(item({ dn: 'CN=g,DC=x', name: 'g', self: true, inCycle: true }), false), true);
});

test('raw counts: one member counted once (member + uniqueMember, 2307bis memberUid)', () => {
  const entry = { attributes: [
    { name: 'objectClass', values: ['top', 'groupOfNames', 'posixGroup'] },
    { name: 'member', values: ['uid=jdoe,ou=People,dc=x', 'uid=anna,ou=People,dc=x'] },
    { name: 'uniqueMember', values: ['UID=jdoe, ou=People,dc=x'] },
    { name: 'memberUid', values: ['jdoe', 'bob'] },
    { name: 'memberOf', values: ['cn=a,dc=x', 'CN=A,DC=x'] },
  ] };
  assert.deepEqual(rawMembershipCounts(entry), { members: 3, memberOf: 1 });
});
