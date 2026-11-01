// Run: cd frontend && node --test 'tests/*.test.ts'
// Results as text (CSV export, Copy Table): visible columns in the visible
// order, the grid's sort, readable dates, formula-safe cells. Batch modify:
// live row problems, template attributes, the compact dry-run rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountTimeLabel, formatLocalDateTime, readableAttrDate, readableDate, sortRows, statusText, tableCSV, tableRows, tableTSV, visibleColumns, type ExportColumn } from '../src/components/search/resultsExport.ts';
import { dryRunRows, newChangeRow, templateAttributes, validateChangeRows, visibleRowProblems } from '../src/lib/bulk.ts';

interface Row { name: string; mail: string; n: number }
const cols: ExportColumn<Row>[] = [
  { id: 'name', header: 'Name', text: (r) => r.name },
  { id: 'type', header: 'Type', text: () => 'User' },
  { id: 'attr:mail', header: 'mail', text: (r) => r.mail },
  { id: 'attr:n', header: 'n', text: (r) => String(r.n), sortValue: (r) => r.n },
  { id: 'dn', header: 'DN', text: (r) => `cn=${r.name}`, defaultHidden: true },
];

test('visibleColumns follows the grid: persisted order first, hidden and defaultHidden columns left out', () => {
  assert.deepEqual(visibleColumns(cols, {}).map((c) => c.id), ['name', 'type', 'attr:mail', 'attr:n']);
  assert.deepEqual(visibleColumns(cols, { order: ['attr:mail', 'name'], hidden: ['type'] }).map((c) => c.id), ['attr:mail', 'name', 'attr:n', 'dn']);
  // A persisted order naming a removed column is ignored for it
  assert.deepEqual(visibleColumns(cols, { order: ['gone', 'dn'], hidden: [] }).map((c) => c.id), ['dn', 'name', 'type', 'attr:mail', 'attr:n']);
});

test('sortRows sorts like the grid: natural, case-insensitive, numbers numeric, empty last', () => {
  const rows: Row[] = [{ name: 'b10', mail: '', n: 10 }, { name: 'B2', mail: 'x', n: 2 }, { name: 'a', mail: 'y', n: 1 }];
  assert.deepEqual(sortRows(rows, cols[0], 'asc').map((r) => r.name), ['a', 'B2', 'b10']);
  assert.deepEqual(sortRows(rows, cols[3], 'desc').map((r) => r.n), [10, 2, 1]);
  assert.deepEqual(sortRows(rows, cols[2], 'asc').map((r) => r.mail), ['x', 'y', '']);
  assert.equal(sortRows(rows, undefined, undefined), rows);
});

test('readableDate: generalized time and FILETIME in local time, "never", other text unchanged', () => {
  assert.equal(readableDate('20261029205900.0Z'), formatLocalDateTime(new Date(Date.UTC(2026, 9, 29, 20, 59, 0))));
  // 2026-01-01T00:00:00Z as FILETIME
  const ft = String((BigInt(Date.UTC(2026, 0, 1)) + 11644473600000n) * 10000n);
  assert.equal(readableDate(ft), formatLocalDateTime(new Date(Date.UTC(2026, 0, 1))));
  assert.equal(readableDate('0'), 'never');
  assert.equal(readableDate('9223372036854775807'), 'never');
  assert.equal(readableDate('19000'), '19000', 'shadowLastChange days stay a number');
  assert.equal(readableDate('soon'), 'soon');
});

test('CSV and TSV of the table are formula-safe', () => {
  const t = tableRows([{ name: '=cmd|x', mail: 'a,b', n: 1 }], visibleColumns(cols, {}));
  assert.deepEqual(t.header, ['Name', 'Type', 'mail', 'n']);
  assert.equal(tableCSV(t.header, t.rows), 'Name,Type,mail,n\r\n\'=cmd|x,User,"a,b",1\r\n');
  assert.equal(tableTSV(['a'], [['+1\tx\ny']]), "a\n'+1 x y");
  assert.equal(statusText(['disabled', 'pwdNeverExpires']), 'Disabled; Password never expires');
});

test('batch rows: typing errors show at once, missing input only after the first attempt', () => {
  const r1 = { ...newChangeRow('replace'), attribute: 'mail', values: '%givenName:title%@x' };
  const r2 = { ...newChangeRow('add'), attribute: '', values: '' };
  const r3 = { ...newChangeRow('add'), attribute: 'description', values: 'a %unclosed' };
  const problems = validateChangeRows([r1, r2, r3]);
  assert.deepEqual(visibleRowProblems(problems, false).map((p) => [p.rowId, p.kind]), [[r1.id, 'invalid'], [r3.id, 'invalid']]);
  assert.match(visibleRowProblems(problems, false)[0].message, /Unknown modifier "title"/);
  assert.match(visibleRowProblems(problems, false)[1].message, /Unterminated placeholder/);
  assert.deepEqual(visibleRowProblems(problems, true).map((p) => p.message), [
    problems[0].message, 'Attribute name is missing', problems[2].message,
  ]);
  assert.deepEqual(templateAttributes({ ...newChangeRow('replace'), values: '%givenName%.%SN:lower%@%dn%\n%givenname%;%mail;lang-de%' }), ['givenName', 'SN', 'mail']);
});

test('dryRunRows: one row per changed attribute, messages on the first row, binary values by size', () => {
  const diff = (attribute: string, before: string[], after: string[], changed = true, binary = false) => ({
    attribute, operations: ['replace'], before, after, beforeCount: before.length, afterCount: after.length, added: [], removed: [], changed, masked: false, binary,
  });
  const rows = dryRunRows([
    { dn: 'CN=a,OU=x,DC=y', status: 'change', errors: [], warnings: ['w'], notes: [], diffs: [diff('mail', ['old'], ['new']), diff('cn', ['a'], ['a'], false), diff('photo', ['AAEC'], [], true, true)] },
    { dn: 'CN=b,OU=x,DC=y', status: 'error', errors: ['no such attribute'], warnings: [], notes: [], diffs: [] },
  ] as never);
  assert.deepEqual(rows.map((r) => [r.rdn, r.attribute, r.before, r.after, r.messages]), [
    ['CN=a', 'mail', 'old', 'new', 'w'],
    ['CN=a', 'photo', '<binary 3 bytes>', '', ''],
    ['CN=b', '', '', '', 'no such attribute'],
  ]);
});

test('account time sentinels read as labels, real times as dates (ACCT-03 columns)', () => {
  assert.equal(accountTimeLabel('pwdAccountLockedTime', '000001010000Z'), 'Permanent (disabled)');
  assert.equal(accountTimeLabel('accountUnlockTime', '19700101000000Z'), 'Permanent (until an administrator unlocks)');
  assert.equal(accountTimeLabel('passwordExpirationTime', '19700101000000Z'), 'Must change at next bind');
  assert.equal(accountTimeLabel('pwdLastSet', '0'), 'Must change at next logon');
  assert.equal(accountTimeLabel('accountExpires', '9223372036854775807'), 'Never');
  assert.equal(accountTimeLabel('lockoutTime', '0'), 'Not locked');
  // A real time is no sentinel (the grid's date renderer shows it)
  assert.equal(accountTimeLabel('accountUnlockTime', '20261101120000Z'), null);
  assert.equal(accountTimeLabel('description', '0'), null);
  assert.equal(readableAttrDate('pwdAccountLockedTime', '000001010000Z'), 'Permanent (disabled)');
  assert.equal(readableAttrDate('accountUnlockTime', '20261101120000Z'), readableDate('20261101120000Z'));
});
