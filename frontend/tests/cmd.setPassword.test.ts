// Run: cd frontend && node --test 'tests/*.test.ts'
//
// Set Password… for LDAP persons without a login: not every directory gives
// its users a uid, and a person without uid and without a password is a
// contact by the kind rule. A contact had no password verb, so such a user
// could never get the password that would make it a user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hasAccountSemantics, nodeKind, passwordVerb, resolveObjectKind } from '../src/components/ui/objectKind.ts';
import { passwordVerbTitle } from '../src/components/commands/accountDisplay.ts';
import { primaryAccountVerb } from '../src/components/ui/primaryAction.ts';
import { passwordDialogText, resultSummary } from '../src/lib/passwordMethod.ts';
import { patchNodeInList } from '../src/lib/treesearch.ts';
import { unencryptedWhat } from '../src/lib/unencryptedConsent.ts';
import type { PasswordChangeResult } from '../src/types/password.ts';
import type { TreeNode } from '../src/types/ldap.ts';

const PERSON = ['top', 'person', 'organizationalPerson', 'inetOrgPerson'];
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('an LDAP person without a login can be given a password: Set Password… on OpenLDAP, 389DS and other LDAP servers', () => {
  const contact = resolveObjectKind(PERSON, ['objectClass', 'cn', 'sn', 'mail']);
  assert.equal(contact, 'contact', 'the kind rule itself is unchanged');
  for (const server of ['openldap', '389ds', 'other']) assert.equal(passwordVerb(contact, PERSON, server), 'set', server);
  assert.equal(passwordVerb(contact, ['top', 'person'], 'openldap'), 'set', 'a plain person may hold userPassword too');
  // The other account verbs stay hidden: a contact has no account status.
  assert.ok(!hasAccountSemantics(contact, PERSON));
});

test('a user keeps Reset Password… on every server; with its first password the former contact is one', () => {
  for (const server of ['ad', 'openldap', '389ds', 'other', null]) {
    assert.equal(passwordVerb('user', ['top', 'person', 'organizationalPerson', 'user'], server), 'reset', String(server));
  }
  const after = resolveObjectKind(PERSON, ['objectClass', 'cn', 'sn', 'userPassword']);
  assert.equal(after, 'user');
  assert.equal(passwordVerb(after, PERSON, 'openldap'), 'reset');
});

test('no password verb on Active Directory contacts, while the server type is unknown, or for other kinds', () => {
  // AD: objects of class contact cannot have a password; userPassword is an ordinary attribute there.
  assert.equal(passwordVerb('contact', ['top', 'person', 'organizationalPerson', 'contact'], 'ad'), null);
  assert.equal(passwordVerb('contact', PERSON, 'ad'), null);
  // The class `contact` is no LDAP person of the kind rule on any server.
  assert.equal(passwordVerb('contact', ['top', 'person', 'organizationalPerson', 'contact'], 'openldap'), null);
  // Unknown server type (RootDSE not read yet): hidden until it is known, never offered on a guess.
  assert.equal(passwordVerb('contact', PERSON, null), null);
  assert.equal(passwordVerb('contact', PERSON, undefined), null);
  // A contact whose classes are unknown (a picker row) is not known to be a person.
  assert.equal(passwordVerb('contact', undefined, 'openldap'), null);
  for (const kind of ['group', 'computer', 'service', 'ou', 'domain', 'container', 'other', undefined] as const) {
    assert.equal(passwordVerb(kind, PERSON, 'openldap'), null, String(kind));
  }
});

test('the verb is named after what it does: Set Password… for a first password, Reset Password… for a user', () => {
  assert.equal(passwordVerbTitle('set'), 'Set Password…');
  assert.equal(passwordVerbTitle('reset'), 'Reset Password…');
  // A menu that keeps the slot of a verb that stopped applying shows the user wording.
  assert.equal(passwordVerbTitle(null), 'Reset Password…');
});

test('Set Password… is the primary verb of such an entry (editor header, palette Shift+Enter)', () => {
  // The only account verb a contact has.
  const items = [{ id: 'account.resetPassword', enabled: true }];
  assert.equal(primaryAccountVerb(items, undefined, { fallback: true })?.id, 'account.resetPassword');
  assert.equal(primaryAccountVerb(items, undefined)?.id, 'account.resetPassword');
});

test('the password dialog says Set, not Reset, for a first password', () => {
  const set = passwordDialogText('set');
  assert.equal(set.title, 'Set Password');
  assert.equal(set.submit, 'Set Password');
  assert.equal(set.again, 'Set Again');
  assert.equal(set.blocked, 'The password cannot be set over this connection');
  assert.equal(set.failed('Erika Muster'), 'Setting the password for Erika Muster failed');
  const reset = passwordDialogText('reset');
  assert.deepEqual([reset.title, reset.submit, reset.again], ['Reset Password', 'Reset Password', 'Reset Again']);
  assert.equal(reset.blocked, 'The password cannot be reset over this connection');
  assert.equal(reset.failed('u1'), 'Password reset for u1 failed');
  assert.equal(passwordDialogText().title, 'Reset Password', 'default: the reset wording');
  // The unencrypted-send confirmation (DEF-21) names the action the same way.
  assert.equal(unencryptedWhat(['verification bind'], set.sends), 'This sends the new password in cleartext (verification bind).');
  assert.equal(unencryptedWhat(['verification bind'], reset.sends), unencryptedWhat(['verification bind']), 'users: unchanged');

  const res: PasswordChangeResult = {
    method: 'userPassword', scheme: 'CRYPT-SHA512', storedScheme: 'CRYPT-SHA512', storedSchemeLabel: '{CRYPT} SHA-512-crypt ($6$)',
    operations: ['replace userPassword'], warnings: [], verified: true, verifyError: '', ineffective: false, unconfirmed: false, mustChangeIgnored: false,
  };
  assert.equal(resultSummary(res, 'Erika Muster', 'set'), 'Password set for Erika Muster (stored as {CRYPT} SHA-512-crypt ($6$), verified by bind)');
  assert.equal(resultSummary({ ...res, operations: [], storedScheme: '', verified: false }, undefined, 'set'), 'Password set');
  assert.equal(resultSummary(res, 'u1'), 'Password reset for u1 (stored as {CRYPT} SHA-512-crypt ($6$), verified by bind)', 'users: unchanged');
});

test('a row whose login attributes were read again changes its kind (tree row, Contents row)', () => {
  const dn = 'cn=Erika Muster,ou=People,dc=demo';
  const list: TreeNode[] = [
    { dn, rdn: 'cn=Erika Muster', hasChildren: false, objectClass: PERSON, loginAttributes: [] } as TreeNode,
    { dn: 'cn=Other,ou=People,dc=demo', rdn: 'cn=Other', hasChildren: false, objectClass: PERSON, loginAttributes: [] } as TreeNode,
  ];
  assert.equal(nodeKind(list[0]), 'contact');
  const next = patchNodeInList(list, 'CN=erika muster, OU=People,DC=demo', { loginAttributes: ['userPassword'] });
  assert.notEqual(next, list, 'a new list: the views re-render');
  assert.equal(nodeKind(next[0]), 'user');
  assert.equal(next[1], list[1], 'other rows keep their identity');
  assert.equal(patchNodeInList(next, dn, { loginAttributes: ['userPassword'] }), next, 'nothing changed: the same list');
});

test('wiring: the registry offers the verb for both, and every view follows the first password', () => {
  const commands = read('../src/components/commands/featureCommands.tsx');
  const def = commands.slice(commands.indexOf("id: 'account.resetPassword'"), commands.indexOf("id: 'account.mustChangePassword'"));
  assert.ok(def.includes('when: (ctx) => passwordVerbOf(ctx) !== null'), 'users and LDAP persons without a login');
  assert.ok(def.includes('title: (ctx) => passwordVerbTitle(passwordVerbOf(ctx))'));
  assert.ok(def.includes('write: true'), 'hidden on read-only and lost connections like every write verb');
  // The other account verbs stay with accounts.
  for (const id of ['account.unlock', 'account.mustChangePassword']) {
    const other = commands.slice(commands.indexOf(`id: '${id}'`));
    assert.ok(other.slice(0, other.indexOf('\n    },')).includes('oneUser'), id);
  }
  const handler = commands.slice(commands.indexOf('function resetPassword(ctx: CommandContext)'));
  assert.ok(handler.slice(0, handler.indexOf('\n}\n')).includes("verb: passwordVerbOf(ctx) ?? 'reset'"), 'the dialog gets the verb');

  // After the write (ldapilot:account-changed) the login attribute names are read again, once
  // (lib/loginRead): for the caches behind result rows and menus, and for the tree row (the
  // Contents list shows the same row).
  const presence = read('../src/components/commands/presence.ts');
  assert.ok(presence.includes('onAccountChanged('), 'presence follows account changes');
  const listener = presence.slice(presence.indexOf('onAccountChanged('));
  assert.ok(listener.includes('readLoginAttributesShared(profileId, dn)'));
  assert.ok(listener.includes('presence.delete(key)'), 'the menus read again');
  const tree = read('../src/stores/treeStore.ts');
  const follow = tree.slice(tree.indexOf('async function refreshLoginAttributes('));
  assert.ok(tree.includes('async function refreshLoginAttributes('), 'the tree row follows');
  assert.ok(follow.includes('readLoginAttributesShared(profileId, node.dn)'), 'the shared read');
  assert.ok(follow.includes('patchNodeInList(lists[key], dn, { loginAttributes })'));
  assert.ok(follow.includes('onEntryEvent<EntryRefDetail>(ACCOUNT_CHANGED'), 'on every account change');
  assert.ok(read('../src/lib/loginRead.ts').includes("createSharedReader<string[] | undefined>"), 'one read per entry for all of them');

  // The editor header decides by the entry it loaded, never by an older tree row.
  const editor = read('../src/components/editor/EntryEditor.tsx');
  const ctx = editor.slice(editor.indexOf('const commandCtx = useMemo('), editor.indexOf('const navigateTo ='));
  assert.ok(ctx.includes('presentAttributes'), 'the loaded entry tells user or contact');

  const dialog = read('../src/components/editor/PasswordDialog.tsx');
  assert.ok(dialog.includes('passwordDialogText(verb)'), 'one dialog, two wordings');
  assert.ok(dialog.includes('resultSummary(res, name, verb)'));
  assert.ok(dialog.includes('unencryptedWhat(resetCleartextParts(sel), text.sends)'));
});
