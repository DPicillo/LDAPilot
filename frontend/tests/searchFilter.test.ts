// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilter, formatFilter, unescapeFilterValue, escapeFilterValue } from '../src/lib/ldapFilter.ts';
import { buildBuilderFilter, builderGroupFromFilter } from '../src/lib/searchFilter.ts';

test('unescapeFilterValue reverses escapeFilterValue (UTF-8 hex escapes too)', () => {
  for (const v of ['a*b', '(x)', 'back\\slash', 'Jürgen', 'nul\u0000', 'plain']) {
    assert.equal(unescapeFilterValue(escapeFilterValue(v)), v);
  }
  assert.equal(unescapeFilterValue('J\\c3\\bcrgen'), 'Jürgen');
  assert.equal(unescapeFilterValue('a\\*b'), 'a*b');
});

test('parseFilter: items, groups, whitespace, missing outer parentheses', () => {
  assert.deepEqual(parseFilter('(cn=*)'), { type: 'present', attr: 'cn' });
  assert.deepEqual(parseFilter('cn=Jo*'), { type: 'substring', attr: 'cn', initial: 'Jo', any: [], final: undefined });
  assert.deepEqual(parseFilter('( & (a=1) (b>=2) )'), {
    type: 'and', children: [{ type: 'equality', attr: 'a', value: '1' }, { type: 'greaterOrEqual', attr: 'b', value: '2' }],
  });
  assert.deepEqual(parseFilter('(userAccountControl:1.2.840.113556.1.4.803:=2)'), { type: 'extensible', attr: 'userAccountControl:1.2.840.113556.1.4.803:', value: '2' });
  assert.deepEqual(parseFilter('(!(cn~=x))'), { type: 'not', child: { type: 'approx', attr: 'cn', value: 'x' } });
  assert.throws(() => parseFilter('(cn=a'), /Missing/);
  assert.throws(() => parseFilter('(&)'), /Empty AND/);
  assert.throws(() => parseFilter('(!(a=1)(b=2))'), /exactly one/);
  assert.throws(() => parseFilter('(cn=a(b))'), /Unescaped/);
  assert.throws(() => parseFilter('(=x)'), /Attribute missing/);
  assert.throws(() => parseFilter('(a=1))'), /Unexpected text/);
});

test('formatFilter round-trips', () => {
  for (const f of ['(&(objectClass=user)(!(mail=*)))', '(|(cn=a*)(sn=*b)(mail=*@x*))', '(cn=a*b*c)', '(memberOf:1.2.840.113556.1.4.1941:=CN=G\\5c,1,DC=x)']) {
    assert.equal(formatFilter(parseFilter(f)), f);
  }
});

test('builder round trip: the builder opens with the current filter', () => {
  const cases = [
    '(objectClass=*)',
    '(&(objectClass=person)(objectClass=user))',
    '(&(objectClass=user)(userAccountControl:1.2.840.113556.1.4.803:=2))',
    '(&(objectClass=group)(!(member=*)))',
    '(|(cn=Jo*)(sn=*son)(mail=*@example*))',
    '(!(&(a=1)(b=2)))',
    '(!(|(a=1)(b=2)))',
    '(&(cn~=smith)(uidNumber>=1000)(uidNumber<=2000))',
    '(cn=a\\2a)',
    '(member=CN=Schmidt\\5c, Anna,OU=x)',
  ];
  for (const f of cases) {
    const r = builderGroupFromFilter(f);
    assert.ok('group' in r, `${f}: ${'error' in r ? r.error : ''}`);
    const built = buildBuilderFilter(r.group);
    assert.deepEqual(built.problems, []);
    assert.equal(built.filter, f);
  }
  // Escaped UTF-8 comes back as text (equivalent filter)
  const r = builderGroupFromFilter('(cn=J\\c3\\bcrgen)');
  assert.ok('group' in r);
  assert.equal(buildBuilderFilter(r.group).filter, '(cn=Jürgen)');
  // A filter-level \2c is just a comma
  const c = builderGroupFromFilter('(cn=a\\2cb)');
  assert.ok('group' in c);
  assert.equal(buildBuilderFilter(c.group).filter, '(cn=a,b)');
});

test('builder refuses what it cannot show (never drops a part)', () => {
  const multi = builderGroupFromFilter('(&(cn=a*b)(sn=x))');
  assert.ok('error' in multi && /several parts/.test(multi.error));
  const bad = builderGroupFromFilter('(cn=');
  assert.ok('error' in bad);
});

test('"Any name": ANR on AD, an OR of name attributes elsewhere', async () => {
  const { buildAnyNameFilter } = await import('../src/lib/searchFilter.ts');
  assert.equal(buildAnyNameFilter(' smith ', 'contains', true, ''), '(anr=smith)');
  assert.equal(buildAnyNameFilter('a*b', 'contains', true, '(objectClass=person)'), '(&(objectClass=person)(anr=a\\2ab))');
  assert.equal(
    buildAnyNameFilter('jo', 'startsWith', false, ''),
    '(|(cn=jo*)(displayName=jo*)(uid=jo*)(mail=jo*)(givenName=jo*)(sn=jo*)(ou=jo*)(sAMAccountName=jo*)(userPrincipalName=jo*))',
  );
  assert.equal(buildAnyNameFilter('', 'contains', false, ''), '(objectClass=*)');
});
