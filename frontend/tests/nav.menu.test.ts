// Run: cd frontend && node --test 'tests/*.test.ts'
// DEF-10: type-ahead in menus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TYPEAHEAD_MS, isTypeaheadKey, typeaheadMatch, typeaheadText, type TypeaheadItem } from '../src/components/ui/menuTypeahead.ts';

const go: TypeaheadItem[] = [
  { label: 'Back' }, { label: 'Forward' }, { label: 'Go to Anything…' }, { label: 'Go to DN…' }, { label: 'Deleted Objects…', disabled: true },
];
const entry: TypeaheadItem[] = [{ label: 'Open' }, { label: 'Delete…' }, { label: 'Disable Account' }, { label: 'Deleted Objects…' }, { label: '“Ben” Export…' }];
const fresh = { buf: '', t: 0 };

test('a letter focuses the next item starting with it; the same letter cycles', () => {
  let r = typeaheadMatch(go, 0, fresh, 'd', 10_000);
  assert.equal(r.index, 4, 'a disabled item is still reached when it is the only match (N-46: "d" in Go)');
  r = typeaheadMatch(go, -1, fresh, 'G', 10_000);
  assert.equal(r.index, 2);
  r = typeaheadMatch(go, r.index, r.state, 'g', 10_100);
  assert.equal(r.index, 3, 'gg cycles to the next G item');
  r = typeaheadMatch(go, r.index, r.state, 'g', 10_200);
  assert.equal(r.index, 2, 'and wraps');
  assert.equal(typeaheadMatch(go, 0, fresh, 'x', 10_000).index, -1);
});

test('typed text within the timeout narrows by prefix; enabled items win; punctuation is skipped', () => {
  let r = typeaheadMatch(entry, 0, fresh, 'd', 1000);
  assert.equal(r.index, 1);
  r = typeaheadMatch(entry, r.index, r.state, 'i', 1100);
  assert.equal(r.index, 2, '"di" = Disable Account');
  r = typeaheadMatch(entry, 0, fresh, 'd', 5000);
  r = typeaheadMatch(entry, r.index, r.state, 'e', 5100);
  assert.equal(r.index, 1, '"de" stays on Delete…');
  r = typeaheadMatch(entry, r.index, r.state, 'l', 5200);
  r = typeaheadMatch(entry, r.index, r.state, 'e', 5300);
  r = typeaheadMatch(entry, r.index, r.state, 't', 5400);
  r = typeaheadMatch(entry, r.index, r.state, 'e', 5500);
  r = typeaheadMatch(entry, r.index, r.state, 'd', 5600);
  assert.equal(r.index, 3, '"deleted" = Deleted Objects…');
  // After the timeout a new search starts.
  r = typeaheadMatch(entry, 3, r.state, 'o', 5600 + TYPEAHEAD_MS + 1);
  assert.equal(r.index, 0);
  assert.equal(r.state.buf, 'o');
  assert.equal(typeaheadMatch(entry, 0, fresh, 'b', 1).index, 4, 'leading quote ignored');
  assert.equal(typeaheadText('  “Ben” Export…'), 'ben” export…');
  const twoD: TypeaheadItem[] = [{ label: 'Delete', disabled: true }, { label: 'Disconnect' }];
  assert.equal(typeaheadMatch(twoD, -1, fresh, 'd', 1).index, 1, 'the enabled match first');
});

test('only plain character keys type ahead', () => {
  assert.ok(isTypeaheadKey({ key: 'd' }));
  assert.ok(isTypeaheadKey({ key: 'D' }));
  assert.ok(!isTypeaheadKey({ key: ' ' }), 'Space activates');
  assert.ok(!isTypeaheadKey({ key: 'd', ctrlKey: true }));
  assert.ok(!isTypeaheadKey({ key: 'd', altKey: true }), 'Alt+letter = menubar mnemonic');
  assert.ok(!isTypeaheadKey({ key: 'ArrowDown' }));
});
