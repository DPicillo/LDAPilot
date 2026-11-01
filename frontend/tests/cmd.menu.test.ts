// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stabilizeItems } from '../src/components/commands/menuStability.ts';
import type { ResolvedCommand } from '../src/components/ui/commands';

const rc = (id: string, title: string, opts: { enabled?: boolean; stableTitle?: boolean; section?: string } = {}): ResolvedCommand => ({
  id,
  command: { id, title, group: 'account', stableTitle: opts.stableTitle },
  title,
  enabled: opts.enabled ?? true,
  isDefault: false,
  section: opts.section ?? 'account',
  danger: false,
});

test('the Unlock placeholder becomes Unlock in place; nothing below it moves', () => {
  const seen = new Map<string, ResolvedCommand>();
  const t0 = stabilizeItems([rc('unlock', 'Checking account status…', { enabled: false }), rc('reset', 'Reset Password…'), rc('toggle', 'Enable/Disable Account', { stableTitle: true })], seen, () => undefined);
  assert.deepEqual(t0.map((i) => i.id), ['unlock', 'reset', 'toggle']);
  const t1 = stabilizeItems([rc('unlock', 'Unlock Account'), rc('reset', 'Reset Password…'), rc('toggle', 'Disable Account', { stableTitle: true })], seen, () => undefined);
  assert.deepEqual(t1.map((i) => [i.id, i.title, i.enabled]), [
    ['unlock', 'Unlock Account', true],
    ['reset', 'Reset Password…', true],
    ['toggle', 'Enable/Disable Account', true], // stableTitle keeps the first title
  ]);
});

test('an item that no longer applies stays in its slot, disabled, with its current title', () => {
  const seen = new Map<string, ResolvedCommand>();
  stabilizeItems([rc('unlock', 'Checking account status…', { enabled: false }), rc('reset', 'Reset Password…')], seen, () => undefined);
  const t1 = stabilizeItems([rc('reset', 'Reset Password…')], seen, (id) => (id === 'unlock' ? rc('unlock', 'Unlock Account') : undefined));
  assert.deepEqual(t1.map((i) => [i.id, i.title, i.enabled]), [
    ['unlock', 'Unlock Account', false],
    ['reset', 'Reset Password…', true],
  ]);
  // Later renders keep the same layout.
  const t2 = stabilizeItems([rc('reset', 'Reset Password…'), rc('photo', 'Download Photo…', { section: 'manage' })], seen, () => undefined);
  assert.deepEqual(t2.map((i) => i.id), ['unlock', 'reset', 'photo']);
});
