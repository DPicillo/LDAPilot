// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isHashedPasswordValue, isPasswordWriteAttribute, isUserPasswordAttribute, normalizePolicySetting, passwordSchemeBadge,
  passwordTag, planNeedsPrompt, defaultClientScheme, policyNotices, reportOutcome, reportSummary, targetHasPasswordValues, describePolicyDefault,
  classifyPasswordValue, bulkPasswordOutcome, reportTitle, schemeSupportSummary, AS_IS_NOTICE, PASSWORD_MASK,
  typedStoredValue, passThroughResetNote, KEPT_VALUES_NOTE,
} from '../src/lib/passwordPolicy.ts';
import {
  defaultSelection, deviatesFromPolicy, methodDescription, policyLine, policySelection, selectionNotices, sendsCleartext,
} from '../src/lib/passwordMethod.ts';
import type { EffectivePasswordPolicy, PasswordWritePlan, PasswordWriteReport } from '../src/types/passwordPolicy.ts';
import type { PasswordContext } from '../src/types/password.ts';

const SSHA = '{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=';

test('scheme prefix detection mirrors Go IsHashedPasswordValue', () => {
  const hashed = [
    SSHA, '{ssha}W6ph5Mm5Pz8GgiULbPgzG37mj9g=', '{SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g', '{CRYPT}$6$salt$hash', '{crypt}$2b$10$abc',
    '{CRYPT}$2y$12$x', '{CRYPT}abJnggxhB/yWI', '{CRYPT}_J9..rasmBYk8r9AiWNc', '{CRYPT}!$6$salt$hash', '{CRYPT}*',
    '{CRYPT-SHA512}$6$salt$hash', '{PBKDF2-SHA512}100000$a$b', '{PBKDF2_SHA256}AAAnEA==', '{ARGON2}$argon2id$v=19',
    '{SASL}user@EXAMPLE.ORG', '{GOST_YESCRYPT}$gy$j9T$salt$hash', '{K5KEY}x',
  ];
  for (const v of hashed) assert.equal(isHashedPasswordValue(v), true, v);
  const clear = [
    'secret', '', 'Grüße!', '{}secret', '{my secret}x', '{SSHA}', ' {SSHA}abc', `{${'A'.repeat(33)}}x`, '{SSHA', '{ü}x',
    // explicit cleartext tags, unknown tags (a typed password), malformed values of known schemes
    '{CLEARTEXT}secret', '{CLEAR}secret', '{plain}secret', '{Summer}2026!', '{a}bcdefgh', '{ssha}garbage', '{SSHA}YWJj',
    '{CRYPT}hunter2', '{CRYPT}$6',
  ];
  for (const v of clear) assert.equal(isHashedPasswordValue(v), false, v);
  assert.deepEqual(passwordTag('{crypt}$6$x'), { tag: 'crypt', rest: '$6$x' });
  assert.equal(classifyPasswordValue('{CLEAR}x').kind, 'cleartextTag');
  assert.equal(classifyPasswordValue('{Summer}2026!').kind, 'unknownTag');
  assert.equal(classifyPasswordValue('{ssha}garbage').kind, 'malformed');
  assert.equal(classifyPasswordValue('{hasOwnProperty}x').kind, 'unknownTag');
});

test('scheme badges', () => {
  assert.deepEqual(passwordSchemeBadge(SSHA)?.text, '{SSHA}');
  assert.equal(passwordSchemeBadge('{CRYPT}$6$salt$hash')?.text, '{CRYPT}$6$');
  assert.equal(passwordSchemeBadge('{crypt}$5$salt$hash')?.text, '{CRYPT}$5$');
  assert.equal(passwordSchemeBadge('{CRYPT}$2b$10$abc')?.text, '{CRYPT}$2b$');
  assert.equal(passwordSchemeBadge('{CRYPT}$2b$10$abc')?.title, '{CRYPT} bcrypt');
  assert.equal(passwordSchemeBadge('{CRYPT}abJnggxhB/yWI')?.text, '{CRYPT}');
  assert.equal(passwordSchemeBadge('{PBKDF2-SHA512}1$a$b')?.text, '{PBKDF2-SHA512}');
  const clear = passwordSchemeBadge('secret');
  assert.equal(clear?.text, 'cleartext');
  assert.equal(clear?.cleartext, true);
  assert.ok(!clear?.title.includes('secret'));
  assert.equal(passwordSchemeBadge(''), null);
  // binary values are base64 of the raw bytes
  assert.equal(passwordSchemeBadge(btoa(SSHA), true)?.text, '{SSHA}');
  assert.equal(passwordSchemeBadge(btoa('s\xe9cret'), true)?.cleartext, true);
  // not hashes: red, and an unknown tag is never shown (it may be part of the password)
  assert.deepEqual([passwordSchemeBadge('{CLEARTEXT}x')?.text, passwordSchemeBadge('{CLEARTEXT}x')?.cleartext], ['cleartext', true]);
  const unknown = passwordSchemeBadge('{Summer}2026!');
  assert.equal(unknown?.text, 'unknown scheme');
  assert.equal(unknown?.cleartext, true);
  assert.ok(!JSON.stringify(unknown).toLowerCase().includes('summer'));
  assert.deepEqual([passwordSchemeBadge('{ssha}garbage')?.text, passwordSchemeBadge('{ssha}garbage')?.cleartext], ['invalid {SSHA}', true]);
  // masks have a fixed width
  assert.equal(PASSWORD_MASK.length, 8);
});

test('attribute names', () => {
  assert.equal(isUserPasswordAttribute('userPassword'), true);
  assert.equal(isUserPasswordAttribute('USERPASSWORD;x-opt'), true);
  assert.equal(isUserPasswordAttribute('userPasswordHint'), false);
  assert.equal(isPasswordWriteAttribute('unicodePwd'), true);
  assert.equal(isPasswordWriteAttribute('sambaNTPassword'), false);
  // by OID
  assert.equal(isUserPasswordAttribute('2.5.4.35'), true);
  assert.equal(isUserPasswordAttribute('2.5.4.35;binary'), true);
  assert.equal(isUserPasswordAttribute('2.5.4.3'), false);
  assert.equal(isPasswordWriteAttribute('1.2.840.113556.1.4.90'), true);
});

test('pre-write check: which writes need a plan', () => {
  assert.equal(targetHasPasswordValues({ attributes: [{ name: 'cn', values: ['x'], binary: false }] }), false);
  assert.equal(targetHasPasswordValues({ attributes: [{ name: 'userPassword', values: ['x'], binary: false }] }), true);
  assert.equal(targetHasPasswordValues({ attributes: [{ name: 'userPassword', values: [], binary: false }] }), false);
  assert.equal(targetHasPasswordValues({ changes: [{ operation: 'delete', attribute: 'userPassword', values: [] }] }), false);
  assert.equal(targetHasPasswordValues({ changes: [{ operation: 'delete', attribute: 'userPassword', values: ['old'] }] }), true);
  assert.equal(targetHasPasswordValues({ changes: [{ operation: 'replace', attribute: 'unicodePwd', values: ['x'] }] }), true);
  assert.equal(targetHasPasswordValues({ ldif: 'dn: cn=x\nuserPassword: secret\n' }), true);
  assert.equal(targetHasPasswordValues({ ldif: 'dn: cn=x\nuserpassword:: c2VjcmV0\n' }), true);
  assert.equal(targetHasPasswordValues({ ldif: 'dn: cn=x\ndescription: userPassword: x\n' }), false);
  assert.equal(targetHasPasswordValues({ ldif: 'dn: cn=x\n2.5.4.35: secret\n' }), true);
  assert.equal(targetHasPasswordValues({ ldif: 'dn: cn=x\n1.2.840.113556.1.4.90:: IgB4ACIA\n' }), true);
  assert.equal(targetHasPasswordValues({ changes: [{ operation: 'replace', attribute: '2.5.4.35', values: ['x'] }] }), true);
});

function plan(p: Partial<PasswordWritePlan>): PasswordWritePlan {
  return {
    policy: {} as EffectivePasswordPolicy, hasPasswords: true, values: 1, hashed: 0, kept: 0, cleartext: 1, exop: false, asIs: false,
    cleartextSent: true, unencrypted: true, needsConfirm: false, needsDecision: false, actions: [], warnings: [], ...p,
  };
}

test('prompt only for confirmation or decision', () => {
  assert.equal(planNeedsPrompt(null), false);
  assert.equal(planNeedsPrompt(plan({})), false);
  assert.equal(planNeedsPrompt(plan({ needsConfirm: true })), true);
  assert.equal(planNeedsPrompt(plan({ needsDecision: true })), true);
  assert.equal(planNeedsPrompt(plan({ needsDecision: true, hasPasswords: false })), false);
});

function eff(p: Partial<EffectivePasswordPolicy>): EffectivePasswordPolicy {
  return {
    configured: 'auto', policy: 'client', scheme: 'CRYPT-SHA512', schemeLabel: '{CRYPT} SHA-512-crypt ($6$)', source: 'default', reason: '',
    serverType: 'openldap', serverHashes: false, serverHashing: '', passwordModifyExop: true, tls: true, summary: 'summary', warnings: [], ...p,
  };
}

test('policy notices', () => {
  assert.deepEqual(policyNotices(eff({})).map((n) => n.level), ['info']);
  const plainClient = policyNotices(eff({ tls: false }));
  assert.equal(plainClient.length, 2);
  assert.equal(plainClient[1].level, 'info');
  const plainServer = policyNotices(eff({ tls: false, policy: 'server' }));
  assert.equal(plainServer[1].level, 'warning');
  assert.equal(policyNotices(eff({ policy: 'ad' }))[0].level, 'warning');
  assert.equal(policyNotices(eff({ warnings: ['x'] })).length, 2);
  // LDIF "store exactly as in the file": the policy does not apply
  const asIs = policyNotices(eff({ tls: false }), { asIs: true });
  assert.equal(asIs[0].text, AS_IS_NOTICE);
  assert.ok(asIs.every((n) => n.level === 'warning' && !n.text.includes('hashed on the client')));
  assert.equal(asIs.length, 2);
});

test('the policy hint says that {SCHEME} values are stored as typed', () => {
  for (const policy of ['client', 'server', 'ask'] as const) {
    const [first] = policyNotices(eff({ policy }));
    assert.equal(first.text, `summary ${KEPT_VALUES_NOTE}`, policy);
  }
  assert.match(KEPT_VALUES_NOTE, /\{SASL\}/);
  // AD passes every value through; "store exactly as in the file" has its own text
  assert.equal(policyNotices(eff({ policy: 'ad' }))[0].text, 'summary');
  assert.ok(policyNotices(eff({}), { asIs: true }).every((n) => !n.text.includes(KEPT_VALUES_NOTE)));
});

// SASL pass-through authentication (issue #1): "{SASL}user" is no password
// but the name OpenLDAP hands to saslauthd; it must reach the server as typed.
test('{SASL} pass-through references are kept and named', () => {
  for (const v of ['{SASL}username', '{SASL}user@EXAMPLE.ORG', '{sasl}username']) {
    assert.equal(isHashedPasswordValue(v), true, v);
    const badge = passwordSchemeBadge(v);
    assert.deepEqual([badge?.text, badge?.cleartext], ['{SASL}', false], v);
    assert.match(badge!.title, /pass-through/i, v);
    assert.ok(!/username|EXAMPLE/.test(badge!.title), v);
  }
  // other schemes keep their tooltip
  assert.equal(passwordSchemeBadge(SSHA)?.title, 'Stored with the {SSHA} scheme');
});

test('a stored value typed as a new password is recognised', () => {
  const sasl = typedStoredValue('{SASL}username');
  assert.deepEqual([sasl?.scheme, sasl?.passThrough], ['SASL', true]);
  assert.match(sasl!.title, /\{SASL\} pass-through reference, not a password/);
  assert.ok(!`${sasl!.title} ${sasl!.text}`.includes('username'));
  assert.equal(typedStoredValue('{sasl}user@EXAMPLE.ORG')?.passThrough, true);
  const hash = typedStoredValue(SSHA);
  assert.deepEqual([hash?.scheme, hash?.passThrough], ['SSHA', false]);
  assert.match(hash!.title, /\{SSHA\} value, not a password/);
  assert.ok(!`${hash!.title} ${hash!.text}`.includes('W6ph5'));
  // passwords: anything that is not a plausible value of a known scheme
  for (const v of ['', 'secret', '{Summer}2026!', '{CLEAR}x', '{SSHA}garbage', '{SASL}']) assert.equal(typedStoredValue(v), null, v);
});

test('Reset Password says when it would replace a pass-through reference', () => {
  assert.match(passThroughResetNote('SASL'), /pass-through/);
  assert.match(passThroughResetNote('sasl'), /\{SASL\}/);
  for (const s of ['SSHA', 'CRYPT-SHA512', 'CLEARTEXT', '', undefined]) assert.equal(passThroughResetNote(s), '', String(s));
});

test('report outcome and summary', () => {
  const base: PasswordWriteReport = {
    actions: ['a'], warnings: [], storedSchemes: ['{CRYPT} SHA-512-crypt ($6$)'], cleartext: false, ineffective: false, unconfirmed: false, exop: false,
  };
  assert.equal(reportOutcome(null), 'none');
  assert.equal(reportOutcome(base), 'ok');
  assert.equal(reportOutcome({ ...base, warnings: ['w'] }), 'warning');
  assert.equal(reportOutcome({ ...base, cleartext: true }), 'error');
  assert.equal(reportOutcome({ ...base, ineffective: true }), 'error');
  assert.equal(reportOutcome({ ...base, actions: [], storedSchemes: [] }), 'none');
  assert.equal(reportSummary(base), 'userPassword stored as {CRYPT} SHA-512-crypt ($6$)');
  assert.equal(reportSummary({ ...base, storedSchemes: [], exop: true }), 'Password set with the Password Modify extended operation');
  // a scheme the server may not verify (bcrypt on glibc OpenLDAP)
  assert.equal(reportOutcome({ ...base, unconfirmed: true }), 'warning');
  assert.equal(reportTitle({ ...base, unconfirmed: true }), 'The new password may not work');
  assert.equal(reportTitle({ ...base, ineffective: true }), 'The new password will not work');
  assert.equal(reportTitle({ ...base, cleartext: true, storedSchemes: ['cleartext'] }), 'Password stored in cleartext');
  assert.equal(reportTitle({ ...base, cleartext: true, storedSchemes: ['unknown scheme'] }), 'Password stored without a known scheme');
  assert.equal(reportTitle({ ...base, warnings: ['w'] }), 'Password storage warning');
});

test('bulk results surface password problems', () => {
  assert.equal(bulkPasswordOutcome({ passwordIneffective: 0, passwordCleartext: 0, passwordWarnings: 0 }), null);
  assert.equal(bulkPasswordOutcome({}), null);
  assert.deepEqual(bulkPasswordOutcome({ passwordIneffective: 2, passwordCleartext: 1, passwordWarnings: 0 }),
    { level: 'error', text: '2 new passwords will not work, 1 password stored in cleartext' });
  assert.deepEqual(bulkPasswordOutcome({ passwordWarnings: 1 }), { level: 'warning', text: '1 with password warnings' });
});

test('settings', () => {
  assert.equal(defaultClientScheme('openldap'), 'CRYPT-SHA512');
  assert.equal(defaultClientScheme('389ds'), 'PBKDF2-SHA512');
  assert.equal(defaultClientScheme('other'), 'SSHA');
  assert.equal(normalizePolicySetting('auto'), '');
  assert.equal(normalizePolicySetting(undefined), '');
  assert.equal(normalizePolicySetting('client'), 'client');
  assert.equal(normalizePolicySetting('bogus'), '');
  assert.equal(
    describePolicyDefault({ serverType: 'openldap', policy: 'client', scheme: 'CRYPT-SHA512', reason: '' }, () => '{CRYPT} SHA-512-crypt ($6$)'),
    'OpenLDAP: hash on the client with {CRYPT} SHA-512-crypt ($6$)',
  );
  assert.equal(describePolicyDefault({ serverType: '389ds', policy: 'server', scheme: '', reason: '' }, () => ''), '389 Directory Server: server-side hashing');
  const sha512 = {
    id: 'SSHA512', label: '{SSHA512}', description: '', security: 'good',
    support: [{ server: 'openldap', level: 'module', note: '' }, { server: '389ds', level: 'native', note: '' }, { server: 'ad', level: 'no', note: '' }],
  } as PasswordContext['schemes'][number];
  assert.equal(schemeSupportSummary(sha512), ' - OpenLDAP: needs module');
  assert.equal(schemeSupportSummary({ ...sha512, support: [{ server: 'openldap', level: 'native', note: '' }] }), '');
});

// --- password dialog defaults follow the policy (lib/passwordMethod.ts) ---
function ctx(p: Partial<PasswordContext>, policy?: Partial<EffectivePasswordPolicy>): PasswordContext {
  const schemes = ['SSHA', 'CRYPT-SHA512', 'PBKDF2-SHA512', 'CLEARTEXT'].map((id) => ({
    id, label: id, description: '', security: id === 'CLEARTEXT' ? 'none' : 'good',
    support: [{ server: 'openldap', level: id === 'PBKDF2-SHA512' ? 'module' : 'native', note: '' }, { server: '389ds', level: 'native', note: '' }],
  })) as PasswordContext['schemes'];
  return {
    dn: 'uid=x', serverType: 'openldap', vendorName: '', vendorVersion: '', tls: true, tlsMode: 'starttls', passwordModifyExop: true,
    ppolicyControl: true, objectClasses: ['inetOrgPerson'], isADAccount: false, hasUserPassword: true, currentScheme: 'SSHA',
    currentSchemeLabel: '{SSHA}', locked: false, mustChange: false, disabled: false, passwordNeverExpires: false, readOnly: false,
    schemes, defaultScheme: 'SSHA', policy: policy ? eff(policy) : undefined, ...p,
  };
}

test('password dialog preselects the connection policy', () => {
  // client policy: userPassword with the policy scheme, even with a remembered exop
  const c = ctx({}, { policy: 'client', scheme: 'CRYPT-SHA512' });
  assert.deepEqual(policySelection(c), { method: 'userPassword', scheme: 'CRYPT-SHA512', verifyBind: true });
  assert.equal(defaultSelection(c, { method: 'exop', scheme: 'SSHA', verifyBind: false }).method, 'userPassword');
  // server policy: Password Modify where announced
  assert.equal(policySelection(ctx({}, { policy: 'server' }))?.method, 'exop');
  // 389DS over plain LDAP refuses Password Modify but hashes cleartext userPassword
  const ds = ctx({ serverType: '389ds', tls: false, tlsMode: 'none' }, { policy: 'server', serverHashes: true, serverType: '389ds', tls: false });
  assert.deepEqual(policySelection(ds), { method: 'userPassword', scheme: 'CLEARTEXT', verifyBind: false });
  assert.equal(policySelection(ctx({ passwordModifyExop: false }, { policy: 'server' }))?.scheme, 'CLEARTEXT');
  // ask and AD: no policy selection; the remembered choice / unicodePwd decide
  assert.equal(policySelection(ctx({}, { policy: 'ask' })), null);
  assert.equal(defaultSelection(ctx({}, { policy: 'ask' }), { method: 'userPassword', scheme: 'SSHA', verifyBind: false }).scheme, 'SSHA');
  const ad = ctx({ serverType: 'ad', isADAccount: true }, { policy: 'ad', serverType: 'ad' });
  assert.equal(policySelection(ad), null);
  assert.equal(defaultSelection(ad, null).method, 'unicodePwd');
  // deviation note
  assert.equal(deviatesFromPolicy(c, { method: 'userPassword', scheme: 'SSHA', verifyBind: false }), true);
  assert.equal(deviatesFromPolicy(c, { method: 'userPassword', scheme: 'CRYPT-SHA512', verifyBind: false }), false);
  // 389DS over plain LDAP: the cleartext selection is presented as server-side hashing, not as a cleartext risk
  const dsSel = policySelection(ds)!;
  assert.ok(policyLine(ds).includes('server-side hashing') && policyLine(ds).includes('which the server hashes'));
  assert.ok(methodDescription(ds, dsSel).includes('the server hashes it'));
  const dsNotices = selectionNotices(ds, dsSel);
  assert.ok(!dsNotices.some((n) => n.text.startsWith('Cleartext: the server stores the password as is')));
  assert.ok(!dsNotices.some((n) => n.text.includes('refuse')));
  // a server that is not known to hash keeps the cleartext warning
  const ol = ctx({ passwordModifyExop: false }, { policy: 'server' });
  assert.ok(selectionNotices(ol, policySelection(ol)!).some((n) => n.level === 'warning' && n.text.startsWith('Cleartext:')));
});

test('password dialog: what sends the cleartext password', () => {
  assert.equal(sendsCleartext({ method: 'exop', scheme: 'SSHA', verifyBind: false }), true);
  assert.equal(sendsCleartext({ method: 'unicodePwd', scheme: 'SSHA', verifyBind: false }), true);
  assert.equal(sendsCleartext({ method: 'userPassword', scheme: 'CLEARTEXT', verifyBind: false }), true);
  assert.equal(sendsCleartext({ method: 'userPassword', scheme: 'CRYPT-SHA512', verifyBind: false }), false);
  assert.equal(sendsCleartext({ method: 'userPassword', scheme: 'CRYPT-SHA512', verifyBind: true }), true);
});
