// Run: cd frontend && node --test 'tests/*.test.ts'
// ACCT-02 / ACCT-08 / ACCT-10: Reset Password dialog logic and password write toasts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountOptions, defaultAccountFlags, methodOptionLabel, passwordSubmitBlock, passwordSummaryLine, resultSummary, schemeLabelOptions,
  schemeOptionLabel, availableMethods, policySelection, selectionNotices,
} from '../src/lib/passwordMethod.ts';
import { accountNameTokens, assessPassword } from '../src/lib/passwordGenerator.ts';
import { passwordToastActions, reportHeadline, reportKeptDisabled, reportSuccessDetail, reportSummary } from '../src/lib/passwordPolicy.ts';
import type { PasswordChangeResult, PasswordContext } from '../src/types/password.ts';
import type { EffectivePasswordPolicy, PasswordWriteReport } from '../src/types/passwordPolicy.ts';
import type { AccountPolicy } from '../src/types/account.ts';

function eff(p: Partial<EffectivePasswordPolicy>): EffectivePasswordPolicy {
  return {
    configured: 'auto', policy: 'client', scheme: 'CRYPT-SHA512', schemeLabel: '{CRYPT} SHA-512-crypt ($6$)', source: 'default', reason: '',
    serverType: 'openldap', serverHashes: false, serverHashing: '', passwordModifyExop: true, tls: true, summary: '', warnings: [], ...p,
  };
}

function ctx(p: Partial<PasswordContext>, policy?: Partial<EffectivePasswordPolicy>): PasswordContext {
  const schemes = ['SSHA', 'CRYPT-SHA512', 'PBKDF2-SHA512', 'CLEARTEXT'].map((id) => ({
    id, label: id === 'CLEARTEXT' ? 'Cleartext (no hashing)' : `{${id}}`, description: '', security: id === 'CLEARTEXT' ? 'none' : 'good',
    support: [{ server: 'openldap', level: 'native', note: '' }, { server: '389ds', level: 'native', note: '' }],
  })) as PasswordContext['schemes'];
  return {
    dn: 'uid=x', serverType: 'openldap', vendorName: '', vendorVersion: '', tls: true, tlsMode: 'starttls', passwordModifyExop: true,
    ppolicyControl: true, objectClasses: ['inetOrgPerson'], isADAccount: false, hasUserPassword: true, currentScheme: 'SSHA',
    currentSchemeLabel: '{SSHA}', locked: false, mustChange: false, disabled: false, passwordNeverExpires: false, readOnly: false,
    schemes, defaultScheme: 'SSHA', policy: policy ? eff(policy) : undefined, ...p,
  };
}

const POLICY: AccountPolicy = {
  name: 'default-ppolicy', source: 'default', readable: true, lockoutEnabled: true, lockoutThreshold: 3, lockoutDurationSeconds: 0,
  observationWindowSeconds: 0, maxPasswordAgeSeconds: 0, minPasswordAgeSeconds: 0, minPasswordLength: 8, passwordHistory: 5,
  expireWarningSeconds: 0, graceLogins: 0, mustChangeEnforced: true,
};

test('AD without TLS: the reset is blocked with the reason and the fix (nothing is sent)', () => {
  const ad = ctx({ serverType: 'ad', tls: false, tlsMode: 'none', isADAccount: true, objectClasses: ['user'] }, { policy: 'ad', serverType: 'ad', tls: false });
  const block = passwordSubmitBlock(ad, { method: 'unicodePwd', scheme: 'CLEARTEXT', verifyBind: false });
  assert.ok(block);
  assert.match(block!.fix, /StartTLS or LDAPS/);
  // every method on AD (userPassword with fUserPwdSupport needs TLS too)
  assert.ok(passwordSubmitBlock(ad, { method: 'userPassword', scheme: 'CLEARTEXT', verifyBind: false }));
  assert.equal(passwordSubmitBlock({ ...ad, tls: true, tlsMode: 'ssl' }, { method: 'unicodePwd', scheme: 'CLEARTEXT', verifyBind: false }), null);
  // AD LDS style entry on an unknown server: unicodePwd blocked, other methods not
  const lds = ctx({ serverType: 'other', tls: false, tlsMode: 'none', objectClasses: ['user'] });
  assert.ok(passwordSubmitBlock(lds, { method: 'unicodePwd', scheme: 'SSHA', verifyBind: false }));
  assert.equal(passwordSubmitBlock(lds, { method: 'userPassword', scheme: 'SSHA', verifyBind: false }), null);
  // the old warning notice is gone (the block says it once)
  assert.ok(!selectionNotices(ad, { method: 'unicodePwd', scheme: 'CLEARTEXT', verifyBind: false }).some((n) => n.text.includes('WILL_NOT_PERFORM')));
});

test('summary line: storage, transport and the policy marker', () => {
  const ol = ctx({}, { policy: 'client', scheme: 'CRYPT-SHA512' });
  const sel = policySelection(ol)!;
  const line = passwordSummaryLine(ol, sel);
  assert.equal(line.storage, '{CRYPT-SHA512}, hashed by LDAPilot (policy)');
  assert.equal(line.transport, 'encrypted (StartTLS)');
  assert.equal(line.transportWarning, false);
  const ds = ctx({ serverType: '389ds', tls: false, tlsMode: 'none' }, { policy: 'server', serverHashes: true, serverHashing: 'PBKDF2-SHA512', serverType: '389ds', tls: false });
  const dsLine = passwordSummaryLine(ds, policySelection(ds)!);
  // RW1-P-05: no nested parentheses.
  assert.equal(dsLine.storage, 'Cleartext – the server hashes it with PBKDF2-SHA512 (policy)');
  const dsNote = ctx({ serverType: '389ds', tls: false, tlsMode: 'none' }, { policy: 'server', serverHashes: true, serverHashing: '389 Directory Server stores passwords with PBKDF2-SHA512 (passwordStorageScheme)', serverType: '389ds', tls: false });
  assert.equal(passwordSummaryLine(dsNote, policySelection(dsNote)!).storage, 'Cleartext – the server hashes it with PBKDF2-SHA512 (policy)');
  assert.equal(dsLine.transportWarning, true);
  assert.equal(passwordSummaryLine(ol, { method: 'userPassword', scheme: 'SSHA', verifyBind: false }).storage, '{SSHA}, hashed by LDAPilot');
  const plainHash = passwordSummaryLine({ ...ol, tls: false, tlsMode: 'none' }, { ...sel, verifyBind: false });
  assert.equal(plainHash.transportWarning, false);
});

test('"(policy)" marks what the policy chose; DS cleartext reads "the server hashes it"', () => {
  const ol = ctx({}, { policy: 'client', scheme: 'CRYPT-SHA512' });
  const opts = schemeLabelOptions(ol);
  const label = (id: string) => schemeOptionLabel(ol.schemes.find((s) => s.id === id)!, ol.serverType, 'SSHA', opts);
  assert.equal(label('CRYPT-SHA512'), '{CRYPT-SHA512} (policy)');
  assert.equal(label('SSHA'), '{SSHA}', 'no "(default)" next to the policy choice');
  const ds = ctx({ serverType: '389ds', tls: false, tlsMode: 'none' }, { policy: 'server', serverHashes: true, serverType: '389ds' });
  const dsOpts = schemeLabelOptions(ds);
  assert.equal(schemeOptionLabel(ds.schemes.find((s) => s.id === 'CLEARTEXT')!, '389ds', 'SSHA', dsOpts), 'Cleartext – the server hashes it (policy)');
  assert.equal(schemeOptionLabel(ds.schemes.find((s) => s.id === 'SSHA')!, '389ds', 'SSHA', dsOpts), '{SSHA}');
  // no policy choice (ask): the default keeps its marker
  const ask = ctx({}, { policy: 'ask' });
  assert.equal(schemeOptionLabel(ask.schemes[0], 'openldap', 'SSHA', schemeLabelOptions(ask)), '{SSHA} (default)');
  // method list
  const server = ctx({}, { policy: 'server' });
  const exop = availableMethods(server, false).find((m) => m.method === 'exop')!;
  assert.match(methodOptionLabel(server, exop), /\(policy\)$/);
});

test('must change follows the effective policy; disabled accounts get unlock / enable options', () => {
  assert.equal(defaultAccountFlags(ctx({ accountPolicy: POLICY })).mustChange, true, 'OpenLDAP pwdMustChange TRUE');
  assert.equal(defaultAccountFlags(ctx({ accountPolicy: { ...POLICY, mustChangeEnforced: false } })).mustChange, false);
  assert.equal(defaultAccountFlags(ctx({})).mustChange, false, 'unknown policy');
  const ad = ctx({ serverType: 'ad', isADAccount: true, objectClasses: ['user'] });
  assert.equal(defaultAccountFlags(ad).mustChange, true);
  assert.equal(defaultAccountFlags(ad).enable, false);
  // OpenLDAP disabled: the unlock option re-enables
  const olDisabled = accountOptions(ctx({ disabled: true }));
  assert.equal(olDisabled.unlock.label, 'Unlock / re-enable the account');
  assert.equal(olDisabled.enable.available, false);
  assert.equal(defaultAccountFlags(ctx({ disabled: true })).unlock, false, 're-enabling is a decision');
  // AD / 389DS disabled: an "Enable the account" box
  assert.equal(accountOptions({ ...ad, disabled: true }).enable.label, 'Enable the account');
  assert.equal(accountOptions(ctx({ serverType: '389ds', disabled: true })).enable.available, true);
  assert.equal(accountOptions(ad).enable.available, false, 'enabled account');
});

test('result toast names the account and says when it stays disabled', () => {
  const res: PasswordChangeResult = {
    method: 'userPassword', scheme: 'CRYPT-SHA512', storedScheme: 'CRYPT-SHA512', storedSchemeLabel: '{CRYPT} SHA-512-crypt ($6$)',
    operations: ['replace userPassword', 'account kept disabled (permanent ppolicy lock set again after the reset)'], warnings: [],
    verified: false, verifyError: '', ineffective: false, unconfirmed: false, mustChangeIgnored: false,
  };
  assert.equal(resultSummary(res, 'ux-p-user3'), 'Password reset for ux-p-user3 (stored as {CRYPT} SHA-512-crypt ($6$), account stays disabled)');
  assert.equal(resultSummary({ ...res, operations: ['replace unicodePwd', 'replace pwdLastSet=0', 'account enabled'], storedScheme: '' }, 'u1'),
    'Password reset for u1 (must change at next logon, account enabled)');
  assert.equal(resultSummary({ ...res, operations: [], storedScheme: '' }), 'Password reset');
});

test('strength meter flags common passwords, season + year and name parts; shows policy requirements', () => {
  for (const pw of ['Password1!', 'P@ssw0rd2026', 'Summer2026!', 'Oktober24!', 'Welcome123', 'Qwertz123!']) {
    const a = assessPassword(pw);
    assert.equal(a.level, 1, pw);
    assert.ok(a.problems.length > 0, pw);
  }
  assert.deepEqual(assessPassword('Summer2026!').problems, ['Season or month plus a year']);
  const named = assessPassword('Mertens#Lab42', { names: ['adm.mertens', 'Klaus Mertens'] });
  assert.ok(named.problems.includes('Contains part of the account name'));
  const strong = assessPassword('t7#Vq9!mZr2$Lp4w');
  assert.deepEqual(strong.problems, []);
  assert.equal(strong.label, 'Strong');
  // AD domain policy: min length, complexity (3 of 4 classes, no name parts), history
  const policy = { minPasswordLength: 7, passwordHistory: 24, complexityKnown: true, complexityEnabled: true, source: 'domain' };
  const req = assessPassword('abcdefgh', { names: ['jdoe'], policy }).requirements;
  assert.deepEqual(req.map((r) => [r.label, r.met]), [
    ['At least 7 characters', true],
    ['3 of 4 character classes (A-Z, a-z, 0-9, symbols)', false],
    ['No part of the account name', true],
    ['Not one of the last 24 passwords (checked by the server)', null],
  ]);
  assert.equal(assessPassword('Xq7#mZ', { policy: { minPasswordLength: 12 } }).label, 'Too weak for the policy');
  assert.deepEqual(accountNameTokens(['Schmidt, Anna', 'a.s']), ['schmidt', 'anna']);
});

const report = (r: Partial<PasswordWriteReport>): PasswordWriteReport => ({
  actions: [], warnings: [], storedSchemes: [], cleartext: false, ineffective: false, unconfirmed: false, exop: false, ...r,
});

test('password toast headline carries the reason; never echoes an unknown tag', () => {
  const tagged = report({
    storedSchemes: ['{SSHA}'],
    warnings: ['userPassword: 1 value starts with a {...} prefix but is not a hash of a known storage scheme: it is treated as a cleartext password (the whole value, prefix included).'],
  });
  assert.equal(reportHeadline(tagged), 'Unknown {…} prefix treated as cleartext → stored as {SSHA}');
  assert.ok(!reportHeadline(tagged).includes('Summer'));
  const ineffective = report({
    ineffective: true, storedSchemes: ['{SSHA}'],
    warnings: ['The server stored {SSHA} instead of the {SSHA512} salted SHA-512 value that was sent: it does not support the scheme and hashed the hash string as if it were a cleartext password, so the new password will NOT work. Choose a scheme the server supports or server-side hashing.'],
  });
  assert.equal(reportHeadline(ineffective), 'The new password will not work: {SSHA512} salted SHA-512 was sent, the server stored {SSHA}');
  const ad = report({ cleartext: true, storedSchemes: ['cleartext'], warnings: ['Active Directory stored userPassword in cleartext as an ordinary attribute: …'] });
  assert.match(reportHeadline(ad), /^Active Directory stored userPassword in cleartext/);
  assert.deepEqual(passwordToastActions(ad), ['remove', 'reset', 'open']);
  assert.deepEqual(passwordToastActions(ineffective), ['reset', 'remove', 'open']);
  assert.deepEqual(passwordToastActions(report({ actions: ['stored as {SSHA}'], storedSchemes: ['{SSHA}'] })), []);
});

test('a write that re-locked a disabled OpenLDAP account says "account stays disabled" (inline edit, Edit Entry)', () => {
  const note = 'account kept disabled: permanent ppolicy lock (pwdAccountLockedTime) set again after the password change';
  const kept = report({ actions: ['userPassword: 1 value hashed on the client with {CRYPT} SHA-512-crypt ($6$)', note], storedSchemes: ['{CRYPT} SHA-512-crypt ($6$)'] });
  assert.equal(reportKeptDisabled(kept), true);
  assert.equal(reportSuccessDetail(kept), 'userPassword stored as {CRYPT} SHA-512-crypt ($6$), account stays disabled');
  const onlyNote = report({ actions: [note] });
  assert.equal(reportSummary(onlyNote), '', 'the long re-lock note is not the summary');
  assert.equal(reportSuccessDetail(onlyNote), 'account stays disabled');
  assert.equal(reportKeptDisabled(report({ actions: ['stored as {SSHA}'] })), false);
  assert.equal(reportSuccessDetail(null), '');
});
