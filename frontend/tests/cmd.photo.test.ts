// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THUMBNAIL_MAX_BYTES, checkPhotoFile, defaultAlsoJpeg, photoTargets, planPhotoChanges, primaryPhotoAttribute } from '../src/components/commands/photoPlan.ts';

const b64 = (bytes: number[], pad = 0) => Buffer.from([...bytes, ...new Array(pad).fill(0)]).toString('base64');
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0], 100);
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 100);

test('AD writes thumbnailPhoto, and jpegPhoto too when asked (default: when the entry has one)', () => {
  assert.equal(primaryPhotoAttribute('ad'), 'thumbnailPhoto');
  assert.equal(primaryPhotoAttribute('openldap'), 'jpegPhoto');
  assert.deepEqual(photoTargets('ad', true), ['thumbnailPhoto', 'jpegPhoto']);
  assert.deepEqual(photoTargets('ad', false), ['thumbnailPhoto']);
  assert.deepEqual(photoTargets('389ds', true), ['jpegPhoto']);
  assert.ok(defaultAlsoJpeg({ jpegPhoto: [JPEG] }));
  assert.ok(!defaultAlsoJpeg({ thumbnailPhoto: [JPEG] }));
});

test('type and size are checked before anything is written', () => {
  assert.deepEqual(checkPhotoFile(JPEG, ['thumbnailPhoto']).problems, []);
  assert.match(checkPhotoFile(b64([1, 2, 3, 4], 50), ['jpegPhoto']).problems[0], /not a JPEG, PNG or GIF/);
  const big = b64([0xff, 0xd8, 0xff, 0xe0], THUMBNAIL_MAX_BYTES + 10);
  assert.match(checkPhotoFile(big, ['thumbnailPhoto']).problems[0], /at most 100\.0 KiB/);
  assert.deepEqual(checkPhotoFile(big, ['jpegPhoto']).problems, [], 'only thumbnailPhoto has the 100 KiB cap');
  assert.equal(checkPhotoFile(PNG, ['thumbnailPhoto', 'jpegPhoto']).warnings.length, 1, 'PNG in jpegPhoto warns');
});

test('one ModifyEntry: replace the first value of existing attributes, add new ones, binary', () => {
  const changes = planPhotoChanges(['thumbnailPhoto', 'jpegPhoto'], { thumbnailPhoto: [PNG], JPEGPhoto: [PNG, JPEG] }, JPEG);
  assert.deepEqual(changes, [
    { operation: 'replace', attribute: 'thumbnailPhoto', values: [JPEG], binary: true },
    { operation: 'replace', attribute: 'jpegPhoto', values: [JPEG, JPEG], binary: true },
  ]);
  assert.deepEqual(planPhotoChanges(['jpegPhoto'], {}, JPEG), [{ operation: 'add', attribute: 'jpegPhoto', values: [JPEG], binary: true }]);
  assert.deepEqual(planPhotoChanges(['jpegPhoto'], { jpegPhoto: [JPEG] }, JPEG), [], 'same picture: nothing to write');
});
