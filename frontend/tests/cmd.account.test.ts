// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECKING_STATUS,
  accountDisplayState,
  bulkEnableCounts,
  defaultBulkEnable,
  mustChangeTitle,
  planBulkEnableRow,
  promisedToggle,
  toggleEnabledTitle,
  unlockSlot,
  type BulkEnableRow,
} from '../src/components/commands/accountDisplay.ts';

const server = (locked: boolean, enabled: boolean, mustChangePassword = false) => ({ locked, enabled, mustChangePassword });

test('the server status is complete: Unlock only when locked, specific Enable/Disable title', () => {
  const locked = accountDisplayState(server(true, true), undefined, undefined);
  assert.equal(unlockSlot(locked, true), 'offer');
  assert.equal(toggleEnabledTitle(locked), 'Disable Account');
  const fine = accountDisplayState(server(false, false), ['locked'], undefined);
  assert.equal(unlockSlot(fine, true), 'hidden', 'the server wins over stale row evidence (unlocked meanwhile)');
  assert.equal(toggleEnabledTitle(fine), 'Enable Account');
});

test('evidence of a search hit / report row shows Unlock at once (OL "(locked out)")', () => {
  const s = accountDisplayState(undefined, ['locked'], 'pending');
  assert.equal(unlockSlot(s, true), 'offer');
  assert.equal(toggleEnabledTitle(s), 'Enable/Disable Account', 'no evidence about enabled: neutral title');
});

test('while the status is read the Unlock slot holds a disabled placeholder (menus never shift)', () => {
  const reading = accountDisplayState(undefined, undefined, 'pending');
  assert.equal(unlockSlot(reading, true), 'checking');
  // About to read (connected, nothing known yet): the same placeholder at t0.
  assert.equal(unlockSlot(accountDisplayState(undefined, [], undefined), true), 'checking');
  // A missing state in the evidence is no evidence (a search returns only the attributes asked for).
  assert.equal(unlockSlot(accountDisplayState(undefined, ['disabled'], 'pending'), true), 'checking');
  assert.equal(CHECKING_STATUS, 'Checking account status…');
});

test('a failed read or no connection keeps Unlock offered (the handler reads and decides); no account hides it', () => {
  assert.equal(unlockSlot(accountDisplayState(undefined, undefined, 'failed'), true), 'offer');
  assert.equal(unlockSlot(accountDisplayState(undefined, undefined, undefined), false), 'offer');
  const na = accountDisplayState(undefined, undefined, 'na');
  assert.equal(unlockSlot(na, true), 'hidden');
  assert.ok(na.noAccount);
});

test('Enable/Disable and must-change titles, and what a clicked title promised', () => {
  assert.equal(toggleEnabledTitle(accountDisplayState(undefined, ['disabled'], undefined)), 'Enable Account');
  assert.equal(promisedToggle('Enable Account'), 'enable');
  assert.equal(promisedToggle('Disable Account'), 'disable');
  assert.equal(promisedToggle('Enable/Disable Account'), null);
  assert.equal(mustChangeTitle(accountDisplayState(server(false, true, true), undefined, undefined)), 'Clear "Must Change Password"');
  assert.equal(mustChangeTitle(accountDisplayState(undefined, undefined, 'pending')), 'Require Password Change at Next Logon');
});

test('bulk Enable/Disable plans every entry and defaults to Disable unless all are disabled', () => {
  const rows: BulkEnableRow[] = [
    { dn: 'cn=a', name: 'a', current: 'enabled' },
    { dn: 'cn=b', name: 'b', current: 'disabled' },
    { dn: 'cn=g', name: 'g', current: 'noAccount' },
    { dn: 'cn=x', name: 'x', current: 'unknown', error: 'timeout' },
  ];
  assert.equal(defaultBulkEnable(rows), false);
  assert.equal(defaultBulkEnable([rows[1]]), true);
  assert.equal(planBulkEnableRow(rows[0], false), 'change');
  assert.equal(planBulkEnableRow(rows[1], false), 'same');
  assert.equal(planBulkEnableRow(rows[2], false), 'noAccount');
  assert.equal(planBulkEnableRow(rows[3], true), 'unknown');
  assert.deepEqual(bulkEnableCounts(rows, true), { change: 1, same: 1, noAccount: 1, unknown: 1 });
});
