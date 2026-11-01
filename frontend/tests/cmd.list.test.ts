// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnInputResult, hiddenAfterShow } from '../src/components/browser/listColumns.ts';

const PRE = ['description', 'company', 'mail'];

test('Add column…: a built-in (hidden) column is shown, a new attribute added, junk refused', () => {
  assert.deepEqual(columnInputResult(' Company ', PRE, []), { kind: 'predefined', name: 'company' });
  assert.deepEqual(columnInputResult('employeeID', PRE, []), { kind: 'new', name: 'employeeID' });
  assert.deepEqual(columnInputResult('EMPLOYEEID', PRE, ['employeeID']), { kind: 'existing', name: 'employeeID' });
  assert.deepEqual(columnInputResult('userCertificate;binary', PRE, []), { kind: 'new', name: 'userCertificate;binary' });
  assert.deepEqual(columnInputResult('not an attr', PRE, []), { kind: 'invalid' });
  assert.deepEqual(columnInputResult('  ', PRE, []), { kind: 'empty' });
  assert.deepEqual(hiddenAfterShow(['attr:company', 'attr:mail', 'dn'], 'attr:company'), ['attr:mail', 'dn']);
});
