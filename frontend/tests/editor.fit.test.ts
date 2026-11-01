// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crumbWindow, dnCrumbs, dnInputProblem, fitToolbarItems } from '../src/components/ui/fit.ts';

test('fitToolbarItems: everything fits without the overflow button', () => {
  // 3 × 60 + 2 gaps of 4 = 188
  assert.equal(fitToolbarItems([60, 60, 60], 4, 188, 28), 3);
  assert.equal(fitToolbarItems([60, 60, 60], 4, 187.6, 28), 3); // half-pixel tolerance
  assert.equal(fitToolbarItems([], 4, 0, 28), 0);
});

test('fitToolbarItems: on overflow, as many as fit next to the "…" button', () => {
  // more 28 + (4 + 60) = 92, + (4 + 60) = 156 > 150 → 1
  assert.equal(fitToolbarItems([60, 60, 60], 4, 150, 28), 1);
  assert.equal(fitToolbarItems([60, 60, 60], 4, 160, 28), 2);
  // Nothing fits next to the button: 0 (all in the overflow menu), never negative
  assert.equal(fitToolbarItems([60, 60], 4, 40, 28), 0);
});

test('fitToolbarItems: the result does not depend on how many were folded before (no shrinking loop)', () => {
  const widths = [80, 90, 70, 100];
  const first = fitToolbarItems(widths, 4, 250, 28);
  assert.equal(fitToolbarItems(widths, 4, 250, 28), first);
  assert.ok(first > 0);
});

test('dnCrumbs: DC components form one root crumb with the DNS name', () => {
  const crumbs = dnCrumbs('CN=Anna,OU=Staff,DC=ad,DC=lab');
  assert.deepEqual(crumbs.map((c) => c.label), ['ad.lab', 'Staff', 'Anna']);
  assert.deepEqual(crumbs.map((c) => c.dn), ['DC=ad,DC=lab', 'OU=Staff,DC=ad,DC=lab', 'CN=Anna,OU=Staff,DC=ad,DC=lab']);
  assert.deepEqual(dnCrumbs(''), []);
});

test('dnCrumbs: an explicit root DN is the first crumb; escaped commas stay inside their RDN', () => {
  const crumbs = dnCrumbs('CN=Schmidt\\, Anna,OU=Staff,CN=Configuration,DC=ad,DC=lab', 'CN=Configuration,DC=ad,DC=lab');
  assert.deepEqual(crumbs.map((c) => c.label), ['Configuration', 'Staff', 'Schmidt, Anna']);
  assert.equal(crumbs[0].dn, 'CN=Configuration,DC=ad,DC=lab');
  assert.equal(crumbs[2].dn, 'CN=Schmidt\\, Anna,OU=Staff,CN=Configuration,DC=ad,DC=lab');
  // DNS zones keep their own name
  assert.equal(dnCrumbs('DC=DomainDnsZones,DC=ad,DC=lab', 'DC=DomainDnsZones,DC=ad,DC=lab')[0].label, 'DomainDnsZones');
  // A root that does not contain the DN is ignored (DC fallback)
  assert.deepEqual(dnCrumbs('CN=X,DC=a,DC=b', 'OU=Other,DC=c').map((c) => c.label), ['a.b', 'X']);
});

test('crumbWindow: all crumbs when they fit, else head + "…" + a tail that keeps the last crumb', () => {
  const w = [50, 60, 70, 80];
  // all: 260 + 3 seps × 8 + 6 gaps × 2 = 296
  assert.equal(crumbWindow(w, 8, 20, 2, 296), 4);
  // Two or fewer crumbs are always shown
  assert.equal(crumbWindow([500, 500], 8, 20, 2, 10), 2);
  // Tight: head (50) + sep + more + 2 gaps = 82; last crumb (80 + 8 + 4) = 174 → start 3
  assert.equal(crumbWindow(w, 8, 20, 2, 180), 3);
  // Even when the last crumb does not fit it is kept (it truncates)
  assert.equal(crumbWindow(w, 8, 20, 2, 10), 3);
  // More room: the 70 crumb joins (174 + 82 = 256)
  assert.equal(crumbWindow(w, 8, 20, 2, 260), 2);
});

test('crumbWindow: the trailing "…" menu takes its room before everything fits', () => {
  const w = [50, 60, 70, 80];
  assert.equal(crumbWindow(w, 8, 20, 2, 296, false), 4);
  assert.ok(crumbWindow(w, 8, 20, 2, 296, true) < 4);
});

test('dnInputProblem: DNs and LDAP URLs with a DN pass, anything else says why', () => {
  assert.equal(dnInputProblem('CN=Anna,OU=Staff,DC=ad,DC=lab'), null);
  assert.equal(dnInputProblem('  cn=x,dc=example,dc=com  '), null);
  assert.equal(dnInputProblem('ldap://dc1.ad.lab/CN=Anna,DC=ad,DC=lab'), null);
  assert.equal(dnInputProblem(''), 'Enter a DN or an LDAP URL');
  assert.equal(dnInputProblem('ldap://dc1.ad.lab/'), 'The LDAP URL has no DN');
  assert.match(dnInputProblem('just some words') ?? '', /^Not a DN/);
});
