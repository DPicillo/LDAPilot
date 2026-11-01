// Run: cd frontend && node --test 'tests/*.test.ts'
// v0.5 leftovers ("rest"): the move flow's close rule (batch dialog Move tab = Move…),
// the one "send unencrypted?" confirmation (DEF-21), cancellable statistics (DEF-23) and the
// editor header's Reconnect primary while the tab's connection is lost (RW2-C-02).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveClosesDialog, moveToastText } from '../src/components/bulk/moveModel.ts';

test('move flow: a full success closes the dialog, a failure or refusal keeps the result', () => {
  assert.equal(moveClosesDialog({ moved: 3, failed: 0 }), true);
  assert.equal(moveClosesDialog({ moved: 2, failed: 1 }), false);
  assert.equal(moveClosesDialog({ moved: 0, failed: 0 }), false);
  assert.equal(moveClosesDialog({ moved: 0, failed: 2 }), false);
  assert.equal(moveClosesDialog({ moved: 1, failed: 0, refused: 'The target container does not exist' }), false);
});

test('move flow: one toast text for Move… and the batch dialog', () => {
  assert.equal(moveToastText(['Anna'], 'Staff'), 'Anna moved to Staff');
  assert.equal(moveToastText(['a', 'b'], 'Staff'), '2 entries moved to Staff');
  assert.equal(moveToastText(['a', 'b'], 'Staff', 1), '2 entries moved to Staff (1 already there)');
});

import { nextStatsRequestId, statisticsText, statsPhaseAfter, statsShare, statsTruncatedNote } from '../src/components/tree/statisticsModel.ts';

test('statistics (DEF-23): a stopped count discards its result, request IDs are unique', () => {
  assert.equal(statsPhaseAfter('ok', false), 'done');
  assert.equal(statsPhaseAfter('error', false), 'error');
  assert.equal(statsPhaseAfter('ok', true), 'stopped');
  assert.equal(statsPhaseAfter('error', true), 'stopped');
  const a = nextStatsRequestId();
  const b = nextStatsRequestId();
  assert.notEqual(a, b);
  assert.match(a, /^stats-/);
});

test('statistics: a count at the size limit is marked as a lower bound', () => {
  assert.equal(statsTruncatedNote({ totalCount: 10, truncated: false }), '');
  assert.ok(statsTruncatedNote({ totalCount: 50000, truncated: true }).includes(`first ${(50000).toLocaleString()} entries only`));
  const text = statisticsText('ou=x', { totalCount: 50000, truncated: true, byType: { Users: 40000, Groups: 10000 } });
  assert.ok(text.includes(`${(50000).toLocaleString()}+`));
  assert.match(text, /lower bound/);
  assert.equal(statsShare(1, 4), '25.0');
  assert.equal(statsShare(1, 0), '0');
  const plain = statisticsText('ou=x', { totalCount: 2, byType: { Users: 2 } });
  assert.doesNotMatch(plain, /lower bound|\+/);
});

import { editorHeaderPrimary, primaryAccountVerb } from '../src/components/ui/primaryAction.ts';

test('editor header (RW2-C-02): Reconnect is the primary while the connection is lost, the account verb returns after', () => {
  assert.equal(editorHeaderPrimary({ offline: true }), 'reconnect');
  assert.equal(editorHeaderPrimary({ offline: false }), 'account');
  // Back online: the account verb is picked as before (Unlock when locked).
  const items = [{ id: 'account.resetPassword', enabled: true }, { id: 'account.unlock', enabled: true }];
  assert.equal(primaryAccountVerb(items, ['locked'])?.id, 'account.unlock');
});

import { readFileSync, readdirSync, statSync } from 'node:fs';
import {
  UNENCRYPTED_CONSENT, UNENCRYPTED_CONTINUE, UNENCRYPTED_RISK, UNENCRYPTED_TITLE, connectCleartextNote, resetCleartextParts, unencryptedWhat,
  withUnencryptedConsent,
} from '../src/lib/unencryptedConsent.ts';

test('DEF-21: what a reset sends in cleartext, one sentence', () => {
  assert.deepEqual(resetCleartextParts({ method: 'exop', scheme: '', verifyBind: true }), ['Password Modify extended operation', 'verification bind']);
  assert.deepEqual(resetCleartextParts({ method: 'userPassword', scheme: 'cleartext', verifyBind: false }), ['cleartext userPassword']);
  assert.deepEqual(resetCleartextParts({ method: 'userPassword', scheme: 'CRYPT-SHA512', verifyBind: false }), []);
  assert.equal(unencryptedWhat(['verification bind']), 'The reset sends the new password in cleartext (verification bind).');
  assert.equal(unencryptedWhat([]), 'The reset sends the new password in cleartext.');
});

test('DEF-21: allowUnencrypted only after the explicit consent', () => {
  assert.equal(withUnencryptedConsent({}, true, false).allowUnencrypted, false);
  assert.equal(withUnencryptedConsent({}, true, true).allowUnencrypted, true);
  // A ticked box on a write that does not need it sends nothing extra.
  assert.equal(withUnencryptedConsent({}, false, true).allowUnencrypted, false);
  // The caller confirmed already (base options).
  assert.equal(withUnencryptedConsent({ policy: 'server' }, false, false, true).allowUnencrypted, true);
});

test('DEF-21: the connect prompt names a simple bind over plain LDAP only', () => {
  assert.equal(connectCleartextNote('simple', 'none'), UNENCRYPTED_RISK);
  assert.equal(connectCleartextNote(undefined, undefined), UNENCRYPTED_RISK);
  assert.equal(connectCleartextNote('simple', 'ssl'), '');
  assert.equal(connectCleartextNote('simple', 'starttls'), '');
  assert.equal(connectCleartextNote('kerberos', 'none'), '');
  assert.equal(connectCleartextNote('ntlm', 'none'), '');
});

test('DEF-21: every unencrypted-send confirmation uses the one pattern', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const pwDialog = read('../src/components/editor/PasswordDialog.tsx');
  assert.match(pwDialog, /<UnencryptedSendDialog/);
  assert.doesNotMatch(pwDialog, /ConfirmDialog/);
  const guard = read('../src/components/password/PasswordWriteGuard.tsx');
  assert.match(guard, /<UnencryptedConsent /);
  assert.match(guard, /withUnencryptedConsent\(/);
  const card = read('../src/components/ai/ApprovalCard.tsx');
  assert.match(card, /<UnencryptedConsent /);
  assert.match(card, /needsPlainConsent && !plainConsent/);
  const dialog = read('../src/components/password/UnencryptedConsent.tsx');
  // Cancel first (initial focus), then Continue, which needs the consent.
  assert.ok(dialog.indexOf('Cancel</Button>') < dialog.indexOf('{UNENCRYPTED_CONTINUE}'));
  assert.match(dialog, /disabled=\{!consent\}/);
  assert.match(dialog, /onSubmit=\{\(\) => \{ if \(consent\) onConfirm\(\) \}\}/);
  // No second wording of the consent / the old button anywhere else in src.
  const files: string[] = [];
  const walk = (dir: URL) => {
    for (const name of readdirSync(dir)) {
      const u = new URL(name, dir);
      if (statSync(u).isDirectory()) walk(new URL(`${name}/`, dir));
      else if (/\.(ts|tsx)$/.test(name)) files.push(u.pathname);
    }
  };
  walk(new URL('../src/', import.meta.url));
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (f.endsWith('lib/unencryptedConsent.ts')) continue;
    assert.ok(!src.includes('Send unencrypted'), `old confirm label in ${f}`);
    assert.ok(!src.includes('Anyone on the network path can read it.'), `own consent wording in ${f}`);
  }
  assert.equal(UNENCRYPTED_TITLE, 'Send the password unencrypted?');
  assert.equal(UNENCRYPTED_CONTINUE, 'Continue');
  assert.match(UNENCRYPTED_CONSENT, /no LDAPS\/StartTLS/);
});

import { editSectionForError, isCredentialError } from '../src/lib/connectionAuth.ts';

test('DEF-26 recheck: a bind cut off by a dropped connection is no credential refusal (auto-retry keeps going)', () => {
  const eof = 'LDAP bind failed: unable to read LDAP response packet: EOF (simple bind as cn=admin,dc=demo,dc=ldapilot,dc=local)';
  assert.equal(isCredentialError(eof), false);
  assert.equal(editSectionForError(eof), undefined);
  assert.equal(isCredentialError('LDAP bind failed: read tcp 127.0.0.1:5→127.0.0.1:389: read: connection reset by peer'), false);
  assert.equal(isCredentialError('LDAP bind failed: LDAP Result Code 200 "Network Error": i/o timeout'), false);
  // Real refusals stay credential errors.
  assert.equal(isCredentialError('LDAP bind failed: LDAP Result Code 49 "Invalid Credentials": 80090308: LdapErr: DSID-0C0903A9, data 52e'), true);
  assert.equal(isCredentialError('LDAP bind failed: LDAP Result Code 53 "Unwilling To Perform": account is locked'), true);
  assert.equal(isCredentialError('LDAP bind failed: LDAP Result Code 50 "Insufficient Access Rights"'), true);
  assert.equal(isCredentialError('password required: no password is stored for "x"'), true);
  assert.equal(isCredentialError('failed to connect to LDAP server: Network Error: dial tcp 127.0.0.1:38390: i/o timeout'), false);
  assert.equal(isCredentialError(''), false);
});

import { eventKey, installKeyNormalization, matchShortcut, normalizedKey } from '../src/components/ui/shortcuts.ts';

test('DEF-26 recheck: WebKitGTK Shift+Tab ("Unidentified", code Tab) is a Tab', () => {
  assert.equal(normalizedKey('Unidentified', 'Tab'), 'Tab');
  assert.equal(normalizedKey('', 'Escape'), 'Escape');
  assert.equal(normalizedKey('Unidentified', 'F5'), 'F5');
  assert.equal(normalizedKey('Tab', 'Tab'), null);
  assert.equal(normalizedKey('a', 'KeyA'), null);
  assert.equal(normalizedKey('Unidentified', 'IntlBackslash'), null);
  assert.equal(eventKey({ key: 'Unidentified', code: 'Tab' }), 'tab');
  const e = { key: 'Unidentified', code: 'Tab', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
  assert.equal(matchShortcut(e, 'Ctrl+Shift+Tab'), true);
  assert.equal(matchShortcut(e, 'Ctrl+Tab'), false);
  // The window listener rewrites the event before later listeners (React) read it.
  const t = new EventTarget();
  const off = installKeyNormalization(t as unknown as Window);
  const ev = new Event('keydown');
  Object.defineProperty(ev, 'key', { get: () => 'Unidentified', configurable: true });
  Object.defineProperty(ev, 'code', { value: 'Tab' });
  let seen = '';
  t.addEventListener('keydown', (x) => { seen = (x as unknown as { key: string }).key; });
  t.dispatchEvent(ev);
  assert.equal(seen, 'Tab');
  off();
});
