// Run: cd frontend && node --test 'tests/*.test.ts'
// New Entry templates, name derivations and the rename helpers (LIFE-01/02/03).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AD_TEMPLATES, LDAP_TEMPLATES, adGroupType, classChain, classesInSchema, computerDNSHostName, computerSAM, defaultTemplate,
  dnsDomainOf, fullNameOf, homeDirectoryOf, ldapContainerClass, logonNameOf, mayAttributes, mustAttributes, newEntryDN,
  newEntryTitle, parseUidList, samFromLogon, summarizeCreate, classesOfKind, ldapPosixGroupClasses, newEntryFieldValue, planNewEntry,
  type NewEntryForm,
} from '../src/components/lifecycle/newEntry.ts';
import { planLogonNameChanges, renamedRDN } from '../src/components/lifecycle/rename.ts';
import { parseRDN } from '../src/lib/dn.ts';
import type { SchemaObjectClass } from '../src/types/ldap';

const oc = (name: string, kind: string, superClass: string[], must: string[], may: string[] = []): SchemaObjectClass =>
  ({ oid: '', name, description: '', kind, superClass, must, may });
const SCHEMA = [
  oc('top', 'abstract', [], ['objectClass']),
  oc('person', 'structural', ['top'], ['sn', 'cn'], ['description', 'userPassword']),
  oc('organizationalPerson', 'structural', ['person'], [], ['title']),
  oc('inetOrgPerson', 'structural', ['organizationalPerson'], [], ['mail', 'uid']),
  oc('posixAccount', 'auxiliary', ['top'], ['cn', 'uid', 'uidNumber', 'gidNumber', 'homeDirectory'], ['loginShell']),
  oc('organizationalRole', 'structural', ['top'], ['cn'], ['description']),
  oc('organizationalUnit', 'structural', ['top'], ['ou'], ['description']),
];

test('ADUC names: full name, logon name, sAMAccountName, UPN parts', () => {
  assert.equal(fullNameOf('Anna', 'M', 'Schmidt'), 'Anna M. Schmidt');
  assert.equal(fullNameOf(' Anna ', 'M.', ''), 'Anna M.');
  assert.equal(fullNameOf('', '', 'Schmidt'), 'Schmidt');
  assert.equal(logonNameOf('Jürgen', 'Groß'), 'juergen.gross');
  assert.equal(logonNameOf('', '', 'Service Desk'), 'service.desk');
  assert.equal(samFromLogon('a.very.long.logon.name.beyond'), 'a.very.long.logon.na');
  assert.equal(computerSAM('ws01'), 'WS01$');
  assert.equal(dnsDomainOf('OU=ux-life,OU=Track-ux,DC=ad,DC=ldapilot,DC=lab'), 'ad.ldapilot.lab');
  assert.equal(computerDNSHostName('WS01', 'ad.ldapilot.lab'), 'ws01.ad.ldapilot.lab');
  assert.equal(computerDNSHostName('', 'x'), '');
});

test('AD groupType from scope and type (signed 32 bit)', () => {
  assert.equal(adGroupType('global', 'security'), -2147483646);
  assert.equal(adGroupType('domainLocal', 'security'), -2147483644);
  assert.equal(adGroupType('universal', 'security'), -2147483640);
  assert.equal(adGroupType('global', 'distribution'), 2);
  assert.equal(adGroupType('universal', 'distribution'), 8);
});

test('templates: LDAP container class from the schema, default template, title', () => {
  assert.deepEqual(ldapContainerClass(new Set(['top', 'organizationalrole'])), { objectClasses: ['top', 'organizationalRole'], rdnAttr: 'cn' });
  assert.deepEqual(ldapContainerClass(new Set(['top', 'organizationalunit'])), { objectClasses: ['top', 'organizationalUnit'], rdnAttr: 'ou' });
  assert.ok(!LDAP_TEMPLATES.some((t) => t.objectClasses.includes('container')), 'no AD container class on LDAP');
  assert.deepEqual(classesInSchema(['top', 'posixAccount', 'shadowAccount'], new Set(['top', 'posixaccount'])), ['top', 'posixAccount']);
  assert.deepEqual(classesInSchema(['a'], new Set()), ['a']);
  // Other Entry… never falls back to OU; the requested template wins; else last used
  assert.equal(defaultTemplate(undefined, 'ou', AD_TEMPLATES), 'custom');
  assert.equal(defaultTemplate(undefined, null, AD_TEMPLATES), 'custom');
  assert.equal(defaultTemplate(undefined, 'group', AD_TEMPLATES), 'group');
  assert.equal(defaultTemplate('ou', 'group', AD_TEMPLATES), 'ou');
  assert.equal(defaultTemplate(undefined, 'posixUser', AD_TEMPLATES), 'custom', 'LDAP-only template on AD');
  assert.equal(newEntryTitle('User', 'OU=ux-life,OU=Track-ux,DC=ad'), 'New User in ux-life');
  assert.equal(newEntryTitle('Contact', 'OU=Sales\\, EU,DC=x'), 'New Contact in Sales, EU');
  assert.equal(newEntryTitle('Entry', ''), 'New Entry');
});

test('schema helpers: MUST/MAY with SUP chain, class chain for Custom…', () => {
  assert.deepEqual(mustAttributes(['inetOrgPerson'], SCHEMA).sort(), ['cn', 'objectClass', 'sn']);
  assert.deepEqual(mustAttributes(['inetOrgPerson', 'posixAccount'], SCHEMA).sort(), ['cn', 'gidNumber', 'homeDirectory', 'objectClass', 'sn', 'uid', 'uidNumber']);
  const may = mayAttributes(['inetOrgPerson', 'posixAccount'], SCHEMA);
  assert.ok(may.includes('mail') && may.includes('loginShell') && !may.includes('uid'), 'MUST attributes are not repeated as MAY');
  assert.deepEqual(classChain('inetOrgPerson', ['posixAccount'], SCHEMA), ['top', 'person', 'organizationalPerson', 'inetOrgPerson', 'posixAccount']);
  assert.deepEqual(classesOfKind(SCHEMA, 'auxiliary'), ['posixAccount']);
  assert.ok(classesOfKind(SCHEMA, 'structural').includes('organizationalRole'));
});

test('new entry DN escapes the value; POSIX helpers', () => {
  assert.equal(newEntryDN('cn', 'ux, user3', 'OU=ux-life,DC=ad'), 'cn=ux\\, user3,OU=ux-life,DC=ad');
  assert.equal(parseRDN('cn=ux\\, user3').value, 'ux, user3');
  assert.equal(newEntryDN('cn', '  ', 'dc=x'), '');
  assert.equal(homeDirectoryOf('ux-life1'), '/home/ux-life1');
  assert.deepEqual(parseUidList('a, b  c;A'), ['a', 'b', 'c']);
});

test('create summary: one toast, problems listed', () => {
  assert.deepEqual(summarizeCreate('u1', [
    { id: 'create', state: 'done', text: 'created' },
    { id: 'password', state: 'done', text: 'password set' },
    { id: 'enable', state: 'done', text: 'enabled' },
  ]), { level: 'success', message: 'u1 created · password set · enabled' });
  const s = summarizeCreate('u2', [
    { id: 'create', state: 'done', text: 'created' },
    { id: 'password', state: 'skipped', text: 'password', detail: 'needs TLS' },
    { id: 'groups', state: 'done', text: 'added to 2 groups' },
  ]);
  assert.equal(s.level, 'warning');
  assert.match(s.message, /^u2 created · added to 2 groups — 1 step not done$/);
  assert.equal(s.detail, 'password: needs TLS');
});

test('rename: plain names are escaped; AD logon names change only when different', () => {
  assert.equal(renamedRDN('CN', 'ux, user3'), 'CN=ux\\, user3');
  assert.equal(renamedRDN('cn', ' #lead '), 'cn=\\#lead');
  assert.deepEqual(planLogonNameChanges(
    { displayName: 'Old', sAMAccountName: 'old', userPrincipalName: 'old@ad' },
    { displayName: 'New', sAMAccountName: 'old', userPrincipalName: '' },
  ), [{ operation: 'replace', attribute: 'displayName', values: ['New'], binary: false }]);
});

const form = (over: Partial<NewEntryForm>): NewEntryForm => ({
  template: 'user', templateRdnAttr: 'cn', isAD: false, parentDN: 'ou=ux-life,ou=Track-ux,dc=demo,dc=x', fields: {}, touched: {},
  ldapRdn: 'uid', scope: 'global', groupKind: 'security', password: '', members: [], upnSuffixes: [], posixIDs: null,
  customRdnDefault: 'cn', mustValues: {}, extraRows: [], ...over,
});

test('plan: AD user (ADUC names, logon names, created disabled, no userPassword)', () => {
  const f = form({
    isAD: true, parentDN: 'OU=ux-life,OU=Track-ux,DC=ad,DC=ldapilot,DC=lab', upnSuffixes: ['ad.ldapilot.lab', 'corp.example'],
    fields: { first: 'Jürgen', initials: 'K', last: 'Groß' }, password: 'Secret-1234',
  });
  const p = planNewEntry(f);
  assert.equal(p.rdnAttr, 'cn');
  assert.equal(p.rdnValue, 'Jürgen K. Groß');
  assert.deepEqual(p.attrs, {
    givenName: ['Jürgen'], sn: ['Groß'], displayName: ['Jürgen K. Groß'], initials: ['K'], sAMAccountName: ['juergen.gross'],
    userPrincipalName: ['juergen.gross@ad.ldapilot.lab'], userAccountControl: ['514'], cn: ['Jürgen K. Groß'],
  });
  // A typed logon name and suffix win; the sAMAccountName follows the logon name.
  const typed = planNewEntry({ ...f, fields: { ...f.fields, logon: 'jgross', upnSuffix: 'corp.example' }, touched: { logon: true, upnSuffix: true } });
  assert.deepEqual([typed.attrs.sAMAccountName, typed.attrs.userPrincipalName], [['jgross'], ['jgross@corp.example']]);
  // No UPN suffix list: the parent's DC= components.
  assert.equal(newEntryFieldValue({ ...f, upnSuffixes: [] }, 'upnSuffix'), 'ad.ldapilot.lab');
});

test('plan: LDAP user named by uid, password kept untrimmed; cn RDN on request', () => {
  const f = form({ fields: { first: 'Anna', last: 'Fuchs', mail: 'anna@example.org' }, password: ' pw with blanks ' });
  const p = planNewEntry(f);
  assert.equal(p.rdnAttr, 'uid');
  assert.equal(p.rdnValue, 'anna.fuchs');
  assert.deepEqual(p.attrs, {
    givenName: ['Anna'], sn: ['Fuchs'], mail: ['anna@example.org'], cn: ['Anna Fuchs'], uid: ['anna.fuchs'], userPassword: [' pw with blanks '],
  });
  const byCn = planNewEntry({ ...f, ldapRdn: 'cn', password: '' });
  assert.equal(byCn.rdnAttr, 'cn');
  assert.equal(byCn.rdnValue, 'Anna Fuchs');
  assert.equal(byCn.attrs.userPassword, undefined);
  // Only a last name: sn and cn are the name (person MUST sn, cn).
  assert.deepEqual(planNewEntry(form({ fields: { last: 'Solo' } })).attrs.sn, ['Solo']);
});

test('plan: POSIX user IDs, home and shell; cn from the uid without names', () => {
  const ids = { uid: 10040, gid: 10003, primary: 10000 };
  const f = form({ template: 'posixUser', templateRdnAttr: 'uid', posixIDs: ids, fields: { uid: 'ux-life-p1' }, touched: { uid: true } });
  const p = planNewEntry(f);
  assert.equal(p.rdnValue, 'ux-life-p1');
  assert.deepEqual(p.attrs, {
    sn: ['ux-life-p1'], cn: ['ux-life-p1'], uid: ['ux-life-p1'], uidNumber: ['10040'], gidNumber: ['10000'],
    homeDirectory: ['/home/ux-life-p1'], loginShell: ['/bin/bash'],
  });
  // Without accounts, the primary gid is 0 → the next free gid.
  assert.equal(newEntryFieldValue({ ...f, posixIDs: { ...ids, primary: 0 } }, 'gidNumber'), '10003');
});

test('plan: groups, POSIX group, AD computer, contact, container, custom', () => {
  const g = planNewEntry(form({ template: 'group', fields: { name: 'ux-life-g1' }, members: ['cn=admin,dc=x'] }));
  assert.deepEqual(g.attrs, { member: ['cn=admin,dc=x'], cn: ['ux-life-g1'] });
  const ad = planNewEntry(form({ template: 'group', isAD: true, scope: 'universal', groupKind: 'distribution', fields: { name: 'ux life g2' } }));
  assert.deepEqual(ad.attrs, { sAMAccountName: ['ux.life.g2'], groupType: ['8'], cn: ['ux life g2'] });
  const pg = planNewEntry(form({ template: 'posixGroup', posixIDs: { uid: 1, gid: 10003, primary: 0 }, fields: { name: 'ux-life-pg', memberUids: 'a, b a' } }));
  assert.deepEqual(pg.attrs, { gidNumber: ['10003'], memberUid: ['a', 'b'], cn: ['ux-life-pg'] });
  const comp = planNewEntry(form({ template: 'computer', isAD: true, parentDN: 'OU=x,DC=ad,DC=lab', fields: { name: 'ws01' } }));
  assert.deepEqual(comp, { rdnAttr: 'cn', rdnValue: 'WS01', attrs: { sAMAccountName: ['WS01$'], userAccountControl: ['4128'], dNSHostName: ['ws01.ad.lab'], cn: ['WS01'] } });
  const contact = planNewEntry(form({ template: 'contact', fields: { first: 'Ext', last: 'Partner' }, password: 'ignored' }));
  assert.deepEqual(contact.attrs, { givenName: ['Ext'], sn: ['Partner'], cn: ['Ext Partner'] }, 'a contact gets no uid and no password');
  const role = planNewEntry(form({ template: 'container', fields: { name: 'ux-life-c1', description: 'd' } }));
  assert.deepEqual(role, { rdnAttr: 'cn', rdnValue: 'ux-life-c1', attrs: { description: ['d'], cn: ['ux-life-c1'] } });
  const custom = planNewEntry(form({
    template: 'custom', customRdnDefault: 'cn', fields: { name: 'ux, custom' }, mustValues: { sn: ' Custom ' },
    extraRows: [{ name: 'mail', value: 'c@x' }, { name: ' ', value: 'dropped' }],
  }));
  assert.deepEqual(custom, { rdnAttr: 'cn', rdnValue: 'ux, custom', attrs: { sn: ['Custom'], mail: ['c@x'], cn: ['ux, custom'] } });
  assert.equal(newEntryDN(custom.rdnAttr, custom.rdnValue, 'dc=x'), 'cn=ux\\, custom,dc=x');
});

test('POSIX group classes: a structural class when posixGroup is auxiliary (389DS rfc2307compat)', () => {
  const nis = [oc('posixGroup', 'structural', ['top'], ['cn', 'gidNumber'])];
  assert.deepEqual(ldapPosixGroupClasses(nis), ['top', 'posixGroup']);
  assert.deepEqual(ldapPosixGroupClasses([]), ['top', 'posixGroup'], 'schema not loaded');
  const ds = [oc('posixGroup', 'auxiliary', ['top'], ['gidNumber']), oc('groupOfNames', 'structural', ['top'], ['cn'], ['member'])];
  assert.deepEqual(ldapPosixGroupClasses(ds), ['top', 'groupOfNames', 'posixGroup']);
  assert.deepEqual(ldapPosixGroupClasses([oc('posixGroup', 'auxiliary', ['top'], ['gidNumber']), oc('namedObject', 'structural', ['top'], [], ['cn'])]),
    ['top', 'namedObject', 'posixGroup']);
});

test('required rows leave out what the form fills: sn, cn, uid, homeDirectory (M-02)', async () => {
  const { formMappedAttributes } = await import('../src/components/lifecycle/newEntry.ts');
  const ldapUser = formMappedAttributes(form({}));
  for (const a of ['sn', 'cn', 'uid']) assert.ok(ldapUser.has(a), a);
  const posix = formMappedAttributes(form({ template: 'posixUser', posixIDs: { uid: 10000, gid: 10000, primary: 10000 } }));
  for (const a of ['sn', 'cn', 'uid', 'homedirectory', 'uidnumber', 'gidnumber']) assert.ok(posix.has(a), a);
  const contact = formMappedAttributes(form({ template: 'contact' }));
  assert.ok(contact.has('sn') && contact.has('cn'));
  assert.ok(!contact.has('uid'), 'a contact has no login');
});
