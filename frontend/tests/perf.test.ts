// Large directories (40,000 groups in one container, 100,000 users): the helpers every
// row goes through must stay cheap. Measurements in docs/perf-large-directories.md.
// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstRDN, parseRDN, unescapeDNValue } from '../src/lib/dn.ts';

/** unescapeDNValue as it was (one TextEncoder.encode per character): the reference for its results. */
function unescapeReference(value: string): string {
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      const hex = value.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        const s = String.fromCodePoint(value.codePointAt(i + 1)!);
        bytes.push(...enc.encode(s));
        i += s.length;
      }
    } else {
      const s = String.fromCodePoint(value.codePointAt(i)!);
      bytes.push(...enc.encode(s));
      i += s.length - 1;
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

test('unescapeDNValue: same results as the per-character implementation', () => {
  const samples = [
    '', 'sap-users-00001', 'Jürgen Weiß-Özdemir', 'Zoë Ångström 日本', '𝒜 emoji 😀 pair',
    'Schmidt\\, Anna', 'C\\+\\+ Developer', '\\#Hash User', 'Quote \\"Q\\" User', 'Semi\\;Colon \\<Angle\\>',
    'Back\\\\Slash', 'M\\C3\\BCller', 'M\\c3\\bcller und \\E6\\97\\A5\\E6\\9C\\AC', 'a\\2Cb\\3Dc', 'trailing blank\\ ',
    '\\ leading blank', 'ends with a backslash\\', 'not hex \\zz and \\4', 'emoji escaped \\😀 x', 'mixed ä\\,ö\\C3\\9F😀\\\\',
    'invalid utf-8 \\FF\\FE end',
  ];
  for (const v of samples) assert.equal(unescapeDNValue(v), unescapeReference(v), JSON.stringify(v));
});

test('names of 40,000 entries: unescaping costs a fraction of the per-character implementation', () => {
  const values = Array.from({ length: 40000 }, (_, i) => `sap-users-${String(i).padStart(5, '0')}`);
  const time = (fn: (v: string) => string) => {
    fn(values[0]); // warm-up
    const start = performance.now();
    let chars = 0;
    for (const v of values) chars += fn(v).length;
    assert.equal(chars, 40000 * 'sap-users-00000'.length);
    return performance.now() - start;
  };
  // Relative, so a loaded machine does not fail it: 36 – 100 µs per name before.
  const before = time(unescapeReference);
  const now = time(unescapeDNValue);
  assert.ok(now * 5 < before, `unescapeDNValue ${Math.round(now)} ms, per-character ${Math.round(before)} ms`);
  assert.equal(parseRDN(firstRDN(`cn=${values[1]},ou=Groups,dc=perf`)).value, values[1]);
});

test('table sort: same order as before, 40,000 rows in well under a second', async () => {
  const { compareCells, sortRowsBy } = await import('../src/components/ui/tableSort.ts');
  // Order rules: empty last, numbers numerically, text naturally and case-insensitively, arrays joined.
  const vals = ['b10', 'B2', null, 'a', 'ä', undefined, 'b2', ['x', 'y'], 'x, y'];
  const asc = sortRowsBy(vals, (v) => v as never, 'asc');
  assert.deepEqual(asc.slice(0, 3), ['a', 'ä', 'B2']);
  assert.equal(asc[4], 'b10');
  assert.deepEqual(asc.slice(-2).map((v) => v ?? 'empty'), ['empty', 'empty']);
  assert.equal(compareCells(2, 10) < 0, true);
  assert.equal(compareCells(['x', 'y'], 'x, y'), 0);
  assert.deepEqual(sortRowsBy([3, 1, 2], (v) => v, 'desc'), [3, 2, 1]);
  // Dates by time, also against generalized time strings.
  assert.ok(compareCells(new Date(Date.UTC(2020, 0, 1)), '20250101000000Z') < 0);

  const rows = Array.from({ length: 40000 }, (_, i) => ({ name: `sap-users-${String((i * 7919) % 40000).padStart(5, '0')}` }));
  sortRowsBy(rows.slice(0, 100), (r) => r.name, 'asc'); // warm-up
  const start = performance.now();
  const sorted = sortRowsBy(rows, (r) => r.name, 'asc');
  const ms = performance.now() - start;
  assert.equal(sorted[0].name, 'sap-users-00000');
  assert.equal(sorted[39999].name, 'sap-users-39999');
  // 15 s per 10,000 rows before (value derived and localeCompare per comparison).
  assert.ok(ms < 1500, `sorting 40,000 rows took ${Math.round(ms)} ms`);
});

test('breadcrumb root of an entry next to 40,000 preloaded siblings: ancestors only, no walk of the siblings', async () => {
  const { owningTreeRoot, forestDomainKeys } = await import('../src/lib/treesearch.ts');
  const node = (dn: string, children?: any[], icon = '') => ({ dn, rdn: dn.split(',')[0], hasChildren: !!children, objectClass: [], icon, children });
  const base = 'ou=Groups,dc=perf,dc=ldapilot,dc=lab';
  const groups = Array.from({ length: 40000 }, (_, i) => node(`cn=g${i},${base}`));
  const roots = [node(base, groups)];
  let calls = 0;
  const isNc = (dn: string) => {
    calls++;
    return dn.toLowerCase() === base.toLowerCase();
  };
  assert.equal(owningTreeRoot(roots, base, isNc)?.dn, base);
  assert.equal(owningTreeRoot(roots, `cn=g39999,${base}`, isNc)?.dn, base);
  assert.equal(owningTreeRoot(roots, `CN=G7,OU=groups,dc=perf,dc=ldapilot,dc=lab`, isNc)?.dn, base, 'other spelling');
  assert.ok(calls <= 6, `isNcHead asked ${calls} times`);

  // Forest domains (globe icon, DC= DN) among the roots and their preloaded children, by normalized DN.
  const ad = [node('DC=ad,DC=lab', [node('CN=Users,DC=ad,DC=lab'), node('DC=child, DC=ad,DC=lab', undefined, 'globe')], 'globe'), node('CN=Configuration,DC=ad,DC=lab')];
  const keys = forestDomainKeys(ad);
  assert.deepEqual([...keys].sort(), ['dc=ad,dc=lab', 'dc=child,dc=ad,dc=lab']);
  assert.equal(forestDomainKeys(ad), keys, 'cached per roots array');
});
