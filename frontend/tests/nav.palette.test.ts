// Run: cd frontend && node --test 'tests/*.test.ts'
// FIN-W-02 (primary account verb in the palette) and the hit names (RDN value + display name).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { primaryAccountVerb } from '../src/components/ui/primaryAction.ts';
import { entryHitLabel } from '../src/components/ui/hitLabel.ts';

const items = [
  { id: 'entry.showInTree', enabled: true },
  { id: 'account.unlock', enabled: false },
  { id: 'account.toggleEnabled', enabled: true },
  { id: 'account.resetPassword', enabled: true },
];

test('the primary verb: Unlock when locked, Enable when disabled, else Reset Password', () => {
  assert.equal(primaryAccountVerb(items, [])?.id, 'account.resetPassword', 'not Show in Tree (FIN-W-02)');
  assert.equal(primaryAccountVerb(items, undefined)?.id, 'account.resetPassword');
  assert.equal(primaryAccountVerb(items, ['disabled'])?.id, 'account.toggleEnabled');
  // The Unlock placeholder ("Checking account status…") is disabled: never the primary.
  assert.equal(primaryAccountVerb(items, ['locked'])?.id, 'account.resetPassword');
  const unlockable = items.map((i) => (i.id === 'account.unlock' ? { ...i, enabled: true } : i));
  assert.equal(primaryAccountVerb(unlockable, ['locked', 'disabled'])?.id, 'account.unlock');
  assert.equal(primaryAccountVerb(unlockable, [], { locked: true })?.id, 'account.unlock');
  // A group / contact has no account verbs: the palette keeps its first item, the header falls back.
  const group = [{ id: 'membership.addMembers', enabled: true }];
  assert.equal(primaryAccountVerb(group, []), undefined);
  assert.equal(primaryAccountVerb(group, [], { fallback: true })?.id, 'membership.addMembers');
});

test('a hit is named by its RDN value, then its display name (else cn) when that differs', () => {
  const dn = 'uid=eva.weber,ou=IT,ou=People,dc=demo,dc=ldapilot,dc=local';
  assert.deepEqual(entryHitLabel(dn, { displayName: 'Eva Weber', cn: 'Eva Weber' }), { name: 'eva.weber', detail: 'Eva Weber' });
  assert.deepEqual(entryHitLabel(dn, { cn: 'Eva Weber' }), { name: 'eva.weber', detail: 'Eva Weber' });
  assert.deepEqual(entryHitLabel('CN=Schmidt\\, Anna,OU=Users,DC=x', { displayName: 'Schmidt, Anna', cn: 'Schmidt, Anna' }), { name: 'Schmidt, Anna' });
  assert.deepEqual(entryHitLabel('CN=Anna Schmidt,OU=Users,DC=x', { displayName: 'Anna Schmidt (HR)' }), { name: 'Anna Schmidt', detail: 'Anna Schmidt (HR)' });
  assert.deepEqual(entryHitLabel('ou=People,dc=x', {}), { name: 'People' });
  assert.deepEqual(entryHitLabel('ou=People,dc=x', { displayName: '  ' }), { name: 'People' });
});
