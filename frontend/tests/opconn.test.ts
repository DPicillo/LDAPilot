// v0.5 open-points package "conn" (DEF-01 … DEF-07, shell view after a reload).
// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionTargets, focusAfterRemovals, importSummary, initialExportChoice, listedNames, needsPasswordPrompt, pruneSelection, rangeSelection,
  toggleInSelection,
} from '../src/components/connection/profileLogic.ts';
import {
  caCheckLines, keepPinInfo, pinDetailText, pinInfoFromChain, profileForSave, profileSecurity, sendsPassword, spnSuggestion, validateConnectionForm,
} from '../src/lib/connectionAuth.ts';
import { DEFAULT_SHELL_VIEW, parseShellView, serializeShellView } from '../src/components/connection/chromeLogic.ts';
import type { ConnectionProfile } from '../src/types/ldap.ts';
import type { CertificateInfo } from '../src/types/auth.ts';

const base: ConnectionProfile = {
  id: 'p1', name: 'Lab', host: 'localhost', port: 636, baseDN: '', authMethod: 'simple', bindDN: 'cn=admin', password: '', hasPassword: false,
  tlsMode: 'ssl', tlsSkipVerify: false, pageSize: 500, timeout: 10, readOnly: false, disableReferrals: false,
};

const fp = (pair: string) => Array(32).fill(pair).join(':');

function cert(over: Partial<CertificateInfo>): CertificateInfo {
  return {
    subject: 'CN=dc1.ad.ldapilot.lab', issuer: 'CN=LDAPilot Lab Samba CA', serialNumber: '1', dnsNames: null, ipAddresses: null,
    notBefore: '2026-01-01T00:00:00Z', notAfter: '2036-10-26T00:00:00Z', isCA: false, selfSigned: false, keyAlgorithm: 'RSA', signatureAlgorithm: 'SHA256-RSA',
    sha256: fp('AA'), pem: '', ...over,
  };
}

// --- DEF-02: multi-select delete -----------------------------------------------------

test('multi-selection: toggle, ranges from the anchor, targets of a row action', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual([...toggleInSelection(new Set(['a']), 'c')], ['a', 'c']);
  assert.deepEqual([...toggleInSelection(new Set(['a', 'c']), 'a')], ['c']);
  assert.deepEqual([...rangeSelection(ids, 'b', 'd')], ['b', 'c', 'd']);
  assert.deepEqual([...rangeSelection(ids, 'd', 'b')], ['b', 'c', 'd']);
  assert.deepEqual([...rangeSelection(ids, null, 'c')], ['c']);
  assert.deepEqual([...rangeSelection(ids, 'gone', 'c')], ['c']);
  // A row inside a multi-selection acts on all of it (list order), a row outside only on itself.
  assert.deepEqual(actionTargets(ids, new Set(['d', 'b']), 'd'), ['b', 'd']);
  assert.deepEqual(actionTargets(ids, new Set(['d', 'b']), 'a'), ['a']);
  assert.deepEqual(actionTargets(ids, new Set(['b']), 'b'), ['b']);
  // Deleted profiles leave the selection; an unchanged selection keeps its identity (no re-render loop).
  const sel = new Set(['a', 'c']);
  assert.equal(pruneSelection(sel, ids), sel);
  assert.deepEqual([...pruneSelection(sel, ['a', 'b'])], ['a']);
});

test('focus after deleting several rows: the row after the last one, else before the first', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  assert.equal(focusAfterRemovals(ids, ['b', 'c']), 'd');
  assert.equal(focusAfterRemovals(ids, ['b', 'd']), 'e');
  assert.equal(focusAfterRemovals(ids, ['d', 'e']), 'c');
  assert.equal(focusAfterRemovals(ids, ['a', 'c', 'e']), 'b');
  assert.equal(focusAfterRemovals(ids, ids), null);
  assert.equal(focusAfterRemovals(ids, []), 'a');
});

test('the delete confirmation lists at most 8 names, then "and n more"', () => {
  assert.deepEqual(listedNames(['A', '', 'C']), ['A', 'Unnamed', 'C']);
  const many = Array.from({ length: 11 }, (_, i) => `P${i + 1}`);
  const shown = listedNames(many);
  assert.equal(shown.length, 9);
  assert.equal(shown[8], '… and 3 more');
});

// --- DEF-06: choose the profiles to export --------------------------------------------

test('export checklist: the multi-selection when it has several profiles, else all', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepEqual([...initialExportChoice(ids)], ids);
  assert.deepEqual([...initialExportChoice(ids, ['b'])], ids);
  assert.deepEqual([...initialExportChoice(ids, ['c', 'a', 'gone'])], ['c', 'a']);
});

// --- DEF-07: ask for the password on every connect --------------------------------------

test('ask for the password: only for methods that send one; no password is saved', () => {
  assert.equal(sendsPassword(base), true);
  assert.equal(sendsPassword({ ...base, bindDN: ' ' }), false);
  assert.equal(sendsPassword({ ...base, authMethod: 'ntlm' }), true);
  assert.equal(sendsPassword({ ...base, authMethod: 'kerberos' }), true);
  assert.equal(sendsPassword({ ...base, authMethod: 'kerberos', krbCredSource: 'system' }), false);
  assert.equal(sendsPassword({ ...base, authMethod: 'none' }), false);
  assert.equal(sendsPassword({ ...base, authMethod: 'external' }), false);

  // The form saves without a password (the typed one only feeds Test / Create and Connect).
  const saved = profileForSave({ ...base, askPassword: true, password: 'typed', hasPassword: true });
  assert.equal(saved.password, '');
  assert.equal(saved.askPassword, true);
  assert.equal(profileForSave({ ...base, authMethod: 'none', askPassword: true }).askPassword, false);
  assert.equal(profileForSave({ ...base, password: 'kept' }).password, 'kept');

  // No "Password is required" for an ask-password profile; still for a plain one.
  assert.equal(validateConnectionForm({ ...base, askPassword: true }, null).errors.password, undefined);
  assert.ok(validateConnectionForm(base, null).errors.password);

  // Connect asks (nothing stored) and the security tooltip says so.
  assert.equal(needsPasswordPrompt({ ...base, askPassword: true }), true);
  assert.match(profileSecurity({ ...base, askPassword: true }).title, /Asks for the password on every connect/);
  assert.doesNotMatch(profileSecurity(base).title, /every connect/);
});

test('import summary lists the profiles that ask on every connect', () => {
  const s = importSummary({ total: 2, imported: ['A', 'B'], duplicates: [], skipped: [], needPassword: ['A'], askPassword: ['B'] });
  assert.equal(s.tone, 'success');
  assert.match(s.detail ?? '', /first connect: A/);
  assert.match(s.detail ?? '', /every connect: B/);
});

// --- DEF-04: pinned certificate details -----------------------------------------------

test('pin details: recorded from a presented chain, kept only for remaining pins', () => {
  const pins = [fp('aa'), fp('BB')];
  const chain = [cert({ sha256: fp('AA'), subject: 'CN=ds1.lab', issuer: 'CN=Lab CA', notAfter: '2028-10-29T00:00:00Z' }), cert({ sha256: fp('CC'), isCA: true })];
  const { info, found } = pinInfoFromChain(undefined, pins, chain);
  assert.deepEqual(found, [fp('AA')]);
  assert.equal(info?.[fp('AA')].subject, 'CN=ds1.lab');
  assert.equal(info?.[fp('BB')], undefined);
  // Removing the pin drops its details.
  assert.equal(keepPinInfo(info, [fp('BB')]), undefined);
  assert.deepEqual(Object.keys(keepPinInfo(info, pins) ?? {}), [fp('AA')]);
  // Saving prunes them too.
  assert.equal(profileForSave({ ...base, tlsPinnedCerts: [fp('BB')], tlsPinnedInfo: info }).tlsPinnedInfo, undefined);

  const now = new Date('2027-01-01T00:00:00Z');
  assert.equal(pinDetailText(info?.[fp('AA')], now), 'ds1.lab · issued by Lab CA · expires 2028-10-29');
  assert.equal(pinDetailText({ subject: 'CN=self', issuer: 'CN=self', notAfter: '2026-01-01T00:00:00Z' }, now), 'self · self-signed · expired 2026-01-01');
  assert.equal(pinDetailText(undefined), null);
});

// --- DEF-05: Kerberos SPN from the RootDSE ----------------------------------------------

test('SPN suggestion from the server name unless the profile already uses it', () => {
  assert.equal(spnSuggestion({ host: 'localhost', krbSPN: '' }, 'DC1.ad.ldapilot.lab'), 'ldap/dc1.ad.ldapilot.lab');
  assert.equal(spnSuggestion({ host: '10.0.0.5', krbSPN: 'ldap/wrong' }, 'dc1.ad.ldapilot.lab'), 'ldap/dc1.ad.ldapilot.lab');
  assert.equal(spnSuggestion({ host: 'localhost', krbSPN: 'ldap/dc1.ad.ldapilot.lab' }, 'dc1.ad.ldapilot.lab'), null);
  assert.equal(spnSuggestion({ host: 'dc1.ad.ldapilot.lab', krbSPN: '' }, 'dc1.ad.ldapilot.lab'), null);
  assert.equal(spnSuggestion({ host: 'localhost', krbSPN: '' }, ''), null);
  assert.equal(spnSuggestion({ host: 'localhost', krbSPN: '' }, undefined), null);
});

// --- DEF-03: CA check lines -----------------------------------------------------------------

test('CA check: subject and validity, expired / not a CA marked', () => {
  const now = new Date('2027-01-01T00:00:00Z');
  const lines = caCheckLines([
    cert({ subject: 'CN=LDAPilot Lab Samba CA,O=LDAPilot', isCA: true, notBefore: '2026-10-26T00:00:00Z' }),
    cert({ subject: 'CN=old CA', isCA: true, notAfter: '2026-06-01T00:00:00Z' }),
    cert({ subject: 'CN=leaf', isCA: false }),
  ], now);
  assert.deepEqual(lines[0], { name: 'LDAPilot Lab Samba CA', text: 'valid 2026-10-26 – 2036-10-26', tone: 'ok' });
  assert.deepEqual(lines[1], { name: 'old CA', text: 'expired on 2026-06-01', tone: 'danger' });
  assert.equal(lines[2].tone, 'warning');
  assert.match(lines[2].text, /not a CA certificate/);
});

// --- Shell view after a reload -------------------------------------------------------------

test('shell view: restored activity and bottom panel, validated', () => {
  const v = { activity: 'search' as const, bottomVisible: true, bottomTab: 'audit' as const };
  assert.deepEqual(parseShellView(serializeShellView(v), 'sidebar'), v);
  assert.deepEqual(parseShellView(null, 'sidebar'), DEFAULT_SHELL_VIEW);
  assert.deepEqual(parseShellView('{bad json', 'sidebar'), DEFAULT_SHELL_VIEW);
  assert.deepEqual(parseShellView('{"activity":"nope","bottomVisible":"yes","bottomTab":"x"}', 'sidebar'), DEFAULT_SHELL_VIEW);
  // The AI activity is not restored while the chat is docked right.
  assert.equal(parseShellView('{"activity":"ai"}', 'right').activity, 'explorer');
  assert.equal(parseShellView('{"activity":"ai"}', 'sidebar').activity, 'ai');
});
