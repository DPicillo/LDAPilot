// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opTone } from '../src/components/layout/opTone.ts';
import { deriveAccountStatus } from '../src/components/ui/accountStatus.ts';
import { createSourceTracker } from '../src/components/commands/selectionSource.ts';
import { accountStatusKinds } from '../src/stores/accountStatusCache.ts';

test('operations and audit log colour every operation the backend writes', () => {
  const expected: Record<string, string> = {
    CONNECT: 'text-op-connect', RECONNECT: 'text-op-connect',
    BIND: 'text-op-bind', BIND_CHECK: 'text-op-bind',
    SEARCH: 'text-op-search', ROOTDSE: 'text-op-search', REFERRAL: 'text-op-search', MEMBERSHIP: 'text-op-search',
    ADD: 'text-op-add', CREATE: 'text-op-add', ADD_ATTR: 'text-op-add', RESTORE: 'text-op-add',
    MODIFY: 'text-op-modify', PASSWD_MODIFY: 'text-op-modify', PWPOLICY: 'text-op-modify',
    RENAME: 'text-op-modrdn', MOVE: 'text-op-modrdn',
    DELETE: 'text-op-delete', DEL_ATTR: 'text-op-delete', TREE_DELETE: 'text-op-delete',
  };
  for (const [op, tone] of Object.entries(expected)) assert.equal(opTone(op), tone, op);
  assert.equal(opTone('tree_delete'), 'text-op-delete', 'case-insensitive');
  assert.equal(opTone('SUBTREE_DELETE'), 'text-op-delete', 'unknown names fall back to substrings');
  assert.equal(opTone('SOMETHING'), 'text-muted-foreground');
});

test('the OpenLDAP permanent lock is "disabled", a timed ppolicy lockout "locked"', () => {
  const disabled = deriveAccountStatus({ objectClass: ['inetOrgPerson'], pwdAccountLockedTime: '000001010000Z' });
  assert.deepEqual(disabled.map((s) => s.kind), ['disabled']);
  const locked = deriveAccountStatus({ objectClass: ['inetOrgPerson'], pwdAccountLockedTime: '20261030120000Z' });
  assert.deepEqual(locked.map((s) => s.kind), ['locked']);
});

test('AD account states only apply to accounts: groups, contacts and OUs get no chip', () => {
  const old = '20200101000000.0Z';
  // Samba/AD return UF_PASSWORD_EXPIRED (0x800000) in the computed UAC of non-accounts.
  const group = deriveAccountStatus({ objectClass: ['top', 'group'], 'msDS-User-Account-Control-Computed': '8388608', whenCreated: old }, { serverType: 'ad' });
  assert.deepEqual(group, [], 'group');
  const contact = deriveAccountStatus({ objectClass: ['top', 'person', 'organizationalPerson', 'contact'], 'msDS-User-Account-Control-Computed': '8388608' }, { serverType: 'ad' });
  assert.deepEqual(contact, [], 'contact');
  const ou = deriveAccountStatus({ objectClass: ['top', 'organizationalUnit'], 'msDS-User-Account-Control-Computed': '8388608', whenCreated: old }, { serverType: 'ad' });
  assert.deepEqual(ou, [], 'OU (no "Never logged on" either)');
  const user = deriveAccountStatus({ objectClass: ['top', 'person', 'organizationalPerson', 'user'], userAccountControl: '512', 'msDS-User-Account-Control-Computed': '8388624' }, { serverType: 'ad' });
  assert.deepEqual(user.map((s) => s.kind).sort(), ['locked', 'pwdExpired']);
  const computer = deriveAccountStatus({ objectClass: ['top', 'person', 'organizationalPerson', 'user', 'computer'], userAccountControl: '4098' });
  assert.deepEqual(computer.map((s) => s.kind), ['disabled']);
  // Without objectClass the attributes are taken as given.
  assert.deepEqual(deriveAccountStatus({ userAccountControl: '514' }).map((s) => s.kind), ['disabled']);
});

test('focus handed back by a closing overlay never changes the command selection source', () => {
  const t = createSourceTracker('tab');
  t.set('tree'); // tree-select A
  t.set('tab'); // Ctrl+K opens B: the new tab becomes active
  t.focus('tree', true); // the palette returns focus to the tree row
  assert.equal(t.current(), 'tab', 'menubar, palette and Ctrl+D / Shift+Alt+C act on B');
  t.focus('tree'); // the user clicks or tabs into the tree
  assert.equal(t.current(), 'tree');
  t.focus(null); // focus elsewhere (menubar, body) keeps the source
  assert.equal(t.current(), 'tree');
  t.focus('tab');
  assert.equal(t.current(), 'tab');
  t.set('results');
  t.reset();
  assert.equal(t.current(), 'tab');
});

test('server account status maps to the command status kinds', () => {
  const base = { dn: 'cn=a', serverType: 'ad', applicable: true, evaluated: '', enabled: true, locked: false, badPasswordCount: 0, passwordExpired: false, passwordNeverExpires: false, mustChangePassword: false, accountExpired: false };
  assert.deepEqual(accountStatusKinds(base as never), []);
  assert.deepEqual(accountStatusKinds({ ...base, locked: true, enabled: false, mustChangePassword: true } as never), ['locked', 'disabled', 'mustChange']);
});
