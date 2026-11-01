// Readable account values on the approval card (lib/aiDecode.ts, A-25).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAttrValue, describeUacChange, describeUacFlags } from '../../src/lib/aiDecode.ts';

test('userAccountControl and its change', () => {
  assert.equal(decodeAttrValue('userAccountControl', '512'), 'Normal account');
  assert.equal(decodeAttrValue('userAccountControl', '514'), 'Account disabled · Normal account');
  assert.equal(decodeAttrValue('userAccountControl', '66048'), 'Normal account · Password never expires');
  assert.equal(describeUacFlags(0x40000000), '0x40000000');
  assert.deepEqual(describeUacChange(['512'], ['514']), { text: 'sets Account disabled', danger: [] });
  assert.deepEqual(describeUacChange(['514'], ['512']), { text: 'clears Account disabled', danger: [] });
  const d = describeUacChange(['512'], ['4194816']);
  assert.equal(d.text, 'sets No Kerberos pre-authentication');
  assert.equal(d.danger.length, 1);
  assert.equal(describeUacChange(['512'], ['512']), null);
  assert.equal(describeUacChange([], ['x']), null);
});

test('password and lockout attributes', () => {
  assert.equal(decodeAttrValue('pwdLastSet', '0'), 'Must change at next logon');
  assert.equal(decodeAttrValue('pwdLastSet', '-1'), 'Set to now (clears “must change at next logon”)');
  assert.equal(decodeAttrValue('lockoutTime', '0'), 'Not locked');
  assert.equal(decodeAttrValue('accountExpires', '9223372036854775807'), 'Never');
  // same label as the Account tab and exports (lib/accountTime.ts, accounts batch)
  assert.equal(decodeAttrValue('pwdAccountLockedTime', '000001010000Z'), 'Permanent (disabled)');
  assert.equal(decodeAttrValue('pwdReset', 'TRUE'), 'Must change the password at the next bind');
  assert.equal(decodeAttrValue('nsAccountLock', 'true'), 'Account disabled');
  assert.match(decodeAttrValue('pwdLastSet', '134379507185307023') ?? '', /20\d\d/);
  assert.equal(decodeAttrValue('description', 'hello'), null);
  assert.equal(decodeAttrValue('groupType', '-2147483646'), 'Global security group');
  assert.equal(decodeAttrValue('groupType', '8'), 'Universal distribution group');
});
