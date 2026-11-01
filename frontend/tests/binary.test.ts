// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attrBaseName, binaryKind, isBinaryAttributeName, base64ByteLength, base64ToBytes, bytesToBase64,
  sniffImageMime, imageDataUrl, formatByteSize, hexPreview, asciiPreview, hexDump, toPEM, certValidity, commonName, binaryTransferName,
  isPKCS7SignedData, isSMIMEAttribute,
} from '../src/lib/binary.ts';

test('attribute classification', () => {
  assert.equal(attrBaseName('userCertificate;binary'), 'usercertificate');
  assert.equal(binaryKind('jpegPhoto'), 'image');
  assert.equal(binaryKind('thumbnailPhoto'), 'image');
  assert.equal(binaryKind('userCertificate;binary'), 'certificate');
  assert.equal(binaryKind('cACertificate'), 'certificate');
  assert.equal(binaryKind('nTSecurityDescriptor'), 'security-descriptor');
  assert.equal(binaryKind('dnsRecord'), 'other');
  assert.equal(isBinaryAttributeName('jpegPhoto'), true);
  assert.equal(isBinaryAttributeName('foo;binary'), true);
  assert.equal(isBinaryAttributeName('x', '1.3.6.1.4.1.1466.115.121.1.28'), true);
  assert.equal(isBinaryAttributeName('x', '1.3.6.1.4.1.1466.115.121.1.8{32}'), true);
  // Octet String is not treated as binary (OpenLDAP userPassword)
  assert.equal(isBinaryAttributeName('userPassword', '1.3.6.1.4.1.1466.115.121.1.40'), false);
  assert.equal(isBinaryAttributeName('mail', '1.3.6.1.4.1.1466.115.121.1.26'), false);
});

test('base64 helpers', () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253]);
  const b64 = bytesToBase64(bytes);
  assert.equal(b64, 'AAEC+vv8/Q==');
  assert.equal(base64ByteLength(b64), 7);
  assert.equal(base64ByteLength('AAEC'), 3);
  assert.equal(base64ByteLength('AAE='), 2);
  assert.equal(base64ByteLength(''), 0);
  assert.deepEqual(Array.from(base64ToBytes(b64)), Array.from(bytes));
  assert.deepEqual(Array.from(base64ToBytes(b64, 4)), [0, 1, 2, 250]);
  assert.equal(base64ToBytes('%%%').length, 0);
});

test('image sniffing', () => {
  const jpeg = bytesToBase64(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]));
  const png = bytesToBase64(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]));
  const gif = btoa('GIF89a\x01\x00');
  assert.equal(sniffImageMime(base64ToBytes(jpeg)), 'image/jpeg');
  assert.equal(sniffImageMime(base64ToBytes(png)), 'image/png');
  assert.equal(sniffImageMime(base64ToBytes(gif)), 'image/gif');
  assert.equal(sniffImageMime(base64ToBytes(btoa('GIF88a'))), null);
  assert.equal(sniffImageMime(new Uint8Array(0)), null);
  assert.equal(imageDataUrl(png), `data:image/png;base64,${png}`);
  assert.equal(imageDataUrl(btoa('hello')), null);
});

test('size and hex formatting', () => {
  assert.equal(formatByteSize(1), '1 byte');
  assert.equal(formatByteSize(812), '812 bytes');
  assert.equal(formatByteSize(12595), '12.3 KiB');
  assert.equal(formatByteSize(1572864), '1.5 MiB');
  const b = Uint8Array.from([1, 0, 4, 0x8c, 0x41, 0x7f]);
  assert.equal(hexPreview(b, 4), '01 00 04 8C …');
  assert.equal(hexPreview(b, 16), '01 00 04 8C 41 7F');
  assert.equal(hexPreview(b.subarray(0, 2), 16, 100), '01 00 …');
  assert.equal(asciiPreview(b, 16), '....A.');
  assert.equal(asciiPreview(Uint8Array.from([0x4e, 0x54, 0x4c, 0x4d]), 2), 'NT…');
  assert.equal(asciiPreview(Uint8Array.from([0x41]), 16, 300), 'A…');
  const dump = hexDump(Uint8Array.from([...Array(18).keys()].map((i) => i + 0x3e)));
  const lines = dump.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '00000000  3E 3F 40 41 42 43 44 45  46 47 48 49 4A 4B 4C 4D  |>?@ABCDEFGHIJKLM|');
  assert.ok(lines[1].startsWith('00000010  4E 4F '));
  assert.ok(lines[1].endsWith('|NO|'));
  assert.equal(lines[1].length, lines[0].length - 14);
});

test('toPEM wraps at 64 columns', () => {
  const b64 = 'A'.repeat(130);
  const pem = toPEM(b64);
  const lines = pem.trimEnd().split('\n');
  assert.equal(lines[0], '-----BEGIN CERTIFICATE-----');
  assert.equal(lines[1].length, 64);
  assert.equal(lines[3], 'AA');
  assert.equal(lines[4], '-----END CERTIFICATE-----');
});

test('certValidity', () => {
  const nb = '2025-01-01T00:00:00Z';
  const na = '2026-01-01T00:00:00Z';
  assert.deepEqual(certValidity(nb, na, Date.parse('2024-12-30T00:00:00Z')), { status: 'not-yet-valid', days: 2 });
  assert.deepEqual(certValidity(nb, na, Date.parse('2025-06-01T00:00:00Z')), { status: 'valid', days: 214 });
  assert.deepEqual(certValidity(nb, na, Date.parse('2025-12-20T00:00:00Z')), { status: 'expiring', days: 12 });
  assert.deepEqual(certValidity(nb, na, Date.parse('2026-01-11T00:00:00Z')), { status: 'expired', days: 10 });
  assert.equal(certValidity(nb, na, new Date('2025-12-20T00:00:00Z'), 7).status, 'valid');
});

test('commonName', () => {
  assert.equal(commonName('CN=John Doe,O=Example'), 'John Doe');
  assert.equal(commonName('O=Example,CN=Doe\\, John'), 'Doe, John');
  assert.equal(commonName('O=Example'), 'O=Example');
});

test('binaryTransferName adds ;binary only for certificate syntaxes', () => {
  assert.equal(binaryTransferName('userCertificate', '1.3.6.1.4.1.1466.115.121.1.8'), 'userCertificate;binary');
  assert.equal(binaryTransferName('userCertificate;binary', '1.3.6.1.4.1.1466.115.121.1.8'), 'userCertificate;binary');
  assert.equal(binaryTransferName('userCertificate', '1.3.6.1.4.1.1466.115.121.1.40'), 'userCertificate'); // 389DS
  assert.equal(binaryTransferName('userCertificate', ''), 'userCertificate'); // AD (no syntax in subschema)
  assert.equal(binaryTransferName('jpegPhoto', '1.3.6.1.4.1.1466.115.121.1.28'), 'jpegPhoto');
});

test('isPKCS7SignedData recognizes DER and indefinite-length (BER) SignedData', () => {
  // first bytes of `openssl crl2pkcs7 -outform DER` and `openssl cms -sign -stream -outform DER` output
  assert.equal(isPKCS7SignedData(base64ToBytes('MIIDxAYJKoZIhvcNAQcCoIIDtTCCA7EC')), true);
  assert.equal(isPKCS7SignedData(base64ToBytes('MIAGCSqGSIb3DQEHAqCAMIACAQExDTAL')), true);
  // an X.509 certificate, PEM text, short or empty input
  assert.equal(isPKCS7SignedData(base64ToBytes('MIIDlTCCAn2gAwIBAgIUKbwcJEWY+1q3')), false);
  assert.equal(isPKCS7SignedData(base64ToBytes('LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0t')), false);
  assert.equal(isPKCS7SignedData(Uint8Array.from([0x30, 0x80, 0x06, 0x09])), false);
  assert.equal(isPKCS7SignedData(new Uint8Array(0)), false);
  assert.equal(isSMIMEAttribute('userSMIMECertificate'), true);
  assert.equal(isSMIMEAttribute('usersmimecertificate;binary'), true);
  assert.equal(isSMIMEAttribute('userCertificate'), false);
  assert.equal(binaryKind('userSMIMECertificate'), 'certificate');
});
