// UX loop round 2: Edit Entry open inputs, clipboard lines, deleted-object restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageOpenInputs } from '../src/lib/entryChanges.ts';
import { attributeLines } from '../src/lib/attributeGroups.ts';
import { blockedByDeletedParent, deletedParentHint } from '../src/lib/recycle.ts';

test('Edit Entry saves a value typed but not added with Enter (RW1-E-02)', () => {
  const working = new Map([['mobile', ['+49 171 1234567']], ['cn', ['x']]]);
  const r = stageOpenInputs(working, { add: { attr: 'otherMobile', value: ' +49 171 7654321 ' } });
  assert.deepEqual(r.attrs.get('otherMobile'), ['+49 171 7654321']);
  assert.equal(r.staged, 1);
  assert.equal(r.blocked, null);
  assert.equal(working.has('otherMobile'), false, 'the working copy is not mutated');
  // An empty add row adds nothing.
  assert.equal(stageOpenInputs(working, { add: { attr: 'otherMobile', value: '  ' } }).staged, 0);
  // A second value for an attribute that has one.
  assert.deepEqual(stageOpenInputs(working, { add: { attr: 'mobile', value: '+1' } }).attrs.get('mobile'), ['+49 171 1234567', '+1']);
  // The inline editor: changed text is staged, unchanged text is not.
  assert.equal(stageOpenInputs(working, { edit: { attr: 'mobile', value: '+49 171 1234567' } }).staged, 0);
  const e = stageOpenInputs(working, { edit: { attr: 'mobile', value: '+1\n\n+2' } });
  assert.deepEqual(e.attrs.get('mobile'), ['+1', '+2']);
  assert.equal(e.staged, 1);
  // Clearing the inline editor removes the attribute.
  assert.equal(stageOpenInputs(working, { edit: { attr: 'mobile', value: '' } }).attrs.has('mobile'), false);
  // A password must be confirmed first; Save waits with a reason.
  const pw = stageOpenInputs(working, { edit: { attr: 'userPassword', value: 'secret', password: true, ready: false } });
  assert.match(pw.blocked ?? '', /Confirm the new userPassword/);
  const pwOk = stageOpenInputs(working, { edit: { attr: 'userPassword', value: 'secret', password: true, ready: true } });
  assert.deepEqual(pwOk.attrs.get('userPassword'), ['secret']);
  assert.deepEqual(pwOk.passwordAttrs, ['userPassword']);
  // The add row keeps a password's blanks.
  assert.deepEqual(stageOpenInputs(working, { add: { attr: 'userPassword', value: ' a b ', password: true } }).attrs.get('userPassword'), [' a b ']);
});

test('binary values are copied as LDIF "attr:: base64" (RW1-E-12)', () => {
  assert.equal(attributeLines('jpegPhoto', ['/9j/4AAQ', 'iVBOR'], true), 'jpegPhoto:: /9j/4AAQ\njpegPhoto:: iVBOR');
  assert.equal(attributeLines('mail', ['a@x', 'b@x']), 'mail: a@x\nmail: b@x');
});

test('Restore refuses a child whose container is deleted too, unless the container is selected (M-32)', () => {
  const parent = { dn: 'OU=del\\0ADEL:1,CN=Deleted Objects,DC=x', lastKnownParent: 'DC=x', parentDeleted: false };
  const child = { dn: 'CN=c\\0ADEL:2,CN=Deleted Objects,DC=x', lastKnownParent: 'OU=del\\0ADEL:1,CN=Deleted Objects,DC=x', parentDeleted: true };
  assert.deepEqual(blockedByDeletedParent([child]), [child]);
  assert.deepEqual(blockedByDeletedParent([child, parent]), [], 'with its container: restored in order');
  assert.deepEqual(blockedByDeletedParent([parent]), []);
  assert.match(deletedParentHint(1), /Restore to/);
  assert.match(deletedParentHint(2), /2 selected objects/);
});

test('Clear Audit Log: the connection name confirms without the middle dot or case (RW1-R-07)', async () => {
  const { typedNameMatches } = await import('../src/lib/recycle.ts');
  assert.equal(typedNameMatches('lab samba ad ldaps', 'Lab · Samba AD (LDAPS)'), true);
  assert.equal(typedNameMatches('Lab . Samba AD (LDAPS)', 'Lab · Samba AD (LDAPS)'), true);
  assert.equal(typedNameMatches('Lab Samba AD', 'Lab · Samba AD (LDAPS)'), false, 'every letter counts');
  assert.equal(typedNameMatches('', '···'), false);
  assert.equal(typedNameMatches('muller', 'Müller'), true);
});

test('Compare shows binary values as a summary with a fingerprint (RW1-E-08)', async () => {
  const { binaryValueSummary } = await import('../src/lib/binary.ts');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(2000).fill(1)]).toString('base64');
  const s = binaryValueSummary('thumbnailPhoto', jpeg);
  assert.match(s, /^JPEG image · /);
  assert.match(s, /· #[0-9a-f]{8}$/);
  assert.notEqual(binaryValueSummary('thumbnailPhoto', jpeg), binaryValueSummary('thumbnailPhoto', jpeg.slice(0, -4) + 'AAAA'));
  assert.match(binaryValueSummary('userCertificate', 'MIIB'), /^Certificate · /);
});
