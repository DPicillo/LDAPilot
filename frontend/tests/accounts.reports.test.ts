// Run: cd frontend && node --test 'tests/*.test.ts'
// ACCT-04 / ACCT-06 / ACCT-07: report catalog per server type and report rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORTS, buildReportRows, clampReportDays, correctReportDays, isComputedReportColumn, isGroupReport, patchReportRows, reportColumns, reportFilter,
  reportUnavailableReason, sortEntriesByName, summarizeAccountReport, withDays, accountReportDisplayColumns,
} from '../src/lib/accountReports.ts';
import type { AccountReportResult, AccountStatus } from '../src/types/account.ts';
import type { LDAPEntry } from '../src/types/ldap.ts';

const byId = (id: string) => REPORTS.find((r) => r.id === id)!;

test('filters per server type (TRIAGE ACCT-04)', () => {
  assert.equal(reportFilter(byId('all-users'), 'ad'), '(&(objectCategory=person)(objectClass=user))');
  assert.equal(reportFilter(byId('all-users'), 'openldap'), '(|(objectClass=inetOrgPerson)(objectClass=posixAccount)(objectClass=account))');
  assert.equal(reportFilter(byId('users-no-email'), '389ds'), '(&(|(objectClass=inetOrgPerson)(objectClass=posixAccount)(objectClass=account))(!(mail=*)))');
  assert.match(reportFilter(byId('users-no-email'), 'ad'), /objectCategory=person/);
  assert.equal(reportFilter(byId('service-accounts'), 'ad'), '(|(objectClass=msDS-ManagedServiceAccount)(objectClass=msDS-GroupManagedServiceAccount))');
  assert.equal(reportFilter(byId('posix-users'), 'openldap'), '(|(objectClass=posixAccount)(uidNumber=*))');
  assert.match(reportFilter(byId('posix-users'), 'ad'), /uidNumber=\*/);
  for (const st of ['ad', 'openldap', '389ds']) {
    const f = reportFilter(byId('all-groups'), st);
    for (const oc of ['group', 'groupOfNames', 'groupOfUniqueNames', 'posixGroup']) assert.ok(f.includes(`(objectClass=${oc})`), `${st} ${oc}`);
  }
  assert.equal(reportFilter(byId('posix-groups'), 'ad'), '(|(objectClass=posixGroup)(&(objectClass=group)(gidNumber=*)))');
  assert.match(reportFilter(byId('all-computers'), 'ad'), /!\(objectClass=msDS-GroupManagedServiceAccount\)/);
  assert.equal(reportFilter(byId('all-computers'), 'openldap'), '(|(objectClass=device)(objectClass=ipHost))');
  assert.deepEqual(reportColumns(byId('all-users'), 'openldap'), ['uid', 'mail', 'description']);
  // Every filter is balanced
  for (const r of REPORTS) {
    for (const st of ['ad', 'openldap']) {
      const f = reportFilter(r, st);
      if (!f) continue;
      let depth = 0;
      for (const c of f) { depth += c === '(' ? 1 : c === ')' ? -1 : 0; assert.ok(depth >= 0, `${r.id}`); }
      assert.equal(depth, 0, `${r.id} ${st}`);
    }
  }
});

test('AD-only reports are greyed elsewhere; backend reasons pass through', () => {
  for (const id of ['service-accounts', 'pwd-never-expires', 'pwd-not-required', 'admin-accounts', 'privileged-members']) {
    assert.equal(reportUnavailableReason(byId(id), 'openldap', {}), 'Active Directory only', id);
    assert.equal(reportUnavailableReason(byId(id), 'ad', {}), null, id);
    assert.equal(reportUnavailableReason(byId(id), null, {}), null, 'unknown server: offered');
  }
  const hint = 'This OpenLDAP server does not record logon times …';
  assert.equal(reportUnavailableReason(byId('users-no-login'), 'openldap', { neverLoggedOn: hint }), hint);
  assert.equal(reportUnavailableReason(byId('all-users'), 'openldap', {}), null);
});

test('Days: validated 1..3650, the field is corrected, N substituted', () => {
  assert.deepEqual(correctReportDays('14'), { days: 14, corrected: false });
  assert.equal(correctReportDays('0').days, 1);
  assert.equal(correctReportDays('0').corrected, true);
  assert.equal(correctReportDays('-5').days, 1);
  assert.equal(correctReportDays('99999').days, 3650);
  assert.match(correctReportDays('99999').message!, /3650/);
  assert.equal(correctReportDays('').days, 14);
  assert.equal(correctReportDays('7.5').days, 7);
  assert.equal(clampReportDays('abc'), 14);
  assert.equal(withDays(byId('pwd-expiring').description, 30), 'Enabled accounts whose password expires within 30 days');
  assert.equal(withDays(byId('pwd-expiring').empty, 1), 'No password expires within 1 day');
});

test('summary: a positive empty state, counts otherwise', () => {
  const empty: AccountReportResult = { entries: [], totalCount: 0, truncated: false, candidates: 1, columns: [], notes: [] };
  const s = summarizeAccountReport('Locked-Out Users', empty, 'No locked-out accounts');
  assert.equal(s.tone, 'success');
  assert.deepEqual(s.lines, ['No locked-out accounts (1 checked).']);
  const one = summarizeAccountReport('Empty Groups', { ...empty, entries: [{ dn: 'cn=g', attributes: [] }], candidates: 27, notes: ['4 group(s) …'] }, 'x', ['group', 'groups']);
  assert.equal(one.tone, 'info');
  assert.deepEqual(one.lines, ['1 group (27 checked)', '4 group(s) …']);
});

const status = (p: Partial<AccountStatus>): AccountStatus => ({
  dn: '', serverType: '389ds', applicable: true, evaluated: '', enabled: true, locked: false, badPasswordCount: 0, passwordExpired: false,
  passwordNeverExpires: false, mustChangePassword: false, accountExpired: false, accountNeverExpires: true, logonCount: 0, hasLogonCount: false,
  userAccountControl: 0, userAccountControlComputed: 0, unsupported: {}, warnings: [], ...p,
});
const entry = (dn: string): LDAPEntry => ({ dn, attributes: [{ name: 'uid', values: [dn.split(',')[0].split('=')[1]], binary: false }] });
const val = (e: LDAPEntry, name: string) => e.attributes.find((a) => a.name === name)?.values[0];

test('report rows: computed columns ("permanent", days left), sorted by name', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  const locked: AccountReportResult = {
    entries: [entry('uid=zoe,ou=p,dc=x'), entry('uid=philipp.hartmann,ou=p,dc=x')], totalCount: 2, truncated: false, candidates: 2, columns: [], notes: [],
    statuses: [status({ locked: true, lockedUntil: '2026-10-31T13:00:00Z', badPasswordCount: 3 }), status({ locked: true, lockedPermanently: true, badPasswordCount: 4 })],
  };
  const rows = buildReportRows('locked', locked, now);
  assert.deepEqual(rows.map((r) => r.entry.dn), ['uid=philipp.hartmann,ou=p,dc=x', 'uid=zoe,ou=p,dc=x']);
  assert.equal(val(rows[0].entry, 'Locked until'), 'permanent');
  assert.equal(val(rows[0].entry, 'Failed logons'), '4');
  assert.equal(rows[0].status?.lockedPermanently, true, 'status travels with its row');
  assert.match(val(rows[1].entry, 'Locked until')!, /^2026-10-31 \d\d:00$/);
  const expiring: AccountReportResult = { ...locked, entries: [entry('uid=a,dc=x')], statuses: [status({ passwordExpires: '2026-11-03T20:00:00Z' })] };
  assert.equal(val(buildReportRows('passwordExpiring', expiring, now)[0].entry, 'Days left'), '3');
  assert.deepEqual(accountReportDisplayColumns('passwordExpiring', 'ad', []), ['sAMAccountName', 'mail', 'Password expires', 'Days left']);
  // group report: the backend's computed columns
  const priv: AccountReportResult = {
    entries: [entry('cn=adm.mertens,dc=ad')], totalCount: 1, truncated: false, candidates: 1, columns: [], notes: [],
    extra: [{ 'Privileged groups': 'Enterprise Admins', 'Nested via': '' }],
  };
  const pr = buildReportRows('privilegedMembers', priv, now)[0].entry;
  assert.equal(val(pr, 'Privileged groups'), 'Enterprise Admins');
  assert.equal(val(pr, 'Nested via'), undefined, 'empty columns are left out');
  assert.equal(isComputedReportColumn('Days left'), true);
  assert.equal(isComputedReportColumn('sAMAccountName'), false);
});

test('report rows are patched after an account action', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  const current = [entry('uid=a,dc=x'), entry('uid=b,dc=x'), entry('uid=c,dc=x')];
  const fresh = buildReportRows('locked', {
    entries: [{ dn: 'UID=b,DC=x', attributes: [{ name: 'uid', values: ['b'], binary: false }, { name: 'accountUnlockTime', values: [], binary: false }] }],
    totalCount: 1, truncated: false, candidates: 1, columns: [], notes: [], statuses: [status({ locked: false })], matches: [false],
  }, now);
  const patched = patchReportRows(current, ['uid=b,dc=x', 'uid=c,dc=x'], fresh);
  assert.deepEqual(patched.map((e) => e.dn), ['uid=a,dc=x', 'UID=b,DC=x'], 'b replaced in place, c (gone) removed');
  assert.equal(val(patched[1], 'Locked until'), undefined, 'no stale lock columns');
  assert.deepEqual(sortEntriesByName([{ dn: 'cn=user10,dc=x' }, { dn: 'cn=User2,dc=x' }]).map((e) => e.dn), ['cn=User2,dc=x', 'cn=user10,dc=x']);
});

test('group report rows keep their computed columns when re-read (privileged member after Reset Password)', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  const priv: AccountReportResult = {
    entries: [entry('cn=adm.mertens,dc=ad'), entry('cn=lea.meyer,dc=ad')], totalCount: 2, truncated: false, candidates: 2, columns: [], notes: [],
    extra: [{ 'Privileged groups': 'Enterprise Admins', 'Nested via': 'Enterprise Admins ← GG-IT-Admins' }, { 'Privileged groups': 'Domain Admins', 'Nested via': '' }],
  };
  const current = buildReportRows('privilegedMembers', priv, now).map((r) => r.entry);
  // The backend re-reads only the entry (no extra columns) for group reports.
  const reread = buildReportRows('privilegedMembers', {
    entries: [{ dn: 'cn=lea.meyer,dc=ad', attributes: [{ name: 'uid', values: ['lea.meyer'], binary: false }, { name: 'userAccountControl', values: ['514'], binary: false }] }],
    totalCount: 1, truncated: false, candidates: 1, columns: [], notes: [], matches: [true],
  }, now);
  assert.equal(isGroupReport('privilegedMembers'), true);
  assert.equal(isGroupReport('emptyGroups'), true);
  assert.equal(isGroupReport('locked'), false);
  const patched = patchReportRows(current, ['cn=lea.meyer,dc=ad'], reread, isGroupReport('privilegedMembers'));
  assert.deepEqual(patched.map((e) => e.dn), ['cn=adm.mertens,dc=ad', 'cn=lea.meyer,dc=ad'], 'the row stays (it is not re-evaluated)');
  assert.equal(val(patched[1], 'Privileged groups'), 'Domain Admins', 'computed column kept');
  assert.equal(val(patched[1], 'userAccountControl'), '514', 'attributes refreshed');
  assert.equal(val(patched[0], 'Nested via'), 'Enterprise Admins ← GG-IT-Admins', 'other rows untouched');
  // Account reports recompute: no stale columns are kept.
  const lockedRow = { dn: 'uid=b,dc=x', attributes: [{ name: 'Locked until', values: ['permanent'], binary: false }] };
  const unlocked = buildReportRows('locked', {
    entries: [entry('uid=b,dc=x')], totalCount: 1, truncated: false, candidates: 1, columns: [], notes: [], statuses: [status({ locked: false })],
  }, now);
  assert.equal(val(patchReportRows([lockedRow], ['uid=b,dc=x'], unlocked, isGroupReport('locked'))[0], 'Locked until'), undefined);
});
