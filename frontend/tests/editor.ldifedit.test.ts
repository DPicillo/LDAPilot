// Edit as LDIF (DEF-14): parser (lib/ldif.ts) and change planner (components/editor/ldifEdit.ts).
// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEntryForEdit, needsBase64ForEdit, parseLDIFRecord, utf8ToBase64, foldLDIFLine } from '../src/lib/ldif.ts';
import {
  attributeKey, dnProblem, lineOffset, planLDIFEdit, planSummary, rdnPairs, schemaIndex, startLDIFEdit,
  LDIF_EDIT_LARGE_BINARY,
} from '../src/components/editor/ldifEdit.ts';
import type { LDAPAttribute, LDAPEntry, SchemaAttribute } from '../src/types/ldap';

const DN = 'cn=Anna Schmidt,ou=People,dc=demo,dc=ldapilot,dc=local';

function sa(name: string, extra: Partial<SchemaAttribute> = {}): SchemaAttribute {
  return {
    oid: extra.oid ?? `1.2.3.${name.length}.${name.charCodeAt(0)}`, name, description: '', syntax: extra.syntax ?? '1.3.6.1.4.1.1466.115.121.1.15',
    syntaxName: '', singleValue: false, noUserMod: false, usage: 'userApplications', superType: '', equality: '', ordering: '', substring: '', ...extra,
  };
}

const SCHEMA = schemaIndex([
  sa('objectClass', { oid: '2.5.4.0' }), sa('cn', { oid: '2.5.4.3', aliases: ['commonName'] }), sa('sn', { oid: '2.5.4.4', aliases: ['surname'] }),
  sa('mail'), sa('description'), sa('telephoneNumber'), sa('givenName', { aliases: ['gn'] }), sa('displayName', { singleValue: true }),
  sa('userCertificate', { syntax: '1.3.6.1.4.1.1466.115.121.1.8' }), sa('jpegPhoto', { syntax: '1.3.6.1.4.1.1466.115.121.1.28' }),
  sa('userPassword', { oid: '2.5.4.35', syntax: '1.3.6.1.4.1.1466.115.121.1.40' }), sa('member'), sa('uid'),
  sa('entryUUID', { noUserMod: true, usage: 'directoryOperation' }), sa('modifyTimestamp', { noUserMod: true, usage: 'directoryOperation' }),
  sa('labeledURI'), sa('ou'),
]);

function entry(attrs: [string, string[], boolean?][], dn = DN): LDAPEntry {
  return { dn, attributes: attrs.map(([name, values, binary]) => ({ name, values, binary: !!binary } as LDAPAttribute)) };
}

const CERT = btoa('certificate-bytes-1');
const CERT2 = btoa(String.fromCharCode(0x30, 0x82, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xff));
const PHOTO = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46));

const BASE = entry([
  ['objectClass', ['top', 'person', 'organizationalPerson', 'inetOrgPerson']],
  ['cn', ['Anna Schmidt']],
  ['sn', ['Schmidt']],
  ['givenName', ['Anna']],
  ['mail', ['anna@demo.local', 'a.schmidt@demo.local']],
  ['description', ['Jürgen\'s deputy']],
  ['telephoneNumber', ['+49 1', '+49 2', '+49 3', '+49 4']],
  ['userCertificate;binary', [CERT2], true],
  ['userPassword', ['{SSHA}abcdefghijklmnopqrstuvwxyz012345']],
  ['entryUUID', ['1111-2222']],
  ['modifyTimestamp', ['20261101000000Z']],
]);

function plan(text: string, opts: { fresh?: LDAPEntry; serverType?: 'ad' | 'openldap'; base?: LDAPEntry } = {}) {
  const session = startLDIFEdit(opts.base ?? BASE, { schema: SCHEMA, serverType: opts.serverType ?? 'openldap' });
  return { session, plan: planLDIFEdit(session, text, { schema: SCHEMA, serverType: opts.serverType ?? 'openldap', fresh: opts.fresh }) };
}

/** The session text with `edit` applied to its lines. */
function edited(edit: (lines: string[]) => string[], base = BASE, serverType: 'ad' | 'openldap' = 'openldap'): string {
  const s = startLDIFEdit(base, { schema: SCHEMA, serverType });
  return edit(s.text.replace(/\n$/, '').split('\n')).join('\n') + '\n';
}

// --- Parser ------------------------------------------------------------------------

test('needsBase64ForEdit keeps UTF-8 text plain, encodes what a line cannot hold', () => {
  for (const v of ['Jürgen', '日本', 'a:b', 'mail@example.org', 'tab\tinside']) assert.equal(needsBase64ForEdit(v), v.includes('\t'), v);
  for (const v of [' lead', ':colon', '<angle', 'trail ', 'a\nb', 'cr\r', 'nul\0', 'del\x7f']) assert.equal(needsBase64ForEdit(v), true, JSON.stringify(v));
});

test('formatEntryForEdit: text unfolded, binary folded at 76, dn first', () => {
  const long = 'x'.repeat(200);
  const text = formatEntryForEdit(DN, [{ name: 'description', values: [long, 'Müller', ' lead'] }, { name: 'jpegPhoto', values: [btoa('y'.repeat(150))], binary: true }]);
  const lines = text.split('\n');
  assert.equal(lines[0], `dn: ${DN}`);
  assert.equal(lines[1], `description: ${long}`);
  assert.equal(lines[2], 'description: Müller');
  assert.equal(lines[3], `description:: ${utf8ToBase64(' lead')}`);
  assert.ok(lines[4].startsWith('jpegPhoto:: ') && lines[4].length === 76 && lines[5].startsWith(' '));
});

test('parseLDIFRecord: folding, base64, comments, version, CRLF', () => {
  const b64 = utf8ToBase64('Grüße, Welt');
  const text = ['version: 1', '# a comment', ` folded comment`, `dn: ${DN}`, 'description: one', 'descr', ' iption-not-a-name: x'].join('\r\n');
  const rec = parseLDIFRecord(text);
  assert.equal(rec.dn, DN);
  assert.equal(rec.dnLine, 4);
  assert.deepEqual(rec.errors, []);
  assert.equal(rec.attributes[0].values[0].value, 'one');
  assert.equal(rec.attributes[1].name, 'description-not-a-name');

  const folded = foldLDIFLine(`mail:: ${b64}`, 20);
  const rec2 = parseLDIFRecord(`dn: ${DN}\n${folded}\nMAIL: second\n`);
  assert.equal(rec2.attributes.length, 1, 'MAIL and mail are one attribute');
  assert.deepEqual(rec2.attributes[0].values.map((v) => [v.value, v.base64]), [[b64, true], ['second', false]]);

  const rec3 = parseLDIFRecord(`dn:: ${utf8ToBase64('cn=Jörg,dc=x')}\ncn:   spaced value  \n`);
  assert.equal(rec3.dn, 'cn=Jörg,dc=x');
  assert.equal(rec3.attributes[0].values[0].value, 'spaced value  ', 'blanks after the colon skipped, trailing kept (as Go)');
});

test('parseLDIFRecord reports change records, URLs, second records, bad base64 with lines', () => {
  const bad = parseLDIFRecord([`dn: ${DN}`, 'changetype: modify', 'replace: mail', '-', 'photo:< file:///etc/passwd', 'cn:: !!notbase64', 'bad name: x', '', 'dn: cn=other,dc=x', 'cn: other'].join('\n'));
  const msgs = bad.errors.map((e) => `${e.line}:${e.message}`);
  assert.ok(msgs.some((m) => m.startsWith('2:change records')), msgs.join('\n'));
  assert.ok(msgs.some((m) => m.startsWith('4:unexpected "-"')));
  assert.ok(msgs.some((m) => m.startsWith('5:URL values')));
  assert.ok(msgs.some((m) => m.startsWith('6:invalid base64')));
  assert.ok(msgs.some((m) => m.startsWith('7:invalid attribute name')));
  assert.ok(msgs.some((m) => m.startsWith('9:only one entry')));
  // blank lines inside the one entry are fine
  const loose = parseLDIFRecord(`dn: ${DN}\ncn: a\n\n\nsn: b\n\n`);
  assert.deepEqual(loose.errors, []);
  assert.deepEqual(loose.attributes.map((a) => a.name), ['cn', 'sn']);
  assert.equal(parseLDIFRecord(' leading continuation\ndn: x=y').errors[0].line, 1);
  assert.match(parseLDIFRecord('cn: x\n').errors[0].message, /must start with a "dn:" line/);
  assert.match(parseLDIFRecord('\n\n').errors[0].message, /no entry/);
});

// --- Session -----------------------------------------------------------------------

test('startLDIFEdit leaves out server-maintained attributes, secrets and large binaries', () => {
  const big = btoa('z'.repeat(LDIF_EDIT_LARGE_BINARY + 10));
  const s = startLDIFEdit(entry([...BASE.attributes.map((a) => [a.name, a.values, a.binary] as [string, string[], boolean]), ['jpegPhoto', [big], true]]), { schema: SCHEMA, serverType: 'openldap' });
  const hidden = Object.fromEntries(s.hidden.map((h) => [h.name, h.reason]));
  assert.deepEqual(hidden, { userPassword: 'secret', entryUUID: 'managed', modifyTimestamp: 'managed', jpegPhoto: 'large' });
  assert.ok(s.text.startsWith(`dn: ${DN}\nobjectClass: top\n`));
  assert.ok(s.text.includes('objectClass: inetOrgPerson\ncn: Anna Schmidt\n'), 'the RDN attribute follows objectClass');
  const late = startLDIFEdit(entry([['sn', ['S']], ['cn', ['Anna Schmidt']], ['objectClass', ['person']]]), { schema: SCHEMA });
  assert.equal(late.text, `dn: ${DN}\nobjectClass: person\ncn: Anna Schmidt\nsn: S\n`);
  assert.ok(s.text.includes("description: Jürgen's deputy\n"), 'UTF-8 stays readable');
  assert.ok(!s.text.includes('SSHA') && !s.text.includes('entryUUID'));
  assert.ok(s.text.includes(`userCertificate;binary:: ${CERT2}`));
});

test('the unchanged text plans nothing (binary, AD GUID/SID, non-ASCII round-trip)', () => {
  const ad = entry([
    ['objectClass', ['top', 'user']], ['cn', ['Anna']], ['msExchMailboxGuid', ['fb92927a-1c2b-4d3e-8f90-123456789abc']],
    ['thumbnailPhoto', [PHOTO], true], ['description', ['Ünïcödé', 'line\r\nbreak']],
  ], 'CN=Anna,OU=X,DC=ad,DC=lab');
  for (const [base, st] of [[BASE, 'openldap'], [ad, 'ad']] as const) {
    const s = startLDIFEdit(base, { schema: SCHEMA, serverType: st });
    const p = planLDIFEdit(s, s.text, { serverType: st });
    assert.deepEqual(p.problems, [], `${st}: ${JSON.stringify(p.problems)}`);
    assert.deepEqual(p.changes, []);
    assert.equal(p.rename, null);
    assert.equal(planSummary(p), 'No changes');
  }
  // refolded and unpadded base64 of the same certificate is the same value
  const t = edited((ls) => ls.map((l) => (l.startsWith('userCertificate') ? foldLDIFLine(`usercertificate;BINARY:: ${CERT2}`, 10) : l)));
  assert.deepEqual(plan(t).plan.changes, []);
});

// --- Changes -----------------------------------------------------------------------

test('multi-valued text: value-level delete/add when smaller, replace otherwise', () => {
  const t = edited((ls) => [...ls.filter((l) => l !== 'telephoneNumber: +49 2'), 'telephoneNumber: +49 5']);
  assert.deepEqual(plan(t).plan.changes, [
    { operation: 'delete', attribute: 'telephoneNumber', values: ['+49 2'], binary: false },
    { operation: 'add', attribute: 'telephoneNumber', values: ['+49 5'], binary: false },
  ]);
  const t2 = edited((ls) => ls.map((l) => (l === 'mail: anna@demo.local' ? 'mail: anna.schmidt@demo.local' : l)));
  assert.deepEqual(plan(t2).plan.changes, [{ operation: 'replace', attribute: 'mail', values: ['anna.schmidt@demo.local', 'a.schmidt@demo.local'], binary: false }]);
  const r = plan(t2).plan.rows[0];
  assert.deepEqual([r.kind, r.removed, r.added, r.kept], ['replace', ['anna@demo.local'], ['anna.schmidt@demo.local'], 1]);
});

test('single-valued and new / removed attributes; order of values does not matter', () => {
  const t = edited((ls) => [
    ...ls.filter((l) => !l.startsWith('description:')).map((l) => (l === 'sn: Schmidt' ? 'sn: Schmidt-Weber' : l)),
    'displayName: Anna S.', 'labeledURI: https://x.example',
  ]);
  const p = plan(t).plan;
  assert.deepEqual(p.changes, [
    { operation: 'replace', attribute: 'sn', values: ['Schmidt-Weber'], binary: false },
    { operation: 'add', attribute: 'displayName', values: ['Anna S.'], binary: false },
    { operation: 'add', attribute: 'labeledURI', values: ['https://x.example'], binary: false },
    { operation: 'delete', attribute: 'description', values: [], binary: false },
  ]);
  const swapped = edited((ls) => {
    const i = ls.indexOf('mail: anna@demo.local');
    [ls[i], ls[i + 1]] = [ls[i + 1], ls[i]];
    return ls;
  });
  assert.deepEqual(plan(swapped).plan.changes, []);
});

test('attribute names: case, aliases and the ;binary option name the same attribute', () => {
  assert.equal(attributeKey('SURNAME', SCHEMA), 'sn');
  assert.equal(attributeKey('2.5.4.3', SCHEMA), 'cn');
  assert.equal(attributeKey('userCertificate;binary', SCHEMA), attributeKey('usercertificate', SCHEMA));
  assert.equal(attributeKey('cn;lang-de', SCHEMA), 'cn;lang-de');
  const t = edited((ls) => ls.map((l) => (l === 'sn: Schmidt' ? 'SURNAME: Schmidt' : l === 'givenName: Anna' ? 'GN: Annette' : l)));
  assert.deepEqual(plan(t).plan.changes, [{ operation: 'replace', attribute: 'givenName', values: ['Annette'], binary: false }], 'the entry spelling is sent');
});

test('binary values: replace of a changed attribute, never value-level, sent as base64', () => {
  const t = edited((ls) => [...ls, `userCertificate:: ${CERT}`]);
  assert.deepEqual(plan(t).plan.changes, [{ operation: 'replace', attribute: 'userCertificate;binary', values: [CERT2, CERT], binary: true }]);
  const removed = edited((ls) => ls.filter((l) => !l.startsWith('userCertificate')));
  assert.deepEqual(plan(removed).plan.changes, [{ operation: 'delete', attribute: 'userCertificate;binary', values: [], binary: true }]);
  // a new certificate attribute gets the transfer option the schema syntax needs
  const base = entry([['objectClass', ['inetOrgPerson']], ['cn', ['Anna Schmidt']], ['sn', ['S']]]);
  const t2 = edited((ls) => [...ls, `userCertificate:: ${CERT2}`, `jpegPhoto:: ${PHOTO}`], base);
  const p = plan(t2, { base }).plan;
  assert.deepEqual(p.changes, [
    { operation: 'add', attribute: 'userCertificate;binary', values: [CERT2], binary: true },
    { operation: 'add', attribute: 'jpegPhoto', values: [PHOTO], binary: true },
  ]);
  assert.match(p.rows[1].added[0], /^JPEG image · 10 bytes · #/);
  // binary bytes typed for a text attribute make that change binary
  const t3 = edited((ls) => [...ls, `description:: ${btoa('\x00\x01')}`]);
  const ch = plan(t3).plan.changes[0];
  assert.equal(ch.binary, true);
  assert.deepEqual(ch.values, [utf8ToBase64("Jürgen's deputy"), btoa('\x00\x01')], 'the text value is sent as its UTF-8 bytes');
});

test('objectClass changes are value-level: new classes first, removed classes last', () => {
  const t = edited((ls) => [...ls.filter((l) => l !== 'objectClass: organizationalPerson'), 'objectClass: posixAccount', 'uid: anna']);
  const p = plan(t).plan;
  assert.deepEqual(p.changes, [
    { operation: 'add', attribute: 'objectClass', values: ['posixAccount'], binary: false },
    { operation: 'add', attribute: 'uid', values: ['anna'], binary: false },
    { operation: 'delete', attribute: 'objectClass', values: ['organizationalPerson'], binary: false },
  ]);
  assert.equal(p.rows[0].kind, 'modify');
  assert.deepEqual(p.finalObjectClasses, ['top', 'person', 'inetOrgPerson', 'posixAccount']);
  assert.deepEqual(p.finalAttributes.uid, ['anna']);
  // case-only change of a class is no change
  const t2 = edited((ls) => ls.map((l) => (l === 'objectClass: person' ? 'objectclass: PERSON' : l)));
  assert.deepEqual(plan(t2).plan.changes, []);
});

test('passwords: hidden, a typed value replaces (never adds), masked in the review', () => {
  const t = edited((ls) => [...ls, 'userPassword: N3w-Secret!']);
  const p = plan(t).plan;
  assert.deepEqual(p.changes, [{ operation: 'replace', attribute: 'userPassword', values: ['N3w-Secret!'], binary: false }]);
  assert.equal(p.writesUserPassword, true);
  assert.deepEqual(p.rows[0].added, ['•'.repeat(8)]);
  assert.deepEqual(p.rows[0].removed, ['1 stored value']);
  assert.ok(!JSON.stringify(p.rows).includes('N3w-Secret'));
  // an entry without a password: still replace
  const base = entry([['objectClass', ['inetOrgPerson']], ['cn', ['Anna Schmidt']], ['sn', ['S']]]);
  const t2 = edited((ls) => [...ls, 'userPassword: x'], base);
  assert.equal(plan(t2, { base }).plan.changes[0].operation, 'replace');
  // not typing it leaves it alone
  assert.deepEqual(plan(edited((ls) => ls)).plan.changes, []);
});

test('problems: duplicates, empty values, single-valued, unknown attributes, the RDN value', () => {
  const t = edited((ls) => [
    ...ls.map((l) => (l === 'cn: Anna Schmidt' ? 'cn: Anna S' : l)),
    'mail: anna@demo.local', 'description:', 'displayName: a', 'displayName: b', 'fooBar: x',
  ]);
  const msgs = plan(t).plan.problems.map((p) => p.message);
  assert.ok(msgs.some((m) => /"mail" lists the same value twice/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /empty value of "description"/.test(m)));
  assert.ok(msgs.some((m) => /displayName is single-valued/.test(m)));
  assert.ok(msgs.some((m) => /"fooBar" is not an attribute/.test(m)));
  assert.ok(msgs.some((m) => /"cn: Anna Schmidt" names the entry/.test(m)));
  assert.match(dnProblem('cn=a,b') ?? '', /no attribute=value pair/);
  assert.equal(dnProblem('CN=Schmidt\\, Anna,OU=X,DC=y'), null);
  assert.deepEqual(rdnPairs('cn=a\\+b+uid=x,dc=y'), [{ attr: 'cn', value: 'a+b' }, { attr: 'uid', value: 'x' }]);
});

test('dn change = rename: the RDN attribute follows, deleteoldrdn from the text', () => {
  // dn only: the rename replaces the RDN value (deleteoldrdn 1), cn is not modified
  const t = edited((ls) => ls.map((l) => (l.startsWith('dn: ') ? 'dn: cn=Anna Weber,ou=People,dc=demo,dc=ldapilot,dc=local' : l)));
  const p = plan(t).plan;
  assert.deepEqual(p.rename, { oldDN: DN, newDN: 'cn=Anna Weber,ou=People,dc=demo,dc=ldapilot,dc=local', newRDN: 'cn=Anna Weber', newSuperior: '', deleteOldRDN: true });
  assert.deepEqual(p.changes, []);
  assert.deepEqual(p.finalAttributes.cn, ['Anna Weber']);
  assert.equal(planSummary(p), 'Rename');
  // dn and cn changed together, plus another attribute
  const t2 = edited((ls) => ls.map((l) => (l.startsWith('dn: ') ? 'dn: cn=Anna Weber,ou=People,dc=demo,dc=ldapilot,dc=local' : l === 'cn: Anna Schmidt' ? 'cn: Anna Weber' : l === 'sn: Schmidt' ? 'sn: Weber' : l)));
  const p2 = plan(t2).plan;
  assert.equal(p2.rename?.deleteOldRDN, true);
  assert.deepEqual(p2.changes, [{ operation: 'replace', attribute: 'sn', values: ['Weber'], binary: false }]);
  assert.equal(planSummary(p2), 'Rename and 1 attribute changed');
  // the old value kept on purpose: deleteoldrdn 0 (not on AD)
  const t3 = edited((ls) => ls.flatMap((l) => (l.startsWith('dn: ') ? ['dn: cn=Anna Weber,ou=People,dc=demo,dc=ldapilot,dc=local'] : l === 'cn: Anna Schmidt' ? [l, 'cn: Anna Weber', 'cn: A. Weber'] : [l])));
  const p3 = plan(t3).plan;
  assert.equal(p3.rename?.deleteOldRDN, false);
  assert.deepEqual(p3.changes, [{ operation: 'add', attribute: 'cn', values: ['A. Weber'], binary: false }]);
  // cn changed without the new RDN value: the rename keeps it (warning, no delete of the new RDN)
  const t4 = edited((ls) => ls.map((l) => (l.startsWith('dn: ') ? 'dn: cn=Anna Weber,ou=People,dc=demo,dc=ldapilot,dc=local' : l === 'cn: Anna Schmidt' ? 'cn: Anni' : l)));
  const p4 = plan(t4).plan;
  assert.deepEqual(p4.changes, [{ operation: 'add', attribute: 'cn', values: ['Anni'], binary: false }]);
  assert.ok(p4.warnings.some((w) => /set by the rename/.test(w.message)));
});

test('dn change on AD always deletes the old RDN; a kept old value is a problem; moves get newSuperior', () => {
  const ad = entry([['objectClass', ['top', 'user']], ['cn', ['Anna']], ['sAMAccountName', ['anna']]], 'CN=Anna,OU=Staff,DC=ad,DC=lab');
  const t = edited((ls) => ls.flatMap((l) => (l.startsWith('dn: ') ? ['dn: CN=Anna W,OU=Staff,DC=ad,DC=lab'] : l === 'cn: Anna' ? ['cn: Anna', 'cn: Anna W'] : [l])), ad, 'ad');
  const s = startLDIFEdit(ad, { serverType: 'ad' });
  const p = planLDIFEdit(s, t, { serverType: 'ad' });
  assert.ok(p.problems.some((x) => /Active Directory removes the old name/.test(x.message)), JSON.stringify(p.problems));
  const move = planLDIFEdit(s, s.text.replace('OU=Staff', 'OU=Former Staff'), { serverType: 'ad' });
  assert.deepEqual(move.rename, { oldDN: ad.dn, newDN: 'CN=Anna,OU=Former Staff,DC=ad,DC=lab', newRDN: 'CN=Anna', newSuperior: 'OU=Former Staff,DC=ad,DC=lab', deleteOldRDN: true });
  assert.equal(planSummary(move), 'Move');
  // only the case / blanks of the parent: no move
  const same = planLDIFEdit(s, s.text.replace('OU=Staff,DC=ad,DC=lab', 'ou=staff, dc=AD, dc=lab'), { serverType: 'ad' });
  assert.equal(same.rename, null);
  // a case-only RDN change is a rename (AD accepts it)
  assert.ok(planLDIFEdit(s, s.text.replace('dn: CN=Anna,', 'dn: CN=ANNA,'), { serverType: 'ad' }).rename);
});

test('changes are computed against the server state; conflicts are flagged, untouched attributes kept', () => {
  // On the server meanwhile: description changed (not touched here) and mail changed (touched here).
  const fresh = entry(BASE.attributes.map((a) =>
    a.name === 'description' ? ['description', ['changed by someone else']]
      : a.name === 'mail' ? ['mail', ['anna@demo.local', 'new@demo.local']]
        : [a.name, a.values, a.binary]) as [string, string[], boolean?][]);
  const t = edited((ls) => ls.filter((l) => l !== 'mail: a.schmidt@demo.local'));
  const p = plan(t, { fresh }).plan;
  assert.deepEqual(p.changes, [{ operation: 'replace', attribute: 'mail', values: ['anna@demo.local'], binary: false }], 'description is not reverted');
  assert.deepEqual(p.conflicts, ['mail']);
  assert.ok(p.rows[0].conflict);
  assert.ok(p.warnings.some((w) => /changed on the server/.test(w.message)));
  // a change the server already has is no change
  const t2 = edited((ls) => [...ls, 'mail: new@demo.local'].filter((l) => l !== 'mail: a.schmidt@demo.local'));
  assert.deepEqual(plan(t2, { fresh }).plan.changes, []);
});

test('a hidden attribute typed into the text is set to the typed values (managed ones warned)', () => {
  const t = edited((ls) => [...ls, 'entryUUID: 9999']);
  const p = plan(t).plan;
  assert.deepEqual(p.changes, [{ operation: 'replace', attribute: 'entryUUID', values: ['9999'], binary: false }]);
  assert.ok(p.warnings.some((w) => /maintained by the server/.test(w.message)));
  // the same value as stored: nothing
  assert.deepEqual(plan(edited((ls) => [...ls, 'entryUUID: 1111-2222'])).plan.changes, []);
});

test('lineOffset finds the start of a line', () => {
  const text = 'a\nbb\nccc\n';
  assert.equal(lineOffset(text, 1), 0);
  assert.equal(lineOffset(text, 2), 2);
  assert.equal(lineOffset(text, 3), 5);
  assert.equal(lineOffset(text, 9), text.length);
});

test('binary values are named in comment lines; comments never change the plan', () => {
  const describeBinary = (name: string, b64: string) => (b64 === CERT2 ? 'Anna Schmidt · Client Authentication · expires 2027-01-01' : undefined);
  const s = startLDIFEdit(BASE, { schema: SCHEMA, serverType: 'openldap', describeBinary });
  assert.ok(s.text.includes(`# userCertificate;binary: Anna Schmidt · Client Authentication · expires 2027-01-01\nuserCertificate;binary:: ${CERT2}`), s.text);
  assert.deepEqual(planLDIFEdit(s, s.text, { schema: SCHEMA }).changes, []);
  // removing the value but leaving its comment: only the value goes
  const t = s.text.replace(`userCertificate;binary:: ${CERT2}\n`, '');
  const p = planLDIFEdit(s, t, { schema: SCHEMA, describeBinary });
  assert.deepEqual(p.changes, [{ operation: 'delete', attribute: 'userCertificate;binary', values: [], binary: true }]);
  assert.deepEqual(p.rows[0].removed, ['Anna Schmidt · Client Authentication · expires 2027-01-01 · 12 bytes'], 'the review names the certificate');
});

test('objectClass stays in the text even when the schema marks it NO-USER-MODIFICATION (Samba)', () => {
  const samba = schemaIndex([sa('objectClass', { noUserMod: true }), sa('cn'), sa('name', { noUserMod: false })]);
  const ad = entry([['objectClass', ['top', 'user']], ['cn', ['Anna']], ['name', ['Anna']]], 'CN=Anna,DC=ad,DC=lab');
  const s = startLDIFEdit(ad, { schema: samba, serverType: 'ad' });
  assert.ok(s.text.includes('objectClass: user'));
  assert.deepEqual(s.hidden.map((h) => [h.name, h.reason]), [['name', 'managed']], 'AD name follows the RDN: maintained by the server');
});

test('only changed attributes are checked: an unchanged attribute missing from the subschema does not block', () => {
  const base = entry([['objectClass', ['inetOrgPerson']], ['cn', ['Anna Schmidt']], ['sn', ['S']], ['msDS-Constructed', ['x', 'y']]]);
  const s = startLDIFEdit(base, { schema: SCHEMA });
  assert.ok(s.text.includes('msDS-Constructed: x'));
  const p = planLDIFEdit(s, s.text.replace('sn: S', 'sn: T'), { schema: SCHEMA });
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.changes, [{ operation: 'replace', attribute: 'sn', values: ['T'], binary: false }]);
  const p2 = planLDIFEdit(s, s.text + 'fooBar: 1\n', { schema: SCHEMA });
  assert.ok(p2.problems.some((x) => /"fooBar" is not an attribute/.test(x.message)));
});
