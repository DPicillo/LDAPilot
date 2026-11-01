// Passwords in the composer (lib/aiPassword.ts, A-13). The vectors are
// shared with the Go scanner (internal/ai/secrettext_test.go).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { maskPasswords, maskSurePasswords, maskAllPasswords, removePasswords, scanPasswords, resetRequest, hintOf, PASSWORD_PLACEHOLDER } from '../../src/lib/aiPassword.ts';

const { cases } = JSON.parse(readFileSync(new URL('./password-phrases.json', import.meta.url), 'utf8'));

test('shared vectors: masking and the approval-card reset', () => {
  for (const c of cases) {
    assert.equal(maskPasswords(c.text), c.masked, `mask: ${c.text}`);
    assert.equal(maskSurePasswords(c.text), c.sure ?? c.masked, `sure: ${c.text}`);
    const scan = scanPasswords(c.text);
    assert.equal(scan.matches.length > 0, c.masked !== c.text, `strong: ${c.text}`);
    assert.equal(resetRequest(c.text, scan), c.reset ?? null, `reset: ${c.text}`);
    // idempotent: an already masked text stays as it is
    assert.equal(maskPasswords(c.masked), c.masked, `idempotent: ${c.text}`);
  }
});

test('weak matches: long random tokens without a password word', () => {
  assert.equal(scanPasswords('use aB3dE5fG7hJ9kL1mN3pQ for the bind').weak, true);
  assert.equal(scanPasswords('use aB3dE5fG7hJ9kL1mN3pQ for the bind').matches.length, 0);
  assert.equal(scanPasswords('objectGUID 6f9619ff-8b86-d011-b42d-00cf4fc964ff').weak, false);
  assert.equal(scanPasswords('CN=Anna Schmidt,OU=Users,DC=corp,DC=example,DC=com').weak, false);
  assert.equal(maskAllPasswords('use aB3dE5fG7hJ9kL1mN3pQ and password: x1'), `use ${PASSWORD_PLACEHOLDER} and password: ${PASSWORD_PLACEHOLDER}`);
});

test('hint never shows the whole value', () => {
  const t = 'password: Passw0rd!2026';
  const m = scanPasswords(t).matches[0];
  assert.equal(hintOf(t, m), 'Pa••••••••26');
  const q = "password 'abc'";
  assert.equal(hintOf(q, scanPasswords(q).matches[0]), '•••');
});

test('matches carry keyword, target and language', () => {
  const [m] = scanPasswords('Setze das Kennwort von Anna Schmidt auf Herbst2026!').matches;
  assert.equal(m.keyword, 'Kennwort');
  assert.equal(m.target, 'Anna Schmidt');
  assert.equal(m.lang, 'de');
  const [e] = scanPasswords('Set the password of ux-a-user1 to Passw0rd!2026').matches;
  assert.equal(e.lang, 'en');
  assert.equal(e.target, 'ux-a-user1');
});

test('"Remove the password" leaves no further password behind (A-13 review)', () => {
  for (const [text, want] of [
    ['Reset the password of jdoe to Sommer2026!, and of anna to Herbst#26', 'Reset the password of jdoe to [password removed], and of anna to [password removed]'],
    ['password: Sommer2026! (old one was Winter2025!)', 'password: [password removed] (old one was [password removed])'],
    ['Password: Sommer2026!\nUser: anna Herbst#2026', 'Password: [password removed]\nUser: anna [password removed]'],
    ["Set the password of O'Brien-2 to Sommer2026!", "Set the password of O'Brien-2 to [password removed]"],
  ]) {
    const out = removePasswords(text);
    assert.equal(out, want, text);
    const again = scanPasswords(out);
    assert.equal(again.matches.length, 0, `rescan: ${out}`);
    assert.equal(again.leftover, false, `leftover: ${out}`);
  }
  // a second password after the removal is still reported (the composer warns)
  assert.equal(scanPasswords('Password: [password removed]\nUser: anna Herbst#2026').leftover, true);
  assert.equal(scanPasswords('Reset the password of jdoe to [password removed]').leftover, false);
});

test('a plain word after a label is not sure (the composer offers Send anyway)', () => {
  const [m] = scanPasswords('PW: geheim').matches;
  assert.equal(m.sure, false);
  assert.equal(scanPasswords('PW: Geheim2026').matches[0].sure, true);
  assert.equal(scanPasswords("Change her password to 'summer'").matches[0].sure, true);
});

test('the reset request names the account of the new phrasings', () => {
  assert.equal(scanPasswords('Password jdoe: Sommer2026!').matches[0].target, 'jdoe');
  assert.equal(scanPasswords('the password for jdoe should be Sommer2026!').matches[0].target, 'jdoe');
  assert.equal(resetRequest('Set the password on jdoe to Sommer2026! and enable the account'), null);
});
