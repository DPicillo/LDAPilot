// Run: cd frontend && node --test 'tests/*.test.ts'
// RW3-R-01 (stable ids) and DEF-24 (own names, manual order) of the bookmarks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStableIds, bookmarkName, compareBookmarks, findByStableId, hasManualOrder, migrateBookmarks, profileBookmarks,
  rekeyBookmarks, renameBookmarkIn, reorderBookmarks, sortByName, stableIdFromAttributes, type Bookmark,
} from '../src/stores/bookmarkStore.ts';

const D = 'DC=ad,DC=ldapilot,DC=lab';
const bm = (dn: string, extra: Partial<Bookmark> = {}): Bookmark => ({ dn, label: dn.split(',')[0], profileId: 'ad', timestamp: 1, ...extra });

test('stored bookmarks of every version load; junk and duplicates are dropped', () => {
  const v1 = [
    { dn: `CN=a,${D}`, label: 'CN=a', profileId: 'ad', timestamp: 5, objectClass: ['user'] },
    { dn: `cn=A,${D.toLowerCase()}`, label: 'CN=a', profileId: 'ad', timestamp: 6 },
    { dn: '', profileId: 'ad' },
    null,
    'x',
    { dn: `OU=b,${D}`, profileId: 'ad', stale: 'yes', stableId: 'nope', name: '  ', order: 'first' },
    { dn: `OU=c,${D}`, profileId: 'ad', stableId: 'objectGUID:1-2', name: ' Team ', order: 2, stale: true },
  ];
  const out = migrateBookmarks(v1);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { dn: `CN=a,${D}`, label: 'CN=a', profileId: 'ad', timestamp: 5, objectClass: ['user'] });
  assert.deepEqual(out[1], { dn: `OU=b,${D}`, label: 'OU=b', profileId: 'ad', timestamp: 0 });
  assert.deepEqual(out[2], { dn: `OU=c,${D}`, label: 'OU=c', profileId: 'ad', timestamp: 0, stale: true, stableId: 'objectGUID:1-2', name: 'Team', order: 2 });
  assert.deepEqual(migrateBookmarks({ not: 'an array' }), []);
});

test('the stable id comes from objectGUID, then nsUniqueId, then entryUUID', () => {
  assert.equal(stableIdFromAttributes([{ name: 'cn', values: ['x'] }, { name: 'entryUUID', values: ['e-1'] }]), 'entryUUID:e-1');
  assert.equal(stableIdFromAttributes([{ name: 'entryUUID', values: ['e-1'] }, { name: 'nsuniqueid', values: ['n-1'] }]), 'nsUniqueId:n-1');
  assert.equal(stableIdFromAttributes([{ name: 'objectGUID', values: ['6f1c'] }, { name: 'entryUUID', values: ['e'] }]), 'objectGUID:6f1c');
  assert.equal(stableIdFromAttributes([{ name: 'objectGUID', values: ['AAAA'], binary: true }]), undefined);
  assert.equal(stableIdFromAttributes(undefined), undefined);
});

test('stable ids are stored by DN; the same entry bookmarked twice keeps the live one with the old name and position', () => {
  const list = [bm(`CN=a,${D}`), bm(`CN=old,${D}`, { stale: true, name: 'Boss', order: 0, stableId: 'objectGUID:g1' }), bm(`CN=b,${D}`, { profileId: 'ol' })];
  const withIds = applyStableIds(list, 'ad', { [`cn=A,${D}`]: 'objectGUID:g0' });
  assert.equal(withIds[0].stableId, 'objectGUID:g0');
  assert.equal(applyStableIds(withIds, 'ad', { [`CN=a,${D}`]: 'objectGUID:g0' }), withIds, 'unchanged = same array');
  // The renamed entry was bookmarked again under its new DN: one bookmark, live, named and placed like the old one.
  const fresh = [...withIds, bm(`CN=new,${D}`)];
  const merged = applyStableIds(fresh, 'ad', { [`CN=new,${D}`]: 'objectGUID:g1' });
  const adOnes = merged.filter((b) => b.profileId === 'ad');
  assert.equal(adOnes.length, 2);
  const kept = adOnes.find((b) => b.stableId === 'objectGUID:g1')!;
  assert.equal(kept.dn, `CN=new,${D}`);
  assert.equal(kept.name, 'Boss');
  assert.equal(kept.order, 0);
  assert.equal(kept.stale, undefined);
  assert.equal(findByStableId(merged, 'ad', 'objectGUID:g1')?.dn, `CN=new,${D}`);
  assert.equal(findByStableId(merged, 'ol', 'objectGUID:g1'), undefined);
});

test('following a rename keeps id, own name and position', () => {
  const list = [bm(`CN=a,OU=x,${D}`, { stableId: 'objectGUID:g', name: 'Mine', order: 3, stale: true })];
  const out = rekeyBookmarks(list, 'ad', `CN=a,OU=x,${D}`, `CN=a2,OU=y,${D}`);
  assert.deepEqual({ ...out[0] }, { dn: `CN=a2,OU=y,${D}`, label: 'CN=a2', profileId: 'ad', timestamp: 1, stableId: 'objectGUID:g', name: 'Mine', order: 3 });
});

test('own names: shown instead of the RDN value; blank or the RDN value clears it', () => {
  const list = [bm(`CN=Schmidt\\, Anna,${D}`), bm(`OU=x,${D}`)];
  const named = renameBookmarkIn(list, 'ad', `cn=schmidt\\, anna,${D}`, '  Anna (HR) ');
  assert.equal(named[0].name, 'Anna (HR)');
  assert.equal(bookmarkName(named[0]), 'Anna (HR)');
  assert.equal(bookmarkName(named[1]), 'x');
  assert.equal(renameBookmarkIn(named, 'ad', `CN=Schmidt\\, Anna,${D}`, 'Anna (HR)'), named, 'same name = same array');
  assert.equal(renameBookmarkIn(named, 'ad', `CN=Schmidt\\, Anna,${D}`, 'Schmidt, Anna')[0].name, undefined);
  assert.equal(renameBookmarkIn(named, 'ad', `CN=Schmidt\\, Anna,${D}`, '   ')[0].name, undefined);
  // Sorting uses the shown name.
  const sorted = [...named].sort(compareBookmarks).map(bookmarkName);
  assert.deepEqual(sorted, ['Anna (HR)', 'x']);
});

test('manual order: reordering numbers the connection, Sort by Name drops it, other connections stay', () => {
  const list = [bm(`CN=c,${D}`), bm(`CN=a,${D}`), bm(`CN=b,${D}`), bm(`CN=z,${D}`, { profileId: 'ol' })];
  assert.deepEqual(profileBookmarks(list, 'ad').map(bookmarkName), ['a', 'b', 'c']);
  assert.equal(hasManualOrder(list, 'ad'), false);
  const moved = reorderBookmarks(list, 'ad', `CN=c,${D}`, 0);
  assert.deepEqual(profileBookmarks(moved, 'ad').map(bookmarkName), ['c', 'a', 'b']);
  assert.equal(hasManualOrder(moved, 'ad'), true);
  assert.equal(moved[3].order, undefined, 'the other connection keeps its name order');
  const down = reorderBookmarks(moved, 'ad', `CN=c,${D}`, 2);
  assert.deepEqual(profileBookmarks(down, 'ad').map(bookmarkName), ['a', 'b', 'c']);
  assert.equal(hasManualOrder(down, 'ad'), true, 'still manual');
  assert.equal(reorderBookmarks(down, 'ad', `CN=c,${D}`, 99), down, 'clamped, no move = same array');
  assert.equal(reorderBookmarks(down, 'ad', `CN=none,${D}`, 0), down);
  // Stale ones keep their manual place.
  const staleFirst = reorderBookmarks(list.map((b) => (b.dn.startsWith('CN=c') ? { ...b, stale: true } : b)), 'ad', `CN=c,${D}`, 0);
  assert.equal(bookmarkName(profileBookmarks(staleFirst, 'ad')[0]), 'c');
  const byName = sortByName(down, 'ad');
  assert.equal(hasManualOrder(byName, 'ad'), false);
  assert.equal(sortByName(byName, 'ad'), byName);
  // Numbered ones first, then the rest by name (a bookmark added before the switch).
  const mixed = [bm(`CN=x,${D}`, { order: 1 }), bm(`CN=a,${D}`), bm(`CN=y,${D}`, { order: 0 })];
  assert.deepEqual(profileBookmarks(mixed, 'ad').map(bookmarkName), ['y', 'x', 'a']);
});
