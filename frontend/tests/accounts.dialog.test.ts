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
