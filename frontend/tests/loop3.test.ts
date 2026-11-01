// UX loop round 3: foreign refresh, server DN spelling, per-tab view state, cached account
// states, restore of deleted children, contacts, pickers, palette and wording helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshTarget } from '../src/components/commands/targets.ts';
import { adoptServerDN, entryLabel } from '../src/lib/entryEvents.ts';
import { dropTabViews, getTabView, hasTabView, moveTabView, setTabView } from '../src/stores/tabViewState.ts';
import { cachedAccountStatus, forgetAccountStatusesUnder, rememberAccountStatus } from '../src/stores/accountStatusCache.ts';
import { originalDNOf } from '../src/lib/recycle.ts';
import { offeredRecentTargets } from '../src/components/lifecycle/containerPicker.ts';
import { matchingProfiles } from '../src/components/commands/paletteSearch.ts';
import { describeQuick } from '../src/components/search/searchModel.ts';
import { objectTypeFromClasses } from '../src/lib/membership.ts';
import { isCompareNoise } from '../src/lib/attributeGroups.ts';
import { splitConnectError } from '../src/components/connection/profileLogic.ts';
import { editSectionForError, isCredentialError } from '../src/lib/connectionAuth.ts';

test('F5 on a tab of another connection reloads it on its own connection (RW2-C-01)', () => {
  const foreign = { profileId: 'ol', name: 'OL', count: 1, dns: ['uid=a,dc=x'] };
  assert.deepEqual(refreshTarget({ selection: [], source: 'tab', foreign }, { tabOpen: true }), { kind: 'foreign', profileId: 'ol', dn: 'uid=a,dc=x' });
  assert.deepEqual(refreshTarget({ selection: [], source: 'palette', foreign }, { tabOpen: true }), { kind: 'foreign', profileId: 'ol', dn: 'uid=a,dc=x' });
  // Several foreign items (a multi-selection of another connection): still nothing.
  assert.deepEqual(refreshTarget({ selection: [], source: 'tree', foreign: { ...foreign, dns: ['a', 'b'] } }), { kind: 'none' });
  // A Contents list's container wins (it is the active connection's).
  assert.deepEqual(refreshTarget({ selection: [], containerDN: 'OU=x', source: 'list', foreign }), { kind: 'container', dn: 'OU=x' });
});

test('a tab adopts the server spelling of its DN (RW2-N-01)', () => {
  assert.equal(adoptServerDN('ou=sub,OU=Track-ux,DC=ad', 'OU=sub,OU=Track-ux,DC=ad'), 'OU=sub,OU=Track-ux,DC=ad');
  assert.equal(adoptServerDN('cn=a, ou=b', 'CN=a,OU=b'), 'CN=a,OU=b');
  assert.equal(adoptServerDN('CN=a,OU=b', 'CN=a,OU=b'), null, 'same spelling');
  assert.equal(adoptServerDN('CN=a,OU=b', 'CN=other,OU=b'), null, 'another entry (alias, referral) never re-keys');
  assert.equal(adoptServerDN('CN=a,OU=b', ''), null);
  assert.equal(adoptServerDN('CN=a,OU=b', undefined), null);
});

test('domain roots are named by their DNS name in tabs (RW2-N-07)', () => {
  assert.equal(entryLabel('DC=ad,DC=ldapilot,DC=lab'), 'ad.ldapilot.lab');
  assert.equal(entryLabel('dc=demo,dc=ldapilot,dc=local'), 'demo.ldapilot.local');
  assert.equal(entryLabel('DC=DomainDnsZones,DC=ad,DC=ldapilot,DC=lab'), 'DomainDnsZones');
  assert.equal(entryLabel('OU=Users,DC=ad,DC=lab'), 'Users');
  assert.equal(entryLabel('DC=lab'), 'lab', 'one DC component stays its value');
  assert.equal(entryLabel('CN=Schmidt\\, Anna,OU=x'), 'Schmidt, Anna');
});

test('per-tab view state: set, move with a re-keyed tab, drop with a closed tab (RW2-E-02/E-03, M-18)', () => {
  setTabView('t1', 'subTab', 'members');
  setTabView('t1', 'list.filter', '049');
  setTabView('t2', 'subTab', 'account');
  assert.equal(getTabView('t1', 'subTab'), 'members');
  assert.equal(hasTabView('t1', 'list.filter'), true);
  setTabView('t1', 'list.filter', undefined);
  assert.equal(hasTabView('t1', 'list.filter'), false, 'undefined removes');
  setTabView('t1', 'subTab', null);
  assert.equal(hasTabView('t1', 'subTab'), true, 'null is a value (the default sub-tab)');
  moveTabView('t1', 't1b');
  assert.equal(hasTabView('t1', 'subTab'), false);
  assert.equal(getTabView('t1b', 'subTab'), null);
  assert.deepEqual(dropTabViews(new Set(['t1b'])), ['t2']);
  assert.equal(getTabView('t2', 'subTab'), undefined);
  assert.equal(getTabView(undefined, 'subTab'), undefined, 'no scope: nothing kept');
  dropTabViews(new Set());
});

test('a re-read listing forgets the remembered account states of its rows (RW2-P-01)', () => {
  const st = (dn: string) => ({ dn, applicable: true, enabled: true, locked: false } as any);
  rememberAccountStatus('ds', st('uid=u1,ou=People,dc=x'));
  rememberAccountStatus('ds', st('uid=u2,ou=Other,dc=x'));
  rememberAccountStatus('ol', st('uid=u1,ou=People,dc=x'));
  forgetAccountStatusesUnder('ds', 'OU=people,DC=x');
  assert.equal(cachedAccountStatus('ds', 'uid=u1,ou=People,dc=x'), undefined, 'row of the reloaded list');
  assert.ok(cachedAccountStatus('ds', 'uid=u2,ou=Other,dc=x'), 'another list keeps it');
  assert.ok(cachedAccountStatus('ol', 'uid=u1,ou=People,dc=x'), 'another connection keeps it');
  forgetAccountStatusesUnder('ds');
  assert.ok(cachedAccountStatus('ds', 'uid=u2,ou=Other,dc=x'), 'no parents: nothing goes');
});

test('restore: a child of a deleted container gets its DN from the container\'s own (M-31)', () => {
  const del = (dn: string, name: string, lastKnownParent: string, extra: object = {}) => ({
    dn, name, rdnAttribute: dn.slice(0, dn.indexOf('=')), lastKnownParent, parentDeleted: /\\0ADEL:/i.test(lastKnownParent),
    originalDN: `${dn.slice(0, dn.indexOf('='))}=${name},${lastKnownParent}`, ...extra,
  });
  const ou = del('OU=del\\0ADEL:1111,CN=Deleted Objects,DC=ad', 'del', 'OU=ux,OU=Track-ux,DC=ad');
  const child = del('CN=Delc\\0ADEL:2222,CN=Deleted Objects,DC=ad', 'Delc', 'OU=del\\0ADEL:1111,CN=Deleted Objects,DC=ad');
  const grand = del('CN=G\\0ADEL:3333,CN=Deleted Objects,DC=ad', 'G', 'CN=Delc\\0ADEL:2222,CN=Deleted Objects,DC=ad');
  const all = [ou, child, grand];
  assert.equal(originalDNOf(ou, all), 'OU=del,OU=ux,OU=Track-ux,DC=ad');
  assert.equal(originalDNOf(child, all), 'CN=Delc,OU=del,OU=ux,OU=Track-ux,DC=ad');
  assert.equal(originalDNOf(grand, all), 'CN=G,CN=Delc,OU=del,OU=ux,OU=Track-ux,DC=ad');
  assert.equal(originalDNOf(child, [child]), '', 'the deleted container is not listed: unknown');
});

test('recent target chips leave out the current parent, moved entries and missing containers (M-12)', () => {
  const recent = ['OU=a,DC=x', 'OU=del,OU=a,DC=x', 'OU=b,DC=x', 'OU=sub,OU=moving,DC=x'];
  assert.deepEqual(offeredRecentTargets(recent, ['CN=u,OU=del,OU=a,DC=x'], new Set()), ['OU=a,DC=x', 'OU=b,DC=x', 'OU=sub,OU=moving,DC=x']);
  assert.deepEqual(offeredRecentTargets(recent, ['OU=moving,DC=x'], new Set(['ou=b,dc=x'])), ['OU=a,DC=x', 'OU=del,OU=a,DC=x']);
  assert.deepEqual(offeredRecentTargets(recent, undefined, new Set(['ou=del,ou=a,dc=x'])), ['OU=a,DC=x', 'OU=b,DC=x', 'OU=sub,OU=moving,DC=x']);
});

test('palette: "switch" / "connect" list every connection (RW2-N-05)', () => {
  const ps = [
    { id: '1', name: 'Lab · Samba AD', host: 'localhost' },
    { id: '2', name: 'Lab · OpenLDAP', host: 'localhost' },
  ];
  assert.deepEqual(matchingProfiles(ps, 'switch').map((p) => p.id), ['1', '2']);
  assert.deepEqual(matchingProfiles(ps, 'connect to').map((p) => p.id), ['1', '2']);
  assert.deepEqual(matchingProfiles(ps, 'switch openldap').map((p) => p.id), ['2']);
  assert.deepEqual(matchingProfiles(ps, 'to').map((p) => p.id), [], '"to" alone is no request');
  assert.deepEqual(matchingProfiles(ps, 'samba').map((p) => p.id), ['1']);
});

test('a type-only quick search is described by its type (RW2-S-05)', () => {
  const label = (a: string) => (a === '*any' ? 'Any name' : a);
  const type = (t: string) => (t === 'contacts' ? 'Contacts' : t);
  assert.equal(describeQuick({ text: '', attr: '*any', matchType: 'contains', objectType: 'contacts' }, label, type), 'All contacts');
  assert.equal(describeQuick({ text: 'jo', attr: '*any', matchType: 'contains', objectType: 'contacts' }, label, type), '"jo" in Any name · Contacts');
});

test('members and pickers: an LDAP person without a login is a contact (M-06)', () => {
  assert.equal(objectTypeFromClasses(['top', 'inetOrgPerson']), 'user', 'unknown attributes stay a user');
  assert.equal(objectTypeFromClasses(['top', 'inetOrgPerson'], ['cn', 'sn', 'mail']), 'contact');
  assert.equal(objectTypeFromClasses(['inetOrgPerson'], ['uid']), 'user');
  assert.equal(objectTypeFromClasses(['inetOrgPerson'], ['userPassword;binary']), 'user');
  assert.equal(objectTypeFromClasses(['inetOrgPerson', 'posixAccount'], []), 'user', 'an account class is a user');
  assert.equal(objectTypeFromClasses(['top', 'person', 'organizationalPerson', 'contact'], []), 'contact');
  assert.equal(objectTypeFromClasses(['groupOfNames'], []), 'group');
});

test('compare: account times and counters are system noise (RW2-E-08)', () => {
  for (const n of ['pwdLastSet', 'badPasswordTime', 'badPwdCount', 'logonCount', 'lastLogonTimestamp', 'pwdChangedTime']) assert.equal(isCompareNoise(n), true, n);
  for (const n of ['accountExpires', 'userAccountControl', 'description']) assert.equal(isCompareNoise(n), false, n);
});

test('connect errors: a certificate problem is said by its kind, Edit… opens the right section (RW2-C-04/C-05)', () => {
  const ip = 'untrusted TLS certificate for 127.0.0.1: x509: cannot validate certificate for 127.0.0.1 because it doesn\'t contain any IP SANs';
  assert.deepEqual(splitConnectError(ip), { summary: 'The server certificate is not trusted: review it', detail: ip });
  assert.equal(splitConnectError('untrusted TLS certificate for h: it does not match the pinned certificate').summary, 'The server certificate changed: review it');
  const ad = 'bind failed: LDAP Result Code 49 "Invalid Credentials": 80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 52e, v1db1';
  assert.equal(isCredentialError(ad), true);
  assert.equal(editSectionForError(ad), 'credentials');
  assert.equal(editSectionForError(ip), 'tls');
  assert.equal(editSectionForError('dial tcp 127.0.0.1:389: connect: connection refused'), undefined);
});
