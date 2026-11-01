// UX final round (after loop round 3): the open BUG / minor items of the re-walk
// round 3 in areas C, N, E, P, M, S and R.
// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editSectionForError } from '../src/lib/connectionAuth.ts';
import { splitConnectError } from '../src/components/connection/profileLogic.ts';
import { ACTION_TOAST_MIN_MS, toastDuration } from '../src/components/connection/chromeLogic.ts';
import { matchingProfiles } from '../src/components/commands/paletteSearch.ts';
import { movedTabCarries, tabsAfterMove } from '../src/lib/entryEvents.ts';
import { getTabView, moveTabView, setTabView } from '../src/stores/tabViewState.ts';
import { hasUnsavedEdits, moveScopedUnsavedEdits, setScopedUnsavedEdits } from '../src/stores/unsavedEdits.ts';
import { inlineEditCaret, showRawColumn, RAW_MIN_TABLE_PX } from '../src/lib/attributeGroups.ts';
import { ACCOUNT_STATUS_ATTRIBUTES, deriveAccountStatus, deriveRowStatus, formatDateTime, timesNeedSeconds } from '../src/components/ui/accountStatus.ts';
import { cachedAccountStatus, forgetAccountStatuses, rememberAccountStatus } from '../src/stores/accountStatusCache.ts';
import { getAccountActions } from '../src/lib/accountActions.ts';
import { schemeWithStrength } from '../src/lib/passwordMethod.ts';
import { stabilizeItems } from '../src/components/commands/menuStability.ts';
import { closesAfterAdd, entryOutcome } from '../src/components/commands/addToGroups.ts';
import { targetProblem, targetProblemText } from '../src/components/lifecycle/containerPickerModel.ts';
import { defaultResultColumns, quickRunProblem, resultCountText, scopeLabel } from '../src/components/search/searchModel.ts';
import { quickObjectTypeFilter, quickObjectTypes } from '../src/lib/searchFilter.ts';
import { staleBookmarkFilter } from '../src/lib/treesearch.ts';
import { bookmarkName, compareBookmarks } from '../src/stores/bookmarkStore.ts';
import { deletedForGood, logResult, profileSlot, withProfileSlot } from '../src/components/layout/opTone.ts';
import { createSharedReader } from '../src/lib/sharedRead.ts';
import type { EditorTab } from '../src/types/ui.ts';
import type { AccountStatus } from '../src/types/account.ts';
import type { ResolvedCommand } from '../src/components/ui/commands';

// --- C ------------------------------------------------------------------------------------

test('Edit… of a refused bind opens Authentication (credentials), never the Password storage select (RW2-C-04)', () => {
  assert.equal(editSectionForError('LDAP bind failed: LDAP Result Code 49 "Invalid Credentials": 80090308: LdapErr: DSID-0C0903A9, data 52e'), 'credentials');
  assert.equal(editSectionForError('password required: no password stored'), 'credentials');
  assert.notEqual(editSectionForError('LDAP Result Code 49 "Invalid Credentials"'), 'password');
  assert.equal(editSectionForError('untrusted TLS certificate for h: x509: certificate signed by unknown authority'), 'tls');
});

test('a changed pin is named by the connect error itself (RW2-C-05)', () => {
  const msg = "untrusted TLS certificate for 127.0.0.1: x509: cannot validate certificate for 127.0.0.1 because it doesn't contain any IP SANs (pinned certificate changed)";
  assert.equal(splitConnectError(msg).summary, 'The server certificate changed: review it');
  assert.equal(splitConnectError(msg.replace(' (pinned certificate changed)', '')).summary, 'The server certificate is not trusted: review it');
});

// --- N ------------------------------------------------------------------------------------

const PROFILES = [
  { id: 'fs1', name: 'ldap.forumsys.com', host: 'ldap.forumsys.com', port: 389 },
  { id: 'fs2', name: 'forumsys (TLS)', host: 'ldap.forumsys.com', port: 636 },
  { id: 'corp', name: 'corp.picillo.de', host: 'corp.picillo.de', port: 636 },
  { id: 'ad', name: 'UX-N AD', host: 'localhost', port: 2636 },
  { id: 'ol', name: 'UX-N OL', host: 'localhost', port: 389 },
  { id: 'olro', name: 'UX-N OL-RO', host: 'localhost', port: 389 },
];
const on = new Set(['ad', 'ol', 'olro']);
const rank = { connected: (id: string) => on.has(id), activeId: 'ad' };

test('palette "switch" lists the connected others, never a Connect, and no cap for a bare verb (RW3-N-01)', () => {
  assert.deepEqual(matchingProfiles(PROFILES, 'switch', 5, rank).map((p) => p.id), ['ol', 'olro']);
  // On a tab of OL-RO (AD active): its connection first.
  assert.deepEqual(matchingProfiles(PROFILES, 'switch', 5, { ...rank, preferId: 'olro' }).map((p) => p.id), ['olro', 'ol']);
  assert.deepEqual(matchingProfiles(PROFILES, 'switch ro', 5, rank).map((p) => p.id), ['olro']);
  assert.deepEqual(matchingProfiles(PROFILES, 'switch forumsys', 5, rank), [], 'switch never offers a Connect');
  // "connect": the unconnected ones first, then the connected others, all of them for the bare verb.
  assert.deepEqual(matchingProfiles(PROFILES, 'connect', 5, rank).map((p) => p.id), ['fs1', 'fs2', 'corp', 'ol', 'olro', 'ad']);
  // Plain words: connected first, file order otherwise; at most `max`.
  assert.deepEqual(matchingProfiles(PROFILES, 'local', 5, rank).map((p) => p.id), ['ol', 'olro', 'ad']);
  assert.deepEqual(matchingProfiles(PROFILES, 'to', 5, rank), []);
});

test('toasts with a button stay at least 10 s; plain ones keep their time (RW3-N-04)', () => {
  assert.equal(toastDuration(3000, true), ACTION_TOAST_MIN_MS);
  assert.equal(toastDuration(3000, false), 3000);
  assert.equal(toastDuration(12_000, true), 12_000);
  assert.equal(toastDuration(0, true), 0, 'persistent stays persistent');
});

// --- E ------------------------------------------------------------------------------------

const tab = (profileId: string, dn: string): EditorTab => ({ id: `${profileId}:${dn}`, profileId, dn, label: dn, dirty: false });

test('a rename carries the hidden tab’s draft and view state to the re-keyed tab (RW3-E-01)', () => {
  const oldDN = 'CN=UX RW3E User2,OU=ux-rw3-e,DC=ad';
  const newDN = 'CN=UX RW3E User2b,OU=ux-rw3-e,DC=ad';
  const before = [tab('p', 'CN=UX RW3E User1,OU=ux-rw3-e,DC=ad'), tab('p', oldDN)];
  const after = tabsAfterMove(before, 'p', oldDN, newDN);
  const carries = movedTabCarries(before, after);
  assert.deepEqual(carries, [{ from: `p:${oldDN}`, to: `p:${newDN}`, dn: newDN }]);
  setTabView(`p:${oldDN}`, 'attr.editValue', '+49 40 555 draft');
  setScopedUnsavedEdits(`p:${oldDN}`, 'p', oldDN, true);
  for (const c of carries) {
    moveTabView(c.from, c.to);
    moveScopedUnsavedEdits(c.from, c.to, c.dn);
  }
  assert.equal(getTabView(`p:${newDN}`, 'attr.editValue'), '+49 40 555 draft');
  assert.ok(hasUnsavedEdits('p', newDN), 'the re-keyed tab stays dirty');
  assert.ok(!hasUnsavedEdits('p', oldDN));
});

test('children of a renamed OU carry their state; a tab dropped for an open one carries nothing', () => {
  const ou = 'OU=a,DC=x';
  const child = 'CN=c,OU=a,DC=x';
  const before = [tab('p', ou), tab('p', child), tab('p', 'CN=c,OU=b,DC=x')];
  const after = tabsAfterMove(before, 'p', ou, 'OU=b,DC=x');
  const carries = movedTabCarries(before, after);
  // OU=a → OU=b; its child collides with the already open CN=c,OU=b: no carry for it.
  assert.deepEqual(carries.map((c) => c.to), ['p:OU=b,DC=x']);
});

test('a restored inline draft keeps the caret at its end, an untouched value is selected (RW3-E-03)', () => {
  assert.equal(inlineEditCaret('draft-rw3 text', 'old'), 'end');
  assert.equal(inlineEditCaret('old', 'old'), 'select');
  assert.equal(inlineEditCaret('', ''), 'select');
});

test('the Raw column only where the Value column keeps room (RW1-E-13)', () => {
  assert.ok(showRawColumn(0), 'not measured yet');
  assert.ok(showRawColumn(1200));
  assert.ok(!showRawColumn(RAW_MIN_TABLE_PX - 1));
});

test('Compare: times equal to the minute but not the second are shown with seconds (RW3-E-04)', () => {
  const a = new Date(2026, 10, 1, 12, 12, 5);
  const b = new Date(2026, 10, 1, 12, 12, 41);
  assert.equal(formatDateTime(a), '2026-11-01 12:12');
  assert.equal(formatDateTime(a, { seconds: true }), '2026-11-01 12:12:05');
  assert.ok(timesNeedSeconds([a], [b]));
  assert.ok(!timesNeedSeconds([a], [new Date(2026, 10, 1, 13, 0)]), 'visibly different: minutes suffice');
  assert.ok(!timesNeedSeconds([a], [a]));
});

// --- P ------------------------------------------------------------------------------------

test('389DS "must change" from passwordExpirationTime 19700101000000Z on every row (RW3-P-02)', () => {
  const ds = { objectClass: ['top', 'person', 'inetOrgPerson'], passwordExpirationTime: '19700101000000Z' };
  assert.ok(deriveAccountStatus(ds).some((s) => s.kind === 'mustChange' && s.source.attribute === 'passwordExpirationTime'));
  assert.ok(deriveRowStatus(ds).some((s) => s.kind === 'mustChange'));
  assert.ok(!deriveAccountStatus({ ...ds, passwordExpirationTime: '20261105000000Z' }).some((s) => s.kind === 'mustChange'), 'a real expiry is no reset marker');
  assert.ok(ACCOUNT_STATUS_ATTRIBUTES.includes('passwordExpirationTime'));
  assert.ok(ACCOUNT_STATUS_ATTRIBUTES.includes('accountUnlockTime'));
  // 389DS lockout: accountUnlockTime 19700101000000Z = locked until an admin unlocks (RW3-P-01).
  assert.ok(deriveRowStatus({ objectClass: ['inetOrgPerson'], accountUnlockTime: '19700101000000Z' }).some((s) => s.kind === 'locked'));
});

test('a search forgets the remembered states of its rows (RW2-P-01)', () => {
  const st = { dn: 'uid=u2,ou=x,dc=demo', applicable: true, locked: false } as unknown as AccountStatus;
  rememberAccountStatus('ol', st);
  assert.ok(cachedAccountStatus('ol', 'UID=u2,OU=x,DC=demo'));
  forgetAccountStatuses('ol', ['uid=u2, ou=x, dc=demo']);
  assert.equal(cachedAccountStatus('ol', st.dn), undefined);
});

test('a lost connection blocks account actions with its own reason (RW2-C-02)', () => {
  const st = { dn: 'cn=a', applicable: true, serverType: 'ad', enabled: true, locked: true, badPasswordCount: 0, userAccountControl: 512, mustChangePassword: false } as unknown as AccountStatus;
  const lost = getAccountActions(st, 'Connection lost: reconnect to edit.');
  assert.equal(lost.unlock.enabled, false);
  assert.equal(lost.unlock.reason, 'Connection lost: reconnect to edit.');
  assert.equal(getAccountActions(st, true).resetPassword.reason, 'The connection is read-only.');
  assert.equal(getAccountActions(st, false).unlock.enabled, true);
});

test('a status read of the last 30 s is shared with the action’s pre-check (RW1-P-06)', async () => {
  let reads = 0;
  let t = 0;
  const reader = createSharedReader(async () => ++reads, 1500, () => t);
  await reader.read('k');
  t = 2500; // human speed: menu open → click
  await reader.read('k', 30_000);
  assert.equal(reads, 1);
  await reader.read('k', 0);
  assert.equal(reads, 2, 'after a write a new read starts');
  reader.seed('r', 7);
  assert.equal(await reader.read('r', 30_000), 7, 'a report row status is shared too');
});

test('weak schemes say so in every scheme list (RW3-P-03)', () => {
  assert.equal(schemeWithStrength('{SHA} unsalted SHA-1', 'weak'), '{SHA} unsalted SHA-1 - weak');
  assert.equal(schemeWithStrength('Cleartext', 'none'), 'Cleartext - not hashed');
  assert.equal(schemeWithStrength('{SSHA512}', 'strong'), '{SSHA512}');
});

test('an item that stopped applying in an open menu says why (RW3-P-04)', () => {
  const rc = (title: string, enabled = true, goneReason?: string): ResolvedCommand => ({
    id: 'account.unlock', command: { id: 'account.unlock', title, group: 'account', goneReason }, title, enabled, isDefault: false, section: 'account', danger: false,
  });
  const seen = new Map<string, ResolvedCommand>();
  stabilizeItems([rc('Checking account status…', false, 'Not locked')], seen, () => undefined);
  const after = stabilizeItems([], seen, () => rc('Unlock Account', true, 'Not locked'));
  assert.deepEqual(after.map((i) => [i.title, i.enabled, i.disabledReason]), [['Unlock Account', false, 'Not locked']]);
});

// --- M ------------------------------------------------------------------------------------

test('Add to Group… for one entry that fully worked closes; anything else keeps the result page (M-14)', () => {
  const ok = entryOutcome('cn=c1', { changed: ['cn=g'], unchanged: [], failed: [], warnings: [] } as never, false);
  assert.ok(closesAfterAdd([ok]));
  assert.ok(!closesAfterAdd([ok, ok]), 'several entries');
  assert.ok(!closesAfterAdd([entryOutcome('cn=c1', { changed: ['cn=g'], unchanged: ['cn=h'], failed: [], warnings: [] } as never, false)]), 'already in one');
  assert.ok(!closesAfterAdd([entryOutcome('cn=c1', null, false, 'boom')]));
});

test('the Move hint is singular for one entry (M-13)', () => {
  const p = targetProblem('OU=a,DC=x', ['CN=e,OU=a,DC=x']);
  assert.equal(p, 'sameParent');
  assert.equal(targetProblemText('sameParent', 1), 'The entry is already in this container.');
  assert.equal(targetProblemText('sameParent', 2), 'The entries are already in this container.');
  assert.equal(targetProblemText('self', 1), 'The target is the entry to move.');
});

// --- S ------------------------------------------------------------------------------------

test('a quick search without a filter here is not run (RW3-S-01)', () => {
  const type = (t: string) => (t === 'contacts' ? 'Contacts' : t);
  const q = { text: '', attr: '*any', matchType: 'contains' as const, objectType: 'contacts' };
  assert.equal(quickRunProblem(q, '', type, 'Lab · OpenLDAP'), 'Contacts is not an object type on Lab · OpenLDAP: the search was not run.');
  assert.equal(quickRunProblem(q, '(objectClass=contact)', type, 'AD'), null);
  assert.equal(quickRunProblem({ ...q, text: 'jo' }, '', type, 'x'), null);
  assert.ok(quickRunProblem({ ...q, objectType: '' }, '', type, 'x'));
});

test('LDAP users have a login, contacts are persons without one (RW3-S-04)', () => {
  assert.equal(quickObjectTypeFilter('users', 'openldap'), '(|(&(objectClass=inetOrgPerson)(uid=*))(objectClass=posixAccount)(objectClass=account))');
  assert.equal(quickObjectTypeFilter('contacts', '389ds'), '(&(objectClass=inetOrgPerson)(!(uid=*))(!(objectClass=posixAccount)))');
  assert.ok(quickObjectTypes('openldap').some((t) => t.value === 'contacts'));
});

test('result columns by server type; history labels name a non-subtree scope (RW3-S-03, RW3-S-05)', () => {
  assert.deepEqual(defaultResultColumns('ad'), ['cn', 'description', 'mail', 'sAMAccountName']);
  assert.deepEqual(defaultResultColumns('openldap'), ['cn', 'uid', 'mail', 'description']);
  assert.ok(!defaultResultColumns(null).includes('sAMAccountName'));
  assert.equal(scopeLabel(0), 'base entry');
  assert.equal(scopeLabel(1), 'one level');
  assert.equal(scopeLabel(2), '');
  assert.equal(resultCountText(1), '1 result');
  assert.equal(resultCountText(3), '3 results');
});

test('Recent LDIF changes: a deleted entry is not opened as a dead tab (RW3-S-08)', () => {
  const del = { operation: 'DELETE', dn: 'cn=c19,ou=x', timestamp: '2026-11-01 12:00:00' };
  assert.ok(deletedForGood([del], del));
  assert.ok(!deletedForGood([del, { operation: 'ADD', dn: 'CN=c19,OU=x', timestamp: '2026-11-01 12:05:00' }], del), 'added again later');
  assert.ok(!deletedForGood([], { ...del, error: 'no such object' }), 'a failed delete');
  assert.ok(!deletedForGood([], { ...del, operation: 'MODIFY' }));
});

// --- R ------------------------------------------------------------------------------------

test('Search by Name of a stale bookmark finds renamed entries (RW3-R-01)', () => {
  assert.equal(staleBookmarkFilter('CN', 'ux-rw3-r-contact2', false), '(CN=*ux-rw3-r-contact2*)');
  assert.equal(staleBookmarkFilter('cn', 'a*b', true), '(|(anr=a\\2ab)(cn=*a\\2ab*))');
});

test('bookmarks sort by their shown name, stale ones last (RW3-R-02)', () => {
  const list = [
    { dn: 'CN=Ben Kowalski,OU=x', label: 'CN=Ben Kowalski' },
    { dn: 'CN=ux-rw3-r-contact2,OU=x', label: 'CN=ux-rw3-r-contact2', stale: true },
    { dn: 'OU=Bulk,DC=ad', label: 'OU=Bulk' },
    { dn: 'OU=Special Cases,DC=ad', label: 'OU=Special Cases' },
    { dn: 'CN=ux-rw3-r-contact1-renamed,OU=x', label: 'CN=ux-rw3-r-contact1-renamed' },
  ];
  assert.deepEqual([...list].sort(compareBookmarks).map(bookmarkName), ['Ben Kowalski', 'Bulk', 'Special Cases', 'ux-rw3-r-contact1-renamed', 'ux-rw3-r-contact2']);
});

test('a cancelled search is recognised with "1 entry" too (RW3-R-04)', () => {
  assert.equal(logResult({ details: 'base=x scope=sub filter=(cn=*) -> cancelled after 1 entry' }), 'cancelled');
  assert.equal(logResult({ details: 'base=x scope=sub filter=(cn=*) -> cancelled after 688 entries' }), 'cancelled');
  assert.equal(logResult({ details: 'base=x scope=base filter=(objectClass=*) -> 1 entry' }), 'ok');
});

test('FIN-W-01: log filters are kept per connection', () => {
  let slots: Record<string, string> = {};
  assert.equal(profileSlot(slots, 'ad', ''), '');
  slots = withProfileSlot(slots, 'ad', 'CN=Schmidt\\, Anna,OU=Users,DC=ad');
  assert.equal(profileSlot(slots, 'ad', ''), 'CN=Schmidt\\, Anna,OU=Users,DC=ad');
  // Switching to OpenLDAP shows its own (empty) filter, not the AD Show History DN.
  assert.equal(profileSlot(slots, 'ol', ''), '');
  slots = withProfileSlot(slots, 'ol', 'uid=eva');
  assert.equal(profileSlot(slots, 'ad', ''), 'CN=Schmidt\\, Anna,OU=Users,DC=ad');
  // A cleared filter stays cleared; no connection: the initial value, slots unchanged.
  slots = withProfileSlot(slots, 'ad', '');
  assert.equal(profileSlot(slots, 'ad', 'x'), '');
  assert.equal(profileSlot(slots, null, 'x'), 'x');
  assert.equal(withProfileSlot(slots, null, 'y'), slots);
});
