// UX loop round 2: operations log per profile, connect error text, diagnostics paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryForProfile, fileNamePart, mergeLogEntries } from '../src/components/layout/opLog.ts';
import { splitConnectError } from '../src/components/connection/profileLogic.ts';
import { redactUserPath } from '../src/components/connection/chromeLogic.ts';

test('the shared operation:log stream is filtered on the entry profile (RW1-C-03)', () => {
  assert.equal(entryForProfile({ profileId: 'ol' }, 'ol'), true);
  assert.equal(entryForProfile({ profileId: 'ol' }, 'ol-ro'), false, 'a foreign tab refresh never lands in the active log');
  assert.equal(entryForProfile({}, 'ol'), true, 'older backend without profileId');
  assert.equal(entryForProfile({ profileId: 'ol' }, null), false);
});

test('GetLogs + stream merge lists the CONNECT entry once, in sequence order (RW1-C-03)', () => {
  const e = (seq: number, op = 'SEARCH') => ({ seq, operation: op });
  // The stream delivered CONNECT (seq 3) before GetLogs answered with 1..3.
  const streamed = [e(3, 'CONNECT')];
  const merged = mergeLogEntries([e(1, 'BIND'), e(2, 'CONNECT'), e(3, 'CONNECT')], streamed);
  assert.deepEqual(merged.map((x) => x.seq), [1, 2, 3]);
  // Live entries append; a repeat is dropped.
  assert.deepEqual(mergeLogEntries(merged, [e(4)]).map((x) => x.seq), [1, 2, 3, 4]);
  assert.equal(mergeLogEntries(merged, [e(3)]).length, 3);
  // Out of order: sorted.
  assert.deepEqual(mergeLogEntries([e(5)], [e(1), e(2)]).map((x) => x.seq), [1, 2, 5]);
  // The view keeps at most the backend's limit.
  assert.deepEqual(mergeLogEntries([e(1), e(2)], [e(3)], 2).map((x) => x.seq), [2, 3]);
  // Nothing new: the same array (no re-render).
  assert.equal(mergeLogEntries(merged, []), merged);
});

test('operations CSV gets a file-system friendly default name (RW1-R-09)', () => {
  assert.equal(fileNamePart('Lab · Samba AD (LDAPS)'), 'Lab-Samba-AD-LDAPS');
  assert.equal(fileNamePart('Müller/OL'), 'Muller-OL');
  assert.equal(fileNamePart('···'), '');
});

test('connect error: the sentence to act on first, the server text as detail (RW1-C-01)', () => {
  const ad = 'bind failed: LDAP Result Code 49 "Invalid Credentials": 80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 52e, v1db1 — wrong password or user name (AD code 52e)';
  const a = splitConnectError(ad);
  assert.equal(a.summary, 'Wrong password or user name (AD code 52e)');
  assert.equal(a.detail, ad);
  const refused = 'LDAP Result Code 200 "Network Error": dial tcp 127.0.0.1:1389: connect: connection refused';
  assert.deepEqual(splitConnectError(refused), { summary: 'Connection refused', detail: refused });
  assert.deepEqual(splitConnectError('connection refused'), { summary: 'Connection refused', detail: null });
  assert.equal(splitConnectError('').summary, 'Connection failed');
  const long = 'x'.repeat(300);
  assert.ok(splitConnectError(long).summary.length <= 160);
  assert.equal(splitConnectError(long).detail, long);
});

test('diagnostics never carry the OS user name (RW1-C-11)', () => {
  assert.equal(redactUserPath('/home/dpicillo/.config/LDAPilot'), '~/.config/LDAPilot');
  assert.equal(redactUserPath('/Users/Anna/Library/Application Support/LDAPilot'), '~/Library/Application Support/LDAPilot');
  assert.equal(redactUserPath('C:\\Users\\Anna Schmidt\\AppData\\Roaming\\LDAPilot'), '%APPDATA%\\LDAPilot');
  assert.equal(redactUserPath('C:\\Users\\Anna\\AppData\\Local\\LDAPilot'), '%LOCALAPPDATA%\\LDAPilot');
  assert.equal(redactUserPath('C:\\Users\\Anna\\LDAPilot'), '%USERPROFILE%\\LDAPilot');
  assert.equal(redactUserPath('/tmp/claude-1000/ux/env/c/config/LDAPilot'), '…/config/LDAPilot');
  assert.equal(redactUserPath('/etc/LDAPilot'), '/etc/LDAPilot');
  assert.equal(redactUserPath(undefined), undefined);
});

test('results CSV: report file name, DN column always included (RW1-S-10)', async () => {
  const { resultsFileName, withDnColumn } = await import('../src/components/search/resultsExport.ts');
  assert.equal(resultsFileName('Disabled Accounts', 'Users'), 'disabled-accounts');
  assert.equal(resultsFileName('Passwords Expiring Soon (14 days)', ''), 'passwords-expiring-soon-14-days');
  assert.equal(resultsFileName('Search', 'Users'), 'Users results');
  assert.equal(resultsFileName(undefined, ''), 'search-results');
  const cols = [{ id: 'name', header: 'Name', text: () => '' }, { id: 'dn', header: 'DN', text: () => '' }];
  assert.deepEqual(withDnColumn([cols[0]], cols).map((c) => c.id), ['name', 'dn']);
  assert.deepEqual(withDnColumn(cols, cols).map((c) => c.id), ['name', 'dn']);
});

test('Filter Builder: an empty equals value is a problem, not "(mail=)" (RW1-S-08)', async () => {
  const { buildBuilderFilter } = await import('../src/lib/searchFilter.ts');
  const r = buildBuilderFilter({ operator: '&', conditions: [{ attribute: 'objectClass', operator: '=', value: 'user' }, { attribute: 'mail', operator: '=', value: '' }] } as any);
  assert.equal(r.filter, '');
  assert.deepEqual(r.problems, ['Value missing for mail']);
  const nested = buildBuilderFilter({ operator: '&', conditions: [{ attribute: 'cn', operator: '=', value: 'x' }, { operator: '|', conditions: [{ attribute: '', operator: '=', value: '' }] }] } as any);
  assert.deepEqual(nested.problems, ['Attribute missing'], 'the untouched row inside a group, not "Empty group"');
  assert.equal(buildBuilderFilter({ operator: '&', conditions: [{ attribute: 'mail', operator: 'present', value: '' }] } as any).filter, '(mail=*)');
});

test('Show History follows renames backwards, old DN links forwards (RW1-R-04)', async () => {
  const { historyDNs, forwardDN } = await import('../src/components/layout/opTone.ts');
  const base = 'OU=ux-rw1-r,OU=Track-ux,DC=ad';
  const old = `CN=ux-rw1-r-contact1,${base}`;
  const now = `CN=ux-rw1-r-contact1-renamed,${base}`;
  const entries = [
    { timestamp: '2026-11-01 02:41:05', operation: 'MODIFY', dn: old, details: 'replace description' },
    { timestamp: '2026-11-01 02:41:07', operation: 'MODIFY', dn: old, details: 'replace description' },
    { timestamp: '2026-11-01 02:41:24', operation: 'RENAME', dn: old, details: `newRDN=CN=ux-rw1-r-contact1-renamed deleteOldRDN=true newDN=${now}` },
    { timestamp: '2026-11-01 02:42:00', operation: 'RENAME', dn: 'CN=other,DC=ad', details: 'newDN=CN=other2,DC=ad', error: 'failed' },
  ];
  const chain = historyDNs(entries, now);
  assert.equal(chain.size, 2);
  assert.ok(chain.has(old.toLowerCase().replace(/\s/g, '')) || [...chain].some((d) => d.startsWith('cn=ux-rw1-r-contact1,')));
  assert.equal(forwardDN(entries, old, '2026-11-01 02:41:05'), now, 'a MODIFY row of the old DN opens the renamed entry');
  assert.equal(forwardDN(entries, now), now);
  assert.equal(forwardDN(entries, 'CN=other,DC=ad'), 'CN=other,DC=ad', 'a failed rename is not followed');
  // A row after the rename (the old name was reused): not forwarded.
  assert.equal(forwardDN(entries, old, '2026-11-01 03:00:00'), old);
});
