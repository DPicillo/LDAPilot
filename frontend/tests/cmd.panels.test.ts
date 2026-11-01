// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PANELS, shortcutCollisions } from '../src/components/commands/panelTable.ts';

// The other global registry shortcuts (coreCommands, shellCommands, treeCommands, aiCommands).
const OTHER = [
  'Mod+K', 'Mod+Shift+P', 'Mod+G', 'Alt+Left', 'Alt+Right', 'Mod+B', 'Mod+J', 'Mod+=', 'Mod+-', 'Mod+0', 'Mod+W',
  'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Mod+/', 'Mod+Shift+?', 'Mod+N', 'Mod+D', 'Shift+Alt+C', 'F2', 'Delete', 'F5', 'Mod+F',
  'Mod+Shift+N', 'Mod+L', 'Mod+A', 'Mod+C', 'Mod+Enter', 'Enter',
  ...Array.from({ length: 9 }, (_, i) => `Mod+${i + 1}`),
];

test('every panel has a shortcut, and no shortcut collides', () => {
  assert.equal(PANELS.length, 8);
  for (const p of PANELS) assert.match(p.shortcut, /^Mod\+Shift\+[A-Z]$/, p.label);
  assert.deepEqual(shortcutCollisions([...PANELS.map((p) => p.shortcut), ...OTHER]), []);
  assert.deepEqual(shortcutCollisions(['Mod+Shift+R', 'Ctrl+Shift+R']), ['mod+r+shift'], 'Ctrl and Mod are the same key on Windows/Linux');
});

test('one name per view (View menu = activity bar tooltip = panel header)', () => {
  assert.deepEqual(
    PANELS.map((p) => p.label),
    ['Connections', 'Explorer', 'Search', 'Reports', 'Bookmarks', 'Schema', 'Import / Export', 'AI Chat'],
  );
  assert.equal(new Set(PANELS.map((p) => p.command)).size, PANELS.length);
});
