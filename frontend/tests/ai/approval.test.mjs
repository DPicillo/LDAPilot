// Resolved approval texts (lib/aiApproval.ts, UX A-24).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvedText } from '../../src/lib/aiApproval.ts';

test('writes are approved, access requests are allowed', () => {
  assert.equal(resolvedText('approved', 'user', 'write'), 'Approved by you');
  assert.equal(resolvedText('approved', 'user'), 'Approved by you');
  assert.equal(resolvedText('approved', 'grant', 'write'), 'Approved automatically (approved for this chat)');
  assert.equal(resolvedText('approved', 'user', 'access'), 'Allowed for this chat');
  assert.equal(resolvedText('approved_always', 'user', 'access'), 'Allowed (always, read)');
  assert.equal(resolvedText('denied', 'user', 'access'), 'Not allowed');
  assert.equal(resolvedText('timeout', 'timeout', 'access'), 'Not answered in time');
  assert.equal(resolvedText('cancelled', 'run', 'access'), 'Cancelled because the response was stopped');
});
