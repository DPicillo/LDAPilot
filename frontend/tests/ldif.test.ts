// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsBase64, foldLDIFLine, ldifAttrLine, formatEntryAsLDIF, formatEntriesAsLDIF, utf8ToBase64 } from '../src/lib/ldif.ts';

/** Minimal RFC 2849 reader: unfold, split "name: value" / "name:: base64". */
function parseRecord(text: string): { name: string; value: string; b64: boolean }[] {
  const unfolded = text.replace(/\n /g, '');
  return unfolded.split('\n').filter(Boolean).map((line) => {
    const i = line.indexOf(':');
    const b64 = line[i + 1] === ':';
    return { name: line.slice(0, i), value: line.slice(i + (b64 ? 3 : 2)), b64 };
  });
}

function decodeUtf8(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

test('needsBase64 follows SAFE-STRING rules', () => {
  for (const v of [' lead', ':colon', '<angle', 'trail ', 'a\nb', 'cr\r', 'nul\0', 'tab\t', 'del\x7f', 'Jürgen', '日本']) {
    assert.equal(needsBase64(v), true, JSON.stringify(v));
  }
  for (const v of ['', 'plain', 'with inner space', 'a:b', 'a<b', 'mail@example.org', 'CN=x,DC=y']) {
    assert.equal(needsBase64(v), false, JSON.stringify(v));
  }
});

test('foldLDIFLine folds at 76 columns with one leading space per continuation', () => {
  const line = 'description: ' + 'x'.repeat(200);
  const folded = foldLDIFLine(line);
  const parts = folded.split('\n');
  assert.equal(parts[0].length, 76);
  for (const p of parts.slice(1)) {
    assert.ok(p.startsWith(' '));
    assert.ok(p.length <= 76);
  }
  assert.equal(folded.replace(/\n /g, ''), line);
  assert.equal(foldLDIFLine('short: line'), 'short: line');
  assert.equal(foldLDIFLine('x'.repeat(76)), 'x'.repeat(76));
  assert.equal(foldLDIFLine(line, 0), line);
});

test('foldLDIFLine never splits a surrogate pair', () => {
  const line = 'a'.repeat(75) + '😀' + 'b';
  const parts = foldLDIFLine(line).split('\n');
  assert.equal(Array.from(parts[0]).length, 76);
  assert.ok(parts[0].endsWith('😀'));
});

test('ldifAttrLine writes binary values unchanged and encodes unsafe text', () => {
  assert.equal(ldifAttrLine('jpegPhoto', '/9j/4AAQ', true), 'jpegPhoto:: /9j/4AAQ');
  assert.equal(ldifAttrLine('cn', 'John'), 'cn: John');
  assert.equal(ldifAttrLine('cn', 'Jürgen'), `cn:: ${utf8ToBase64('Jürgen')}`);
  assert.equal(ldifAttrLine('description', 'x '), 'description:: eCA=');
});

test('formatEntryAsLDIF round-trips tricky values and folds long lines', () => {
  const photo = btoa(String.fromCharCode(...Array.from({ length: 3000 }, (_, i) => (i * 7) & 0xff)));
  const values = [' lead', ':colon', '<angle', 'trail ', 'multi\nline', 'Zoë Ångström 日本', 'x'.repeat(300), 'plain'];
  const dn = 'cn=Jürgen Weiß-Özdemir,ou=People,dc=example';
  const out = formatEntryAsLDIF(dn, {
    attributes: [
      { name: 'description', values },
      { name: 'jpegPhoto', values: [photo], binary: true },
    ],
  });
  assert.ok(out.endsWith('\n'));
  for (const line of out.split('\n')) assert.ok(line.length <= 76, `line too long: ${line.length}`);
  const rec = parseRecord(out);
  assert.equal(rec[0].name, 'dn');
  assert.equal(rec[0].b64, true);
  assert.equal(decodeUtf8(rec[0].value), dn);
  const desc = rec.filter((r) => r.name === 'description').map((r) => (r.b64 ? decodeUtf8(r.value) : r.value));
  assert.deepEqual(desc, values);
  const jpeg = rec.find((r) => r.name === 'jpegPhoto')!;
  assert.equal(jpeg.b64, true);
  assert.equal(jpeg.value, photo);
});

test('formatEntriesAsLDIF writes a version header and blank lines between records', () => {
  const out = formatEntriesAsLDIF([
    { dn: 'cn=a,dc=x', attributes: [{ name: 'cn', values: ['a'] }] },
    { dn: 'cn=b,dc=x', attributes: [{ name: 'cn', values: ['b'] }] },
  ]);
  assert.equal(out, 'version: 1\n\ndn: cn=a,dc=x\ncn: a\n\ndn: cn=b,dc=x\ncn: b\n');
});

// --- AD values shown as text go back to raw bytes (mirror of Go ldap.RawADValues) ---
import { rawADValue, sortParentFirst } from '../src/lib/ldif.ts';

function b64Bytes(b64: string): number[] {
  return [...atob(b64)].map((c) => c.charCodeAt(0));
}

// Same vectors as internal/ldap/ad_format_test.go
const GUID_RAW = [0x7e, 0xd5, 0x60, 0x9c, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x01, 0x02, 0x03, 0x04];
const GUID_TEXT = '9c60d57e-3412-7856-9abc-def001020304';
const SID_RAW = [1, 5, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xe9, 0x03, 0, 0];
const SID_TEXT = 'S-1-5-21-1144201745-2289526357-3434850969-1001';

test('rawADValue turns objectGUID / objectSid text back into the raw bytes', () => {
  assert.deepEqual(b64Bytes(rawADValue('objectGUID', GUID_TEXT)!), GUID_RAW);
  assert.deepEqual(b64Bytes(rawADValue('msExchMailboxGuid', GUID_TEXT.toUpperCase())!), GUID_RAW);
  assert.deepEqual(b64Bytes(rawADValue('objectSid', SID_TEXT)!), SID_RAW);
  assert.deepEqual(b64Bytes(rawADValue('objectSid;binary', 'S-1-1-0')!), [1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
  for (const [name, value] of [['objectGUID', 'not-a-guid'], ['objectSid', 'S-1-x'], ['cn', GUID_TEXT], ['objectSid', 'S-1-281474976710656']]) {
    assert.equal(rawADValue(name, value), null, `${name}: ${value}`);
  }
});

test('formatEntryAsLDIF writes AD-formatted values as raw base64 (re-importable), binary values unchanged', () => {
  const out = formatEntryAsLDIF('CN=x,DC=ad', {
    attributes: [
      { name: 'objectGUID', values: [GUID_TEXT] },
      { name: 'objectSid', values: [SID_TEXT] },
      { name: 'objectGUID', values: ['fn6BOA=='], binary: true },
      { name: 'cn', values: ['x'] },
    ],
  });
  const recs = parseRecord(out);
  assert.deepEqual(recs.map((r) => [r.name, r.b64]), [['dn', false], ['objectGUID', true], ['objectSid', true], ['objectGUID', true], ['cn', false]]);
  assert.deepEqual(b64Bytes(recs[1].value), GUID_RAW);
  assert.deepEqual(b64Bytes(recs[2].value), SID_RAW);
  assert.equal(recs[3].value, 'fn6BOA==');
  // One value that does not parse: the attribute stays text (never half converted)
  const mixed = parseRecord(formatEntryAsLDIF('CN=x', { attributes: [{ name: 'objectSid', values: [SID_TEXT, 'garbage'] }] }));
  assert.deepEqual(mixed.slice(1).map((r) => [r.value, r.b64]), [[SID_TEXT, false], ['garbage', false]]);
});

test('sortParentFirst puts every parent before its children (stable, escape-aware depth)', () => {
  const entries = [
    { dn: 'CN=Schmidt\\, Anna,OU=Sub,OU=Top,DC=x' },
    { dn: 'OU=Sub,OU=Top,DC=x' },
    { dn: 'CN=b,OU=Top,DC=x' },
    { dn: 'OU=Top,DC=x' },
    { dn: 'CN=a,OU=Top,DC=x' },
  ];
  assert.deepEqual(sortParentFirst(entries).map((e) => e.dn), [
    'OU=Top,DC=x', 'OU=Sub,OU=Top,DC=x', 'CN=b,OU=Top,DC=x', 'CN=a,OU=Top,DC=x', 'CN=Schmidt\\, Anna,OU=Sub,OU=Top,DC=x',
  ]);
});

test('sortParentFirst puts referenced entries of the list first (member, manager), cycles do not loop', () => {
  const e = (dn: string, attrs: Record<string, string[]> = {}) => ({ dn, attributes: Object.entries(attrs).map(([name, values]) => ({ name, values })) });
  const out = sortParentFirst([
    e('CN=Team,OU=Src,DC=ad,DC=lab', { member: ['cn=anna, ou=src,dc=AD,dc=lab', 'CN=Outside,DC=ad,DC=lab'] }),
    e('CN=Anna,OU=Src,DC=ad,DC=lab', { manager: ['CN=Boss,OU=Sub,OU=Src,DC=ad,DC=lab'] }),
    e('OU=Src,DC=ad,DC=lab'),
    e('CN=Boss,OU=Sub,OU=Src,DC=ad,DC=lab'),
    e('OU=Sub,OU=Src,DC=ad,DC=lab'),
    e('CN=x,OU=Src,DC=ad,DC=lab', { seeAlso: ['CN=y,OU=Src,DC=ad,DC=lab'] }),
    e('CN=y,OU=Src,DC=ad,DC=lab', { seeAlso: ['CN=x,OU=Src,DC=ad,DC=lab'] }),
  ]);
  assert.deepEqual(out.map((x) => x.dn.split(',')[0]), ['OU=Src', 'OU=Sub', 'CN=Boss', 'CN=Anna', 'CN=Team', 'CN=x', 'CN=y']);
});
