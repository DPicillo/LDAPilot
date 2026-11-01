// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitDN, firstRDN, getParentDN, normalizeDN, dnDepth, isDNAtOrBelow, isDNBelow, parseRDN, escapeDNValue, unescapeDNValue,
} from '../src/lib/dn.ts';
import { placeMenu } from '../src/lib/menuPosition.ts';

const COMMA = 'CN=int\\, Comma,OU=Track-integration,OU=LDAPilot,DC=ad,DC=ldapilot,DC=lab';

test('first RDN and parent keep escaped commas', () => {
  assert.equal(firstRDN(COMMA), 'CN=int\\, Comma');
  assert.equal(getParentDN(COMMA), 'OU=Track-integration,OU=LDAPilot,DC=ad,DC=ldapilot,DC=lab');
  assert.equal(firstRDN('CN=Schmidt\\, Anna'), 'CN=Schmidt\\, Anna');
  assert.equal(getParentDN('CN=Schmidt\\, Anna'), '');
  // escaped backslash before a real separator
  assert.deepEqual(splitDN('cn=a\\\\,ou=b'), ['cn=a\\\\', 'ou=b']);
  // hex escape, quoted value, legacy ';' separator
  assert.deepEqual(splitDN('cn=a\\2cb,ou=x'), ['cn=a\\2cb', 'ou=x']);
  assert.deepEqual(splitDN('cn="Doe, John";ou=x'), ['cn="Doe, John"', 'ou=x']);
  assert.equal(dnDepth(COMMA), 6);
  assert.equal(dnDepth(' '), 0);
});

test('normalizeDN and ancestry are case- and blank-insensitive', () => {
  assert.equal(normalizeDN(' CN = A\\, B , OU=X '), 'cn=a\\, b,ou=x');
  assert.equal(normalizeDN(''), '');
  assert.ok(isDNAtOrBelow(COMMA, 'ou=track-integration, ou=ldapilot,dc=ad,dc=ldapilot,dc=lab'));
  assert.ok(isDNAtOrBelow('dc=x', 'DC=X'));
  assert.ok(!isDNBelow('dc=x', 'DC=X'));
  assert.ok(isDNBelow('cn=a,dc=x', 'DC=X'));
  // "CN=b\, OU=x" is one RDN, not below OU=x
  assert.ok(!isDNBelow('CN=b\\, OU=x', 'OU=x'));
});

test('parseRDN / escapeDNValue round trip', () => {
  assert.deepEqual(parseRDN('CN=Doe\\, John'), { attr: 'CN', value: 'Doe, John' });
  assert.deepEqual(parseRDN('cn=M\\C3\\BCller'), { attr: 'cn', value: 'Müller' });
  assert.equal(unescapeDNValue('a\\+b\\\\c'), 'a+b\\c');
  for (const v of ['Doe, John', ' lead', 'trail ', '#hash', 'a+b;c<d>e"f\\g', 'Müller 😀']) {
    assert.equal(parseRDN('cn=' + escapeDNValue(v)).value, v);
  }
});

test('placeMenu flips and clamps into the viewport', () => {
  // fits: stays at the click position
  assert.deepEqual(placeMenu(100, 100, 200, 300, 1280, 800), { left: 100, top: 100, maxHeight: 792 });
  // account node menu (16 items) at y=400 in an 800px window: flipping up would give top -56
  const p = placeMenu(100, 400, 200, 456, 1280, 800);
  assert.equal(p.top, 800 - 456 - 4);
  assert.ok(p.top >= 4);
  // right edge: flipped left
  assert.equal(placeMenu(1200, 100, 200, 100, 1280, 800).left, 1000);
  // taller than the viewport (zoomed): starts at the top margin, capped height
  const tall = placeMenu(100, 300, 200, 700, 1024, 640);
  assert.equal(tall.top, 4);
  assert.equal(tall.maxHeight, 632);
});
