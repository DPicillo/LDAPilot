// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeChange, objectClassChanges, buildEntryChanges, buildCopyAttributes, sameValues, valuesWithUpload, findAttributeKey,
  suggestSAMAccountName, splitFirstRDN, parseRDN, escapeDNValue, planEntryCopy, copyTargetDN,
  blockingValidationErrors, requiredButNotLoaded, describeChange, isSensitiveAttributeName, copySecretAttributes,
  copyLoginFields, suggestUid,
} from '../src/lib/entryChanges.ts';

test('attributeChange picks add / replace / delete and skips unchanged', () => {
  assert.equal(attributeChange('mail', ['a'], ['a']), null);
  assert.equal(attributeChange('mail', ['a', 'b'], ['b', 'a']), null);
  assert.deepEqual(attributeChange('mail', [], ['a']), { operation: 'add', attribute: 'mail', values: ['a'], binary: false });
  assert.deepEqual(attributeChange('mail', ['a'], ['b']), { operation: 'replace', attribute: 'mail', values: ['b'], binary: false });
  assert.deepEqual(attributeChange('mail', ['a'], []), { operation: 'delete', attribute: 'mail', values: [], binary: false });
  assert.equal(attributeChange('mail', [], []), null);
  // jpegPhoto: never value-level add/delete on an existing attribute (OpenLDAP has no equality rule)
  assert.deepEqual(attributeChange('jpegPhoto', ['QQ=='], ['QQ==', 'Qg=='], true), { operation: 'replace', attribute: 'jpegPhoto', values: ['QQ==', 'Qg=='], binary: true });
  assert.deepEqual(attributeChange('jpegPhoto', ['QQ==', 'Qg=='], ['Qg=='], true), { operation: 'replace', attribute: 'jpegPhoto', values: ['Qg=='], binary: true });
  assert.deepEqual(attributeChange('unicodePwd', [], ['pw']), { operation: 'replace', attribute: 'unicodePwd', values: ['pw'], binary: false });
  assert.equal(sameValues(['a', 'a'], ['a', 'b']), false);
});

test('objectClassChanges is value-level and case-insensitive', () => {
  const r = objectClassChanges(['top', 'person', 'inetOrgPerson'], ['top', 'Person', 'inetOrgPerson', 'posixAccount']);
  assert.deepEqual(r.add, { operation: 'add', attribute: 'objectClass', values: ['posixAccount'], binary: false });
  assert.equal(r.remove, null);
  const d = objectClassChanges(['top', 'inetOrgPerson', 'shadowAccount'], ['top', 'inetOrgPerson']);
  assert.equal(d.add, null);
  assert.deepEqual(d.remove?.values, ['shadowAccount']);
});

test('buildEntryChanges: auxiliary class with required attributes in one ordered list', () => {
  const photo = 'AQID';
  const changes = buildEntryChanges({
    originalObjectClasses: ['top', 'inetOrgPerson', 'shadowAccount'],
    objectClasses: ['top', 'inetOrgPerson', 'posixAccount'],
    originalAttrs: new Map([
      ['cn', ['John']],
      ['description', ['old']],
      ['jpegPhoto', [photo]],
      ['userCertificate;binary', ['MAo=']],
      ['shadowExpire', ['1']],
    ]),
    workingAttrs: new Map([
      ['cn', ['John']],
      ['description', ['new']],
      ['jpegPhoto', [photo]],
      ['userCertificate;binary', []],
      ['uidNumber', ['10001']],
      ['gidNumber', ['10001']],
      ['homeDirectory', ['/home/john']],
    ]),
    binaryAttrs: new Set(['jpegphoto', 'usercertificate;binary']),
  });
  assert.deepEqual(changes.map((c) => `${c.operation} ${c.attribute}${c.binary ? ' (binary)' : ''} [${c.values.join('|')}]`), [
    'add objectClass [posixAccount]',
    'replace description [new]',
    'delete userCertificate;binary (binary) []',
    'delete shadowExpire []',
    'add uidNumber [10001]',
    'add gidNumber [10001]',
    'add homeDirectory [/home/john]',
    'delete objectClass [shadowAccount]',
  ]);
  // The unchanged photo is not sent at all.
  assert.ok(!changes.some((c) => c.attribute === 'jpegPhoto'));
});

test('buildEntryChanges matches attribute names case-insensitively', () => {
  const changes = buildEntryChanges({
    originalObjectClasses: ['top'],
    objectClasses: ['top'],
    originalAttrs: new Map([['mail', ['a@x']]]),
    workingAttrs: new Map([['Mail', ['a@x']]]),
    binaryAttrs: new Set(),
  });
  assert.deepEqual(changes, []);
});

test('buildEntryChanges sends uploaded binary values with binary: true', () => {
  const changes = buildEntryChanges({
    originalObjectClasses: ['top'],
    objectClasses: ['top'],
    originalAttrs: new Map(),
    workingAttrs: new Map([['thumbnailPhoto', ['/9j/']]]),
    binaryAttrs: new Set(['thumbnailphoto']),
  });
  assert.deepEqual(changes, [{ operation: 'add', attribute: 'thumbnailPhoto', values: ['/9j/'], binary: true }]);
});

test('buildCopyAttributes keeps binary values and drops operational attributes', () => {
  const attrs = buildCopyAttributes([
    { name: 'objectClass', values: ['top', 'inetOrgPerson'], binary: false },
    { name: 'cn', values: ['John', 'Johnny'], binary: false },
    { name: 'jpegPhoto', values: ['/9j/4A=='], binary: true },
    { name: 'userCertificate;binary', values: ['MAo='], binary: true },
    { name: 'entryUUID', values: ['x'], binary: false },
    { name: 'nTSecurityDescriptor', values: ['AQA='], binary: true },
    { name: 'modifyTimestamp', values: ['20240101000000Z'], binary: false },
  ], 'cn', 'Copy of John');
  assert.deepEqual(attrs, [
    { name: 'objectClass', values: ['top', 'inetOrgPerson'], binary: false },
    { name: 'cn', values: ['Copy of John'], binary: false },
    { name: 'jpegPhoto', values: ['/9j/4A=='], binary: true },
    { name: 'userCertificate;binary', values: ['MAo='], binary: true },
  ]);
  const withRdn = buildCopyAttributes([{ name: 'objectClass', values: ['organizationalUnit'], binary: false }], 'ou', 'Copy');
  assert.deepEqual(withRdn[1], { name: 'ou', values: ['Copy'], binary: false });
});

test('valuesWithUpload adds or replaces one value', () => {
  assert.deepEqual(valuesWithUpload(['a', 'b'], { type: 'add' }, 'c'), ['a', 'b', 'c']);
  assert.deepEqual(valuesWithUpload(['a', 'b'], { type: 'replace', index: 1 }, 'c'), ['a', 'c']);
  assert.deepEqual(valuesWithUpload([], { type: 'replace', index: 0 }, 'c'), ['c']);
  // replacing value 1 of a photo attribute re-sends value 0 in one replace
  assert.deepEqual(attributeChange('jpegPhoto', ['a', 'b'], valuesWithUpload(['a', 'b'], { type: 'replace', index: 1 }, 'c'), true),
    { operation: 'replace', attribute: 'jpegPhoto', values: ['a', 'c'], binary: true });
});

test('findAttributeKey matches exact, case-insensitive and option variants', () => {
  const keys = ['cn', 'Mail', 'userCertificate;binary'];
  assert.equal(findAttributeKey(keys, 'cn'), 'cn');
  assert.equal(findAttributeKey(keys, 'mail'), 'Mail');
  assert.equal(findAttributeKey(keys, 'userCertificate'), 'userCertificate;binary');
  assert.equal(findAttributeKey(['userCertificate'], 'usercertificate;binary'), 'userCertificate');
  assert.equal(findAttributeKey(keys, 'sn'), undefined);
});

test('buildCopyAttributes gives AD account copies a new sAMAccountName/UPN and disables them', () => {
  const source = [
    { name: 'objectClass', values: ['top', 'person', 'organizationalPerson', 'user'], binary: false },
    { name: 'cn', values: ['tb-user'], binary: false },
    { name: 'sAMAccountName', values: ['tb-user'], binary: false },
    { name: 'userPrincipalName', values: ['tb-user@ad.example.org'], binary: false },
    { name: 'userAccountControl', values: ['512'], binary: false },
    { name: 'pwdLastSet', values: ['133000000000000000'], binary: false },
    { name: 'mS-DS-ConsistencyGuid', values: ['AAAA'], binary: true },
    { name: 'msExchMailboxGuid', values: ['{0000}'], binary: false },
    { name: 'thumbnailPhoto', values: ['/9j/'], binary: true },
  ];
  assert.deepEqual(buildCopyAttributes(source, 'CN', 'tb-copy', { sAMAccountName: 'tb-copy' }), [
    { name: 'objectClass', values: ['top', 'person', 'organizationalPerson', 'user'], binary: false },
    { name: 'cn', values: ['tb-copy'], binary: false },
    { name: 'sAMAccountName', values: ['tb-copy'], binary: false },
    { name: 'userPrincipalName', values: ['tb-copy@ad.example.org'], binary: false },
    { name: 'userAccountControl', values: ['514'], binary: false },
    { name: 'thumbnailPhoto', values: ['/9j/'], binary: true },
  ]);
  // without a new name, the colliding names are left out
  const names = buildCopyAttributes(source, 'CN', 'tb-copy').map((a) => a.name);
  assert.ok(!names.includes('sAMAccountName') && !names.includes('userPrincipalName'));
});

test('buildCopyAttributes never copies passwords (disabled OpenLDAP / 389DS accounts must not become live copies)', () => {
  const source = [
    { name: 'objectClass', values: ['inetOrgPerson', 'posixAccount'], binary: false },
    { name: 'uid', values: ['leaver'], binary: false },
    { name: 'cn', values: ['Leaver'], binary: false },
    { name: 'userPassword', values: ['{SSHA}abc'], binary: false },
    { name: 'authPassword', values: ['SHA256$x$y'], binary: false },
    { name: 'sambaNTPassword', values: ['0123'], binary: false },
    { name: 'pwdAccountLockedTime', values: ['000001010000Z'], binary: false },
    { name: 'nsRoleDN', values: ['cn=nsDisabledRole,dc=x'], binary: false },
    { name: 'pwdPolicySubentry', values: ['cn=policy,dc=x'], binary: false },
  ];
  const names = buildCopyAttributes(source, 'uid', 'newbie').map((a) => a.name);
  assert.deepEqual(names, ['objectClass', 'uid', 'cn', 'pwdPolicySubentry']);
  assert.deepEqual(copySecretAttributes(source), ['userPassword', 'authPassword', 'sambaNTPassword']);
});

test('suggestSAMAccountName strips invalid characters and limits the length', () => {
  assert.equal(suggestSAMAccountName('Copy of John Doe'), 'Copy.of.John.Doe');
  assert.equal(suggestSAMAccountName('Doe, John [Admin]'), 'Doe.John.Admin');
  assert.equal(suggestSAMAccountName('a very long name that exceeds twenty'), 'a.very.long.name.tha');
  assert.equal(suggestSAMAccountName('ends with dot after cut.'), 'ends.with.dot.after');
});

test('splitFirstRDN / parseRDN / escapeDNValue handle escaped DN characters', () => {
  assert.deepEqual(splitFirstRDN('CN=Schmidt\\, Anna,OU=Users,DC=ad'), { rdn: 'CN=Schmidt\\, Anna', parent: 'OU=Users,DC=ad' });
  assert.deepEqual(splitFirstRDN('dc=local'), { rdn: 'dc=local', parent: '' });
  assert.deepEqual(parseRDN('CN=Schmidt\\, Anna'), { attr: 'CN', value: 'Schmidt, Anna' });
  assert.deepEqual(parseRDN('cn=J\\C3\\BCrgen'), { attr: 'cn', value: 'Jürgen' });
  assert.deepEqual(parseRDN('cn=a\\=b'), { attr: 'cn', value: 'a=b' });
  assert.equal(escapeDNValue('Copy of Schmidt, Anna'), 'Copy of Schmidt\\, Anna');
  assert.equal(escapeDNValue('#1 <x> "q" a+b;c\\d '), '\\#1 \\<x\\> \\"q\\" a\\+b\\;c\\\\d\\ ');
  assert.equal(escapeDNValue(' lead'), '\\ lead');
  assert.equal(escapeDNValue('Zoë 日本'), 'Zoë 日本');
  // round trip
  for (const v of ['Schmidt, Anna', '#Hash User', 'Quote "Q" User', 'Semi;Colon <Angle>', 'Back\\Slash', 'C++ Developer']) {
    assert.equal(parseRDN('cn=' + escapeDNValue(v)).value, v);
  }
});

test('planEntryCopy escapes the new RDN value and keeps the parent', () => {
  const plan = planEntryCopy('CN=Doe\\, Jane,OU=Track,DC=ad', [
    { name: 'cn', values: ['Doe, Jane'], binary: false },
    { name: 'sAMAccountName', values: ['doej'], binary: false },
  ], ' Copy of Doe, Jane ', { sAMAccountName: 'Copy.of.Doe.Jane' });
  assert.equal(plan.dn, 'CN=Copy of Doe\\, Jane,OU=Track,DC=ad');
  assert.deepEqual(plan.attributes, [
    { name: 'cn', values: ['Copy of Doe, Jane'], binary: false },
    { name: 'sAMAccountName', values: ['Copy.of.Doe.Jane'], binary: false },
  ]);
  assert.equal(copyTargetDN('ou=Top', 'New'), 'ou=New');
});

test('planEntryCopy of an AD computer / service account leaves out SPNs and other per-account attributes', () => {
  const source = [
    { name: 'objectClass', values: ['top', 'person', 'organizationalPerson', 'user', 'computer'], binary: false },
    { name: 'cn', values: ['WS01'], binary: false },
    { name: 'sAMAccountName', values: ['WS01$'], binary: false },
    { name: 'userAccountControl', values: ['4096'], binary: false },
    { name: 'dNSHostName', values: ['ws01.ad.example.org'], binary: false },
    { name: 'servicePrincipalName', values: ['HOST/ws01.ad.example.org', 'HOST/WS01', 'MSSQLSvc/ws01.ad.example.org:1433'], binary: false },
    { name: 'msDS-AdditionalDnsHostName', values: ['alias.ad.example.org'], binary: false },
    { name: 'msDS-AdditionalSamAccountName', values: ['ALIAS$'], binary: false },
    { name: 'altSecurityIdentities', values: ['X509:<I>CN=CA<S>CN=WS01'], binary: false },
    { name: 'msDS-KeyCredentialLink', values: ['B:828:0002…:CN=WS01,OU=x'], binary: false },
    { name: 'operatingSystem', values: ['Windows Server 2025'], binary: false },
  ];
  const plan = planEntryCopy('CN=WS01,OU=Track,DC=ad', source, 'WS02', { sAMAccountName: suggestSAMAccountName('WS02', true) });
  assert.equal(plan.dn, 'CN=WS02,OU=Track,DC=ad');
  assert.deepEqual(plan.attributes, [
    { name: 'objectClass', values: ['top', 'person', 'organizationalPerson', 'user', 'computer'], binary: false },
    { name: 'cn', values: ['WS02'], binary: false },
    { name: 'sAMAccountName', values: ['WS02$'], binary: false },
    { name: 'userAccountControl', values: ['4098'], binary: false },
    { name: 'operatingSystem', values: ['Windows Server 2025'], binary: false },
  ]);
  // a computer name typed without "$" gets it
  const typed = buildCopyAttributes(source, 'cn', 'WS03', { sAMAccountName: 'WS03' });
  assert.deepEqual(typed.find((a) => a.name === 'sAMAccountName')?.values, ['WS03$']);
  // a user (no "$") keeps the name as typed
  const user = buildCopyAttributes([{ name: 'sAMAccountName', values: ['svc-sql'], binary: false },
    { name: 'servicePrincipalName', values: ['MSSQLSvc/db.ad.example.org'], binary: false }], 'cn', 'svc-sql2', { sAMAccountName: 'svc-sql2' });
  assert.deepEqual(user, [
    { name: 'sAMAccountName', values: ['svc-sql2'], binary: false },
    { name: 'cn', values: ['svc-sql2'], binary: false },
  ]);
});

test('suggestSAMAccountName for computer accounts: 15 characters plus "$"', () => {
  assert.equal(suggestSAMAccountName('Copy of WS01', true), 'Copy-of-WS01$');
  assert.equal(suggestSAMAccountName('a-very-long-computer-name', true), 'a-very-long-com$');
  assert.equal(suggestSAMAccountName('srv.example', true), 'srv-example$');
  assert.equal(suggestSAMAccountName('WS01$', true), 'WS01$');
  assert.equal(suggestSAMAccountName('???', true), '');
});

test('blockingValidationErrors ignores required attributes the server keeps but did not return', () => {
  // Samba/AD: "top" requires nTSecurityDescriptor, which "*" + "+" does not return.
  const mustBefore = ['objectClass', 'objectCategory', 'nTSecurityDescriptor', 'instanceType', 'cn'];
  const originalAttrNames = ['cn', 'objectCategory', 'instanceType', 'description'];
  const nt = { attribute: 'nTSecurityDescriptor', message: 'Required attribute "nTSecurityDescriptor" is missing', type: 'error' };
  const cn = { attribute: 'cn', message: 'Required attribute "cn" is missing', type: 'error' };
  const uid = { attribute: 'uidNumber', message: 'Required attribute "uidNumber" is missing', type: 'error' };
  const oc = { attribute: 'objectClass', message: 'At least one structural objectClass is required', type: 'error' };
  const schema = { attribute: '', message: 'Failed to load schema: x', type: 'error' };

  const r = blockingValidationErrors([nt, cn, uid, oc, schema], { mustBefore, originalAttrNames, objectClassesChanged: false });
  // cn was loaded and removed by the user; uidNumber is new (posixAccount added); schema errors always block
  assert.deepEqual(r.blocking, [cn, uid, schema]);
  assert.deepEqual(r.ignored, [nt, oc]);
  // objectClass problems block once the classes were changed
  assert.deepEqual(blockingValidationErrors([oc], { mustBefore, originalAttrNames, objectClassesChanged: true }).blocking, [oc]);
  // a description-only edit on AD is not blocked
  assert.deepEqual(blockingValidationErrors([nt], { mustBefore, originalAttrNames, objectClassesChanged: false }).blocking, []);

  assert.equal(requiredButNotLoaded('ntsecuritydescriptor', mustBefore, originalAttrNames), true);
  assert.equal(requiredButNotLoaded('cn', mustBefore, originalAttrNames), false);
  assert.equal(requiredButNotLoaded('uidNumber', mustBefore, originalAttrNames), false);
  // options are ignored when matching names
  assert.equal(requiredButNotLoaded('userCertificate', ['userCertificate'], ['userCertificate;binary']), false);
});

test('describeChange masks secret values and counts binary ones', () => {
  assert.equal(describeChange({ operation: 'add', attribute: 'objectClass', values: ['posixAccount'], binary: false }), 'add objectClass: posixAccount');
  assert.equal(describeChange({ operation: 'replace', attribute: 'userPassword', values: ['{SSHA}abc', 'NewSecret'], binary: false }), 'replace userPassword: *** (2 values)');
  assert.equal(describeChange({ operation: 'replace', attribute: 'unicodePwd', values: ['NewSecret'], binary: false }), 'replace unicodePwd: *** (1 value)');
  assert.equal(describeChange({ operation: 'add', attribute: 'msLAPS-Password', values: ['x'], binary: false }), 'add msLAPS-Password: *** (1 value)');
  assert.equal(describeChange({ operation: 'add', attribute: 'jpegPhoto', values: ['/9j/', 'iVBO'], binary: true }), 'add jpegPhoto: 2 binary values');
  assert.equal(describeChange({ operation: 'replace', attribute: 'mail', values: ['a', 'b', 'c', 'd'], binary: false }), 'replace mail: a, b, c, …');
  assert.equal(describeChange({ operation: 'delete', attribute: 'userPassword', values: [], binary: false }), 'delete userPassword');
  for (const n of ['userPassword', 'authPassword;orig', 'sambaNTPassword', 'ms-Mcs-AdmPwd', 'dBCSPwd', 'pwdHistory', 'olcRootPW', 'krbPrincipalKey', 'supplementalCredentials', 'clientSecret', '2.5.4.35', '1.2.840.113556.1.4.90;binary']) {
    assert.ok(isSensitiveAttributeName(n), n);
  }
  for (const n of [
    'pwdLastSet', 'pwdReset', 'description', 'pwdPolicySubentry',
    // timestamps / counters / policy values that mention "password"
    'badPasswordTime', 'passwordExpirationTime', 'passwordRetryCount', 'msDS-UserPasswordExpiryTimeComputed',
    'msDS-MinimumPasswordLength', 'msDS-MaximumPasswordAge', 'msDS-PasswordSettingsPrecedence', 'passwordExpWarned',
  ]) {
    assert.ok(!isSensitiveAttributeName(n), n);
  }
});

test('account copies never keep the source login (P-25): new uid, uidNumber, home directory', () => {
  const source = [
    { name: 'objectClass', values: ['top', 'inetOrgPerson', 'posixAccount'], binary: false },
    { name: 'cn', values: ['ux-p-user4'], binary: false },
    { name: 'sn', values: ['User4'], binary: false },
    { name: 'uid', values: ['ux-p-user4'], binary: false },
    { name: 'uidNumber', values: ['10010'], binary: false },
    { name: 'gidNumber', values: ['10000'], binary: false },
    { name: 'homeDirectory', values: ['/home/ux-p-user4'], binary: false },
    { name: 'displayName', values: ['ux-p-user4'], binary: false },
    { name: 'userPassword', values: ['{SSHA}x'], binary: false },
  ];
  const login = copyLoginFields(source, 'cn');
  assert.equal(login.uid, true);
  assert.equal(login.posix, true);
  assert.equal(login.sourceUid, 'ux-p-user4');
  const plan = planEntryCopy('cn=ux-p-user4,ou=ux-p,dc=x', source, 'ux-p-user5', { uid: 'ux-p-user5', uidNumber: '10040' });
  const byName = Object.fromEntries(plan.attributes.map((a) => [a.name, a.values]));
  assert.deepEqual(byName.uid, ['ux-p-user5']);
  assert.deepEqual(byName.uidNumber, ['10040']);
  assert.deepEqual(byName.homeDirectory, ['/home/ux-p-user5']);
  assert.deepEqual(byName.displayName, ['ux-p-user5']);
  assert.deepEqual(byName.gidNumber, ['10000']);
  assert.equal(byName.userPassword, undefined);
  // without a new uid the source's uid is left out, never copied
  const names = buildCopyAttributes(source, 'cn', 'x').map((a) => a.name);
  assert.ok(!names.includes('uid') && !names.includes('uidNumber'));
  // uid as RDN: the RDN value is the new uid (checked for duplicates by the dialog)
  assert.equal(copyLoginFields(source, 'uid').uid, false);
  assert.equal(copyLoginFields(source, 'uid').rdnIsLogin, true);
  assert.equal(copyLoginFields(source, 'cn').rdnIsLogin, false);
  const byUid = planEntryCopy('uid=ux-p-user4,ou=ux-p,dc=x', source, 'copy.of.ux-p-user4', { uidNumber: '10041', parentDN: 'ou=other,dc=x' });
  const uidAttrs = Object.fromEntries(byUid.attributes.map((a) => [a.name, a.values]));
  assert.equal(byUid.dn, 'uid=copy.of.ux-p-user4,ou=other,dc=x');
  assert.deepEqual(uidAttrs.uid, ['copy.of.ux-p-user4']);
  assert.deepEqual(uidAttrs.homeDirectory, ['/home/copy.of.ux-p-user4'], 'the home follows the new uid');
  assert.deepEqual(uidAttrs.cn, ['copy.of.ux-p-user4'], 'a cn equal to the old uid follows the name');
  assert.deepEqual(uidAttrs.uidNumber, ['10041']);
  // a non-account entry with a uid attribute (device) keeps it
  assert.equal(copyLoginFields([{ name: 'objectClass', values: ['device'], binary: false }, { name: 'uid', values: ['d1'], binary: false }]).uid, false);
  // an unrelated home directory is kept as it is
  const shared = buildCopyAttributes(source.map((a) => a.name === 'homeDirectory' ? { ...a, values: ['/srv/shared'] } : a), 'cn', 'y', { uid: 'y', uidNumber: '1' });
  assert.deepEqual(shared.find((a) => a.name === 'homeDirectory')?.values, ['/srv/shared']);
});

test('planEntryCopy puts the copy into another container and takes an explicit UPN', () => {
  const plan = planEntryCopy('CN=Doe\\, Jane,OU=A,DC=ad', [
    { name: 'objectClass', values: ['user'], binary: false },
    { name: 'sAMAccountName', values: ['doej'], binary: false },
    { name: 'userPrincipalName', values: ['doej@ad.example.org'], binary: false },
  ], 'Roe, Rick', { sAMAccountName: 'roer', userPrincipalName: 'rick.roe@corp.example.org', parentDN: 'OU=B,DC=ad' });
  assert.equal(plan.dn, 'CN=Roe\\, Rick,OU=B,DC=ad');
  assert.deepEqual(plan.attributes.find((a) => a.name === 'userPrincipalName')?.values, ['rick.roe@corp.example.org']);
  const ad = copyLoginFields(plan.attributes);
  assert.equal(ad.sAMAccountName, true);
  assert.equal(ad.upnSuffix, '@corp.example.org');
  assert.equal(copyTargetDN('cn=a,ou=x', 'b', ' '), 'cn=b,ou=x');
});

test('suggestUid folds names into lowercase login names', () => {
  assert.equal(suggestUid('Copy of Jürgen Groß'), 'copy.of.juergen.gross');
  assert.equal(suggestUid('  Zoë O\'Neil '), 'zoe.o.neil');
  assert.equal(suggestUid('ux-life user1'), 'ux-life.user1');
  assert.equal(suggestUid('...'), '');
});
