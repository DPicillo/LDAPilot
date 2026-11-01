// Run: cd frontend && node --test 'tests/*.test.ts'
// Search panel model: history (per connection, deduplicated, pinned first),
// saved searches on another connection, hidden status attributes, DN re-keying.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addToHistory, baseForProfile, describeQuick, historyFor, historyKey, rekeyDN, suggestNames, withStatusAttributes,
  type SearchHistoryItem,
} from '../src/components/search/searchModel.ts';

const params = (filter: string, baseDN = 'dc=x', extra: Partial<SearchHistoryItem['params']> = {}) => ({
  baseDN, filter, scope: 2 as const, attributes: [], sizeLimit: 1000, timeLimit: 30, ...extra,
});

function item(id: string, filter: string, profileId: string, ts: number, more: Partial<SearchHistoryItem> = {}): SearchHistoryItem {
  return { id, params: params(filter), resultCount: 1, timestamp: ts, pinned: false, profileId, mode: 'advanced', ...more };
}

test('history: the same search on the same connection and base is one entry (newest first, pin kept)', () => {
  let h: SearchHistoryItem[] = [];
  h = addToHistory(h, item('1', '(cn=a)', 'ad', 1));
  h = addToHistory(h, item('2', '(cn=b)', 'ad', 2));
  h = [{ ...h[1], pinned: true }, h[0]];
  h = addToHistory(h, item('3', ' (cn=a) ', 'ad', 3));
  assert.deepEqual(h.map((x) => x.id), ['3', '2']);
  assert.equal(h[0].pinned, true, 'pin of the replaced entry is kept');
  // Another connection or another base is another search
  h = addToHistory(h, item('4', '(cn=a)', 'ol', 4));
  h = addToHistory(h, { ...item('5', '(cn=a)', 'ad', 5), params: params('(cn=a)', 'ou=y,dc=x') });
  assert.equal(h.length, 4);
  // Base DNs compare normalized
  assert.equal(historyKey({ params: params('(x=1)', 'OU=A, DC=X'), profileId: 'p' }), historyKey({ params: params('(x=1)', 'ou=a,dc=x'), profileId: 'p' }));
});

test('history: quick searches are keyed by their text and options, not the generated filter', () => {
  const q = { text: 'schmidt', attr: '*any', matchType: 'contains' as const, objectType: 'users' };
  const a = item('1', '(anr=schmidt)', 'ad', 1, { mode: 'quick', quick: q });
  const b = item('2', '(anr=schmidt)', 'ad', 2, { mode: 'quick', quick: { ...q, objectType: 'groups' } });
  assert.notEqual(historyKey(a), historyKey(b));
  assert.equal(historyKey(a), historyKey({ ...a, quick: { ...q, text: ' schmidt ' } }));
});

test('history: at most n unpinned entries per connection; historyFor shows pinned first', () => {
  let h: SearchHistoryItem[] = [];
  for (let i = 0; i < 5; i++) h = addToHistory(h, item(`ad${i}`, `(cn=${i})`, 'ad', i), 3);
  h = addToHistory(h, item('ol', '(cn=z)', 'ol', 10), 3);
  assert.deepEqual(h.filter((x) => x.profileId === 'ad').map((x) => x.id), ['ad4', 'ad3', 'ad2']);
  h = h.map((x) => (x.id === 'ad2' ? { ...x, pinned: true } : x));
  const shown = historyFor([...h, { ...item('old', '(o=1)', '', 0), profileId: undefined }], 'ad');
  assert.deepEqual(shown.map((x) => x.id), ['ad2', 'ad4', 'ad3', 'old']);
});

test('describeQuick names the text, the attribute, the match and the type', () => {
  const label = (a: string) => (a === '*any' ? 'Any name' : a);
  const type = (t: string) => (t === 'users' ? 'Users' : t);
  assert.equal(describeQuick({ text: ' jo ', attr: '*any', matchType: 'contains', objectType: '' }, label, type), '"jo" in Any name');
  assert.equal(describeQuick({ text: 'jo', attr: 'mail', matchType: 'startsWith', objectType: 'users' }, label, type), '"jo" in mail (starts) · Users');
});

test('a saved search on another connection keeps its base only inside that connection base', () => {
  assert.deepEqual(baseForProfile('OU=Sales,DC=ad,DC=lab', 'DC=ad,DC=lab'), { baseDN: 'OU=Sales,DC=ad,DC=lab', replaced: false });
  assert.deepEqual(baseForProfile('OU=Sales,DC=ad,DC=lab', 'dc=demo,dc=local'), { baseDN: 'dc=demo,dc=local', replaced: true });
  assert.deepEqual(baseForProfile('', 'dc=demo,dc=local'), { baseDN: 'dc=demo,dc=local', replaced: false });
  assert.deepEqual(baseForProfile('ou=x,dc=y', ''), { baseDN: 'ou=x,dc=y', replaced: false });
});

test('withStatusAttributes: objectClass and status are always read and reported as hidden', () => {
  const always = ['objectClass', 'userAccountControl', 'msDS-User-Account-Control-Computed', 'pwdAccountLockedTime'];
  const operational = ['msDS-User-Account-Control-Computed', 'pwdAccountLockedTime'];
  // A restricted list gets every status attribute (the user's own are not hidden)
  const r = withStatusAttributes(['cn', 'userAccountControl'], always, operational);
  assert.deepEqual(r.request, ['cn', 'userAccountControl', 'objectClass', 'msDS-User-Account-Control-Computed', 'pwdAccountLockedTime']);
  assert.deepEqual(r.hidden, ['objectclass', 'msds-user-account-control-computed', 'pwdaccountlockedtime']);
  // All attributes: '*' plus the operational ones '*' leaves out
  const all = withStatusAttributes([], always, operational);
  assert.deepEqual(all.request, ['*', 'msDS-User-Account-Control-Computed', 'pwdAccountLockedTime']);
  assert.deepEqual(all.hidden, ['msds-user-account-control-computed', 'pwdaccountlockedtime']);
  const star = withStatusAttributes(['*', 'cn'], always, operational);
  assert.deepEqual(star.request, ['*', 'cn', 'msDS-User-Account-Control-Computed', 'pwdAccountLockedTime']);
});

test('rekeyDN: the moved entry and the rows below it get the new DN', () => {
  assert.equal(rekeyDN('CN=Anna,OU=A,DC=x', 'cn=anna,ou=a,dc=x', 'CN=Anna B,OU=B,DC=x'), 'CN=Anna B,OU=B,DC=x');
  assert.equal(rekeyDN('CN=Schmidt\\, Anna,OU=A,DC=x', 'OU=A,DC=x', 'OU=A2,OU=B,DC=x'), 'CN=Schmidt\\, Anna,OU=A2,OU=B,DC=x');
  assert.equal(rekeyDN('CN=x,OU=Other,DC=x', 'OU=A,DC=x', 'OU=B,DC=x'), null);
});

test('suggestNames: prefix matches first, then substring matches', () => {
  const names = ['description', 'displayName', 'mail', 'otherMailbox', 'proxyAddresses'];
  assert.deepEqual(suggestNames(names, 'mai'), ['mail', 'otherMailbox']);
  assert.deepEqual(suggestNames(names, 'D', 2), ['description', 'displayName']);
  assert.deepEqual(suggestNames(names, ''), names);
});
