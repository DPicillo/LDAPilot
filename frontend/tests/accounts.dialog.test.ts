// Run: cd frontend && node --test 'tests/*.test.ts'
// ACCT-01 regression check (component-free): React bubbles synthetic events
// along the component tree, through portals, so a nested dialog's submit
// (the unencrypted-send confirmation inside PasswordDialog) reached the parent
// dialog's <form onSubmit>, re-opened the confirmation and re-sent the
// password. The Dialog primitive must stop the submit at its own form, and
// PasswordDialog must ignore form submits while its confirmation is open.
// Manual check (fix-notes/accounts.md): AD-plain / OL-plain "Send
// unencrypted" (now: consent + Continue, DEF-21) sends exactly one MODIFY and the confirmation does not reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** The body of the first `onSubmit={(e) => { … }}` handler on a <form> in src. */
function formSubmitHandler(src: string): string {
  const form = src.indexOf('<form');
  assert.ok(form >= 0, 'Dialog renders a <form>');
  const start = src.indexOf('onSubmit={', form);
  assert.ok(start >= 0, 'the form has an onSubmit handler');
  let depth = 0;
  for (let i = start + 'onSubmit='.length; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced onSubmit handler');
}

test('Dialog stops the submit event before calling onSubmit (nested dialogs)', () => {
  const handler = formSubmitHandler(read('../src/components/ui/Dialog.tsx'));
  const stop = handler.indexOf('e.stopPropagation()');
  const call = handler.indexOf('onSubmit(e)');
  assert.ok(stop >= 0, `stopPropagation missing in ${handler}`);
  assert.ok(call > stop, 'propagation is stopped before the dialog handles the submit');
  assert.ok(handler.indexOf('e.preventDefault()') >= 0, 'no native form navigation');
});

test('PasswordDialog: no submit while the cleartext confirmation is open; the confirmation is closed before sending', () => {
  const src = read('../src/components/editor/PasswordDialog.tsx');
  assert.match(src, /onSubmit=\{\(\) => \{ if \(!confirmPlain && ready\) void handleSubmit\(\); \}\}/);
  assert.match(src, /onConfirm=\{\(\) => \{ setConfirmPlain\(false\); void handleSubmit\(true\); \}\}/);
  const send = src.indexOf('await SetPassword(');
  const clear = src.lastIndexOf('setConfirmPlain(false);', send);
  assert.ok(clear > 0 && clear < send, 'confirmPlain is cleared before the password is sent');
  assert.ok(src.includes('inFlight.current'), 'one write at a time');
});

// Issue #1 follow-up: "{SASL}user" (pass-through authentication) and hashes
// are stored unchanged by every generic write path, but Reset Password
// hashes the text it is given. The dialog names such a text and stores it
// through the generic path instead.
test('PasswordDialog: a typed stored value ({SASL}user, a hash) is stored as typed, not through SetPassword', () => {
  const src = read('../src/components/editor/PasswordDialog.tsx');
  // Not on AD: the reset writes unicodePwd there, where every text is a password.
  assert.ok(src.includes("ctx.serverType !== 'ad' ? typedStoredValue(newPassword) : null"), 'offered off AD only');
  const start = src.indexOf('async function handleStoreAsTyped(');
  assert.ok(start >= 0, 'the dialog has a Store as Typed handler');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  assert.ok(
    body.includes("ModifyEntryWithOptions(profileId, dn, [{ operation: 'replace', attribute: 'userPassword', values: [newPassword] }], { asIs: true })"),
    'one replace of userPassword, stored exactly as typed',
  );
  assert.ok(!body.includes('SetPassword('), 'SetPassword would hash the text');
  assert.ok(body.includes('passwordsMatch'), 'typed twice, like every password field');
  assert.ok(body.includes('inFlight.current'), 'one write at a time');
  assert.ok(src.includes('Store as Typed'), 'the alert offers the button');
  // A reset of a pass-through account says what it replaces.
  assert.ok(src.includes('passThroughResetNote(ctx.currentScheme)'));
});

// Found in the walkthrough against the lab OpenLDAP: with "{SASL}user" typed
// twice, Enter in the confirmation field submitted the form, i.e. the hashing
// reset, although the warning was on screen. While the warning is shown the
// reset needs a click on its button; Enter does nothing.
test('PasswordDialog: Enter never hashes a typed stored value', () => {
  const src = read('../src/components/editor/PasswordDialog.tsx');
  const start = src.indexOf('async function handleSubmit(');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  const guard = body.indexOf('if (typedStored && !hashAsPassword.current) return;');
  assert.ok(guard >= 0, 'handleSubmit refuses a typed stored value unless Reset Password was clicked');
  assert.ok(guard < body.indexOf('await SetPassword('), 'the guard comes before the write');
  // No submit button while the warning is shown: Enter in a field has nothing to activate.
  assert.ok(src.includes("type={typedStored ? 'button' : 'submit'}"), 'the footer button is no submit button then');
  assert.ok(src.includes('hashAsPassword.current = true'), 'only the click sets the flag');
  assert.match(src, /useEffect\(\(\) => \{ hashAsPassword\.current = false; \}, \[newPassword\]\)/, 'a changed text needs a new click');
});
