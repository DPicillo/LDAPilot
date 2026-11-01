// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchShortcut, isTextEditingShortcut, isPlainKey } from '../src/components/ui/shortcuts.ts';

const ev = (key: string, code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) => ({
  key, code, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta,
});

test('letters and digits match by physical key, Shift must match', () => {
  assert.ok(matchShortcut(ev('b', 'KeyB', { ctrl: true }), 'Ctrl+B'));
  assert.ok(!matchShortcut(ev('B', 'KeyB', { ctrl: true, shift: true }), 'Ctrl+B'));
  assert.ok(matchShortcut(ev('E', 'KeyE', { ctrl: true, shift: true }), 'Ctrl+Shift+E'));
  assert.ok(matchShortcut(ev('1', 'Digit1', { ctrl: true }), 'Ctrl+1'));
  // A German layout types '/' with Shift+7: Ctrl+1..9 must not catch it
  assert.ok(!matchShortcut(ev('/', 'Digit7', { ctrl: true, shift: true }), 'Ctrl+7'));
});

test('symbols match the typed character on any layout (Ctrl+/ on German = Ctrl+Shift+7)', () => {
  assert.ok(matchShortcut(ev('/', 'Slash', { ctrl: true }), 'Ctrl+/'));
  assert.ok(matchShortcut(ev('/', 'Digit7', { ctrl: true, shift: true }), 'Ctrl+/'));
  assert.ok(matchShortcut(ev('?', 'Slash', { ctrl: true, shift: true }), 'Ctrl+Shift+?'));
  assert.ok(matchShortcut(ev('-', 'Minus', { ctrl: true }), 'Ctrl+-'));
  // Zoom in: '=' (US) and '+' (German key next to Enter, or Shift+0 '=')
  assert.ok(matchShortcut(ev('=', 'Equal', { ctrl: true }), 'Ctrl+='));
  assert.ok(matchShortcut(ev('+', 'BracketRight', { ctrl: true }), 'Ctrl+='));
  assert.ok(matchShortcut(ev('=', 'Digit0', { ctrl: true, shift: true }), 'Ctrl+='));
  // Ctrl+0 (reset) is not Ctrl+Shift+0
  assert.ok(matchShortcut(ev('0', 'Digit0', { ctrl: true }), 'Ctrl+0'));
  assert.ok(!matchShortcut(ev('=', 'Digit0', { ctrl: true, shift: true }), 'Ctrl+0'));
});

test('text editing keys stay with editable fields', () => {
  assert.ok(isTextEditingShortcut('Alt+Left'));
  assert.ok(isTextEditingShortcut('Alt+Right'));
  assert.ok(isTextEditingShortcut('F2'));
  assert.ok(isTextEditingShortcut('Delete'));
  assert.ok(isTextEditingShortcut('Ctrl+Backspace'));
  assert.ok(!isTextEditingShortcut('Ctrl+B'));
  assert.ok(!isTextEditingShortcut('Ctrl+Shift+F'));
  assert.ok(!isTextEditingShortcut('Ctrl+Tab'));
  assert.ok(isPlainKey('F5'));
  assert.ok(!isPlainKey('Shift+Alt+C'));
});

test('Ctrl+D and Ctrl+N never run in text fields; Ctrl+W, Ctrl+K and the panel shortcuts do', async () => {
  const { blocksInEditable } = await import('../src/components/ui/shortcuts.ts');
  // Ctrl+D (bookmark) and Ctrl+N (new entry) act on a selection the user does not look at while typing.
  assert.ok(blocksInEditable('Ctrl+D'));
  assert.ok(blocksInEditable('Ctrl+N'));
  // Text editing keys stay with the field as before.
  assert.ok(blocksInEditable('Alt+Left'));
  assert.ok(blocksInEditable('Delete'));
  assert.ok(blocksInEditable('Ctrl+Backspace'));
  // Mod+W still closes the tab (through the editor's close guard); app shortcuts keep working.
  assert.ok(!blocksInEditable('Ctrl+W'));
  assert.ok(!blocksInEditable('Ctrl+K'));
  assert.ok(!blocksInEditable('Ctrl+Shift+N'), 'AI: New Chat is not Ctrl+N');
  assert.ok(!blocksInEditable('Ctrl+Shift+F'));
  assert.ok(!blocksInEditable('Shift+Alt+C'));
});
