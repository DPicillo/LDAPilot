// Run: cd frontend && node --test 'tests/*.test.ts'
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  contextHeadLabel,
  createCoalescer,
  dnsNameOf,
  findDNKey,
  isNodeKnown,
  movedDN,
  parentPathLabel,
  patchNodeInList,
  planTreeMove,
  rebaseDN,
  rebaseSet,
  unescapedDN,
  visibleExpandedContainers,
  withoutKeysBelow,
  withoutSetBelow,
} from '../src/lib/treesearch.ts';
import type { TreeNode } from '../src/types/ldap';

const node = (dn: string, hasChildren = true, extra: Partial<TreeNode> = {}): TreeNode => ({
  dn,
  rdn: dn.split(',')[0],
  hasChildren,
  objectClass: [],
  icon: '',
  ...extra,
});

const D = 'DC=ad,DC=ldapilot,DC=lab';

test('Refresh Tree reloads only visible expanded containers, top-down', () => {
  const roots = [node(D), node(`CN=Configuration,${D}`)];
  const child = {
    [D]: [node(`OU=LDAPilot,${D}`), node(`OU=Track-ux,${D}`)],
    [`OU=LDAPilot,${D}`]: [node(`OU=Bulk,OU=LDAPilot,${D}`)],
    [`OU=Bulk,OU=LDAPilot,${D}`]: [node(`CN=c1,OU=Bulk,OU=LDAPilot,${D}`, false)],
    // loaded but its parent (Track-ux) is collapsed: hidden, not reloaded
    [`OU=ux-n,OU=Track-ux,${D}`]: [],
  };
  const expanded = new Set([D, `OU=LDAPilot,${D}`, `OU=Bulk,OU=LDAPilot,${D}`, `OU=ux-n,OU=Track-ux,${D}`, `CN=Configuration,${D}`]);
  // Configuration is expanded but its children are not loaded: nothing to reload there.
  assert.deepEqual(visibleExpandedContainers(roots, child, expanded), [D, `OU=LDAPilot,${D}`, `OU=Bulk,OU=LDAPilot,${D}`]);
});

test('patchNodeInList gives a leaf parent its chevron (and keeps the array when unchanged)', () => {
  const list = [node(`OU=ux-n,OU=Track-ux,${D}`, false), node(`OU=x,OU=Track-ux,${D}`, false)];
  const next = patchNodeInList(list, `ou=UX-N, ou=track-ux,${D.toLowerCase()}`, { hasChildren: true });
  assert.notEqual(next, list);
  assert.equal(next[0].hasChildren, true);
  assert.equal(next[1], list[1]);
  assert.equal(patchNodeInList(next, `OU=ux-n,OU=Track-ux,${D}`, { hasChildren: true }), next);
});

test('findDNKey and isNodeKnown compare DNs normalized', () => {
  const child = { [`OU=Track-ux,${D}`]: [node(`OU=ux-n,OU=Track-ux,${D}`)] };
  assert.equal(findDNKey(child, `ou=track-ux, dc=ad,dc=ldapilot,dc=lab`), `OU=Track-ux,${D}`);
  assert.equal(findDNKey(child, `OU=nope,${D}`), undefined);
  assert.equal(isNodeKnown([node(D)], child, `OU=UX-N,OU=Track-ux,${D}`), true);
  assert.equal(isNodeKnown([node(D)], child, D.toLowerCase()), true);
  assert.equal(isNodeKnown([node(D)], child, `OU=other,OU=Track-ux,${D}`), false);
});

test('rebaseDN / rebaseSet re-key a moved subtree, escapes kept', () => {
  const oldDN = `OU=ux-tree,OU=Track-ux,${D}`;
  const newDN = `OU=ux-tree,OU=target,OU=Track-ux,${D}`;
  assert.equal(rebaseDN(`CN=Schmidt\\, Anna,${oldDN}`, oldDN, newDN), `CN=Schmidt\\, Anna,${newDN}`);
  assert.equal(rebaseDN(oldDN, oldDN, newDN), newDN);
  assert.equal(rebaseDN(`OU=other,${D}`, oldDN, newDN), null);
  const set = new Set([`CN=a,${oldDN}`, `OU=other,${D}`]);
  assert.deepEqual([...rebaseSet(set, oldDN, newDN)], [`CN=a,${newDN}`, `OU=other,${D}`]);
  const untouched = new Set([`OU=other,${D}`]);
  assert.equal(rebaseSet(untouched, oldDN, newDN), untouched);
});

test('withoutSetBelow / withoutKeysBelow drop a deleted subtree only', () => {
  const gone = `OU=gone,${D}`;
  const set = new Set([gone, `CN=x,${gone}`, `OU=gone2,${D}`]);
  assert.deepEqual([...withoutSetBelow(set, gone)], [`OU=gone2,${D}`]);
  const rec = { [gone]: [], [`CN=x,${gone}`]: [], [D]: [] };
  assert.deepEqual(Object.keys(withoutKeysBelow(rec, gone)), [D]);
  assert.equal(withoutKeysBelow(rec, `OU=none,${D}`), rec);
});

test('root labels: DNS name, DNS zones, Configuration, Schema, scoped base', () => {
  assert.equal(contextHeadLabel(D), 'ad.ldapilot.lab');
  assert.equal(contextHeadLabel(`DC=DomainDnsZones,${D}`), 'DomainDnsZones');
  assert.equal(contextHeadLabel(`DC=ForestDnsZones,${D}`), 'ForestDnsZones');
  assert.equal(contextHeadLabel(`CN=Configuration,${D}`), 'Configuration');
  assert.equal(contextHeadLabel(`CN=Schema,CN=Configuration,${D}`), 'Schema');
  assert.equal(contextHeadLabel(`OU=LDAPilot,${D}`), 'LDAPilot (ad.ldapilot.lab)');
  assert.equal(contextHeadLabel('ou=People,dc=demo,dc=ldapilot,dc=local'), 'People (demo.ldapilot.local)');
  assert.equal(contextHeadLabel('dc=demo,dc=ldapilot,dc=local'), 'demo.ldapilot.local');
  assert.equal(contextHeadLabel('o=example'), 'o=example');
  assert.equal(contextHeadLabel('cn=config'), 'cn=config');
  assert.equal(dnsNameOf('o=example'), null);
});

test('hit labels: unescaped DN and parent path (nearest first)', () => {
  const dn = `CN=Semi\\3BColon \\<Angle\\>,OU=Special Cases,OU=LDAPilot,${D}`;
  assert.equal(unescapedDN(dn), 'CN=Semi;Colon <Angle>, OU=Special Cases, OU=LDAPilot, DC=ad, DC=ldapilot, DC=lab');
  assert.equal(parentPathLabel(dn), 'Special Cases, LDAPilot, ad.ldapilot.lab');
  assert.equal(parentPathLabel(`CN=Schmidt\\, Anna,OU=A\\, B,${D}`), 'A, B, ad.ldapilot.lab');
  assert.equal(parentPathLabel(D), 'ldapilot.lab');
  assert.equal(parentPathLabel('o=example'), '');
});

test('planTreeMove: whole selection, nested entries, own subtree, NC heads, other NC', () => {
  const roots = [node(D), node(`CN=Configuration,${D}`)];
  const target = `OU=ux-tree-child,OU=ux-tree,OU=Track-ux,${D}`;
  const u1 = `CN=u1,OU=ux-tree,OU=Track-ux,${D}`;
  const u2 = `CN=u2,OU=empty,OU=ux-tree,OU=Track-ux,${D}`;
  const parent = `OU=ux-tree,OU=Track-ux,${D}`;
  const inside = `CN=in,${target}`;
  const nested = `CN=n,OU=empty,OU=ux-tree,OU=Track-ux,${D}`;
  const ctx = (dn: string) => roots.some((r) => r.dn === dn);
  const plan = planTreeMove([u1, u2, u1, parent, inside, D, `CN=x,CN=Configuration,${D}`, `OU=empty,OU=ux-tree,OU=Track-ux,${D}`, nested], target, roots, ctx);
  assert.deepEqual(plan.move, [u1, `OU=empty,OU=ux-tree,OU=Track-ux,${D}`]);
  assert.deepEqual(
    plan.skipped.map((s) => [s.dn, s.reason]),
    [
      [u2, 'inside-moved-entry'],
      [parent, 'into-itself'],
      [inside, 'already-there'],
      [D, 'naming-context'],
      [`CN=x,CN=Configuration,${D}`, 'other-naming-context'],
      [nested, 'inside-moved-entry'],
    ],
  );
  assert.equal(movedDN(`CN=Schmidt\\, Anna,OU=a,${D}`, target), `CN=Schmidt\\, Anna,${target}`);
});

test('planTreeMove: spellings differ, big selections stay linear', () => {
  const roots = [node(D)];
  const base = `OU=ux-tree,OU=Track-ux,${D}`;
  const target = `OU=target,${base}`;
  const sub = `OU=Sub,${base}`;
  // The selected container in another spelling; its child below it goes along.
  const plan = planTreeMove([`ou = sub , ou=UX-TREE,ou=track-ux,dc=AD,dc=ldapilot,dc=lab`, `CN=c1,${sub}`, `cn=t1, ${target.toLowerCase()}`], target, roots, () => false);
  assert.deepEqual(plan.move, [`ou = sub , ou=UX-TREE,ou=track-ux,dc=AD,dc=ldapilot,dc=lab`]);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ['inside-moved-entry', 'already-there']);
  // 3,000 siblings plus their container: one plan well below a frame budget.
  const many = Array.from({ length: 3000 }, (_, i) => `CN=u${i},${sub}`);
  const t0 = performance.now();
  const big = planTreeMove([...many, sub], target, roots, () => false);
  assert.ok(performance.now() - t0 < 500);
  assert.deepEqual(big.move, [sub]);
  assert.equal(big.skipped.length, 3000);
  assert.equal(planTreeMove(many, target, roots, () => false).move.length, 3000);
});

test('createCoalescer flushes repeated keys once after the delay', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const flushed: Map<string, number>[] = [];
    const c = createCoalescer<number>(300, (b) => flushed.push(b), (a, b) => a + b);
    c.add('a', 1);
    c.add('a', 2);
    c.add('b', 5);
    assert.equal(c.size, 2);
    mock.timers.tick(299);
    assert.equal(flushed.length, 0);
    mock.timers.tick(1);
    assert.equal(flushed.length, 1);
    assert.deepEqual([...flushed[0]], [['a', 3], ['b', 5]]);
    c.add('a', 1);
    mock.timers.tick(300);
    assert.equal(flushed.length, 2);
  } finally {
    mock.timers.reset();
  }
});
