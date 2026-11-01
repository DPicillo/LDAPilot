// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseDnLabel, exportSummary, focusAfterRemoval, idleSwitcherLabel, importSummary, listTabStop, needsPasswordPrompt, preselectedProfileId,
  profileToActivate, selectionSummaryText, typeAheadKey, typeAheadMatch,
} from '../src/components/connection/profileLogic.ts';

test('saved-profile lists preselect the last used profile, never the alphabetically first', () => {
  const ids = ['prod-ad', 'lab-ol', 'lab-ds'];
  assert.equal(preselectedProfileId(ids, 'lab-ds', 'lab-ol'), 'lab-ds');
  assert.equal(preselectedProfileId(ids, 'deleted', 'lab-ol'), 'lab-ol');
  assert.equal(preselectedProfileId(ids, null, null), null);
  assert.equal(preselectedProfileId(ids, 'gone', 'gone-too'), null);
  // The Connections list needs a tab stop: focused > active > last used > first row.
  assert.equal(listTabStop(ids, 'lab-ol', 'lab-ds', 'lab-ds'), 'lab-ol');
  assert.equal(listTabStop(ids, null, null, 'lab-ds'), 'lab-ds');
  assert.equal(listTabStop(ids, 'gone', 'lab-ol', 'lab-ds'), 'lab-ol');
  assert.equal(listTabStop(ids, null, null, null), 'prod-ad');
  assert.equal(listTabStop([], null, null, null), null);
});

test('type-ahead keeps blanks inside a burst and cycles one-letter searches', () => {
  let st = { buf: '', t: 0 };
  const names = ['UX-C AD', 'UX-C DS', 'UX-C OL'];
  for (const [i, key] of [...'ux-c d'].entries()) {
    const r = typeAheadKey(st, key, 1000 + i * 100);
    assert.equal(r.consumed, true, `key ${JSON.stringify(key)}`);
    st = r.state;
  }
  assert.equal(st.buf, 'ux-c d');
  assert.equal(typeAheadMatch(names, st.buf, 0), 1);
  // A blank outside a burst is not consumed (it selects the row).
  assert.equal(typeAheadKey({ buf: 'ux', t: 0 }, ' ', 5000).consumed, false);
  assert.equal(typeAheadKey({ buf: '', t: 0 }, ' ', 10).consumed, false);
  // Non-character keys are ignored.
  assert.equal(typeAheadKey(st, 'ArrowDown', 1700).consumed, false);
  // "o" repeated cycles through o-names starting after the current row.
  const os = ['Alpha', 'OL', 'OL-RO', 'Zulu'];
  assert.equal(typeAheadMatch(os, 'o', 1), 2);
  assert.equal(typeAheadMatch(os, 'o', 2), 1);
  assert.equal(typeAheadMatch(os, 'ol-', 1), 2);
  assert.equal(typeAheadMatch(os, 'x', 0), -1);
});

test('focus after removing a row goes to the next one, else the previous one', () => {
  assert.equal(focusAfterRemoval(['a', 'b', 'c'], 'b'), 'c');
  assert.equal(focusAfterRemoval(['a', 'b', 'c'], 'c'), 'b');
  assert.equal(focusAfterRemoval(['a'], 'a'), null);
  assert.equal(focusAfterRemoval(['a', 'b'], 'x'), 'a');
});

test('status bar texts', () => {
  assert.equal(idleSwitcherLabel('UX-C DS', 4), 'UX-C DS – not connected · 4 open');
  assert.equal(idleSwitcherLabel('UX-C DS', 0), 'UX-C DS – not connected');
  assert.equal(idleSwitcherLabel(null, 0), 'No connection · Connect…');
  assert.equal(idleSwitcherLabel(null, 2), 'No active connection · 2 open');
  assert.equal(baseDnLabel(''), 'all naming contexts');
  assert.equal(baseDnLabel(' dc=demo '), 'dc=demo');
  assert.equal(selectionSummaryText(1, 12, 'Users'), '12 children of Users · 1 selected');
  assert.equal(selectionSummaryText(2, 1, 'Bulk'), '1 child of Bulk · 2 selected');
  assert.equal(selectionSummaryText(3, null, null), '3 selected');
});

test('an open connection becomes active after a reload: the last active profile first, then the active tab', () => {
  const profiles = [{ id: 'ad' }, { id: 'ol' }, { id: 'ds' }];
  const statuses = { ad: true, ol: true };
  // RW1-C-12: the last active profile (the user's choice) wins over a preview tab of another connection.
  assert.equal(profileToActivate({ activeProfileId: null, profiles, statuses, activeTabProfileId: 'ol', lastActiveId: 'ad' }), 'ad');
  assert.equal(profileToActivate({ activeProfileId: null, profiles, statuses, activeTabProfileId: 'ol', lastActiveId: null }), 'ol');
  assert.equal(profileToActivate({ activeProfileId: null, profiles, statuses, activeTabProfileId: 'ds', lastActiveId: 'ad' }), 'ad');
  assert.equal(profileToActivate({ activeProfileId: null, profiles, statuses, activeTabProfileId: null, lastActiveId: 'ds' }), 'ad');
  assert.equal(profileToActivate({ activeProfileId: 'ds', profiles, statuses, activeTabProfileId: 'ol' }), null);
  assert.equal(profileToActivate({ activeProfileId: null, profiles, statuses: {}, lastActiveId: 'ad' }), null);
});

test('password prompt only for methods that send a password none is stored for', () => {
  const p = { authMethod: 'simple' as const, bindDN: 'cn=admin', hasPassword: false, krbCredSource: undefined };
  assert.equal(needsPasswordPrompt(p), true);
  assert.equal(needsPasswordPrompt({ ...p, hasPassword: true }), false);
  assert.equal(needsPasswordPrompt({ ...p, bindDN: ' ' }), false);
  assert.equal(needsPasswordPrompt({ ...p, authMethod: 'none' }), false);
  assert.equal(needsPasswordPrompt({ ...p, authMethod: 'ntlm' }), true);
  assert.equal(needsPasswordPrompt({ ...p, authMethod: 'kerberos', krbCredSource: 'system' }), false);
  assert.equal(needsPasswordPrompt({ ...p, authMethod: 'external' }), false);
});

test('import and export messages cover every case', () => {
  const base = { total: 0, imported: [] as string[], duplicates: [] as string[], skipped: [] as { name: string; reason: string }[], needPassword: [] as string[] };
  assert.deepEqual(importSummary(base), { tone: 'info', message: 'The file contains no connection profiles' });
  const dup = importSummary({ ...base, total: 11, duplicates: Array.from({ length: 11 }, (_, i) => `P${i}`) });
  assert.equal(dup.message, 'No connections imported (11 already saved)');
  assert.match(dup.detail ?? '', /Already saved/);
  const mixed = importSummary({ ...base, total: 3, imported: ['OL'], duplicates: ['AD'], skipped: [{ name: 'Win', reason: 'unsupported authentication method "sspi"' }], needPassword: ['OL'] });
  assert.equal(mixed.tone, 'warning');
  assert.equal(mixed.message, '1 connection imported (1 already saved, 1 skipped)');
  assert.match(mixed.detail ?? '', /Not imported: Win - unsupported/);
  assert.match(mixed.detail ?? '', /first connect: OL/);
  assert.equal(importSummary({ ...base, total: 2, imported: ['A', 'B'] }).message, '2 connections imported');
  assert.equal(exportSummary({ path: '', count: 0 }), null);
  assert.equal(exportSummary({ path: '/tmp/x.json', count: 11 }), '11 connections exported to /tmp/x.json');
  assert.equal(exportSummary({ path: '/tmp/x.json', count: 1 }), '1 connection exported to /tmp/x.json');
});
