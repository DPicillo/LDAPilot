// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newConnectionProfile } from '../src/types/ldap.ts';
import { ntlmDomainFromUser, portForTLSMode, splitPEMCertificates, validateConnectionForm } from '../src/lib/connectionAuth.ts';

const valid = () => ({ ...newConnectionProfile(), name: 'OL', host: 'ol', bindDN: 'cn=admin', password: 'x', tlsMode: 'starttls' as const });

test('page size 1-5000 and timeout 1-600 are validated', () => {
  assert.deepEqual(validateConnectionForm(valid(), null).errors, {});
  for (const pageSize of [0, -3, 5001, 2.5, Number.NaN]) {
    assert.ok(validateConnectionForm({ ...valid(), pageSize }, null).errors.pageSize, `page size ${pageSize}`);
  }
  for (const timeout of [0, -5, 601, Number.NaN]) {
    assert.ok(validateConnectionForm({ ...valid(), timeout }, null).errors.timeout, `timeout ${timeout}`);
  }
  assert.equal(validateConnectionForm({ ...valid(), pageSize: 5000, timeout: 600 }, null).errors.pageSize, undefined);
  assert.equal(validateConnectionForm({ ...valid(), pageSize: 1, timeout: 1 }, null).errors.timeout, undefined);
});

test('the disabled NTLM domain shows the domain of the user name', () => {
  assert.equal(ntlmDomainFromUser('LDAPILOT\\Administrator'), 'LDAPILOT');
  assert.equal(ntlmDomainFromUser('Administrator@ad.ldapilot.lab'), 'ad.ldapilot.lab');
  assert.equal(ntlmDomainFromUser('Administrator'), '');
  assert.equal(ntlmDomainFromUser(''), '');
});

test('Global Catalog ports follow the TLS mode like 389/636', () => {
  assert.equal(portForTLSMode(3268, 'ssl'), 3269);
  assert.equal(portForTLSMode(3269, 'starttls'), 3268);
  assert.equal(portForTLSMode(3269, 'none'), 3268);
  assert.equal(portForTLSMode(389, 'ssl'), 636);
  assert.equal(portForTLSMode(2636, 'none'), 2636);
});

test('PEM text splits into certificate blocks', () => {
  const a = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
  const b = '-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----';
  assert.deepEqual(splitPEMCertificates(`${a}\n\n${b}\n`), [a, b]);
  assert.deepEqual(splitPEMCertificates(''), []);
  assert.deepEqual(splitPEMCertificates('-----BEGIN CERTIFICATE-----\nhalf'), []);
});
