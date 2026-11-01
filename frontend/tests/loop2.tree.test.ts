// UX loop round 2: breadcrumb root, subtree refresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { owningTreeRoot, subtreeRefreshPlan } from '../src/lib/treesearch.ts';

const node = (dn: string, children?: any[]) => ({ dn, rdn: dn.split(',')[0], hasChildren: !!children, objectClass: [], icon: '', children });

test('breadcrumb root: an entry below CN=Users starts at the domain (RW1-N-01)', () => {
  const roots = [
    node('DC=ad,DC=ldapilot,DC=lab', [node('CN=Users,DC=ad,DC=ldapilot,DC=lab'), node('OU=LDAPilot,DC=ad,DC=ldapilot,DC=lab'), node('DC=child,DC=ad,DC=ldapilot,DC=lab')]),
    node('CN=Configuration,DC=ad,DC=ldapilot,DC=lab'),
  ];
  const nc = new Set(['dc=ad,dc=ldapilot,dc=lab', 'dc=child,dc=ad,dc=ldapilot,dc=lab', 'cn=configuration,dc=ad,dc=ldapilot,dc=lab']);
  const isNc = (dn: string) => nc.has(dn.toLowerCase());
  assert.equal(owningTreeRoot(roots, 'CN=Administrator,CN=Users,DC=ad,DC=ldapilot,DC=lab', isNc)?.dn, 'DC=ad,DC=ldapilot,DC=lab');
  assert.equal(owningTreeRoot(roots, 'CN=u,OU=Track-ux,OU=LDAPilot,DC=ad,DC=ldapilot,DC=lab', isNc)?.dn, 'DC=ad,DC=ldapilot,DC=lab');
  assert.equal(owningTreeRoot(roots, 'CN=x,DC=child,DC=ad,DC=ldapilot,DC=lab', isNc)?.dn, 'DC=child,DC=ad,DC=ldapilot,DC=lab', 'an injected child domain is its own root');
  assert.equal(owningTreeRoot(roots, 'CN=Sites,CN=Configuration,DC=ad,DC=ldapilot,DC=lab', isNc)?.dn, 'CN=Configuration,DC=ad,DC=ldapilot,DC=lab');
  assert.equal(owningTreeRoot(roots, 'CN=x,DC=other', isNc), null);
  // A scoped tree (base DN = an OU): its root, not a preloaded child OU.
  const scoped = [node('OU=LDAPilot,DC=ad,DC=ldapilot,DC=lab', [node('OU=Special Cases,OU=LDAPilot,DC=ad,DC=ldapilot,DC=lab')])];
  assert.equal(owningTreeRoot(scoped, 'CN=Test Stale,OU=Special Cases,OU=LDAPilot,DC=ad,DC=ldapilot,DC=lab', isNc)?.dn, 'OU=LDAPilot,DC=ad,DC=ldapilot,DC=lab');
});

test('refresh of one container reloads its expanded sub-containers, marks hidden ones stale (RW1-N-04)', () => {
  const P = 'OU=p,DC=lab';
  const childNodes: Record<string, any[]> = {
    [P]: [node(`OU=a,${P}`), node(`OU=b,${P}`), node(`CN=leaf,${P}`)],
    [`OU=a,${P}`]: [node(`OU=a1,OU=a,${P}`)],
    [`OU=a1,OU=a,${P}`]: [node(`CN=x,OU=a1,OU=a,${P}`)],
    [`OU=b,${P}`]: [node(`CN=y,OU=b,${P}`)],
    ['OU=other,DC=lab']: [],
  };
  const expanded = new Set([P, `OU=a,${P}`, `OU=a1,OU=a,${P}`]);
  const plan = subtreeRefreshPlan(P, childNodes, expanded);
  assert.deepEqual(plan.reload, [`OU=a,${P}`, `OU=a1,OU=a,${P}`]);
  assert.deepEqual(plan.stale, [`OU=b,${P}`], 'a loaded but collapsed list below the node is stale; other subtrees are left alone');
  assert.deepEqual(subtreeRefreshPlan('OU=none,DC=lab', childNodes, expanded), { reload: [], stale: [] });
});
