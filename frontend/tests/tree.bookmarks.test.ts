// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSameBookmark, markBookmarksStale, noteBookmarkLoaded, rekeyBookmarks, useBookmarkStore, type Bookmark } from '../src/stores/bookmarkStore.ts';

const D = 'DC=ad,DC=ldapilot,DC=lab';
const bm = (dn: string, extra: Partial<Bookmark> = {}): Bookmark => ({ dn, label: dn.split(',')[0], profileId: 'ad', timestamp: 1, ...extra });

test('a rename re-keys the bookmark (and the ones below a moved container)', () => {
  const list = [
    bm(`CN=ux-r-contact1-renamed,OU=ux-tree,${D}`, { stale: true }),
    bm(`CN=deep,OU=box,OU=ux-tree,${D}`),
    bm(`CN=other,${D}`),
    bm(`CN=ux-r-contact1-renamed,OU=ux-tree,${D}`, { profileId: 'ol' }),
  ];
  const renamed = rekeyBookmarks(list, 'ad', `CN=ux-r-contact1-renamed,OU=ux-tree,${D}`, `CN=ux-r-contact1,OU=ux-tree,${D}`);
  assert.deepEqual(renamed.slice(0, 2).map((b) => b.dn), [`CN=deep,OU=box,OU=ux-tree,${D}`, `CN=other,${D}`]);
  const moved = renamed.find((b) => b.profileId === 'ad' && b.dn.startsWith('CN=ux-r-contact1,'));
  assert.ok(moved);
  assert.equal(moved.label, 'CN=ux-r-contact1');
  assert.equal(moved.stale, undefined);
  // The other profile's bookmark with the same DN stays.
  assert.ok(renamed.some((b) => b.profileId === 'ol' && b.dn === `CN=ux-r-contact1-renamed,OU=ux-tree,${D}`));

  const movedBox = rekeyBookmarks(list, 'ad', `OU=box,OU=ux-tree,${D}`, `OU=box,OU=target,${D}`);
  assert.ok(movedBox.some((b) => b.dn === `CN=deep,OU=box,OU=target,${D}`));
  assert.equal(rekeyBookmarks(list, 'ad', `OU=none,${D}`, `OU=n2,${D}`), list);
});

test('a move onto an already bookmarked DN keeps one bookmark', () => {
  const list = [bm(`CN=a,OU=x,${D}`), bm(`CN=a,OU=y,${D}`)];
  const out = rekeyBookmarks(list, 'ad', `CN=a,OU=x,${D}`, `cn=A,ou=Y,${D.toLowerCase()}`);
  assert.equal(out.length, 1);
});

test('deleted / missing entries mark bookmarks stale, restore and load clear it', () => {
  const list = [bm(`CN=c1,OU=box,${D}`), bm(`OU=box,${D}`), bm(`CN=keep,${D}`)];
  const single = markBookmarksStale(list, 'ad', `ou=BOX,${D}`, false, true);
  assert.deepEqual(single.map((b) => !!b.stale), [false, true, false]);
  const subtree = markBookmarksStale(list, 'ad', `OU=box,${D}`, true, true);
  assert.deepEqual(subtree.map((b) => !!b.stale), [true, true, false]);
  assert.equal(markBookmarksStale(list, 'ol', `OU=box,${D}`, true, true), list);
  const restored = markBookmarksStale(subtree, 'ad', `OU=box,${D}`, false, false);
  assert.deepEqual(restored.map((b) => !!b.stale), [true, false, false]);
  const loaded = noteBookmarkLoaded(restored, 'ad', `CN=c1,OU=box,${D}`, ['top', 'contact']);
  assert.equal(loaded[0].stale, undefined);
  assert.deepEqual(loaded[0].objectClass, ['top', 'contact']);
  assert.equal(noteBookmarkLoaded(loaded, 'ad', `CN=c1,OU=box,${D}`, ['top', 'contact']), loaded);
});

test('the store compares DNs normalized and survives without localStorage', () => {
  const s = useBookmarkStore.getState();
  s.addBookmark('ad', `CN=Test,${D}`, ['user']);
  s.addBookmark('ad', `cn=test, dc=ad,dc=ldapilot,dc=lab`);
  assert.equal(useBookmarkStore.getState().bookmarks.length, 1);
  assert.equal(s.isBookmarked('ad', `CN=TEST,${D}`), true);
  assert.equal(isSameBookmark(useBookmarkStore.getState().bookmarks[0], 'ol', `CN=Test,${D}`), false);
  s.removeBookmark('ad', `cn=test,${D}`);
  assert.equal(useBookmarkStore.getState().bookmarks.length, 0);
});
