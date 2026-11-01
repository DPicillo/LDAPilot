// UX loop round 2: row status merge, one account read per change, kinds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRowStatus, mergeRowStatus, type AccountStatus } from '../src/components/ui/accountStatus.ts';
import { createSharedReader } from '../src/lib/sharedRead.ts';
import { nodeKind, resolveObjectKind } from '../src/components/ui/objectKind.ts';
import { objectTypeFromClasses } from '../src/lib/membership.ts';

const expiresSoon: AccountStatus = { kind: 'expiresSoon', label: 'Expires in 5 days', source: { attribute: 'accountExpires', raw: '1' } } as AccountStatus;
const stale: AccountStatus = { kind: 'stale', label: 'Never logged on', source: { attribute: 'lastLogonTimestamp', raw: '0' } } as AccountStatus;
const disabled: AccountStatus = { kind: 'disabled', label: 'Disabled', source: { attribute: 'userAccountControl', raw: '514' } } as AccountStatus;

test('a cached server status never removes "Expires in n days" / inactivity chips (RW1-P-01)', () => {
  // Opening the entry cached its status (no lock, enabled): the attribute-only chips stay.
  assert.deepEqual(mergeRowStatus([], [expiresSoon]), [expiresSoon]);
  assert.deepEqual(mergeRowStatus(['pwdNeverExpires'], [expiresSoon, stale]), ['pwdNeverExpires', expiresSoon, stale]);
  // The server decides the states it knows: an enable done elsewhere removes "Disabled".
  assert.deepEqual(mergeRowStatus([], [disabled, expiresSoon]), [expiresSoon]);
  // A server state also seen in the attributes keeps the attribute's label and dates.
  assert.deepEqual(mergeRowStatus(['disabled', 'locked'], [disabled]), [disabled, 'locked']);
  // Unknown server status: the attributes alone.
  assert.deepEqual(mergeRowStatus(undefined, [disabled, expiresSoon]), [disabled, expiresSoon]);
  // End to end with real attributes: accountExpires in 5 days.
  const now = Date.now();
  const ft = String(BigInt(now + 5 * 86400_000 + 3600_000) * 10000n + 116444736000000000n);
  const derived = deriveRowStatus({ objectClass: ['top', 'person', 'organizationalPerson', 'user'], userAccountControl: ['512'], accountExpires: [ft] } as any);
  const merged = mergeRowStatus([], derived);
  assert.ok(merged.some((s) => typeof s === 'object' && s.kind === 'expiresSoon'), JSON.stringify(merged));
});

test('views reacting to one account change share one read (RW1-P-06)', async () => {
  let t = 1000;
  let calls = 0;
  const reader = createSharedReader(async (k: string) => {
    calls++;
    return `${k}#${calls}`;
  }, 1500, () => t);
  const a = await reader.read('p\ndn');
  const b = await reader.read('p\ndn');
  assert.equal(a, b);
  assert.equal(calls, 1, 'editor tab, Account tab and tree overlay: one read');
  t += 1600;
  assert.equal(await reader.read('p\ndn'), 'p\ndn#2', 'older than the window: read anew');
  assert.equal(await reader.read('p\ndn', 0), 'p\ndn#3', 'after a write: always a new read');
  assert.equal(await reader.read('p\ndn'), 'p\ndn#3', '… which the others then share');
  reader.seed('p\ndn', 'given');
  assert.equal(await reader.read('p\ndn'), 'given', 'the emitter passed the fresh status');
  reader.forget('p\ndn');
  assert.equal(await reader.read('p\ndn'), 'p\ndn#4', 'a status-less change forgets older reads');
  // A failed read is not shared.
  let fail = true;
  const flaky = createSharedReader(async () => {
    if (fail) throw new Error('down');
    return 'ok';
  }, 1500, () => t);
  await assert.rejects(flaky.read('k'));
  await new Promise((r) => setTimeout(r, 0));
  fail = false;
  assert.equal(await flaky.read('k'), 'ok');
});

test('an LDAP contact is a contact in the tree from the first view (M-06)', () => {
  const oc = ['top', 'person', 'organizationalPerson', 'inetOrgPerson'];
  assert.equal(nodeKind({ objectClass: oc, loginAttributes: [] }), 'contact');
  assert.equal(nodeKind({ objectClass: oc, loginAttributes: ['uid'] }), 'user');
  assert.equal(nodeKind({ objectClass: oc, loginAttributes: ['userPassword'] }), 'user');
  assert.equal(nodeKind({ objectClass: oc, loginAttributes: null }), 'user', 'unknown: stays a user');
  assert.equal(nodeKind({ objectClass: oc }), 'user');
  assert.equal(resolveObjectKind(['inetOrgPerson', 'posixAccount'], []), 'user', 'an account class wins');
});

test('membership rows type an LDAP device as computer (M-05)', () => {
  assert.equal(objectTypeFromClasses(['top', 'device']), 'computer');
  assert.equal(objectTypeFromClasses(['ipHost', 'device']), 'computer');
  assert.equal(objectTypeFromClasses(['top', 'groupOfNames']), 'group');
});

test('the LDAP Container template entry (organizationalRole) is a container (M-08)', () => {
  assert.equal(resolveObjectKind(['top', 'organizationalRole']), 'container');
});
