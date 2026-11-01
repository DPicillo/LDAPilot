// Certificate card texts (DEF-12) and the binary value picker list (DEF-13): components/editor/certificateCard.ts.
// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  binaryChoices, certAltNameLine, certAltNames, certChoiceLine, certExpiryNote, certPurpose, certWhen, choiceMeta, choiceTitle,
} from '../src/components/editor/certificateCard.ts';
import type { CertificateSummary } from '../src/types/binary';
import type { LDAPAttribute } from '../src/types/ldap';

function cert(extra: Partial<CertificateSummary> = {}): CertificateSummary {
  return {
    subject: 'CN=Anna Schmidt,OU=Staff,DC=ad,DC=lab', issuer: 'CN=Lab CA,DC=ad,DC=lab', serialNumber: '01', notBefore: '2026-01-01T00:00:00Z',
    notAfter: '2027-01-01T00:00:00Z', version: 3, signatureAlgorithm: 'SHA256-RSA', publicKeyAlgorithm: 'RSA', publicKeyBits: 2048, isCA: false,
    selfSigned: false, dnsNames: [], emailAddresses: ['anna@ad.lab'], ipAddresses: [], uris: [], upns: ['anna@ad.lab'], keyUsage: ['Digital Signature'],
    extKeyUsage: ['Client Authentication', 'Smart Card Logon'], subjectKeyId: '', authorityKeyId: '', sha1Fingerprint: '', sha256Fingerprint: '', size: 900, der: '',
    ...extra,
  };
}

const NOW = Date.parse('2026-11-01T12:00:00Z');

test('certPurpose: extended key usages first, else key usages', () => {
  assert.equal(certPurpose(cert()), 'Client Authentication · Smart Card Logon');
  assert.equal(certPurpose(cert({ extKeyUsage: [], keyUsage: ['Certificate Sign', 'CRL Sign'] })), 'Certificate Sign · CRL Sign');
  assert.equal(certPurpose(cert({ extKeyUsage: [], keyUsage: [] })), '');
});

test('certAltNameLine ranks UPN, email, DNS first and counts the rest', () => {
  const info = cert({
    altNames: [
      { type: 'DirName', value: 'CN=x' }, { type: 'DNS', value: 'h.ad.lab' }, { type: 'UPN', value: 'anna@ad.lab' },
      { type: 'otherName 1.2.3', value: 'ab:cd' },
    ],
  });
  const line = certAltNameLine(info);
  assert.equal(line.text, 'UPN anna@ad.lab · DNS h.ad.lab');
  assert.equal(line.more, 2);
  assert.equal(line.all, 'DirName: CN=x\nDNS: h.ad.lab\nUPN: anna@ad.lab\notherName 1.2.3: ab:cd', 'the tooltip keeps certificate order');
  // an older backend without altNames: rebuilt from the flat lists
  assert.deepEqual(certAltNames(cert()).map((n) => n.type), ['UPN', 'Email']);
  assert.equal(certAltNameLine(cert({ upns: [], emailAddresses: [] })).text, '');
});

test('certExpiryNote: expired, expiring within 30 days, not yet valid, valid', () => {
  assert.equal(certExpiryNote(cert(), NOW), null);
  assert.deepEqual(certExpiryNote(cert({ notAfter: '2026-11-13T12:00:00Z' }), NOW), { tone: 'warning', text: 'Expires in 12 days (2026-11-13)' });
  assert.deepEqual(certExpiryNote(cert({ notAfter: '2026-11-02T11:00:00Z' }), NOW), { tone: 'warning', text: 'Expires today (2026-11-02)' });
  assert.deepEqual(certExpiryNote(cert({ notAfter: '2026-09-22T12:00:00Z' }), NOW), { tone: 'danger', text: 'Expired 40 days ago (2026-09-22)' });
  assert.deepEqual(certExpiryNote(cert({ notAfter: '2026-10-31T12:00:00Z' }), NOW), { tone: 'danger', text: 'Expired 1 day ago (2026-10-31)' });
  assert.deepEqual(certExpiryNote(cert({ notBefore: '2026-11-06T12:00:00Z' }), NOW), { tone: 'warning', text: 'Not valid before 2026-11-06 (in 5 days)' });
});

test('certChoiceLine names the certificate, its first purposes and the expiry', () => {
  assert.equal(certChoiceLine(cert(), NOW), 'Anna Schmidt · Client Authentication, Smart Card Logon · expires 2027-01-01');
  assert.equal(certChoiceLine(cert({ notAfter: '2026-01-02T00:00:00Z', extKeyUsage: [] }), NOW), 'Anna Schmidt · expired 2026-01-02');
  assert.equal(certWhen(cert({ notBefore: '2026-12-01T00:00:00Z' }), NOW), 'valid from 2026-12-01');
});

test('binaryChoices lists every value of the named attributes in that order', () => {
  const jpeg = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4));
  const png = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
  const attrs: LDAPAttribute[] = [
    { name: 'jpegPhoto', values: [jpeg, png], binary: true },
    { name: 'cn', values: ['x'], binary: false },
    { name: 'thumbnailPhoto', values: [jpeg], binary: true },
    { name: 'userCertificate;binary', values: ['AAAA', 'BBBB'], binary: true },
  ];
  const photos = binaryChoices(attrs, ['thumbnailPhoto', 'jpegPhoto', 'photo']);
  assert.deepEqual(photos.map((c) => `${c.attribute}:${c.index}/${c.of}`), ['thumbnailPhoto:0/1', 'jpegPhoto:0/2', 'jpegPhoto:1/2']);
  assert.equal(choiceTitle(photos[0]), 'thumbnailPhoto');
  assert.equal(choiceTitle(photos[2]), 'jpegPhoto 2 of 2');
  assert.equal(choiceMeta(photos[1]), 'JPEG · 8 bytes');
  assert.equal(choiceMeta(photos[2]), 'PNG · 8 bytes');
  const certs = binaryChoices(attrs, ['userCertificate', 'userCertificate;binary', 'userSMIMECertificate']);
  assert.deepEqual(certs.map((c) => [c.attribute, c.index, c.kind]), [['userCertificate;binary', 0, 'certificate'], ['userCertificate;binary', 1, 'certificate']]);
  assert.equal(choiceMeta(certs[0]), 'Certificate data · 3 bytes');
  assert.deepEqual(binaryChoices(undefined, ['jpegPhoto']), []);
});

test('binaryValueLabel: certificate line, image format, nothing for other data', async () => {
  const { binaryValueLabel } = await import('../src/components/editor/certificateCard.ts');
  assert.equal(binaryValueLabel('userCertificate', 'AAAA', cert(), NOW), 'Anna Schmidt · Client Authentication, Smart Card Logon · expires 2027-01-01');
  assert.equal(binaryValueLabel('userCertificate', 'AAAA', null, NOW), undefined);
  assert.equal(binaryValueLabel('jpegPhoto', btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0)), null, NOW), 'JPEG image');
  assert.equal(binaryValueLabel('jpegPhoto', btoa('text'), null, NOW), 'not an image');
  assert.equal(binaryValueLabel('objectSid', 'AQ==', null, NOW), undefined);
});

test('nameColumnWidth: 220 px on wide tables, down to 140 px on narrow ones (RW1-E-13)', async () => {
  const { nameColumnWidth } = await import('../src/components/editor/certificateCard.ts');
  assert.equal(nameColumnWidth(0), 220, 'not measured yet');
  assert.equal(nameColumnWidth(1200), 220);
  assert.equal(nameColumnWidth(760), 220);
  assert.equal(nameColumnWidth(600), 168);
  assert.equal(nameColumnWidth(400), 140);
});
